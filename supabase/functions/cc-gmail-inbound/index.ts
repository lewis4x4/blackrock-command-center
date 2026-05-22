import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { asArray, asString, cleanString, cpAudit, cpGet, cpPatch, gmailAccessToken, isRecord, json } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-gmail-inbound";
const PUBSUB_TOKEN = Deno.env.get("GMAIL_PUBSUB_VERIFICATION_TOKEN") ?? "";

console.log(`[${FUNCTION_NAME}] ready`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405);
  if (!verifyPubSub(req)) return json({ error: "unauthorized" }, 401);

  let envelope: unknown;
  try { envelope = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400); }
  const historyId = extractHistoryId(envelope);
  if (!historyId) return json({ error: "Pub/Sub message did not include Gmail historyId" }, 400);

  try {
    const cursorRows = await cpGet("cc_gmail_history_cursor?id=eq.1&select=history_id");
    const cursor = cursorRows.find(isRecord)?.history_id;
    const token = await gmailAccessToken();
    const messageIds = cursor ? await listHistoryMessages(token, String(cursor)) : [];
    await cpPatch("cc_gmail_history_cursor?id=eq.1", { history_id: historyId });

    const matched: string[] = [];
    for (const id of messageIds) {
      const msg = await getMessage(token, id);
      const headers = headersMap(msg);
      const ccSendId = headers.get("x-cc-send-id") ?? null;
      const inReplyTo = headers.get("in-reply-to") ?? headers.get("references") ?? null;
      const from = headers.get("from") ?? "";
      const gmailThreadId = asString(msg.threadId);
      const send = await findSend(ccSendId, inReplyTo, gmailThreadId, from);
      if (!send) {
        await cpAudit(null, FUNCTION_NAME, "gmail_inbound_unmatched", { gmail_message_id: id, in_reply_to: inReplyTo });
        continue;
      }
      const sendId = cleanString(send.id, 80)!;
      const appId = cleanString(send.app_id, 80);
      const replyText = extractBody(msg);
      const updated = await cpPatch(`cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&state=in.(sent,delivered,opened,clicked,clarify_sent)`, {
        state: "replied",
        raw_reply_text: replyText,
        replied_at: new Date().toISOString(),
        gmail_thread_id: gmailThreadId ?? send.gmail_thread_id ?? null,
      });
      if (updated.length === 0) {
        await cpAudit(appId, FUNCTION_NAME, "gmail_inbound_skipped_closed_send", { send_id: sendId, gmail_message_id: id });
        continue;
      }
      await cpAudit(appId, `client:${from || "gmail"}`, "decision_reply_received", {
        send_id: sendId,
        owner_name: send.recipient_name,
        owner_email: send.recipient_email,
        gmail_message_id: id,
      });
      matched.push(sendId);
    }

    return json({ ok: true, history_id: historyId, processed_messages: messageIds.length, matched_send_ids: matched });
  } catch (e) {
    return json({ error: "gmail inbound failed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function verifyPubSub(req: Request): boolean {
  if (!PUBSUB_TOKEN) return false;
  const url = new URL(req.url);
  if (url.searchParams.get("token") === PUBSUB_TOKEN) return true;
  const auth = req.headers.get("Authorization") ?? "";
  return auth === `Bearer ${PUBSUB_TOKEN}`;
}

function extractHistoryId(envelope: unknown): string | null {
  if (!isRecord(envelope)) return null;
  const message = isRecord(envelope.message) ? envelope.message : null;
  if (!message) return null;
  const data = asString(message.data);
  if (!data) {
    const attrs = isRecord(message.attributes) ? message.attributes : {};
    return asString(attrs.historyId);
  }
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    const jsonText = atob(normalized);
    const payload = JSON.parse(jsonText) as Record<string, unknown>;
    return asString(payload.historyId);
  } catch {
    return null;
  }
}

async function listHistoryMessages(token: string, startHistoryId: string): Promise<string[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
  url.searchParams.set("startHistoryId", startHistoryId);
  url.searchParams.set("historyTypes", "messageAdded");
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Gmail history.list failed: ${r.status} ${await r.text()}`);
  const payload = await r.json() as { history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }> };
  const ids = new Set<string>();
  for (const h of payload.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      if (added.message?.id) ids.add(added.message.id);
    }
  }
  return [...ids];
}

async function getMessage(token: string, id: string): Promise<Record<string, unknown>> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Gmail messages.get failed: ${r.status} ${await r.text()}`);
  return await r.json() as Record<string, unknown>;
}

