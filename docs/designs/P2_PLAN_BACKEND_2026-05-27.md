# Backend P2 Fix Plan — 2026-05-27

**Status:** Planning only. No code, no migrations authored here.
**Source audits:** `AUDIT_SECURITY_2026-05-27.md`, `AUDIT_PERFORMANCE_2026-05-27.md`, `AUDIT_DATABASE_2026-05-27.md`.
**Scope:** 6 backend P2 items identified after yesterday's post-build audit.

---

## Notes from scope verification

Before drafting per-item plans, I verified each audit reference against the live source. Two callouts:

1. **Item 2 location mismatch.** The audit attributes "Aggregator polling iterates serially across apps" to `cc-read-home/index.ts ~120`, but `cc-read-home` already wraps its side-reads in `Promise.all` (lines ~205). The actual serial-across-apps loop is in `aggregator/index.ts` lines ~169–225 (`for (const app of apps)`). The plan treats the fix as belonging to `aggregator/index.ts` and flags this in self-critique.
2. **Item 4 sibling count.** The audit says "5 functions still duplicate" the CORS allow-headers, but `file_search` on `Access-Control-Allow-Headers` returned **15** edge functions with locally-defined `corsHeaders` (plus `_shared/phase5.ts` itself). The migration covers all 15 across three header-shape classes.

Next available migration number is **053** (highest existing is `052_audit_database_fixes.sql`).

---

## Item 1 — Move decisions suppression to server-side RPC

**File / anchor:** `supabase/functions/cc-read-decisions/index.ts` lines ~423–475 (the `Promise.all` that fetches `answeredKeyRows`, `answeredSendRows`, `routedSendRows`) and lines ~593–617 (the `answeredKeys` / `routedKeys` Set construction).

### Concrete scope

Three suppression queries today run unbounded:

| Variable | PostgREST shape | Bound |
|---|---|---|
| `answeredKeyRows` | `cc_decision_answers?...&app_id=in.(${appIdFilter})&deleted_at=is.null` | none — grows with all-time answer history |
| `answeredSendRows` | `cc_decision_email_sends?...&decision_answer_id=not.is.null` | none AND missing `app_id` filter (cross-tenant scan) |
| `routedSendRows` | `cc_decision_email_sends?...&app_id=in.(${appIdFilter})&state=in.(...)` | none |

These exist solely to build two `Set<"${app_id}::${decision_external_ref}">` lookup keys used to suppress already-handled rows from the federated decision fanout.

**Proposed shape:**

1. New SECURITY DEFINER RPC `cc_decisions_page_suppression(p_refs jsonb)` where `p_refs` is `[{"app_id":"…","decision_external_ref":"…"}, …]` — exactly the (app_id, decision_external_ref) pairs returned by the federated fanout.
2. RPC returns one row per input pair with the merged suppression view:
   ```
   app_id           uuid
   decision_ref     text
   answered         boolean   -- exists in cc_decision_answers OR a send with non-null decision_answer_id
   routed_active    boolean   -- exists in cc_decision_email_sends with awaiting-reply state
   created_via      text      -- "manual" | "auto_route" | null  (for the matched send)
   issue_id         uuid
   issue_status     text
   ```
3. `cc-read-decisions` reorders its work to:
   1. Fan out to apps (existing) → collect decision pairs.
   2. Call the new RPC with that bounded pair list.
   3. Merge the result into `answeredKeys` / `routedKeys` Sets.
   4. Continue with existing filtering/title-lookup logic.
