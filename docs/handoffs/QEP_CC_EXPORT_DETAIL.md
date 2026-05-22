# QEP → Command Center handoff: `cc_export_detail()`

Target repo/project: QEP data plane (`iciddijgonywtxoelous`), not the Command Center control plane.

The Command Center cockpit calls this read-only contract through the control-plane `cc-read-app-detail` proxy. The browser never calls QEP directly, and the control plane does not snapshot or store this item-level payload.

## Boundary rule

QEP owns the cockpit surface. The QEP team chooses exactly which columns are exposed in each section. Keep the result useful for operators, but do not expose secrets, customer PII, raw internal notes, or columns that are not needed by the Command Center.

## SQL to apply in QEP

This is the full contract shape. Replace the marked section queries with QEP-owned tables/views and QEP-approved columns before applying. Keep the function name, args, return envelope, `SECURITY DEFINER`, revokes, and grant intact.

```sql
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_center') THEN
    CREATE ROLE command_center NOLOGIN;
  END IF;
END$$;

GRANT command_center TO authenticator;
GRANT USAGE ON SCHEMA public TO command_center;

-- Optional: dedicate a function-owner role (clean separation).
-- If qep already has a 'cc_contract_owner' role, reuse it; otherwise create:
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cc_contract_owner') THEN
    CREATE ROLE cc_contract_owner NOLOGIN;
  END IF;
END$$;

-- Grant cc_contract_owner the SELECTs it needs (per the CTE wiring below).
-- These grants live on cc_contract_owner, NEVER on command_center.
-- Example (replace with QEP's real tables/views):
GRANT SELECT ON public.qep_roadmap_tasks TO cc_contract_owner;
GRANT SELECT ON public.qep_decisions TO cc_contract_owner;
GRANT SELECT ON public.v_qep_roadmap_sync_health TO cc_contract_owner;

CREATE OR REPLACE FUNCTION public.cc_export_detail(
  p_section text DEFAULT 'all',
  p_cursor  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_section text := lower(coalesce(nullif(trim(p_section), ''), 'all'));
  v_limit   integer := 50;
  v_roadmap jsonb := jsonb_build_object('items', '[]'::jsonb, 'next_cursor', NULL);
  v_decisions jsonb := jsonb_build_object('items', '[]'::jsonb, 'next_cursor', NULL);
  v_sync jsonb := jsonb_build_object('items', '[]'::jsonb, 'next_cursor', NULL);
BEGIN
  IF v_section NOT IN ('all', 'roadmap', 'decisions', 'sync') THEN
    RAISE EXCEPTION 'cc_export_detail: invalid section %', p_section
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_section IN ('all', 'roadmap') THEN
    /*
      QEP owns the source and exposed columns.
      Replace this CTE with a real read from QEP's roadmap/Linear mirror tables or a dedicated safe view.
      Fully-qualify all schema references (for example, public.qep_roadmap_tasks)
      because search_path is empty. This is intentional — prevents schema-search hijack.
      Recommended item keys: id, stream, wave, title, status, owner, priority, blocker, updated_at.
    */
    WITH roadmap_items AS (
      SELECT
        NULL::text AS id,
        NULL::text AS stream,
        NULL::text AS wave,
        NULL::text AS title,
        NULL::text AS status,
        NULL::text AS owner,
        NULL::text AS priority,
        NULL::text AS blocker,
        NULL::timestamptz AS updated_at
      WHERE false
      LIMIT v_limit
    )
    SELECT jsonb_build_object(
      'items', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', id,
        'stream', stream,
        'wave', wave,
        'title', title,
        'status', status,
        'owner', owner,
        'priority', priority,
        'blocker', blocker,
        'updated_at', updated_at
      ))), '[]'::jsonb),
      'next_cursor', NULL
    ) INTO v_roadmap
    FROM roadmap_items;
  END IF;

  IF v_section IN ('all', 'decisions') THEN
    /*
      QEP owns the source and exposed columns.
      Replace this CTE with open operator/client decisions safe for the Command Center.
      Fully-qualify all schema references (for example, public.qep_decisions)
      because search_path is empty. This is intentional — prevents schema-search hijack.
      Recommended item keys: id, title, owner, status, age, source_ref, updated_at.
    */
    WITH decision_items AS (
      SELECT
        NULL::text AS id,
        NULL::text AS title,
        NULL::text AS owner,
        NULL::text AS status,
        NULL::text AS age,
        NULL::text AS source_ref,
        NULL::timestamptz AS updated_at
      WHERE false
      LIMIT v_limit
    )
    SELECT jsonb_build_object(
      'items', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', id,
        'title', title,
        'owner', owner,
        'status', status,
        'age', age,
        'source_ref', source_ref,
        'updated_at', updated_at
      ))), '[]'::jsonb),
      'next_cursor', NULL
    ) INTO v_decisions
    FROM decision_items;
  END IF;

  IF v_section IN ('all', 'sync') THEN
    /*
      QEP owns the source and exposed columns.
      Replace this CTE with Linear/snapshot sync health rows safe for the Command Center.
      Fully-qualify all schema references (for example, public.v_qep_roadmap_sync_health)
      because search_path is empty. This is intentional — prevents schema-search hijack.
      Recommended item keys: source, status, total_tasks, mirrored_tasks, pending_count, error_count, last_checked.
    */
    WITH sync_items AS (
      SELECT
        NULL::text AS source,
        NULL::text AS status,
        NULL::integer AS total_tasks,
        NULL::integer AS mirrored_tasks,
        NULL::integer AS pending_count,
        NULL::integer AS error_count,
        NULL::timestamptz AS last_checked
      WHERE false
      LIMIT v_limit
    )
    SELECT jsonb_build_object(
      'items', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'source', source,
        'status', status,
        'total_tasks', total_tasks,
        'mirrored_tasks', mirrored_tasks,
        'pending_count', pending_count,
        'error_count', error_count,
        'last_checked', last_checked
      ))), '[]'::jsonb),
      'next_cursor', NULL
    ) INTO v_sync
    FROM sync_items;
  END IF;

  RETURN jsonb_build_object(
    'roadmap', v_roadmap,
    'decisions', v_decisions,
    'sync', v_sync
  );
END;
$fn$;

ALTER FUNCTION public.cc_export_detail(text, text) OWNER TO cc_contract_owner;

COMMENT ON FUNCTION public.cc_export_detail(text, text) IS
  'Command Center cockpit detail contract. SECURITY DEFINER; QEP owns which safe columns each section exposes.';

REVOKE EXECUTE ON FUNCTION public.cc_export_detail(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cc_export_detail(text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.cc_export_detail(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cc_export_detail(text, text) TO command_center;
-- Note: NO `GRANT SELECT` to command_center. Function runs as cc_contract_owner.

COMMIT;
```

