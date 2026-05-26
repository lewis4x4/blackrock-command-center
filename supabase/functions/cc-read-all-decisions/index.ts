import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, CP_URL, cpHeaders, isRecord, json, verifyAccessJwt } from "../_shared/phase5.ts";

const FUNCTION_NAME = "cc-read-all-decisions";
const PAGE_SIZE = 1000;

console.log(`[${FUNCTION_NAME}] ready`);

type AnyRecord = Record<string, unknown>;

type DecisionAdminRow = {
  id: string;
  app_id: string;
  app_short_code: string | null;
  app_display_name: string | null;
  issue_type: string;
  source_ref: string;
  status: string;
  severity: string;
  title: string;
  summary: string | null;
  detail: AnyRecord | null;
  context: AnyRecord | null;
  surfaced_at: string | null;
  last_seen_at: string | null;
  resolved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  send_count: number;
  answer_count: number;
  late_reply_count: number;
  last_action_at: string | null;
  last_action: string | null;
  sends: AnyRecord[];
  answers: AnyRecord[];
  audit_events: AnyRecord[];
  late_replies: AnyRecord[];
};

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nestedRecord(value: unknown): AnyRecord | null {
  if (Array.isArray(value)) return value.find(isRecord) ?? null;
  return isRecord(value) ? value : null;
}

async function cpGetAll(path: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const r = await fetch(`${CP_URL}/rest/v1/${path}`, {
      headers: { ...cpHeaders, Range: `${offset}-${offset + PAGE_SIZE - 1}` },
    });
    if (!r.ok) throw new Error(`control-plane GET ${path} -> ${r.status} ${await r.text()}`);
    const page = await r.json() as unknown;
    const items = Array.isArray(page) ? page : [];
    rows.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return rows;
}

function issueDecisionRef(issue: AnyRecord): string | null {
  const detail = isRecord(issue.detail) ? issue.detail : null;
  const context = isRecord(issue.context) ? issue.context : null;
  return asString(issue.source_ref)
    ?? asString(detail?.decision_external_ref)
    ?? asString(detail?.external_ref)
    ?? asString(detail?.decision_id)
    ?? asString(context?.decision_external_ref)
    ?? null;
}

function appFields(issue: AnyRecord): { shortCode: string | null; displayName: string | null } {
  const app = nestedRecord(issue.registry_apps);
  return {
    shortCode: app ? asString(app.short_code) : null,
    displayName: app ? asString(app.display_name) : null,
  };
}

function eventIssueId(event: AnyRecord): string | null {
  const detail = isRecord(event.detail) ? event.detail : null;
  return asString(detail?.issue_id);
}

function eventDecisionRef(event: AnyRecord): string | null {
  const detail = isRecord(event.detail) ? event.detail : null;
  return asString(detail?.decision_external_ref) ?? asString(detail?.source_ref);
}

function ts(value: unknown): number {
  const raw = asString(value);
  if (!raw) return 0;
  const n = Date.parse(raw);
  return Number.isNaN(n) ? 0 : n;
}

function mostRecentAction(issue: AnyRecord, sends: AnyRecord[], answers: AnyRecord[], audits: AnyRecord[], lateReplies: AnyRecord[]): { at: string | null; label: string | null } {
  const candidates: Array<{ at: string | null; label: string }> = [
    { at: asString(issue.updated_at) ?? asString(issue.created_at), label: `issue ${asString(issue.status) ?? "updated"}` },
    ...sends.map((send) => ({ at: asString(send.updated_at) ?? asString(send.created_at), label: `email ${asString(send.state) ?? "send"}` })),
    ...answers.map((answer) => ({ at: asString(answer.answered_at) ?? asString(answer.created_at), label: `answered: ${asString(answer.answer_value) ?? "choice"}` })),
    ...audits.map((event) => ({ at: asString(event.occurred_at), label: asString(event.event_type) ?? "audit event" })),
    ...lateReplies.map((reply) => ({ at: asString(reply.created_at) ?? asString(reply.surfaced_at), label: "late reply" })),
  ].filter((item) => !!item.at);
  candidates.sort((a, b) => ts(b.at) - ts(a.at));
  return { at: candidates[0]?.at ?? null, label: candidates[0]?.label ?? null };
}

function normalizeAudit(event: AnyRecord): AnyRecord {
  const app = nestedRecord(event.registry_apps);
  const { registry_apps: _registryApps, ...rest } = event;
  void _registryApps;
  return {
    ...rest,
    app_short_code: app ? asString(app.short_code) : null,
    app_display_name: app ? asString(app.display_name) : null,
  };
}

