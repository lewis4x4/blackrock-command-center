-- ============================================================================
-- Migration 005: login-free Command Center home
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- The home screen is a single-operator internal dashboard. Requiring a sign-in
-- to read it is friction with no payoff. This grants the anon role SELECT on
-- exactly the four tables the home reads, so the app loads with no login.
--
-- DELIBERATELY NOT exposed to anon: registry_app_supabase, registry_app_linear,
-- registry_app_repo — those carry project refs, repo names and secret-ref
-- pointers. They stay authenticated-only.
--
-- Trade-off: anyone with the deployed URL can now read the home data (app
-- names, counts, the audit feed). Acceptable for localhost / a private URL.
-- When this is deployed publicly, gate it at the host (Netlify password /
-- access list) rather than reinstating an app login.
-- ============================================================================

BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'registry_apps',
    'registry_app_snapshots',
    'registry_app_integrations',
    'cc_audit_events'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_anon_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (true)',
      t||'_anon_read', t);
  END LOOP;
END$$;

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DROP POLICY IF EXISTS registry_apps_anon_read              ON public.registry_apps;
--   DROP POLICY IF EXISTS registry_app_snapshots_anon_read     ON public.registry_app_snapshots;
--   DROP POLICY IF EXISTS registry_app_integrations_anon_read  ON public.registry_app_integrations;
--   DROP POLICY IF EXISTS cc_audit_events_anon_read            ON public.cc_audit_events;
-- COMMIT;
