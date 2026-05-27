import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jsr:@panva/jose@^6";
import { corsHeaders } from "../_shared/phase5.ts";

// Browser read path for app drilldown payload (§4.11).

const FUNCTION_NAME = "cc-read-app";
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


type AccessResult = {
  ok: boolean;
  status: number;
  error?: string;
  headerValue: "noop" | "pass";
};

type VerifyKey = CryptoKey | Uint8Array;
type DataPlaneKeyClass = "readonly" | "service_role" | null;

const jwkCache = new Map<string, VerifyKey>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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

function readSecretPresence(secretRef: unknown): boolean {
  const ref = asString(secretRef)?.trim();
  if (!ref) return false;
  const resolved = Deno.env.get(ref);
  return typeof resolved === "string" && resolved.length > 0;
}

function resolveDataPlaneKeyClass(supabaseRec: Record<string, unknown>): DataPlaneKeyClass {
  if (readSecretPresence(supabaseRec.readonly_secret_ref)) return "readonly";
  if (readSecretPresence(supabaseRec.service_secret_ref)) return "service_role";
  return null;
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
  if (!appId || !isUuid(appId)) {
    return buildJsonResponse({ error: "app_id must be a valid uuid" }, 400, access.headerValue);
  }

  let appRows: unknown[];
  let supabaseRows: unknown[];
  let linearRows: unknown[];
  let repoRows: unknown[];
  let ownerRows: unknown[];
  let decisionRecipientRows: unknown[];
  let integrationRows: unknown[];
  let snapshotRows: unknown[];

  try {
    [
      appRows,
      supabaseRows,
      linearRows,
      repoRows,
      ownerRows,
      decisionRecipientRows,
      integrationRows,
      snapshotRows,
    ] = await Promise.all([
      cpGet(`registry_apps?id=eq.${appId}&deleted_at=is.null&select=*`),
      cpGet(`registry_app_supabase?app_id=eq.${appId}&select=project_ref,project_url,region,snapshot_contract_version,readonly_secret_ref,service_secret_ref&limit=1`),
      cpGet(`registry_app_linear?app_id=eq.${appId}&select=workspace_name,team_key,api_key_ref,webhook_secret_ref,status_map,stream_project_map&limit=1`),
      cpGet(`registry_app_repo?app_id=eq.${appId}&select=github_repo,default_branch,roadmap_doc_path,github_install_id&limit=1`),
      cpGet(`registry_app_owners?app_id=eq.${appId}&select=person_name,person_email,portal_role,is_decision_owner`),
      cpGet(`registry_app_decision_recipients?app_id=eq.${appId}&deleted_at=is.null&select=id,app_id,contact_name,contact_email,contact_role,active,created_at,updated_at&order=contact_name.asc`),
      cpGet(`registry_app_integrations?app_id=eq.${appId}&select=integration_type,status,last_verified_at`),
      cpGet(`registry_app_snapshots?app_id=eq.${appId}&select=*&order=captured_at.desc&limit=1`),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "database read failed", detail: msg }, 500, access.headerValue);
  }

  const app = appRows.find(isRecord);
  if (!app) {
    return buildJsonResponse({ error: "app not found" }, 404, access.headerValue);
  }

  const supabaseRec = supabaseRows.find(isRecord) ?? {};
  const linearRec = linearRows.find(isRecord) ?? {};
  const repoRec = repoRows.find(isRecord) ?? {};
  const latestSnapshot = snapshotRows.find(isRecord) ?? null;

  const owners = ownerRows.filter(isRecord).map((row) => ({
    person_name: asString(row.person_name),
    person_email: asString(row.person_email),
    portal_role: asString(row.portal_role),
    is_decision_owner: row.is_decision_owner === true,
  }));

  const decision_recipients = decisionRecipientRows.filter(isRecord).map((row) => ({
    id: asString(row.id),
    app_id: asString(row.app_id),
    contact_name: asString(row.contact_name),
    contact_email: asString(row.contact_email),
    contact_role: asString(row.contact_role),
    active: row.active === true,
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
  }));

  const integrations = integrationRows.filter(isRecord).map((row) => ({
    integration_type: asString(row.integration_type),
    status: asString(row.status),
    last_verified_at: asString(row.last_verified_at),
  }));

  const dataPlaneKeyClass = resolveDataPlaneKeyClass(supabaseRec);
  const supabase = {
    project_ref: asString(supabaseRec.project_ref),
    project_url: asString(supabaseRec.project_url),
    region: asString(supabaseRec.region),
    snapshot_contract_version: supabaseRec.snapshot_contract_version,
    readonly_secret_ref: asString(supabaseRec.readonly_secret_ref),
    readonly_secret_ref_set: readSecretPresence(supabaseRec.readonly_secret_ref),
    service_secret_ref: asString(supabaseRec.service_secret_ref),
    service_secret_ref_set: readSecretPresence(supabaseRec.service_secret_ref),
    data_plane_key_class: dataPlaneKeyClass,
  };

  const linear = {
    workspace_name: asString(linearRec.workspace_name),
    team_key: asString(linearRec.team_key),
    api_key_ref: asString(linearRec.api_key_ref),
    api_key_ref_set: readSecretPresence(linearRec.api_key_ref),
    webhook_secret_ref: asString(linearRec.webhook_secret_ref),
    webhook_secret_ref_set: readSecretPresence(linearRec.webhook_secret_ref),
    status_map: linearRec.status_map ?? null,
    stream_project_map: linearRec.stream_project_map ?? null,
  };

  const repo = {
    github_repo: asString(repoRec.github_repo),
    default_branch: asString(repoRec.default_branch),
    roadmap_doc_path: asString(repoRec.roadmap_doc_path),
    github_install_id: asString(repoRec.github_install_id),
  };

  return buildJsonResponse({
    app,
    supabase,
    linear,
    repo,
    owners,
    decision_recipients,
    integrations,
    latest_snapshot: latestSnapshot,
    generated_at: new Date().toISOString(),
  }, 200, access.headerValue);
});
