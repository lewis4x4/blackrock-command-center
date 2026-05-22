import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from "jsr:@panva/jose@^6";

// Browser read path for Settings. Federated: reads control-plane config/observability only.
// Secret values never cross this function boundary; only pointer names + presence booleans are returned.

const FUNCTION_NAME = "cc-read-settings";
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

const INTEGRATION_STATUSES = ["live", "demo", "manual_safe", "planned"] as const;
type IntegrationStatus = typeof INTEGRATION_STATUSES[number];
type SecretColumn = "service_secret_ref" | "readonly_secret_ref" | "api_key_ref" | "webhook_secret_ref" | "vault";
type AuthMode = "access_jwt" | "read_token";
type VerifyKey = CryptoKey | Uint8Array;

type AccessResult = {
  ok: boolean;
  status: number;
  error?: string;
  headerValue: "noop" | "pass";
  authMode: AuthMode;
  actor: string;
  email: string | null;
};

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

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return value.find(isRecord) ?? null;
  return isRecord(value) ? value : null;
}

async function cpGet(path: string, profile?: string): Promise<unknown[]> {
  const headers = profile ? { ...cpHeaders, "Accept-Profile": profile } : cpHeaders;
  const r = await fetch(`${CP_URL}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`control-plane GET ${profile ? `${profile}.` : ""}${path} -> ${r.status} ${await r.text()}`);
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

function operatorFromPayload(payload: JWTPayload): { actor: string; email: string | null } {
  const email = typeof payload.email === "string" ? payload.email : null;
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  return { actor: email ?? sub ?? "access-jwt", email };
}

async function sha256Prefix(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyReadTokenHeader(presented: string | null): Promise<AccessResult> {
  if (!CC_READ_TOKEN) {
    return { ok: false, status: 401, error: "read token not configured", headerValue: "noop", authMode: "read_token", actor: "unknown", email: null };
  }
  if (!presented || presented !== CC_READ_TOKEN) {
    return { ok: false, status: 401, error: "missing or invalid x-cc-read-token", headerValue: "noop", authMode: "read_token", actor: "unknown", email: null };
  }
  return { ok: true, status: 200, headerValue: "noop", authMode: "read_token", actor: `read-token:${await sha256Prefix(presented)}`, email: null };
}

async function verifyAccessJwt(assertion: string | null): Promise<AccessResult> {
  if (!ACCESS_REQUIRED) return verifyReadTokenHeader(assertion);

  if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUD) {
    return { ok: false, status: 500, error: "CC_ACCESS_TEAM_DOMAIN and CC_ACCESS_AUD are required when CC_ACCESS_REQUIRED=true", headerValue: "pass", authMode: "access_jwt", actor: "unknown", email: null };
  }

  if (!assertion) return { ok: false, status: 401, error: "missing Cf-Access-Jwt-Assertion", headerValue: "pass", authMode: "access_jwt", actor: "unknown", email: null };

  try {
    const { kid } = decodeProtectedHeader(assertion);
    if (!kid) return { ok: false, status: 401, error: "JWT header missing kid", headerValue: "pass", authMode: "access_jwt", actor: "unknown", email: null };

    let key = jwkCache.get(kid);
    if (!key) {
      await loadJwksIntoCache(ACCESS_TEAM_DOMAIN);
      key = jwkCache.get(kid);
    }
    if (!key) return { ok: false, status: 401, error: "no matching JWKS key for token kid", headerValue: "pass", authMode: "access_jwt", actor: "unknown", email: null };

    const verified = await jwtVerify(assertion, key, { audience: ACCESS_AUD });
    const aud = verified.payload.aud;
    const audValues = Array.isArray(aud) ? aud : (typeof aud === "string" ? [aud] : []);
    if (!audValues.includes(ACCESS_AUD)) {
      return { ok: false, status: 401, error: "token audience is invalid", headerValue: "pass", authMode: "access_jwt", actor: "unknown", email: null };
    }

    const operator = operatorFromPayload(verified.payload);
    return { ok: true, status: 200, headerValue: "pass", authMode: "access_jwt", actor: operator.actor, email: operator.email };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 401, error: `access JWT verification failed: ${msg}`, headerValue: "pass", authMode: "access_jwt", actor: "unknown", email: null };
  }
}

function readSecretPresence(secretRef: unknown): boolean {
  const ref = asString(secretRef)?.trim();
  if (!ref) return false;
  const resolved = Deno.env.get(ref);
  return typeof resolved === "string" && resolved.length > 0;
}

function cronNextEta(schedule: string | null): string | null {
  if (!schedule) return null;
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parts[0];
  const every = minute === "*" ? 1 : minute.match(/^\*\/(\d{1,2})$/)?.[1];
  const interval = every ? Number(every) : null;
  if (!interval || interval < 1 || interval > 59) return null;
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  const currentMinute = next.getMinutes();
  const nextMinute = Math.floor(currentMinute / interval) * interval + interval;
  if (nextMinute >= 60) {
    next.setHours(next.getHours() + 1, nextMinute % 60, 0, 0);
  } else {
    next.setMinutes(nextMinute, 0, 0);
  }
  return next.toISOString();
}

function integrationStatus(value: unknown): IntegrationStatus | null {
  const raw = asString(value);
  return INTEGRATION_STATUSES.includes(raw as IntegrationStatus) ? raw as IntegrationStatus : null;
}

function buildIntegrations(rows: unknown[], appsById: Map<string, { short_code: string; display_name: string }>) {
  const totals: Record<IntegrationStatus, number> = { live: 0, demo: 0, manual_safe: 0, planned: 0 };
  const byApp = new Map<string, { app_id: string; app_short_code: string; app_display_name: string; integrations: unknown[] }>();

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const appId = asString(row.app_id);
    const app = appId ? appsById.get(appId) : null;
    const status = integrationStatus(row.status);
    if (!appId || !app || !status) continue;
    totals[status] += 1;
    const entry = byApp.get(appId) ?? { app_id: appId, app_short_code: app.short_code, app_display_name: app.display_name, integrations: [] };
    entry.integrations.push({
      type: asString(row.integration_type),
      status,
      last_verified_at: asString(row.last_verified_at),
    });
    byApp.set(appId, entry);
  }

  return {
    totals,
    by_app: [...byApp.values()].sort((a, b) => a.app_short_code.localeCompare(b.app_short_code)),
  };
}

function collectSecretRefs(rows: unknown[], appsById: Map<string, { short_code: string }>, columns: SecretColumn[]) {
  const refs: { ref_name: string; is_set: boolean; app_short_code: string | null; column: SecretColumn }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const appId = asString(row.app_id);
    const app = appId ? appsById.get(appId) : null;
    if (!app) continue;
    for (const column of columns) {
      const refName = asString(row[column])?.trim();
      if (!refName) continue;
      refs.push({ ref_name: refName, is_set: readSecretPresence(refName), app_short_code: app.short_code, column });
    }
  }
  return refs;
}

async function readVaultSecretPresence(name: string): Promise<boolean | null> {
  try {
    const rows = await cpGet(`decrypted_secrets?select=name&name=eq.${encodeURIComponent(name)}&limit=1`, "vault");
    return rows.some((row) => isRecord(row) && asString(row.name) === name);
  } catch {
    const envFallback = Deno.env.get(name) ?? Deno.env.get(name.toUpperCase());
    return typeof envFallback === "string" ? envFallback.length > 0 : null;
  }
}

async function readCronJob(): Promise<Record<string, unknown> | null> {
  const query = "job?select=jobname,schedule,active&jobname=like.cc-aggregator*&limit=1";
  try {
    const rows = await cpGet(query, "cron");
    return rows.find(isRecord) ?? null;
  } catch {
    try {
      const rows = await cpGet(`cron.${query}`);
      return rows.find(isRecord) ?? null;
    } catch {
      return null;
    }
  }
}

function normalizeAudit(row: unknown) {
  const rec = isRecord(row) ? row : {};
  const registry = nestedRecord(rec.registry_apps);
  return {
    occurred_at: asString(rec.occurred_at),
    actor: asString(rec.actor),
    event_type: asString(rec.event_type),
    detail: isRecord(rec.detail) ? rec.detail : null,
    app_id: asString(rec.app_id),
    short_code: registry ? asString(registry.short_code) : null,
    app_name: registry ? asString(registry.display_name) ?? asString(registry.short_code) : null,
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

  let appsRows: unknown[];
  let supabaseRows: unknown[];
  let linearRows: unknown[];
  let integrationRows: unknown[];
  let latestSnapshotRows: unknown[];
  let auditPreviewRows: unknown[];
  let cronJob: Record<string, unknown> | null;
  let aggregatorTokenSet: boolean | null;

  try {
    [appsRows, supabaseRows, linearRows, integrationRows, latestSnapshotRows, auditPreviewRows, cronJob, aggregatorTokenSet] = await Promise.all([
      cpGet("registry_apps?select=id,short_code,display_name&deleted_at=is.null&order=short_code.asc"),
      cpGet("registry_app_supabase?select=app_id,service_secret_ref,readonly_secret_ref"),
      cpGet("registry_app_linear?select=app_id,api_key_ref,webhook_secret_ref"),
      cpGet("registry_app_integrations?select=app_id,integration_type,status,last_verified_at&order=app_id.asc"),
      cpGet("cc_audit_events?select=occurred_at&event_type=eq.snapshot_captured&order=occurred_at.desc&limit=1"),
      cpGet("cc_audit_events?select=occurred_at,actor,event_type,detail,app_id,registry_apps(short_code,display_name)&event_type=not.in.(detail_read,agents_page_read,decisions_page_read,settings_page_read,secret_read)&order=occurred_at.desc&limit=10"),
      readCronJob(),
      readVaultSecretPresence("aggregator_token"),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "database read failed", detail: msg }, 500, access.headerValue);
  }

  const appsById = new Map<string, { short_code: string; display_name: string }>();
  for (const row of appsRows) {
    if (!isRecord(row)) continue;
    const id = asString(row.id);
    const shortCode = asString(row.short_code);
    const displayName = asString(row.display_name) ?? shortCode;
    if (id && shortCode && displayName) appsById.set(id, { short_code: shortCode, display_name: displayName });
  }

  const schedule = asString(cronJob?.schedule) ?? "*/5 * * * *";
  const lastSuccessfulAt = asString((latestSnapshotRows.find(isRecord) ?? {}).occurred_at);
  const secrets = [
    ...collectSecretRefs(supabaseRows, appsById, ["service_secret_ref", "readonly_secret_ref"]),
    ...collectSecretRefs(linearRows, appsById, ["api_key_ref", "webhook_secret_ref"]),
    { ref_name: "aggregator_token", is_set: aggregatorTokenSet === true, app_short_code: null, column: "vault" as const },
  ].sort((a, b) => (a.app_short_code ?? "GLOBAL").localeCompare(b.app_short_code ?? "GLOBAL") || a.column.localeCompare(b.column));

  const payload = {
    account: {
      auth_mode: access.authMode,
      actor: access.actor,
      email: access.email,
    },
    aggregator: {
      jobname: asString(cronJob?.jobname) ?? "cc-aggregator-5min",
      schedule,
      active: asBoolean(cronJob?.active),
      last_successful_at: lastSuccessfulAt,
      next_eta_at: cronNextEta(schedule),
    },
    integrations: buildIntegrations(integrationRows, appsById),
    secrets,
    audit_preview: auditPreviewRows.map(normalizeAudit),
    generated_at: new Date().toISOString(),
  };

  try {
    await cpInsert("cc_audit_events", {
      app_id: null,
      actor: access.actor,
      event_type: "settings_page_read",
      detail: {
        auth_mode: access.authMode,
        integration_rows: integrationRows.length,
        secret_refs: secrets.length,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "audit write failed", detail: msg }, 500, access.headerValue);
  }

  return buildJsonResponse(payload, 200, access.headerValue);
});
