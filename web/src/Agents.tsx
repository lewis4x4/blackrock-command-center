import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import {
  acknowledgeHandoff, ago, approveWorkOrder, colorFor, loadAgents, loadHandoffs,
  type AgentRun, type AgentsPayload, type AgentWorkOrder, type CostLedgerRow, type OperatorHandoff, type RunnerStatus,
} from './lib';

export type AgentsViewHandle = {
  refresh: () => Promise<void>;
};

const emptyAgents: AgentsPayload = {
  work_orders: { open: [], recent_completed: [] },
  runs: [],
  cost_ledger_summary: { rows: [], grand_total_usd: 0 },
  runner_status: {
    online: false,
    last_seen_at: null,
    note: 'No runner host deployed yet. See docs/handoffs/RUNNER_HOST_SETUP.md.',
  },
};

const RUNNER_DOC_URL = 'https://github.com/lewis4x4/blackrock-command-center/blob/main/docs/handoffs/RUNNER_HOST_SETUP.md';

type LoadState = 'loading' | 'ready' | 'error';

export const AgentsView = forwardRef<AgentsViewHandle, { demo: boolean }>(function AgentsView({ demo }, ref) {
  const [state, setState] = useState<LoadState>('loading');
  const [payload, setPayload] = useState<AgentsPayload>(emptyAgents);
  const [handoffs, setHandoffs] = useState<OperatorHandoff[]>([]);
  const [error, setError] = useState('');

  async function refresh() {
    setState('loading');
    setError('');
    try {
      const [next, nextHandoffs] = await Promise.all([loadAgents(demo), loadHandoffs(demo)]);
      setPayload(next);
      setHandoffs(nextHandoffs);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPayload(emptyAgents);
      setHandoffs([]);
      setState('error');
    }
  }

  useImperativeHandle(ref, () => ({ refresh }));

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  const openOrders = payload.work_orders.open;
  const recentRuns = payload.runs;
  const ledgerRows = payload.cost_ledger_summary.rows;

  return (
    <div className="agents-page">
      <AgentsHeader
        loading={state === 'loading'}
        generatedAt={payload.generated_at}
        openCount={openOrders.length}
        runCount={recentRuns.length}
        totalSpend={payload.cost_ledger_summary.grand_total_usd}
        onRefresh={refresh}
      />
      {state === 'error' && <InlineError message={error} />}
      <RunnerStatusPill status={payload.runner_status} />
      <QueueBand orders={openOrders} loading={state === 'loading'} demo={demo} onChanged={refresh} />
      <OperatorHandoffsPanel handoffs={handoffs} loading={state === 'loading'} demo={demo} onChanged={refresh} />
      <RunsBand runs={recentRuns} loading={state === 'loading'} />
      <CostLedgerBand rows={ledgerRows} grandTotal={payload.cost_ledger_summary.grand_total_usd} loading={state === 'loading'} />
    </div>
  );
});

function AgentsHeader({ loading, generatedAt, openCount, runCount, totalSpend, onRefresh }: {
  loading: boolean;
  generatedAt?: string;
  openCount: number;
  runCount: number;
  totalSpend: number;
  onRefresh: () => void | Promise<void>;
}) {
  return (
    <section className="agents-hero">
      <div className="agents-hero-copy">
        <div className="detail-eyebrow">Agents</div>
        <h1>Work spine</h1>
        <p>Queue, runner attempts, and spend from the control plane. The daemon is not deployed yet; this page shows that honestly.</p>
      </div>
      <div className="agents-hero-actions">
        <span className="detail-key">Updated {ago(generatedAt) ?? '—'}</span>
        <button className={'refresh' + (loading ? ' spin' : '')} onClick={() => void onRefresh()} disabled={loading}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          {loading ? 'Refreshing…' : 'Refresh agents'}
        </button>
      </div>
      <div className="agents-metrics">
        <Metric label="Open orders" value={String(openCount)} tone={openCount ? 'amber' : 'green'} />
        <Metric label="Recent runs" value={String(runCount)} />
        <Metric label="Spend" value={money(totalSpend)} tone={totalSpend ? 'blue' : 'green'} />
      </div>
    </section>
  );
}

function RunnerStatusPill({ status }: { status: RunnerStatus }) {
  return (
    <section className={'runner-status ' + (status.online ? 'online' : 'offline')}>
      <div className="runner-status-main">
        <span className="dot" style={{ background: status.online ? 'var(--green)' : 'var(--amber)' }} />
        <b>{status.online ? `Runner online — last heartbeat ${ago(status.last_seen_at) ?? 'just now'}` : 'No runner deployed'}</b>
      </div>
      <div className="runner-status-copy">
        {status.online ? status.note : <>See <a href={RUNNER_DOC_URL} target="_blank" rel="noreferrer">RUNNER_HOST_SETUP.md</a> for the missing host contract.</>}
      </div>
    </section>
  );
}

