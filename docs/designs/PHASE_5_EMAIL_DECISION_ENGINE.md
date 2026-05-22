# Phase 5 — Email Decision Engine — Master Plan (v2)

**Compiled:** 2026-05-22 · **Revised:** 2026-05-22 to lock architecture choices.
**Status:** Ready for operator greenlight. All architectural decisions are now locked.

---

## Architectural decisions (locked in this revision)

| Choice | Locked answer | Why |
|---|---|---|
| **Email transport** | **Gmail API via Google Workspace** (`blackrockai.co`). NOT Resend. | Operator already has Workspace; recipients already know him at this address; replies land in his existing inbox; no new vendor; recipients see a real personal email, not transactional. |
| **Sender identity** | **`Brian Lewis <brian.lewis@blackrockai.co>`** — sent as the operator's real Workspace identity via OAuth2. | Recipients see a normal email from someone they already know. No "via" annotation, no role address. |
| **Reply-to** | Same (`brian.lewis@blackrockai.co`). All replies land in the operator's daily Gmail inbox. | Operator sees every reply naturally; no hidden mailbox. |
| **LLM** | **Claude Code CLI on the Mac Studio runner.** Existing Anthropic Pro/Max subscription. | Zero new API billing; reply text stays on operator hardware; same auth path the runner already uses. |
| **Multi-recipient** | **Per-app point-of-contact list** in a new `registry_app_decision_recipients` table. QEP = Rylee + Ryan McKenzie. Other apps configurable. | Real-world routing — different clients have different stakeholders. |
| **AI-rewrite step** | **Mac Studio Claude Code rewrites the raw QEP decision into customer-friendly language before send.** Operator previews + approves. | Raw decision text is often technical; customers need plain English. |
| **Auto-clarification loop** | **Up to ONE auto-follow-up** if the LLM extraction is ambiguous. Then escalates to the operator confirm queue. Hard cap. | Closes the loop without harassing recipients. |

---

## 0. Operator's ready-to-build checklist

Run these before greenlighting Slice 1. The agents are blocked until each is done.

**Google Workspace / Gmail API setup** (one-time, ~30 min the first time)

- [ ] **Confirm admin access** to the `blackrockai.co` Google Workspace.
- [ ] **Create a Google Cloud Console project** named "BlackRock AI Command Center."
- [ ] **Enable Gmail API + Cloud Pub/Sub API** on the project.
- [ ] **Create OAuth 2.0 credentials** (Web application type). Set the authorized redirect URI to the one-time consent page (URL provided when Slice 1 ships).
- [ ] **Grant OAuth consent** as `brian.lewis@blackrockai.co` to scopes: `gmail.send`, `gmail.readonly`, `gmail.metadata`. Store the refresh token (the consent flow will save it as the `GMAIL_OAUTH_REFRESH_TOKEN` Supabase secret).
- [ ] **Create a Cloud Pub/Sub topic** named `cc-gmail-inbound` and a push subscription pointing at the Command Center inbound endpoint (URL provided when Slice 1 ships).
- [ ] **Configure Gmail watch** on the `brian.lewis@blackrockai.co` inbox, scoped to messages with a custom label (see §10 for details).

**Per-app recipient configuration**

- [ ] **Add Rylee** to QEP's recipient list (the Apps page UI will let you do this after the Slice 1 ships; for the smoke test, we'll insert directly).
- [ ] **Add Ryan McKenzie** to QEP's recipient list.

**Mac Studio**

- [ ] **Confirm `claude --version` works** on the Mac Studio (already true — the runner uses it).

**Pilot setup**

- [ ] **Identify the first real-routed decision.** Recommendation: route the rebate-stacking question (Q10) to Rylee + Ryan once you've smoke-tested with yourself first.
- [ ] **30 minutes blocked** on your calendar to run the Slice 1 smoke (send to yourself first, then to Rylee+Ryan).

---

## 1. Executive summary

Phase 5 transforms the Command Center from an internal cockpit into a **client-facing decision loop**. The operator clicks "Route to client" on a real open decision in the cockpit. The Mac Studio rewrites the question into customer-friendly language. The operator previews + approves the rewrite. The email goes to the per-app point-of-contact list — for QEP, that's Rylee + Ryan McKenzie — sent from `brian.lewis@blackrockai.co` via Gmail API, so it looks like a normal personal email. Recipients answer by clicking a magic-link button OR by replying naturally. Plain-text replies are extracted on the Mac Studio (Claude Code) and surface in the operator confirm queue. Once confirmed, the answer commits, the work order queues, the runner builds, and the build moves.

**MVP cut: Slice 1 ships outbound + magic-link button-confirm.** Free-text extraction + confirm queue in Slice 2. Reminders + auto-clarify in Slice 3.

---

## 2. Strategic frame

### Why Phase 5 matters

The platform shows decisions blocking builds. Today operator-owned decisions can be answered in the cockpit. Client-owned ones require manual email handling outside the platform. Phase 5 closes the loop: the client gets a clean email, clicks an answer, the platform moves.

