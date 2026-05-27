import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, CP_KEY, UUID_RE, cleanString, cpAudit, cpGet, cpPatch, encodeRfc2047HeaderValue, escapeHtml, formatCoRecipients, gmailSend, isRecord, json, stripHeaderUnsafe, verifyWriteToken } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-notify-co-recipients";
const SENDER = "Brian Lewis <brian.lewis@blackrockai.co>";
const REPLY_TO = "brian.lewis@blackrockai.co";
const COCKPIT_DECISIONS_URL = Deno.env.get("CC_COCKPIT_DECISIONS_URL") ?? "https://blackrockai.co/decisions";

const ACTIVE_SEND_STATES = ["sent", "delivered", "opened", "clicked", "reminded", "awaiting_clarify", "clarify_sent"];

type NotifyPayload = {
  issue_id: string;
  decision_external_ref: string;
  answer_id: string;
  app_id: string;
};

console.log(`[${FUNCTION_NAME}] ready`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const auth = verifyCaller(req);
  if (!auth.ok) return json({ error: auth.error ?? "unauthorized" }, auth.status, auth.headerValue);

  let rawBody: unknown;
  try { rawBody = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, auth.headerValue); }
  const parsed = parsePayload(rawBody);
  if (!parsed.ok) return json({ error: parsed.error }, 400, auth.headerValue);

  const errors: Array<Record<string, unknown>> = [];
  let notified = 0;
  let superseded = 0;

  try {
    const answer = await loadAnswer(parsed.payload);
    if (!answer) return json({ error: "decision answer not found" }, 404, auth.headerValue);

    const answeredSend = await loadAnsweredSend(parsed.payload);
    const answerer = displayAnswerer(answeredSend, answer);
    const answerValue = cleanString(answer.answer_value, 200) ?? "the selected option";
    const answerDisplay = optionDisplay(answeredSend?.options_snapshot ?? answer.answer_options_snapshot, answerValue);
    const question = cleanString(answeredSend?.raw_decision_title, 500) ?? await loadIssueTitle(parsed.payload.issue_id) ?? "this decision";
    const answeredAt = cleanString(answer.answered_at, 80) ?? cleanString(answeredSend?.answered_at, 80) ?? new Date().toISOString();
    const rationale = cleanString(answer.rationale, 500);

    const remaining = await loadRemainingSends(parsed.payload);
    for (const send of remaining) {
      const sendId = cleanString(send.id, 80);
      const recipientEmail = cleanString(send.recipient_email, 320);
      const recipientName = cleanString(send.recipient_name, 160) ?? recipientEmail;
      if (!sendId || !recipientEmail || !recipientName) continue;

      try {
        const siblingRows = await cpGet(`cc_decision_email_sends?app_id=eq.${parsed.payload.app_id}&decision_external_ref=eq.${encodeURIComponent(parsed.payload.decision_external_ref)}&id=neq.${sendId}&deleted_at=is.null&select=recipient_name,recipient_email`);
        const awarenessLine = formatCoRecipients(siblingRows);
        const body = composeBody({ answerer, answerDisplay, question, answeredAt, rationale, awarenessLine });
        const subjectQuestion = stripHeaderUnsafe(question).slice(0, 120) || "decision";
        const subject = `FYI — ${subjectQuestion}: ${answerer} answered`;
        const messageId = `<cc-co-${sendId}-${parsed.payload.answer_id}@blackrockai.co>`;
        const originalMessageId = cleanString(send.gmail_message_id, 500);
        const raw = composeMessage({
          sendId,
          toName: recipientName,
          toEmail: recipientEmail,
          subject,
          body,
          messageId,
          inReplyTo: originalMessageId,
          references: originalMessageId,
        });
        const gmail = await gmailSend(raw);
        notified += 1;

        const updated = await cpPatch<Record<string, unknown>>(
          `cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&state=in.(${ACTIVE_SEND_STATES.join(",")})`,
          {
            state: "superseded",
            superseded_at: new Date().toISOString(),
            decision_answer_id: parsed.payload.answer_id,
            claim_token: null,
            lease_expires_at: null,
            reminder_started_at: null,
            clarification_started_at: null,
            extraction_started_at: null,
            last_error: null,
          },
        );
        if (updated.length === 1) superseded += 1;
        else {
          await cpAudit(parsed.payload.app_id, FUNCTION_NAME, "co_recipient_notify_supersede_drift", {
            send_id: sendId,
            issue_id: parsed.payload.issue_id,
            decision_external_ref: parsed.payload.decision_external_ref,
            answer_id: parsed.payload.answer_id,
            gmail_message_id: gmail.id,
          });
        }

        await cpAudit(parsed.payload.app_id, FUNCTION_NAME, "co_recipient_notified", {
          send_id: sendId,
          issue_id: parsed.payload.issue_id,
          decision_external_ref: parsed.payload.decision_external_ref,
          answer_id: parsed.payload.answer_id,
          recipient_email: recipientEmail,
          gmail_message_id: gmail.id,
          superseded: updated.length === 1,
        });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        errors.push({ send_id: sendId, recipient_email: recipientEmail, error });
        await auditFailure(parsed.payload, { send_id: sendId, recipient_email: recipientEmail, error });
      }
    }

    return json({ ok: true, notified, superseded, considered: remaining.length, errors }, 200, auth.headerValue);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await auditFailure(parsed.payload, { error });
    return json({ ok: false, error: "co-recipient notify failed", detail: error, notified, superseded, errors }, 500, auth.headerValue);
  }
});

