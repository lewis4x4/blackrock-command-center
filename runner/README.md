# Command Center Runner Daemon

Bun + TypeScript daemon for the Command Center work-order queue. It claims `agent_work_orders`, mints a short-lived GitHub App installation token for the target repo, runs Claude Code `/goal` in a fresh clone, pushes a branch, opens a PR, and writes the `agent_runs` ledger.

The runner never merges PRs and never stores GitHub tokens.

## Prereqs

- M-series Mac Studio, 32GB+ RAM recommended for the always-on host.
- Bun installed.
- Git installed.
- Claude Code CLI installed and authenticated for the runner macOS user.
- BlackRock AI GitHub App installed on target repos with:
  - Contents: read/write
  - Pull requests: read/write
  - Metadata: read
- Control-plane service-role key delivered through the operator-approved secret channel.

## One-time setup

```bash
cd /Users/brianlewis/Projects/blackrock-command-center/runner
cp .env.example .env
# Fill .env with CONTROL_PLANE_SERVICE_KEY, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, RUNNER_ID, etc.
bun install
bun test
```

`GITHUB_APP_PRIVATE_KEY` accepts either a literal PEM or a base64-encoded PEM. Do not commit `.env`.

## Run foreground

```bash
cd /Users/brianlewis/Projects/blackrock-command-center/runner
bun run start
```

Logs are structured JSON to stdout. Redirect them if running under a process manager.

## Verify with mock mode

Mock mode uses fake GitHub + fake Claude Code boundaries and a throwaway local mock workspace. It still claims, completes/fails, and writes `agent_runs` against the configured control plane.

```bash
cd /Users/brianlewis/Projects/blackrock-command-center/runner
RUNNER_MOCK_MODE=true bun run start
```

Then enqueue a safe test work order from the Command Center or via the control-plane RPC. The runner should log:

- `work order claimed`
- `minted GitHub installation token` with `mock-installation`
- `work order completed`

Verify through `cc-read-audit` that these audit events exist with `actor = "mac-studio-1"`:

- `work_order_claimed` from `cc_claim_work_order`
- `pr_opened` from `cc_complete_work_order`

Verify `agent_runs` has a matching row with `status = 'succeeded'`, `runner = 'claude_code_goal'`, and a mock PR URL like:

```text
https://github.com/<owner>/<repo>/pull/mock-<work_order_id>
```

Clean up any smoke-test work-order row after verification.

## launchd template

Save as `~/Library/LaunchAgents/ai.blackrock.command-center-runner.plist`, then load with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.blackrock.command-center-runner.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.blackrock.command-center-runner</string>

  <key>WorkingDirectory</key>
  <string>/Users/brianlewis/Projects/blackrock-command-center/runner</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>run</string>
    <string>start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/brianlewis/Library/Logs/command-center-runner.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/brianlewis/Library/Logs/command-center-runner.err.log</string>
</dict>
</plist>
```

Keep `.env` in the runner directory; Bun loads it when the process starts from `WorkingDirectory`.

## Graceful restart

Send SIGTERM or press Ctrl-C. The daemon stops claiming new work, finishes the current work order if one is running, then exits. It does not hard-kill a long Claude Code run during shutdown; if the host dies, the lease expires and the sweeper reclaims the order.

## Troubleshooting

- **No work claimed:** confirm queued rows exist and no same-`app_id` order is already `claimed`, `dispatched`, or `building`.
- **Lease expired:** the daemon missed renewal. The scheduled sweeper resets the row to `queued` or dead-letters it after `max_attempts`.
- **GitHub token failure:** confirm the GitHub App is installed on the target repo and `registry_app_repo.github_install_id` is set. The runner can also look up the installation by repo when the install id is missing.
- **Claude Code failure:** inspect the `agent_runs.notes` excerpt and runner stderr log. The work order is failed or dead-lettered through `cc_fail_work_order`.
- **Workspace leftovers:** each run removes `WORKSPACE_ROOT/<work_order_id>` in `finally`. Leftovers indicate a host/process crash; they can be deleted manually after confirming no daemon is using them.