### MVP cut — must / maybe / cut

**Must (v1.0):**
- Outbound email via Gmail API as `brian.lewis@blackrockai.co`.
- Magic-link confirm page (security-critical — scanner pre-clicks must not commit answers).
- One operator confirm queue UI surface.
- Per-app recipient list (Rylee + Ryan for QEP).
- AI-rewrite step with operator preview.
- Work-order dispatch on confirmed answer.

**Maybe ship if cheap:**
- Branded HTML email template (a clean plain-ish design is fine for friendly-client v1).
- Reminder cron.

**Cut to v1.1+:**
- Bulk operations, deliverability dashboards, per-client template customization, A/B subject lines, weekly digest emails.
- Full free-text reply extraction → Slice 2 (NOT in v1).
- Auto-clarification follow-up → Slice 3 (NOT in v1).

### Business risks

| Risk | Mitigation |
|---|---|
| **Reply lands at wrong recipient** | Per-app recipient list configured in advance. Cockpit shows the recipients before send and lets you uncheck per send. |
| **AI rewrite changes the meaning** | Operator previews + approves every rewrite. Can edit or fall back to raw text. |
| **Recipient marks email as spam** | Pre-warm the recipient ("you'll get an email from Brian about QEP decisions") before the first real send. Gmail's existing reputation under `brian.lewis@blackrockai.co` is already trusted by these contacts. |
| **OAuth token revoked** | `gmail_send_failed` event in Lately surfaces immediately. Cockpit shows "send blocked — manually email <recipient>" with rewritten body as fallback. |
| **LLM extraction commits wrong answer** | Confirm queue is mandatory; v1 has zero auto-confirm. |
| **Operator overload** | v1.0 rule: button confirmations commit, free-text replies require operator confirm. Auto-confirm rules deferred. |
| **Auto-clarify spam loop** | Hard cap: max 1 auto-clarification per decision per recipient. Then escalate to operator. |

### Success metrics

| Metric | Target |
|---|---|
| Decisions routed per week | Enough usage to learn (no specific count for v1) |
| Median time `routed` → `answered` | Hours, not days |
| Button answers vs reply answers | Button-dominant (≥70%) means low-friction is working |
| LLM extraction acceptance rate | ≥80% — if lower, build correction tools before automation |
| Bounces / spam reports | Zero tolerated |
| Operator confirm-queue clear time | <2 min per item |
| OAuth token health | Should never fail; audit alerts on any failure |

### Stop conditions

- After Slice 1: if magic-link confirms work for 90%+ recipients → defer Slice 2 for months.
- After Slice 2: if confirm queue >10 items/day → build auto-confirm rules BEFORE Slice 3 reminders.
- Stop all feature work if deliverability weakens, emails land in spam, or any recipient reports confusion. Invest in inbox placement first.
- Don't scale to all six clients until QEP has been live for a week with no drama.

---

## 3. Architecture overview

