import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  ACCESS_REQUIRED,
  UUID_RE,
  asString,
  cleanString,
  cpAudit,
  cpGet,
  cpPatch,
  isRecord,
  json,
  verifyAccessJwt,
  verifyWriteToken,
} from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-acknowledge-handoff";

type HandoffStatus = "acknowledged" | "done";

console.log(`[${FUNCTION_NAME}] ready`);

const responseHeaders = {
  "Access-Control-Allow-Methods": "POST,OPTIONS",
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

const handoffSelect = [
  "id", "app_id", "kind", "work_order_id", "issue_id", "runbook_md", "status", "created_at",
  "acknowledged_at", "completed_at", "severity", "deleted_at",
  "registry_apps(short_code,display_name)",
].join(",");

async function loadHandoff(handoffId: string): Promise<Record<string, unknown> | null> {
  const rows = await cpGet(`cc_operator_handoffs?select=${handoffSelect}&id=eq.${handoffId}&deleted_at=is.null&limit=1`);
  const row = rows.find(isRecord);
  return row ? normalizeHandoff(row) : null;
}

function parseBody(value: unknown): { ok: true; handoffId: string; status: HandoffStatus; note: string | null } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "body must be a JSON object" };
  const handoffId = cleanString(value.handoff_id, 80);
  const status = cleanString(value.status, 32);
  const note = cleanString(value.note, 1000);
  if (!handoffId || !UUID_RE.test(handoffId)) return { ok: false, error: "handoff_id must be a valid uuid" };
  if (status !== "acknowledged" && status !== "done") return { ok: false, error: "status must be 'acknowledged' or 'done'" };
  return { ok: true, handoffId, status, note };
}

function auditDetail(handoff: Record<string, unknown>, previousStatus: string | null, status: HandoffStatus, note: string | null): Record<string, unknown> {
  return {
    handoff_id: asString(handoff.id),
    previous_status: previousStatus,
    status,
    kind: asString(handoff.kind),
    work_order_id: asString(handoff.work_order_id),
    issue_id: asString(handoff.issue_id),
    ...(note ? { note } : {}),
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return json({ ok: true }, 200, "noop", responseHeaders);
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop", responseHeaders);

  const access = await verifyAccessJwt(
    ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"),
  );
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue, responseHeaders);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return json({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue, responseHeaders);

  let parsedJson: unknown;
  try { parsedJson = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, access.headerValue, responseHeaders); }
  const parsed = parseBody(parsedJson);
  if (!parsed.ok) return json({ error: parsed.error }, 400, access.headerValue, responseHeaders);

  try {
    const before = await loadHandoff(parsed.handoffId);
    if (!before) return json({ error: "handoff not found" }, 404, access.headerValue, responseHeaders);

    const previousStatus = asString(before.status);
    const now = new Date().toISOString();
    const patch = parsed.status === "acknowledged"
      ? { status: "acknowledged", acknowledged_at: asString(before.acknowledged_at) ?? now }
      : { status: "done", acknowledged_at: asString(before.acknowledged_at) ?? now, completed_at: now };
    const statusFilter = parsed.status === "acknowledged" ? "status=eq.open" : "status=in.(open,acknowledged)";
    const patched = await cpPatch<Record<string, unknown>>(
      `cc_operator_handoffs?id=eq.${parsed.handoffId}&deleted_at=is.null&${statusFilter}`,
      patch,
    );

    if (patched.length === 0) {
      const current = await loadHandoff(parsed.handoffId);
      if (!current) return json({ error: "handoff not found" }, 404, access.headerValue, responseHeaders);
      return json({ handoff: current, idempotent: true }, 200, access.headerValue, responseHeaders);
    }

    const handoff = await loadHandoff(parsed.handoffId) ?? normalizeHandoff(patched[0]);
    await cpAudit(
      asString(handoff.app_id),
      access.actor,
      parsed.status === "acknowledged" ? "handoff_acknowledged" : "handoff_completed",
      auditDetail(handoff, previousStatus, parsed.status, parsed.note),
    );
    return json({ handoff }, 200, access.headerValue, responseHeaders);
  } catch (e) {
    return json({ error: "handoff update failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue, responseHeaders);
  }
});
