import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, type ReactNode } from 'react';
import {
  ago, colorFor, loadAllDecisions, loadAuditPage, loadSettings,
  type ActivityEvent, type AggregatorSchedule, type AllDecisionsPayload, type AuditPage, type DecisionAdminRow, type IntegrationsAppBreakdown,
  type IntegrationStatus, type SecretInventory, type SettingsPayload,
} from './lib';
import { SlideOver } from './SlideOver';

export type SettingsViewHandle = {
  refresh: () => Promise<void>;
};

type LoadState = 'loading' | 'ready' | 'error';

const GITHUB_APP_URL = 'https://github.com/settings/apps/3803517';
const ACCESS_DOC_URL = 'https://github.com/lewis4x4/blackrock-command-center/blob/main/docs/CLOUDFLARE_ACCESS_SETUP.md';
const HIDDEN_AUDIT_EVENTS = new Set(['detail_read', 'agents_page_read', 'decisions_page_read', 'settings_page_read', 'secret_read']);
const STATUS_ORDER: IntegrationStatus[] = ['live', 'demo', 'manual_safe', 'planned'];

const emptySettings: SettingsPayload = {
  account: { auth_mode: 'read_token', actor: 'unknown', email: null },
  aggregator: { jobname: 'cc-aggregator-5min', schedule: '*/5 * * * *', active: null, last_successful_at: null, next_eta_at: null },
  integrations: { totals: { live: 0, demo: 0, manual_safe: 0, planned: 0 }, by_app: [] },
  secrets: [],
  audit_preview: [],
};

const emptyAudit: AuditPage = { events: [], cursor: { next: null, has_more: false } };
const emptyAllDecisions: AllDecisionsPayload = { decisions: [] };
type DecisionAdminFilter = 'all' | 'open' | 'routed' | 'awaiting_reply' | 'late_replies' | 'answered' | 'done';

