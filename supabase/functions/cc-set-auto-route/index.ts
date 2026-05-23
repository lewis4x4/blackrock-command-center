import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, cleanString, json, rpc, verifyAccessJwt } from "../_shared/phase5.ts";

const TOGGLE_TOKEN = Deno.env.get("CC_AUTO_ROUTE_TOGGLE_TOKEN") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);
  if (!TOGGLE_TOKEN) return json({ error: "auto-route toggle token not configured" }, 500, access.headerValue);
  const toggleHeader = req.headers.get("x-cc-auto-route-toggle");
  if (!toggleHeader || toggleHeader !== TOGGLE_TOKEN) return json({ error: "missing or invalid x-cc-auto-route-toggle" }, 401, access.headerValue);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, access.headerValue); }
  const appId = cleanString((body as Record<string, unknown>)?.app_id, 80);
  const enabled = (body as Record<string, unknown>)?.enabled;
  if (!appId || !UUID_RE.test(appId)) return json({ error: "app_id must be a valid uuid" }, 400, access.headerValue);
  if (typeof enabled !== "boolean") return json({ error: "enabled must be boolean" }, 400, access.headerValue);

  try {
    const app = await rpc("cc_set_auto_route", { p_app_id: appId, p_enabled: enabled, p_actor: access.actor });
    return json({ app }, 200, access.headerValue);
  } catch (e) {
    return json({ error: "set auto route failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});
