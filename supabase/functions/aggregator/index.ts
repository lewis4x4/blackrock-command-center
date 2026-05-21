// ============================================================================
// BlackRock AI Command Center — Aggregator edge function
//
// Polls every ACTIVE registered app's cc_export_snapshot() contract and writes
// one registry_app_snapshots row per app, plus a cc_audit_events entry, then
// reconciles the snapshot into the cc_issues ledger via cc_reconcile_app_issues().
//
// Federated by design:
//   - The control plane never cross-joins client databases. It POLLS.
//   - Each app's read-only key is resolved at runtime by NAME: the registry
//     row registry_app_supabase.readonly_secret_ref holds the *name* of a
//     control-plane edge-function secret (convention: READ_KEY_<SHORTCODE>).
//     During cutover, service_secret_ref / SVC_KEY_<SHORTCODE> remains a
//     fallback only. The raw key is never stored in a registry row.
//
// Auth: custom shared-secret header. The function is deployed verify_jwt=false
// and instead checks X-Aggregator-Token against the AGGREGATOR_TOKEN secret.
// The pg_cron job supplies that header from Supabase Vault.
//
// Zero-blocking: one app failing (missing secret, contract error, app down)
// never aborts the run or the other apps. The failure is recorded to
// cc_audit_events; the app keeps its last good snapshot so the home view shows
// staleness via last_snapshot_at rather than flapping to 'unknown'. A reconcile
// failure is likewise logged and never discards a captured snapshot.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CP_URL = Deno.env.get("SUPABASE_URL")!;
const CP_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRIGGER_TOKEN = Deno.env.get("AGGREGATOR_TOKEN") ?? "";

const cpHeaders = {
  apikey: CP_KEY,
  Authorization: `Bearer ${CP_KEY}`,
  "Content-Type": "application/json",
};

