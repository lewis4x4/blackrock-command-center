# Phase 5 — Slice 3 — Polish Round — Architecture Design

**Compiled:** 2026-05-22 · **Status:** Design draft, awaiting operator greenlight.
**Predecessors:**
- `docs/designs/PHASE_5_EMAIL_DECISION_ENGINE.md` (master plan, especially §4 non-negotiables and §9 locked decisions)
- `docs/designs/SLICE_2_EXTRACTION_DESIGN.md` (extraction architecture, especially §6 confidence threshold + auto-tighten rule)
- `docs/designs/SLICE_2_OPERATOR_UX_DESIGN.md` (current operator surface; §10 already noted "defer/snooze" as an open question)
- Migrations 024 → 028 (Phase 5 schema evolution + cron schedules)

**Target migration:** `029_phase5_slice3_polish.sql`.
**Build budget:** 4–6 hours, hard ceiling.

---

## 0. Scope and posture

Slice 3 is the **polish round** after Slices 1, 2, 2.5 and the cron schedules. We do not add new core surfaces; we close five small gaps that became visible once the autonomous pipeline went live.

| # | Feature | Priority | Estimate | Defer rule |
|---|---|---|---|---|
| 1 | Per-decision pause auto-route | **P0** | 60–75 min | Must ship |
| 2 | Reminder cron at 2 days | **P0** | 80–95 min | Must ship |
| 3 | Richer operator-typed clarification | **P0** | 40–55 min | Must ship |
| 4 | Snooze decision | P1 | 50–65 min | Drop if P0 trio > 3h 45m |
| 5 | Auto-tighten threshold metrics (data only) | P1 | 25–35 min | Drop only if F4 already shipped |

**Mid-estimate total: 4h 40m. Worst-case stretch: 5h 15m.** Both fit the budget. No single feature exceeds 95 minutes; nothing flagged for Slice 4.

### Posture (locked from master plan + Slice 2 review)

1. **Reuse > extend > new.** Reuse existing tables (`cc_decision_email_sends`, `cc_issues`), the `_shared/phase5.ts` Gmail helper, and the established `verifyAccessJwt` / read-token auth pattern. New tables would blow the budget; new shared abstractions would carry into Slice 4. Everything here is incremental.
2. **Non-negotiables preserved.**
   - §9 decision #7: "remind once at 2 days only" → enforced via `reminded_at IS NULL` filter + permanent `reminded_at` set after one send.
   - §4 #4: "operator confirm gate on every free-text reply" → unchanged. Slice 3 adds no new commit pathways.
   - §4 #1: "customer input cannot reach the agent as instructions" → operator-typed clarification body is sent to the recipient, never back into work orders.
   - Auto-clarify cap of 1 (DB CHECK) → unchanged; F3's operator-origin clarification continues to be excluded from the cap per Slice 2 §4c.
3. **One migration.** All schema + RPCs + cron in `029_phase5_slice3_polish.sql`. Cron `cron.schedule` for the reminder is the final block so failed cron registration leaves a recoverable state.
4. **One read-token cron auth pattern.** Migration 028's cron schedules send `x-cc-read-token`. The new reminder function adopts the same header (not `Authorization: Bearer CC_INTERNAL_TOKEN`) so we stay consistent with the live infrastructure.

---

## 1. Migration 029 — schema delta (consolidated)

