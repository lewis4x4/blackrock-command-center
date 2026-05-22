import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { SlideOver } from './SlideOver';
import { DecisionAnswerBody, useDecisionAnswerFlow } from './TriagePanels';
import {
  ago, colorFor, decisionAgeDays, decisionRowId, decisionRowIssueId, decisionRowOwnerKind, decisionRowTitle, loadDecisions,
  type AnsweredDecisionSummary, type DecisionAgeFilter, type DecisionOwnerFilter, type DecisionRow, type DecisionsAppStatus,
  type DecisionsFilters, type DecisionsPayload, type DecisionSort,
} from './lib';

export type DecisionsViewHandle = {
  refresh: () => Promise<void>;
};

type LoadState = 'loading' | 'ready' | 'error';

const emptyDecisions: DecisionsPayload = {
  apps_reached: [],
  apps_unreachable: [],
  apps_unwired: [],
  decisions: [],
  answered_recent: [],
};

export const DecisionsView = forwardRef<DecisionsViewHandle, { demo: boolean }>(function DecisionsView({ demo }, ref) {
  const [state, setState] = useState<LoadState>('loading');
  const [payload, setPayload] = useState<DecisionsPayload>(emptyDecisions);
  const [error, setError] = useState('');
  const [appId, setAppId] = useState('');
  const [ownerKind, setOwnerKind] = useState<DecisionOwnerFilter>('all');
  const [age, setAge] = useState<DecisionAgeFilter>('all');
  const [sort, setSort] = useState<DecisionSort>('oldest');
  const [openDecision, setOpenDecision] = useState<DecisionRow | null>(null);

  const filters: DecisionsFilters = useMemo(() => ({
    app_id: appId || undefined,
    owner_kind: ownerKind,
    age,
    sort,
  }), [appId, ownerKind, age, sort]);

  async function refresh() {
    setState('loading');
    setError('');
    try {
      const next = await loadDecisions(filters, demo);
      setPayload(next);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPayload(emptyDecisions);
      setState('error');
    }
  }

  useImperativeHandle(ref, () => ({ refresh }));

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, filters]);

  const ownerCounts = ownerBreakdown(payload.decisions);
  const appOptions = appChoices(payload);

  return (
    <div className="decisions-page">
      <DecisionsHeader
        loading={state === 'loading'}
        generatedAt={payload.generated_at}
        openCount={payload.decisions.length}
        operatorCount={ownerCounts.operator}
        clientCount={ownerCounts.client}
        unknownCount={ownerCounts.unknown}
        onRefresh={refresh}
      />
      {state === 'error' && <div className="detail-note error">Decisions read failed: {error}</div>}
      <FilterBand
        appId={appId}
        appOptions={appOptions}
        ownerKind={ownerKind}
        age={age}
        sort={sort}
        onAppId={setAppId}
        onOwnerKind={setOwnerKind}
        onAge={setAge}
        onSort={setSort}
      />
      <DecisionsBand decisions={payload.decisions} loading={state === 'loading'} onOpen={setOpenDecision} />
      <WiringNotes unwired={payload.apps_unwired} unreachable={payload.apps_unreachable} />
      <AnsweredBand rows={payload.answered_recent} loading={state === 'loading'} />
      {openDecision && <DecisionDrawer decision={openDecision} demo={demo} onClose={() => setOpenDecision(null)} onAnswered={refresh} />}
    </div>
  );
});

function DecisionsHeader({ loading, generatedAt, openCount, operatorCount, clientCount, unknownCount, onRefresh }: {
  loading: boolean;
  generatedAt?: string;
  openCount: number;
  operatorCount: number;
  clientCount: number;
  unknownCount: number;
  onRefresh: () => void | Promise<void>;
}) {
  return (
    <section className="agents-hero decisions-hero">
      <div className="agents-hero-copy">
        <div className="detail-eyebrow">Decisions inbox</div>
        <h1>Clear every app’s open questions</h1>
        <p>Federated read across registered apps. The control plane tags rows by app but does not store client decision content.</p>
      </div>
      <div className="agents-hero-actions">
        <span className="detail-key">Updated {ago(generatedAt) ?? '—'}</span>
        <button className={'refresh' + (loading ? ' spin' : '')} onClick={() => void onRefresh()} disabled={loading}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          {loading ? 'Refreshing…' : 'Refresh decisions'}
        </button>
      </div>
      <div className="agents-metrics decisions-metrics">
        <Metric label="Open decisions" value={String(openCount)} tone={openCount ? 'amber' : 'green'} />
        <Metric label="Operator-owned" value={String(operatorCount)} tone={operatorCount ? 'amber' : 'green'} />
        <Metric label="Client / unknown" value={`${clientCount} / ${unknownCount}`} tone={clientCount || unknownCount ? 'blue' : 'green'} />
      </div>
    </section>
  );
}

