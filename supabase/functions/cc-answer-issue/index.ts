import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from "jsr:@panva/jose@^6";
import { verifyWriteToken } from "../_shared/phase5.ts";

// Browser write path for Phase 2 issue resolution. This function authenticates
// the same way as cc-read-app-detail, validates the HTTP payload, and delegates
// the issue transition / answer insert / audit insert to one atomic Postgres RPC.

const FUNCTION_NAME = "cc-answer-issue";
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTIONS = new Set(["answer_decision", "acknowledge", "dismiss", "link_to_decision"]);
const RISK_CLASSES = new Set(["auto", "authorize", "destructive", "production"]);

type Action = "answer_decision" | "acknowledge" | "dismiss" | "link_to_decision";
type RiskClass = "auto" | "authorize" | "destructive" | "production";
type VerifyKey = CryptoKey | Uint8Array;
type AccessResult = {
  ok: boolean;
  status: number;
  error?: string;
  headerValue: "noop" | "pass";
  actor: string;
};
type AnswerRequest = {
  issue_id?: unknown;
  action?: unknown;
  answer_value?: unknown;
  answer_options_snapshot?: unknown;
  rationale?: unknown;
  risk_class?: unknown;
  linked_decision_ref?: unknown;
  decision_external_ref?: unknown;
  source?: unknown;
  answer_source?: unknown;
};
type ResolveIssueParams = {
  issue_id: string;
  action: Action;
  answer_value: string | null;
  answer_options_snapshot: unknown;
  rationale: string | null;
  risk_class: string | null;
  linked_decision_ref: string | null;
  actor: string;
  decision_external_ref: string | null;
  answer_source: "operator" | "client_reply" | "auto_extraction" | "smoke_test" | "system" | "manual_remediation" | null;
};
type RpcErrorPayload = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
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
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "x-cc-access-check": accessCheck,
    },
  });
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

async function verifyReadTokenHeader(presented: string | null): Promise<AccessResult> {
  if (!CC_READ_TOKEN) {
    return { ok: false, status: 401, error: "read token not configured", headerValue: "noop", actor: "unknown" };
  }
  if (!presented || presented !== CC_READ_TOKEN) {
    return { ok: false, status: 401, error: "missing or invalid x-cc-read-token", headerValue: "noop", actor: "unknown" };
  }
  return { ok: true, status: 200, headerValue: "noop", actor: `read-token:${await sha256Prefix(presented)}` };
}

async function verifyAccessJwt(assertion: string | null): Promise<AccessResult> {
  if (!ACCESS_REQUIRED) return verifyReadTokenHeader(assertion);

  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD) {
    return { ok: false, status: 500, error: "CC_ACCESS_TEAM_DOMAIN and CC_ACCESS_AUD are required when CC_ACCESS_REQUIRED=true", headerValue: "pass", actor: "unknown" };
  }

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
    if (!audValues.includes(ACCESS_AUD)) {
      return { ok: false, status: 401, error: "token audience is invalid", headerValue: "pass", actor: "unknown" };
    }

    return { ok: true, status: 200, headerValue: "pass", actor: operatorFromPayload(verified.payload) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 401, error: `access JWT verification failed: ${msg}`, headerValue: "pass", actor: "unknown" };
  }
}

function parseBody(value: unknown): { ok: true; body: AnswerRequest; issueId: string; action: Action } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "body must be a JSON object" };
  const body = value as AnswerRequest;
  const issueId = cleanString(body.issue_id, 80);
  const action = cleanString(body.action, 40);
  if (!issueId || !isUuid(issueId)) return { ok: false, error: "issue_id must be a valid uuid" };
  if (!action || !ACTIONS.has(action)) return { ok: false, error: "action must be one of answer_decision, acknowledge, dismiss, link_to_decision" };
  return { ok: true, body, issueId, action: action as Action };
}

function enumeratedOptionIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      ids.add(item.trim());
      continue;
    }
    if (!isRecord(item)) continue;
    for (const key of ["id", "value", "key"]) {
      const id = cleanString(item[key], 200);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function validateActionPayload(body: AnswerRequest, action: Action): { ok: true; riskClass?: RiskClass; answerValue?: string; rationale: string | null; linkedDecisionRef?: string } | { ok: false; error: string } {
  const rationale = cleanString(body.rationale, 500);

  if (action === "answer_decision") {
    const answerValue = cleanString(body.answer_value, 200);
    const riskClass = cleanString(body.risk_class, 40);
    if (!answerValue) return { ok: false, error: "answer_value is required for answer_decision" };
    if (!riskClass || !RISK_CLASSES.has(riskClass)) return { ok: false, error: "risk_class must be one of auto, authorize, destructive, production" };
    if (body.answer_options_snapshot === undefined || body.answer_options_snapshot === null) {
      return { ok: false, error: "answer_options_snapshot is required for answer_decision" };
    }
    const optionIds = enumeratedOptionIds(body.answer_options_snapshot);
    if (optionIds.size === 0) return { ok: false, error: "answer_options_snapshot must contain at least one enumerated option" };
    if (!optionIds.has(answerValue)) return { ok: false, error: "answer_value must match an enumerated option id" };
    return { ok: true, riskClass: riskClass as RiskClass, answerValue, rationale };
  }

  if (action === "link_to_decision") {
    const linkedDecisionRef = cleanString(body.linked_decision_ref, 200);
    if (!linkedDecisionRef) return { ok: false, error: "linked_decision_ref is required for link_to_decision" };
    return { ok: true, rationale, linkedDecisionRef };
  }

  return { ok: true, rationale };
}

async function parseRpcErrorPayload(r: Response): Promise<RpcErrorPayload> {
  const text = await r.text();
  if (!text) return { message: `RPC failed with HTTP ${r.status}` };
  try {
    const payload = JSON.parse(text) as RpcErrorPayload;
    if (isRecord(payload)) return payload;
  } catch {
    // fall through to raw body
  }
  return { message: text };
}

async function resolveIssueViaRpc(params: ResolveIssueParams): Promise<unknown> {
  const r = await fetch(`${CP_URL}/rest/v1/rpc/cc_resolve_issue`, {
    method: "POST",
    headers: cpHeaders,
    body: JSON.stringify(params),
  });
  if (!r.ok) throw new RpcError(r.status, await parseRpcErrorPayload(r));
  return await r.json();
}

async function loadIssueForAlert(issueId: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${CP_URL}/rest/v1/cc_issues?id=eq.${issueId}&select=id,app_id,title,status,source_ref&limit=1`, { headers: cpHeaders });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []) as unknown;
  return Array.isArray(rows) && isRecord(rows[0]) ? rows[0] : null;
}

function requestAnswerSource(body: AnswerRequest): string | null {
  return cleanString(body.source, 80) ?? cleanString(body.answer_source, 80);
}

function isSmokeTestBlocked(body: AnswerRequest, error: RpcError): boolean {
  const source = requestAnswerSource(body)?.toLowerCase();
  const haystack = `${error.message} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase();
  return source === "smoke_test" || (haystack.includes("smoke") && haystack.includes("routed"));
}

async function notifySmokeTestBlocked(issueId: string, body: AnswerRequest, actor: string, error: RpcError): Promise<void> {
  const writeToken = Deno.env.get("CC_WRITE_TOKEN") ?? "";
  if (!writeToken) return;
  const issue = await loadIssueForAlert(issueId);
  const appId = isRecord(issue) ? asString(issue.app_id) : null;
  const decisionRef = cleanString(body.decision_external_ref, 200) ?? (isRecord(issue) ? asString(issue.source_ref) : null);
  const title = isRecord(issue) ? asString(issue.title) : null;
  const detail = error.details ? ` (${error.details})` : "";
  await fetch(`${CP_URL}/functions/v1/cc-telegram-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cc-write-token": writeToken },
    body: JSON.stringify({
      event_type: "smoke_test_blocked",
      severity: "critical",
      app_id: appId,
      title: "🚨 Smoke-test answer blocked",
      body: `Rejected a smoke-test answer attempt${decisionRef ? ` for decision ${decisionRef}` : ""}${title ? ` (${title})` : ""}. Actor: ${actor}.${detail}`,
      deep_link: "/settings",
    }),
  }).catch(() => undefined);
}

function rpcErrorResponse(e: RpcError, accessCheck: "noop" | "pass"): Response {
  const message = e.message || "issue update failed";

  if (e.code === "P0001") {
    if (message === "issue not found") {
      return buildJsonResponse({ error: message }, 404, accessCheck);
    }
    if (message === "issue is already closed") {
      return buildJsonResponse({ error: message, status: e.details ?? undefined }, 410, accessCheck);
    }
    if (message.startsWith("issue status ")) {
      return buildJsonResponse({ error: message }, 409, accessCheck);
    }
    return buildJsonResponse({ error: message }, 400, accessCheck);
  }

  const detail = e.details ? `${e.code}: ${message} — ${e.details}` : `${e.code}: ${message}`;
  return buildJsonResponse({ error: "issue update failed", detail }, 500, accessCheck);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return buildJsonResponse({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");
  }

  const access = await verifyAccessJwt(
    ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"),
  );
  if (!access.ok) {
    return buildJsonResponse({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);
  }

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return buildJsonResponse({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);

  let parsedJson: unknown;
  try {
    parsedJson = await req.json();
  } catch {
    return buildJsonResponse({ error: "body must be valid JSON" }, 400, access.headerValue);
  }

  const parsed = parseBody(parsedJson);
  if (!parsed.ok) return buildJsonResponse({ error: parsed.error }, 400, access.headerValue);

  const payload = validateActionPayload(parsed.body, parsed.action);
  if (!payload.ok) return buildJsonResponse({ error: payload.error }, 400, access.headerValue);

  try {
    const updatedIssue = await resolveIssueViaRpc({
      issue_id: parsed.issueId,
      action: parsed.action,
      answer_value: payload.answerValue ?? null,
      answer_options_snapshot: parsed.body.answer_options_snapshot ?? null,
      rationale: payload.rationale,
      risk_class: payload.riskClass ?? cleanString(parsed.body.risk_class, 40),
      linked_decision_ref: payload.linkedDecisionRef ?? null,
      actor: access.actor,
      decision_external_ref: cleanString(parsed.body.decision_external_ref, 200),
      answer_source: parsed.action === "answer_decision" ? "operator" : null,
    });

    return buildJsonResponse({ issue: updatedIssue, action: parsed.action }, 200, access.headerValue);
  } catch (e) {
    if (e instanceof RpcError) {
      if (isSmokeTestBlocked(parsed.body, e)) {
        await notifySmokeTestBlocked(parsed.issueId, parsed.body, access.actor, e);
      }
      return rpcErrorResponse(e, access.headerValue);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "issue update failed", detail: msg }, 500, access.headerValue);
  }
});
