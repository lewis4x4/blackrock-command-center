# Frontend P2 Plan — 2026-05-27

Source audits: `docs/designs/AUDIT_FRONTEND_2026-05-27.md`, `docs/designs/AUDIT_SECURITY_2026-05-27.md`.

Lane: cleanup of the 8 frontend P2 items surfaced after yesterday's post-build audit. **Planning document only — no code changes in this lane.**

Verification performed while planning:
- Read both audit reports in full.
- Read each cited source file at the cited line ranges: `web/src/Home.tsx`, `Decisions.tsx`, `Agents.tsx`, `SlideOver.tsx`, `DecisionRouteModal.tsx`, `lib.ts`, `utils.ts`, `App.tsx`, `index.css`, `index.html`, `package.json`.
- Read `netlify.toml` (because item 6 is about CSP, which is currently configured there, not in `index.html`).
- Searched for the F1 router (item 1's stated dependency). It has **not** landed — `App.tsx:16` still carries the comment "Tiny hash switch until F1's router lands".

---

## Item 1 — Home `Cell k="Blocked"` deep-link

**Audit pointer:** `web/src/Home.tsx` ~158

**Verified scope.** The portfolio strip renders `<Cell k="Blocked" v={String(blocked)} />` as a read-only number. It is not wrapped in a button, link, or `onClick` — there is no way to drill from "23 blocked" to "show me the 23 blocked items". The audit's prescription is to wire it to `/?blocked=all` (or equivalent query param) once the F1 router lands.

**Concrete scope (no code):**
1. Wait for F1's router to land. F1 will replace the hash-switch in `App.tsx` (`pageFromHash`, `hashForPage`, `navigate`).
2. Wrap the `Blocked` cell in a `<button>` (or `<a>`) that calls `navigate('apps')` with a query/route param such as `blocked=all`.
3. In `AppsView`, read the param at mount and pre-filter the apps list (or roadmap-counts sub-view) to apps with `roadmap_counts.blocked > 0`.
4. Keep the visual unchanged when not actionable (e.g. `blocked === 0` — render as plain `<Cell>`, no button affordance).
5. Add an `aria-label` like "Show 23 blocked roadmap items" so the deep-link is announced.

**Effort:** small (<30 min once F1 has shipped).

**Risk:** low. Pure addition; no existing behavior is replaced. The only failure mode is forgetting to handle `blocked === 0` (would render a dead button).

**Dependencies:** **blocked by F1 router**. Do not pre-build behind hash params — pre-building this and then re-doing it on F1 day is wasted work.

**Recommended ship slice:** pair with F1 router rollout (whoever owns F1 should pick this up as a 15-minute add-on so the new router gets exercised by a real deep-link out of the gate).

---

## Item 2 — `decisionCta()` exhaustive switch + type guard

**Audit pointer:** `web/src/Decisions.tsx` ~600 (actual line: 644)

**Verified scope.** The audit calls it a "switch with fallthrough cases" — it is actually an `if/else` chain returning string literals based on a stringly-typed `state: string | null` parameter. The function returns one of `'Review reply'`, `'Resend'`, or `'Send to client'`. Same shape repeats in `decisionOptionsCopy` (line 650) and `stateLabel`/`stateBadgeTone` above it. The root issue the audit is pointing at is real: `state` is a string, not a discriminated union, so the TS compiler cannot catch a missed case when we add a new email state.

**Concrete scope (no code):**
1. Define a named union type `DecisionEmailState = 'unrouted' | 'routed' | 'link_clicked' | 'awaiting_operator_confirm' | 'answered' | 'expired' | 'paused' | 'snoozed'` (these are the states already listed in `decisionEmailState()` at line 593).
2. Change `decisionEmailState()` return type from `string | null` to `DecisionEmailState | null` and tighten the function so unrecognized inputs return `null` rather than the raw lowercased string.
3. Convert `decisionCta`, `decisionOptionsCopy`, `stateLabel`, and `stateBadgeTone` to `switch (state)` blocks over the new union, with a `default` branch that calls a shared `assertNever(state)` helper for compile-time exhaustiveness.
4. Add the `assertNever` helper either inline in `Decisions.tsx` or — preferred — in `utils.ts` so future surfaces can reuse it.

**Effort:** medium (45–75 min). The type tightening cascades into a handful of call sites because `state` is also used in JSX (`state-badge-{stateBadgeTone(state)}`) — each call site needs to handle the new `null` branch.

**Risk:** medium. Touches the decision-routing CTA copy that operators see all day. A bad union (missing a value the backend actually emits) would silently render a fallback CTA in production. Mitigation: grep `decisionEmailState`/`email_state`/`routing_state` in `web/src` and in `supabase/functions/cc-read-decisions/index.ts` and `cc-route-decision/index.ts` to confirm the union matches what the backend can return today.

**Dependencies:** none for ship; the `assertNever` helper added here is reused by item 7's hook if it needs error states.

**Recommended ship slice:** Batch 2 (with item 7). Both are type-safety/infra refactors; testing them together is one cycle instead of two.

---

## Item 3 — Replace hand-rolled markdown renderer with `marked` / `markdown-it`

**Audit pointer:** `web/src/Agents.tsx` (specifically `renderRunbookMarkdown` at line 488, used at line 298)

**Verified scope.** `OperatorHandoffsPanel` runs handoff runbook bodies through `renderRunbookMarkdown` and injects the result via `dangerouslySetInnerHTML`. The current renderer:

- handles headings (`#`, `##`, `###`), unordered lists (`- `), paragraphs, inline `<code>`, and `**bold**`;
- does NOT handle ordered lists, links, code fences, blockquotes, tables, or images;
- DOES escape `&`, `<`, `>`, `"`, `'` correctly in `escapeMarkdownHtml` before applying inline rules, so XSS is currently mitigated for the supported subset.

The audit hedges with "once bundle budget allows" — meaning the swap is not urgent. `marked` is ~13 KB minified+gzipped; `markdown-it` is ~40 KB. Both are larger than the 30 lines of hand-rolled code today.

**Concrete scope (no code):**
1. Add `marked` (preferred — smaller; tree-shakeable) as a dependency.
2. Configure marked with safe defaults: disable HTML pass-through, use the built-in escaping, and lock to a small subset (headings, lists, code, emphasis, links) consistent with what runbook authors actually write.
3. Delete `renderRunbookMarkdown`, `inlineMarkdown`, and `escapeMarkdownHtml` from `Agents.tsx`.
4. Replace the `dangerouslySetInnerHTML` call with a `<HandoffRunbook markdown={handoff.runbook_md} />` component that calls `marked.parse()` and renders.
5. Add a basic test fixture for the runbook surface — at minimum, a snapshot of one real runbook from `036_cc_operator_handoffs.sql` seed data — so the upgrade is provably non-regressing.

**Effort:** large (>2 hrs). Bundle audit, dependency add, behavior verification across all runbook fixtures, and at least one passing test.

**Risk:** medium. `marked` defaults to permissive HTML; misconfigured, it would *widen* the XSS surface vs. the current hand-rolled escaper. The hand-rolled escaper is the safer-by-default option until the lib is locked down.

**Dependencies:** none, but bundle budget tracking should be in place. If a "bundle budget per route" check is wired into CI (it is not today), confirm this swap doesn't push the Agents route past its budget.

**Recommended ship slice:** Batch 4 (defer). The current renderer is functional, escaped, and small. Swap only when runbook authors actually need tables/links/code fences. Filing as P2-deferred is more honest than P2-now.

---

## Item 4 — Bump Vite/esbuild past the `bun audit` moderate advisories

**Audit pointer:** `web/package.json` (current `vite: ^5.4.2`); cross-referenced in `AUDIT_SECURITY_2026-05-27.md` "Dependency audit" section.

**Verified scope.** `bun audit` reports two moderate dev-tool advisories:
- `vite <= 6.4.1` — path traversal in optimized deps source-map handling.
- `esbuild <= 0.24.2` — dev server request exposure.

Both are dev-server-only. Production builds are unaffected. But shipping a known-vulnerable dev server to the team's laptops is still worth fixing.

**Concrete scope (no code):**
1. Bump `vite` from `^5.4.2` to `^5.4.21` (or latest patch in the 5.x line that resolves both advisories — verify with `bun audit` after upgrade).
2. `bun install` to refresh `bun.lock` (if `bun.lock` exists; otherwise `package-lock.json`).
3. Run `cd web && bun run build` to confirm Vite 5.4.21 still emits a clean build.
4. Run `cd web && bun audit` again to confirm zero advisories.

**Effort:** small (<15 min including audit re-run).

**Risk:** low. Patch-level bump within the same minor (5.4.2 → 5.4.21). Vite's changelog for 5.4.x has been bug-fix only.

**Dependencies:** none.

**Recommended ship slice:** Batch 1 (ship now). Dep bump is mechanical and shippable in isolation.

---

## Item 5 — Memoize `writeHeaders()` at module load

**Audit pointer:** `web/src/lib.ts` ~685

**Verified scope.** `writeHeaders()` (lib.ts:684–687) reads `import.meta.env.VITE_CC_WRITE_TOKEN` on every call. The sibling `READ_TOKEN` and `ACCESS_REQUIRED` are already module-level constants in `utils.ts` (lines 8–9). `WRITE_TOKEN` should live there too. `readHeaders()` (lib.ts:679–683) already uses the module-level `READ_TOKEN`, so the asymmetry is the bug.

**Concrete scope (no code):**
1. Add `export const WRITE_TOKEN = import.meta.env.VITE_CC_WRITE_TOKEN ?? '';` to `utils.ts` next to `READ_TOKEN`.
2. Import `WRITE_TOKEN` in `lib.ts` and change `writeHeaders()` body to use the module-level constant instead of re-reading `import.meta.env` per call.
3. (No type changes needed — `VITE_CC_WRITE_TOKEN` is already declared in `vite-env.d.ts`.)

**Effort:** small (<15 min).

**Risk:** low. Behavior-identical — `import.meta.env` is resolved at build time, so module-level read = per-call read.

**Dependencies:** none.

**Recommended ship slice:** Batch 1 (ship now). Trivial tidy that closes the symmetry with `READ_TOKEN`.

---

## Item 6 — Tighten CSP: remove `'unsafe-inline'` from `style-src`, add nonce strategy

**Audit pointer:** `web/index.html` (audit claim: "No CSP `script-src` nonce")

**Verified scope.** The audit's framing is partially incorrect: `web/index.html` is intentionally a thin SPA shell with no CSP `<meta>` tag, but CSP IS configured at the edge in `netlify.toml`. Current policy:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self' https://*.supabase.co https://*.cloudflareaccess.com;
font-src 'self';
frame-ancestors 'none';
```

- `script-src 'self'` already has **no** `'unsafe-inline'` — the script-src side of the audit's recommendation is already done.
- `style-src` does still allow `'unsafe-inline'`. This is non-trivial to remove because the codebase uses inline `style={{}}` props heavily in `App.tsx` (skeleton sizing, error button padding — itself a P2 in yesterday's frontend audit), `Files.tsx`, and elsewhere.

So the real work is two coupled changes: (a) eliminate inline `style` props or move them to nonced `<style>` blocks, and (b) tighten `netlify.toml`'s `style-src`.

**Concrete scope (no code):**
1. Inventory pass: list every `style={{...}}` JSX prop across `web/src` (audit already flagged `App.tsx:156,168,179,201` and `Files.tsx:377,413` as the largest concentrations).
2. Migrate each one to a CSS class in `index.css` (e.g. `.skeleton-hero`, `.skeleton-band-row`, `.err-action`). This is also P2 from the frontend audit — same change, satisfies both.
3. Once `style={{}}` is gone from React render output, tighten `netlify.toml` `style-src` from `'self' 'unsafe-inline'` to `'self'`.
4. **Do not** add nonces. Nonces in a Vite + Netlify static deploy require either a build-time injector or an edge function to rewrite responses. The simpler, more durable path is "no inline styles at all", which is also better for caching.
5. After tightening, run the site in production mode (`vite preview` with Netlify-equivalent headers) and click through every page; any CSP violation will show in DevTools console.

**Effort:** medium (60–90 min — the inline-style migration is the bulk; the toml change is 30 seconds).

**Risk:** medium. CSP violations are silent in `tsc` and `vite build`; they only show at runtime. If a single inline style is missed, the affected element renders unstyled in production. Mitigation: manual pass through every page after the change, plus a CSP report-uri (or `report-to`) header to catch anything missed.

**Dependencies:**
- Soft dependency on item 8 (CSS tokens). If item 8 lands first, the inline `style={{ height: 230 }}` skeleton sizes get a natural home as `.skel-hero` classes.
- Independent of F1 router.

**Recommended ship slice:** Batch 3 or its own batch. **Do not** pair with item 1's router work — these are unrelated and the CSP change is risky enough to ship on its own.

---

## Item 7 — Extract `useFocusTrap()` hook

**Audit pointer:** `web/src/SlideOver.tsx` (and `web/src/DecisionRouteModal.tsx`)

**Verified scope.** I diffed the two implementations:

- `SlideOver.tsx` lines 21–71: focus-trap effect.
- `DecisionRouteModal.tsx` lines 100–151: near-identical focus-trap effect.

The differences are cosmetic:
- `SlideOver` attaches to `document`; `DecisionRouteModal` attaches to `window`. Either works; `document` is fine for both.
- `SlideOver`'s ref is `panelRef`; `DecisionRouteModal`'s is `modalRef`. Hook will take a generic `ref` parameter.
- Body-scroll lock and focus restore are otherwise identical.

This is a textbook hook extraction.

**Concrete scope (no code):**
1. Create `web/src/hooks/useFocusTrap.ts` (or `web/src/useFocusTrap.ts` to match the flat existing structure — pick one based on what already lives in `web/src`; today everything is flat).
2. Hook signature (pseudocode): `useFocusTrap({ active: boolean, containerRef: React.RefObject<HTMLElement>, onEscape: () => void }): void`.
3. Hook body: the existing effect — capture `document.activeElement`, attach `keydown` listener for Tab/Shift-Tab cycling and Escape, lock `body.overflow`, focus first focusable on mount, restore on unmount.
4. Refactor `SlideOver.tsx` to delete the inline effect and call `useFocusTrap({ active: open, containerRef: panelRef, onEscape: onClose })`.
5. Refactor `DecisionRouteModal.tsx` to do the same with `modalRef`.
6. Add a smoke test (or at minimum a comment block) that documents the keyboard contract: Tab cycles forward, Shift+Tab cycles backward, Escape closes, body scroll is locked while open, focus restores to opener on close.

**Effort:** medium (75–120 min, mostly because both modals are accessibility-critical and need manual keyboard verification — focus restore is the easiest thing to break).

**Risk:** medium. Focus trap regressions are user-hostile: a broken trap means a Tab key press can land focus on the page behind the modal, which is exactly what P0 fixed yesterday. Mitigation: keyboard-test both modals (open via demo data, Tab through, Escape, click backdrop, verify focus restoration) before merging.

**Dependencies:** none.

**Recommended ship slice:** Batch 2 (with item 2). Both touch shared infra; reviewing the keyboard contract once for the hook lets you stop re-reviewing per-modal forever.

---

## Item 8 — Move inline hex colors to CSS custom properties at `:root`

**Audit pointer:** `web/src/index.css` (lines 46, 139–141, 402–403 — there are more)

**Verified scope.** `:root` (index.css:5–13) already defines a primary palette: `--red`, `--amber`, `--blue`, `--green`, `--grey`, plus text/surface tokens. The problem is **lifted foreground/chip variants**:

- `#FF8092` (light red) appears at lines 46, 139, 402, 403 — used for danger chips, error icons, failed run cards.
- `#FFC061` (light amber) appears at lines 140, 402, 403 — used for warning chips, gated work-order chips, authorize-tier risk chips.
- `#82BCF7` (light blue) appears at lines 141, 402, 403 — used for info chips, viewed-state badges.
- `#67E0A6` (light green) appears at lines 402, 403 — used for success/auto chips, undo banners.

These four colors recur 10+ times each across component-specific selectors. They are essentially un-named tone tokens.

**Concrete scope (no code):**
1. Add four lifted-tone tokens at `:root` next to the existing primary palette. Names per audit suggestion: `--tone-danger-fg`, `--tone-progress-fg`, `--tone-good-fg`, `--tone-human-fg` (or simpler `--red-fg`, `--amber-fg`, `--blue-fg`, `--green-fg` — pick one naming convention consistent with the rest of the file).
2. Also add the matching transparent-fill tokens (`rgba(255,92,115,.14)` etc.) as `--tone-danger-bg`, `--tone-progress-bg`, etc. — these are even more repeated than the hex foregrounds.
3. Find-and-replace each literal hex/`rgba` in `index.css` with the new tokens. Audit-cited lines are a starting point but not exhaustive — a literal `grep -E '#FF8092|#FFC061|#82BCF7|#67E0A6'` over `index.css` will catch the long tail.
4. (Optional, deferable) Also expose `--tone-*` tokens for any inline `<svg stroke="...">` in `Home.tsx:55-61,79` — but the audit lists that nav-icon work as a separate item ("switch icons to `currentColor`"). Stay scoped: only touch `index.css` here.
5. After substitution, do a quick visual diff (DevTools side-by-side or screenshot pair) on Decisions, Agents, Home, and Settings pages — any miss will be visible.

**Effort:** medium (60–90 min — mostly the grep-and-substitute work in `index.css`, plus visual verification).

**Risk:** low. Pure substitution; the rendered color values are identical. The only failure mode is a typo'd variable name producing `var(--tone-dander-fg)` which renders as the inherited `color` — caught immediately in a visual pass.

**Dependencies:** none for ship. Soft enabler for item 6 (some inline `style={{ color: '#FF8092' }}` props could become classes that reference these new tokens).

**Recommended ship slice:** Batch 1 (ship now). Pure CSS, no behavior change, no JS touched.

---

## Recommended sequencing

**Batch 1 — ship this week (~75 min total, low risk).** Items 4, 5, 8.
- Item 4 (vite bump): mechanical dep upgrade.
- Item 5 (`writeHeaders` memoize): symmetric tidy, completes `READ_TOKEN`/`WRITE_TOKEN` parity.
- Item 8 (CSS tokens): pure substitution in one file, sets up later naming consistency.
- Justification: zero behavior change, no shared infra, no review entanglement, no F1 dependency. Three small wins in one PR.

**Batch 2 — ship next sprint (~2–3 hrs, medium risk).** Items 2, 7.
- Item 7 (`useFocusTrap` hook): shared modal infra extraction.
- Item 2 (decisionCta exhaustive switch): introduces `assertNever` helper.
- Justification: both are type-safety / shared-infra refactors. Single review cycle. Both require keyboard or compile-time verification rather than a visual smoke test.

**Batch 3 — pair with F1 router (~30 min add-on, low risk).** Item 1.
- Justification: hard dependency on F1. Pre-building behind hash params would be wasted work. Filed as "F1 follow-on" rather than its own batch.

**Batch 4 — defer until pressured (~3 hrs, medium risk).** Item 3.
- Justification: the audit itself says "once bundle budget allows". The hand-rolled renderer is XSS-escaped and functional. Swap when runbook authors need richer markdown (tables, links, code fences), not before.

**Batch 5 — dedicated CSP lane (~90 min, medium risk).** Item 6.
- Justification: the audit's framing of "add nonce + remove unsafe-inline" is partially incorrect because (a) CSP already exists in `netlify.toml`, (b) `script-src` already has no `'unsafe-inline'`, and (c) the real work is migrating inline `style={{}}` props before tightening `style-src`. CSP violations are runtime-only — they will not show in `tsc`/`vite build`. Ship this in isolation with manual smoke testing on `vite preview`.

---

## What I might be wrong about

**1. Item 5 might be premature optimization.** `writeHeaders()` is called per HTTP mutation (a few times per minute at most), not per render. Re-reading `import.meta.env.VITE_CC_WRITE_TOKEN` per call costs nanoseconds because Vite resolves `import.meta.env.*` at build time — there's no runtime env lookup, it's a literal-folded string. So the performance argument is essentially zero. The audit is right that the asymmetry with `READ_TOKEN` is ugly, but framing this as "memoize for perf" overstates the win. I am still recommending Batch 1 because the change is free and improves symmetry, not because performance demands it. **Revised framing in plan above: this is a tidy, not a perf fix.**

**2. Item 3 might be the wrong call to defer.** The hand-rolled markdown renderer in `Agents.tsx` doesn't support links. Operator runbooks routinely want to link to runbook docs, dashboards, or Supabase function URLs. If runbook authors are already working around this by pasting bare URLs (which currently render as plain text), the swap is more urgent than the audit implies. I'm holding the defer recommendation because there is no evidence today that authors are blocked, but if `036_cc_operator_handoffs.sql` seed data or live runbooks contain markdown link syntax that's rendering as literal `[text](url)` to operators, **flip this to Batch 2 immediately**. Worth a 60-second `grep -E '\[.*\]\(' supabase/migrations/036_*.sql` to confirm.

**3. Item 6's scope as I've written it is larger than the audit's wording.** The audit says "add nonce + remove `'unsafe-inline'`". I've expanded that into "migrate inline `style={{}}` first, then tighten". The audit author may have meant the simpler nonce-injection path. Tradeoff: nonces require a Vite/Netlify integration (custom plugin or edge function) and re-introduce a per-page CSP header rewrite; the no-inline-styles path is durable but more code churn. I am betting on the latter because the codebase already has the inline-styles migration as a separate P2 item — folding the two together is cheaper than doing them sequentially. If team consensus is "ship nonce now, migrate later", flip the plan: keep `style-src 'unsafe-inline'`, add `'nonce-XXX'` via a Vite plugin like `@vitejs/plugin-react-swc`'s nonce hook, and treat inline-style elimination as a separate future cleanup.

**4. Item 2's union type is only as good as the backend.** The list of email states in `decisionEmailState()` comes from the audit-of-Decisions.tsx surface. The real source of truth is whatever string `cc-read-decisions` and `cc-route-decision` write into `email_state` / `routing_state` / `decision_email_state`. If the backend can emit a state the union doesn't include, the new `assertNever` branch will crash the page. Before merging item 2, **must** grep the edge functions for every value written to those columns. Cheap to do but easy to forget.

---

**Honest "ship now vs defer" call:**

- **Ship now (Batch 1):** items 4, 5, 8 — three quick wins, no risk.
- **Ship next (Batch 2):** items 2, 7 — real value, low risk if reviewed together.
- **Wait on F1 (Batch 3):** item 1.
- **Defer (Batch 4):** item 3, unless the link-syntax check above flips it.
- **Schedule separately (Batch 5):** item 6 — bigger than the audit implied, ship in its own PR with explicit production smoke testing.