```
┌─────────────┐   ┌──────────────────┐   ┌────────────────────┐   ┌──────────────┐
│  Operator   │──▶│ cc-route-decision│──▶│  Mac Studio runner │──▶│   Gmail API  │
│  (cockpit)  │   │  composes send   │   │  AI-rewrites the   │   │  sends AS    │
│             │   │  + magic tokens  │   │  decision (claude) │   │  brian.lewis │
└─────────────┘   └─────────┬────────┘   └──────────┬─────────┘   └──────┬───────┘
                            │                       │                    │
                            │       (operator      │                    │
                            │        approves      │                    │
                            │        rewrite)      │                    ▼
                            │                       │            ┌──────────────┐
                            ▼                       │            │  Recipient   │
                  cc_decision_email_sends            │            │   inbox      │
                  (state=sent, hash stored)          │            └──────┬───────┘
                                                     ▼                   │
                  ┌──────────────────────────────────────────────────────┴──┐
                  │                                                         │
            (option button click)                                  (replies in plain text)
                  │                                                         │
                  ▼                                                         ▼
   ┌──────────────────────────────┐                  ┌────────────────────────────────────┐
   │ cc-decision-confirm-page GET │                  │     Recipient → brian.lewis Gmail   │
   │  validates token             │                  │     normal reply, lands in inbox    │
   │  audits decision_link_visited│                  └─────────────────┬──────────────────┘
   │  RENDERS confirm page (no DB)│                                    │
   └────────────┬─────────────────┘                                    ▼
                │                                       ┌──────────────────────────────────┐
       (operator-equivalent click)                      │  Gmail watch + Cloud Pub/Sub     │
                │                                       │  push notification to control-   │
                ▼                                       │  plane → cc-gmail-inbound        │
   ┌──────────────────────────────┐                    │  reads new message via Gmail API │
   │cc-decision-confirm-submit POST│                    │  identifies decision via         │
   │  validates token + CSRF      │                    │  In-Reply-To/References header   │
   │  calls cc_resolve_issue      │                    │  state=replied                   │
   │  state=answered              │                    └─────────────────┬────────────────┘
   └────────────┬─────────────────┘                                      │
                │                                                        ▼
                │                                  ┌──────────────────────────────────────┐
                │                                  │  Mac Studio runner daemon            │
                │                                  │  polls for state=replied rows         │
                │                                  │  runs `claude` CLI locally           │
                │                                  │  (existing subscription)             │
                │                                  │  LLM proposal ONLY · NEVER commits   │
                │                                  └─────────────────┬────────────────────┘
                │                                                    │
                │                                                    ▼
                │                                     ┌────────────────────────────────┐
                │                                     │  Operator confirm queue        │
                │                                     │  (band on /decisions page)     │
                │                                     │  Brian reviews + commits       │
                │                                     └─────────────┬──────────────────┘
                │                                                   │
                │                                                   ▼
                │                              ┌──────────────────────────────────────┐
                │                              │  cc-confirm-extraction               │
                │                              │  calls cc_resolve_issue              │
                │                              │  state=answered                      │
                │                              └────────────┬─────────────────────────┘
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

**Key invariants:**
- Every send is sent **AS** the operator via OAuth — recipients see a normal personal email.
- LLM (both rewrite + extraction) runs on the Mac Studio via Claude Code subscription. No external API billing. Reply text never leaves operator hardware until operator confirms.
- Magic-link tokens are HMAC-hashed at rest. GET renders only; POST commits.
- Every commit path goes through `cc_resolve_issue` + `cc_enqueue_with_gating`. No new commit pathway.
- `target_repo` and `target_branch` stay server-bound from the registry.

---

## 4. Non-negotiables (these never automate)

Per OS Roadmap §8:

1. **Customer input cannot reach the agent as instructions.** Email bodies + rationales are data/provenance only. They produce a candidate `option_id` (validated against the enumerated set), never appear as imperative text in `change_spec`.

2. **Customer input cannot choose the build target.** Tokens, replies, and LLM outputs never contain or accept repo/branch. Work orders read `target_repo`/`target_branch` from `registry_app_repo` by `app_id` only.

3. **AUTHORIZE / destructive / production work never auto-dispatches.** A confirmed client answer may *create* a work order, but `risk_class` is re-derived server-side. Anything beyond `auto`-class under the cost cap requires Brian's one-press approval (same Phase 4 gate).

4. **Brian's confirm gate on every free-text reply, full stop.** Magic-link button answers can commit after token/CSRF validation (enumerated). Free-text replies cannot — they always go through the operator confirm queue.

5. **PR merge always human-gated.**

---

## 5. Schema — Migration `025_phase5_email_engine.sql`

Three new tables:

```sql
BEGIN;

-- ============================================================================
-- 1. registry_app_decision_recipients — per-app point-of-contact list.
-- ============================================================================

CREATE TABLE public.registry_app_decision_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  contact_name text NOT NULL,
  contact_email text NOT NULL,
  contact_role text,                           -- "primary" | "secondary" | "operator"
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX registry_app_decision_recipients_email_idx
  ON public.registry_app_decision_recipients (app_id, lower(contact_email))
  WHERE deleted_at IS NULL;

CREATE INDEX registry_app_decision_recipients_active_idx
  ON public.registry_app_decision_recipients (app_id, active)
  WHERE deleted_at IS NULL;

ALTER TABLE public.registry_app_decision_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY recipients_service_all
  ON public.registry_app_decision_recipients FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON public.registry_app_decision_recipients FROM anon, authenticated;
GRANT ALL ON public.registry_app_decision_recipients TO service_role;

-- Seed QEP's recipients (will be insertable via the Apps page UI later):
-- (operator runs this once after migration)
-- INSERT INTO registry_app_decision_recipients (app_id, contact_name, contact_email, contact_role)
-- VALUES
--   ((SELECT id FROM registry_apps WHERE short_code='QEP'), 'Rylee', 'rylee@qep.com', 'primary'),
--   ((SELECT id FROM registry_apps WHERE short_code='QEP'), 'Ryan McKenzie', 'ryan@qep.com', 'primary');

-- ============================================================================
-- 2. cc_decision_email_sends — one row per outbound send.
-- ============================================================================

CREATE TYPE public.cc_decision_email_state AS ENUM (
  'queued', 'rewriting', 'rewrite_ready', 'sent', 'delivered',
  'opened', 'clicked', 'replied', 'extracting',
  'awaiting_clarify', 'clarify_sent',
  'answered', 'done',
  'reminded', 'bounced', 'expired', 'failed'
);

