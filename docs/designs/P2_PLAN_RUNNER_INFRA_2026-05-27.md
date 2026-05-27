# P2 Plan — Runner + Infra Cleanup (2026-05-27)

**Author:** JARVIS  
**Scope:** Plan-only response to the 4 P2 items from the 2026-05-26 post-build audit. No code or migrations included.  
**Audience:** Sir.

---

## TL;DR

Two of the four items have a real but small "harden the edges" payoff (Telegram retry, orphan workspace sweep). One is a five-line housekeeping decision (migration 044). One is meta-work on the migration convention that is bigger than it looks and probably premature for a single-author repo. I recommend shipping items **1 + 2 together** as a runner patch, deciding **3** in a one-paragraph call (default: commit as-is), and **deferring 4** to a lightweight template rather than a full framework change.

---

## Ground-truth notes (from reading the source)

- **`runner/src/runner.ts:570–590`** — `notifyPrOpened` already `await`s the notifier, swallows the error, logs it, and writes a `telegram_notify_failed` audit event. It is **not** actually fire-and-forget in the strict sense; it is "best-effort, single-attempt, observed." The PR has already been opened and committed by the time this runs.
- **`runner/src/workspace.ts:79–81`** — `RealWorkspaceManager.destroy()` already does `rm(workspace.root, { recursive: true, force: true })`. `runner.ts:484–490` (the `finally` block in `executeWorkOrder`) already calls it on every run, success or failure. The `runner/README.md` confirms: *"each run removes `WORKSPACE_ROOT/<work_order_id>` in `finally`. Leftovers indicate a host/process crash; they can be deleted manually."*  
  → The audit phrasing *"prune branches"* is slightly misframed. With `--depth 1 --branch <target>` and full-tree deletion on `finally`, there are no stray local branches accumulating. The only leak path is a **host crash mid-run** that leaves a `WORKSPACE_ROOT/<work_order_id>` directory behind.
- **`supabase/migrations/044_register_scc_app.sql`** — File is untracked (`git status` confirms). 112 lines. Pure registry-row inserts into the control plane (`registry_apps`, `registry_app_supabase`, `registry_app_repo`, `registry_app_owners`, `cc_audit_events`). All `ON CONFLICT DO NOTHING` / `NOT EXISTS` guarded.
- **Down-migration convention** — 24 of 52 migrations contain a `-- Down migration (commented; copy/paste to revert)` block at the bottom. The remaining 28 (notably 012, 017–022, 024–035, 037–043, 045, 048, 052) do not. The pattern is real but inconsistently applied. Recent migrations 049–051 honor it; 052 does not.

---

## Item 1 — Telegram notify: bounded retry

**Location:** `runner/src/runner.ts`, `notifyPrOpened()` (~lines 570–590).

### Scope
Wrap the existing `deps.telegramNotifier(...)` call in a tiny retry helper:

```
attempt up to 3 times total (1 initial + 2 retries)
backoff: 500ms, then 2000ms (jittered ±20%)
abort retries on 4xx (don't retry bad request / auth failures)
on final failure: existing logger.error + safeAudit path (unchanged)
```

Keep the helper local to this file or move to `audit.ts` as `withBoundedRetry`. No new deps.

### Effort
**Small.** ~25 LOC + 2 unit tests (success-on-retry, exhausted-retries-still-audits).

### Risk
**Low.** Adds at most ~2.5s of latency on the post-success notification path. Cannot break PR open / work-order completion (those already happened upstream). `safeAudit` failure handling unchanged.

### Tradeoffs (case for NOT doing it)
- The current code already records `telegram_notify_failed` to `cc_audit_events`, so a miss is **observable**.
- A missed Telegram ping = Sir doesn't get a notification, but the PR still exists, the work order is still completed, and the audit log shows it. The signal of last resort (the DB) is intact.
- Telegram outages tend to be either transient (sub-second) or long (multi-minute). The 500ms + 2s backoff catches the first bucket; the second bucket isn't fixed by 2 retries either.
- This is genuinely small-payoff work. Maybe the right answer is **leave it alone and add a 4xx-vs-5xx split in the audit detail**, so when it fails we know whether it's worth manual replay.