## Expected return shape

```json
{
  "roadmap": { "items": [], "next_cursor": null },
  "decisions": { "items": [], "next_cursor": null },
  "sync": { "items": [], "next_cursor": null }
}
```

`p_section` may be `all`, `roadmap`, `decisions`, or `sync`. `p_cursor` is reserved for section pagination; return each section's `next_cursor` as `null` until QEP adds cursoring.

## Verification

Positive case, using a JWT whose role claim is `command_center`:

```bash
curl -sS \
  -H "apikey: $READ_KEY_QEP" \
  -H "Authorization: Bearer $READ_KEY_QEP" \
  -H "Content-Type: application/json" \
  -X POST \
  --data '{"p_section":"all","p_cursor":null}' \
  "https://iciddijgonywtxoelous.supabase.co/rest/v1/rpc/cc_export_detail"
```

Expected: HTTP 200 and JSON with `roadmap`, `decisions`, and `sync` keys. Once QEP replaces the placeholder CTEs with safe views, the relevant section should return rows.

Negative case, using anon/authenticated/non-`command_center` credentials:

```bash
curl -i \
  -H "apikey: $QEP_ANON_KEY" \
  -H "Authorization: Bearer $QEP_ANON_KEY" \
  -H "Content-Type: application/json" \
  -X POST \
  --data '{"p_section":"all","p_cursor":null}' \
  "https://iciddijgonywtxoelous.supabase.co/rest/v1/rpc/cc_export_detail"
```

Expected: permission denied / not executable for non-`command_center` roles.

Direct-table negative case, using the database console after the function is installed:

```sql
SET ROLE command_center;
SELECT public.cc_export_detail('all', NULL); -- should succeed
SELECT * FROM public.qep_decisions LIMIT 1; -- must fail with permission denied
RESET ROLE;
```

Expected: `cc_export_detail()` succeeds, but direct reads from QEP tables still return `permission denied`. `command_center` has no direct `SELECT` on any QEP table — this is intentional federation containment.

## Command Center dependency

The Command Center control plane now calls `cc_export_detail(text, text)` and grants are ready for the `command_center` role. Runtime cutover still depends on the QEP team applying this SQL and minting/configuring `READ_KEY_QEP`; until then, `cc-read-app-detail` returns a structured 503 that the cockpit renders as “not yet wired.”
