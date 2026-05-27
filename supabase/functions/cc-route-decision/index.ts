import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, cleanString, cpAudit, cpGet, cpInsert, cpPatch, encodeRfc2047HeaderValue, escapeHtml, formatCoRecipients, gmailSend, hmacSha256Hex, isRecord, json, randomToken, stripHeaderUnsafe, verifyAccessJwt, UUID_RE, verifyWriteToken } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-route-decision";
const MAGIC_SECRET = Deno.env.get("CC_MAGIC_LINK_SECRET") ?? "";
const PUBLIC_BASE_URL = (Deno.env.get("CC_PUBLIC_DECISION_BASE_URL") ?? "https://blackrockai-command-center.netlify.app").replace(/\/+$/, "");
const SENDER = "Brian Lewis <brian.lewis@blackrockai.co>";
const REPLY_TO = "brian.lewis@blackrockai.co";

console.log(`[${FUNCTION_NAME}] ready`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");
  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return json({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);
  if (!MAGIC_SECRET) return json({ error: "CC_MAGIC_LINK_SECRET is not configured" }, 500, access.headerValue);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, access.headerValue); }
  if (!isRecord(body)) return json({ error: "body must be a JSON object" }, 400, access.headerValue);

  const sendId = cleanString(body.send_id, 80);
  const recipientIds = Array.isArray(body.recipient_ids) ? body.recipient_ids.map((v) => cleanString(v, 80)).filter((v): v is string => !!v && UUID_RE.test(v)) : [];
  const approvedSubject = cleanString(body.approved_subject, 300);
  const approvedBody = cleanString(body.approved_body, 8000);
  const approvedOptions = Array.isArray(body.approved_options) ? body.approved_options.map(normalizeOption).filter((v): v is Option => !!v) : [];
  if (!sendId || !UUID_RE.test(sendId)) return json({ error: "send_id must be a valid uuid" }, 400, access.headerValue);
  if (recipientIds.length === 0) return json({ error: "recipient_ids must include at least one recipient uuid" }, 400, access.headerValue);
  if (!approvedSubject || !approvedBody) return json({ error: "approved_subject and approved_body are required" }, 400, access.headerValue);
  if (approvedOptions.length === 0) return json({ error: "approved_options must include at least one option" }, 400, access.headerValue);

  try {
    const sendRows = await cpGet(`cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&state=eq.rewrite_ready&select=*`);
    const existingSend = sendRows.find(isRecord);
    if (!existingSend) return json({ error: "rewrite-ready send not found" }, 404, access.headerValue);

    const existingCreatedVia = cleanString(existingSend.created_via, 40);
    const existingClaimToken = cleanString(existingSend.claim_token, 80);
    if (existingCreatedVia === "auto_route" && existingClaimToken) {
      return json({ error: "auto-route finalize currently owns this send" }, 409, access.headerValue);
    }

    let baseSend = existingSend;
    if (existingCreatedVia === "auto_route") {
      const takeover = await cpPatch<Record<string, unknown>>(
        `cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&state=eq.rewrite_ready&created_via=eq.auto_route&claim_token=is.null`,
        { created_via: "manual", claim_token: null },
      );
      if (takeover.length !== 1) {
        return json({ error: "send became unavailable for manual takeover" }, 409, access.headerValue);
      }
      baseSend = takeover[0];
    }

    const appId = cleanString(baseSend.app_id, 80)!;
    const issueId = cleanString(baseSend.issue_id, 80)!;
    const decisionExternalRef = cleanString(baseSend.decision_external_ref, 200)!;

    const recipientRows = await cpGet(`registry_app_decision_recipients?app_id=eq.${appId}&id=in.(${recipientIds.join(",")})&active=eq.true&deleted_at=is.null&select=*`);
    const recipients = recipientRows.filter(isRecord);
    if (recipients.length !== recipientIds.length) return json({ error: "one or more recipients are inactive, deleted, or not bound to this app" }, 400, access.headerValue);

    const storedOptions = approvedOptions.map((option) => ({ id: option.id, label: option.label }));
    const prepared: Array<{
      perSendId: string;
      recipientId: string;
      recipientEmail: string;
      recipientName: string;
      tokenized: Tokenized;
      messageId: string;
    }> = [];
    for (let i = 0; i < recipients.length; i += 1) {
      const recipient = recipients[i];
      const recipientId = cleanString(recipient.id, 80)!;
      const recipientEmail = cleanString(recipient.contact_email, 320)!;
      const recipientName = cleanString(recipient.contact_name, 160) ?? recipientEmail;
      const perSend = i === 0 ? baseSend : await cloneSend(baseSend);
      const perSendId = cleanString(perSend.id, 80)!;
      const tokenized = await tokenizedOptions(storedOptions, perSendId);
      const messageId = `<cc-${perSendId}@blackrockai.co>`;
      await cpPatch<Record<string, unknown>>(`cc_decision_email_sends?id=eq.${perSendId}`, {
        recipient_id: recipientId,
        recipient_email: recipientEmail,
        recipient_name: recipientName,
        rewritten_subject: approvedSubject,
        rewritten_body: approvedBody,
        rewrite_approved_by: access.actor,
        rewrite_approved_at: new Date().toISOString(),
        options_snapshot: storedOptions,
        magic_link_tokens: tokenized.tokenRecords,
        magic_link_token_hash: tokenized.firstHash,
        magic_link_expires_at: tokenized.expiresAt,
        gmail_message_id: messageId,
        last_error: null,
        created_via: "manual",
      });
      prepared.push({ perSendId, recipientId, recipientEmail, recipientName, tokenized, messageId });
    }

    const sent: Record<string, unknown>[] = [];
    for (const item of prepared) {
      const awarenessLine = await siblingAwarenessLine(appId, decisionExternalRef, item.perSendId);
      const raw = composeMessage({
        sendId: item.perSendId,
        toName: item.recipientName,
        toEmail: item.recipientEmail,
        subject: approvedSubject,
        body: appendSiblingAwareness(approvedBody, awarenessLine),
        options: item.tokenized.options,
        messageId: item.messageId,
      });
      const gmail = await gmailSend(raw);
      const updatedRows = await cpPatch<Record<string, unknown>>(`cc_decision_email_sends?id=eq.${item.perSendId}`, {
        gmail_thread_id: gmail.threadId ?? gmail.id,
        state: "sent",
        sent_at: new Date().toISOString(),
      });
      const updated = updatedRows[0];
      sent.push(updated);
      await cpAudit(appId, access.actor, "decision_routed", {
        send_id: item.perSendId,
        issue_id: issueId,
        recipient_id: item.recipientId,
        owner_name: item.recipientName,
        owner_email: item.recipientEmail,
        gmail_id: gmail.id,
        gmail_thread_id: gmail.threadId ?? null,
      });
    }

    const issueRows = await cpPatch<Record<string, unknown>>(`cc_issues?id=eq.${issueId}&deleted_at=is.null`, {
      status: "routed_to_client",
      resolved_at: new Date().toISOString(),
    });
    if (issueRows.length !== 1) {
      await cpAudit(appId, access.actor, "decision_route_issue_transition_failed", { issue_id: issueId, sent_count: sent.length });
      throw new Error("decision email sent, but issue transition to routed_to_client failed");
    }
    return json({ sent }, 200, access.headerValue);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: "decision route failed", detail: msg }, 500, access.headerValue);
  }
});