CREATE TABLE public.cc_decision_email_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  -- Provenance
  decision_answer_id uuid REFERENCES public.cc_decision_answers(id) ON DELETE SET NULL,
  issue_id uuid NOT NULL REFERENCES public.cc_issues(id) ON DELETE RESTRICT,
  app_id uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE RESTRICT,
  decision_external_ref text NOT NULL,
  recipient_id uuid REFERENCES public.registry_app_decision_recipients(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  recipient_name text,

  -- Content snapshots (what was actually sent)
  raw_decision_title text NOT NULL,
  raw_decision_body text,
  rewritten_subject text,         -- AI-rewritten + operator-approved
  rewritten_body text,            -- AI-rewritten + operator-approved
  rewrite_approved_by text,       -- operator who clicked Send
  rewrite_approved_at timestamptz,
  options_snapshot jsonb NOT NULL,

  -- Gmail send metadata
  gmail_message_id text,          -- the Message-Id header value sent
  gmail_thread_id text,           -- Gmail thread identifier for reply matching

  -- Magic-link auth
  magic_link_token_hash text NOT NULL,
  magic_link_expires_at timestamptz NOT NULL,

  -- State machine
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

  -- Reply + extraction
  raw_reply_text text,                          -- quarantined; service-role only
  llm_extraction jsonb,                         -- {matched_option_id, confidence, reasoning, requires_human}
  extraction_started_at timestamptz,            -- runner claim marker
  extraction_runner_id text,
  clarification_attempt_count integer NOT NULL DEFAULT 0,
  clarification_sent_at timestamptz,

  -- Operator confirm
  operator_confirmed_by text,
  operator_confirmed_at timestamptz,
  selected_option text,

  -- Error / retry
  last_error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),

  CONSTRAINT cc_decision_email_sends_options_array
    CHECK (jsonb_typeof(options_snapshot) = 'array'),
  CONSTRAINT cc_decision_email_sends_clarify_cap
    CHECK (clarification_attempt_count <= 1),    -- hard cap: one auto-clarify
  CONSTRAINT cc_decision_email_sends_answer_consistency
    CHECK (
      state NOT IN ('answered','done')
      OR (decision_answer_id IS NOT NULL AND answered_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX cc_decision_email_sends_token_hash_idx
  ON public.cc_decision_email_sends (magic_link_token_hash)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX cc_decision_email_sends_gmail_msg_idx
  ON public.cc_decision_email_sends (gmail_message_id)
  WHERE gmail_message_id IS NOT NULL AND deleted_at IS NULL;
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
CREATE INDEX cc_decision_email_sends_thread_idx
  ON public.cc_decision_email_sends (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER cc_decision_email_sends_touch
  BEFORE UPDATE ON public.cc_decision_email_sends
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.cc_decision_email_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_sends_service_all
  ON public.cc_decision_email_sends FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON public.cc_decision_email_sends FROM anon, authenticated;
GRANT ALL ON public.cc_decision_email_sends TO service_role;

-- ============================================================================
-- 3. cc_gmail_history_cursor — tracks last processed Gmail history ID.
-- ============================================================================

CREATE TABLE public.cc_gmail_history_cursor (
  id integer PRIMARY KEY DEFAULT 1,
  history_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cc_gmail_history_cursor_singleton CHECK (id = 1)
);
INSERT INTO public.cc_gmail_history_cursor (id) VALUES (1);

ALTER TABLE public.cc_gmail_history_cursor ENABLE ROW LEVEL SECURITY;
CREATE POLICY gmail_cursor_service_all
  ON public.cc_gmail_history_cursor FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON public.cc_gmail_history_cursor FROM anon, authenticated;
GRANT ALL ON public.cc_gmail_history_cursor TO service_role;

COMMIT;
```

### State machine

```
queued
  ├─ai-rewrite→ rewriting → rewrite_ready
  │                ├─operator approves+sends→ sent
  │                └─operator skips/edits→ rewrite_ready (re-pass)
  └─send ok→ sent
      ├─Gmail labels message delivered/read→ delivered/opened
      ├─magic-link click→ clicked → confirm-submit→ answered → done
      ├─plain reply received→ replied → extracting
      │     ├─LLM ok + clear→ answered → done (via operator confirm queue)
      │     ├─LLM ambiguous → awaiting_clarify → clarify_sent → (replied again or timeout)
      │     └─LLM fails → operator confirm queue with requires_human=true
      ├─reminder-cron→ reminded
      ├─Gmail bounce signal→ bounced
      └─expire-cron→ expired

Hard failures → failed.
```

---

## 6. Edge functions

### 6.1 `cc-rewrite-decision` — AI-rewrite step (NEW)

```
POST /functions/v1/cc-rewrite-decision
Auth: Cloudflare Access JWT (operator)
Body: { issue_id, decision_external_ref, app_id, raw_title, raw_body, options }
Response: { rewrite_task_id }
```

Flow:
1. Verify Access JWT.
2. Insert a row into `cc_decision_email_sends` with `state='rewriting'`, raw fields populated, `rewritten_*` fields null.
3. Return `rewrite_task_id` (the send row id).
4. Mac Studio runner picks up `state='rewriting'` rows on its poll loop:
   - Calls `claude` CLI with a rewrite prompt: "Rewrite this technical decision for a non-technical recipient who needs to answer it. Keep all options. Be polite, brief, plain English."
   - Returns `{rewritten_subject, rewritten_body, rewritten_options[]}`.
   - Updates the send row with the rewritten content, transitions to `state='rewrite_ready'`.
5. Cockpit polls the send row; when `state='rewrite_ready'`, shows the preview UI:
   - Side-by-side: original (left) vs rewritten (right).
   - Operator clicks **Send**, **Edit then send**, or **Send original**.

### 6.2 `cc-route-decision` — operator triggers final send

```
POST /functions/v1/cc-route-decision
Auth: Cloudflare Access JWT (operator)
Body: { send_id, recipient_ids[], approved_subject, approved_body, approved_options }
```

Flow:
1. Verify Access JWT.
2. Load send row; assert `state='rewrite_ready'`.
3. For each recipient in `recipient_ids` (from `registry_app_decision_recipients`):
   a. Clone the send row per recipient (one send row per recipient — each gets distinct tokens).
   b. Generate magic-link token per option × per recipient. HMAC-hash at rest.
   c. Compose Gmail RFC-822 message: From `Brian Lewis <brian.lewis@blackrockai.co>`, To `<recipient>`, Subject `approved_subject`, body HTML + plain-text. Add custom header `X-CC-Send-Id: <send_id>` so the inbound matcher can identify it later.
   d. POST to `gmail.users.messages.send` using OAuth refresh token from `GMAIL_OAUTH_REFRESH_TOKEN`.
   e. Capture `gmail_message_id` and `gmail_thread_id` from response.
   f. Update send row: `state='sent'`, `sent_at`, `gmail_message_id`, `gmail_thread_id`, `rewrite_approved_by`, `rewrite_approved_at`.
4. Update `cc_issues.status` → `routed_to_client`.
5. Audit `decision_routed` per recipient.

**Must not:** accept `target_repo`/`target_branch`/`change_spec`; write `cc_decision_answers`; route to anyone outside `registry_app_decision_recipients` for that app (operator can edit the recipient list, but the cockpit always pulls from there).

### 6.3 `cc-decision-confirm-page` — public, GET, render-only

(Unchanged from the Resend-based plan.)

```
GET /functions/v1/cc-decision-confirm-page?t=<raw_token>&o=<option_id>
Auth: public, token-bound
```

Renders the confirm page. NO writes. Validates token signature + state. Sets CSRF cookie + hidden field.

### 6.4 `cc-decision-confirm-submit` — public, POST, commit

(Unchanged from the Resend-based plan.)

```
POST /functions/v1/cc-decision-confirm-submit
Auth: token-bound + CSRF
Body: { token, option_id, csrf }
```

Validates CSRF + token. Calls `cc_resolve_issue`. Updates send row to `state='answered'`. Calls `cc_enqueue_with_gating`. Audits.

### 6.5 `cc-gmail-inbound` — Gmail Pub/Sub push handler (REPLACES Resend webhook)

```
POST /functions/v1/cc-gmail-inbound
Auth: Cloud Pub/Sub push token verification
Body: Pub/Sub envelope containing the Gmail history ID
```

Flow:
1. Verify the Pub/Sub authentication token.
2. Read `cc_gmail_history_cursor.history_id` (last processed).
3. Call `gmail.users.history.list` with `startHistoryId = cursor` to get new message IDs since last poll.
4. Update cursor to the new history ID.
5. For each new message:
   a. Fetch via `gmail.users.messages.get`.
   b. Look for `X-CC-Send-Id` header OR match `In-Reply-To` against `gmail_message_id`.
   c. If matched: extract reply body (strip quoted thread + signatures), update the matching send row to `state='replied'`, set `raw_reply_text`, `replied_at`.
   d. If unmatched: audit `gmail_inbound_unmatched` and move on (the message stays in Brian's inbox normally).
6. The Mac Studio runner picks up `state='replied'` rows on its extraction poll loop.

**Must not:** treat any inbound as an answer; commit without running through extraction + operator confirm.

### 6.6 LLM extraction — runs on Mac Studio (no edge function)

(Unchanged from the locked Mac Studio architecture.)

The runner daemon polls `cc_decision_email_sends` for `state='replied' AND llm_extraction IS NULL`, claims one atomically via `cc_claim_extraction_task` RPC, runs `claude` CLI with extraction prompt, writes `llm_extraction`, audits `decision_extraction_proposed`.

After extraction:
- If `requires_human: false` AND `clarification_attempt_count = 0` AND confidence ≥ 0.85 → state remains `extracting` until operator confirms (does NOT auto-commit, just makes it visible in confirm queue).
- If `requires_human: true` AND `clarification_attempt_count < 1` → state transitions to `awaiting_clarify`. The auto-clarify cron picks it up.
- Otherwise → state remains in confirm queue for operator.

### 6.7 `cc-confirm-extraction` — operator confirms parsed reply

(Unchanged from the locked plan.)

### 6.8 `cc-auto-clarify` — sends one follow-up if LLM extraction was ambiguous (NEW)

```
POST /functions/v1/cc-auto-clarify
Auth: internal cron token
```

Flow:
1. SELECT rows where `state='awaiting_clarify' AND clarification_attempt_count < 1`.
2. For each: compose a polite follow-up: *"Hi <name> — thanks for replying. Just to make sure I get this right, could you confirm which option you meant? <buttons>"* using the same magic-link tokens (unchanged TTL).
3. Send via Gmail API as `brian.lewis@blackrockai.co`.
4. Update `clarification_sent_at`, `clarification_attempt_count = 1`, `state='clarify_sent'`.
5. Audit `decision_clarification_sent`.

If the recipient ignores the clarify too (after another 3 days), the next cron transitions `clarify_sent → awaiting_operator_review` (a new soft state surfaced in confirm queue with a special "two replies received, both ambiguous" tag for Brian to handle manually).

**Must not:** send more than 1 auto-clarify per send_id. Hard cap in the schema check constraint.

### 6.9 `cc-decision-reminder` — cron

(Unchanged from the locked plan. Same reminder logic but sends via Gmail API.)

### 6.10 `cc-decision-expire` — cron

(Unchanged from the locked plan.)

---

## 7. Threat model summary

(Full matrix in `prompt-exports/phase5-recon-security.md`.)

### Key controls

| Vector | Mitigation |
|---|---|
| Outbound email leak | Branded card contains only decision content + options; no secrets/repo/branch |
| Magic-link scanner pre-click | GET renders only; POST + CSRF + valid token required for write |
| Token tampering | HMAC-signed; constant-time verify; bind decision/recipient/option/expiry |
| Replay/double dispatch | Row lock; idempotency check; `decision_answer_id IS NULL` precondition |
| Gmail inbound spoofing | Pub/Sub auth token verification; message matched by `X-CC-Send-Id` header + `In-Reply-To` |
| Prompt injection in reply | Body is data only; LLM output validated against `options_snapshot`; operator confirm gate |
| Hallucinated option ID | Validation against `options_snapshot`; rejected → `requires_human: true` |
| Forwarded email / wrong responder | Token bound to original recipient; confirm page discloses intended recipient |
| Cross-app routing | `app_id` binds the entire pipeline; tokens cannot cross apps |
| Auto-clarify loop | Hard `clarification_attempt_count <= 1` constraint at the DB layer |

### Must NOT build

- ❌ Auto-applying free-text answers
- ❌ Customer email body in less-trusted readable columns (quarantined)
- ❌ Recipient-chosen repo or branch
- ❌ Direct "click here to apply" links (must go through confirm page)
- ❌ Cross-app routing
- ❌ Raw token storage (HMAC hashes only)
- ❌ Answer inference from open/click telemetry
- ❌ LLM output as authority
- ❌ Anon DB exposure for any Phase 5 table
- ❌ More than 1 auto-clarification per decision per recipient (DB constraint)

---

## 8. Magic-link + LLM safety

(Unchanged from prior version. See §8 of the previous master plan revision and `prompt-exports/phase5-recon-security.md` for full detail.)

Key points retained:
- Per-recipient per-option tokens.
- HMAC-hashed at rest; raw never persists.
- 7-day TTL.
- GET = render-only. POST = commit.
- LLM is suggestion, never authority.
- All extraction → operator confirm queue.

---

## 9. UX specs

### 9.1 The outbound email — worked example (rebate stacking, sent to Rylee)

Subject: **`Quick question about rebate stacking on QEP quotes`**

From: **`Brian Lewis <brian.lewis@blackrockai.co>`**
To: **`Rylee <rylee@qep.com>`**
Cc: **`Ryan McKenzie <ryan@qep.com>`** *(or sent as separate per-recipient emails — implementation choice)*
Reply-To: **`brian.lewis@blackrockai.co`**

Body:
```
Hey Rylee,

Quick question — I want to get this right before we ship the quote
engine update.

When a customer's quote qualifies for BOTH a cash rebate AND a finance
rebate, which way should we go?

  • Let customers stack both rebates
  • Customer picks one rebate
  • System auto-picks the best rebate for the customer

Just click whichever fits how you want it to work. Or reply to this
email if you want to talk it through.

Thanks,
Brian
```

(Three buttons render as styled HTML CTAs in the actual email; plain-text fallback uses numbered options.)

The AI-rewrite step is what turned the raw QEP decision text into this natural-language version. Operator approved before send.

### 9.2 Operator confirm queue — band on `/decisions` page

(Unchanged from the prior plan. See `docs/designs/PHASE_5_UX_RECON.md` §3 for the full card spec.)

### 9.3 Apps page — recipient management (NEW)

The Apps page (`/apps`) gains a new section per app's detail panel:

```
┌───────────────────────────────────────────────┐
│  Decision recipients for QEP                  │
├───────────────────────────────────────────────┤
│  Rylee <rylee@qep.com>             primary    │
│                                    [edit][×]  │
├───────────────────────────────────────────────┤
│  Ryan McKenzie <ryan@qep.com>      primary    │
│                                    [edit][×]  │
├───────────────────────────────────────────────┤
│  [+ Add recipient]                            │
└───────────────────────────────────────────────┘
```

When the operator clicks "Route" on a decision, the cockpit pre-populates the recipient list from this table for that app. The operator can uncheck any per-send if they want only one of the two recipients on a particular question.

### 9.4 AI-rewrite preview (NEW)

After clicking "Route to client" in the cockpit, the operator sees a side-by-side preview before the final send:

```
┌──────────────────────────────────────────────────────────────┐
│  Reviewing AI-rewritten decision email                       │
├────────────────────────────┬─────────────────────────────────┤
│ ORIGINAL (from QEP)        │ REWRITTEN (Mac Studio claude)   │
├────────────────────────────┼─────────────────────────────────┤
│ Q10: When a quote has      │ Hey Rylee,                      │
│ both a cash rebate AND a   │                                 │
│ finance rebate that could  │ Quick question — I want to get  │
│ apply, can the customer    │ this right before we ship the   │
│ stack both, or do they     │ quote engine update.            │
│ have to pick one?          │                                 │
│                            │ When a customer's quote         │
│ Options:                   │ qualifies for BOTH a cash       │
│ - allow_stacking           │ rebate AND a finance rebate,    │
│ - customer_picks_one       │ which way should we go?         │
│ - system_auto_picks        │                                 │
│                            │   • Let customers stack both    │
│                            │   • Customer picks one          │
│                            │   • System auto-picks the best  │
├────────────────────────────┴─────────────────────────────────┤
│  Going to: Rylee <rylee@qep.com>, Ryan <ryan@qep.com>        │
│  [ Edit rewrite ]  [ Send as-is ]  [ Cancel ]                │
└──────────────────────────────────────────────────────────────┘
```

### 9.5 Decision state badges + Lately mappings + reminder copy

(Mostly unchanged — see `docs/designs/PHASE_5_UX_RECON.md`. New mappings added for `decision_clarification_sent` and `decision_rewrite_ready`.)

---

## 10. Operator setup — Gmail / Google Workspace (replaces Resend)

### Step 1 — Cloud Console project

1. Sign in to https://console.cloud.google.com **as `brian.lewis@blackrockai.co`**.
2. Create new project: "BlackRock AI Command Center."
3. From "APIs & Services → Library," enable:
   - **Gmail API**
   - **Cloud Pub/Sub API**

### Step 2 — OAuth credentials

4. APIs & Services → Credentials → Create credentials → OAuth client ID.
5. Application type: **Web application**.
6. Authorized redirect URIs: `https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-gmail-oauth-callback` *(this edge function ships in Slice 1)*.
7. Download the JSON; you'll provide it as a Supabase secret.

### Step 3 — Grant consent (one-time)

8. Once Slice 1 is deployed, visit the consent URL it provides. You'll see Google's permission screen asking BlackRock AI Command Center to:
   - "Send email on your behalf"
   - "Read your email"
   - "Modify labels on your email"
9. Click Allow. The refresh token is captured and stored as Supabase secret.

### Step 4 — Pub/Sub for inbound

10. In Cloud Console, Pub/Sub → Topics → Create topic: `cc-gmail-inbound`.
11. Subscription type: **Push**. Endpoint: `https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-gmail-inbound`.
12. Grant the Gmail API service account permission to publish to the topic.

### Step 5 — Gmail watch

13. From a Slice 1 admin endpoint, the system calls `gmail.users.watch` on `brian.lewis@blackrockai.co` with the Pub/Sub topic + a label filter (e.g., only messages with label `INBOX` not already labelled `cc-handled`).
14. Gmail then sends a Pub/Sub message every time a new email arrives in your inbox matching that filter.

### Step 6 — Supabase secrets

After the above, set on the control plane:

```bash
supabase secrets set GMAIL_OAUTH_CLIENT_ID='<from step 4>' --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set GMAIL_OAUTH_CLIENT_SECRET='<from step 4>' --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set GMAIL_OAUTH_REFRESH_TOKEN='<from step 8 consent flow>' --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set CC_MAGIC_LINK_SECRET="$(openssl rand -base64 32)" --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set CC_INTERNAL_TOKEN="$(openssl rand -base64 32)" --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set CC_PUBLIC_DECISION_BASE_URL='https://blackrockai-command-center.netlify.app' --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set GMAIL_PUBSUB_VERIFICATION_TOKEN='<from Pub/Sub subscription config>' --project-ref gsvhuzpysxaegoecwjmf
```

### Step 7 — Verify

Once secrets are in place + the Slice 1 functions are deployed:
- Send yourself a test email through the cockpit → it should arrive from `Brian Lewis <brian.lewis@blackrockai.co>` in YOUR own inbox.
- Reply to it → cc-gmail-inbound should fire within seconds.

---

## 11. Sub-phase build plan

### Slice 1 — Outbound + magic-link button-confirm + multi-recipient + AI-rewrite (MVP)

**Goal:** Operator clicks "Route to client," AI rewrites, operator approves, email goes to Rylee + Ryan from `brian.lewis@blackrockai.co`, recipient clicks Confirm, work order queues.

- [ ] **Migration 025**: full schema (recipients table + sends table + gmail history cursor + state machine).
- [ ] **Seed QEP recipients** (Rylee + Ryan McKenzie) via post-migration insert.
- [ ] **OAuth flow**: edge function `cc-gmail-oauth-callback` that captures the refresh token, plus a one-time consent URL helper.
- [ ] **Edge function `cc-rewrite-decision`** + runner task type for the AI rewrite.
- [ ] **Edge function `cc-route-decision`** (Gmail API send).
- [ ] **Edge functions `cc-decision-confirm-page`** + **`cc-decision-confirm-submit`** (unchanged from earlier plan).
- [ ] **Edge function `cc-gmail-inbound`** (Pub/Sub push handler — but only stores the matched reply; extraction is Slice 2).
- [ ] **Frontend**: 
  - Apps page recipients management UI.
  - Cockpit "Route" button wires to `cc-rewrite-decision` → preview modal → `cc-route-decision`.
  - Decision-state badges + Lately mappings.
- [ ] **Gmail setup** complete per §10.
- [ ] **Live smoke**: route the rebate-stacking decision to YOURSELF first → click Confirm → verify the answer commits + work order queues. Then re-route the same decision to Rylee + Ryan (after pre-warming them).

### Slice 2 — Inbound LLM extraction + operator confirm queue

- [ ] **Migration 025b**: `cc_claim_extraction_task` RPC + stuck-extraction sweeper.
- [ ] **Runner daemon update**: extraction poll loop alongside work-order poll.
- [ ] **Extend `cc-gmail-inbound`**: when matched reply lands, transition row to `state='replied'`, kick off the extraction task (no new function — runner picks it up).
- [ ] **Edge function `cc-confirm-extraction`** (operator confirms an LLM proposal).
- [ ] **Frontend**: operator confirm queue band on `/decisions` page.
- [ ] **Live smoke**: reply (in plain English) to a routed decision; verify the extraction proposal lands in confirm queue within ~30s; confirm; answer commits.

### Slice 3 — Reminders + auto-clarify + polish

- [ ] **Cron functions**: `cc-decision-reminder` (every 6h), `cc-decision-expire` (every hour), `cc-auto-clarify` (every 6h).
- [ ] **Reminder + clarify email copy** per §9.
- [ ] **Settings page**: surface Phase 5 row counts (sent / awaiting / answered / bounced / expired this week).
- [ ] **Live smoke**: route a decision, fast-forward `replied_at` and clear `llm_extraction.matched_option_id`, verify the clarify follow-up fires and audit captures.

---

## 12. Open decisions for the operator

Most are locked. Remaining:

| # | Question | Status |
|---|---|---|
| 1 | LLM via Claude Code CLI on Mac Studio | ✅ **LOCKED** |
| 2 | Email transport | ✅ **LOCKED — Gmail API via Google Workspace** |
| 3 | Sender address | ✅ **LOCKED — `Brian Lewis <brian.lewis@blackrockai.co>`** |
| 4 | Multi-recipient handling | ✅ **LOCKED — `registry_app_decision_recipients` table; QEP = Rylee + Ryan** |
| 5 | AI-rewrite step before send | ✅ **LOCKED — yes, with operator preview/approve** |
| 6 | Auto-clarification loop | ✅ **LOCKED — capped at 1 follow-up, then operator queue** |
| 7 | Reminder cadence | Recommend 3-day default, max 2 reminders, expire 7d. Accept or override. |
| 8 | Confirm-page deployment target | Recommend Netlify under the existing Command Center site. Accept or override. |
| 9 | First friendly-client recipient | Already decided indirectly — QEP's Rylee + Ryan via the first real route. (You smoke-test to yourself first, then routes to them.) |

---

## 13. Out of scope (Phase 6+)

- Bulk routing to all clients at once.
- Deliverability dashboards (open rates, click rates, bounce trends).
- Per-client template customization (custom logos, colors).
- A/B testing subject lines or CTAs.
- Weekly digest emails ("you have 3 pending decisions").
- High-confidence auto-confirm rules (e.g., LLM confidence > 0.95 → auto-commit).
- SMS / Slack / Telegram routing channels (Phase 5 is single-channel email).
- Recipient self-service preferences page.
- Decision question editing post-send (cancel + reroute is the only path).
- Multi-language support.
- Reply alias parsing (e.g. `reply+<send_id>@blackrockai.co`) — Gmail's In-Reply-To header gives us thread matching for free.

---

## 14. Recon contribution map

Same as v1 of this plan, with the addition of the operator dialogue today that locked Gmail-over-Resend, the multi-recipient model, the AI-rewrite step, and the capped auto-clarify loop.

---

**End of master plan v2.** Ready for operator greenlight to dispatch Slice 1.
