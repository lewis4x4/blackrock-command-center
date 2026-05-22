# BlackRock AI Command Center — The Master Plan
# The full build: from read-only board to self-driving operating system

**Compiled:** 2026-05-20
**Method:** a six-agent design panel — Resolution Loop, Execution Backbone, Per-App Cockpit, Nav Pages & Activity, Data Model & Contracts, and an Information-Architecture / Visual-Design / Systems-Coherence skeptic — each designed one domain; this document synthesizes all six into one coherent, buildable plan.
**Supersedes:** `COMMAND_CENTER_OS_ROADMAP.md` as the live plan. The OS roadmap remains the record of Phase 0; this document is the plan for everything from here.
**Status of Phase 0:** schema spine done — migrations 006 (audit append-only), 007 (`cc_issues`), 008 (cron→5 min), 009 (`cc_reconcile_app_issues`) applied and verified. Two Phase-0 items remain and run on the Security Track below.

---

## 0. How to read this document

It is long because Brian asked for the whole thing, fully specified. The order is:

1. **The thesis** — what is actually wrong and what "fixed" means.
2. **The architecture** — the four moving parts and how a problem becomes a shipped change.
3. **The autonomy model and the operator handoff** — the class gate, and the "tell me exactly what to do" feature that is the heart of this revision.
4. **The data model** — every new table, as migration-ready DDL (migrations 010+).
5. **The screens** — every surface, fully specified: layout, data, actions, copy, acceptance criteria.
6. **The execution backbone** — the queue, the runner, the contracts, the verification gate.
7. **The design system** — tokens, components, states, mobile.
8. **The risks** — the skeptic's pass, with mitigations folded into the plan.
9. **The phased roadmap** — two parallel tracks, phases and exit criteria, no calendar estimates.
10. **Decisions still needed from Brian.**

The **locked decisions** this plan is built on, confirmed by Brian: class-gated autonomy; Cloudflare Access as the deployment gate; the always-on Mac Studio as the runner host with Claude Code `/goal` primary and Cursor for cloud leaf work; an **interactive** per-app cockpit; **parallel** security and functionality tracks; and a **fully-specified** deliverable. None of these are reopened below.

---

## 1. The thesis — what is wrong, and what "fixed" means

### 1.1 The one sentence

The Command Center looks like an operating system and behaves like a screenshot. Every surface that implies action — the four triage buttons, "Open QEP," the four nav pages — is a dead stub. The home renders a backend that does not exist.

### 1.2 What "fixed" is

Fixed is not "the buttons open something." Fixed is a closed loop:

> **Brian sees an issue → answers it in place → the work is composed, dispatched, built, and verified in the background → a pull request comes back, ranked for review → he merges.** And for anything that cannot run itself, the system hands him an exact, ordered runbook: which tool, which commands, in what order.

The product is that loop. Not the dashboard — the loop. Everything in this plan is in service of it.

### 1.3 The four things the panel changed about the obvious approach

**One — resolution happens where the problem was seen, never by navigating.** A triage item opens a **slide-over** on top of the home. Brian answers inside it; it closes; the row updates in place. He does not "go to the Decisions page to handle decisions." The nav pages are for browsing and configuration; the **home and the cockpit are where work gets resolved.** This single rule is the spine of the information architecture — it keeps the loop tight enough to clear from a phone in fifteen seconds.

**Two — the system must tell Brian what to do, not just what is wrong.** The roadmap's autonomy model handles the work that can run itself. The missing half — the half Brian called out — is the work that cannot: the AUTHORIZE-class build, the hard change that needs hand-composition in RepoPrompt, the credential only he can rotate. For every one of those, the system produces an **operator handoff**: a concrete, copy-pasteable runbook naming the exact tool and steps. This is promoted to a first-class feature (§3.3). It is the difference between a console that reports and a console that commands.

**Three — "self-driving" is earned per class of work, by evidence, never switched on by a flag.** The single largest way this project fails: Brian builds the whole dispatch engine, it works mechanically, but the verification gate is not trustworthy — so he reviews every PR fully anyway, and the Command Center runs at exactly the speed he runs at today, plus maintenance. The mitigation is a sequencing discipline (§8.1, §9): the verification gate ships *before* auto-dispatch, runs in advisory mode while Brian still reviews everything, and a work-class only goes hands-off once the gate has *demonstrated* it catches what Brian would have caught.

**Four — honesty is a build requirement, not a polish item.** A dead app must never show a confident green. Freshness and build-health are two separate signals and the UI may never merge them. Stale data is labeled stale. A page whose data arrives in a later phase shows an honest, useful interim state — never the word "soon."

### 1.4 What is already true (Phase 0 progress)

The control plane has a registry, append-only audit log, and a live issue ledger. `cc_issues` is populated and self-maintaining: the Aggregator polls QEP every five minutes and `cc_reconcile_app_issues()` upserts triage conditions into the ledger. QEP currently carries three real issues. The read path is honest and done. **This plan builds the write path and the surfaces on top of it.**

---

## 2. The architecture

### 2.1 The four parts

```
   A CLIENT APP            THE CONTROL PLANE  (Command Center)            A RUNNER
   ───────────             ─────────────────────────────────────         ────────
   roadmap / decisions     ┌─ cc_issues ──── the issue ledger             Claude Code /goal
   change → webhook push ─►│      │          (every triage condition)     on the Mac Studio
                           │      ▼                                       (primary)
   cc_export_snapshot() ──►│  cc_decision_answers ── the answer            Cursor background
   cc_export_detail()   ◄──┤      │                                       agents (cloud leaf)
   cc_apply_*()         ◄──┤      ▼                                            │
        ▲                  │  agent_work_orders ──── the queue ───────────────►│ runs /goal,
        │ writes go        │      │         (atomic claim, lease, mutex)        │ opens a PR
        │ through the      │      ▼                                            │
        └─ cockpit proxy   │  cc_operator_handoffs ── "what you do by hand"     │
                           │      │                                            ▼
                           │      ▼                              verification gate (CI +
                           │  agent_runs ──── cost / outcome ◄─── acceptance + blast-radius)
                           │                                            │
                           └─ PR-triage band on the home  ◄─────────────┘  →  Brian merges
```

**The federated boundary is absolute.** The control plane holds no client business data. It never live-joins a client database. It learns about a client app three ways only: it polls `cc_export_snapshot()` (aggregate counts, every 5 min); it reads `cc_export_detail()` on demand (item-level, when a panel opens); and it receives HMAC-signed webhook pushes. Every write back into a client database goes through a single control-plane proxy that resolves the key by name and audits the call. One breach must never become six.

**The build target is bound server-side, always.** A work order's `target_repo` and `target_branch` are read from `registry_app_repo` keyed by `app_id`. No answer, email, free-text field, agent output, or UI control can name a repo. This is enforced in the data model (no column accepts it from the client), in the UI (no input renders for it), and in the proxy (it ignores any repo field in a payload).

### 2.2 The lifecycle of one problem, end to end

1. A condition appears in QEP (a decision opens, the build goes yellow, a task blocks). The Aggregator's next poll reconciles it into `cc_issues` as a row with identity and a lifecycle.
2. It surfaces on the home triage band — `surfaced`, "Needs you."
3. Brian clicks the triage action. A **resolution slide-over** opens over the home. Header renders instantly from `cc_issues`; the item-level body streams from `cc_export_detail()` through the cockpit proxy.
4. He answers — an **enumerated** option plus an optional free-text rationale. The answer writes `cc_decision_answers`; the issue advances `triaging → answered`.
5. The control plane composes an `agent_work_orders` row: `app_id`, the server-bound repo/branch, a structured `change_spec` assembled only from enumerated fields, a re-derived `risk_class`, an `idempotency_key`, a `cost_cap`. The issue advances to `work_order_created`. Simultaneously a `cc_operator_handoffs` row is written — for AUTO work it says "nothing to do, watching"; for everything else it is the exact runbook.
6. **Class gate.** AUTO-class, reversible, single-surface, under the cost cap → the work order is dispatch-eligible immediately. AUTHORIZE-class → the work order parks in `pending_authorization` and the issue moves to `gated` ("Waiting on your OK") for one press from Brian.
7. The runner daemon on the Mac Studio claims the order under an atomic lease, takes the per-app repo mutex, mints a short-lived GitHub App token, clones the server-bound repo into a throwaway workspace, runs `/goal` against the `change_spec`, pushes a branch, opens a PR, writes `agent_runs` cost and outcome. The issue moves `dispatched → building → pr_open`.
8. The **verification gate** runs between the PR and Brian: typecheck, build, tests, the acceptance criteria from the `change_spec`, and a blast-radius check. A failure routes the PR back to the agent, not to Brian.
9. A verified PR lands in the **PR-triage band** on the home, ranked by impact. Brian reviews and merges. The merge is the one permanent human gate — it never automates.
10. The condition clears in QEP; the next poll reconciles the `cc_issues` row to `done`.

