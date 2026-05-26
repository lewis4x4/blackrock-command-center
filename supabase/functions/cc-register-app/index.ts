import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from "jsr:@panva/jose@^6";
import { verifyWriteToken } from "../_shared/phase5.ts";

// Browser write path for Apps registration. Auth mirrors cc-answer-issue and
// writes through one atomic service-role-only cc_register_app RPC.

const FUNCTION_NAME = "cc-register-app";
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
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Cf-Access-Jwt-Assertion, x-cc-read-token, x-cc-write-token",
};

const BODY_KEYS = new Set(["short_code", "display_name", "project_ref", "project_url", "service_secret_ref", "readonly_secret_ref", "github_repo"]);
type VerifyKey = CryptoKey | Uint8Array;
type AccessResult = { ok: boolean; status: number; error?: string; headerValue: "noop" | "pass"; actor: string };
type RpcErrorPayload = { code?: string; message?: string; details?: string | null; hint?: string | null };
type RegisterPayload = {
  short_code: string;
  display_name: string;
  project_ref: string;
  project_url: string;
  service_secret_ref: string;
  github_repo: string;
  readonly_secret_ref: string | null;
};

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

function cleanString(value: unknown, max = 500): string | null {
  const raw = asString(value)?.trim();
  if (!raw) return null;
  return raw.length > max ? raw.slice(0, max) : raw;
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

function secretRefLooksRaw(value: string): boolean {
  const ref = value.trim();
  return ref.startsWith("eyJ") || ref.length > 100 || /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(ref);
}

function parseBody(value: unknown): { ok: true; payload: RegisterPayload } | { ok: false; body: Record<string, unknown> } {
  if (!isRecord(value)) return { ok: false, body: { error: "body must be a JSON object" } };
  const unknownFields = Object.keys(value).filter((key) => !BODY_KEYS.has(key));
  if (unknownFields.length) return { ok: false, body: { error: "only the minimum registration payload is accepted", code: "non_allowlisted_fields", fields: unknownFields } };

  const payload: RegisterPayload = {
    short_code: cleanString(value.short_code, 12)?.toUpperCase() ?? "",
    display_name: cleanString(value.display_name, 120) ?? "",
    project_ref: cleanString(value.project_ref, 80) ?? "",
    project_url: cleanString(value.project_url, 500) ?? "",
    service_secret_ref: cleanString(value.service_secret_ref, 1000) ?? "",
    github_repo: cleanString(value.github_repo, 200) ?? "",
    readonly_secret_ref: cleanString(value.readonly_secret_ref, 1000),
  };

  if (!/^[A-Z0-9_]{2,12}$/.test(payload.short_code)) return { ok: false, body: { error: "short_code must be 2-12 uppercase letters, numbers, or underscores" } };
  if (!payload.display_name) return { ok: false, body: { error: "display_name is required" } };
  if (!payload.project_ref) return { ok: false, body: { error: "project_ref is required" } };
  if (!/^https:\/\/\S+$/.test(payload.project_url)) return { ok: false, body: { error: "project_url must be an https URL" } };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.github_repo)) return { ok: false, body: { error: "github_repo must be owner/name" } };
  if (!payload.service_secret_ref || secretRefLooksRaw(payload.service_secret_ref)) {
    return { ok: false, body: { error: "service_secret_ref must be a secret pointer, not a raw key", code: "secret_ref_validation" } };
  }
  if (payload.readonly_secret_ref && secretRefLooksRaw(payload.readonly_secret_ref)) {
    return { ok: false, body: { error: "readonly_secret_ref must be a secret pointer, not a raw key", code: "secret_ref_validation" } };
  }

  return { ok: true, payload };
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

async function registerAppViaRpc(payload: RegisterPayload, actor: string): Promise<unknown> {
  const r = await fetch(`${CP_URL}/rest/v1/rpc/cc_register_app`, {
    method: "POST",
    headers: cpHeaders,
    body: JSON.stringify({
      p_short_code: payload.short_code,
      p_display_name: payload.display_name,
      p_project_ref: payload.project_ref,
      p_project_url: payload.project_url,
      p_service_secret_ref: payload.service_secret_ref,
      p_github_repo: payload.github_repo,
      p_readonly_secret_ref: payload.readonly_secret_ref,
      p_actor: actor,
    }),
  });
  if (!r.ok) throw new RpcError(r.status, await parseRpcErrorPayload(r));
  return await r.json();
}

function rpcErrorResponse(e: RpcError, accessCheck: "noop" | "pass"): Response {
  const message = e.message || "app registration failed";
  if (e.code === "P0001") return buildJsonResponse({ error: message, detail: e.details ?? undefined }, 400, accessCheck);
  if (e.code === "23505") return buildJsonResponse({ error: "app registration failed", detail: message }, 409, accessCheck);
  return buildJsonResponse({ error: "app registration failed", detail: e.details ? `${e.code}: ${message} — ${e.details}` : `${e.code}: ${message}` }, 500, accessCheck);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return buildJsonResponse({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return buildJsonResponse({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return buildJsonResponse({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);

  let parsedJson: unknown;
  try {
    parsedJson = await req.json();
  } catch {
    return buildJsonResponse({ error: "body must be valid JSON" }, 400, access.headerValue);
  }

  const parsed = parseBody(parsedJson);
  if (!parsed.ok) return buildJsonResponse(parsed.body, 400, access.headerValue);

  try {
    const app = await registerAppViaRpc(parsed.payload, access.actor);
    return buildJsonResponse({ app }, 200, access.headerValue);
  } catch (e) {
    if (e instanceof RpcError) return rpcErrorResponse(e, access.headerValue);
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "app registration failed", detail: msg }, 500, access.headerValue);
  }
});