function headersMap(msg: Record<string, unknown>): Map<string, string> {
  const payload = isRecord(msg.payload) ? msg.payload : {};
  const headers = asArray(payload.headers);
  const map = new Map<string, string>();
  for (const h of headers) {
    if (!isRecord(h)) continue;
    const name = asString(h.name)?.toLowerCase();
    const value = asString(h.value);
    if (name && value) map.set(name, value);
  }
  return map;
}

async function findSend(ccSendId: string | null, inReplyTo: string | null, gmailThreadId: string | null, from: string): Promise<Record<string, unknown> | null> {
  if (ccSendId) {
    const rows = await cpGet(`cc_decision_email_sends?id=eq.${ccSendId}&deleted_at=is.null&select=*`);
    const row = rows.find(isRecord);
    if (row && senderMatches(row, from) && threadMatches(row, inReplyTo, gmailThreadId)) return row;
  }
  if (inReplyTo) {
    const encoded = encodeURIComponent(inReplyTo.split(/\s+/)[0] ?? inReplyTo);
    const rows = await cpGet(`cc_decision_email_sends?gmail_message_id=eq.${encoded}&deleted_at=is.null&select=*`);
    const row = rows.find(isRecord);
    if (row && senderMatches(row, from)) return row;
  }
  if (gmailThreadId) {
    const rows = await cpGet(`cc_decision_email_sends?gmail_thread_id=eq.${encodeURIComponent(gmailThreadId)}&deleted_at=is.null&select=*`);
    const row = rows.find(isRecord);
    if (row && senderMatches(row, from)) return row;
  }
  return null;
}

function senderMatches(send: Record<string, unknown>, from: string): boolean {
  const recipient = asString(send.recipient_email)?.toLowerCase();
  if (!recipient) return false;
  return extractEmail(from).toLowerCase() === recipient;
}

function threadMatches(send: Record<string, unknown>, inReplyTo: string | null, gmailThreadId: string | null): boolean {
  const sentMessageId = asString(send.gmail_message_id);
  const sentThreadId = asString(send.gmail_thread_id);
  if (gmailThreadId && sentThreadId && gmailThreadId === sentThreadId) return true;
  if (inReplyTo && sentMessageId && inReplyTo.includes(sentMessageId)) return true;
  return false;
}

function extractEmail(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim();
}

function extractBody(msg: Record<string, unknown>): string {
  const payload = isRecord(msg.payload) ? msg.payload : {};
  const parts = flattenParts(payload);
  const textPart = parts.find((p) => asString(p.mimeType)?.startsWith("text/plain")) ?? parts.find((p) => asString(p.mimeType)?.startsWith("text/html")) ?? payload;
  const body = isRecord(textPart.body) ? textPart.body : {};
  const data = asString(body.data);
  if (!data) return cleanString(msg.snippet, 2000) ?? "";
  const decoded = decodeBase64Url(data);
  return stripQuoted(decoded.replace(/<[^>]*>/g, " ")).slice(0, 12000);
}

function flattenParts(part: Record<string, unknown>): Record<string, unknown>[] {
  const out = [part];
  for (const child of asArray(part.parts)) {
    if (isRecord(child)) out.push(...flattenParts(child));
  }
  return out;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array([...binary].map((ch) => ch.charCodeAt(0)));
  return new TextDecoder().decode(bytes);
}

function stripQuoted(value: string): string {
  return value.split(/\nOn .+ wrote:\n|\nFrom: .+\n/i)[0].replace(/\n>.*$/gm, "").trim();
}
