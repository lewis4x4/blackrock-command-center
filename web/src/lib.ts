/* ============================================================================
   BlackRock AI Command Center — data layer

   WIRE-UP MAP — every backend read the Home performs:
     loadApps()         <- v_command_center_home      view   (strip, Band 1 & 2)
     loadActivity()     <- cc_audit_events            table  (Band 3)
     loadMomentum()     <- registry_app_snapshots     table  (per-card delta)
     loadIntegrations() <- registry_app_integrations  table  (per-card health)
     sb().auth                                               (login gate)

   DEMO mode (VITE_DEMO_MODE) returns sample rows and needs no backend.
   Live mode reads the control plane (gsvhuzpysxaegoecwjmf).
   Every value rendered traces to a column — nothing is invented.
   ============================================================================ */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/* ───────────────────── Types — the v_command_center_home contract ───────── */
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

export type TriageSev = 'critical' | 'needs' | 'watch';
export interface TriageItem {
  sev: TriageSev;
  title: string;
  sub: string;
  act: string;
  app: AppRow;
}

/* ───────────────────── Config + Supabase client ─────────────────────────── */
export const INITIAL_DEMO =
  (import.meta.env.VITE_DEMO_MODE ?? 'true') !== 'false';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';

let _sb: SupabaseClient | null = null;
export function sb(): SupabaseClient {
  if (!_sb) _sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  return _sb;
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
  { occurred_at: isoAgo(8),   short_code: 'QEP', actor: 'aggregator', event_type: 'snapshot_captured', detail: { build_status: 'green' } },
  { occurred_at: isoAgo(4),   short_code: 'SCC', actor: 'aggregator', event_type: 'snapshot_captured', detail: { build_status: 'yellow' } },
  { occurred_at: isoAgo(4),   short_code: 'FND', actor: 'aggregator', event_type: 'snapshot_failed',   detail: { error: "control-plane secret 'SVC_KEY_FND' is not set" } },
  { occurred_at: isoAgo(68),  short_code: 'QEP', actor: 'aggregator', event_type: 'snapshot_captured', detail: { build_status: 'green' } },
  { occurred_at: isoAgo(128), short_code: 'QEP', actor: 'blewis@lewisinsurance.com', event_type: 'app_provisioned', detail: { short_code: 'QEP' } },
  { occurred_at: isoAgo(190), short_code: 'SCC', actor: 'aggregator', event_type: 'snapshot_captured', detail: { build_status: 'yellow' } },
];

/* ───────────────────── Data loaders ─────────────────────────────────────── */

/* SOURCE 1 — v_command_center_home (+ merge integrations & momentum). */
export async function loadApps(demo: boolean): Promise<AppRow[]> {
  if (demo) return structuredClone(DEMO_APPS);
  const { data, error } = await sb().from('v_command_center_home').select('*');
  if (error) throw new Error('v_command_center_home: ' + error.message);
  const [integ, mom] = await Promise.all([loadIntegrations(), loadMomentum()]);
  return (data as Record<string, unknown>[]).map((a) => ({
    ...(a as unknown as AppRow),
    integrations: integ[a.id as string] ?? {},
    momentum: mom[a.id as string] ?? {},
  }));
}

/* SOURCE 2 — cc_audit_events (Band 3 activity feed). */
export async function loadActivity(demo: boolean): Promise<ActivityEvent[]> {
  if (demo) return structuredClone(DEMO_ACTIVITY);
  /* Embed registry_apps so each event carries its app's short_code. */
  const { data, error } = await sb()
    .from('cc_audit_events')
    .select('occurred_at,actor,event_type,detail,app_id,registry_apps(short_code)')
    .order('occurred_at', { ascending: false })
    .limit(20);
  if (error) throw new Error('cc_audit_events: ' + error.message);
  return (data as Record<string, any>[]).map((r) => ({
    occurred_at: r.occurred_at,
    actor: r.actor,
    event_type: r.event_type,
    detail: r.detail,
    app_id: r.app_id,
    short_code: r.registry_apps?.short_code,
  }));
}

