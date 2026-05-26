# Smoke Test Decision Answer Audit — 2026-05-26

Read-only audit against linked Supabase control-plane project `gsvhuzpysxaegoecwjmf`.

## Executive summary

- **Queries actually run:** yes, via `supabase db query --linked -o json`.
- **Database mutations:** none. Only `SELECT` statements were run.
- **Literal smoke-test poisoned answers found:** **1** in `cc_decision_answers`.
- **Control-plane inbound email replies found:** **0** in both canonical inbound storage locations.
- **Rylee's claimed 8x8/Twilio email reply:** **NOT FOUND** in control-plane tables.
- **Important nearby finding:** the closest Rylee activity is a **magic-link answer** at `2026-05-26 02:13:28+00` (`2026-05-25 22:13:28 ET`) for the **prospect quoting** decision, not the 8x8/Twilio decision.

## 1. Schema findings

Live schema was introspected first. The prompt's earlier `s.last_inbound_received_at` column does **not** exist.

### Relevant tables found

Only these email/inbound-related tables exist in `public`:

| table | purpose / finding |
|---|---|
| `cc_decision_email_sends` | Canonical outbound-send table. Also stores the first processed inbound reply inline. |
| `cc_decision_inbound_extra_replies` | Canonical table for duplicate/additional replies after the first processed reply. |
| `cc_gmail_history_cursor` | Gmail history cursor only. |

No standalone inbound-message table exists: **no** `cc_gmail_inbound`, `cc_gmail_messages`, or `cc_inbound_emails` table was present.

### `cc_decision_answers` columns

Real answer columns are:

- `id uuid`
- `issue_id uuid`
- `app_id uuid`
- `decision_external_ref text`
- `answer_value text`
- `answer_options_snapshot jsonb`
- `rationale text`
- `risk_class text`
- `answered_by text`
- `answered_at timestamptz`
- `dispatched_at timestamptz`
- `created_at timestamptz`
- `updated_at timestamptz`
- `deleted_at timestamptz`

There is **no** `actor` column and **no** `answer_data` column. Use `answered_by`, `answer_value`, and `answer_options_snapshot`.

### `cc_decision_email_sends` reply/inbound columns

The reply-received fields are:

- `replied_at timestamptz`
- `inbound_received_at timestamptz`
- `inbound_gmail_message_id text`
- `raw_reply_text text`

Relevant outbound/send columns include:

- `id uuid`
- `issue_id uuid`
- `decision_answer_id uuid`
- `app_id uuid`
- `decision_external_ref text`
- `recipient_email text`
- `recipient_name text`
- `raw_decision_title text`
- `rewritten_subject text`
- `gmail_message_id text`
- `gmail_thread_id text`
- `state cc_decision_email_state`
- `sent_at timestamptz`
- `answered_at timestamptz`
- `selected_option text`
- `operator_confirmed_by text`
- `operator_confirmed_at timestamptz`
- `created_via text`
- `route_parent_send_id uuid`

### `cc_decision_inbound_extra_replies` columns

- `id uuid`
- `send_id uuid`
- `inbound_gmail_message_id text`
- `raw_reply_text text`
- `received_at timestamptz`

### `cc_issues` relevant columns

- `id uuid`
- `app_id uuid`
- `issue_type cc_issue_type`
- `source_ref text`
- `status cc_issue_status`
- `severity cc_issue_severity`
- `title text`
- `summary text`
- `detail jsonb`
- `context jsonb`
- `surfaced_at timestamptz`
- `last_seen_at timestamptz`
- `resolved_at timestamptz`
- `created_at timestamptz`
- `updated_at timestamptz`
- `deleted_at timestamptz`

## 2. Poisoned decision count

### Exact literal smoke-test answer count: 1

Query matched `answer_value`, `answered_by`, `rationale`, title, and `answer_options_snapshot::text` for smoke/test strings.

