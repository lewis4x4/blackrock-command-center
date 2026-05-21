-- ============================================================================
-- Migration 007: cc_issues — the issue ledger
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- OS roadmap Phase 0 / §4 — the identity layer every action depends on.
--
-- Today triage items are recomputed from snapshot counts on every render — they
-- have no identity, no memory, no state. You cannot open, answer, or track
-- something that is recreated each render.
--
-- cc_issues gives every triage condition a persistent row and a lifecycle:
--   surfaced -> triaging -> answered -> work_order_created -> dispatched
--            -> building -> pr_open -> done
--   (plus routed_to_client, gated, dismissed)
--
-- The Aggregator reconciles snapshot counts into this ledger on every poll,
-- keyed on a stable (app_id, issue_type, source_ref): it upserts the open row
-- for a still-present condition and resolves the row for one that has cleared.
-- The partial unique index cc_issues_open_key enforces exactly one OPEN issue
-- per condition while letting resolved history accumulate unconstrained — so a
-- recurrence after resolution opens a fresh row rather than reopening a closed
-- one.
--
-- Conventions follow migration 001 house style: uuid PK, created_at/updated_at,
-- deleted_at soft-delete, RLS on the table. anon SELECT mirrors migration 005
-- (the home reads login-free; the deployed app is gated at the host).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Enums
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  -- The four triage conditions the home surfaces: decisions, build, blockers, sync.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_issue_type') THEN
    CREATE TYPE public.cc_issue_type AS ENUM
      ('open_decision', 'build_health', 'blocked_item', 'sync_error');
  END IF;

  -- The full lifecycle. Terminal states: done, routed_to_client, dismissed.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_issue_status') THEN
    CREATE TYPE public.cc_issue_status AS ENUM
      ('surfaced', 'triaging', 'answered', 'work_order_created',
       'dispatched', 'building', 'pr_open', 'done',
       'routed_to_client', 'gated', 'dismissed');
  END IF;

  -- Impact rank for the triage queue ordering.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_issue_severity') THEN
    CREATE TYPE public.cc_issue_severity AS ENUM
      ('critical', 'high', 'normal', 'low');
  END IF;
END$$;

-- ----------------------------------------------------------------------------
-- 1. cc_issues — one row per triage condition, with lifecycle + memory
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cc_issues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  issue_type    public.cc_issue_type     NOT NULL,
  source_ref    text                     NOT NULL DEFAULT '',
  status        public.cc_issue_status   NOT NULL DEFAULT 'surfaced',
  severity      public.cc_issue_severity NOT NULL DEFAULT 'normal',
  title         text NOT NULL,
  summary       text,
  detail        jsonb,
  surfaced_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

COMMENT ON TABLE public.cc_issues IS
  'The issue ledger. One persistent row per triage condition, carried through its lifecycle. The Aggregator reconciles snapshot counts into it on every poll.';
COMMENT ON COLUMN public.cc_issues.source_ref IS
  'Stable per-app reference for the condition — a decision id, a blocked-task id, or a constant such as ''build'' for an aggregate condition. Part of the upsert key.';
COMMENT ON COLUMN public.cc_issues.last_seen_at IS
  'Set to now() on every poll the condition is still present. Lets the Aggregator detect a condition that has cleared.';
COMMENT ON COLUMN public.cc_issues.resolved_at IS
  'Set when the issue reaches a terminal state (done / routed_to_client / dismissed). A non-null value drops the row out of cc_issues_open_key, so a recurrence opens a fresh row.';

-- ----------------------------------------------------------------------------
-- 2. Indexes
--    cc_issues_open_key is the upsert key: exactly one OPEN issue per
--    (app, type, source_ref). Resolved/soft-deleted history is unconstrained.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS cc_issues_open_key
  ON public.cc_issues (app_id, issue_type, source_ref)
  WHERE resolved_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS cc_issues_app_status_idx
  ON public.cc_issues (app_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS cc_issues_open_feed_idx
  ON public.cc_issues (severity, surfaced_at DESC)
  WHERE resolved_at IS NULL AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 3. updated_at trigger (shared function from migration 001)
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS cc_issues_touch ON public.cc_issues;
CREATE TRIGGER cc_issues_touch
  BEFORE UPDATE ON public.cc_issues
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 4. RLS — registry model (migration 001) + login-free home read (migration
--    005): service_role full, authenticated read+write, anon read. The
--    deployed app is gated at the host (Cloudflare Access), not by a login.
-- ----------------------------------------------------------------------------
ALTER TABLE public.cc_issues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cc_issues_service_all ON public.cc_issues;
CREATE POLICY cc_issues_service_all
  ON public.cc_issues FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS cc_issues_auth_all ON public.cc_issues;
CREATE POLICY cc_issues_auth_all
  ON public.cc_issues FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS cc_issues_anon_read ON public.cc_issues;
CREATE POLICY cc_issues_anon_read
  ON public.cc_issues FOR SELECT TO anon USING (true);

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.cc_issues;
--   DROP TYPE  IF EXISTS public.cc_issue_severity;
--   DROP TYPE  IF EXISTS public.cc_issue_status;
--   DROP TYPE  IF EXISTS public.cc_issue_type;
-- COMMIT;
