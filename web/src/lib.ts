/* ============================================================================
   BlackRock AI Command Center — data layer

   WIRE-UP MAP — every browser backend read:
     loadApps()         <- cc-read-home       edge function (Home strip, Bands 1 & 2)
     loadAppDetail()    <- cc-read-app        edge function (future cockpit drilldown)
     loadActivity()     <- cc-read-audit      edge function (Band 3)
     FilesView          <- cc-read-artifacts  edge function (Files surface)

   DEMO mode (VITE_DEMO_MODE) returns sample Home rows and needs no backend.
   Live mode reads the control-plane edge functions (gsvhuzpysxaegoecwjmf).
   Every value rendered traces to a backend payload — nothing is invented.
   ============================================================================ */
import { ACCESS_REQUIRED, ago, FUNCTIONS_URL, hoursOld, sum, colorFor, APP_COLOR, HEALTH, READ_TOKEN, SEV_RANK, SEV_LABEL, INITIAL_DEMO } from './utils';

/* ───────────────────── Types — the cc-read-home contract ───────────────── */
export type BuildStatus = 'green' | 'yellow' | 'red' | 'unknown';
export type AppStatus = 'provisioning' | 'active' | 'paused' | 'archived';
export type LifecyclePhase = 'discovery' | 'build' | 'launched' | 'maintenance';

export interface RoadmapCounts {
  not_started?: number; in_progress?: number; blocked?: number;
  pending_decision?: number; shipped?: number; deferred?: number; na?: number;
}
export interface DecisionCounts { open?: number; answered?: number; }
export interface SyncHealth {
  total_tasks?: number; mirrored_tasks?: number; error_count?: number;
  pending_count?: number; stale_pending_count?: number;
  [k: string]: number | string | undefined;
}
export interface Integrations { live?: number; demo?: number; manual_safe?: number; planned?: number; }
export interface Momentum { shipped_delta?: number; }

export interface AppRow {
  id: string;
  short_code: string;
  display_name: string;
  client_name: string | null;
  status: AppStatus;
  lifecycle_phase: LifecyclePhase;
  criticality: number;
  last_snapshot_at: string | null;
  build_status: BuildStatus | null;
  roadmap_counts: RoadmapCounts;
  decision_counts: DecisionCounts;
  sync_health: SyncHealth;
  app_url: string | null;
  /* merged in from registry_app_integrations / registry_app_snapshots */
  integrations: Integrations;
  momentum: Momentum;
  sample?: boolean;
}

export interface ActivityEvent {
  occurred_at: string;
  actor: string;
  event_type: string;
  detail: Record<string, unknown> | null;
  app_id?: string;
  short_code?: string;
}

export type IssueType = 'open_decision' | 'build_health' | 'blocked_item' | 'sync_error';
export type IssueStatus =
  | 'surfaced' | 'triaging' | 'answered' | 'work_order_created'
  | 'dispatched' | 'building' | 'pr_open' | 'done'
  | 'routed_to_client' | 'gated' | 'dismissed';
export type IssueSeverity = 'critical' | 'high' | 'normal' | 'low';

export interface IssueRow {
  id: string;
  app_id: string;
  issue_type: IssueType;
  source_ref: string;
  status: IssueStatus;
  severity: IssueSeverity;
  title: string;
  summary: string | null;
  surfaced_at: string;
  last_seen_at: string;
  created_at?: string;
  updated_at?: string;
}

export type IssueAction = 'answer_decision' | 'acknowledge' | 'dismiss' | 'link_to_decision';
export type RiskClass = 'auto' | 'authorize' | 'destructive' | 'production';
export interface AnswerIssuePayload {
  answer_value?: string;
  answer_options_snapshot?: unknown;
  rationale?: string;
  risk_class?: RiskClass;
  linked_decision_ref?: string;
  decision_external_ref?: string;
}

export interface HomePayload {
  apps: AppRow[];
  issues: IssueRow[];
}

export type DetailSection = 'roadmap' | 'decisions' | 'sync' | 'all';
export interface DetailSectionPayload {
  items: Record<string, unknown>[];
  next_cursor: string | null;
}
export interface AppDetailPayload {
  available: boolean;
  message?: string;
  roadmap: DetailSectionPayload;
  decisions: DetailSectionPayload;
  sync: DetailSectionPayload;
  generated_at?: string;
  last_snapshot_at?: string | null;
  key_class?: 'readonly' | 'service_role' | null;
}

export type WorkOrderStatus = 'queued' | 'gated' | 'claimed' | 'dispatched' | 'building' | 'pr_open' | 'done' | 'failed' | 'dead_lettered' | 'cancelled';
export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
export interface AgentAppIdentity { id: string | null; short_code: string | null; display_name: string | null; }
export interface AgentWorkOrder {
  id: string;
  created_at: string;
  updated_at?: string | null;
  app_id: string;
  app: AgentAppIdentity;
  target_repo?: string | null;
  target_branch?: string | null;
  change_spec: Record<string, unknown>;
  risk_class: RiskClass;
  cost_cap_usd: number | null;
  status: WorkOrderStatus;
  gated_reason?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  dispatched_at?: string | null;
  pr_opened_at?: string | null;
  completed_at?: string | null;
  dead_lettered_at?: string | null;
  pr_url: string | null;
}
export interface AgentRun {
  id: string;
  created_at?: string | null;
  updated_at?: string | null;
  work_order_id: string;
  runner: string;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string | null;
  status: AgentRunStatus;
  cost_usd: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  pr_url: string | null;
  notes: string | null;
  app: AgentAppIdentity;
  work_order: {
    id: string | null;
    status: WorkOrderStatus | null;
    risk_class: RiskClass | null;
    change_spec: Record<string, unknown>;
  } | null;
}
export interface CostLedgerRow {
  app_id: string | null;
  short_code: string | null;
  display_name: string | null;
  runner: string | null;
  cost_usd: number;
  run_count: number;
}
export interface CostLedgerSummary {
  rows: CostLedgerRow[];
  grand_total_usd: number;
}
export interface RunnerStatus {
  online: boolean;
  last_seen_at: string | null;
  note: string;
}
export type WorkOrder = AgentWorkOrder;

export interface DispatchFromAnswerResponse {
  work_order: WorkOrder;
  dispatched: boolean;
}

export interface ApproveWorkOrderResponse {
  work_order: WorkOrder;
}

export interface AgentsPayload {
  work_orders: {
    open: AgentWorkOrder[];
    recent_completed: AgentWorkOrder[];
  };
  runs: AgentRun[];
  cost_ledger_summary: CostLedgerSummary;
  runner_status: RunnerStatus;
  generated_at?: string;
}