### 2.3 The two surfaces where work is resolved

- **The home** — triage across all apps. Resolution happens in slide-overs that never unmount the home.
- **The per-app cockpit** (`/apps/QEP`) — the home's grammar one level deeper, for one app. Interactive: answer that app's decisions, change task states, dispatch, retry sync. It removes your need to *open* Linear for the daily look — **Linear itself is not replaced; it stays the system of record** (§5.3).

The four nav pages — Decisions, Agents, Apps, Settings — are for **browsing and configuration**, not resolution. This division is the IA.

---

## 3. The autonomy model and the operator handoff

### 3.1 The class gate (locked)

Answering an issue always composes a work order. Whether that order **auto-dispatches** is gated by class:

- **AUTO** — reversible, single-surface, under the app's cost cap. Dispatches with no click. The common case; genuinely hands-off.
- **AUTHORIZE** — money-touching, schema-destructive, production-affecting, or over the cost cap. The order is created and waits for **one press** from Brian. Not a form — one button.

`risk_class` is **re-derived server-side** when the work order is composed. A client app's `cc_export_detail()` may *hint* a class; the control plane recomputes it from the change surface, the cost cap, and a keyword/área check, and the hint can only ever make a thing *more* gated, never less.

**Five things never automate, at any maturity:** the PR merge; dispatch of AUTHORIZE / destructive / production work; the confirm step on a client's free-text reply; what is shown to a client as "Shipped"; and any non-trivial dispatch while Brian is unreachable.

### 3.2 Earned autonomy

Auto-dispatch is not switched on for a work-class by setting a flag. It is **earned**:

- **Stage 1 — advisory.** The verification gate runs on every PR; Brian still reviews everything. The gate records, per PR, whether it agreed with his merge/reject decision.
- **Stage 2 — measured.** Once the gate's agreement rate on a work-class clears a threshold over a real sample, that class becomes eligible for auto-dispatch.
- **Stage 3 — hands-off.** The class auto-dispatches; the gate is the reviewer of first resort; Brian reviews the PR-triage band.

This is a per-class progression backed by evidence in `agent_runs`. It is the antidote to the project's single biggest failure mode (§8.1).

### 3.3 The operator handoff — the headline feature of this revision

Every work order produces a `cc_operator_handoffs` row. It answers one question: **"What, if anything, do I do now?"**

- **AUTO work** → the handoff says: *"Nothing to do. QEP build dispatched to Claude Code — watching it for you."* It is a receipt, not a task.
- **AUTHORIZE work** → the handoff is a one-press instruction surfaced as a button: *"Authorize this build."*
- **Work that cannot run itself** — a hard change that needs hand-composition, a credential rotation, a manual config step — → the handoff is an **exact, ordered runbook**:

  ```
  This one needs your hands. Here is the path:

  1. Open RepoPrompt.
  2. Paste the work-order brief below (already on your clipboard).
  3. Compose the change against  lewis4x4/qep  on branch  cc/dec-118-leadtime.
  4. When RepoPrompt produces the patch, come back here and press
     "Mark composed" on this handoff — the queue takes it from there.

  Brief: <the change_spec, rendered as readable markdown>
  Repo:  lewis4x4/qep   Branch: cc/dec-118-leadtime   (bound — do not change)
  ```

The handoff names the **tool** (RepoPrompt, Cursor, Claude Code `/goal`, the Supabase dashboard, a Cloudflare setting), the **exact steps**, the **exact values** (repo, branch, file paths, secret names), and a **way back** — a control the handoff offers so the loop closes when the manual step is done. A handoff is never vague. It is the spec, the location, and the next click.

Handoffs surface in three places: inline in the slide-over that produced them; on the **Agents** page as a "Waiting on you" list; and, for the urgent ones, as a Telegram message. Each has a state — `pending → acknowledged → done → dismissed` — so nothing Brian must do by hand is ever silently lost.

### 3.4 Where customer and agent input is allowed to go

A client's free-text reply, or an agent's output, can never become instructions an agent reads, and can never select a build target. The data model enforces it: `change_spec` is assembled from enumerated `option_id`s; the rationale text is stored as `provenance.operator_note` and explicitly flagged non-instructional; `target_repo` is read from the registry. The UI enforces it: there is no control anywhere that lets a repo or branch be typed. A client's free-text email reply is reduced to an enumerated option by an extraction step and then **confirmed by Brian** before it touches a work order.

---

## 4. The data model — migrations 010 onward

Everything below is migration-ready DDL in the house style: `uuid` primary keys; `created_at` / `updated_at` / `deleted_at`; RLS on every table; secrets only as `*_secret_ref` pointers; `NNN_snake_case.sql`, no gaps. The shared `fn_cc_touch_updated_at()` trigger (migration 001) is reused throughout. Lifecycle columns with a stable vocabulary (`cc_issue_status`, `cc_work_order_status`) use Postgres enums; status columns the write path is expected to extend (`agent_runs.outcome`, the email-send and webhook-delivery states) deliberately use `text` + a `CHECK` constraint, so adding a value is a one-line change, not an `ALTER TYPE` migration.

**One standing rule for every new table: no `anon` grant, ever.** Migration 005 made the home tables anon-readable; that is acceptable only for low-sensitivity registry data behind Cloudflare Access. The write-path tables carry operator rationale, cost data, repo targets, handoff runbooks, and (later) magic-link tokens. They are `service_role` + `authenticated` only. Cloudflare Access is one gate; it is not a reason to widen the database.

### 4.1 Migration 010 — `cc_issues` grain + the anon-read hardening

```sql
-- 010_cc_issues_grain_and_anon_hardening.sql
BEGIN;

-- (a) Issue grain — aggregate vs item-level. The reconciler writes 'aggregate'
--     rows; Phase 2 detail panels write 'item' rows with a real source_ref.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_issue_grain') THEN
    CREATE TYPE public.cc_issue_grain AS ENUM ('aggregate', 'item');
  END IF;
END $$;

ALTER TABLE public.cc_issues
  ADD COLUMN IF NOT EXISTS grain public.cc_issue_grain NOT NULL DEFAULT 'aggregate';

-- (b) Security Track / S1 close-out: revoke EVERY anonymous read. After this
--     the browser holds no Supabase key at all and reads only through the
--     Access-gated control-plane read API (§4.11). Apply part (b) ONLY once
--     that read API is live — otherwise the live home loses its data source.
DROP POLICY IF EXISTS registry_apps_anon_read             ON public.registry_apps;
DROP POLICY IF EXISTS registry_app_snapshots_anon_read    ON public.registry_app_snapshots;
DROP POLICY IF EXISTS registry_app_integrations_anon_read ON public.registry_app_integrations;
DROP POLICY IF EXISTS cc_audit_events_anon_read           ON public.cc_audit_events;
DROP POLICY IF EXISTS cc_issues_anon_read                 ON public.cc_issues;
-- Drop the table-level grant too — the standing rule is no anon grant, at all.
-- (Migration 006 explicitly GRANTed SELECT on cc_audit_events to anon; the
--  others carry Supabase's default-privilege grant. Revoke all five.)
REVOKE SELECT ON public.registry_apps, public.registry_app_snapshots,
                 public.registry_app_integrations, public.cc_audit_events,
                 public.cc_issues FROM anon;

COMMIT;
```

> **Apply order.** Migration 010 is a single file applied once — at the S1 point inside F1, after the §4.11 read API is live; both parts apply together. Part (a)'s `grain` column then lands well before F2's item-level issues need it; part (b)'s anon-revocation is safe because the browser no longer reads the database directly. `cc_reconcile_app_issues()` (migration 009) needs no change: its upsert path takes the `grain` default `'aggregate'`, and its resolve step is already isolated to aggregate rows by the `source_ref = 'aggregate'` predicate — item-level rows (which carry a real `source_ref`) are never touched by it.

### 4.2 Migration 011 — `cc_decision_answers`

The durable record of every answer Brian (or a confirmed client reply) gives.

