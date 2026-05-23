import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, cleanString, isRecord, json, rpc, RpcError, rpcErrorResponse, verifyAccessJwt, UUID_RE, verifyWriteToken } from "../_shared/phase5.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");
  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return json({ error: writeAuth.error ?? "forbidden" }, writeAuth.status, access.headerValue);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, access.headerValue); }
  if (!isRecord(body)) return json({ error: "body must be a JSON object" }, 400, access.headerValue);
  const recipientId = cleanString(body.recipient_id, 80);
  if (!recipientId || !UUID_RE.test(recipientId)) return json({ error: "recipient_id must be a valid uuid" }, 400, access.headerValue);
  if (body.active !== undefined && typeof body.active !== "boolean") return json({ error: "active must be boolean when provided" }, 400, access.headerValue);
  try {
    const recipient = await rpc("cc_edit_decision_recipient", {
      p_recipient_id: recipientId,
      p_contact_name: cleanString(body.contact_name, 160),
      p_contact_email: cleanString(body.contact_email, 320),
      p_contact_role: body.contact_role === null ? "" : cleanString(body.contact_role, 80),
      p_active: body.active,
      p_actor: access.actor,
    });
    return json({ recipient }, 200, access.headerValue);
  } catch (e) {
    if (e instanceof RpcError) return rpcErrorResponse(e, access.headerValue);
    return json({ error: "recipient edit failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});
