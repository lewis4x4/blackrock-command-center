import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jsr:@panva/jose@^6";

// Browser read path for the Agents nav page. Federated: reads control-plane
// queue/ledger tables only. No client data-plane calls and no runner daemon work.

const FUNCTION_NAME = "cc-read-agents";
const CP_URL = Deno.env.get("SUPABASE_URL")!;
const CP_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ACCESS_REQUIRED = (Deno.env.get("CC_ACCESS_REQUIRED") ?? "false") === "true";
const ACCESS_TEAM_DOMAIN = Deno.env.get("CC_ACCESS_TEAM_DOMAIN") ?? "";
const ACCESS_AUD = Deno.env.get("CC_ACCESS_AUD") ?? "";
const CC_READ_TOKEN = Deno.env.get("CC_READ_TOKEN") ?? "";

if (ACCESS_REQUIRED) {
  console.log(`[${FUNCTION_NAME}] Cloudflare Access verification ENABLED`);
} else if (CC_READ_TOKEN) {
  console.log(`[${FUNCTION_NAME}] Cloudflare Access verification DISABLED — falling back to x-cc-read-token`);
} else {
  console.log(`[${FUNCTION_NAME}] Cloudflare Access verification DISABLED AND no CC_READ_TOKEN set — function will reject ALL requests`);
}

const cpHeaders = {
  apikey: CP_KEY,
  Authorization: `Bearer ${CP_KEY}`,
  "Content-Type": "application/json",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Cf-Access-Jwt-Assertion, x-cc-read-token",
};

const OPEN_WORK_ORDER_STATUSES = ["queued", "claimed", "dispatched", "building", "pr_open"] as const;
const CLOSED_WORK_ORDER_STATUSES = ["done", "failed", "dead_lettered", "cancelled"] as const;

type AccessResult = {
  ok: boolean;
  status: number;
  error?: string;
  headerValue: "noop" | "pass";
};

type VerifyKey = CryptoKey | Uint8Array;
const jwkCache = new Map<string, VerifyKey>();

function buildJsonResponse(body: unknown, status = 200, accessCheck: "noop" | "pass" = "noop"): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "x-cc-access-check": accessCheck,
    },
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return value.find(isRecord) ?? null;
  return isRecord(value) ? value : null;
}

async function cpGet(path: string): Promise<unknown[]> {
  const r = await fetch(`${CP_URL}/rest/v1/${path}`, { headers: cpHeaders });
  if (!r.ok) throw new Error(`control-plane GET ${path} -> ${r.status} ${await r.text()}`);
  return asArray(await r.json());
}