```sql
-- 011_cc_decision_answers.sql
BEGIN;

CREATE TABLE public.cc_decision_answers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  issue_id        uuid NOT NULL REFERENCES public.cc_issues(id)     ON DELETE CASCADE,
  source_ref      text NOT NULL,                 -- the client-app decision/task id
  answer_kind     text NOT NULL CHECK (answer_kind IN
                    ('operator_decision','client_decision','blocker_input','sync_escalation')),
  option_id       text,                          -- the ENUMERATED choice — never free text
  option_label    text,                          -- denormalized for display + change_spec
  typed_value     jsonb,                         -- a validated typed value where the answer is a number/string
  rationale       text,                          -- provenance only; NEVER read as instructions
  answered_by     text NOT NULL,                 -- operator email, or 'client:<email>' for a confirmed reply
  answered_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- An answer is either an enumerated option or a validated typed value — never neither.
  CONSTRAINT cc_decision_answers_has_answer
    CHECK (option_id IS NOT NULL OR typed_value IS NOT NULL)
);

COMMENT ON COLUMN public.cc_decision_answers.rationale IS
  'Operator note, kept for the record. Never assembled into change_spec, never read by an agent.';

-- One answer per (issue, decision): re-answering the same decision conflicts,
-- so a double-fire from the slide-over can never write a second answer row.
CREATE UNIQUE INDEX cc_decision_answers_issue_source_key
  ON public.cc_decision_answers (issue_id, source_ref);
CREATE INDEX cc_decision_answers_app_idx
  ON public.cc_decision_answers (app_id, answered_at DESC);

CREATE TRIGGER cc_decision_answers_touch BEFORE UPDATE ON public.cc_decision_answers
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.cc_decision_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY cc_decision_answers_service_all ON public.cc_decision_answers
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY cc_decision_answers_auth_all ON public.cc_decision_answers
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
```

### 4.3 Migration 012 — `agent_work_orders` (the queue)

The single most important table in the write path. A work order is one row; its `status` is the source of truth; every transition writes a `cc_audit_events` row.

```sql
-- 012_agent_work_orders.sql
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_work_order_status') THEN
    CREATE TYPE public.cc_work_order_status AS ENUM
      ('composed',            -- created from an answer, not yet eligible
       'pending_authorization', -- AUTHORIZE-class, waiting on Brian's one press
       'ready',               -- eligible; awaiting a runner claim
       'claimed',             -- a runner holds the lease
       'building',            -- the agent is working
       'pr_open',             -- a PR exists; verification gate to run/running
       'verifying',           -- verification gate in progress
       'verified',            -- gate passed; in the PR-triage band
       'merged',              -- Brian merged — terminal success
       'failed',              -- the run errored
       'dead_letter',         -- exhausted max attempts
       'cancelled');          -- cancelled by Brian
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_risk_class') THEN
    CREATE TYPE public.cc_risk_class AS ENUM ('auto', 'authorize');
  END IF;
END $$;

CREATE TABLE public.agent_work_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  issue_id         uuid REFERENCES public.cc_issues(id) ON DELETE SET NULL,
  answer_id        uuid REFERENCES public.cc_decision_answers(id) ON DELETE SET NULL,
  status           public.cc_work_order_status NOT NULL DEFAULT 'composed',
  risk_class       public.cc_risk_class NOT NULL,         -- re-derived server-side
  -- Build target — bound server-side from registry_app_repo. NEVER set from a client.
  target_repo      text NOT NULL,
  target_branch    text NOT NULL,
  -- The brief. Assembled ONLY from enumerated answers + typed values.
  change_spec      jsonb NOT NULL,    -- {intent, affected_area, acceptance_criteria[], constraints[], decision_id, option_id}
  provenance       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {issue_id, answer_id, answered_by, operator_note}
  routing          text NOT NULL DEFAULT 'goal'         -- runner — SERVER-SET by the routing policy (§6.3), never client-chosen
                     CHECK (routing IN ('goal','cursor','codex','gemini','opencode')),
  -- Queue mechanics
  idempotency_key  text NOT NULL UNIQUE,                 -- hash(app_id, source_ref, option_id[, retry-N])
  criticality      int NOT NULL DEFAULT 0,               -- copied server-side from registry_apps at compose, for claim ordering
  cost_cap_usd     numeric(10,2) NOT NULL DEFAULT 5.00,
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 3,
  -- Lease — a crashed runner's order auto-reclaims when the lease expires.
  claimed_by       text,
  claimed_at       timestamptz,
  lease_expires_at timestamptz,
  -- Result
  pr_url           text,
  failure_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

-- The per-app repo mutex: never two agents writing one repo's working clone at
-- once. It covers ONLY the states where a runner holds a live clone. Once a PR
-- is open the clone is destroyed, so 'pr_open'/'verifying' are deliberately NOT
-- in the set — that is what lets the §6.7 WIP limit (up to N un-merged PRs per
-- app) actually be reachable, instead of being capped at 1 by this index.
CREATE UNIQUE INDEX agent_work_orders_repo_mutex
  ON public.agent_work_orders (app_id)
  WHERE status IN ('claimed','building');

CREATE INDEX agent_work_orders_claimable_idx
  ON public.agent_work_orders (status, criticality DESC, created_at)
  WHERE status = 'ready';
CREATE INDEX agent_work_orders_app_idx ON public.agent_work_orders (app_id, created_at DESC);

CREATE TRIGGER agent_work_orders_touch BEFORE UPDATE ON public.agent_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.agent_work_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_work_orders_service_all ON public.agent_work_orders
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_work_orders_auth_read ON public.agent_work_orders
  FOR SELECT TO authenticated USING (true);

-- Brian's one-press authorize — the only authenticated write to this table.
-- SECURITY DEFINER so it can advance a row `authenticated` may only SELECT;
-- search_path pinned; EXECUTE revoked from PUBLIC, granted to authenticated.
CREATE OR REPLACE FUNCTION public.cc_authorize_work_order(p_work_order_id uuid)
RETURNS public.agent_work_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_row public.agent_work_orders;
BEGIN
  UPDATE public.agent_work_orders
     SET status = 'ready'
   WHERE id = p_work_order_id
     AND status = 'pending_authorization'
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'work order % is not awaiting authorization', p_work_order_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, 'operator', 'work_order_authorized',
          jsonb_build_object('work_order_id', v_row.id));
  RETURN v_row;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_authorize_work_order(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cc_authorize_work_order(uuid) TO authenticated;

COMMIT;
```

The claim is atomic: a runner runs `UPDATE agent_work_orders SET status='claimed', claimed_by=$1, claimed_at=now(), lease_expires_at=now()+interval '15 min' WHERE id = (SELECT id FROM agent_work_orders WHERE status='ready' ORDER BY criticality DESC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. `criticality` is denormalized onto the work order at compose time — copied server-side from `registry_apps`, the same discipline as the build target — so the claim orders on a local, indexed column (`agent_work_orders_claimable_idx`) with no cross-table join on the hot path. Criticality scheduling is in from the first runner. The repo-mutex partial unique index makes two agents in one repo a database error, not a race.

### 4.4 Migration 013 — `agent_runs` (the cost & outcome ledger)

```sql
-- 013_agent_runs.sql
BEGIN;

