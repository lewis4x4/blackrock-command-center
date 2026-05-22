-- ============================================================================
-- QEP Tier 1 — apply on QEP data plane (iciddijgonywtxoelous)
--
-- Run as `postgres` (the default in the Supabase SQL editor).
-- Safe to re-run; every step is idempotent.
--
-- What this does (Tier 1 — cockpit path only)
--   1. Creates the command_center role + grants USAGE on the public schema.
--   2. Creates the cc_contract_owner role (owns cc_export_detail under SECURITY
--      DEFINER, holds SELECT on QEP source tables, never granted to anyone else).
--   3. Creates three "safe views" mapping QEP's real columns to the cockpit's
--      expected shape — column names from qep-introspect output.
--   4. Creates cc_export_detail(text, text) as SECURITY DEFINER, owned by
--      cc_contract_owner. command_center holds EXECUTE only — never SELECT on
--      raw QEP tables. This is the federation boundary.
--
-- DEFERRED to a follow-up Tier 1.5
--   - cc_export_snapshot() SECURITY mode conversion. A first attempt at flipping
--     it to DEFINER + owner=postgres broke because Supabase's `postgres` role
--     lacks SELECT on v_qep_roadmap_sync_health (owned by supabase_admin). The
--     conversion needs visibility into the function body; see §3 below.
--   - Setting READ_KEY_QEP on the control plane. The Aggregator's belt-and-
--     suspenders fallback would try it for cc_export_snapshot and fail every
--     5 minutes until Tier 1.5 lands. Hold READ_KEY_QEP installation until
--     Tier 1.5 ships.
--
-- Verify after applying THIS file — should succeed:
--   SET ROLE command_center;
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

-- Make the migrating role (typically `postgres` in the Supabase SQL editor) a
-- member of cc_contract_owner so the ALTER FUNCTION ... OWNER TO statement
-- below can proceed. PostgreSQL requires SET ROLE membership for ownership
-- reassignment. Idempotent.
GRANT cc_contract_owner TO CURRENT_USER;

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
-- 3. cc_export_snapshot() — DEFERRED to a separate Tier 1.5 slice.
--
--    The first apply attempt converted this function to SECURITY DEFINER with
--    owner postgres, which broke immediately:
--
--      ERROR: 42501: permission denied for view v_qep_roadmap_sync_health
--      CONTEXT: SQL function "cc_export_snapshot" during startup
--
--    Root cause: on Supabase, `postgres` is NOT a full superuser. The view
--    v_qep_roadmap_sync_health is owned by `supabase_admin`, so when
--    cc_export_snapshot ran under DEFINER + owner=postgres, the SELECT was
--    refused. The function's body references multiple views/tables we don't
--    have full visibility into.
--
--    Resolution path for Tier 1.5 (handled separately):
--      1. Inspect the function body:
--           SELECT pg_get_functiondef(oid)
--             FROM pg_proc
--            WHERE proname = 'cc_export_snapshot'
--              AND pronamespace = 'public'::regnamespace;
--      2. Enumerate every relation it reads.
--      3. Create cc_snapshot_owner role; GRANT SELECT on each of those.
--      4. ALTER FUNCTION ... OWNER TO cc_snapshot_owner; flip to DEFINER.
--
--    Until Tier 1.5: the Aggregator continues to call cc_export_snapshot
--    under SVC_KEY_QEP (the existing service-role fallback the post-014
--    aggregator code already supports). The cockpit's cc_export_detail
--    path — installed below — is federation-pure today and the bigger win.
-- ---------------------------------------------------------------------------

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
-- This Tier 1 ships the cockpit federation path only. cc_export_snapshot is
-- intentionally untouched; the Aggregator continues using SVC_KEY_QEP for
-- snapshot polls until Tier 1.5 lands.
--
-- Next steps for the operator
--   1. Run the verification queries at the top of this file under
--      `SET ROLE command_center` and confirm the positive case returns rows.
--   2. Run this introspection query and paste the output back to the
--      orchestrator so Tier 1.5 can be composed:
--
--        SELECT pg_get_functiondef(oid) AS body
--          FROM pg_proc
--         WHERE proname = 'cc_export_snapshot'
--           AND pronamespace = 'public'::regnamespace;
--
--   3. Do NOT yet set READ_KEY_QEP on the control plane. That step happens
--      after Tier 1.5 closes the snapshot path.
-- ============================================================================
