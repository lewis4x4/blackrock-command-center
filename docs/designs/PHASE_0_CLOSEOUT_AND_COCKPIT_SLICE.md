# Phase 0 Closeout and Cockpit Slice

This plan describes the final steps to complete Phase 0 and the initial Phase 2 cockpit slice of the BlackRock AI Command Center. It delivers three sequenced work items: closing the critical god-credential vulnerability by introducing a scoped read-only role, switching the home view triage band to read from the newly reconciled `cc_issues` ledger, and shipping the Phase 2 per-app cockpit proxy and web route. The work is organized into a single shippable slice, ensuring the platform remains safe and consistent at each step.

## Item 1: Phase 0 Prerequisite (Reference Only)
The underlying Phase 0 infrastructure is already in place. The control plane has been hardened with append-only audit logs (migration `006_audit_log_append_only.sql`), the `cc_issues` ledger has been created (`007_cc_issues_ledger.sql`), the 5-minute aggregator poll is active (`008_aggregator_schedule_5min.sql`), and snapshot issues are being reconciled correctly (`009_cc_reconcile_issues.sql`). Anonymous read access has been safely revoked (`013_revoke_all_anon_grants.sql`). Downstream agents should rely on these existing contracts; no new data plane schema or cron work is required here.

- [x] Phase 0 control-plane schema and Aggregator baseline established.

## Item 2: Retire the SVC_KEY God-Credential ✅ DONE (control plane)

_Status: Control-plane migration 014 applied; Aggregator + cc-read-app refactored with belt-and-suspenders fallback and audit `key_class` tagging; QEP handoff doc lives at `docs/handoffs/QEP_COMMAND_CENTER_ROLE.md`. The QEP repo still needs to apply its data-plane SQL + mint `READ_KEY_QEP`._

Currently, the Aggregator and `cc-read-app` functions use a full-access service-role key (`SVC_KEY_QEP`) to poll client data planes, bypassing RLS and creating a massive blast radius. This item replaces it with a scoped, read-only `command_center` role.

### The Client Data Plane (QEP Repo Handoff)
- [x] Create the `command_center` role on the QEP data plane. _(handoff doc written; QEP team executes)_ It should only have permission to execute the snapshot contract (and future export functions).
```sql
-- Target: QEP data plane (QEP repo)
CREATE ROLE command_center NOLOGIN;
GRANT USAGE ON SCHEMA public TO command_center;
GRANT EXECUTE ON FUNCTION cc_export_snapshot() TO command_center;
```
*(Note: Do not apply this here; provide the skeleton for the downstream operator/agent working in the QEP repo.)*

