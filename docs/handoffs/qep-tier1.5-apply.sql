-- ============================================================================
-- QEP Tier 1.5 — convert cc_export_snapshot() to SECURITY DEFINER
--
-- Apply on QEP data plane (iciddijgonywtxoelous), after Tier 1 has landed.
-- Idempotent. Safe to re-run.
--
-- Composed from the cc_export_snapshot() function body returned by the QEP
-- builder. The function reads exactly three relations:
--   - public.qep_roadmap_tasks
--   - public.qep_decisions
--   - public.v_qep_roadmap_sync_health
-- All three are already SELECT-granted to cc_contract_owner by Tier 1.
-- Tier 1.5 reuses that same role as the new function owner — no new role
-- needed, no new grants needed.
--
-- After this lands, both cc_export_snapshot() and cc_export_detail(text,text)
-- run under SECURITY DEFINER owned by cc_contract_owner. command_center holds
-- EXECUTE on both — never SELECT on raw tables.
--
-- service_role retains its existing EXECUTE on cc_export_snapshot() for the
-- 24-hour belt-and-suspenders cutover window. The Aggregator continues to
-- function under SVC_KEY_QEP until READ_KEY_QEP is installed and verified.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Membership prereq: the migrating role must be a member of cc_contract_owner
--    to execute ALTER FUNCTION ... OWNER TO cc_contract_owner. Idempotent.
-- ---------------------------------------------------------------------------

GRANT cc_contract_owner TO CURRENT_USER;

-- ---------------------------------------------------------------------------
-- 2. Temporary CREATE-on-schema grant. The QEP builder discovered during Tier 1
--    that PostgreSQL on Supabase requires this for ALTER FUNCTION ... OWNER TO
--    to succeed (in addition to role membership). Granted before ownership
--    transfer, revoked immediately after — cc_contract_owner does NOT retain
--    schema-create privileges.
-- ---------------------------------------------------------------------------

GRANT CREATE ON SCHEMA public TO cc_contract_owner;

-- ---------------------------------------------------------------------------
-- 3. Reassign ownership + flip security mode.
--
--    search_path stays at 'public' (its current value) intentionally. The
--    function body uses fully-qualified references (public.qep_roadmap_tasks,
--    etc.) AND calls built-in functions (jsonb_build_object, count, coalesce,
--    now) that live in pg_catalog. A bare search_path = '' would resolve the
--    fully-qualified names fine but would break the built-in calls during
--    function parse/validation, since they're unqualified. Leaving it as
--    'public' is the safe, idempotent move; the qualified user-object refs
--    are the actual security control here.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.cc_export_snapshot() OWNER TO cc_contract_owner;
ALTER FUNCTION public.cc_export_snapshot() SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- 4. Grant EXECUTE to command_center. service_role retains its existing
--    EXECUTE (NOT revoked here) so the Aggregator's belt-and-suspenders
--    fallback continues to work during the 24-hour cutover window.
--    Optional hardening (separate Tier 1.6) can revoke service_role after
--    verification shows key_class:"readonly" for 24h.
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION public.cc_export_snapshot() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cc_export_snapshot() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cc_export_snapshot() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.cc_export_snapshot() TO command_center;

-- ---------------------------------------------------------------------------
-- 5. Revoke the temporary CREATE-on-schema grant — cc_contract_owner has no
--    need to create new objects in public going forward.
-- ---------------------------------------------------------------------------

REVOKE CREATE ON SCHEMA public FROM cc_contract_owner;

COMMIT;

-- ============================================================================
-- Verification after applying
--
-- Should succeed and return the snapshot JSON envelope (proves federation
-- works for the snapshot path now too):
--
--   SET ROLE command_center;
--   SELECT public.cc_export_snapshot();
--   RESET ROLE;
--
-- Should still fail with permission denied (federation boundary holds — the
-- new EXECUTE grant did NOT come with table SELECTs):
--
--   SET ROLE command_center;
--   SELECT * FROM public.qep_roadmap_tasks LIMIT 1;
--   RESET ROLE;
--
-- Confirm the ownership/security flip landed:
--
--   SELECT
--     p.prosecdef                    AS is_security_definer,
--     pg_get_userbyid(p.proowner)    AS owner_role
--   FROM pg_proc p
--   WHERE p.proname = 'cc_export_snapshot'
--     AND p.pronamespace = 'public'::regnamespace;
--
-- Expected: is_security_definer=true, owner_role='cc_contract_owner'.
--
-- After this lands, return control to the orchestrator. The next steps
-- (which I handle from the control-plane side, not on QEP):
--   1. Mint READ_KEY_QEP (90-day JWT signed with QEP's JWT secret).
--   2. supabase secrets set READ_KEY_QEP on gsvhuzpysxaegoecwjmf.
--   3. Wait one 5-minute cron tick.
--   4. Run scripts/verify-qep-cutover.sh — expect key_class:"readonly".
--   5. After 24h of zero fallback events, retire SVC_KEY_QEP.
-- ============================================================================
