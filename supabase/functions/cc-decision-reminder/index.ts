import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, cleanString, cpAudit, cpGet, cpPatch, encodeRfc2047HeaderValue, escapeHtml, formatCoRecipients, gmailSend, json, rpc, stripHeaderUnsafe, verifyAccessJwt, verifyWriteToken } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-decision-reminder";
const TOGGLE_TOKEN = Deno.env.get("CC_AUTO_ROUTE_TOGGLE_TOKEN") ?? "";
const READ_TOKEN = Deno.env.get("CC_READ_TOKEN") ?? "";
if (TOGGLE_TOKEN && TOGGLE_TOKEN === READ_TOKEN) {
  console.error("[cc-decision-reminder] FATAL: CC_AUTO_ROUTE_TOGGLE_TOKEN must differ from CC_READ_TOKEN");
}
const SENDER = "Brian Lewis <brian.lewis@blackrockai.co>";
const REPLY_TO = "brian.lewis@blackrockai.co";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return json({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);
  if (!TOGGLE_TOKEN || TOGGLE_TOKEN === READ_TOKEN) return json({ error: "operator mutation auth misconfigured" }, 500, access.headerValue);
  if (req.headers.get("x-cc-auto-route-toggle") !== TOGGLE_TOKEN) return json({ error: "missing or invalid x-cc-auto-route-toggle" }, 401, access.headerValue);

  let sent = 0;
  let considered = 0;
  const errors: Array<Record<string, unknown>> = [];

  for (let i = 0; i < 25; i += 1) {
    const row = await rpc<Record<string, unknown> | null>("cc_claim_reminder_task", { p_lease_seconds: 60 });
    if (!row || !cleanString(row.id, 80)) break;
    considered += 1;

    const sendId = cleanString(row.id, 80)!;
    const appId = cleanString(row.app_id, 80);
    const issueId = cleanString(row.issue_id, 80);
    const decisionExternalRef = cleanString(row.decision_external_ref, 200) ?? "";
    const claimToken = cleanString(row.claim_token, 80);
    const recipientEmail = cleanString(row.recipient_email, 320);
    const recipientName = cleanString(row.recipient_name, 160) ?? recipientEmail ?? "there";
    const originalSubject = cleanString(row.rewritten_subject, 300) ?? cleanString(row.raw_decision_title, 300) ?? "Quick question";
    const originalMessageId = cleanString(row.gmail_message_id, 500);
    const reminderAttemptId = cleanString(row.reminder_attempt_id, 80);

    if (!recipientEmail || !claimToken || !originalMessageId || !reminderAttemptId) {
      await releaseClaim(sendId, claimToken);
      continue;
    }

    const subject = `Following up on ${lowerFirst(stripHeaderUnsafe(originalSubject))}`;
    const body = `Hey ${firstName(recipientName)},\n\nJust bubbling this back up — I'm still waiting to hear which way you'd like to go on:\n\n${cleanString(row.raw_decision_title, 500) ?? 'this decision'}\n\nThe buttons in my original email above are still active — just scroll up in this thread and click.\n\nIf now's not a good time, just reply to this thread and I'll handle it on my end.\n\nThanks,\nBrian`;

    const gmailMessageId = `<cc-reminder-${reminderAttemptId}@blackrockai.co>`;

    try {
      const awarenessLine = await siblingAwarenessLine(appId ?? "", decisionExternalRef, sendId);
      const raw = composeMessage({
        sendId,
        toName: recipientName,
        toEmail: recipientEmail,
        subject,
        body: appendSiblingAwareness(body, awarenessLine),
        inReplyTo: originalMessageId,
        references: originalMessageId,
        messageId: gmailMessageId,
      });
      const gmail = await gmailSend(raw);

      const updated = await cpPatch<Record<string, unknown>>(
        `cc_decision_email_sends?id=eq.${sendId}&claim_token=eq.${claimToken}&state=in.(sent,delivered,opened,clicked)&replied_at=is.null`,
        {
          state: "reminded",
          reminded_at: new Date().toISOString(),
          reminder_gmail_message_id: gmailMessageId,
          claim_token: null,
          lease_expires_at: null,
          reminder_started_at: null,
        },
      );

      if (updated.length !== 1) {
        await cpAudit(appId, FUNCTION_NAME, "decision_reminder_post_send_drift", {
          send_id: sendId,
          issue_id: issueId,
          gmail_message_id: gmailMessageId,
        });
        const cleaned = await cpPatch<Record<string, unknown>>(
          `cc_decision_email_sends?id=eq.${sendId}&claim_token=eq.${claimToken}`,
          {
            claim_token: null,
            reminder_started_at: null,
            lease_expires_at: null,
          },
        );
        await cpAudit(appId, FUNCTION_NAME, "decision_reminder_drift_cleanup", {
          send_id: sendId,
          issue_id: issueId,
          cleaned: cleaned.length === 1,
        });
        continue;
      }

      await cpAudit(appId, FUNCTION_NAME, "decision_reminder_sent", {
        send_id: sendId,
        issue_id: issueId,
        recipient_email: recipientEmail,
        gmail_message_id: gmailMessageId,
      });
      sent += 1;
    } catch (e) {
      await releaseClaim(sendId, claimToken);
      errors.push({ send_id: sendId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return json({ ok: true, sent, considered, errors }, 200, access.headerValue);
});

async function releaseClaim(sendId: string, claimToken: string | null): Promise<void> {
  if (!claimToken) return;
  await cpPatch(
    `cc_decision_email_sends?id=eq.${sendId}&claim_token=eq.${claimToken}`,
    {
      claim_token: null,
      lease_expires_at: null,
      reminder_started_at: null,
      reminder_attempt_id: null,
    },
  );
}

async function siblingAwarenessLine(appId: string, decisionExternalRef: string, currentSendId: string): Promise<string | null> {
  if (!appId || !decisionExternalRef) return null;
  const rows = await cpGet(`cc_decision_email_sends?app_id=eq.${appId}&decision_external_ref=eq.${encodeURIComponent(decisionExternalRef)}&id=neq.${currentSendId}&deleted_at=is.null&select=recipient_name,recipient_email`);
  return formatCoRecipients(rows);
}

function appendSiblingAwareness(body: string, line: string | null): string {
  return line ? `${body}\n\n${line}` : body;
}


function composeMessage(input: { sendId: string; toName: string; toEmail: string; subject: string; body: string; inReplyTo: string; references: string; messageId: string }): string {
  const boundary = `cc_${crypto.randomUUID()}`;
  const to = input.toName && input.toName !== input.toEmail ? `"${stripHeaderUnsafe(input.toName).replaceAll('"', "'")}" <${input.toEmail}>` : input.toEmail;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.5;color:#111827;max-width:640px"><p>${escapeHtml(input.body).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p></div>`;

  return [
    `From: ${SENDER}`,
    `To: ${to}`,
    `Reply-To: ${REPLY_TO}`,
    `Subject: ${encodeRfc2047HeaderValue(input.subject)}`,
    `Message-ID: ${input.messageId}`,
    `In-Reply-To: ${stripHeaderUnsafe(input.inReplyTo)}`,
    `References: ${stripHeaderUnsafe(input.references)}`,
    `X-CC-Send-Id: ${input.sendId}`,
    "X-CC-Reminder: 1",
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
  ].join("\r\n");
}

function firstName(value: string): string {
  const s = cleanString(value, 160) ?? "there";
  return s.split(/\s+/)[0] ?? "there";
}

function lowerFirst(value: string): string {
  const s = value.trim();
  if (!s) return "quick question";
  return s.charAt(0).toLowerCase() + s.slice(1);
}
