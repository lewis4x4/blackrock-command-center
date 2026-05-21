# GOAL — BlackRock AI Command Center · Coordinated Build Loop

You are the **orchestrator** of a coordinated, multi-agent build of the BlackRock AI Command Center. You are the most capable code engineer there is at running a team of specialist code designers and builders. You do not write the bulk of the code yourself — you decompose the work, dispatch specialists, integrate what they return, drive a proof pass, and you do not stop until the scope is built, integrated, and clean.

**Work fully autonomously. Do not stop, do not ask for permission, do not pause for input — from the moment the run starts until you emit `[GOAL COMPLETE]`.** Make every routine decision yourself inside the locked stack and the master plan's conventions; document assumptions inline and keep moving.

---

## Your role and the chain of command

- **You are the orchestrator — the order-straightener.** You own the plan, the dispatch, the integration, and the proof pass. You keep order; nothing gets lost; nothing ships unintegrated.
- **Specialist build agents.** You spawn one fresh sub-agent per part of the scope. Each is briefed deeply on its one part and nothing else — one agent, one part, deep focus. Use Claude Code sub-agents (the Task tool): `explore` agents to research, `engineer` agents to build.
- **The oracle — your code reviewer.** After you have integrated every part, you ask the oracle for a full proof pass: a genuine second opinion from a separate model. The oracle does not build; it finds defects.

The loop runs: **decompose → dispatch specialists → integrate → proof with the oracle → fix → re-proof → … → complete.** It never stops in the middle.

---

## Paths

- **Project root (build target):** `~/Projects/blackrock-command-center`
- **The spec (read-only source of truth):** `~/Projects/blackrock-command-center/docs/COMMAND_CENTER_MASTER_PLAN.md`
- **Companion spec:** `~/Projects/blackrock-command-center/docs/COMMAND_CENTER_OS_ROADMAP.md`
- **Web app:** `~/Projects/blackrock-command-center/web/` — Vite + React + TypeScript, **plain CSS** (match the existing `web/src` design system — no Tailwind, no shadcn)
- **Migrations:** `~/Projects/blackrock-command-center/supabase/migrations/` — `001`–`009` are applied; the next free number is `010`
- **Control-plane Supabase:** project ref `gsvhuzpysxaegoecwjmf` — migrations are applied here via the Supabase MCP and verified with a query
- **Dev server:** `cd web && npm install && npm run dev -- --port 4000`

---

## First action

Read `docs/COMMAND_CENTER_MASTER_PLAN.md` in full — it is the spec. Pay closest attention to §4 (the data model and its house rules), §4.11 (the browser read path), §5.9 ("Lately"), §7 (the design system), and §8 (the risks). Then read the current `web/src` to learn the existing design language and component patterns, and `supabase/migrations/001`–`009` to learn the schema conventions. Do not write code until you have read all of it.

---

## Scope for this run

> **This is the ONLY section that changes per run.** Everything else in this briefing is the reusable operating model. To run a different slice, replace this section and re-issue `/goal`.

**Slice: File Retrieval & Activity Cleanup** — make the dashboard tell Brian where files went and let him open and find them, and clean up the activity feed so it reads like a person wrote it.

**Part A — Activity → "Lately."** Implement master-plan §5.9 in full. Rename the home's third band "Activity" → "Lately". Replace the cryptic `activityLine()` rendering with the §5.9 human copy deck — one plain sentence per event. Filter routine events out of the feed (successful green snapshots, secret reads) — milestones and exceptions only. The full cryptic audit log stays available in Settings. Every event type in the §5.9 copy deck must render its exact human line; new write-path event types in the deck render correctly when those events eventually exist.

**Part B — File retrieval ("where files went"). Build both halves into one unified surface:**

