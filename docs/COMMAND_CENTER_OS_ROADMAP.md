# BlackRock AI Command Center — The Operating System Roadmap

**Compiled:** 2026-05-20
**Method:** 6 specialist agents — Freshness, Resolution Loop, Agent Orchestration, Per-App Cockpit, Information Architecture, and a Systems-Coherence skeptic — each reviewed one aspect; this document synthesizes all six.
**Scope:** This turns the Command Center from a read-only status board into a working operating system: see an issue, answer it, and have it resolved in the background. It supersedes the relevant sections of `BLACKROCK_COMMAND_CENTER_PLATFORM_ROADMAP.md` with a concrete, buildable plan.

---

## 1. What you asked for, and what the panel found underneath it

You flagged five things: the board is 22 minutes stale, the triage action buttons are dead, "Open QEP" is dead, the Activity feed is gibberish, and the four nav pages all say "soon." All five are addressed below. But you also said: *find what I'm not seeing.* The panel found three things that change the order of the work.

**One — the control plane is, right now, a back door into every client's data, and the login removal made it public.** The Aggregator holds every client's full-access Supabase service-role key (`SVC_KEY_QEP`, and one per future app) as plain edge-function environment variables. A service-role key bypasses all row-level security. So a single process can read and write every client database — the exact "one breach = six breaches" outcome the federated architecture was built to prevent. Federation moved the blast radius from the database layer into the Aggregator's environment, and that environment was never re-secured. Then migration 005 — removing the login, as you asked — granted anonymous read on the registry, the snapshot history, the integrations, and the audit log. You were right that an in-app login is friction you don't want. The problem is the fix left **no gate at all**: anyone who finds the deployed URL sees every client name, every project's progress, the integration topology, and the full audit trail of every secret access. This is fixable without putting a login back (see §3 and Phase 0) — but it has to be fixed before this is deployed anywhere public.

**Two — the half of the system that makes it "self-driving" does not exist yet, in any form.** What is built is a *read* path: poll each app, snapshot it, display it. The vision — answer a decision, work dispatches, a PR comes back — needs a *write* path: an issue ledger, a work-order queue, a runner engine, a cost ledger. None of it exists. There is no table, no function, no queue. The current UI even renders event types like "agent dispatched" — the interface is dressed for a system that has no backend. This is not a flaw; it is simply the next, larger half of the build. But it means the triage buttons can't just be "wired up" — there is nothing behind them to wire to yet.

**Three — "fully automatic, I only review the PR" relocates the bottleneck onto you, and makes it worse.** Six apps, decisions answered continuously, every answer auto-dispatching a build, equals a continuous stream of pull requests. A PR review is not a glance — it is reading a diff, understanding intent, confirming nothing else broke. If you are asleep, agents keep building against decisions answered hours ago, and you wake to fifteen PRs across six repos with no triage among them. The Command Center solved "what needs me" for *decisions*; with naive auto-dispatch it has no equivalent for *PRs*. You would have traded chasing decisions for reviewing an unbounded PR firehose alone — higher cognitive load, and not something you can clear from your phone. The fix is not to abandon "automatic." It is to **reframe it** (§3) and to build a PR-triage surface and an automated verification gate *before* the firehose is switched on.

None of this means slow down. It means build in an order where the system is safe and honest at every step. That order is §6.

---

## 2. The shape of the finished system

```
   A client app           THE CONTROL PLANE (Command Center)              A runner
   ───────────            ─────────────────────────────────              ────────
   roadmap / decisions      issue ledger → work-order queue → dispatch  →  Claude Code /goal
   change → push ──────►    (cc_issues)     (agent_work_orders)             (Mac mini host)
                            ▲                          │                   or Cursor (cloud)
   cc_export_snapshot()  ───┘                          │                        │
   cc_export_detail()    ◄── cockpit proxy             ▼                   opens a PR
                                              verification gate  ◄──────────────┘
                                              (CI + acceptance)
                                                       │
                                              PR-triage band → you merge
```