type Option = { id: string; label: string };

type Tokenized = { options: Array<Option & { confirm_url: string }>; tokenRecords: Array<{ option_id: string; token_hash: string }>; firstHash: string; expiresAt: string };

async function cloneSend(base: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = await cpInsert<Record<string, unknown>>("cc_decision_email_sends", {
    issue_id: base.issue_id,
    app_id: base.app_id,
    decision_external_ref: base.decision_external_ref,
    recipient_email: "pending@blackrockai.co",
    recipient_name: "Pending recipient",
    raw_decision_title: base.raw_decision_title,
    raw_decision_body: base.raw_decision_body,
    rewritten_subject: base.rewritten_subject,
    rewritten_body: base.rewritten_body,
    options_snapshot: base.options_snapshot,
    risk_class: base.risk_class,
    magic_link_token_hash: `route-placeholder:${randomToken(16)}`,
    magic_link_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    state: "rewrite_ready",
    max_attempts: base.max_attempts ?? 3,
    created_via: "manual",
  });
  const row = rows[0];
  if (!row?.id) throw new Error("send clone returned no id");
  return row;
}

async function tokenizedOptions(options: Option[], sendId: string): Promise<Tokenized> {
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const out: Array<Option & { confirm_url: string }> = [];
  const records: Array<{ option_id: string; token_hash: string }> = [];
  for (const option of options) {
    const raw = randomToken(32);
    const tokenHash = await hmacSha256Hex(MAGIC_SECRET, `${sendId}:${option.id}:${raw}`);
    const confirmUrl = `${PUBLIC_BASE_URL}/c/${encodeURIComponent(raw)}?s=${encodeURIComponent(sendId)}&o=${encodeURIComponent(option.id)}`;
    out.push({ ...option, confirm_url: confirmUrl });
    records.push({ option_id: option.id, token_hash: tokenHash });
  }
  return { options: out, tokenRecords: records, firstHash: records[0].token_hash, expiresAt };
}

function composeMessage(input: { sendId: string; toName: string; toEmail: string; subject: string; body: string; options: Array<Option & { confirm_url: string }>; messageId: string }): string {
  const boundary = `cc_${crypto.randomUUID()}`;
  const plainOptions = input.options.map((option, index) => `${index + 1}. ${option.label}\n${option.confirm_url}`).join("\n\n");
  const plain = `${input.body}\n\n${plainOptions}\n\nOr reply to this email if you want to talk it through.\n\nThanks,\nBrian`;
  const buttons = input.options.map((option) => `<p><a href="${escapeHtml(option.confirm_url)}" style="display:inline-block;background:#7C6FF0;color:#fff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:700">${escapeHtml(option.label)}</a></p>`).join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.5;color:#111827;max-width:640px"><p>${escapeHtml(input.body).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>${buttons}<p>Or reply to this email if you want to talk it through.</p><p>Thanks,<br>Brian</p></div>`;
  const to = input.toName && input.toName !== input.toEmail ? `${quoteName(input.toName)} <${input.toEmail}>` : input.toEmail;
  return [
    `From: ${SENDER}`,
    `To: ${to}`,
    `Reply-To: ${REPLY_TO}`,
    `Subject: ${encodeRfc2047HeaderValue(input.subject)}`,
    `Message-ID: ${input.messageId}`,
    `X-CC-Send-Id: ${input.sendId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plain,
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

async function siblingAwarenessLine(appId: string, decisionExternalRef: string, currentSendId: string): Promise<string | null> {
  const rows = await cpGet(`cc_decision_email_sends?app_id=eq.${appId}&decision_external_ref=eq.${encodeURIComponent(decisionExternalRef)}&id=neq.${currentSendId}&deleted_at=is.null&select=recipient_name,recipient_email`);
  return formatCoRecipients(rows);
}

function appendSiblingAwareness(body: string, line: string | null): string {
  return line ? `${body}\n\n${line}` : body;
}


function normalizeOption(item: unknown): Option | null {
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

function quoteName(name: string): string {
  return `"${stripHeaderUnsafe(name).replaceAll('"', "'")}"`;
}
