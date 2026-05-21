#!/usr/bin/env node
// ============================================================================
// aggregator-once.mjs — one-shot snapshot reader for a Command Center app.
//
// This is the seed of the Aggregator (Phase 1, step 9). It polls ONE client
// app's data plane and prints the snapshot JSON to stdout. The full Aggregator
// edge function will loop this over every registered app on a cron and write
// the result into registry_app_snapshots.
//
// It reads the standard contract function public.cc_export_snapshot(). If that
// function is not deployed yet, it falls back to reading the three source
// objects directly (qep_roadmap_tasks, qep_decisions, v_qep_roadmap_sync_health)
// and computes the identical shape locally — so "first light" never blocks on a
// migration.
//
// Usage:
//   node --env-file=<app>/.env scripts/aggregator-once.mjs
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  process.exit(1);
}

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function rest(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`REST ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function tryRpc() {
  const res = await fetch(`${URL}/rest/v1/rpc/cc_export_snapshot`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  if (res.status === 404) return null;            // contract function not deployed yet
  if (!res.ok) throw new Error(`rpc cc_export_snapshot -> ${res.status} ${await res.text()}`);
  return res.json();
}

function tally(rows, field) {
  return rows.reduce((acc, r) => {
    const k = r[field] ?? 'null';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

async function fallback() {
  const [roadmap, decisions, healthRows] = await Promise.all([
    rest('qep_roadmap_tasks?select=ship_state'),
    rest('qep_decisions?select=status'),
    rest('v_qep_roadmap_sync_health?select=*'),
  ]);
  const health = healthRows[0] || {};
  const errorCount = Number(health.error_count || 0);
  const stalePending = Number(health.stale_pending_count || 0);
  return {
    contract_version: 1,
    captured_at: new Date().toISOString(),
    roadmap_total: roadmap.length,
    roadmap_counts: tally(roadmap, 'ship_state'),
    decision_total: decisions.length,
    decision_counts: tally(decisions, 'status'),
    sync_health: health,
    build_status: errorCount > 0 ? 'red' : stalePending > 0 ? 'yellow' : 'green',
    _source: 'fallback_direct_read',
  };
}

const snapshot = (await tryRpc()) ?? (await fallback());
if (!snapshot._source) snapshot._source = 'cc_export_snapshot_rpc';
console.log(JSON.stringify(snapshot, null, 2));