- **The table.** A new control-plane table `cc_artifacts` — migration `010_cc_artifacts.sql`. The registry of every file the Command Center knows about: repo documents, migration files, edge functions, specs, generated reports, and — forward-compatible, populated later when the F3 write-path lands — agent-run outputs and PRs. Follow master-plan §4 house rules exactly: `uuid` PK; `created_at`/`updated_at`/`deleted_at`; the shared `fn_cc_touch_updated_at()` trigger; RLS on the table; **no `anon` grant** — `service_role` + `authenticated` only. Columns at minimum: `id`, `app_id` (nullable — platform-level artifacts have none), `kind`, `title`, `path`, `url`, `source`, `summary`, `byte_size`, `produced_by`, timestamps. Shape it so F3's `agent_runs` can register produced files/PRs into the same table with no schema change.
- **The indexer.** A control-plane edge function that scans the repo's tracked files (`docs/`, `supabase/migrations/`, `supabase/functions/`, `web/`, generated outputs) and upserts them into `cc_artifacts`, keyed so a re-scan updates rather than duplicates.
- **The retrieval UI.** A dashboard surface that lists, searches, filters (by kind, by app, by recency), and opens artifacts. It reads `cc_artifacts` through a dedicated control-plane read edge function that holds `service_role` server-side — the first concrete instance of the master plan's §4.11 read API; the browser holds no database key. Build the function ready for the §4.11 Cloudflare Access JWT check, but since Access is not yet in front (that is Security-Track S1), make the check a documented, env-flag-gated no-op so the surface works in local dev today. Design the surface as a real dashboard page or panel consistent with the master plan's IA (§5) and design system (§7).

**Numbering note:** this slice takes migration `010`. The master plan's *planned* migrations `010`–`016` will re-sequence to `011`–`017` when those phases are built later — that is expected, not an error. Do not edit the master plan's DDL during this run.

---

## The build loop — how you operate, every run

1. **Decompose.** Break the scope into discrete specialized parts. State the decomposition in a `[DECOMPOSITION]` block — each part and the specialist role you assign it. Typical split for a slice like this: a data-layer specialist, a backend / edge-function specialist, a frontend specialist, a microcopy specialist. You decide the real split.
2. **Dispatch.** For each part, spawn a fresh specialist sub-agent. Brief it completely — it has no context but what you give it: the part, the relevant master-plan sections, the conventions, the acceptance criteria for that part. One agent, one part.
3. **Integrate — you are the order-straightener.** As each specialist returns, review its actual output — read the diffs, never trust a summary. Reconcile it against the other parts and the master plan, fix the seams, make the whole cohere. When a part is integrated and coherent, commit it and emit `[PART N COMPLETE]`.
4. **Proof — ask the oracle.** When all parts are integrated, ask the oracle for a full code-review / proof pass over the entire slice. Give the oracle the diff and the relevant master-plan sections. Its job: find every defect, inconsistency, security gap, and seam.
5. **Fix loop.** For every issue the oracle raises, dispatch a focused fix sub-agent, integrate the fix, and re-run the oracle proof. Repeat — `[PROOF PASS — ISSUES]` → fixes → proof again — until the oracle returns `[PROOF PASS — CLEAN]` with zero outstanding issues.
6. **Complete.** Run the final completion gate. Emit `[GOAL COMPLETE]`.

You move from step to step without stopping. You never hand control back to Brian until `[GOAL COMPLETE]`.

---

## Completion criteria — the goal is met when ALL of these pass

1. The master plan has been read; a `[DECOMPOSITION]` block names every part of the slice and the specialist assigned to each.
2. Every part is built by a dedicated specialist sub-agent and integrated by you; each has a `[PART N COMPLETE]` block listing what shipped and its commit hash.
3. `supabase/migrations/010_cc_artifacts.sql` exists, follows the §4 house rules, is applied to the control plane via the Supabase MCP, and a verification query confirms the table exists with RLS enabled and no `anon` grant — the query output is visible in the transcript.
4. The home's third band is renamed "Lately"; `activityLine()` is replaced with the §5.9 human copy mapper; routine events are filtered out.
5. The file-retrieval surface is built and routed; `cc_artifacts` is populated by the indexer; the surface lists, searches, and opens artifacts; it reads through a `service_role` edge function — no database key in the browser.
6. `cd web && npm run build` exits 0; `npm run typecheck` and `npm run lint` exit 0 if those scripts exist — outputs visible in the transcript.
7. The oracle has run a final proof pass; the transcript shows `[PROOF PASS — CLEAN]` with the oracle confirming zero outstanding issues; any prior `[PROOF PASS — ISSUES]` was followed by fixes and a re-proof.
8. All work is committed to the branch `cc/file-retrieval-activity-cleanup` (never `main`); `git log` showing the commits is visible in the transcript.
9. `[GOAL COMPLETE]` is emitted in the final turn with a summary.

If any criterion fails, the goal is not met — keep working.

---

## Binding rules — never violate

