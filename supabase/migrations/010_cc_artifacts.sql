-- ============================================================================
-- Migration 010: cc_artifacts — file retrieval registry
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Creates public.cc_artifacts as the control-plane registry of artifacts the
-- Command Center knows about (repo docs, migrations, edge functions, specs,
-- generated reports, and forward-compatible agent outputs / PR artifacts).
--
-- Federated boundary: control-plane/repo metadata only — NEVER client business
-- data. This table is for file retrieval and activity context, not tenant data.
--
-- Forward compatibility:
--   - work_order_id and agent_run_id are added now without FKs.
--   - F3 migrations (012/013) will add FK constraints once those tables exist.
--
-- Security rule: no anon read. Browser read path is server-side via service_role
-- (§4.11); this migration includes an explicit REVOKE SELECT FROM anon.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.cc_artifacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN (
                    'doc', 'migration', 'edge_function', 'spec', 'report',
                    'web_source', 'script', 'agent_output', 'pull_request')),
  title           text NOT NULL,
  path            text,
  url             text,
  source          text NOT NULL CHECK (source IN ('repo_scan', 'agent_run', 'manual')),
  summary         text,
  byte_size       bigint,
  produced_by     text,
  content_sha     text,
  discovered_at   timestamptz NOT NULL DEFAULT now(),
  last_indexed_at timestamptz NOT NULL DEFAULT now(),
  work_order_id   uuid,
  agent_run_id    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT cc_artifacts_path_or_url_required
    CHECK (
      COALESCE(NULLIF(btrim(path), ''), NULLIF(btrim(url), '')) IS NOT NULL
    )
);

COMMENT ON TABLE public.cc_artifacts IS
  'Control-plane artifact registry for Command Center file retrieval/activity context (repo and generated artifacts only). Federated boundary: never stores client business data.';

COMMENT ON COLUMN public.cc_artifacts.content_sha IS
  'SHA-256 content digest (when available) used to dedupe repo-scan re-indexes cleanly.';

COMMENT ON COLUMN public.cc_artifacts.work_order_id IS
  'Forward-compat reference. F3 (migration 012) introduces agent_work_orders; FK is intentionally deferred until that table exists.';

COMMENT ON COLUMN public.cc_artifacts.agent_run_id IS
  'Forward-compat reference. F3 (migration 013) introduces agent_runs; FK is intentionally deferred until that table exists.';

CREATE UNIQUE INDEX IF NOT EXISTS cc_artifacts_path_key
  ON public.cc_artifacts (path)
  WHERE source = 'repo_scan' AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cc_artifacts_url_key
  ON public.cc_artifacts (url)
  WHERE source IN ('agent_run', 'manual') AND url IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS cc_artifacts_app_last_indexed_idx
  ON public.cc_artifacts (app_id, last_indexed_at DESC);

CREATE INDEX IF NOT EXISTS cc_artifacts_kind_last_indexed_idx
  ON public.cc_artifacts (kind, last_indexed_at DESC);

CREATE INDEX IF NOT EXISTS cc_artifacts_last_indexed_idx
  ON public.cc_artifacts (last_indexed_at DESC);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS cc_artifacts_touch ON public.cc_artifacts;
  CREATE TRIGGER cc_artifacts_touch
    BEFORE UPDATE ON public.cc_artifacts
    FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();
END$$;

ALTER TABLE public.cc_artifacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cc_artifacts_service_all ON public.cc_artifacts;
CREATE POLICY cc_artifacts_service_all ON public.cc_artifacts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS cc_artifacts_auth_read ON public.cc_artifacts;
CREATE POLICY cc_artifacts_auth_read ON public.cc_artifacts
  FOR SELECT TO authenticated USING (true);

REVOKE ALL PRIVILEGES ON public.cc_artifacts FROM anon;
REVOKE SELECT ON public.cc_artifacts FROM anon;

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.cc_artifacts;
-- COMMIT;
