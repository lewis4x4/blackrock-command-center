import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cleanString, cpGet, hmacSha256Hex, isRecord, json, randomToken, rpc, RpcError, rpcErrorResponse, UUID_RE } from "../_shared/phase5.ts";

const MAGIC_SECRET = Deno.env.get("CC_MAGIC_LINK_SECRET") ?? "";
const PUBLIC_APP_ORIGIN = new URL(Deno.env.get("CC_PUBLIC_DECISION_BASE_URL") ?? "https://blackrockai-command-center.netlify.app").origin;
const CSRF_TTL_MS = 15 * 60_000;

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
  // Signed CSRF token (no cookie) — payload binds the csrf to this exact
  // send_id + option_id + expiry so it cannot be replayed across decisions
  // or after expiry. Cookies don't work here because Safari ITP blocks
  // cross-site cookies set by supabase.co for a netlify.app origin.
  const csrf = await signCsrfToken(sendId, optionId);
  try {
    const tokenHash = await hmacSha256Hex(MAGIC_SECRET, `${sendId}:${optionId}:${rawToken}`);
    try {
      const data = await rpc("cc_get_decision_confirm_data", { p_token_hash: tokenHash, p_option_id: optionId });
      const alreadyAnswered = await maybeAlreadyAnsweredPayload(sendId, optionId, tokenHash, csrf);
      return publicJson(req, alreadyAnswered ?? { ...data as Record<string, unknown>, csrf }, 200, {
        "Cache-Control": "no-store",
      });
    } catch (e) {
      if (e instanceof RpcError) {
        const alreadyAnswered = await maybeAlreadyAnsweredPayload(sendId, optionId, tokenHash, csrf);
        if (alreadyAnswered) {
          return publicJson(req, alreadyAnswered, 200, {
            "Cache-Control": "no-store",
          });
        }
        return withPublicCors(req, rpcErrorResponse(e));
      }
      throw e;
    }
  } catch (_e) {
    return publicJson(req, { error: "decision link read failed" }, 500);
  }
});

type AlreadyAnsweredPayload = {
  send_id: string;
  selected_option_id: string;
  csrf: string;
  subject: string | null;
  body: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  options: unknown[];
  selected_option: Record<string, unknown> | null;
  expires_at: string | null;
  state: "already_answered";
  answer: {
    answered_by_name: string | null;
    answer_value: string | null;
    answer_label: string | null;
    answered_at: string | null;
    rationale: string | null;
  } | null;
};

async function maybeAlreadyAnsweredPayload(sendId: string, optionId: string, tokenHash: string, csrf: string): Promise<AlreadyAnsweredPayload | null> {
  const tokenFilter = encodeURIComponent(JSON.stringify([{ option_id: optionId, token_hash: tokenHash }]));
  const sendRows = await cpGet(
    `cc_decision_email_sends?id=eq.${sendId}&deleted_at=is.null&magic_link_tokens=cs.${tokenFilter}&select=id,issue_id,decision_external_ref,recipient_name,recipient_email,rewritten_subject,rewritten_body,options_snapshot,magic_link_expires_at,state,decision_answer_id,answered_at,selected_option`,
  );
  const send = sendRows.find(isRecord);
  if (!send) return null;

  const issueId = cleanString(send.issue_id, 80);
  const decisionExternalRef = cleanString(send.decision_external_ref, 500);
  if (!issueId || !UUID_RE.test(issueId) || !decisionExternalRef) return null;

  const answer = await loadDecisionAnswer(issueId, decisionExternalRef, cleanString(send.decision_answer_id, 80));
  const options = Array.isArray(send.options_snapshot) ? send.options_snapshot : [];
  if (!answer && cleanString(send.state, 40) !== "answered") return null;
  const answerValue = answer ? cleanString(answer.answer_value, 200) : cleanString(send.selected_option, 200);
  const answerLabel = answerValue ? optionLabel(options, answerValue) : null;
  const answeredSend = answer ? await loadAnsweredSend(issueId, decisionExternalRef, cleanString(answer.id, 80)) : send;
  const answeredByName = cleanString(answer?.answered_by, 500) ?? cleanString(answeredSend?.recipient_name, 320);

  return {
    send_id: cleanString(send.id, 80) ?? sendId,
    selected_option_id: optionId,
    csrf,
    subject: cleanString(send.rewritten_subject, 500),
    body: cleanString(send.rewritten_body, 5000),
    recipient_name: cleanString(send.recipient_name, 320),
    recipient_email: cleanString(send.recipient_email, 320),
    options: options.map(stripMagicOption),
    selected_option: optionByValue(options, optionId),
    expires_at: cleanString(send.magic_link_expires_at, 80),
    state: "already_answered",
    answer: answerValue ? {
      answered_by_name: displayAnsweredBy(answeredByName, answeredSend),
      answer_value: answerValue,
      answer_label: answerLabel,
      answered_at: answer ? cleanString(answer.answered_at, 80) : cleanString(send.answered_at, 80),
      rationale: answer ? cleanString(answer.rationale, 5000) : null,
    } : null,
  };
}