Two unbreakable rules carry through every phase. **The federated boundary:** the control plane never holds client business data and never live-joins a client database — it polls, it receives pushes, and it calls one narrow per-app contract function. **The human gate:** an agent never merges. The PR is the permanent checkpoint. Everything else can be automated; that cannot.

---

## 3. The autonomy model — a reframe the panel recommends

You chose "fully automatic." The panel — unanimously — recommends one adjustment, and it is your call:

> **Answering a decision always auto-creates a work order. Whether that work order auto-*dispatches* is gated by class.**
> - **AUTO-class, reversible, single-surface work, under the app's cost ceiling → dispatches automatically.** No click. This is the 80%. It is genuinely hands-off.
> - **AUTHORIZE-class, money-touching, schema-destructive, or production-affecting work → the work order is created and waits for one press from you.** Not a form, not a meeting — one button.

Why not pure auto-dispatch for everything: a decision answered wrong (or a client's email reply mis-parsed) becomes shipped code with no human in the loop; a mislabeled destructive change auto-runs; two decisions on one app dispatch two agents that collide in the same repo. The class gate costs you one press on the riskiest ~20% and removes the catastrophic failure modes. The "self-driving" feel is fully preserved for the common case.

Paired with two things that make even the automatic 80% safe to watch: a **verification gate** (automated CI + acceptance-criteria check runs *between* the agent opening a PR and it reaching you — a failed check sends it back to the agent, not to you), and a **PR-triage band** on the home so the review queue is ranked by impact, never a flat pile. With those, "fully automatic" is real and it is safe. Without them, it is a liability. Decision #1 in §10 is yours.

---

## 4. The architecture

Four new pieces, built in this dependency order.

**The issue ledger — `cc_issues`.** Today triage items are computed on the fly from snapshot counts every time the screen renders — they have no identity, no memory, no state. You cannot "open," answer, or track something that is recreated every render. The first thing built is identity: every triage condition becomes a persistent row that moves through a lifecycle — `surfaced → triaging → answered → work_order_created → dispatched → building → pr_open → done` (plus `routed_to_client`, `gated`, `dismissed`). The Aggregator reconciles snapshot counts into this ledger on every poll — opening new issues, closing ones whose condition cleared — keyed on a stable `(app_id, issue_type, source_ref)` so it upserts instead of duplicating.

**The work-order queue — `agent_work_orders`.** When an issue reaches `answered`, a work order is composed. It carries exactly, and only: `app_id`; `target_repo` + `target_branch` (read server-side from the registry — never from any answer or email field); a structured `change_spec` (intent, affected area, acceptance criteria, constraints — assembled from *enumerated* answers, never raw customer free text); the answered-decision provenance; a `risk_class`; an `idempotency_key`; a `cost_cap`. The queue supports atomic claim (`FOR UPDATE SKIP LOCKED`), leases with visibility timeout (a crashed runner's order auto-reclaims), dead-letter after max attempts, a **per-`app_id` repo mutex** (never two agents in one repo at once), and an `agent_runs` cost ledger.

**The runner engine.** A daemon claims ready work orders, mints a short-lived repo-scoped GitHub App token, runs the agent against the change spec, pushes a branch, opens a PR, writes cost and outcome back. Detailed in §5.

**The federated detail contract — `cc_export_detail()`.** The cockpit and the resolution panels need item-level data (the actual decisions, the actual blocked tasks) — which lives in each client app's own database. A new contract function on each client app, sibling to `cc_export_snapshot()`, returns one section at a time (`roadmap`, `decisions`, `sync`) with cursoring. It is `SECURITY INVOKER`, `service_role`-execute-only, and the **client app owns what columns it exposes**. The browser never calls it; a control-plane proxy edge function does, resolving the key by name at request time, and writes a `detail_read` audit row every time. Read-on-demand, never snapshotted — so the cockpit is live without making the home expensive.

---

## 5. The execution recommendation

You asked the panel to recommend the runner architecture. Here it is, opinionated.

**Primary runner: Claude Code `/goal` on a dedicated Mac mini.** You already have a *validated* overnight pattern — per-slice extract, verify, push. That is the only runner with proven, repeatable autonomy against your actual repos. Building the engine on an unproven cloud foundation to chase "no host" is a mistake. `/goal`, OpenCode, and Codex are local-process tools — they need a real filesystem, a checked-out repo, a long-lived process, and your CLI auth. There is no managed cloud endpoint for a `/goal` overnight run. So: **get an M-series Mac mini, 32GB+.** It runs one lightweight daemon — claim a work order, clone the server-bound repo into a fresh throwaway workspace, run `/goal` with the change spec as the brief, push, open the PR, destroy the workspace. One order, one clean clone, no cross-contamination. It is cheap, inside your trust boundary, and physically yours. It is the only always-on component, and if it dies, leases expire and orders are safely re-claimed — nothing is lost.

**Second runner: Cursor background agents — the cloud-native escape hatch for leaf tasks.** A single-file fix or a copy change does not need the host; the Cursor adapter calls its API. So the system is *hybrid*: host for multi-step autonomy, cloud for leaf work. It is never fully cloud-native, and pretending otherwise would delay a working engine.

**Drop RepoPrompt as a runner.** RepoPrompt is your interactive multi-model *composition* layer — a human cockpit for authoring hard change specs. Forcing it into a headless dispatch target fights its design. Keep it as the place you compose a difficult work order by hand; the queue then executes what you composed. Codex, Gemini, and OpenCode become later adapters behind the same four-verb contract (`dispatch / poll / cancel / capabilities`) with zero queue rework.

**Routing** is a data table, not code: leaf task → Cursor; multi-step build (a roadmap slice, a migration + function + UI) → Claude Code `/goal`; research with no code output → Gemini or the Anthropic API writing findings back; a whole wave → the queue itself fans out N child orders.

**Repo access:** the BlackRock AI GitHub App, per-repo short-lived installation tokens minted per run, ~1-hour TTL, never persisted, never logged. No personal access token, no org-wide credential. The target repo is bound server-side from the work order — the agent cannot be argued into a different one.

---

## 6. The phased roadmap

No calendar estimates — phases and exit criteria. Each phase ships something you can see. Security and the issue ledger come first because everything stands on them; dispatch comes late and gated, because shipping it before the rails is the one truly dangerous move.

### Phase 0 — Honest foundation

The gate. Nothing else is safe until this is green.

- Close the migration-005 exposure (see §3 / §8 — host-level gate, not necessarily a login).
- Make `cc_audit_events` truly append-only — `REVOKE UPDATE, DELETE`; an audit log a process can rewrite is not an audit log.
- Retire the standing god-credential: replace static `SVC_KEY_*` service-role keys with a per-client scoped, **read-only** `command_center` database role; the snapshot contract runs under that role, not service-role.
- Build `cc_issues` — the identity layer every action depends on.
- Freshness quick win: Aggregator cron hourly → every 5 minutes.

**Exit:** the control plane is not publicly readable; no process holds a god-credential; the audit log is tamper-evident; every triage item is a real, addressable record; the board is at most 5 minutes stale.

### Phase 1 — The board comes alive

- Push ingest: each client app fires an HMAC-signed webhook to a control-plane `snapshot-ingest` function whenever its state changes (debounced); the 5-minute poll stays as the safety-net heartbeat.
- Supabase Realtime on the snapshot and audit tables — the home live-updates with no manual refresh; the "Updated" pill ticks on its own and recolors honestly.
- Honest staleness: a `live / lagging / stale / silent` state, distinct from build health — a dead app stops showing a confident green.
- "Activity" → **"Lately"** — plain-English, milestones-and-exceptions only; the full audit log moves to Settings (§7).
- The **Apps** and **Settings** nav pages — buildable now from registry data (§7).

**Exit:** the board feels live and tells the truth; "Lately" reads like a person wrote it; two of the four nav pages are real.

### Phase 2 — See an issue, answer an issue

- The resolution panels: "Open decisions," "View build," "Review blockers," "Check sync" each open a real slide-over where you *resolve*, not just view (§7).
- Operator decisions answered in the Command Center — enumerated options, a rationale line; the answer is recorded against the issue.
- The per-app cockpit: the `cc_export_detail()` contract + the cockpit proxy + the `/apps/QEP` page — "Open QEP" finally opens (§7).

**Exit:** every triage action does something real; "Open QEP" opens a full cockpit that replaces your need to open Linear; you can answer an operator decision. (Answers are recorded — auto-build arrives in Phase 4.)

### Phase 3 — The write spine

- `agent_work_orders` — the full queue: atomic claim, leases, dead-letter, per-app repo mutex, `agent_runs` cost ledger.
- The runner daemon on the Mac mini; the Claude Code `/goal` adapter; GitHub App scoped tokens.
- Observability: runner heartbeat, live run state, "this run is 40 min in, normal is 8."
- Telegram notifications — agent finished, agent failed, PR ready, cost ceiling hit.
- The **Agents** nav page — now backed by real data.

**Exit:** you can hand the queue a work order, watch an agent build, and get a PR back — and you find out on your phone, not by opening the app.

### Phase 4 — Closing the loop

- Decision answered → work order → **policy-gated dispatch** (auto for AUTO-class reversible work under the cost ceiling; one-press approve otherwise — §3).
- The verification gate: automated CI + acceptance-criteria check between the agent's PR and you.
- The PR-triage band on the home — the review queue, ranked.
- The Cursor background-agent adapter; the routing policy goes live.

**Exit:** the self-driving loop runs end to end — answer a decision, a verified PR comes back ranked for review — and the riskiest 20% still pauses for one press.

### Phase 5 — Client decisions, routed

- The email decision engine: `cc_decision_email_sends`, the branded card, Resend transport, the magic-link confirm page, inbound free-text reply parsing → LLM extraction → **your confirm queue** (never auto-applied).
- The **Decisions** nav page — fully live, cross-app, filterable by app / by who owes the answer / by age.

**Exit:** a client-facing decision goes out as a clean email, the owner answers, the answer lands structured and confirmed by you, the build unblocks.

### Phase 6 — Scale and resilience

- Criticality-aware runner scheduling for multi-app contention.
- A rollback runbook — every merged change has a defined revert path.
- An operator-availability model — no auto-dispatch of non-trivial work outside the hours you set.
- A second runner host; onboard app #2 (SCC) to prove plug-and-play.

**Exit:** the system runs six apps without you refereeing it, and a wrong change has a clean way back.

---

## 7. Every screen

**The home.** Freshness fixed (Phase 0–1). Each triage action opens a **resolution panel** — a slide-over, you never leave the home: *Open decisions* → answer operator decisions inline or route client ones out; *View build* → the health reasons, the stuck items, a live tail of recent runs, retry/cancel; *Review blockers* → the blocked items, supply the missing input or link it to a decision; *Check sync* → the sync errors, retry, escalate-to-fix. A new **PR-triage band** appears once Phase 4 lands — the ranked review queue. Band 3 "Activity" becomes **"Lately."**

**The per-app cockpit** (`/apps/QEP`). The home's grammar, one level deeper: a health header (instant, from the snapshot), then a **roadmap board** — Streams A–F, Waves, tasks — that replaces opening Linear (read-reflective, not a drag board; Linear stays the system of record); the decision queue for that app; sync detail; integrations; per-app activity. Mirrors the dark home design; mobile-first single scroll.

**The four nav pages.** **Apps** and **Settings** ship first — they are buildable now from the registry. **Apps**: every registered app, a detail panel per app (Supabase / Linear / repo / owners / integrations — secret *references* shown as labels, never values), edit basics, and a manual "register a new app" form. **Settings**: integrations, the secret-ref pointers (display-only, reassurance not an editor), account, the Aggregator schedule, and the full audit log. **Decisions** and **Agents** depend on later phases — they ship as honest, *designed* scaffolds: the real page frame, real filters, an empty state that tells you where the work lives right now — never another "coming soon" card.

**Activity → "Lately" — the copy.** Drop the machine words for the words you'd use:

| Event | Today (cryptic) | "Lately" |
|---|---|---|
| snapshot captured, healthy | "QEP — Snapshot captured / build green" | **"QEP checked in — build looking good."** |
| snapshot captured, yellow | "QEP — Snapshot captured / build yellow" | **"QEP checked in — build needs a look."** |
| snapshot failed | "Snapshot failed / secret SVC_KEY_FND not set" | **"Couldn't reach Foundry — its access key isn't set up yet."** |
| app provisioned | "Registered as a Command Center app" | **"QEP added to the Command Center."** |
| agent dispatched | "agent_dispatch / by blewis@" | **"You sent a build task to QEP."** |
| decision answered | — | **"Ryan answered a decision on QEP — a build can move now."** |
| secret read | "Secret retrieved / by aggregator" | *audit log only — never shown in "Lately."* |

"Lately" shows exceptions and milestones — a failed check-in, a new app, an answered decision. Routine successful snapshots and secret reads are audit-log material, not feed material.

---

## 8. Security and the gates that never automate away

The federated non-negotiables, restated and enforced: customer input can never reach an agent as instructions — a client's free-text reply is reduced to an enumerated option ID before it touches a work order; the build target is bound server-side from the registry, never chosen by an answer, an email, or an agent; no standing god-credential; AUTHORIZE-class / money-touching / schema-destructive / production work is dispatch-gated even under "fully automatic."

**The migration-005 fix, without putting a login back.** You were right that an in-app login is friction. The fix is a host-level gate: put the deployed app behind **Cloudflare Access** tied to your Google identity — you sign in once via SSO, no per-visit password, and the registry and audit log stop being public. Until that is in place, run it locally only. This keeps zero friction for you and closes the exposure.

**These five never become automatic, no matter how good the system gets:** the PR merge; dispatch of AUTHORIZE-class or destructive or production work; the confirm step on every free-text client reply; what gets shown to a client as "Shipped"; and any non-trivial dispatch while you are unreachable.

---

## 9. New data model

Control plane: `cc_issues` (the issue ledger + lifecycle), `cc_decision_answers`, `agent_work_orders` (the queue), `agent_runs` (the cost/usage ledger), `cc_decision_email_sends` (Phase 5), plus new registry columns — `detail_contract_version`, `ingest_secret_ref`. Each client app gains one function: `cc_export_detail()`, the item-level read contract. The existing `cc_audit_events` becomes truly append-only and gains the new event types in the "Lately" vocabulary.

---

## 10. Decisions for you

1. **The autonomy reframe (§3)** — accept "automatic for reversible leaf work, one-press for the risky 20%"? The panel strongly recommends yes.
2. **The deployment gate (§8)** — Cloudflare Access in front of the deployed app, or keep it local-only until then?
3. **The Mac mini** — approve the runner host. The engine cannot be cloud-only.
4. **GitHub App** — confirm creating the BlackRock AI GitHub App (per-repo short-lived tokens), retiring any personal token.
5. **Resend + sending domains** (Phase 5) — for the client decision emails.
6. **RepoPrompt** — confirmed as your hand-composition layer, not a dispatch runner. Agree?

---

## 11. The immediate next moves

On your word, Phase 0 is built the way everything else here was — staged as migrations and code, applied, verified: close the 005 exposure, lock the audit log, retire the god-credential, build `cc_issues`, and bump the Aggregator to 5 minutes. That makes the Command Center honest and safe, and gives every triage item the identity the rest of the system is built on.

**End of roadmap.** Companion: `BLACKROCK_COMMAND_CENTER_PLATFORM_ROADMAP.md` (the strategic frame this concretizes).
