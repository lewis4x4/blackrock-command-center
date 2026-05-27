# P2 follow-up — Markdown renderer

Date: 2026-05-27

## Decision

Deferred Item 3 (`OperatorHandoffsPanel` markdown renderer) because replacing the current hand-rolled renderer with `marked` exceeded the requested bundle budget gate.

## Evidence

- Baseline after Batch 1/2 Vite build: combined JS+CSS gzip assets = **111,076 bytes**.
- Trial with `marked@18.0.4`: combined JS+CSS gzip assets = **126,458 bytes**.
- Delta: **+15,382 bytes gzip**, which is over the requested `>15kB gzip` stop threshold.

## Trial implementation notes

The trial used `marked` with:

- GFM enabled.
- HTML token rendering disabled.
- Image token rendering disabled.
- Link rendering constrained to `http:`, `https:`, `mailto:`, root-relative, and hash-relative URLs.
- `target="_blank" rel="noreferrer"` for rendered links.

The implementation built successfully, but was reverted because of the bundle delta.

## Recommended next options

1. Prefer a smaller markdown subset renderer that adds links/ordered lists/code fences without a full parser dependency.
2. If richer markdown is still needed, lazy-load the renderer only on the Agents route/operator handoff panel and add a route-level bundle budget.
3. Keep the current escaped renderer until runbook authors have concrete formatting needs that justify the route cost.

## Effort estimate

- Small custom subset expansion: 1–2 hours plus fixture tests.
- Lazy-loaded `marked` route split: 2–4 hours plus bundle-budget verification.
- Full renderer migration with tests/fixtures: 4–6 hours.
