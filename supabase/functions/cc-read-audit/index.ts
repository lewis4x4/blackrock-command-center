import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jsr:@panva/jose@^6";

// Browser read path for audit feed payload (§4.11).

const FUNCTION_NAME = "cc-read-audit";
const CP_URL = Deno.env.get("SUPABASE_URL")!;
const CP_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ACCESS_REQUIRED = (Deno.env.get("CC_ACCESS_REQUIRED") ?? "false") === "true";
const ACCESS_TEAM_DOMAIN = Deno.env.get("CC_ACCESS_TEAM_DOMAIN") ?? "";
const ACCESS_AUD = Deno.env.get("CC_ACCESS_AUD") ?? "";
const CC_READ_TOKEN = Deno.env.get("CC_READ_TOKEN") ?? "";

if (ACCESS_REQUIRED) {
  console.log(`[${FUNCTION_NAME}] Cloudflare Access verification ENABLED (production-ready §4.11)`);
} else if (CC_READ_TOKEN) {
  console.log(`[${FUNCTION_NAME}] Cloudflare Access verification DISABLED — falling back to x-cc-read-token (S1 not yet in front; READ-ONLY scope)`);
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

// Source of truth (frontend): web/src/lib.ts LATELY_VISIBLE_EVENT_TYPES
const HIDDEN_OPERATOR_NOISE_EVENT_TYPES: readonly string[] = [
  "detail_read",
  "agents_page_read",
  "decisions_page_read",
  "settings_page_read",
  "secret_read",
];

const LATELY_VISIBLE_EVENT_TYPES: readonly string[] = [
  "snapshot_captured",
  "snapshot_failed",
  "app_provisioned",
  "app_updated",
  "decision_answered",
  "issue_resolved",
  "decision_rewrite_ready",
  "decision_routed",
  "decision_answered_by_recipient",
  "decision_email_bounced",
  "decision_reply_received",
  "work_order_created",
  "work_order_gated",
  "pr_opened",
  "work_order_failed",
  "work_order_dead_lettered",
  "agent_dispatched",
  "agent_finished",
  "agent_failed",
  "agent_run_long",
  "pr_ready",
  "verification_failed",
  "cost_ceiling_hit",
  "runner_offline",
  "handoff_created",
  "artifact_index_failed",
];

type CursorToken = { occurred_at: string; id: number };

type LatelyMapping = {
  visible: boolean;
  sentence: string | null;
  tone: "plain" | "needs" | "failure";
};

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
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function eventAppName(registry: Record<string, unknown> | null): string {
  const displayName = registry ? asString(registry.display_name) : null;
  const shortCode = registry ? asString(registry.short_code) : null;
  return displayName ?? shortCode ?? "an app";
}

function latelyMapping(eventType: string | null, registry: Record<string, unknown> | null): LatelyMapping {
  const app = eventAppName(registry);
  switch (eventType) {
    case "work_order_created":
      return { visible: true, sentence: `You sent a build task to ${app}.`, tone: "plain" };
    case "work_order_gated":
      return { visible: true, sentence: `A work order needs your approval on ${app}.`, tone: "needs" };
    case "work_order_claimed":
    case "work_order_approved":
      return { visible: false, sentence: null, tone: "plain" };
    case "app_updated":
      return { visible: true, sentence: `${app}'s registry basics were updated.`, tone: "plain" };
    case "decision_rewrite_ready":
      return { visible: true, sentence: `A client decision email for ${app} is ready for review.`, tone: "needs" };
    case "decision_answered_by_recipient":
      return { visible: true, sentence: `A recipient confirmed a decision on ${app}.`, tone: "plain" };
    case "decision_email_bounced":
      return { visible: true, sentence: `A decision email for ${app} bounced.`, tone: "failure" };
    case "pr_opened":
      return { visible: true, sentence: `${app} has a PR ready for review.`, tone: "plain" };
    case "work_order_failed":
    case "work_order_dead_lettered":
      return { visible: true, sentence: `${app} build failed — needs a look.`, tone: "failure" };
    case "work_order_lease_expired":
    case "agents_page_read":
    case "decisions_page_read":
    case "settings_page_read":
      return { visible: false, sentence: null, tone: "plain" };
    default:
      return { visible: LATELY_VISIBLE_EVENT_TYPES.includes(eventType ?? ""), sentence: null, tone: "plain" };
  }
}

function encodeCursor(c: CursorToken): string {
  return btoa(JSON.stringify(c));
}

function decodeCursor(raw: string): CursorToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(raw));
  } catch {
    throw new Error("cursor is not valid base64 JSON");
  }

  if (!isRecord(parsed)) throw new Error("cursor payload must be an object");
  const occurredAt = asString(parsed.occurred_at) ?? "";
  const id = asNumber(parsed.id);

  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    throw new Error("cursor.occurred_at must be a valid ISO timestamp");
  }
  if (id == null || !Number.isInteger(id)) {
    throw new Error("cursor.id must be an integer");
  }

  return { occurred_at: occurredAt, id };
}

