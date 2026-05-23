import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, cleanString, cpAudit, cpGet, cpPatch, encodeRfc2047HeaderValue, escapeHtml, gmailSend, hmacSha256Hex, isRecord, json, randomToken, stripHeaderUnsafe, verifyAccessJwt, verifyWriteToken } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-operator-clarify-extraction";
const TOGGLE_TOKEN = Deno.env.get("CC_AUTO_ROUTE_TOGGLE_TOKEN") ?? "";
const READ_TOKEN = Deno.env.get("CC_READ_TOKEN") ?? "";
if (TOGGLE_TOKEN && TOGGLE_TOKEN === READ_TOKEN) {
  console.error("[cc-operator-clarify-extraction] FATAL: CC_AUTO_ROUTE_TOGGLE_TOKEN must differ from CC_READ_TOKEN");
}
const MAGIC_SECRET = Deno.env.get("CC_MAGIC_LINK_SECRET") ?? "";
const PUBLIC_BASE_URL = (Deno.env.get("CC_PUBLIC_DECISION_BASE_URL") ?? "https://blackrockai-command-center.netlify.app").replace(/\/+$/, "");
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
  if (!MAGIC_SECRET) return json({ error: "CC_MAGIC_LINK_SECRET is not configured" }, 500, access.headerValue);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, access.headerValue); }

  const sendId = cleanString((body as Record<string, unknown>)?.send_id, 80);
  const subjectInput = cleanString((body as Record<string, unknown>)?.subject, 200);
  const bodyInput = cleanString((body as Record<string, unknown>)?.body, 4000) ?? cleanString((body as Record<string, unknown>)?.message, 4000);
  const includeButtons = (body as Record<string, unknown>)?.include_buttons === true;
  const regenerateRequested = (body as Record<string, unknown>)?.regenerate_tokens === true;
  if (!sendId || !UUID_RE.test(sendId)) return json({ error: "send_id must be a valid uuid" }, 400, access.headerValue);
  if (!bodyInput) return json({ error: "body is required" }, 400, access.headerValue);

  try {
    const rows = await cpGet(`cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&state=in.(extracting,replied,awaiting_clarify,clarify_sent,awaiting_operator_review)&select=*`);
    const row = rows.find(isRecord);
    if (!row) return json({ error: "send not found or not clarifiable" }, 404, access.headerValue);

    const recipientEmail = cleanString(row.recipient_email, 320);
    const recipientName = cleanString(row.recipient_name, 160) ?? recipientEmail;
    const defaultSubject = `Re: ${cleanString(row.rewritten_subject, 300) ?? cleanString(row.raw_decision_title, 300) ?? "Quick clarification"}`;
    const subject = stripHeaderUnsafe(subjectInput ?? defaultSubject);
    if (!recipientEmail) return json({ error: "send row missing recipient_email" }, 400, access.headerValue);

    const options = normalizeOptions(row.options_snapshot);
    const regenerateTokens = includeButtons ? true : regenerateRequested;
    if (regenerateTokens && (!includeButtons || options.length === 0)) {
      return json({ error: "regenerate_tokens requires include_buttons=true and at least one option" }, 400, access.headerValue);
    }

    const clarificationCount = Number(row.operator_clarification_count) || 0;
    if (clarificationCount >= 5) {
      return json({ error: "clarification cap exceeded" }, 409, access.headerValue);
    }

    const tokenized = regenerateTokens ? await tokenizedOptions(options, sendId) : null;

    const raw = composeMessage({
      sendId,
      toName: recipientName,
      toEmail: recipientEmail,
      subject,
      body: bodyInput,
      inReplyTo: cleanString(row.gmail_message_id, 500),
      references: cleanString(row.gmail_message_id, 500),
      options: includeButtons ? (tokenized?.options ?? []) : [],
    });
    const gmail = await gmailSend(raw);

    const patch: Record<string, unknown> = {
      state: "clarify_sent",
      clarification_sent_at: new Date().toISOString(),
      clarification_gmail_message_id: gmail.id,
      claim_token: null,
      extraction_started_at: null,
      operator_clarification_count: clarificationCount + 1,
    };
    if (regenerateTokens && tokenized) {
      patch.magic_link_tokens = tokenized.tokenRecords;
      patch.magic_link_token_hash = tokenized.firstHash;
      patch.magic_link_expires_at = tokenized.expiresAt;
    }

    const updated = await cpPatch<Record<string, unknown>>(
      `cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&state=in.(extracting,awaiting_operator_review,awaiting_clarify,clarify_sent)`,
      patch,
    );

    if (updated.length !== 1) {
      await cpAudit(cleanString(row.app_id, 80), access.actor, "decision_operator_clarify_post_send_drift", { send_id: sendId });
      return json({ error: "state changed during send; not finalized", sent_to_gmail: true }, 200, access.headerValue);
    }

    await cpAudit(cleanString(row.app_id, 80), access.actor, "decision_clarification_sent", {
      send_id: sendId,
      origin: "operator",
      subject,
      body: bodyInput,
      recipient_email: recipientEmail,
      gmail_message_id: gmail.id,
      include_buttons: includeButtons,
      regenerated_tokens: regenerateTokens,
      invalidated_token_count: Array.isArray(row.magic_link_tokens) ? row.magic_link_tokens.length : 0,
    });

    return json({ send: updated[0] ?? row, regenerated_tokens: regenerateTokens }, 200, access.headerValue);
  } catch (e) {
    return json({ error: "clarify extraction failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});

type Option = { id: string; label: string };

function normalizeOptions(value: unknown): Option[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const rec = isRecord(item) ? item : null;
    const id = cleanString(rec?.id, 200) ?? cleanString(rec?.value, 200) ?? cleanString(rec?.key, 200);
    if (!id) return null;
    return { id, label: cleanString(rec?.label, 300) ?? cleanString(rec?.name, 300) ?? cleanString(rec?.title, 300) ?? id };
  }).filter((v): v is Option => !!v);
}

async function tokenizedOptions(options: Option[], sendId: string): Promise<{ options: Array<Option & { confirm_url: string }>; tokenRecords: Array<{ option_id: string; token_hash: string; minted_at: string }>; firstHash: string; expiresAt: string }> {
  const out: Array<Option & { confirm_url: string }> = [];
  const records: Array<{ option_id: string; token_hash: string; minted_at: string }> = [];
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  for (const option of options) {
    const raw = randomToken(32);
    const tokenHash = await hmacSha256Hex(MAGIC_SECRET, `${sendId}:${option.id}:${raw}`);
    const confirmUrl = `${PUBLIC_BASE_URL}/c/${encodeURIComponent(raw)}?s=${encodeURIComponent(sendId)}&o=${encodeURIComponent(option.id)}`;
    out.push({ ...option, confirm_url: confirmUrl });
    records.push({ option_id: option.id, token_hash: tokenHash, minted_at: "operator-clarify" });
  }
  return { options: out, tokenRecords: records, firstHash: records[0]?.token_hash ?? "", expiresAt };
}

function composeMessage(input: { sendId: string; toName: string | null; toEmail: string; subject: string; body: string; inReplyTo: string | null; references: string | null; options: Array<Option & { confirm_url: string }> }): string {
  const boundary = `cc_${crypto.randomUUID()}`;
  const to = input.toName && input.toName !== input.toEmail ? `"${stripHeaderUnsafe(input.toName).replaceAll('"', "'")}" <${input.toEmail}>` : input.toEmail;
  const plainButtons = input.options.map((opt) => `• ${opt.label}\n${opt.confirm_url}`).join("\n\n");
  const plain = `${input.body}${plainButtons ? `\n\n${plainButtons}` : ""}\n\nThanks,\nBrian`;
  const htmlButtons = input.options.map((opt) => `<p><a href="${escapeHtml(opt.confirm_url)}" style="display:inline-block;background:#7C6FF0;color:#fff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:700">${escapeHtml(opt.label)}</a></p>`).join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.5;color:#111827;max-width:640px"><p>${escapeHtml(input.body).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>${htmlButtons}<p>Thanks,<br>Brian</p></div>`;
  const headers = [
    `From: ${SENDER}`,
    `To: ${to}`,
    `Reply-To: ${REPLY_TO}`,
    `Subject: ${encodeRfc2047HeaderValue(input.subject)}`,
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
