# Frontend audit — 2026-05-27

Scope audited: `web/src/`, `web/vite.config.ts`, `web/package.json`, `web/index.html`, `web/tsconfig.json`.

Design basis: `docs/COMMAND_CENTER_MASTER_PLAN.md` §1 and §5: resolution stays in-place, mobile must keep the operator in the loop, slide-overs are core workflow surfaces, and every page/list needs honest loading/error/empty behavior.

Verification: `cd web && bun run build` ✅

## P0 fixes implemented

- `web/src/Home.tsx`, `web/src/index.css` — Added a mobile bottom tab bar and shared nav item model.
  - Why: at mobile widths the left rail was `display:none`, leaving a 380px operator without in-app navigation to Decisions, Agents, Apps, Files, Workspace, or Settings. That broke the master-plan mobile requirement and stranded resolution/browse flows.
  - What changed: added an accessible fixed bottom tab bar with ≥44px targets, `aria-current`, and enough bottom content padding to prevent overlap.

- `web/src/SlideOver.tsx` — Added focus entry, focus trap, focus restoration, Escape close handling, and scroll lock to the shared resolution slide-over.
  - Why: resolution panels are the heart of the loop; keyboard focus could escape behind the modal, which is an accessibility blocker for the primary workflow.
  - What changed: the panel now captures focus on open, cycles Tab/Shift+Tab inside the panel, restores the opener on close, and keeps background scroll locked.

- `web/src/DecisionRouteModal.tsx` — Added equivalent modal focus management and body scroll lock for the decision-routing modal.
  - Why: routing a client-owned decision is a modal workflow; keyboard focus could leave the dialog and interact with the covered page.
  - What changed: the route dialog now traps focus, restores focus on close, closes via Escape, and prevents background scrolling.

## P1 fixes implemented

- `web/src/Decisions.tsx`, `web/src/index.css` — Removed nested interactive controls in `DecisionCard`.
  - Why: the card rendered a `<button>` inside another `<button>`, which causes invalid DOM and React/browser console warnings in normal use.
  - What changed: kept the whole card as the single semantic button and rendered the CTA as styled non-interactive text inside it.

- `web/src/Files.tsx`, `web/src/index.css` — Converted file rows from `div role="button"` to native buttons.
  - Why: artifact rows are interactive controls; native buttons provide correct keyboard activation and semantics without custom key handling.
  - What changed: replaced the row wrapper control with `<button type="button">` and reset CSS so the grid layout is unchanged.

- `web/src/Settings.tsx` — Improved keyboard handling and announcement for decision-admin rows.
  - Why: rows were clickable and Enter-enabled but not announced as interactive; Space also did nothing.
  - What changed: added `role="button"`, an explicit `aria-label`, and Space/Enter activation.

- `web/src/DecisionRouteModal.tsx` — Replaced a normal-flow `console.warn` with a user-visible warning.
  - Why: recipient-loading failures are expected operational errors and should appear in the UI, not only in DevTools.
  - What changed: recipient load failures now display as a non-fatal panel note while preserving the rest of the route review flow.

- `web/src/lib.ts`, `web/src/vite-env.d.ts` — Removed the `import.meta as any` escape for `VITE_CC_WRITE_TOKEN`.
  - Why: strict TypeScript forbids `any`; the write token env var was missing from `ImportMetaEnv`.
  - What changed: typed `VITE_CC_WRITE_TOKEN` and read it directly through `import.meta.env`.

## P2 documented

- `web/src/lib.ts:1` — `lib.ts` is 2,640 LOC and mixes demo data, parsing, API transport, business helpers, and mutation calls.
  - Suggested fix: split into `api/transport.ts`, `api/parsers.ts`, `api/demoData.ts`, and feature-specific clients after behavior is better covered by tests.

- `web/src/Decisions.tsx:1`, `web/src/Home.tsx:1`, `web/src/Settings.tsx:1`, `web/src/Agents.tsx:1`, `web/src/Apps.tsx:1`, `web/src/Files.tsx:1`, `web/src/TriagePanels.tsx:1` — multiple components exceed 300 LOC and carry several concerns.
  - Suggested fix: extract bands, row/card components, and data hooks incrementally; do not do a broad split without regression coverage.

- `web/src/index.css:46`, `web/src/index.css:139`, `web/src/index.css:140`, `web/src/index.css:141`, `web/src/index.css:402`, `web/src/index.css:403` — many semantic colors are hard-coded as hex/literal rgba instead of derived from named design tokens.
  - Suggested fix: introduce semantic token variables (`--tone-danger-*`, `--tone-human-*`, `--tone-progress-*`, `--tone-good-*`) and migrate per surface.

- `web/src/Home.tsx:55`, `web/src/Home.tsx:56`, `web/src/Home.tsx:57`, `web/src/Home.tsx:58`, `web/src/Home.tsx:59`, `web/src/Home.tsx:60`, `web/src/Home.tsx:61`, `web/src/Home.tsx:79` — nav SVGs hard-code stroke/fill colors.
  - Suggested fix: switch icons to `currentColor` and let `.nav-item` / `.mobile-tab` own color state.

- `web/src/utils.ts:34` — per-app badge colors live in TypeScript (`APP_COLOR`), while the plan says to move app badge colors into CSS tokens.
  - Suggested fix: define app color CSS custom properties and map app codes to classes/data attributes.

- `web/src/Agents.tsx:298` — handoff runbooks use `dangerouslySetInnerHTML` from a custom markdown renderer.
  - Suggested fix: replace with a small React renderer or add focused tests around the escaping/allowed-markdown subset before expanding runbook formatting.

- `web/src/App.tsx:66`, `web/src/AppDetail.tsx:44`, `web/src/Agents.tsx:52`, `web/src/Decisions.tsx:69`, `web/src/Files.tsx:261`, `web/src/Settings.tsx:83`, `web/src/TriagePanels.tsx:54` — several effects suppress `react-hooks/exhaustive-deps`.
  - Suggested fix: convert load/refresh functions to stable callbacks or isolate effect-only loader functions, one component at a time, to reduce stale-closure risk.

- `web/src/Files.tsx:91`, `web/src/Files.tsx:322`, `web/src/Files.tsx:328`, `web/src/TriagePanels.tsx:408`, `web/src/lib.ts:990`, `web/src/lib.ts:1110`, `web/src/lib.ts:2113`, `web/src/lib.ts:2189` — some `as` casts are valid guarded casts, but they obscure type narrowing.
  - Suggested fix: introduce reusable type guard helpers (`isArtifactKind`, `isArtifactSource`, `isRiskClass`) and use them in parsers and select handlers.

- `web/src/App.tsx:156`, `web/src/App.tsx:168`, `web/src/App.tsx:179`, `web/src/App.tsx:201`, `web/src/Files.tsx:377`, `web/src/Files.tsx:413` — repeated inline styles for skeleton and error button sizing bypass the spacing/button primitives.
  - Suggested fix: add reusable skeleton/error-state classes and standard button sizing modifiers.
