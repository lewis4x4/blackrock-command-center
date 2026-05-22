import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cleanString, hmacSha256Hex, isRecord, json, rpc, RpcError, rpcErrorResponse, UUID_RE } from "../_shared/phase5.ts";

const MAGIC_SECRET = Deno.env.get("CC_MAGIC_LINK_SECRET") ?? "";
const PUBLIC_APP_ORIGIN = new URL(Deno.env.get("CC_PUBLIC_DECISION_BASE_URL") ?? "https://blackrockai-command-center.netlify.app").origin;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return publicJson(req, { ok: true });
  if (req.method !== "POST") return publicJson(req, { error: "POST or OPTIONS only" }, 405);
  if (!MAGIC_SECRET) return publicJson(req, { error: "CC_MAGIC_LINK_SECRET is not configured" }, 500);

  let body: unknown;
  try { body = await req.json(); } catch { return publicJson(req, { error: "body must be valid JSON" }, 400); }
  if (!isRecord(body)) return publicJson(req, { error: "body must be a JSON object" }, 400);
  const rawToken = cleanString(body.token, 200);
  const sendId = cleanString(body.send_id, 80);
  const optionId = cleanString(body.option_id, 200);
  const csrf = cleanString(body.csrf, 200);
  const cookieCsrf = cookieValue(req.headers.get("Cookie") ?? "", "cc_decision_csrf");
  if (!rawToken) return publicJson(req, { error: "token is required" }, 400);
  if (!sendId || !UUID_RE.test(sendId)) return publicJson(req, { error: "send_id must be a valid uuid" }, 400);
  if (!optionId) return publicJson(req, { error: "option_id is required" }, 400);
  if (!csrf || !cookieCsrf || csrf !== cookieCsrf) return publicJson(req, { error: "CSRF validation failed" }, 403);

  try {
    const tokenHash = await hmacSha256Hex(MAGIC_SECRET, `${sendId}:${optionId}:${rawToken}`);
    const result = await rpc("cc_confirm_decision_token", {
      p_token_hash: tokenHash,
      p_option_id: optionId,
      p_actor: "client-magic-link",
    });
    return publicJson(req, { result }, 200, {
      "Set-Cookie": "cc_decision_csrf=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None",
      "Cache-Control": "no-store",
    });
  } catch (e) {
    if (e instanceof RpcError) return withPublicCors(req, rpcErrorResponse(e));
    return publicJson(req, { error: "decision confirm failed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});

function publicJson(req: Request, body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return json(body, status, "noop", publicHeaders(req, headers));
}

function withPublicCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(publicHeaders(req))) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

function publicHeaders(req: Request, extra: Record<string, string> = {}): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allowedOrigin = origin === PUBLIC_APP_ORIGIN ? origin : PUBLIC_APP_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Credentials": "true",
    ...extra,
  };
}

function cookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
