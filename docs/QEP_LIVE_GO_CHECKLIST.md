# QEP Live-Go Checklist

The single ordered list of moves that takes the Command Center from "registry-only" placeholder data to **fully live cockpit + slide-overs + S2 cutover complete** for QEP.

Companion docs (already in this repo):
- `docs/handoffs/QEP_COMMAND_CENTER_ROLE.md` — the role + JWT recipe (deep detail).
- `docs/handoffs/QEP_CC_EXPORT_DETAIL.md` — the `cc_export_detail()` SQL (deep detail).
- `docs/CLOUDFLARE_ACCESS_SETUP.md` — public deployment hardening.

Helper scripts (this repo):
- `scripts/mint-read-key-qep.mjs` — mints the `READ_KEY_QEP` JWT.
- `scripts/verify-qep-cutover.sh` — confirms via live audit log that S2 has flipped.

---

## Tier 1 — Make the cockpit show real QEP data (≤ 1 hour)

After Tier 1, `/apps/qep` lights up: real Streams/Waves/tasks, real decisions you can answer inline, the 47 blocked items listed by name, the `key_class` cutover observable in the audit log.

### 1.1 — Apply the `command_center` role on QEP's data plane

The exact SQL is in `docs/handoffs/QEP_COMMAND_CENTER_ROLE.md` §1. Two ways to apply it:

**Option A — Through the QEP repo as a normal migration** (recommended; keeps history):
1. Open the `lewis4x4/qep` repo.
2. Create a new migration file (e.g. `NNN_command_center_role.sql`) with the §1 SQL.
3. Apply via the Supabase MCP linked to the QEP project, same way every other QEP migration ships.

**Option B — Apply directly via the Supabase dashboard SQL editor** for the QEP project (`iciddijgonywtxoelous`). Faster if you don't want to ship a migration through QEP's flow:
1. Open https://supabase.com/dashboard/project/iciddijgonywtxoelous/sql/new
2. Paste the SQL from `docs/handoffs/QEP_COMMAND_CENTER_ROLE.md` §1.
3. Run.

Either way, the role exists on QEP afterward.

### 1.2 — Mint `READ_KEY_QEP`

```bash
# Get the QEP JWT secret from the QEP Supabase dashboard:
#   Settings → API → JWT Settings → JWT Secret
export QEP_JWT_SECRET='<paste it here>'

# Mint the JWT
node scripts/mint-read-key-qep.mjs
```

The script prints a long JWT string. Copy it.

### 1.3 — Set the secret on the control plane

```bash
supabase secrets set READ_KEY_QEP='<paste the printed JWT>' \
  --project-ref gsvhuzpysxaegoecwjmf
```

### 1.4 — Wait for the next 5-minute cron tick, then verify the cutover

```bash
./scripts/verify-qep-cutover.sh
```

Expected output after success:
```
PASS — Aggregator is using the scoped command_center role via READ_KEY_QEP.
S2 god-credential retirement is COMPLETE on the live control plane.
```

If it says PENDING, the most likely cause is `READ_KEY_QEP` not landing in the control-plane secrets, or the role not being grantable on QEP. The script tells you which to check.

### 1.5 — Apply `cc_export_detail()` on QEP's data plane

The exact SQL contract is in `docs/handoffs/QEP_CC_EXPORT_DETAIL.md`. Same two-option choice as step 1.1 (migration via QEP repo, or direct SQL editor).

**Important:** the QEP team decides what columns each of the three sections (`roadmap`, `decisions`, `sync`) exposes. That's the federated boundary working as designed — Command Center reads only what QEP chooses to expose.

Once applied, refresh `/apps/qep` — the placeholders flip to real data. The "Review blockers" slide-over now lists the 47 actual blocked items by title.

### 1.6 — Retire `SVC_KEY_QEP`

Wait at least 24 hours after Step 1.5 confirms `key_class: "readonly"`, then check the audit log for zero `fallback_from` events in that window:

```bash
# Confirm no fallback events in the last day
curl -s "https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-read-audit?limit=300" \
  -H "x-cc-read-token: <VITE_CC_READ_TOKEN>" \
  | jq '.events | map(select(.detail.fallback_from != null)) | length'
# Expected: 0
```

If the result is `0`, unset the legacy secret:

```bash
supabase secrets unset SVC_KEY_QEP --project-ref gsvhuzpysxaegoecwjmf
```

S2 is now fully complete — no standing god-credential anywhere.

### 1.7 — Schedule `READ_KEY_QEP` rotation

Add a calendar reminder to rotate `READ_KEY_QEP` every 60 days (mint expires at 90). Rotation: re-run `scripts/mint-read-key-qep.mjs` with the same `QEP_JWT_SECRET`, then set the control-plane secret again:

```bash
QEP_JWT_SECRET='<QEP Supabase JWT secret>' node scripts/mint-read-key-qep.mjs \
  | xargs -I {} supabase secrets set READ_KEY_QEP='{}' \
      --project-ref gsvhuzpysxaegoecwjmf
```

---

## Tier 2 — Use it from anywhere (≤ 1 hour)

After Tier 2, you sign in once via Google SSO and the cockpit works from any device.

### 2.1 — Provision Cloudflare Access

Walk the runbook at `docs/CLOUDFLARE_ACCESS_SETUP.md` — provision the Access app on the deployed hostname, bind it to your Google identity, lock down the policy.

### 2.2 — Flip the gating env vars

In Netlify (and any local `.env` you're using):
```
VITE_CC_ACCESS_REQUIRED=true
CC_ACCESS_REQUIRED=true
CC_ACCESS_TEAM_DOMAIN=<your team-domain>.cloudflareaccess.com
CC_ACCESS_AUD=<the Access application audience tag>
```

Tighten the CSP in `netlify.toml` per the runbook (drop the "intentionally permissive" header).

### 2.3 — Re-target Netlify and publish the new bundle

Currently the local Netlify CLI is linked to `circleoflifealf` (per the earlier audit). Re-link:
```bash
netlify link
# pick / type the Command Center site name
netlify deploy --prod
```

The deployed cockpit, slide-overs, Agents page, and (once Stream B lands) PR-triage band are live behind SSO.

---

## Tier 3 — Make it self-driving (≤ 1 day, mostly waiting)

This is the runner-daemon + dispatch-policy slice. The control-plane and frontend pieces are coming in parallel with this checklist (Streams A and B). What you'll need on the operator side:

### 3.1 — Create the BlackRock AI GitHub App

1. github.com → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Name: "BlackRock AI Command Center".
3. Repository permissions:
   - Contents: Read & write
   - Pull requests: Read & write
   - Metadata: Read-only
4. Subscribe to events: none (the runner polls, doesn't listen).
5. Where can this app be installed: Only on this account.
6. Generate, then **install on `lewis4x4/qep` only**.
7. Download the private key (.pem). Note the App ID.

### 3.2 — Stand up the Mac Studio runner host

- M-series Mac Studio, 32GB+ RAM.
- Install Bun: `curl -fsSL https://bun.sh/install | bash`
- Install + authenticate Claude Code CLI.
- Clone this repo to the Mac Studio.
- Configure the runner (see `runner/README.md` once Stream A lands).
- `bun install`, then run as a `launchd` service.

### 3.3 — Confirm end-to-end

Answer a low-risk AUTO-class decision in the Command Center. Watch:
- `cc_decision_answers` row written.
- `agent_work_orders` row appears with `status='queued'`.
- The daemon claims it within ~10 seconds; audit shows `work_order_claimed`.
- A PR opens against `lewis4x4/qep`.
- Audit shows `pr_opened`; the PR appears in the home's "PRs ready for review" band.

You merge the PR. The build moves.

---

## Tier 4 — Client-facing decision routing

Phase 5 — defer until you've lived in the cockpit for a week or two and have signal on what's working. Email engine + Resend + magic-link confirm + inbound reply parsing. Not on the critical path to making the platform useful.
