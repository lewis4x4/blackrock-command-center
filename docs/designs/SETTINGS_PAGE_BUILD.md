# Settings Page Build Plan

## 1. Summary
This slice ships the Settings page, surfacing five distinct bands of configuration and observability: Account, Aggregator schedule, Integrations, Secrets, and the full Audit log. It introduces a single new `cc-read-settings` edge function that envelopes this data efficiently, mirroring the `cc-read-agents` multi-section pattern. The UI acts as a read-only reassurance layer (especially for secret references and the Aggregator schedule) while providing a filterable, append-only view of the full audit stream via the existing `cc-read-audit` function.

## 2. Phased Checklist

### Backend
- [ ] Create new `supabase/functions/cc-read-settings/index.ts` edge function.
- [ ] Implement identity resolution in `cc-read-settings` via Access JWT or read-token hash to populate the Account band data (mirroring `supabase/functions/cc-answer-issue/index.ts:139-179`).
- [ ] Implement `pg_cron.job` read in `cc-read-settings` using service-role to fetch `jobname`, `schedule`, and `active` status for the Aggregator schedule. Explicitly exclude the `command` field to avoid leaking secrets.
- [ ] Query and compile cross-app integration metrics from `registry_app_integrations` for the Integrations band.
- [ ] Query and compile the full inventory of secret references (e.g., `service_secret_ref`, `readonly_secret_ref`, `api_key_ref`, `webhook_secret_ref`, plus the non-column Vault reference `aggregator_token`). Format as name + `is_set` boolean.
- [ ] Return the compiled `{account, aggregator, integrations, secrets, audit_preview, generated_at}` envelope matching the pattern in `supabase/functions/cc-read-agents/index.ts:270-322`.
- [ ] Extend `supabase/functions/cc-read-audit/index.ts` to support optional filtering by `app_id`, `type`, and `date` if straightforward, to support the full filterable audit log.
- [ ] Deploy the new and updated edge functions and verify functionality.

### Frontend types + helper
- [ ] In `web/src/lib.ts`, define `SettingsPayload` type matching the backend envelope of `cc-read-settings`.
- [ ] In `web/src/lib.ts`, define types for the individual bands (e.g., `AccountInfo`, `AggregatorSchedule`, `SecretInventory`).
- [ ] In `web/src/lib.ts`, implement `loadSettings(demo)` helper function to call `cc-read-settings`.
- [ ] In `web/src/lib.ts`, extend the existing `loadAudit()` helper or create a new one to pass the new filter parameters to `cc-read-audit`.

### Frontend page
- [ ] Create `web/src/Settings.tsx`.
- [ ] Implement page structure with five visual bands matching the styling of `web/src/Agents.tsx`.
- [ ] **Account Band:** Display the identity line ("Signed in as `<actor>`"), a link to the GitHub App settings, and a link to `docs/CLOUDFLARE_ACCESS_SETUP.md`.
- [ ] **Aggregator Band:** Display the cron schedule expression, job name, last successful run (derived from `cc_audit_events.snapshot_captured`), and next ETA.
- [ ] **Integrations Band:** Display integration counts grouped by status (live/demo/manual_safe/planned). Implement a slide-over drill-down for per-app breakdown, or a flat list grouped by app (Designer's choice).
- [ ] **Secrets Band:** Display every secret-ref pointer as a read-only chip showing the name and a SET/NOT-SET dot. Group by app, adding a global section for `aggregator_token`. Ensure values are NEVER rendered or requested.
- [ ] **Audit Band:** Implement a paginated stream using the `cc-read-audit` endpoint. Include a "Load more" button via cursor. Hide telemetry events (`detail_read`, `agents_page_read`, `decisions_page_read`, `settings_page_read`, `secret_read`). Ensure zero delete affordance.

### Routing + nav
- [ ] In `web/src/Home.tsx`, extend `ShellPage` union type with `'settings'` (`web/src/Home.tsx:34`).
- [ ] In `web/src/App.tsx`, extend `pageFromHash()` and `hashForPage()` to handle `#/settings`.
- [ ] In `web/src/App.tsx`, add the render branch for `page === 'settings'` mounting the `<Settings />` component.
- [ ] In `web/src/App.tsx`, update the topbar title to include "Settings" when active.
- [ ] In `web/src/Home.tsx`, remove the `soon` badge from the Settings nav item and wire the click to set `location.hash = '#/settings'`.

### Audit Lately mapping
- [ ] Ensure `settings_page_read` is correctly handled (filtered out of the main audit view) in `cc-read-audit` and logged during `cc-read-settings` access.

### Verification gate
- [ ] Run `npm run build` in `/web` and ensure it passes.
- [ ] Run `deno check` (or equivalent) for the new/updated edge functions and ensure they pass.
- [ ] Perform a live smoke test: verify the Secrets band never leaks a real secret value over the network payload.
- [ ] Verify the Audit band displays logs but offers no way to modify or delete them.

## 3. Out-of-Scope (Phase 5+)
- [ ] Account logout or password management (delegated to Cloudflare Access).
- [ ] Direct secret value setting via the UI.

## 4. Open Questions / Decisions
- Integrations drill-down: Should we use a slide-over for per-app breakdowns or just render a flat grouped list? (Recommendation: Flat grouped list if count is small, slide-over if UI gets too vertically heavy).
- Audit filters: If extending `cc-read-audit` with full filters (app/type/date) is too complex for this slice, should we ship the v1 with just the existing cursor pagination and defer filters? (Recommendation: Defer full filters to next phase if it significantly bloats the PR, as cursor pagination meets the minimum spec).

## 5. Assumptions
- Assume the backend database triggers (migration 006) strictly enforce append-only for the audit log, serving as the ultimate safeguard regardless of frontend behavior.
- Assume `cc-read-app`'s pattern for exposing secret names + boolean status is directly reusable in the new cross-app `cc-read-settings` context.
