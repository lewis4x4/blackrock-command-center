# Cloudflare Access — putting the Command Center behind SSO

## What this closes
- Master plan §8.2 (the public-exposure risk) and §4.11 (the browser read path's hard gate).
- After this runbook, the deployed app is only reachable to identities that pass Brian's Google SSO. The interim `VITE_CC_READ_TOKEN` is removed.

## What you (Brian) own
- Decisions §10 #1: the public hostname. Pick one before starting.
- Creating the Cloudflare Access application + Google identity policy.

## What this repo already gives you
- `cc-read-*` edge functions accept the `Cf-Access-Jwt-Assertion` header when `CC_ACCESS_REQUIRED=true` and verify it against the team domain's JWKS.
- `netlify.toml` is configured to play nicely with Access (security headers, no caching of HTML, no automatic redirect chains that would break the Access challenge).

## Step-by-step

### 1. Pick the hostname and confirm DNS
- Choose: `<e.g. command.blackrockai.co>`.
- Add the CNAME at your registrar pointing at the Netlify site.
- Confirm the site loads at that hostname (still public for the moment).

### 2. Create the Cloudflare Access application
- Cloudflare Zero Trust dashboard → Access → Applications → Add application → Self-hosted.
- **Application Name:** "BlackRock AI Command Center"
- **Session Duration:** 24h (default is fine; tighten later if desired)
- **Application domain:** `<your hostname>`
- Save and note the **Application AUD tag** — the long hex string. You'll paste it into the Supabase Functions secrets in step 5.

### 3. Add identity provider and policy
- Identity Providers tab → add Google (using the Google OAuth credentials you already use elsewhere, or set up new ones — Cloudflare's guide walks you through it).
- Policies → Create policy:
  - **Name:** "Brian only"
  - **Action:** Allow
  - **Selector:** Emails → `<your email>`
- (You can add more allowed emails / a domain match later; start narrow.)

### 4. Note your Access team domain
- Zero Trust dashboard → Settings → General → **Team domain**.
- Format: `<team>.cloudflareaccess.com`. You'll paste this in step 5.

### 5. Configure the four read functions for production §4.11
Run from the repo root (Supabase CLI must be linked, which it already is):

```bash
supabase secrets set CC_ACCESS_REQUIRED=true
supabase secrets set CC_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
supabase secrets set CC_ACCESS_AUD=<application AUD tag from step 2>
```

That flips every read function (`cc-read-home`, `cc-read-app`, `cc-read-audit`, `cc-read-artifacts`) into Access-verified mode. The functions reload within a minute. After that, requests without a valid `Cf-Access-Jwt-Assertion` header return 401 — regardless of whether `CC_READ_TOKEN` is set.

### 6. Configure the deployed web app
Web env (Netlify environment variables for the production deploy):

```env
VITE_CC_ACCESS_REQUIRED=true
VITE_CC_FUNCTIONS_URL=https://<hostname>/_/cc-functions
# (path-prefix Cloudflare proxies to *.supabase.co/functions/v1 —
#  see step 7. The browser hits the same hostname so the Cf-Access cookie
#  is included automatically.)
```

Remove:

```env
VITE_CC_READ_TOKEN=...    # no longer needed once Access is on
```

Also remove the `CC_READ_TOKEN` from Supabase Functions secrets:

```bash
supabase secrets unset CC_READ_TOKEN
```

(Removing it is optional but tidy — without `CC_ACCESS_REQUIRED=true` the fallback only authorizes reads, but with Access on the fallback is unreachable anyway, so the token is dead code.)

### 7. Wire the path-prefix proxy
Cloudflare Access only injects `Cf-Access-Jwt-Assertion` into requests for hostnames it gates. The Supabase Functions domain (`*.supabase.co`) is **not** gated by Access — so the browser cannot call it directly under Access.

Two production-grade options; pick one:

- **Option A — Cloudflare Worker route** (recommended). On the same `<hostname>` zone, add a Worker route `<hostname>/_/cc-functions/*` whose Worker proxies to `https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/*` and forwards the `Cf-Access-Jwt-Assertion` header. Cloudflare injects the assertion before the Worker runs; the Worker just relays it.
- **Option B — Netlify rewrite to a Worker domain.** If you already have a proxy Worker elsewhere, point the Netlify `_redirects` at it.

Either way, the browser only ever talks to `<hostname>`; Access is fully in front.

### 8. Verify
- Open `<hostname>` in a fresh incognito window. You should be challenged by Google SSO. Sign in as `<allowed email>`. The Command Center home should load, reading the live edge functions through the Access-protected path.
- Open the same URL in a window where you're **not** logged in. You should see the Cloudflare Access challenge — never the dashboard.
- Run the `Files` surface (`#/files`) and confirm artifacts load — that's proof the same Access cookie covers all four read functions.

### 9. Decommission the interim
- Delete `VITE_CC_READ_TOKEN` from any developer's local `.env`.
- Delete `CC_READ_TOKEN` from Supabase Functions secrets (step 6).
- Delete the §4.1 part (a) followups: migration 013 (this slice) is now in effect; no anon grants remain.

## What's still open after S1
- S2 (god-credential retirement on each client data plane) — separate slice.
- S3 (HMAC webhook ingest + GitHub App) — separate slice.

## Rollback (if Access breaks something)
- Revert step 5: `supabase secrets unset CC_ACCESS_REQUIRED CC_ACCESS_TEAM_DOMAIN CC_ACCESS_AUD`.
- Re-add `CC_READ_TOKEN` and `VITE_CC_READ_TOKEN` from your password manager.
- The functions auto-reload; the home returns to the interim `x-cc-read-token` mode within ~60 seconds.