// The DB-layer whitelist mirrors latelyLine()'s visible cases (§5.9 deck).
// New visible event types must be added in BOTH places; new hidden types only
// need to be omitted from this list. The client-side hide check stays as
// defense-in-depth.
export const LATELY_VISIBLE_EVENT_TYPES: readonly string[] = [
  'snapshot_captured',
  'snapshot_failed',
  'app_provisioned',
  'decision_answered',
  'issue_resolved',
  'decision_routed',
  'decision_reply_received',
  'work_order_created',
  'work_order_gated',
  'pr_opened',
  'work_order_failed',
  'work_order_dead_lettered',
  'agent_dispatched',
  'agent_finished',
  'agent_failed',
  'agent_run_long',
  'pr_ready',
  'verification_failed',
  'cost_ceiling_hit',
  'runner_offline',
  'handoff_created',
  'artifact_index_failed',
];

export type TriageSev = 'critical' | 'needs' | 'watch';
export interface TriageItem {
  id: string;
  sev: TriageSev;
  title: string;
  sub: string;
  act: string;
  app: AppRow;
  issue: IssueRow;
}

/* ───────────────────── Demo seed — exact backend shapes ─────────────────── */
const isoAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export const DEMO_APPS: AppRow[] = [
  {
    /* LIVE numbers — QEP's real current snapshot */
    id: 'qep', short_code: 'QEP', display_name: 'QEP OS',
    client_name: 'Quality Equipment & Parts, Inc.',
    app_url: 'https://qep.blackrockai.co',
    status: 'active', lifecycle_phase: 'build', criticality: 100, sample: false,
    last_snapshot_at: isoAgo(8), build_status: 'green',
    roadmap_counts: { shipped: 57, in_progress: 20, not_started: 50, blocked: 27, pending_decision: 15, deferred: 5 },
    decision_counts: { open: 7, answered: 13 },
    sync_health: { total_tasks: 174, mirrored_tasks: 171, error_count: 0, pending_count: 3, stale_pending_count: 0 },
    integrations: { live: 0, demo: 0, manual_safe: 0, planned: 7 },
    momentum: { shipped_delta: 3 },
  },
  {
    id: 'scc', short_code: 'SCC', display_name: 'SCC', client_name: '—',
    app_url: null, status: 'active', lifecycle_phase: 'build', criticality: 80, sample: true,
    last_snapshot_at: isoAgo(4), build_status: 'yellow',
    roadmap_counts: { shipped: 41, in_progress: 12, not_started: 33, blocked: 14, pending_decision: 9, deferred: 3 },
    decision_counts: { open: 3, answered: 8 },
    sync_health: { total_tasks: 112, mirrored_tasks: 104, error_count: 2, pending_count: 6, stale_pending_count: 0 },
    integrations: { live: 1, demo: 0, manual_safe: 0, planned: 4 },
    momentum: { shipped_delta: 1 },
  },
  {
    id: 'col', short_code: 'COL', display_name: 'Circle of Life', client_name: '—',
    app_url: null, status: 'paused', lifecycle_phase: 'build', criticality: 60, sample: true,
    last_snapshot_at: isoAgo(300), build_status: 'green',
    roadmap_counts: { shipped: 28, in_progress: 6, not_started: 40, blocked: 8, pending_decision: 4, deferred: 2 },
    decision_counts: { open: 2, answered: 5 },
    sync_health: { total_tasks: 88, mirrored_tasks: 88, error_count: 0, pending_count: 0, stale_pending_count: 0 },
    integrations: { live: 2, demo: 0, manual_safe: 0, planned: 3 },
    momentum: { shipped_delta: 0 },
  },
  {
    id: 'fnd', short_code: 'FND', display_name: 'Foundry', client_name: '—',
    app_url: null, status: 'provisioning', lifecycle_phase: 'discovery', criticality: 40, sample: true,
    last_snapshot_at: null, build_status: 'unknown',
    roadmap_counts: {}, decision_counts: {}, sync_health: {},
    integrations: {}, momentum: {},
  },
];

export const DEMO_ISSUES: IssueRow[] = [
  {
    id: 'demo-qep-build-health', app_id: 'qep', issue_type: 'build_health', source_ref: 'aggregate',
    status: 'surfaced', severity: 'critical', title: 'QEP build is failing',
    summary: 'Last snapshot came back red before recovering; review the failure trail.',
    surfaced_at: isoAgo(9), last_seen_at: isoAgo(7),
  },
  {
    id: 'demo-qep-open-decisions', app_id: 'qep', issue_type: 'open_decision', source_ref: 'aggregate',
    status: 'triaging', severity: 'high', title: '7 decisions waiting on QEP',
    summary: '7 open, 13 answered. Answering these clears 15 pending-decision tasks.',
    surfaced_at: isoAgo(18), last_seen_at: isoAgo(8),
  },
  {
    id: 'demo-scc-sync-errors', app_id: 'scc', issue_type: 'sync_error', source_ref: 'aggregate',
    status: 'surfaced', severity: 'high', title: 'SCC sync is erroring',
    summary: '2 sync errors on the last check.',
    surfaced_at: isoAgo(14), last_seen_at: isoAgo(4),
  },
  {
    id: 'demo-col-blocked-items', app_id: 'col', issue_type: 'blocked_item', source_ref: 'aggregate',
    status: 'surfaced', severity: 'normal', title: '8 items blocked on Circle of Life',
    summary: '8 of 88 tasks are blocked.',
    surfaced_at: isoAgo(52), last_seen_at: isoAgo(30),
  },
];

export const DEMO_APP_DETAIL: AppDetailPayload = {
  available: true,
  generated_at: new Date().toISOString(),
  last_snapshot_at: new Date().toISOString(),
  key_class: 'readonly',
  roadmap: {
    next_cursor: null,
    items: [
      { stream: 'Stream A', wave: 'Wave 2', title: 'Parts search polish', status: 'in_progress', owner: 'BlackRock AI', priority: 'high' },
      { stream: 'Stream B', wave: 'Wave 2', title: 'Quote approval guardrails', status: 'blocked', blocker: 'Needs dealer policy answer' },
      { stream: 'Stream C', wave: 'Wave 3', title: 'Inventory freshness job', status: 'not_started', priority: 'normal' },
      { stream: 'Stream F', wave: 'Wave 1', title: 'Command Center snapshot contract', status: 'shipped', shipped_at: isoAgo(300) },
    ],
  },
  decisions: {
    next_cursor: null,
    items: [
      {
        id: 'demo-decision-1', title: 'Which approval threshold should auto-route quotes?', owner: 'Ryan', owner_type: 'client',
        age: '2d', status: 'open', risk_class: 'authorize',
        options: [{ id: 'route_to_manager', label: 'Route to manager' }, { id: 'auto_approve_under_500', label: 'Auto-approve under $500' }],
      },
      {
        id: 'demo-decision-2', title: 'Confirm OEM portal fallback copy', owner: 'Brian', owner_type: 'operator',
        age: '8h', status: 'open', risk_class: 'auto',
        options: [{ id: 'use_plain_language', label: 'Use plain-language fallback' }, { id: 'keep_oem_terms', label: 'Keep OEM terminology' }],
      },
    ],
  },
  sync: {
    next_cursor: null,
    items: [
      { source: 'Linear', status: 'healthy', mirrored_tasks: 171, total_tasks: 174, pending_count: 3 },
      { source: 'Supabase snapshot', status: 'fresh', last_checked: isoAgo(8), contract_version: 1 },
    ],
  },
};

