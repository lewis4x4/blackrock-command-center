import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, cleanString, cpAudit, isRecord, json, verifyWriteToken } from "../_shared/phase5.ts";

/*
cc-telegram-notify — outbound-only Telegram Bot API notifier.

Kill switch: when TELEGRAM_BOT_TOKEN or TELEGRAM_OPERATOR_CHAT_ID is unset, this
function returns HTTP 200 with { ok: true, skipped: "telegram_disabled" }. This
must never block work-order or handoff paths.

Manual smoke tests:

# 1. Gated work order — high severity pings.
curl -sS -X POST "$SUPABASE_URL/functions/v1/cc-telegram-notify" \
  -H "Content-Type: application/json" \
  -H "x-cc-write-token: $CC_WRITE_TOKEN" \
  -d '{"event_type":"work_order_gated","severity":"high","title":"Work order ready to authorize","body":"QEP has a gated work order waiting for Brian.","deep_link":"/agents"}'

# 2. Critical handoff — critical severity pings; lower severities are silent.
curl -sS -X POST "$SUPABASE_URL/functions/v1/cc-telegram-notify" \
  -H "Content-Type: application/json" \
  -H "x-cc-write-token: $CC_WRITE_TOKEN" \
  -d '{"event_type":"handoff_created","severity":"critical","title":"Manual handoff required","body":"A critical operator runbook is open.","deep_link":"/agents"}'

# 3. PR opened — any severity pings.
curl -sS -X POST "$SUPABASE_URL/functions/v1/cc-telegram-notify" \
  -H "Content-Type: application/json" \
  -H "x-cc-write-token: $CC_WRITE_TOKEN" \
  -d '{"event_type":"work_order_pr_opened","severity":"normal","title":"PR ready for review","body":"The runner opened a PR for review.","deep_link":"https://github.com/example/repo/pull/1"}'
*/

const FUNCTION_NAME = "cc-telegram-notify";
const TELEGRAM_API_BASE = "https://api.telegram.org";
const CP_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

type Severity = "low" | "normal" | "high" | "critical";
type NotifyEventType = "work_order_gated" | "handoff_created" | "work_order_pr_opened";

type NotifyPayload = {
  event_type: NotifyEventType | string;
  severity: Severity;
  app_id: string | null;
  title: string;
  body: string;
  deep_link: string | null;
};

type TelegramResponse = {
  ok?: boolean;
  result?: {
    message_id?: number;
  };
  error_code?: number;
  description?: string;
};

console.log(`[${FUNCTION_NAME}] ready`);

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json({ error: "body must be valid JSON" }, 400, ACCESS_REQUIRED ? "pass" : "noop");
  }

  const parsed = parsePayload(rawBody);
  if (!parsed.ok) return json({ error: parsed.error }, 400, ACCESS_REQUIRED ? "pass" : "noop");

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim() ?? "";
  const chatId = Deno.env.get("TELEGRAM_OPERATOR_CHAT_ID")?.trim() ?? "";
  if (!token || !chatId) {
    console.log(`[${FUNCTION_NAME}] skipped: telegram_disabled`, { event_type: parsed.payload.event_type });
    return json({ ok: true, skipped: "telegram_disabled" });
  }

  const auth = await verifyCaller(req);
  if (!auth.ok) return json({ error: auth.error ?? "unauthorized" }, auth.status, auth.headerValue);

  const gate = shouldNotify(parsed.payload.event_type, parsed.payload.severity);
  if (!gate.notify) {
    console.log(`[${FUNCTION_NAME}] skipped: ${gate.reason}`, { event_type: parsed.payload.event_type, severity: parsed.payload.severity });
    return json({ ok: true, skipped: gate.reason });
  }

  const text = renderTelegramMessage(parsed.payload);

  try {
    const telegram = await postTelegram(token, chatId, text);
    if (telegram.ok === true && typeof telegram.result?.message_id === "number") {
      console.log(`[${FUNCTION_NAME}] sent`, { event_type: parsed.payload.event_type, telegram_message_id: telegram.result.message_id });
      return json({ ok: true, telegram_message_id: telegram.result.message_id });
    }

    await auditFailure(parsed.payload, "telegram_api_error", {
      error_code: telegram.error_code ?? null,
      description: telegram.description ?? "Telegram API returned ok=false",
    });
    return json({ ok: false, error: { code: "telegram_api_error", telegram } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditFailure(parsed.payload, "telegram_request_failed", { message });
    return json({ ok: false, error: { code: "telegram_request_failed", message } });
  }
});