function verifyCaller(req: Request): { ok: true; status: 200; headerValue: "noop" | "pass" } | { ok: false; status: number; error?: string; headerValue: "noop" | "pass" } {
  const auth = req.headers.get("Authorization") ?? "";
  if (CP_KEY && auth === `Bearer ${CP_KEY}`) return { ok: true, status: 200, headerValue: ACCESS_REQUIRED ? "pass" : "noop" };
  const writeAuth = verifyWriteToken(req);
  if (writeAuth.ok) return { ok: true, status: 200, headerValue: ACCESS_REQUIRED ? "pass" : "noop" };
  return { ok: false, status: writeAuth.status, error: writeAuth.error, headerValue: ACCESS_REQUIRED ? "pass" : "noop" };
}

function parsePayload(value: unknown): { ok: true; payload: NotifyPayload } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "body must be a JSON object" };
  const issueId = cleanString(value.issue_id, 80);
  const decisionExternalRef = cleanString(value.decision_external_ref, 200);
  const answerId = cleanString(value.answer_id, 80);
  const appId = cleanString(value.app_id, 80);
  if (!issueId || !UUID_RE.test(issueId)) return { ok: false, error: "issue_id must be a valid uuid" };
  if (!decisionExternalRef) return { ok: false, error: "decision_external_ref is required" };
  if (!answerId || !UUID_RE.test(answerId)) return { ok: false, error: "answer_id must be a valid uuid" };
  if (!appId || !UUID_RE.test(appId)) return { ok: false, error: "app_id must be a valid uuid" };
  return { ok: true, payload: { issue_id: issueId, decision_external_ref: decisionExternalRef, answer_id: answerId, app_id: appId } };
}

async function loadAnswer(payload: NotifyPayload): Promise<Record<string, unknown> | null> {
  const rows = await cpGet(`cc_decision_answers?id=eq.${payload.answer_id}&app_id=eq.${payload.app_id}&issue_id=eq.${payload.issue_id}&decision_external_ref=eq.${encodeURIComponent(payload.decision_external_ref)}&deleted_at=is.null&select=id,issue_id,app_id,decision_external_ref,answer_value,answer_options_snapshot,rationale,risk_class,answered_by,answered_at`);
  return rows.find(isRecord) ?? null;
}

async function loadAnsweredSend(payload: NotifyPayload): Promise<Record<string, unknown> | null> {
  const rows = await cpGet(`cc_decision_email_sends?app_id=eq.${payload.app_id}&decision_external_ref=eq.${encodeURIComponent(payload.decision_external_ref)}&decision_answer_id=eq.${payload.answer_id}&deleted_at=is.null&select=id,recipient_name,recipient_email,raw_decision_title,raw_decision_body,options_snapshot,gmail_message_id,gmail_thread_id,selected_option,answered_at&order=answered_at.desc.nullslast,updated_at.desc&limit=1`);
  return rows.find(isRecord) ?? null;
}

async function loadRemainingSends(payload: NotifyPayload): Promise<Record<string, unknown>[]> {
  const rows = await cpGet(`cc_decision_email_sends?app_id=eq.${payload.app_id}&decision_external_ref=eq.${encodeURIComponent(payload.decision_external_ref)}&deleted_at=is.null&state=in.(${ACTIVE_SEND_STATES.join(",")})&select=id,recipient_name,recipient_email,gmail_message_id,gmail_thread_id,state`);
  return rows.filter(isRecord);
}