4. The `answer-key`, `answered-send`, and `routed-send` raw cpGet calls disappear. The `cc_issues?…issue_type=eq.open_decision` issue-metadata read remains (it's the issueByDecisionRef map, which is needed for `cc_issue_status` enrichment and could be folded into the same RPC in a follow-up).
5. The `routed_recent` band (top 20) is a separate concern — it needs the full send rows for display, not just a flag. Keep that as a small bounded read (`order=updated_at.desc&limit=20`) or fold into the same RPC with `p_recent_limit`.

Pseudocode in the edge function (after fanout completes):

```
const refs = allDecisions.map(d => ({ app_id: d.app_id, decision_external_ref: d.id }));
const suppression = await cpRpc("cc_decisions_page_suppression", { p_refs: refs });
for (const row of suppression) {
  const key = `${row.app_id}::${row.decision_ref}`;
  if (row.answered) answeredKeys.add(key);
  if (row.routed_active) routedKeys.add(key);
}
```

### Effort

**Large.** RPC design + edge rewrite + careful regression testing. The reorder (fanout-then-suppress vs. parallel) is the architectural risk.

### Risk

**High.** This is the read-path contract for the Decisions page. Getting the suppression rule wrong re-surfaces handled decisions (operator confusion) or hides open ones (missed work). Specific regression risks:

- Decisions snoozed but unanswered: must not be suppressed by `routed_active`.
- Decisions where the operator manually took over an auto-route send (the `created_via=manual` takeover at line ~50 of `cc-route-decision`): the RPC must reflect the post-takeover state.
- Late-reply path: a send may exist in `replied` state with `decision_answer_id IS NULL`. Today this is handled implicitly by the `state=in.(…replied…)` filter on routedSendRows. The RPC must continue to count it.

Mitigation: ship the RPC, run it in **shadow mode** for one deploy cycle (compute both old + new suppression sets, audit any diff, but trust the old result) before flipping. The audit-event payload already logs counts; add a `suppression_v2_diff` field for the comparison.

### Migration needed?

**Yes.** Migration `053_phase6_decisions_suppression_rpc.sql`:

- Create `cc_decisions_page_suppression(p_refs jsonb, p_recent_limit int default 20) returns table(...)`.
- `SECURITY DEFINER`, `SET search_path = public, pg_catalog`.
- Grant `EXECUTE` to `service_role` only.
- Add `cc_decision_answers (app_id, decision_external_ref) WHERE deleted_at IS NULL` index if not already present (audit confirmed `cc_decision_answers_app_decision_ref_idx` exists — verify it covers this query plan).
- Add `cc_decision_email_sends (app_id, decision_external_ref) WHERE deleted_at IS NULL AND state IN (...active...)` partial index. Audit migration 052 added `cc_decision_email_sends_app_decision_ref_idx` — confirm it serves both `decision_answer_id IS NOT NULL` and `state IN (...)` filters.

### Deploy footprint

- `cc-read-decisions` redeploy.
- DB migration applied via `supabase db push --linked --include-all`.

### Backward compat

Server-side change behind the existing edge endpoint. Browser callers see the same `decisions`, `routed_recent`, `answered_recent`, `snoozed`, `pending_reviews` payload shape. The shadow-mode rollout keeps the old code path available for one deploy cycle in case of regression. **No frontend changes.**

---

## Item 2 — Parallelize aggregator polling across apps

**File / anchor (actual):** `supabase/functions/aggregator/index.ts` lines ~169–225 (`for (const app of apps) { … await pollApp(app); … }`).
**Audit-stated anchor:** `cc-read-home/index.ts ~120` — but cc-read-home is already parallel; see "Notes from scope verification" above.

### Concrete scope

Today the aggregator polls each app's `cc_export_snapshot()` sequentially. With QEP + SCC live and a 3rd app pending, total invocation time is `n × (poll + snapshot insert + audit + reconcile RPC)`. A slow tenant blocks all later tenants.

**Proposed shape:**

```
const results = await Promise.allSettled(apps.map(app => handleOneApp(app)));
```

Where `handleOneApp(app)` is the existing body of the loop (poll → insert snapshot → audit → reconcile). Each app's failure is already isolated to its own audit event; `allSettled` preserves the zero-blocking property explicitly.

Parallel ceiling consideration: with 3–5 apps the natural fan-out is fine. If app count grows past ~10, introduce a small concurrency limiter (e.g. `p-limit` semaphore at 5) to avoid hammering the control-plane PostgREST. **Don't add the limiter yet** — premature for current scale.

### Effort

**Small.** Mechanical refactor of one loop into a `Promise.allSettled` map. Extract the loop body into a named function for readability.

### Risk

**Low.** `cc_reconcile_app_issues` is per-app (one app's reconcile cannot conflict with another's). Snapshot inserts are per-app rows. Audit events are append-only. The only theoretical concern is the control-plane PostgREST connection pool — but 3–5 concurrent inserts is well within Supabase's default limits.

### Migration needed?

**No.**

### Deploy footprint

- `aggregator` redeploy only.

### Backward compat

None affected. Cron caller doesn't see anything different. Result ordering in the response JSON may change (today it's input order; with `allSettled` it's still input order, so this is preserved).

---

## Item 3 — Cache data-plane secrets in module scope

**File / anchor:** `supabase/functions/aggregator/index.ts` lines ~94–115 (`resolveDataPlaneKeys()`).

### Concrete scope

`CP_URL` and `CP_KEY` are already at module scope (lines 28–29) and are read once at cold start. The actual per-invocation env reads are the per-app data-plane secrets (`READ_KEY_<SHORTCODE>` / `SVC_KEY_<SHORTCODE>`) inside `resolveDataPlaneKeys()`:

```ts
const key = Deno.env.get(candidate.secretName);   // called per-app, per-invocation
```

**Proposed shape:** lazy module-scope Map cache populated on first lookup.

```
const dataPlaneKeyCache = new Map<string, string | null>();
function getDataPlaneSecret(name: string): string | null {
  if (dataPlaneKeyCache.has(name)) return dataPlaneKeyCache.get(name)!;
  const value = Deno.env.get(name) ?? null;
  dataPlaneKeyCache.set(name, value);
  return value;
}
```

Rotation behavior: secrets read once and cached for the lifetime of the container instance. When Brian rotates a secret via `supabase secrets set`, the new container will pick it up; existing warm containers continue using the cached value until the next cold start. This matches today's behavior for `CP_KEY` (already module-scope) and is acceptable for the data-plane keys.

The same pattern should apply to `cc-read-decisions/index.ts` `resolveDataPlaneKeys()` (lines ~193–215) — same logic duplicated. Best move: put `getDataPlaneSecret()` into `_shared/phase5.ts` once and import in both. (Pairs naturally with Item 4.)

### Effort

**Small.** ~20-line helper plus two call-site swaps.

### Risk

**Low**, with one tradeoff: a rotated secret won't be re-read until the container restarts. This is the same tradeoff the function already accepts for `SUPABASE_SERVICE_ROLE_KEY` (line 29). The "colder cold-start tradeoff" the audit mentions doesn't really apply if we use **lazy** caching (no eager pre-load). It would apply if we tried to eagerly enumerate every known secret at module init, which we should NOT do — we don't know which `READ_KEY_<SHORTCODE>` names exist until we read the registry.

### Migration needed?

**No.**

### Deploy footprint

- `aggregator` redeploy.
- `cc-read-decisions` redeploy (if we centralize the helper).
- Re-deploys to any other function that ends up importing the helper (none required initially).

### Backward compat

Internal-only. No client-visible change.

---

## Item 4 — Migrate functions to shared CORS headers

**File / anchor:** `supabase/functions/_shared/phase5.ts` lines 25–28 already exports a complete `corsHeaders` constant.

### Concrete scope

`file_search` on `Access-Control-Allow-Headers` shows **15** functions with locally-defined `corsHeaders` (audit said 5 — actual count is higher). Three header-shape classes:

| Class | Header set | Functions |
|---|---|---|
| Write-touching (5) | `Authorization, Content-Type, Cf-Access-Jwt-Assertion, x-cc-read-token, x-cc-write-token` | `cc-answer-issue`, `cc-approve-work-order`, `cc-dispatch-from-answer`, `cc-edit-app`, `cc-register-app` |
| Read-only (8) | `Authorization, Content-Type, Cf-Access-Jwt-Assertion, x-cc-read-token` | `cc-read-agents`, `cc-read-app`, `cc-read-app-detail`, `cc-read-artifacts`, `cc-read-audit`, `cc-read-decisions`, `cc-read-home`, `cc-read-settings` |
| Aggregator-token (2) | `Content-Type, x-aggregator-token` | `aggregator`, `cc-index-artifacts` |

The shared `phase5.ts` superset is `Authorization, Content-Type, Cf-Access-Jwt-Assertion, x-cc-read-token, x-csrf-token, x-cc-auto-route-toggle, x-cc-write-token`. CORS allow-headers is a permissive list — exposing extra header names doesn't break callers. The browser only sends headers the function actually reads.

**Proposed shape:**

1. Extend `_shared/phase5.ts` to export three header bundles:
   - `corsHeaders` (existing superset, for write-touching functions and read-only — extras are harmless).
   - `aggregatorCorsHeaders` (new, narrow — `Content-Type, x-aggregator-token`, methods `POST,OPTIONS`).
2. Walk all 15 functions and replace the local `const corsHeaders = { … }` with `import { corsHeaders } from "../_shared/phase5.ts"` (or `aggregatorCorsHeaders` for the two aggregator-token cases).
3. Each function also needs its `Access-Control-Allow-Methods` to match what `phase5.ts` exports (`GET,POST,OPTIONS`). Most read-only functions today declare `GET,OPTIONS` only. Either:
   - (a) Use the shared headers as-is and accept the extra `POST` advertisement (harmless — function still rejects POST with 405).
   - (b) Export a `readOnlyCorsHeaders` variant with `GET,OPTIONS`.
   - **Recommend (a)** — fewer exports, less divergence. The 405 response still has the right body.

### Effort

**Medium.** 15 files, each is a 1–2 line swap + import line. Total ~30–45 line diff. No logic changes.

### Risk

**Low — but high blast radius.** Every read and write endpoint touches this. Two ways it can fail:

- A function preflight stops including a header the browser was actually sending → CORS error in the browser. Mitigated because the shared `corsHeaders` is a **superset** of what each function declares today.
- The aggregator family advertises GET/POST/OPTIONS in error responses instead of POST/OPTIONS → cosmetic only.

Mitigation: deploy in two waves to limit blast radius — read functions first (8), confirm web app still loads cleanly, then write functions (5) and aggregator family (2).

### Migration needed?

**No.**

### Deploy footprint

- All 15 edge functions redeploy.
- Suggest scripting `supabase functions deploy <name>` in a loop or one big `deploy --all`.

### Backward compat

No client-facing change. Header names allowed by CORS are a strict superset of today's. Methods may add `POST` to some read-only function preflights — harmless because the function still 405s a POST body.

---

## Item 5 — Sanitize Telegram bot token from error responses

**File / anchor:** `supabase/functions/cc-telegram-notify/index.ts` line ~217 (`return json({ ok: false, error: { code: "telegram_request_failed", message } });`) and the surrounding `auditFailure` call.

### Concrete scope

The leak path:

1. Line ~205 (`postTelegram`): `await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, …)`.
2. If the fetch fails with a low-level network error (DNS failure, TLS error, abort, connection reset), the thrown `Error.message` from Deno's fetch can include the **full request URL** — which contains `bot<TOKEN>` in the path segment.
3. Line ~211 catches the error, line ~217 returns `{ ok: false, error: { code: "telegram_request_failed", message } }` directly to the caller.
4. The same `message` is also written to `cc_audit_events.detail.message` via `auditFailure()`. **Audit events are an exposure path too** — they're read by `cc-read-audit`.

**Proposed shape:**

1. Define `scrubTelegramSecret(text: string, token: string): string` — replace any occurrence of the literal token, plus any `bot<token>` URL fragment, with `bot***`.
2. Apply at two sites:
   - The JSON response at line 217.
   - The `auditFailure()` detail payload at line 219.
3. Also apply to the `telegram.description` field returned from the Telegram API on `telegram_api_error` (line 213) as a belt-and-suspenders — Telegram's own error bodies shouldn't contain the token but defensive scrub is cheap.
4. Treat empty/unset `token` as a no-op for the scrub (preserves the kill-switch path where `token === ""`).

The scrub should also handle the **HTTP** path: if `response.text()` echoes back a URL or the token, scrub before parsing into the `telegram` object.

### Effort

**Small.** Single helper function, two call-site wraps.

### Risk

**Low.** Pure-string transform. Unit-testable with a fixture token + a synthetic error message.

### Migration needed?

**No.**

### Deploy footprint

- `cc-telegram-notify` redeploy only.

### Backward compat

External callers see `bot***` in error.message instead of the raw token. Audit consumers see the same. No structural change.

---

## Item 6 — Rate limit outbound decision email sends (10/hour/recipient)

**File / anchor:** `supabase/functions/cc-route-decision/index.ts` lines ~95–130 (the recipient `for` loop that calls `gmailSend(raw)`).

### Concrete scope

Today the route-decision endpoint:

1. Patches per-send rows with rewritten subject/body and tokens (line ~80–92).
2. Iterates `prepared[]` and calls `gmailSend(raw)` per recipient (line ~100).
3. No rate-limit check anywhere. An operator who accidentally double-clicks the Route button, or routes the same decision to the same recipient via two different decisions in quick succession, can spam.

**Proposed shape — DB-level token bucket:**

1. New table `cc_rate_limit_buckets`:
   ```
   scope         text         not null    -- e.g. 'route_decision_email'
   bucket_key    text         not null    -- e.g. lower(recipient_email)
   tokens        int          not null
   refilled_at   timestamptz  not null
   updated_at    timestamptz  not null
   primary key (scope, bucket_key)
   ```
   RLS enabled, no row-level policies → service-role only.
2. New SECURITY DEFINER RPC:
   ```
   cc_consume_rate_limit_token(
     p_scope         text,
     p_bucket_key    text,
     p_capacity      int,      -- e.g. 10
     p_refill_window interval  -- e.g. '1 hour'
   ) returns table(allowed boolean, remaining int, reset_at timestamptz)
   ```
   Semantics: full token-bucket with linear refill. On call:
   - If bucket doesn't exist: insert with `tokens = capacity - 1`, return allowed=true.
   - If bucket exists: compute refill since `refilled_at` linearly; cap at capacity. If `tokens >= 1`, decrement and return allowed=true. Else return allowed=false with `reset_at` = next-token timestamp.
   - Use `INSERT … ON CONFLICT DO UPDATE` for atomicity (no separate read-then-write race).
3. `cc-route-decision` calls the RPC once per recipient before `gmailSend`. On `allowed=false`, skip that recipient, log an audit `decision_route_rate_limited`, accumulate into a `rate_limited[]` array, and continue with the next recipient. The 200 response shape becomes `{ sent: […], rate_limited: […] }`.
4. The bucket key should be **`lower(recipient_email)`** (not `recipient_id`) — the operational concern is per-mailbox spam, not per-row. Two recipient records with the same email should share a bucket.
5. Apply the same RPC to `cc-auto-route-decisions/index.ts` if it exists in the same hot path (out of scope for the audit's stated location but worth verifying in the same batch — auto-route shares the gmailSend path).

### Effort

**Medium.** New table + RPC + edge call-site change + audit event + response shape extension. Bulk of the time is on the RPC SQL (lock-free token math) and on writing the cc-route-decision response/error flow.

### Risk

**Medium.** Wrong rate-limit math could:

- **Block legitimate routes.** A 10/hour cap could fire if the operator routes 11 decisions to the same recipient in an hour during a real batch day. Mitigation: 10/hour is conservative; consider 20/hour or make capacity configurable via a `cc_settings` row before shipping.
- **Let through spam by failing-open.** If the RPC itself throws (e.g. due to a transient DB error), the edge function must decide whether to allow or block. Recommend **fail-open with audit** — return the email but record `rate_limit_check_failed` in audit. Spam tolerance > false-blocking tolerance in this app.

### Migration needed?

**Yes.** Migration `054_phase6_rate_limit_buckets.sql`:

- `CREATE TABLE cc_rate_limit_buckets(...)` with primary key and RLS enabled.
- `CREATE OR REPLACE FUNCTION cc_consume_rate_limit_token(...)` SECURITY DEFINER.
- `REVOKE … FROM PUBLIC; GRANT EXECUTE … TO service_role;`
- Optional: index on `(scope, bucket_key)` (already covered by primary key) plus `(updated_at)` for janitorial cleanup.
- Optional janitorial cron: drop bucket rows older than 30 days. **Not required for v1** — table grows slowly (one row per (scope, recipient)).

### Deploy footprint

- DB migration applied.
- `cc-route-decision` redeploy.
- Defensive: also redeploy `cc-auto-route-decisions` once the same check is added there.

### Backward compat

Response shape gains a `rate_limited` array. Frontend (`Decisions.tsx`, `DecisionRouteModal.tsx`) doesn't currently read this field, so legacy clients see no behavior change for successful routes. **Soft frontend ask:** surface `rate_limited` recipients in the modal toast as a non-blocking warning, so the operator knows to retry later. Not required for backend deploy.

---

## Recommended sequencing

Four batches. Each batch is independently deployable; later batches can be deferred without leaving the system in a broken state.

### Batch A — Foundation & cleanup (low risk, removes future merge conflicts)

- **Item 4** — CORS shared headers migration.
- **Item 3** — Module-scope secret cache.

**Justification:** Item 4 touches 15 files but has zero behavioral effect. Doing it first means every subsequent batch's diffs land on a clean shared-headers baseline (Items 1 and 6 both modify edge functions in this set). Item 3 piggybacks because it's the natural place to add a `getDataPlaneSecret()` helper to `_shared/phase5.ts` and update both call sites. Both items deploy together; no DB migration.

**Deploy:** all 15 edge functions + `aggregator` + `cc-read-decisions`. Two-wave rollout: read functions first (8), then write/aggregator (7).

### Batch B — Security hardening (isolated, narrow)

- **Item 5** — Sanitize Telegram errors.

**Justification:** Single-file change, no migration, security-relevant. Should not wait behind the larger architectural items. Independent of every other item.

**Deploy:** `cc-telegram-notify` only.

### Batch C — DB-backed contracts (bundle SQL migrations)

- **Item 6** — Rate limit table + RPC + cc-route-decision wiring.
- **Item 1** — Suppression RPC for cc-read-decisions.

**Justification:** Both require new RPCs (migrations 053 and 054). Bundling means one `supabase db push` event and one coordinated functions deploy. Item 1 is more architectural; Item 6 is more mechanical. Ship Item 6 first within the batch (lower regression surface) — if both ship in the same deploy window, the rate-limit work serves as a warm-up for the suppression RPC work.

For Item 1 specifically: run the new suppression code in **shadow mode** (compute + audit-event-diff against the old code path) for one deploy cycle, then flip the consumer to the new path in a follow-up edge-only deploy. This is a soft requirement — skip the shadow phase only if Brian wants the bandwidth back.

**Deploy:** migrations 053 + 054 → `cc-route-decision` + `cc-read-decisions` redeploy.

### Batch D — Performance (defer until justified)

- **Item 2** — Parallelize aggregator polling.

**Justification:** Current scale (1 app live, 1 wiring up) doesn't justify the parallelization yet. The audit itself calls out "**once SCC + 3rd app land**" as the trigger. Park this until app count hits 3 OR a cron run starts exceeding ~30s. Mechanical change when it's time; no migration; ~10-line diff.

**Deploy:** `aggregator` only, when scale justifies.

---

## What I might be wrong about

1. **Item 3 (cache service key) is borderline premature.** `Deno.env.get()` is a runtime HashMap lookup in V8 — its cost is well under a microsecond. The number of times we call it in a single invocation is bounded by the number of registered apps (2 today, 5 realistically within a year). Even with 20 apps and 5 lookups each, that's 100 HashMap reads — not a meaningful fraction of the network-bound cost of polling those apps. The real win of caching is **defensive code clarity** and a small reduction in V8 runtime surface, not measurable latency. If we cut this item from Batch A and leave the env reads inline, nothing observably changes. The version of this work that **is** worth doing — and could be a simpler alternative — is just to move the `Deno.env.get` calls out of the per-app loop and into `resolveDataPlaneKeys()`'s caller, computed once per invocation, without any module-scope cache. That gets the obvious savings without the rotation-staleness tradeoff.

2. **Item 6 (10/hour/recipient rate limit) may solve a problem we don't have.** Today's routes are operator-driven through the Decisions modal — there's no automation that can sustain >10 routes/hour to one recipient. The realistic spam vector is **double-clicks** or **race conditions on the routes** (operator hits Route, the modal doesn't update fast enough, they hit it again). A simpler alternative is an **idempotency check, not a rate limit**: reject a duplicate route to `(recipient_email, decision_external_ref)` within the last 60 seconds. This catches the actual bug — accidental re-routes of the same decision — without introducing the false-positive risk of a true token bucket, and without a new bucket table. The token-bucket approach is the more general/durable answer, but for the actual current threat model, idempotency would be a smaller-blast-radius win. Worth a 5-minute design discussion before committing to Batch C's `cc_rate_limit_buckets` table.