export const SettingsView = forwardRef<SettingsViewHandle, { demo: boolean }>(function SettingsView({ demo }, ref) {
  const [state, setState] = useState<LoadState>('loading');
  const [payload, setPayload] = useState<SettingsPayload>(emptySettings);
  const [audit, setAudit] = useState<AuditPage>(emptyAudit);
  const [allDecisions, setAllDecisions] = useState<AllDecisionsPayload>(emptyAllDecisions);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  async function refresh() {
    setState('loading');
    setError('');
    try {
      const [settings, auditPage, decisionsPayload] = await Promise.all([
        loadSettings(demo),
        loadAuditPage(demo),
        loadAllDecisions(demo),
      ]);
      setPayload(settings);
      setAudit(filterAuditPage(auditPage));
      setAllDecisions(decisionsPayload);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPayload(emptySettings);
      setAudit(emptyAudit);
      setAllDecisions(emptyAllDecisions);
      setState('error');
    }
  }

  async function loadMore() {
    if (!audit.cursor.next) return;
    setLoadingMore(true);
    try {
      const next = filterAuditPage(await loadAuditPage(demo, audit.cursor.next));
      setAudit((current) => ({
        events: [...current.events, ...next.events],
        cursor: next.cursor,
        generated_at: next.generated_at,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  useImperativeHandle(ref, () => ({ refresh }));

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  return (
    <div className="settings-page">
      <SettingsHeader loading={state === 'loading'} generatedAt={payload.generated_at} payload={payload} onRefresh={refresh} />
      {state === 'error' && <div className="detail-note error">Settings read failed: {error}</div>}
      <AccountBand payload={payload} loading={state === 'loading'} />
      <AggregatorBand schedule={payload.aggregator} loading={state === 'loading'} />
      <ExtractionQualityBand payload={payload} loading={state === 'loading'} />
      <IntegrationsBand apps={payload.integrations.by_app} totals={payload.integrations.totals} loading={state === 'loading'} />
      <SecretsBand secrets={payload.secrets} loading={state === 'loading'} />
      <AuditBand audit={audit} loading={state === 'loading'} loadingMore={loadingMore} onLoadMore={loadMore} />
      <DecisionsAdminBand payload={allDecisions} loading={state === 'loading'} />
    </div>
  );
});

function SettingsHeader({ loading, generatedAt, payload, onRefresh }: { loading: boolean; generatedAt?: string; payload: SettingsPayload; onRefresh: () => void | Promise<void> }) {
  const secretSet = payload.secrets.filter((secret) => secret.is_set).length;
  const integrationTotal = STATUS_ORDER.reduce((total, status) => total + payload.integrations.totals[status], 0);
  return (
    <section className="agents-hero settings-hero">
      <div className="agents-hero-copy">
        <div className="detail-eyebrow">Settings</div>
        <h1>Control-plane configuration</h1>
        <p>Read-only account, schedule, integrations, secret pointers, and audit trail. Secret values never leave the edge runtime.</p>
      </div>
      <div className="agents-hero-actions">
        <span className="detail-key">Updated {ago(generatedAt) ?? '—'}</span>
        <button className={'refresh' + (loading ? ' spin' : '')} onClick={() => void onRefresh()} disabled={loading}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          {loading ? 'Refreshing…' : 'Refresh settings'}
        </button>
      </div>
      <div className="agents-metrics settings-metrics">
        <Metric label="Secret refs set" value={`${secretSet} / ${payload.secrets.length}`} tone={secretSet === payload.secrets.length && payload.secrets.length ? 'green' : 'amber'} />
        <Metric label="Integrations" value={String(integrationTotal)} />
        <Metric label="Audit preview" value={String(payload.audit_preview.length)} />
      </div>
    </section>
  );
}

function AccountBand({ payload, loading }: { payload: SettingsPayload; loading: boolean }) {
  const via = payload.account.auth_mode === 'access_jwt' ? 'via Cloudflare Access' : 'via operator read token';
  return (
    <SettingsSection num="1" title="Account" subtitle="Identity is resolved by the edge function. No logout or password controls live here." count={1}>
      {loading ? <SkeletonRows /> : (
        <div className="settings-account-card">
          <div>
            <div className="settings-primary">Signed in as <b>{payload.account.actor}</b> <span>({via})</span></div>
            {payload.account.email && <div className="settings-muted">Access email: {payload.account.email}</div>}
          </div>
          <div className="settings-link-row">
            <a href={GITHUB_APP_URL} target="_blank" rel="noreferrer">Manage GitHub App →</a>
            <a href={ACCESS_DOC_URL} target="_blank" rel="noreferrer">Cloudflare Access setup →</a>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

function AggregatorBand({ schedule, loading }: { schedule: AggregatorSchedule; loading: boolean }) {
  const healthy = schedule.active !== false && freshnessOk(schedule.last_successful_at);
  return (
    <SettingsSection num="2" title="Aggregator" subtitle="pg_cron schedule read server-side. The cron command is intentionally not exposed." count={1}>
      {loading ? <SkeletonRows /> : (
        <div className="settings-aggregator-grid">
          <div className="settings-cron-card">
            <span>Cron expression</span>
            <b>{schedule.schedule}</b>
          </div>
          <InfoCard label="Jobname" value={schedule.jobname} />
          <InfoCard label="Last run" value={schedule.last_successful_at ? ago(schedule.last_successful_at) ?? 'just now' : '—'} dot={healthy ? 'green' : 'red'} />
          <InfoCard label="Next ETA" value={etaLabel(schedule.next_eta_at)} />
        </div>
      )}
    </SettingsSection>
  );
}

function ExtractionQualityBand({ payload, loading }: { payload: SettingsPayload; loading: boolean }) {
  const m = payload.extraction_metrics;
  return (
    <SettingsSection num="2.5" title="Extraction quality" subtitle="14-day auto-commit vs revert rate window." count={m ? 1 : 0}>
      {loading ? <SkeletonRows /> : !m ? <Empty title="No extraction metrics" copy="Metrics view not available yet." /> : (
        <div className="settings-aggregator-grid">
          <InfoCard label="Auto-commits (14d)" value={String(m.auto_commits_14d)} />
          <InfoCard label="Reverts (14d)" value={String(m.reverts_14d)} />
          <InfoCard label="Revert rate" value={`${(m.revert_rate_14d * 100).toFixed(2)}%`} />
          <InfoCard label="Threshold" value={String(m.current_threshold)} />
        </div>
      )}
    </SettingsSection>
  );
}

function IntegrationsBand({ apps, totals, loading }: { apps: IntegrationsAppBreakdown[]; totals: Record<IntegrationStatus, number>; loading: boolean }) {
  const [openApp, setOpenApp] = useState<string | null>(null);
  return (
    <SettingsSection num="3" title="Integrations" subtitle="Cross-app integration counts by status, plus per-app drill-down." count={apps.length}>
      {loading ? <SkeletonRows /> : (
        <>
          <div className="settings-status-grid">
            {STATUS_ORDER.map((status) => <StatusTile key={status} status={status} value={totals[status]} />)}
          </div>
          <div className="settings-app-list">
            {apps.length === 0 ? <Empty title="No integrations" copy="No registry integration rows have been added yet." /> : apps.map((app) => {
              const open = openApp === app.app_id;
              return (
                <button className="settings-app-row" key={app.app_id} onClick={() => setOpenApp(open ? null : app.app_id)}>
                  <div className="agents-app">
                    <span className="badge" style={{ background: colorFor(app.app_short_code) }}>{app.app_short_code[0]}</span>
                    <div><b>{app.app_display_name}</b><span>{app.app_short_code}</span></div>
                  </div>
                  <span className="settings-muted">{app.integrations.length} integration{app.integrations.length === 1 ? '' : 's'}</span>
                  {open && (
                    <div className="settings-integration-panel">
                      {app.integrations.map((integration, index) => (
                        <div className="settings-integration-row" key={`${integration.type ?? 'integration'}-${index}`}>
                          <b>{integration.type ?? 'unknown'}</b>
                          <span className={'status-chip ' + integration.status}>{label(integration.status)}</span>
                          <em>{integration.last_verified_at ? `Verified ${ago(integration.last_verified_at) ?? 'recently'} ago` : 'Not verified yet'}</em>
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

function SecretsBand({ secrets, loading }: { secrets: SecretInventory[]; loading: boolean }) {
  const global = secrets.filter((secret) => !secret.app_short_code);
  const groups = useMemo(() => {
    const map = new Map<string, SecretInventory[]>();
    for (const secret of secrets.filter((item) => item.app_short_code)) {
      const key = secret.app_short_code ?? 'APP';
      map.set(key, [...(map.get(key) ?? []), secret]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [secrets]);

  return (
    <SettingsSection num="4" title="Secrets" subtitle="Pointer inventory only. Zero inputs, zero buttons, zero secret values." count={secrets.length}>
      {loading ? <SkeletonRows /> : secrets.length === 0 ? <Empty title="No secret refs" copy="Secret pointer rows will appear after apps are registered." /> : (
        <div className="settings-secret-groups">
          {global.length > 0 && <SecretGroup title="Global" secrets={global} />}
          {groups.map(([app, rows]) => <SecretGroup key={app} title={app} secrets={rows} />)}
        </div>
      )}
    </SettingsSection>
  );
}

function AuditBand({ audit, loading, loadingMore, onLoadMore }: { audit: AuditPage; loading: boolean; loadingMore: boolean; onLoadMore: () => void | Promise<void> }) {
  return (
    <SettingsSection num="5" title="Audit log" subtitle="Append-only stream. Telemetry reads and secret-read noise are hidden from this operator view." count={audit.events.length}>
      {loading ? <SkeletonRows /> : audit.events.length === 0 ? <Empty title="No audit rows" copy="The audit log is quiet after telemetry filtering." /> : (
        <>
          <div className="settings-audit-list">
            {audit.events.map((event, index) => <AuditRow key={`${event.occurred_at}-${event.event_type}-${index}`} event={event} />)}
          </div>
          {audit.cursor.has_more && (
            <div className="settings-load-more">
              <button className="ghost-btn" onClick={() => void onLoadMore()} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
            </div>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function DecisionsAdminBand({ payload, loading }: { payload: AllDecisionsPayload; loading: boolean }) {
  const [filter, setFilter] = useState<DecisionAdminFilter>('all');
  const [selected, setSelected] = useState<DecisionAdminRow | null>(null);
  const rows = useMemo(() => payload.decisions.filter((row) => decisionAdminMatches(row, filter)), [payload.decisions, filter]);
  const filters: Array<{ id: DecisionAdminFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'open', label: 'Open' },
    { id: 'routed', label: 'Routed' },
    { id: 'awaiting_reply', label: 'Awaiting reply' },
    { id: 'late_replies', label: 'Late replies' },
    { id: 'answered', label: 'Answered' },
    { id: 'done', label: 'Done' },
  ];
  return (
    <SettingsSection num="6" title="Decisions admin" subtitle="All decisions, across all states, regardless of the lookback window." count={rows.length}>
      {loading ? <SkeletonRows /> : payload.decisions.length === 0 ? <Empty title="No decisions" copy="No control-plane decision rows were returned." /> : (
        <>
          <div className="settings-decision-filters">
            {filters.map((item) => (
              <button key={item.id} className={'decision-chip' + (filter === item.id ? ' active' : '')} onClick={() => setFilter(item.id)}>{item.label}</button>
            ))}
          </div>
          {rows.length === 0 ? <Empty title="No matching decisions" copy="Try a different filter." /> : (
            <div className="settings-decisions-table-wrap">
              <table className="agents-table settings-decisions-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>App</th>
                    <th>Last action</th>
                    <th>Send count</th>
                    <th>Answer count</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="settings-decision-row" onClick={() => setSelected(row)} tabIndex={0} onKeyDown={(ev) => { if (ev.key === 'Enter') setSelected(row); }}>
                      <td><div className="agents-primary">{row.title}</div><div className="agents-muted">{row.source_ref || row.id}</div></td>
                      <td><span className={'status-chip ' + row.status}>{label(row.status)}</span>{row.late_reply_count > 0 && <span className="settings-late-pill">Late reply</span>}</td>
                      <td>{row.app_short_code ?? row.app_display_name ?? '—'}</td>
                      <td><div className="agents-primary">{row.last_action ?? '—'}</div><div className="agents-muted">{ago(row.last_action_at ?? row.updated_at ?? undefined) ?? '—'} ago</div></td>
                      <td>{row.send_count}</td>
                      <td>{row.answer_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <DecisionHistoryPanel row={selected} onClose={() => setSelected(null)} />
        </>
      )}
    </SettingsSection>
  );
}

function DecisionHistoryPanel({ row, onClose }: { row: DecisionAdminRow | null; onClose: () => void }) {
  const events = useMemo(() => row ? buildDecisionTimeline(row) : [], [row]);
  return (
    <SlideOver open={!!row} title={row?.title ?? 'Decision'} subtitle={row ? `${row.app_short_code ?? row.app_display_name ?? 'App'} · ${label(row.status)} · ${row.source_ref || row.id}` : undefined} onClose={onClose}>
      {row && (
        <>
          <div className="settings-decision-summary">
            <InfoCard label="Status" value={label(row.status)} />
            <InfoCard label="Sends" value={String(row.send_count)} />
            <InfoCard label="Answers" value={String(row.answer_count)} />
            <InfoCard label="Late replies" value={String(row.late_reply_count)} />
          </div>
          {row.summary && <div className="panel-note">{row.summary}</div>}
          <div className="panel-section">
            <div className="panel-label">Full history</div>
            <div className="panel-stack">
              {events.length === 0 ? <Empty title="No history" copy="No sends, answers, or audit events were returned." /> : events.map((event, index) => (
                <div className="panel-card" key={`${event.at}-${event.kind}-${index}`}>
                  <b>{event.label}</b>
                  <span>{event.at ? `${ago(event.at) ?? '—'} ago` : 'time unknown'} · {event.actor ?? event.kind}</span>
                  {event.detail && <em>{event.detail}</em>}
                </div>
              ))}
            </div>
          </div>
          <div className="panel-section">
            <div className="panel-label">Debug detail</div>
            <pre className="settings-debug-json">{JSON.stringify({ detail: row.detail, context: row.context }, null, 2)}</pre>
          </div>
        </>
      )}
    </SlideOver>
  );
}

function SettingsSection({ num, title, subtitle, count, children }: { num: string; title: string; subtitle: string; count: number; children: ReactNode }) {
  return (
    <section className="band agents-section settings-section">
      <div className="band-head">
        <span className="band-num">{num}</span>
        <div>
          <div className="band-title">{title}</div>
          <div className="band-sub">{subtitle}</div>
        </div>
        <span className="count-chip">{count}</span>
      </div>
      <div className="agents-section-body settings-section-body">{children}</div>
    </section>
  );
}

function SecretGroup({ title, secrets }: { title: string; secrets: SecretInventory[] }) {
  return (
    <div className="settings-secret-group">
      <div className="settings-secret-title">{title}</div>
      <div className="settings-secret-chips">
        {secrets.map((secret) => (
          <div className="settings-secret-chip" key={`${title}-${secret.column}-${secret.ref_name}`}>
            <span className="dot" style={{ background: secret.is_set ? 'var(--green)' : 'var(--grey)' }} />
            <b>{secret.ref_name}</b>
            <em>{secret.is_set ? 'SET' : 'NOT-SET'}</em>
            <small>{label(secret.column)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function AuditRow({ event }: { event: ActivityEvent }) {
  return (
    <div className="settings-audit-row">
      <div className="feed-ico">{event.short_code?.[0] ?? '•'}</div>
      <div className="feed-text">
        <div className="feed-title">{label(event.event_type)}{event.short_code ? ` · ${event.short_code}` : ''}</div>
        <div className="feed-meta">{event.actor} · {detailPreview(event.detail)}</div>
      </div>
      <div className="feed-time">{ago(event.occurred_at) ?? '—'} ago</div>
    </div>
  );
}

function StatusTile({ status, value }: { status: IntegrationStatus; value: number }) {
  return (
    <div className={'settings-status-tile ' + status}>
      <span>{label(status)}</span>
      <b>{value}</b>
    </div>
  );
}

function InfoCard({ label: title, value, dot }: { label: string; value: string; dot?: 'green' | 'red' }) {
  return (
    <div className="settings-info-card">
      <span>{title}</span>
      <b>{dot && <i className="dot" style={{ background: dot === 'green' ? 'var(--green)' : 'var(--red)' }} />}{value}</b>
    </div>
  );
}

function Metric({ label: title, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="detail-metric">
      <span>{title}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}

function Empty({ title, copy }: { title: string; copy: string }) {
  return <div className="detail-placeholder agents-empty"><b>{title}</b><span>{copy}</span></div>;
}

function SkeletonRows() {
  return (
    <div className="agents-skeleton">
      {Array.from({ length: 3 }).map((_, i) => <div className="skel" key={i} style={{ height: 54 }} />)}
    </div>
  );
}

function filterAuditPage(page: AuditPage): AuditPage {
  return { ...page, events: page.events.filter((event) => !HIDDEN_AUDIT_EVENTS.has(event.event_type)) };
}

function decisionAdminMatches(row: DecisionAdminRow, filter: DecisionAdminFilter): boolean {
  const status = String(row.status);
  if (filter === 'all') return true;
  if (filter === 'open') return ['surfaced', 'triaging', 'gated'].includes(status);
  if (filter === 'routed') return status === 'routed_to_client';
  if (filter === 'awaiting_reply') return status === 'routed_to_client' && row.answer_count === 0;
  if (filter === 'late_replies') return row.late_reply_count > 0;
  if (filter === 'answered') return status === 'answered' || row.answer_count > 0;
  if (filter === 'done') return status === 'done';
  return true;
}

function buildDecisionTimeline(row: DecisionAdminRow): Array<{ at: string | null; kind: string; label: string; actor?: string | null; detail?: string | null }> {
  const events: Array<{ at: string | null; kind: string; label: string; actor?: string | null; detail?: string | null }> = [];
  for (const send of row.sends) {
    events.push({
      at: textField(send, 'sent_at') ?? textField(send, 'created_at'),
      kind: 'send',
      label: `Email ${textField(send, 'state') ?? 'send'}`,
      actor: textField(send, 'recipient_email'),
      detail: textField(send, 'raw_decision_title') ?? textField(send, 'last_error'),
    });
    const replyAt = textField(send, 'inbound_received_at') ?? textField(send, 'replied_at');
    if (replyAt) events.push({ at: replyAt, kind: 'reply', label: 'Reply received', actor: textField(send, 'recipient_email'), detail: textField(send, 'raw_reply_text') });
  }
  for (const answer of row.answers) {
    events.push({
      at: textField(answer, 'answered_at') ?? textField(answer, 'created_at'),
      kind: 'answer',
      label: `Answered: ${textField(answer, 'answer_value') ?? 'choice'}`,
      actor: textField(answer, 'answered_by'),
      detail: textField(answer, 'rationale'),
    });
  }
  for (const late of row.late_replies) {
    events.push({
      at: textField(late, 'created_at') ?? textField(late, 'surfaced_at'),
      kind: 'late_reply',
      label: textField(late, 'title') ?? 'Late reply arrived',
      actor: textField(recordField(late, 'detail'), 'recipient_email'),
      detail: textField(late, 'summary'),
    });
  }
  for (const auditEvent of row.audit_events) {
    events.push({
      at: auditEvent.occurred_at ?? null,
      kind: 'audit',
      label: label(auditEvent.event_type ?? 'audit event'),
      actor: auditEvent.actor ?? null,
      detail: detailPreview(auditEvent.detail ?? null),
    });
  }
  return events.sort((a, b) => timeMs(b.at) - timeMs(a.at));
}

function recordField(row: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = row[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textField(row: Record<string, unknown> | null, key: string): string | null {
  const value = row?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timeMs(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Date.parse(value);
  return Number.isNaN(n) ? 0 : n;
}

function freshnessOk(value: string | null): boolean {
  if (!value) return false;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < 12 * 60_000;
}

function etaLabel(value: string | null): string {
  if (!value) return '—';
  const delta = Date.parse(value) - Date.now();
  if (Number.isNaN(delta)) return '—';
  if (delta <= 0) return 'due now';
  const minutes = Math.max(1, Math.round(delta / 60_000));
  return `~${minutes}m`;
}

function detailPreview(detail: Record<string, unknown> | null): string {
  if (!detail) return 'no detail';
  const keys = Object.keys(detail).filter((key) => !/secret|token|key/i.test(key)).slice(0, 3);
  if (keys.length === 0) return 'detail hidden';
  return keys.map((key) => `${key}: ${String(detail[key]).slice(0, 40)}`).join(' · ');
}

function label(value: string): string {
  return value.replace(/_/g, ' ');
}
