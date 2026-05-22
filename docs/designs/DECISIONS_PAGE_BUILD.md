# Decisions Page Build Plan

## 1. Summary
This slice ships the fully functional Decisions inbox, providing a cross-app view of all open decisions and a history of recently answered ones. It introduces a new `cc-read-decisions` fan-out endpoint that aggregates decision data directly from each client app's `cc_export_detail('decisions')` endpoint, ensuring the control plane remains stateless regarding item-level details. The UI provides filtering by app, owner, and age, reusing the existing `OpenDecisionsPanel` logic for the slide-over view. This slice explicitly does not include Phase 5 features such as client email routing, inbound reply parsing, or the final "route to client" wiring, allowing operators to fully clear the queue today while deferring client self-service to a later phase.

## 2. Phased Checklist

### Backend
- [ ] Create new `supabase/functions/cc-read-decisions/index.ts` edge function.
- [ ] Implement endpoint contract: `GET /functions/v1/cc-read-decisions` accepting query params `app_id`, `owner_kind`, `max_age_days`, `limit`, `cursor`.
- [ ] Re-use the auth and key resolution patterns from `cc-read-app-detail` (`supabase/functions/cc-read-app-detail/index.ts:243-335`). *Extract the shared bits into a common helper if it can be done without disturbing the existing function.*
- [ ] Implement server-side parallel fan-out (`Promise.all` with individual `catch`) to all active registered apps to call their `cc_export_detail('decisions')` function.
- [ ] Handle partial failures gracefully so one unreachable app does not blank the entire register.
- [ ] Format the response envelope to match the `cc-read-agents` pattern (`supabase/functions/cc-read-agents/index.ts:292-318`):
  - `apps_reached`: count or list of successfully queried apps.
  - `apps_unreachable`: list of apps that timed out or threw 500s.
  - `apps_unwired`: list of apps returning 503 `detail_contract_unavailable` (like QEP currently).
  - `decisions`: flattened array `[{app_id, app_short_code, app_display_name, ...decision_row_fields}]`.
  - `answered_recent`: most recent answered decisions joined from `cc_decision_answers` and `registry_apps`.
  - `generated_at`: timestamp.
- [ ] Write a `decisions_page_read` audit event per call.
- [ ] Deploy the function via Supabase CLI and verify functionality.

### Frontend types + helper
- [ ] In `web/src/lib.ts`, define `DecisionRow` type: cross-app shape with `app_id`, `app_short_code`, `app_display_name` + recommended fields as `Record<string, unknown>`.
- [ ] In `web/src/lib.ts`, define `DecisionsPayload` type matching the backend envelope.
- [ ] In `web/src/lib.ts`, define `AnsweredDecisionSummary` type for the recently answered section.
- [ ] In `web/src/lib.ts`, implement `loadDecisions(filters, demo)` helper function to call the new edge function.
- [ ] For demo mode, synthesize cross-app decisions by tagging items from `DEMO_APP_DETAIL.decisions.items` (`web/src/lib.ts:322-356`) with the four demo apps defined in `INITIAL_DEMO`.

### Frontend page
- [ ] Create `web/src/Decisions.tsx`.
- [ ] Implement header pattern matching `web/src/Agents.tsx:75-113` (eyebrow "Decisions inbox", h1, copy line, updated pill, refresh button, summary metrics for open count & by-owner breakdown).
- [ ] Implement filter row:
  - App dropdown (populated from the payload or a registry lookup).
  - Owner-kind chips (Operator / Client / Unknown).
  - Age chips (0-2d / 3-7d / 8+d).
  - Sort toggle (oldest first / newest first, defaulting to oldest).
- [ ] Implement the cards list view. Each card should display the app badge, decision title, owner, age, risk_class chip (read from row or default to 'authorize' per `web/src/TriagePanels.tsx:358-361`), and options preview.
- [ ] Wire card click to open a slide-over.
- [ ] In the slide-over, reuse `OpenDecisionsPanel` logic from `web/src/TriagePanels.tsx:21-72, 95-139, 323-408`. Refactor minimally to extract a `DecisionAnswerBody` component if it doesn't break the existing cockpit view.
- [ ] Add a "Route to client" button on client-owned cards that triggers `alert('Routing decisions to clients arrives in Phase 5.')`.
- [ ] Implement the empty state: "No open decisions. Every registered app is unblocked right now." (Matches `web/src/Agents.tsx:292-318` empty state pattern).
- [ ] Implement the honest "apps not wired" / "apps unreachable" subnote at the bottom of the list based on the envelope payload.
- [ ] (Optional slot) Implement a second band for "Recently answered" showing the most recent N rows from `cc_decision_answers`.

### Routing + nav
- [ ] In `web/src/Home.tsx`, extend `ShellPage` union type with `'decisions'` (`web/src/Home.tsx:34`).
- [ ] In `web/src/App.tsx`, extend `pageFromHash()` and `hashForPage()` to handle `#/decisions` (`web/src/App.tsx:14-28, 92-107`).
- [ ] In `web/src/App.tsx`, add the render branch for `page === 'decisions'` mounting the `<Decisions />` component.
- [ ] In `web/src/App.tsx`, update the topbar title to include "Decisions" when active.
- [ ] In `web/src/Home.tsx`, remove the `soon` badge from the Decisions nav item and wire the click to set `location.hash = '#/decisions'` (`web/src/Home.tsx:78-91`).

### Audit Lately mapping
- [ ] In `supabase/functions/cc-read-audit/index.ts`, map the `decisions_page_read` event to be hidden from Lately (matching the pattern used for `agents_page_read`, `detail_read`, `secret_read`).

### Verification gate
- [ ] Run `npm run build` in `/web` and ensure it passes.
- [ ] Run `deno check` (or equivalent Deno lint/typecheck command) for the new edge function and ensure it passes.
- [ ] Perform a live smoke test against the deployed control plane: hit `cc-read-decisions`, expecting `apps_unwired: [{short_code:'QEP', reason:'detail_contract_unavailable'}]` and `decisions: []` as the correct honest state for QEP before the handoff.
- [ ] Perform manual UX check in dev mode: `/decisions` in demo mode shows synthesized rows; live mode shows the honest "apps not yet wired" state and correct styling.

## 3. Out-of-Scope (Phase 5)
- [ ] Resend integration, MJML email templates, and sending domain configuration (Later slice).
- [ ] Magic-link confirmation page for client decisions (Later slice).
- [ ] Inbound reply parsing to operator confirm queue (Later slice).
- [ ] Creation of the `cc_decision_email_sends` table (Later slice).
- [ ] The actual `route_to_client` dispatch wiring (Later slice).

## 4. Open Questions / Decisions
- Should the `cc-read-decisions` internal fan-out limit the number of parallel requests to prevent timeouts or resource exhaustion if the registry grows significantly? (Recommendation: Start with unbounded `Promise.all` and monitor, or implement a basic chunked concurrency limit if we know the registry will exceed ~50 apps soon).

## 5. Assumptions
- Assume the "Recently answered" section fetches a fixed limit (e.g., 20) of the most recent answers across all apps globally, since the spec doesn't specify pagination for the history band.
- Assume the extraction of auth/key resolution logic from `cc-read-app-detail` is straightforward enough to not require a separate refactoring PR first. If it is highly entangled, the implementer may choose to duplicate it temporarily for this slice.
- Assume that a decision row missing the `risk_class` field should always default to `'authorize'` for UI representation, mirroring current operator cockpit behavior.
