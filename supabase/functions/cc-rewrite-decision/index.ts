import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, cleanString, cpGet, cpInsert, isRecord, json, randomToken, verifyAccessJwt, UUID_RE, verifyWriteToken } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-rewrite-decision";
const TOKEN_PLACEHOLDER_PREFIX = "rewrite-placeholder:";
const DEFAULT_EXPIRY_DAYS = 7;

console.log(`[${FUNCTION_NAME}] ready`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return json({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);

  if (req.method === "GET") {
    const sendId = new URL(req.url).searchParams.get("send_id")?.trim() ?? "";
    if (!UUID_RE.test(sendId)) return json({ error: "send_id must be a valid uuid" }, 400, access.headerValue);
    try {
      const rows = await cpGet(`cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&select=*`);
      const send = rows.find(isRecord);
      if (!send) return json({ error: "send not found" }, 404, access.headerValue);
      return json({ send }, 200, access.headerValue);
    } catch (e) {
      return json({ error: "send read failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
    }
  }

  if (req.method !== "POST") return json({ error: "GET, POST, or OPTIONS only" }, 405, access.headerValue);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, access.headerValue); }
  if (!isRecord(body)) return json({ error: "body must be a JSON object" }, 400, access.headerValue);

  const issueId = cleanString(body.issue_id, 80);
  const appId = cleanString(body.app_id, 80);
  const decisionExternalRef = cleanString(body.decision_external_ref, 200) ?? cleanString(body.id, 200) ?? "decision";
  const rawTitle = cleanString(body.raw_title, 500) ?? cleanString(body.title, 500);
  const rawBody = cleanString(body.raw_body, 5000) ?? cleanString(body.summary, 5000) ?? null;
  const riskClass = cleanString(body.risk_class, 40) ?? "authorize";
  const options = Array.isArray(body.options) ? body.options : [];

  if (!issueId || !UUID_RE.test(issueId)) return json({ error: "issue_id must be a valid uuid" }, 400, access.headerValue);
  if (!appId || !UUID_RE.test(appId)) return json({ error: "app_id must be a valid uuid" }, 400, access.headerValue);
  if (!rawTitle) return json({ error: "raw_title is required" }, 400, access.headerValue);
  if (!Array.isArray(options)) return json({ error: "options must be an array (use [] when the decision has no enumerated options)" }, 400, access.headerValue);
  if (!["auto", "authorize", "destructive", "production"].includes(riskClass)) return json({ error: "risk_class must be auto, authorize, destructive, or production" }, 400, access.headerValue);

  // Empty options array is allowed: the AI rewrite step will suggest options
  // (Mac Studio Claude) and the operator approves/edits before send.
  const normalizedOptions = options.map((item) => normalizeOption(item)).filter((item): item is Record<string, string> => !!item);

  try {
    const issues = await cpGet(`cc_issues?id=eq.${issueId}&deleted_at=is.null&select=id,app_id,status,source_ref,issue_type,detail`);
    const issue = issues.find(isRecord);
    if (!issue) return json({ error: "issue not found" }, 404, access.headerValue);
    if (cleanString(issue.app_id, 80) !== appId) return json({ error: "issue does not belong to app_id" }, 400, access.headerValue);
    const status = cleanString(issue.status, 40);
    // Routable from: surfaced (untriaged), triaging (operator looking at it),
    // routed_to_client (already routed — allow re-route / retry), and
    // answered (operator answered internally but wants client confirmation).
    // The act of routing to recipients is itself an explicit operator decision
    // that overrides any prior internal-answer classification.
    if (!status || !["surfaced", "triaging", "routed_to_client", "answered"].includes(status)) return json({ error: `issue status ${status ?? "unknown"} is not routable` }, 400, access.headerValue);
    const sourceRef = cleanString(issue.source_ref, 200);
    if (sourceRef && !["aggregate", "build", "sync", "blocked"].includes(sourceRef) && sourceRef !== decisionExternalRef) {
      return json({ error: "decision_external_ref does not match issue source_ref" }, 400, access.headerValue);
    }
    const trustedOptionIds = optionIdsFromUnknown(issue.detail);
    if (trustedOptionIds.size > 0 && normalizedOptions.some((option) => !trustedOptionIds.has(option.id))) {
      return json({ error: "options include ids that are not present on the issue detail snapshot" }, 400, access.headerValue);
    }

    const rows = await cpInsert<Record<string, unknown>>("cc_decision_email_sends", {
      issue_id: issueId,
      app_id: appId,
      decision_external_ref: decisionExternalRef,
      recipient_email: "rewrite-preview@blackrockai.co",
      recipient_name: "Rewrite preview",
      raw_decision_title: rawTitle,
      raw_decision_body: rawBody,
      options_snapshot: normalizedOptions,
      risk_class: riskClass,
      magic_link_token_hash: `${TOKEN_PLACEHOLDER_PREFIX}${randomToken(16)}`,
      magic_link_expires_at: new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86_400_000).toISOString(),
      state: "rewriting",
      max_attempts: 3,
    });
    const send = rows[0];
    if (!send?.id) throw new Error("insert returned no send id");
    return json({ rewrite_task_id: send.id, send }, 200, access.headerValue);
  } catch (e) {
    return json({ error: "rewrite task create failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});

function optionIdsFromUnknown(value: unknown): Set<string> {
  const out = new Set<string>();
  collectOptionIds(value, out, 0);
  return out;
}

function collectOptionIds(value: unknown, out: Set<string>, depth: number): void {
  if (depth > 4 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      const option = normalizeOption(item);
      if (option) out.add(option.id);
      else collectOptionIds(item, out, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ["options", "answer_options", "choices", "allowed_answers", "decision_options"]) {
    if (key in value) collectOptionIds(value[key], out, depth + 1);
  }
}

function normalizeOption(item: unknown): Record<string, string> | null {
  if (typeof item === "string") {
    const id = item.trim();
    return id ? { id, label: id } : null;
  }
  if (!isRecord(item)) return null;
  const id = cleanString(item.id, 200) ?? cleanString(item.value, 200) ?? cleanString(item.key, 200);
  if (!id) return null;
  const label = cleanString(item.label, 300) ?? cleanString(item.name, 300) ?? cleanString(item.title, 300) ?? id;
  return { id, label };
}
