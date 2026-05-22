# Phase 5 — Email Decision Engine — Master Plan

**Compiled:** 2026-05-22
**Method:** Four specialist recon agents — Security, Technical Architecture, UX, CEO/Strategic — each produced one angle. This document synthesizes all four into one build-ready plan.
**Scope:** Closes the client-facing decision loop. Operator routes a decision via email → recipient answers → answer commits → work order dispatches → PR opens. The last unbuilt phase of the OS Roadmap.
**Recon sources (read these for depth):**
- `prompt-exports/phase5-recon-ceo.md`
- `prompt-exports/phase5-recon-security.md`
- `prompt-exports/phase5-recon-tech.md`
- `docs/designs/PHASE_5_UX_RECON.md`

---

## 0. Operator's ready-to-build checklist

Run these before greenlighting Slice 1 — the agents are blocked until each is done.

- [ ] **Resend account** created at https://resend.com.
- [ ] **Sending domain verified** — recommended `decisions.blackrockai.co` (NOT root domain — keeps reputation blast radius contained).
- [ ] **DKIM / SPF / DMARC** DNS records configured for that subdomain (DNS propagation can take hours; do this first).
- [ ] **`RESEND_API_KEY`** generated, ready to `supabase secrets set` on the control plane.
- [ ] **`RESEND_WEBHOOK_SECRET`** generated (for verifying inbound + delivery webhooks).
- [ ] **Claude Code CLI authenticated on Mac Studio** — `claude --version` succeeds (already true since the runner uses it). The runner daemon picks up LLM extraction tasks via the operator's existing Anthropic subscription — no API key billing, no monthly cap, no additional vendor. Slice 2 only.
- [ ] **First friendly-client recipient identified.** Recommendation: Brian himself OR one QEP business owner who knows about the experiment. NOT all six clients on day one.
- [ ] **30 minutes blocked** on Brian's calendar to run the Slice 1 smoke test (route a real QEP decision → click confirm → verify work order queues).

---

## 1. Executive summary

Phase 5 transforms the Command Center from an internal cockpit into a **client-facing decision loop**. Today Brian sees that a QEP build is blocked on a decision; Phase 5 lets him route that decision to the right business owner, get an answer back, confirm it safely, and unblock the build — without chasing email threads.

**MVP cut: outbound + button-confirm only.** The platform proves the loop with magic-link confirmation pages (security-critical) before adding free-text reply parsing. Sub-phases:

1. **Slice 1 — Outbound + magic-link button** *(MVP, ~half-day agent)*
2. **Slice 2 — Inbound + LLM extraction + operator confirm queue** *(when Slice 1 is proven)*
3. **Slice 3 — Reminders + expiry + polish** *(when Brian wants hands-off operation)*

If recipients click buttons reliably, Slice 2 may not be worth building for months. Honest about deferring.

---

## 2. Strategic frame

### Why Phase 5 matters

Brian's stated pain across the platform's six client apps: decisions chased over email, status lives in his head, builds blocked on un-answered questions. Phase 5 closes the last missing link of the OS Roadmap's "Decision Inbox → Answer → Build" loop. The Command Center already shows decisions and lets Brian answer operator-owned ones inline. Client-owned ones today require manual email-handling outside the platform. Phase 5 brings that work into the system, with the security boundaries intact.

### MVP cut — must / maybe / cut

**Must ship (v1.0):**
- Outbound email send via Resend.
- Magic-link confirm page (the security-critical part — scanner pre-clicks must not commit answers).
- One operator confirm queue UI surface.
- Work-order dispatch on confirmed answer (uses existing `cc_enqueue_with_gating`).

**Maybe ship if cheap:**
- Branded MJML template (a clean simple template is fine for friendly-client v1).
- Reminder cron (manual nudges are acceptable for week-one).

**Cut to v1.1+:**
- Bulk operations, deliverability dashboards, per-client template customization, A/B subject lines, weekly digest emails.
- Full free-text reply extraction if Slice 1 proves button-confirm is enough.

### Business risks (not technical — those go in §7)

| Risk | Mitigation |
|---|---|
| **Deliverability damage** — misconfigured domain → spam → reputation hit | Dedicated subdomain `decisions.blackrockai.co`; warm-up with one friendly recipient first; never blast all six clients on day one |
| **Client confusion** — recipient doesn't know what "BlackRock AI Command Center" is | First-email copy: "This is from Brian Lewis; your answer routes directly back to me and unblocks the QEP build." |
| **Trust erosion** — LLM extraction APPEARS to work and commits wrong answer | Confirm queue is mandatory gate, never auto-commit; Slice 2 explicitly designed around this |
| **Operator overload** — every reply hits Brian's queue | v1.0 rule: button confirmations commit; free-text replies require Brian; future auto-confirm rules are explicitly out of scope |
| **Wrong owner routing** — a "client-only" question gets routed to an internal teammate | Cockpit "Route" button is a deliberate operator action, not automatic; UI shows app + owner clearly before send |

### Success metrics

