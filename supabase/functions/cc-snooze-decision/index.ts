import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, cleanString, json, rpc, verifyAccessJwt, verifyWriteToken } from "../_shared/phase5.ts";

const TOGGLE_TOKEN = Deno.env.get("CC_AUTO_ROUTE_TOGGLE_TOKEN") ?? "";
const READ_TOKEN = Deno.env.get("CC_READ_TOKEN") ?? "";
if (TOGGLE_TOKEN && TOGGLE_TOKEN === READ_TOKEN) {
  console.error("[cc-snooze-decision] FATAL: CC_AUTO_ROUTE_TOGGLE_TOKEN must differ from CC_READ_TOKEN");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return json({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);
  if (!TOGGLE_TOKEN || TOGGLE_TOKEN === READ_TOKEN) return json({ error: "operator mutation auth misconfigured" }, 500, access.headerValue);
  if (req.headers.get("x-cc-auto-route-toggle") !== TOGGLE_TOKEN) return json({ error: "missing or invalid x-cc-auto-route-toggle" }, 401, access.headerValue);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, access.headerValue); }

  const issueId = cleanString((body as Record<string, unknown>)?.issue_id, 80);
  const action = cleanString((body as Record<string, unknown>)?.action, 16) ?? "snooze";
  const until = cleanString((body as Record<string, unknown>)?.until, 80);
  const daysRaw = (body as Record<string, unknown>)?.days;
  const days = typeof daysRaw === "number" && Number.isFinite(daysRaw) ? daysRaw : null;
  if (!issueId || !UUID_RE.test(issueId)) return json({ error: "issue_id must be a valid uuid" }, 400, access.headerValue);
  if (action !== "snooze" && action !== "unsnooze") return json({ error: "action must be 'snooze' or 'unsnooze'" }, 400, access.headerValue);

  try {
    if (action === "unsnooze") {
      const issue = await rpc("cc_unsnooze_decision", { p_issue_id: issueId, p_actor: access.actor });
      return json({ issue }, 200, access.headerValue);
    }

    let untilIso = until;
    if (!untilIso) {
      const d = days ?? 1;
      const target = new Date(Date.now() + d * 86_400_000);
      untilIso = target.toISOString();
    }
    const issue = await rpc("cc_snooze_decision", { p_issue_id: issueId, p_until: untilIso, p_actor: access.actor });
    return json({ issue }, 200, access.headerValue);
  } catch (e) {
    return json({ error: "snooze action failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});
