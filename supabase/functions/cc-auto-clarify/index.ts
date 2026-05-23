import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cleanString, cpAudit, cpPatch, escapeHtml, gmailSend, hmacSha256Hex, json, randomToken, rpc, stripHeaderUnsafe } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-auto-clarify";
const INTERNAL_TOKEN = Deno.env.get("CC_INTERNAL_TOKEN") ?? "";
const MAGIC_SECRET = Deno.env.get("CC_MAGIC_LINK_SECRET") ?? "";
const PUBLIC_BASE_URL = (Deno.env.get("CC_PUBLIC_DECISION_BASE_URL") ?? "https://blackrockai-command-center.netlify.app").replace(/\/+$/, "");
const SENDER = "Brian Lewis <brian.lewis@blackrockai.co>";
const REPLY_TO = "brian.lewis@blackrockai.co";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405);
  if (!INTERNAL_TOKEN || req.headers.get("Authorization") !== `Bearer ${INTERNAL_TOKEN}`) return json({ error: "unauthorized" }, 401);
  if (!MAGIC_SECRET) return json({ error: "CC_MAGIC_LINK_SECRET is not configured" }, 500);

  try {
    const rows: Array<Record<string, unknown>> = [];
    let sent = 0;
    for (let i = 0; i < 25; i += 1) {
      const claimed = await rpc<Record<string, unknown> | null>("cc_claim_clarify_task", { p_lease_seconds: 60 });
      if (!claimed || !cleanString(claimed.id, 80)) break;
      rows.push(claimed);
      const row = claimed;
      const sendId = cleanString(row.id, 80);
      const appId = cleanString(row.app_id, 80);
      const recipientEmail = cleanString(row.recipient_email, 320);
      const recipientName = cleanString(row.recipient_name, 160) ?? recipientEmail;
      const originalSubject = cleanString(row.rewritten_subject, 300) ?? cleanString(row.raw_decision_title, 300) ?? "Quick clarification";
      const inReplyTo = cleanString(row.gmail_message_id, 500);
      if (!sendId || !recipientEmail) continue;

      const options = normalizeOptions(row.options_snapshot);
      if (options.length === 0) continue;
      const tokenized = await tokenizedOptions(options, sendId);
      const question = cleanString((row.llm_extraction as Record<string, unknown> | null)?.proposed_clarifying_question, 400)
        ?? `Just to make sure I picked this up right — would you like ${options.map((opt) => opt.label).join(', or ')}?`;

      const raw = composeMessage({
        sendId,
        toName: recipientName,
        toEmail: recipientEmail,
        subject: `Re: ${originalSubject}`,
        question,
        options: tokenized.options,
        inReplyTo,
        references: inReplyTo,
      });
      const gmail = await gmailSend(raw);

      const existingTokens = Array.isArray(row.magic_link_tokens) ? row.magic_link_tokens : [];
      const claimToken = cleanString(row.claim_token, 80);
      const updated = await cpPatch(`cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&state=eq.awaiting_clarify&clarification_attempt_count=lt.1&claim_token=eq.${claimToken}`, {
        state: "clarify_sent",
        clarification_sent_at: new Date().toISOString(),
        clarification_attempt_count: (Number(row.clarification_attempt_count) || 0) + 1,
        clarification_gmail_message_id: gmail.id,
        magic_link_tokens: [...existingTokens, ...tokenized.tokenRecords],
        claim_token: null,
        clarification_started_at: null,
      });

      if (updated.length !== 1) {
        await cpAudit(appId, FUNCTION_NAME, "decision_clarification_finalize_mismatch", { send_id: sendId, claim_token: claimToken, gmail_message_id: gmail.id });
        continue;
      }

      await cpAudit(appId, FUNCTION_NAME, "decision_clarification_sent", {
        send_id: sendId,
        issue_id: cleanString(row.issue_id, 80),
        gmail_message_id: gmail.id,
        recipient_email: recipientEmail,
      });
      sent += 1;
    }

    return json({ ok: true, sent, considered: rows.length });
  } catch (e) {
    return json({ error: "auto clarify failed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});

type Option = { id: string; label: string };

function normalizeOptions(value: unknown): Option[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const rec = typeof item === "object" && item && !Array.isArray(item) ? item as Record<string, unknown> : null;
    const id = cleanString(rec?.id, 200) ?? cleanString(rec?.value, 200) ?? cleanString(rec?.key, 200);
    if (!id) return null;
    return { id, label: cleanString(rec?.label, 300) ?? cleanString(rec?.name, 300) ?? cleanString(rec?.title, 300) ?? id };
  }).filter((v): v is Option => !!v);
}

async function tokenizedOptions(options: Option[], sendId: string): Promise<{ options: Array<Option & { confirm_url: string }>; tokenRecords: Array<{ option_id: string; token_hash: string; minted_at: string }> }> {
  const out: Array<Option & { confirm_url: string }> = [];
  const records: Array<{ option_id: string; token_hash: string; minted_at: string }> = [];
  for (const option of options) {
    const raw = randomToken(32);
    const tokenHash = await hmacSha256Hex(MAGIC_SECRET, `${sendId}:${option.id}:${raw}`);
    const confirmUrl = `${PUBLIC_BASE_URL}/c/${encodeURIComponent(raw)}?s=${encodeURIComponent(sendId)}&o=${encodeURIComponent(option.id)}`;
    out.push({ ...option, confirm_url: confirmUrl });
    records.push({ option_id: option.id, token_hash: tokenHash, minted_at: "clarify" });
  }
  return { options: out, tokenRecords: records };
}

function composeMessage(input: { sendId: string; toName: string | null; toEmail: string; subject: string; question: string; options: Array<Option & { confirm_url: string }>; inReplyTo: string | null; references: string | null }): string {
  const boundary = `cc_${crypto.randomUUID()}`;
  const to = input.toName && input.toName !== input.toEmail ? `"${stripHeaderUnsafe(input.toName).replaceAll('"', "'")}" <${input.toEmail}>` : input.toEmail;
  const plainOptions = input.options.map((option) => `• ${option.label} → ${option.confirm_url}`).join("\n");
  const plain = `Hey ${input.toName ?? input.toEmail},\n\nThanks for the reply! I want to make sure I'm reading it right before I move this forward.\n\n${input.question}\n\n${plainOptions}\n\nOr just reply with the one you want and I'll handle the rest.\n\nThanks,\nBrian`;
  const htmlButtons = input.options.map((option) => `<p><a href="${escapeHtml(option.confirm_url)}" style="display:inline-block;background:#7C6FF0;color:#fff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:700">${escapeHtml(option.label)}</a></p>`).join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.5;color:#111827;max-width:640px"><p>Hey ${escapeHtml(input.toName ?? input.toEmail)},</p><p>Thanks for the reply! I want to make sure I'm reading it right before I move this forward.</p><p>${escapeHtml(input.question)}</p>${htmlButtons}<p>Or just reply with the one you want and I'll handle the rest.</p><p>Thanks,<br>Brian</p></div>`;

  const headers = [
    `From: ${SENDER}`,
    `To: ${to}`,
    `Reply-To: ${REPLY_TO}`,
    `Subject: ${stripHeaderUnsafe(input.subject)}`,
    `X-CC-Send-Id: ${input.sendId}`,
    "X-CC-Clarification: 1",
    input.inReplyTo ? `In-Reply-To: ${stripHeaderUnsafe(input.inReplyTo)}` : null,
    input.references ? `References: ${stripHeaderUnsafe(input.references)}` : null,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean) as string[];

  return [
    ...headers,
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
