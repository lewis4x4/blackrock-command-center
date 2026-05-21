-- ============================================================================
-- Migration 009: cc_reconcile_app_issues() — snapshot -> issue ledger
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- OS roadmap Phase 0 / §4 — reconciliation.
--
-- Migration 007 built the cc_issues ledger; this gives it its writer. The
-- Aggregator calls cc_reconcile_app_issues(app_id, snapshot) after every
-- successful poll. The function derives the four triage conditions from the
-- snapshot JSON, upserts one OPEN aggregate issue per present condition, and
-- resolves any open aggregate issue whose condition has cleared.
--
-- Keyed on (app_id, issue_type, source_ref='aggregate') against the partial
-- unique index cc_issues_open_key — a still-present condition upserts in place;
-- a cleared-then-recurring one opens a fresh row.
--
-- Phase 0 works from snapshot COUNTS only — one aggregate issue per condition.
-- Phase 2 adds cc_export_detail() and item-level issues (a row per decision,
-- per blocked task) with a real source_ref; those sit alongside these
-- aggregate rows, untouched by this function.
--
-- Lifecycle safety: the upsert never changes `status`, so an operator-advanced
-- issue keeps its place in the workflow. The resolve step only closes issues
-- still in 'surfaced'/'triaging' — once answered or dispatched, the issue is
-- owned by the work flow, not the snapshot reconciler.
--
-- SECURITY INVOKER: the Aggregator always calls this as the control plane's
-- own service_role (BYPASSRLS). The client-key retirement concerns reads of
-- client data planes, never control-plane RPC calls — so no DEFINER needed.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.cc_reconcile_app_issues(
  p_app_id   uuid,
  p_snapshot jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_short       text;
  v_build       text;
  v_dec_open    int;
  v_dec_answer  int;
  v_blocked     int;
  v_total       int;
  v_sync_err    int;
  v_pending_dec int;
  v_present     public.cc_issue_type[] := ARRAY[]::public.cc_issue_type[];
  v_resolved    int := 0;
BEGIN
  SELECT short_code INTO v_short FROM public.registry_apps WHERE id = p_app_id;
  IF v_short IS NULL THEN
    RAISE EXCEPTION 'cc_reconcile_app_issues: unknown app_id %', p_app_id;
  END IF;

  -- Figures the four conditions key off of. A missing key means zero.
  v_build       := COALESCE(p_snapshot->>'build_status', 'unknown');
  v_dec_open    := COALESCE((p_snapshot#>>'{decision_counts,open}')::int, 0);
  v_dec_answer  := COALESCE((p_snapshot#>>'{decision_counts,answered}')::int, 0);
  v_blocked     := COALESCE((p_snapshot#>>'{roadmap_counts,blocked}')::int, 0);
  v_total       := COALESCE((p_snapshot#>>'{sync_health,total_tasks}')::int, 0);
  v_sync_err    := GREATEST(
                     COALESCE((p_snapshot#>>'{sync_health,error_count}')::int, 0),
                     COALESCE((p_snapshot#>>'{sync_health,errors_last_24h}')::int, 0));
  v_pending_dec := COALESCE((p_snapshot#>>'{roadmap_counts,pending_decision}')::int, 0);

  -- ---- Condition 1: open operator decisions --------------------------------
  IF v_dec_open > 0 THEN
    v_present := v_present || 'open_decision'::public.cc_issue_type;
    INSERT INTO public.cc_issues
      (app_id, issue_type, source_ref, severity, title, summary, detail, last_seen_at)
    VALUES (
      p_app_id, 'open_decision', 'aggregate', 'high',
      v_dec_open || ' decision' || CASE WHEN v_dec_open = 1 THEN '' ELSE 's' END
        || ' waiting on ' || v_short,
      v_dec_open || ' open, ' || v_dec_answer || ' answered.',
      jsonb_build_object('open', v_dec_open, 'answered', v_dec_answer,
                         'pending_decision_tasks', v_pending_dec),
      now())
    ON CONFLICT (app_id, issue_type, source_ref)
      WHERE resolved_at IS NULL AND deleted_at IS NULL
    DO UPDATE SET
      last_seen_at = now(),
      severity     = EXCLUDED.severity,
      title        = EXCLUDED.title,
      summary      = EXCLUDED.summary,
      detail       = EXCLUDED.detail;
  END IF;

  -- ---- Condition 2: build health -------------------------------------------
  IF v_build IN ('yellow', 'red') THEN
    v_present := v_present || 'build_health'::public.cc_issue_type;
    INSERT INTO public.cc_issues
      (app_id, issue_type, source_ref, severity, title, summary, detail, last_seen_at)
    VALUES (
      p_app_id, 'build_health', 'aggregate',
      (CASE WHEN v_build = 'red' THEN 'critical' ELSE 'high' END)::public.cc_issue_severity,
      v_short || CASE WHEN v_build = 'red' THEN ' build is failing'
                      ELSE ' build needs a look' END,
      'Last snapshot came back ' || v_build || '.',
      jsonb_build_object('build_status', v_build),
      now())
    ON CONFLICT (app_id, issue_type, source_ref)
      WHERE resolved_at IS NULL AND deleted_at IS NULL
    DO UPDATE SET
      last_seen_at = now(),
      severity     = EXCLUDED.severity,
      title        = EXCLUDED.title,
      summary      = EXCLUDED.summary,
      detail       = EXCLUDED.detail;
  END IF;

  -- ---- Condition 3: blocked items ------------------------------------------
  IF v_blocked > 0 THEN
    v_present := v_present || 'blocked_item'::public.cc_issue_type;
    INSERT INTO public.cc_issues
      (app_id, issue_type, source_ref, severity, title, summary, detail, last_seen_at)
    VALUES (
      p_app_id, 'blocked_item', 'aggregate', 'normal',
      v_blocked || ' item' || CASE WHEN v_blocked = 1 THEN '' ELSE 's' END
        || ' blocked on ' || v_short,
      CASE WHEN v_total > 0
           THEN v_blocked || ' of ' || v_total || ' tasks are blocked.'
           ELSE v_blocked || ' tasks are blocked.' END,
      jsonb_build_object('blocked', v_blocked, 'total_tasks', v_total),
      now())
    ON CONFLICT (app_id, issue_type, source_ref)
      WHERE resolved_at IS NULL AND deleted_at IS NULL
    DO UPDATE SET
      last_seen_at = now(),
      severity     = EXCLUDED.severity,
      title        = EXCLUDED.title,
      summary      = EXCLUDED.summary,
      detail       = EXCLUDED.detail;
  END IF;

  -- ---- Condition 4: sync errors --------------------------------------------
  IF v_sync_err > 0 THEN
    v_present := v_present || 'sync_error'::public.cc_issue_type;
    INSERT INTO public.cc_issues
      (app_id, issue_type, source_ref, severity, title, summary, detail, last_seen_at)
    VALUES (
      p_app_id, 'sync_error', 'aggregate', 'high',
      v_short || ' sync is erroring',
      v_sync_err || ' sync error' || CASE WHEN v_sync_err = 1 THEN '' ELSE 's' END
        || ' on the last check.',
      jsonb_build_object('error_count', v_sync_err),
      now())
    ON CONFLICT (app_id, issue_type, source_ref)
      WHERE resolved_at IS NULL AND deleted_at IS NULL
    DO UPDATE SET
      last_seen_at = now(),
      severity     = EXCLUDED.severity,
      title        = EXCLUDED.title,
      summary      = EXCLUDED.summary,
      detail       = EXCLUDED.detail;
  END IF;

  -- ---- Resolve conditions that have cleared --------------------------------
  -- Only the aggregate rows this function owns, and only ones an operator has
  -- not yet picked up. Anything answered or further along is owned elsewhere.
  UPDATE public.cc_issues
  SET status = 'done', resolved_at = now()
  WHERE app_id      = p_app_id
    AND source_ref  = 'aggregate'
    AND resolved_at IS NULL
    AND deleted_at  IS NULL
    AND status      IN ('surfaced', 'triaging')
    AND issue_type  <> ALL (v_present);
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RETURN jsonb_build_object(
    'app',                v_short,
    'conditions_present', COALESCE(array_length(v_present, 1), 0),
    'present',            to_jsonb(v_present),
    'resolved',           v_resolved
  );
END;
$fn$;

COMMENT ON FUNCTION public.cc_reconcile_app_issues(uuid, jsonb) IS
  'Reconciles one app''s snapshot into the cc_issues ledger: upserts an open aggregate issue per present triage condition, resolves ones that have cleared. Called by the Aggregator after every successful poll.';

REVOKE EXECUTE ON FUNCTION public.cc_reconcile_app_issues(uuid, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cc_reconcile_app_issues(uuid, jsonb) TO service_role;

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- DROP FUNCTION IF EXISTS public.cc_reconcile_app_issues(uuid, jsonb);
