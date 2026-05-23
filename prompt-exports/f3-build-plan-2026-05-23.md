# F3 Build Plan — Runner E2E Close

**Compiled:** 2026-05-23
**Owner:** orchestrator (CEO co-pilot)
**Bible reference:** `docs/COMMAND_CENTER_MASTER_PLAN.md` §9 F3
**Source audit:** explore agent gap audit (in-session)

## F3 exit criteria (verbatim from Bible §9)

> "a work order can be handed to the queue, an agent builds it, a PR comes back, and Brian finds out on his phone — with an exact handoff for anything manual."

Plus the Bible §9 sequencing rule already in effect:
> F3 ships with **one-press dispatch only** until the F4 deferral lifts. No AUTO class. Brian authorizes every PR.

## What's already done (do not rebuild)

- `runner/src/` daemon — RunnerDaemon, GitHub App, /goal adapter, workspace manager, audit, config, log
- Migrations 017–022 — `agent_work_orders`, `agent_runs`, dispatch RPCs, lease sweeper, `cc_approve_work_order` RPC
- Edge function `supabase/functions/cc-approve-work-order/index.ts` — backend is complete and correct
- Phase 5 rewrite + extraction task flows through the runner E2E (smoke test confirmed today)
- Daemon is **live on Mac Studio** under launchd, logs at `~/Library/Logs/command-center-runner.log`

## What's missing (the F3 gaps)

| # | Gap | File | Confidence |
|---|---|---|---|
| 1 | `cc_operator_handoffs` table never migrated; schema only in Bible §4.5 prose | new `supabase/migrations/036_cc_operator_handoffs.sql` | HIGH |
| 3 | No Authorize button for `gated` work orders in `QueueBand` (backend RPC complete) | `web/src/Agents.tsx` | HIGH |
| 4 | No operator-handoffs panel anywhere in `web/src/` | `web/src/Agents.tsx` + `lib.ts` | HIGH |
| 5 | No auto-trigger from `cc_decision_answers` insert → `cc-dispatch-from-answer` fire | new pg_net trigger / cron / button | HIGH |
| 6 | Zero Telegram wiring; runner config has no TELEGRAM_* env vars | new `supabase/functions/cc-telegram-notify/` | HIGH |

**Explicitly deferred (F3-Blockers slice, not built now):**
- Gap 2: `supply_input` / `create_work_order` resolution actions on `cc_resolve_issue` — only built if the blocker UI kill-criterion ever trips (triage 2026-05-23 confirmed it did NOT trip)

## Decomposition — 3 work items

### Item 1 — Backend foundation (~1–2 days) — SEQUENTIAL FIRST

**Goal:** ship the missing migration + auto-dispatch glue so the queue actually fills itself and the handoffs table exists.

**Done when:**
- Migration 036 creates `cc_operator_handoffs` per Bible §4.5 spec (columns: id, app_id, kind (`manual_step` | `compose_by_hand` | `credential_rotation`), work_order_id nullable, issue_id nullable, runbook_md, status (`open` | `acknowledged` | `done`), created_at, acknowledged_at, completed_at, severity, deleted_at)
- Migration 037 (or pg_cron job inside 036) auto-fires `cc-dispatch-from-answer` when a new `cc_decision_answers` row lands without an existing `agent_work_orders` row referencing it. Either: (a) a pg_net trigger on insert, (b) a 1-min cron job that scans for orphan answers, OR (c) extend the existing `cc-answer-issue` edge function to call dispatch inline (simplest)
- Audit event types `handoff_created`, `handoff_acknowledged`, `handoff_completed` added to the existing enum/text vocabulary
- Manual smoke test: insert a fake `cc_decision_answers` row, watch a `agent_work_orders` row appear within ≤60s, watch daemon log claim it

**Files to touch:**
- `supabase/migrations/036_cc_operator_handoffs.sql` (new)
- `supabase/migrations/037_auto_dispatch_from_answer.sql` (new) — or amend `cc-answer-issue/index.ts` if going the inline route
- (do NOT modify `cc-approve-work-order/index.ts` — already correct)

**Boundary:** This item does NOT touch the frontend. Items 2 and 3 wait on this landing.

### Item 2 — Agents page completion (~1 day) — PARALLEL after Item 1

**Goal:** make the Agents page actionable — Brian can see what's in the queue, press Authorize on gated work orders, and see the manual handoff runbooks.

**Done when:**
- `web/src/Agents.tsx` `QueueBand` renders an Authorize button on `gated` rows that POSTs to existing `cc-approve-work-order` edge function
- New `OperatorHandoffsPanel` component (in `Agents.tsx` or `TriagePanels.tsx` for slide-over reuse) renders open `cc_operator_handoffs` rows with their `runbook_md` markdown
- New edge function `supabase/functions/cc-read-handoffs/index.ts` (mirror of `cc-read-agents` posture) returns the list
- New edge function `supabase/functions/cc-acknowledge-handoff/index.ts` (mirror of `cc-snooze-decision`) marks a handoff acknowledged → completed
- `web/src/lib.ts` adds `OperatorHandoff` type and `loadHandoffs()` / `acknowledgeHandoff()` helpers
- Demo data in `lib.ts` updated to seed at least one example handoff so the panel renders in demo mode
- Optimistic UI on Authorize click + Acknowledge click (button disabled, row collapses, refetch on success)