CREATE TABLE public.agent_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id    uuid NOT NULL REFERENCES public.agent_work_orders(id) ON DELETE RESTRICT,
  app_id           uuid NOT NULL REFERENCES public.registry_apps(id)    ON DELETE CASCADE,
  runner           text NOT NULL,                  -- 'goal' | 'cursor' | ...
  runner_host      text,                           -- 'mac-studio' | 'cursor-cloud'
  attempt          int  NOT NULL DEFAULT 1,
  outcome          text CHECK (outcome IN ('running','succeeded','failed','cancelled','timed_out')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  duration_sec     int,
  cost_usd         numeric(10,4),
  tokens_in        bigint,
  tokens_out       bigint,
  baseline_sec     int,                            -- typical duration for this runner+kind, for the heartbeat
  pr_url           text,
  verification     jsonb,                          -- {typecheck, build, tests, acceptance[], blast_radius}
  log_excerpt      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_runs_work_order_idx ON public.agent_runs (work_order_id);
CREATE INDEX agent_runs_app_idx        ON public.agent_runs (app_id, started_at DESC);
CREATE INDEX agent_runs_running_idx    ON public.agent_runs (outcome) WHERE outcome = 'running';

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_runs_service_all ON public.agent_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_runs_auth_read ON public.agent_runs
  FOR SELECT TO authenticated USING (true);

COMMIT;
```

### 4.5 Migration 014 — `cc_operator_handoffs`

The "tell me exactly what to do" feature, given a table.

```sql
-- 014_cc_operator_handoffs.sql
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_handoff_status') THEN
    CREATE TYPE public.cc_handoff_status AS ENUM
      ('pending','acknowledged','done','dismissed');
  END IF;
END $$;

CREATE TABLE public.cc_operator_handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  issue_id        uuid REFERENCES public.cc_issues(id) ON DELETE SET NULL,
  work_order_id   uuid REFERENCES public.agent_work_orders(id) ON DELETE RESTRICT,
  status          public.cc_handoff_status NOT NULL DEFAULT 'pending',
  kind            text NOT NULL CHECK (kind IN
                    ('watching',          -- AUTO work — informational, no action
                     'authorize',         -- one-press authorize
                     'compose_by_hand',   -- RepoPrompt / Cursor hand-composition
                     'manual_step',       -- a credential rotation, a dashboard setting
                     'review_pr')),       -- a verified PR awaiting merge
  headline        text NOT NULL,          -- "This one needs your hands."
  tool            text,                   -- 'repoprompt' | 'cursor' | 'goal' | 'supabase' | 'cloudflare' | null
  steps           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ordered [{n, instruction, value}]
  brief           text,                   -- the change_spec rendered as readable markdown
  clipboard       text,                   -- exact text pre-loaded to the clipboard
  return_action   text,                   -- the control that closes the loop: 'mark_composed' | 'authorize' | ...
  acknowledged_at timestamptz,
  done_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cc_operator_handoffs_open_idx
  ON public.cc_operator_handoffs (status, created_at)
  WHERE status IN ('pending','acknowledged');
CREATE INDEX cc_operator_handoffs_app_idx   ON public.cc_operator_handoffs (app_id, created_at DESC);
CREATE INDEX cc_operator_handoffs_wo_idx    ON public.cc_operator_handoffs (work_order_id);
CREATE INDEX cc_operator_handoffs_issue_idx ON public.cc_operator_handoffs (issue_id);

CREATE TRIGGER cc_operator_handoffs_touch BEFORE UPDATE ON public.cc_operator_handoffs
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.cc_operator_handoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY cc_operator_handoffs_service_all ON public.cc_operator_handoffs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY cc_operator_handoffs_auth_all ON public.cc_operator_handoffs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
```

### 4.6 Migration 015 — webhook ingest

```sql
-- 015_webhook_ingest.sql
BEGIN;

-- Registry pointers for the per-app inbound webhook secret + detail contract.
ALTER TABLE public.registry_app_supabase
  ADD COLUMN IF NOT EXISTS detail_contract_version int NOT NULL DEFAULT 0;
ALTER TABLE public.registry_apps
  ADD COLUMN IF NOT EXISTS ingest_secret_ref text;   -- name of the HMAC secret; value in vault

CREATE TABLE public.cc_webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  received_at     timestamptz NOT NULL DEFAULT now(),
  event_kind      text NOT NULL,                  -- 'snapshot_push' | ...
  signature_ok    boolean NOT NULL,
  nonce           text,                           -- replay defense; unique per app over a window
  payload_digest  text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('accepted','rejected_signature','rejected_replay','rejected_schema','error')),
  detail          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cc_webhook_deliveries_nonce_key
  ON public.cc_webhook_deliveries (app_id, nonce) WHERE nonce IS NOT NULL;
CREATE INDEX cc_webhook_deliveries_app_idx ON public.cc_webhook_deliveries (app_id, received_at DESC);

ALTER TABLE public.cc_webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY cc_webhook_deliveries_service_all ON public.cc_webhook_deliveries
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY cc_webhook_deliveries_auth_read ON public.cc_webhook_deliveries
  FOR SELECT TO authenticated USING (true);

COMMIT;
```

### 4.7 Migration 016 — `cc_decision_email_sends` (Phase 5, client decisions)

```sql
-- 016_cc_decision_email_sends.sql
BEGIN;

