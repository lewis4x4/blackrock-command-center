import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jsr:@panva/jose@^6";

// Browser read path for cc_artifacts — the first §4.11 surface.
// The browser does NOT hold a Supabase key. It calls THIS function over HTTPS.
// This function:
//   1. Verifies the Cloudflare Access JWT (when CC_ACCESS_REQUIRED=true; otherwise a documented no-op).
//   2. Reads cc_artifacts with the control-plane SERVICE_ROLE key, server-side.
//   3. Returns exactly the shape the Files surface needs — no over-fetch, no raw table access from the browser.
// When Security Track S1 lands, flip CC_ACCESS_REQUIRED=true and remove no other code.

const CP_URL = Deno.env.get("SUPABASE_URL")!;
const CP_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ACCESS_REQUIRED = (Deno.env.get("CC_ACCESS_REQUIRED") ?? "false") === "true";
const ACCESS_TEAM_DOMAIN = Deno.env.get("CC_ACCESS_TEAM_DOMAIN") ?? "";
const ACCESS_AUD = Deno.env.get("CC_ACCESS_AUD") ?? "";

if (!ACCESS_REQUIRED) {
  console.log("cc-read-artifacts: CC_ACCESS_REQUIRED=false; Cloudflare Access JWT verification is currently a no-op.");
}

const cpHeaders = {
  apikey: CP_KEY,
  Authorization: `Bearer ${CP_KEY}`,
  "Content-Type": "application/json",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Cf-Access-Jwt-Assertion",
};

type CursorToken = { last_indexed_at: string; id: string };

type AccessResult = {
  ok: boolean;
  status: number;
  error?: string;
  headerValue: "noop" | "pass";
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function decodeCursor(raw: string): CursorToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(raw));
  } catch {
    throw new Error("cursor is not valid base64 JSON");
  }

  if (!parsed || typeof parsed !== "object") throw new Error("cursor payload must be an object");
  const p = parsed as Record<string, unknown>;
  const lastIndexedAt = typeof p.last_indexed_at === "string" ? p.last_indexed_at : "";
  const id = typeof p.id === "string" ? p.id : "";

  if (!lastIndexedAt || Number.isNaN(Date.parse(lastIndexedAt))) {
    throw new Error("cursor.last_indexed_at must be a valid ISO timestamp");
  }
  if (!isUuid(id)) throw new Error("cursor.id must be a valid uuid");

  return { last_indexed_at: lastIndexedAt, id };
}

function encodeCursor(c: CursorToken): string {
  return btoa(JSON.stringify(c));
}

async function cpGet(path: string): Promise<any[]> {
  const r = await fetch(`${CP_URL}/rest/v1/${path}`, { headers: cpHeaders });
  if (!r.ok) throw new Error(`control-plane GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
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

async function verifyAccessJwt(assertion: string | null): Promise<AccessResult> {
  if (!ACCESS_REQUIRED) return { ok: true, status: 200, headerValue: "noop" };

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

    const verified = await jwtVerify(assertion, key, {
      audience: ACCESS_AUD,
    });

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
  if (raw == null || raw === "") return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new Error("limit must be an integer between 1 and 200");
  }
  return n;
}

function parseFilters(req: Request, body: Record<string, unknown> | null): {
  q: string | null;
  kind: string | null;
  app_id: string | null;
  source: string | null;
  limit: number;
  cursor: CursorToken | null;
} {
  const url = new URL(req.url);

  const readString = (key: string): string | null => {
    const bodyVal = body?.[key];
    if (typeof bodyVal === "string") return bodyVal;
    const qs = url.searchParams.get(key);
    return qs;
  };

  const q = readString("q");
  const kind = readString("kind");
  const app_id = readString("app_id");
  const source = readString("source");

  if (app_id && !isUuid(app_id)) throw new Error("app_id must be a valid uuid");

  const limit = parseLimit(readString("limit"));

  const rawCursor = readString("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;

  return {
    q: q && q.trim() ? q.trim() : null,
    kind: kind && kind.trim() ? kind.trim() : null,
    app_id: app_id && app_id.trim() ? app_id.trim() : null,
    source: source && source.trim() ? source.trim() : null,
    limit,
    cursor,
  };
}

function buildQuery(filters: {
  q: string | null;
  kind: string | null;
  app_id: string | null;
  source: string | null;
  limit: number;
  cursor: CursorToken | null;
}): string {
  const params = new URLSearchParams();

  params.set(
    "select",
    "id,app_id,kind,title,path,url,source,summary,byte_size,produced_by,content_sha,discovered_at,last_indexed_at",
  );
  params.append("deleted_at", "is.null");
  params.append("order", "last_indexed_at.desc");
  params.append("order", "id.desc");
  params.set("limit", String(filters.limit + 1));

  if (filters.kind) params.append("kind", `eq.${filters.kind}`);
  if (filters.app_id) params.append("app_id", `eq.${filters.app_id}`);
  if (filters.source) params.append("source", `eq.${filters.source}`);

  if (filters.q) {
    const escaped = filters.q.replaceAll("*", "\\*");
    params.append("or", `(title.ilike.*${escaped}*,path.ilike.*${escaped}*,summary.ilike.*${escaped}*)`);
  }

  if (filters.cursor) {
    // Keyset pagination predicate on (last_indexed_at DESC, id DESC):
    // fetch rows strictly "after" the current cursor in descending order.
    params.append(
      "or",
      `(last_indexed_at.lt.${filters.cursor.last_indexed_at},and(last_indexed_at.eq.${filters.cursor.last_indexed_at},id.lt.${filters.cursor.id}))`,
    );
  }

  return `cc_artifacts?${params.toString()}`;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return buildJsonResponse({ error: "GET, POST, or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");
  }

  let body: Record<string, unknown> | null = null;
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      return buildJsonResponse({ error: "invalid JSON body" }, 400, ACCESS_REQUIRED ? "pass" : "noop");
    }
  }

  const access = await verifyAccessJwt(req.headers.get("Cf-Access-Jwt-Assertion"));
  if (!access.ok) {
    return buildJsonResponse({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);
  }

  let filters;
  try {
    filters = parseFilters(req, body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: msg }, 400, access.headerValue);
  }

  let rows: any[];
  try {
    rows = await cpGet(buildQuery(filters));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildJsonResponse({ error: "database read failed", detail: msg }, 500, access.headerValue);
  }

  const hasMore = rows.length > filters.limit;
  const pageItems = hasMore ? rows.slice(0, filters.limit) : rows;

  const tail = pageItems.at(-1);
  const nextCursor = hasMore && tail
    ? encodeCursor({ last_indexed_at: tail.last_indexed_at, id: tail.id })
    : null;

  return buildJsonResponse(
    {
      items: pageItems,
      cursor: {
        next: nextCursor,
        has_more: hasMore,
      },
      generated_at: new Date().toISOString(),
      filters: {
        q: filters.q,
        kind: filters.kind,
        app_id: filters.app_id,
        source: filters.source,
        limit: filters.limit,
      },
    },
    200,
    access.headerValue,
  );
});