```sql
-- ============================================================================
-- Migration 029: Phase 5 Slice 3 polish
-- Target: control plane (gsvhuzpysxaegoecwjmf)
-- Adds: per-send auto-route pause, snooze on cc_issues, reminder claim RPC,
-- richer operator clarify metadata, extraction-quality metrics view, and the
-- once-per-hour reminder cron.
-- ============================================================================
BEGIN;

-- 1.A  Per-send auto-route pause (Feature 1) ---------------------------------
ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS auto_route_paused_at     timestamptz,
  ADD COLUMN IF NOT EXISTS auto_route_paused_by     text,
  ADD COLUMN IF NOT EXISTS auto_route_paused_reason text;

-- Cron candidate-eligibility filter wants the "not paused" common case fast.
CREATE INDEX IF NOT EXISTS cc_decision_email_sends_auto_route_unpaused_idx
  ON public.cc_decision_email_sends (state, updated_at)
  WHERE deleted_at IS NULL
    AND created_via = 'auto_route'
    AND auto_route_paused_at IS NULL;

-- 1.B  Reminder bookkeeping (Feature 2) --------------------------------------
-- reminded_at + state='reminded' + cc_decision_email_sends_pending_reminder_idx
-- already exist (migration 024). We only add the reminder gmail message id so
-- inbound replies that land on the reminder sub-message match correctly,
-- mirroring clarification_gmail_message_id (migration 026).
ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS reminder_gmail_message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS cc_decision_email_sends_reminder_msg_idx
  ON public.cc_decision_email_sends (reminder_gmail_message_id)
  WHERE reminder_gmail_message_id IS NOT NULL AND deleted_at IS NULL;

-- 1.C  Snooze (Feature 4, P1) ------------------------------------------------
ALTER TABLE public.cc_issues
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_by    text;

CREATE INDEX IF NOT EXISTS cc_issues_snoozed_until_idx
  ON public.cc_issues (snoozed_until)
  WHERE deleted_at IS NULL AND snoozed_until IS NOT NULL;

-- 1.D  Extraction-quality metrics view (Feature 5, P1) -----------------------
CREATE OR REPLACE VIEW public.cc_extraction_threshold_metrics AS
WITH win AS (
  SELECT (now() - interval '14 days') AS start_at, now() AS end_at
)
SELECT
  (SELECT start_at FROM win)                                                                     AS window_start,
  (SELECT end_at   FROM win)                                                                     AS window_end,
  COALESCE((SELECT COUNT(*) FROM public.cc_audit_events e, win
            WHERE e.event_type = 'decision_extracted_and_answered'
              AND e.occurred_at >= win.start_at AND e.occurred_at < win.end_at), 0)              AS auto_commits_14d,
  COALESCE((SELECT COUNT(*) FROM public.cc_audit_events e, win
            WHERE e.event_type = 'decision_extraction_reverted'
              AND e.occurred_at >= win.start_at AND e.occurred_at < win.end_at), 0)              AS reverts_14d,
  CASE WHEN COALESCE((SELECT COUNT(*) FROM public.cc_audit_events e, win
                      WHERE e.event_type = 'decision_extracted_and_answered'
                        AND e.occurred_at >= win.start_at AND e.occurred_at < win.end_at), 0) > 0
    THEN ((SELECT COUNT(*) FROM public.cc_audit_events e, win
           WHERE e.event_type = 'decision_extraction_reverted'
             AND e.occurred_at >= win.start_at AND e.occurred_at < win.end_at)::numeric
          / (SELECT COUNT(*) FROM public.cc_audit_events e, win
             WHERE e.event_type = 'decision_extracted_and_answered'
               AND e.occurred_at >= win.start_at AND e.occurred_at < win.end_at)::numeric)
    ELSE 0
  END                                                                                            AS revert_rate_14d,
  COALESCE(NULLIF(current_setting('cc.extraction_auto_commit_confidence', true), '')::numeric,
           1.01)                                                                                 AS current_threshold;

REVOKE ALL ON public.cc_extraction_threshold_metrics FROM anon, authenticated;
GRANT  SELECT ON public.cc_extraction_threshold_metrics TO service_role;

-- 1.E  RPCs (sections 2/4/5 below carry the bodies) --------------------------
--   cc_pause_auto_route(p_send_id, p_actor, p_reason)
--   cc_resume_auto_route(p_send_id, p_actor)
--   cc_snooze_decision(p_issue_id, p_until, p_actor)
--   cc_unsnooze_decision(p_issue_id, p_actor)
--   cc_claim_reminder_task(p_lease_seconds)

-- 1.F  Cron — once per hour at :17 (off-peak vs */2 and */5 schedules) ------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-decision-reminder') THEN
    PERFORM cron.unschedule('cc-decision-reminder');
  END IF;
END $$;

SELECT cron.schedule(
  'cc-decision-reminder',
  '17 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-decision-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cc-read-token', '85dfc1883530807294c1568fa1c0236f15db9f672a54bd5d3bd0e3009febf8db'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

COMMIT;
```

**Rollback:** drop the new columns + view + RPCs + `cron.unschedule('cc-decision-reminder')`. No data dependencies; no fan-out across other tables.

---

## 2. Feature 1 — Per-decision pause auto-route (P0)

