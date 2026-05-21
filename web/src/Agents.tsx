import { forwardRef, useEffect, useImperativeHandle, useState, type ReactNode } from 'react';
import {
  ago, colorFor, loadAgents,
  type AgentRun, type AgentsPayload, type AgentWorkOrder, type CostLedgerRow, type RunnerStatus,
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
  const [error, setError] = useState('');

  async function refresh() {
    setState('loading');
    setError('');
    try {
      const next = await loadAgents(demo);
      setPayload(next);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPayload(emptyAgents);
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
      <QueueBand orders={openOrders} loading={state === 'loading'} />
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

function QueueBand({ orders, loading }: { orders: AgentWorkOrder[]; loading: boolean }) {
  return (
    <AgentsSection title="Queue" subtitle="Open work orders: queued, claimed, dispatched, building, or PR open." count={orders.length}>
      {loading ? <SkeletonRows /> : orders.length === 0 ? (
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
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AgentsSection>
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

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}