function buildDecisionRows(issues: AnyRecord[], sends: AnyRecord[], answers: AnyRecord[], audits: AnyRecord[]): DecisionAdminRow[] {
  const openDecisions = issues.filter((issue) => asString(issue.issue_type) === "open_decision");
  const lateReplyIssues = issues.filter((issue) => asString(issue.issue_type) === "late_reply");

  return openDecisions.map((issue) => {
    const id = asString(issue.id) ?? "";
    const appId = asString(issue.app_id) ?? "";
    const ref = issueDecisionRef(issue);
    const relatedSends = sends.filter((send) =>
      asString(send.issue_id) === id ||
      (!!ref && asString(send.app_id) === appId && asString(send.decision_external_ref) === ref)
    );
    const relatedAnswers = answers.filter((answer) =>
      asString(answer.issue_id) === id ||
      (!!ref && asString(answer.app_id) === appId && asString(answer.decision_external_ref) === ref)
    );
    const relatedAudits = audits.filter((event) =>
      eventIssueId(event) === id ||
      (!!ref && asString(event.app_id) === appId && eventDecisionRef(event) === ref)
    ).map(normalizeAudit);
    const relatedLateReplies = lateReplyIssues.filter((late) => {
      const lateRef = issueDecisionRef(late);
      const lateContext = isRecord(late.context) ? late.context : {};
      const lateDetail = isRecord(late.detail) ? late.detail : {};
      return asString(late.app_id) === appId && (
        (!!ref && lateRef === ref) ||
        asString(lateContext.open_decision_issue_id) === id ||
        asString(lateDetail.issue_id) === id
      );
    });
    const app = appFields(issue);
    const action = mostRecentAction(issue, relatedSends, relatedAnswers, relatedAudits, relatedLateReplies);

    return {
      id,
      app_id: appId,
      app_short_code: app.shortCode,
      app_display_name: app.displayName,
      issue_type: asString(issue.issue_type) ?? "open_decision",
      source_ref: asString(issue.source_ref) ?? "",
      status: asString(issue.status) ?? "surfaced",
      severity: asString(issue.severity) ?? "normal",
      title: asString(issue.title) ?? "Untitled decision",
      summary: asString(issue.summary),
      detail: isRecord(issue.detail) ? issue.detail : null,
      context: isRecord(issue.context) ? issue.context : null,
      surfaced_at: asString(issue.surfaced_at),
      last_seen_at: asString(issue.last_seen_at),
      resolved_at: asString(issue.resolved_at),
      created_at: asString(issue.created_at),
      updated_at: asString(issue.updated_at),
      send_count: relatedSends.length,
      answer_count: relatedAnswers.length,
      late_reply_count: relatedLateReplies.length,
      last_action_at: action.at,
      last_action: action.label,
      sends: relatedSends,
      answers: relatedAnswers,
      audit_events: relatedAudits,
      late_replies: relatedLateReplies,
    };
  }).sort((a, b) => ts(b.last_action_at ?? b.updated_at) - ts(a.last_action_at ?? a.updated_at));
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "GET") return json({ error: "GET or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(
    ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"),
  );
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  try {
    const [issuesRaw, sendsRaw, answersRaw, auditsRaw] = await Promise.all([
      cpGetAll("cc_issues?select=id,app_id,issue_type,source_ref,status,severity,title,summary,detail,context,surfaced_at,last_seen_at,resolved_at,created_at,updated_at,registry_apps(short_code,display_name)&deleted_at=is.null&order=updated_at.desc"),
      cpGetAll("cc_decision_email_sends?select=id,created_at,updated_at,issue_id,app_id,decision_external_ref,recipient_email,recipient_name,state,sent_at,replied_at,inbound_received_at,raw_reply_text,selected_option,decision_answer_id,created_via,raw_decision_title,last_error&deleted_at=is.null&order=created_at.asc"),
      cpGetAll("cc_decision_answers?select=id,created_at,updated_at,issue_id,app_id,decision_external_ref,answer_value,answer_options_snapshot,rationale,risk_class,answered_by,answered_at,dispatched_at,deleted_at&deleted_at=is.null&order=answered_at.asc"),
      cpGetAll("cc_audit_events?select=occurred_at,actor,event_type,detail,app_id,registry_apps(short_code,display_name)&order=occurred_at.asc"),
    ]);

    const issues = issuesRaw.filter(isRecord);
    const sends = sendsRaw.filter(isRecord);
    const answers = answersRaw.filter(isRecord);
    const audits = auditsRaw.filter(isRecord);
    const decisions = buildDecisionRows(issues, sends, answers, audits);

    return json({ decisions, generated_at: new Date().toISOString() }, 200, access.headerValue);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: "database read failed", detail: msg }, 500, access.headerValue);
  }
});