| Metric | Target |
|---|---|
| Decisions routed per week | Enough real usage to learn (no specific count) |
| Median time from `routed` → `answered` | Hours, not days |
| Button answers vs reply answers | Button-dominant (≥70%) means low-friction is working |
| LLM extraction acceptance rate | ≥80% — if lower, build correction tools before automation |
| Bounces / spam reports | Zero spam reports tolerated; any = stop sign |
| Brian's confirm-queue clear time | <2 min per item |

### Stop conditions

- After Slice 1: if magic-link confirm works for 90%+ of recipients → defer Slice 2 for months.
- After Slice 2: if confirm queue >10 items/day → build auto-confirm rules BEFORE Slice 3 reminders.
- Stop all feature work if deliverability is weak, emails land in spam, or recipients report confusion. Invest in inbox placement first.
- Don't scale to all six clients until owner mapping is reliable.

---

## 3. Architecture overview

```
┌─────────────┐   ┌──────────────────┐   ┌─────────────┐   ┌──────────────┐
│  Operator   │──▶│ cc-route-decision│──▶│   Resend    │──▶│  Recipient   │
│  (cockpit)  │   │  (control plane) │   │  outbound   │   │    inbox     │
└─────────────┘   └─────────┬────────┘   └─────────────┘   └──────┬───────┘
                            │                                       │
                  cc_decision_email_sends                            │
                  (state: sent, token hash stored)                   │
                                                                     │
                  ┌──────────────────────────────────────────────────┴──┐
                  │                                                     │
            (option button click)                              (replies in plain text)
                  │                                                     │
                  ▼                                                     ▼
   ┌──────────────────────────────┐                     ┌──────────────────────────────┐
   │ cc-decision-confirm-page (GET)│                     │     Resend inbound webhook    │
   │  validates token              │                     │                              │
   │  audits decision_link_visited │                     │                              │
   │  RENDERS confirm page (no DB) │                     │                              │
   └────────────┬─────────────────┘                     └────────────┬─────────────────┘
                │                                                     │
       (operator-equivalent click)                          ┌─────────▼─────────┐
                │                                          │ cc-resend-webhook  │
                ▼                                          │  verifies HMAC     │
   ┌──────────────────────────────┐                       │  dedupes event     │
   │cc-decision-confirm-submit POST│                       │  stores raw reply  │
   │  validates token + CSRF      │                       │  state=replied     │
   │  calls cc_resolve_issue      │                       └─────────┬─────────┘
   │  state=answered              │                                 │
   └────────────┬─────────────────┘                                 ▼
                │                                ┌────────────────────────────────┐
                │                                │  Mac Studio runner daemon      │
                │                                │  polls for state=replied rows  │
                │                                │  runs `claude` CLI locally     │
                │                                │  (existing subscription)       │
                │                                │  LLM proposal ONLY             │
                │                                │  NEVER commits                 │
                │                                └─────────┬──────────────────────┘
                │                                                 │
                │                                                 ▼
                │                                    ┌─────────────────────────┐
                │                                    │ Operator confirm queue  │
                │                                    │ (Decisions page band)   │
                │                                    │ Brian reviews + commits │
                │                                    └─────────┬───────────────┘
                │                                              │
                │                                              ▼
                │                              ┌──────────────────────────────┐
                │                              │   cc-confirm-extraction      │
                │                              │   calls cc_resolve_issue     │
                │                              │   state=answered             │
                │                              └────────────┬─────────────────┘
                │                                           │
                └──────────────────┬────────────────────────┘
                                   │
                                   ▼
                  ┌────────────────────────────┐
                  │ cc_enqueue_with_gating     │
                  │ → agent_work_orders queue  │
                  └─────────────┬──────────────┘
                                │
                                ▼
                  ┌────────────────────────────┐
                  │  Mac Studio runner daemon  │
                  │  → opens PR in client repo │
                  └────────────────────────────┘
```

**Key invariants in this flow:**

- LLM is an **untrusted suggestion source**. Its output never commits without operator confirm.
- Every commit path (magic-link click OR operator confirm) goes through the existing `cc_resolve_issue` + `cc_enqueue_with_gating` RPCs. No new commit pathway is introduced.
- Raw magic-link tokens **never** stored at rest — only HMAC hashes.
- `target_repo` and `target_branch` stay server-bound from the registry. Email never names a repo.
- **LLM extraction runs on the Mac Studio runner via `claude` CLI**, not via an external API. Reply text never leaves the operator's hardware until the operator confirms. Uses the existing Anthropic subscription — zero additional billing.

---

## 4. The non-negotiables (these never automate)

Per OS Roadmap §8 + Master Plan §3, lifted from the security recon:

1. **Customer input cannot reach the agent as instructions.** Email bodies and rationales are *data/provenance only*. They produce a candidate `option_id` (validated against the enumerated set), never appear as imperative text in `change_spec`.

2. **Customer input cannot choose the build target.** Tokens, replies, and LLM outputs never contain or accept repo/branch. Work orders read `target_repo`/`target_branch` from `registry_app_repo` by `app_id` only.

3. **AUTHORIZE / destructive / production work never auto-dispatches.** A confirmed client answer may *create* a work order, but `risk_class` is re-derived server-side. Anything beyond `auto`-class under the cost cap requires Brian's one-press approval — same Phase 4 gate.

