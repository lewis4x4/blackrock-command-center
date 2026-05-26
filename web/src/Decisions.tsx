import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { SlideOver } from './SlideOver';
import { DecisionRouteModal } from './DecisionRouteModal';
import { ExtractionReviewModal } from './ExtractionReviewModal';
import { DecisionAnswerBody, useDecisionAnswerFlow } from './TriagePanels';
import {
  ago, colorFor, confirmExtraction, decisionAgeDays, decisionRowId, decisionRowIssueId, decisionRowOwnerKind, decisionRowTitle, loadDecisions, operatorClarifyExtraction, rejectExtraction, resolveLateReply, setDecisionPause, setDecisionSnooze,
  type AnsweredDecisionSummary, type DecisionAgeFilter, type DecisionOwnerFilter, type DecisionRow, type DecisionsAppStatus, type LateReplyIssueSummary,
  type DecisionsFilters, type DecisionsPayload, type DecisionSort, type DecisionStateFilter, type OperatorClarifyExtractionPayload, type PendingReviewSend, type RoutedDecisionSummary,
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
  routed_recent: [],
  late_replies: [],
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
  const [stateFilter, setStateFilter] = useState<DecisionStateFilter>('active');
  const [openDecision, setOpenDecision] = useState<DecisionRow | null>(null);
  const [openReview, setOpenReview] = useState<PendingReviewSend | null>(null);
  const [lastOpenCount, setLastOpenCount] = useState(0);

  const filters: DecisionsFilters = useMemo(() => ({
    app_id: appId || undefined,
    owner_kind: ownerKind,
    age,
    sort,
    state: stateFilter,
  }), [appId, ownerKind, age, sort, stateFilter]);

  async function refresh() {
    setState('loading');
    setError('');
    try {
      const next = await loadDecisions(filters, demo);
      setPayload(next);
      setLastOpenCount(next.decisions.length);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }

  useImperativeHandle(ref, () => ({ refresh }));

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, filters]);

  const ownerCounts = useMemo(() => ownerBreakdown(payload.decisions), [payload.decisions]);
  const appOptions = useMemo(() => appChoices(payload), [payload]);

  return (
    <div className="decisions-page">
      <DecisionsHeader
        loading={state === 'loading'}
        generatedAt={payload.generated_at}
        openCount={state === 'error' ? lastOpenCount : payload.decisions.length}
        operatorCount={ownerCounts.operator}
        clientCount={ownerCounts.client}
        unknownCount={ownerCounts.unknown}
        onRefresh={refresh}
      />
      <PendingReviewBand reviews={payload.pending_reviews ?? []} onOpen={setOpenReview} />
      <FilterBand
        appId={appId}
        appOptions={appOptions}
        ownerKind={ownerKind}
        age={age}
        sort={sort}
        stateFilter={stateFilter}
        onAppId={setAppId}
        onOwnerKind={setOwnerKind}
        onAge={setAge}
        onSort={setSort}
        onStateFilter={setStateFilter}
      />
      <DecisionsBand
        decisions={payload.decisions}
        loading={state === 'loading'}
        error={state === 'error' ? error : ''}
        onRetry={refresh}
        onOpen={setOpenDecision}
      />
      <RoutedBand rows={payload.routed_recent ?? []} loading={state === 'loading'} />
      <LateRepliesBand rows={payload.late_replies ?? []} loading={state === 'loading'} demo={demo} onResolved={refresh} />
      <WiringNotes unwired={payload.apps_unwired} unreachable={payload.apps_unreachable} />
      <AnsweredBand rows={payload.answered_recent} loading={state === 'loading'} />
      {openDecision && <DecisionDrawer decision={openDecision} demo={demo} onClose={() => setOpenDecision(null)} onAnswered={refresh} />}
      <ExtractionReviewModal
        review={openReview}
        open={!!openReview}
        onClose={() => setOpenReview(null)}
        onConfirm={async (sendId, optionId, rationale) => { await confirmExtraction(sendId, optionId, rationale, demo); await refresh(); }}
        onReject={async (sendId, reason) => { await rejectExtraction(sendId, reason, demo); await refresh(); }}
        onClarify={async (payload: OperatorClarifyExtractionPayload) => { await operatorClarifyExtraction(payload, demo); await refresh(); }}
      />
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

function PendingReviewBand({ reviews, onOpen }: { reviews: PendingReviewSend[]; onOpen: (review: PendingReviewSend) => void }) {
  if (!reviews.length) return null;
  return (
    <section className="band agents-section decisions-list-band">
      <div className="band-head">
        <span className="band-num">⚠</span>
        <div>
          <div className="band-title">Awaiting your review</div>
          <div className="band-sub">Claude proposed an answer — confirm, choose differently, reject, or clarify.</div>
        </div>
        <span className="count-chip">{reviews.length}</span>
      </div>
      <div className="decision-card-list">
        {reviews.map((review) => (
          <button key={review.send_id} className="decision-card client pending-review-card" onClick={() => onOpen(review)}>
            <div className="decision-card-top"><div className="decision-title">[{review.app_short_code}] {review.raw_decision_title}</div><span className="decision-state-badge awaiting_operator_confirm">needs review</span></div>
            <div className="decision-meta">Reply from {review.recipient_name ?? review.recipient_email} · {ago(review.replied_at) ?? 'recently'}</div>
            <div className="decision-options">“{review.raw_reply_text}”</div>
          </button>
        ))}
      </div>
    </section>
  );
}

function FilterBand({ appId, appOptions, ownerKind, age, sort, stateFilter, onAppId, onOwnerKind, onAge, onSort, onStateFilter }: {
  appId: string;
  appOptions: { id: string; code: string; name: string }[];
  ownerKind: DecisionOwnerFilter;
  age: DecisionAgeFilter;
  sort: DecisionSort;
  stateFilter: DecisionStateFilter;
  onAppId: (value: string) => void;
  onOwnerKind: (value: DecisionOwnerFilter) => void;
  onAge: (value: DecisionAgeFilter) => void;
  onSort: (value: DecisionSort) => void;
  onStateFilter: (value: DecisionStateFilter) => void;
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
        <ChipGroup label="State" value={stateFilter} options={[['active', 'Active'], ['paused', 'Paused'], ['all', 'All']]} onChange={(value) => onStateFilter(value as DecisionStateFilter)} />
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

function DecisionsBand({ decisions, loading, error, onRetry, onOpen }: {
  decisions: DecisionRow[];
  loading: boolean;
  error: string;
  onRetry: () => void | Promise<void>;
  onOpen: (decision: DecisionRow) => void;
}) {
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
        {loading ? <SkeletonCards /> : error ? (
          <div className="detail-placeholder agents-empty">
            <b>Couldn't load decisions.</b>
            <span>{error}</span>
            <button className="ghost-btn" onClick={() => void onRetry()}>Retry</button>
          </div>
        ) : decisions.length === 0 ? (
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
  const options = decisionOptions(decision);
  const emailState = decisionEmailState(decision);
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
        <span className={'risk-chip ' + ageTone(decision)}>{ageLabel(decision)}</span>
      </div>
      <div className="decision-title">{decisionRowTitle(decision)}</div>
      <div className="decision-meta">
        <span>{ownerLabel(owner)}</span>
        {emailState && <span className={'decision-state-badge ' + stateBadgeTone(emailState)}>{stateLabel(emailState)}</span>}
        {text(decision.reminded_at) && <span>reminded {ago(text(decision.reminded_at)) ?? 'recently'}</span>}
      </div>
      <div className="decision-options">{decisionOptionsCopy(owner, emailState, options, decision)}</div>
      <button className="btn-primary decision-route" style={{ width: '100%', minHeight: 44 }} type="button" onClick={(ev) => { ev.stopPropagation(); onOpen(decision); }}>{decisionCta(emailState)}</button>
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

function RoutedBand({ rows, loading }: { rows: RoutedDecisionSummary[]; loading: boolean }) {
  if (!loading && rows.length === 0) return null;
  return (
    <section className="band agents-section">
      <div className="band-head">
        <span className="band-num">2</span>
        <div>
          <div className="band-title">Awaiting reply</div>
          <div className="band-sub">Decisions already routed to recipients, hidden from the open list.</div>
        </div>
        <span className="count-chip">{rows.length}</span>
      </div>
      {loading ? <SkeletonCards /> : (
        <div className="answered-list">
          {rows.map((row) => (
            <div className="answered-row" key={row.send_id}>
              <div className="agents-app">
                <span className="badge" style={{ background: colorFor(row.app_short_code ?? 'APP') }}>{(row.app_short_code ?? 'A')[0]}</span>
                <div>
                  <b>{row.app_display_name ?? row.app_short_code ?? 'App'}</b>
                  <span>{row.app_short_code ?? '—'}</span>
                </div>
              </div>
              <div className="answered-main">
                <b>{row.decision_title ?? row.decision_external_ref}</b>
                <span>{routedStateLabel(row.state)}{row.recipient_count > 1 ? ` · ${row.recipient_count} recipients` : row.recipient_name ? ` · ${row.recipient_name}` : ''}</span>
              </div>
              <div className="answered-age">{ago(row.reminded_at ?? row.sent_at ?? row.updated_at) ?? '—'}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function LateRepliesBand({ rows, loading, demo, onResolved }: { rows: LateReplyIssueSummary[]; loading: boolean; demo: boolean; onResolved: () => void | Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function resolve(row: LateReplyIssueSummary, action: 'apply' | 'dismiss') {
    if (busyId) return;
    setBusyId(row.issue_id);
    try {
      await resolveLateReply(row.issue_id, action, demo);
      await onResolved();
    } finally {
      setBusyId(null);
    }
  }

  if (!loading && rows.length === 0) return null;
  return (
    <section className="band agents-section" id="late-replies">
      <div className="band-head">
        <span className="band-num">3</span>
        <div>
          <div className="band-title">Late replies</div>
          <div className="band-sub">Replies that arrived after the original decision was already answered or done.</div>
        </div>
        <span className="count-chip">{rows.length}</span>
      </div>
      {loading ? <SkeletonCards /> : (
        <div className="answered-list">
          {rows.map((row) => {
            const sender = row.sender_name || row.sender_email || 'Unknown sender';
            const busy = busyId === row.issue_id;
            return (
              <div className="answered-row" key={row.issue_id}>
                <div className="agents-app">
                  <span className="badge" style={{ background: colorFor(row.app_short_code ?? 'APP') }}>{(row.app_short_code ?? 'A')[0]}</span>
                  <div>
                    <b>{row.app_display_name ?? row.app_short_code ?? 'App'}</b>
                    <span>{row.app_short_code ?? '—'}</span>
                  </div>
                </div>
                <div className="answered-main">
                  <b>{row.original_decision_title ?? row.original_decision_ref ?? 'Answered decision'}</b>
                  <span>{sender} · {row.reply_excerpt ? `“${row.reply_excerpt}”` : 'No reply excerpt captured.'}</span>
                </div>
                <div className="answered-age">{ago(row.last_seen_at ?? row.created_at ?? row.surfaced_at) ?? '—'}</div>
                <div className="agents-hero-actions" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn-primary" disabled={busy} onClick={() => void resolve(row, 'apply')}>{busy ? 'Saving…' : 'Apply as answer'}</button>
                  <button className="ghost-btn" disabled={busy} onClick={() => void resolve(row, 'dismiss')}>Dismiss as noise</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AnsweredBand({ rows, loading }: { rows: AnsweredDecisionSummary[]; loading: boolean }) {
  return (
    <section className="band agents-section">
      <div className="band-head">
        <span className="band-num">4</span>
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
                <b>{row.decision_title ?? row.decision_external_ref ?? 'Decision answered'}</b>
                <span>Answer: <b>{row.answer_label ?? row.answer_value}</b> · {row.risk_class}{row.created_via === 'auto_route' ? ' · auto-routed' : ''}</span>
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
  const [routingRow, setRoutingRow] = useState<Record<string, unknown> | null>(null);
  const [mutating, setMutating] = useState(false);

  async function closeAfterMaybeRefresh() {
    if (flow.completed) await onAnswered();
    onClose();
  }

  const issueId = decisionRowIssueId(decision);
  const paused = decision.auto_route_paused === true || !!decision.auto_route_paused_at;

  async function togglePause(nextPaused: boolean) {
    if (!issueId || mutating) return;
    setMutating(true);
    try {
      await setDecisionPause(issueId, nextPaused, null, demo);
      await onAnswered();
    } finally {
      setMutating(false);
    }
  }

  async function snooze(days: 1 | 3 | 7 | null) {
    if (!issueId || mutating) return;
    setMutating(true);
    try {
      await setDecisionSnooze(issueId, days, demo);
      await onAnswered();
    } finally {
      setMutating(false);
    }
  }

  return (
    <SlideOver open title="Decision detail" subtitle={`${decision.app_short_code} · ${ownerLabel(decisionRowOwnerKind(decision))} owned`} onClose={() => void closeAfterMaybeRefresh()} footer={(
      <>
        {issueId && <button className="ghost-btn" onClick={() => void togglePause(!paused)} disabled={mutating}>{paused ? 'Resume auto-route' : 'Pause auto-route'}</button>}
        {issueId && <button className="ghost-btn" onClick={() => void snooze(decision.snoozed_until ? null : 1)} disabled={mutating}>{decision.snoozed_until ? 'Unsnooze' : 'Snooze 1d'}</button>}
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
        onRouteClient={setRoutingRow}
        missingIssueCopy="This app returned a decision row without issue_id/cc_issue_id. The row is visible, but answering requires the app to include the control-plane issue id."
      />
      <DecisionRouteModal open={!!routingRow} demo={demo} appId={decision.app_id} issueId={decisionRowIssueId(decision)} decision={routingRow ?? {}} onClose={() => setRoutingRow(null)} onSent={onAnswered} />
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

function routedStateLabel(state: string): string {
  if (state === 'reminded') return 'Reminder sent';
  if (state === 'awaiting_clarify' || state === 'clarify_sent') return 'Clarification sent';
  return 'Routed to recipient';
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

function decisionEmailState(row: Record<string, unknown>): string | null {
  if (row.auto_route_paused === true || text(row.auto_route_paused_at)) return 'paused';
  const snoozedUntil = text(row.snoozed_until);
  if (snoozedUntil && new Date(snoozedUntil).getTime() > Date.now()) return 'snoozed';
  const direct = text(row.decision_email_state) ?? text(row.email_state) ?? text(row.routing_state);
  const status = text(row.status)?.toLowerCase();
  const raw = (direct ?? (status === 'routed_to_client' ? 'routed' : status === 'answered' ? 'answered' : null))?.toLowerCase();
  if (!raw) return 'unrouted';
  if (['unrouted', 'routed', 'link_clicked', 'awaiting_operator_confirm', 'answered', 'expired'].includes(raw)) return raw;
  if (raw === 'clicked') return 'link_clicked';
  if (raw === 'replied' || raw === 'extracting') return 'awaiting_operator_confirm';
  if (raw === 'sent' || raw === 'delivered' || raw === 'opened') return 'routed';
  return null;
}

function ownerLabel(owner: 'operator' | 'client' | 'unknown'): string {
  if (owner === 'operator') return 'Operator';
  if (owner === 'client') return 'Client';
  return 'Unknown';
}

function ageLabel(row: Record<string, unknown>): string {
  const days = decisionAgeDays(row);
  if (days == null) return '—';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days >= 30) return '30d+';
  return `${Math.round(days)}d`;
}

function ageTone(row: Record<string, unknown>): 'auto' | 'authorize' | 'destructive' {
  const days = decisionAgeDays(row);
  if (days == null || days <= 2) return 'auto';
  if (days <= 7) return 'authorize';
  return 'destructive';
}

function stateBadgeTone(state: string): string {
  if (state === 'unrouted') return 'awaiting_operator_confirm';
  return state;
}

function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    unrouted: 'Open',
    routed: 'Sent',
    link_clicked: 'Viewed',
    awaiting_operator_confirm: 'Needs review',
    answered: 'Answered',
    expired: 'Expired',
    paused: 'Paused',
    snoozed: 'Snoozed',
  };
  return labels[state] ?? state.replace(/_/g, ' ');
}

function decisionCta(state: string | null): string {
  if (state === 'awaiting_operator_confirm' || state === 'answered') return 'Review reply';
  if (state === 'routed' || state === 'link_clicked') return 'Resend';
  return 'Send to client';
}

function decisionOptionsCopy(owner: 'operator' | 'client' | 'unknown', state: string | null, options: { id: string; label: string }[], row: DecisionRow): string {
  if (state === 'awaiting_operator_confirm') return 'Review reply';
  if (state === 'answered') return `Answered: ${text(row.selected_option) ?? text(row.answer_label) ?? text(row.answer_value) ?? '—'}`;
  if (state === 'routed' || state === 'link_clicked') {
    if (options.length) {
      const count = options.length;
      return `Sent ${count} option${count === 1 ? '' : 's'}: ${options.slice(0, 3).map((option) => option.label).join(' · ')}`;
    }
    return 'Sent — awaiting reply.';
  }
  if (options.length) return options.slice(0, 3).map((option) => option.label).join(' · ');
  if (owner === 'operator') return 'Free-form — answer in your own words.';
  if (owner === 'unknown') return 'Assign an owner to continue.';
  return 'AI will draft options when you send.';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