/* SOURCE 3 — registry_app_snapshots (per-app shipped delta). */
export async function loadMomentum(): Promise<Record<string, Momentum>> {
  const { data, error } = await sb()
    .from('registry_app_snapshots')
    .select('app_id,captured_at,roadmap_counts')
    .order('captured_at', { ascending: false })
    .limit(200);
  if (error) throw new Error('registry_app_snapshots: ' + error.message);
  const byApp: Record<string, { roadmap_counts: RoadmapCounts }[]> = {};
  for (const r of data as { app_id: string; roadmap_counts: RoadmapCounts }[]) {
    (byApp[r.app_id] ??= []).push(r);
  }
  const out: Record<string, Momentum> = {};
  for (const id of Object.keys(byApp)) {
    const rows = byApp[id];
    const cur = rows[0]?.roadmap_counts?.shipped ?? 0;
    const prev = rows[1]?.roadmap_counts?.shipped ?? cur;
    out[id] = { shipped_delta: cur - prev };
  }
  return out;
}

/* SOURCE 4 — registry_app_integrations (per-app integration health). */
export async function loadIntegrations(): Promise<Record<string, Integrations>> {
  const { data, error } = await sb()
    .from('registry_app_integrations')
    .select('app_id,status');
  if (error) throw new Error('registry_app_integrations: ' + error.message);
  const out: Record<string, Integrations> = {};
  for (const r of data as { app_id: string; status: keyof Integrations }[]) {
    const bucket = (out[r.app_id] ??= { live: 0, demo: 0, manual_safe: 0, planned: 0 });
    if (r.status in bucket) bucket[r.status] = (bucket[r.status] ?? 0) + 1;
  }
  return out;
}

/* ───────────────────── Helpers ──────────────────────────────────────────── */
export function sum(o: unknown): number {
  if (!o || typeof o !== 'object') return 0;
  return Object.values(o as Record<string, unknown>)
    .reduce<number>((a, b) => a + (Number(b) || 0), 0);
}

export function ago(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
export const hoursOld = (s: string | null | undefined): number | null =>
  s ? (Date.now() - new Date(s).getTime()) / 3_600_000 : null;

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

export const SEV_RANK: Record<TriageSev, number> = { critical: 0, needs: 1, watch: 2 };
export const SEV_LABEL: Record<TriageSev, string> = { critical: 'CRITICAL', needs: 'NEEDS YOU', watch: 'WATCH' };

export const APP_COLOR: Record<string, string> = {
  QEP: '#7C6FF0', SCC: '#4F9CF0', COL: '#3DD68C', FND: '#F5A623',
};
export function colorFor(code: string): string {
  return APP_COLOR[code] ?? '#5A6275';
}

export const HEALTH: Record<BuildStatus, { c: string; t: string }> = {
  green: { c: 'var(--green)', t: 'Healthy' },
  yellow: { c: 'var(--amber)', t: 'Attention' },
  red: { c: 'var(--red)', t: 'Failing' },
  unknown: { c: 'var(--grey)', t: 'Unknown' },
};

/* cc_audit_events row -> human-readable [title, meta] */
export function activityLine(ev: ActivityEvent): [string, string] {
  const d: Record<string, unknown> = ev.detail ?? {};
  switch (ev.event_type) {
    case 'snapshot_captured': return ['Snapshot captured', 'build ' + String(d.build_status ?? '?')];
    case 'snapshot_failed':   return ['Snapshot failed', String(d.error ?? 'unknown error')];
    case 'app_provisioned':   return ['Registered as a Command Center app', 'by ' + ev.actor];
    case 'secret_read':       return ['Secret retrieved', 'by ' + ev.actor];
    case 'agent_dispatch':    return ['Agent dispatched', 'by ' + ev.actor];
    default:                  return [ev.event_type, 'by ' + ev.actor];
  }
}
