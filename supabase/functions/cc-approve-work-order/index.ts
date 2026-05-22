import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from "jsr:@panva/jose@^6";

const FUNCTION_NAME = "cc-approve-work-order";
const CP_URL = Deno.env.get("SUPABASE_URL")!;
const CP_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ACCESS_REQUIRED = (Deno.env.get("CC_ACCESS_REQUIRED") ?? "false") === "true";
const ACCESS_TEAM_DOMAIN = Deno.env.get("CC_ACCESS_TEAM_DOMAIN") ?? "";
const ACCESS_AUD = Deno.env.get("CC_ACCESS_AUD") ?? "";
const CC_READ_TOKEN = Deno.env.get("CC_READ_TOKEN") ?? "";

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

function cleanString(value: unknown, max = 500): string | null {
  const raw = asString(value)?.trim();
  if (!raw) return null;
  return raw.length > max ? raw.slice(0, max) : raw;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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
    try { jwkCache.set(kid, await importJWK(jwk, "RS256")); } catch { /* skip invalid key */ }
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

async function parseRpcErrorPayload(r: Response): Promise<RpcErrorPayload> {
  const text = await r.text();
  if (!text) return { message: `RPC failed with HTTP ${r.status}` };
  try {
    const payload = JSON.parse(text) as RpcErrorPayload;
    if (isRecord(payload)) return payload;
  } catch { /* raw text fallback */ }
  return { message: text };
}

async function approveWorkOrder(workOrderId: string, actor: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${CP_URL}/rest/v1/rpc/cc_approve_work_order`, {
    method: "POST",
    headers: cpHeaders,
    body: JSON.stringify({ p_work_order_id: workOrderId, p_actor: actor }),
  });
  if (!r.ok) throw new RpcError(r.status, await parseRpcErrorPayload(r));
  const payload = await r.json();
  if (!isRecord(payload)) throw new Error("cc_approve_work_order returned a non-object payload");
  return payload;
}

function parseBody(value: unknown): { ok: true; workOrderId: string } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "body must be a JSON object" };
  const workOrderId = cleanString(value.work_order_id, 80);
  if (!workOrderId || !isUuid(workOrderId)) return { ok: false, error: "work_order_id must be a valid uuid" };
  return { ok: true, workOrderId };
}

function rpcErrorResponse(e: RpcError, accessCheck: "noop" | "pass"): Response {
  const detail = e.details ? `${e.code}: ${e.message} — ${e.details}` : `${e.code}: ${e.message}`;
  const status = e.code === "22023" || e.code === "P0001" ? 400 : 500;
  return buildJsonResponse({ error: "approval failed", detail }, status, accessCheck);
}

console.log(`[${FUNCTION_NAME}] ready`);

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return buildJsonResponse({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return buildJsonResponse({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  let parsedJson: unknown;
  try { parsedJson = await req.json(); } catch { return buildJsonResponse({ error: "body must be valid JSON" }, 400, access.headerValue); }
  const parsed = parseBody(parsedJson);
  if (!parsed.ok) return buildJsonResponse({ error: parsed.error }, 400, access.headerValue);

  try {
    const workOrder = await approveWorkOrder(parsed.workOrderId, access.actor);
    return buildJsonResponse({ work_order: workOrder }, 200, access.headerValue);
  } catch (e) {
    if (e instanceof RpcError) return rpcErrorResponse(e, access.headerValue);
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "approval failed", detail: msg }, 500, access.headerValue);
  }
});
