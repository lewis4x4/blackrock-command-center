# BlackRock AI Command Center — Project Instructions
# BlackRock AI internal platform | Last updated: 2026-05-20
# Paste this into the new project's custom instructions.

---

## WHAT THIS PROJECT IS

The **BlackRock AI Command Center** — the operator console Brian Lewis uses to run every client app BlackRock AI builds. It is BlackRock AI's own platform, **not a client deliverable**.

The goal is a **self-driving operating system**: Brian sees an issue, answers it, and it gets resolved in the background by AI agents — decision captured, work dispatched, a pull request comes back. It is explicitly **not** a status board. What exists today is the read-only first half; the roadmap below builds the rest.

The client apps the Command Center runs: **QEP** (live, app #1 — a heavy-equipment dealership platform), then SCC, Circle of Life, Foundry, and two more.

---

## WHO YOU'RE WORKING WITH

**Brian Lewis ("Speedy")** — solo operator of BlackRock AI, an AI development agency. He is the only user of the Command Center. He is the orchestrator; AI agents do the building.

Working style: direct, no filler, no recaps or "here's what I did." Lead with the answer. Production-ready outputs, complete code, exact paths and commands — never pseudocode or concepts. When you hand Brian a step to do himself, keep it short and plain — a command or a name/value pair, not a paragraph. **Never use week/calendar estimates** — phases and modules only. All user-facing copy must sound like a person wrote it.

Build the way this project always has: stage changes as files, apply them, verify them. Migrations get written to `supabase/migrations/`, applied via the Supabase MCP, and verified with a query. Code gets built and the build checked before it's called done.

---

## CURRENT STATE (2026-05-20)

**Built and live:**
- Control-plane Supabase project (the registry, snapshots, audit log) — migrations 001–005 applied.
- The Aggregator edge function + an hourly `pg_cron` job — polls each app's `cc_export_snapshot()` and writes snapshots.
- The operator web app (`web/`) — Vite + React + TypeScript, three-band home (triage / projects / activity). Runs in demo mode offline; live mode reads the control plane. No login (anon read — see hard truth #1).
- QEP registered as app #1; its `cc_export_snapshot()` contract is live (QEP migration 608).

**Designed but NOT built:** the entire write path — the issue ledger, the work-order queue, the runner engine, the per-app cockpit, the four nav pages, the email decision engine. The triage action buttons and "Open QEP" are dead stubs.

**Pending:** three Phase-0 decisions from Brian (see PENDING DECISIONS). Phase 0 has not started.

The live plan is `docs/COMMAND_CENTER_OS_ROADMAP.md` — read it first, every session.

---

## ARCHITECTURE — federated

One shared **control plane** (a Supabase project) holds the app registry, aggregated progress snapshots, and an audit log — **no client business data, ever**. Each **client app keeps its own isolated Supabase project** (its data plane). The control plane never live-joins a client database — it polls a standard read contract (`cc_export_snapshot()`) and receives pushes. One breach must never become six.

---

## KEY FACTS

| Thing | Value |
|---|---|
| Control-plane Supabase | project ref `gsvhuzpysxaegoecwjmf`, org `xeouznaipzbzqwacerjf` |
| Control-plane URL | `https://gsvhuzpysxaegoecwjmf.supabase.co` |
| Publishable key (frontend — non-secret) | `sb_publishable_NUCBIao37hJ_ynvlez9BWQ_noaCVkyz` |
| Repo | `~/Projects/blackrock-command-center` · GitHub `lewis4x4/blackrock-command-center` |
| Web app | repo `web/` — `cd web && npm install && npm run dev -- --port 4000` |
| Migrations applied | 001–005 on the control plane |
| Aggregator | edge function `aggregator` + cron `cc-aggregator-hourly` |
| App #1 — QEP | data plane `iciddijgonywtxoelous` (a **different** Supabase org); contract migration 608 applied on QEP |
| Supabase MCP scoping | the MCP is single-org — the control plane and QEP are in different orgs; you can only reach one org per MCP connection |
| Secrets | never in tables — only `*_secret_ref` pointers; raw keys live in edge-function secrets / Supabase Vault |

Brian's tool stack (all subscribed): Claude Code (`/goal`), Cursor, OpenCode, Codex, RepoPrompt, Gemini, Anthropic API, Supabase, Netlify, Cloudflare, Linear, Notion, Telegram.

---

## THE ROADMAP — phases 0–6

Full detail in `docs/COMMAND_CENTER_OS_ROADMAP.md`. Security first; agent dispatch comes late and gated.

- **Phase 0 — Honest foundation:** close the anon-read exposure, lock the audit log append-only, retire the standing god-credential, build the `cc_issues` identity layer, Aggregator cron → every 5 min.
- **Phase 1 — The board comes alive:** push-ingest + Supabase Realtime, honest staleness, "Activity" → "Lately" with human copy, the Apps + Settings nav pages.
- **Phase 2 — See an issue, answer an issue:** the triage resolution panels, operator decision answering, the per-app cockpit ("Open QEP").
- **Phase 3 — The write spine:** the `agent_work_orders` queue, the runner daemon + Claude Code `/goal` adapter, observability + Telegram, the Agents page.
- **Phase 4 — Closing the loop:** decision → work order → policy-gated dispatch, the verification gate, the PR-triage band, the Cursor adapter.
- **Phase 5 — Client decisions:** the email decision engine, the Decisions page.
- **Phase 6 — Scale & resilience:** criticality scheduling, rollback, operator-hours mode, onboard app #2.

---

## THREE HARD TRUTHS (a 6-agent panel surfaced these — keep them front of mind)

1. **The control plane is currently a back door.** The Aggregator holds every client's full-access service-role key as plain env vars, and migration 005 made the registry + audit log anonymously readable to anyone with the URL. Phase 0 fixes this. Do not deploy publicly until it is fixed (host-level gate, e.g. Cloudflare Access — not necessarily an in-app login).
2. **The self-driving half is unbuilt.** The UI is dressed for a backend that does not exist. The queue, runners, and issue ledger must be built before any triage button can do real work.
3. **Naive "fully automatic" makes Brian a PR-review bottleneck.** See the autonomy model.

---

## THE AUTONOMY MODEL

Answering a decision always auto-creates a work order. Whether it auto-**dispatches** is gated by class: **AUTO-class, reversible, single-surface work under the cost ceiling dispatches automatically**; **AUTHORIZE-class / money-touching / schema-destructive / production work creates the order and waits for one press from Brian.** A verification gate (CI + acceptance check) runs between the agent's PR and Brian. A PR-triage band ranks the review queue.

---

## EXECUTION STACK (the recommended runner architecture)

Primary runner: **Claude Code `/goal` on a dedicated always-on Mac mini** (the proven autonomous pattern). Second runner: **Cursor background agents** for cloud leaf tasks. Repo access: a BlackRock AI **GitHub App** with per-repo short-lived tokens. RepoPrompt stays Brian's hand-composition layer — not a dispatch runner. Codex / Gemini / OpenCode are later adapters behind a four-verb contract.

---

## NON-NEGOTIABLES

- The federated boundary holds: control plane holds no client data, never live-joins a client DB.
- **The PR merge is never automated.** Neither is AUTHORIZE-class / destructive / production dispatch, nor the confirm step on a client's free-text reply.
- Customer input can never reach an agent as instructions; the build target is bound server-side from the registry.
- No standing god-credential. Secrets are `*_secret_ref` pointers; raw keys in vault / edge-function secrets only.
- RLS on every user-facing table. `uuid` PKs; `created_at` / `updated_at` / `deleted_at`.
- Migrations: `NNN_snake_case_name.sql`, no gaps, applied via the Supabase MCP and verified.

---

## REPO LAYOUT

```
blackrock-command-center/
  README.md  netlify.toml
  docs/        ← roadmaps + design (start here)
    COMMAND_CENTER_OS_ROADMAP.md           ← the live plan
    BLACKROCK_COMMAND_CENTER_PLATFORM_ROADMAP.md
    COMMAND_CENTER_HOME_UI_HANDOFF.md
    PROJECT_INSTRUCTIONS.md                ← this file
    prototypes/                            ← superseded HTML prototypes
  supabase/migrations/   001–005
  supabase/functions/aggregator/
  scripts/aggregator-once.mjs
  web/                   ← the operator app
```

---

## PENDING DECISIONS (the three gate Phase 0)

1. **Autonomy reframe** — accept "automatic for reversible leaf work, one-press for the risky 20%"? (Panel strongly recommends yes.)
2. **Deployment gate** — Cloudflare Access in front of the deployed app, or keep it local-only for now?
3. **The Mac mini** — approve the runner host (the engine cannot be cloud-only).

Also open: confirm the GitHub App; Resend + sending domains (Phase 5); RepoPrompt confirmed as compose layer, not runner.

---

## HOW TO RESUME

Each session: read `docs/COMMAND_CENTER_OS_ROADMAP.md`, confirm which phase is current, and continue from there. Until Brian answers the three Phase-0 decisions, the next move is Phase 0. Build staged → applied → verified, and continue into the next roadmap item without waiting for a prompt unless blocked by a real external dependency or an irreversible decision.
