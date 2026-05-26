import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, cleanString, cpInsert, cpPatch, cpGet, gmailAccessToken, isRecord, json, verifyAccessJwt } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-gmail-watch-start";

console.log(`[${FUNCTION_NAME}] ready`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "GET, POST, or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");
  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const url = new URL(req.url);
  const projectId = cleanString(url.searchParams.get("project_id"), 120);
  const topicName = cleanString(url.searchParams.get("topic"), 200) ?? "cc-gmail-inbound";
  const labelIds = (url.searchParams.get("labels") ?? "INBOX").split(",").map((s) => s.trim()).filter(Boolean);

  if (!projectId) {
    return json({
      error: "project_id query param is required",
      hint: "Pass ?project_id=<your-gcp-project-id>. Find it in https://console.cloud.google.com/home/dashboard — top of the page, 'Project info' card.",
    }, 400, access.headerValue);
  }

  try {
    const token = await gmailAccessToken();
    const watchUrl = "https://gmail.googleapis.com/gmail/v1/users/me/watch";
    const r = await fetch(watchUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topicName: `projects/${projectId}/topics/${topicName}`,
        labelIds,
        labelFilterAction: "include",
      }),
    });
    const body = await r.text();
    if (!r.ok) {
      return json({
        error: "Gmail users.watch failed",
        status: r.status,
        body,
        hint: "Common causes: (1) Pub/Sub topic doesn't exist — create it first in Cloud Console, (2) gmail-api-push@system.gserviceaccount.com not granted Pub/Sub Publisher on the topic, (3) wrong project_id.",
      }, 500, access.headerValue);
    }
    const parsed = JSON.parse(body) as { historyId?: string; expiration?: string };
    const historyId = cleanString(parsed.historyId, 80);
    const expiration = cleanString(parsed.expiration, 40);
    if (!historyId) {
      return json({ error: "Gmail users.watch returned no historyId", body }, 500, access.headerValue);
    }

    // Seed cc_gmail_history_cursor only when it is empty. On renewals, keep the
    // existing cursor so a manual or Pub/Sub inbound run can backfill messages
    // that arrived while the watch was expired or the push path was broken.
    const cursorRows = await cpGet("cc_gmail_history_cursor?id=eq.1&select=history_id");
    const previousHistoryId = cursorRows.find(isRecord)?.history_id;
    const cursorUpdated = !previousHistoryId;
    if (cursorUpdated) {
      await cpPatch(`cc_gmail_history_cursor?id=eq.1`, {
        history_id: historyId,
      });
    }

    return json({
      ok: true,
      historyId,
      previous_history_id: previousHistoryId ?? null,
      cursor_updated: cursorUpdated,
      expiration_ms: expiration,
      expiration_iso: expiration ? new Date(Number(expiration)).toISOString() : null,
      expires_in_days: expiration ? Math.round((Number(expiration) - Date.now()) / 86_400_000) : null,
      topic: `projects/${projectId}/topics/${topicName}`,
      label_ids: labelIds,
      note: "Watch tokens expire ~7 days; renew before expiry. A renewal cron is Stage 3.",
    }, 200, access.headerValue);
  } catch (e) {
    return json({ error: "watch start failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});