async function verifyCaller(req: Request): Promise<{ ok: true; status: 200; headerValue: "noop" | "pass" } | { ok: false; status: number; error?: string; headerValue: "noop" | "pass" }> {
  const auth = req.headers.get("Authorization") ?? "";
  if (CP_KEY && auth === `Bearer ${CP_KEY}`) return { ok: true, status: 200, headerValue: ACCESS_REQUIRED ? "pass" : "noop" };
  const writeAuth = verifyWriteToken(req);
  if (!writeAuth.ok) return { ok: false, status: writeAuth.status, error: writeAuth.error, headerValue: ACCESS_REQUIRED ? "pass" : "noop" };
  return { ok: true, status: 200, headerValue: ACCESS_REQUIRED ? "pass" : "noop" };
}

function parsePayload(value: unknown): { ok: true; payload: NotifyPayload } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "body must be a JSON object" };
  const eventType = cleanString(value.event_type, 80);
  const severity = normalizeSeverity(value.severity);
  const title = cleanString(value.title, 200);
  const body = cleanString(value.body, 2000);
  const appId = cleanString(value.app_id, 80);
  const deepLink = cleanString(value.deep_link, 1000);

  if (!eventType) return { ok: false, error: "event_type is required" };
  if (!severity) return { ok: false, error: "severity must be one of low, normal, high, critical" };
  if (!title) return { ok: false, error: "title is required" };
  if (!body) return { ok: false, error: "body is required" };
  if (appId && !isUuid(appId)) return { ok: false, error: "app_id must be a uuid when provided" };

  return { ok: true, payload: { event_type: eventType, severity, app_id: appId, title, body, deep_link: deepLink } };
}

function normalizeSeverity(value: unknown): Severity | null {
  const raw = cleanString(value, 20)?.toLowerCase();
  if (raw === "low" || raw === "normal" || raw === "high" || raw === "critical") return raw;
  return null;
}

function shouldNotify(eventType: string, severity: Severity): { notify: true } | { notify: false; reason: string } {
  if (eventType === "work_order_pr_opened") return { notify: true };
  if (eventType === "work_order_gated") return severityRank(severity) >= severityRank("high") ? { notify: true } : { notify: false, reason: "severity_below_gate" };
  if (eventType === "handoff_created") return severity === "critical" ? { notify: true } : { notify: false, reason: "severity_below_gate" };
  return { notify: false, reason: "unsupported_event_type" };
}

function severityRank(severity: Severity): number {
  if (severity === "critical") return 3;
  if (severity === "high") return 2;
  if (severity === "normal") return 1;
  return 0;
}

function renderTelegramMessage(payload: NotifyPayload): string {
  const lines = [
    `*${escapeMarkdownV2(payload.title)}*`,
    "",
    escapeMarkdownV2(payload.body),
  ];
  if (payload.deep_link) {
    lines.push("", escapeMarkdownV2(payload.deep_link));
  }
  return lines.join("\n");
}

function escapeMarkdownV2(value: string): string {
  return value.replace(/([_.*[\]()~`>#+\-=|{}!])/g, "\\$1");
}

async function postTelegram(token: string, chatId: string, text: string): Promise<TelegramResponse> {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    }),
  });
  const textBody = await response.text();
  let telegram: TelegramResponse = {};
  if (textBody) {
    try {
      const parsed = JSON.parse(textBody) as unknown;
      telegram = isRecord(parsed) ? parsed as TelegramResponse : { description: textBody };
    } catch {
      telegram = { description: textBody };
    }
  }
  if (!response.ok) {
    return { ...telegram, ok: false, error_code: telegram.error_code ?? response.status, description: telegram.description ?? `HTTP ${response.status}` };
  }
  return telegram;
}

async function auditFailure(payload: NotifyPayload, code: string, detail: Record<string, unknown>): Promise<void> {
  console.log(`[${FUNCTION_NAME}] failed`, { event_type: payload.event_type, code, ...detail });
  try {
    await cpAudit(payload.app_id, FUNCTION_NAME, "telegram_notify_failed", {
      code,
      event_type: payload.event_type,
      severity: payload.severity,
      title: payload.title,
      ...detail,
    });
  } catch (auditError) {
    console.log(`[${FUNCTION_NAME}] audit failed`, { error: auditError instanceof Error ? auditError.message : String(auditError) });
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
}
