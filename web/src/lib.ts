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

// The DB-layer whitelist mirrors latelyLine()'s visible cases (§5.9 deck).
// New visible event types must be added in BOTH places; new hidden types only
// need to be omitted from this list. The client-side hide check stays as
// defense-in-depth.
export const LATELY_VISIBLE_EVENT_TYPES: readonly string[] = [
  'snapshot_captured',
  'snapshot_failed',
  'app_provisioned',
  'decision_answered',
  'decision_routed',
  'decision_reply_received',
  'work_order_created',
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
  sev: TriageSev;
  title: string;
  sub: string;
  act: string;
  app: AppRow;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

async function fetchJson(path: string, params?: URLSearchParams): Promise<unknown> {
  const qs = params?.toString();
  const url = `${FUNCTIONS_URL}/${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { method: 'GET', headers: readHeaders() });
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

function parseHomeResponse(value: unknown): AppRow[] {
  if (!isRecord(value) || !Array.isArray(value.apps) || !asString(value.generated_at)) {
    throw new Error('cc-read-home payload is invalid');
  }
  return value.apps.map(parseAppRow);
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

/* SOURCE 1 — cc-read-home (merged app strip/cards payload). */
export async function loadApps(demo: boolean): Promise<AppRow[]> {
  if (demo) return structuredClone(DEMO_APPS);
  return parseHomeResponse(await fetchJson('cc-read-home'));
}

/* SOURCE 2 — cc-read-audit (Band 3 activity feed). */
export async function loadActivity(demo: boolean): Promise<ActivityEvent[]> {
  if (demo) return structuredClone(DEMO_ACTIVITY).filter((ev) => latelyLine(ev)[1]);
  const params = new URLSearchParams();
  params.set('lately_only', 'true');
  params.set('limit', '20');
  return parseAuditResponse(await fetchJson('cc-read-audit', params));
}

/* SOURCE 3 — cc-read-app (future cockpit drilldown placeholder). */
export async function loadAppDetail(appId: string): Promise<unknown> {
  const params = new URLSearchParams();
  params.set('app_id', appId);
  return fetchJson('cc-read-app', params);
}

/* ───────────────────── Helpers ──────────────────────────────────────────── */
export { ago, hoursOld, sum, colorFor, APP_COLOR, HEALTH, SEV_RANK, SEV_LABEL, INITIAL_DEMO } from './utils';

/* ───────────────────── Triage — aggregate signals only ──────────────────── */
/* The control plane holds counts, never individual tasks/decisions, so every
   triage item is a count-level condition — not a fabricated item title.       */
export function deriveTriage(app: AppRow): TriageItem[] {
  const out: Omit<TriageItem, 'app'>[] = [];
  const rc = app.roadmap_counts ?? {};
  const dc = app.decision_counts ?? {};
  const sh = app.sync_health ?? {};
  const old = hoursOld(app.last_snapshot_at);
  if (app.status === 'paused' || app.status === 'archived') return [];

  /* CRITICAL — broken or blind */
  if (app.build_status === 'red')
    out.push({ sev: 'critical', title: `${app.display_name} — build is failing`, sub: 'Build health is red', act: 'Open app' });
  if ((sh.error_count ?? 0) > 0)
    out.push({ sev: 'critical', title: `${app.display_name} — Linear sync has ${sh.error_count} error${sh.error_count! > 1 ? 's' : ''}`, sub: 'Sync failed for tracked work items', act: 'Check sync' });
  if (app.status === 'active' && old != null && old > 3)
    out.push({ sev: 'critical', title: `${app.display_name} — no data in ${Math.round(old)}h`, sub: 'The Aggregator has not received a snapshot', act: 'Open app' });

  /* NEEDS YOU — a build is blocked on a human */
  if ((dc.open ?? 0) > 0)
    out.push({ sev: 'needs', title: `${app.display_name} — ${dc.open} decision${dc.open! > 1 ? 's' : ''} waiting on answers`, sub: `Answering these clears ${rc.pending_decision ?? 0} blocked task${(rc.pending_decision ?? 0) === 1 ? '' : 's'}`, act: 'Open decisions' });
  if (app.build_status === 'yellow')
    out.push({ sev: 'needs', title: `${app.display_name} — build needs a look`, sub: 'Build health is yellow', act: 'View build' });

  /* WATCH — slipping, not yet urgent */
  if ((rc.blocked ?? 0) > 0)
    out.push({ sev: 'watch', title: `${app.display_name} — ${rc.blocked} item${rc.blocked! > 1 ? 's' : ''} blocked`, sub: 'Blocked work items need review', act: 'Review blockers' });
  if ((sh.stale_pending_count ?? 0) > 0)
    out.push({ sev: 'watch', title: `${app.display_name} — ${sh.stale_pending_count} items haven't synced`, sub: 'Roadmap items pending sync to Linear', act: 'Check sync' });

  return out.map((i) => ({ ...i, app }));
}

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
  return d.risk_class === 'authorize' || d.requires_authorization === true || d.status === 'pending_authorization';
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
      return ['', false];
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
    (ev.event_type === 'work_order_created' && isAuthorizeWorkOrder(d))
  ) return 'needs';
  if (
    ev.event_type === 'snapshot_failed' ||
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