export const DEMO_AGENTS: AgentsPayload = {
  generated_at: new Date().toISOString(),
  runner_status: {
    online: false,
    last_seen_at: null,
    note: 'No runner host deployed yet. See docs/handoffs/RUNNER_HOST_SETUP.md.',
  },
  work_orders: {
    open: [
      {
        id: 'demo-wo-qep-1', app_id: 'qep', app: { id: 'qep', short_code: 'QEP', display_name: 'QEP OS' },
        created_at: isoAgo(42), updated_at: isoAgo(42), target_repo: 'lewis4x4/qep', target_branch: 'main',
        change_spec: { intent: 'Polish the quote approval empty state', affected_area: 'quotes', acceptance_criteria: ['copy reads naturally', 'no schema changes'] },
        risk_class: 'auto', cost_cap_usd: 6, status: 'queued', claimed_by: null, claimed_at: null, lease_expires_at: null,
        attempt_count: 0, max_attempts: 3, last_error: null, pr_url: null,
      },
      {
        id: 'demo-wo-scc-1', app_id: 'scc', app: { id: 'scc', short_code: 'SCC', display_name: 'SCC' },
        created_at: isoAgo(95), updated_at: isoAgo(18), target_repo: 'lewis4x4/scc', target_branch: 'main',
        change_spec: { intent: 'Investigate Linear sync retries', affected_area: 'sync', acceptance_criteria: ['identify failure source', 'open PR only if code fix is safe'] },
        risk_class: 'authorize', cost_cap_usd: 12, status: 'claimed', claimed_by: 'mac-studio-01', claimed_at: isoAgo(18), lease_expires_at: isoAgo(-7),
        attempt_count: 1, max_attempts: 3, last_error: null, pr_url: null,
      },
      {
        id: 'demo-wo-qep-gated-1', app_id: 'qep', app: { id: 'qep', short_code: 'QEP', display_name: 'QEP OS' },
        created_at: isoAgo(24), updated_at: isoAgo(24), target_repo: 'lewis4x4/qep', target_branch: 'main',
        change_spec: { intent: 'Apply the answer “route to manager” to quote approval thresholds', affected_area: 'quotes', acceptance_criteria: ['manager route is implemented', 'existing tests pass'] },
        risk_class: 'authorize', cost_cap_usd: 5, status: 'gated', gated_reason: 'authorize_class', approved_by: null, approved_at: null,
        claimed_by: null, claimed_at: null, lease_expires_at: null, attempt_count: 0, max_attempts: 3, last_error: null, pr_url: null,
      },
      {
        id: 'demo-wo-scc-gated-1', app_id: 'scc', app: { id: 'scc', short_code: 'SCC', display_name: 'SCC' },
        created_at: isoAgo(66), updated_at: isoAgo(66), target_repo: 'lewis4x4/scc', target_branch: 'main',
        change_spec: { intent: 'Prepare production sync retry backfill', affected_area: 'sync', acceptance_criteria: ['backfill plan is safe', 'no destructive migration'] },
        risk_class: 'production', cost_cap_usd: 8, status: 'gated', gated_reason: 'production_class', approved_by: null, approved_at: null,
        claimed_by: null, claimed_at: null, lease_expires_at: null, attempt_count: 0, max_attempts: 3, last_error: null, pr_url: null,
      },
      {
        id: 'demo-wo-qep-pr-1', app_id: 'qep', app: { id: 'qep', short_code: 'QEP', display_name: 'QEP OS' },
        created_at: isoAgo(210), updated_at: isoAgo(30), target_repo: 'lewis4x4/qep', target_branch: 'main',
        change_spec: { intent: 'Tighten OEM portal fallback copy', affected_area: 'portal fallback', acceptance_criteria: ['copy is plain-language', 'tests pass'] },
        risk_class: 'auto', cost_cap_usd: 4, status: 'pr_open', claimed_by: 'mac-studio-01', claimed_at: isoAgo(190), lease_expires_at: null,
        attempt_count: 1, max_attempts: 3, last_error: null, pr_opened_at: isoAgo(30), pr_url: 'https://github.com/lewis4x4/qep/pull/131',
      },
      {
        id: 'demo-wo-scc-pr-1', app_id: 'scc', app: { id: 'scc', short_code: 'SCC', display_name: 'SCC' },
        created_at: isoAgo(260), updated_at: isoAgo(75), target_repo: 'lewis4x4/scc', target_branch: 'main',
        change_spec: { intent: 'Fix project-grid health copy for SCC', affected_area: 'home', acceptance_criteria: ['copy reads naturally', 'build passes'] },
        risk_class: 'auto', cost_cap_usd: 3, status: 'pr_open', claimed_by: 'cursor-bg', claimed_at: isoAgo(240), lease_expires_at: null,
        attempt_count: 1, max_attempts: 3, last_error: null, pr_opened_at: isoAgo(75), pr_url: 'https://github.com/lewis4x4/scc/pull/44',
      },
    ],
    recent_completed: [
      {
        id: 'demo-wo-qep-0', app_id: 'qep', app: { id: 'qep', short_code: 'QEP', display_name: 'QEP OS' },
        created_at: isoAgo(260), updated_at: isoAgo(72), target_repo: 'lewis4x4/qep', target_branch: 'main',
        change_spec: { intent: 'Add acceptance copy to decisions panel', affected_area: 'command-center cockpit' },
        risk_class: 'auto', cost_cap_usd: 5, status: 'done', claimed_by: 'mac-studio-01', claimed_at: isoAgo(220), lease_expires_at: null,
        attempt_count: 1, max_attempts: 3, last_error: null, pr_opened_at: isoAgo(72), completed_at: isoAgo(70), pr_url: 'https://github.com/lewis4x4/qep/pull/124',
      },
    ],
  },
  runs: [
    {
      id: 'demo-run-qep-1', work_order_id: 'demo-wo-qep-0', runner: 'claude_code_goal', started_at: isoAgo(220), finished_at: isoAgo(72), heartbeat_at: isoAgo(74), status: 'succeeded',
      cost_usd: 1.84, tokens_input: 48210, tokens_output: 9120, pr_url: 'https://github.com/lewis4x4/qep/pull/124', notes: 'Opened PR; waiting for human merge.',
      app: { id: 'qep', short_code: 'QEP', display_name: 'QEP OS' },
      work_order: { id: 'demo-wo-qep-0', status: 'pr_open', risk_class: 'auto', change_spec: { intent: 'Add acceptance copy to decisions panel' } },
    },
    {
      id: 'demo-run-scc-1', work_order_id: 'demo-wo-scc-0', runner: 'cursor_bg', started_at: isoAgo(360), finished_at: isoAgo(318), heartbeat_at: isoAgo(320), status: 'failed',
      cost_usd: 0.42, tokens_input: 18400, tokens_output: 2400, pr_url: null, notes: 'Stopped before PR: missing repo installation token.',
      app: { id: 'scc', short_code: 'SCC', display_name: 'SCC' },
      work_order: { id: 'demo-wo-scc-0', status: 'failed', risk_class: 'authorize', change_spec: { intent: 'Probe sync failure' } },
    },
  ],
  cost_ledger_summary: {
    rows: [
      { app_id: 'qep', short_code: 'QEP', display_name: 'QEP OS', runner: 'claude_code_goal', cost_usd: 1.84, run_count: 1 },
      { app_id: 'scc', short_code: 'SCC', display_name: 'SCC', runner: 'cursor_bg', cost_usd: 0.42, run_count: 1 },
    ],
    grand_total_usd: 2.26,
  },
};

