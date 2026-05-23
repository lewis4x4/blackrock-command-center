# QEP Blocked Work — Data & Contracts Design

**Author:** Data/contracts lane (one of four parallel design tracks)
**Date:** 2026-05-23
**Scope:** Backend changes only — SQL signatures, federation contracts, edge-function proxy responsibilities, audit + idempotency. **No SQL is applied. No edge-function code is written. No migration files are created in this pass.**
**Sibling tracks:** UX · Architecture-fit · CEO-priority (out of scope here)

---

## 0. Context recap

The QEP OS card on the Command Center home shows **47 blocked work items** alongside **6 open decisions**. These are distinct buckets:

| Bucket | QEP source | Cockpit surfacing |
|---|---|---|
| 47 blocked items | `qep_roadmap_tasks` where `ship_state='blocked'`, with a free-text `blocker` column | `cc_safe_roadmap_items.status='blocked'` → `cc_export_detail('roadmap')` → cockpit list |
| 6 open decisions | `qep_decisions` where `answered_at IS NULL` | `cc_safe_decision_items` → `cc_export_detail('decisions')` → cockpit list |

The 6 decisions do **not** unblock the 47 — they are an orthogonal queue. Some of the 47 may *become* decisions once we know what kind of blocker they are (decision-shaped vs. dependency-shaped vs. data-shaped, etc.), and that is exactly the surface this design powers.

### Existing primitives already in place

- **`cc_issues` ledger** (mig 007) — one row per triage condition, with lifecycle. Today QEP has exactly **one aggregate `blocked_item` row** keyed `(app_id, 'blocked_item', 'aggregate')`, written by `cc_reconcile_app_issues` (mig 009) from the snapshot count `roadmap_counts.blocked`. No per-task identity.
- **Per-decision per-task pattern proven** (mig 032) — `cc_issues_app_source_ref_active_idx` is a unique partial index on `(app_id, source_ref) WHERE source_ref != 'aggregate'`. Per-decision rows already upsert against it via `cc_claim_auto_route_decision`. The same mechanism is reusable for per-blocker rows.
- **Issue resolution RPC** (`cc_resolve_issue`, mig 016) — already supports `answer_decision | acknowledge | dismiss | link_to_decision` actions. **`link_to_decision` is the natural seed** for "convert this blocker into a decision."
- **Snooze infrastructure** (mig 029) — `cc_issues.snoozed_until` + `cc_snooze_decision(uuid, timestamptz, text)` exists for decisions. Notice the WHERE clause is `issue_type='open_decision' AND source_ref='aggregate'`. Cannot be reused as-is for per-task blocker rows; a sibling RPC is required.
- **QEP federation contract** (mig 002 + `QEP_BUILDER_HANDOFF.md`) — `cc_export_detail(text, text)` is QEP's only read surface. `command_center` JWT role has zero direct table access; everything funnels through `SECURITY DEFINER` owned by `cc_contract_owner`. Mutations flow through control-plane edge functions calling QEP RPCs that follow the same posture.

### What's missing

- Per-task **identity** for the 47 blocked rows (currently fungible behind one aggregate count).
- A **categorization** that tells the operator *what kind of intervention* clears each blocker.
- **Mutations**: resolve, convert-to-decision, snooze, reassign owner — none exist for blockers today.
- Federation surface: new columns on `cc_safe_roadmap_items`, new SECURITY DEFINER RPCs, control-plane edge function proxies.

---

## 1. Blocker categorization

### 1.1 The taxonomy

| `blocker_kind` | Definition | Cleared by |
|---|---|---|
| `decision_shaped` | A bounded choice with enumerated options that, once picked, unblocks the task. | `cc_convert_blocker_to_decision` → enters the open-decisions flow. |
| `dependency_shaped` | Waits on another `qep_roadmap_tasks` row, a deploy, or a sibling system milestone. | Auto-clears when the upstream ships (or `cc_resolve_blocker` with a link to the upstream task id). |
| `external_answer_shaped` | Waits on a reply from outside QEP — vendor, OEM, accountant, regulator, a specific person. | `cc_resolve_blocker` once the reply lands; or convert to an outbound email decision routed to that party (reusing the existing `cc-route-decision` machinery). |
| `data_shaped` | We don't yet have the data needed to make progress (a sample file, a customer list, a real screenshot). | `cc_resolve_blocker` once the data is captured. |
| `unknown` | Default. Not yet triaged. | Becomes one of the above via `cc_categorize_blocker`, then proceeds. |

The five buckets are deliberately mutually exclusive and answer the only question the cockpit needs: **"what action moves this forward?"** They don't mirror Jira/Linear category trees; they mirror operator intent.

### 1.2 Where the column lives — trade-offs

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. New column on `qep_roadmap_tasks.blocker_kind`** (typed text with CHECK constraint) | Persistent. Survives view changes. Indexable. Can be operator-overridden. Single source of truth. | One small QEP migration. Touches a business table (additive only — `DEFAULT 'unknown'`, no rewrite). | **✅ Adopt.** |
| **B. Computed in `cc_safe_roadmap_items` via heuristic on `blocker` text** | Zero QEP-side schema change. Backfills automatically. | Fragile (relies on substring matching). Can't be overridden. Recomputed every read = no memory of operator corrections. View definition becomes the rules engine, which is the wrong layer. | **❌ Reject as primary.** Heuristic is fine as the *initial backfill source* for column A. |
| **C. Async AI tagger writes to `qep_roadmap_tasks.blocker_kind`** | Most accurate. Can re-tag when `blocker` text changes. | Requires LLM workflow on QEP. Cost. Latency. Still needs column A as the durable store. | **🟡 Defer.** Add later as a *writer* into column A; don't gate v1 on it. |

**Recommendation: A primary, B-as-backfill, C as v2 enhancement.**

Concretely, the first QEP migration adds `blocker_kind text NOT NULL DEFAULT 'unknown'` with a CHECK constraint and a one-time `UPDATE` using regex heuristics on the existing `blocker` text:

