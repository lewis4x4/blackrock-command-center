# Path 2 — Runner Daemon Go-Live

End-to-end walkthrough to take the Command Center from "code-complete platform" to **a real PR opens against `lewis4x4/qep` from an answered decision**. ≤1 day of operator time, almost all of it waiting on installs and clicking through GitHub.

This doc combines and replaces the operator-side guidance in `runner/README.md` and `docs/handoffs/RUNNER_HOST_SETUP.md` for the first-time golive. Reference those for daemon internals.

---

## Prereqs

- [ ] M-series Mac Studio, 32GB+ RAM, set up with a macOS user dedicated to the runner.
- [ ] Admin access to the `lewis4x4` GitHub account (or org, if QEP moves there).
- [ ] Admin access to the Command Center Supabase project (`gsvhuzpysxaegoecwjmf`).

---

## Phase 2.1 — Create the BlackRock AI GitHub App *(~15 minutes, browser)*

1. Open https://github.com/settings/apps/new (or your org's `/organizations/<org>/settings/apps/new` if you have one).
2. Fill in:
   - **GitHub App name:** `BlackRock AI Command Center`
   - **Homepage URL:** `https://github.com/lewis4x4/blackrock-command-center`
   - **Webhook → Active:** **UNCHECK**. The runner polls; it doesn't listen.
3. **Repository permissions** (this is the security boundary — *exactly* these, no more):
   - **Contents** → **Read and write** (clone + push branch).
   - **Pull requests** → **Read and write** (open the PR).
   - **Metadata** → **Read-only** (required).
   - Leave everything else **No access**.