export const DEMO_ACTIVITY: ActivityEvent[] = [
  { occurred_at: isoAgo(2),   short_code: 'QEP', actor: 'aggregator', event_type: 'snapshot_captured', detail: { build_status: 'green' } },
  { occurred_at: isoAgo(4),   short_code: 'SCC', actor: 'aggregator', event_type: 'snapshot_captured', detail: { build_status: 'yellow' } },
  { occurred_at: isoAgo(7),   short_code: 'QEP', actor: 'aggregator', event_type: 'snapshot_captured', detail: { build_status: 'red' } },
  { occurred_at: isoAgo(10),  short_code: 'FND', actor: 'aggregator', event_type: 'snapshot_failed', detail: { error: "control-plane secret 'SVC_KEY_FND' is not set", app_name: 'Foundry' } },
  { occurred_at: isoAgo(13),  short_code: 'SCC', actor: 'aggregator', event_type: 'snapshot_failed', detail: { error: 'app unreachable' } },
  { occurred_at: isoAgo(16),  short_code: 'QEP', actor: 'blewis@lewisinsurance.com', event_type: 'app_provisioned', detail: { short_code: 'QEP' } },
  { occurred_at: isoAgo(18),  short_code: 'QEP', actor: 'blewis@lewisinsurance.com', event_type: 'secret_read', detail: { secret_ref: 'SVC_KEY_QEP' } },
  { occurred_at: isoAgo(20),  short_code: 'QEP', actor: 'blewis@lewisinsurance.com', event_type: 'decision_answered', detail: { answer_kind: 'operator_decision' } },
  { occurred_at: isoAgo(24),  short_code: 'QEP', actor: 'client:ryan@example.com', event_type: 'decision_answered', detail: { answer_kind: 'client_decision' } },
  { occurred_at: isoAgo(28),  short_code: 'SCC', actor: 'blewis@lewisinsurance.com', event_type: 'decision_routed', detail: { owner_name: 'Rylee', owner_email: 'rylee@example.com' } },
  { occurred_at: isoAgo(32),  short_code: 'SCC', actor: 'client:rylee@example.com', event_type: 'decision_reply_received', detail: { owner_name: 'Rylee' } },
  { occurred_at: isoAgo(36),  short_code: 'QEP', actor: 'system', event_type: 'work_order_created', detail: { risk_class: 'auto' } },
  { occurred_at: isoAgo(40),  short_code: 'QEP', actor: 'system', event_type: 'work_order_created', detail: { risk_class: 'authorize' } },
  { occurred_at: isoAgo(42),  short_code: 'QEP', actor: 'system', event_type: 'work_order_gated', detail: { risk_class: 'authorize', gated_reason: 'authorize_class' } },
  { occurred_at: isoAgo(44),  short_code: 'QEP', actor: 'runner', event_type: 'agent_dispatched', detail: { runner: 'goal' } },
  { occurred_at: isoAgo(48),  short_code: 'QEP', actor: 'runner', event_type: 'agent_finished', detail: { outcome: 'succeeded' } },
  { occurred_at: isoAgo(52),  short_code: 'QEP', actor: 'runner', event_type: 'agent_failed', detail: { error: 'typecheck failed' } },
  { occurred_at: isoAgo(56),  short_code: 'QEP', actor: 'runner', event_type: 'agent_run_long', detail: { minutes_in: 40, baseline_min: 8 } },
  { occurred_at: isoAgo(60),  short_code: 'QEP', actor: 'runner', event_type: 'pr_ready', detail: { pr_url: 'https://github.com/lewis4x4/qep/pull/1' } },
  { occurred_at: isoAgo(64),  short_code: 'QEP', actor: 'verifier', event_type: 'verification_failed', detail: { check: 'acceptance' } },
  { occurred_at: isoAgo(68),  short_code: 'QEP', actor: 'runner', event_type: 'cost_ceiling_hit', detail: { cap_usd: 5 } },
  { occurred_at: isoAgo(72),  actor: 'runner', event_type: 'runner_offline', detail: { runner_host: 'Mac Studio' } },
  { occurred_at: isoAgo(76),  short_code: 'QEP', actor: 'system', event_type: 'handoff_created', detail: { kind: 'manual_step' } },
];

/* ───────────────────── Data loaders ─────────────────────────────────────── */

type EdgeErrorBody = { error?: unknown; detail?: unknown };

const APP_STATUSES = new Set<AppStatus>(['provisioning', 'active', 'paused', 'archived']);
const LIFECYCLE_PHASES = new Set<LifecyclePhase>(['discovery', 'build', 'launched', 'maintenance']);
const BUILD_STATUSES = new Set<BuildStatus>(['green', 'yellow', 'red', 'unknown']);
const RISK_CLASSES = new Set<RiskClass>(['auto', 'authorize', 'destructive', 'production']);
const WORK_ORDER_STATUSES = new Set<WorkOrderStatus>(['queued', 'gated', 'claimed', 'dispatched', 'building', 'pr_open', 'done', 'failed', 'dead_lettered', 'cancelled']);
const AGENT_RUN_STATUSES = new Set<AgentRunStatus>(['running', 'succeeded', 'failed', 'timed_out', 'cancelled']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!ACCESS_REQUIRED && READ_TOKEN) headers['x-cc-read-token'] = READ_TOKEN;
  return headers;
}

