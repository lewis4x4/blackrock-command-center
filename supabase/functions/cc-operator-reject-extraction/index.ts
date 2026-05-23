import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, cleanString, cpAudit, cpGet, cpPatch, json, verifyAccessJwt, verifyWriteToken } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-operator-reject-extraction";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");
  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return json({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, access.headerValue); }
  const sendId = cleanString((body as Record<string, unknown>)?.send_id, 80);
  const reason = cleanString((body as Record<string, unknown>)?.reason, 500);
  if (!sendId || !UUID_RE.test(sendId)) return json({ error: "send_id must be a valid uuid" }, 400, access.headerValue);
  if (!reason) return json({ error: "reason is required" }, 400, access.headerValue);

  try {
    const rows = await cpGet(`cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&state=in.(extracting,replied,awaiting_clarify,clarify_sent,awaiting_operator_review)&select=*`);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return json({ error: "send not found or not reviewable" }, 404, access.headerValue);

    const updated = await cpPatch<Record<string, unknown>>(`cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null`, {
      state: "rejected_by_operator",
      operator_confirmed_by: access.actor,
      operator_confirmed_at: new Date().toISOString(),
      last_error: reason,
      claim_token: null,
      extraction_started_at: null,
    });

    await cpAudit(cleanString(row.app_id, 80), access.actor, "decision_extraction_rejected", {
      send_id: sendId,
      reason,
      recipient_email: cleanString(row.recipient_email, 320),
    });

    return json({ send: updated[0] ?? row }, 200, access.headerValue);
  } catch (e) {
    return json({ error: "reject extraction failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});