CREATE TABLE public.cc_decision_email_sends (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  issue_id         uuid NOT NULL REFERENCES public.cc_issues(id)     ON DELETE CASCADE,
  source_ref       text NOT NULL,
  owner_email      text NOT NULL,
  owner_name       text,
  magic_token_hash text NOT NULL,                 -- hash only; the raw token is emailed, never stored
  token_expires_at timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','sent','opened','replied','answer_confirmed','expired','failed')),
  sent_at          timestamptz,
  opened_at        timestamptz,
  replied_at       timestamptz,
  reply_raw        text,                          -- the client's free text — quarantined, never an instruction
  reply_option_id  text,                          -- the extracted enumerated option, pending Brian's confirm
  confirmed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cc_decision_email_sends_issue_idx  ON public.cc_decision_email_sends (issue_id);
CREATE INDEX cc_decision_email_sends_status_idx ON public.cc_decision_email_sends (status, created_at DESC);
CREATE INDEX cc_decision_email_sends_app_idx    ON public.cc_decision_email_sends (app_id, created_at DESC);

CREATE TRIGGER cc_decision_email_sends_touch BEFORE UPDATE ON public.cc_decision_email_sends
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.cc_decision_email_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY cc_decision_email_sends_service_all ON public.cc_decision_email_sends
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY cc_decision_email_sends_auth_read ON public.cc_decision_email_sends
  FOR SELECT TO authenticated USING (true);

COMMIT;
```

### 4.8 The federated contracts

**`cc_export_detail()`** — a new function on **each client app**, sibling to `cc_export_snapshot()`. Where the snapshot returns aggregate counts, this returns the item-level rows a resolution panel or the cockpit needs.

```sql
-- Lives on the CLIENT app's data plane (e.g. QEP migration 6xx).
cc_export_detail(
  p_section text DEFAULT 'all',       -- 'all' | 'decisions' | 'build' | 'blockers' | 'sync' | 'roadmap'
  p_cursor  text DEFAULT NULL
) RETURNS jsonb                       -- { section, contract_version, generated_at, cursor:{next,has_more}, items:[...] }
```

The 4-arg signature in earlier drafts is superseded; `p_limit` is hard-coded server-side (50), and `p_filter` is reserved for future use — out of scope for current cockpit.

`SECURITY DEFINER`; `REVOKE EXECUTE FROM PUBLIC`; `GRANT EXECUTE` only to the per-app scoped read role (§4.9). The client app owns exactly which columns each section exposes — the contract is the *shape*, not table access. Read-on-demand; the Aggregator never calls it, so the home stays cheap. Section payload shapes are specified per panel in §5.

**`cc_apply_*()`** — the write siblings, also on each client app: `cc_apply_decision_answer()`, `cc_apply_task_state()`, `cc_apply_blocker_resolution()`. Each accepts only enumerated/typed arguments, never a repo or free text, and the client app owns exactly what they may mutate.

**Two control-plane proxy edge functions:**

- `cockpit-detail` — the only caller of `cc_export_detail()`. Resolves the per-app key by name, calls the contract, writes a `detail_read` audit row, returns the envelope to the browser. The browser never holds a client key.
- `cockpit-writeback` — the only path for a cockpit/panel write into a client data plane. Binds the client data plane purely from `app_id`; ignores any repo/branch/URL in the payload; calls the matching `cc_apply_*()`; advances the `cc_issues` row; audits; de-dupes on an `idempotency_key`.

### 4.9 The Phase-0 god-credential retirement (Security Track)

On each client data plane, a scoped, **read-only** role replaces the static service-role key the Aggregator holds today:

```sql
-- Lives on the CLIENT app's data plane.
CREATE ROLE command_center NOLOGIN;
GRANT command_center TO authenticator;            -- so PostgREST can assume it
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM command_center;
GRANT EXECUTE ON FUNCTION public.cc_export_snapshot() TO command_center;
GRANT EXECUTE ON FUNCTION public.cc_export_detail(text, text) TO command_center;
-- cc_apply_*() are granted to a separate, narrowly-scoped write role.
```

The Aggregator and the `cockpit-detail` proxy authenticate as `command_center` by presenting a JWT whose `role` claim is `command_center`, signed once with the client app's JWT secret and stored as a control-plane edge-function secret named `CC_KEY_<SHORTCODE>` — which replaces the full-access `SVC_KEY_<SHORTCODE>` the Aggregator holds today. They can call exactly two functions and read nothing else. This is the retirement of the standing god-credential. It is built on the Security Track and requires the Supabase MCP (or Brian) to reach QEP's organization.

### 4.10 New `cc_audit_events` event types

The write path adds: `decision_answered`, `decision_routed`, `decision_reply_received`, `work_order_created`, `work_order_authorized`, `agent_dispatched`, `agent_finished`, `agent_failed`, `agent_run_long`, `verification_passed`, `verification_failed`, `pr_ready`, `pr_merged`, `cost_ceiling_hit`, `runner_offline`, `handoff_created`, `handoff_done`, `detail_read`, `blocker_resolved`, `sync_retry`, `app_updated`. Every one has a plain-language "Lately" line (§5.9).

### 4.11 The browser read path — no database key in the browser

Today the web app reads the control plane directly with the Supabase publishable (anon) key, and migration 005 granted `anon` SELECT to make that work login-free. **Cloudflare Access gates the web app; it does not authenticate the Supabase client.** The anon key sits in the browser bundle, and the Supabase REST endpoint is separate infrastructure that Access does not cover — so revoking the anon grants (migration 010 part b) without a replacement would leave the live home with no data source. This was the largest gap the pre-handoff review found: the plan revoked anonymous read but never said how the browser would then read. It is resolved here.

**The browser ships with no Supabase key at all.** Every Command Center read goes through a thin set of control-plane **read edge functions** — `cc-read-home`, `cc-read-app`, `cc-read-audit`, plus the already-specified `cockpit-detail`. Each one:

- Verifies the **Cloudflare Access assertion JWT** — the `Cf-Access-Jwt-Assertion` header Cloudflare injects on every request that cleared Access — against the Access application's public keys. Only a request that passed Brian's SSO reaches data.
- Queries the control plane with `service_role`, server-side.
- Returns exactly the shape the calling screen needs — no over-fetch, no raw table access from the browser.

The write path already works this way (`cockpit-writeback`, the RPCs). With reads behind the same boundary the result is: **no `anon` grant on any table; the Supabase REST endpoint is never reachable from a browser; Cloudflare Access is the one and only identity gate.** This read API is built in **F1** and is the hard prerequisite for migration 010 part (b). It is the read counterpart of the federated boundary — and it means the web app's data layer is rebuilt in F1 to call functions rather than the Supabase client directly (the router rework in F1 already touches this layer).

---

## 5. The screens — fully specified

Every surface below is built against real data from the day it ships. Where a surface depends on a later-phase table, it ships its full frame, filters, and empty states now, with an **honest interim state** that does useful work and names the phase its data arrives. No screen, ever again, says "soon."

Foundational prerequisites for all of §5, done first in Phase 1: **add `react-router`** (the app has no router today — every screen and every slide-over below needs a URL), and **add a mobile bottom tab bar** (the rail currently just `display:none`s on mobile, stranding the operator on the home).

### 5.1 The home (`/`)

**Purpose.** Triage across every app — "what needs me, ranked" — and the entry to every resolution. It stays a single vertical scroll.

**Layout, top to bottom:**

- **The triage barometer** — replaces today's six vanity counts. Six tappable cells, each filters the triage band: `Needs you` · `Critical` (red) · `Decisions open` · `Blocked` · `Awaiting review` (PRs; Phase 4) · `Oldest` (age of the oldest unresolved issue — the one honest "how far behind am I" number).
- **Band 1 — "What needs you."** The triage queue, now reading **`cc_issues` rows** (real identity), not a per-render derivation. Each row: rank, app badge, the issue title, a **lifecycle chip** in plain words (§5.2.1), a severity accent, and a **status-aware action button**. The button is the entry to a resolution slide-over. Crucially, the row shows in-flight state on the home itself — a decision already answered reads `Build queued`; one mid-build reads `Agent building`.
- **Band 1.5 — "Ready to review"** — the PR-triage band. Appears in Phase 4; hidden (not stubbed) until then. Verified PRs, ranked by impact, each with a verification summary rich enough to merge a trivial PR from the phone.
- **Band 2 — Projects.** The app grid. A card per registered app; tap → the cockpit `/apps/:code`. Cards carry the four states: `live`, `not-reporting`, `stale` (desaturated), `paused/provisioning`.
- **Band 3 — "Lately."** The activity feed, rewritten (§5.9).

**Data.** `v_command_center_home`, `cc_issues` (open, all apps), `cc_audit_events` (filtered, for Lately). Phase 4 adds `agent_work_orders` where `status='verified'` for Band 1.5.

**The triage row's status-aware action button:**

| `cc_issues.status` | Button | Opens |
|---|---|---|
| `surfaced` / `triaging` | **Answer / Review** (by type) | the matching resolution slide-over |
| `gated` (AUTHORIZE order awaiting your OK) | **Authorize build** | one-press authorize, from the home |
| `building` | **Watch it build** | the slide-over, live run strip |
| `pr_open` | **Review PR** | the Review-PR slide-over |

**Acceptance criteria.** Triage rows bind to `cc_issues` and show the lifecycle chip; the barometer cells filter Band 1; an answered issue visibly changes state on the home without a reload; the project card "Open" navigates to `/apps/:code` (no longer a dead external link); every band degrades independently.

### 5.2 The resolution slide-overs

The heart of the loop. One frame component, five bodies. A right-side panel (480px desktop) / full-height bottom sheet (mobile), over a dimmed home that never unmounts. URL-addressable (`/?issue=:id`) so a Telegram link opens the exact panel. Header + context bar render **instantly** from the `cc_issues` row already in memory; the item body streams from `cc_export_detail()` via the `cockpit-detail` proxy.

#### 5.2.1 The lifecycle chip — plain words, shared everywhere

| `cc_issue_status` | Chip | Color |
|---|---|---|
| `surfaced` | Needs you | amber |
| `triaging` | Looking into it | amber |
| `answered` | Answered | blue |
| `work_order_created` | Build queued | blue |
| `gated` | Waiting on your OK | amber |
| `dispatched` | Dispatched | blue |
| `building` | Agent building | blue (pulse) |
| `pr_open` | PR ready | green |
| `done` | Done | green |
| `routed_to_client` | With {owner} | grey |
| `dismissed` | Dismissed | grey |

#### 5.2.2 Panel — Open Decisions (`open_decision`)

The highest-value panel. Body: a list of `DecisionCard`s, oldest first. Each expands to show context, an **enumerated `OptionPicker`** (radio — the only input that drives the build), a one-line **rationale** field (provenance only), and a risk badge (`AUTO — dispatches on answer` / `AUTHORIZE — waits for your press`). A client-owned decision shows **Route to {owner}** instead of a picker.

`cc_export_detail('decisions')` item shape: `{decision_id, title, context, owner_kind, owner_name, owner_email, options:[{option_id, label, implication}], risk_class, affected_area, blocks_task_ids[], age_days}`.

On **Answer**: write `cc_decision_answers`; advance the issue `triaging → answered → work_order_created`; compose the `agent_work_orders` row (server-bound repo, enumerated `change_spec`, re-derived `risk_class`, `idempotency_key`); write the `cc_operator_handoffs` row. AUTO → dispatch-eligible immediately; AUTHORIZE → the issue moves to `gated` and the card collapses to a one-press **Authorize this build**. A genuinely hard change offers a third path — **Compose by hand** — which renders the brief, copies it to the clipboard, and creates a `compose_by_hand` handoff pointing at RepoPrompt.

**Acceptance:** opening never leaves the home; operator decisions get an enumerated picker, client decisions get Route; one `cc_decision_answers` and one `agent_work_orders` row per answer; `change_spec` carries no free text; `target_repo` equals the registry value; answering twice never double-dispatches (idempotency key); a routed decision leaves the home queue.

#### 5.2.3 Panel — View Build (`build_health`)

Observational with run-control. Body: why the build is not green (enumerated reasons), stuck items, and a live tail of recent `agent_runs` with a heartbeat ("12 min in, normal is 8"). Actions: **Re-run the build check**, **Retry last run** (only if the latest run failed), **Cancel** (only while one runs), and the one sanctioned outbound link — **Open the repo** — for a genuine CI investigation. The issue auto-resolves when a later snapshot is green.

#### 5.2.4 Panel — Review Blockers (`blocked_item`)

Body: blocked items **grouped by reason** — *awaiting a decision*, *missing input*, *behind another task*, *blocked externally*. A banner when any are decision-blocked: *"{K} of these clear the moment you answer the open decisions."* Missing-input cards offer a **typed/enumerated** `SupplyInputForm` (never a free-text instruction box); awaiting-decision cards offer **Link to a decision** and a jump straight to the Open Decisions panel. Supplying a value composes a work order; supplying a credential/asset is recorded as a manual resolution with no work order.

#### 5.2.5 Panel — Check Sync (`sync_error`)

Body: sync errors grouped by kind (`auth`, `rate_limit`, `mapping`, `conflict`, `unknown`), each with the right action — `auth` errors offer **Escalate**, not a bare retry; rate-limit/mapping offer **Retry**. A buildable fix escalates into a work order; a credential rotation produces a `manual_step` handoff. The issue auto-resolves at the next clean snapshot.

#### 5.2.6 Panel — Review PR (Phase 4)

Body: the diff summary, the verification-gate result (typecheck/build/tests/acceptance/blast-radius, each ticked or flagged), the work order's provenance (which decision, which answer). Actions: **Merge** (the one permanent human gate) and **Send back to the agent** — made one tap, so the cheap action is cheaper than the expensive one.

#### 5.2.7 Cross-cutting panel states

Loading: header instant, body skeleton. Error: the body shows the proxy error, the header still shows the aggregate truth. Empty: the condition cleared between render and open — a positive empty state. Stale: if `last_seen_at` is older than ~12 minutes, an amber "data may be stale — recheck" tag. Mid-workflow: a re-opened panel honestly reflects `answered` / `building` / `pr_open` — never misleading.

### 5.3 The per-app cockpit (`/apps/:shortCode`)

**Purpose.** Everything about one app, and the place to act on it without opening Linear. The home's grammar one level deeper. Interactive. Mobile-first single scroll.

**Linear is not replaced.** Linear remains the system of record for the QEP build — its planning, its workflow, its source of truth. The cockpit is a *read-reflective mirror* of Linear plus a place to take Command Center actions. It removes the need to open Linear for the daily look; it does not take over what Linear does. If the cockpit and Linear ever disagree, Linear wins. The one write the cockpit makes to task state (Section C below) flows *into* the truth Linear owns — Linear mirrors it — and is never a competing record.

**Six stacked sections, instant-truth first:**

- **A — Health header.** Renders instantly from the snapshot already in memory (no network wait). App identity, a vitals strip (build / progress / open decisions / blocked / sync), and the honest freshness line (`live / lagging / stale / silent`) with a Refresh.
- **B — Decision queue.** This app's open decisions, each answerable inline — the same flow as the Open Decisions slide-over, embedded. The cockpit's center of gravity.
- **C — Roadmap board.** Streams A–F → Waves → tasks, from `cc_export_detail('roadmap')`, cursored. Read-reflective of Linear. Filter chips (All / In progress / Blocked / Pending decision / Shipped). A `pending_decision` task cross-links to its decision card in Section B.
- **D — Sync detail.** Mirror health, the error list, **Retry** / **Retry all**.
- **E — Integrations.** This app's `registry_app_integrations` with status pills — secret *references* as labels, never values.
- **F — App activity.** "Lately" scoped to this `app_id`; every cockpit write Brian makes appears here.

**The five interactive actions and their classes:**

| Action | Work order? | Touches client DB? | Class |
|---|---|---|---|
| Answer an operator decision | Yes | Yes (via `cockpit-writeback`) | AUTO **or** AUTHORIZE by lane |
| Change a task's state | No | Yes (via proxy) | AUTHORIZE (one-press confirm) |
| Dispatch a work order | dispatches existing | No | AUTHORIZE (one press) |
| Retry a sync | No | Yes (via proxy) | AUTO |
| Supply blocker input | No (unless → decision) | Yes (via proxy) | AUTO |

**Write path, invariant:** browser → control-plane RPC → `cockpit-writeback` proxy → the client app's `cc_apply_*()`. The browser never holds a client key; `app_id` is the only binding; the build target is read from the registry. **Note — task-state change is the highest-risk interactive feature** (two writers to one truth; see §8.6); it is honored because Brian chose it, engineered through the proxy + `cc_apply_task_state()`, always one-press-confirmed, and it lands in a later phase than the read cockpit.

**Degradation:** with QEP's database unreachable, the header (snapshot-backed), integrations (registry-backed), and activity (control-plane) still render fully; only B/C/D show an "app unreachable" notice. The cockpit never goes blank.

**Acceptance:** `/apps/QEP` resolves and the home's "Open QEP" navigates there; the header paints before any detail call returns; decisions are answerable; every detail call routes through `cockpit-detail` and writes a `detail_read` audit row; the page uses only the home's design primitives.

### 5.4 The Apps page (`/apps`)

**Purpose.** The registry made operable. Buildable fully now. The app grid; each card opens a **detail slide-over** exposing the full registry record (Supabase / Linear / repo / owners / integrations) with **secret references shown as labels only**; edit app basics; and a **"Register an app"** form that inserts the registry rows and rejects any field that looks like a raw key. Writes `app_provisioned` / `app_updated` audit events.

**Acceptance:** every registered app is a card; the detail panel shows all six registry sections; no raw secret value can ever be rendered; "Edit basics" updates only `registry_apps`; "Register an app" inserts a complete record and the card appears without a reload.

### 5.5 The Settings page (`/settings`)

**Purpose.** How the Command Center is wired, and the complete machine record. Buildable fully now. Bands: **Account** (the Cloudflare Access reality — no in-app password); **Aggregator** (schedule, last run, per-app freshness, a manual "Run now"); **Integrations** (cross-app); **Secrets** — the reassurance inventory: every `*_secret_ref` pointer as a read-only chip with a SET/NOT-SET dot, zero inputs, zero buttons — that is the feature; **Audit log** — the full, cryptic, filterable `cc_audit_events` stream, append-only, with an immutability seal and no delete affordance.

### 5.6 The Decisions page (`/decisions`)

**Purpose.** The cross-app decision register — browse and filter every decision blocking a build, by app, by who owes the answer, by age. Answering still happens in the slide-over; this page is the register. Ships now against `cc_issues` aggregate `open_decision` rows (one row per app, age-ranked, with a deep link to that app's decisions); the per-decision layer renders when item-level `cc_issues` rows exist (Phase 2) and routes to client owners by email (Phase 5). The interim state is an honest, working bridge — never "soon."

### 5.7 The Agents page (`/agents`)

**Purpose.** The runner roster and the live run board. Ships now with a real **runner roster** (Claude Code `/goal` — primary, Mac Studio; Cursor — cloud leaf; Codex / Gemini / OpenCode — adapters; RepoPrompt explicitly labeled a compose layer, not a runner) and the (currently empty, honest) dispatch ledger from `cc_audit_events`. The **live run board** — per-run cost, the heartbeat verdict ("40 min in, normal is 8"), the AUTHORIZE one-press approve queue, retry on failure — is designed in full and lights up in Phase 3. It also surfaces the open `cc_operator_handoffs` as a "Waiting on you" list.

### 5.8 Design states — every list, every page

Five states, always: **Skeleton** (never a bare spinner); **Empty** in two flavors — *earned-calm* ("Nothing needs you — every app is green") and *neutral-scaffold* (a not-yet-wired section explaining where the work lives now); **Error** with retry and a mono detail; **Stale banner** atop any view whose snapshot is stale/silent; **Loading-inline** for slide-over content.

### 5.9 "Lately" — the activity rewrite

Band 3 of the home, renamed Activity → **Lately**. It shows **milestones and exceptions only**, in plain human language. Routine green snapshots and secret reads are dropped from Lately entirely — they remain in the Settings audit log. If Lately has a row, something happened a person would want to know.

**The copy deck — every event type, machine form → "Lately" line:**

| Event | "Lately" line | Shown |
|---|---|---|
| `snapshot_captured` green | — | audit log only |
| `snapshot_captured` yellow | "QEP's build needs a look — its last check-in came back yellow." | yes |
| `snapshot_captured` red | "QEP's build is failing — its last check-in came back red." | yes |
| `snapshot_failed` (missing secret) | "Couldn't reach Foundry — its access key isn't set up yet." | yes |
| `snapshot_failed` (unreachable) | "Couldn't reach SCC on the last check — it may be down." | yes |
| `app_provisioned` | "QEP was added to the Command Center." | yes |
| `secret_read` | — | audit log only |
| `decision_answered` (Brian) | "You answered a decision on QEP — a build can move now." | yes |
| `decision_answered` (client) | "Ryan answered a decision on QEP — a build can move now." | yes |
| `decision_routed` | "A decision on SCC was emailed to Rylee to answer." | yes |
| `decision_reply_received` | "Rylee replied to a decision on SCC — it's waiting for you to confirm her answer." | yes |
| `work_order_created` (auto) | "A build task was lined up for QEP — it'll start on its own." | yes |
| `work_order_created` (authorize) | "A build task for QEP is ready — it needs your go-ahead." | yes |
| `agent_dispatched` | "A build started on QEP — Claude Code is on it." | yes |
| `agent_finished` | "The build agent finished on QEP — work is ready." | yes |
| `agent_failed` | "A build on QEP didn't finish — the agent hit an error." | yes |
| `agent_run_long` | "A build on QEP is running long — 40 minutes in, where 8 is normal." | yes |
| `pr_ready` | "A pull request is ready for your review on QEP." | yes |
| `verification_failed` | "A build on QEP came back but didn't pass its checks — it went back to the agent, not to you." | yes |
| `cost_ceiling_hit` | "QEP hit its spending limit for build work — nothing new runs until you raise it." | yes |
| `runner_offline` | "The Mac Studio runner went quiet — builds are paused until it's back." | yes |
| `handoff_created` (manual) | "QEP needs a hand from you — open it for the steps." | yes |

**Copy rules:** one plain sentence; name the consequence, not the mechanism; exceptions and milestones only; failures honest and specific without alarmism; needs-you events carry an accent and an inline action; the system never brags about routine success.

---

## 6. The execution backbone

### 6.1 The thesis

Answering an issue does exactly one structural thing: it writes an `agent_work_orders` row. Everything downstream — dispatch, runner, PR, verification, review — is that row's `status` advancing through the state machine in §4.3. All *policy* (class gating, routing, the repo mutex, retries) lives in the database, where it is auditable and testable. The runner is deliberately dumb: claim the next ready order, execute it, write the result back, loop. No orchestration intelligence in the runner.

### 6.2 The runner daemon on the Mac Studio

A small always-on daemon, isolated from Brian's interactive work:

- Runs under its own macOS user account (`brai-runner`) and `launchd` `LaunchDaemon` — up whenever the machine is, restarts on crash, survives reboot.
- Loop: claim one `ready` work order with the atomic `FOR UPDATE SKIP LOCKED` query (§4.3, ordered by `registry_apps.criticality DESC, created_at` — criticality scheduling is in from the start, not deferred); take the per-app repo mutex (enforced by the partial unique index); mint a short-lived (~1h) repo-scoped GitHub App token; clone the server-bound repo into a throwaway workspace under `/Users/brai-runner/runs/<work_order_id>/`; run Claude Code `/goal` with the `change_spec` as the brief; push a branch; open a PR; write `agent_runs` (cost, duration, outcome); destroy the workspace.
- One order, one clean clone, no cross-contamination. A corrupted workspace is discarded, never the source of truth.
- Heartbeat: the daemon writes a liveness row every minute. If it stops, leases expire and orders auto-reclaim; a missed heartbeat raises a `runner_offline` event.
- Lease sweeper: a control-plane `pg_cron` minute-job reclaims any work order whose `lease_expires_at` has passed while still in `claimed`, `building`, `pr_open`, or `verifying` — covering both a crashed runner and a hung verification — incrementing `attempts` and returning it to `ready`, or to `dead_letter` past `max_attempts`. This is what guarantees no order is ever stuck holding the per-app repo mutex.

**Hard ceilings on every run:** a `cost_cap_usd` (in the work order) **and** a wall-clock cap. Exceeding either auto-kills the run — the "40 min in, normal is 8" heartbeat is allowed to *act*, not just display. A global **kill switch** in Settings pauses all dispatch.

### 6.3 The four-verb adapter contract

Every runner — `/goal`, Cursor, and later Codex / Gemini / OpenCode — sits behind one contract: `dispatch(work_order) → run_id`, `poll(run_id) → status`, `cancel(run_id)`, `capabilities() → {kinds, concurrency, host}`. Adding a runner is writing one adapter; the queue never changes. **Routing** is a data rule, not code: a single-file/copy change → Cursor (cloud, never occupies the Mac Studio); a multi-step build → `/goal`; research with no code output → the Anthropic API writing findings back. RepoPrompt is not a runner — it is Brian's hand-composition layer, reached via a `compose_by_hand` handoff.

### 6.4 Dispatch, authorization, and the one press

A `composed` work order is classified. AUTO → `ready`. AUTHORIZE → `pending_authorization`; the only authenticated write to `agent_work_orders` is the RPC `cc_authorize_work_order(p_work_order_id)` — Brian's one press. It is `SECURITY DEFINER` (so it can advance a row the `authenticated` role may only read), validates the order is in `pending_authorization`, flips it to `ready`, and writes a `work_order_authorized` audit row. The runner does the rest.

### 6.5 Webhooks — both directions

- **Inbound (Phase 1):** each client app fires an HMAC-signed `snapshot_push` to a control-plane `snapshot-ingest` function when its state changes (debounced). The function verifies the signature against the per-app `ingest_secret_ref`, checks a timestamp + nonce against replay, accepts only a snapshot for the `app_id` in the path, logs to `cc_webhook_deliveries`, and reconciles. The 5-minute poll stays as the safety-net heartbeat.
- **Pickup:** the runner daemon claims work by polling the `ready` queue every few seconds — simple, crash-safe, no webhook needed for the inner loop. (A Postgres `LISTEN/NOTIFY` on insert is an optional latency optimization, never the correctness path.)

### 6.6 The verification gate

Runs between the agent's PR and Brian: typecheck, build, the test suite, the **acceptance criteria** carried in the `change_spec`, and a **blast-radius check** — a PR touching far more than a "leaf" work order should is auto-sent-back, not surfaced. A failure routes the PR back to the agent (a new attempt, up to `max_attempts`, then `dead_letter` — and a dead-letter becomes a CRITICAL triage item, never a silent loss). A pass moves the order to `verified` and into the PR-triage band. Per §3.2 the gate ships in advisory mode first and earns each work-class its hands-off status by measured agreement with Brian.

### 6.7 Back-pressure — the WIP limit

Per-app, a cap on concurrent un-merged PRs (default 3). At the cap, newly answered decisions still compose work orders but they hold in `gated` — dispatch is back-pressured by Brian's review throughput, not just by cost. This is the structural defense against the PR firehose (§8.1).

---

## 7. The design system

The existing dark, dense, instrument-grade language in `web/src` is good. The job is to codify and extend it, not redesign it.

**Tokens.** Lock the `:root` palette: surfaces `--bg #0A0C12` / `--panel #0F121B` / `--card #161A26` / `--card-2 #1B2030`; text ramp `--text #E7E9F0` / `--text-2 #9099AD` / `--text-3 #5C6478`; brand `--accent #7C6FF0`. Fix the duplicated `--red`. Move the per-app badge colors out of `lib.ts` into CSS tokens.

**One severity color language, used identically everywhere.** Green is the only "good." **Blue is never "good"** — it means informational / in-progress / watch. Red is always broken-or-now. Amber is always needs-a-human. The DB enum `cc_issue_severity` has four values; the UI shows three tiers — collapse it explicitly: `critical → CRITICAL (red)`, `high → NEEDS YOU (amber)`, `normal + low → WATCH (blue)`. Build health (green/yellow/red/grey) and freshness (live/lagging/stale/silent) are **separate signals** and the UI may never merge them.

**Typography.** The system font stack stays. Codify the scale: Display 20/700, Title 15/700, Body 14/400-600, Body-sm 13, Meta 12, Micro 11, Label 10-11/700 uppercase, Mono for IDs/diffs/secret-refs. Live-changing numbers use `tabular-nums`.

**Component library** — documented primitives so six apps' worth of screens stay consistent: `Shell` (+ mobile bottom tab bar, + notification bell), `Band`, `Strip`/`Cell`, `AppCard` (4 states), `TriageRow`, `PRRow`, `RunRow`, `FeedRow`, `DecisionRow`, the **`SlideOver`** (the most important new component — build once, five bodies), `Button` (primary/secondary/ghost/danger), `RadioOption` (the enumerated-answer selector, 44px target), `SecretRefChip` (display-only, by construction), `Badge`/`SeverityTag`/`StatusPill`/`Chip`, `HealthDot`/`FreshnessDot` (with a `silent` slashed variant), `ProgressBar`, and the five state components.

**Mobile.** Single-column scroll; rail → bottom tab bar; slide-overs → bottom sheets with a sticky action footer above the thumb; 44px targets; the "answer a decision" flow must complete one-thumb on a 380px viewport.

**Honesty, enforced in the system.** A `silent` app desaturates and its health dot goes grey-slashed — a build agent cannot render green-when-silent. There is no input control anywhere that accepts a repo or branch — they are display-only labels from `registry_app_repo`.

---

## 8. The risks — the skeptic's pass, with mitigations

Each risk below is carried into the plan with a named mitigation; the roadmap (§9) sequences the mitigations.

**8.1 — The PR-review bottleneck (CRITICAL).** "Self-driving" moves the bottleneck from answering decisions to reviewing PRs, and a PR review is heavier and cannot be done from a phone the way a decision can. Mitigation, all in the plan: the verification gate does real work including a blast-radius check (§6.6); a per-app WIP limit back-pressures dispatch (§6.7); the PR-triage band carries a verification summary rich enough to merge trivial PRs without opening GitHub; "send back" is one tap; and autonomy is earned per class by evidence (§3.2).

**8.2 — The standing god-credential / public exposure (CRITICAL).** The Aggregator holds full-access service-role keys; migrations 005/007 made the registry, audit log, and issue ledger anon-readable. Mitigation: the Security Track — Cloudflare Access in front before any public deploy (a guessable URL is a public URL), the scoped read-only `command_center` role (§4.9), the control-plane read API so the browser carries no database key (§4.11), and migration 010 revoking every anon grant. No new table ever gets an anon grant.

**8.3 — Dispatch races and the runaway run (HIGH).** Mitigation: the per-app repo mutex as a database constraint (§4.3); hard cost *and* wall-clock ceilings that auto-kill (§6.2); fresh throwaway clones; visible dead-letter as a CRITICAL issue; a global kill switch.

**8.4 — Single-host contention at six apps (HIGH).** Mitigation: leaf work is routed to Cursor and never occupies the Mac Studio; criticality-aware queue ordering is in from Phase 3, not deferred to Phase 6; the Agents page shows queue depth and wait time; a documented Cursor-only degraded mode if the host dies.

**8.5 — Stale data shown as live (HIGH).** Mitigation: freshness is per-app, never global; the global pill shows the *oldest* app's freshness; the 4-state model is distinct from build health; a `silent` app emits a CRITICAL issue and cannot show green.

**8.6 — The interactive cockpit as a sync hazard (HIGH).** Brian chose an interactive cockpit including task-state changes; the skeptic's caution is two writers to one truth (the cockpit and Linear) across a 5-minute snapshot lag. Mitigation: task-state writes go through `cockpit-writeback` → `cc_apply_task_state()` (the client app owns what may change), are always one-press-confirmed, write *to* the client data plane which Linear then mirrors (one direction of truth), show the change optimistically, and reconcile on the next snapshot. It is engineered as specified and flagged the highest-risk interactive feature; it lands in a later phase than the read cockpit so the pattern is proven on lower-risk writes first.

**8.7 — Webhook spoofing (HIGH).** Mitigation: HMAC per-app secrets, timestamp + nonce replay defense, strict `app_id`-in-path binding, schema rejection of any identity/target field, every delivery logged to `cc_webhook_deliveries`.

**8.8 — Notification overload (MEDIUM).** Mitigation: severity-gated and digested — CRITICAL pushes immediately, NEEDS-YOU batches into a digest, WATCH lives in-app only; quiet-hours suppression.

**8.9 — The operator-handoff / slide-over getting ignored (MEDIUM).** If resolving in the Command Center is slower than the app Brian already uses, he reverts and the Command Center decays to a status board. Mitigation: the slide-over must be strictly faster for the common case (open, see options, tap, done — no page load) and carry enough context to decide without "checking the real app first"; instrument adoption and treat decisions-answered-elsewhere as a product failure to surface.

**8.10 — The biggest conceptual risk.** The engine gets built, works mechanically, but the verification gate is not trustworthy — so Brian reviews every PR fully and the Command Center reproduces today's throughput with more moving parts. Mitigation is the sequencing discipline of §3.2 and §9: the gate ships before auto-dispatch, runs advisory, and each work-class earns hands-off status by evidence. If the gate cannot be made trustworthy, the honest outcome is a superb one-press operator console — still a real, valuable product. The failure is pretending the loop is closed when the gate is theater.

---

## 9. The phased roadmap — two parallel tracks

No calendar estimates. Two tracks run at once (Brian's locked decision): the **Security Track** closes the Phase-0 exposures; the **Functionality Track** builds the loop. The Functionality Track does not wait on the Security Track *except* at one hard gate: **nothing is deployed to any public URL until S1 is done.** Local development proceeds freely.

### Security Track

**S1 — Close the exposure.** Cloudflare Access in front of the deployed app (Brian: create the Access app + Google policy; Claude: DNS + `netlify.toml`). The control-plane read API (§4.11) is built so the browser holds no database key; migration 010 then revokes every `anon` grant. *Exit:* the deployed app is not publicly readable; the Supabase REST endpoint is not browser-reachable; no table is anon-readable.

**S2 — Retire the god-credential.** The scoped read-only `command_center` role on each client data plane (§4.9); the Aggregator and `cockpit-detail` proxy re-pointed to it; `SVC_KEY_*` retired. Requires the Supabase MCP pointed at QEP's org, or Brian applying the QEP-side migration. *Exit:* no process holds a full-access client key.

**S3 — Webhook hardening + the GitHub App.** HMAC ingest (migration 015, the `snapshot-ingest` function); the BlackRock AI GitHub App with per-repo short-lived tokens, retiring any personal token. *Exit:* inbound webhooks are signed and replay-proof; repo access is short-lived and per-repo.

### Functionality Track

**F1 — The board comes alive, honestly.** React-router; the mobile bottom tab bar; migration 010 (`cc_issues` grain). The triage band rebinds to `cc_issues` with the lifecycle chip and status-aware actions. The triage barometer. Per-app freshness (live/lagging/stale/silent). Activity → "Lately" with the copy deck. The **Apps** and **Settings** pages — fully real. Supabase Realtime on the snapshot and issue tables so the home updates itself with no manual refresh (webhook push-ingest from client apps is part of S3's webhook work — migration 015). *Exit:* the home is live and honest; two nav pages are real; "Lately" reads like a person wrote it.

**F2 — See an issue, answer an issue.** The `cc_export_detail()` contract on QEP; the `cockpit-detail` proxy. Item-level `cc_issues` rows; the aggregate→item rollup rule. The four resolution slide-overs — answering recorded into `cc_decision_answers` (migration 011). The interactive per-app cockpit (read sections live; decision-answering live; the `cockpit-writeback` proxy + `cc_apply_*()` for retry-sync and supply-input). The **Decisions** page's real layer. *Exit:* every triage action opens a real resolution panel; "Open QEP" opens a full cockpit; decisions are answered in the Command Center.

**F3 — The write spine.** Migrations 012–014 — `agent_work_orders`, `agent_runs`, `cc_operator_handoffs`. The runner daemon on the Mac Studio; the `/goal` adapter; the four-verb contract; criticality-ordered claiming; cost + wall-clock ceilings; the kill switch. The operator-handoff feature end to end. The **Agents** page, live. Telegram notifications, severity-gated. *Exit:* a work order can be handed to the queue, an agent builds it, a PR comes back, and Brian finds out on his phone — with an exact handoff for anything manual.

**F4 — Close the loop.** Decision answered → work order → **class-gated dispatch** (AUTO auto-dispatches; AUTHORIZE one-press). The verification gate — advisory first (§3.2). The PR-triage band on the home; the Review-PR slide-over. The Cursor adapter; the routing policy live. The per-app WIP limit. Task-state change from the cockpit (the §8.6 feature, engineered as specified). *Exit:* the self-driving loop runs end to end; the verification gate is measured; the riskiest work still pauses for one press.

**F5 — Client decisions.** Migration 016 — `cc_decision_email_sends`. The branded decision email, Resend transport, the magic-link confirm page, inbound free-text reply → extraction → **Brian's confirm queue** (never auto-applied). The **Decisions** page, fully live. *Exit:* a client decision goes out clean, the owner answers, the answer lands structured and confirmed, the build unblocks.

**F6 — Scale and resilience.** Earned-autonomy promotion of work-classes by gate evidence; a rollback runbook for every merged change; the operator-availability / quiet-hours model; a second runner host; onboard app #2 (SCC) to prove plug-and-play. *Exit:* the system runs multiple apps without Brian refereeing it, and a wrong change has a clean way back.

### Sequencing rule

S1 gates public deploy and nothing else. S2 is needed before F3's runner reads client repos at scale but does not block F1–F2. F2 depends on F1 (the router, the rebind). F3 depends on F2 (work orders are composed by answers). F4 depends on F3. The verification gate (F4) ships and runs *before* any work-class goes hands-off — that is the §3.2 discipline and it is non-negotiable.

---

## 10. Decisions still needed from Brian

1. **Cloudflare Access hostname (S1).** The deployed hostname to put behind Access — needed to wire DNS and `netlify.toml`.
2. **QEP-org Supabase access (S2).** Reconnect the Supabase MCP to QEP's organization, or apply the QEP-side `command_center` role migration yourself — needed to retire the god-credential.
3. **The GitHub App (S3).** Confirm creating the BlackRock AI GitHub App for per-repo short-lived tokens.
4. **Resend + a sending domain (F5).** For the client decision emails.
5. **The verification-gate threshold (F4).** What agreement rate, over what sample, earns a work-class its hands-off status — a number you are comfortable with.
6. **WIP limit (F4).** Confirm the default cap of 3 concurrent un-merged PRs per app, or set your own.

Everything else in this document is specified and ready to build. On your word, F1 and the Security Track's S1 start together.

**End of master plan.**


