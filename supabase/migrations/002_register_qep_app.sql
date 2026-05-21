-- ============================================================================
-- Migration 002: Register QEP as Command Center app #1
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- This is "Phase 1 — first light, step 7": QEP OS becomes the first row in the
-- federated registry. It seeds one registry_apps row plus its data-plane,
-- Linear, repo, owner, and integration records.
--
-- SECRETS RULE (migration 001): no raw key lives in a registry row. The
-- *_secret_ref columns hold opaque vault pointers only.
--
-- Idempotent: every insert is guarded (ON CONFLICT / NOT EXISTS) so re-running
-- this migration is safe. No DO block, no nested dollar-quoting.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. registry_apps — the app itself
-- ----------------------------------------------------------------------------
INSERT INTO public.registry_apps
  (short_code, display_name, client_name, status, lifecycle_phase, criticality, notes)
VALUES
  ('QEP', 'QEP OS', 'Quality Equipment & Parts, Inc.',
   'active', 'build', 100,
   'Command Center app #1. AI-native Dealership Operating System. Phase 1 replaces HubSpot; Phases 3-8 progressively replace IntelliDealer. Lake City, FL heavy-equipment dealership.')
ON CONFLICT (short_code) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. registry_app_supabase — QEP's isolated data plane
-- ----------------------------------------------------------------------------
INSERT INTO public.registry_app_supabase
  (app_id, project_ref, project_url, region, snapshot_contract_version, service_secret_ref)
SELECT a.id, 'iciddijgonywtxoelous', 'https://iciddijgonywtxoelous.supabase.co',
       'us-west-2', 1, 'SVC_KEY_QEP'
FROM public.registry_apps a
WHERE a.short_code = 'QEP'
ON CONFLICT (app_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. registry_app_linear — QEP's Linear team + sync config
--    status_map: QEP 7-state ship vocabulary -> Linear workflow state names.
--    stream_project_map: stream code -> Linear project name.
-- ----------------------------------------------------------------------------
INSERT INTO public.registry_app_linear
  (app_id, workspace_name, team_key, api_key_ref, webhook_secret_ref, status_map, stream_project_map)
SELECT a.id, 'QEP OS', 'QEP',
       'vault://qep/linear/api_key',
       'vault://qep/linear/webhook_secret',
       '{"not_started":"Backlog","in_progress":"In Progress","blocked":"Blocked","pending_decision":"Pending Decision","shipped":"Done","deferred":"Deferred","na":"Canceled"}'::jsonb,
       '{"A":"Stream A - Iron Quote","B":"Stream B - Sales Advisor","C":"Stream C - IntelliDealer Cutover","D":"Stream D - Parity & Decisions","E":"Stream E - Platform Foundation","F":"Stream F - Decision Velocity"}'::jsonb
FROM public.registry_apps a
WHERE a.short_code = 'QEP'
ON CONFLICT (app_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. registry_app_repo — QEP's GitHub repo
-- ----------------------------------------------------------------------------
INSERT INTO public.registry_app_repo
  (app_id, github_repo, default_branch, roadmap_doc_path)
SELECT a.id, 'lewis4x4/qep', 'main', 'QEP (1)/QEP_UNIFIED_ROADMAP_2026-05-19.md'
FROM public.registry_apps a
WHERE a.short_code = 'QEP'
ON CONFLICT (app_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 5. registry_app_owners — the QEP people who answer decisions
-- ----------------------------------------------------------------------------
INSERT INTO public.registry_app_owners
  (app_id, person_name, person_email, portal_role, is_decision_owner)
SELECT a.id, o.person_name, o.person_email, o.portal_role, o.is_decision_owner
FROM public.registry_apps a
CROSS JOIN (VALUES
  ('Ryan McKenzie',  NULL::text, 'owner_all', true),
  ('Rylee McKenzie', NULL::text, 'sales',     true),
  ('Angela',         NULL::text, 'sales',     false),
  ('Norman',         NULL::text, 'parts',     false),
  ('Tina',           NULL::text, 'finance',   false)
) AS o(person_name, person_email, portal_role, is_decision_owner)
WHERE a.short_code = 'QEP'
  AND NOT EXISTS (
    SELECT 1 FROM public.registry_app_owners x
    WHERE x.app_id = a.id AND x.person_name = o.person_name
  );

-- ----------------------------------------------------------------------------
-- 6. registry_app_integrations — external systems wired per app
--    All 'planned': Phase 1 build is authorized but no integration is live yet.
-- ----------------------------------------------------------------------------
INSERT INTO public.registry_app_integrations
  (app_id, integration_type, status, config)
SELECT a.id, i.integration_type, i.status::public.cc_integration_status, i.config::jsonb
FROM public.registry_apps a
CROSS JOIN (VALUES
  ('m365',         'planned', '{"purpose":"Outlook + OneDrive via Microsoft Graph API","phase":"1C"}'),
  ('twilio',       'planned', '{"purpose":"SMS/MMS - replaces VitalEngage","phase":"1C"}'),
  ('8x8',          'planned', '{"purpose":"Phone - call logging + AI transcript summarization","phase":"1C"}'),
  ('hubspot',      'planned', '{"purpose":"CRM migration source","phase":"1D"}'),
  ('intellidealer','planned', '{"purpose":"VitalEdge DMS - integrate then replace","phase":"3+"}'),
  ('quickbooks',   'planned', '{"purpose":"Accounting export","phase":"8"}'),
  ('oem_portal',   'planned', '{"purpose":"22+ manufacturer portals - SSO + price feeds","phase":"9"}')
) AS i(integration_type, status, config)
WHERE a.short_code = 'QEP'
  AND NOT EXISTS (
    SELECT 1 FROM public.registry_app_integrations x
    WHERE x.app_id = a.id AND x.integration_type = i.integration_type
  );

-- ----------------------------------------------------------------------------
-- 7. cc_audit_events — record the provisioning
-- ----------------------------------------------------------------------------
INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
SELECT a.id, 'blewis@lewisinsurance.com', 'app_provisioned',
       jsonb_build_object(
         'short_code', 'QEP',
         'migration', '002_register_qep_app',
         'data_plane', 'iciddijgonywtxoelous')
FROM public.registry_apps a
WHERE a.short_code = 'QEP';

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DELETE FROM public.cc_audit_events
--     WHERE app_id = (SELECT id FROM public.registry_apps WHERE short_code='QEP');
--   DELETE FROM public.registry_apps WHERE short_code = 'QEP';  -- cascades children
-- COMMIT;
