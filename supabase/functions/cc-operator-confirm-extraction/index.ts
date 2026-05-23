import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, cleanString, cpAudit, cpGet, cpPatch, json, rpc, verifyAccessJwt, verifyWriteToken } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-operator-confirm-extraction";

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
  const optionId = cleanString((body as Record<string, unknown>)?.option_id, 200);
  const rationale = cleanString((body as Record<string, unknown>)?.rationale, 500);
  if (!sendId || !UUID_RE.test(sendId)) return json({ error: "send_id must be a valid uuid" }, 400, access.headerValue);
  if (!optionId) return json({ error: "option_id is required" }, 400, access.headerValue);

  try {
    const rows = await cpGet(`cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&state=in.(extracting,replied,awaiting_clarify,clarify_sent,awaiting_operator_review)&select=*`);
    const send = rows[0] as Record<string, unknown> | undefined;
    if (!send) return json({ error: "send not found or not reviewable" }, 404, access.headerValue);

    const options = Array.isArray(send.options_snapshot) ? send.options_snapshot : [];
    const optionIds = options
      .map((opt) => (typeof opt === "object" && opt && !Array.isArray(opt) ? (cleanString((opt as Record<string, unknown>).id, 200) ?? cleanString((opt as Record<string, unknown>).value, 200) ?? cleanString((opt as Record<string, unknown>).key, 200)) : null))
      .filter((v): v is string => !!v);
    if (!optionIds.includes(optionId)) return json({ error: "option_id is not valid for this decision" }, 400, access.headerValue);

    const answer = await rpc<Record<string, unknown>>("cc_resolve_issue", {
      issue_id: send.issue_id,
      action: "answer_decision",
      answer_value: optionId,
      answer_options_snapshot: options,
      rationale: rationale ?? `Operator confirmed extraction for ${cleanString(send.recipient_email, 320) ?? "recipient"}`,
      risk_class: send.risk_class,
      actor: access.actor,
      decision_external_ref: send.decision_external_ref,
    });

    const decisionAnswerId = cleanString(answer?.decision_answer_id, 80);
    const workOrder = await rpc<Record<string, unknown>>("cc_enqueue_with_gating", {
      p_app_id: send.app_id,
      p_change_spec: {
        intent: `Apply confirmed extraction answer ${optionId} to decision ${cleanString(send.raw_decision_title, 300) ?? "decision"}.`,
        affected_area: send.decision_external_ref,
        acceptance_criteria: ["Implement the confirmed client choice", "All existing tests pass", "No schema-destructive operations"],
        constraints: ["Single PR", "Branch must start with cc/", "Do not modify CI configuration"],
      },
      p_risk_class: send.risk_class,
      p_idempotency_key: `decision_email_extracted:${sendId}:${optionId}`,
      p_source_answer_id: decisionAnswerId,
      p_actor: access.actor,
    });

    const updated = await cpPatch<Record<string, unknown>>(`cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null`, {
      state: "answered",
      operator_confirmed_by: access.actor,
      operator_confirmed_at: new Date().toISOString(),
      selected_option: optionId,
      answered_at: new Date().toISOString(),
      decision_answer_id: decisionAnswerId,
      claim_token: null,
      extraction_started_at: null,
      last_error: null,
    });

    await cpAudit(cleanString(send.app_id, 80), access.actor, "decision_operator_confirmed", { send_id: sendId, option_id: optionId, source: "extraction" });

    return json({ send: updated[0] ?? send, answer, work_order: workOrder, dispatched: cleanString(workOrder?.status, 40) === "queued" }, 200, access.headerValue);
  } catch (e) {
    return json({ error: "confirm extraction failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});
