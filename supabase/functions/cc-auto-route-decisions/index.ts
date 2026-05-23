import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, cleanString, cpAudit, cpGet, cpInsert, cpPatch, escapeHtml, gmailSend, hmacSha256Hex, isRecord, json, randomToken, rpc, stripHeaderUnsafe, verifyAccessJwt } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-auto-route-decisions";
const MAGIC_SECRET = Deno.env.get("CC_MAGIC_LINK_SECRET") ?? "";
const PUBLIC_BASE_URL = (Deno.env.get("CC_PUBLIC_DECISION_BASE_URL") ?? "https://blackrockai-command-center.netlify.app").replace(/\/+$/, "");
const SENDER = "Brian Lewis <brian.lewis@blackrockai.co>";
const REPLY_TO = "brian.lewis@blackrockai.co";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);
  if (!MAGIC_SECRET) return json({ error: "CC_MAGIC_LINK_SECRET is not configured" }, 500, access.headerValue);

  const errors: Array<Record<string, unknown>> = [];
  let phaseA_finalized = 0;
  let phaseB_enqueued = 0;

  const rewriteRows = await cpGet("cc_decision_email_sends?deleted_at=is.null&created_via=eq.auto_route&route_parent_send_id=is.null&state=eq.rewrite_ready&order=updated_at.asc&limit=10&select=id");
  for (const row of rewriteRows) {
    const sendId = cleanString((row as Record<string, unknown>)?.id, 80);
    if (!sendId || !UUID_RE.test(sendId)) continue;
    try {
      const claimed = await rpc<Record<string, unknown> | null>("cc_claim_auto_route_finalize", { p_send_id: sendId, p_actor: access.actor, p_lease_seconds: 120 });
      if (!claimed) continue;
      const claimToken = cleanString(claimed.claim_token, 80);
      const send = isRecord(claimed.send) ? claimed.send : null;
      const recipients = Array.isArray(claimed.recipients) ? claimed.recipients.filter(isRecord) : [];
      if (!claimToken || !send || recipients.length === 0) throw new Error("claim returned no recipients");

      const appId = cleanString(send.app_id, 80)!;
      const issueId = cleanString(send.issue_id, 80)!;
      const subject = cleanString(send.rewritten_subject, 300) ?? cleanString(send.raw_decision_title, 300) ?? "Quick question";
      const body = cleanString(send.rewritten_body, 8000) ?? cleanString(send.raw_decision_body, 8000) ?? "Quick question before we proceed.";
      const options = normalizeOptions(send.options_snapshot);
      if (options.length === 0) throw new Error("send has no options_snapshot");

      for (let i = 0; i < recipients.length; i += 1) {
        const recipient = recipients[i];
        const recipientId = cleanString(recipient.id, 80)!;
        const recipientEmail = cleanString(recipient.contact_email, 320)!;
        const recipientName = cleanString(recipient.contact_name, 160) ?? recipientEmail;
        const perSend = i === 0 ? send : await cloneSend(send);
        const perSendId = cleanString(perSend.id, 80)!;
        const tokenized = await tokenizedOptions(options, perSendId);
        const messageId = `<cc-${perSendId}@blackrockai.co>`;
        const prePatchPath = perSendId === sendId
          ? `cc_decision_email_sends?id=eq.${perSendId}&claim_token=eq.${claimToken}`
          : `cc_decision_email_sends?id=eq.${perSendId}`;
        const prePatched = await cpPatch<Record<string, unknown>>(prePatchPath, {
          recipient_id: recipientId,
          recipient_email: recipientEmail,
          recipient_name: recipientName,
          rewritten_subject: subject,
          rewritten_body: body,
          rewrite_approved_by: access.actor,
          rewrite_approved_at: new Date().toISOString(),
          options_snapshot: options,
          magic_link_tokens: tokenized.tokenRecords,
          magic_link_token_hash: tokenized.firstHash,
          magic_link_expires_at: tokenized.expiresAt,
          gmail_message_id: messageId,
          last_error: null,
          created_via: "auto_route",
        });
        if (perSendId === sendId && prePatched.length !== 1) {
          await cpAudit(appId, access.actor, "decision_auto_route_finalize_stale", { send_id: perSendId, issue_id: issueId });
          throw new Error("finalize claim became stale");
        }

        const raw = composeMessage({ sendId: perSendId, toName: recipientName, toEmail: recipientEmail, subject, body, options: tokenized.options, messageId });
        const gmail = await gmailSend(raw);

        const postPatchPath = perSendId === sendId
          ? `cc_decision_email_sends?id=eq.${perSendId}&claim_token=eq.${claimToken}`
          : `cc_decision_email_sends?id=eq.${perSendId}`;
        const postPatched = await cpPatch<Record<string, unknown>>(postPatchPath, {
          gmail_thread_id: gmail.threadId ?? gmail.id,
          state: "sent",
          sent_at: new Date().toISOString(),
        });
        if (perSendId === sendId && postPatched.length !== 1) {
          await cpAudit(appId, access.actor, "decision_auto_route_post_send_drift", {
            send_id: perSendId,
            issue_id: issueId,
            recipient_id: recipientId,
            gmail_id: gmail.id,
          });
          throw new Error("post-send patch drifted after gmail send");
        }

        await cpAudit(appId, access.actor, "decision_auto_route_sent", {
          send_id: perSendId,
          issue_id: issueId,
          recipient_id: recipientId,
          owner_name: recipientName,
          owner_email: recipientEmail,
          gmail_id: gmail.id,
          gmail_thread_id: gmail.threadId ?? null,
        });
      }

      await cpPatch(`cc_issues?id=eq.${issueId}&deleted_at=is.null`, { status: "routed_to_client" });
      phaseA_finalized += 1;
    } catch (e) {
      errors.push({ phase: "A", send_id: sendId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (let i = 0; i < 10; i += 1) {
    try {
      const claimed = await rpc<Record<string, unknown> | null>("cc_claim_auto_route_candidate", { p_actor: access.actor });
      if (!claimed || !cleanString(claimed.send_id, 80)) break;
      phaseB_enqueued += 1;
      await cpAudit(cleanString(claimed.app_id, 80), access.actor, "decision_auto_route_enqueued_function", { send_id: claimed.send_id, issue_id: claimed.issue_id });
    } catch (e) {
      errors.push({ phase: "B", error: e instanceof Error ? e.message : String(e) });
      break;
    }
  }

  return json({ phaseA_finalized, phaseB_enqueued, errors }, 200, access.headerValue);
});

type Option = { id: string; label: string };

type Tokenized = { options: Array<Option & { confirm_url: string }>; tokenRecords: Array<{ option_id: string; token_hash: string }>; firstHash: string; expiresAt: string };

function normalizeOptions(value: unknown): Option[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isRecord(item)) return null;
    const id = cleanString(item.id, 200) ?? cleanString(item.value, 200) ?? cleanString(item.key, 200);
    if (!id) return null;
    return { id, label: cleanString(item.label, 300) ?? cleanString(item.name, 300) ?? cleanString(item.title, 300) ?? id };
  }).filter((item): item is Option => !!item);
}

async function cloneSend(base: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parentId = cleanString(base.id, 80);
  if (!parentId) throw new Error("parent send id missing");
  const rows = await cpInsert<Record<string, unknown>>("cc_decision_email_sends", {
    issue_id: base.issue_id,
    app_id: base.app_id,
    decision_external_ref: base.decision_external_ref,
    recipient_email: "auto-route-pending@blackrockai.co",
    recipient_name: "Auto-route pending",
    raw_decision_title: base.raw_decision_title,
    raw_decision_body: base.raw_decision_body,
    rewritten_subject: base.rewritten_subject,
    rewritten_body: base.rewritten_body,
    options_snapshot: base.options_snapshot,
    risk_class: base.risk_class,
    magic_link_token_hash: `route-placeholder:${randomToken(16)}`,
    magic_link_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    state: "sent",
    max_attempts: base.max_attempts ?? 3,
    created_via: "auto_route",
    route_parent_send_id: parentId,
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
    `Subject: ${stripHeaderUnsafe(input.subject)}`,
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

function quoteName(name: string): string {
  return `"${stripHeaderUnsafe(name).replaceAll('"', "'")}"`;
}
