# Phase 5 — Slice 3 — Safety & Race Audit

**Compiled:** 2026-05-22 · **Status:** Pre-build safety review. Must be honored by `docs/designs/SLICE_3_ARCHITECTURE.md` before any code lands.
**Predecessors:** `SLICE_2_EXTRACTION_DESIGN.md` (§6 auto-tighten, §8 idempotency, §9 failure modes), migrations `024 / 026 / 027 / 028`, edge functions `cc-auto-route-decisions`, `cc-auto-clarify`, `cc-operator-clarify-extraction`, `cc-gmail-inbound`.

The job of this document is **not** to redesign Slice 3. It enumerates every safety/race risk Slice 3 introduces and prescribes the concrete mitigation the architecture spec MUST include. Every recommendation cites the file or RPC that enforces it.

---

## 0. Hard Rules (architecture must honor all of these)

These are non-negotiable. The architecture document is rejected if any of them are absent.

| # | Rule | Enforced by |
|---|------|-------------|
| **HR-1** | **No state mutation after a network side-effect without a claim-token fence.** Every cron or operator path that sends Gmail MUST take an atomic claim BEFORE sending and re-assert that claim in the post-send PATCH. The model is `cc-auto-route-decisions` Phase A: `cpPatch(... claim_token=eq.${claimToken} ...)` → if `length !== 1`, audit drift event and throw. | New crons must mirror `cc-auto-route-decisions/index.ts:54-91` |
| **HR-2** | **Lease + sweeper on every new claim RPC.** Top-of-RPC `UPDATE … WHERE claim_token IS NOT NULL AND <started_at> < now() - lease`, then `FOR UPDATE SKIP LOCKED` to claim the next eligible row. Mirror `cc_claim_clarify_task` (migration 026 lines 489-528). | New claim RPCs in `029_phase5_slice3.sql` |
| **HR-3** | **No second-order automation respects only one budget counter.** Reminder cron must check BOTH `reminded_at IS NULL` AND `state IN (...active states only...)`. Snooze cron must check BOTH `snoozed_until <= now()` AND a fresh state predicate. Anything that fires off a Gmail send re-reads state INSIDE the claim transaction. | New cron edge functions |
| **HR-4** | **Pause is a hard gate, not a soft hint.** A pause flag MUST be re-read inside `cc_claim_auto_route_candidate` and `cc_claim_auto_route_finalize` SELECT predicates. The flag MUST NOT be checked only by the edge function (race: operator pauses between SELECT and PATCH). | Update RPCs in migration 027 |
| **HR-5** | **Operator-provided text is untrusted input.** All operator-typed subjects MUST pass through `stripHeaderUnsafe`. All operator-typed bodies MUST pass through `escapeHtml` before HTML composition. No HTML mode without sanitization. | `cc-operator-clarify-extraction/index.ts`, future compose RPCs |
| **HR-6** | **Every pause / resume / snooze / un-snooze / reminder send writes a `cc_audit_events` row.** No silent state changes. Detail must include `send_id`, `issue_id`, `actor`, before/after state. | `cpAudit(...)` calls in every Slice 3 edge function + RPC |
| **HR-7** | **Magic-link token TTL is 7 days from rewrite-ready (`magic_link_expires_at = now() + interval '7 days'`).** Reminders fire at day 2 — math is safe with 5 days slack. Reminders MUST NOT mint new tokens; they reuse the existing ones unchanged. Reminders MUST fail-closed (do not send) if `magic_link_expires_at < now() + interval '24 hours'`. | New `cc-auto-remind` cron |
| **HR-8** | **Token regeneration in operator clarify is a destructive operation.** Operator must be one-press-confirmed in the UI (same posture as destructive work orders). New tokens MUST overwrite, not append. The audit event MUST capture the count of invalidated hashes. | Operator clarify compose RPC |
| **HR-9** | **Metrics queries are read-only and bounded.** The auto-tighten metric query MUST be capped to a 14-day rolling window AND backed by a partial index on `cc_audit_events (created_at, event_type) WHERE event_type IN (...)`. No materialized view in v1 — cap window + index instead. | Migration 029 + `cc-read-decision-metrics` |
| **HR-10** | **Slice 3 features are opt-in per app.** Pause/snooze/reminder/operator-clarify-compose all live behind the existing `auto_route_decisions` boolean OR a new sibling boolean. No backfill enables them on existing apps without operator action. | `registry_apps` flag check in every Slice 3 RPC |

---

## 1. Per-decision Pause / Resume Auto-route

