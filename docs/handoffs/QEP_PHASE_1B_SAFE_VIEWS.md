# QEP Phase 1b safe-view contract

Target repo/project: QEP data plane (`iciddijgonywtxoelous`), not the Command Center control plane.

This is the companion handoff for `docs/handoffs/QEP_CC_EXPORT_DETAIL.md`. It defines the safe QEP-owned view layer that lets `public.cc_export_detail()` return real cockpit data without granting the Command Center access to raw QEP tables.

These definitions are examples based on this repo's current clues, especially `scripts/aggregator-once.mjs`. The QEP team confirms real column names and adjusts the SQL before applying it on QEP.

## §1. The pattern

QEP creates three safe views in `public`:

- `public.cc_safe_roadmap_items`
- `public.cc_safe_decision_items`
- `public.cc_safe_sync_items`

These views project exactly the columns the cockpit needs. They omit customer PII, raw customer text, internal notes, secrets, debug payloads, and any column that is not part of the federated Command Center contract.

QEP owns these views. They are the contract surface between QEP and the Command Center cockpit. The Command Center only receives the JSON returned by `public.cc_export_detail(text, text)`; it does not query QEP tables or views directly.

Recommended permission shape:

- `cc_contract_owner` owns or executes `cc_export_detail()` under `SECURITY DEFINER`.
- `cc_contract_owner` can `SELECT` from the three safe views.
- `command_center` can only `EXECUTE` `cc_export_detail()`.
- `command_center` cannot `SELECT` from the safe views or the original source tables.

## §2. Candidate source tables

Inferred from `scripts/aggregator-once.mjs`:

### `public.qep_roadmap_tasks` → `public.cc_safe_roadmap_items`

Suggested exposed columns:

- `id`
- `stream`
- `wave`
- `title`
- `status` mapped from `ship_state`
- `owner`
- `priority`
- `blocker`
- `updated_at`

### `public.qep_decisions` → `public.cc_safe_decision_items`

Suggested exposed columns:

- `id`
- `title`
- `owner`
- `status`
- `age` computed from `created_at`
- `source_ref`
- `updated_at`

If QEP tracks them, also expose:

- `owner_kind` (`operator | client`)
- `risk_class`

If QEP does not track those fields yet, omit them. The cockpit defaults still work.

### `public.v_qep_roadmap_sync_health` → `public.cc_safe_sync_items`

Suggested exposed columns:

- `source`
- `status`
- `total_tasks`
- `mirrored_tasks`
- `pending_count`
- `error_count`
- `last_checked`

Run `scripts/qep-introspect.mjs` before finalizing this SQL. It lists the actual columns visible on QEP so the QEP team can adjust these examples to the real schema.

## §3. Full SQL

Example only. QEP confirms column names before applying.

```sql
BEGIN;

-- Each view exposes ONLY the columns below.
-- No customer free text. No internal notes. No PII. No secrets.

CREATE OR REPLACE VIEW public.cc_safe_roadmap_items AS
  SELECT
    id,
    stream,
    wave,
    title,
    ship_state AS status,
    owner,
    priority,
    blocker,
    updated_at
  FROM public.qep_roadmap_tasks
  WHERE deleted_at IS NULL;

CREATE OR REPLACE VIEW public.cc_safe_decision_items AS
  SELECT
    id,
    title,
    owner,
    status,
    (now() - created_at) AS age, -- consider casting to text per cockpit shape
    source_ref,
    updated_at
  FROM public.qep_decisions
  WHERE deleted_at IS NULL
    AND status NOT IN ('resolved', 'cancelled');

CREATE OR REPLACE VIEW public.cc_safe_sync_items AS
  SELECT
    source,
    status,
    total_tasks,
    mirrored_tasks,
    pending_count,
    error_count,
    last_checked
  FROM public.v_qep_roadmap_sync_health;

-- Grant SELECT to the role that owns/executes cc_export_detail under SECURITY DEFINER.
GRANT SELECT ON public.cc_safe_roadmap_items TO cc_contract_owner;
GRANT SELECT ON public.cc_safe_decision_items TO cc_contract_owner;
GRANT SELECT ON public.cc_safe_sync_items TO cc_contract_owner;

-- Do NOT grant SELECT to command_center.
-- command_center only EXECUTEs public.cc_export_detail(text, text).

COMMIT;
```

