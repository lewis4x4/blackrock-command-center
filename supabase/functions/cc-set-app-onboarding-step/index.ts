import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, cleanString, json, rpc, rpcErrorResponse, verifyAccessJwt, verifyWriteToken, RpcError } from "../_shared/phase5.ts";

const TOGGLE_TOKEN = Deno.env.get("CC_AUTO_ROUTE_TOGGLE_TOKEN") ?? "";
const VALID_STEPS = new Set(["gmail_test_users_added", "client_emits_owner_kind"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return json({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);
  if (!TOGGLE_TOKEN) return json({ error: "auto-route toggle token not configured" }, 500, access.headerValue);
  const toggleHeader = req.headers.get("x-cc-auto-route-toggle");
  if (!toggleHeader || toggleHeader !== TOGGLE_TOKEN) return json({ error: "missing or invalid x-cc-auto-route-toggle" }, 401, access.headerValue);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "body must be valid JSON" }, 400, access.headerValue);
  }

  const appId = cleanString((body as Record<string, unknown>)?.app_id, 80);
  const stepId = cleanString((body as Record<string, unknown>)?.step_id, 120);
  const done = (body as Record<string, unknown>)?.done;
  if (!appId || !UUID_RE.test(appId)) return json({ error: "app_id must be a valid uuid" }, 400, access.headerValue);
  if (!stepId || !VALID_STEPS.has(stepId)) return json({ error: "step_id must be one of: gmail_test_users_added, client_emits_owner_kind" }, 400, access.headerValue);
  if (typeof done !== "boolean") return json({ error: "done must be boolean" }, 400, access.headerValue);

  try {
    const result = await rpc<{ app_id: string; onboarding_steps: Record<string, unknown> }>("cc_set_app_onboarding_step", {
      p_app_id: appId,
      p_step_id: stepId,
      p_done: done,
      p_actor: access.actor,
    });
    return json({ app_id: result?.app_id ?? appId, onboarding_steps: result?.onboarding_steps ?? {} }, 200, access.headerValue);
  } catch (e) {
    if (e instanceof RpcError) return rpcErrorResponse(e, access.headerValue);
    return json({ error: "set onboarding step failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});