Slice 2.5 has `cc_set_auto_route(app_id, enabled, actor)` which pauses ALL auto-routing for an app and force-expires in-flight rewriting/rewrite_ready rows (migration 027 lines 286-318). Slice 3 adds DECISION-LEVEL pause: the operator pauses a single `cc_decision_email_sends` row without affecting siblings.

### 1.1 Schema additions (required)

```sql
ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS paused_by text,
  ADD COLUMN IF NOT EXISTS paused_reason text;
```

### 1.2 Risk table

| ID | Severity | Risk | Mitigation (architecture MUST include) | Enforced by |
|----|----------|------|----------------------------------------|-------------|
| **P-1** | **High** | Operator clicks Pause exactly when `cc_claim_auto_route_candidate` is running. Pause UPDATE and claim UPDATE race. Worst case: row is enqueued AND then the next cron Phase A sees `paused=true` but does the pause flag block the finalize? | `cc_pause_decision` RPC uses `FOR UPDATE` lock on the send row AND uses `SECURITY DEFINER` to obtain a row-level lock. Slice 3 must ADD `AND s.paused = false` to `cc_claim_auto_route_finalize`'s SELECT predicate (migration 027 line 233). The finalize claim already takes `FOR UPDATE SKIP LOCKED` — adding the pause predicate inside the same predicate makes the check atomic. | New migration 029 alters `cc_claim_auto_route_finalize`; new `cc_pause_decision(p_send_id, p_actor, p_reason)` RPC |
| **P-2** | **High** | A row is in `state='rewriting'` (runner has it claimed). Operator pauses. Runner finishes rewrite and flips to `rewrite_ready`. Next cron Phase A finalize claim sees `rewrite_ready` AND `paused=false` (operator paused AFTER runner started but BEFORE this check). Without the gate at finalize-claim time, the rewrite IS sent. | Pause MUST NOT abort the in-flight rewrite (runner has it claimed, lease in effect). Pause MUST be re-read inside `cc_claim_auto_route_finalize`'s candidate predicate. Recommended additional gate: `cc_finish_rewrite_task` (Slice 1 — file not yet edited) also checks `paused=false` and, if paused, transitions to `paused_waiting_resume` instead of `rewrite_ready`. | Migration 029 alters BOTH `cc_claim_auto_route_finalize` (claim-time gate) and `cc_finish_rewrite_task` (rewrite-finish gate). New enum value `paused_waiting_resume` added to `cc_decision_email_state` (separate transaction per `ALTER TYPE` rule from migration 026 line 13) |
| **P-3** | **Med** | Resume behavior is ambiguous. Does operator clicking Resume re-enqueue the auto-route claim, or does it need a manual trigger? If automatic, race: resume fires while finalize Phase A is mid-claim → finalize sees `paused=false`, sends → resume audit logs success, but the send was already in flight. | `cc_resume_decision(p_send_id, p_actor)` MUST: (1) acquire `FOR UPDATE` on send row, (2) flip `paused=false, paused_at=NULL, paused_by=NULL`, (3) if state IS `paused_waiting_resume`, transition to `rewrite_ready`, (4) write audit `decision_paused_resumed`. Resume is purely declarative — it does NOT call the auto-route cron. The next cron tick (≤ 2 min) finalizes. Document this in operator-facing copy: "Resume reactivates within 2 minutes". | New `cc_resume_decision` RPC + UI copy |
| **P-4** | **Med** | Operator pauses an `awaiting_clarify` row. The clarify cron (`cc-auto-clarify`) doesn't know about pause. Customer gets a clarification email even though operator intended to pause. | `cc_claim_clarify_task` (migration 026 line 489) MUST gain `AND paused = false` in BOTH the sweeper UPDATE predicate and the candidate predicate. Same for any future reminder/snooze claim. | Migration 029 alters `cc_claim_clarify_task` + adds the predicate to all new Slice 3 claim RPCs |
| **P-5** | **Low** | Operator pauses an already-`sent` row. The send already went out; pause is a no-op for that side-effect but blocks reminder/clarification follow-ups. | Document in the audit detail: pause-after-send blocks future automated follow-ups (reminder, clarify cron pick-up) but does NOT recall the email. Operator UI shows "Sent — paused; no follow-ups will fire." | UI copy + audit detail keys `state_at_pause`, `effective_scope` |
| **P-6** | **Med** | Pause is operator-only. If `x-cc-read-token` is leaked (it ships in the bundle per migration 028 line 11), anyone with the token can call `cc_pause_decision` via the edge function. | The pause edge function MUST require `verifyAccessJwt` with `ACCESS_REQUIRED=true` (Cloudflare Access JWT), NOT the read token. The read token authorizes read-only `cc-read-*` functions; mutation paths must require Access JWT. Pattern: `cc-set-auto-route/index.ts` (existing — gates on `verifyAccessJwt`). | New `cc-pause-decision` and `cc-resume-decision` edge functions; reject if `access.actor === 'read-token:*'` |
| **P-7** | **Med** | Read-token leakage scenarios are not theoretical — the token is hardcoded in `028_phase5_cron_schedules.sql` lines 47, 67, 91 and embedded in the public Vite bundle. Any Slice 3 mutation that depends on it inherits the leak. | Audit table: every Slice 3 mutation RPC must REVOKE EXECUTE from `anon, authenticated` and only GRANT to `service_role` (pattern from migration 027 lines 354-362). Edge function additionally requires Access JWT — defense in depth. | Migration 029 grants + edge function auth headers |
| **P-8** | **Low** | Audit gap: operator pauses, walks away, comes back hours later — needs to see why the decision sat unrouted. | Every `cc_pause_decision` call writes `decision_paused` audit event with `{ send_id, issue_id, paused_by, paused_reason, state_at_pause, sent_at_or_null }`. Cockpit shows pause status + reason directly on the decision card. | `cpAudit(...)` in `cc-pause-decision` edge function |

