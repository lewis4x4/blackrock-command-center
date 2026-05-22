import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cleanString, hmacSha256Hex, json, randomToken, rpc, RpcError, rpcErrorResponse, UUID_RE } from "../_shared/phase5.ts";

const MAGIC_SECRET = Deno.env.get("CC_MAGIC_LINK_SECRET") ?? "";
const PUBLIC_APP_ORIGIN = new URL(Deno.env.get("CC_PUBLIC_DECISION_BASE_URL") ?? "https://blackrockai-command-center.netlify.app").origin;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return publicJson(req, { ok: true });
  if (req.method !== "GET") return publicJson(req, { error: "GET or OPTIONS only" }, 405);
  if (!MAGIC_SECRET) return publicJson(req, { error: "CC_MAGIC_LINK_SECRET is not configured" }, 500);
  const url = new URL(req.url);
  const rawToken = cleanString(url.searchParams.get("t") ?? url.searchParams.get("token"), 200) ?? cleanString(pathToken(url.pathname), 200);
  const sendId = cleanString(url.searchParams.get("s") ?? url.searchParams.get("send_id"), 80);
  const optionId = cleanString(url.searchParams.get("o") ?? url.searchParams.get("option_id"), 200);
  if (!rawToken) return publicJson(req, { error: "token is required" }, 400);
  if (!sendId || !UUID_RE.test(sendId)) return publicJson(req, { error: "send_id is required" }, 400);
  if (!optionId) return publicJson(req, { error: "option_id is required" }, 400);
  const csrf = randomToken(24);
  try {
    const tokenHash = await hmacSha256Hex(MAGIC_SECRET, `${sendId}:${optionId}:${rawToken}`);
    const data = await rpc("cc_get_decision_confirm_data", { p_token_hash: tokenHash, p_option_id: optionId });
    return publicJson(req, { ...data as Record<string, unknown>, csrf }, 200, {
      "Set-Cookie": `cc_decision_csrf=${csrf}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=None`,
      "Cache-Control": "no-store",
    });
  } catch (e) {
    if (e instanceof RpcError) return withPublicCors(req, rpcErrorResponse(e));
    return publicJson(req, { error: "decision link read failed", detail: e instanceof Error ? e.message : String(e) }, 500);
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

function pathToken(pathname: string): string | null {
  const match = pathname.match(/\/c\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
