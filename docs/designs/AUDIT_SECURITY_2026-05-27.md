# Security Audit — 2026-05-27

Scope: Auth, RLS, CORS, secret handling, SQL injection surface, dependency vulnerabilities.

Lane audited:
- `supabase/functions/**/index.ts`
- `supabase/migrations/*.sql` (read-only; no migrations authored)
- `runner/src/{config,controlPlane,githubApp,claudeCode}.ts` plus adjacent runner secret-flow observations
- `web/.env`, `web/.env.example`
- `package.json` / audit metadata for `web` and `runner`

Verification performed:
- `deno check supabase/functions/cc-answer-issue/index.ts supabase/functions/cc-gmail-oauth-callback/index.ts supabase/functions/aggregator/index.ts supabase/functions/cc-index-artifacts/index.ts supabase/functions/cc-telegram-notify/index.ts` ✅
- `cd web && bun audit` ✅ completed; 2 moderate dev-tool advisories found
- `cd runner && bun audit` ✅ no vulnerabilities found

## P0 — fixed

### 1. `cc-answer-issue` mutation bypassed write-token gating for authenticated callers

- File: `supabase/functions/cc-answer-issue/index.ts`
- Finding: `verifyWriteToken(req)` was nested inside the `if (!access.ok)` branch. A caller with a valid read/Access gate could reach the mutation path without `x-cc-write-token`.
- Impact: authenticated/read-gated browser callers could mutate `cc_issues` / `cc_decision_answers` through `cc_resolve_issue` without the required write token.
- Fix applied: return immediately on failed access check; always call `verifyWriteToken(req)` before JSON parsing and RPC mutation.
- Verification: included in passing `deno check`.

### 2. Gmail OAuth callback rendered a live refresh token to the browser on storage failure

- File: `supabase/functions/cc-gmail-oauth-callback/index.ts`
- Finding: if automatic Supabase secret storage failed, the HTML response included a copy-paste `supabase secrets set GMAIL_OAUTH_REFRESH_TOKEN='...'` command containing the live refresh token.
- Impact: token exposure via browser history, screenshots, copied support text, or page capture.
- Fix applied: the fallback page now explains recovery without displaying the token.
- Verification: included in passing `deno check`.

## P1 — fixed

### 1. Internal POST functions lacked OPTIONS/CORS responses

- Files:
  - `supabase/functions/aggregator/index.ts`
  - `supabase/functions/cc-index-artifacts/index.ts`
- Finding: both mutation-capable internal endpoints rejected non-POST requests without preflight handling and did not include CORS headers in JSON responses.
- Fix applied: added explicit `OPTIONS` responses and `Access-Control-Allow-Headers: Content-Type, x-aggregator-token`; normalized JSON responses to include CORS headers.
- Verification: included in passing `deno check`.

### 2. Telegram notifier parsed body / disclosed disabled state before authenticating

- File: `supabase/functions/cc-telegram-notify/index.ts`
- Finding: unauthenticated callers could force JSON parsing and observe `telegram_disabled` before `verifyCaller(req)` ran.
- Fix applied: authenticate immediately after method checks; only parse body or disclose disabled/skipped states after caller verification.
- Verification: included in passing `deno check`.

### 3. Secret ignore patterns missed common environment variants

- File: `.gitignore`
- Finding: `.env` and `.env.local` were ignored, but common secret variants such as `.env.production`, `.env.staging`, and `.env.runner` were not.
- Fix applied: added common env variant patterns.

## P1 — documented / not changed in this lane

### Browser-exposed interim read/write tokens

- Files observed: `web/.env` (untracked local), `web/.env.example`.
- Finding: `VITE_CC_READ_TOKEN` and `VITE_CC_WRITE_TOKEN` are browser-exposed by design while Cloudflare Access / write gates are incomplete. Local `web/.env` also contains `VITE_CC_AUTO_ROUTE_TOGGLE_TOKEN`.
- Impact: any populated `VITE_*` token should be treated as visible to browser users. This is an interim control, not a durable secret boundary.
- Status: documented only. Removing these tokens requires coordinated frontend/API auth changes and is outside this security-lane patch.

### Runner stdout/stderr propagation can expose secrets if downstream tools print them

- Out-of-lane file observed: `runner/src/runner.ts`.
- Finding: Claude stdout/stderr can be copied into PR body text and agent-run notes. If Claude or a command prints secrets, they may be persisted externally.
- Status: documented only because the requested runner edit lane was limited to `config.ts`, `controlPlane.ts`, `githubApp.ts`, and `claudeCode.ts`.

## P2 / hardening notes

- Edge functions commonly use service-role PostgREST calls after app-layer auth. This is common in this codebase but means any edge auth bypass becomes full RLS bypass. Prefer narrower RPCs and least-privilege server roles over time.
- Shared PostgREST helpers accept raw path strings. No raw SQL interpolation was found, and most user-controlled values are UUID-validated or URL-encoded, but a `URLSearchParams` wrapper would reduce future filter-injection mistakes.
- `cc_decision_answers` is ledger-like but not fully immutable. DB audit found no P0 migration required; optional hardening would add a trigger preventing updates to core answer fields while allowing `dispatched_at` / remediation metadata.
- `web` dependency audit found moderate dev-server advisories in Vite/esbuild. No critical CVE was reported by `bun audit`.
- `@blackrock-ai/*` package audit was limited because `bun audit` skips non-default registry packages. At audit time, direct web deps were `^0.1.6`; lockfile/package state is concurrently changing in the worktree by sibling agents.

## RLS / audit-log integrity

- `cc_audit_events` is append-only at multiple layers:
  - mutation grants revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role` in `006_audit_log_append_only.sql`;
  - service role has insert/select policies only;
  - update/delete/truncate triggers raise on mutation.
- No edge function update/delete access to `cc_audit_events` was found; edge functions only insert audit rows or read through gated read endpoints.
- `cc_issues` initially had broad authenticated/anon policies, but later migrations remove/revoke them (`013_revoke_all_anon_grants.sql`, `031_phase5_security_rotate.sql`).
- `cc_decision_answers` and `agent_work_orders` are RLS-enabled and service-role only; RPC execute grants are restricted to service role.

## Dependency audit

### `web`

Command: `cd web && bun audit`

Result: 2 moderate advisories:
- `vite <= 6.4.1` — path traversal in optimized deps source-map handling.
- `esbuild <= 0.24.2` — dev server request exposure advisory.

No critical/high direct vulnerability was reported. `bun audit` skipped `@blackrock-ai/*` packages because they are not from the default registry.

### `runner`

Command: `cd runner && bun audit`

Result: no vulnerabilities found.

## Files changed by this security lane

- `.gitignore`
- `docs/designs/AUDIT_SECURITY_2026-05-27.md`
- `supabase/functions/aggregator/index.ts`
- `supabase/functions/cc-answer-issue/index.ts`
- `supabase/functions/cc-gmail-oauth-callback/index.ts`
- `supabase/functions/cc-index-artifacts/index.ts`
- `supabase/functions/cc-telegram-notify/index.ts`