async function loadIssueTitle(issueId: string): Promise<string | null> {
  const rows = await cpGet(`cc_issues?id=eq.${issueId}&deleted_at=is.null&select=title,summary&limit=1`);
  const issue = rows.find(isRecord);
  return cleanString(issue?.title, 500) ?? cleanString(issue?.summary, 500);
}

function displayAnswerer(send: Record<string, unknown> | null, answer: Record<string, unknown>): string {
  return cleanString(send?.recipient_name, 160)
    ?? cleanString(send?.recipient_email, 320)
    ?? cleanString(answer.answered_by, 160)
    ?? "A co-recipient";
}

function optionDisplay(options: unknown, value: string): string {
  const label = optionLabel(options, value);
  return label ?? value;
}

function optionLabel(options: unknown, value: string): string | null {
  const rows = Array.isArray(options) ? options : [];
  for (const row of rows) {
    if (typeof row === "string" && row === value) return row;
    if (!isRecord(row)) continue;
    const id = cleanString(row.id, 200) ?? cleanString(row.value, 200) ?? cleanString(row.key, 200);
    if (id !== value) continue;
    return cleanString(row.label, 300) ?? cleanString(row.name, 300) ?? cleanString(row.title, 300) ?? id;
  }
  return null;
}

function composeBody(input: { answerer: string; answerDisplay: string; question: string; answeredAt: string; rationale: string | null; awarenessLine: string | null }): string {
  const lines = [
    `${input.answerer} answered "${input.answerDisplay}" on the question about ${lowerFirst(input.question)} at ${formatAnswerTime(input.answeredAt)}.`,
  ];
  if (input.rationale) lines.push(`Rationale: ${input.rationale}`);
  lines.push(`${input.awarenessLine ? `${input.awarenessLine} ` : ""}Disagree? Reply to this email or view the thread in the cockpit: ${COCKPIT_DECISIONS_URL}`);
  return lines.join("\n\n");
}

function composeMessage(input: { sendId: string; toName: string; toEmail: string; subject: string; body: string; messageId: string; inReplyTo: string | null; references: string | null }): string {
  const boundary = `cc_${crypto.randomUUID()}`;
  const to = input.toName && input.toName !== input.toEmail ? `${quoteName(input.toName)} <${input.toEmail}>` : input.toEmail;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.5;color:#111827;max-width:640px"><p>${escapeHtml(input.body).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p></div>`;
  const headers = [
    `From: ${SENDER}`,
    `To: ${to}`,
    `Reply-To: ${REPLY_TO}`,
    `Subject: ${encodeRfc2047HeaderValue(input.subject)}`,
    `Message-ID: ${input.messageId}`,
  ];
  if (input.inReplyTo) headers.push(`In-Reply-To: ${stripHeaderUnsafe(input.inReplyTo)}`);
  if (input.references) headers.push(`References: ${stripHeaderUnsafe(input.references)}`);
  headers.push(
    `X-CC-Send-Id: ${input.sendId}`,
    "X-CC-Co-Recipient-Notify: 1",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "",
    `--${boundary}--`,
    "",
  );
  return headers.join("\r\n");
}

function formatAnswerTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "recently";
  const nowParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const key = (parts: Intl.DateTimeFormatPart[]) => `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(d);
  return key(nowParts) === key(dateParts) ? `${time} today` : `${time} on ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(d)}`;
}

function lowerFirst(value: string): string {
  const s = value.trim();
  if (!s) return "this decision";
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function quoteName(name: string): string {
  return `"${stripHeaderUnsafe(name).replaceAll('"', "'")}"`;
}

async function auditFailure(payload: NotifyPayload, detail: Record<string, unknown>): Promise<void> {
  console.log(`[${FUNCTION_NAME}] failed`, detail);
  try {
    await cpAudit(payload.app_id, FUNCTION_NAME, "co_recipient_notify_failed", {
      issue_id: payload.issue_id,
      decision_external_ref: payload.decision_external_ref,
      answer_id: payload.answer_id,
      ...detail,
    });
  } catch (auditError) {
    console.log(`[${FUNCTION_NAME}] audit failed`, auditError instanceof Error ? auditError.message : String(auditError));
  }
}
