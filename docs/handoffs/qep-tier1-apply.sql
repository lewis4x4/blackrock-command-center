-- ============================================================================
-- QEP Tier 1 — apply on QEP data plane (iciddijgonywtxoelous)
--
-- Run as `postgres` (the default in the Supabase SQL editor).
-- Safe to re-run; every step is idempotent.
--
-- What this does
--   1. Creates the command_center role + grants USAGE on the public schema.
--   2. Creates the cc_contract_owner role (owns cc_export_detail under SECURITY
--      DEFINER, holds SELECT on QEP source tables, never granted to anyone else).
--   3. Inspects cc_export_snapshot()'s current security mode. If it is
--      SECURITY INVOKER, reassigns ownership to postgres and flips to DEFINER
--      with empty search_path. Idempotent — if already DEFINER, this is a no-op.
--   4. Creates three "safe views" mapping QEP's real columns to the cockpit's
--      expected shape — column names from qep-introspect output.
--   5. Creates cc_export_detail(text, text) as SECURITY DEFINER, owned by
--      cc_contract_owner. command_center holds EXECUTE only — never SELECT on
--      raw QEP tables. This is the federation boundary.
--
-- Verify after applying — should all succeed:
--   SET ROLE command_center;
--     SELECT public.cc_export_snapshot();
--     SELECT public.cc_export_detail('all', NULL);
--   RESET ROLE;
--
-- Verify after applying — should all FAIL with "permission denied":
--   SET ROLE command_center;
--     SELECT * FROM public.qep_decisions LIMIT 1;
--     SELECT * FROM public.qep_roadmap_tasks LIMIT 1;
--     SELECT * FROM public.cc_safe_decision_items LIMIT 1;
--   RESET ROLE;
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_center') THEN
    CREATE ROLE command_center NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cc_contract_owner') THEN
    CREATE ROLE cc_contract_owner NOLOGIN;
  END IF;
END$$;

-- PostgREST needs to be able to switch into the JWT's role: "command_center" claim.
GRANT command_center TO authenticator;

-- command_center can resolve names in the public schema, but cannot read any
-- table or view there directly — only call the contract functions.
GRANT USAGE ON SCHEMA public TO command_center;
GRANT USAGE ON SCHEMA public TO cc_contract_owner;

-- ---------------------------------------------------------------------------
-- 2. cc_contract_owner gets SELECT on the QEP source tables + views.
--    These grants stay on cc_contract_owner. They are never granted to
--    command_center.
-- ---------------------------------------------------------------------------

GRANT SELECT ON public.qep_roadmap_tasks       TO cc_contract_owner;
GRANT SELECT ON public.qep_decisions           TO cc_contract_owner;
GRANT SELECT ON public.v_qep_roadmap_sync_health TO cc_contract_owner;

-- ---------------------------------------------------------------------------
-- 3. cc_export_snapshot() — verify or convert to SECURITY DEFINER.
--    The introspect proved this function exists. SECURITY mode is unknown
--    from REST-only introspection, so we check pg_catalog directly (the SQL
--    editor runs as postgres and can read it).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_secdef boolean;
  v_owner  name;
