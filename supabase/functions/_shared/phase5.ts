import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from "jsr:@panva/jose@^6";

export const CP_URL = Deno.env.get("SUPABASE_URL")!;
export const CP_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ACCESS_REQUIRED = (Deno.env.get("CC_ACCESS_REQUIRED") ?? "false") === "true";
export const ACCESS_TEAM_DOMAIN = Deno.env.get("CC_ACCESS_TEAM_DOMAIN") ?? "";
export const ACCESS_AUD = Deno.env.get("CC_ACCESS_AUD") ?? "";
export const CC_READ_TOKEN = Deno.env.get("CC_READ_TOKEN") ?? "";
export const CC_WRITE_TOKEN = Deno.env.get("CC_WRITE_TOKEN") ?? "";

export const cpHeaders = {
  apikey: CP_KEY,
  Authorization: `Bearer ${CP_KEY}`,
  "Content-Type": "application/json",
};

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Cf-Access-Jwt-Assertion, x-cc-read-token, x-csrf-token, x-cc-auto-route-toggle, x-cc-write-token",
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type VerifyKey = CryptoKey | Uint8Array;
export type AccessResult = { ok: boolean; status: number; error?: string; headerValue: "noop" | "pass"; actor: string };
export type RpcErrorPayload = { code?: string; message?: string; details?: string | null; hint?: string | null };

export class RpcError extends Error {
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

export function json(body: unknown, status = 200, accessCheck: "noop" | "pass" = "noop", headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, ...headers, "Content-Type": "application/json", "x-cc-access-check": accessCheck },
  });
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function cleanString(value: unknown, max = 500): string | null {
  const raw = asString(value)?.trim();
  if (!raw) return null;
  return raw.length > max ? raw.slice(0, max) : raw;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function operatorFromPayload(payload: JWTPayload): string {
  const email = typeof payload.email === "string" ? payload.email : null;
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  return email ?? sub ?? "access-jwt";
}

export async function sha256Prefix(value: string): Promise<string> {
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

export async function verifyReadTokenHeader(presented: string | null): Promise<AccessResult> {
  if (!CC_READ_TOKEN) return { ok: false, status: 401, error: "read token not configured", headerValue: "noop", actor: "unknown" };
  if (!presented || presented !== CC_READ_TOKEN) return { ok: false, status: 401, error: "missing or invalid x-cc-read-token", headerValue: "noop", actor: "unknown" };
  return { ok: true, status: 200, headerValue: "noop", actor: `read-token:${await sha256Prefix(presented)}` };
}

export function verifyWriteToken(req: Request): { ok: boolean; status: number; error?: string } {
  const token = req.headers.get("x-cc-write-token");
  if (!CC_WRITE_TOKEN) return { ok: false, status: 500, error: "write token not configured" };
  if (CC_WRITE_TOKEN === Deno.env.get("CC_READ_TOKEN")) return { ok: false, status: 500, error: "write token must differ from read token" };
  if (!token || token !== CC_WRITE_TOKEN) return { ok: false, status: 401, error: "missing or invalid x-cc-write-token" };
  return { ok: true, status: 200 };
}

export async function verifyAccessJwt(assertion: string | null): Promise<AccessResult> {
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

export async function parseRpcErrorPayload(r: Response): Promise<RpcErrorPayload> {
  const text = await r.text();
  if (!text) return { message: `RPC failed with HTTP ${r.status}` };
  try {
    const payload = JSON.parse(text) as RpcErrorPayload;
    if (isRecord(payload)) return payload;
  } catch { /* raw fallback */ }
  return { message: text };
}

export async function rpc<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${CP_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: cpHeaders, body: JSON.stringify(body) });
  if (!r.ok) throw new RpcError(r.status, await parseRpcErrorPayload(r));
  const text = await r.text();
  return text ? JSON.parse(text) as T : null as T;
}

export async function cpGet(path: string): Promise<unknown[]> {
  const r = await fetch(`${CP_URL}/rest/v1/${path}`, { headers: cpHeaders });
  if (!r.ok) throw new Error(`control-plane GET ${path} -> ${r.status} ${await r.text()}`);
  return asArray(await r.json());
}

export async function cpInsert<T = unknown>(table: string, row: unknown): Promise<T[]> {
  const r = await fetch(`${CP_URL}/rest/v1/${table}`, { method: "POST", headers: { ...cpHeaders, Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`control-plane INSERT ${table} -> ${r.status} ${await r.text()}`);
  return await r.json() as T[];
}

export async function cpPatch<T = unknown>(path: string, row: unknown): Promise<T[]> {
  const r = await fetch(`${CP_URL}/rest/v1/${path}`, { method: "PATCH", headers: { ...cpHeaders, Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`control-plane PATCH ${path} -> ${r.status} ${await r.text()}`);
  return await r.json() as T[];
}

export async function cpAudit(appId: string | null, actor: string, eventType: string, detail: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${CP_URL}/rest/v1/cc_audit_events`, { method: "POST", headers: { ...cpHeaders, Prefer: "return=minimal" }, body: JSON.stringify({ app_id: appId, actor, event_type: eventType, detail }) });
  if (!r.ok) throw new Error(`audit write failed -> ${r.status} ${await r.text()}`);
}

export function rpcErrorResponse(e: RpcError, accessCheck: "noop" | "pass" = "noop"): Response {
  const message = e.message || "request failed";
  if (e.code === "P0001") return json({ error: message, detail: e.details ?? undefined }, message.includes("not found") ? 404 : 400, accessCheck);
  return json({ error: "request failed", detail: e.details ? `${e.code}: ${message} — ${e.details}` : `${e.code}: ${message}` }, 500, accessCheck);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function encodeRfc822Base64Url(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function gmailAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GMAIL_OAUTH_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GMAIL_OAUTH_CLIENT_SECRET") ?? "";
  const refreshToken = Deno.env.get("GMAIL_OAUTH_REFRESH_TOKEN") ?? "";
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Gmail OAuth secrets are not configured");
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`Gmail OAuth refresh failed: ${r.status} ${await r.text()}`);
  const payload = await r.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("Gmail OAuth refresh response did not include access_token");
  return payload.access_token;
}

export async function gmailSend(rawRfc822: string): Promise<{ id: string; threadId?: string }> {
  const token = await gmailAccessToken();
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encodeRfc822Base64Url(rawRfc822) }),
  });
  if (!r.ok) throw new Error(`Gmail send failed: ${r.status} ${await r.text()}`);
  return await r.json() as { id: string; threadId?: string };
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function stripHeaderUnsafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
