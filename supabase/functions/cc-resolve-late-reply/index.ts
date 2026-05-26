import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, asString, cleanString, cpAudit, cpGet, cpPatch, isRecord, json, verifyAccessJwt, verifyWriteToken } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-resolve-late-reply";
const ACTIONS = new Set(["apply", "dismiss"]);

type LateReplyAction = "apply" | "dismiss";

console.log(`[${FUNCTION_NAME}] ready`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return json({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, access.headerValue); }
  if (!isRecord(body)) return json({ error: "body must be a JSON object" }, 400, access.headerValue);

  const issueId = cleanString(body.issue_id, 80);
  const action = cleanString(body.action, 20) as LateReplyAction | null;
  if (!issueId || !UUID_RE.test(issueId)) return json({ error: "issue_id must be a valid uuid" }, 400, access.headerValue);
  if (!action || !ACTIONS.has(action)) return json({ error: "action must be one of apply, dismiss" }, 400, access.headerValue);

  try {
    const rows = await cpGet(`cc_issues?id=eq.${issueId}&issue_type=eq.late_reply&deleted_at=is.null&select=id,app_id,source_ref,status,severity,title,summary,detail,context&limit=1`);
    const issue = rows.find(isRecord);
    if (!issue) return json({ error: "late reply issue not found" }, 404, access.headerValue);

    const status = asString(issue.status);
    if (status === "answered" || status === "done" || status === "dismissed") {
      return json({ error: "late reply issue is already closed", status }, 410, access.headerValue);
    }
    if (status !== "surfaced" && status !== "triaging") {
      return json({ error: `late reply issue status ${status ?? "unknown"} cannot be resolved` }, 409, access.headerValue);
    }

    const now = new Date().toISOString();
    const context = isRecord(issue.context) ? issue.context : {};
    const nextStatus = action === "apply" ? "answered" : "dismissed";
    const eventType = action === "apply" ? "late_reply_applied_as_answer" : "late_reply_dismissed_as_noise";
    const resolution = {
      late_reply_resolution: action,
      late_reply_resolved_at: now,
      late_reply_resolved_by: access.actor,
    };

    const updated = await cpPatch<Record<string, unknown>>(`cc_issues?id=eq.${issueId}&issue_type=eq.late_reply&deleted_at=is.null`, {
      status: nextStatus,
      resolved_at: now,
      context: { ...context, ...resolution },
    });
    const updatedIssue = updated[0] ?? issue;

    await cpAudit(cleanString(issue.app_id, 80), access.actor, eventType, {
      issue_id: issueId,
      send_id: cleanString(issue.source_ref, 80),
      original_decision_ref: isRecord(issue.detail) ? asString(issue.detail.original_decision_ref) : null,
      action,
    });

    return json({ issue: updatedIssue, action }, 200, access.headerValue);
  } catch (e) {
    return json({ error: "late reply resolution failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});
