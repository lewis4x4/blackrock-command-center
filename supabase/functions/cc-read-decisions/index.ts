import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jsr:@panva/jose@^6";

// Browser read path for the Decisions nav page. Federated: fans out to each
// registered app's cc_export_detail('decisions') contract and keeps client
// decision content out of the control plane.

const FUNCTION_NAME = "cc-read-decisions";
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_KINDS = new Set(["operator", "client", "unknown"]);

type AccessResult = {
  ok: boolean;
  status: number;
  error?: string;
  headerValue: "noop" | "pass";
};

type VerifyKey = CryptoKey | Uint8Array;
type DataPlaneKeyClass = "readonly" | "service_role";
type DataPlaneKey = { key: string; keyClass: DataPlaneKeyClass; secretName: string };
type AppIdentity = { app_id: string; app_short_code: string; app_display_name: string };
type AppRecord = AppIdentity & { id: string; short_code: string; display_name: string };
type DataPlaneRecord = Record<string, unknown> & { app_id?: string };
type AppStatusRecord = AppIdentity & { reason?: string; status?: number; detail?: string };
type FanoutResult =
  | { kind: "reached"; app: AppRecord; decisions: Record<string, unknown>[]; keyClass: DataPlaneKeyClass; secretName: string; fallbackFrom: unknown }
  | { kind: "unwired"; app: AppRecord; reason: string; detail?: string }
  | { kind: "unreachable"; app: AppRecord; reason: string; status?: number; detail?: string };

class DataPlaneRpcError extends Error {
  status: number;
  body: string;
  keyClass: DataPlaneKeyClass;

  constructor(status: number, body: string, keyClass: DataPlaneKeyClass) {
    super(`cc_export_detail RPC (${keyClass}) -> ${status} ${body}`);
    this.status = status;
    this.body = body;
    this.keyClass = keyClass;
  }
}

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

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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

