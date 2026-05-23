-- ============================================================================
-- Migration 036: cc_operator_handoffs + decision-answer auto-dispatch
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- F3 backend foundation. Adds the operator handoff ledger from the master plan
-- and closes the queue-filling gap for answered decisions.
--
-- Auto-dispatch choice: option (b), a 1-minute pg_cron scanner for orphan
-- cc_decision_answers rows. This was chosen over an edge-function inline call so
-- direct SQL inserts, retries, and any future writer all share the same durable
-- recovery path. The scanner composes the same default work-order intent as
-- cc-dispatch-from-answer and delegates to cc_enqueue_with_gating, preserving
-- the existing gating/idempotency/audit behavior without introducing another
-- HTTP secret dependency in cron.
--
-- Handoff audit vocabulary: callers that create or advance handoffs should emit
-- cc_audit_events.event_type values handoff_created, handoff_acknowledged, and
-- handoff_completed. cc_audit_events.event_type is text, so no enum migration is
-- required for those event names.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. cc_operator_handoffs — explicit manual-action runbooks for the operator
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cc_operator_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('manual_step','compose_by_hand','credential_rotation')),
  work_order_id uuid REFERENCES public.agent_work_orders(id) ON DELETE SET NULL,
  issue_id uuid REFERENCES public.cc_issues(id) ON DELETE SET NULL,
  runbook_md text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  completed_at timestamptz,
  severity public.cc_issue_severity NOT NULL DEFAULT 'normal',
  deleted_at timestamptz,

  CONSTRAINT cc_operator_handoffs_runbook_nonempty CHECK (btrim(runbook_md) <> ''),
  CONSTRAINT cc_operator_handoffs_ack_time_requires_status CHECK (
    acknowledged_at IS NULL OR status IN ('acknowledged','done')
  ),
  CONSTRAINT cc_operator_handoffs_done_time_requires_done CHECK (
    completed_at IS NULL OR status = 'done'
  )
);

COMMENT ON TABLE public.cc_operator_handoffs IS
  'Operator-visible runbooks for manual steps the agent system cannot safely perform itself.';
COMMENT ON COLUMN public.cc_operator_handoffs.app_id IS
  'Owning Command Center app. Handoffs are app-scoped so the Agents page can group them with queue work.';
COMMENT ON COLUMN public.cc_operator_handoffs.kind IS
  'Manual handoff category: manual_step, compose_by_hand, or credential_rotation.';
COMMENT ON COLUMN public.cc_operator_handoffs.work_order_id IS
  'Optional related runner work order. NULL when the handoff is not tied to a queued build task.';
COMMENT ON COLUMN public.cc_operator_handoffs.issue_id IS
  'Optional related issue ledger row. NULL when the handoff comes from a non-issue workflow.';
COMMENT ON COLUMN public.cc_operator_handoffs.runbook_md IS
  'Markdown instructions shown to the operator: exact manual steps, credentials to rotate by reference, or composition guidance.';
COMMENT ON COLUMN public.cc_operator_handoffs.status IS
  'Operator lifecycle: open until seen, acknowledged while in progress, done when completed.';
COMMENT ON COLUMN public.cc_operator_handoffs.acknowledged_at IS
  'Timestamp set when the operator acknowledges the handoff.';
COMMENT ON COLUMN public.cc_operator_handoffs.completed_at IS
  'Timestamp set when the operator marks the handoff done.';
COMMENT ON COLUMN public.cc_operator_handoffs.severity IS
  'Impact rank for sorting and notification gates. Reuses cc_issue_severity values: critical, high, normal, low.';
COMMENT ON COLUMN public.cc_operator_handoffs.deleted_at IS
  'Soft-delete marker; non-null rows are hidden from open handoff feeds.';

CREATE INDEX IF NOT EXISTS cc_operator_handoffs_open_idx
  ON public.cc_operator_handoffs (status, created_at DESC)
  WHERE deleted_at IS NULL AND status IN ('open','acknowledged');