async function cpGet(path: string): Promise<any[]> {
  const r = await fetch(`${CP_URL}/rest/v1/${path}`, { headers: cpHeaders });
  if (!r.ok) throw new Error(`control-plane GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function cpInsert(table: string, row: unknown): Promise<void> {
  const r = await fetch(`${CP_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...cpHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`control-plane INSERT ${table} -> ${r.status} ${await r.text()}`);
}

// Call a control-plane Postgres function via PostgREST /rpc and return its JSON.
async function cpRpc(fn: string, args: unknown): Promise<unknown> {
  const r = await fetch(`${CP_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: cpHeaders,
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`control-plane RPC ${fn} -> ${r.status} ${await r.text()}`);
  return r.json();
}

type DataPlaneKeyClass = "readonly" | "service_role";

type DataPlaneKey = {
  key: string;
  keyClass: DataPlaneKeyClass;
  secretName: string;
};

type PollResult = {
  snapshot: any;
  keyClass: DataPlaneKeyClass;
  secretName: string;
  fallbackFrom: { key_class: DataPlaneKeyClass; error: string } | null;
};

function normalizeSecretRef(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveDataPlaneKeys(dp: any): DataPlaneKey[] {
  const readonlySecretName = normalizeSecretRef(dp.readonly_secret_ref);
  const serviceSecretName = normalizeSecretRef(dp.service_secret_ref);
  const keys: DataPlaneKey[] = [];

  for (const candidate of [
    { secretName: readonlySecretName, keyClass: "readonly" as const },
    { secretName: serviceSecretName, keyClass: "service_role" as const },
  ]) {
    if (!candidate.secretName) continue;
    const key = Deno.env.get(candidate.secretName);
    if (key) keys.push({ key, keyClass: candidate.keyClass, secretName: candidate.secretName });
  }

  if (keys.length > 0) return keys;

  if (!readonlySecretName && !serviceSecretName) {
    throw new Error("registry_app_supabase.readonly_secret_ref and service_secret_ref are empty");
  }

  const missing = [readonlySecretName, serviceSecretName].filter(Boolean).join("' or '");
  throw new Error(`control-plane secret '${missing}' is not set`);
}

async function callSnapshot(dp: any, credential: DataPlaneKey): Promise<any> {
  const r = await fetch(`${dp.project_url}/rest/v1/rpc/cc_export_snapshot`, {
    method: "POST",
    headers: { apikey: credential.key, Authorization: `Bearer ${credential.key}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`cc_export_snapshot RPC (${credential.keyClass}) -> ${r.status} ${await r.text()}`);
  return r.json();
}

// Poll one app's cc_export_snapshot() contract via PostgREST RPC.
async function pollApp(app: any): Promise<PollResult> {
  const dp = app.registry_app_supabase;
  if (!dp || !dp.project_url) throw new Error("no data-plane (registry_app_supabase) record");

  let fallbackFrom: PollResult["fallbackFrom"] = null;
  let lastError: string | null = null;

  for (const credential of resolveDataPlaneKeys(dp)) {
    try {
      const snapshot = await callSnapshot(dp, credential);
      return { snapshot, keyClass: credential.keyClass, secretName: credential.secretName, fallbackFrom };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (!fallbackFrom) fallbackFrom = { key_class: credential.keyClass, error: lastError };
    }
  }

  throw new Error(lastError ?? "cc_export_snapshot RPC failed");
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Custom auth — constant-ish shared-secret check.
  const presented = req.headers.get("x-aggregator-token") ?? "";
  if (!TRIGGER_TOKEN || presented !== TRIGGER_TOKEN) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const startedAt = new Date().toISOString();

  let apps: any[];
  try {
    apps = await cpGet(
      "registry_apps?select=id,short_code,display_name,registry_app_supabase(project_url,project_ref,readonly_secret_ref,service_secret_ref,snapshot_contract_version)&status=eq.active&deleted_at=is.null",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: `registry read failed: ${msg}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const results: any[] = [];

  for (const app of apps) {
    try {
      const { snapshot: snap, keyClass, secretName, fallbackFrom } = await pollApp(app);

      await cpInsert("registry_app_snapshots", {
        app_id: app.id,
        captured_at: snap.captured_at ?? new Date().toISOString(),
        roadmap_counts: snap.roadmap_counts ?? {},
        decision_counts: snap.decision_counts ?? {},
        sync_health: snap.sync_health ?? {},
        build_status: snap.build_status ?? "unknown",
        aggregator_note: `Aggregator poll. contract_version ${snap.contract_version ?? "?"}. key_class ${keyClass}.`,
      });

      await cpInsert("cc_audit_events", {
        app_id: app.id,
        actor: "aggregator",
        event_type: "snapshot_captured",
        detail: {
          short_code: app.short_code,
          build_status: snap.build_status ?? "unknown",
          contract_version: snap.contract_version ?? null,
          key_class: keyClass,
          secret_ref: secretName,
          fallback_from: fallbackFrom,
        },
      });

      // Reconcile the snapshot into the cc_issues ledger. Zero-blocking: a
      // reconcile failure is logged but never discards the captured snapshot.
      let reconciled: unknown = null;
      try {
        reconciled = await cpRpc("cc_reconcile_app_issues", {
          p_app_id: app.id,
          p_snapshot: snap,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await cpInsert("cc_audit_events", {
          app_id: app.id,
          actor: "aggregator",
          event_type: "issue_reconcile_failed",
          detail: { short_code: app.short_code, error: msg },
        }).catch(() => {/* audit best-effort */});
      }

      results.push({
        app: app.short_code,
        ok: true,
        build_status: snap.build_status ?? "unknown",
        issues: reconciled,
      });
    } catch (e) {
      // Zero-blocking: log the failure, do NOT write a snapshot (keep last good),
      // do NOT abort the loop.
      const msg = e instanceof Error ? e.message : String(e);
      await cpInsert("cc_audit_events", {
        app_id: app.id,
        actor: "aggregator",
        event_type: "snapshot_failed",
        detail: { short_code: app.short_code, error: msg },
      }).catch(() => {/* audit best-effort */});
      results.push({ app: app.short_code, ok: false, error: msg });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  return new Response(
    JSON.stringify({ started_at: startedAt, polled: apps.length, ok, failed: apps.length - ok, results }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
