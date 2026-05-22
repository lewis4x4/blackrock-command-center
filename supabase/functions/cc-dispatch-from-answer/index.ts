import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from "jsr:@panva/jose@^6";

const FUNCTION_NAME = "cc-dispatch-from-answer";
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
type ChangeSpec = { intent: string; affected_area?: string | null; acceptance_criteria?: string[]; constraints?: string[] };
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

function cleanStringArray(value: unknown, maxItems = 12, maxLen = 240): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item, maxLen)).filter((item): item is string => !!item).slice(0, maxItems);
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

async function cpGetOne(path: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${CP_URL}/rest/v1/${path}`, { headers: cpHeaders });
  if (!r.ok) throw new Error(`control-plane GET ${path} -> ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) && isRecord(rows[0]) ? rows[0] : null;
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

async function enqueueWithGating(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${CP_URL}/rest/v1/rpc/cc_enqueue_with_gating`, {
    method: "POST",
    headers: cpHeaders,
    body: JSON.stringify(params),
  });
  if (!r.ok) throw new RpcError(r.status, await parseRpcErrorPayload(r));
  const payload = await r.json();
  if (!isRecord(payload)) throw new Error("cc_enqueue_with_gating returned a non-object payload");
  return payload;
}

function parseBody(value: unknown): { ok: true; answerId: string; changeSpec: ChangeSpec | null } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "body must be a JSON object" };
  const answerId = cleanString(value.decision_answer_id, 80);
  if (!answerId || !isUuid(answerId)) return { ok: false, error: "decision_answer_id must be a valid uuid" };
  if (value.change_spec === undefined || value.change_spec === null) return { ok: true, answerId, changeSpec: null };
  if (!isRecord(value.change_spec)) return { ok: false, error: "change_spec must be an object when provided" };
  const changeSpecRecord = value.change_spec;
  const intent = cleanString(changeSpecRecord.intent, 1000);
  if (!intent) return { ok: false, error: "change_spec.intent is required when change_spec is provided" };
  return {
    ok: true,
    answerId,
    changeSpec: {
      intent,
      affected_area: cleanString(changeSpecRecord.affected_area, 240),
      acceptance_criteria: cleanStringArray(changeSpecRecord.acceptance_criteria),
      constraints: cleanStringArray(changeSpecRecord.constraints),
    },
  };
}

function deriveAffectedArea(issue: Record<string, unknown>): string | null {
  const context = isRecord(issue.context) ? issue.context : {};
  const detail = isRecord(issue.detail) ? issue.detail : {};
  for (const source of [context, detail, issue]) {
    for (const key of ["affected_area", "area", "surface", "stream", "source_ref"]) {
      const value = cleanString(source[key], 240);
      if (value && !["aggregate", "build", "sync", "blocked"].includes(value)) return value;
    }
  }
  return null;
}

function composeChangeSpec(answer: Record<string, unknown>, issue: Record<string, unknown>): ChangeSpec {
  const answerValue = cleanString(answer.answer_value, 200) ?? "unknown";
  const rationale = cleanString(answer.rationale, 500);
  const title = cleanString(issue.title, 500) ?? cleanString(answer.decision_external_ref, 200) ?? "the answered decision";
  return {
    intent: `Apply the answer '${answerValue}' to decision '${title}'${rationale ? `: operator note: '${rationale}'.` : "."}`,
    affected_area: deriveAffectedArea(issue),
    acceptance_criteria: ["Implement the answered choice", "All existing tests pass", "No schema-destructive operations"],
    constraints: ["Single PR", "Branch must start with cc/", "Do not modify CI configuration"],
  };
}

function rpcErrorResponse(e: RpcError, accessCheck: "noop" | "pass"): Response {
  const detail = e.details ? `${e.code}: ${e.message} — ${e.details}` : `${e.code}: ${e.message}`;
  const status = e.code === "23503" || e.code === "P0001" || e.code === "22023" ? 400 : 500;
  return buildJsonResponse({ error: "dispatch failed", detail }, status, accessCheck);
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
    const answer = await cpGetOne(`cc_decision_answers?select=id,issue_id,app_id,decision_external_ref,answer_value,rationale,risk_class&deleted_at=is.null&id=eq.${parsed.answerId}&limit=1`);
    if (!answer) return buildJsonResponse({ error: "decision answer not found" }, 404, access.headerValue);

    const issueId = cleanString(answer.issue_id, 80);
    const appId = cleanString(answer.app_id, 80);
    if (!issueId || !appId) return buildJsonResponse({ error: "decision answer is missing issue/app linkage" }, 500, access.headerValue);

    const [issue, app] = await Promise.all([
      cpGetOne(`cc_issues?select=id,app_id,issue_type,source_ref,title,summary,context,detail&deleted_at=is.null&id=eq.${issueId}&limit=1`),
      cpGetOne(`registry_apps?select=id,short_code,display_name,criticality&deleted_at=is.null&id=eq.${appId}&limit=1`),
    ]);
    if (!issue) return buildJsonResponse({ error: "related issue not found" }, 404, access.headerValue);
    if (!app) return buildJsonResponse({ error: "related app not found" }, 404, access.headerValue);

    const changeSpec = parsed.changeSpec ?? composeChangeSpec(answer, issue);
    const idempotencyKey = `decision_answer:${parsed.answerId}`;
    const workOrder = await enqueueWithGating({
      p_app_id: appId,
      p_change_spec: changeSpec,
      p_risk_class: cleanString(answer.risk_class, 40) ?? "authorize",
      p_idempotency_key: idempotencyKey,
      p_source_answer_id: parsed.answerId,
      p_cost_cap_usd: null,
      p_actor: access.actor,
    });

    const status = cleanString(workOrder.status, 40);
    return buildJsonResponse({ work_order: workOrder, dispatched: status === "queued" }, 200, access.headerValue);
  } catch (e) {
    if (e instanceof RpcError) return rpcErrorResponse(e, access.headerValue);
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "dispatch failed", detail: msg }, 500, access.headerValue);
  }
});
