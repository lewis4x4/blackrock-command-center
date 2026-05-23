import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, cleanString, json, rpc, verifyAccessJwt, verifyWriteToken } from "../_shared/phase5.ts";

const TOGGLE_TOKEN = Deno.env.get("CC_AUTO_ROUTE_TOGGLE_TOKEN") ?? "";
const READ_TOKEN = Deno.env.get("CC_READ_TOKEN") ?? "";
if (TOGGLE_TOKEN && TOGGLE_TOKEN === READ_TOKEN) {
  console.error("[cc-pause-decision] FATAL: CC_AUTO_ROUTE_TOGGLE_TOKEN must differ from CC_READ_TOKEN");
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
  const action = cleanString((body as Record<string, unknown>)?.action, 16);
  const reason = cleanString((body as Record<string, unknown>)?.reason, 500);
  if (!issueId || !UUID_RE.test(issueId)) return json({ error: "issue_id must be a valid uuid" }, 400, access.headerValue);
  if (action !== "pause" && action !== "resume") return json({ error: "action must be 'pause' or 'resume'" }, 400, access.headerValue);

  try {
    const issue = action === "pause"
      ? await rpc("cc_pause_auto_route", { p_issue_id: issueId, p_actor: access.actor, p_reason: reason })
      : await rpc("cc_resume_auto_route", { p_issue_id: issueId, p_actor: access.actor });
    return json({ issue }, 200, access.headerValue);
  } catch (e) {
    return json({ error: "pause action failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});