async function cpGet(path: string): Promise<unknown[]> {
  const r = await fetch(`${CP_URL}/rest/v1/${path}`, { headers: cpHeaders });
  if (!r.ok) throw new Error(`control-plane GET ${path} -> ${r.status} ${await r.text()}`);
  return asArray(await r.json());
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

function parseLimit(raw: string | null): number {
  if (raw == null || raw === "") return 20;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  return n;
}

function parseBooleanParam(raw: string | null, name: string, defaultValue = false): boolean {
  if (raw == null || raw === "") return defaultValue;
  const lower = raw.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parseLatelyOnly(raw: string | null): boolean {
  return parseBooleanParam(raw, "lately_only", false);
}

function parseEventType(raw: string | null): string | null {
  if (raw == null || raw.trim() === "") return null;
  const value = raw.trim();
  if (!/^[a-z0-9_:-]{1,80}$/i.test(value)) throw new Error("event_type contains unsupported characters");
  return value;
}

function parseAppId(raw: string | null): string | null {
  if (raw == null || raw.trim() === "") return null;
  const value = raw.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("app_id must be a valid uuid");
  }
  return value;
}

function parseSinceDate(raw: string | null): string | null {
  if (raw == null || raw.trim() === "") return null;
  const value = raw.trim();
  if (Number.isNaN(Date.parse(value))) throw new Error("since_date must be a valid date or timestamp");
  return value;
}

function buildQuery(limit: number, cursor: CursorToken | null, latelyOnly: boolean, filters: { appId: string | null; eventType: string | null; sinceDate: string | null; hideOperatorNoise: boolean }): string {
  const params = new URLSearchParams();
  params.set("select", "occurred_at,actor,event_type,detail,app_id,id,registry_apps(short_code,display_name)");
  params.append("order", "occurred_at.desc");
  params.append("order", "id.desc");
  params.set("limit", String(limit + 1));

  if (latelyOnly) {
    params.append("event_type", `in.(${LATELY_VISIBLE_EVENT_TYPES.join(",")})`);
    // §5.9 invariant: exclude green snapshots from Lately mode.
    params.append("or", "(event_type.neq.snapshot_captured,detail->>build_status.neq.green)");
  }

  if (filters.appId) params.append("app_id", `eq.${filters.appId}`);
  if (filters.eventType) params.append("event_type", `eq.${filters.eventType}`);
  else if (filters.hideOperatorNoise) params.append("event_type", `not.in.(${HIDDEN_OPERATOR_NOISE_EVENT_TYPES.join(",")})`);
  if (filters.sinceDate) params.append("occurred_at", `gte.${filters.sinceDate}`);

  if (cursor) {
    params.append("or", `(occurred_at.lt.${cursor.occurred_at},and(occurred_at.eq.${cursor.occurred_at},id.lt.${cursor.id}))`);
  }

  return `cc_audit_events?${params.toString()}`;
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

  let limit = 20;
  let latelyOnly = false;
  let cursor: CursorToken | null = null;
  let appId: string | null = null;
  let eventType: string | null = null;
  let sinceDate: string | null = null;
  let hideOperatorNoise = false;
  try {
    const url = new URL(req.url);
    limit = parseLimit(url.searchParams.get("limit"));
    latelyOnly = parseLatelyOnly(url.searchParams.get("lately_only"));
    hideOperatorNoise = parseBooleanParam(url.searchParams.get("hide_operator_noise"), "hide_operator_noise", false);
    appId = parseAppId(url.searchParams.get("app_id"));
    eventType = parseEventType(url.searchParams.get("event_type"));
    sinceDate = parseSinceDate(url.searchParams.get("since_date"));
    const rawCursor = url.searchParams.get("cursor");
    cursor = rawCursor ? decodeCursor(rawCursor) : null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: msg }, 400, access.headerValue);
  }

  let rows: unknown[];
  try {
    rows = await cpGet(buildQuery(limit, cursor, latelyOnly, { appId, eventType, sinceDate, hideOperatorNoise }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "database read failed", detail: msg }, 500, access.headerValue);
  }

  const hasMore = rows.length > limit;
  const pageItems = hasMore ? rows.slice(0, limit) : rows;

  const events = pageItems.map((row) => {
    const rec = isRecord(row) ? row : {};
    const registry = Array.isArray(rec.registry_apps)
      ? rec.registry_apps.find(isRecord)
      : (isRecord(rec.registry_apps) ? rec.registry_apps : null);

    const registryRecord = registry ?? null;
    const eventType = asString(rec.event_type);
    const mapping = latelyMapping(eventType, registryRecord);

    return {
      occurred_at: asString(rec.occurred_at),
      actor: asString(rec.actor),
      event_type: eventType,
      detail: isRecord(rec.detail) ? rec.detail : null,
      app_id: asString(rec.app_id),
      short_code: registry ? asString(registry.short_code) : null,
      app_name: eventAppName(registryRecord),
      lately: mapping,
      id: asNumber(rec.id),
    };
  });

  const tail = events.at(-1);
  const next = hasMore && tail?.occurred_at && typeof tail.id === "number"
    ? encodeCursor({ occurred_at: tail.occurred_at, id: tail.id })
    : null;

  const eventOutput = events.map(({ id, ...rest }) => rest);

  return buildJsonResponse({
    events: eventOutput,
    cursor: {
      next,
      has_more: hasMore,
    },
    generated_at: new Date().toISOString(),
    filters: {
      lately_only: latelyOnly,
      limit,
      app_id: appId,
      event_type: eventType,
      since_date: sinceDate,
      hide_operator_noise: hideOperatorNoise,
    },
  }, 200, access.headerValue);
});