| answer_id | issue_id | issue title | issue status | decision_ref | answer_value | answered_by | answer timestamp | send state | reply present? |
|---|---|---|---|---|---|---|---|---|---|
| `ae8ceddb-d022-4eea-b2e0-11976199bde5` | `9f808690-db4f-4168-a0f9-7639921412a8` | `6 decisions waiting on QEP` | `answered` | `phase2-smoke-test` | `smoke_test_selected` | `read-token:7e2e4ceaa524bd56` | `2026-05-21 18:57:24.110548+00` | no send row for `phase2-smoke-test` | no |

Notes:

- The live DB title is `6 decisions waiting on QEP`; the PR title Brian saw said `8 decisions waiting on QEP`. I did not find a current control-plane row with title `8 decisions waiting on QEP`.
- The smoke answer created a work order:
  - `agent_work_orders.id = 165c1295-d29b-4b75-8bac-e61800830d4c`
  - `source_answer_id = ae8ceddb-d022-4eea-b2e0-11976199bde5`
  - `status = pr_open`
  - `pr_url = https://github.com/lewis4x4/qep/pull/65`
  - `change_spec.intent = Apply the answer 'smoke_test_selected' to decision '6 decisions waiting on QEP': operator note: 'Phase 2 live smoke test'.`

### Related decision sends on the same aggregate issue

These are not literal smoke-test answer rows, but they are sends/decisions attached to the same aggregate issue that was smoke-answered.

| decision_ref | decision title | send states | latest sent | reply present? | recipients |
|---|---|---:|---|---|---|
| `e4c13fc9-0661-445f-9196-6b76b9fc3f61` | Prospect quoting / customer conversion timing | `answered`, `rewrite_ready`, `sent` | `2026-05-23 21:07:29.878+00` | no | Brian, Ryan, Rylee, rewrite preview |
| `cdf28f33-44fe-40b0-b467-df536271f96d` | Source-required equipment alerts: 8x8 vs Twilio | `rewrite_ready`, `sent` | `2026-05-23 17:44:43.853+00` | no | Brian, Ryan, Rylee, rewrite preview |
| `70f42db8-6782-4642-8b1e-841ee506189d` | Cyber insurance one-page confirmation | `rewrite_ready` | null | no | rewrite preview |
| `7274e919-b8e7-43a7-bfca-5ca9f3b12bca` | Cash rebate + finance rebate stacking | `answered`, `rewrite_ready` | `2026-05-22 23:12:28.64+00` | no | Brian, rewrite preview |

## 3. Rylee's 8x8/Twilio reply

**Result: NOT FOUND in control-plane tables.**

I searched the live control-plane inbound storage surfaces:

- `cc_decision_email_sends.raw_reply_text`
- `cc_decision_email_sends.inbound_received_at`
- `cc_decision_email_sends.inbound_gmail_message_id`
- `cc_decision_email_sends.replied_at`
- `cc_decision_inbound_extra_replies.raw_reply_text`
- `cc_decision_inbound_extra_replies.received_at`

No processed inbound replies exist at all in these tables.

### 8x8/Twilio send rows for Rylee/Ryan/Brian

The 8x8/Twilio decision is:

- `decision_external_ref = cdf28f33-44fe-40b0-b467-df536271f96d`
- title: `When a rep hits source-required on equipment (not in stock, needs to come from somewhere), Iron Quote needs to alert the sales manager. Do you want that alert sent through 8x8 (your existing phone system) or Twilio (the new SMS provider we are wiring for quote sends)?`

Relevant sent rows:

| send_id | recipient | state | sent_at | gmail_thread_id | inbound_received_at | raw_reply_text |
|---|---|---|---|---|---|---|
| `0cb5a2b4-cacc-490a-b476-1debf331c99b` | `rylee@qepusa.com` | `sent` | `2026-05-23 17:44:43.853+00` | `19e55f079f96a562` | null | null |
| `d2c79b15-6e56-4765-82ac-e50f605dde8e` | `ryan@qepusa.com` | `sent` | `2026-05-23 17:44:43.305+00` | `19e55f07744f0dbb` | null | null |
| `84cf5943-ffac-426a-88a3-30d93416a226` | `brian.lewis@blackrockai.co` | `sent` | `2026-05-23 17:44:42.861+00` | `19e55f075126f054` | null | null |

### Closest Rylee activity found

At `2026-05-26 02:13:28.290152+00` (`2026-05-25 22:13:28 ET`), Rylee used a magic link for a **different** decision:

| field | value |
|---|---|
| decision_ref | `e4c13fc9-0661-445f-9196-6b76b9fc3f61` |
| decision | Prospect quoting / customer conversion timing |
| send_id | `eced4fe6-a35f-4200-a7bb-6c4820abaf58` |
| answer_id | `95ed183c-5fb5-4fa6-a900-24d7b5f7f935` |
| answer_value | `do_not_allow` |
| rationale | `Client confirmed by magic link: rylee@qepusa.com` |
| recipient | `rylee@qepusa.com` |

This timestamp is close to Brian's reported `~22:16 ET`, but it is **not** the 8x8/Twilio decision and has no email-reply body.

### Why the email reply may be missing

The control-plane DB suggests Gmail inbound has not processed any replies:

- `cc_decision_email_sends` has **0** rows with `raw_reply_text`, `inbound_received_at`, `inbound_gmail_message_id`, or `replied_at` populated.
- `cc_decision_inbound_extra_replies` has **0** rows after the smoke-test answer timestamp.
- `cc_audit_events` has **0** `cc-gmail-inbound`, `gmail_*`, `*inbound*`, or `*reply*` events.
- `cc_gmail_history_cursor` is `history_id = 237040`, `updated_at = 2026-05-23 01:50:01.908156+00`, stale before the 2026-05-25/26 Rylee activity.

Hypothesis: the reply may exist in Gmail, but the `cc-gmail-inbound` ingestion path did not run or did not persist it into the control plane.

## 4. Other late-reply victims

### Processed inbound email replies on closed decisions

**Count: 0.**

No processed inbound email replies were present on any decision, closed or open, so the specific SQL pattern “reply arrived on `answered`/`done` decision” returned no victims in control-plane storage.

### Related non-email late answers after the smoke-test timestamp

These are not inbound email replies, but they are noteworthy because they occurred after the smoke answer on the same aggregate issue:

| answer_id | timestamp | actor | decision_ref | answer_value | recipient/source |
|---|---|---|---|---|---|
| `8c1456b0-a4f3-4488-9a5b-807e834d27cd` | `2026-05-22 23:25:08.862167+00` | `client-magic-link` | `7274e919-b8e7-43a7-bfca-5ca9f3b12bca` | `case_by_case` | `brian.lewis@blackrockai.co` |
| `95ed183c-5fb5-4fa6-a900-24d7b5f7f935` | `2026-05-26 02:13:28.290152+00` | `client-magic-link` | `e4c13fc9-0661-445f-9196-6b76b9fc3f61` | `do_not_allow` | `rylee@qepusa.com` |

## 5. Remediation SQL drafts — DO NOT RUN YET

These are draft Phase 2 statements using real live column names. They were **not** run.

### A. Quarantine the literal smoke-test answer

```sql
-- DO NOT RUN until reviewed.
BEGIN;

UPDATE public.cc_decision_answers
SET deleted_at = now(),
    updated_at = now()
WHERE id = 'ae8ceddb-d022-4eea-b2e0-11976199bde5'
  AND answer_value = 'smoke_test_selected'
  AND deleted_at IS NULL;

COMMIT;
```

### B. Quarantine the work order spawned from the smoke-test answer

