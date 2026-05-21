import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jsr:@panva/jose@^6";

// Browser read path for per-app cockpit detail. Federated: this function proxies
// the client app's cc_export_detail() contract and audits every successful read.

const FUNCTION_NAME = "cc-read-app-detail";
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
const VALID_SECTIONS = new Set(["roadmap", "decisions", "sync", "all"]);

type AccessResult = {
  ok: boolean;
  status: number;
  error?: string;
  headerValue: "noop" | "pass";
};

type VerifyKey = CryptoKey | Uint8Array;
type DataPlaneKeyClass = "readonly" | "service_role";
type DataPlaneKey = { key: string; keyClass: DataPlaneKeyClass; secretName: string };
type DetailResult = {
  data: unknown;
  keyClass: DataPlaneKeyClass;
  secretName: string;
  fallbackFrom: { key_class: DataPlaneKeyClass; error: string } | null;
};

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

async function callDetail(projectUrl: string, credential: DataPlaneKey, section: string, cursor: string | null): Promise<unknown> {
  const r = await fetch(`${projectUrl}/rest/v1/rpc/cc_export_detail`, {
    method: "POST",
    headers: { apikey: credential.key, Authorization: `Bearer ${credential.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_section: section, p_cursor: cursor }),
  });
  if (!r.ok) throw new DataPlaneRpcError(r.status, await r.text(), credential.keyClass);
  return r.json();
}

async function readDetail(dp: Record<string, unknown>, section: string, cursor: string | null): Promise<DetailResult> {
  const projectUrl = asString(dp.project_url);
  if (!projectUrl) throw new Error("registry_app_supabase.project_url is missing");

  let fallbackFrom: DetailResult["fallbackFrom"] = null;
  let lastError: Error | null = null;

  for (const credential of resolveDataPlaneKeys(dp)) {
    try {
      const data = await callDetail(projectUrl, credential, section, cursor);
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

  const url = new URL(req.url);
  const appId = (url.searchParams.get("app_id") ?? "").trim();
  const section = (url.searchParams.get("section") ?? "all").trim().toLowerCase();
  const cursor = url.searchParams.get("cursor");

  if (!appId || !isUuid(appId)) {
    return buildJsonResponse({ error: "app_id must be a valid uuid" }, 400, access.headerValue);
  }
  if (!VALID_SECTIONS.has(section)) {
    return buildJsonResponse({ error: "section must be one of roadmap, decisions, sync, all" }, 400, access.headerValue);
  }

  let app: Record<string, unknown> | null = null;
  let dp: Record<string, unknown> | null = null;
  let lastSnapshotAt: string | null = null;
  try {
    const [appRows, dpRows, homeRows] = await Promise.all([
      cpGet(`registry_apps?id=eq.${appId}&deleted_at=is.null&select=id,short_code,display_name&limit=1`),
      cpGet(`registry_app_supabase?app_id=eq.${appId}&select=project_url,project_ref,readonly_secret_ref,service_secret_ref&limit=1`),
      cpGet(`registry_app_snapshots?app_id=eq.${appId}&select=captured_at&order=captured_at.desc&limit=1`),
    ]);
    app = appRows.find(isRecord) ?? null;
    dp = dpRows.find(isRecord) ?? null;
    const snapshotRow = homeRows.find(isRecord);
    lastSnapshotAt = snapshotRow ? asString(snapshotRow.captured_at) : null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "database read failed", detail: msg }, 500, access.headerValue);
  }

  if (!app) return buildJsonResponse({ error: "app not found" }, 404, access.headerValue);
  if (!dp) return buildJsonResponse({ error: "app data plane not configured" }, 503, access.headerValue);

  let detail: DetailResult;
  try {
    detail = await readDetail(dp, section, cursor);
  } catch (e) {
    if (isMissingDetailContract(e)) {
      return buildJsonResponse({
        error: "detail_contract_unavailable",
        message: "Cockpit detail is not wired for this app yet.",
        app_id: appId,
        section,
        last_snapshot_at: lastSnapshotAt,
        generated_at: new Date().toISOString(),
      }, 503, access.headerValue);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "detail read failed", detail: msg }, 502, access.headerValue);
  }

  try {
    await cpInsert("cc_audit_events", {
      app_id: appId,
      actor: FUNCTION_NAME,
      event_type: "detail_read",
      detail: {
        short_code: asString(app.short_code),
        section,
        cursor,
        key_class: detail.keyClass,
        secret_ref: detail.secretName,
        fallback_from: detail.fallbackFrom,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "audit write failed", detail: msg }, 500, access.headerValue);
  }

  return buildJsonResponse({
    app_id: appId,
    section,
    data: detail.data,
    key_class: detail.keyClass,
    last_snapshot_at: lastSnapshotAt,
    generated_at: new Date().toISOString(),
  }, 200, access.headerValue);
});