CREATE INDEX IF NOT EXISTS cc_operator_handoffs_app_idx
  ON public.cc_operator_handoffs (app_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS cc_operator_handoffs_work_order_idx
  ON public.cc_operator_handoffs (work_order_id)
  WHERE deleted_at IS NULL AND work_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cc_operator_handoffs_issue_idx
  ON public.cc_operator_handoffs (issue_id)
  WHERE deleted_at IS NULL AND issue_id IS NOT NULL;

ALTER TABLE public.cc_operator_handoffs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cc_operator_handoffs_service_all ON public.cc_operator_handoffs;
CREATE POLICY cc_operator_handoffs_service_all
  ON public.cc_operator_handoffs FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS cc_operator_handoffs_auth_all ON public.cc_operator_handoffs;
DROP POLICY IF EXISTS cc_operator_handoffs_auth_read ON public.cc_operator_handoffs;
DROP POLICY IF EXISTS cc_operator_handoffs_anon_read ON public.cc_operator_handoffs;

REVOKE ALL ON public.cc_operator_handoffs FROM anon;
REVOKE ALL ON public.cc_operator_handoffs FROM authenticated;
GRANT ALL ON public.cc_operator_handoffs TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_center') THEN
    EXECUTE 'DROP POLICY IF EXISTS cc_operator_handoffs_command_center_all ON public.cc_operator_handoffs';
    EXECUTE 'CREATE POLICY cc_operator_handoffs_command_center_all ON public.cc_operator_handoffs FOR ALL TO command_center USING (true) WITH CHECK (true)';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.cc_operator_handoffs TO command_center';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Orphan answer dispatcher — recovery path for answers without work orders
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cc_dispatch_orphan_decision_answers(
  p_limit int DEFAULT 25
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_answer public.cc_decision_answers%ROWTYPE;
  v_issue public.cc_issues%ROWTYPE;
  v_row public.agent_work_orders%ROWTYPE;
  v_title text;
  v_rationale text;
  v_affected_area text;
  v_change_spec jsonb;
  v_dispatched int := 0;
BEGIN
  FOR v_answer IN
    SELECT a.*
    FROM public.cc_decision_answers a
    WHERE a.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.agent_work_orders wo
        WHERE wo.source_answer_id = a.id
      )
    ORDER BY a.created_at ASC
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO v_issue
    FROM public.cc_issues
    WHERE id = v_answer.issue_id
      AND app_id = v_answer.app_id
      AND deleted_at IS NULL;

    IF NOT FOUND THEN
      INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
      VALUES (
        v_answer.app_id,
        'cc-auto-dispatch-cron',
        'work_order_dispatch_skipped',
        jsonb_build_object(
          'source_answer_id', v_answer.id,
          'reason', 'related_issue_not_found'
        )
      );
      CONTINUE;
    END IF;

    v_title := COALESCE(NULLIF(btrim(v_issue.title), ''), NULLIF(btrim(v_answer.decision_external_ref), ''), 'the answered decision');
    v_rationale := NULLIF(btrim(COALESCE(v_answer.rationale, '')), '');

    v_affected_area := COALESCE(
      NULLIF(btrim(COALESCE(v_issue.context ->> 'affected_area', '')), ''),
      NULLIF(btrim(COALESCE(v_issue.context ->> 'area', '')), ''),
      NULLIF(btrim(COALESCE(v_issue.context ->> 'surface', '')), ''),
      NULLIF(btrim(COALESCE(v_issue.context ->> 'stream', '')), ''),
      NULLIF(btrim(COALESCE(v_issue.context ->> 'source_ref', '')), ''),
      NULLIF(btrim(COALESCE(v_issue.detail ->> 'affected_area', '')), ''),
      NULLIF(btrim(COALESCE(v_issue.detail ->> 'area', '')), ''),
      NULLIF(btrim(COALESCE(v_issue.detail ->> 'surface', '')), ''),
      NULLIF(btrim(COALESCE(v_issue.detail ->> 'stream', '')), ''),
      NULLIF(btrim(COALESCE(v_issue.detail ->> 'source_ref', '')), '')
    );

    IF v_affected_area IN ('aggregate', 'build', 'sync', 'blocked') THEN
      v_affected_area := NULL;
    END IF;

    v_change_spec := jsonb_strip_nulls(jsonb_build_object(
      'intent',
        'Apply the answer ''' || v_answer.answer_value || ''' to decision ''' || v_title || '''' ||
        CASE WHEN v_rationale IS NULL THEN '.' ELSE ': operator note: ''' || v_rationale || '''.' END,
      'affected_area', v_affected_area,
      'acceptance_criteria', jsonb_build_array(
        'Implement the answered choice',
        'All existing tests pass',
        'No schema-destructive operations'
      ),
      'constraints', jsonb_build_array(
        'Single PR',
        'Branch must start with cc/',
        'Do not modify CI configuration'
      )
    ));

    BEGIN
      v_row := public.cc_enqueue_with_gating(
        v_answer.app_id,
        v_change_spec,
        v_answer.risk_class,
        'decision_answer:' || v_answer.id::text,
        v_answer.id,
        NULL,
        'cc-auto-dispatch-cron'
      );
      v_dispatched := v_dispatched + 1;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent dispatcher may have won the idempotency race after this
      -- function selected the answer. Treat that as already dispatched.
      UPDATE public.cc_decision_answers
         SET dispatched_at = COALESCE(dispatched_at, now())
       WHERE id = v_answer.id
         AND deleted_at IS NULL;
    WHEN OTHERS THEN
      INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
      VALUES (
        v_answer.app_id,
        'cc-auto-dispatch-cron',
        'work_order_dispatch_failed',
        jsonb_build_object(
          'source_answer_id', v_answer.id,
          'sqlstate', SQLSTATE,
          'message', SQLERRM
        )
      );
    END;
  END LOOP;

  RETURN v_dispatched;
END;
$fn$;

COMMENT ON FUNCTION public.cc_dispatch_orphan_decision_answers(int) IS
  'Scans cc_decision_answers for rows without any agent_work_orders.source_answer_id reference and enqueues gated/queued work orders via cc_enqueue_with_gating. Scheduled every minute for F3 auto-dispatch recovery.';

REVOKE EXECUTE ON FUNCTION public.cc_dispatch_orphan_decision_answers(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cc_dispatch_orphan_decision_answers(int) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_center') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.cc_dispatch_orphan_decision_answers(int) TO command_center';
  END IF;
END $$;

-- pg_cron is already part of the control-plane posture (see migrations 003/020).
-- The extension statement keeps this migration safe on fresh local databases.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-auto-dispatch-decision-answers') THEN
    PERFORM cron.unschedule('cc-auto-dispatch-decision-answers');
  END IF;
END $$;

SELECT cron.schedule(
  'cc-auto-dispatch-decision-answers',
  '* * * * *',
  $job$
  SELECT public.cc_dispatch_orphan_decision_answers(25);
  $job$
);

COMMIT;

-- ============================================================================
-- Manual smoke test recipe (copy/paste in SQL editor after applying migration)
-- ============================================================================
-- 1. Pick one non-terminal issue that has a configured repo for its app:
--    SELECT i.id AS issue_id, i.app_id
--    FROM public.cc_issues i
--    JOIN public.registry_app_repo r ON r.app_id = i.app_id
--    WHERE i.deleted_at IS NULL
--      AND i.status IN ('surfaced','triaging','answered')
--    ORDER BY i.created_at DESC
--    LIMIT 1;
--
-- 2. Insert a fake answer using that issue_id/app_id pair:
--    INSERT INTO public.cc_decision_answers (
--      issue_id, app_id, decision_external_ref, answer_value,
--      answer_options_snapshot, rationale, risk_class, answered_by
--    ) VALUES (
--      '<issue_id>', '<app_id>', 'f3-smoke-' || extract(epoch FROM now())::bigint,
--      'ship', '[{"id":"ship","label":"Ship"}]'::jsonb,
--      'F3 auto-dispatch smoke test', 'authorize', 'manual-smoke'
--    )
--    RETURNING id;
--
-- 3. Wait up to 60 seconds for pg_cron, or run this immediate equivalent:
--    SELECT public.cc_dispatch_orphan_decision_answers(25);
--
-- 4. Confirm the gated work order appeared:
--    SELECT id, status, gated_reason, source_answer_id, created_at
--    FROM public.agent_work_orders
--    WHERE source_answer_id = '<returned_answer_id>';
--
-- 5. Cleanup the smoke rows if desired:
--    UPDATE public.agent_work_orders SET deleted_at = now()
--    WHERE source_answer_id = '<returned_answer_id>';
--    UPDATE public.cc_decision_answers SET deleted_at = now()
--    WHERE id = '<returned_answer_id>';
--
-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DO $$
--   BEGIN
--     IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-auto-dispatch-decision-answers') THEN
--       PERFORM cron.unschedule('cc-auto-dispatch-decision-answers');
--     END IF;
--   END $$;
--   DROP FUNCTION IF EXISTS public.cc_dispatch_orphan_decision_answers(int);
--   DROP TABLE IF EXISTS public.cc_operator_handoffs;
-- COMMIT;
