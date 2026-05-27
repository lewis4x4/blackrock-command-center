-- ============================================================================
-- PAUSED — SCC registration was applied to remote on 2026-05-24 but the SCC
-- onboarding effort was paused on 2026-05-25 in favor of a greenfield app
-- (see conversation log). The row exists in registry_apps with no keys minted,
-- so the Aggregator returns 401 every 5 min — known acceptable state.
--
-- To resume: mint SVC_KEY_SCC + READ_KEY_SCC in the control plane Vault,
-- then proceed to F6 Phase B per docs/COMMAND_CENTER_MASTER_PLAN.md §9.
-- To remove: write a follow-up migration that soft-deletes from registry_apps.
-- ============================================================================

-- ============================================================================
-- Migration 038: Register SCC as Command Center app #2
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- F6 Phase A — onboard SCC (Southern Coal / Justice Companies) as the second
-- federated app. Mirrors 002_register_qep_app structure exactly so that the
-- onboarding pattern itself becomes the template for app #3 (Circle of Life)
-- and beyond.
--
-- SECRETS RULE (migration 001): no raw key lives in a registry row. The
-- *_secret_ref columns hold opaque vault pointers only. The actual
-- SVC_KEY_SCC and READ_KEY_SCC values land as Supabase Edge Function secrets
-- in Phase C; this migration just registers the pointer names.
--
-- Idempotent: every insert is guarded (ON CONFLICT / NOT EXISTS) so re-running
-- this migration is safe. No DO block, no nested dollar-quoting.
--
-- Phase B (data plane: command_center role, safe views, cc_export_snapshot,
-- cc_export_detail) happens via handoff docs against the SCC project itself,
-- not in this migration. This file only touches the control plane.
--
-- Linear and integrations rows are intentionally omitted; backfill via
-- follow-up migration when SCC's Linear workspace + integration roadmap are
-- known. The Aggregator does not require these to begin polling.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. registry_apps — the app itself
--    Criticality 90: just below QEP (100) so QEP claims the runner first when
--    both have work; well above the implicit default for future apps.
-- ----------------------------------------------------------------------------
INSERT INTO public.registry_apps
  (short_code, display_name, client_name, status, lifecycle_phase, criticality, notes)
VALUES
  ('SCC', 'Justice Companies', 'Justice Companies',
   'active', 'build', 90,
   'Command Center app #2. Southern Coal / Justice Companies operations platform. First federation proving ground — the migration pattern here becomes the template for app #3 onward.')
ON CONFLICT (short_code) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. registry_app_supabase — SCC's isolated data plane
--    Project: zymenlnwyzpnohljwifx (East US / N. Virginia, us-east-1)
--    Org:     juclqvizrlhogvdgoqqg
-- ----------------------------------------------------------------------------
INSERT INTO public.registry_app_supabase
  (app_id, project_ref, project_url, region, snapshot_contract_version, service_secret_ref)
SELECT a.id, 'zymenlnwyzpnohljwifx', 'https://zymenlnwyzpnohljwifx.supabase.co',
       'us-east-1', 1, 'SVC_KEY_SCC'
FROM public.registry_apps a
WHERE a.short_code = 'SCC'
ON CONFLICT (app_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. registry_app_repo — SCC's GitHub repo
--    NOTE: roadmap_doc_path is a repo-RELATIVE path. Operator-supplied local
--    path was /Users/brianlewis/Southern Coal/SOUTHERN COAL/projects/justice-
--    companies/scc-os/UNIFIED_ROADMAP.md. Best-guess relative path used here;
--    operator to confirm/correct via follow-up UPDATE if the repo layout
--    differs from the local mirror.
-- ----------------------------------------------------------------------------
INSERT INTO public.registry_app_repo
  (app_id, github_repo, default_branch, roadmap_doc_path)
SELECT a.id, 'lewis4x4/SouthernCoal', 'main',
       'projects/justice-companies/scc-os/UNIFIED_ROADMAP.md'
FROM public.registry_apps a
WHERE a.short_code = 'SCC'
ON CONFLICT (app_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. registry_app_owners — the SCC people who answer decisions
--    For now: Brian only. Additional owners (Justice Companies operators)
--    land via follow-up migration when assigned.
-- ----------------------------------------------------------------------------
INSERT INTO public.registry_app_owners
  (app_id, person_name, person_email, portal_role, is_decision_owner)
SELECT a.id, o.person_name, o.person_email, o.portal_role, o.is_decision_owner
FROM public.registry_apps a
CROSS JOIN (VALUES
  ('Brian Lewis', 'brian.lewis@blackrockai.co', 'owner_all', true)
) AS o(person_name, person_email, portal_role, is_decision_owner)
WHERE a.short_code = 'SCC'
  AND NOT EXISTS (
    SELECT 1 FROM public.registry_app_owners x
    WHERE x.app_id = a.id AND x.person_name = o.person_name
  );

-- ----------------------------------------------------------------------------
-- 5. cc_audit_events — record the provisioning
-- ----------------------------------------------------------------------------
INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
SELECT a.id, 'brian.lewis@blackrockai.co', 'app_provisioned',
       jsonb_build_object(
         'short_code', 'SCC',
         'migration', '038_register_scc_app',
         'data_plane', 'zymenlnwyzpnohljwifx',
         'github_repo', 'lewis4x4/SouthernCoal',
         'phase', 'F6 Phase A — control-plane registration only')
FROM public.registry_apps a
WHERE a.short_code = 'SCC';

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DELETE FROM public.cc_audit_events
--     WHERE app_id = (SELECT id FROM public.registry_apps WHERE short_code='SCC');
--   DELETE FROM public.registry_apps WHERE short_code = 'SCC';  -- cascades children
-- COMMIT;