### What
The operator can mark a specific in-flight auto-routed decision as **do not send**. The `cc-auto-route-decisions` cron skips paused rows in both Phase A (finalize) and indirectly in Phase B (because a paused send row still occupies the issue, so the candidate selector's `NOT EXISTS` clause keeps the issue out).

Pause is **per-send**, not per-issue, because the only thing that varies between auto-routed sends from the same issue is *which recipient*. In practice an auto-route issue produces one parent send (per the `cc_decision_email_sends_one_active_auto_route_parent_per_issue_idx` unique partial index in migration 027), so per-send = per-issue in 99% of cases.

### Schema delta

```sql
ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS auto_route_paused_at     timestamptz,
  ADD COLUMN IF NOT EXISTS auto_route_paused_by     text,
  ADD COLUMN IF NOT EXISTS auto_route_paused_reason text;

CREATE INDEX IF NOT EXISTS cc_decision_email_sends_auto_route_unpaused_idx
  ON public.cc_decision_email_sends (state, updated_at)
  WHERE deleted_at IS NULL
    AND created_via = 'auto_route'
    AND auto_route_paused_at IS NULL;
```

### RPC signatures

```sql
CREATE OR REPLACE FUNCTION public.cc_pause_auto_route(
  p_send_id uuid,
  p_actor   text,
  p_reason  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor  text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 500), '');
  v_row    public.cc_decision_email_sends%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_decision_email_sends
  SET auto_route_paused_at     = now(),
      auto_route_paused_by     = v_actor,
      auto_route_paused_reason = v_reason
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND created_via = 'auto_route'
    AND state IN ('queued','rewriting','rewrite_ready')
    AND auto_route_paused_at IS NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'send not pausable (wrong state, already paused, or not an auto-route row)'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, v_actor, 'decision_auto_route_paused',
          jsonb_build_object('send_id', v_row.id, 'issue_id', v_row.issue_id, 'reason', v_reason));

  RETURN to_jsonb(v_row);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_resume_auto_route(
  p_send_id uuid,
  p_actor   text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_row   public.cc_decision_email_sends%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_decision_email_sends
  SET auto_route_paused_at     = NULL,
      auto_route_paused_by     = NULL,
      auto_route_paused_reason = NULL
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND auto_route_paused_at IS NOT NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'send not paused' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, v_actor, 'decision_auto_route_resumed',
          jsonb_build_object('send_id', v_row.id, 'issue_id', v_row.issue_id));

  RETURN to_jsonb(v_row);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_pause_auto_route(uuid, text, text)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_resume_auto_route(uuid, text)       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cc_pause_auto_route(uuid, text, text)  TO service_role;
GRANT  EXECUTE ON FUNCTION public.cc_resume_auto_route(uuid, text)       TO service_role;
```

### Cron candidate filter — required one-line tweak

In `cc_claim_auto_route_finalize` (migration 027), the candidate sub-select must add `AND s.auto_route_paused_at IS NULL`. The Phase B `cc_claim_auto_route_candidate` doesn't need a change — its existing `NOT EXISTS` against any non-deleted send row already excludes issues that have a paused (or any) send.

Add this as the second statement in the RPC update inside migration 029:

```sql
CREATE OR REPLACE FUNCTION public.cc_claim_auto_route_finalize(...)
-- existing body unchanged EXCEPT add the new WHERE clause:
--   AND s.auto_route_paused_at IS NULL
-- inside the CTE 'candidate' WHERE block.
```

### Edge function

**Decision: NEW endpoint `cc-pause-decision`**, not an extension of `cc-set-auto-route`.
Rationale: `cc-set-auto-route` operates app-scope on `registry_apps` and requires the separate `x-cc-auto-route-toggle` toggle token (a deliberate two-factor for the app-level flag). Per-send pause is a row-scope operator action surfaced from the cockpit's open-decisions row. Mixing the two would force the cockpit to acquire the toggle token for a routine action.

```
POST /functions/v1/cc-pause-decision
Auth: Cf-Access-Jwt-Assertion (operator) OR x-cc-read-token (dev / cockpit)
Body: { send_id: uuid, action: "pause" | "resume", reason?: string }
Response: { send: <DecisionEmailSend> }
```

Implementation (~55 LOC, mirrors `cc-operator-clarify-extraction` shape):

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ACCESS_REQUIRED, UUID_RE, cleanString, json, rpc, verifyAccessJwt } from "../_shared/phase5.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "POST or OPTIONS only" }, 405, ACCESS_REQUIRED ? "pass" : "noop");

  const access = await verifyAccessJwt(ACCESS_REQUIRED ? req.headers.get("Cf-Access-Jwt-Assertion") : req.headers.get("x-cc-read-token"));
  if (!access.ok) return json({ error: access.error ?? "unauthorized" }, access.status, access.headerValue);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "body must be valid JSON" }, 400, access.headerValue); }
  const sendId = cleanString((body as Record<string, unknown>)?.send_id, 80);
  const action = cleanString((body as Record<string, unknown>)?.action, 16);
  const reason = cleanString((body as Record<string, unknown>)?.reason, 500);
  if (!sendId || !UUID_RE.test(sendId)) return json({ error: "send_id must be a valid uuid" }, 400, access.headerValue);
  if (action !== "pause" && action !== "resume") return json({ error: "action must be 'pause' or 'resume'" }, 400, access.headerValue);

  try {
    const send = action === "pause"
      ? await rpc("cc_pause_auto_route",  { p_send_id: sendId, p_actor: access.actor, p_reason: reason })
      : await rpc("cc_resume_auto_route", { p_send_id: sendId, p_actor: access.actor });
    return json({ send }, 200, access.headerValue);
  } catch (e) {
    return json({ error: "pause action failed", detail: e instanceof Error ? e.message : String(e) }, 500, access.headerValue);
  }
});
```

### Audit event types
- `decision_auto_route_paused { send_id, issue_id, reason }`
- `decision_auto_route_resumed { send_id, issue_id }`

### Idempotency
- Pause is a conditional UPDATE with `WHERE auto_route_paused_at IS NULL`. Repeat calls raise `not pausable` instead of double-auditing.
- Resume symmetric: `WHERE auto_route_paused_at IS NOT NULL`. Double resume raises `send not paused`.

### Failure modes
| Failure | Behavior |
|---|---|
| Row already sent (`state='sent'+`) | RPC raises P0001 "not pausable". Operator's choice from there is to use the existing cancel/expire path (out of scope for Slice 3). |
| Row created via manual operator route | RPC raises P0001 "not pausable (not an auto-route row)". Manual routes already have operator control points; no pause needed. |
| Concurrent cron claim races operator pause | The auto-route cron uses `FOR UPDATE SKIP LOCKED` on the candidate sub-select. If the cron has already claimed the row (lease set), the pause RPC's `WHERE state IN ('rewriting','rewrite_ready')` still succeeds because the state is unchanged, but the lease holder will finalize anyway. To make pause stronger during an active rewrite, the next slice (or a v1.1 of this) could PATCH `claim_token=null, rewrite_started_at=null` inside the pause RPC. **For v1.0 of Slice 3 we accept the rare race** (window: ~30s of an active rewrite). |

### Files

| Action | Path |
|---|---|
| NEW | `supabase/functions/cc-pause-decision/index.ts` |
| MOD | `supabase/migrations/029_phase5_slice3_polish.sql` (columns, index, 2 RPCs, finalize-claim WHERE tweak) |
| MOD | `web/src/lib.ts` (add `pauseAutoRoute(sendId, reason?)`, `resumeAutoRoute(sendId)`; surface `auto_route_paused_at` on `DecisionEmailSend`) |
| MOD | `web/src/Decisions.tsx` (small "Pause auto-send" / "Resume" link in `DecisionDrawer` when `created_via='auto_route' AND state IN ('queued','rewriting','rewrite_ready')`) |

**Build estimate: 60–75 min.**

---

## 3. Feature 2 — Reminder cron at 2 days (P0)

### What
Per master plan §9 decision #7: **one reminder, at 2 days, never a second.** Cron fires hourly, claims one sent row past the 2-day mark with no reminder, no reply, and a still-valid magic link, sends a friendly nudge in the same Gmail thread, and stamps `reminded_at` so it can never be re-selected.

### Schema delta
- `reminded_at` and the state value `'reminded'` already exist (migration 024 lines 56, 107).
- `cc_decision_email_sends_pending_reminder_idx` on `(state, sent_at, reminded_at)` filtering for `state IN ('sent','delivered','opened')` already exists (migration 024 line 160). The cron query lands on that index.
- **NEW:** `reminder_gmail_message_id text` + unique partial index so the inbound matcher can recognise replies that thread off the reminder message (parallels `clarification_gmail_message_id` from migration 026 §8.4).

(Both already shown in §1.B above.)

### RPC — claim

```sql
CREATE OR REPLACE FUNCTION public.cc_claim_reminder_task(
  p_lease_seconds integer DEFAULT 60
) RETURNS public.cc_decision_email_sends
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row   public.cc_decision_email_sends;
  v_lease interval := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 60), 30));
  v_claim uuid     := gen_random_uuid();