### Recommendation
**Do it, but minimal.** 2 retries, exponential backoff with jitter, skip retry on 4xx. Keep the audit event. ~30 minutes of work, zero downstream risk.

---

## Item 2 — Workspace cleanup after run

**Location:** `runner/src/workspace.ts` (`RealWorkspaceManager`) + optionally `runner/src/index.ts` (startup sweep) or a cron host.

### What's already in place
- Clone uses `--depth 1 --branch <target_branch>` (single ref, single commit) → no other local branches to prune.
- Per-run cleanup: `executeWorkOrder` `finally` block calls `workspaceManager.destroy()`, which `rm -rf`s the whole `WORKSPACE_ROOT/<work_order_id>` directory.
- **So "prune branches" as framed in the audit is a non-issue.** The real leak is **orphaned workspace directories from host/process crashes** (e.g., daemon SIGKILL, OOM, power loss between `create()` and `finally`).

### Scope
Two complementary mechanisms, pick one:

**Option A — Startup sweep (recommended).**  
On `RunnerDaemon` boot, before entering `runForever()`, scan `WORKSPACE_ROOT/*` and `rm -rf` any subdirectory older than `LEASE_SECONDS * 4` whose name does not match an in-flight work order. Pseudocode:
```
const stale = await listSubdirsOlderThan(workspaceRoot, leaseSeconds * 4_000ms)
const claimedIds = new Set(<no easy way; just trust the time-based filter>)
for (const dir of stale) await rm(dir, { recursive: true, force: true })
log.info("workspace startup sweep", { swept: stale.length })
```

**Option B — Daily cron.**  
A separate `scripts/runner-workspace-sweep.sh` invoked by host cron / systemd timer, same logic. Decouples runner code from disk hygiene.

