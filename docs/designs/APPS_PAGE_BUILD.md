# Apps Page Build Plan

## 1. Summary
This slice ships the fully functional Apps page, transforming the registry into an operable system. It provides a view of every registered app using the existing project grid pattern, a detail panel per app reusing existing components, the ability to edit basic app information, and a manual "register a new app" form. Secret references are strictly displayed as labels, never values. The control plane implements these mutations via new `cc-edit-app` and `cc-register-app` service-role edge functions, rejecting direct client PostgREST writes.

## 2. Phased Checklist

### Backend
- [ ] Create new `supabase/functions/cc-edit-app/index.ts` edge function.
- [ ] Implement `cc-edit-app` endpoint: allowlist `display_name`, `app_url`, and `criticality` only. Reject all other fields.
- [ ] Create new `supabase/functions/cc-register-app/index.ts` edge function.
- [ ] Implement `cc-register-app` endpoint: accept minimum payload (`short_code`, `display_name`, `project_ref`, `project_url`, `service_secret_ref`, `github_repo`, optional `readonly_secret_ref`).
- [ ] In both new functions, resolve operator identity via Cloudflare Access JWT (sub/email) or read-token hash, mirroring the `cc-answer-issue` pattern (`supabase/functions/cc-answer-issue/index.ts:139-179`).
- [ ] Implement secret-ref validation in `cc-register-app`: reject strings resembling raw JWTs or API keys (e.g., starting with `eyJ`, length > 100). Enforce pointer names (e.g., `READ_KEY_SCC`).
- [ ] Deploy the functions via Supabase CLI and verify functionality.

### Frontend types + helper
- [ ] In `web/src/lib.ts`, add helper function `editAppBasics(appId, changes)` to call `cc-edit-app`.
- [ ] In `web/src/lib.ts`, add helper function `registerApp(payload)` to call `cc-register-app`.
- [ ] Ensure types reflect the "Edit basics" whitelist and "Register minimum payload".

### Frontend page
- [ ] Create `web/src/Apps.tsx`.
- [ ] Implement the list view reusing the existing project grid from `web/src/Home.tsx:335-454`. (Recommend keeping the base component in Home or extracting to a shared component).
- [ ] Add a "Register new app" CTA at the top of the page.
- [ ] Wire the "Register new app" CTA to open a modal/slide-over with the registration form.
- [ ] Implement registration form submission to `cc-register-app`. On success, show the new `short_code` and the post-registration checklist instructions (e.g., "Now run: `supabase secrets set SVC_KEY_NEW_CODE=...` to enable polling").
- [ ] On the project cards in `web/src/Apps.tsx`, add a pencil icon for "Edit basics".
- [ ] Wire the pencil icon to open a slide-over showing the three editable fields (`display_name`, `app_url`, `criticality`).
- [ ] Implement save logic for "Edit basics": call `cc-edit-app`, show a toast success message, and refresh the grid.
- [ ] Ensure the app detail view remains accessible at `/apps/:slug` (the cockpit detail) and continues to render secret references as labels only.

### Routing + nav
- [ ] In `web/src/Home.tsx`, extend `ShellPage` union type with `'apps'` (`web/src/Home.tsx:34`).
- [ ] In `web/src/App.tsx`, extend `pageFromHash()` and `hashForPage()` to handle `#/apps` (without breaking `#/apps/:slug`).
- [ ] In `web/src/App.tsx`, add the render branch for `page === 'apps'` mounting the `<Apps />` component.
- [ ] In `web/src/App.tsx`, update the topbar title to include "Apps" when active.
- [ ] In `web/src/Home.tsx`, remove the `soon` badge from the Apps nav item (if present) and wire the "View all apps" button and top nav to set `location.hash = '#/apps'`.

### Audit Lately mapping
- [ ] In `supabase/functions/cc-read-audit/index.ts`, map the new endpoint executions or related page reads appropriately (hide telemetry if implemented).

### Verification gate
- [ ] Run `npm run build` in `/web` and ensure it passes.
- [ ] Run `deno check` (or equivalent Deno lint/typecheck command) for the new edge functions and ensure they pass.
- [ ] Perform a live smoke test against the deployed control plane: try to edit an app's basics and verify only the allowlisted fields are updated. Attempt to bypass with a non-allowlisted field and ensure rejection.
- [ ] Register a test app and verify the post-step checklist appears correctly.

## 3. Out-of-Scope (Phase 4+)
- [ ] Editing Linear, owners, and integrations (deferred to post-registration edits).
- [ ] Hard deletion of applications.

## 4. Open Questions / Decisions
- Should `cc-register-app` automatically generate placeholder integrations or owners records? (Recommendation: Leave them empty and defer to future "Edit" features for those sections).

## 5. Assumptions
- Assume `v_command_center_home` correctly filters out soft-deleted apps (`deleted_at IS NULL`) so no UI filtering is needed for soft deletes.
