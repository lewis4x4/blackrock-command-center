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

export type OnboardingStepId = 'gmail_test_users_added' | 'client_emits_owner_kind';
export type OnboardingStepState = { done: boolean; at?: string; by?: string };

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
  auto_route_decisions?: boolean;
  onboarding_steps?: Record<string, OnboardingStepState>;
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
export interface DecisionRecipient {
  id: string;
  app_id: string;
  contact_name: string;
  contact_email: string;
  contact_role: string | null;
  active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AppDetailPayload {
  available: boolean;
  message?: string;
  roadmap: DetailSectionPayload;
  decisions: DetailSectionPayload;
  sync: DetailSectionPayload;
  decision_recipients?: DecisionRecipient[];
  generated_at?: string;
  last_snapshot_at?: string | null;
  key_class?: 'readonly' | 'service_role' | null;
}

export type WorkOrderStatus = 'queued' | 'gated' | 'claimed' | 'dispatched' | 'building' | 'pr_open' | 'done' | 'failed' | 'dead_lettered' | 'cancelled';
export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
export type OperatorHandoffKind = 'manual_step' | 'compose_by_hand' | 'credential_rotation';
export type OperatorHandoffStatus = 'open' | 'acknowledged' | 'done';
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
export interface OperatorHandoff {
  id: string;
  app_id: string;
  kind: OperatorHandoffKind;
  work_order_id: string | null;
  issue_id: string | null;
  runbook_md: string;
  status: OperatorHandoffStatus;
  created_at: string;
  acknowledged_at: string | null;
  completed_at: string | null;
  severity: IssueSeverity;
  deleted_at: string | null;
  app: AgentAppIdentity;
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

export interface AcknowledgeHandoffResponse {
  handoff: OperatorHandoff;
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

export type AuditEvent = ActivityEvent;
export interface AuditPage {
  events: AuditEvent[];
  cursor: { next: string | null; has_more: boolean };
  generated_at?: string;
}

export interface AccountInfo {
  auth_mode: 'access_jwt' | 'read_token';
  actor: string;
  email: string | null;
}
export interface AggregatorSchedule {
  jobname: string;
  schedule: string;
  active: boolean | null;
  last_successful_at: string | null;
  next_eta_at: string | null;
}
export type IntegrationStatus = 'live' | 'demo' | 'manual_safe' | 'planned';
export interface IntegrationRow {
  type: string | null;
  status: IntegrationStatus;
  last_verified_at: string | null;
}
export interface IntegrationsAppBreakdown {
  app_id: string;
  app_short_code: string;
  app_display_name: string;
  integrations: IntegrationRow[];
}
export interface IntegrationsInventory {
  totals: Record<IntegrationStatus, number>;
  by_app: IntegrationsAppBreakdown[];
}
export interface SecretInventory {
  ref_name: string;
  is_set: boolean;
  app_short_code: string | null;
  column: 'service_secret_ref' | 'readonly_secret_ref' | 'api_key_ref' | 'webhook_secret_ref' | 'vault';
}
export interface ExtractionThresholdMetrics {
  window_start: string | null;
  window_end: string | null;
  auto_commits_14d: number;
  reverts_14d: number;
  revert_rate_14d: number;
  current_threshold: number;
  auto_tighten: 'disabled' | 'enabled';
}

export interface SettingsPayload {
  account: AccountInfo;
  aggregator: AggregatorSchedule;
  integrations: IntegrationsInventory;
  secrets: SecretInventory[];
  audit_preview: AuditEvent[];
  extraction_metrics?: ExtractionThresholdMetrics;
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
  'app_updated',
  'decision_answered',
  'issue_resolved',
  'decision_rewrite_ready',
  'decision_routed',
  'decision_answered_by_recipient',
  'decision_email_bounced',
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
    auto_route_decisions: true,
    onboarding_steps: {
      gmail_test_users_added: { done: true, at: isoAgo(180), by: 'demo' },
      client_emits_owner_kind: { done: true, at: isoAgo(120), by: 'demo' },
    },
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
    auto_route_decisions: true,
    onboarding_steps: {
      gmail_test_users_added: { done: false, at: isoAgo(90), by: 'demo' },
      client_emits_owner_kind: { done: false, at: isoAgo(60), by: 'demo' },
    },
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
  decision_recipients: [
    { id: 'demo-rylee', app_id: 'qep', contact_name: 'Rylee', contact_email: 'rylee@qep.com', contact_role: 'primary', active: true },
    { id: 'demo-ryan', app_id: 'qep', contact_name: 'Ryan McKenzie', contact_email: 'ryan@qep.com', contact_role: 'primary', active: true },
  ],
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

export const DEMO_HANDOFFS: OperatorHandoff[] = [
  {
    id: 'demo-handoff-qep-1',
    app_id: 'qep',
    kind: 'manual_step',
    work_order_id: 'demo-wo-qep-gated-1',
    issue_id: 'demo-qep-open-decisions',
    runbook_md: '## Manual approval checklist\n\n- Open the QEP manager-routing policy.\n- Confirm the threshold matches the client answer.\n- **Do not merge** until the linked PR checks are green.\n\n`route_to_manager` is the selected answer.',
    status: 'open',
    created_at: isoAgo(12),
    acknowledged_at: null,
    completed_at: null,
    severity: 'high',
    deleted_at: null,
    app: { id: 'qep', short_code: 'QEP', display_name: 'QEP OS' },
  },
];

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
  { occurred_at: isoAgo(80),  actor: 'read-token:demo', event_type: 'settings_page_read', detail: { auth_mode: 'read_token' } },
];

export const DEMO_SETTINGS: SettingsPayload = {
  generated_at: new Date().toISOString(),
  account: {
    auth_mode: 'read_token',
    actor: 'read-token:demo',
    email: null,
  },
  aggregator: {
    jobname: 'cc-aggregator-5min',
    schedule: '*/5 * * * *',
    active: true,
    last_successful_at: isoAgo(2),
    next_eta_at: isoAgo(-3),
  },
  integrations: {
    totals: { live: 3, demo: 1, manual_safe: 2, planned: 8 },
    by_app: DEMO_APPS.map((app, index) => ({
      app_id: app.id,
      app_short_code: app.short_code,
      app_display_name: app.display_name,
      integrations: [
        { type: index === 0 ? 'linear' : 'github', status: index === 0 ? 'live' : 'planned', last_verified_at: index === 0 ? isoAgo(8) : null },
        { type: index === 0 ? 'm365' : 'supabase', status: index === 1 ? 'demo' : index === 2 ? 'manual_safe' : 'planned', last_verified_at: index === 1 ? isoAgo(90) : null },
      ] as IntegrationRow[],
    })),
  },
  secrets: [
    { ref_name: 'aggregator_token', is_set: true, app_short_code: null, column: 'vault' },
    { ref_name: 'SVC_KEY_QEP', is_set: false, app_short_code: 'QEP', column: 'service_secret_ref' },
    { ref_name: 'READ_KEY_QEP', is_set: true, app_short_code: 'QEP', column: 'readonly_secret_ref' },
    { ref_name: 'LINEAR_API_KEY_QEP', is_set: true, app_short_code: 'QEP', column: 'api_key_ref' },
    { ref_name: 'LINEAR_WEBHOOK_QEP', is_set: false, app_short_code: 'QEP', column: 'webhook_secret_ref' },
    { ref_name: 'READ_KEY_SCC', is_set: false, app_short_code: 'SCC', column: 'readonly_secret_ref' },
  ],
  audit_preview: DEMO_ACTIVITY.slice(0, 10),
};

/* ───────────────────── Data loaders ─────────────────────────────────────── */

type EdgeErrorBody = { error?: unknown; detail?: unknown };

const APP_STATUSES = new Set<AppStatus>(['provisioning', 'active', 'paused', 'archived']);
const LIFECYCLE_PHASES = new Set<LifecyclePhase>(['discovery', 'build', 'launched', 'maintenance']);
const BUILD_STATUSES = new Set<BuildStatus>(['green', 'yellow', 'red', 'unknown']);
const RISK_CLASSES = new Set<RiskClass>(['auto', 'authorize', 'destructive', 'production']);
const WORK_ORDER_STATUSES = new Set<WorkOrderStatus>(['queued', 'gated', 'claimed', 'dispatched', 'building', 'pr_open', 'done', 'failed', 'dead_lettered', 'cancelled']);
const AGENT_RUN_STATUSES = new Set<AgentRunStatus>(['running', 'succeeded', 'failed', 'timed_out', 'cancelled']);
const OPERATOR_HANDOFF_KINDS = new Set<OperatorHandoffKind>(['manual_step', 'compose_by_hand', 'credential_rotation']);
const OPERATOR_HANDOFF_STATUSES = new Set<OperatorHandoffStatus>(['open', 'acknowledged', 'done']);

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

function writeHeaders(): Record<string, string> {
  const writeToken = (import.meta as any).env?.VITE_CC_WRITE_TOKEN ?? '';
  return { ...readHeaders(), 'x-cc-write-token': writeToken };
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
    headers: { ...writeHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw cleanError(path, res.status, payload);
  return payload;
}

async function publicPostJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${FUNCTIONS_URL}/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw cleanError(path, res.status, payload);
  return payload;
}

async function publicFetchJson(path: string, params?: URLSearchParams): Promise<unknown> {
  const qs = params?.toString();
  const res = await fetch(`${FUNCTIONS_URL}/${path}${qs ? `?${qs}` : ''}`, { credentials: 'include' });
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

function parseOnboardingSteps(value: unknown): Record<string, OnboardingStepState> {
  if (!isRecord(value)) return {};
  const out: Record<string, OnboardingStepState> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    out[key] = {
      done: raw.done === true,
      at: asString(raw.at) ?? undefined,
      by: asString(raw.by) ?? undefined,
    };
  }
  return out;
}

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
    auto_route_decisions: value.auto_route_decisions === true,
    onboarding_steps: parseOnboardingSteps(value.onboarding_steps),
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
  return parseAuditPage(value).events;
}

function parseAuditPage(value: unknown): AuditPage {
  if (!isRecord(value) || !Array.isArray(value.events) || !asString(value.generated_at)) {
    throw new Error('cc-read-audit payload is invalid');
  }
  const cursor = asRecord(value.cursor);
  return {
    events: value.events.map(parseActivityEvent),
    cursor: {
      next: asString(cursor.next),
      has_more: cursor.has_more === true,
    },
    generated_at: asString(value.generated_at) ?? undefined,
  };
}

function parseIntegrationStatus(value: unknown): IntegrationStatus {
  const raw = asString(value);
  if (raw === 'live' || raw === 'demo' || raw === 'manual_safe' || raw === 'planned') return raw;
  return 'planned';
}

function parseIntegrationsInventory(value: unknown): IntegrationsInventory {
  const rec = asRecord(value);
  const totals = asRecord(rec.totals);
  return {
    totals: {
      live: asNumber(totals.live) ?? 0,
      demo: asNumber(totals.demo) ?? 0,
      manual_safe: asNumber(totals.manual_safe) ?? 0,
      planned: asNumber(totals.planned) ?? 0,
    },
    by_app: Array.isArray(rec.by_app) ? rec.by_app.map((item) => {
      const app = asRecord(item);
      return {
        app_id: asString(app.app_id) ?? '',
        app_short_code: asString(app.app_short_code) ?? '',
        app_display_name: asString(app.app_display_name) ?? '',
        integrations: Array.isArray(app.integrations) ? app.integrations.map((row) => {
          const integration = asRecord(row);
          return {
            type: asString(integration.type),
            status: parseIntegrationStatus(integration.status),
            last_verified_at: asString(integration.last_verified_at),
          };
        }) : [],
      };
    }) : [],
  };
}

function parseSecretInventory(value: unknown): SecretInventory {
  const rec = asRecord(value);
  const column = asString(rec.column);
  return {
    ref_name: asString(rec.ref_name) ?? '',
    is_set: rec.is_set === true,
    app_short_code: asString(rec.app_short_code),
    column: column === 'service_secret_ref' || column === 'readonly_secret_ref' || column === 'api_key_ref' || column === 'webhook_secret_ref' || column === 'vault' ? column : 'vault',
  };
}

function parseSettingsPayload(value: unknown): SettingsPayload {
  if (!isRecord(value) || !isRecord(value.account) || !isRecord(value.aggregator) || !isRecord(value.integrations) || !Array.isArray(value.secrets)) {
    throw new Error('cc-read-settings payload is invalid');
  }
  const account = asRecord(value.account);
  const aggregator = asRecord(value.aggregator);
  const mode = asString(account.auth_mode);
  return {
    account: {
      auth_mode: mode === 'access_jwt' ? 'access_jwt' : 'read_token',
      actor: asString(account.actor) ?? 'unknown',
      email: asString(account.email),
    },
    aggregator: {
      jobname: asString(aggregator.jobname) ?? 'cc-aggregator-5min',
      schedule: asString(aggregator.schedule) ?? '*/5 * * * *',
      active: typeof aggregator.active === 'boolean' ? aggregator.active : null,
      last_successful_at: asString(aggregator.last_successful_at),
      next_eta_at: asString(aggregator.next_eta_at),
    },
    integrations: parseIntegrationsInventory(value.integrations),
    secrets: value.secrets.map(parseSecretInventory).filter((secret) => secret.ref_name),
    audit_preview: Array.isArray(value.audit_preview) ? value.audit_preview.map(parseActivityEvent) : [],
    extraction_metrics: isRecord(value.extraction_metrics) ? {
      window_start: asString(value.extraction_metrics.window_start),
      window_end: asString(value.extraction_metrics.window_end),
      auto_commits_14d: asNumber(value.extraction_metrics.auto_commits_14d) ?? 0,
      reverts_14d: asNumber(value.extraction_metrics.reverts_14d) ?? 0,
      revert_rate_14d: asNumber(value.extraction_metrics.revert_rate_14d) ?? 0,
      current_threshold: asNumber(value.extraction_metrics.current_threshold) ?? 1.01,
      auto_tighten: asString(value.extraction_metrics.auto_tighten) === 'enabled' ? 'enabled' : 'disabled',
    } : undefined,
    generated_at: asString(value.generated_at) ?? undefined,
  };
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

function parseOperatorHandoffKind(value: unknown): OperatorHandoffKind {
  const raw = asString(value);
  if (!OPERATOR_HANDOFF_KINDS.has(raw as OperatorHandoffKind)) throw new Error(`cc-read-handoffs row has invalid kind: ${raw}`);
  return raw as OperatorHandoffKind;
}

function parseOperatorHandoffStatus(value: unknown): OperatorHandoffStatus {
  const raw = asString(value);
  if (!OPERATOR_HANDOFF_STATUSES.has(raw as OperatorHandoffStatus)) throw new Error(`cc-read-handoffs row has invalid status: ${raw}`);
  return raw as OperatorHandoffStatus;
}

function parseIssueSeverity(value: unknown): IssueSeverity {
  const raw = asString(value);
  if (!ISSUE_SEVERITIES.has(raw as IssueSeverity)) throw new Error(`cc-read-handoffs row has invalid severity: ${raw}`);
  return raw as IssueSeverity;
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

function parseOperatorHandoff(value: unknown): OperatorHandoff {
  if (!isRecord(value)) throw new Error('cc-read-handoffs payload contains an invalid handoff row');
  const id = asString(value.id);
  const appId = asString(value.app_id);
  const runbookMd = asString(value.runbook_md);
  const createdAt = asString(value.created_at);
  if (!id || !appId || !runbookMd || !createdAt) throw new Error('cc-read-handoffs row is missing required fields');
  return {
    id,
    app_id: appId,
    kind: parseOperatorHandoffKind(value.kind),
    work_order_id: asString(value.work_order_id),
    issue_id: asString(value.issue_id),
    runbook_md: runbookMd,
    status: parseOperatorHandoffStatus(value.status),
    created_at: createdAt,
    acknowledged_at: asString(value.acknowledged_at),
    completed_at: asString(value.completed_at),
    severity: parseIssueSeverity(value.severity),
    deleted_at: asString(value.deleted_at),
    app: parseAgentAppIdentity(value.app),
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

function parseHandoffsResponse(value: unknown): OperatorHandoff[] {
  if (!isRecord(value) || !Array.isArray(value.handoffs)) {
    throw new Error('cc-read-handoffs payload is invalid');
  }
  return value.handoffs.map(parseOperatorHandoff);
}

function parseAcknowledgeHandoffResponse(value: unknown): AcknowledgeHandoffResponse {
  if (!isRecord(value) || !isRecord(value.handoff)) {
    throw new Error('cc-acknowledge-handoff payload is invalid');
  }
  return { handoff: parseOperatorHandoff(value.handoff) };
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

export async function loadAuditPage(demo: boolean, cursor?: string | null, filters: { app_id?: string; event_type?: string; since_date?: string } = {}): Promise<AuditPage> {
  if (demo) {
    const hidden = new Set(['detail_read', 'agents_page_read', 'decisions_page_read', 'settings_page_read', 'secret_read']);
    const events = structuredClone(DEMO_ACTIVITY).filter((ev) => !hidden.has(ev.event_type));
    return { events, cursor: { next: null, has_more: false }, generated_at: new Date().toISOString() };
  }
  const params = new URLSearchParams();
  params.set('lately_only', 'false');
  params.set('limit', '20');
  if (cursor) params.set('cursor', cursor);
  if (filters.app_id) params.set('app_id', filters.app_id);
  if (filters.event_type) params.set('event_type', filters.event_type);
  if (filters.since_date) params.set('since_date', filters.since_date);
  params.set('hide_operator_noise', 'true');
  return parseAuditPage(await fetchJson('cc-read-audit', params));
}

/* SOURCE 3 — cc-read-agents (Agents nav page queue/run/cost read surface). */
export async function loadAgents(demo: boolean): Promise<AgentsPayload> {
  if (demo) return structuredClone(DEMO_AGENTS);
  return parseAgentsResponse(await fetchJson('cc-read-agents'));
}

export async function loadHandoffs(demo: boolean, appId?: string): Promise<OperatorHandoff[]> {
  if (demo) {
    const rows = structuredClone(DEMO_HANDOFFS).filter((row) => row.status === 'open');
    return appId ? rows.filter((row) => row.app_id === appId) : rows;
  }
  const params = new URLSearchParams();
  if (appId) params.set('app_id', appId);
  return parseHandoffsResponse(await fetchJson('cc-read-handoffs', params));
}

/* SOURCE 4 — cc-read-settings (Settings nav page five-band envelope). */
export async function loadSettings(demo: boolean): Promise<SettingsPayload> {
  if (demo) return structuredClone(DEMO_SETTINGS);
  return parseSettingsPayload(await fetchJson('cc-read-settings'));
}

/* SOURCE 5 — cc-read-app (registry/config drilldown placeholder). */
export async function loadAppDetail(appId: string): Promise<unknown> {
  const params = new URLSearchParams();
  params.set('app_id', appId);
  return fetchJson('cc-read-app', params);
}

export async function loadDecisionRecipients(appId: string, demo = false): Promise<DecisionRecipient[]> {
  if (demo) return structuredClone(DEMO_APP_DETAIL.decision_recipients ?? []).map((row) => ({ ...row, app_id: appId }));
  return parseAppDetailPayload(await loadAppDetail(appId)).decision_recipients ?? [];
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

function parseDecisionRecipient(value: unknown): DecisionRecipient {
  const rec = asRecord(value);
  return {
    id: asString(rec.id) ?? '',
    app_id: asString(rec.app_id) ?? '',
    contact_name: asString(rec.contact_name) ?? '',
    contact_email: asString(rec.contact_email) ?? '',
    contact_role: asString(rec.contact_role),
    active: rec.active === true,
    created_at: asString(rec.created_at),
    updated_at: asString(rec.updated_at),
  };
}

function parseAppDetailPayload(value: unknown): AppDetailPayload {
  const rec = asRecord(value);
  const data = asRecord(rec.data ?? value);
  const keyClass = asString(rec.key_class);
  const recipients = Array.isArray(rec.decision_recipients) ? rec.decision_recipients : Array.isArray(data.decision_recipients) ? data.decision_recipients : [];
  return {
    available: true,
    roadmap: normalizeDetailSection(data.roadmap),
    decisions: normalizeDetailSection(data.decisions),
    sync: normalizeDetailSection(data.sync),
    decision_recipients: recipients.map(parseDecisionRecipient).filter((row) => row.id && row.contact_email),
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

export async function acknowledgeHandoff(handoffId: string, status: 'acknowledged' | 'done', note?: string, demo = false): Promise<AcknowledgeHandoffResponse> {
  if (demo) {
    const now = new Date().toISOString();
    const handoff = DEMO_HANDOFFS.find((row) => row.id === handoffId);
    if (!handoff) throw new Error('demo handoff not found');
    if (status === 'acknowledged' && handoff.status === 'open') {
      handoff.status = 'acknowledged';
      handoff.acknowledged_at = handoff.acknowledged_at ?? now;
    }
    if (status === 'done' && handoff.status !== 'done') {
      handoff.status = 'done';
      handoff.acknowledged_at = handoff.acknowledged_at ?? now;
      handoff.completed_at = handoff.completed_at ?? now;
    }
    void note;
    return { handoff: structuredClone(handoff) };
  }
  return parseAcknowledgeHandoffResponse(await postJson('cc-acknowledge-handoff', { handoff_id: handoffId, status, note }));
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
    case 'app_updated':
      return [`${app}'s registry basics were updated.`, true];
    case 'secret_read':
    case 'detail_read':
    case 'agents_page_read':
    case 'decisions_page_read':
    case 'settings_page_read':
    case 'issue_acknowledged':
    case 'issue_dismissed':
      return ['', false];
    case 'issue_resolved':
      return [`You answered a decision on ${app} — a build can move forward.`, true];
    case 'decision_rewrite_ready':
      return [`A client decision email for ${app} is ready for your review.`, true];
    case 'decision_answered': {
      const who = ev.actor.startsWith('client:') ? firstNameFromActor(ev.actor) : 'You';
      return [`${who} answered a decision on ${app} — a build can move now.`, true];
    }
    case 'decision_routed': {
      const owner = detailString(d, 'owner_name') ?? 'the owner';
      return [`A decision on ${app} was emailed to ${owner} to answer.`, true];
    }
    case 'decision_answered_by_recipient': {
      const owner = detailString(d, 'owner_name') ?? detailString(d, 'owner_email') ?? firstNameFromActor(ev.actor);
      return [`${owner} confirmed a decision on ${app} — a build can move now.`, true];
    }
    case 'decision_email_bounced':
      return [`A decision email for ${app} bounced — send it manually or fix the recipient.`, true];
    case 'decision_reply_received': {
      const owner = detailString(d, 'owner_name') ?? firstNameFromActor(ev.actor);
      return [`${owner} replied to a decision on ${app} — it's waiting for you to confirm their answer.`, true];
    }
    case 'decision_reminder_sent': {
      const owner = detailString(d, 'owner_name') ?? firstNameFromActor(ev.actor);
      return [`You sent a reminder on ${app} — still waiting on ${owner}.`, false];
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
    ev.event_type === 'decision_rewrite_ready' ||
    ev.event_type === 'cost_ceiling_hit' ||
    ev.event_type === 'runner_offline' ||
    ev.event_type === 'handoff_created' ||
    ev.event_type === 'work_order_gated' ||
    (ev.event_type === 'work_order_created' && isAuthorizeWorkOrder(d))
  ) return 'needs';
  if (
    ev.event_type === 'decision_email_bounced' ||
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

// ===== Apps =====
export type EditAppPayload = Partial<Pick<AppRow, 'display_name' | 'app_url' | 'criticality' | 'auto_route_decisions'>>;

export interface RegisterAppPayload {
  short_code: string;
  display_name: string;
  project_ref: string;
  project_url: string;
  service_secret_ref: string;
  github_repo: string;
  readonly_secret_ref?: string | null;
}

function parseAppWriteResponse(value: unknown): AppRow {
  const rec = asRecord(value);
  return parseAppRow(rec.app ?? value);
}

export async function setAutoRoute(appId: string, enabled: boolean, demo = false): Promise<AppRow> {
  if (demo) {
    const app = DEMO_APPS.find((row) => row.id === appId);
    if (!app) throw new Error('demo app not found');
    app.auto_route_decisions = enabled;
    return structuredClone(app);
  }
  const toggleToken = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_CC_AUTO_ROUTE_TOGGLE_TOKEN ?? '';
  const res = await fetch(`${FUNCTIONS_URL}/cc-set-auto-route`, {
    method: 'POST',
    headers: { ...writeHeaders(), 'Content-Type': 'application/json', 'x-cc-auto-route-toggle': toggleToken },
    body: JSON.stringify({ app_id: appId, enabled }),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw cleanError('cc-set-auto-route', res.status, payload);
  const result = asRecord(payload);
  return parseAppRow(result.app);
}

export async function setAppOnboardingStep(appId: string, stepId: OnboardingStepId, done: boolean, demo = false): Promise<{ app_id: string; onboarding_steps: Record<string, OnboardingStepState> }> {
  if (demo) {
    return {
      app_id: appId,
      onboarding_steps: { [stepId]: { done, at: new Date().toISOString(), by: 'demo' } },
    };
  }
  const toggleToken = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_CC_AUTO_ROUTE_TOGGLE_TOKEN ?? '';
  const res = await fetch(`${FUNCTIONS_URL}/cc-set-app-onboarding-step`, {
    method: 'POST',
    headers: { ...writeHeaders(), 'Content-Type': 'application/json', 'x-cc-auto-route-toggle': toggleToken },
    body: JSON.stringify({ app_id: appId, step_id: stepId, done }),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw cleanError('cc-set-app-onboarding-step', res.status, payload);
  const result = asRecord(payload);
  return {
    app_id: asString(result.app_id) ?? appId,
    onboarding_steps: parseOnboardingSteps(result.onboarding_steps),
  };
}

export async function editAppBasics(appId: string, changes: EditAppPayload, demo = false): Promise<AppRow> {
  if (demo) {
    const app = DEMO_APPS.find((row) => row.id === appId);
    if (!app) throw new Error('demo app not found');
    if (changes.display_name !== undefined) app.display_name = changes.display_name;
    if (changes.app_url !== undefined) app.app_url = changes.app_url;
    if (changes.criticality !== undefined) app.criticality = changes.criticality;
    return structuredClone(app);
  }
  return parseAppWriteResponse(await postJson('cc-edit-app', { app_id: appId, changes }));
}

export async function registerApp(payload: RegisterAppPayload, demo = false): Promise<AppRow> {
  if (demo) {
    const shortCode = payload.short_code.trim().toUpperCase();
    if (DEMO_APPS.some((app) => app.short_code.toUpperCase() === shortCode)) throw new Error('demo app short_code already exists');
    const app: AppRow = {
      id: `demo-${shortCode.toLowerCase()}`,
      short_code: shortCode,
      display_name: payload.display_name.trim(),
      client_name: null,
      app_url: null,
      status: 'provisioning',
      lifecycle_phase: 'build',
      criticality: 0,
      last_snapshot_at: null,
      build_status: 'unknown',
      roadmap_counts: {},
      decision_counts: {},
      sync_health: {},
      integrations: {},
      momentum: {},
      sample: true,
    };
    DEMO_APPS.push(app);
    return structuredClone(app);
  }
  return parseAppWriteResponse(await postJson('cc-register-app', payload));
}

// ===== Decisions =====
export type DecisionEmailState = 'queued' | 'rewriting' | 'rewrite_ready' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'replied' | 'extracting' | 'awaiting_clarify' | 'clarify_sent' | 'awaiting_operator_review' | 'rejected_by_operator' | 'answered' | 'done' | 'reminded' | 'bounced' | 'expired' | 'failed';

export interface DecisionExtractionLLM {
  matched_option_id: string | null;
  confidence: number;
  rationale: string | null;
  requires_human: boolean;
  suggested_clarification: string | null;
}

export interface PendingReviewSend extends Record<string, unknown> {
  send_id: string;
  app_id: string;
  app_short_code: string;
  app_display_name: string;
  issue_id: string;
  decision_external_ref: string;
  raw_decision_title: string;
  raw_decision_body: string | null;
  options_snapshot: DecisionOptionLike[];
  recipient_id: string | null;
  recipient_name: string | null;
  recipient_email: string;
  replied_at: string | null;
  raw_reply_text: string;
  llm_extraction: DecisionExtractionLLM | null;
  clarification_attempt_count: number;
  state: DecisionEmailState;
}

export interface DecisionEmailSend extends Record<string, unknown> {
  id: string;
  state: DecisionEmailState;
  app_id: string;
  issue_id: string;
  decision_external_ref: string;
  raw_decision_title: string;
  raw_decision_body: string | null;
  rewritten_subject: string | null;
  rewritten_body: string | null;
  options_snapshot: unknown;
  last_error: string | null;
  recipient_id?: string | null;
  recipient_name?: string | null;
  recipient_email?: string | null;
  replied_at?: string | null;
  raw_reply_text?: string | null;
  llm_extraction?: DecisionExtractionLLM | null;
  operator_confirmed_by?: string | null;
  operator_confirmed_at?: string | null;
  selected_option?: string | null;
  clarification_attempt_count?: number;
  clarification_sent_at?: string | null;
}

export interface RewriteDecisionPayload {
  issue_id: string;
  app_id: string;
  decision_external_ref: string;
  raw_title: string;
  raw_body?: string | null;
  options: DecisionOptionLike[];
  risk_class?: RiskClass;
}

export type DecisionOptionLike = { id: string; label: string };

export interface DecisionRow extends Record<string, unknown> {
  app_id: string;
  app_short_code: string;
  app_display_name: string;
  auto_route_paused?: boolean;
  auto_route_paused_at?: string | null;
  auto_route_paused_by?: string | null;
  auto_route_paused_reason?: string | null;
  snoozed_until?: string | null;
  snoozed_by?: string | null;
  reminded_at?: string | null;
}

export interface DecisionsAppStatus {
  app_id: string;
  app_short_code: string;
  app_display_name: string;
  reason?: string;
  status?: number;
  detail?: string;
}

export interface AnsweredDecisionSummary extends Record<string, unknown> {
  id: string;
  issue_id: string;
  app_id: string;
  app_short_code: string | null;
  app_display_name: string | null;
  decision_external_ref: string | null;
  decision_title: string | null;
  answer_value: string;
  answer_label: string | null;
  answer_options_snapshot: unknown;
  rationale: string | null;
  risk_class: RiskClass;
  answered_by: string;
  answered_at: string;
  dispatched_at: string | null;
  created_via?: 'manual' | 'auto_route';
}

export interface DecisionsPayload {
  apps_reached: DecisionsAppStatus[];
  apps_unreachable: DecisionsAppStatus[];
  apps_unwired: DecisionsAppStatus[];
  decisions: DecisionRow[];
  answered_recent: AnsweredDecisionSummary[];
  pending_reviews?: PendingReviewSend[];
  generated_at?: string;
}

export type DecisionOwnerFilter = 'all' | 'operator' | 'client' | 'unknown';
export type DecisionAgeFilter = 'all' | '0-2' | '3-7' | '8+';
export type DecisionSort = 'oldest' | 'newest';
export type DecisionStateFilter = 'active' | 'paused' | 'all';
export interface DecisionsFilters {
  app_id?: string;
  owner_kind?: DecisionOwnerFilter;
  age?: DecisionAgeFilter;
  sort?: DecisionSort;
  state?: DecisionStateFilter;
}

const DEMO_PENDING_REVIEWS: PendingReviewSend[] = [
  {
    send_id: 'demo-review-1',
    app_id: 'qep',
    app_short_code: 'QEP',
    app_display_name: 'QEP OS',
    issue_id: 'demo-qep-open-decisions',
    decision_external_ref: 'Q10',
    raw_decision_title: 'Rebate stacking rules',
    raw_decision_body: 'When both rebates apply, what should we do?',
    options_snapshot: [{ id: 'stack', label: 'Allow stacking' }, { id: 'pick_one', label: 'Customer picks one' }, { id: 'auto_pick', label: 'Auto-pick best rebate' }],
    recipient_id: 'demo-rylee',
    recipient_name: 'Rylee',
    recipient_email: 'rylee@qep.com',
    replied_at: new Date(Date.now() - 14 * 60_000).toISOString(),
    raw_reply_text: "Let's go with the biggest one; no double dipping.",
    llm_extraction: { matched_option_id: 'pick_one', confidence: 0.91, rationale: 'mentions biggest one + no double-dipping', requires_human: false, suggested_clarification: null },
    clarification_attempt_count: 0,
    state: 'awaiting_operator_review',
  },
  {
    send_id: 'demo-review-2',
    app_id: 'qep',
    app_short_code: 'QEP',
    app_display_name: 'QEP OS',
    issue_id: 'demo-qep-open-decisions',
    decision_external_ref: 'Q11',
    raw_decision_title: 'Portal fallback copy',
    raw_decision_body: 'Which copy variant should ship?',
    options_snapshot: [{ id: 'plain', label: 'Plain language' }, { id: 'oem', label: 'Keep OEM terms' }],
    recipient_id: 'demo-ryan',
    recipient_name: 'Ryan McKenzie',
    recipient_email: 'ryan@qep.com',
    replied_at: new Date(Date.now() - 26 * 60_000).toISOString(),
    raw_reply_text: 'Not sure — either could work. What do you recommend?',
    llm_extraction: { matched_option_id: null, confidence: 0.42, rationale: 'ambiguous and asks counter-question', requires_human: true, suggested_clarification: 'Should we ship plain language or keep OEM terms?' },
    clarification_attempt_count: 1,
    state: 'awaiting_operator_review',
  },
];

const emptyDecisionsPayload: DecisionsPayload = {
  apps_reached: [],
  apps_unreachable: [],
  apps_unwired: [],
  decisions: [],
  answered_recent: [],
  pending_reviews: [],
};

function parseDecisionsAppStatus(value: unknown): DecisionsAppStatus {
  const rec = asRecord(value);
  return {
    app_id: asString(rec.app_id) ?? '',
    app_short_code: asString(rec.app_short_code) ?? '',
    app_display_name: asString(rec.app_display_name) ?? '',
    reason: asString(rec.reason) ?? undefined,
    status: asNumber(rec.status) ?? undefined,
    detail: asString(rec.detail) ?? undefined,
  };
}

function parseDecisionRow(value: unknown): DecisionRow {
  if (!isRecord(value)) throw new Error('cc-read-decisions payload contains an invalid decision row');
  const appId = asString(value.app_id);
  const appShortCode = asString(value.app_short_code);
  const appDisplayName = asString(value.app_display_name);
  if (!appId || !appShortCode || !appDisplayName) throw new Error('cc-read-decisions decision row is missing app tags');
  return {
    ...value,
    app_id: appId,
    app_short_code: appShortCode,
    app_display_name: appDisplayName,
    auto_route_paused: value.auto_route_paused === true,
    auto_route_paused_at: asString(value.auto_route_paused_at),
    auto_route_paused_by: asString(value.auto_route_paused_by),
    auto_route_paused_reason: asString(value.auto_route_paused_reason),
    snoozed_until: asString(value.snoozed_until),
    snoozed_by: asString(value.snoozed_by),
    reminded_at: asString(value.reminded_at),
  };
}

function parseAnsweredDecisionSummary(value: unknown): AnsweredDecisionSummary {
  if (!isRecord(value)) throw new Error('cc-read-decisions payload contains an invalid answered decision row');
  const id = asString(value.id);
  const issueId = asString(value.issue_id);
  const appId = asString(value.app_id);
  const answerValue = asString(value.answer_value);
  const riskClass = RISK_CLASSES.has(asString(value.risk_class) as RiskClass) ? asString(value.risk_class) as RiskClass : 'authorize';
  const answeredBy = asString(value.answered_by);
  const answeredAt = asString(value.answered_at);
  if (!id || !issueId || !appId || !answerValue || !answeredBy || !answeredAt) {
    throw new Error('cc-read-decisions answered row is missing required fields');
  }
  return {
    ...value,
    id,
    issue_id: issueId,
    app_id: appId,
    app_short_code: asString(value.app_short_code),
    app_display_name: asString(value.app_display_name),
    decision_external_ref: asString(value.decision_external_ref),
    decision_title: asString(value.decision_title),
    answer_value: answerValue,
    answer_label: asString(value.answer_label),
    answer_options_snapshot: value.answer_options_snapshot,
    rationale: asString(value.rationale),
    risk_class: riskClass,
    answered_by: answeredBy,
    answered_at: answeredAt,
    dispatched_at: asString(value.dispatched_at),
    created_via: asString(value.created_via) === 'auto_route' ? 'auto_route' : 'manual',
  };
}

function parseDecisionExtractionLLM(value: unknown): DecisionExtractionLLM | null {
  const rec = asRecord(value);
  if (!Object.keys(rec).length) return null;
  return {
    matched_option_id: asString(rec.matched_option_id),
    confidence: asNumber(rec.confidence) ?? 0,
    rationale: asString(rec.rationale),
    requires_human: rec.requires_human === true,
    suggested_clarification: asString(rec.suggested_clarification) ?? asString(rec.proposed_clarifying_question),
  };
}

function parsePendingReviewSend(value: unknown): PendingReviewSend {
  const rec = asRecord(value);
  return {
    ...rec,
    send_id: asString(rec.send_id) ?? '',
    app_id: asString(rec.app_id) ?? '',
    app_short_code: asString(rec.app_short_code) ?? '',
    app_display_name: asString(rec.app_display_name) ?? '',
    issue_id: asString(rec.issue_id) ?? '',
    decision_external_ref: asString(rec.decision_external_ref) ?? '',
    raw_decision_title: asString(rec.raw_decision_title) ?? '',
    raw_decision_body: asString(rec.raw_decision_body),
    options_snapshot: Array.isArray(rec.options_snapshot) ? rec.options_snapshot.map(optionFromUnknown).filter((v): v is DecisionOptionLike => !!v) : [],
    recipient_id: asString(rec.recipient_id),
    recipient_name: asString(rec.recipient_name),
    recipient_email: asString(rec.recipient_email) ?? '',
    replied_at: asString(rec.replied_at),
    raw_reply_text: asString(rec.raw_reply_text) ?? '',
    llm_extraction: parseDecisionExtractionLLM(rec.llm_extraction),
    clarification_attempt_count: asNumber(rec.clarification_attempt_count) ?? 0,
    state: asString(rec.state) as DecisionEmailState,
  };
}

function parseDecisionsPayload(value: unknown): DecisionsPayload {
  if (!isRecord(value) || !Array.isArray(value.decisions) || !Array.isArray(value.answered_recent)) {
    throw new Error('cc-read-decisions payload is invalid');
  }
  return {
    apps_reached: Array.isArray(value.apps_reached) ? value.apps_reached.map(parseDecisionsAppStatus) : [],
    apps_unreachable: Array.isArray(value.apps_unreachable) ? value.apps_unreachable.map(parseDecisionsAppStatus) : [],
    apps_unwired: Array.isArray(value.apps_unwired) ? value.apps_unwired.map(parseDecisionsAppStatus) : [],
    decisions: value.decisions.map(parseDecisionRow),
    answered_recent: value.answered_recent.map(parseAnsweredDecisionSummary),
    pending_reviews: Array.isArray(value.pending_reviews) ? value.pending_reviews.map(parsePendingReviewSend) : [],
    generated_at: asString(value.generated_at) ?? undefined,
  };
}

function decisionOwnerKind(row: Record<string, unknown>): 'operator' | 'client' | 'unknown' {
  const values = ['owner_type', 'owner_kind', 'answer_owner', 'owned_by', 'decision_owner']
    .map((key) => asString(row[key])?.toLowerCase())
    .filter(Boolean) as string[];
  if (values.some((value) => value === 'operator' || value === 'blackrock' || value === 'blackrock_ai')) return 'operator';
  if (values.some((value) => value === 'client' || value === 'customer')) return 'client';
  const owner = asString(row.owner)?.toLowerCase() ?? asString(row.assignee)?.toLowerCase() ?? '';
  if (['brian', 'operator', 'blackrock ai', 'blackrock'].includes(owner)) return 'operator';
  if (owner) return 'client';
  return 'unknown';
}

export function decisionAgeDays(row: Record<string, unknown>): number | null {
  const direct = asNumber(row.age_days);
  if (direct != null) return direct;
  const age = asString(row.age)?.trim().toLowerCase();
  if (age) {
    const m = age.match(/^(\d+(?:\.\d+)?)\s*([mhdw])(?:in|ours?|ays?|eeks?)?$/);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2];
      if (unit === 'm') return n / 1440;
      if (unit === 'h') return n / 24;
      if (unit === 'd') return n;
      if (unit === 'w') return n * 7;
    }
  }
  for (const key of ['opened_at', 'created_at', 'surfaced_at', 'last_seen_at', 'updated_at']) {
    const raw = asString(row[key]);
    if (!raw) continue;
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return Math.max(0, (Date.now() - t) / 86_400_000);
  }
  return null;
}

function decisionIssueId(row: Record<string, unknown>): string | null {
  return asString(row.issue_id) ?? asString(row.cc_issue_id) ?? asString(row.control_plane_issue_id);
}

function filterDecisionRows(rows: DecisionRow[], filters: DecisionsFilters): DecisionRow[] {
  return rows.filter((row) => {
    if (filters.app_id && row.app_id !== filters.app_id) return false;
    if (filters.owner_kind && filters.owner_kind !== 'all' && decisionOwnerKind(row) !== filters.owner_kind) return false;
    const isPaused = row.auto_route_paused === true;
    const isSnoozed = !!row.snoozed_until && new Date(row.snoozed_until).getTime() > Date.now();
    if ((filters.state ?? 'active') === 'active' && (isPaused || isSnoozed)) return false;
    if ((filters.state ?? 'active') === 'paused' && !isPaused) return false;
    const age = decisionAgeDays(row);
    if (filters.age === '0-2' && (age == null || age > 2)) return false;
    if (filters.age === '3-7' && (age == null || age < 3 || age > 7)) return false;
    if (filters.age === '8+' && (age == null || age < 8)) return false;
    return true;
  });
}

function sortDecisionRows(rows: DecisionRow[], sort: DecisionSort = 'oldest'): DecisionRow[] {
  return [...rows].sort((a, b) => {
    const ageA = decisionAgeDays(a) ?? 0;
    const ageB = decisionAgeDays(b) ?? 0;
    return sort === 'oldest' ? ageB - ageA : ageA - ageB;
  });
}

function buildDecisionParams(filters: DecisionsFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.app_id) params.set('app_id', filters.app_id);
  if (filters.owner_kind && filters.owner_kind !== 'all') params.set('owner_kind', filters.owner_kind);
  if (filters.age === '0-2') params.set('max_age_days', '2');
  params.set('limit', '300');
  return params;
}

function demoDecisionsPayload(filters: DecisionsFilters): DecisionsPayload {
  const rows = DEMO_APPS.flatMap((app) => DEMO_APP_DETAIL.decisions.items.map((item, index) => {
    const row = structuredClone(item) as Record<string, unknown>;
    const sourceId = asString(row.id) ?? `decision-${index + 1}`;
    return {
      ...row,
      id: `${app.id}-${sourceId}`,
      issue_id: `demo-${app.id}-open-decisions`,
      app_id: app.id,
      app_short_code: app.short_code,
      app_display_name: app.display_name,
    } as DecisionRow;
  }));
  const decisions = sortDecisionRows(filterDecisionRows(rows, filters), filters.sort);
  return {
    ...structuredClone(emptyDecisionsPayload),
    apps_reached: DEMO_APPS.map((app) => ({ app_id: app.id, app_short_code: app.short_code, app_display_name: app.display_name, reason: 'demo' })),
    decisions,
    answered_recent: [],
    pending_reviews: structuredClone(DEMO_PENDING_REVIEWS),
    generated_at: new Date().toISOString(),
  };
}

export async function loadDecisions(filters: DecisionsFilters, demo: boolean): Promise<DecisionsPayload> {
  if (demo) return demoDecisionsPayload(filters);
  const payload = parseDecisionsPayload(await fetchJson('cc-read-decisions', buildDecisionParams(filters)));
  return { ...payload, decisions: sortDecisionRows(filterDecisionRows(payload.decisions, filters), filters.sort) };
}

export async function loadPendingReviews(demo: boolean): Promise<PendingReviewSend[]> {
  const payload = await loadDecisions({}, demo);
  return payload.pending_reviews ?? [];
}

export interface OperatorConfirmExtractionPayload {
  send_id: string;
  option_id: string;
  rationale?: string | null;
}

export interface OperatorRejectExtractionPayload {
  send_id: string;
  reason: string;
}

export interface OperatorClarifyExtractionPayload {
  send_id: string;
  subject: string;
  body: string;
  include_buttons: boolean;
  regenerate_tokens: boolean;
}

export async function confirmExtraction(send_id: string, option_id: string, rationale?: string | null, demo = false): Promise<unknown> {
  if (demo) return { send: { id: send_id, state: 'answered' }, answer: { decision_answer_id: `demo-${send_id}`, issue_id: 'demo' }, work_order: { id: `wo-${send_id}` }, dispatched: true };
  return postJson('cc-operator-confirm-extraction', { send_id, option_id, rationale });
}

export async function setDecisionPause(issue_id: string, paused: boolean, reason?: string | null, demo = false): Promise<unknown> {
  if (demo) return { issue: { id: issue_id, auto_route_paused_at: paused ? new Date().toISOString() : null, auto_route_paused_reason: reason ?? null } };
  return postJson('cc-pause-decision', { issue_id, action: paused ? 'pause' : 'resume', reason: reason ?? null });
}

export async function setDecisionSnooze(issue_id: string, days: 1 | 3 | 7 | null, demo = false): Promise<unknown> {
  if (demo) return { issue: { id: issue_id, snoozed_until: days ? new Date(Date.now() + days * 86400000).toISOString() : null } };
  return postJson('cc-snooze-decision', days ? { issue_id, action: 'snooze', days } : { issue_id, action: 'unsnooze' });
}

export async function rejectExtraction(send_id: string, reason: string, demo = false): Promise<unknown> {
  if (demo) return { send: { id: send_id, state: 'expired', last_error: reason } };
  return postJson('cc-operator-reject-extraction', { send_id, reason });
}

export async function operatorClarifyExtraction(payload: OperatorClarifyExtractionPayload, demo = false): Promise<unknown> {
  if (demo) return { send: { id: payload.send_id, state: 'clarify_sent' } };
  return postJson('cc-operator-clarify-extraction', payload);
}

function parseDecisionEmailSend(value: unknown): DecisionEmailSend {
  const rec = asRecord(value);
  return {
    ...rec,
    id: asString(rec.id) ?? '',
    state: asString(rec.state) as DecisionEmailState,
    app_id: asString(rec.app_id) ?? '',
    issue_id: asString(rec.issue_id) ?? '',
    decision_external_ref: asString(rec.decision_external_ref) ?? '',
    raw_decision_title: asString(rec.raw_decision_title) ?? '',
    raw_decision_body: asString(rec.raw_decision_body),
    rewritten_subject: asString(rec.rewritten_subject),
    rewritten_body: asString(rec.rewritten_body),
    options_snapshot: rec.options_snapshot,
    last_error: asString(rec.last_error),
  };
}

export async function rewriteDecision(payload: RewriteDecisionPayload, demo = false): Promise<DecisionEmailSend> {
  if (demo) return parseDecisionEmailSend({
    id: `demo-send-${Date.now()}`,
    state: 'rewrite_ready',
    app_id: payload.app_id,
    issue_id: payload.issue_id,
    decision_external_ref: payload.decision_external_ref,
    raw_decision_title: payload.raw_title,
    raw_decision_body: payload.raw_body ?? null,
    rewritten_subject: `Quick question about ${payload.decision_external_ref}`,
    rewritten_body: `Hey — quick question before we move this forward.\n\n${payload.raw_title}`,
    options_snapshot: payload.options,
    last_error: null,
  });
  const result = asRecord(await postJson('cc-rewrite-decision', payload));
  return parseDecisionEmailSend(result.send);
}

export async function loadDecisionSend(sendId: string, demo = false): Promise<DecisionEmailSend> {
  if (demo) return parseDecisionEmailSend({ id: sendId, state: 'rewrite_ready', app_id: 'qep', issue_id: 'demo', decision_external_ref: 'demo', raw_decision_title: 'Demo decision', raw_decision_body: null, rewritten_subject: 'Demo subject', rewritten_body: 'Demo body', options_snapshot: [], last_error: null });
  const params = new URLSearchParams();
  params.set('send_id', sendId);
  const result = asRecord(await fetchJson('cc-rewrite-decision', params));
  return parseDecisionEmailSend(result.send);
}

export async function routeDecision(sendId: string, recipientIds: string[], approvedSubject: string, approvedBody: string, approvedOptions: DecisionOptionLike[], demo = false): Promise<unknown> {
  if (demo) return { sent: recipientIds.map((id) => ({ id: `demo-routed-${id}`, state: 'sent' })) };
  return postJson('cc-route-decision', { send_id: sendId, recipient_ids: recipientIds, approved_subject: approvedSubject, approved_body: approvedBody, approved_options: approvedOptions });
}

export async function addDecisionRecipient(appId: string, payload: Pick<DecisionRecipient, 'contact_name' | 'contact_email'> & { contact_role?: string | null }, demo = false): Promise<DecisionRecipient> {
  if (demo) return { id: `demo-recipient-${Date.now()}`, app_id: appId, active: true, contact_role: payload.contact_role ?? null, contact_name: payload.contact_name, contact_email: payload.contact_email };
  const result = asRecord(await postJson('cc-add-recipient', { app_id: appId, ...payload }));
  return parseDecisionRecipient(result.recipient);
}

export async function editDecisionRecipient(recipientId: string, payload: Partial<Pick<DecisionRecipient, 'contact_name' | 'contact_email' | 'contact_role' | 'active'>>, demo = false): Promise<DecisionRecipient> {
  if (demo) return { id: recipientId, app_id: 'demo', active: payload.active ?? true, contact_role: payload.contact_role ?? null, contact_name: payload.contact_name ?? 'Demo', contact_email: payload.contact_email ?? 'demo@example.com' };
  const result = asRecord(await postJson('cc-edit-recipient', { recipient_id: recipientId, ...payload }));
  return parseDecisionRecipient(result.recipient);
}

export async function deleteDecisionRecipient(recipientId: string, demo = false): Promise<void> {
  if (demo) return;
  await postJson('cc-delete-recipient', { recipient_id: recipientId });
}

export interface DecisionConfirmData extends Record<string, unknown> {
  send_id: string;
  selected_option_id: string;
  csrf: string;
  subject: string | null;
  body: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  options: DecisionOptionLike[];
  selected_option: DecisionOptionLike | null;
  expires_at: string;
}

export async function loadDecisionConfirmData(token: string, sendId: string, optionId: string): Promise<DecisionConfirmData> {
  const params = new URLSearchParams({ t: token, s: sendId, o: optionId });
  const rec = asRecord(await publicFetchJson('cc-decision-confirm-data', params));
  return {
    ...rec,
    send_id: asString(rec.send_id) ?? sendId,
    selected_option_id: asString(rec.selected_option_id) ?? optionId,
    csrf: asString(rec.csrf) ?? '',
    subject: asString(rec.subject),
    body: asString(rec.body),
    recipient_name: asString(rec.recipient_name),
    recipient_email: asString(rec.recipient_email),
    options: Array.isArray(rec.options) ? rec.options.map(optionFromUnknown).filter((v): v is DecisionOptionLike => !!v) : [],
    selected_option: optionFromUnknown(rec.selected_option),
    expires_at: asString(rec.expires_at) ?? '',
  };
}

export async function submitDecisionConfirm(token: string, sendId: string, optionId: string, csrf: string): Promise<unknown> {
  return publicPostJson('cc-decision-confirm-submit', { token, send_id: sendId, option_id: optionId, csrf });
}

function optionFromUnknown(value: unknown): DecisionOptionLike | null {
  if (typeof value === 'string' && value.trim()) return { id: value.trim(), label: value.trim() };
  const rec = asRecord(value);
  const id = asString(rec.id) ?? asString(rec.value) ?? asString(rec.key);
  if (!id) return null;
  return { id, label: asString(rec.label) ?? asString(rec.name) ?? asString(rec.title) ?? id };
}

export function decisionRowId(row: Record<string, unknown>): string {
  const appId = asString(row.app_id) ?? 'app';
  const localId = asString(row.id) ?? asString(row.external_ref) ?? asString(row.decision_id) ?? decisionRowTitle(row);
  return `${appId}:${localId}`;
}

export function decisionRowTitle(row: Record<string, unknown>): string {
  return asString(row.title) ?? asString(row.name) ?? asString(row.summary) ?? asString(row.source) ?? 'Untitled decision';
}

export function decisionRowOwnerKind(row: Record<string, unknown>): 'operator' | 'client' | 'unknown' {
  return decisionOwnerKind(row);
}

export function decisionRowIssueId(row: Record<string, unknown>): string | null {
  return decisionIssueId(row);
}
