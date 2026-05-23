import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, asString, cpGet, isRecord, json, verifyAccessJwt } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-read-handoffs";

console.log(`[${FUNCTION_NAME}] ready`);

const responseHeaders = {
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

const severityRank: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function nestedRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return value.find(isRecord) ?? null;
  return isRecord(value) ? value : null;
}

function normalizeHandoff(row: unknown): Record<string, unknown> {
  const rec = isRecord(row) ? row : {};
  const app = nestedRecord(rec.registry_apps);
  const { registry_apps: _registryApps, ...rest } = rec;
  void _registryApps;
  return {
    ...rest,
    app: {
      id: asString(rec.app_id),
      short_code: app ? asString(app.short_code) : null,
      display_name: app ? asString(app.display_name) : null,
    },
  };
}

function compareHandoffs(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const severityA = severityRank[asString(a.severity) ?? ""] ?? 99;
  const severityB = severityRank[asString(b.severity) ?? ""] ?? 99;
  if (severityA !== severityB) return severityA - severityB;
  return (asString(a.created_at) ?? "").localeCompare(asString(b.created_at) ?? "");
}

const handoffSelect = [
  "id", "app_id", "kind", "work_order_id", "issue_id", "runbook_md", "status", "created_at",
  "acknowledged_at", "completed_at", "severity", "deleted_at",
  "registry_apps(short_code,display_name)",
].join(",");

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200, "noop", responseHeaders);
  if (req.method !== "GET") return json({ error: "GET or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop", responseHeaders);

  const access = await verifyAccessJwt(
    ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"),
  );
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue, responseHeaders);

  const url = new URL(req.url);
  const appId = url.searchParams.get("app_id")?.trim() ?? "";
  if (appId && !UUID_RE.test(appId)) return json({ error: "app_id must be a valid uuid" }, 400, access.headerValue, responseHeaders);

  const appFilter = appId ? `&app_id=eq.${appId}` : "";
  const path = `cc_operator_handoffs?select=${handoffSelect}&deleted_at=is.null&status=eq.open${appFilter}&order=severity.desc&order=created_at.asc`;

  try {
    const rows = await cpGet(path);
    const handoffs = rows.map(normalizeHandoff).sort(compareHandoffs);
    return json({ handoffs, generated_at: new Date().toISOString() }, 200, access.headerValue, responseHeaders);
  } catch (e) {
    return json({ error: "database read failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue, responseHeaders);
  }
});
