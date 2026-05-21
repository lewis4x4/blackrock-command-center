-- ============================================================================
-- Migration 006: cc_audit_events — truly append-only
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- OS roadmap Phase 0 — honest foundation.
--
-- cc_audit_events records every secret read and every agent dispatch. As built
-- (migration 001) the service_role holds FOR ALL on it and can UPDATE or DELETE
-- any row. An audit log a process can rewrite is not an audit log. This
-- migration makes it tamper-evident, three layers deep:
--
--   1. Privilege lock — REVOKE UPDATE, DELETE, TRUNCATE from every grantable
--      role (anon, authenticated, service_role, PUBLIC). INSERT and SELECT
--      stay: the Aggregator still writes, the home still reads.
--   2. Tamper guard — a trigger that hard-refuses UPDATE / DELETE / TRUNCATE
--      for ALL roles, the table owner included. service_role carries BYPASSRLS,
--      so RLS alone cannot stop it; a trigger fires regardless of BYPASSRLS.
--      A future migration cannot silently rewrite history without first,
--      visibly, dropping this guard.
--   3. RLS intent — the FOR ALL service policy is replaced with INSERT + SELECT
--      so the policy set no longer advertises a mutate path.
--
-- The Aggregator (supabase/functions/aggregator) only ever INSERTs audit rows
-- (snapshot_captured / snapshot_failed) — this migration does not affect it.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Privilege lock — no grantable role may mutate or wipe the log
-- ----------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON public.cc_audit_events FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON public.cc_audit_events FROM anon;
REVOKE UPDATE, DELETE, TRUNCATE ON public.cc_audit_events FROM authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON public.cc_audit_events FROM service_role;

-- INSERT + SELECT remain. Re-assert them so intent is explicit in the schema.
GRANT INSERT, SELECT ON public.cc_audit_events TO service_role;
GRANT SELECT          ON public.cc_audit_events TO authenticated;
GRANT SELECT          ON public.cc_audit_events TO anon;

-- ----------------------------------------------------------------------------
-- 2. Tamper guard — a trigger that refuses UPDATE / DELETE / TRUNCATE outright.
--    Triggers cannot be bypassed by BYPASSRLS and fire for every role, so this
--    holds even against service_role and the table owner.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cc_audit_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  RAISE EXCEPTION
    'cc_audit_events is append-only — % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

COMMENT ON FUNCTION public.fn_cc_audit_immutable() IS
  'Append-only guard for cc_audit_events. Raises on any UPDATE/DELETE/TRUNCATE. Drop the triggers below, visibly, to ever override.';

DROP TRIGGER IF EXISTS cc_audit_events_no_update ON public.cc_audit_events;
CREATE TRIGGER cc_audit_events_no_update
  BEFORE UPDATE ON public.cc_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_audit_immutable();

DROP TRIGGER IF EXISTS cc_audit_events_no_delete ON public.cc_audit_events;
CREATE TRIGGER cc_audit_events_no_delete
  BEFORE DELETE ON public.cc_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_audit_immutable();

DROP TRIGGER IF EXISTS cc_audit_events_no_truncate ON public.cc_audit_events;
CREATE TRIGGER cc_audit_events_no_truncate
  BEFORE TRUNCATE ON public.cc_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cc_audit_immutable();

-- ----------------------------------------------------------------------------
-- 3. RLS — replace the FOR ALL service policy with INSERT + SELECT only.
--    The authenticated/anon SELECT policies (migrations 001, 005) stay as-is.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS cc_audit_events_service_all   ON public.cc_audit_events;
DROP POLICY IF EXISTS cc_audit_events_service_write ON public.cc_audit_events;
DROP POLICY IF EXISTS cc_audit_events_service_read  ON public.cc_audit_events;

CREATE POLICY cc_audit_events_service_write
  ON public.cc_audit_events FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY cc_audit_events_service_read
  ON public.cc_audit_events FOR SELECT TO service_role USING (true);

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DROP TRIGGER IF EXISTS cc_audit_events_no_update   ON public.cc_audit_events;
--   DROP TRIGGER IF EXISTS cc_audit_events_no_delete   ON public.cc_audit_events;
--   DROP TRIGGER IF EXISTS cc_audit_events_no_truncate ON public.cc_audit_events;
--   DROP FUNCTION IF EXISTS public.fn_cc_audit_immutable();
--   DROP POLICY IF EXISTS cc_audit_events_service_write ON public.cc_audit_events;
--   DROP POLICY IF EXISTS cc_audit_events_service_read  ON public.cc_audit_events;
--   CREATE POLICY cc_audit_events_service_all ON public.cc_audit_events
--     FOR ALL TO service_role USING (true) WITH CHECK (true);
--   GRANT UPDATE, DELETE, TRUNCATE ON public.cc_audit_events TO service_role;
-- COMMIT;