4. **Subscribe to events:** none.
5. **Where can this GitHub App be installed?** → **Only on this account.**
6. Click **Create GitHub App**.
7. On the next page, note the **App ID** (you'll need it). Example: `123456`.
8. Scroll to **Private keys** → **Generate a private key**. A `.pem` file downloads — keep it; you'll paste its contents into the runner `.env` later.

---

## Phase 2.2 — Install on `lewis4x4/qep` and capture the install ID *(~5 minutes)*

1. From the App settings page, click **Install App** in the left nav.
2. Click **Install** next to your account / org.
3. Choose **Only select repositories** and pick **`lewis4x4/qep`** only. Click **Install**.
4. After install, the browser URL becomes `https://github.com/settings/installations/<INSTALL_ID>` — note the `<INSTALL_ID>`. Example: `78901234`.
5. Write the install id back to the control plane so the runner can find it:

   ```bash
   # Replace 78901234 with your actual install id
   psql "$(supabase projects api-keys --project-ref gsvhuzpysxaegoecwjmf | grep service_role | awk '{print $3}')" \
     -h db.gsvhuzpysxaegoecwjmf.supabase.co -U postgres -d postgres \
     -c "UPDATE public.registry_app_repo SET github_install_id = '78901234' WHERE app_id = (SELECT id FROM public.registry_apps WHERE short_code = 'QEP');"
   ```

   Or do it in the Supabase dashboard SQL editor (control-plane project):
   ```sql
   UPDATE public.registry_app_repo
   SET github_install_id = '78901234'
   WHERE app_id = (SELECT id FROM public.registry_apps WHERE short_code = 'QEP');
   ```

   Verify:
   ```sql
   SELECT a.short_code, r.github_repo, r.default_branch, r.github_install_id
   FROM public.registry_app_repo r
   JOIN public.registry_apps a ON a.id = r.app_id
   WHERE a.short_code = 'QEP';
   ```

---

## Phase 2.3 — Grab the Command Center service-role key *(~2 minutes)*

The daemon needs this to write `agent_work_orders` and `agent_runs` (server-to-server writes on the control plane — not a client-DB call).

1. Open https://supabase.com/dashboard/project/gsvhuzpysxaegoecwjmf/settings/api
2. Scroll to **Project API keys** → **service_role** → click **Reveal** → **Copy**.
3. Hold it for Phase 2.5. **Do not paste it anywhere it might get committed.**

---

## Phase 2.4 — Provision the Mac Studio *(~30 minutes, on the host)*

These commands run on the **Mac Studio**, not your laptop.

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.zshrc   # or ~/.bashrc — restart your shell

# Install Claude Code CLI (if not already)
brew install --cask claude
# OR follow https://docs.anthropic.com/claude/docs/claude-code-cli
# Then authenticate:
claude login

# Install Git if missing
git --version || xcode-select --install

# Clone this repo
mkdir -p ~/Projects && cd ~/Projects
git clone https://github.com/lewis4x4/blackrock-command-center.git
cd blackrock-command-center/runner

# Install daemon dependencies
bun install
bun test    # all 11 tests should pass
```

---

## Phase 2.5 — Configure the daemon *(~5 minutes)*

Still on the Mac Studio.

```bash
cd ~/Projects/blackrock-command-center/runner
cp .env.example .env
# Edit .env (use nano, vim, or `open -t .env`)
```

Fill in these fields in `.env`:

```
CONTROL_PLANE_URL=https://gsvhuzpysxaegoecwjmf.supabase.co
CONTROL_PLANE_SERVICE_KEY=<the service-role key from Phase 2.3>

GITHUB_APP_ID=<your App ID from Phase 2.1, e.g. 123456>

# Paste the entire .pem you downloaded in Phase 2.1. Multi-line is fine.
# If multi-line is awkward, base64-encode the pem:
#   base64 -i path/to/blackrock-ai-command-center.private-key.pem | pbcopy
# Then paste the base64 string here.
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----
<...>
-----END RSA PRIVATE KEY-----

RUNNER_ID=mac-studio-1
POLL_INTERVAL_SECONDS=10
LEASE_SECONDS=600
WORKSPACE_ROOT=/tmp/cc-runner
CONCURRENCY=1

CLAUDE_CODE_COMMAND=claude
CLAUDE_CODE_TIMEOUT_SECONDS=0

# Leave false for production; flip to true if you want a no-Claude smoke first
RUNNER_MOCK_MODE=false
```

Sanity check:
```bash
bun run start
# You should see structured JSON logs starting with:
#   {"ts":"...","level":"info","component":"runner","message":"runner online","runner_id":"mac-studio-1",...}
# Ctrl-C to stop.
```

If you see config errors, the daemon tells you exactly which env var is wrong.

---

## Phase 2.6 — End-to-end live smoke *(~5–10 minutes)*

We're going to do this in **two stages** to keep the risk low:

### Stage A — Mock-mode end-to-end *(no Claude, no real PR, but real control plane)*

```bash
# Stop any running daemon (Ctrl-C).
# Run in mock mode:
RUNNER_MOCK_MODE=true bun run start
# Leave it running in this terminal.
```

In a second terminal **on your laptop**:
```bash
cd ~/Projects/blackrock-command-center
./scripts/runner-smoke-real.sh --mock
```

Expected: the script enqueues a tiny work order against QEP, the Mac Studio daemon claims it within ~10 seconds, "completes" it with a fake PR URL, and the script reports success. Then the script cleans up the test rows.

If this passes, the entire plumbing (control plane RPCs, claim/lease, audit writes, ledger) works end-to-end.

Stop the daemon with Ctrl-C, then continue to Stage B.

### Stage B — Real end-to-end *(real Claude, real PR against `lewis4x4/qep`)*

```bash
# On the Mac Studio:
bun run start    # without RUNNER_MOCK_MODE
```

On your laptop:
```bash
./scripts/runner-smoke-real.sh
```

Expected:
- Daemon claims the test order within ~10 seconds.
- Daemon mints a GitHub App installation token (you'll see it in the log, sanitized).
- Daemon clones `lewis4x4/qep` to `/tmp/cc-runner/<work_order_id>/repo`.
- Claude Code `/goal` runs — the change_spec asks it to add a single timestamped comment to `README.md`.
- Daemon pushes branch `cc/smoke-<work_order_id>` and opens a PR against `main`.
- Script reports the PR URL.
- **Go to the PR, look at the diff, then close it (don't merge)** to confirm the loop is real.
- Script cleans up the work-order row (the branch and PR you handle manually on GitHub).

If this passes — **you're operational.** The platform self-drives.

---

## Phase 2.7 — Promote to a background service *(~5 minutes)*

`runner/README.md` has the launchd plist template. Quick version:

```bash
cd ~/Projects/blackrock-command-center/runner

# Copy the plist template from runner/README.md into:
nano ~/Library/LaunchAgents/ai.blackrock.command-center-runner.plist

# Then load it:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.blackrock.command-center-runner.plist

# Verify it's running:
launchctl list | grep command-center-runner

# Tail logs:
tail -f ~/Library/Logs/command-center-runner.log
```

The daemon now restarts on host reboot, on crash, on Bun update — fully unattended.

---

## After go-live

What changes for you operationally:

| Before | After |
|---|---|
| Answer a decision → manually queue/build/PR | Answer a decision → AUTO answers auto-dispatch; AUTHORIZE answers wait for one Approve press on the home |
| Build PRs appear in your GitHub inbox unsorted | Home's "PRs ready for review" band ranks them by app criticality + age |
| You're the courier between decision and dispatch | You're the operator — the platform routes |

### Smoke-test cadence

Once a week, run `./scripts/runner-smoke-real.sh --mock` to confirm the daemon is healthy. The PR-side smoke (Stage B) is good for any time you've changed daemon code or rotated the GitHub App keys.

### Cost ceiling

AUTO-class auto-dispatch is currently capped at **$5 per work order**. The cap is hard-coded in `cc_enqueue_with_gating`. When you want per-app tuning, add `registry_apps.auto_dispatch_cap_usd` (a documented follow-up slice).

### When to circle back

- **A second app onboards** → repeat Phase 2.2 for that app (install the GitHub App on its repo, write `github_install_id`).
- **You move to a second runner host** → bump `CONCURRENCY` in `runner/.env` is the wrong move; instead stand up a second host with `RUNNER_ID=mac-studio-2`. The per-app mutex in the queue handles fan-out automatically.
- **GitHub App private key needs rotation** → generate a new private key in the App settings, swap `GITHUB_APP_PRIVATE_KEY` in `.env`, restart the daemon via launchd (`launchctl kickstart -k gui/$(id -u)/ai.blackrock.command-center-runner`).