**Files to touch:**
- `web/src/Agents.tsx`
- `web/src/lib.ts`
- `supabase/functions/cc-read-handoffs/index.ts` (new)
- `supabase/functions/cc-acknowledge-handoff/index.ts` (new)

**Boundary:** Read-only handoff lifecycle for v1. Item 2 does NOT compose handoffs — that comes from Item 1's auto-dispatch and from future blocker work. Item 2 also does NOT touch the runner daemon.

### Item 3 — Telegram notifications (~1 day) — PARALLEL after Item 1

**Goal:** Brian gets a phone ping when the queue needs him. Severity-gated per Bible §5.

**Done when:**
- New edge function `supabase/functions/cc-telegram-notify/index.ts` accepts `{event_type, severity, app_id, title, body, deep_link}` and POSTs to Telegram Bot API
- Env vars `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPERATOR_CHAT_ID` documented in a new `docs/TELEGRAM_SETUP.md` and in `runner/README.md`
- Three event types fire Telegram pings (gated by severity):
  - `work_order_gated` — a new work order needs Authorize. severity=high+
  - `handoff_created` — a manual handoff is open. severity=critical only (per Bible §5 — don't push every dashboard event)
  - `work_order_pr_opened` — agent finished, PR is ready for review. severity=any
- The runner daemon calls `cc-telegram-notify` directly (already has `controlPlane.writeAuditEvent` pattern to mirror)
- The control plane fires `cc-telegram-notify` from `cc-approve-work-order`'s post-write path and from Item 1's auto-dispatch trigger (when a new gated work order appears)
- Severity gate: respects an `quiet_hours_until` row in `registry_apps` (per Bible §6) — defer this if it doesn't exist yet, simple boolean kill switch is fine for v1
- Manual smoke test: trigger one event of each type, confirm Brian receives the ping

**Files to touch:**
- `supabase/functions/cc-telegram-notify/index.ts` (new)
- `runner/src/runner.ts` (add one call to cc-telegram-notify on work_order_pr_opened)
- `runner/src/config.ts` (env vars)
- `supabase/functions/cc-approve-work-order/index.ts` (one call after success)
- Item 1's auto-dispatch path
- `docs/TELEGRAM_SETUP.md` (new) + `runner/README.md` (one section)

**Boundary:** v1 is a simple Bot API POST. NO inbound (no Telegram → command center). NO rich formatting beyond title + body + deep_link. NO per-app routing — single operator chat.

## What the user (Brian) still owes us

Documented here so the agents don't block on it:

1. **BlackRock AI GitHub App** — App ID, Installation ID, private key in `runner/.env` on Mac Studio. **Already done if Phase 5 rewrite tasks open PRs against any repo today; verify by checking runner/.env on Mac Studio.** Otherwise Brian provisions it.
2. **Telegram Bot + Chat ID** — Brian creates a Bot via @BotFather, gets the bot token, gets his own chat ID (via @userinfobot), puts both in the control plane's edge function env.
3. **WIP cap decision** — suggest 1 concurrent in-flight agent PR per app for week 1. Already enforced by `agent_work_orders_active_app_mutex` unique index in mig 017 (one active row per app). No code change required.

## Sequencing summary

```
Item 1 (backend) — ships first, ~1–2 days
  └─ Item 2 (Agents page) ┐
  └─ Item 3 (Telegram)    ┘ parallel, ~1 day each
```

## Acceptance — F3 exit gate

E2E smoke test, top to bottom:
1. Operator answers a decision in the cockpit
2. Within ≤60s a new `agent_work_orders` row appears in `gated` status (auto-dispatch)
3. Brian gets a Telegram ping: "Work order ready to authorize on QEP"
4. Brian opens the Agents page, sees the row, presses **Authorize**
5. Daemon claims the work order within the next polling tick
6. Agent runs against the QEP repo, opens a PR
7. Brian gets a second Telegram ping: "PR ready for review on QEP — [link]"
8. Brian reviews and merges

If any step fails, F3 isn't done. If all 8 succeed, F3 ships and we move to F5 client-decision finish + onboarding SCC as app #2.

## Anti-scope (do NOT build now)

- F4 earned-autonomy, verification gate, AUTO-class dispatch, PR-triage band, agreement-rate measurement — explicitly deferred per Bible §9.
- F3-Blockers slice (`supply_input` / `create_work_order` resolution actions) — explicitly deferred per triage 2026-05-23.
- Multi-operator / second-operator Telegram routing — single operator (Brian) until SCC onboards.
- Inbound Telegram commands — out of scope.
- Quiet-hours model — out of scope unless trivial to add.

---

End of plan. Each agent reads this first, then their assigned item only.