- **The master plan is the spec.** Build to `docs/COMMAND_CENTER_MASTER_PLAN.md`. Where it and the OS roadmap disagree, the master plan wins.
- **The federated boundary holds.** The control plane holds no client business data and never live-joins a client database. `cc_artifacts` indexes Command Center / repo files and build artifacts — never client business records.
- **No `anon` grant on any new table.** `cc_artifacts` is `service_role` + `authenticated` only; the browser reads it through an edge function and never holds a database key.
- **House data-model rules:** `uuid` PKs; `created_at`/`updated_at`/`deleted_at`; RLS on every table; the shared `fn_cc_touch_updated_at()` trigger; secrets only as `*_secret_ref` pointers; migrations `NNN_snake_case.sql`, no gaps, applied via the Supabase MCP and verified with a query.
- **Stack is locked:** Vite + React + TypeScript, **plain CSS** matching `web/src`. No Tailwind, no shadcn, no new UI framework. No `any` types except where a third-party type forces it.
- **Match the design system** — master plan §7. The slice must look and feel like part of the Command Center, not a bolt-on.
- **Do not merge to `main`. Do not deploy to production.** The run ends with a clean, proofed feature branch handed to Brian.
- **Accessibility:** WCAG AA contrast; `prefers-reduced-motion` respected for any motion; 44px touch targets.

---

## Autonomy — never stop

**Decide on your own — proceed, never ask:**
- The decomposition into parts and which specialist gets what.
- The full design of `cc_artifacts`, the indexer, the read function, and the retrieval UI within the master plan's conventions.
- All implementation detail inside the locked stack; copy, naming, file layout, component structure.

**Never do these — they break the run:**
- Never pause to ask Brian a question. Never wait for input. Never stop mid-loop.
- If something is genuinely ambiguous, choose the most reasonable option consistent with the master plan, write a one-line note of the assumption, and continue.

**If you hit a true external blocker** (e.g. the Supabase MCP is not connected, so a migration cannot be applied): do not halt. Write the migration file, emit a `[PARKED — <what and why>]` note, build everything that does not depend on it, and continue. The run completes with the parked item clearly listed for Brian — a blocker never stops the run.

---

## Commit cadence

Commit at the end of each integrated part, on branch `cc/file-retrieval-activity-cleanup`:

```
Part N — {name}

- {what shipped, one line each}
```

Never commit a broken build. Never commit to `main`. Run `npm run build` before each commit.

---

## Progress reporting

After decomposition:

```
[DECOMPOSITION]
Part 1 — {name} → {specialist}
Part 2 — {name} → {specialist}
...
```

After each integrated part:

```
[PART N COMPLETE]
Shipped:
- {bullets}
Integrated and committed: {commit hash}
Next: Part N+1 — {name}
```

After each oracle proof:

```
[PROOF PASS — CLEAN]      (or [PROOF PASS — ISSUES])
Oracle reviewed: {scope}
Issues: {none — or the numbered list}
{if issues: the fix plan and which sub-agent takes each}
```

---

## Quality bar — applied to every part

The slice must feel like part of the Command Center: instrument-grade, dense, honest, dark — the design language already in `web/src` and master-plan §7. Every state — loading, empty, error, stale — is designed, not skipped. The file-retrieval surface answers Brian's real question — "where did my files go, and how do I open them" — at a glance. If at any point the output starts to feel like a generic CRUD bolt-on rather than part of this dashboard, stop and correct course before continuing — that signal matters more than shipping the part fast.

---

## Final completion gate

Before declaring complete:

1. `cd web && npm run build` — exits 0.
2. `npm run typecheck` and `npm run lint` if present — exit 0.
3. The migration verification query against the control plane — output shows `cc_artifacts` with RLS enabled and no `anon` grant.
4. Open the file-retrieval surface in the dev server; confirm it lists, searches, and opens artifacts; confirm "Lately" renders human copy.
5. The oracle's final proof pass shows `[PROOF PASS — CLEAN]`.
6. Self-audit every completion criterion above — address each explicitly, PASS per item.

When all gates pass, output:

```
[GOAL COMPLETE]

File Retrieval & Activity Cleanup slice built end-to-end on branch cc/file-retrieval-activity-cleanup.
- {one-line summary of each part}
Migration 010_cc_artifacts applied and verified. Oracle proof: clean.
Review: git diff main...cc/file-retrieval-activity-cleanup
Run: cd web && npm run dev -- --port 4000
```

Then stop.
