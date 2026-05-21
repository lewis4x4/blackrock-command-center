# BlackRock AI Command Center — Platform Roadmap

**Compiled:** 2026-05-19
**Method:** 6 architect agents — Platform/Multi-Tenancy, Email Engine, Agent Orchestration, Command Center UI, Integrations, Security — each designed one subsystem. This document synthesizes all six.
**Scope:** This is the **platform roadmap**. It is deliberately SEPARATE from the per-app build roadmaps (QEP's Streams A–G, SCC's, Circle of Life's, etc.). The per-app roadmaps say *what to build for each client*. This roadmap says *what to build so all of it can be run from one place*.

---

## 1. What this is

Brian is building roughly six client apps in parallel — QEP, SCC, Circle of Life, Foundry, and more. Today each is its own island: its own Supabase, its own repo, its own Linear team, its own roadmap, run by hand. There is no single place to see them, no shared machinery, and every new app means re-doing the plumbing.

The **Command Center** is the factory. Build the factory, then every client app runs through it: decisions captured, agents dispatched, progress aggregated, all from one home. The roadmap-Linear sync, the Decision Inbox, and Build Room are not separate projects — they are *modules* of this platform, and this document is the order they get built in.

The honest framing Brian asked for: **build Phase 0 and Phase 1 before continuing net-new app feature work.** That is the secure foundation plus the see-all-projects home. Everything after that can overlap with resumed app building, because from Phase 2 on the app building itself flows *through* the Command Center.

---

## 2. The architecture — federated, decided unanimously

Two of the six agents (Platform, Security) were asked the multi-tenancy question independently. Both returned the same answer, decisively:

**Federated. A control plane, plus one isolated data plane per client. Never a shared multi-tenant database.**

- **The Control Plane** is its own Supabase project. It holds the app registry, aggregated progress snapshots, the agent work queue, the secrets vault, and Brian's Command Center auth. It holds **no client business data**.
- **Each client app keeps its own Supabase project** — its data plane. QEP stays at `iciddijgonywtxoelous`. SCC stays where it is. They never share a row, a role, or an RLS boundary.
- **Aggregation is pull-and-snapshot, never live cross-database joins.** A scheduled Aggregator calls a standard read contract (`cc_export_snapshot()`) on each client app and writes the result into the control plane. The home dashboard reads only control-plane tables — fast, decoupled, and an offline client app degrades to "stale snapshot," not "dashboard down."

Why federated won, in one line each:
- **Blast radius** — an RLS mistake (and the QEP panel already found one) stays inside one client instead of leaking across six.
- **Plug-and-play** — every client app already *has* its own Supabase; onboarding is "register what exists," not "migrate into a shared DB."
- **Insurability** — "one breach ≠ six breaches" is a material cyber-insurance asset.

The cost — per-project migrations, six sets of keys, no cross-client SQL JOIN — is real and acceptable. The Command Center never needs a cross-client JOIN; it needs an aggregated operator view, which the control plane provides.

---

## 3. The six subsystems

| Subsystem | Owns | Core decision |
|---|---|---|
| **Platform / Multi-Tenancy** | The control plane, the app registry, plug-and-play onboarding | Federated; the sync package becomes a shared library + one shared webhook service |
| **Agent Orchestration** | The work queue, the runner abstraction, dispatch | One queue, six interchangeable runners behind a 4-verb adapter, two human gates |
| **Email Engine** | Decision-email generation, send, tracking, inbound reply parsing | Resend transport; magic-link confirm-page primary; free-text replies AI-parsed then Brian-confirmed |
| **Integrations** | The connector model, Telegram, Google Workspace | Platform-level vs app-level connectors; one auth broker; Telegram as a command surface |
| **Command Center UI** | Brian's cross-project home and per-app cockpits | 3-band home — queue first, project grid, ambient last; never a vanity dashboard |
| **Security** | Tenant isolation, secrets, auth, the agent-dispatch boundary | Separate projects; no standing god-credential; three-plane auth; customer input never becomes agent instructions |

These are not six separate products. They are six layers of one platform, and Section 5 sequences them.

---

## 4. The non-negotiables (Security — must be true before a second client is onboarded)

1. **Separate Supabase project per client.** No shared multi-tenant DB, ever.
2. **No standing god-credential.** Per-client scoped DB roles + short-TTL tokens from a KMS-backed secrets manager. No service-role key in env, repo, or frontend.
3. **MFA-enforced, three-plane auth.** Control plane, per-client owners, and machine identities never share a credential pool. A client owner has no network path to the control plane.
4. **Customer input cannot reach the agent as instructions, and cannot choose the build target.** Enumerated answers only; human-gated dispatch; the target repo is server-bound from the decision's client; the agent runs sandboxed, single-repo, PR-only.
5. **Database-enforced decision integrity.** The migration-595 trigger must verify actor identity, decision lane, and `requires_two_sigs` before it promotes anything.

---

## 5. The phased platform roadmap

No calendar estimates — phases and exit criteria only. QEP is the proving ground throughout; it is wired first because its data and roadmap already exist.

### Phase 0 — Secure foundation *(the gate — do this before continuing app building)*

The hard gate. Nothing customer-facing or multi-client happens until this is green.

- Stand up the **Control Plane Supabase project** — its own Vault, MFA-enforced auth, the `platform_admin` role.
- Decide and stand up the **secrets manager** (Supabase Vault for the control plane's own project; an external KMS-backed store — Doppler / 1Password / AWS Secrets Manager — for client credentials).
- Create the **BlackRock AI GitHub App** with per-repository installation tokens. Stop using a personal PAT.
- Define the **per-client scoped `command_center` DB role** pattern — the control plane uses *that*, never raw service-role.
- Write **QEP migration 599** — the Build Room Wave 1 security fix: the `build_room_customer` role, kill the `USING(true)` reads, fix the migration-595 trigger (actor + lane + two-sig), the `submit_build_room_answer()` write-RPC with actor/IP capture. **This migration doubles as the canonical per-client security template** every future client inherits.
- Stand up the **append-only audit log** in the control plane (every secret retrieval, every dispatch).

**Exit:** the control plane exists, MFA-locked; QEP's RLS is fixed and is the template; no god-credentials anywhere.

### Phase 1 — The registry + the all-projects home *(do this before continuing app building)*

This delivers the moonshot's first visible promise — *see every project in one place*.

- Build the **app registry** schema: `registry_apps`, `registry_app_supabase`, `registry_app_linear`, `registry_app_repo`, `registry_app_owners`, `registry_app_integrations`, `registry_app_snapshots`.
- Manually register QEP (its details are known). Add placeholder rows for SCC, Circle of Life, Foundry, +2.
- Write the **`cc_export_snapshot()`** read contract; apply it to QEP's Supabase by hand.
- Build the **Aggregator** edge function + cron — polls registered apps, writes `registry_app_snapshots`.
- Build the **Command Center home, first cut**: Band 1 (the cross-app "what needs you" queue) + Band 2 (the project grid). QEP shows real data; the others show "not yet connected" placeholder cards. Mobile-first single scroll.

**Exit:** Brian opens one screen and sees all six projects, with QEP fully live. The thing he said he struggles with — "what I'm building" — is solved at a glance.

### Phase 2 — Shared sync library + shared webhook service + the queue

Stop the fork-per-project model before it becomes six copies to maintain.

- Refactor `roadmap-linear-sync` from forked-per-project into a **shared library** (`@blackrock/roadmap-sync`), driven by one `app.config.json` per app. Status-vocabulary differences (QEP's 7 states vs SCC's 5) become config, not code forks.
- Stand up **one shared reverse-sync webhook receiver** in the control plane — tenant ID in the path (`/linear-webhook/{app_id}`) — carrying the reliability layer: idempotency ledger, HMAC verification, the queue.
- Build the **`agent_work_orders` queue**: `app_id` scoped, idempotency keys, atomic claim (`FOR UPDATE SKIP LOCKED`), lease + visibility timeout, dead-letter, max-attempts, per-`(app_id, runner)` concurrency caps.
- Generalize the **`qep_build_status` derived health view** — green/yellow/red from real signal, so a stuck loop renders yellow, never silent green.

**Exit:** one sync codebase for all apps; one reliable queue; the autonomous loop has a trustworthy spine.

### Phase 3 — The unified runner orchestration

Make "dispatch a build to the right AI tool" a single backend.

- Build the **runner abstraction** — a 4-verb adapter contract (`dispatch / poll / cancel / capabilities`) and the `runners` capability table.
- Ship **two adapters first**: Claude Code `/goal` (the proven workhorse — needs an always-on host) and Cursor background agents (cloud-native, for leaf tasks). Codex, Gemini, RepoPrompt, OpenCode are later adapters — zero queue rework.
- Build the **routing policy** (capability rule v1: leaf→Cursor/Codex, multi-step→Claude Code, research→Gemini, whole-wave→RepoPrompt fan-out).
- Wire the **two human gates**: dispatch approval (with a policy cost-ceiling for auto-approving cheap AUTO-class tasks) and PR merge (never auto-merge).
- Build the **`agent_runs` cost/usage ledger** — per-app, per-runner spend; cost-per-shipped-PR.

**Exit:** Brian approves a dispatch, an agent builds, a PR comes back — reliably, for any app, routed to the right tool.

> **Phases 0–3 are the factory.** From here, app feature-building resumes — but it now flows through the Command Center.

### Phase 4 — The email decision engine

The crown jewel from the panel — frictionless decision capture.

- `decision_email_sends` table + the email-state model (queued → sent → delivered → opened → clicked → replied → answered, plus reminded/bounced/expired).
- The **MJML→HTML 5-slot card template**, per-client theming from a `client_apps` config row.
- **Resend** as the multi-client transport (one verified sending domain per client app); M365 send-as kept as a per-client fallback.
- The **generation pipeline**: decision row → rendered email, with Brian's mandatory inline-edit gate (optional for AUTO/RATIFY, mandatory for AUTHORIZE).
- **Magic-link confirm-page pattern** — the link click only renders an authenticated confirm page; the explicit button press writes. A scanner pre-clicking the link cannot resolve a decision.
- **Inbound reply parsing** — ingest, quote/signature strip with a library-grade parser, LLM structured extraction against the decision's option set, then **always** Brian's confirm queue. Free-text replies are treated as the majority path, not a fallback.
- The **decision-email tracking dashboard** + lane-aware reminders + a "nudge now" button.
- **Schema change** — conditional-answer support on the decisions table ("yes, but only for new customers" is often a new sub-decision, not an option).

**Exit:** a decision goes out as a clean email, the owner answers, the answer lands structured and Brian-confirmed, the build unblocks.

### Phase 5 — The integrations layer

The connective tissue, plug-and-play.

- The **connector model**: `platform_connectors` + `app_connectors`, a type registry, fail-closed scope resolution (platform-level vs app-level, never bleeding).
- The **auth broker** — OAuth2, API-key, and inbound-webhook patterns, built once.
- The **health-check scheduler** — a degraded connector renders yellow, never silent green.
- **First three connectors, all platform-level**: Linear (adopt the existing sync into the model as the reference), Telegram (Brian's phone command surface — notifications + inline-button actions feeding the same queue), Google Sheets (a live roadmap mirror).
- NotebookLM is **dropped** as a wired connector (no real write API) — it stays a manual tool.

**Exit:** adding a connector for a new app is a config step; Brian can act from Telegram.

### Phase 6 — The Command Center home, complete

- Band 3 (ambient activity), the cross-app **decision dashboard**, and **cockpit drill-down** per app.
- The **`command_center_actions`** table — the cross-app "what needs me" queue, fully wired and severity-ranked.
- The **single-app cockpit** — the internal Build Room generalized: streams/waves tree, live build feed, blockers, decisions. Live data is welcome here; it is Brian's screen.

**Exit:** the full operator experience — home, drill-down, decisions — across all wired apps.

### Phase 7 — Prove plug-and-play: onboard app #2

- Build the **automated provisioner** — a registration form + a provisioner edge function that validates credentials, applies the standard contract migration to the new client's Supabase, runs the Linear bootstrap, and flips the app to `active`.
- Onboard **SCC** end-to-end through the provisioner. Measure: how many manual steps remained.
- Then Circle of Life, Foundry, and the rest.

**Exit:** adding a client app is a form plus a provisioner run — under ~10 minutes of Brian's time, one un-automatable residual (creating the Linear workspace/key).

### Phase 8 — The thin Client Window *(customer-facing — last, on purpose)*

- Per client, **hard-pinned to one client project** at build time, configurable by no one.
- Runs on the constrained `build_room_customer` role + `SECURITY DEFINER` views — allow-listed columns only.
- Shipped-this-week with proof-of-use, calm on-budget/on-date status (Brian-authored), 2-week look-ahead, the "we trust you — just build it" delegation toggle.
- Read-only. No live bar, no agent feed, no moving deadline. Toggled on per-engagement at Brian's discretion.

**Exit:** a client like QEP gets the calm, retrospective window — only after the platform underneath it is proven.

---

## 6. What stays human-gated forever

Regardless of how good the platform gets:

- **PR merge.** Agents open PRs; Brian merges.
- **Agent dispatch** for anything AUTHORIZE-class, money-touching, schema-destructive, or production.
- **The confirm step** on every free-text decision reply.
- **AUTHORIZE-lane decisions.** No silence-resolution, no agent resolution, ever.
- **What renders as "Shipped"** to a customer — only on a human-confirmed merge.

---

## 7. Decisions Brian must make

There are 18 of them across the six designs. Fittingly, these should run through the Decision Inbox once it exists — but for the platform itself, here is the list, grouped:

**Architecture & money**
1. Confirm the federated model (separate Supabase per client) over consolidation.
2. Authorize the one-time shared-library refactor of the sync package.
3. Budget for six+ separate Supabase projects + a secrets manager (external KMS is a line item).
4. Per-app cost ceilings for agent dispatch, and the cost ceiling below which AUTO-class dispatch auto-approves.

**Security & legal**
5. Authorize creating a BlackRock AI GitHub App; stop using the personal PAT.
6. Are contractors in scope as control-plane principals? (If yes, time-boxed per-client access changes the role model.)
7. Pull "signed PDF / legal weight" language from all client-facing materials until the audit controls ship.
8. Decide whether a real e-signature vendor (DocuSign-class) handles AUTHORIZE decisions — building legally-defensible signing in-house is not advised.
9. Engage a cyber-insurance broker early — the per-client isolation story is an underwriting asset.

**Email**
10. Confirm Resend as the multi-client transport; secure six verified sending domains with DNS access.
11. Approve the conditional-answer schema change on the decisions table.
12. Confirm Brian personally is the confirm gate for every free-text reply at launch.

**Agents & tooling**
13. Confirm API access for Codex, Gemini, Cursor background agents, RepoPrompt, OpenCode.
14. Decide on an always-on host for the local-runner (Claude Code / OpenCode) daemon.

**Integrations**
15. Create the Telegram bot (BotFather) and confirm Brian's single allowlisted chat ID.
16. Authorize a Google Workspace OAuth app (Sheets + Gmail + Docs scopes).
17. Confirm NotebookLM is dropped as a wired connector.

**UI**
18. Provide the canonical list of the six apps + repo/data locations + a per-app criticality weight (which project outranks which when the queue is contested).

---

## 8. How Brian's work changes once this exists

| Today | With the Command Center |
|---|---|
| Six apps, six mental contexts, no single view | One home — every project, what's blocked, what needs him |
| Plumbing re-done by hand per app | A registration form + a provisioner — onboarding in minutes |
| Decisions chased over email and calls | Decision emails out, answers parsed and confirmed, builds auto-unblock |
| "Which AI tool do I use for this?" | One queue routes to the right runner; Brian approves dispatch |
| Status lives in Brian's head | Aggregated, honest, glanceable — and a calm window for each client |
| Brian is the bottleneck and the courier | Brian is the operator — he reads the board, approves, merges |

---

## 9. The immediate ask

Brian asked for the roadmap he can execute "right now, before continuing app building." That is **Phase 0 and Phase 1** — the secure foundation and the see-all-projects home. Concretely, the first move is:

1. Answer decisions 1, 3, 5 from Section 7 (federated model, budget, GitHub App) — these gate everything.
2. Stand up the Control Plane Supabase project.
3. Write QEP migration 599 (the security template).
4. Build the registry + the all-projects home, QEP wired.

On Brian's word, migration 599 and the control-plane schema get written next — the same way the QEP roadmap sync and the Decision Inbox were built: staged as files, applied, verified.

---

**End of platform roadmap.** Companions: the six architect reports inform every section; `QEP_BUILD_ROOM_RUN_ROADMAP.md` is the QEP-app-level corrected design that this platform generalizes.