```sql
ALTER TABLE public.qep_roadmap_tasks
  ADD COLUMN IF NOT EXISTS blocker_kind text NOT NULL DEFAULT 'unknown',
  ADD CONSTRAINT qep_roadmap_tasks_blocker_kind_check
    CHECK (blocker_kind IN ('decision_shaped','dependency_shaped','external_answer_shaped','data_shaped','unknown'));

-- Optional, one-time heuristic backfill (kept narrow to avoid false positives):
UPDATE public.qep_roadmap_tasks SET blocker_kind = 'decision_shaped'
  WHERE ship_state = 'blocked' AND blocker_kind = 'unknown'
    AND blocker ~* '\m(decide|choose|pick|approve|sign off|decision)\M';
UPDATE public.qep_roadmap_tasks SET blocker_kind = 'dependency_shaped'
  WHERE ship_state = 'blocked' AND blocker_kind = 'unknown'
    AND blocker ~* '\m(waiting on|blocked by|depends on|after [A-Z]-\d|deploy of)\M';
UPDATE public.qep_roadmap_tasks SET blocker_kind = 'external_answer_shaped'
  WHERE ship_state = 'blocked' AND blocker_kind = 'unknown'
    AND blocker ~* '\m(vendor|oem|client|customer|reply|response from)\M';
UPDATE public.qep_roadmap_tasks SET blocker_kind = 'data_shaped'
  WHERE ship_state = 'blocked' AND blocker_kind = 'unknown'
    AND blocker ~* '\m(sample|file|screenshot|csv|export|data set|missing data)\M';
-- Everything else remains 'unknown' — operator triages.
```

The cockpit then shows the categorization with an "override" affordance that calls `cc_categorize_blocker(...)`.

### 1.3 Adjacent columns

Two more columns earn their keep:

- `blocker_owner_kind text NOT NULL DEFAULT 'operator' CHECK (blocker_owner_kind IN ('operator','client','external'))` — mirrors the `owner_kind` field already used on `cc_safe_decision_items` (per `QEP_BUILDER_HANDOFF.md` §3). Tells the cockpit who clears it without re-parsing the owner string.
- `blocked_since timestamptz` — set by a trigger (or by the RPC that transitions `ship_state` to `blocked`). Lets the cockpit show **age** without subtracting `created_at` (which is the row's age, not the block's age).
- `linked_decision_id uuid` — set by `cc_convert_blocker_to_decision`. Nullable. Guards against double-conversion.
- `snoozed_until timestamptz` — QEP-side snooze (parallel to the existing `cc_issues.snoozed_until` on the control plane). Lets the safe view filter out snoozed rows so they fall out of the cockpit list until they wake.

---

## 2. QEP-side contract additions

### 2.1 Safe-view changes — `public.cc_safe_roadmap_items`

Mirror the pattern in `QEP_BUILDER_HANDOFF.md` §3:

```sql
CREATE OR REPLACE VIEW public.cc_safe_roadmap_items AS
  SELECT
    id::text                    AS id,
    stream,
    wave,
    title,
    ship_state                  AS status,
    owner,
    sort_order::text            AS priority,
    blocking_decision           AS blocker,            -- existing
    blocker_kind,                                       -- NEW
    blocker_owner_kind          AS owner_kind,         -- NEW (parallel to decisions view)
    blocked_since,                                      -- NEW
    linked_decision_id::text    AS linked_decision_id, -- NEW
    snoozed_until,                                      -- NEW
    updated_at
  FROM public.qep_roadmap_tasks
  WHERE deleted_at IS NULL
    -- Snoozed blocked rows hide until they wake; non-blocked rows always show.
    AND (ship_state <> 'blocked' OR snoozed_until IS NULL OR snoozed_until <= now());
```

Grants stay exactly as today: `GRANT SELECT ... TO cc_contract_owner;` — nothing changes for `command_center`.

### 2.2 `cc_export_detail` projection — `roadmap` section

Extend the existing `jsonb_build_object(...)` in `cc_export_detail`'s roadmap CTE to expose the new columns. **No new function signature** — same `cc_export_detail(text, text)`, additive field set. The Command Center has no breaking-change surface.

```sql
-- Inside cc_export_detail, the roadmap CTE adds:
'blocker_kind',         blocker_kind,
'owner_kind',           owner_kind,
'blocked_since',        blocked_since,
'linked_decision_id',   linked_decision_id,
'snoozed_until',        snoozed_until,
```

### 2.3 New RPCs (QEP side, SECURITY DEFINER, owned by `cc_contract_owner`)

