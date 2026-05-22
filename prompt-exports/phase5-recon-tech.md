# Phase 5 Technical Architecture Report — Client Decision Email Engine

## §1. Schema additions — Migration `025_cc_decision_email_sends.sql`

```sql
BEGIN;

CREATE TYPE public.cc_decision_email_recipient_kind AS ENUM ('client', 'operator');

CREATE TYPE public.cc_decision_email_state AS ENUM (
  'queued', 'sent', 'delivered', 'opened', 'clicked',
  'replied', 'answered', 'done', 'reminded', 'bounced', 'expired', 'failed'
);

CREATE TABLE public.cc_decision_email_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  decision_answer_id uuid REFERENCES public.cc_decision_answers(id) ON DELETE SET NULL,
  issue_id uuid NOT NULL REFERENCES public.cc_issues(id) ON DELETE RESTRICT,
  app_id uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE RESTRICT,
  decision_external_ref text NOT NULL,
  recipient_email text NOT NULL,
  recipient_name text,
  recipient_kind public.cc_decision_email_recipient_kind NOT NULL DEFAULT 'client',
  options_snapshot jsonb NOT NULL,
  send_id text,
  magic_link_token_hash text NOT NULL,
  magic_link_expires_at timestamptz NOT NULL,
  state public.cc_decision_email_state NOT NULL DEFAULT 'queued',
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,
  answered_at timestamptz,
  reminded_at timestamptz,
  expired_at timestamptz,
  bounced_at timestamptz,
  last_error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  selected_option text,
  raw_reply_text text,
  llm_extraction jsonb,
  operator_confirmed_by text,
  operator_confirmed_at timestamptz
);
-- + indexes on token_hash, send_id, issue_id, app_id+state, pending reminders, expiry
-- + touch trigger, RLS service-role only
```

Companion table `cc_resend_webhook_events` for webhook idempotency (event_id UNIQUE).

State graph:
```
queued → sent → delivered → opened → clicked → answered → done
                                  → replied → operator-confirm → answered → done
                          → bounced
                          → expired (cron)
```

## §2. Edge functions to build (8 total)

1. **`cc-route-decision`** (POST, Access-authed) — operator triggers. Composes email, mints magic-link token (HMAC-hashed at rest), calls Resend, writes `cc_decision_email_sends`, audits `decision_routed`.

2. **`cc-decision-confirm-page`** (GET, public token-bound) — renders confirm page. NO writes. Validates token signature, expiry, state. Audits `decision_link_visited`.

3. **`cc-decision-confirm-submit`** (POST, token-bound + CSRF) — recipient pressed Confirm. Locks send row, revalidates token, calls `cc_resolve_issue`, calls `cc_enqueue_with_gating`. Idempotent (already-answered → friendly page).

4. **`cc-resend-webhook`** (POST, Resend HMAC) — receives delivered/opened/clicked/bounced/replied/inbound events. Dedupe via `cc_resend_webhook_events.event_id`. State promotion via rank function (answered > bounced > expired > clicked > replied > opened > delivered > sent > queued).

5. **`cc-extract-reply`** (internal, called from webhook on `inbound`) — LLM-parses raw reply against `options_snapshot`. Returns `{matched_option_id, confidence, reasoning, requires_human}`. Validates `matched_option_id` exists in snapshot. **Never auto-commits.**

6. **`cc-confirm-extraction`** (POST, Access-authed operator-only) — Brian's confirm queue endpoint. Picks the LLM extraction or overrides with a different option → commits via `cc_resolve_issue` → dispatches via `cc_enqueue_with_gating`.

7. **`cc-decision-reminder`** (POST, internal cron) — finds rows older than 3d in sent/delivered/opened with no answer, sends reminder using same option links, audits `decision_email_reminded`.

8. **`cc-decision-expire`** (POST, internal cron) — finds expired tokens, transitions to `expired`, audits.

## §3. Resend integration