If QEP sets these views to `security_invoker = true`, then `cc_contract_owner` also needs source-table permissions. Prefer the default view behavior unless QEP has a specific RLS reason to do otherwise.

## §4. Wire the CTEs

After the safe views exist, update `public.cc_export_detail(text, text)` by replacing the placeholder CTEs from `QEP_CC_EXPORT_DETAIL.md` with reads from the safe views.

Roadmap section:

```sql
WITH roadmap_items AS (
  SELECT
    id,
    stream,
    wave,
    title,
    status,
    owner,
    priority,
    blocker,
    updated_at
  FROM public.cc_safe_roadmap_items
  ORDER BY updated_at DESC
  LIMIT v_limit
)
```

Decisions section:

```sql
WITH decision_items AS (
  SELECT
    id,
    title,
    owner,
    status,
    age::text AS age,
    source_ref,
    updated_at
  FROM public.cc_safe_decision_items
  ORDER BY updated_at DESC
  LIMIT v_limit
)
```

If QEP exposes `owner_kind` and `risk_class`, add them to the CTE and to the `jsonb_build_object(...)` payload intentionally. Do not add raw notes, raw prompts, customer free text, or private discussion fields.

Sync section:

```sql
WITH sync_items AS (
  SELECT
    source,
    status,
    total_tasks,
    mirrored_tasks,
    pending_count,
    error_count,
    last_checked
  FROM public.cc_safe_sync_items
  ORDER BY last_checked DESC NULLS LAST
  LIMIT v_limit
)
```

The function stays the only executable contract for the Command Center. The safe views are implementation detail inside QEP.

## §5. Verification

Apply on QEP in one transaction:

1. Create the three safe views.
2. Grant `SELECT` on the safe views to `cc_contract_owner`.
3. Update `public.cc_export_detail(text, text)` to swap placeholder CTEs for safe-view reads.
4. Verify positive: `cc_export_detail` returns rows through the Command Center read JWT.
5. Verify negative: `command_center` cannot read the safe views directly.
6. Verify negative: `command_center` cannot read the original QEP source tables.

Positive check:

```bash
curl -sS \
  -H "apikey: $READ_KEY_QEP" \
  -H "Authorization: Bearer $READ_KEY_QEP" \
  -H "Content-Type: application/json" \
  -X POST \
  --data '{"p_section":"all","p_cursor":null}' \
  "https://iciddijgonywtxoelous.supabase.co/rest/v1/rpc/cc_export_detail" \
  | jq .
```

Expected: HTTP 200. `roadmap.items`, `decisions.items`, or `sync.items` should contain rows when QEP has matching source data.

Negative SQL checks from a privileged SQL session:

```sql
BEGIN;

SET LOCAL ROLE command_center;
SELECT * FROM public.cc_safe_decision_items LIMIT 1;
-- Expected: permission denied

ROLLBACK;
```

```sql
BEGIN;

SET LOCAL ROLE command_center;
SELECT * FROM public.qep_decisions LIMIT 1;
-- Expected: permission denied

ROLLBACK;
```

Also verify the function path still works after those denials:

```sql
-- Run as a role allowed to SET ROLE command_center, or use the minted read JWT via curl.
SELECT public.cc_export_detail('all', NULL);
```

Expected: JSON envelope with `roadmap`, `decisions`, and `sync` keys.

## §6. Rollback

If anything goes wrong:

```sql
BEGIN;

REVOKE SELECT ON public.cc_safe_roadmap_items FROM cc_contract_owner;
REVOKE SELECT ON public.cc_safe_decision_items FROM cc_contract_owner;
REVOKE SELECT ON public.cc_safe_sync_items FROM cc_contract_owner;

DROP VIEW IF EXISTS public.cc_safe_sync_items;
DROP VIEW IF EXISTS public.cc_safe_decision_items;
DROP VIEW IF EXISTS public.cc_safe_roadmap_items;

-- Revert public.cc_export_detail(text, text) to the placeholder CTE version from
-- docs/handoffs/QEP_CC_EXPORT_DETAIL.md until QEP approves the corrected view SQL.

COMMIT;
```

Do not grant `command_center` direct table or view access as a rollback shortcut. Keep the cockpit boundary: `command_center` executes `cc_export_detail`; `cc_contract_owner` reads the safe views under the definer contract.
