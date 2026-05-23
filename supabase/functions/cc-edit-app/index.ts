import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from "jsr:@panva/jose@^6";
import { verifyWriteToken } from "../_shared/phase5.ts";

// Browser write path for Apps edit basics. Auth mirrors cc-answer-issue:
// Cloudflare Access JWT in production, or x-cc-read-token fallback in local/dev.
// All writes are delegated to the atomic service-role-only cc_edit_app RPC.

const FUNCTION_NAME = "cc-edit-app";
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
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Cf-Access-Jwt-Assertion, x-cc-read-token",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BODY_KEYS = new Set(["app_id", "changes"]);
const EDITABLE_FIELDS = new Set(["display_name", "app_url", "criticality"]);
type VerifyKey = CryptoKey | Uint8Array;
type AccessResult = { ok: boolean; status: number; error?: string; headerValue: "noop" | "pass"; actor: string };
type RpcErrorPayload = { code?: string; message?: string; details?: string | null; hint?: string | null };

class RpcError extends Error {
  responseStatus: number;
  code: string;
  details: string | null;
  hint: string | null;

  constructor(responseStatus: number, payload: RpcErrorPayload) {
    super(payload.message ?? "RPC failed");
    this.name = "RpcError";
    this.responseStatus = responseStatus;
    this.code = payload.code ?? "";
    this.details = payload.details ?? null;
    this.hint = payload.hint ?? null;
  }
}

const jwkCache = new Map<string, VerifyKey>();

function buildJsonResponse(body: unknown, status = 200, accessCheck: "noop" | "pass" = "noop"): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "x-cc-access-check": accessCheck },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function operatorFromPayload(payload: JWTPayload): string {
  const email = typeof payload.email === "string" ? payload.email : null;
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  return email ?? sub ?? "access-jwt";
}

async function sha256Prefix(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadJwksIntoCache(teamDomain: string): Promise<void> {
  const r = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`JWKS fetch failed: ${r.status} ${await r.text()}`);
  const payload = await r.json() as { keys?: JWK[] };
  for (const jwk of Array.isArray(payload.keys) ? payload.keys : []) {
    const kid = typeof jwk.kid === "string" ? jwk.kid : "";
    if (!kid) continue;
    try {
      jwkCache.set(kid, await importJWK(jwk, "RS256"));
    } catch {
      // skip invalid key entries
    }
  }
}

async function verifyReadTokenHeader(presented: string | null): Promise<AccessResult> {
  if (!CC_READ_TOKEN) return { ok: false, status: 401, error: "read token not configured", headerValue: "noop", actor: "unknown" };
  if (!presented || presented !== CC_READ_TOKEN) return { ok: false, status: 401, error: "missing or invalid x-cc-read-token", headerValue: "noop", actor: "unknown" };
  return { ok: true, status: 200, headerValue: "noop", actor: `read-token:${await sha256Prefix(presented)}` };
}

async function verifyAccessJwt(assertion: string | null): Promise<AccessResult> {
  if (!ACCESS_REQUIRED) return verifyReadTokenHeader(assertion);
  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD) return { ok: false, status: 500, error: "CC_ACCESS_TEAM_DOMAIN and CC_ACCESS_AUD are required when CC_ACCESS_REQUIRED=true", headerValue: "pass", actor: "unknown" };
  if (!assertion) return { ok: false, status: 401, error: "missing Cf-Access-Jwt-Assertion", headerValue: "pass", actor: "unknown" };

  try {
    const { kid } = decodeProtectedHeader(assertion);
    if (!kid) return { ok: false, status: 401, error: "JWT header missing kid", headerValue: "pass", actor: "unknown" };
    let key = jwkCache.get(kid);
    if (!key) {
      await loadJwksIntoCache(ACCESS_TEAM_DOMAIN);
      key = jwkCache.get(kid);
    }
    if (!key) return { ok: false, status: 401, error: "no matching JWKS key for token kid", headerValue: "pass", actor: "unknown" };

    const verified = await jwtVerify(assertion, key, { audience: ACCESS_AUD });
    const aud = verified.payload.aud;
    const audValues = Array.isArray(aud) ? aud : (typeof aud === "string" ? [aud] : []);
    if (!audValues.includes(ACCESS_AUD)) return { ok: false, status: 401, error: "token audience is invalid", headerValue: "pass", actor: "unknown" };
    return { ok: true, status: 200, headerValue: "pass", actor: operatorFromPayload(verified.payload) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 401, error: `access JWT verification failed: ${msg}`, headerValue: "pass", actor: "unknown" };
  }
}