### Control Plane Data
- [x] Add a `readonly_secret_ref` column to the `registry_app_supabase` table. _(migration 014 applied + verified)_
```sql
-- Target: Command Center control plane (migration 014)
ALTER TABLE public.registry_app_supabase ADD COLUMN readonly_secret_ref text;
```
*(Note: We will use a custom JWT signed with `role: "command_center"` using the client's JWT secret, and store it in Supabase Vault as `READ_KEY_QEP`)*

### Edge Functions
- [x] Update `supabase/functions/aggregator/index.ts` to use `readonly_secret_ref` instead of `service_secret_ref`. Belt-and-suspenders fallback in place; audit `snapshot_captured` events now tag `key_class`, `secret_ref`, and `fallback_from`.
- [x] Update `supabase/functions/cc-read-app/index.ts` (returns `data_plane_key_class` metadata). Other `cc-read-*` functions read the control plane only — no changes needed.

### Rotation & Verification
- [ ] Apply the new `READ_KEY_QEP` to the control plane environment variables. _(blocked on QEP team executing the handoff)_
- [ ] Validate that the Aggregator successfully polls QEP using the read-only key. _(verify via `cc_audit_events.snapshot_captured.key_class = 'readonly'`)_
- [ ] Verify the old `SVC_KEY_QEP` is rejected when testing against the read-only functions, then safely remove `SVC_KEY_QEP` from the environment.

## Item 3: Wire the Home Triage Band to `cc_issues` ✅ DONE

_Status: `cc-read-home` returns `issues[]` from open `cc_issues` rows; home triage band reads them with stable IDs; `deriveTriage()` removed; demo mode synthesizes plausible issues. Live smoke: `cc-read-home` returned 200 with 2 issues having stable IDs._

The home page currently computes triage states client-side from the snapshot counts (`deriveTriage()` in `web/src/lib.ts`). With the 009 reconciliation migration running every 5 minutes, the `cc_issues` ledger is now the true source of triage state.

- [x] **Extend `cc-read-home`**: Update `supabase/functions/cc-read-home/index.ts` to query `cc_issues` where `resolved_at IS NULL`. We extend `cc-read-home` instead of creating a new edge function to prevent an N+1 request problem and avoid introducing a secondary loading state on the home screen.
- [x] **Update Home View**: Modify `Home.tsx` and `App.tsx` to read the new `issues` array returned by `cc-read-home`.
- [x] **Remove `deriveTriage()`**: Delete `deriveTriage()` entirely from `web/src/lib.ts`. Since migration 009 runs on every poll, we do not need backward compatibility; falling back to a client-side computation masks edge cases and creates split-brain logic.
- [x] **Verification**: The home triage band renders correctly, displaying the same items but backed by stable `id` properties from the `cc_issues` table (critical for Phase 2 resolution panels).

## Item 4: Ship the Phase 2 Cockpit ✅ DONE (Command Center side)

_Status: `cc-read-app-detail` deployed and live; `/apps/:slug` route + `AppDetail.tsx` shipped; "Open QEP" navigates internally; QEP handoff doc at `docs/handoffs/QEP_CC_EXPORT_DETAIL.md`. Live smoke: `cc-read-app-detail` returns structured `503 detail_contract_unavailable` until QEP applies its contract — expected behavior._

Deliver the per-app cockpit proxy and the `/apps/:slug` web route so that "Open QEP" keeps the user within the Command Center instead of navigating away.

### The Client Data Plane (QEP Repo Handoff)
- [x] Expose `cc_export_detail()` on the QEP data plane. _(handoff doc written at `docs/handoffs/QEP_CC_EXPORT_DETAIL.md`; QEP team executes)_
```sql
-- Target: QEP data plane (QEP repo)
CREATE OR REPLACE FUNCTION cc_export_detail(
  p_section text DEFAULT 'all'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  -- Validate section and aggregate: 'roadmap', 'decisions', 'sync'
  RETURN jsonb_build_object(
    'roadmap', '...',
    'decisions', '...',
    'sync', '...'
  );
END;
$$;
-- The command_center role will need EXECUTE on this new function
GRANT EXECUTE ON FUNCTION cc_export_detail(text) TO command_center;
```

### Control Plane Data
- [x] Build the `cc-read-app-detail` edge function. _(deployed; auth + readonly→service fallback + `detail_read` audit + graceful 503 path all wired)_
  - Inputs: `app_id` (uuid), optional `section` (string), optional cursor.
  - Auth: Authenticates via Cloudflare Access JWT (or the `x-cc-read-token` fallback).
  - Security: Resolves the scoped read-only key by `readonly_secret_ref`.
  - Audit: Writes an audit event (`detail_read`) to `cc_audit_events` on every successful invocation.

### Web Application
- [x] Introduce a minimal HashRouter in `web/src/App.tsx`. The current hash switch allows `#/` and `#/files`. Extend `ShellPage` and `pageFromHash()` to support `#/apps/:slug` rather than adding a heavy dependency like React Router. A simple regex or split on `location.hash` keeps the app lightweight.
- [x] Build the `/apps/:slug` view (`web/src/AppDetail.tsx` or similar):
  - **Header**: App health and status (from the registry).
  - **Sections**: Roadmap board, Decision queue, Sync detail, Integrations, and Per-App Activity (reference §7 "per-app cockpit").
- [x] Rewire the "Open App" action on the home screen triage cards. It should navigate to `#/apps/qep` (using `short_code.toLowerCase()`) instead of opening `registry_app_supabase.project_url`.
- [x] **Verification**: Clicking "Open QEP" loads the new cockpit view with placeholder sections; the user never leaves the Command Center. Live data fills in once the QEP team applies `cc_export_detail()`.

## Assumptions & Open Questions
- **Assumptions**:
  - The QEP team is available to apply the `command_center` role and `cc_export_detail` function to their data plane synchronously.
  - The JWT secret for QEP is accessible to the platform operator to generate the `READ_KEY_QEP` and configure it in the Vault.
  - Full data payloads from `cc_export_detail` are sufficient for Phase 2 initial roll-out (no pagination required yet).
- **Open Questions**:
  - For the "belt-and-suspenders" key cutover, how long should `SVC_KEY_QEP` be retained as a fallback before being completely removed from the secrets manager?