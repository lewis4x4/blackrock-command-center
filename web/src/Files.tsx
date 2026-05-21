import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ago, INITIAL_DEMO } from './utils';

type ArtifactKind = 'doc' | 'migration' | 'edge_function' | 'spec' | 'report' | 'web_source' | 'script' | 'agent_output' | 'pull_request';
type ArtifactSource = 'repo_scan' | 'agent_run' | 'manual';

type ArtifactFilters = {
  q: string;
  kind: ArtifactKind | '';
  source: ArtifactSource | '';
};

interface Artifact {
  id: string;
  app_id: string | null;
  kind: ArtifactKind;
  title: string;
  path: string | null;
  url: string | null;
  source: ArtifactSource;
  summary: string | null;
  byte_size: number | null;
  produced_by: string | null;
  content_sha: string | null;
  discovered_at: string;
  last_indexed_at: string;
}

interface ArtifactResponse {
  items: Artifact[];
  cursor: { next: string | null; has_more: boolean };
  generated_at: string;
  index_health: { latest_indexed_at: string | null };
  filters: Record<string, unknown>;
}

export type FilesViewHandle = {
  refresh: () => Promise<void>;
};

const LOCAL_REPO = '/Users/brianlewis/Projects/blackrock-command-center';
const PAGE_SIZE = 50;
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const FUNCTIONS_URL = (import.meta.env.VITE_CC_FUNCTIONS_URL ?? `${SUPABASE_URL}/functions/v1`).replace(/\/$/, '');
const READ_TOKEN = import.meta.env.VITE_CC_READ_TOKEN ?? '';
const ACCESS_REQUIRED = (import.meta.env.VITE_CC_ACCESS_REQUIRED ?? 'false') === 'true';

const KIND_OPTIONS: { value: ArtifactKind | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'doc', label: 'Docs' },
  { value: 'spec', label: 'Specs' },
  { value: 'report', label: 'Reports' },
  { value: 'migration', label: 'Migrations' },
  { value: 'edge_function', label: 'Edge functions' },
  { value: 'web_source', label: 'Web source' },
  { value: 'script', label: 'Scripts' },
  { value: 'agent_output', label: 'Agent outputs' },
  { value: 'pull_request', label: 'Pull requests' },
];

const SOURCE_OPTIONS: { value: ArtifactSource | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'repo_scan', label: 'Repo scan' },
  { value: 'agent_run', label: 'Agent run' },
  { value: 'manual', label: 'Manual' },
];