async function cpInsert(table: string, row: unknown): Promise<void> {
  const r = await fetch(`${CP_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...cpHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`control-plane INSERT ${table} -> ${r.status} ${await r.text()}`);
}

async function loadJwksIntoCache(teamDomain: string): Promise<void> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`JWKS fetch failed: ${r.status} ${await r.text()}`);

  const payload = await r.json() as { keys?: JWK[] };
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  for (const jwk of keys) {
    const kid = typeof jwk.kid === "string" ? jwk.kid : "";
    if (!kid) continue;
    try {
      const key = await importJWK(jwk, "RS256");
      jwkCache.set(kid, key);
    } catch {
      // skip invalid key entries
    }
  }
}

function verifyReadTokenHeader(presented: string | null): AccessResult {
  if (!CC_READ_TOKEN) {
    return { ok: false, status: 401, error: "read token not configured", headerValue: "noop" };
  }
  if (!presented || presented !== CC_READ_TOKEN) {
    return { ok: false, status: 401, error: "missing or invalid x-cc-read-token", headerValue: "noop" };
  }
  return { ok: true, status: 200, headerValue: "noop" };
}

async function verifyAccessJwt(assertion: string | null): Promise<AccessResult> {
  if (!ACCESS_REQUIRED) return verifyReadTokenHeader(assertion);

  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD) {
    return { ok: false, status: 500, error: "CC_ACCESS_TEAM_DOMAIN and CC_ACCESS_AUD are required when CC_ACCESS_REQUIRED=true", headerValue: "pass" };
  }

  if (!assertion) return { ok: false, status: 401, error: "missing Cf-Access-Jwt-Assertion", headerValue: "pass" };

  try {
    const { kid } = decodeProtectedHeader(assertion);
    if (!kid) return { ok: false, status: 401, error: "JWT header missing kid", headerValue: "pass" };

    let key = jwkCache.get(kid);
    if (!key) {
      await loadJwksIntoCache(ACCESS_TEAM_DOMAIN);
      key = jwkCache.get(kid);
    }
    if (!key) return { ok: false, status: 401, error: "no matching JWKS key for token kid", headerValue: "pass" };

    const verified = await jwtVerify(assertion, key, { audience: ACCESS_AUD });
    const aud = verified.payload.aud;
    const audValues = Array.isArray(aud) ? aud : (typeof aud === "string" ? [aud] : []);
    if (!audValues.includes(ACCESS_AUD)) {
      return { ok: false, status: 401, error: "token audience is invalid", headerValue: "pass" };
    }

    return { ok: true, status: 200, headerValue: "pass" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 401, error: `access JWT verification failed: ${msg}`, headerValue: "pass" };
  }
}

function appFromJoined(row: Record<string, unknown>): { id: string | null; short_code: string | null; display_name: string | null } {
  const app = nestedRecord(row.registry_apps);
  return {
    id: asString(row.app_id),
    short_code: app ? asString(app.short_code) : null,
    display_name: app ? asString(app.display_name) : null,
  };
}

function normalizeWorkOrder(row: unknown): Record<string, unknown> {
  const rec = isRecord(row) ? row : {};
  const { registry_apps: _registryApps, ...rest } = rec;
  void _registryApps;
  return {
    ...rest,
    cost_cap_usd: asNumber(rec.cost_cap_usd),
    attempt_count: asNumber(rec.attempt_count) ?? 0,
    max_attempts: asNumber(rec.max_attempts) ?? 0,
    app: appFromJoined(rec),
  };
}

function normalizeRun(row: unknown): Record<string, unknown> {
  const rec = isRecord(row) ? row : {};
  const workOrder = nestedRecord(rec.agent_work_orders);
  const app = workOrder ? appFromJoined(workOrder) : { id: null, short_code: null, display_name: null };
  const { agent_work_orders: _workOrder, ...rest } = rec;
  void _workOrder;
  return {
    ...rest,
    cost_usd: asNumber(rec.cost_usd),
    tokens_input: asNumber(rec.tokens_input),
    tokens_output: asNumber(rec.tokens_output),
    work_order: workOrder
      ? {
        id: asString(workOrder.id),
        status: asString(workOrder.status),
        risk_class: asString(workOrder.risk_class),
        change_spec: isRecord(workOrder.change_spec) ? workOrder.change_spec : {},
      }
      : null,
    app,
  };
}

function costKey(appId: string | null, runner: string | null): string {
  return `${appId ?? "unknown"}\u0000${runner ?? "unknown"}`;
}

function buildCostLedgerSummary(rows: unknown[]): { rows: Record<string, unknown>[]; grand_total_usd: number } {
  const groups = new Map<string, { app_id: string | null; short_code: string | null; display_name: string | null; runner: string | null; cost_usd: number; run_count: number }>();
  let grandTotal = 0;

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const cost = asNumber(row.cost_usd);
    if (cost == null) continue;

    const runner = asString(row.runner);
    const workOrder = nestedRecord(row.agent_work_orders);
    const app = workOrder ? appFromJoined(workOrder) : { id: null, short_code: null, display_name: null };
    const key = costKey(app.id, runner);
    const bucket = groups.get(key) ?? { app_id: app.id, short_code: app.short_code, display_name: app.display_name, runner, cost_usd: 0, run_count: 0 };
    bucket.cost_usd += cost;
    bucket.run_count += 1;
    groups.set(key, bucket);
    grandTotal += cost;
  }

  return {
    rows: [...groups.values()]
      .map((row) => ({ ...row, cost_usd: Number(row.cost_usd.toFixed(2)) }))
      .sort((a, b) => (asNumber(b.cost_usd) ?? 0) - (asNumber(a.cost_usd) ?? 0)),
    grand_total_usd: Number(grandTotal.toFixed(2)),
  };
}

const workOrderSelect = [
  "id", "created_at", "updated_at", "app_id", "target_repo", "target_branch", "change_spec", "source_answer_id",
  "risk_class", "cost_cap_usd", "status", "claimed_by", "claimed_at", "lease_expires_at", "attempt_count",
  "max_attempts", "last_error", "dispatched_at", "pr_opened_at", "completed_at", "dead_lettered_at", "pr_url",
  "registry_apps(short_code,display_name)",
].join(",");

const runSelect = [
  "id", "created_at", "updated_at", "work_order_id", "runner", "started_at", "finished_at", "heartbeat_at", "status",
  "cost_usd", "tokens_input", "tokens_output", "pr_url", "notes",
  "agent_work_orders(id,app_id,status,change_spec,risk_class,registry_apps(short_code,display_name))",
].join(",");

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return buildJsonResponse({ error: "GET or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");
  }

  const access = await verifyAccessJwt(
    ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"),
  );
  if (!access.ok) {
    return buildJsonResponse({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);
  }

  let openWorkOrders: unknown[];
  let recentClosedWorkOrders: unknown[];
  let runsRows: unknown[];
  let costRows: unknown[];
  try {
    [openWorkOrders, recentClosedWorkOrders, runsRows, costRows] = await Promise.all([
      cpGet(`agent_work_orders?select=${workOrderSelect}&deleted_at=is.null&status=in.(${OPEN_WORK_ORDER_STATUSES.join(",")})&order=created_at.asc`),
      cpGet(`agent_work_orders?select=${workOrderSelect}&deleted_at=is.null&status=in.(${CLOSED_WORK_ORDER_STATUSES.join(",")})&order=updated_at.desc&limit=20`),
      cpGet(`agent_runs?select=${runSelect}&order=started_at.desc&limit=50`),
      cpGet(`agent_runs?select=runner,cost_usd,agent_work_orders(app_id,registry_apps(short_code,display_name))&cost_usd=not.is.null`),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "database read failed", detail: msg }, 500, access.headerValue);
  }

  const payload = {
    work_orders: {
      open: openWorkOrders.map(normalizeWorkOrder),
      recent_completed: recentClosedWorkOrders.map(normalizeWorkOrder),
    },
    runs: runsRows.map(normalizeRun),
    cost_ledger_summary: buildCostLedgerSummary(costRows),
    runner_status: {
      online: false,
      last_seen_at: null,
      note: "No runner host deployed yet. See docs/handoffs/RUNNER_HOST_SETUP.md.",
    },
    generated_at: new Date().toISOString(),
  };

  try {
    await cpInsert("cc_audit_events", {
      app_id: null,
      actor: FUNCTION_NAME,
      event_type: "agents_page_read",
      detail: {
        open_work_orders: payload.work_orders.open.length,
        recent_completed_work_orders: payload.work_orders.recent_completed.length,
        runs: payload.runs.length,
        runner_online: payload.runner_status.online,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "audit write failed", detail: msg }, 500, access.headerValue);
  }

  return buildJsonResponse(payload, 200, access.headerValue);
});