BEGIN
  -- Release stale reminder claims (cron crashed mid-send).
  UPDATE public.cc_decision_email_sends
  SET claim_token      = NULL,
      lease_expires_at = NULL
  WHERE deleted_at IS NULL
    AND state IN ('sent','delivered','opened','clicked')
    AND reminded_at IS NULL
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < now();

  -- Atomic claim.
  UPDATE public.cc_decision_email_sends s
  SET claim_token      = v_claim,
      lease_expires_at = now() + v_lease
  WHERE s.id = (
    SELECT id
    FROM public.cc_decision_email_sends
    WHERE deleted_at IS NULL
      AND state IN ('sent','delivered','opened','clicked')
      AND reminded_at IS NULL
      AND claim_token IS NULL
      AND sent_at IS NOT NULL
      AND sent_at < now() - interval '2 days'
      AND magic_link_expires_at > now()    -- never remind on a dead link
    ORDER BY sent_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_claim_reminder_task(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cc_claim_reminder_task(integer) TO service_role;
```

### Edge function

```
POST /functions/v1/cc-decision-reminder
Auth: x-cc-read-token (same pattern as cc-auto-route-decisions)
Body: {} (empty)
Response: { ok: true, sent: <n>, considered: <n> }
```

Flow (mirrors `cc-auto-clarify` structure, ~140 LOC):
1. Verify access (`verifyAccessJwt(req.headers.get("x-cc-read-token"))`).
2. Loop up to 25 times:
   - `cc_claim_reminder_task` → row (break on null).
   - Compose Gmail RFC-822:
     - From `Brian Lewis <brian.lewis@blackrockai.co>` (constants from cc-auto-clarify).
     - To: `<recipient_name> <recipient_email>` from the row.
     - Subject: `Re: <rewritten_subject || raw_decision_title>` so the recipient's client threads it.
     - `In-Reply-To: <gmail_message_id>` of the original send.
     - `References: <gmail_message_id>` of the original send.
     - `X-CC-Send-Id: <send_id>` for inbound matching (same as Slice 1).
     - Body: friendly nudge, e.g. *"Hey <name>, just bumping this — still need an answer when you have a sec. Same three options below."*
     - Buttons: **re-use existing tokens**. TTL is 7 days from the original send; reminder fires at 2 days, so 5 days remain. No re-mint required. Pull from `row.magic_link_tokens` — but the **raw tokens are gone** (only hashes survive). The Slice 2 §7.0 token-destruction rule means we can't reconstruct the original URLs.
     - **Resolution:** the reminder email is plain text with NO buttons, just the friendly nudge and the line *"The buttons in my original email above are still active — just scroll up in this thread and click."* This is the minimum viable polish; rendering fresh buttons would require minting new tokens and bumping `magic_link_expires_at`, adding 10 minutes of code we don't need. (Operator can request button-render in a v1.1 by setting an env flag — out of scope.)
   - `gmailSend(raw)` → `{id, threadId}`.
   - `cpPatch` with conditional state guard:
     ```
     cc_decision_email_sends?id=eq.<sendId>&claim_token=eq.<token>&state=in.(sent,delivered,opened,clicked)&reminded_at=is.null
     { state: 'reminded', reminded_at: now, reminder_gmail_message_id: gmail.id,
       claim_token: null, lease_expires_at: null }
     ```
     If the patch returns 0 rows, audit `decision_reminder_skipped_state_drift` and move on (the recipient replied between claim and send — the inbound function already transitioned the row out of the matchable state).
   - `cpAudit decision_reminder_sent { send_id, issue_id, recipient_email, gmail_message_id, hours_since_sent }`.
3. Return summary.

### cc-gmail-inbound coordination

The reminder cron leaves the row in `state='reminded'`. **Verify that `cc-gmail-inbound`'s state filter for matchable replies includes `'reminded'`** — if it doesn't, replies arriving after the reminder will fail to transition the row to `replied`. If missing, add it:

```ts
// cc-gmail-inbound findSend() WHERE clause
state=in.(sent,delivered,opened,clicked,clarify_sent,reminded)
```

And add `reminder_gmail_message_id` to the OR-match query alongside `clarification_gmail_message_id`:

```ts
// matching by In-Reply-To header
or=(gmail_message_id.eq.<encoded>,clarification_gmail_message_id.eq.<encoded>,reminder_gmail_message_id.eq.<encoded>)
```

### Cron schedule
Already shown in §1.F. Once per hour at `:17` (off-peak vs the `*/2` auto-route and `*/5` auto-clarify schedules; matches the `cc-gmail-watch-renew` minute offset for consistency).

### Audit event types
- `decision_reminder_sent { send_id, issue_id, recipient_email, gmail_message_id, hours_since_sent }`
- `decision_reminder_skipped_state_drift { send_id, reason }` (when post-claim PATCH precondition fails)

### Idempotency
1. **`reminded_at IS NULL` filter is permanent.** Once set, the row can never be re-claimed. This is the master-plan §9 "remind once" guarantee at the DB level.
2. **Claim token + lease.** A crashed cron's claim releases after 60s via the sweep block; the next cron run re-claims with a fresh token.
3. **Unique `reminder_gmail_message_id` index.** Defends against the rare case of the cron successfully sending twice (e.g., the cpPatch failing but Gmail succeeded). The second cpPatch attempt collides on the unique index and surfaces a clear error.
4. **Conditional cpPatch state guard** (`state=in.(sent,...)`) gives us read-modify-write atomicity around the inbound function: if the recipient replied between claim and send, the row already moved to `replied` and our PATCH safely no-ops.

### Failure modes
| Failure | Behavior |
|---|---|
| Gmail OAuth refresh fails | `gmailSend` throws → 500 to cron → claim released by sweep at next run → retried next hour. |
| Magic link expired between claim and send | Claim filter excludes (`magic_link_expires_at > now()`); never selected. |
| Recipient replied between claim and send | Conditional PATCH returns 0 rows; audit `decision_reminder_skipped_state_drift`; row already in `replied` so harmless. |
| Two hourly cron runs collide | `FOR UPDATE SKIP LOCKED` + `claim_token IS NULL` guarantees one wins per row. |
| Inbound reply on the reminder sub-message | Matches via `reminder_gmail_message_id` (new); the existing `gmail_thread_id` match also covers it. |

### Files

| Action | Path |
|---|---|
| NEW | `supabase/functions/cc-decision-reminder/index.ts` (~140 LOC) |
| MOD | `supabase/migrations/029_phase5_slice3_polish.sql` (column + index + claim RPC + cron schedule) |
| MOD | `supabase/functions/cc-gmail-inbound/index.ts` (add `reminded` to state filter + `reminder_gmail_message_id` to OR-match) |

**Build estimate: 80–95 min.** Largest single item. Bulk of risk is the inbound coordination — budget 15 minutes for that verification + patch.

---

## 4. Feature 3 — Richer operator-typed clarification (P0)

### What
Today `cc-operator-clarify-extraction` accepts `{ send_id, message }` — a flat one-shot body. Slice 2 operator UX design §5 specified a full composer surface (subject, body, include-buttons toggle, regenerate-tokens toggle). Feature 3 implements the server side so the cockpit can deliver that UX.

### Expanded body shape

```ts
// POST /functions/v1/cc-operator-clarify-extraction
{
  send_id:            string,    // uuid, required
  subject?:           string,    // 1-200 chars; default = "Re: " + (rewritten_subject || raw_decision_title)
  body?:              string,    // 1-4000 chars (required if no `message`)
  include_buttons?:   boolean,   // default false (back-compat)
  regenerate_tokens?: boolean,   // default = include_buttons (see below)
  message?:           string     // DEPRECATED alias for `body`; still accepted
}
```

**Body resolution:** `effective_body = body ?? message`. Reject 400 if both null.
**Subject resolution:** `effective_subject = subject ?? \`Re: ${rewritten_subject || raw_decision_title || "Quick clarification"}\``.

### Token regeneration rule

Per Slice 2 §7.0: raw magic-link tokens are destroyed at send time; only HMAC hashes survive. So **rendering buttons requires fresh tokens** — there is no path to "re-use existing buttons" because the original raw values are gone. Therefore:

```
if (include_buttons === true) {
  regenerate_tokens := true   // force, even if caller said false
}
```

Document this in the response payload (`regenerated_tokens: true` flag). If the operator wants buttons without re-minting, they can't have it — this is a Slice 2-locked security property.

### Server flow

```ts
// 1. Auth + parse (unchanged).
// 2. Load send row by id (existing query, no state widening).
// 3. effective_subject, effective_body, include_buttons, regenerate_tokens.

// 4. If include_buttons:
//    - normalize options from row.options_snapshot (cc-auto-clarify has the helper)
//    - tokenizedOptions(options, sendId) — mint fresh per-option hashes
//    - append to existing magic_link_tokens (NEVER overwrite — old hashes stay valid
//      for the lifetime of their TTL; both sets coexist per Slice 2 §7.0)
//    - bump magic_link_expires_at = now() + interval '7 days'

// 5. Compose multipart RFC-822 (re-use existing composeMessage; add option-button section if include_buttons)

// 6. gmailSend(raw) → { id }

// 7. cpPatch send row:
//    {
//      state: 'clarify_sent',
//      clarification_sent_at: now,
//      clarification_gmail_message_id: gmail.id,
//      magic_link_tokens: include_buttons ? [...existing, ...new] : existing,
//      magic_link_expires_at: include_buttons ? <bumped> : existing,
//      claim_token: null, extraction_started_at: null
//    }

// 8. Audit decision_clarification_sent {
//      send_id, origin: 'operator',
//      subject: effective_subject, recipient_email,
//      include_buttons, regenerated_tokens
//    }
```

### Schema delta
**None.** All required state already exists.

### Audit event types
Existing `decision_clarification_sent` — only the `detail` shape gains the `include_buttons` + `regenerated_tokens` flags. No new event type.

### Idempotency
- Operator-initiated, not cron-driven. No DB-level dedup needed.
- Cockpit MUST disable the Send button while in-flight (standard React `busy` flag).
- Worst case (double-click): two reply emails in the same thread; benign for an operator-driven action.

### Failure modes
| Failure | Behavior |
|---|---|
| Body and message both null | 400 "body is required". |
| Body > 4000 chars | 400 "body too long". |
| Subject > 200 chars | 400 "subject too long". |
| Gmail send fails | 500; row unchanged. Operator retries. |
| Token regeneration fails (e.g., `CC_MAGIC_LINK_SECRET` missing) | 500 with explicit message; operator falls back to `include_buttons=false` mode. |

### Files

| Action | Path |
|---|---|
| MOD | `supabase/functions/cc-operator-clarify-extraction/index.ts` (extend body parsing + add button-render path + token-mint helpers copied from cc-auto-clarify) |
| MOD | `web/src/lib.ts` (extend `OperatorClarifyExtractionPayload`: add `subject?`, `body?`, `include_buttons?`, `regenerate_tokens?`; update `operatorClarifyExtraction()` to accept the new shape while preserving the 2-arg back-compat) |
| MOD | `web/src/ExtractionReviewModal.tsx` (expand the `<details>` clarification disclosure into the spec'd composer per Slice 2 UX §5: subject input, body textarea, two checkboxes, primary "Send clarification" button) |

**Build estimate: 40–55 min.** Server work ~25 min, cockpit composer ~20 min. The token-mint helpers already exist in cc-auto-clarify — copy-paste into a small `_shared/tokens.ts` (5-min helper extraction) if both functions can share, otherwise duplicate (faster).

---

## 5. Feature 4 — Snooze decision (P1)

### What
Operator can defer an open decision for N days (default 24h). Snoozed decisions hide from the open list until `snoozed_until` passes; cockpit shows a collapsible "Snoozed (n)" band so they're never truly invisible.

### Why on `cc_issues`, not `cc_decision_email_sends`
A decision can have multiple sends (auto-route parent + per-recipient clones; manual re-routes). Snooze is a decision-level UX action — the operator wants "hide this question from my queue for a day," not "hide just this one recipient." Modeling on `cc_issues` makes the read-time filter trivial (`WHERE snoozed_until IS NULL OR snoozed_until < now()`).

### Schema delta

```sql
ALTER TABLE public.cc_issues
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_by    text;

CREATE INDEX IF NOT EXISTS cc_issues_snoozed_until_idx
  ON public.cc_issues (snoozed_until)
  WHERE deleted_at IS NULL AND snoozed_until IS NOT NULL;
```

### RPC signatures

```sql
CREATE OR REPLACE FUNCTION public.cc_snooze_decision(
  p_issue_id uuid,
  p_until    timestamptz,
  p_actor    text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_max   timestamptz := now() + interval '30 days';
  v_row   public.cc_issues%ROWTYPE;
BEGIN
  IF v_actor   IS NULL THEN RAISE EXCEPTION 'p_actor is required'           USING ERRCODE = 'P0001'; END IF;
  IF p_until   IS NULL THEN RAISE EXCEPTION 'p_until is required'           USING ERRCODE = 'P0001'; END IF;
  IF p_until <= now()  THEN RAISE EXCEPTION 'p_until must be in the future' USING ERRCODE = 'P0001'; END IF;
  IF p_until >  v_max  THEN RAISE EXCEPTION 'p_until exceeds 30-day cap'    USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_issues
  SET snoozed_until = p_until,
      snoozed_by    = v_actor
  WHERE id = p_issue_id
    AND deleted_at IS NULL
    AND status IN ('surfaced','triaging','routed_to_client','gated')
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'issue not snoozable (wrong state or not found)' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, v_actor, 'decision_snoozed',
          jsonb_build_object('issue_id', v_row.id, 'until', p_until));

  RETURN to_jsonb(v_row);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_unsnooze_decision(
  p_issue_id uuid,
  p_actor    text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_row   public.cc_issues%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_issues
  SET snoozed_until = NULL,
      snoozed_by    = NULL
  WHERE id = p_issue_id
    AND deleted_at IS NULL
    AND snoozed_until IS NOT NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'issue not snoozed' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, v_actor, 'decision_unsnoozed',
          jsonb_build_object('issue_id', v_row.id));

  RETURN to_jsonb(v_row);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_snooze_decision(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_unsnooze_decision(uuid, text)            FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cc_snooze_decision(uuid, timestamptz, text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.cc_unsnooze_decision(uuid, text)            TO service_role;
```

### Edge function

```
POST /functions/v1/cc-snooze-decision
Auth: Cf-Access-Jwt-Assertion OR x-cc-read-token
Body:
  {
    issue_id: uuid,
    action:   "snooze" | "unsnooze",
    until?:   string (ISO8601),   // explicit timestamp
    days?:    number              // alternative: now + days (default 1 if neither supplied)
  }
Response: { issue: <CcIssue> }
```

Resolution: if `action="snooze"`, compute `effective_until = until ?? now() + (days ?? 1) * 86_400_000 ms`. Clamp to ≤30 days client-side (server re-validates). RPC delegates.

~50 LOC, mirrors `cc-pause-decision`.

### Read filter — `cc-read-decisions`

Update the federation function so the `decisions[]` array excludes rows where `cc_issues.snoozed_until > now()`. Add a `snoozed[]` array to the payload so the cockpit can render a collapsible band:

```jsonc
{
  "apps_reached":      [...],
  "decisions":         [...],    // excludes snoozed
  "snoozed":           [          // NEW
    { "issue_id": "...", "app_id": "...", "decision_title": "...", "snoozed_until": "..." },
    ...
  ],
  "answered_recent":   [...],
  "pending_reviews":   [...]
}
```

The federation function already joins per-app `cc_export_detail('decisions')` against control-plane `cc_issues` — adding the snooze filter is a one-line WHERE clause on the control-plane side.

### Audit event types
- `decision_snoozed { issue_id, until }`
- `decision_unsnoozed { issue_id }`

### Idempotency
- Conditional UPDATE with status guard. Repeat snooze just overwrites the `snoozed_until` (acceptable for "snooze for another day" UX).
- Audit emits on every successful state transition. (Repeat snoozes do double-audit; acceptable — the audit log is the operator's history of snooze actions.)
- No cron. Read filter is the only enforcement; PATCH paths (`cc-rewrite-decision`, `cc-route-decision`, `cc_resolve_issue`) deliberately ignore snooze — operator can still act on a snoozed issue if they choose to dig it out.

### Failure modes
| Failure | Behavior |
|---|---|
| `p_until` in the past | RPC raises P0001. |
| `p_until` > 30 days out | RPC raises P0001 (hard cap; deliberate — snooze isn't "archive"). |
| Issue not in snoozable state (`answered`, `dismissed`, `done`) | RPC raises P0001. |
| Snoozed past expiry → read filter auto-reveals | Expected behavior; no action needed. Optional polish: a cron sweep to clear stale `snoozed_until` columns (skip for v1 — keeps history). |

### Files

| Action | Path |
|---|---|
| NEW | `supabase/functions/cc-snooze-decision/index.ts` (~50 LOC) |
| MOD | `supabase/migrations/029_phase5_slice3_polish.sql` (columns + 2 RPCs) |
| MOD | `supabase/functions/cc-read-decisions/index.ts` (filter snoozed from `decisions[]`; add `snoozed[]` array) |
| MOD | `web/src/lib.ts` (add `SnoozedDecisionSummary`, `snoozed?:` on `DecisionsPayload`, `snoozeDecision`, `unsnoozeDecision`) |
| MOD | `web/src/Decisions.tsx` (add "Snooze 1d" / "Snooze 1w" links in `DecisionDrawer`; render "Snoozed (n)" collapsible band when `payload.snoozed?.length > 0`) |

**Build estimate: 50–65 min.** Defer to Slice 4 only if the P0 trio overshoots 3h 45m.

---

## 6. Feature 5 — Auto-tighten threshold metrics (P1, data only)

### What
Per SLICE_2_EXTRACTION_DESIGN §6: when extraction revert rate exceeds 5% over 14 days, nudge `EXTRACTION_AUTO_COMMIT_CONFIDENCE` up by 0.05. Since the threshold is `1.01` (auto-commit off) by default today, **the metric reads 0** for Slice 3 — but we want the instrumentation in place for the day auto-commit goes on, and we want it surfaced in Settings now so the operator can monitor.

**Defer the auto-nudge cron.** Build only:
1. The metrics VIEW (already shown in §1.D).
2. The Settings page band that renders it.
3. The forward-compat hook: when revert UX ships in a future slice, it emits `decision_extraction_reverted` and this view populates without any other change.

### Schema delta
Just the VIEW (already shown in §1.D). No mutating tables.

### Edge function — extend `cc-read-settings`

Append `extraction_metrics` to the SettingsPayload response by `SELECT * FROM cc_extraction_threshold_metrics`. Shape:

```jsonc
{
  "account":              {...},
  "aggregator":           {...},
  "integrations":         {...},
  "secrets":              [...],
  "audit_preview":        [...],
  "extraction_metrics":   {     // NEW
    "window_start":      "2026-05-08T00:00:00Z",
    "window_end":        "2026-05-22T22:00:00Z",
    "auto_commits_14d":  0,
    "reverts_14d":       0,
    "revert_rate_14d":   0.0,
    "current_threshold": 1.01,
    "auto_tighten":      "disabled"   // computed server-side; always "disabled" until auto-nudge cron ships
  }
}
```

### Audit event types
None new in Slice 3. The view is forward-compat for `decision_extraction_reverted` (which a future revert UX will emit).

### Idempotency / failure modes
- Read-only view; no concurrency.
- View is `CREATE OR REPLACE`, safe to re-run.
- Defaults `current_threshold` to `1.01` via `COALESCE(NULLIF(current_setting(...), '')::numeric, 1.01)` so the GUC's absence (managed Supabase doesn't allow `ALTER DATABASE`) is handled.

### Files

| Action | Path |
|---|---|
| MOD | `supabase/migrations/029_phase5_slice3_polish.sql` (CREATE VIEW + GRANT) |
| MOD | `supabase/functions/cc-read-settings/index.ts` (SELECT from view, append to payload) |
| MOD | `web/src/lib.ts` (add `ExtractionThresholdMetrics` interface + `extraction_metrics?:` on `SettingsPayload`; extend `parseSettingsPayload`) |
| MOD | `web/src/Settings.tsx` (new `ExtractionQualityBand` after the existing `AggregatorBand`, ~35 LOC) |

**Build estimate: 25–35 min.** Cheapest item. Ship even if F4 slips.

---

## 7. Build sequencing + hour budget

Recommended order (each step depends only on prior steps):

| # | Step | Estimate | Cumulative |
|---|---|---|---|
| 1 | Write migration 029 (all schema + all RPCs + cron) | 50 min | 0:50 |
| 2 | F1 — `cc-pause-decision` edge function + cockpit link + lib.ts | 30 min | 1:20 |
| 3 | F2 — `cc-decision-reminder` edge function + inbound match patch | 70 min | 2:30 |
| 4 | F3 — extend `cc-operator-clarify-extraction` + composer UI | 50 min | 3:20 |
| 5 | F5 — metrics view wiring + Settings band | 30 min | 3:50 |
| 6 | F4 — snooze RPCs + endpoint + read-decisions filter + cockpit band | 60 min | 4:50 |
| 7 | `ask_oracle` review pass + small fixups | 30 min | 5:20 |

**Worst-case stretch:** F2 hits 95 min, F4 hits 65 min, F3 hits 55 min → ~5:45. Still within budget.

**Deferral rule (hard):**
- If steps 1–4 (migration + the three P0 features) consume more than **3h 45m**, stop. Ship P0 alone. F4 and F5 go to Slice 4.
- F5 alone (without F4) is fine to ship — it touches only the migration's VIEW + Settings, no shared surface with F4.
- F4 alone (without F5) is also fine.

---

## 8. Master-plan non-negotiable compliance

| Non-negotiable | Slice 3 compliance |
|---|---|
| §9 #7 — "remind once at 2 days only" | F2 enforces via `reminded_at IS NULL` permanent claim filter; can never re-claim a row after a successful send. |
| §4 #4 — "operator confirm gate on every free-text reply" | Unchanged. F3 is operator → recipient outbound, not recipient → platform inbound. No new commit paths. |
| §4 #1 — "customer input cannot reach the agent as instructions" | F3 buttons re-use validated `options_snapshot`; operator-typed body is data only, never reaches work orders. |
| §4 #2 — "customer input cannot choose the build target" | F1/F4 are operator ledgers, no inbound vector. |
| §4 #6 — auto-clarify cap = 1 | F3 operator-origin clarifications continue to be excluded from `clarification_attempt_count` per Slice 2 §4c (already in place). F2 reminders are not clarifications (tracked separately via `reminded_at`). |
| Token destruction at send | F2 doesn't re-mint (plain-text reminder). F3 force-mints when `include_buttons=true` and appends to `magic_link_tokens` (never overwrites), preserving Slice 2 §7.0 invariants. |

---

## 9. Open questions for the operator

1. **F1 scope: does pause apply to operator-routed sends too?** Recommend NO. Operator-routed sends are already operator-controlled (the route modal is a manual gate). Only `created_via='auto_route'` rows can be paused. Saves UI complexity.
2. **F4 default snooze duration: 1 day or 24 hours from click?** Recommend 24 hours (`now() + interval '1 day'`). Cockpit dropdown offers `1d / 3d / 1w / custom`.
3. **F4 snooze on routed-to-client decisions:** the RPC currently allows snoozing `routed_to_client` issues. Open question — does the operator want to "ignore" a routed decision the recipient hasn't answered yet, or should snooze only apply pre-route? Recommend allow on routed too: the recipient still sees the email; the snooze just hides it from the operator's cockpit until the reply lands or the snooze expires.
4. **F2 inbound state filter:** verify `cc-gmail-inbound` accepts `state='reminded'` as a matchable inbound source. If not, add it as part of F2 (~5 min). Flag if this requires more than a one-line tweak.
5. **F5 revert UX:** out of scope for Slice 3. View ships with permanent `0` reverts until a future slice adds the "revert this auto-commit" button.

---

## 10. File touchpoint summary

**New files (4):**
- `supabase/migrations/029_phase5_slice3_polish.sql`
- `supabase/functions/cc-pause-decision/index.ts`
- `supabase/functions/cc-decision-reminder/index.ts`
- `supabase/functions/cc-snooze-decision/index.ts` *(P1)*

**Modified files (8):**
- `supabase/functions/cc-operator-clarify-extraction/index.ts` *(F3)*
- `supabase/functions/cc-gmail-inbound/index.ts` *(F2)*
- `supabase/functions/cc-read-decisions/index.ts` *(F4)*
- `supabase/functions/cc-read-settings/index.ts` *(F5)*
- `web/src/lib.ts` *(all features)*
- `web/src/Decisions.tsx` *(F1, F4)*
- `web/src/Settings.tsx` *(F5)*
- `web/src/ExtractionReviewModal.tsx` *(F3)*

---

**End of SLICE_3_ARCHITECTURE_DESIGN.md. Ready for operator greenlight.**