```sql
-- DO NOT RUN until reviewed.
BEGIN;

UPDATE public.agent_work_orders
SET deleted_at = now(),
    updated_at = now(),
    last_error = COALESCE(last_error, 'Quarantined: work order spawned from smoke_test_selected control-plane answer')
WHERE id = '165c1295-d29b-4b75-8bac-e61800830d4c'
  AND source_answer_id = 'ae8ceddb-d022-4eea-b2e0-11976199bde5'
  AND deleted_at IS NULL;

COMMIT;
```

### C. Guarded aggregate issue status repair, only if no non-smoke answers remain

Current live data has non-smoke answers on the same aggregate issue, so this guarded statement should update **0 rows** unless those non-smoke answers are handled separately first.

```sql
-- DO NOT RUN until reviewed.
-- This is intentionally guarded to avoid reopening an issue that still has legitimate answers.
BEGIN;

UPDATE public.cc_issues i
SET status = 'surfaced',
    resolved_at = NULL,
    updated_at = now()
WHERE i.id = '9f808690-db4f-4168-a0f9-7639921412a8'
  AND i.status IN ('answered', 'done')
  AND NOT EXISTS (
    SELECT 1
    FROM public.cc_decision_answers a
    WHERE a.issue_id = i.id
      AND a.deleted_at IS NULL
      AND a.answer_value <> 'smoke_test_selected'
  );

COMMIT;
```

### D. 8x8/Twilio reply correction placeholder

No control-plane inbound body was found for Rylee's 8x8/Twilio reply, so I cannot draft a real answer correction for `cdf28f33-44fe-40b0-b467-df536271f96d` without guessing. Once Brian retrieves the Gmail body, the likely repair should target the real individual issue:

- `cc_issues.id = 4742e7eb-2b90-49c9-ab95-02525c59a380`
- `cc_issues.source_ref = cdf28f33-44fe-40b0-b467-df536271f96d`
- current `status = surfaced`

Draft shape only, with placeholders intentionally left unresolved:

```sql
-- DO NOT RUN; placeholder only. Fill <actual_option> and <rationale_from_rylee_reply> after retrieving Gmail body.
BEGIN;

-- Prefer the existing RPC/path in Phase 2 if possible; direct insert shown only as a surgical draft shape.
INSERT INTO public.cc_decision_answers (
  issue_id,
  app_id,
  decision_external_ref,
  answer_value,
  answer_options_snapshot,
  rationale,
  risk_class,
  answered_by
)
SELECT
  i.id,
  i.app_id,
  i.source_ref,
  '<actual_option>',
  i.detail->'options',
  '<rationale_from_rylee_reply>',
  COALESCE(i.detail->>'risk_class', 'authorize'),
  'manual-remediation:rylee@qepusa.com'
FROM public.cc_issues i
WHERE i.id = '4742e7eb-2b90-49c9-ab95-02525c59a380'
  AND i.source_ref = 'cdf28f33-44fe-40b0-b467-df536271f96d'
  AND i.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.cc_decision_answers a
    WHERE a.issue_id = i.id
      AND a.deleted_at IS NULL
  );

-- If an answer is inserted, close the individual decision issue.
UPDATE public.cc_issues
SET status = 'answered',
    resolved_at = now(),
    updated_at = now()
WHERE id = '4742e7eb-2b90-49c9-ab95-02525c59a380'
  AND deleted_at IS NULL
  AND status NOT IN ('answered', 'done', 'dismissed');

COMMIT;
```

## Self-check

- I actually ran the live introspection and diagnostic SQL using `supabase db query --linked`.
- I did not run any `INSERT`, `UPDATE`, `DELETE`, migrations, deploys, or edge-function changes.
- Rylee's 8x8/Twilio reply was **not found** in control-plane storage.
- Remediation drafts use real live columns (`answer_value`, `answered_by`, `raw_reply_text`, `inbound_received_at`, `source_answer_id`, etc.), not the prompt's pseudocode column names.