function cleanError(prefix: string, status: number, payload: unknown): Error {
  const body: EdgeErrorBody = isRecord(payload) ? payload : {};
  const parts = [asString(body.error), asString(body.detail)].filter(Boolean);
  return new Error(parts.length ? `${prefix}: ${parts.join(': ')}` : `${prefix} returned ${status}`);
}

async function fetchJsonResponse(path: string, params?: URLSearchParams): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const qs = params?.toString();
  const url = `${FUNCTIONS_URL}/${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { method: 'GET', headers: readHeaders() });
  const payload: unknown = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, payload };
}

async function fetchJson(path: string, params?: URLSearchParams): Promise<unknown> {
  const res = await fetchJsonResponse(path, params);
  if (!res.ok) throw cleanError(path, res.status, res.payload);
  return res.payload;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${FUNCTIONS_URL}/${path}`, {
    method: 'POST',
    headers: { ...readHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw cleanError(path, res.status, payload);
  return payload;
}

function parseIntegrations(value: unknown): Integrations {
  const rec = asRecord(value);
  return {
    live: asNumber(rec.live) ?? undefined,
    demo: asNumber(rec.demo) ?? undefined,
    manual_safe: asNumber(rec.manual_safe) ?? undefined,
    planned: asNumber(rec.planned) ?? undefined,
  };
}

function parseMomentum(value: unknown): Momentum {
  const rec = asRecord(value);
  return { shipped_delta: asNumber(rec.shipped_delta) ?? undefined };
}

const ISSUE_TYPES = new Set<IssueType>(['open_decision', 'build_health', 'blocked_item', 'sync_error']);
const ISSUE_STATUSES = new Set<IssueStatus>([
  'surfaced', 'triaging', 'answered', 'work_order_created', 'dispatched', 'building', 'pr_open', 'done',
  'routed_to_client', 'gated', 'dismissed',
]);
const ISSUE_SEVERITIES = new Set<IssueSeverity>(['critical', 'high', 'normal', 'low']);

function parseAppRow(value: unknown): AppRow {
  if (!isRecord(value)) throw new Error('cc-read-home payload contains an invalid app row');
  const id = asString(value.id);
  const shortCode = asString(value.short_code);
  const displayName = asString(value.display_name);
  const status = asString(value.status);
  if (!id || !shortCode || !displayName || !status) throw new Error('cc-read-home app row is missing required fields');
  if (!APP_STATUSES.has(status as AppStatus)) throw new Error(`cc-read-home app row has invalid status: ${status}`);

  const lifecyclePhase = asString(value.lifecycle_phase);
  const buildStatus = asString(value.build_status);
  return {
    ...(value as unknown as AppRow),
    id,
    short_code: shortCode,
    display_name: displayName,
    client_name: asString(value.client_name),
    status: status as AppStatus,
    lifecycle_phase: LIFECYCLE_PHASES.has(lifecyclePhase as LifecyclePhase) ? lifecyclePhase as LifecyclePhase : 'discovery',
    criticality: asNumber(value.criticality) ?? 0,
    last_snapshot_at: asString(value.last_snapshot_at),
    build_status: BUILD_STATUSES.has(buildStatus as BuildStatus) ? buildStatus as BuildStatus : null,
    roadmap_counts: asRecord(value.roadmap_counts) as RoadmapCounts,
    decision_counts: asRecord(value.decision_counts) as DecisionCounts,
    sync_health: asRecord(value.sync_health) as SyncHealth,
    app_url: asString(value.app_url),
    integrations: parseIntegrations(value.integrations),
    momentum: parseMomentum(value.momentum),
  };
}

function parseIssueRow(value: unknown): IssueRow {
  if (!isRecord(value)) throw new Error('cc-read-home payload contains an invalid issue row');
  const id = asString(value.id);
  const appId = asString(value.app_id);
  const issueType = asString(value.issue_type);
  const status = asString(value.status);
  const severity = asString(value.severity);
  const title = asString(value.title);
  const surfacedAt = asString(value.surfaced_at);
  const lastSeenAt = asString(value.last_seen_at);
  if (!id || !appId || !issueType || !status || !severity || !title || !surfacedAt || !lastSeenAt) {
    throw new Error('cc-read-home issue row is missing required fields');
  }
  if (!ISSUE_TYPES.has(issueType as IssueType)) throw new Error(`cc-read-home issue row has invalid issue_type: ${issueType}`);
  if (!ISSUE_STATUSES.has(status as IssueStatus)) throw new Error(`cc-read-home issue row has invalid status: ${status}`);
  if (!ISSUE_SEVERITIES.has(severity as IssueSeverity)) throw new Error(`cc-read-home issue row has invalid severity: ${severity}`);
  return {
    id,
    app_id: appId,
    issue_type: issueType as IssueType,
    source_ref: asString(value.source_ref) ?? '',
    status: status as IssueStatus,
    severity: severity as IssueSeverity,
    title,
    summary: asString(value.summary),
    surfaced_at: surfacedAt,
    last_seen_at: lastSeenAt,
    created_at: asString(value.created_at) ?? undefined,
    updated_at: asString(value.updated_at) ?? undefined,
  };
}

function parseHomeResponse(value: unknown): HomePayload {
  if (!isRecord(value) || !Array.isArray(value.apps) || !Array.isArray(value.issues) || !asString(value.generated_at)) {
    throw new Error('cc-read-home payload is invalid');
  }
  return {
    apps: value.apps.map(parseAppRow),
    issues: value.issues.map(parseIssueRow),
  };
}

function parseActivityEvent(value: unknown): ActivityEvent {
  if (!isRecord(value)) throw new Error('cc-read-audit payload contains an invalid event row');
  const occurredAt = asString(value.occurred_at);
  const actor = asString(value.actor);
  const eventType = asString(value.event_type);
  if (!occurredAt || !actor || !eventType) throw new Error('cc-read-audit event row is missing required fields');
  return {
    occurred_at: occurredAt,
    actor,
    event_type: eventType,
    detail: isRecord(value.detail) ? value.detail : null,
    app_id: asString(value.app_id) ?? undefined,
    short_code: asString(value.short_code) ?? undefined,
  };
}

function parseAuditResponse(value: unknown): ActivityEvent[] {
  if (!isRecord(value) || !Array.isArray(value.events) || !asString(value.generated_at)) {
    throw new Error('cc-read-audit payload is invalid');
  }
  return value.events.map(parseActivityEvent);
}

function parseAgentAppIdentity(value: unknown): AgentAppIdentity {
  const rec = asRecord(value);
  return {
    id: asString(rec.id),
    short_code: asString(rec.short_code),
    display_name: asString(rec.display_name),
  };
}

function parseRiskClass(value: unknown): RiskClass {
  const raw = asString(value);
  return RISK_CLASSES.has(raw as RiskClass) ? raw as RiskClass : 'auto';
}

function parseWorkOrderStatus(value: unknown): WorkOrderStatus {
  const raw = asString(value);
  if (!WORK_ORDER_STATUSES.has(raw as WorkOrderStatus)) throw new Error(`cc-read-agents work order has invalid status: ${raw}`);
  return raw as WorkOrderStatus;
}

function parseAgentRunStatus(value: unknown): AgentRunStatus {
  const raw = asString(value);
  if (!AGENT_RUN_STATUSES.has(raw as AgentRunStatus)) throw new Error(`cc-read-agents run has invalid status: ${raw}`);
  return raw as AgentRunStatus;
}

function parseAgentWorkOrder(value: unknown): AgentWorkOrder {
  if (!isRecord(value)) throw new Error('cc-read-agents payload contains an invalid work order row');
  const id = asString(value.id);
  const createdAt = asString(value.created_at);
  const appId = asString(value.app_id);
  if (!id || !createdAt || !appId) throw new Error('cc-read-agents work order row is missing required fields');
  return {
    id,
    created_at: createdAt,
    updated_at: asString(value.updated_at),
    app_id: appId,
    app: parseAgentAppIdentity(value.app),
    target_repo: asString(value.target_repo),
    target_branch: asString(value.target_branch),
    change_spec: asRecord(value.change_spec),
    risk_class: parseRiskClass(value.risk_class),
    cost_cap_usd: asNumber(value.cost_cap_usd),
    status: parseWorkOrderStatus(value.status),
    gated_reason: asString(value.gated_reason),
    approved_by: asString(value.approved_by),
    approved_at: asString(value.approved_at),
    claimed_by: asString(value.claimed_by),
    claimed_at: asString(value.claimed_at),
    lease_expires_at: asString(value.lease_expires_at),
    attempt_count: asNumber(value.attempt_count) ?? 0,
    max_attempts: asNumber(value.max_attempts) ?? 0,
    last_error: asString(value.last_error),
    dispatched_at: asString(value.dispatched_at),
    pr_opened_at: asString(value.pr_opened_at),
    completed_at: asString(value.completed_at),
    dead_lettered_at: asString(value.dead_lettered_at),
    pr_url: asString(value.pr_url),
  };
}

function parseAgentRun(value: unknown): AgentRun {
  if (!isRecord(value)) throw new Error('cc-read-agents payload contains an invalid run row');
  const id = asString(value.id);
  const workOrderId = asString(value.work_order_id);
  const runner = asString(value.runner);
  const startedAt = asString(value.started_at);
  if (!id || !workOrderId || !runner || !startedAt) throw new Error('cc-read-agents run row is missing required fields');
  const workOrder = isRecord(value.work_order) ? value.work_order : null;
  return {
    id,
    created_at: asString(value.created_at),
    updated_at: asString(value.updated_at),
    work_order_id: workOrderId,
    runner,
    started_at: startedAt,
    finished_at: asString(value.finished_at),
    heartbeat_at: asString(value.heartbeat_at),
    status: parseAgentRunStatus(value.status),
    cost_usd: asNumber(value.cost_usd),
    tokens_input: asNumber(value.tokens_input),
    tokens_output: asNumber(value.tokens_output),
    pr_url: asString(value.pr_url),
    notes: asString(value.notes),
    app: parseAgentAppIdentity(value.app),
    work_order: workOrder
      ? {
        id: asString(workOrder.id),
        status: WORK_ORDER_STATUSES.has(asString(workOrder.status) as WorkOrderStatus) ? asString(workOrder.status) as WorkOrderStatus : null,
        risk_class: RISK_CLASSES.has(asString(workOrder.risk_class) as RiskClass) ? asString(workOrder.risk_class) as RiskClass : null,
        change_spec: asRecord(workOrder.change_spec),
      }
      : null,
  };
}

function parseCostLedgerRow(value: unknown): CostLedgerRow {
  const rec = asRecord(value);
  return {
    app_id: asString(rec.app_id),
    short_code: asString(rec.short_code),
    display_name: asString(rec.display_name),
    runner: asString(rec.runner),
    cost_usd: asNumber(rec.cost_usd) ?? 0,
    run_count: asNumber(rec.run_count) ?? 0,
  };
}

function parseAgentsResponse(value: unknown): AgentsPayload {
  if (!isRecord(value) || !isRecord(value.work_orders) || !Array.isArray(value.runs) || !isRecord(value.cost_ledger_summary) || !isRecord(value.runner_status)) {
    throw new Error('cc-read-agents payload is invalid');
  }
  const workOrders = asRecord(value.work_orders);
  const costLedger = asRecord(value.cost_ledger_summary);
  const runnerStatus = asRecord(value.runner_status);
  return {
    work_orders: {
      open: Array.isArray(workOrders.open) ? workOrders.open.map(parseAgentWorkOrder) : [],
      recent_completed: Array.isArray(workOrders.recent_completed) ? workOrders.recent_completed.map(parseAgentWorkOrder) : [],
    },
    runs: value.runs.map(parseAgentRun),
    cost_ledger_summary: {
      rows: Array.isArray(costLedger.rows) ? costLedger.rows.map(parseCostLedgerRow) : [],
      grand_total_usd: asNumber(costLedger.grand_total_usd) ?? 0,
    },
    runner_status: {
      online: runnerStatus.online === true,
      last_seen_at: asString(runnerStatus.last_seen_at),
      note: asString(runnerStatus.note) ?? '',
    },
    generated_at: asString(value.generated_at) ?? undefined,
  };
}

function parseDispatchFromAnswerResponse(value: unknown): DispatchFromAnswerResponse {
  if (!isRecord(value) || !isRecord(value.work_order) || typeof value.dispatched !== 'boolean') {
    throw new Error('cc-dispatch-from-answer payload is invalid');
  }
  return { work_order: parseAgentWorkOrder(value.work_order), dispatched: value.dispatched };
}

function parseApproveWorkOrderResponse(value: unknown): ApproveWorkOrderResponse {
  if (!isRecord(value) || !isRecord(value.work_order)) {
    throw new Error('cc-approve-work-order payload is invalid');
  }
  return { work_order: parseAgentWorkOrder(value.work_order) };
}

/* SOURCE 1 — cc-read-home (merged app strip/cards + issue ledger payload). */
export async function loadHome(demo: boolean): Promise<HomePayload> {
  if (demo) return { apps: structuredClone(DEMO_APPS), issues: structuredClone(DEMO_ISSUES) };
  return parseHomeResponse(await fetchJson('cc-read-home'));
}

export async function loadApps(demo: boolean): Promise<AppRow[]> {
  return (await loadHome(demo)).apps;
}

/* SOURCE 2 — cc-read-audit (Band 3 activity feed). */
export async function loadActivity(demo: boolean): Promise<ActivityEvent[]> {
  if (demo) return structuredClone(DEMO_ACTIVITY).filter((ev) => latelyLine(ev)[1]);
  const params = new URLSearchParams();
  params.set('lately_only', 'true');
  params.set('limit', '20');
  return parseAuditResponse(await fetchJson('cc-read-audit', params));
}

/* SOURCE 3 — cc-read-agents (Agents nav page queue/run/cost read surface). */
export async function loadAgents(demo: boolean): Promise<AgentsPayload> {
  if (demo) return structuredClone(DEMO_AGENTS);
  return parseAgentsResponse(await fetchJson('cc-read-agents'));
}

/* SOURCE 4 — cc-read-app (registry/config drilldown placeholder). */
export async function loadAppDetail(appId: string): Promise<unknown> {
  const params = new URLSearchParams();
  params.set('app_id', appId);
  return fetchJson('cc-read-app', params);
}

function emptyDetailSection(): DetailSectionPayload {
  return { items: [], next_cursor: null };
}

function normalizeDetailSection(value: unknown): DetailSectionPayload {
  if (Array.isArray(value)) return { items: value.filter(isRecord), next_cursor: null };
  const rec = asRecord(value);
  const rawItems = Array.isArray(rec.items) ? rec.items : [];
  return {
    items: rawItems.filter(isRecord),
    next_cursor: asString(rec.next_cursor),
  };
}

function parseAppDetailPayload(value: unknown): AppDetailPayload {
  const rec = asRecord(value);
  const data = asRecord(rec.data ?? value);
  const keyClass = asString(rec.key_class);
  return {
    available: true,
    roadmap: normalizeDetailSection(data.roadmap),
    decisions: normalizeDetailSection(data.decisions),
    sync: normalizeDetailSection(data.sync),
    generated_at: asString(rec.generated_at) ?? undefined,
    last_snapshot_at: asString(rec.last_snapshot_at) ?? null,
    key_class: keyClass === 'readonly' || keyClass === 'service_role' ? keyClass : null,
  };
}

function parseDetailSectionPayload(value: unknown, section: Exclude<DetailSection, 'all'>): DetailSectionPayload {
  const rec = asRecord(value);
  const data = rec.data ?? value;
  const dataRec = asRecord(data);
  if (dataRec[section] !== undefined) return normalizeDetailSection(dataRec[section]);
  return normalizeDetailSection(data);
}

export async function loadAppCockpitDetail(appId: string, demo: boolean, section: DetailSection = 'all', cursor?: string): Promise<AppDetailPayload> {
  if (demo) return structuredClone(DEMO_APP_DETAIL);

  const params = new URLSearchParams();
  params.set('app_id', appId);
  params.set('section', section);
  if (cursor) params.set('cursor', cursor);

  const res = await fetchJsonResponse('cc-read-app-detail', params);
  if (res.ok) return parseAppDetailPayload(res.payload);
  if (res.status === 503 && isRecord(res.payload)) {
    return {
      available: false,
      message: asString(res.payload.message) ?? 'Cockpit is not wired for this app yet.',
      roadmap: emptyDetailSection(),
      decisions: emptyDetailSection(),
      sync: emptyDetailSection(),
      generated_at: asString(res.payload.generated_at) ?? undefined,
      last_snapshot_at: asString(res.payload.last_snapshot_at) ?? null,
      key_class: null,
    };
  }
  throw cleanError('cc-read-app-detail', res.status, res.payload);
}

export async function loadAppDetailSection(appId: string, demo: boolean, section: Exclude<DetailSection, 'all'>, cursor?: string): Promise<DetailSectionPayload> {
  if (demo) return structuredClone(DEMO_APP_DETAIL[section]);

  const params = new URLSearchParams();
  params.set('app_id', appId);
  params.set('section', section);
  if (cursor) params.set('cursor', cursor);

  const res = await fetchJsonResponse('cc-read-app-detail', params);
  if (res.ok) return parseDetailSectionPayload(res.payload, section);
  if (res.status === 503) return emptyDetailSection();
  throw cleanError('cc-read-app-detail', res.status, res.payload);
}

export async function answerIssue(issueId: string, action: IssueAction, payload: AnswerIssuePayload = {}, demo = false): Promise<unknown> {
  if (demo) {
    const risk = payload.risk_class ?? 'auto';
    return {
      issue: {
        id: issueId,
        status: action === 'dismiss' ? 'dismissed' : action === 'answer_decision' ? 'answered' : 'triaging',
        decision_answer_id: action === 'answer_decision' ? `demo-answer-${risk}-${issueId}` : null,
      },
      action,
    };
  }
  return postJson('cc-answer-issue', { issue_id: issueId, action, ...payload });
}

export async function dispatchFromAnswer(decisionAnswerId: string, demo = false): Promise<DispatchFromAnswerResponse> {
  if (demo) {
    const status: WorkOrderStatus = decisionAnswerId.includes('authorize') || decisionAnswerId.includes('destructive') || decisionAnswerId.includes('production') ? 'gated' : 'queued';
    return {
      dispatched: status === 'queued',
      work_order: {
        id: `demo-wo-${decisionAnswerId}`,
        created_at: new Date().toISOString(),
        app_id: 'qep',
        app: { id: 'qep', short_code: 'QEP', display_name: 'QEP OS' },
        change_spec: { intent: 'Apply the answered decision' },
        risk_class: decisionAnswerId.includes('production') ? 'production' : decisionAnswerId.includes('destructive') ? 'destructive' : decisionAnswerId.includes('authorize') ? 'authorize' : 'auto',
        cost_cap_usd: null,
        status,
        gated_reason: status === 'gated' ? 'authorize_class' : null,
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        attempt_count: 0,
        max_attempts: 3,
        last_error: null,
        pr_url: null,
      },
    };
  }
  return parseDispatchFromAnswerResponse(await postJson('cc-dispatch-from-answer', { decision_answer_id: decisionAnswerId }));
}

export async function approveWorkOrder(workOrderId: string, demo = false): Promise<ApproveWorkOrderResponse> {
  if (demo) {
    return parseApproveWorkOrderResponse({
      work_order: {
        id: workOrderId,
        created_at: new Date().toISOString(),
        app_id: 'qep',
        app: { id: 'qep', short_code: 'QEP', display_name: 'QEP OS' },
        change_spec: { intent: 'Approved demo work order' },
        risk_class: 'authorize',
        cost_cap_usd: null,
        status: 'queued',
        gated_reason: null,
        approved_by: 'demo-operator',
        approved_at: new Date().toISOString(),
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        attempt_count: 0,
        max_attempts: 3,
        last_error: null,
        pr_url: null,
      },
    });
  }
  return parseApproveWorkOrderResponse(await postJson('cc-approve-work-order', { work_order_id: workOrderId }));
}

/* ───────────────────── Helpers ──────────────────────────────────────────── */
export { ago, hoursOld, sum, colorFor, APP_COLOR, HEALTH, SEV_RANK, SEV_LABEL, INITIAL_DEMO } from './utils';

export type LatelyTone = 'plain' | 'needs' | 'failure';

function eventApp(ev: ActivityEvent): string {
  return ev.short_code ?? 'an app';
}

function detailString(d: Record<string, unknown>, key: string): string | null {
  const v = d[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function detailNumber(d: Record<string, unknown>, key: string): number | null {
  const v = d[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function firstNameFromActor(actor: string): string {
  const raw = actor.startsWith('client:') ? actor.slice('client:'.length) : actor;
  const local = raw.split('@')[0] ?? raw;
  const first = local.split(/[._+-]/)[0] ?? local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'Someone';
}

function isAuthorizeWorkOrder(d: Record<string, unknown>): boolean {
  return d.risk_class === 'authorize' || d.risk_class === 'destructive' || d.risk_class === 'production' || d.requires_authorization === true || d.status === 'pending_authorization' || d.status === 'gated';
}

/* cc_audit_events row -> §5.9 Lately [sentence, show]. show=false stays in Settings audit only.
   Indexer events use the §5.9 routine/exception cut: artifacts_indexed is routine (hidden),
   artifact_index_failed is exceptional (visible). */
export function latelyLine(ev: ActivityEvent): [sentence: string, show: boolean] {
  const d: Record<string, unknown> = ev.detail ?? {};
  const app = eventApp(ev);
  switch (ev.event_type) {
    case 'snapshot_captured': {
      const status = d.build_status;
      if (status === 'green') return ['', false];
      if (status === 'yellow') return [`${app}'s build needs a look — its last check-in came back yellow.`, true];
      if (status === 'red') return [`${app}'s build is failing — its last check-in came back red.`, true];
      return ['', false];
    }
    case 'snapshot_failed': {
      const err = String(d.error ?? '').toLowerCase();
      if (err.includes('secret') || err.includes('key') || err.includes('access')) {
        return [`Couldn't reach ${app} — its access key isn't set up yet.`, true];
      }
      return [`Couldn't reach ${app} on the last check — it may be down.`, true];
    }
    case 'app_provisioned':
      return [`${app} was added to the Command Center.`, true];
    case 'secret_read':
    case 'detail_read':
    case 'agents_page_read':
    case 'issue_acknowledged':
    case 'issue_dismissed':
      return ['', false];
    case 'issue_resolved':
      return [`You answered a decision on ${app} — a build can move forward.`, true];
    case 'decision_answered': {
      const who = ev.actor.startsWith('client:') ? firstNameFromActor(ev.actor) : 'You';
      return [`${who} answered a decision on ${app} — a build can move now.`, true];
    }
    case 'decision_routed': {
      const owner = detailString(d, 'owner_name') ?? 'the owner';
      return [`A decision on ${app} was emailed to ${owner} to answer.`, true];
    }
    case 'decision_reply_received': {
      const owner = detailString(d, 'owner_name') ?? firstNameFromActor(ev.actor);
      return [`${owner} replied to a decision on ${app} — it's waiting for you to confirm their answer.`, true];
    }
    case 'work_order_created':
      return isAuthorizeWorkOrder(d)
        ? [`A build task for ${app} is ready — it needs your go-ahead.`, true]
        : [`A build task was lined up for ${app} — it'll start on its own.`, true];
    case 'work_order_gated':
      return [`A work order needs your approval on ${app}.`, true];
    case 'pr_opened':
      return [`${app} has a PR ready for review.`, true];
    case 'work_order_failed':
    case 'work_order_dead_lettered':
      return [`${app} build failed — needs a look.`, true];
    case 'agent_dispatched':
      return [`A build started on ${app} — Claude Code is on it.`, true];
    case 'agent_finished':
      return [`The build agent finished on ${app} — work is ready.`, true];
    case 'agent_failed':
      return [`A build on ${app} didn't finish — the agent hit an error.`, true];
    case 'agent_run_long': {
      const minutes = detailNumber(d, 'minutes_in') ?? 40;
      const baseline = detailNumber(d, 'baseline_min') ?? 8;
      return [`A build on ${app} is running long — ${minutes} minutes in, where ${baseline} is normal.`, true];
    }
    case 'pr_ready':
      return [`A pull request is ready for your review on ${app}.`, true];
    case 'verification_failed':
      return [`A build on ${app} came back but didn't pass its checks — it went back to the agent, not to you.`, true];
    case 'cost_ceiling_hit':
      return [`${app} hit its spending limit for build work — nothing new runs until you raise it.`, true];
    case 'runner_offline':
      return ["The Mac Studio runner went quiet — builds are paused until it's back.", true];
    case 'handoff_created':
      return [`${app} needs a hand from you — open it for the steps.`, true];
    case 'artifacts_indexed':
      return ['', false];
    case 'artifact_index_failed':
      return ['File indexing hit an error — see Settings audit for details.', true];
    default:
      // Default: hide. §5.9 is a whitelist — events not in the deck stay in Settings audit until copy is approved.
      return ['', false];
  }
}

export function latelyTone(ev: ActivityEvent): LatelyTone {
  const d: Record<string, unknown> = ev.detail ?? {};
  if (
    ev.event_type === 'decision_reply_received' ||
    ev.event_type === 'cost_ceiling_hit' ||
    ev.event_type === 'runner_offline' ||
    ev.event_type === 'handoff_created' ||
    ev.event_type === 'work_order_gated' ||
    (ev.event_type === 'work_order_created' && isAuthorizeWorkOrder(d))
  ) return 'needs';
  if (
    ev.event_type === 'snapshot_failed' ||
    ev.event_type === 'work_order_failed' ||
    ev.event_type === 'work_order_dead_lettered' ||
    ev.event_type === 'agent_failed' ||
    ev.event_type === 'verification_failed' ||
    ev.event_type === 'artifact_index_failed' ||
    (ev.event_type === 'snapshot_captured' && d.build_status === 'red')
  ) return 'failure';
  return 'plain';
}

/** @deprecated Use latelyLine(), which returns the §5.9 single-sentence Lately copy. */
export function activityLine(ev: ActivityEvent): [string, string] {
  const [sentence] = latelyLine(ev);
  return [sentence, ''];
}