### 1.3 Required edge functions

- `cc-pause-decision` — POST `{ send_id, reason? }` → `cc_pause_decision` RPC. Requires Access JWT.
- `cc-resume-decision` — POST `{ send_id }` → `cc_resume_decision` RPC. Requires Access JWT.

---

## 2. Reminder cron at 2 days

The `reminded_at` column and partial index already exist (migration 024 lines 107 + 159-160). Slice 3 adds the claim RPC, the cron, and the send logic. Pattern follows `cc-auto-clarify` (migration 026 + edge function).

### 2.1 Schema additions

```sql
ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS reminder_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_attempt_count integer NOT NULL DEFAULT 0
    CHECK (reminder_attempt_count <= 1);  -- hard cap: one reminder per send

-- Sweep + claim index
CREATE INDEX cc_decision_email_sends_reminder_claim_idx
  ON public.cc_decision_email_sends (sent_at)
  WHERE deleted_at IS NULL
    AND state IN ('sent','delivered','opened')
    AND reminded_at IS NULL
    AND paused = false;
```

### 2.2 Risk table

| ID | Severity | Risk | Mitigation | Enforced by |
|----|----------|------|------------|-------------|
| **R-1** | **High** | Two parallel cron invocations both find the same eligible send and both call Gmail send. Customer gets two reminder emails. | New `cc_claim_reminder_task(p_lease_seconds)` RPC mirrors `cc_claim_clarify_task` exactly: top-of-RPC sweeper for stuck `claim_token` + `reminder_started_at < now() - lease`, then `FOR UPDATE SKIP LOCKED` on a single row, atomic UPDATE setting `claim_token` + `reminder_started_at`. Edge function PATCH after send uses `claim_token=eq.${claimToken}` as fence; mismatch → audit `decision_reminder_finalize_mismatch` and skip. | Migration 029 `cc_claim_reminder_task`; new `cc-auto-remind` edge function modeled on `cc-auto-clarify/index.ts:51-67` |
| **R-2** | **High** | Idempotency violation: if `reminded_at` is set AFTER Gmail send (current `cc-auto-clarify` pattern does this for `clarification_sent_at`), a crash between Gmail success and DB PATCH leaves `reminded_at=NULL`. Next cron run sees an unreminded row that already received a reminder → duplicate. | Two-stage commit: (1) inside the claim RPC, set `reminder_started_at = now()` AND keep `reminded_at = NULL`; (2) after Gmail send, PATCH sets `reminded_at = now()` AND `claim_token = NULL` filtered by `claim_token=eq.${claimToken}`. If PATCH returns 0 rows (lease lost mid-send), audit `decision_reminder_post_send_drift` with `{ gmail_message_id, send_id }` so the operator can decide whether to send another. The 60-second lease window minimizes overlap. Accept: in the rare crash-mid-send case, ONE duplicate may go out before the next claim cycle finds the dangling state — this is bounded and audit-visible. | `cc-auto-remind` edge function + audit |
| **R-3** | **High** | Magic-link tokens expire at day 7. The reminder reuses them at day 2 — math is safe (5 days slack). BUT if a row is paused for 6 days then resumed, the reminder cron picks it up and the tokens are 24h from expiry. Customer clicks → token expires mid-flight. | The reminder cron MUST refuse to send if `magic_link_expires_at < now() + interval '24 hours'`. Instead it transitions to `awaiting_operator_review` with `last_error = 'reminder skipped: tokens expire within 24h'` and audits `decision_reminder_skipped_expiry`. Operator sees this in the review queue and can manually compose a new send. | `cc-auto-remind` predicate + RPC validation |
| **R-4** | **High** | Customer replies via Gmail JUST before reminder cron fires. `cc-gmail-inbound` flips state from `sent` to `replied`. Reminder cron's SELECT (before the inbound write commits) sees state still `sent` → sends reminder for a question the customer already answered. | The claim RPC's predicate uses `state IN ('sent','delivered','opened')` ONLY — NOT `replied/extracting/awaiting_*`. The predicate is re-evaluated atomically inside the `FOR UPDATE SKIP LOCKED` claim, so if the inbound write has committed by claim time the row is excluded. If the inbound write commits AFTER claim but BEFORE Gmail send, the post-send PATCH will still drift (state has moved past `sent`). Mitigation: post-send PATCH also asserts `state IN ('sent','delivered','opened')` — if drift, audit `decision_reminder_raced_inbound` and DO NOT write `reminded_at`. Customer gets one reminder they didn't need; their reply is still processed. Acceptable: one wasteful reminder per race, never a missed reply. | `cc_claim_reminder_task` predicate + `cc-auto-remind` post-send PATCH |
| **R-5** | **Med** | Quiet hours / time-of-day not addressed by Decision #7 in master plan. Default behavior: reminders fire at any UTC hour. Risk: a 3 AM PST reminder annoys the recipient. | **Policy gap flag.** v1 ships with no quiet-hours filter — explicitly documented. The architecture doc MUST include a TODO note: "Slice 4 may add `quiet_hours_local` per recipient." For now: cron schedule = every 30 min; reminder eligibility predicate = `sent_at < now() - interval '2 days'`. This means a 3 AM send 2 days ago becomes a 3 AM reminder. Operator can pause individual rows (§1) if needed. | Policy gap section in architecture doc + cron schedule in migration 029 |
| **R-6** | **High** | Content safety: the reminder reuses `raw_decision_title` and `rewritten_subject`. These flow through `cc_export_detail` from the client app's data plane (QEP today). If the client emits a title with embedded `\r\n`, header injection is possible. | The reminder compose function MUST call `stripHeaderUnsafe` on subject (same as `cc-auto-route-decisions/index.ts:211`). Body uses `escapeHtml` for the HTML alternative. The plaintext alternative does NOT escape but does run through `String.prototype.normalize` + length cap (8000). Same guarantees as Slice 2.5. | `cc-auto-remind` compose function |
| **R-7** | **Med** | The reminder is a NEW Gmail message in the same thread (uses `In-Reply-To` + `References` headers pointing at original `gmail_message_id`). When the customer replies to the reminder, their `In-Reply-To` references the REMINDER message ID, not the original. `cc-gmail-inbound` `findSend()` (`cc-gmail-inbound/index.ts:148-156`) matches on `gmail_message_id` OR `clarification_gmail_message_id`. Reminder message IDs are NOT in either column → inbound match falls through to thread-id matching. | Migration 029 adds `reminder_gmail_message_id text` + unique partial index. `cc-gmail-inbound`'s `findSend()` query must extend the `or=(...)` filter to include `reminder_gmail_message_id.eq.${encoded}`. Thread-id fallback continues to work but is less precise (one thread → potentially many sends if recipient changed). | Migration 029 + edit `cc-gmail-inbound/index.ts:148` |
| **R-8** | **Low** | Reminder hard-cap is `reminder_attempt_count <= 1` (one reminder, ever). Operator can manually trigger another via cockpit — this should NOT increment the counter (operator action ≠ auto). | Cockpit's "Send manual reminder" path uses a separate operator function (`cc-operator-send-reminder`?) that does NOT touch `reminded_at` or `reminder_attempt_count`. Audit event distinguishes `decision_reminder_sent_auto` vs `decision_reminder_sent_operator`. | Operator reminder edge function (separate from cron) |
| **R-9** | **Low** | Customer experience: reminder appears in the same Gmail thread as the original. They see Brian's voice ("Hey, just checking in on this — same question, same buttons"). The buttons reuse the same `confirm_url`s from `magic_link_tokens` — no new tokens minted. | Same as Slice 2 clarification (§7.4 of `SLICE_2_EXTRACTION_DESIGN.md`): same thread, no duplicate identity. Reminder copy template is locked in the architecture doc and reviewed by the operator before code lands. | Architecture doc reminder template |

