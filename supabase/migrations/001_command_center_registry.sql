-- ============================================================================
-- Migration 001: BlackRock AI Command Center — control-plane registry
-- Target: the NEW control-plane Supabase project (create it, then apply this).
--
-- The Command Center is federated:
--   - This control plane is ONE shared Supabase project. It holds the app
--     registry, aggregated progress snapshots, and an audit log. It holds NO
--     client business data.
--   - Each client app (QEP, SCC, Circle of Life, Foundry, ...) keeps its own
--     isolated Supabase project. They never share a row or an RLS boundary.
--
-- This migration is the keystone — the 593-equivalent for the platform.
-- Conventions follow the QEP house style: uuid PK, created_at/updated_at,
-- deleted_at soft-delete, RLS on every table, NNN_ migration naming.
--
-- SECRETS RULE: this registry stores only *_secret_ref pointers — opaque
-- references into a secrets manager. No service-role key, API key, or webhook
-- secret is ever stored in a registry row.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Enums
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_app_status') THEN
    CREATE TYPE public.cc_app_status AS ENUM
      ('provisioning', 'active', 'paused', 'archived');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_lifecycle_phase') THEN
    CREATE TYPE public.cc_lifecycle_phase AS ENUM
      ('discovery', 'build', 'launched', 'maintenance');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_build_status') THEN
    CREATE TYPE public.cc_build_status AS ENUM
      ('green', 'yellow', 'red', 'unknown');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_integration_status') THEN
    -- Mirrors the QEP zero-blocking convention: live / demo / manual_safe.
    CREATE TYPE public.cc_integration_status AS ENUM
      ('live', 'demo', 'manual_safe', 'planned');
  END IF;
END$$;

-- ----------------------------------------------------------------------------
-- 1. registry_apps — one row per client app the Command Center runs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.registry_apps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_code       text NOT NULL UNIQUE,                 -- 'QEP', 'SCC', 'COL', 'FND'
  display_name     text NOT NULL,                        -- 'QEP OS'
  client_name      text,                                 -- 'Quality Equipment & Parts, Inc.'
  status           public.cc_app_status     NOT NULL DEFAULT 'provisioning',
  lifecycle_phase  public.cc_lifecycle_phase NOT NULL DEFAULT 'build',
  criticality      integer NOT NULL DEFAULT 0,           -- higher = outranks when the queue is contested
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

COMMENT ON TABLE public.registry_apps IS
  'The app registry — every client app the Command Center manages. One shared control-plane row per isolated client data plane.';
COMMENT ON COLUMN public.registry_apps.short_code IS
  'Stable 2-5 letter code. Used as the tenant key throughout the platform.';
COMMENT ON COLUMN public.registry_apps.criticality IS
  'Tie-breaker when two apps contend for an agent runner or for Brian attention. Higher wins.';

-- ----------------------------------------------------------------------------
-- 2. registry_app_supabase — the client app's isolated data-plane project
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.registry_app_supabase (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                    uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  project_ref               text NOT NULL,                -- e.g. 'iciddijgonywtxoelous'
  project_url               text NOT NULL,
  region                    text,
  snapshot_contract_version integer NOT NULL DEFAULT 1,    -- which cc_export_snapshot() shape this app exposes
  service_secret_ref        text,                         -- pointer into the secrets manager — NEVER the key itself
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id)
);

COMMENT ON TABLE public.registry_app_supabase IS
  'The isolated client Supabase project for an app. service_secret_ref is a vault pointer; the raw key never lives here.';

-- ----------------------------------------------------------------------------
-- 3. registry_app_linear — the client app's Linear team + sync config
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.registry_app_linear (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id              uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  workspace_name      text,
  team_key            text NOT NULL,                      -- 'QEP'
  api_key_ref         text,                               -- vault pointer
  webhook_secret_ref  text,                               -- vault pointer
  status_map          jsonb,                              -- per-app ship-state vocabulary (QEP 7-state, SCC 5-state)
  stream_project_map  jsonb,                              -- stream code -> Linear project name
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id)
);

COMMENT ON TABLE public.registry_app_linear IS
  'Linear team + sync config per app. status_map and stream_project_map make status-vocabulary differences config, not code forks.';

-- ----------------------------------------------------------------------------
-- 4. registry_app_repo — the client app's GitHub repo
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.registry_app_repo (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id             uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  github_repo        text NOT NULL,                       -- 'lewis4x4/qep'
  default_branch     text NOT NULL DEFAULT 'main',
  roadmap_doc_path   text,
  github_install_id  text,                                -- BlackRock AI GitHub App per-repo installation id
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id)
);

COMMENT ON TABLE public.registry_app_repo IS
  'GitHub repo per app. github_install_id is the per-repo installation of the BlackRock AI GitHub App — short-lived tokens, no personal PAT.';

