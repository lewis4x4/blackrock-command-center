# Performance Audit — 2026-05-27

Scope: frontend bundle/package deps, edge function performance, runner performance, query optimization. Stayed out of auth/CORS, `web/src/`, and migrations.

## P0

No in-lane P0 found.

## P1

### Fixed — Edge read payload CPU/bandwidth

- Files: `supabase/functions/cc-read-decisions/index.ts`, `supabase/functions/cc-read-home/index.ts`, `supabase/functions/cc-read-app-detail/index.ts`
- Finding: high-traffic read functions pretty-printed every JSON response with `JSON.stringify(body, null, 2)`, increasing response bytes and serialization work on the request path.
- Fix: compact JSON responses with `JSON.stringify(body)`.

### Fixed — `cc-read-app-detail` remote data-plane timeout

- File: `supabase/functions/cc-read-app-detail/index.ts`
- Finding: `cc_export_detail` remote RPC had no timeout; a slow or hanging app data plane could hold the edge invocation until platform timeout.
- Fix: added `AbortSignal.timeout(8000)` to match the decisions read path timeout behavior.

### Fixed — `cc-read-home` unbounded side reads

- File: `supabase/functions/cc-read-home/index.ts`
- Finding: home loaded registry flags, integrations, snapshots, and unresolved issues without constraining to apps shown by `v_command_center_home`; issues had no limit.
- Fix: derive app IDs from home rows, push `app_id in (...)` filters into related queries, and cap unresolved issues at 100 latest surfaced rows.
- Remaining risk: if the home UI eventually needs more than 100 unresolved issues, add pagination or aggregate counts rather than restoring an unbounded read.

### Fixed/Documented — `cc-read-decisions` read-path containment

- File: `supabase/functions/cc-read-decisions/index.ts`
- Finding: pending operator reviews were ordered but unbounded before being displayed as a compact list.
- Fix: capped pending operator reviews at the latest 100 rows while preserving exact answered/routed/snoozed suppression queries.
- Remaining P1: answer-key, issue-metadata, answered-send, and routed-send reads still need an exact bounded RPC/view keyed to the current decision refs. I did **not** cap those correctness-sensitive support sets because doing so can re-surface already handled decisions once history exceeds the cap.

### Fixed — Runner work-order cold-start serialization

- File: `runner/src/runner.ts`
- Finding: work-order setup serialized independent control-plane/workspace work before clone: create agent run → get GitHub installation id → create workspace.
- Fix: overlap those independent operations with `Promise.allSettled`, preserving workspace cleanup on partial failure.

### Fixed — Frontend unused direct BlackRock deps

- Files: `web/package.json`, `web/package-lock.json`
- Finding: source only directly imports `@blackrock-ai/agent-core`, but package metadata pulled `@blackrock-ai/agent-runtime`, `@blackrock-ai/agent-schema`, and `@blackrock-ai/agent-tools` as top-level frontend deps. `agent-core` still brings its required transitive runtime/tools versions.
- Fix: removed the three unused direct deps from frontend package metadata.
- Build measurement before fix: `dist/assets/index-D-5LzcCG.js` 354.65 kB / gzip 101.29 kB.
- Remaining risk: bundle remains above the earlier ~90 kB gzip baseline because `agent-core` is still directly used in `web/src`; further reduction likely requires Frontend-lane lazy loading or replacing browser imports.

## P2 / documented only

- `supabase/functions/cc-read-all-decisions/index.ts` appears to do full-table paginated reads plus in-memory joins. Not changed because it was outside the requested high-traffic focus and may need a product/export contract decision.
- `runner/src/runner.ts` idle polling still does priority-ordered sequential claim RPCs. A true fix needs a new single server-side claim RPC, which is a Database/API contract change and out of this lane.
- `runner/src/workspace.ts` could add `git clone --single-branch --filter=blob:none`; left as P2 because behavior with every target repo should be validated before changing clone semantics.
- `web/vite.config.ts` could add manual chunks for bundle visibility/cache behavior, but without `web/src` lazy imports it would not materially reduce initial bytes.
- Potential Database-agent follow-up: add/confirm indexes for unresolved issue reads and decision suppression lookups, e.g. partial indexes on active `cc_issues` query paths and `(app_id, decision_external_ref)` for non-deleted answers/sends.

## Verification log

- PASS: `deno check supabase/functions/cc-read-decisions/index.ts supabase/functions/cc-read-home/index.ts supabase/functions/cc-read-app-detail/index.ts`
- PASS: `cd web && bun run build`
  - Current working-tree output: `dist/assets/index-DDeGHAVV.js` 357.27 kB / gzip 101.93 kB; CSS 51.92 kB / gzip 9.11 kB.
- PASS: `cd runner && bun test` — 18 pass / 0 fail.
- DEPLOYED: `supabase functions deploy cc-read-decisions cc-read-home cc-read-app-detail`
  - Project: `gsvhuzpysxaegoecwjmf`
  - Functions: `cc-read-decisions`, `cc-read-home`, `cc-read-app-detail`