### 2.3 Cron schedule

Add to migration 029:
```sql
SELECT cron.schedule(
  'cc-auto-remind',
  '*/30 * * * *',   -- every 30 min; coarser than clarify because reminders are tolerant of latency
  $$ SELECT net.http_post(...); $$
);
```

---

## 3. Richer Operator Clarification Compose

Slice 2 ships `cc-operator-clarify-extraction` (file: `supabase/functions/cc-operator-clarify-extraction/index.ts`). It accepts a single `message` text field and patches `state='clarify_sent'` directly — BYPASSING the `cc_claim_clarify_task` claim path and BYPASSING the budget cap. Slice 3 enriches the compose UX (custom subject + body + optional regen + button options).

### 3.1 Risk table

| ID | Severity | Risk | Mitigation | Enforced by |
|----|----------|------|------------|-------------|
| **C-1** | **High** | Token regeneration race: operator regenerates tokens, but the customer has already received the original buttons. The customer clicks an old button. Old tokens are still valid because `cc_get_decision_confirm_data` (migration 026 lines 110-119) doesn't filter by token age — it only checks `magic_link_expires_at > now()`. | Mitigation options, in order of preference: (a) **REPLACE not APPEND**: when operator regenerates, the RPC overwrites `magic_link_tokens` entirely with the fresh set (instead of appending). All old tokens become invalid in one atomic UPDATE. (b) Add `invalidated_at timestamptz` per token entry; readers filter on `(tok->>'invalidated_at') IS NULL`. (c) Bump `magic_link_token_hash` (the legacy single-hash column) to a new sentinel so single-hash lookups also miss. **Recommendation: (a) plus (b) for audit.** New tokens replace old; the old hashes get appended to a separate `magic_link_tokens_revoked` jsonb column for forensic visibility. | New `cc_operator_regenerate_decision_tokens(p_send_id, p_actor)` RPC + audit event `decision_tokens_regenerated` with `{ revoked_count }` |
| **C-2** | **High** | Subject header injection: operator types `"Re: Question\r\nBcc: leaker@evil.com"` in the subject field. Gmail accepts the CRLF in MIME header → BCC smuggled in. | All subjects MUST pass through `stripHeaderUnsafe` (defined in `_shared/phase5.ts:223`). The function strips `[\r\n]+` to a single space. This is already done for `cc-auto-route-decisions` and `cc-operator-clarify-extraction` — Slice 3 compose must inherit it without exception. Test case required: subject containing `\r\n`, `\r`, `\n`, `\t` all collapse to space. | Operator clarify compose edge function MUST call `stripHeaderUnsafe(input.subject)` at line analogous to `cc-operator-clarify-extraction/index.ts:78` |
| **C-3** | **Med** | Body content safety: operator-typed body renders in customer's email client. Email clients are sandboxed for active content (no JS), so this is NOT a classic XSS surface. But operator could embed phishing-looking content, tracking pixels, or external images that bypass the BlackrockAI tone. | The HTML body MUST be composed by passing the operator's text through `escapeHtml` and then applying the same paragraph/line-break replacement as `cc-operator-clarify-extraction/index.ts:67` (`escapeHtml(body).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")`). NO raw HTML pass-through, ever. If the operator needs richer formatting in v2, the architecture doc must add a markdown→HTML pipeline with an allow-list, not a raw HTML mode. Plaintext alternative is sent as-is (no parsing risk in plaintext). | Compose edge function — pure-text input only |
| **C-4** | **High** | Full content audit gap: the existing `decision_clarification_sent` audit event captures `{ send_id, subject, recipient_email, gmail_message_id }` but NOT the body. Slice 3's richer compose makes this gap worse — operator can type freeform paragraphs the audit log never sees. | Every operator-typed clarification compose MUST write a `decision_operator_clarify_composed` audit event with `{ send_id, subject, body, regenerated_tokens, gmail_message_id }`. Body is capped at 8000 chars (already enforced in `cleanString`). This is THE audit record for compliance / "why did we say that to the customer" investigation. | `cpAudit(...)` in new compose edge function — body included in detail |
| **C-5** | **Med** | Policy gap: auto-clarify cron enforces `clarification_attempt_count < 1` (hard cap of 1 automated clarification). Operator-clarify currently bypasses this entirely — operator can send unlimited follow-ups. Is that intentional? Per master plan §6.6, yes (operator override). But Slice 3 should make the asymmetry explicit. | The new compose RPC MUST: (a) NOT increment `clarification_attempt_count` (so the auto-clarify cron remains capped — operator action ≠ auto), (b) write a separate counter `operator_clarification_count integer NOT NULL DEFAULT 0` that increments on every operator compose, (c) the cockpit surfaces both counts. Recommended hard ceiling: `operator_clarification_count <= 5` (DB check constraint) — prevents an automation-script bug from spamming. Document the asymmetry explicitly in the architecture doc. | Migration 029 adds column + check; RPC increments |
| **C-6** | **Med** | If operator includes button options in the compose, the per-option `confirm_url`s must reference the SAME `magic_link_tokens` rows (unless regenerated). If the operator includes a button for an option_id NOT in `options_snapshot`, the URL would 404 or — worse — be confused with another decision's option. | The compose RPC validates each button's `option_id` against the row's `options_snapshot` (same logic as `cc_finish_extraction_with_answer`, migration 026 lines 410-417). Unknown option_id → RAISE EXCEPTION. The button URL composition is server-side, not operator-supplied — operator picks options from a dropdown of `options_snapshot.label`. | Compose edge function input validation + RPC server-side URL build |
| **C-7** | **Low** | The compose flow must distinguish "send to original recipient" vs "send to a DIFFERENT recipient" (e.g., escalation to a manager). v1 should NOT permit the latter — it changes the trust model entirely. | Compose RPC accepts NO `recipient_email` field. The recipient is locked to the original `cc_decision_email_sends.recipient_email`. Architecture doc explicitly OUT-OF-SCOPE: cross-recipient escalation lands in a future slice with its own audit/legal review. | Compose edge function — recipient is read from the row, not the request body |
| **C-8** | **Low** | Operator could compose a message into a state that doesn't make sense (e.g., compose into a `answered` row where the decision is already locked in). Current code permits states `extracting, replied, awaiting_clarify, clarify_sent, awaiting_operator_review` (`cc-operator-clarify-extraction/index.ts:23`). | Compose RPC predicate: `state NOT IN ('answered','done','expired','bounced','failed','rejected_by_operator')` — terminal states excluded. Audit detail records `state_at_compose` so operator intent is visible. | Compose edge function `state=in.(...)` filter |

