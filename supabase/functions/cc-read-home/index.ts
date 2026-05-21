import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jsr:@panva/jose@^6";

// Browser read path for Command Center home payload (§4.11).

const FUNCTION_NAME = "cc-read-home";
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

function buildIntegrations(rows: unknown[]): Record<string, { live: number; demo: number; manual_safe: number; planned: number }> {
  const out: Record<string, { live: number; demo: number; manual_safe: number; planned: number }> = {};
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const appId = asString(row.app_id);
    const status = asString(row.status);
    if (!appId || !status) continue;

    const bucket = (out[appId] ??= { live: 0, demo: 0, manual_safe: 0, planned: 0 });
    if (status === "live" || status === "demo" || status === "manual_safe" || status === "planned") {
      bucket[status] += 1;
    }
  }
  return out;
}

function buildMomentum(rows: unknown[]): Record<string, { shipped_delta: number }> {
  const byApp: Record<string, number[]> = {};

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const appId = asString(row.app_id);
    const roadmapCounts = isRecord(row.roadmap_counts) ? row.roadmap_counts : null;
    const shipped = roadmapCounts ? asNumber(roadmapCounts.shipped) ?? 0 : 0;
    if (!appId) continue;
    (byApp[appId] ??= []).push(shipped);
  }

  const out: Record<string, { shipped_delta: number }> = {};
  for (const [appId, shippedSeries] of Object.entries(byApp)) {
    const current = shippedSeries[0] ?? 0;
    const prior = shippedSeries[1] ?? current;
    out[appId] = { shipped_delta: current - prior };
  }

  return out;
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

  let appsRows: unknown[];
  let integrationRows: unknown[];
  let snapshotRows: unknown[];
  let issueRows: unknown[];
  try {
    [appsRows, integrationRows, snapshotRows, issueRows] = await Promise.all([
      cpGet("v_command_center_home?select=*"),
      cpGet("registry_app_integrations?select=app_id,status"),
      cpGet("registry_app_snapshots?select=app_id,captured_at,roadmap_counts&order=captured_at.desc&limit=200"),
      cpGet("cc_issues?select=id,app_id,issue_type,source_ref,status,severity,title,summary,surfaced_at,last_seen_at,created_at,updated_at&resolved_at=is.null&deleted_at=is.null&status=not.in.(done,dismissed)&order=surfaced_at.desc"),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "database read failed", detail: msg }, 500, access.headerValue);
  }

  const integrationsByApp = buildIntegrations(integrationRows);
  const momentumByApp = buildMomentum(snapshotRows);

  const apps = appsRows.map((row) => {
    const rec = isRecord(row) ? row : {};
    const appId = asString(rec.id) ?? "";
    return {
      ...rec,
      integrations: integrationsByApp[appId] ?? {},
      momentum: momentumByApp[appId] ?? {},
    };
  });

  return buildJsonResponse({
    apps,
    issues: issueRows,
    generated_at: new Date().toISOString(),
  }, 200, access.headerValue);
});
