# Runner Host Setup Handoff

Scope: daemon contract only. This slice ships the control-plane queue, ledger, and RPCs. It does **not** ship runner daemon code, host provisioning, secrets, config files, or launchd units.

## Runner contract

Every runner adapter implements the same four verbs:

1. `dispatch(work_order) -> run_id`
   - Accepts one claimed `agent_work_orders` row.
   - Starts exactly one isolated run.
2. `poll(run_id) -> status`
   - Returns `running`, `succeeded`, `failed`, `timed_out`, or `cancelled` plus heartbeat/cost/PR metadata when available.
3. `cancel(run_id)`
   - Stops the active process, releases local resources, and records failure/cancellation back to the control plane.
4. `capabilities() -> { kinds, concurrency, host }`
   - Declares what the adapter can run, its concurrency, and the host identity.

Primary adapter: `claude_code_goal` on the Mac Studio. Later adapters (`cursor_bg`, `codex`, `gemini`, `opencode`) use the same contract.

RepoPrompt remains Brian's hand-composition layer, not a headless runner.

## Control-plane RPC loop

The daemon uses the control-plane Supabase service-role key. This is server-to-server inside the Command Center control plane, because the daemon writes `agent_work_orders` and `agent_runs`. It is not a browser/client scoped-role call.

Loop:

1. Claim work:
   ```sql
   select * from public.cc_claim_work_order('mac-studio-01', 600);
   ```
   - Returns one work order or `null`.
   - The RPC enforces the per-app repo mutex. The daemon does not need app-level locking logic.
2. Mint a GitHub App installation token:
   - Use `registry_app_repo.github_install_id` for the claimed `app_id`.
   - Token scope: one repo only.
   - TTL: roughly 1 hour.
   - Never persist, log, or store the token in a table.
3. Fresh clone:
   - Clone `work_order.target_repo` at `work_order.target_branch` into a new throwaway workspace.
   - Example workspace shape: `/Users/brai-runner/runs/<work_order_id>/repo`.
   - Never reuse a previous worktree.
4. Create an `agent_runs` row with `status='running'`, `runner='claude_code_goal'`, and `work_order_id`.
5. Run Claude Code `/goal` with `work_order.change_spec` rendered as the brief.
   - The brief is structured intent only: `intent`, `affected_area`, `acceptance_criteria`, `constraints`, and safe provenance.
   - Do not add customer free text as instructions.
   - Respect `cost_cap_usd`; stop the run before exceeding it.
6. Heartbeat while running:
   ```sql
   select * from public.cc_renew_lease('<work_order_id>', 'mac-studio-01', 600);
   ```
   - Renew before expiry, normally once per minute.
   - Update the matching `agent_runs.heartbeat_at` and any known usage/cost.
7. Push branch and open PR.
   - The runner pushes only a branch and opens a PR.
   - The runner never merges.
8. Complete the work order:
   ```sql
   select * from public.cc_complete_work_order('<work_order_id>', 'https://github.com/org/repo/pull/123');
   ```
   - This moves the queue row to `pr_open` and writes the `pr_opened` audit event.
9. Finish the ledger row:
   - Set `agent_runs.status='succeeded'`, `finished_at=now()`, `cost_usd`, `tokens_input`, `tokens_output`, `pr_url`, and notes.
10. Destroy the workspace.

Failure path:

```sql
select * from public.cc_fail_work_order('<work_order_id>', 'mac-studio-01', '<short error>');
```

- The RPC writes `work_order_failed` while attempts remain.
- Once `attempt_count >= max_attempts`, it writes `work_order_dead_lettered` and sets `dead_lettered_at`.
- The runner also finishes the `agent_runs` row as `failed`, `timed_out`, or `cancelled` with notes.

Lease recovery:

- `cc_reclaim_expired_leases()` is scheduled every minute by pg_cron.
- If the daemon crashes or misses heartbeats, active rows with expired leases reset to `queued` and emit `work_order_lease_expired`.
- The next daemon loop can claim them again.

## Per-app repo mutex

`cc_claim_work_order()` refuses to claim an order when the same `app_id` already has an order in `claimed`, `dispatched`, or `building`.

A partial unique index backs this up at the table level. The daemon should not implement its own per-app lock; doing so would create split-brain logic.

## GitHub App permissions

Use the BlackRock AI GitHub App, not a personal access token.

Guidance:

- Installation token per repo, minted per run.
- Approximate TTL: 1 hour.
- Never persisted in the database, filesystem, logs, or crash dumps.
- Minimum repo permissions for this slice:
  - Contents: read/write, to clone and push a branch.
  - Pull requests: read/write, to open the PR.
  - Metadata: read.
- Add checks/status permissions only when the verification gate slice needs them.

## Host requirements

- Dedicated M-series Mac Studio, 32GB+ RAM.
- One always-on daemon process under a runner-specific macOS user.
- Bun runtime, matching the project core stack.
- Claude Code authenticated for the runner user.
- Fresh clone per work order; no shared working copy.
- Sandboxed local run directory with cleanup after success/failure.
- One active local `/goal` run by default unless `capabilities()` later advertises safe concurrency.

## Security boundaries

- The work order stores a control-plane `target_repo` reference and structured `change_spec`; it must not store client business data.
- The build target is server-bound from `registry_app_repo`, not from producer payloads or agent output.
- GitHub credentials are short-lived per-repo installation tokens.
- The daemon uses the control-plane service-role key only because it is a server-side control-plane writer.
- No standing repo-wide personal token.
- PR-only: the daemon never merges and never deploys production directly.

## Out of scope for this slice

- Writing daemon code.
- Creating the GitHub App.
- Provisioning the Mac Studio host.
- Adding runner env/config files or secrets.
- Running Claude Code `/goal` from this repo.
- Building the verification gate or PR-triage UI.

Operator-blocked prerequisites for the daemon slice:

1. GitHub App created and installed on target repos.
2. Mac Studio runner host provisioned.
3. Control-plane service-role key made available to the daemon through the operator-approved secret channel.
4. Claude Code authenticated for the runner macOS user.
