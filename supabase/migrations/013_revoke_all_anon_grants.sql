-- ============================================================================
-- Migration 013: revoke every anon grant on the Command Center
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- The §4.11 read API is now in place: the browser reads every Command Center
-- surface through one of four edge functions (cc-read-home, cc-read-app,
-- cc-read-audit, cc-read-artifacts), each holding the service_role key
-- server-side. The browser ships without a Supabase database key.
--
-- This migration retires the migration-005 anon SELECT policies and revokes
-- the underlying table grants from anon. After this lands:
--   - No Command Center table is readable by the anon role.
--   - The Supabase REST endpoint is not browser-reachable for our data.
--   - Cloudflare Access is the one and only identity gate (S1 in front).
--
-- ORDER OF OPERATIONS: this migration must be applied AFTER the frontend
-- (web/src/lib.ts) is wired to the new edge functions. The current branch
-- (cc/s1-close-the-exposure) ships both changes together; do not deploy
-- this migration alone.
-- ============================================================================

BEGIN;

-- Drop the migration-005 anon SELECT policies.
DROP POLICY IF EXISTS registry_apps_anon_read              ON public.registry_apps;
DROP POLICY IF EXISTS registry_app_snapshots_anon_read     ON public.registry_app_snapshots;
DROP POLICY IF EXISTS registry_app_integrations_anon_read  ON public.registry_app_integrations;
DROP POLICY IF EXISTS cc_audit_events_anon_read            ON public.cc_audit_events;
-- migration 007 also installed an anon read policy on cc_issues — drop it too.
DROP POLICY IF EXISTS cc_issues_anon_read                  ON public.cc_issues;

-- Migration 006 explicitly GRANTed SELECT on cc_audit_events to anon. The
-- other three carry Supabase's default-privilege SELECT grant. Revoke all
-- of them. cc_issues was never anon-readable by policy but defaults may
-- still expose it — revoke defensively. cc_artifacts (migration 010) and
-- the file-retrieval registry never had anon access; included for symmetry.
REVOKE ALL PRIVILEGES ON public.registry_apps              FROM anon;
REVOKE ALL PRIVILEGES ON public.registry_app_snapshots     FROM anon;
REVOKE ALL PRIVILEGES ON public.registry_app_integrations  FROM anon;
REVOKE ALL PRIVILEGES ON public.cc_audit_events            FROM anon;
REVOKE ALL PRIVILEGES ON public.cc_issues                  FROM anon;
REVOKE ALL PRIVILEGES ON public.cc_artifacts               FROM anon;

-- Defensive: revoke any anon EXECUTE on Command Center functions. service_role
-- and authenticated retain their existing grants from earlier migrations.
REVOKE ALL ON FUNCTION public.cc_reconcile_app_issues(uuid, jsonb)  FROM anon;

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert — DO NOT use in production
-- without first re-introducing a browser-side read path).
-- ============================================================================
-- BEGIN;
--   GRANT SELECT ON public.registry_apps              TO anon;
--   GRANT SELECT ON public.registry_app_snapshots     TO anon;
--   GRANT SELECT ON public.registry_app_integrations  TO anon;
--   GRANT SELECT ON public.cc_audit_events            TO anon;
--   CREATE POLICY registry_apps_anon_read              ON public.registry_apps              FOR SELECT TO anon USING (true);
--   CREATE POLICY registry_app_snapshots_anon_read     ON public.registry_app_snapshots     FOR SELECT TO anon USING (true);
--   CREATE POLICY registry_app_integrations_anon_read  ON public.registry_app_integrations  FOR SELECT TO anon USING (true);
--   CREATE POLICY cc_audit_events_anon_read            ON public.cc_audit_events            FOR SELECT TO anon USING (true);
-- COMMIT;