All five RPCs follow the existing pattern verbatim:
- `LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''` (or `= public, pg_temp` per mig 032's lead).
- `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO command_center;`
- `OWNER TO cc_contract_owner`.
- Return shape: `jsonb` envelope with `{ task_id, status: <new_ship_state>, ... }`.
- Every mutation writes a row to `qep_audit_events` (assumed parallel of `cc_audit_events` on the QEP side; if it does not exist, the cockpit audit on the control plane is the canonical record — see §4).
- `actor text` is required on every RPC; rejected with `P0001` if blank. The control-plane edge functions pass the Cloudflare Access JWT email (or `read-token:<hash>`) as `actor`.

#### 2.3.1 `cc_resolve_blocker`

```sql
public.cc_resolve_blocker(
  p_task_id            text,       -- qep_roadmap_tasks.id
  p_resolution         text,       -- 'not_started'|'in_progress'|'shipped'|'deferred'|'na'
  p_resolution_note    text,       -- free-text reason captured into qep_roadmap_tasks (separate notes column or a JSON 'last_resolution' field)
  p_actor              text
) RETURNS jsonb;
```

Behavior:
- Reject if task's current `ship_state <> 'blocked'` (cockpit raced — return `{error: 'not_currently_blocked'}` so the UI can refresh).
- `p_resolution` must be one of the seven ship_states *except* `blocked` and `pending_decision` (a resolution can't be "still blocked" — that's a categorization, not a resolution).
- Sets `ship_state = p_resolution`, `blocker = NULL`, `blocker_kind = 'unknown'`, `snoozed_until = NULL`, `updated_at = now()`.
- Appends `{ ts, actor, from: 'blocked', to: p_resolution, note }` to a `resolution_history jsonb` column (additive — recommend adding alongside `blocker_kind`).
- Returns `{ task_id, status, prior_status: 'blocked', resolved_at }`.

#### 2.3.2 `cc_convert_blocker_to_decision`

```sql
public.cc_convert_blocker_to_decision(
  p_task_id            text,
  p_question_plain     text,            -- shows as decision title
  p_options            jsonb,           -- [{id, label}, ...] — at least one
  p_risk_class         text,            -- 'auto'|'authorize'|'destructive'|'production'
  p_owner_kind         text,            -- 'operator'|'client'
  p_owner_role         text,            -- free-text owner (mirrors qep_decisions.owner_role)
  p_actor              text
) RETURNS jsonb;
```

Behavior:
- **Idempotency**: if `qep_roadmap_tasks.linked_decision_id IS NOT NULL`, return `{ skipped: 'already_converted', decision_id: <existing>, task_id: ... }`. No exception — the cockpit treats it as success.
- Validate `p_options` is a non-empty JSON array (mirrors `cc_resolve_issue`'s validation, mig 016 lines 89–115).
- Insert into `qep_decisions` with QEP's column names (best guess from existing pattern: `code` = `BLK-<task_id>-CONV-<short>`, `question_plain`, `options`, `decision_class`, `owner_role`, `created_at`).
- Set `qep_roadmap_tasks.ship_state = 'pending_decision'`, `linked_decision_id = <new>`, `updated_at = now()`.
- Returns `{ task_id, decision_id, decision_code, status: 'pending_decision' }`.
- **Race protection**: wrap insert + update in a single SQL transaction. Add a unique partial index on `qep_roadmap_tasks.linked_decision_id` (`WHERE linked_decision_id IS NOT NULL AND deleted_at IS NULL`) so double-converts at the DB layer also fail cleanly.

#### 2.3.3 `cc_snooze_blocker`

```sql
public.cc_snooze_blocker(
  p_task_id   text,
  p_until     timestamptz,      -- 30-day cap (parallel to cc_snooze_decision, mig 029)
  p_actor     text
) RETURNS jsonb;
```

Behavior:
- 30-day cap (`p_until > now() AND p_until <= now() + interval '30 days'`).
- Only valid when `ship_state = 'blocked'`. Snoozing a non-blocked task returns `{error: 'not_currently_blocked'}`.
- Sets `snoozed_until = p_until`, `updated_at = now()`.
- Returns full row.

Unsnooze: deliberately omitted as a separate RPC for v1. **Resolving the blocker (`cc_resolve_blocker`) clears the snooze.** Editing the snooze is a re-call of `cc_snooze_blocker` with a new `p_until`. A `cc_unsnooze_blocker` exists in v2 if operators ask for it; cutting it for v1 reduces surface area.

#### 2.3.4 `cc_reassign_blocker_owner`

```sql
public.cc_reassign_blocker_owner(
  p_task_id         text,
  p_new_owner       text,            -- new qep_roadmap_tasks.owner value
  p_new_owner_kind  text,            -- 'operator'|'client'|'external'
  p_actor           text
) RETURNS jsonb;
```

Behavior:
- Validates `p_new_owner` against `registry_app_owners.person_name` on the control plane? **No** — that's a cross-project lookup we should not couple to. Accept any non-empty string; the cockpit gates the value at write time with a dropdown sourced from the existing owner registry.
- Updates `owner`, `blocker_owner_kind`, `updated_at`.
- Returns full row.

#### 2.3.5 `cc_categorize_blocker`

```sql
public.cc_categorize_blocker(
  p_task_id       text,
  p_blocker_kind  text,          -- one of the five enum values
  p_actor         text
) RETURNS jsonb;
```

Behavior:
- CHECK constraint on column does most of the validation; RPC adds a friendlier error message.
- Updates `blocker_kind`, `updated_at`.
- Returns full row.

### 2.4 SECURITY DEFINER + grant posture (full template)

For each RPC above, the migration tail is:

```sql
ALTER FUNCTION public.<rpc_name>(<arg types>) OWNER TO cc_contract_owner;
COMMENT ON FUNCTION public.<rpc_name>(<arg types>) IS
  '<one-line purpose>. SECURITY DEFINER. Cockpit mutation contract.';
REVOKE EXECUTE ON FUNCTION public.<rpc_name>(<arg types>) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.<rpc_name>(<arg types>) FROM anon;
REVOKE EXECUTE ON FUNCTION public.<rpc_name>(<arg types>) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.<rpc_name>(<arg types>) TO command_center;
```

`command_center` keeps zero direct table grants. Every blocker mutation, like every read, goes through the function boundary.

---

## 3. Control-plane edge function proxies

Five new functions under `supabase/functions/cc-*`, each modeled on the existing `cc-route-decision` / `cc-snooze-decision` / `cc-dispatch-from-answer` template:

| New function | Mirrors | Calls into QEP |
|---|---|---|
| `cc-resolve-blocker` | `cc-snooze-decision` | `cc_resolve_blocker(p_task_id, p_resolution, p_resolution_note, p_actor)` |
| `cc-convert-blocker-to-decision` | `cc-dispatch-from-answer` (composes a richer payload) | `cc_convert_blocker_to_decision(...)` |
| `cc-snooze-blocker` | `cc-snooze-decision` (literal twin) | `cc_snooze_blocker(p_task_id, p_until, p_actor)` |
| `cc-reassign-blocker-owner` | `cc-snooze-decision` | `cc_reassign_blocker_owner(...)` |
| `cc-categorize-blocker` | `cc-snooze-decision` | `cc_categorize_blocker(...)` |

### 3.1 Auth + transport shared envelope

Every function:
1. CORS preflight handling.
2. `verifyAccessJwt(...)` — Cloudflare Access JWT or `x-cc-read-token` fallback (mirrors all existing `cc-*` proxies).
3. `verifyWriteToken(...)` — the existing `phase5.ts` helper (write-token header check).
4. **Mutation header**: write-class operations carry a separate `x-cc-mutation-token` header backed by `CC_MUTATION_TOKEN` env var, **distinct from `CC_READ_TOKEN`**. The existing `cc-snooze-decision` enforces a `CC_AUTO_ROUTE_TOGGLE_TOKEN` for the same reason — segregating mutation auth from read auth. Recommend reusing that same token for blocker mutations OR introducing one shared `CC_BLOCKER_MUTATION_TOKEN`. **Decision:** use the existing `CC_AUTO_ROUTE_TOGGLE_TOKEN` name normalized to `CC_MUTATION_TOKEN` going forward, with a feature-flag period of accepting both (zero-downtime rename).
5. Validate JSON body shape (UUIDs match `UUID_RE`, enums match the allowed set, strings ≤ max lengths).
6. Look up the app's data plane (`registry_app_supabase` row) to get `project_url` + `service_secret_ref` → real key from Deno env. Same resolution as `cc-read-app-detail`.
7. POST to QEP's `cc_<rpc>` endpoint with the `READ_KEY_QEP`-style JWT (re-uses the per-app key infrastructure already in place).
8. On success, **mutate the corresponding control-plane `cc_issues` row** to keep the ledger in lockstep (see §4).
9. Write `cc_audit_events`. Return `{ task: <full row from QEP>, issue: <updated cc_issues row> }`.

### 3.2 Why proxy through edge functions and not direct PostgREST from the cockpit?

Same reasons existing decisions flow does: the browser does not hold QEP credentials, the audit row is mandatory and centralized, and mutation auth (the second-class token) is server-only.

### 3.3 JSON shapes

```json
// POST /functions/v1/cc-resolve-blocker
{ "app_id": "<uuid>", "task_id": "<text>", "resolution": "shipped", "note": "Vendor confirmed price feed available.", }
// → 200
{ "task": { "id": "...", "status": "shipped", "blocker_kind": "unknown", ... },
  "issue": { "id": "...", "status": "done", "resolved_at": "..." } }

// POST /functions/v1/cc-convert-blocker-to-decision
{ "app_id": "<uuid>", "task_id": "<text>",
  "question": "Should we onboard with Vendor A or Vendor B?",
  "options": [{"id":"a","label":"Vendor A"},{"id":"b","label":"Vendor B"}],
  "risk_class": "authorize",
  "owner_kind": "operator",
  "owner_role": "owner_all" }
// → 200
{ "task": { "id": "...", "status": "pending_decision", "linked_decision_id": "..." },
  "decision": { "id": "...", "code": "BLK-T-042-CONV-AB12" },
  "issue": { "id": "...", "status": "triaging", "context": { "linked_decision_ref": "..." } } }

// POST /functions/v1/cc-snooze-blocker
{ "app_id": "<uuid>", "task_id": "<text>", "until": "2026-06-01T00:00:00Z" }
// (or "days": 7)
// → 200
{ "task": { "id": "...", "snoozed_until": "..." }, "issue": { "id": "...", "snoozed_until": "..." } }

// POST /functions/v1/cc-reassign-blocker-owner
{ "app_id": "<uuid>", "task_id": "<text>", "new_owner": "Ryan McKenzie", "new_owner_kind": "client" }
// → 200
{ "task": { "id": "...", "owner": "Ryan McKenzie", "owner_kind": "client" }, "issue": { "id": "..." } }

// POST /functions/v1/cc-categorize-blocker
{ "app_id": "<uuid>", "task_id": "<text>", "blocker_kind": "decision_shaped" }
// → 200
{ "task": { "id": "...", "blocker_kind": "decision_shaped" }, "issue": { "id": "...", "detail": { "blocker_kind": "decision_shaped", ... } } }
```

---

## 4. Issue ledger integration

### 4.1 The pattern (verbatim from mig 032)

Each blocked task gets a `cc_issues` row with:
- `issue_type = 'blocked_item'`
- `source_ref = <qep_task_id>` (e.g. `'T-042'`, **not** `'aggregate'`)
- `detail` jsonb carrying:
  ```json
  {
    "title": "<task title>",
    "blocker": "<free-text blocker>",
    "blocker_kind": "decision_shaped",
    "owner": "Ryan McKenzie",
    "owner_kind": "client",
    "stream": "C",
    "wave": "1",
    "priority": "300",
    "blocked_since": "2026-05-01T12:00:00Z"
  }
  ```
- `title` = `"Blocked: " || <task title>`
- `severity` = `'normal'` initially; **bumped to `'high'` when `blocked_since` is older than 14 days** (set inside the reconciler).
- `status` lifecycle: `surfaced → triaging → answered (when converted to decision) → done (when resolved or dismissed)`.

### 4.2 New reconciliation function — `cc_reconcile_app_blockers`

This is the per-task analog of `cc_reconcile_app_issues` (mig 009) for the blocker dimension. It does **not** replace the aggregate row — see §4.3.

```sql
public.cc_reconcile_app_blockers(
  p_app_id    uuid,
  p_blockers  jsonb              -- array of items projected from cc_export_detail('roadmap')
                                 -- filtered to status='blocked'
) RETURNS jsonb;
```

Behavior (single transaction, idempotent on the unique partial index from mig 032):

1. Iterate over `p_blockers`. For each, `INSERT ... ON CONFLICT (app_id, source_ref) WHERE deleted_at IS NULL AND source_ref != 'aggregate' DO UPDATE SET …` — preserving operator-advanced status (`status` is **not** overwritten when it's `'answered'`, `'work_order_created'`, `'dispatched'`, `'done'`, `'dismissed'` — exact parallel of mig 032 line 121).
2. `last_seen_at = now()`, `detail = <fresh detail jsonb>`, `severity = compute(blocked_since)`.
3. After iterating, **resolve cleared blockers**: any `cc_issues` row for this app with `issue_type='blocked_item'`, `source_ref != 'aggregate'`, `status IN ('surfaced','triaging')`, `last_seen_at < now() - interval '30 seconds'` → set `status='done'`, `resolved_at=now()` (the task moved out of `blocked` upstream).
4. Return `{ upserted: N, resolved: N, surfaced_new: N }`.

`SECURITY INVOKER` (matches the existing `cc_reconcile_app_issues`) — called by the Aggregator under `service_role`, which bypasses RLS. No DEFINER posture needed.

### 4.3 Aggregate row stays — backwards compat

Migration 009's comment explicitly anticipated this (lines 22–26): *"Phase 2 adds … item-level issues (a row per decision, per blocked task) with a real source_ref; those sit alongside these aggregate rows, untouched by this function."*

The aggregate `(app_id, 'blocked_item', 'aggregate')` row continues to be written by `cc_reconcile_app_issues` from snapshot counts. It serves the **card count** on the home page (`47 blocked`). The per-task rows serve the **list** on the Blocked Work surface. The unique partial index in mig 032 explicitly excludes `source_ref='aggregate'`, so the two coexist.

The home card UI can switch from "47 blocked" pulled from the aggregate row's `detail.blocked` to `COUNT(*) FROM cc_issues WHERE issue_type='blocked_item' AND source_ref<>'aggregate' AND resolved_at IS NULL`, and they should be equal modulo polling lag. The aggregate row remains as a fast-path count and as the existing source of truth until the per-task rows have aged through a full polling cycle.

### 4.4 Aggregator wiring

The Aggregator already calls `cc_reconcile_app_issues(app_id, snapshot)` after every snapshot poll. To populate per-task rows it must additionally:

1. Call QEP's `cc_export_detail('roadmap', NULL)`.
2. Filter `data.roadmap.items` where `status = 'blocked'`.
3. Call `cc_reconcile_app_blockers(app_id, <filtered jsonb>)`.

This adds one detail RPC per app per polling cycle. Today the Aggregator polls every 5 minutes (mig 008). Doable, but watch the cost — see §6.3.

### 4.5 Conversion linkage

When `cc-convert-blocker-to-decision` succeeds:
- The blocker `cc_issues` row transitions to `status='triaging'` with `context` updated:
  ```json
  { "linked_decision_ref": "<qep_decision_code>",
    "linked_to_decision_at": "<ts>",
    "linked_to_decision_by": "<actor>" }
  ```
  This is **exactly the shape `cc_resolve_issue('link_to_decision', ...)` already produces** (mig 016 lines 192–198). Reuse `cc_resolve_issue` with `action='link_to_decision'` from inside the edge function rather than duplicating the update logic.
- On the next Aggregator cycle, a new `cc_issues` row appears for the decision (issue_type `open_decision`, source_ref = the decision code), per the existing mig 032 flow. The two rows are linked via `context.linked_decision_ref`.
- When the decision is answered (`cc_resolve_issue('answer_decision', ...)`), the **blocker row stays at `triaging`** until the QEP task moves out of `pending_decision` back through the lifecycle. Once `qep_roadmap_tasks.ship_state` changes, the next reconciler cycle resolves the blocker row.

---

## 5. Per-task vs aggregate reconciler — detailed change

`cc_reconcile_app_issues` (mig 009) **is not modified**. We deliberately add `cc_reconcile_app_blockers` as a sibling rather than overloading the existing function. Reasons:

1. **Different inputs**: 009 takes the aggregate `jsonb` snapshot; the new function takes an array of detail items. Conflating them widens the signature uncomfortably.
2. **Different cadence (potentially)**: snapshot poll is 5min; detail poll for per-task rows can be slower if we want to throttle.
3. **Cleaner rollback**: turning off per-task rows means turning off the new function; aggregate behavior is untouched.
4. **Forward-compat**: open_decision per-item rows from mig 032 follow the same pattern (a separate claim RPC, not an addition to 009). Consistency.

The only modification to mig 009 territory is the **`severity` computation in the aggregate row** if we want the home card to escalate when long-blocked tasks accumulate — but that's a follow-up, not part of v1.

---

## 6. Audit, idempotency, locking

### 6.1 Audit events (`cc_audit_events.event_type` is plain `text`, no enum to extend)

New event_types written on every successful mutation:

| event_type | actor | detail jsonb |
|---|---|---|
| `blocker_resolved` | operator email | `{ task_id, prior_status: 'blocked', new_status, note }` |
| `blocker_converted_to_decision` | operator email | `{ task_id, decision_id, decision_code, options, owner_kind }` |
| `blocker_snoozed` | operator email | `{ task_id, snoozed_until }` |
| `blocker_owner_reassigned` | operator email | `{ task_id, prior_owner, new_owner, new_owner_kind }` |
| `blocker_categorized` | operator email | `{ task_id, prior_kind, new_kind }` |
| `blocker_surfaced` | `aggregator` | `{ task_id, blocker_kind, owner_kind }` — written by `cc_reconcile_app_blockers` on insert only |
| `blocker_cleared` | `aggregator` | `{ task_id, last_seen_at, resolved_after_seconds }` — written by `cc_reconcile_app_blockers` on resolve |

QEP's RPCs write **mirror events** to a QEP-side audit log if one exists. If QEP does not have one, the control-plane audit row is canonical and the QEP RPCs skip QEP-side auditing for v1 (acceptable per existing federation pattern; the Command Center is the operator-of-record audit surface).

### 6.2 Idempotency — concrete guards

| Risk | Mitigation |
|---|---|
| Double-conversion: operator clicks "Convert" twice → two `qep_decisions` rows | (a) `cc_convert_blocker_to_decision` short-circuits when `linked_decision_id IS NOT NULL`; (b) unique partial index on `qep_roadmap_tasks.linked_decision_id WHERE deleted_at IS NULL`; (c) edge function returns 409 with the existing decision payload, not 500 |
| Double-resolve: two operators resolve simultaneously | RPC checks `ship_state = 'blocked'` at start of transaction (under row-level lock via `SELECT ... FOR UPDATE`); second caller gets `{error: 'not_currently_blocked'}` |
| Snooze races | Last write wins; `snoozed_until` is plainly updateable. Audit captures both events. |
| Reconciler races with operator mutations | `cc_reconcile_app_blockers` runs under `service_role`. Its UPDATE preserves operator-advanced status (the `CASE WHEN status IN (...) THEN status ELSE 'triaging'` pattern from mig 032 line 121). |
| Auto-route fires on a `pending_decision` task before per-blocker reconciliation catches up | Already handled by the existing auto-route flow's own idempotency (mig 032 lines 88–101). Per-blocker rows don't need their own. |

### 6.3 Polling cost

Adding a `cc_export_detail('roadmap')` call per app per Aggregator tick is fine for the current scale (1 app — QEP). At N apps, this becomes N detail RPCs per 5min. Mitigations available later (not in v1): (a) ETag on the detail response; (b) decouple detail polling to 15min while keeping snapshot at 5min; (c) cache the last roadmap items + only call when the snapshot's `roadmap_counts.blocked` count changes.

For v1: just do the extra call. 12 extra RPCs/hour against QEP is negligible.

---

## 7. Per-blocker auto-route equivalent?

The user asked whether blockers warrant an auto-route table like `cc_per_decision_autoroute`. **No, not in v1.** Reasoning:

1. The closest analog already exists: `cc-route-decision` → routes a decision to an external email recipient with magic-link confirm. **That flow lights up automatically once a blocker is converted into a decision.** No new infrastructure needed; the operator just clicks "Convert" then "Route to client" (one button each, or fused into a single "Send to client for decision" affordance — that's a UX-track call).
2. Auto-conversion of blockers (e.g., "any blocker tagged `decision_shaped` and `owner_kind='client'` should auto-create a decision and route to the client") is **a meaningful policy change** that bypasses operator review of the question phrasing. The existing auto-route policy carries that risk for decisions, and there's already a `cc-pause-decision` kill-switch. Repeating that pattern for blockers means doubling the surface area of policies that can mis-fire.
3. The 47 blockers are mostly stale — they accumulated because nothing was processing them. Once the cockpit surface exists, an operator working through them at 30 seconds each clears the queue in 24 minutes. Automation past "Convert" + "Route" buys little.

**Recommendation:** ship v1 with manual `cc-convert-blocker-to-decision` → manual `cc-route-decision`. Revisit auto-conversion only after observing real triage patterns over a month.

If a v2 auto-conversion is built, the natural shape mirrors mig 032 exactly:

```sql
public.cc_claim_auto_convert_blocker(
  p_app_id        uuid,
  p_task_id       text,
  p_raw_title     text,
  p_raw_blocker   text,
  p_blocker_kind  text,
  p_owner_kind    text,
  p_owner_role    text,
  p_actor         text
) RETURNS jsonb;
```

…with the same unique partial index already enforced by `cc_issues_app_source_ref_active_idx` and a new partial index on `qep_roadmap_tasks (id) WHERE linked_decision_id IS NULL AND blocker_kind = 'decision_shaped' AND deleted_at IS NULL` to limit candidate scans.

---

## 8. Migration numbering & sequencing

Control-plane repo (`gsvhuzpysxaegoecwjmf`, this repo):

| # | File | Purpose | Depends on |
|---|---|---|---|
| 035 | `035_cc_reconcile_app_blockers.sql` | New `cc_reconcile_app_blockers(uuid, jsonb)` function. Reuses `cc_issues_app_source_ref_active_idx` from mig 032. | mig 032 |
| 036 | `036_cc_blocker_lifecycle_rpc.sql` | Control-plane mirror RPC(s): `cc_link_blocker_to_decision(issue_id, decision_code, actor)` — wraps `cc_resolve_issue('link_to_decision', ...)` so edge functions have a single call site. Optional — could just call `cc_resolve_issue` directly. | mig 016 |

QEP-side migrations (applied via the QEP repo's tooling, **not** this repo) — handed off as Tier-3 documents under `docs/handoffs/`:

| Handoff | Migration(s) on QEP | Purpose |
|---|---|---|
| `QEP_TIER3_BLOCKER_SCHEMA.md` | Add `blocker_kind`, `blocker_owner_kind`, `blocked_since`, `linked_decision_id`, `snoozed_until`, `resolution_history` columns to `qep_roadmap_tasks`. CHECK constraints. Unique partial index on `linked_decision_id`. One-time heuristic backfill. | Column landing |
| `QEP_TIER3_BLOCKER_VIEW.md` | Extend `cc_safe_roadmap_items` to project the new columns. Extend `cc_export_detail`'s roadmap CTE. | Federation read surface |
| `QEP_TIER3_BLOCKER_RPCS.md` | Create the five new SECURITY DEFINER RPCs in §2.3. Grant EXECUTE to `command_center`. | Federation mutation surface |

Sequence: ship QEP schema first, then QEP view + RPCs, then control-plane 035 (which depends on real items existing), then edge functions. Each handoff is one transactional migration on the QEP side.

---

## 9. Did I push this? Is this the best way?

### 9.1 Steelman: do nothing server-side

> "Don't model blockers as a new server-side concept at all. Let the operator open each blocked roadmap task one at a time, decide informally what to do, and either (a) edit QEP's task in Linear/their existing tooling, or (b) manually create a decision via the existing decisions UI and paste in the question. Why double the contract surface for what's fundamentally a 47-item one-shot cleanup?"

**This steelman is genuinely strong.** Three sub-points:

1. **The 47 will burn down.** This is not an evergreen flow that compounds — it's an accumulated backlog. After it's cleared the surface gets used a handful of times per week, not constantly. Every line of SQL we ship has to be maintained forever; every line of UX we don't ship today is something we don't have to support tomorrow.
2. **The existing decisions flow already handles the high-value case.** A blocker that becomes a decision flows through *exactly* the decisions infrastructure we have. The only new thing we're really adding is "what about blockers that *don't* become decisions?" — and for those, manually updating the upstream task in QEP's existing tooling is a perfectly fine workflow.
3. **Categorization is largely unused signal.** Until we have automation that branches on `blocker_kind`, the column just colors the cockpit row. We can color the row equally well with regex-on-blocker-text without a column.

**Where the steelman breaks down:**

- **Identity matters even for one-shot cleanup.** Without per-task rows in `cc_issues`, an operator can't "snooze a blocker for a week" or "dismiss this one" without leaving a trail. Audit, snooze, dismiss only work with per-row identity. And those affordances are what turn "47 blocked, ugh" into "I'll deal with 8 today and snooze the rest" — which is the actual UX win.
- **"Just update the task in Linear"** is the *current* behavior, and it's how we ended up with 47 of them. The cockpit's job is to be the place where work actually moves, not to be a window into other tools. If a blocker action has to happen elsewhere, the operator won't do it from the cockpit.
- **Convert-to-decision needs a server-side link.** Without `linked_decision_id` (or equivalent), the cockpit can't show "Blocker T-042 → Decision DEC-042 → answered Vendor A" as a chain. That chain is what unblocks the operator's mental model of "where does each thing live now?"

**Net:** the steelman wins for "do nothing past the manual conversion path" but loses for snooze/dismiss/audit. **A compromise version exists** — see §9.3 below — and it's worth taking seriously as the v0.5 cut.

### 9.2 Biggest schema/contract risk + mitigation

**The single biggest risk is `blocker_kind` becoming a tag-soup with operator-meaningful sub-cases that the five-bucket taxonomy can't express, leading to either (a) operators ignoring the column or (b) us adding bucket #6, #7, #8 until it's useless.**

This is the classic categorization-system failure mode. Mitigations, in priority order:

1. **Keep the column free of business semantics.** `blocker_kind` answers exactly one question — *what action moves it forward* — and the five values map 1:1 to the five UI affordances. Adding a sixth value should require adding a sixth affordance. That constraint keeps the taxonomy honest. Codify this in the migration comment.
2. **Make the categorization revisable, not destructive.** `cc_categorize_blocker` is intentionally cheap. Operators can re-categorize freely as they learn. The cost of a wrong tag is one click to re-tag.
3. **Don't index on it as a primary key dimension.** Indexes can come later if query patterns demand. v1 has 47 rows; even a sequential scan is free.
4. **Keep `unknown` as a first-class value, not an error state.** Half the rows will be `unknown` for weeks while operators triage. The UI should treat `unknown` as "needs triage" and offer one-click categorization, not as an exception.

**Second-biggest risk: breaking the federation boundary.** New view columns or RPC arguments could quietly start passing PII or internal-only fields through `cc_export_detail`. Mitigation: every column added to `cc_safe_roadmap_items` is reviewed against the same checklist QEP_PHASE_1B_SAFE_VIEWS.md uses for the original columns. The QEP handoff doc enumerates the exposed columns explicitly and forbids drift; the Command Center side cannot add a new column to its expectation without a corresponding QEP-side migration.

**Third-biggest risk: RLS regression on `cc_issues`.** The new per-task rows multiply by ~10× the volume of the table for QEP (47 → ~470 over time including resolved history). RLS policies on `cc_issues` allow `authenticated` and `anon` to SELECT (mig 007). If a future caller starts using these directly without going through the safe paths, **the per-task rows expose `detail.blocker` (free text)** to anyone with an anon JWT. Mitigation: audit the `detail` shape carefully — `blocker` text from QEP is operator-authored and approved-for-the-cockpit, so it's already in the "safe to expose" set per the view definition. But **do not put `resolution_history` or audit-style fields into `detail`** — those go on the QEP side only.

### 9.3 What to cut for a v0.5 in days, not weeks

The minimum surface that makes the 47-item cleanup tractable in the cockpit:

| Drop | Keep |
|---|---|
| ❌ `cc_categorize_blocker` (categorization manual via heuristic-only) | ✅ `cc_resolve_blocker` |
| ❌ `cc_snooze_blocker` (snooze isn't critical for a one-time cleanup) | ✅ `cc_convert_blocker_to_decision` |
| ❌ `cc_reassign_blocker_owner` (do this in Linear) | ✅ Per-task `cc_issues` rows (the identity is what unlocks UX) |
| ❌ Auto-conversion (was already deferred — confirmed cut) | ✅ The aggregator's new per-task reconciler call |
| ❌ `cc_safe_roadmap_items.snoozed_until` column (only needed if snooze ships) | ✅ Extending `cc_safe_roadmap_items` with `blocker_kind` (heuristic-only), `owner_kind`, `blocked_since`, `linked_decision_id` |

**v0.5 deliverables in priority order:**

1. **QEP schema additive migration** (one transaction): `blocker_kind`, `linked_decision_id`, `blocked_since` columns + the heuristic backfill. Skip `snoozed_until`, `blocker_owner_kind`, `resolution_history`.
2. **QEP view + RPCs**: extended `cc_safe_roadmap_items`, extended `cc_export_detail`, `cc_resolve_blocker` + `cc_convert_blocker_to_decision` only. ~150 lines of SQL total.
3. **Control-plane**: `cc_reconcile_app_blockers` (mig 035) + Aggregator wiring.
4. **Two edge functions**: `cc-resolve-blocker`, `cc-convert-blocker-to-decision`. ~250 lines of TypeScript total.

This is genuinely a **3–5 day shippable cut**. Adds snooze and categorization can ship a week later once usage tells us they're needed.

### 9.4 Confirm or revise

**Confirmed, with the v0.5 cut from §9.3 as the recommended ship target.**

The full design in §1–§7 is the right north star — it's coherent, mirrors existing patterns exactly, and avoids inventing new federation concepts. But §9.3 is what I'd actually build next week. The full design earns its way in only if operator usage of v0.5 demonstrates the need for snooze/categorize/reassign as real affordances rather than nice-to-haves.

One revision against my initial design: the **mutation-token rename** in §3.1 (`CC_AUTO_ROUTE_TOGGLE_TOKEN` → `CC_MUTATION_TOKEN`) should be its own tiny separate cleanup PR, not tangled into blocker-work shipping. The blocker edge functions can use the existing toggle-token name verbatim. Don't widen scope.

---

## 10. Open questions for sibling tracks

These are deliberately not answered here — they belong to UX, Architecture-fit, or CEO-priority lanes:

1. **UX**: when an operator clicks "Convert to decision" on a blocker, do they see the decision composer modal immediately (auto-routed flow) or is the decision opened cold and they fill in the question text in a separate step? The data contract supports both.
2. **UX**: should the home card show 47 → split into "blocked needing triage (kind=unknown)" + "blocked awaiting external (kind=external_answer_shaped)" + "blocked awaiting dependency (kind=dependency_shaped)"? The data contract supports it; the question is whether the home card has the real estate.
3. **Architecture-fit**: is the new `cc_reconcile_app_blockers` polling the right cadence, or should it move to a webhook/CDC trigger when QEP supports it? Out of scope for this lane.
4. **CEO-priority**: does this ship before or after the next email-engine slice? The roadmap has both candidates; I'm describing what's possible, not what's next.

---

## Appendix A — Full SQL signatures (for handoff doc authors)

### A.1 QEP-side

```sql
-- §2.1 view (extended)
CREATE OR REPLACE VIEW public.cc_safe_roadmap_items AS
  SELECT
    id::text AS id, stream, wave, title,
    ship_state AS status, owner,
    sort_order::text AS priority,
    blocking_decision AS blocker,
    blocker_kind,
    blocker_owner_kind AS owner_kind,
    blocked_since,
    linked_decision_id::text AS linked_decision_id,
    snoozed_until,
    updated_at
  FROM public.qep_roadmap_tasks
  WHERE deleted_at IS NULL
    AND (ship_state <> 'blocked' OR snoozed_until IS NULL OR snoozed_until <= now());

-- §2.3.1
CREATE OR REPLACE FUNCTION public.cc_resolve_blocker(
  p_task_id text, p_resolution text, p_resolution_note text, p_actor text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- §2.3.2
CREATE OR REPLACE FUNCTION public.cc_convert_blocker_to_decision(
  p_task_id text, p_question_plain text, p_options jsonb,
  p_risk_class text, p_owner_kind text, p_owner_role text, p_actor text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- §2.3.3
CREATE OR REPLACE FUNCTION public.cc_snooze_blocker(
  p_task_id text, p_until timestamptz, p_actor text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- §2.3.4
CREATE OR REPLACE FUNCTION public.cc_reassign_blocker_owner(
  p_task_id text, p_new_owner text, p_new_owner_kind text, p_actor text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- §2.3.5
CREATE OR REPLACE FUNCTION public.cc_categorize_blocker(
  p_task_id text, p_blocker_kind text, p_actor text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- All five — owner + grants
ALTER FUNCTION public.<rpc>(...) OWNER TO cc_contract_owner;
REVOKE EXECUTE ON FUNCTION public.<rpc>(...) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.<rpc>(...) TO command_center;
```

### A.2 Control-plane

```sql
-- §4.2 (mig 035 candidate)
CREATE OR REPLACE FUNCTION public.cc_reconcile_app_blockers(
  p_app_id uuid, p_blockers jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.cc_reconcile_app_blockers(uuid, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cc_reconcile_app_blockers(uuid, jsonb) TO service_role;
```

## Appendix B — JSON shapes (for cockpit / edge function authors)

Per-task `cc_safe_roadmap_items` row (as projected through `cc_export_detail('roadmap')`):

```json
{
  "id": "T-042",
  "stream": "C",
  "wave": "1",
  "title": "Wire OEM Vendor A price feed",
  "status": "blocked",
  "owner": "Norman",
  "owner_kind": "operator",
  "priority": "300",
  "blocker": "Waiting on Vendor A to confirm endpoint auth method",
  "blocker_kind": "external_answer_shaped",
  "blocked_since": "2026-04-12T15:22:00Z",
  "linked_decision_id": null,
  "snoozed_until": null,
  "updated_at": "2026-05-22T10:11:00Z"
}
```

Corresponding `cc_issues` row (control-plane side):

```json
{
  "id": "<uuid>",
  "app_id": "<qep_app_uuid>",
  "issue_type": "blocked_item",
  "source_ref": "T-042",
  "status": "surfaced",
  "severity": "high",
  "title": "Blocked: Wire OEM Vendor A price feed",
  "summary": "External answer needed (41d). Owner: Norman.",
  "detail": {
    "title": "Wire OEM Vendor A price feed",
    "blocker": "Waiting on Vendor A to confirm endpoint auth method",
    "blocker_kind": "external_answer_shaped",
    "owner": "Norman",
    "owner_kind": "operator",
    "stream": "C",
    "wave": "1",
    "priority": "300",
    "blocked_since": "2026-04-12T15:22:00Z"
  },
  "context": {},
  "surfaced_at": "2026-05-23T11:00:00Z",
  "last_seen_at": "2026-05-23T11:25:00Z",
  "snoozed_until": null,
  "resolved_at": null
}
```

— End of design doc —
