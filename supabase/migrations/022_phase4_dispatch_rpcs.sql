-- ============================================================================
-- Migration 022: Phase 4 dispatch RPCs
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Adds the policy-gated decision-answer dispatch path and one-press approval.
-- Also extends cc_resolve_issue's JSON result with decision_answer_id while
-- preserving all existing returned fields.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.cc_resolve_issue(
  issue_id uuid,
  action text,
  answer_value text DEFAULT NULL,
  answer_options_snapshot jsonb DEFAULT NULL,
  rationale text DEFAULT NULL,
  risk_class text DEFAULT NULL,
  linked_decision_ref text DEFAULT NULL,
  actor text DEFAULT NULL,
  decision_external_ref text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_issue public.cc_issues%ROWTYPE;
  v_action text := NULLIF(btrim(action), '');
  v_answer_value text := NULLIF(left(btrim(COALESCE(answer_value, '')), 200), '');
  v_rationale text := NULLIF(left(btrim(COALESCE(rationale, '')), 500), '');
  v_risk_class text := NULLIF(btrim(risk_class), '');
  v_linked_decision_ref text := NULLIF(left(btrim(COALESCE(linked_decision_ref, '')), 200), '');
  v_actor text := NULLIF(left(btrim(COALESCE(actor, '')), 500), '');
  v_decision_external_ref text := NULLIF(left(btrim(COALESCE(decision_external_ref, '')), 200), '');
  v_event_type text := 'issue_acknowledged';
  v_updated_issue public.cc_issues%ROWTYPE;
  v_answer_id uuid;
BEGIN
  IF v_action IS NULL OR v_action NOT IN ('answer_decision', 'acknowledge', 'dismiss', 'link_to_decision') THEN
    RAISE EXCEPTION 'invalid action'
      USING ERRCODE = 'P0001', DETAIL = 'action must be one of answer_decision, acknowledge, dismiss, link_to_decision';
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_risk_class IS NOT NULL AND v_risk_class NOT IN ('auto', 'authorize', 'destructive', 'production') THEN
    RAISE EXCEPTION 'invalid risk class'
      USING ERRCODE = 'P0001', DETAIL = 'risk_class must be one of auto, authorize, destructive, production';
  END IF;

  SELECT * INTO v_issue
  FROM public.cc_issues
  WHERE id = issue_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue not found'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_issue.status IN ('done', 'dismissed') THEN
    RAISE EXCEPTION 'issue is already closed'
      USING ERRCODE = 'P0001', DETAIL = v_issue.status::text;
  END IF;

  IF v_action = 'answer_decision' THEN
    IF v_issue.status NOT IN ('surfaced', 'triaging') THEN
      RAISE EXCEPTION 'issue status % cannot be answered', v_issue.status
        USING ERRCODE = 'P0001';
    END IF;

    IF v_answer_value IS NULL THEN
      RAISE EXCEPTION 'answer_value is required for answer_decision'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_risk_class IS NULL THEN
      RAISE EXCEPTION 'invalid risk class'
        USING ERRCODE = 'P0001', DETAIL = 'risk_class must be one of auto, authorize, destructive, production';
    END IF;

    IF answer_options_snapshot IS NULL OR jsonb_typeof(answer_options_snapshot) <> 'array' THEN
      RAISE EXCEPTION 'answer_options_snapshot must contain at least one enumerated option'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(answer_options_snapshot) AS opt(value)
      WHERE CASE jsonb_typeof(opt.value)
        WHEN 'string' THEN NULLIF(btrim(opt.value #>> '{}'), '')
        WHEN 'object' THEN COALESCE(
          NULLIF(btrim(opt.value ->> 'id'), ''),
          NULLIF(btrim(opt.value ->> 'value'), ''),
          NULLIF(btrim(opt.value ->> 'key'), '')
        )
        ELSE NULL
      END IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'answer_options_snapshot must contain at least one enumerated option'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(answer_options_snapshot) AS opt(value)
      WHERE v_answer_value = CASE jsonb_typeof(opt.value)
        WHEN 'string' THEN NULLIF(btrim(opt.value #>> '{}'), '')
        WHEN 'object' THEN COALESCE(
          NULLIF(btrim(opt.value ->> 'id'), ''),
          NULLIF(btrim(opt.value ->> 'value'), ''),
          NULLIF(btrim(opt.value ->> 'key'), '')
        )
        ELSE NULL
      END
    ) THEN
      RAISE EXCEPTION 'answer_value must match an enumerated option id'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_decision_external_ref IS NULL
       AND v_issue.source_ref <> ''
       AND v_issue.source_ref NOT IN ('aggregate', 'build', 'sync', 'blocked') THEN
      v_decision_external_ref := v_issue.source_ref;
    END IF;

    INSERT INTO public.cc_decision_answers (
      issue_id,
      app_id,
      decision_external_ref,
      answer_value,
      answer_options_snapshot,
      rationale,
      risk_class,
      answered_by
    ) VALUES (
      v_issue.id,
      v_issue.app_id,
      v_decision_external_ref,
      v_answer_value,
      answer_options_snapshot,
      v_rationale,
      v_risk_class,
      v_actor
    )
    RETURNING id INTO v_answer_id;

    UPDATE public.cc_issues
    SET status = 'answered'
    WHERE id = v_issue.id
    RETURNING * INTO v_updated_issue;

    v_event_type := 'issue_resolved';

  ELSIF v_action = 'acknowledge' THEN
    IF v_issue.status NOT IN ('surfaced', 'triaging', 'gated') THEN
      RAISE EXCEPTION 'issue status % cannot be acknowledged', v_issue.status
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.cc_issues
    SET status = CASE WHEN v_issue.status = 'surfaced' THEN 'triaging'::public.cc_issue_status ELSE v_issue.status END
    WHERE id = v_issue.id
    RETURNING * INTO v_updated_issue;

    v_event_type := 'issue_acknowledged';

  ELSIF v_action = 'dismiss' THEN
    IF v_issue.status NOT IN ('surfaced', 'triaging', 'gated') THEN
      RAISE EXCEPTION 'issue status % cannot be dismissed', v_issue.status
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.cc_issues
    SET status = 'dismissed',
        resolved_at = now()
    WHERE id = v_issue.id
    RETURNING * INTO v_updated_issue;

    v_event_type := 'issue_dismissed';

  ELSIF v_action = 'link_to_decision' THEN
    IF v_issue.status NOT IN ('surfaced', 'triaging', 'gated') THEN
      RAISE EXCEPTION 'issue status % cannot be linked to a decision', v_issue.status
        USING ERRCODE = 'P0001';
    END IF;

    IF v_linked_decision_ref IS NULL THEN
      RAISE EXCEPTION 'linked_decision_ref is required for link_to_decision'
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.cc_issues
    SET status = 'triaging',
        context = COALESCE(context, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
          'linked_decision_ref', v_linked_decision_ref,
          'linked_to_decision_at', now(),
          'linked_to_decision_by', v_actor,
          'rationale', v_rationale
        ))
    WHERE id = v_issue.id
    RETURNING * INTO v_updated_issue;

    v_event_type := 'issue_acknowledged';
  END IF;

  INSERT INTO public.cc_audit_events (
    app_id,
    actor,
    event_type,
    detail
  ) VALUES (
    v_issue.app_id,
    v_actor,
    v_event_type,
    jsonb_build_object(
      'issue_id', v_issue.id,
      'issue_type', v_issue.issue_type,
      'source_ref', v_issue.source_ref,
      'action', v_action,
      'decision_answer_id', v_answer_id
    )
  );

  RETURN jsonb_build_object(
    'id', v_updated_issue.id,
    'app_id', v_updated_issue.app_id,
    'issue_type', v_updated_issue.issue_type,
    'source_ref', v_updated_issue.source_ref,
    'status', v_updated_issue.status,
    'severity', v_updated_issue.severity,
    'title', v_updated_issue.title,
    'summary', v_updated_issue.summary,
    'surfaced_at', v_updated_issue.surfaced_at,
    'last_seen_at', v_updated_issue.last_seen_at,
    'updated_at', v_updated_issue.updated_at,
    'context', v_updated_issue.context,
    'decision_answer_id', v_answer_id
  );
END;
$fn$;

COMMENT ON FUNCTION public.cc_resolve_issue(uuid, text, text, jsonb, text, text, text, text, text) IS
  'Atomically resolves/triages one cc_issues row, optionally records an enumerated decision answer, appends the audit event, and returns decision_answer_id for Phase 4 dispatch.';

CREATE OR REPLACE FUNCTION public.cc_enqueue_with_gating(
  p_app_id uuid,
  p_change_spec jsonb,
  p_risk_class text,
  p_idempotency_key text,
  p_source_answer_id uuid DEFAULT NULL,
  p_cost_cap_usd numeric DEFAULT NULL,
  p_actor text DEFAULT NULL
)
RETURNS public.agent_work_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.agent_work_orders;
  v_work_order_id uuid;
  v_risk_class text := lower(NULLIF(btrim(COALESCE(p_risk_class, '')), ''));
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_criticality int;
  v_auto_dispatch_cap_usd numeric := 5.00;
  v_should_dispatch boolean;
  v_gated_reason text;
BEGIN
  IF p_app_id IS NULL THEN
    RAISE EXCEPTION 'p_app_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_risk_class NOT IN ('auto','authorize','destructive','production') THEN
    RAISE EXCEPTION 'invalid risk_class: %', p_risk_class USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COALESCE(criticality, 0) INTO v_criticality
  FROM public.registry_apps
  WHERE id = p_app_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'app % not found', p_app_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Criticality is intentionally read here so this RPC is ready for the future
  -- per-app auto_dispatch_cap_usd slice without changing the edge contract.
  v_criticality := COALESCE(v_criticality, 0);

  v_should_dispatch := v_risk_class = 'auto'
    AND (p_cost_cap_usd IS NULL OR p_cost_cap_usd <= v_auto_dispatch_cap_usd);

  v_gated_reason := CASE
    WHEN v_should_dispatch THEN NULL
    WHEN v_risk_class = 'authorize' THEN 'authorize_class'
    WHEN v_risk_class = 'destructive' THEN 'destructive_class'
    WHEN v_risk_class = 'production' THEN 'production_class'
    WHEN v_risk_class = 'auto' AND p_cost_cap_usd > v_auto_dispatch_cap_usd THEN 'over_cost_cap'
    ELSE 'authorize_class'
  END;

  v_row := public.cc_enqueue_work_order(
    p_app_id,
    p_change_spec,
    v_risk_class,
    p_idempotency_key,
    p_source_answer_id,
    p_cost_cap_usd,
    3
  );
  v_work_order_id := v_row.id;

  IF NOT v_should_dispatch THEN
    UPDATE public.agent_work_orders
       SET status = 'gated',
           gated_reason = COALESCE(gated_reason, v_gated_reason),
           claimed_by = NULL,
           claimed_at = NULL,
           lease_expires_at = NULL
     WHERE id = v_work_order_id
       AND deleted_at IS NULL
       AND status = 'queued'
       AND approved_at IS NULL
    RETURNING * INTO v_row;

    IF FOUND THEN
      INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
      VALUES (
        v_row.app_id,
        v_actor,
        'work_order_gated',
        jsonb_build_object(
          'work_order_id', v_row.id,
          'source_answer_id', v_row.source_answer_id,
          'risk_class', v_row.risk_class,
          'gated_reason', v_row.gated_reason,
          'idempotency_key', v_row.idempotency_key,
          'auto_dispatch_cap_usd', v_auto_dispatch_cap_usd,
          'app_criticality', v_criticality
        )
      );
    ELSE
      SELECT * INTO v_row
      FROM public.agent_work_orders
      WHERE id = v_work_order_id;
    END IF;
  END IF;

  IF p_source_answer_id IS NOT NULL THEN
    UPDATE public.cc_decision_answers
       SET dispatched_at = COALESCE(dispatched_at, now())
     WHERE id = p_source_answer_id
       AND deleted_at IS NULL;
  END IF;

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_approve_work_order(
  p_work_order_id uuid,
  p_actor text
)
RETURNS public.agent_work_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_row public.agent_work_orders;
BEGIN
  IF p_work_order_id IS NULL THEN
    RAISE EXCEPTION 'p_work_order_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.agent_work_orders
     SET status = 'queued',
         approved_by = v_actor,
         approved_at = now(),
         gated_reason = NULL,
         claimed_by = NULL,
         claimed_at = NULL,
         lease_expires_at = NULL,
         last_error = NULL
   WHERE id = p_work_order_id
     AND deleted_at IS NULL
     AND status = 'gated'
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'work order % is not gated or does not exist', p_work_order_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_row.app_id,
    v_actor,
    'work_order_approved',
    jsonb_build_object(
      'work_order_id', v_row.id,
      'source_answer_id', v_row.source_answer_id,
      'risk_class', v_row.risk_class
    )
  );

  RETURN v_row;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_resolve_issue(uuid, text, text, jsonb, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_enqueue_with_gating(uuid, jsonb, text, text, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_approve_work_order(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cc_resolve_issue(uuid, text, text, jsonb, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_enqueue_with_gating(uuid, jsonb, text, text, uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_approve_work_order(uuid, text) TO service_role;

COMMIT;