### 3.2 Required edge function

- `cc-operator-clarify-compose` — POST `{ send_id, subject, body, options?: [option_id], regenerate_tokens?: boolean }` → composes + sends, writes audit. Requires Access JWT. Reuses `gmailSend` from `_shared/phase5.ts:216`.

---

## 4. Snooze decision (P1)

### 4.1 Schema additions

```sql
ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_by text,
  ADD COLUMN IF NOT EXISTS snooze_count integer NOT NULL DEFAULT 0
    CHECK (snooze_count <= 4);  -- hard ceiling: at most 4 snoozes per send (~30 days at 7d each)

CREATE INDEX cc_decision_email_sends_snooze_unsnooze_idx
  ON public.cc_decision_email_sends (snoozed_until)
  WHERE deleted_at IS NULL AND snoozed_until IS NOT NULL;
```

### 4.2 Risk table

| ID | Severity | Risk | Mitigation | Enforced by |
|----|----------|------|------------|-------------|
| **S-1** | **High** | Snooze expiry cron must un-snooze the row. Race with operator manually resuming during the same window: both flip `snoozed_until = NULL`. Both are idempotent (NULL set to NULL is a no-op), BUT both write audit events. Result: duplicate `decision_unsnoozed` audit rows. | `cc_unsnooze_decision(p_send_id, p_actor)` uses `FOR UPDATE` lock + only writes the audit event if the UPDATE actually changed the row (`IF FOUND` after `UPDATE ... WHERE snoozed_until IS NOT NULL`). The un-snooze cron uses the SAME RPC, so the dedup logic is shared. | New `cc_unsnooze_decision` RPC + `cc-auto-unsnooze` cron |
| **S-2** | **High** | Aggregator interaction: the source app's `cc_export_detail` keeps emitting the decision (it has no concept of snooze — snooze is a control-plane construct). The aggregator's existing dedup (`NOT EXISTS (SELECT 1 FROM cc_decision_email_sends s WHERE s.issue_id = i.id AND s.deleted_at IS NULL)` per migration 027 line 76) prevents creating a SECOND send row — but the `cc_issues` row may transition back from `triaging` to `surfaced` if the upstream emits a delta. Then `cc_claim_auto_route_candidate` finds it again (snoozed send exists → NOT EXISTS fails → no enqueue — good). BUT a future change to the aggregator could break the predicate. | (a) The snooze flag MUST be checked at the `cc_issues.status` level as well: add a new status value `snoozed` and the aggregator's reconcile function (migration 009) must respect it: snoozed issues do NOT transition back to `surfaced` on aggregator re-pull. (b) `cc_claim_auto_route_candidate` adds `AND NOT EXISTS (... AND s.snoozed_until IS NOT NULL AND s.snoozed_until > now())` to its candidate predicate — defense in depth. | Migration 029 alters `cc_claim_auto_route_candidate` (line 64 of 027) + aggregator reconcile logic |
| **S-3** | **Med** | Misuse: operator could perma-snooze critical decisions by snoozing every 30 days. | Hard ceiling: DB check `snooze_count <= 4` (≈ 30 days max if each snooze ≤ 7 days). Default snooze duration capped at 7 days per call (RPC validates `p_snooze_until <= now() + interval '7 days'`). Cockpit shows snooze history. After hitting the cap, the row MUST go to `awaiting_operator_review` with `last_error = 'snooze ceiling reached'`. | RPC validation + check constraint |
| **S-4** | **Med** | Snoozed decisions still appear in `cc-read-decisions` (they're not deleted, just snoozed). Risk: cockpit cluttered with snoozed rows the operator can't act on. | Cockpit query (`cc-read-decisions`) adds an `?include_snoozed=false` default. Snoozed band is collapsed by default, showing only a count badge. Operator can expand to view + un-snooze early. | `cc-read-decisions` query + UI |
| **S-5** | **Low** | Snooze + un-snooze audit events must record duration: `decision_snoozed { send_id, snoozed_until, snooze_count, actor }` and `decision_unsnoozed { send_id, unsnoozed_by_cron | actor }`. The audit log MUST be able to reconstruct "this decision sat snoozed for X hours; here's why." | `cpAudit(...)` in `cc_snooze_decision` and `cc_unsnooze_decision`. | Audit detail keys defined in migration 029 |
| **S-6** | **Med** | Snooze interaction with reminder cron: a snoozed row must NOT receive a reminder. | Reminder claim predicate (§2) MUST include `AND snoozed_until IS NULL`. Same applies to clarify claim. | `cc_claim_reminder_task` predicate + `cc_claim_clarify_task` predicate |
| **S-7** | **Low** | Snooze interaction with magic-link TTL: if operator snoozes for 4 days, then un-snoozes, the tokens are 3 days from expiry. Same risk class as R-3. | Inherit R-3 mitigation: un-snooze checks `magic_link_expires_at < now() + interval '24 hours'`; if true, transition to `awaiting_operator_review` instead of resuming. | `cc_unsnooze_decision` RPC validation |

### 4.3 Cron schedule

```sql
SELECT cron.schedule(
  'cc-auto-unsnooze',
  '*/15 * * * *',
  $$ SELECT net.http_post(...); $$
);
```

---

## 5. Auto-tighten Threshold Metrics

Read-side only in v1 — per the brief, no auto-mutation. The metric in question (§6 of `SLICE_2_EXTRACTION_DESIGN.md`): "% of auto-committed extractions subsequently reverted by operator, over a rolling 14-day window."

### 5.1 Risk table

| ID | Severity | Risk | Mitigation | Enforced by |
|----|----------|------|------------|-------------|
| **M-1** | **Med** | The SQL query joins `cc_audit_events` to find `decision_extracted_and_answered` events from the last 14 days and counts how many were subsequently reverted (audit event TBD — operator-driven). If called on every cockpit load (or worse, on every Home page render), the DB pays a sequential scan over the audit table. | (a) Cap window at 14 days hard-coded in the RPC. (b) Partial index on `cc_audit_events (created_at) WHERE event_type IN ('decision_extracted_and_answered', 'decision_reverted_by_operator')`. (c) Cockpit caches the metric for 5 minutes client-side. (d) No materialized view in v1 — re-evaluate in Slice 4 if query latency exceeds 200ms p95. | Migration 029 partial index + `cc_get_extraction_revert_rate(p_window_days int = 14)` RPC + client cache |
| **M-2** | **Low** | Metric exposure: the revert rate could be sensitive (reveals LLM accuracy publicly). Today's read token is leaked; if metrics are surfaced under that token, the data leaks too. | Metric RPC requires Access JWT (not read token). Cockpit fetches via `cc-read-decision-metrics` edge function which checks `verifyAccessJwt` with `ACCESS_REQUIRED=true`. | `cc-read-decision-metrics` edge function |
| **M-3** | **Low** | Auto-tighten is read-only in v1. Slice 4 may auto-mutate `cc.extraction_auto_commit_confidence` based on this metric. The architecture doc must explicitly defer that mutation logic — DO NOT include it in Slice 3. | Architecture doc section "Out of Scope" lists auto-mutation. v1 only reads + surfaces. | Architecture doc scope section |
| **M-4** | **Low** | The metric depends on a `decision_reverted_by_operator` audit event that does not exist yet. If operator reverts manually today, no audit event is written → metric reads 0% revert rate falsely. | Migration 029 ALSO adds: (a) audit event emission to whatever RPC handles operator revert (likely `cc_operator_reject_extraction` — confirm by reading the function), (b) backfill: count `cc_decision_email_sends` rows where `selected_option` changed after `state='answered'` as "implicit reverts" for the past 14 days. | Migration 029 + edge function audit additions |

---

## 6. Cross-cutting Concerns

### 6.1 Migration ordering

Slice 3 lands as migration 029. The enum additions (`paused_waiting_resume`, `snoozed`) MUST live in a separate transaction from the column/RPC changes (Postgres limitation; same pattern as migration 026 lines 11-19). Recommended structure:

```
029_phase5_slice3_safety.sql
  TX 1: ALTER TYPE cc_decision_email_state ADD VALUE
        ALTER TYPE cc_issue_status ADD VALUE (if needed for snooze)
  TX 2: schema columns + indexes + RPCs + grants + cron schedules
```

### 6.2 RPC grant pattern

Every new RPC in 029 MUST:
```sql
REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION ... TO service_role;
```
Pattern from migration 027 lines 354-362. No exceptions.

### 6.3 Edge function auth pattern

| Function | Auth | Pattern source |
|----------|------|----------------|
| `cc-pause-decision` | Cf Access JWT (mutation) | `cc-set-auto-route/index.ts` |
| `cc-resume-decision` | Cf Access JWT (mutation) | `cc-set-auto-route/index.ts` |
| `cc-snooze-decision` | Cf Access JWT (mutation) | `cc-set-auto-route/index.ts` |
| `cc-operator-clarify-compose` | Cf Access JWT (mutation) | `cc-operator-clarify-extraction/index.ts` |
| `cc-auto-remind` | Internal cron token (`CC_INTERNAL_TOKEN`) | `cc-auto-clarify/index.ts:14` |
| `cc-auto-unsnooze` | Internal cron token | `cc-auto-clarify/index.ts:14` |
| `cc-read-decision-metrics` | Cf Access JWT (read; not the bundle token) | `cc-read-home/index.ts` |

The pattern in `cc-auto-clarify/index.ts:14` rejects with 401 if `Authorization !== 'Bearer ${INTERNAL_TOKEN}'`. The reminder + unsnooze crons mirror this exactly.

### 6.4 Cron token rotation

Migration 028 lines 47, 67, 91 hardcode the read token in the cron schedule body. If Slice 3 adds new crons, they SHOULD use `CC_INTERNAL_TOKEN` (an internal-only bearer, not the bundle token) per `cc-auto-clarify` precedent. The migration note in 028 lines 7-13 about token rotation applies — document the rotation procedure for Slice 3 crons in the architecture doc's deployment section.

### 6.5 Test plan (architecture doc must include)

Required test cases per feature:
- **Pause:** click during finalize-mid-flight (P-1, P-2); resume + immediate re-finalize (P-3); pause-after-send is no-op (P-5); read-token rejected for mutation (P-6).
- **Reminder:** two concurrent crons → single send (R-1); crash-mid-send → one duplicate at most (R-2); token expiry skip (R-3); inbound race → no reminder sent (R-4); header injection on title (R-6); inbound matching of reminder replies (R-7).
- **Compose:** subject CRLF injection blocked (C-2); body XSS-style chars escaped (C-3); audit captures full body (C-4); operator counter increments separately from auto counter (C-5); unknown option_id rejected (C-6); cannot compose to alternate recipient (C-7); cannot compose to terminal-state row (C-8); token regen invalidates old hashes (C-1).
- **Snooze:** un-snooze cron + manual race → one audit event (S-1); snoozed row not picked by auto-route candidate (S-2); snooze cap enforced (S-3); snoozed row not picked by reminder cron (S-6); near-expiry tokens block un-snooze (S-7).
- **Metrics:** 14-day window enforced (M-1); requires Access JWT (M-2); implicit revert backfill present (M-4).

---

## 7. Summary

Risk count (total 36):
- **High (12)**: P-1, P-2, R-1, R-2, R-3, R-4, R-6, C-1, C-2, C-4, S-1, S-2
- **Med (13)**: P-3, P-4, P-6, P-7, R-5, R-7, C-3, C-5, C-6, M-1, S-3, S-4, S-6
- **Low (11)**: P-5, P-8, R-8, R-9, C-7, C-8, M-2, M-3, M-4, S-5, S-7

The architecture doc must respond to every numbered risk above. Hard Rules HR-1 through HR-10 are non-negotiable.

