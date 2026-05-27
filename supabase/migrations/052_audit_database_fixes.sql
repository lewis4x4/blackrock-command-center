-- ============================================================================
-- Migration 052: database audit P0/P1 remediation
-- Target: control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Addresses the 2026-05-27 database audit findings:
--   - Task #33: prevent duplicate active decision answers per issue/ref.
--   - Soft-delete pre-existing duplicate answer rows before creating the guard.
--   - Add supporting indexes for FK columns and high-traffic read paths.
--   - Add state/timestamp integrity for the email-send superseded state.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Task #33 remediation — keep the newest active answer for each logical
--    decision answer key and soft-delete older duplicates before adding the
--    uniqueness guard. The known live duplicate is the older
--    `do_not_allow` answer for prospect quoting; keeping newest preserves the
--    later explicit `disallow_prospect_quotes` answer.
-- ----------------------------------------------------------------------------
WITH duplicate_answers AS (
  SELECT
    id,
    app_id,
    issue_id,
    decision_external_ref,
    row_number() OVER (
      PARTITION BY issue_id, decision_external_ref
      ORDER BY created_at DESC, id DESC
    ) AS keep_rank
  FROM public.cc_decision_answers
  WHERE deleted_at IS NULL
    AND decision_external_ref IS NOT NULL
), soft_deleted AS (
  UPDATE public.cc_decision_answers a
     SET deleted_at = now()
    FROM duplicate_answers d
   WHERE a.id = d.id
     AND d.keep_rank > 1
  RETURNING a.id, a.app_id, a.issue_id, a.decision_external_ref, a.answer_value, a.answered_by, a.created_at
)
INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
SELECT
  app_id,
  'database-audit-2026-05-27',
  'decision_answer_duplicate_soft_deleted',
  jsonb_build_object(
    'answer_id', id,
    'issue_id', issue_id,
    'decision_external_ref', decision_external_ref,
    'answer_value', answer_value,
    'answered_by', answered_by,
    'created_at', created_at,
    'reason', 'task_33_unique_guard_preflight_keep_newest'
  )
FROM soft_deleted;

CREATE UNIQUE INDEX IF NOT EXISTS cc_decision_answers_issue_decision_active_uidx
  ON public.cc_decision_answers (issue_id, decision_external_ref)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX public.cc_decision_answers_issue_decision_active_uidx IS
  'Task #33 guard: at most one active answer per control-plane issue and client decision_external_ref. Soft-deleted history remains unconstrained.';

-- Useful for read functions that suppress already-answered decision refs by app.
CREATE INDEX IF NOT EXISTS cc_decision_answers_app_decision_ref_idx
  ON public.cc_decision_answers (app_id, decision_external_ref)
  WHERE deleted_at IS NULL AND decision_external_ref IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Supporting indexes for FK/read-path columns that were missing standalone
--    left-prefix coverage. Partial indexes match the platform's soft-delete
--    query convention and keep the active working set small.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS cc_decision_answers_issue_idx
  ON public.cc_decision_answers (issue_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_work_orders_source_answer_idx
  ON public.agent_work_orders (source_answer_id)
  WHERE deleted_at IS NULL AND source_answer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cc_artifacts_work_order_idx
  ON public.cc_artifacts (work_order_id)
  WHERE deleted_at IS NULL AND work_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cc_artifacts_agent_run_idx
  ON public.cc_artifacts (agent_run_id)
  WHERE deleted_at IS NULL AND agent_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cc_decision_email_sends_decision_answer_idx
  ON public.cc_decision_email_sends (decision_answer_id)
  WHERE deleted_at IS NULL AND decision_answer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cc_decision_email_sends_recipient_idx
  ON public.cc_decision_email_sends (recipient_id)
  WHERE deleted_at IS NULL AND recipient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cc_decision_email_sends_route_parent_idx
  ON public.cc_decision_email_sends (route_parent_send_id)
  WHERE deleted_at IS NULL AND route_parent_send_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cc_decision_email_sends_app_decision_ref_idx
  ON public.cc_decision_email_sends (app_id, decision_external_ref)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS registry_app_integrations_app_idx
  ON public.registry_app_integrations (app_id);

CREATE INDEX IF NOT EXISTS registry_app_owners_app_idx
  ON public.registry_app_owners (app_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS cc_issues_unresolved_app_surfaced_idx
  ON public.cc_issues (app_id, surfaced_at DESC)
  WHERE deleted_at IS NULL AND resolved_at IS NULL;

-- Agent Core is in the same linked DB and has tenant-scoped RLS paths that use
-- tenant_id filters. These indexes keep common tenant scans off sequential scans.
CREATE INDEX IF NOT EXISTS idx_agent_messages_tenant_created
  ON agent_core.agent_messages (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oauth_states_tenant_expires
  ON agent_core.oauth_states (tenant_id, expires_at);

-- ----------------------------------------------------------------------------
-- 3. Superseded state integrity. Migration 051 added the enum value and
--    timestamp column; this check makes future superseded rows record when they
--    left the reminder/reply path.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cc_decision_email_sends_superseded_at_chk'
      AND conrelid = 'public.cc_decision_email_sends'::regclass
  ) THEN
    ALTER TABLE public.cc_decision_email_sends
      ADD CONSTRAINT cc_decision_email_sends_superseded_at_chk
      CHECK (state <> 'superseded'::public.cc_decision_email_state OR superseded_at IS NOT NULL);
  END IF;
END $$;

COMMIT;