type CollapsedNotice = { id: string; title: string; action: string };

function QueueBand({ orders, loading, demo, onChanged }: { orders: AgentWorkOrder[]; loading: boolean; demo: boolean; onChanged: () => void | Promise<void> }) {
  const [pending, setPending] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, CollapsedNotice>>({});
  const [error, setError] = useState('');
  const timers = useRef<Record<string, number>>({});

  useEffect(() => () => {
    Object.values(timers.current).forEach(window.clearTimeout);
  }, []);

  const visibleOrders = orders.filter((order) => !collapsed[order.id]);
  const notices = Object.values(collapsed);

  async function authorize(order: AgentWorkOrder) {
    setPending(order.id);
    setError('');
    try {
      await approveWorkOrder(order.id, demo);
      collapseWithUndo(order.id, intent(order), 'Authorized');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  function collapseWithUndo(id: string, title: string, action: string) {
    window.clearTimeout(timers.current[id]);
    setCollapsed((current) => ({ ...current, [id]: { id, title, action } }));
    timers.current[id] = window.setTimeout(() => {
      setCollapsed((current) => {
        const { [id]: _removed, ...rest } = current;
        void _removed;
        return rest;
      });
      void onChanged();
    }, 6000);
  }

  function undo(id: string) {
    window.clearTimeout(timers.current[id]);
    setCollapsed((current) => {
      const { [id]: _removed, ...rest } = current;
      void _removed;
      return rest;
    });
  }

  return (
    <AgentsSection title="Queue" subtitle="Open work orders: queued, gated, claimed, dispatched, building, or PR open." count={orders.length}>
      {error && <div className="detail-note error agents-inline-error">Approval failed: {error}</div>}
      <UndoNotices notices={notices} onUndo={undo} />
      {loading ? <SkeletonRows /> : visibleOrders.length === 0 ? (
        <EmptyState title="Queue is empty" copy="No open work orders are waiting on the runner right now." />
      ) : (
        <div className="agents-table-wrap">
          <table className="agents-table queue-table">
            <thead>
              <tr>
                <th>App</th>
                <th>Intent</th>
                <th>Status</th>
                <th>Risk</th>
                <th>Claimed by</th>
                <th>Attempts</th>
                <th>Age</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((order) => {
                const isPending = pending === order.id;
                return (
                  <tr key={order.id} className={isPending ? 'agents-row-pending' : ''}>
                    <td><AppBadge app={order.app} fallbackId={order.app_id} /></td>
                    <td>
                      <div className="agents-primary">{intent(order)}</div>
                      <div className="agents-muted">{text(order.change_spec.affected_area) ?? order.target_repo ?? 'structured change spec'}</div>
                    </td>
                    <td><span className={'status-chip ' + order.status}>{label(order.status)}</span></td>
                    <td><span className={'risk-chip ' + order.risk_class}>{order.risk_class}</span></td>
                    <td>{order.claimed_by ?? '—'}</td>
                    <td>{order.attempt_count} / {order.max_attempts}</td>
                    <td>{ago(order.created_at) ?? '—'}</td>
                    <td>
                      {order.status === 'gated' ? (
                        <button className="act-btn agents-action" onClick={() => void authorize(order)} disabled={pending !== null}>
                          {isPending ? 'Authorizing…' : 'Authorize'}
                        </button>
                      ) : <span className="agents-muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AgentsSection>
  );
}

function OperatorHandoffsPanel({ handoffs, loading, demo, onChanged }: { handoffs: OperatorHandoff[]; loading: boolean; demo: boolean; onChanged: () => void | Promise<void> }) {
  const [pending, setPending] = useState<{ id: string; status: 'acknowledged' | 'done' } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, CollapsedNotice>>({});
  const [error, setError] = useState('');
  const timers = useRef<Record<string, number>>({});

  useEffect(() => () => {
    Object.values(timers.current).forEach(window.clearTimeout);
  }, []);

  const visible = handoffs.filter((handoff) => !collapsed[handoff.id]);
  const notices = Object.values(collapsed);

  async function advance(handoff: OperatorHandoff, status: 'acknowledged' | 'done') {
    setPending({ id: handoff.id, status });
    setError('');
    try {
      await acknowledgeHandoff(handoff.id, status, undefined, demo);
      collapseWithUndo(handoff.id, handoffTitle(handoff), status === 'done' ? 'Marked done' : 'Acknowledged');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  function collapseWithUndo(id: string, title: string, action: string) {
    window.clearTimeout(timers.current[id]);
    setCollapsed((current) => ({ ...current, [id]: { id, title, action } }));
    timers.current[id] = window.setTimeout(() => {
      setCollapsed((current) => {
        const { [id]: _removed, ...rest } = current;
        void _removed;
        return rest;
      });
      void onChanged();
    }, 6000);
  }

  function undo(id: string) {
    window.clearTimeout(timers.current[id]);
    setCollapsed((current) => {
      const { [id]: _removed, ...rest } = current;
      void _removed;
      return rest;
    });
  }

  return (
    <AgentsSection title="Operator handoffs" subtitle="Manual runbooks that need operator action before F3 can close." count={handoffs.length}>
      {error && <div className="detail-note error agents-inline-error">Handoff update failed: {error}</div>}
      <UndoNotices notices={notices} onUndo={undo} />
      {loading ? <SkeletonRows /> : visible.length === 0 ? (
        <EmptyState title="No open handoffs" copy="No manual runbooks are waiting on you right now." />
      ) : (
        <div className="handoff-list">
          {visible.map((handoff) => {
            const pendingAction = pending?.id === handoff.id ? pending.status : null;
            return (
              <article className={'handoff-card ' + handoff.severity + (pendingAction ? ' agents-row-pending' : '')} key={handoff.id}>
                <div className="handoff-card-head">
                  <AppBadge app={handoff.app} fallbackId={handoff.app_id} />
                  <span className={'risk-chip ' + severityTone(handoff.severity)}>{handoff.severity}</span>
                  <span className={'status-chip ' + handoff.status}>{label(handoff.status)}</span>
                </div>
                <div className="handoff-meta">
                  <span>{label(handoff.kind)}</span>
                  <span>Created {ago(handoff.created_at) ?? 'recently'}</span>
                  {handoff.work_order_id && <span>WO {shortId(handoff.work_order_id)}</span>}
                </div>
                <div className="handoff-runbook" dangerouslySetInnerHTML={{ __html: renderRunbookMarkdown(handoff.runbook_md) }} />
                <div className="handoff-actions">
                  {handoff.status === 'open' && (
                    <button className="ghost-btn" onClick={() => void advance(handoff, 'acknowledged')} disabled={pending !== null}>
                      {pendingAction === 'acknowledged' ? 'Acknowledging…' : 'Acknowledge'}
                    </button>
                  )}
                  <button className="act-btn agents-action" onClick={() => void advance(handoff, 'done')} disabled={pending !== null}>
                    {pendingAction === 'done' ? 'Saving…' : 'Mark done'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </AgentsSection>
  );
}

function UndoNotices({ notices, onUndo }: { notices: CollapsedNotice[]; onUndo: (id: string) => void }) {
  if (notices.length === 0) return null;
  return (
    <div className="agents-undo-stack">
      {notices.map((notice) => (
        <div className="agents-undo" key={notice.id}>
          <span>{notice.action}: <b>{notice.title}</b>. Refreshing in 6 seconds.</span>
          <button className="ghost-btn" onClick={() => onUndo(notice.id)}>Undo</button>
        </div>
      ))}
    </div>
  );
}

function RunsBand({ runs, loading }: { runs: AgentRun[]; loading: boolean }) {
  return (
    <AgentsSection title="Recent runs" subtitle="Newest runner ledger entries across every app." count={runs.length}>
      {loading ? <SkeletonRows /> : runs.length === 0 ? (
        <EmptyState title="No runs yet" copy="The ledger is ready, but no daemon has written an agent run yet." />
      ) : (
        <div className="agent-run-list">
          {runs.map((run) => (
            <div className={'agent-run-card ' + run.status} key={run.id}>
              <div className="agent-run-top">
                <AppBadge app={run.app} fallbackId={run.work_order_id} />
                <span className="runner-name">{run.runner}</span>
                <span className={'status-chip ' + run.status}>{label(run.status)}</span>
              </div>
              <div className="agent-run-grid">
                <RunMetric label="Started" value={ago(run.started_at) ?? '—'} />
                <RunMetric label="Finished" value={run.finished_at ? ago(run.finished_at) ?? '—' : 'running'} />
                <RunMetric label="Cost" value={run.cost_usd == null ? '—' : money(run.cost_usd)} />
                <RunMetric label="PR" value={run.pr_url ? <a href={run.pr_url} target="_blank" rel="noreferrer">Open PR</a> : '—'} />
              </div>
              {run.notes && <div className="agents-muted run-notes">{run.notes}</div>}
            </div>
          ))}
        </div>
      )}
    </AgentsSection>
  );
}

function CostLedgerBand({ rows, grandTotal, loading }: { rows: CostLedgerRow[]; grandTotal: number; loading: boolean }) {
  const hasSpend = rows.length > 0 && grandTotal > 0;
  return (
    <AgentsSection title="Cost ledger" subtitle="Spend grouped by app and runner." count={rows.length}>
      {loading ? <SkeletonRows /> : !hasSpend ? (
        <EmptyState title="No spend yet" copy="Runs can report cost_usd, but no meaningful spend is recorded yet." />
      ) : (
        <div className="cost-ledger">
          <div className="cost-total">
            <span>Grand total</span>
            <b>{money(grandTotal)}</b>
          </div>
          <div className="cost-grid">
            {rows.map((row) => <CostCard key={`${row.app_id ?? 'unknown'}-${row.runner ?? 'unknown'}`} row={row} />)}
          </div>
        </div>
      )}
    </AgentsSection>
  );
}

function CostCard({ row }: { row: CostLedgerRow }) {
  return (
    <div className="cost-card">
      <AppBadge app={{ id: row.app_id, short_code: row.short_code, display_name: row.display_name }} fallbackId={row.app_id ?? '—'} />
      <div className="cost-card-meta">
        <span>{row.runner ?? 'unknown runner'}</span>
        <b>{money(row.cost_usd)}</b>
        <em>{row.run_count} run{row.run_count === 1 ? '' : 's'}</em>
      </div>
    </div>
  );
}

function AgentsSection({ title, subtitle, count, children }: { title: string; subtitle: string; count: number; children: ReactNode }) {
  return (
    <section className="band agents-section">
      <div className="band-head">
        <div>
          <div className="band-title">{title}</div>
          <div className="band-sub">{subtitle}</div>
        </div>
        <span className="count-chip">{count}</span>
      </div>
      <div className="agents-section-body">{children}</div>
    </section>
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

function RunMetric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="run-metric">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function AppBadge({ app, fallbackId }: { app: { id?: string | null; short_code: string | null; display_name: string | null }; fallbackId: string }) {
  const code = app.short_code ?? fallbackId.slice(0, 3).toUpperCase();
  return (
    <div className="agents-app">
      <span className="badge" style={{ background: colorFor(code) }}>{code[0] ?? '—'}</span>
      <div>
        <b>{app.display_name ?? code}</b>
        <span>{code}</span>
      </div>
    </div>
  );
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="detail-placeholder agents-empty">
      <b>{title}</b>
      <span>{copy}</span>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return <div className="detail-note error">Agents read failed: {message}</div>;
}

function SkeletonRows() {
  return (
    <div className="agents-skeleton">
      {Array.from({ length: 3 }).map((_, i) => <div className="skel" key={i} style={{ height: 46 }} />)}
    </div>
  );
}

function intent(order: AgentWorkOrder): string {
  return text(order.change_spec.intent) ?? text(order.change_spec.title) ?? 'Untitled work order';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function label(value: string): string {
  return value.replace(/_/g, ' ');
}

function handoffTitle(handoff: OperatorHandoff): string {
  return `${handoff.app.display_name ?? handoff.app.short_code ?? shortId(handoff.app_id)} ${label(handoff.kind)}`;
}

function severityTone(severity: OperatorHandoff['severity']): string {
  if (severity === 'critical' || severity === 'high') return 'production';
  if (severity === 'normal') return 'authorize';
  return 'auto';
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function renderRunbookMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    const listItem = trimmed.match(/^-\s+(.+)$/);
    if (listItem) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(listItem[1] ?? '')}</li>`);
      continue;
    }
    closeList();
    if (trimmed.startsWith('### ')) html.push(`<h4>${inlineMarkdown(trimmed.slice(4))}</h4>`);
    else if (trimmed.startsWith('## ')) html.push(`<h3>${inlineMarkdown(trimmed.slice(3))}</h3>`);
    else if (trimmed.startsWith('# ')) html.push(`<h2>${inlineMarkdown(trimmed.slice(2))}</h2>`);
    else html.push(`<p>${inlineMarkdown(trimmed)}</p>`);
  }
  closeList();
  return html.join('');
}

function inlineMarkdown(value: string): string {
  return escapeMarkdownHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function escapeMarkdownHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}
