import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { SlideOver } from './SlideOver';
import { DecisionRouteModal } from './DecisionRouteModal';
import {
  answerIssue, ago, dispatchFromAnswer, loadAppDetailSection,
  type AppRow, type DetailSectionPayload, type IssueAction, type IssueRow, type RiskClass,
} from './lib';

type PanelProps = {
  issue: IssueRow;
  app: AppRow;
  onClose: () => void;
  onResolved: () => void;
  demo?: boolean;
};

type LoadState = 'loading' | 'ready' | 'error';
export type DecisionOption = { id: string; label: string };

const riskClasses: RiskClass[] = ['auto', 'authorize', 'destructive', 'production'];

export function useDecisionAnswerFlow({ rows, demo, issueIdForRow }: {
  rows: Record<string, unknown>[];
  demo: boolean;
  issueIdForRow: (row: Record<string, unknown>) => string | null;
}) {
  const [selectedId, setSelectedId] = useState('');
  const [selectedAnswer, setSelectedAnswer] = useState('');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [dispatchNotice, setDispatchNotice] = useState<{ tone: 'queued' | 'gated'; text: string } | null>(null);
  const [completed, setCompleted] = useState(false);

  const operatorRows = useMemo(() => rows.filter(isOperatorDecision), [rows]);
  const clientRows = useMemo(() => rows.filter((row) => !isOperatorDecision(row)), [rows]);
  const selected = operatorRows.find((row) => rowId(row) === selectedId) ?? operatorRows[0] ?? null;
  const options = selected ? optionsFor(selected) : [];
  const riskClass = riskFor(selected);
  const selectedIssueId = selected ? issueIdForRow(selected) : null;
  const canSubmit = !!selected && !!selectedIssueId && !!selectedAnswer && options.length > 0 && !busy && !completed;

  useEffect(() => {
    const next = operatorRows[0];
    setSelectedId(next ? rowId(next) : '');
    setSelectedAnswer('');
    setCompleted(false);
    setDispatchNotice(null);
    setActionError('');
  }, [operatorRows]);

  useEffect(() => {
    setSelectedAnswer(options[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function submitAnswer() {
    if (!selected || !selectedAnswer || !selectedIssueId) return;
    setBusy(true);
    setActionError('');
    setDispatchNotice(null);
    try {
      const answerResult = await answerIssue(selectedIssueId, 'answer_decision', {
        answer_value: selectedAnswer,
        answer_options_snapshot: options,
        rationale,
        risk_class: riskClass,
        decision_external_ref: rowId(selected),
      }, demo);
      const answerId = decisionAnswerIdFromResult(answerResult);
      if (!answerId) throw new Error('Decision was recorded, but the response did not include decision_answer_id for dispatch.');
      const dispatch = await dispatchFromAnswer(answerId, demo);
      setDispatchNotice(dispatch.dispatched
        ? { tone: 'queued', text: 'Work order queued — daemon will build.' }
        : { tone: 'gated', text: 'Work order created — needs your approval on the home.' });
      setCompleted(true);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return {
    operatorRows, clientRows, selected, selectedId, setSelectedId,
    selectedAnswer, setSelectedAnswer, rationale, setRationale,
    busy, actionError, dispatchNotice, completed, options, riskClass,
    selectedIssueId, canSubmit, submitAnswer,
  };
}

export function PortfolioBlockersPanel({ apps, onClose }: { apps: AppRow[]; onClose: () => void }) {
  const blockedApps = apps
    .filter((app) => (app.roadmap_counts?.blocked ?? 0) > 0)
    .sort((a, b) => (b.roadmap_counts?.blocked ?? 0) - (a.roadmap_counts?.blocked ?? 0) || b.criticality - a.criticality);

  return (
    <SlideOver open title="Portfolio blockers" subtitle="Apps with blocked roadmap work across the command center" onClose={onClose} footer={(
      <button className="ghost-btn" onClick={onClose}>Close</button>
    )}>
      <PanelStatus state="ready" error="" empty={blockedApps.length === 0} emptyCopy="No blocked roadmap work is currently reported." />
      {blockedApps.length > 0 && (
        <div className="panel-section">
          <div className="panel-label">Blocked apps</div>
          <div className="panel-stack">
            {blockedApps.map((app) => {
              const count = app.roadmap_counts?.blocked ?? 0;
              return (
                <button className="panel-card" key={app.id} onClick={() => { window.location.hash = `#/apps/${app.short_code.toLowerCase()}`; }}>
                  <b>{app.display_name}</b>
                  <span>{app.short_code} · {count} blocked item{count === 1 ? '' : 's'} · {app.lifecycle_phase}</span>
                  <em>Open cockpit</em>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </SlideOver>
  );
}

export function OpenDecisionsPanel(props: PanelProps) {
  const { issue, app, onClose, onResolved, demo = false } = props;
  const { state, rows, error } = usePanelSection(app.id, demo, 'decisions');
  const flow = useDecisionAnswerFlow({ rows, demo, issueIdForRow: () => issue.id });
  const [routingRow, setRoutingRow] = useState<Record<string, unknown> | null>(null);

  function closeAfterMaybeRefresh() {
    if (flow.completed) onResolved();
    else onClose();
  }

  return (
    <SlideOver open title="Open decisions" subtitle={`${app.short_code} · answer operator-owned decisions only`} onClose={closeAfterMaybeRefresh} footer={(
      <>
        <button className="ghost-btn" onClick={closeAfterMaybeRefresh}>{flow.completed ? 'Done' : 'Close'}</button>
        {!flow.completed && (
          <button className="btn-primary panel-primary" onClick={() => void flow.submitAnswer()} disabled={!flow.canSubmit}>
            {flow.busy ? 'Recording…' : 'Answer decision'}
          </button>
        )}
      </>
    )}>
      <DecisionAnswerBody flow={flow} state={state} error={error} empty={rows.length === 0} emptyCopy="No decisions returned for this app yet." onRouteClient={setRoutingRow} />
      <DecisionRouteModal open={!!routingRow} demo={demo} appId={app.id} issueId={issue.id} decision={routingRow ?? {}} onClose={() => setRoutingRow(null)} onSent={onResolved} />
    </SlideOver>
  );
}

export function DecisionAnswerBody({ flow, state, error, empty, emptyCopy, showRouteToClient = false, missingIssueCopy = 'This decision row is missing a control-plane issue id, so it cannot be answered from Command Center yet.', onRouteClient }: {
  flow: ReturnType<typeof useDecisionAnswerFlow>;
  state: LoadState;
  error: string;
  empty: boolean;
  emptyCopy: string;
  showRouteToClient?: boolean;
  missingIssueCopy?: string;
  onRouteClient?: (row: Record<string, unknown>) => void;
}) {
  return (
    <>
      <PanelStatus state={state} error={error} empty={empty} emptyCopy={emptyCopy} />
      {flow.actionError && <div className="panel-error">{flow.actionError}</div>}
      {flow.dispatchNotice && <div className={'panel-confirm ' + flow.dispatchNotice.tone}>{flow.dispatchNotice.tone === 'queued' ? '✓' : '!'} {flow.dispatchNotice.text}</div>}
      {flow.operatorRows.length > 0 && (
        <div className="panel-section">
          <div className="panel-label">Operator-owned</div>
          <div className="panel-stack">
            {flow.operatorRows.map((row) => {
              const id = rowId(row);
              const opts = optionsFor(row);
              return (
                <div key={id} className={'panel-card decision-choice' + (flow.selected && id === rowId(flow.selected) ? ' selected' : '')}>
                  <button className="panel-card-button" onClick={() => flow.setSelectedId(id)}>
                    <b>{rowTitle(row)}</b>
                    <span>{rowMeta(row, ['owner', 'owner_type', 'owner_kind', 'age', 'status', 'risk_class'])}</span>
                    {opts.length === 0 && <em>No enumerated options returned — cannot answer from Command Center yet.</em>}
                  </button>
                  {(showRouteToClient || onRouteClient) && (
                    <button className="ghost-btn panel-source" onClick={(ev) => { ev.stopPropagation(); onRouteClient?.(row); }}>Route to recipients</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {flow.selected && flow.options.length > 0 && (
        <div className="panel-section answer-box">
          <label>
            <span>Enumerated answer</span>
            <select value={flow.selectedAnswer} onChange={(ev) => flow.setSelectedAnswer(ev.target.value)}>
              {flow.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label>
            <span>Rationale (optional, one line)</span>
            <input value={flow.rationale} onChange={(ev) => flow.setRationale(ev.target.value)} maxLength={500} placeholder="Why this option?" />
          </label>
          <div className="panel-note">Risk class: <b>{flow.riskClass}</b>. Answering records the decision and creates a work order immediately.</div>
          {!flow.selectedIssueId && <div className="panel-note">{missingIssueCopy}</div>}
        </div>
      )}
      {flow.clientRows.length > 0 && (
        <div className="panel-section">
          <div className="panel-label">Client-owned</div>
          <div className="panel-stack">
            {flow.clientRows.map((row) => (
              <div className="panel-card" key={rowId(row)}>
                <b>{rowTitle(row)}</b>
                <span>{rowMeta(row, ['owner', 'owner_type', 'owner_kind', 'age', 'status'])}</span>
                <div className="panel-note">Client decision — route it to the app’s decision recipients for confirmation.</div>
                {(showRouteToClient || onRouteClient) && <button className="ghost-btn panel-source" onClick={() => onRouteClient?.(row)}>Route to recipients</button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export function ViewBuildPanel(props: PanelProps) {
  const { issue, app, onClose, onResolved, demo = false } = props;
  const { state, rows, error } = usePanelSection(app.id, demo, 'roadmap');
  const stuck = rows.filter(isStuckRow);
  const reasons = rows.filter((row) => hasAny(row, ['health_reason', 'build_reason', 'failure_reason', 'blocker', 'blocked_reason']));
  return (
    <ActionPanel title="View build" subtitle={`${app.short_code} · MVP read-only with acknowledge/dismiss`} issue={issue} onClose={onClose} onResolved={onResolved} demo={demo} primaryAction="acknowledge">
      <PanelStatus state={state} error={error} empty={rows.length === 0} emptyCopy="No roadmap/build detail returned for this app yet." />
      <PanelReadOnlyNote text="Phase 2 shows the evidence and lets you mark it seen. Retry/cancel/live run controls arrive with the runner in Phase 3+." />
      <SummaryCards rows={reasons.length ? reasons : rows.slice(0, 3)} emptyCopy="No explicit build-health reasons returned." />
      <PanelList title="Stuck items" rows={stuck} emptyCopy="No stuck or blocked roadmap items returned." />
      <SourceLink app={app} rows={rows} />
    </ActionPanel>
  );
}

export function ReviewBlockersPanel(props: PanelProps) {
  const { issue, app, onClose, onResolved, demo = false } = props;
  const { state, rows, error } = usePanelSection(app.id, demo, 'roadmap');
  const blockers = rows.filter(isBlockedRow);
  const [linkedDecisionRef, setLinkedDecisionRef] = useState('');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState<IssueAction | null>(null);
  const [actionError, setActionError] = useState('');

  async function run(action: IssueAction) {
    setBusy(action);
    setActionError('');
    try {
      await answerIssue(issue.id, action, action === 'link_to_decision' ? { linked_decision_ref: linkedDecisionRef, rationale } : {}, demo);
      onResolved();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SlideOver open title="Review blockers" subtitle={`${app.short_code} · link a blocker to a decision or dismiss it`} onClose={onClose} footer={(
      <>
        <button className="ghost-btn" onClick={onClose}>Close</button>
        <button className="ghost-btn danger" onClick={() => void run('dismiss')} disabled={busy !== null}>{busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}</button>
        <button className="btn-primary panel-primary" onClick={() => void run('link_to_decision')} disabled={busy !== null || !linkedDecisionRef.trim()}>{busy === 'link_to_decision' ? 'Linking…' : 'Link to decision'}</button>
      </>
    )}>
      <PanelStatus state={state} error={error} empty={rows.length === 0} emptyCopy="No roadmap detail returned for this app yet." />
      {actionError && <div className="panel-error">{actionError}</div>}
      <PanelList title="Blocked items" rows={blockers} emptyCopy="No blocked roadmap items returned." />
      <div className="panel-section answer-box">
        <label>
          <span>Decision ref</span>
          <input value={linkedDecisionRef} onChange={(ev) => setLinkedDecisionRef(ev.target.value)} placeholder="Decision ID from the app detail" />
        </label>
        <label>
          <span>Rationale (optional)</span>
          <input value={rationale} onChange={(ev) => setRationale(ev.target.value)} maxLength={500} placeholder="Why this blocker depends on that decision?" />
        </label>
        <div className="panel-note">This only annotates <code>cc_issues.context</code> and moves the issue to triaging. No work order is created in Phase 2.</div>
      </div>
    </SlideOver>
  );
}

export function CheckSyncPanel(props: PanelProps) {
  const { issue, app, onClose, onResolved, demo = false } = props;
  const { state, rows, error } = usePanelSection(app.id, demo, 'sync');
  const errors = rows.filter(isSyncErrorRow);
  return (
    <ActionPanel title="Check sync" subtitle={`${app.short_code} · MVP read-only with acknowledge/dismiss`} issue={issue} onClose={onClose} onResolved={onResolved} demo={demo} primaryAction="acknowledge">
      <PanelStatus state={state} error={error} empty={rows.length === 0} emptyCopy="No sync detail returned for this app yet." />
      <PanelReadOnlyNote text="Phase 2 shows sync errors and last-sync evidence. Retry/escalate controls arrive after the write spine exists." />
      <PanelList title="Sync errors" rows={errors.length ? errors : rows} emptyCopy="No sync errors returned." />
      <SourceLink app={app} rows={rows} />
    </ActionPanel>
  );
}

function ActionPanel({ title, subtitle, issue, onClose, onResolved, demo = false, primaryAction, children }: { title: string; subtitle: string; issue: IssueRow; onClose: () => void; onResolved: () => void; demo?: boolean; primaryAction: IssueAction; children: ReactNode }) {
  const [busy, setBusy] = useState<IssueAction | null>(null);
  const [actionError, setActionError] = useState('');
  async function run(action: IssueAction) {
    setBusy(action);
    setActionError('');
    try {
      await answerIssue(issue.id, action, {}, demo);
      onResolved();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <SlideOver open title={title} subtitle={subtitle} onClose={onClose} footer={(
      <>
        <button className="ghost-btn" onClick={onClose}>Close</button>
        <button className="ghost-btn danger" onClick={() => void run('dismiss')} disabled={busy !== null}>{busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}</button>
        <button className="btn-primary panel-primary" onClick={() => void run(primaryAction)} disabled={busy !== null}>{busy === primaryAction ? 'Saving…' : 'Acknowledge'}</button>
      </>
    )}>
      {actionError && <div className="panel-error">{actionError}</div>}
      {children}
    </SlideOver>
  );
}

function usePanelSection(appId: string, demo: boolean, section: 'roadmap' | 'decisions' | 'sync') {
  const [state, setState] = useState<LoadState>('loading');
  const [detail, setDetail] = useState<DetailSectionPayload>({ items: [], next_cursor: null });
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setError('');
    loadAppDetailSection(appId, demo, section)
      .then((payload) => {
        if (cancelled) return;
        setDetail(payload);
        setState('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setDetail({ items: [], next_cursor: null });
        setState('error');
      });
    return () => { cancelled = true; };
  }, [appId, demo, section]);

  return { state, rows: detail.items, error };
}

function PanelStatus({ state, error, empty, emptyCopy }: { state: LoadState; error: string; empty: boolean; emptyCopy: string }) {
  if (state === 'loading') return <div className="detail-placeholder">Loading detail…</div>;
  if (state === 'error') return <div className="panel-error">Detail read failed: {error}</div>;
  if (empty) return <div className="detail-placeholder">{emptyCopy}</div>;
  return null;
}

function PanelReadOnlyNote({ text }: { text: string }) {
  return <div className="panel-note">{text}</div>;
}

function SummaryCards({ rows, emptyCopy }: { rows: Record<string, unknown>[]; emptyCopy: string }) {
  return <PanelList title="Health reasons" rows={rows} emptyCopy={emptyCopy} />;
}

function PanelList({ title, rows, emptyCopy }: { title: string; rows: Record<string, unknown>[]; emptyCopy: string }) {
  return (
    <div className="panel-section">
      <div className="panel-label">{title}</div>
      {rows.length === 0 ? <div className="detail-placeholder">{emptyCopy}</div> : (
        <div className="panel-stack">
          {rows.map((row, i) => <DetailRow key={String(row.id ?? row.title ?? row.source ?? i)} row={row} />)}
        </div>
      )}
    </div>
  );
}

function DetailRow({ row }: { row: Record<string, unknown> }) {
  return (
    <div className="panel-card">
      <b>{rowTitle(row)}</b>
      <span>{rowMeta(row)}</span>
    </div>
  );
}

function SourceLink({ app, rows }: { app: AppRow; rows: Record<string, unknown>[] }) {
  const url = firstUrl(rows) ?? app.app_url;
  if (!url) return null;
  return <a className="ghost-btn panel-source" href={url} target="_blank" rel="noreferrer">Open source record</a>;
}

function isOperatorDecision(row: Record<string, unknown>): boolean {
  const values = ['owner_type', 'owner_kind', 'answer_owner', 'owned_by', 'decision_owner'].map((key) => text(row[key])?.toLowerCase()).filter(Boolean);
  if (values.some((value) => value === 'operator' || value === 'blackrock' || value === 'blackrock_ai')) return true;
  if (values.some((value) => value === 'client' || value === 'customer')) return false;
  const owner = text(row.owner)?.toLowerCase() ?? text(row.assignee)?.toLowerCase() ?? '';
  return ['brian', 'operator', 'blackrock ai', 'blackrock'].includes(owner);
}

function isBlockedRow(row: Record<string, unknown>): boolean {
  const status = text(row.status)?.toLowerCase() ?? '';
  return status.includes('blocked') || status.includes('stuck') || hasAny(row, ['blocker', 'blocked_reason', 'blocked_by']);
}

function isStuckRow(row: Record<string, unknown>): boolean {
  const status = text(row.status)?.toLowerCase() ?? '';
  return isBlockedRow(row) || status.includes('failing') || status.includes('red') || status.includes('yellow');
}

function isSyncErrorRow(row: Record<string, unknown>): boolean {
  const status = text(row.status)?.toLowerCase() ?? '';
  const count = numberValue(row.error_count) ?? numberValue(row.errors) ?? 0;
  return status.includes('error') || status.includes('failed') || count > 0 || hasAny(row, ['error', 'last_error']);
}

function optionsFor(row: Record<string, unknown>): DecisionOption[] {
  const raw = row.options ?? row.answer_options ?? row.choices ?? row.allowed_answers;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === 'string') return { id: item, label: item };
    if (!isRecord(item)) return null;
    const id = text(item.id) ?? text(item.value) ?? text(item.key);
    const label = text(item.label) ?? text(item.name) ?? text(item.title) ?? id;
    return id && label ? { id, label } : null;
  }).filter((item): item is DecisionOption => !!item);
}

function riskFor(row: Record<string, unknown> | null): RiskClass {
  const raw = text(row?.risk_class)?.toLowerCase();
  return riskClasses.includes(raw as RiskClass) ? raw as RiskClass : 'authorize';
}

function rowId(row: Record<string, unknown> | null): string {
  return text(row?.id) ?? text(row?.external_ref) ?? text(row?.decision_id) ?? rowTitle(row ?? {});
}

function rowTitle(row: Record<string, unknown>): string {
  return text(row.title) ?? text(row.name) ?? text(row.summary) ?? text(row.source) ?? 'Untitled item';
}

function rowMeta(row: Record<string, unknown>, prefer?: string[]): string {
  const entries = Object.entries(row)
    .filter(([key, value]) => !['id', 'title', 'name', 'summary', 'options', 'answer_options', 'choices', 'allowed_answers'].includes(key) && value != null && typeof value !== 'object');
  const ordered = prefer
    ? [...entries.filter(([key]) => prefer.includes(key)), ...entries.filter(([key]) => !prefer.includes(key))]
    : entries;
  return ordered.slice(0, 5).map(([key, value]) => `${key.replace(/_/g, ' ')}: ${String(value)}`).join(' · ') || 'No metadata returned.';
}

function firstUrl(rows: Record<string, unknown>[]): string | null {
  for (const row of rows) {
    for (const key of ['url', 'source_url', 'linear_url', 'github_url', 'html_url']) {
      const value = text(row[key]);
      if (value?.startsWith('http')) return value;
    }
  }
  return null;
}

function hasAny(row: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => row[key] != null && row[key] !== '');
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function decisionAnswerIdFromResult(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = text(value.decision_answer_id);
  if (direct) return direct;
  const issue = isRecord(value.issue) ? value.issue : null;
  return issue ? text(issue.decision_answer_id) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