4. **Brian's confirm gate on every free-text reply, full stop.** Magic-link button answers can commit after token/CSRF validation (enumerated). Free-text replies cannot — they always go through the operator confirm queue.

5. **PR merge always human-gated.** Phase 5 may unblock build dispatch and PR creation, but Brian merges. The PR-triage band on the home is unchanged.

---

## 5. Schema — Migration `025_cc_decision_email_sends.sql`

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
  send_id text,                          -- Resend message id
  magic_link_token_hash text NOT NULL,   -- HMAC-SHA256(secret, raw_token); raw token NEVER stored
  magic_link_expires_at timestamptz NOT NULL,
  state public.cc_decision_email_state NOT NULL DEFAULT 'queued',
  sent_at timestamptz, delivered_at timestamptz, opened_at timestamptz,
  clicked_at timestamptz, replied_at timestamptz, answered_at timestamptz,
  reminded_at timestamptz, expired_at timestamptz, bounced_at timestamptz,
  last_error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  selected_option text,
  raw_reply_text text,                   -- quarantined; service-role only
  llm_extraction jsonb,                  -- {matched_option_id, confidence, reasoning, requires_human}
  extraction_started_at timestamptz,     -- runner claim marker; prevents double-processing
  extraction_runner_id text,             -- which Mac Studio runner is processing this
  operator_confirmed_by text,
  operator_confirmed_at timestamptz,
  CONSTRAINT cc_decision_email_sends_options_array
    CHECK (jsonb_typeof(options_snapshot) = 'array'),
  CONSTRAINT cc_decision_email_sends_answer_consistency
    CHECK (
      state NOT IN ('answered','done')
      OR (decision_answer_id IS NOT NULL AND answered_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX cc_decision_email_sends_token_hash_idx
  ON public.cc_decision_email_sends (magic_link_token_hash)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX cc_decision_email_sends_send_id_idx
  ON public.cc_decision_email_sends (send_id)
  WHERE send_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX cc_decision_email_sends_issue_idx
  ON public.cc_decision_email_sends (issue_id) WHERE deleted_at IS NULL;
CREATE INDEX cc_decision_email_sends_app_state_idx
  ON public.cc_decision_email_sends (app_id, state, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX cc_decision_email_sends_pending_reminder_idx
  ON public.cc_decision_email_sends (state, sent_at, reminded_at)
  WHERE deleted_at IS NULL AND state IN ('sent','delivered','opened');
CREATE INDEX cc_decision_email_sends_expiry_idx
  ON public.cc_decision_email_sends (magic_link_expires_at)
  WHERE deleted_at IS NULL AND state NOT IN ('answered','done','expired','bounced');

CREATE TRIGGER cc_decision_email_sends_touch
  BEFORE UPDATE ON public.cc_decision_email_sends
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.cc_decision_email_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY cc_decision_email_sends_service_all
  ON public.cc_decision_email_sends FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON public.cc_decision_email_sends FROM anon, authenticated;
GRANT ALL ON public.cc_decision_email_sends TO service_role;

-- Webhook idempotency dedupe table
CREATE TABLE public.cc_resend_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL UNIQUE,
  send_id text,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  processed_at timestamptz,
  last_error text
);
ALTER TABLE public.cc_resend_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY cc_resend_webhook_events_service_all
  ON public.cc_resend_webhook_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON public.cc_resend_webhook_events FROM anon, authenticated;
GRANT ALL ON public.cc_resend_webhook_events TO service_role;

COMMIT;
```

### State graph

```
queued
  └─send ok→ sent
      ├─email.delivered→ delivered
      │   ├─email.opened→ opened
      │   │   ├─email.clicked→ clicked
      │   │   │   └─confirm-submit→ answered → done
      │   │   └─email.replied→ replied → operator-confirm→ answered → done
      ├─email.bounced→ bounced
      └─expire-cron→ expired

Hard failures → failed.
```

### State promotion (prevents downgrade)

```typescript
const stateRank = {
  queued: 0, sent: 1, delivered: 2, opened: 3, clicked: 4,
  replied: 5, answered: 6, done: 7,
  reminded: 2, bounced: 99, expired: 99, failed: 99,
};

function promoteTo(current, next) {
  if (['answered', 'done'].includes(current)) return current;
  if (['bounced', 'expired', 'failed'].includes(current) && next !== 'answered') return current;
  return stateRank[next] > stateRank[current] ? next : current;
}
```

---

## 6. The 8 edge functions

### 6.1 `cc-route-decision` — operator triggers route

```
POST /functions/v1/cc-route-decision
Auth: Cloudflare Access JWT (operator)
Body: { issue_id, app_id, decision_external_ref, recipient_email,
        recipient_name?, recipient_kind, decision_title, decision_body, options }
```

Flow:
1. Verify Access JWT (mirror `cc-answer-issue` auth pattern).
2. Validate inputs; load issue + registry app server-side.
3. Assert `issue.status IN ('surfaced','triaging')`.
4. For each option: generate random 32-byte token → HMAC hash → build magic link.
5. Render compiled MJML HTML with option buttons.
6. POST to Resend `/emails`.
7. Insert `cc_decision_email_sends` (state=`sent`, attempt_count=1).
8. Update `cc_issues.status` → `routed_to_client`.
9. Audit `decision_routed`.

**Must not:** accept `target_repo`/`target_branch`/`change_spec` in payload; write to `cc_decision_answers`; route to recipient outside the registered app's domain.

### 6.2 `cc-decision-confirm-page` — public, GET, render-only

```
GET /functions/v1/cc-decision-confirm-page?t=<raw_token>&o=<option_id>
Auth: public, token-bound
```

Flow:
1. Compute `tokenHash` from `t`.
2. Lookup `cc_decision_email_sends` by hash.
3. Render based on state: invalid token → 404; expired → expired page; already answered → idempotent page; otherwise → confirm page.
4. Set CSRF cookie + hidden field.
5. **No DB writes** beyond optional `decision_link_visited` audit (only if URL signals it's not a scanner — open question, recommend NOT writing here).

**Must not:** commit any answer; set `clicked_at` (Resend tracking handles that).

### 6.3 `cc-decision-confirm-submit` — public, POST, commit

```
POST /functions/v1/cc-decision-confirm-submit
Auth: token-bound + CSRF
Body: { token, option_id, csrf }
```

Flow:
1. Validate CSRF cookie/header pair.
2. Compute `tokenHash`; SELECT FOR UPDATE the send row.
3. Reject if expired, already answered, or `option_id` not in `options_snapshot`.
4. Call `cc_resolve_issue(...)` with the enumerated option (existing RPC — no new pathway).
5. Update send row: `state='answered'`, `selected_option`, `decision_answer_id`, `answered_at`.
6. Call `cc_enqueue_with_gating(...)` → work order queues / gates per risk class.
7. Audit `decision_answered_by_recipient`.

**Must not:** accept `change_spec` from body; commit without the row lock; bypass the existing risk-class gate.

### 6.4 `cc-resend-webhook` — Resend sends events here

```
POST /functions/v1/cc-resend-webhook
Auth: Resend HMAC signature (use RESEND_WEBHOOK_SECRET)
```

Flow:
1. Verify HMAC signature.
2. INSERT into `cc_resend_webhook_events` with `event_id` UNIQUE — duplicates return 200 immediately.
3. Lookup send row by `send_id`.
4. Apply state transition per event type (see §5 state promotion):
   - `email.sent` → `sent_at`
   - `email.delivered` → `delivered_at`, promote to `delivered`
   - `email.opened` → `opened_at`, promote to `opened`
   - `email.clicked` → `clicked_at`, promote to `clicked`, audit `decision_link_visited`
   - `email.bounced` → `bounced_at`, state=`bounced`, audit
   - `email.replied` / `inbound` → `replied_at`, `raw_reply_text`, promote to `replied`, **invoke `cc-extract-reply` internal call**
5. Return 200.

**Must not:** treat any event as an answer; downgrade a stronger state; loop on inbound parsing failures.

### 6.5 LLM extraction — runs on the Mac Studio, NOT as an edge function

Architectural note: there is no `cc-extract-reply` edge function. Extraction runs on the operator's Mac Studio via the runner daemon's existing Claude Code authentication. The runner gains a new poll loop alongside its work-order poll.

**The queue is the table itself.** When `cc-resend-webhook` transitions a row to `state='replied'` with `raw_reply_text` populated and `llm_extraction IS NULL`, the runner picks it up on its next poll cycle (every ~30 seconds).

**Runner poll loop (added to existing daemon):**

```typescript
// Every 30s, alongside the existing work-order poll:
const task = await claimExtractionTask(runnerId);
if (!task) { sleep(30s); continue; }

const prompt = buildExtractionPrompt({
  decisionTitle: task.decision_title,
  options: task.options_snapshot,
  replyText: task.raw_reply_text,
});

// Spawn claude CLI subprocess with stdin prompt (NOT argv — secrets safety).
const result = await runClaudeCli(prompt);

// Parse strict JSON output; validate matched_option_id exists in options_snapshot.
const extraction = parseAndValidate(result, task.options_snapshot);

// Write back via control-plane service-role.
await writeExtraction(task.id, extraction);
await auditEvent('decision_extraction_proposed', task);
```

**Atomic claim RPC** (added to migration 025 alongside the table):

```sql
CREATE OR REPLACE FUNCTION public.cc_claim_extraction_task(p_runner_id text)
RETURNS public.cc_decision_email_sends
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_row public.cc_decision_email_sends;
BEGIN
  WITH candidate AS (
    SELECT id FROM public.cc_decision_email_sends
    WHERE deleted_at IS NULL
      AND state = 'replied'
      AND llm_extraction IS NULL
      AND extraction_started_at IS NULL
    ORDER BY replied_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.cc_decision_email_sends wo
     SET extraction_started_at = now(),
         extraction_runner_id = p_runner_id
    FROM candidate
   WHERE wo.id = candidate.id
  RETURNING wo.* INTO v_row;
  RETURN v_row;
END;
$fn$;
```

Plus a sweeper for stuck extractions: rows with `extraction_started_at > now() - interval '10 minutes'` and `llm_extraction IS NULL` get their `extraction_started_at` cleared so they retry.

**Must not:** call `cc_resolve_issue` from the runner; auto-commit; treat `claude` output as authority; include raw reply text in any audit event detail or downstream `change_spec`; pass the reply text via process argv (use stdin only).

Retry: 2× total; on third failure mark `llm_extraction = {requires_human: true, error: "..."}`.

**Operator manual re-extract:** if the operator wants to retry an extraction (e.g. LLM got it wrong), the confirm queue UI can call a thin `cc-reextract-decision` edge function that sets `extraction_started_at = NULL` and `llm_extraction = NULL`, putting the row back in the runner's claimable pool. Defer to Slice 3 polish if not needed in v1.

### 6.6 `cc-confirm-extraction` — operator confirms parsed reply

```
POST /functions/v1/cc-confirm-extraction
Auth: Cloudflare Access JWT (operator-only)
Body: { email_send_id, selected_option }
```

Flow:
1. Verify Access JWT.
2. Lock send row.
3. Assert `state='replied'`, `decision_answer_id IS NULL`, `selected_option` in `options_snapshot`.
4. Call `cc_resolve_issue(...)` with `actor=Brian@blackrock`.
5. Update send row to `state='answered'`, `operator_confirmed_by`, `operator_confirmed_at`.
6. Call `cc_enqueue_with_gating(...)`.
7. Audit `decision_operator_confirmed`.

**Must not:** bypass operator identity; auto-confirm on high LLM confidence (deferred to v1.2+ explicitly).

### 6.7 `cc-decision-reminder` — cron

```
POST /functions/v1/cc-decision-reminder
Auth: internal cron token
Body: { older_than_days?: number = 3, limit?: number = 50 }
```

Flow:
1. SELECT rows in (`sent`,`delivered`,`opened`) with `answered_at IS NULL`, `bounced_at IS NULL`, `magic_link_expires_at > now()`, `(reminded_at IS NULL OR reminded_at < now() - interval '2 days')`, `sent_at < now() - interval '<older_than_days> days'`.
2. For each: send reminder email (same option links, reminder copy from UX recon §6).
3. Update `reminded_at`, audit `decision_email_reminded`.
4. Max 2 reminders per send (3d, 6d).

### 6.8 `cc-decision-expire` — cron

```
POST /functions/v1/cc-decision-expire
Auth: internal cron token
```

Flow:
1. UPDATE rows past `magic_link_expires_at` not in terminal states → `state='expired'`, `expired_at=now()`.
2. Audit `decision_expired` per row.
3. Optionally move `cc_issues.status` back to `triaging` with `context.expired_email_send_id` for operator follow-up.

---

## 7. Threat model + must-not-build list

(Lifted from security recon §2 + §7 — full matrix in `prompt-exports/phase5-recon-security.md`.)

### Threat matrix highlights

| Vector | Threat | Mitigation |
|---|---|---|
| Outbound send | Email leaks sensitive internal context | Branded card contains only decision context/options needed; no secrets, repo, branch |
| Magic-link GET | Scanner pre-clicks → "answers" decision | GET renders only; POST + CSRF + valid token required for write |
| Confirm POST | Token tampering | HMAC-signed token; constant-time verify; bind decision/recipient/option/expiry |
| Confirm POST | Replay/double dispatch | Row lock; idempotency check; `decision_answer_id IS NULL` precondition |
| Email reply webhook | Spoofed webhook | Resend HMAC signature verification; event_id dedupe |
| Free-text body | Prompt injection → "ignore prior instructions" | Body is data only; LLM prompt restricts to option extraction; output never executed |
| LLM extraction | Hallucinated option ID | Validate against `options_snapshot`; reject if no match |
| Operator confirm | Unauthorized actor | Cloudflare Access JWT verification |
| Bot pre-click | False engagement signal | "Visited" and "answered" are separate states; opens/clicks are telemetry only |
| Forwarded email | Wrong person answers | Token bound to recipient; confirm page discloses intended recipient |
| Reply-all / misroute | Wrong inbox receives reply | Per-send reply-to alias `reply+<send_id>@decisions.blackrockai.co`; reject unbound inbound |

### Must NOT build (security-critical)

- ❌ Auto-applying free-text answers
- ❌ Customer email body in less-trusted readable columns (quarantined `raw_reply_text` only)
- ❌ Recipient-chosen repo or branch
- ❌ Direct "click here to apply" links (must go through confirm page)
- ❌ Cross-app routing (a QEP send row can only affect QEP's issue/app/work-order path)
- ❌ Raw token storage (hashes only)
- ❌ Answer inference from open/click telemetry
- ❌ LLM output as authority
- ❌ Anon DB exposure for any Phase 5 table

---

## 8. Magic-link + LLM safety (highest-risk subsystems)

### Magic-link design (the security-critical part)

**Per-recipient per-option tokens.** A decision with 3 options × 2 recipients = 6 distinct tokens. Each token:
- HMAC-SHA256 signed with `CC_MAGIC_LINK_SECRET`.
- Payload claims: `decision_id`, `issue_id`, `app_id`, `recipient_id`, `send_id`, `option_id`, `exp`, random nonce.
- Stored as hash only — raw token never persists on the server.
- TTL: 7 days (configurable). After: render the "expired" page on click; operator can resend or mint new tokens.

**Why GET ≠ answer:** email security scanners (Microsoft ATP, Mimecast, Proofpoint) routinely pre-click links to scan for phishing. Without the GET-vs-POST split, those pre-clicks would commit answers. So:
- GET → render the confirm page (no writes).
- POST → commits (CSRF nonce minted on GET ties them).
- Both validate the full token claims.

**Scanner containment:** opens and clicks land in Resend telemetry → state transitions to `opened`/`clicked` → audited as `decision_link_visited` (NOT an answer). Only a `POST /cc-decision-confirm-submit` with valid CSRF + valid token writes the answer row.

### LLM extraction safety

The LLM is treated as **untrusted suggestion**, never authority. Flow:

```
inbound webhook
  → cc-extract-reply
    → LLM proposal { matched_option_id, confidence, reasoning, requires_human }
    → validate matched_option_id IS NULL OR exists in options_snapshot
    → store in cc_decision_email_sends.llm_extraction
    → audit decision_extraction_proposed
  → Brian sees in confirm queue
  → Brian clicks "Confirm" OR overrides
  → cc-confirm-extraction → cc_resolve_issue → answer commits
```

**Failures contained:**

| Failure | Containment |
|---|---|
| Prompt injection in reply body ("ignore your system prompt") | Body is data; model only outputs an option ID; operator confirms |
| Hallucinated option ID | Validated against snapshot; rejected → `requires_human: true` |
| Ambiguous reply ("either is fine") | Mark `requires_human`; Brian arbitrates |
| Multi-intent reply | Extract only the option choice; ignore unrelated text |
| Hostile content (HTML/scripts) | Stored escaped; never rendered as HTML |
| Model overconfidence | Doesn't matter — confirm gate is mandatory |

**Requires_human triggers:** confidence < 0.85, reply asks a question, reply has conditions not represented by options, multiple options match, model returned malformed JSON.

---

## 9. UX specs

### 9.1 The outbound email — worked example

Subject: **`[QEP] You have a decision to answer: cash + finance rebate stacking`**
From: **`BlackRock AI Command Center <decisions@decisions.blackrockai.co>`**
Reply-To: **`reply+<send_id>@decisions.blackrockai.co`**

5-slot card:

```
┌─────────────────────────────────────────────────────┐
│  BlackRock AI    [QEP]                              │  ← Header (BlackRock + app badge)
├─────────────────────────────────────────────────────┤
│                                                     │
│  Cash + finance rebate stacking                     │  ← Title (decision question)
│                                                     │
├─────────────────────────────────────────────────────┤
│  Hello Ryan,                                        │
│                                                     │
│  When a QEP quote has both a cash rebate AND a      │  ← Context (1-2 sentences)
│  finance rebate that could apply, we need to know   │
│  whether customers can stack them or pick one.      │
│  Brian needs your call before the build can move.   │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [   Allow stacking (both apply)   ]                │  ← Options (one CTA per option,
│                                                     │     each with unique magic link)
│  [   Pick one — customer chooses    ]               │
│                                                     │
│  [   Pick one — system auto-picks best ]            │
│                                                     │
├─────────────────────────────────────────────────────┤
│  Prefer to explain? Just reply to this email and    │  ← Footer
│  Brian Lewis will confirm the parsed answer.        │
│                                                     │
│  This link expires in 7 days.                       │
│  This message is from Brian Lewis at Lewis Insurance.│
└─────────────────────────────────────────────────────┘
```

Plain-text fallback: same content as numbered options ("Reply with 1, 2, or 3 to answer.").

### 9.2 The magic-link confirm page

URL: `https://blackrockai-command-center.netlify.app/c/<token>?o=<option_id>`

**Default state (clicked but not yet confirmed):**

```
┌────────────────────────────────────────────┐
│           BlackRock AI                     │
├────────────────────────────────────────────┤
│                                            │
│  QEP — Cash + finance rebate stacking      │
│                                            │
│  You're about to answer:                   │
│                                            │
│       Allow stacking (both apply)          │
│       ─────────────────────────            │
│                                            │
│  If this is correct, press Confirm.        │
│  If not, close this tab and click a        │
│  different option in the original email.   │
│                                            │
│       ┌─────────────────────┐              │
│       │      Confirm        │              │
│       └─────────────────────┘              │
│                                            │
│  Need to explain? Reply to the original    │
│  email instead.                            │
└────────────────────────────────────────────┘
```

**Already-answered state:** "This decision was already answered ('Allow stacking') on 2026-05-23. Nothing further needed."

**Expired state:** "This decision was sent more than 7 days ago. Reply to the email and Brian will route it manually."

**Invalid token state:** Polite 404-style page.

### 9.3 Operator confirm queue — new band on Decisions page

Top of `/decisions` page, ABOVE the existing cross-app inbox:

```
┌──────────────────────────────────────────────────────────────┐
│  ⚠ Awaiting your confirmation (3)                            │
├──────────────────────────────────────────────────────────────┤
│  [QEP] Q10 · rebate stacking                                 │
│  Replied by ryan@qep.com · 14m ago                           │
│                                                              │
│  Reply text:                                                 │
│  "Let them stack both — it's what our biggest dealers do."   │
│                                                              │
│  LLM suggested: Allow stacking (both apply)                  │
│  Confidence: 0.91                                            │
│  Reasoning: Reply explicitly favors stacking; no conditions. │
│                                                              │
│  [ Confirm as suggested ]  [ Pick different ▾ ]              │
│  [ Reject — ask to clarify ]  [ Defer 24h ]                  │
└──────────────────────────────────────────────────────────────┘
```

Band hidden when empty (earned-calm pattern from Master Plan).

### 9.4 Decision state badges on cockpit + Decisions inbox

| State | Badge | Action available |
|---|---|---|
| `unrouted` | (none) | "Route to <owner>" CTA |
| `routed` | 📨 "Routed 2d ago" | "Resend now" / "Cancel routing" |
| `link_clicked` | 👁 "Opened, not confirmed" | "Nudge to confirm" |
| `awaiting_operator_confirm` | ⏳ "In your confirm queue" | Link to confirm queue |
| `answered` | ✅ "Answered by Ryan 14m ago" | Read-only |
| `expired` | ⏰ "Expired" | "Reroute" CTA |

### 9.5 Reminder copy

Subject: **`Friendly reminder: QEP decision`**

```
Hi Ryan,

Just a friendly nudge — we're still waiting on your answer to:

  "When a QEP quote has both a cash and finance rebate, can
   customers stack them or do they pick one?"

[Original option buttons here]

If you've already answered, please ignore — sometimes our
confirmation runs late.

— Brian Lewis
```

### 9.6 "Lately" feed mappings

| Event | Lately copy | Visible? |
|---|---|---|
| `decision_routed` | "You routed a QEP decision to Ryan — waiting for an answer." | ✅ |
| `decision_answered_by_recipient` | "Ryan answered the rebate decision — a build can move now." | ✅ |
| `decision_operator_confirmed` | "You confirmed Ryan's reply on the rebate decision — build dispatched." | ✅ |
| `decision_email_bounced` | "A QEP decision email bounced — check Ryan's address." | ✅ |
| `decision_email_delivered` | — | hidden |
| `decision_email_opened` | — | hidden |
| `decision_link_visited` | — | hidden |
| `decision_extraction_proposed` | — | hidden (only operator confirm queue surfaces these) |

---

## 10. Resend + LLM setup (operator tasks)

### Resend account

1. Sign up at resend.com.
2. Create a sending domain: **`decisions.blackrockai.co`** (subdomain — NEVER use root).
3. Configure DNS at your registrar:
   - DKIM record from Resend
   - SPF record (Resend provides exact value)
   - DMARC record (start with `p=none` for monitoring; tighten to `quarantine` after 1 month of clean reports)
4. Wait for DNS verification (Resend will email when ready — minutes to hours).
5. Generate API key from Resend dashboard.
6. Generate inbound webhook secret in Resend dashboard.
7. Configure inbound webhook URL to point at:
   `https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-resend-webhook`
8. Configure reply alias pattern: `reply+<send_id>@decisions.blackrockai.co` → routes to inbound parsing.

### LLM (Slice 2 only — skip for Slice 1)

1. Generate Anthropic API key.
2. Decide monthly cap (recommended: $20/month soft ceiling for v1).
3. Document the prompt template (in `cc-extract-reply` source).

### Supabase secrets (run after account/keys are ready)

```bash
supabase secrets set RESEND_API_KEY='<from Resend dashboard>' --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set RESEND_WEBHOOK_SECRET='<from Resend dashboard>' --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set CC_MAGIC_LINK_SECRET="$(openssl rand -base64 32)" --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set CC_INTERNAL_TOKEN="$(openssl rand -base64 32)" --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set CC_PUBLIC_DECISION_BASE_URL='https://blackrockai-command-center.netlify.app' --project-ref gsvhuzpysxaegoecwjmf

# Slice 2 only:
supabase secrets set ANTHROPIC_API_KEY='<from console.anthropic.com>' --project-ref gsvhuzpysxaegoecwjmf
```

---

## 11. Sub-phase build plan

### Slice 1 — Outbound + magic-link button-confirm *(MVP, ~half-day)*

**Goal:** Brian routes a real QEP decision via email; recipient clicks Confirm; answer commits; work order queues.

- [ ] **Migration 025** applied (full schema — includes columns for Slice 2 LLM extraction so we don't need to migrate again later).
- [ ] **Edge function `cc-route-decision`** built + deployed.
- [ ] **Edge function `cc-decision-confirm-page`** built + deployed (renders HTML directly from the function or serves a Netlify route — pick one).
- [ ] **Edge function `cc-decision-confirm-submit`** built + deployed.
- [ ] **Edge function `cc-resend-webhook`** built + deployed (handles `sent`/`delivered`/`opened`/`clicked`/`bounced` — defers `replied`/`inbound` to Slice 2).
- [ ] **MJML template** compiled to TS string + imported into `cc-route-decision`.
- [ ] **Frontend**: wire the existing "Route to client" button in `TriagePanels.tsx` to call `cc-route-decision`. Add decision-state badges to cockpit + Decisions inbox. Add 3-4 "Lately" mappings.
- [ ] **Resend setup** complete (account + domain verified + DNS + secrets set).
- [ ] **Live smoke**: route the rebate-stacking decision to Brian's personal email. Click Confirm in the email. Verify: send row state=`answered`, `cc_decision_answers` row written, work order queued via `cc_enqueue_with_gating`, audit chain complete.

**Done when:** the smoke completes end-to-end with a real email, real click, real work-order dispatch.

### Slice 2 — Inbound + LLM extraction (Mac Studio) + operator confirm queue

**Goal:** recipients can reply via plain email; the Mac Studio runner extracts via Claude Code; Brian confirms in the queue; answer commits.

- [ ] **Migration 025b**: add `cc_claim_extraction_task` RPC + sweeper for stuck extractions (alongside the column additions already in migration 025).
- [ ] **Runner daemon update**: add the extraction poll loop alongside the work-order poll. Reuses the existing Claude Code authentication. New task type, same daemon process.
- [ ] **Edge function `cc-confirm-extraction`** built + deployed (operator-confirms a parsed extraction).
- [ ] **Extend `cc-resend-webhook`** to handle `replied`/`inbound` events → transitions row to `state='replied'`. NO inline LLM call; the runner picks it up.
- [ ] **Frontend**: build operator confirm queue band on `/decisions` page per UX spec §9.3.
- [ ] **Confirm `claude --version` succeeds on the Mac Studio** — should already be true since the runner uses it.
- [ ] **Live smoke**: reply (in plain English) to a routed decision; verify the extraction proposal lands in confirm queue within ~30 seconds; Brian confirms; answer commits.

**Stop condition:** if confirm queue >10 items/day after a week, build auto-confirm rules (out of scope for Phase 5) BEFORE Slice 3.

### Slice 3 — Reminders + expiry + polish

**Goal:** Phase 5 runs hands-off for the common case.

- [ ] **Cron function `cc-decision-reminder`** built + scheduled (every 6h).
- [ ] **Cron function `cc-decision-expire`** built + scheduled (every hour).
- [ ] **Reminder email template** + copy per UX spec §9.5.
- [ ] **Branded MJML polish** (optional — only if v1 template feels off).
- [ ] **Settings page**: surface Phase 5 row counts (sent / awaiting / answered / bounced / expired this week).
- [ ] **Live smoke**: route a decision, manually fast-forward `sent_at` to 3 days ago, verify reminder fires + audit captures.

---

## 12. Open decisions for the operator

Before kicking off Slice 1, Brian decides:

1. **LLM via Claude Code CLI on Mac Studio** — LOCKED. Extraction runs on the operator's Mac Studio via the runner daemon's existing Anthropic subscription. No API key, no monthly cap, no additional vendor. Reply text never leaves the operator's hardware until the operator confirms.
2. **First friendly-client recipient** — Brian himself? Rylee? One QEP business owner? Name them.
3. **Reminder cadence** — recommend 3-day default, max 2 reminders. Accept or override.
4. **Sending domain confirmation** — `decisions.blackrockai.co`. Accept or pick another.
5. **Initial Slice 1 deployment target** — Netlify URL for the confirm page? Or serve directly from Supabase edge function HTML? Recommend Netlify.

---

## 13. Out of scope (Phase 6+)

These are NOT in any Slice 1-3:

- Bulk routing (sending one decision to 10 recipients at once).
- Deliverability dashboards (open rates, click rates, bounce trends by domain).
- Per-client template customization (custom logo, custom from-name, etc.).
- A/B testing subject lines or CTA copy.
- Weekly digest emails ("you have 3 pending decisions").
- High-confidence auto-confirm rules (e.g. "LLM confidence > 0.95 + business hours + AUTO-class → auto-commit").
- SMS/Slack/Telegram routing channels (the platform infra is single-channel email for v1).
- Recipient self-service ("change my notification preferences" page).
- Decision question editing post-send (cancel + reroute is the only path).
- Multi-language support.

---

## 14. Summary of recon contributions

| Section | Sourced from |
|---|---|
| §1 Executive summary | CEO recon §1, §2 + synthesis |
| §2 Strategic frame | CEO recon §1, §2, §5, §6, §7 |
| §3 Architecture overview | Tech recon §2 + synthesis ASCII diagram |
| §4 Non-negotiables | Security recon §3 |
| §5 Schema | Tech recon §1 |
| §6 Edge functions | Tech recon §2 |
| §7 Threat model + must-not-build | Security recon §1, §2, §7 |
| §8 Magic-link + LLM safety | Security recon §4, §5 |
| §9 UX specs | UX recon §1, §2, §3, §4, §5, §6 |
| §10 Resend + LLM setup | Tech recon §3 + CEO recon §8 |
| §11 Sub-phase build plan | CEO recon §4 sequencing + tech recon checklists |
| §12 Open decisions | CEO recon §8 |
| §13 Out of scope | CEO recon §2 cuts |

---

**End of master plan.** Ready for the operator's greenlight to dispatch Slice 1.