function FilterBand({ appId, appOptions, ownerKind, age, sort, onAppId, onOwnerKind, onAge, onSort }: {
  appId: string;
  appOptions: { id: string; code: string; name: string }[];
  ownerKind: DecisionOwnerFilter;
  age: DecisionAgeFilter;
  sort: DecisionSort;
  onAppId: (value: string) => void;
  onOwnerKind: (value: DecisionOwnerFilter) => void;
  onAge: (value: DecisionAgeFilter) => void;
  onSort: (value: DecisionSort) => void;
}) {
  return (
    <section className="band decisions-filter-band">
      <div className="decisions-filterbar">
        <label className="files-control decisions-app-filter">
          <span>App</span>
          <select value={appId} onChange={(ev) => onAppId(ev.target.value)}>
            <option value="">All apps</option>
            {appOptions.map((app) => <option key={app.id} value={app.id}>{app.code} · {app.name}</option>)}
          </select>
        </label>
        <ChipGroup label="Owner" value={ownerKind} options={[['all', 'All'], ['operator', 'Operator'], ['client', 'Client'], ['unknown', 'Unknown']]} onChange={(value) => onOwnerKind(value as DecisionOwnerFilter)} />
        <ChipGroup label="Age" value={age} options={[['all', 'All'], ['0-2', '0–2d'], ['3-7', '3–7d'], ['8+', '8+d']]} onChange={(value) => onAge(value as DecisionAgeFilter)} />
        <button className="ghost-btn decisions-sort" onClick={() => onSort(sort === 'oldest' ? 'newest' : 'oldest')}>
          {sort === 'oldest' ? 'Oldest first' : 'Newest first'}
        </button>
      </div>
    </section>
  );
}

function ChipGroup({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="decisions-chipgroup">
      <span>{label}</span>
      <div>
        {options.map(([id, text]) => (
          <button key={id} className={'decision-chip' + (value === id ? ' active' : '')} onClick={() => onChange(id)}>{text}</button>
        ))}
      </div>
    </div>
  );
}

function DecisionsBand({ decisions, loading, onOpen }: { decisions: DecisionRow[]; loading: boolean; onOpen: (decision: DecisionRow) => void }) {
  return (
    <section className="band agents-section decisions-list-band">
      <div className="band-head">
        <span className="band-num">1</span>
        <div>
          <div className="band-title">Open decisions</div>
          <div className="band-sub">Oldest first by default. Operator decisions can create work orders; client routing is stubbed for Phase 5.</div>
        </div>
        <span className="count-chip">{decisions.length}</span>
      </div>
      <div className="decisions-section-body">
        {loading ? <SkeletonCards /> : decisions.length === 0 ? (
          <div className="detail-placeholder agents-empty">
            <b>No open decisions</b>
            <span>Every registered app is unblocked right now.</span>
          </div>
        ) : (
          <div className="decision-card-list">
            {decisions.map((decision) => <DecisionCard key={decisionRowId(decision)} decision={decision} onOpen={onOpen} />)}
          </div>
        )}
      </div>
    </section>
  );
}

function DecisionCard({ decision, onOpen }: { decision: DecisionRow; onOpen: (decision: DecisionRow) => void }) {
  const owner = decisionRowOwnerKind(decision);
  const risk = riskClass(decision);
  const options = decisionOptions(decision);
  return (
    <button className={'decision-card ' + owner} onClick={() => onOpen(decision)}>
      <div className="decision-card-top">
        <div className="agents-app">
          <span className="badge" style={{ background: colorFor(decision.app_short_code) }}>{decision.app_short_code[0]}</span>
          <div>
            <b>{decision.app_display_name}</b>
            <span>{decision.app_short_code}</span>
          </div>
        </div>
        <span className={'risk-chip ' + risk}>{risk}</span>
      </div>
      <div className="decision-title">{decisionRowTitle(decision)}</div>
      <div className="decision-meta">
        <span>{ownerLabel(owner)} owned</span>
        <span>{ageLabel(decision)}</span>
        <span>{text(decision.status) ?? 'open'}</span>
      </div>
      <div className="decision-options">{options.length ? options.slice(0, 3).map((option) => option.label).join(' · ') : 'No enumerated options returned.'}</div>
      {owner === 'client' && (
        <span className="ghost-btn decision-route" onClick={(ev) => { ev.stopPropagation(); alert('Routing decisions to clients arrives in Phase 5.'); }}>Route to client</span>
      )}
    </button>
  );
}

function WiringNotes({ unwired, unreachable }: { unwired: DecisionsAppStatus[]; unreachable: DecisionsAppStatus[] }) {
  if (unwired.length === 0 && unreachable.length === 0) return null;
  return (
    <section className="decisions-wiring-note">
      {unwired.length > 0 && <span>Apps not wired yet: {unwired.map((app) => `${app.app_short_code}${app.reason ? ` (${app.reason})` : ''}`).join(', ')}.</span>}
      {unreachable.length > 0 && <span>Apps unreachable: {unreachable.map((app) => `${app.app_short_code}${app.reason ? ` (${app.reason})` : ''}`).join(', ')}.</span>}
    </section>
  );
}