BEGIN
  SELECT p.prosecdef, pg_get_userbyid(p.proowner)
    INTO v_secdef, v_owner
    FROM pg_proc p
   WHERE p.proname = 'cc_export_snapshot'
     AND p.pronamespace = 'public'::regnamespace
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'public.cc_export_snapshot() does not exist on this database';
  END IF;

  IF NOT v_secdef THEN
    -- Was SECURITY INVOKER. Flip to DEFINER and ensure ownership is a role
    -- that has the SELECTs the function body needs. postgres is the Supabase
    -- superuser, so reassigning to it is safe.
    EXECUTE 'ALTER FUNCTION public.cc_export_snapshot() OWNER TO postgres';
    EXECUTE 'ALTER FUNCTION public.cc_export_snapshot() SECURITY DEFINER';
    EXECUTE 'ALTER FUNCTION public.cc_export_snapshot() SET search_path = ''''';
    RAISE NOTICE 'cc_export_snapshot: converted INVOKER -> DEFINER, owner -> postgres';
  ELSE
    RAISE NOTICE 'cc_export_snapshot: already SECURITY DEFINER (owner = %)', v_owner;
  END IF;
END$$;

REVOKE EXECUTE ON FUNCTION public.cc_export_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_export_snapshot() TO command_center;

-- ---------------------------------------------------------------------------
-- 4. Safe views — map QEP's real columns into the cockpit's expected shape.
--    Column names from qep-introspect output.
-- ---------------------------------------------------------------------------

-- 4a. Roadmap items
--   qep_roadmap_tasks → cc_safe_roadmap_items
--     ship_state       → status
--     sort_order::text → priority   (cast for cockpit string shape)
--     blocking_decision→ blocker
CREATE OR REPLACE VIEW public.cc_safe_roadmap_items AS
  SELECT
    id::text             AS id,
    stream,
    wave,
    title,
    ship_state           AS status,
    owner,
    sort_order::text     AS priority,
    blocking_decision    AS blocker,
    updated_at
  FROM public.qep_roadmap_tasks;

-- 4b. Decision items
--   qep_decisions → cc_safe_decision_items
--     question_plain   → title
--     owner_role       → owner
--     code             → source_ref
--     decision_class   → risk_class (validated against enum)
--     created_at delta → age_days
--     owner_role prefix→ owner_kind (heuristic; QEP can refine later)
--   Filter: only open decisions (answered_at IS NULL).
CREATE OR REPLACE VIEW public.cc_safe_decision_items AS
  SELECT
    id::text             AS id,
    question_plain       AS title,
    owner_role           AS owner,
    status,
    code                 AS source_ref,
    options,
    updated_at,
    CASE
      WHEN lower(coalesce(decision_class::text, ''))
        IN ('auto', 'authorize', 'destructive', 'production')
        THEN lower(decision_class::text)
      ELSE 'authorize'
    END                  AS risk_class,
    EXTRACT(DAY FROM (now() - created_at))::int AS age_days,
    CASE
      WHEN lower(coalesce(owner_role, '')) LIKE 'client%'
        THEN 'client'
      ELSE 'operator'
    END                  AS owner_kind
  FROM public.qep_decisions
  WHERE answered_at IS NULL;

-- 4c. Sync items
--   v_qep_roadmap_sync_health → cc_safe_sync_items
--     constant 'linear'     → source
--     derived from counts   → status
--     last_synced_at        → last_checked
CREATE OR REPLACE VIEW public.cc_safe_sync_items AS
  SELECT
    'linear'::text       AS source,
    CASE
      WHEN error_count   > 0 THEN 'error'
      WHEN pending_count > 0 THEN 'pending'
      ELSE                       'healthy'
    END                  AS status,
    total_tasks,
    mirrored_tasks,
    pending_count,
    error_count,
    last_synced_at       AS last_checked
  FROM public.v_qep_roadmap_sync_health;

-- Grant SELECT on the safe views to cc_contract_owner only. command_center
-- never gets SELECT on anything — it executes the function.
GRANT SELECT ON public.cc_safe_roadmap_items   TO cc_contract_owner;
GRANT SELECT ON public.cc_safe_decision_items  TO cc_contract_owner;
GRANT SELECT ON public.cc_safe_sync_items      TO cc_contract_owner;

-- ---------------------------------------------------------------------------
-- 5. cc_export_detail(text, text) — SECURITY DEFINER, owned by cc_contract_owner.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cc_export_detail(
  p_section text DEFAULT 'all',
  p_cursor  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_section   text    := lower(coalesce(nullif(trim(p_section), ''), 'all'));
  v_limit     integer := 50;
  v_roadmap   jsonb   := jsonb_build_object('items', '[]'::jsonb, 'next_cursor', NULL);
  v_decisions jsonb   := jsonb_build_object('items', '[]'::jsonb, 'next_cursor', NULL);
  v_sync      jsonb   := jsonb_build_object('items', '[]'::jsonb, 'next_cursor', NULL);
BEGIN
  IF v_section NOT IN ('all', 'roadmap', 'decisions', 'sync') THEN
    RAISE EXCEPTION 'cc_export_detail: invalid section %', p_section
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_section IN ('all', 'roadmap') THEN
    SELECT jsonb_build_object(
      'items', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',         id,
        'stream',     stream,
        'wave',       wave,
        'title',      title,
        'status',     status,
        'owner',      owner,
        'priority',   priority,
        'blocker',    blocker,
        'updated_at', updated_at
      ))), '[]'::jsonb),
      'next_cursor', NULL
    ) INTO v_roadmap
    FROM (
      SELECT id, stream, wave, title, status, owner, priority, blocker, updated_at
      FROM public.cc_safe_roadmap_items
      ORDER BY updated_at DESC NULLS LAST
      LIMIT v_limit
    ) r;
  END IF;

  IF v_section IN ('all', 'decisions') THEN
    SELECT jsonb_build_object(
      'items', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',          id,
        'title',       title,
        'owner',       owner,
        'owner_kind',  owner_kind,
        'risk_class',  risk_class,
        'options',     options,
        'status',      status,
        'age',         age_days::text || 'd',
        'source_ref',  source_ref,
        'updated_at',  updated_at
      ))), '[]'::jsonb),
      'next_cursor', NULL
    ) INTO v_decisions
    FROM (
      SELECT id, title, owner, owner_kind, risk_class, options, status, age_days, source_ref, updated_at
      FROM public.cc_safe_decision_items
      ORDER BY age_days DESC NULLS LAST
      LIMIT v_limit
    ) d;
  END IF;

  IF v_section IN ('all', 'sync') THEN
    SELECT jsonb_build_object(
      'items', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'source',         source,
        'status',         status,
        'total_tasks',    total_tasks,
        'mirrored_tasks', mirrored_tasks,
        'pending_count',  pending_count,
        'error_count',    error_count,
        'last_checked',   last_checked
      ))), '[]'::jsonb),
      'next_cursor', NULL
    ) INTO v_sync
    FROM public.cc_safe_sync_items;
  END IF;

  RETURN jsonb_build_object(
    'roadmap',   v_roadmap,
    'decisions', v_decisions,
    'sync',      v_sync
  );
END;
$fn$;

ALTER FUNCTION public.cc_export_detail(text, text) OWNER TO cc_contract_owner;

COMMENT ON FUNCTION public.cc_export_detail(text, text) IS
  'Command Center cockpit detail contract. SECURITY DEFINER. Owned by cc_contract_owner. command_center holds EXECUTE only.';

REVOKE EXECUTE ON FUNCTION public.cc_export_detail(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cc_export_detail(text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.cc_export_detail(text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.cc_export_detail(text, text) TO command_center;

COMMIT;

-- ============================================================================
-- Done.
--
-- Expected NOTICEs you should see:
--   "cc_export_snapshot: converted INVOKER -> DEFINER, owner -> postgres"
--   OR
--   "cc_export_snapshot: already SECURITY DEFINER (owner = ...)"
--
-- Next: run the verification queries at the top of this file under
-- `SET ROLE command_center`. Then hand control back to the orchestrator and
-- proceed to Step 2 (mint READ_KEY_QEP + supabase secrets set).
-- ============================================================================