Operator setup:
1. Resend account.
2. Verify sending domain `decisions.blackrockai.co` — DKIM/SPF/DMARC.
3. Generate API key + webhook secret.
4. Configure inbound parsing OR reply alias pattern (`reply+<email_send_id>@decisions.blackrockai.co`).
5. Store secrets: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `CC_MAGIC_LINK_SECRET`, `CC_INTERNAL_TOKEN`, `CC_PUBLIC_DECISION_BASE_URL`.

Rendering: pre-render MJML → HTML at build time, not runtime. Store compiled template as TS string imported by `cc-route-decision`.

## §4. MJML 5-slot template structure

```
<mjml>
  <mj-body>
    1. Header: BlackRock AI + {{app_badge}}
    2. Title: {{decision_title}}
    3. Context: greeting + {{decision_body}}
    4. Options: per-option <mj-button href="{{magic_link}}">{{label}}</mj-button>
    5. Footer: reply_instructions + expiry + unsubscribe placeholder
```

Each CTA carries token + option_id. Reply footer: "You can also reply to this email in plain English; Brian will confirm the parsed answer before it is applied."

## §5. LLM extraction service

Model: Claude Sonnet 4 (or equivalent). Provider-neutral interface.

Prompt template:
```
System: Extract the chosen option from a free-text reply.
Given an option set, return the option ID that best matches,
OR null if ambiguous, OR null if requests clarification.
Never invent. Never commit.

User:
Decision title: {{decision_title}}
Options JSON: {{options_snapshot}}
Reply text: {{raw_reply_text}}

Return JSON: { matched_option_id, confidence, reasoning, requires_human }
```

`requires_human` MUST be true when: confidence < 0.85, reply asks a question, reply has conditions not represented, multiple options match.

## §6. State transitions per Resend event

```
email.sent       → sent_at set, promote to "sent"
email.delivered  → delivered_at, promote to "delivered"
email.opened     → opened_at, promote to "opened" (only if not stronger)
email.clicked    → clicked_at, promote to "clicked", audit decision_link_visited
email.bounced    → bounced_at, state="bounced" (if not answered/done)
email.replied    → replied_at + raw_reply_text, promote to "replied", invoke cc-extract-reply
```

State rank prevents downgrade: answered/done > bounced/expired/failed > clicked > replied > opened > delivered > sent > queued.

## §7. Reverse-sync back to QEP

Both commit paths (magic-link button + operator confirm extraction) share:
1. Call `cc_resolve_issue(...)` → writes `cc_decision_answers`, transitions issue to `answered`, returns `decision_answer_id`.
2. Optional: call `cc_apply_decision_answer()` on QEP if QEP exposes that write contract; otherwise let aggregator surface state.
3. Call `cc_enqueue_with_gating(...)` → composed change_spec from ENUMERATED option only.

Invariants: free text NEVER enters `change_spec`. `target_repo`/`target_branch` stay server-bound.

## §8. Idempotency, retries, dead-letter

- Magic link GET: idempotent reads. POST: locks row, rejects duplicates with friendly page.
- Webhook dedupe: UNIQUE on `event_id`. Return 200 for duplicates.
- Outbound retries: increment `attempt_count`, fail after `max_attempts`.
- LLM retries: attempt 2× then fall through to `requires_human: true`.
- Dead-letter states: `failed`, `bounced`, `expired`.

Confirm queue filter:
```sql
SELECT * FROM cc_decision_email_sends
WHERE deleted_at IS NULL AND state = 'replied' AND decision_answer_id IS NULL
ORDER BY replied_at ASC;
```

## Builder checklist

- Migration `025_cc_decision_email_sends.sql` (+ optional `cc_resend_webhook_events` dedupe).
- 8 edge functions per §2.
- Reuse: Cloudflare Access auth (from `cc-answer-issue`), `cc_resolve_issue` atomic write, `cc_enqueue_with_gating`, federated proxy pattern from `cc-read-app-detail`.
- 5 Supabase secrets: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `CC_MAGIC_LINK_SECRET`, `CC_INTERNAL_TOKEN`, `CC_PUBLIC_DECISION_BASE_URL`.