function normalizeSecretRef(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveDataPlaneKeys(dp: Record<string, unknown>): DataPlaneKey[] {
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

async function callDetail(projectUrl: string, credential: DataPlaneKey, cursor: string | null): Promise<unknown> {
  const r = await fetch(`${projectUrl}/rest/v1/rpc/cc_export_detail`, {
    method: "POST",
    headers: { apikey: credential.key, Authorization: `Bearer ${credential.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(cursor ? { p_section: "decisions", p_cursor: cursor } : { p_section: "decisions" }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new DataPlaneRpcError(r.status, await r.text(), credential.keyClass);
  return r.json();
}

async function readDecisions(dp: Record<string, unknown>, cursor: string | null): Promise<{ data: unknown; keyClass: DataPlaneKeyClass; secretName: string; fallbackFrom: unknown }> {
  const projectUrl = asString(dp.project_url);
  if (!projectUrl) throw new Error("registry_app_supabase.project_url is missing");

  let fallbackFrom: { key_class: DataPlaneKeyClass; error: string } | null = null;
  let lastError: Error | null = null;

  for (const credential of resolveDataPlaneKeys(dp)) {
    try {
      const data = await callDetail(projectUrl, credential, cursor);
      return { data, keyClass: credential.keyClass, secretName: credential.secretName, fallbackFrom };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (!fallbackFrom) fallbackFrom = { key_class: credential.keyClass, error: lastError.message };
    }
  }

  throw lastError ?? new Error("cc_export_detail RPC failed");
}

function isMissingDetailContract(error: unknown): boolean {
  if (!(error instanceof DataPlaneRpcError)) return false;
  const body = error.body.toLowerCase();
  return error.status === 404 || body.includes("pgrst202") || body.includes("could not find the function") || body.includes("schema cache");
}

function normalizeDecisionItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  const rec = isRecord(value) ? value : {};
  const data = isRecord(rec.data) ? rec.data : rec;
  const raw = data.decisions !== undefined ? data.decisions : data;
  if (Array.isArray(raw)) return raw.filter(isRecord);
  const rawRecord = isRecord(raw) ? raw : {};
  const rawItems = Array.isArray(rawRecord.items) ? rawRecord.items : [];
  return rawItems.filter(isRecord);
}

function appIdentity(row: Record<string, unknown>): AppRecord | null {
  const id = asString(row.id);
  const shortCode = asString(row.short_code);
  const displayName = asString(row.display_name);
  if (!id || !shortCode || !displayName) return null;
  return { id, short_code: shortCode, display_name: displayName, app_id: id, app_short_code: shortCode, app_display_name: displayName };
}

function appStatus(app: AppRecord, extra: Omit<AppStatusRecord, keyof AppIdentity>): AppStatusRecord {
  return { app_id: app.app_id, app_short_code: app.app_short_code, app_display_name: app.app_display_name, ...extra };
}

function tagDecision(app: AppRecord, row: Record<string, unknown>, ccIssueId: string | null): Record<string, unknown> {
  return {
    ...row,
    app_id: app.app_id,
    app_short_code: app.app_short_code,
    app_display_name: app.app_display_name,
    cc_issue_id: ccIssueId,
  };
}

function ownerKind(row: Record<string, unknown>): "operator" | "client" | "unknown" {
  const values = ["owner_type", "owner_kind", "answer_owner", "owned_by", "decision_owner"]
    .map((key) => asString(row[key])?.toLowerCase())
    .filter(Boolean) as string[];
  if (values.some((value) => value === "operator" || value === "blackrock" || value === "blackrock_ai")) return "operator";
  if (values.some((value) => value === "client" || value === "customer")) return "client";

  const owner = asString(row.owner)?.toLowerCase() ?? asString(row.assignee)?.toLowerCase() ?? "";
  if (["brian", "operator", "blackrock ai", "blackrock"].includes(owner)) return "operator";
  if (owner) return "client";
  return "unknown";
}

function decisionAgeDays(row: Record<string, unknown>): number | null {
  const direct = asNumber(row.age_days);
  if (direct != null) return direct;

  const age = asString(row.age)?.trim().toLowerCase();
  if (age) {
    const m = age.match(/^(\d+(?:\.\d+)?)\s*([mhdw])(?:in|ours?|ays?|eeks?)?$/);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2];
      if (unit === "m") return n / 1440;
      if (unit === "h") return n / 24;
      if (unit === "d") return n;
      if (unit === "w") return n * 7;
    }
  }

  for (const key of ["opened_at", "created_at", "surfaced_at", "last_seen_at", "updated_at"]) {
    const raw = asString(row[key]);
    if (!raw) continue;
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return Math.max(0, (Date.now() - t) / 86_400_000);
  }
  return null;
}

function applyFilters(rows: Record<string, unknown>[], ownerFilter: string | null, maxAgeDays: number | null): Record<string, unknown>[] {
  return rows.filter((row) => {
    if (ownerFilter && ownerKind(row) !== ownerFilter) return false;
    if (maxAgeDays != null) {
      const age = decisionAgeDays(row);
      if (age == null || age > maxAgeDays) return false;
    }
    return true;
  });
}

function parseLimit(raw: string | null): number {
  if (raw == null || raw === "") return 200;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  return n;
}

function parseMaxAgeDays(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error("max_age_days must be a non-negative number");
  return n;
}

async function fanOutApp(app: AppRecord, dp: DataPlaneRecord | undefined, ccIssueId: string | null, cursor: string | null): Promise<FanoutResult> {
  if (!dp) return { kind: "unwired", app, reason: "data_plane_not_configured" };

  try {
    const detail = await readDecisions(dp, cursor);
    return {
      kind: "reached",
      app,
      decisions: normalizeDecisionItems(detail.data).map((row) => tagDecision(app, row, ccIssueId)),
      keyClass: detail.keyClass,
      secretName: detail.secretName,
      fallbackFrom: detail.fallbackFrom,
    };
  } catch (e) {
    if (isMissingDetailContract(e)) {
      return { kind: "unwired", app, reason: "detail_contract_unavailable" };
    }
    const msg = e instanceof Error ? e.message : String(e);
    const status = e instanceof DataPlaneRpcError ? e.status : undefined;
    return { kind: "unreachable", app, reason: "detail_read_failed", status, detail: msg };
  }
}

function answeredSummary(row: unknown): Record<string, unknown> {
  const rec = isRecord(row) ? row : {};
  const registry = Array.isArray(rec.registry_apps)
    ? rec.registry_apps.find(isRecord)
    : (isRecord(rec.registry_apps) ? rec.registry_apps : null);
  const { registry_apps: _registryApps, ...rest } = rec;
  void _registryApps;
  return {
    ...rest,
    app_short_code: registry ? asString(registry.short_code) : null,
    app_display_name: registry ? asString(registry.display_name) : null,
  };
}

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

  let appId: string | null = null;
  let ownerFilter: string | null = null;
  let maxAgeDays: number | null = null;
  let limit = 200;
  let cursor: string | null = null;
  try {
    const url = new URL(req.url);
    appId = (url.searchParams.get("app_id") ?? "").trim() || null;
    if (appId && !isUuid(appId)) throw new Error("app_id must be a valid uuid");

    ownerFilter = (url.searchParams.get("owner_kind") ?? "").trim().toLowerCase() || null;
    if (ownerFilter && !OWNER_KINDS.has(ownerFilter)) throw new Error("owner_kind must be operator, client, or unknown");

    maxAgeDays = parseMaxAgeDays(url.searchParams.get("max_age_days"));
    limit = parseLimit(url.searchParams.get("limit"));
    cursor = url.searchParams.get("cursor");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: msg }, 400, access.headerValue);
  }

  let apps: AppRecord[];
  let dpRows: DataPlaneRecord[];
  let answeredRecent: unknown[];
  let answeredSendRows: unknown[];
  let pendingReviews: unknown[];
  let aggregateIssueByApp: Map<string, string> = new Map();
  try {
    const appPath = appId
      ? `registry_apps?id=eq.${appId}&deleted_at=is.null&status=eq.active&select=id,short_code,display_name&limit=1`
      : "registry_apps?deleted_at=is.null&status=eq.active&select=id,short_code,display_name&order=criticality.desc";
    const appRows = await cpGet(appPath);
    apps = appRows.map((row) => isRecord(row) ? appIdentity(row) : null).filter((row): row is AppRecord => !!row);

    const appIdFilter = apps.map((app) => app.app_id).join(",");
    const [rawDpRows, rawAnsweredRecent, rawAggregateIssues, rawPendingReviews, rawAnsweredSendRows] = await Promise.all([
      appIdFilter
        ? cpGet(`registry_app_supabase?app_id=in.(${appIdFilter})&select=app_id,project_url,project_ref,readonly_secret_ref,service_secret_ref`)
        : Promise.resolve([]),
      cpGet("cc_decision_answers?select=id,issue_id,app_id,decision_external_ref,answer_value,answer_options_snapshot,rationale,risk_class,answered_by,answered_at,dispatched_at,registry_apps(short_code,display_name)&deleted_at=is.null&order=answered_at.desc&limit=20"),
      appIdFilter
        ? cpGet(`cc_issues?app_id=in.(${appIdFilter})&issue_type=eq.open_decision&source_ref=eq.aggregate&deleted_at=is.null&status=in.(surfaced,triaging,answered,work_order_created,dispatched,building,pr_open,routed_to_client,gated)&select=id,app_id,created_at&order=created_at.desc`)
        : Promise.resolve([]),
      appId
        ? cpGet(`cc_decision_email_sends?deleted_at=is.null&app_id=eq.${appId}&state=eq.awaiting_operator_review&select=id,app_id,issue_id,decision_external_ref,raw_decision_title,raw_decision_body,options_snapshot,recipient_id,recipient_name,recipient_email,replied_at,raw_reply_text,llm_extraction,clarification_attempt_count,state&order=updated_at.desc`)
        : cpGet("cc_decision_email_sends?deleted_at=is.null&state=eq.awaiting_operator_review&select=id,app_id,issue_id,decision_external_ref,raw_decision_title,raw_decision_body,options_snapshot,recipient_id,recipient_name,recipient_email,replied_at,raw_reply_text,llm_extraction,clarification_attempt_count,state&order=updated_at.desc"),
      cpGet("cc_decision_email_sends?deleted_at=is.null&decision_answer_id=not.is.null&select=decision_answer_id,created_via"),
    ]);
    dpRows = rawDpRows.filter(isRecord) as DataPlaneRecord[];
    answeredRecent = rawAnsweredRecent;
    answeredSendRows = rawAnsweredSendRows;
    pendingReviews = rawPendingReviews;
    // Map: app_id -> most recent aggregate open_decision cc_issues.id
    aggregateIssueByApp = new Map();
    for (const row of rawAggregateIssues.filter(isRecord)) {
      const appIdValue = asString(row.app_id);
      const issueIdValue = asString(row.id);
      if (!appIdValue || !issueIdValue) continue;
      if (!aggregateIssueByApp.has(appIdValue)) {
        aggregateIssueByApp.set(appIdValue, issueIdValue); // most-recent (ordered DESC)
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "database read failed", detail: msg }, 500, access.headerValue);
  }

  const dpByAppId = new Map(dpRows.filter(isRecord).map((row) => [asString(row.app_id), row as DataPlaneRecord]));
  const fanout = await Promise.all(apps.map((app) => fanOutApp(app, dpByAppId.get(app.app_id), aggregateIssueByApp.get(app.app_id) ?? null, cursor)));

  const appsReached = fanout
    .filter((result): result is Extract<FanoutResult, { kind: "reached" }> => result.kind === "reached")
    .map((result) => appStatus(result.app, { reason: "ok" }));
  const appsUnwired = fanout
    .filter((result): result is Extract<FanoutResult, { kind: "unwired" }> => result.kind === "unwired")
    .map((result) => appStatus(result.app, { reason: result.reason, detail: result.detail }));
  const appsUnreachable = fanout
    .filter((result): result is Extract<FanoutResult, { kind: "unreachable" }> => result.kind === "unreachable")
    .map((result) => appStatus(result.app, { reason: result.reason, status: result.status, detail: result.detail }));

  const allDecisions = fanout.flatMap((result) => result.kind === "reached" ? result.decisions : []);
  const decisions = applyFilters(allDecisions, ownerFilter, maxAgeDays).slice(0, limit);

  const appById = new Map(apps.map((app) => [app.app_id, app]));
  const createdViaByAnswerId = new Map(
    answeredSendRows.filter(isRecord)
      .map((row) => [asString(row.decision_answer_id), asString(row.created_via)])
      .filter(([id, via]) => !!id && !!via) as Array<[string, string]>
  );
  const payload = {
    apps_reached: appsReached,
    apps_unreachable: appsUnreachable,
    apps_unwired: appsUnwired,
    decisions,
    answered_recent: answeredRecent.map((row) => {
      const summary = answeredSummary(row);
      const id = asString(summary.id);
      return { ...summary, created_via: id ? (createdViaByAnswerId.get(id) ?? 'manual') : 'manual' };
    }),
    pending_reviews: pendingReviews.filter(isRecord).map((row) => {
      const app = appById.get(asString(row.app_id) ?? "");
      return {
        send_id: asString(row.id),
        app_id: asString(row.app_id),
        app_short_code: app?.app_short_code ?? null,
        app_display_name: app?.app_display_name ?? null,
        issue_id: asString(row.issue_id),
        decision_external_ref: asString(row.decision_external_ref),
        raw_decision_title: asString(row.raw_decision_title),
        raw_decision_body: asString(row.raw_decision_body),
        options_snapshot: Array.isArray(row.options_snapshot) ? row.options_snapshot : [],
        recipient_id: asString(row.recipient_id),
        recipient_name: asString(row.recipient_name),
        recipient_email: asString(row.recipient_email),
        replied_at: asString(row.replied_at),
        raw_reply_text: asString(row.raw_reply_text),
        llm_extraction: isRecord(row.llm_extraction) ? row.llm_extraction : null,
        clarification_attempt_count: asNumber(row.clarification_attempt_count) ?? 0,
        state: asString(row.state),
      };
    }),
    generated_at: new Date().toISOString(),
  };

  try {
    await cpInsert("cc_audit_events", {
      app_id: appId,
      actor: FUNCTION_NAME,
      event_type: "decisions_page_read",
      detail: {
        apps_reached: appsReached.length,
        apps_unreachable: appsUnreachable.length,
        apps_unwired: appsUnwired.length,
        decisions: decisions.length,
        pending_reviews: pendingReviews.length,
        filters: { app_id: appId, owner_kind: ownerFilter, max_age_days: maxAgeDays, limit },
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "audit write failed", detail: msg }, 500, access.headerValue);
  }

  return buildJsonResponse(payload, 200, access.headerValue);
});