### Effort
**Small** for either. A is ~20 LOC + 1 test (seed a stale dir, assert it's gone). B is a 15-line shell script.

### Risk
**Low** for A *if* the age threshold is generous (≥ 4× lease). The active-run dir is touched continuously by clone/checkout/push, so atime/mtime stay fresh during the run. Risk: filesystem clocks skewed → mistakenly deletes a live workspace. Mitigation: use mtime of the directory itself, not subfiles, and use `lease_seconds × 4` as the floor.

### Cadence recommendation
**On daemon startup is enough.** The runner is long-lived but restarts on deploys/host reboots. A daily cron is overkill for a single-host runner. Revisit when we move to multi-host.

### Tradeoffs (case for NOT doing it)
- Disk fills *slowly* with `--depth 1` clones. Each work-order workspace is typically <50MB. To fill 100GB you need 2000+ orphans, which requires the daemon to crash mid-run thousands of times — which would have produced bigger alarms first.
- Operationally, `rm -rf /tmp/cc-runner/*` once when an alert fires is also a valid posture.

### Recommendation
**Do Option A.** It's smaller than a cron job, lives next to the code it cleans up, and self-heals on every deploy. Skip Option B unless we go multi-host.

---

## Item 3 — Migration 044 (SCC registration paused)

**Location:** `supabase/migrations/044_register_scc_app.sql` (untracked).

### Current state
- File is on disk, never committed.
- Per the task brief, the SCC registration row **is still in the DB** — i.e., this migration was already applied to the control plane at some point.
- SCC pivot is paused; we don't know if it's coming back.

### Three options (re-stated and evaluated)

| Option | Action | Implication |
|---|---|---|
| **(a) Delete the file** | `rm 044_register_scc_app.sql` | Git history clean. **But the DB row stays, creating a drift between filesystem migrations and applied state.** A fresh clone applying migrations 001→052 will not produce the same DB state as production. Bad. |
| **(b) Fold into greenfield onboarding** | Move 044's INSERTs into the future `04X_register_<greenfield>_app.sql` and templatize the structure | Cleanest end-state, but blocks on greenfield onboarding actually landing. Until then, drift persists. |
| **(c) Commit as-is** | `git add` and push 044 unchanged, optionally renumber to next free slot | Migration history matches DB state. Future readers can see the SCC row was provisioned and is paused. **One-line commit message documents the pause.** |

### Effort
**Trivial** for (a) or (c). **Medium** for (b) (gated on greenfield work).

### Risk
- (a): **Medium** — creates schema drift, which is the exact problem audits look for.
- (b): **Low** — but only viable if greenfield is in the next sprint or two.
- (c): **Very low** — adds a documented paused-state row to git; if SCC is killed for good, a future migration `0XX_decommission_scc_app.sql` cleanly removes both the row and the artifact.

### Tradeoffs (case for NOT doing it)
- The "do nothing" status quo is genuinely fine for ~30 days. The runner doesn't care. The aggregator doesn't poll SCC (no integration row was inserted; comment in the file confirms). Sir is the only person who reads `git status`.

### Recommendation
**Option (c): commit 044 as-is, with a 2-line header comment update marking SCC as paused.** Pseudocode for the new comment block at the top:
```
-- STATUS: PAUSED (2026-05-27). SCC pivot deferred.
-- This migration WAS applied to the control plane. Row remains in
-- registry_apps for auditability. Decommission via follow-up migration
-- if SCC is formally cancelled.
```
This eliminates filesystem-vs-DB drift now, without committing us to either re-launching SCC or building the decommission migration today. Defer the decommission/fold-in decision to whenever Sir makes the SCC-vs-greenfield call.

If Sir believes greenfield is landing within ~14 days, **switch to (b)** instead and treat the SCC INSERTs as the first concrete test of the template.

---

## Item 4 — Down-migration template/convention

**Location:** `supabase/migrations/*.sql` + (proposed) a new template file.

### Current state
- 24 of 52 migrations carry a commented `Down migration` block at the bottom (`-- BEGIN; ... DROP ... -- COMMIT;`).
- 28 do not — including the most recent (`052_audit_database_fixes.sql`) and most of the Phase-4/5 cluster (`017–035`).
- The format isn't a real down-migration — it's a **copy-paste recipe for the operator if a revert is needed.** Which is actually the right shape for Supabase (no automated rollback runner exists in our stack).
- Several files explicitly opt out with a reasoned note (e.g., 046 *"intentionally commented; preserve auditability of production remediation"*, 050 *"enum values cannot be removed safely in-place"*). That opt-out pattern is itself valuable.

### Scope options

**(i) Add a template file + lint, retroactive sweep.**
- New file `supabase/migrations/_TEMPLATE.sql` with the header, BEGIN/COMMIT, and a mandatory `Down migration` block scaffold (either real revert SQL or an explicit `-- No down migration: <reason>` line).
- New script `scripts/check-migration-pattern.mjs` invoked by CI / pre-commit: every `NNN_*.sql` must contain one of:
  - `-- Down migration (commented; copy/paste to revert)`, OR
  - `-- No down migration: <reason>` (free text reason).
- Retroactive backfill of the 28 missing migrations (only the comment/marker, not actual down SQL — most are too risky to script).

**(ii) Template + lint, no retroactive backfill.**
- Same as (i) but skip the sweep. Old migrations stay as-is; only new migrations from `053_*` onward must comply.

**(iii) Separate `down/*.sql` directory.**
- New convention: every `up` migration ships with `down/NNN_*.sql`. Closer to industry tools (dbmate, etc.).
- Heavy: requires a runner to actually execute downs, which we don't have. Probably out of scope until we adopt a migration framework.

### Effort
- (i): **Medium.** Template + lint + reviewing/touching 28 files. Realistically half a day.
- (ii): **Small.** Template + lint only. ~1 hour.
- (iii): **Large.** Convention change + tooling + cultural shift. Multi-day, and only worth it if we hire a second engineer.

### Risk
- (i): **Low-medium.** Retroactive comment additions are non-functional changes, so DB risk is zero. The risk is "spending half a day on docs polish nobody reads."
- (ii): **Very low.** Pure dev-tooling addition.
- (iii): **Medium-high.** Convention churn without tooling adoption tends to half-land and create more confusion than the original drift.

### Tradeoffs (case for NOT doing it)
- The repo has **one author.** Conventions that exist to coordinate across humans are lower-leverage when the human is also the linter.
- The existing 24-of-52 hit rate isn't from a missing template — it's from migrations where the *author judged a down made sense*. The 28 without (cron schedules, RPC drops, enum-only changes) are mostly cases where a textual revert recipe wouldn't be safer than just `git revert` the migration.
- Adding a lint that demands a comment marker invites *meaningless* `-- No down migration: this is hard` lines that satisfy the linter without informing anyone.

### Recommendation
**Option (ii): template only, no enforcement, no backfill.**  
Drop a `_TEMPLATE.sql` at the top of `supabase/migrations/` with the canonical header, BEGIN/COMMIT, and an optional `Down migration` block. Encourage but don't enforce. Revisit enforcement when a second engineer joins or when a real down-migration framework is adopted. The 28 existing files stay untouched.

If Sir disagrees and wants enforcement, escalate to **Option (ii) + a soft CI check** that warns (not blocks) on missing markers in new migrations.

---

## Recommended sequencing

The two runner items are independent of the two infra items. Both batches are independently shippable. Suggested order:

### Batch A — Runner patch (items 1 + 2)
- **Why together:** same repo, same test suite, same deploy. Both are small, low-risk runtime hardening.
- **Order within batch:** Item 2 first (startup sweep — purely additive code path, easy to test), then Item 1 (retry helper).
- **Estimated effort:** 1–2 hours including tests.
- **Risk profile:** Low. Neither changes the work-order success path.

### Batch B — Infra housekeeping (items 3 + 4)
- **Why together:** both touch `supabase/migrations/`; one commit + one PR.
- **Order within batch:** Item 3 first (commit 044 — eliminates the most visible drift), then Item 4 (drop in `_TEMPLATE.sql`).
- **Estimated effort:** 30 minutes if going with my recommendations [(c) + (ii)].
- **Risk profile:** Very low. Both are documentation-shaped changes.

### Cross-batch dependencies
None. Ship A and B in either order, or in parallel branches. They don't share files.

### If forced to pick only one
**Batch A.** The runner is a live production component; small hardening there has real surface-area payoff. Batch B is hygiene that won't bite for weeks.

---

## What I might be wrong about

- **Item 1 may be premature optimization.** The current code already audits failures and the PR already exists by the time the notifier fires. If Telegram delivery has never failed in production telemetry, retries solve a problem that doesn't happen. Honest answer: I'd want to grep `cc_audit_events` for `telegram_notify_failed` over the last 30 days before committing to even a 30-minute fix. If the count is zero, **skip Item 1.**

- **Item 2's framing is slightly off.** The audit said "prune branches"; the actual leak vector is *crashed-run orphan directories*, not git branches. If Sir's intent was specifically "git branches accumulating in clones," the answer is "they don't, because we delete the clone." The orphan sweep is still worth doing, but it's solving a different problem than the audit phrased.

- **Item 3 option (c) is the cowardly choice on purpose.** A more decisive operator would either (a) delete the SCC row and the file together via a new decommission migration *today*, or (b) commit to greenfield onboarding and templatize. Recommending (c) is a hedge against the SCC pivot decision not yet being made. If Sir has already decided SCC is dead, **switch to a `decommission_scc_app.sql` migration** that removes the row and never commit 044.

- **Item 4 may not be worth doing at all in a single-author repo.** The template-only recommendation is small enough that it's hard to argue against, but I'd readily defend "do nothing" as the right answer until a second engineer joins. The convention is documented by example in 24 of 52 files; that's more than enough for the current team size.

- **I assumed the runner is single-host.** If it's already multi-host or about to be, Item 2 should be a cron job (Option B), not a daemon-startup sweep — because a startup sweep on one host shouldn't be deleting workspaces owned by another host. Worth a 30-second sanity check before implementing.