async function loadDecisionAnswer(issueId: string, decisionExternalRef: string, decisionAnswerId: string | null): Promise<Record<string, unknown> | null> {
  const encodedRef = encodeURIComponent(decisionExternalRef);
  const idFilter = decisionAnswerId && UUID_RE.test(decisionAnswerId) ? `&id=eq.${decisionAnswerId}` : "";
  const answerRows = await cpGet(
    `cc_decision_answers?issue_id=eq.${issueId}&decision_external_ref=eq.${encodedRef}&deleted_at=is.null${idFilter}&select=id,answer_value,rationale,answered_by,answered_at&order=answered_at.desc&limit=1`,
  );
  return answerRows.find(isRecord) ?? null;
}

async function loadAnsweredSend(issueId: string, decisionExternalRef: string, decisionAnswerId: string | null): Promise<Record<string, unknown> | null> {
  const encodedRef = encodeURIComponent(decisionExternalRef);
  const idFilter = decisionAnswerId && UUID_RE.test(decisionAnswerId) ? `&decision_answer_id=eq.${decisionAnswerId}` : "";
  const sendRows = await cpGet(
    `cc_decision_email_sends?issue_id=eq.${issueId}&decision_external_ref=eq.${encodedRef}&deleted_at=is.null&state=eq.answered${idFilter}&select=recipient_name,recipient_email,answered_at&order=answered_at.desc&limit=1`,
  );
  return sendRows.find(isRecord) ?? null;
}

function stripMagicOption(option: unknown): unknown {
  if (!isRecord(option)) return option;
  const safeOption = { ...option };
  delete safeOption.token_hash;
  delete safeOption.confirm_url;
  return safeOption;
}

function optionByValue(options: unknown[], value: string): Record<string, unknown> | null {
  for (const option of options) {
    if (!isRecord(option)) continue;
    const optionValue = cleanString(option.id, 200) ?? cleanString(option.value, 200) ?? cleanString(option.key, 200);
    if (optionValue === value) return stripMagicOption(option) as Record<string, unknown>;
  }
  return null;
}

function optionLabel(options: unknown[], value: string): string | null {
  const option = optionByValue(options, value);
  if (!option) return value;
  return cleanString(option.label, 500) ?? cleanString(option.name, 500) ?? cleanString(option.title, 500) ?? value;
}

function displayAnsweredBy(answeredBy: string | null, answeredSend: Record<string, unknown> | null): string | null {
  if (!answeredBy || answeredBy === "client-magic-link") return cleanString(answeredSend?.recipient_name, 320) ?? cleanString(answeredSend?.recipient_email, 320);
  return answeredBy;
}

async function signCsrfToken(sendId: string, optionId: string): Promise<string> {
  const payload = {
    s: sendId,
    o: optionId,
    n: randomToken(12),
    exp: Date.now() + CSRF_TTL_MS,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = await hmacSha256Hex(MAGIC_SECRET, payloadB64);
  return `${payloadB64}.${sig}`;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

function pathToken(pathname: string): string | null {
  const match = pathname.match(/\/c\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