const KIND_LABEL: Record<ArtifactKind, string> = {
  doc: 'doc',
  spec: 'spec',
  report: 'report',
  migration: 'migration',
  edge_function: 'edge fn',
  web_source: 'web',
  script: 'script',
  agent_output: 'agent',
  pull_request: 'pr',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const ARTIFACT_KINDS = new Set<ArtifactKind>(['doc', 'migration', 'edge_function', 'spec', 'report', 'web_source', 'script', 'agent_output', 'pull_request']);

function asKind(value: unknown): ArtifactKind {
  if (typeof value !== 'string' || !ARTIFACT_KINDS.has(value as ArtifactKind)) throw new Error('artifact kind is invalid');
  return value as ArtifactKind;
}

function asSource(value: unknown): ArtifactSource {
  if (value === 'repo_scan' || value === 'agent_run' || value === 'manual') return value;
  throw new Error('artifact source is invalid');
}

function parseArtifact(value: unknown): Artifact {
  if (!isRecord(value)) throw new Error('artifact row is invalid');
  const id = asString(value.id);
  const title = asString(value.title);
  const discoveredAt = asString(value.discovered_at);
  const lastIndexedAt = asString(value.last_indexed_at);
  if (!id || !title || !discoveredAt || !lastIndexedAt) throw new Error('artifact row is missing required fields');
  return {
    id,
    app_id: asString(value.app_id),
    kind: asKind(value.kind),
    title,
    path: asString(value.path),
    url: asString(value.url),
    source: asSource(value.source),
    summary: asString(value.summary),
    byte_size: asNumber(value.byte_size),
    produced_by: asString(value.produced_by),
    content_sha: asString(value.content_sha),
    discovered_at: discoveredAt,
    last_indexed_at: lastIndexedAt,
  };
}

function parseArtifactResponse(value: unknown): ArtifactResponse {
  if (!isRecord(value)) throw new Error('artifact response is invalid');
  const items = Array.isArray(value.items) ? value.items.map(parseArtifact) : [];
  const cursor = isRecord(value.cursor) ? value.cursor : {};
  const indexHealth = isRecord(value.index_health) ? value.index_health : {};
  return {
    items,
    cursor: {
      next: asString(cursor.next),
      has_more: cursor.has_more === true,
    },
    generated_at: asString(value.generated_at) ?? new Date().toISOString(),
    index_health: {
      latest_indexed_at: asString(indexHealth.latest_indexed_at),
    },
    filters: isRecord(value.filters) ? value.filters : {},
  };
}

async function readArtifacts(filters: ArtifactFilters, cursor: string | null): Promise<ArtifactResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(PAGE_SIZE));
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.source) params.set('source', filters.source);
  if (cursor) params.set('cursor', cursor);

  const headers: Record<string, string> = {};
  if (!ACCESS_REQUIRED && READ_TOKEN) headers['x-cc-read-token'] = READ_TOKEN;

  const res = await fetch(`${FUNCTIONS_URL}/cc-read-artifacts?${params.toString()}`, { method: 'GET', headers });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = isRecord(payload)
      ? [asString(payload.error), asString(payload.detail)].filter(Boolean).join(': ')
      : '';
    throw new Error(msg || `cc-read-artifacts returned ${res.status}`);
  }
  return parseArtifactResponse(payload);
}

function bytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function middleTruncate(value: string | null, left = 10, right = 8): string {
  if (!value) return '—';
  if (value.length <= left + right + 1) return value;
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function sourceLabel(source: ArtifactSource): string {
  return SOURCE_OPTIONS.find((s) => s.value === source)?.label ?? source;
}

function filterSummary(filters: ArtifactFilters): string {
  const parts = [
    filters.q.trim() ? `q=${filters.q.trim()}` : null,
    filters.kind ? `kind=${filters.kind}` : null,
    filters.source ? `source=${filters.source}` : null,
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : 'unfiltered';
}

function hasFilters(filters: ArtifactFilters): boolean {
  return !!filters.q.trim() || !!filters.kind || !!filters.source;
}

export const FilesView = forwardRef<FilesViewHandle>(function FilesView(_props, ref) {
  const [filters, setFilters] = useState<ArtifactFilters>({ q: '', kind: '', source: '' });
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState<Artifact[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [inlineLoading, setInlineLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [loadMoreError, setLoadMoreError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [latestIndexedAt, setLatestIndexedAt] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(filters.q), 250);
    return () => window.clearTimeout(t);
  }, [filters.q]);

  const effectiveFilters = useMemo<ArtifactFilters>(() => ({ ...filters, q: debouncedQ }), [filters, debouncedQ]);

  async function fetchFirst() {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setError('');
    setLoadMoreError('');
    if (initialLoaded) setInlineLoading(true);
    else setLoading(true);
    try {
      const res = await readArtifacts(effectiveFilters, null);
      if (seq !== requestSeq.current) return;
      setItems(res.items);
      setNextCursor(res.cursor.next);
      setHasMore(res.cursor.has_more);
      setLatestIndexedAt(res.index_health.latest_indexed_at);
      setExpandedId(null);
      setInitialLoaded(true);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setInitialLoaded(true);
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setInlineLoading(false);
      }
    }
  }

  useImperativeHandle(ref, () => ({
    refresh: fetchFirst,
  }));

  useEffect(() => {
    void fetchFirst();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFilters.q, effectiveFilters.kind, effectiveFilters.source]);

  async function loadMore() {
    if (!nextCursor) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    setLoadMoreError('');
    try {
      const res = await readArtifacts(effectiveFilters, nextCursor);
      if (seq !== requestSeq.current) return;
      setItems((cur) => [...cur, ...res.items]);
      setNextCursor(res.cursor.next);
      setHasMore(res.cursor.has_more);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setLoadMoreError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === requestSeq.current) setLoadingMore(false);
    }
  }

  function clearFilters() {
    setFilters({ q: '', kind: '', source: '' });
    setDebouncedQ('');
  }

  const filtered = hasFilters(effectiveFilters);
  const tally = `${items.length}${hasMore ? '+' : ''} artifact${items.length === 1 && !hasMore ? '' : 's'}`;
  const latestAgo = ago(latestIndexedAt);
  const ageMs = latestIndexedAt ? (Date.now() - new Date(latestIndexedAt).getTime()) : null;
  const staleTone = ageMs == null ? '' : ageMs > 7 * 24 * 60 * 60 * 1000 ? ' failure' : ageMs > 24 * 60 * 60 * 1000 ? ' needs' : '';

  return (
    <section className="band files-band">
      {INITIAL_DEMO && (
        <div className="files-demo-banner needs">
          Demo mode: this surface still reads the live cc-read-artifacts function — there is no demo data path for files.
        </div>
      )}
      <div className="band-head">
        <span className="band-num">F</span>
        <div>
          <div className="band-title">Files.</div>
          <div className="band-sub">Every file the Command Center knows about — docs, migrations, edge functions, agent outputs.</div>
          {items.length > 0 && latestAgo && <div className={`band-sub files-indexed-sub${staleTone}`}>Last indexed {latestAgo}.</div>}
        </div>
        <span className="count-chip">{loading && !initialLoaded ? 'loading' : tally}</span>
      </div>

      <div className="files-filterbar" aria-label="File search and filters">
        <label className="files-control files-search">
          <span>Search</span>
          <input
            value={filters.q}
            onChange={(e) => setFilters((cur) => ({ ...cur, q: e.target.value }))}
            placeholder="Title, path, summary…"
          />
        </label>
        <label className="files-control">
          <span>Kind</span>
          <select value={filters.kind} onChange={(e) => setFilters((cur) => ({ ...cur, kind: e.target.value as ArtifactKind | '' }))}>
            {KIND_OPTIONS.map((opt) => <option key={opt.value || 'all'} value={opt.value}>{opt.label}</option>)}
          </select>
        </label>
        <label className="files-control">
          <span>Source</span>
          <select value={filters.source} onChange={(e) => setFilters((cur) => ({ ...cur, source: e.target.value as ArtifactSource | '' }))}>
            {SOURCE_OPTIONS.map((opt) => <option key={opt.value || 'all'} value={opt.value}>{opt.label}</option>)}
          </select>
        </label>
        <div className="files-sort-note">
          <span>Sort</span>
          <b>Last indexed ↓</b>
        </div>
        {hasFilters(filters) && <button className="ghost-btn files-clear" onClick={clearFilters}>Clear</button>}
      </div>

      <div className="files-results">
        {inlineLoading && <div className="files-inline-progress" />}
        {error ? (
          <FilesError message={error} onRetry={fetchFirst} />
        ) : loading && !initialLoaded ? (
          <FilesSkeleton />
        ) : items.length === 0 ? (
          <FilesEmpty filtered={filtered} filters={effectiveFilters} onClear={clearFilters} />
        ) : (
          <>
            <div className="files-list">
              {items.map((item) => (
                <ArtifactRow
                  key={item.id}
                  item={item}
                  expanded={expandedId === item.id}
                  onToggle={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
                />
              ))}
            </div>
            {hasMore && (
              <div className="files-more-wrap">
                {loadMoreError && <div className="files-more-error">{loadMoreError}</div>}
                <button className="act-btn files-more" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? 'Loading…' : `Load ${PAGE_SIZE} more`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
});

function FilesSkeleton() {
  return (
    <div className="files-skeleton">
      {Array.from({ length: 8 }).map((_, i) => <div className="skel" style={{ height: 38 }} key={i} />)}
    </div>
  );
}

function FilesEmpty({ filtered, filters, onClear }: { filtered: boolean; filters: ArtifactFilters; onClear: () => void }) {
  if (filtered) {
    return (
      <div className="files-empty">
        <div className="files-empty-title">No files match those filters.</div>
        <div className="files-filter-values">{filterSummary(filters)}</div>
        <button className="ghost-btn" onClick={onClear}>Clear filters</button>
      </div>
    );
  }
  return (
    <div className="files-empty">
      <div className="files-empty-title">No artifacts indexed yet.</div>
      <div className="files-empty-copy">Run the indexer to populate this surface:</div>
      <div className="files-filter-values">node scripts/cc-index-artifacts.mjs --url ... --token ...</div>
    </div>
  );
}

function FilesError({ message, onRetry }: { message: string; onRetry: () => void | Promise<void> }) {
  return (
    <div className="err-wrap">
      <div className="err-ico">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FF8092" strokeWidth="2" strokeLinecap="round">
          <path d="M12 8v5M12 17h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>
      <div className="err-h">Couldn't read the file index</div>
      <div className="err-p">The Files surface reads the cc-read-artifacts edge function with a GET request.</div>
      <div className="err-detail">{message}</div>
      <button className="btn-primary" style={{ width: 'auto', padding: '11px 22px' }} onClick={() => void onRetry()}>
        Retry
      </button>
    </div>
  );
}

function ArtifactRow({ item, expanded, onToggle }: { item: Artifact; expanded: boolean; onToggle: () => void }) {
  function open() {
    if (item.url) window.open(item.url, '_blank', 'noopener');
    else onToggle();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  }

  return (
    <div className={'file-row-wrap' + (expanded ? ' expanded' : '')}>
      <div className="file-row" role="button" tabIndex={0} onClick={open} onKeyDown={onKeyDown}>
        <span className={'kind-chip kind-' + item.kind}>{KIND_LABEL[item.kind]}</span>
        <div className="file-title" title={item.title}>{item.title}</div>
        <div className="file-path" title={item.path ?? item.url ?? undefined}>{item.path ?? item.url ?? '—'}</div>
        <div className="file-size">{bytes(item.byte_size)}</div>
        <div className="file-age">{ago(item.last_indexed_at) ?? '—'}</div>
      </div>
      {expanded && !item.url && <ArtifactDrawer item={item} />}
    </div>
  );
}

function ArtifactDrawer({ item }: { item: Artifact }) {
  const rawHref = item.path ? encodeURI(`file://${LOCAL_REPO}/${item.path}`) : null;
  return (
    <div className="file-drawer">
      <div className="file-summary">{item.summary ?? 'No summary indexed for this artifact.'}</div>
      <div className="file-detail-grid">
        <Detail label="Path" value={item.path ?? '—'} mono />
        <Detail label="Kind" value={item.kind} />
        <Detail label="Source" value={sourceLabel(item.source)} />
        <Detail label="Bytes" value={bytes(item.byte_size)} mono />
        <Detail label="SHA" value={middleTruncate(item.content_sha)} mono title={item.content_sha ?? undefined} />
        <Detail label="Produced by" value={item.produced_by ?? '—'} />
        <Detail label="Discovered" value={ago(item.discovered_at) ?? item.discovered_at} />
        <Detail label="Indexed" value={ago(item.last_indexed_at) ?? item.last_indexed_at} />
      </div>
      <div className="file-drawer-actions">
        <button className="ghost-btn" disabled={!item.path} onClick={() => item.path && void navigator.clipboard.writeText(item.path)}>
          Copy path
        </button>
        {rawHref && (
          <a className="ghost-btn file-raw-link" href={rawHref} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            View raw
          </a>
        )}
      </div>
    </div>
  );
}

function Detail({ label, value, mono = false, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="file-detail">
      <span>{label}</span>
      <b className={mono ? 'mono' : undefined} title={title ?? value}>{value}</b>
    </div>
  );
}