-- ----------------------------------------------------------------------------
-- 5. registry_app_owners — the client people who answer decisions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.registry_app_owners (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id            uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  person_name       text NOT NULL,
  person_email      text,
  portal_role       text,                                 -- 'owner_all' | 'sales' | 'parts' | 'finance'
  is_decision_owner boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.registry_app_owners IS
  'Client owners per app. Drives decision-email routing and, later, Client Window access scoping.';

-- ----------------------------------------------------------------------------
-- 6. registry_app_integrations — external systems wired per app
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.registry_app_integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  integration_type text NOT NULL,                         -- 'm365', 'twilio', 'hubspot', 'oem_portal', ...
  status           public.cc_integration_status NOT NULL DEFAULT 'planned',
  config           jsonb,
  last_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.registry_app_integrations IS
  'External integrations per app, with the QEP zero-blocking status model: live / demo / manual_safe / planned.';

-- ----------------------------------------------------------------------------
-- 7. registry_app_snapshots — append-only aggregated progress
--    Written by the Aggregator (it polls each app's cc_export_snapshot()).
--    Read by the Command Center home. The control plane never live-joins
--    across client databases — it reads these snapshots.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.registry_app_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  roadmap_counts  jsonb,                                  -- per ship_state tallies
  decision_counts jsonb,                                  -- open / answered / blocked tallies
  sync_health     jsonb,                                  -- linear sync health blob
  build_status    public.cc_build_status NOT NULL DEFAULT 'unknown',
  aggregator_note text
);

COMMENT ON TABLE public.registry_app_snapshots IS
  'Append-only. The Aggregator writes one row per app per poll. The home dashboard reads the latest per app.';

CREATE INDEX IF NOT EXISTS registry_app_snapshots_app_captured_idx
  ON public.registry_app_snapshots (app_id, captured_at DESC);

-- ----------------------------------------------------------------------------
-- 8. cc_audit_events — append-only control-plane audit log
--    Every secret retrieval and every agent dispatch is recorded here.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cc_audit_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  app_id       uuid REFERENCES public.registry_apps(id) ON DELETE SET NULL,
  actor        text NOT NULL,                             -- who/what (platform_admin email, machine identity)
  event_type   text NOT NULL,                             -- 'secret_read', 'agent_dispatch', 'app_provisioned', ...
  detail       jsonb,
  ip           text
);

COMMENT ON TABLE public.cc_audit_events IS
  'Append-only audit log for the control plane. Every secret retrieval and agent dispatch lands here.';

CREATE INDEX IF NOT EXISTS cc_audit_events_occurred_idx ON public.cc_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS cc_audit_events_app_idx      ON public.cc_audit_events (app_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- 9. updated_at trigger (shared)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_cc_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'registry_apps','registry_app_supabase','registry_app_linear',
    'registry_app_repo','registry_app_owners','registry_app_integrations'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t||'_touch', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at()',
      t||'_touch', t);
  END LOOP;
END$$;

-- ----------------------------------------------------------------------------
-- 10. Home view — one row per app with its latest snapshot
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_command_center_home
WITH (security_invoker = on) AS
SELECT
  a.id,
  a.short_code,
  a.display_name,
  a.client_name,
  a.status,
  a.lifecycle_phase,
  a.criticality,
  s.captured_at        AS last_snapshot_at,
  s.build_status,
  s.roadmap_counts,
  s.decision_counts,
  s.sync_health
FROM public.registry_apps a
LEFT JOIN LATERAL (
  SELECT * FROM public.registry_app_snapshots ss
  WHERE ss.app_id = a.id
  ORDER BY ss.captured_at DESC
  LIMIT 1
) s ON true
WHERE a.deleted_at IS NULL
ORDER BY a.criticality DESC, a.short_code ASC;

COMMENT ON VIEW public.v_command_center_home IS
  'One row per active app with its most recent snapshot. The Command Center home reads this.';

-- ----------------------------------------------------------------------------
-- 11. RLS — control plane is Brian-only for now (platform_operator/contractor
--     roles + finer policies arrive when contractors are added).
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'registry_apps','registry_app_supabase','registry_app_linear','registry_app_repo',
    'registry_app_owners','registry_app_integrations','registry_app_snapshots','cc_audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_service_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t||'_service_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_auth_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      t||'_auth_read', t);
  END LOOP;
END$$;

-- Registry write access for the authenticated operator (Brian). Tighten to a
-- platform_admin/platform_operator role model when contractors are onboarded.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'registry_apps','registry_app_supabase','registry_app_linear','registry_app_repo',
    'registry_app_owners','registry_app_integrations'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_auth_write', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t||'_auth_write', t);
  END LOOP;
END$$;

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DROP VIEW IF EXISTS public.v_command_center_home;
--   DROP TABLE IF EXISTS public.cc_audit_events;
--   DROP TABLE IF EXISTS public.registry_app_snapshots;
--   DROP TABLE IF EXISTS public.registry_app_integrations;
--   DROP TABLE IF EXISTS public.registry_app_owners;
--   DROP TABLE IF EXISTS public.registry_app_repo;
--   DROP TABLE IF EXISTS public.registry_app_linear;
--   DROP TABLE IF EXISTS public.registry_app_supabase;
--   DROP TABLE IF EXISTS public.registry_apps;
--   DROP FUNCTION IF EXISTS public.fn_cc_touch_updated_at;
--   DROP TYPE IF EXISTS public.cc_integration_status;
--   DROP TYPE IF EXISTS public.cc_build_status;
--   DROP TYPE IF EXISTS public.cc_lifecycle_phase;
--   DROP TYPE IF EXISTS public.cc_app_status;
-- COMMIT;