function structuredBadRequest(error: string, fields?: string[]): Record<string, unknown> {
  return fields?.length ? { error, code: "non_allowlisted_fields", fields } : { error };
}

function parseBody(value: unknown, archive: boolean): { ok: true; appId: string; changes: Record<string, unknown> } | { ok: false; body: Record<string, unknown> } {
  if (!isRecord(value)) return { ok: false, body: { error: "body must be a JSON object" } };

  const unknownBodyFields = Object.keys(value).filter((key) => !BODY_KEYS.has(key));
  if (unknownBodyFields.length) {
    return { ok: false, body: structuredBadRequest("only app_id and changes are accepted at the top level", unknownBodyFields) };
  }

  const appId = asString(value.app_id)?.trim() ?? "";
  if (!UUID_RE.test(appId)) return { ok: false, body: { error: "app_id must be a valid uuid" } };

  const changes = value.changes === undefined ? {} : value.changes;
  if (!isRecord(changes)) return { ok: false, body: { error: "changes must be a JSON object" } };

  const rejected = Object.keys(changes).filter((key) => !EDITABLE_FIELDS.has(key));
  if (rejected.length) return { ok: false, body: structuredBadRequest("only display_name, app_url, and criticality are editable", rejected) };
  if (!archive && Object.keys(changes).length === 0) return { ok: false, body: { error: "at least one editable field is required" } };

  if (changes.display_name !== undefined && (typeof changes.display_name !== "string" || !changes.display_name.trim())) {
    return { ok: false, body: { error: "display_name must be a non-empty string" } };
  }
  if (changes.app_url !== undefined && changes.app_url !== null) {
    if (typeof changes.app_url !== "string") return { ok: false, body: { error: "app_url must be a string or null" } };
    const appUrl = changes.app_url.trim();
    if (appUrl && !/^https:\/\/\S+$/.test(appUrl)) return { ok: false, body: { error: "app_url must be an https URL or null" } };
  }
  if (changes.criticality !== undefined) {
    const criticality = changes.criticality;
    if (typeof criticality !== "number" || !Number.isInteger(criticality) || criticality < 0 || criticality > 1000) {
      return { ok: false, body: { error: "criticality must be an integer between 0 and 1000" } };
    }
  }

  return { ok: true, appId, changes };
}

async function parseRpcErrorPayload(r: Response): Promise<RpcErrorPayload> {
  const text = await r.text();
  if (!text) return { message: `RPC failed with HTTP ${r.status}` };
  try {
    const payload = JSON.parse(text) as RpcErrorPayload;
    if (isRecord(payload)) return payload;
  } catch {
    // fall through
  }
  return { message: text };
}

async function editAppViaRpc(params: { p_app_id: string; p_changes: Record<string, unknown>; p_archive: boolean; p_actor: string }): Promise<unknown> {
  const r = await fetch(`${CP_URL}/rest/v1/rpc/cc_edit_app`, { method: "POST", headers: cpHeaders, body: JSON.stringify(params) });
  if (!r.ok) throw new RpcError(r.status, await parseRpcErrorPayload(r));
  return await r.json();
}

function rpcErrorResponse(e: RpcError, accessCheck: "noop" | "pass"): Response {
  const message = e.message || "app update failed";
  if (e.code === "P0001") {
    if (message === "app not found") return buildJsonResponse({ error: message }, 404, accessCheck);
    return buildJsonResponse({ error: message, detail: e.details ?? undefined }, 400, accessCheck);
  }
  return buildJsonResponse({ error: "app update failed", detail: e.details ? `${e.code}: ${message} — ${e.details}` : `${e.code}: ${message}` }, 500, accessCheck);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return buildJsonResponse({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return buildJsonResponse({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return buildJsonResponse({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);

  const archive = new URL(req.url).searchParams.get("archive") === "true";

  let parsedJson: unknown;
  try {
    parsedJson = await req.json();
  } catch {
    return buildJsonResponse({ error: "body must be valid JSON" }, 400, access.headerValue);
  }

  const parsed = parseBody(parsedJson, archive);
  if (!parsed.ok) return buildJsonResponse(parsed.body, 400, access.headerValue);

  try {
    const app = await editAppViaRpc({
      p_app_id: parsed.appId,
      p_changes: parsed.changes,
      p_archive: archive,
      p_actor: access.actor,
    });
    return buildJsonResponse({ app, archived: archive }, 200, access.headerValue);
  } catch (e) {
    if (e instanceof RpcError) return rpcErrorResponse(e, access.headerValue);
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "app update failed", detail: msg }, 500, access.headerValue);
  }
});
