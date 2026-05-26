import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cleanString, cpPatch, hmacSha256Hex, isRecord, json, rpc, RpcError, rpcErrorResponse, UUID_RE } from "../_shared/phase5.ts";

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
  const csrf = cleanString(body.csrf, 400);
  if (!rawToken) return publicJson(req, { error: "token is required" }, 400);
  if (!sendId || !UUID_RE.test(sendId)) return publicJson(req, { error: "send_id must be a valid uuid" }, 400);
  if (!optionId) return publicJson(req, { error: "option_id is required" }, 400);
  if (!csrf) return publicJson(req, { error: "csrf is required" }, 403);

  // Signed CSRF validation — Safari ITP blocks cross-site cookies set by
  // supabase.co for a netlify.app origin, so we use a stateless signed token
  // instead of a cookie+body match. The csrf payload binds to this exact
  // send_id + option_id and includes an expiry to prevent replay.
  const csrfCheck = await verifyCsrfToken(csrf, sendId, optionId);
  if (!csrfCheck.ok) return publicJson(req, { error: `CSRF validation failed: ${csrfCheck.reason}` }, 403);

  try {
    const tokenHash = await hmacSha256Hex(MAGIC_SECRET, `${sendId}:${optionId}:${rawToken}`);
    const result = await rpc("cc_confirm_decision_token", {
      p_token_hash: tokenHash,
      p_option_id: optionId,
      p_actor: "client-magic-link",
    });
    await markSendAnswered(sendId, optionId, tokenHash, decisionAnswerIdFromResult(result));
    return publicJson(req, { result }, 200, {
      "Cache-Control": "no-store",
    });
  } catch (e) {
    if (e instanceof RpcError) return withPublicCors(req, rpcErrorResponse(e));
    return publicJson(req, { error: "decision confirm failed" }, 500);
  }
});

async function markSendAnswered(sendId: string, optionId: string, tokenHash: string, decisionAnswerId: string): Promise<void> {
  const tokenFilter = encodeURIComponent(JSON.stringify([{ option_id: optionId, token_hash: tokenHash }]));
  await cpPatch(
    `cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&state=in.(sent,delivered,opened,clicked,reminded,awaiting_clarify,clarify_sent,replied,extracting,awaiting_operator_review)&magic_link_tokens=cs.${tokenFilter}`,
    {
      state: "answered",
      answered_at: new Date().toISOString(),
      operator_confirmed_by: "client-magic-link",
      operator_confirmed_at: new Date().toISOString(),
      selected_option: optionId,
      decision_answer_id: decisionAnswerId,
      clicked_at: new Date().toISOString(),
      last_error: null,
    },
  );
}

function decisionAnswerIdFromResult(result: unknown): string {
  if (!isRecord(result)) throw new Error("decision confirm returned no result object");
  const direct = cleanString(result.decision_answer_id, 80);
  if (direct && UUID_RE.test(direct)) return direct;
  const answer = isRecord(result.answer) ? cleanString(result.answer.decision_answer_id, 80) : null;
  if (answer && UUID_RE.test(answer)) return answer;
  const send = isRecord(result.send) ? cleanString(result.send.decision_answer_id, 80) : null;
  if (send && UUID_RE.test(send)) return send;
  throw new Error("decision confirm returned no decision_answer_id");
}

async function verifyCsrfToken(token: string, expectedSendId: string, expectedOptionId: string): Promise<{ ok: boolean; reason: string }> {
  const dot = token.lastIndexOf(".");
  if (dot < 1 || dot >= token.length - 1) return { ok: false, reason: "malformed" };
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = await hmacSha256Hex(MAGIC_SECRET, payloadB64);
  if (!timingSafeEqual(sig, expectedSig)) return { ok: false, reason: "signature" };
  let payload: { s?: unknown; o?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return { ok: false, reason: "payload" };
  }
  if (payload.s !== expectedSendId) return { ok: false, reason: "send_id mismatch" };
  if (payload.o !== expectedOptionId) return { ok: false, reason: "option_id mismatch" };
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (!exp || exp < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, reason: "ok" };
}

function base64UrlDecode(value: string): string {
  let b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return atob(b64);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

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