function AnsweredBand({ rows, loading }: { rows: AnsweredDecisionSummary[]; loading: boolean }) {
  return (
    <section className="band agents-section">
      <div className="band-head">
        <span className="band-num">2</span>
        <div>
          <div className="band-title">Recently answered</div>
          <div className="band-sub">Latest operator answers recorded in the control plane ledger.</div>
        </div>
        <span className="count-chip">{rows.length}</span>
      </div>
      {loading ? <SkeletonCards /> : rows.length === 0 ? (
        <div className="detail-placeholder agents-empty">
          <b>No recent answers</b>
          <span>Answered decisions will appear here after the first one is recorded.</span>
        </div>
      ) : (
        <div className="answered-list">
          {rows.map((row) => (
            <div className="answered-row" key={row.id}>
              <div className="agents-app">
                <span className="badge" style={{ background: colorFor(row.app_short_code ?? 'APP') }}>{(row.app_short_code ?? 'A')[0]}</span>
                <div>
                  <b>{row.app_display_name ?? row.app_short_code ?? 'App'}</b>
                  <span>{row.app_short_code ?? '—'}</span>
                </div>
              </div>
              <div className="answered-main">
                <b>{row.decision_external_ref ?? 'Decision answered'}</b>
                <span>{row.answer_value} · {row.risk_class}</span>
              </div>
              <div className="answered-age">{ago(row.answered_at) ?? '—'}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DecisionDrawer({ decision, demo, onClose, onAnswered }: { decision: DecisionRow; demo: boolean; onClose: () => void; onAnswered: () => void | Promise<void> }) {
  const rows = useMemo(() => [decision], [decision]);
  const flow = useDecisionAnswerFlow({ rows, demo, issueIdForRow: decisionRowIssueId });

  async function closeAfterMaybeRefresh() {
    if (flow.completed) await onAnswered();
    onClose();
  }

  return (
    <SlideOver open title="Decision detail" subtitle={`${decision.app_short_code} · ${ownerLabel(decisionRowOwnerKind(decision))} owned`} onClose={() => void closeAfterMaybeRefresh()} footer={(
      <>
        <button className="ghost-btn" onClick={() => void closeAfterMaybeRefresh()}>{flow.completed ? 'Done' : 'Close'}</button>
        {!flow.completed && flow.operatorRows.length > 0 && (
          <button className="btn-primary panel-primary" onClick={() => void flow.submitAnswer()} disabled={!flow.canSubmit}>
            {flow.busy ? 'Recording…' : 'Answer decision'}
          </button>
        )}
      </>
    )}>
      <DecisionAnswerBody
        flow={flow}
        state="ready"
        error=""
        empty={false}
        emptyCopy="No decision detail returned."
        showRouteToClient
        missingIssueCopy="This app returned a decision row without issue_id/cc_issue_id. The row is visible, but answering requires the app to include the control-plane issue id."
      />
    </SlideOver>
  );
}

function Metric({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="detail-metric">
      <span>{label}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="agents-skeleton">
      {Array.from({ length: 3 }).map((_, i) => <div className="skel" key={i} style={{ height: 92 }} />)}
    </div>
  );
}

function ownerBreakdown(rows: DecisionRow[]): { operator: number; client: number; unknown: number } {
  return rows.reduce((acc, row) => {
    acc[decisionRowOwnerKind(row)] += 1;
    return acc;
  }, { operator: 0, client: 0, unknown: 0 });
}

function appChoices(payload: DecisionsPayload): { id: string; code: string; name: string }[] {
  const map = new Map<string, { id: string; code: string; name: string }>();
  for (const status of [...payload.apps_reached, ...payload.apps_unwired, ...payload.apps_unreachable]) {
    if (status.app_id) map.set(status.app_id, { id: status.app_id, code: status.app_short_code, name: status.app_display_name });
  }
  for (const decision of payload.decisions) {
    map.set(decision.app_id, { id: decision.app_id, code: decision.app_short_code, name: decision.app_display_name });
  }
  return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function decisionOptions(row: Record<string, unknown>): { id: string; label: string }[] {
  const raw = row.options ?? row.answer_options ?? row.choices ?? row.allowed_answers;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === 'string') return { id: item, label: item };
    if (!isRecord(item)) return null;
    const id = text(item.id) ?? text(item.value) ?? text(item.key);
    const label = text(item.label) ?? text(item.name) ?? text(item.title) ?? id;
    return id && label ? { id, label } : null;
  }).filter((item): item is { id: string; label: string } => !!item);
}

function riskClass(row: Record<string, unknown>): string {
  const risk = text(row.risk_class)?.toLowerCase();
  return ['auto', 'authorize', 'destructive', 'production'].includes(risk ?? '') ? risk! : 'authorize';
}

function ownerLabel(owner: 'operator' | 'client' | 'unknown'): string {
  if (owner === 'operator') return 'Operator';
  if (owner === 'client') return 'Client';
  return 'Unknown';
}

function ageLabel(row: Record<string, unknown>): string {
  const age = text(row.age);
  if (age) return age;
  const days = decisionAgeDays(row);
  if (days == null) return 'age unknown';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.round(days)}d`;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
