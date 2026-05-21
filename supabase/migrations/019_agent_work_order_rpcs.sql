-- ============================================================================
-- Migration 019: agent_work_order RPCs — enqueue, claim, lease, complete, fail
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- All RPCs are SECURITY DEFINER with EXECUTE granted only to service_role.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.cc_enqueue_work_order(
  p_app_id uuid,
  p_change_spec jsonb,
  p_risk_class text,
  p_idempotency_key text,
  p_source_answer_id uuid DEFAULT NULL,
  p_cost_cap_usd numeric DEFAULT NULL,
  p_max_attempts int DEFAULT 3
)
RETURNS public.agent_work_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.agent_work_orders;
BEGIN
  IF p_app_id IS NULL THEN
    RAISE EXCEPTION 'p_app_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_change_spec IS NULL OR jsonb_typeof(p_change_spec) <> 'object' THEN
    RAISE EXCEPTION 'p_change_spec must be a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_risk_class NOT IN ('auto','authorize','destructive','production') THEN
    RAISE EXCEPTION 'invalid risk_class: %', p_risk_class USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'p_idempotency_key is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_cost_cap_usd IS NOT NULL AND p_cost_cap_usd < 0 THEN
    RAISE EXCEPTION 'p_cost_cap_usd must be non-negative' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 THEN
    RAISE EXCEPTION 'p_max_attempts must be at least 1' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_row
  FROM public.agent_work_orders
  WHERE idempotency_key = p_idempotency_key;

  IF v_row.id IS NOT NULL THEN
    IF v_row.app_id IS DISTINCT FROM p_app_id
      OR v_row.change_spec IS DISTINCT FROM p_change_spec
      OR v_row.risk_class IS DISTINCT FROM p_risk_class
      OR v_row.source_answer_id IS DISTINCT FROM p_source_answer_id
      OR v_row.cost_cap_usd IS DISTINCT FROM p_cost_cap_usd
      OR v_row.max_attempts IS DISTINCT FROM p_max_attempts THEN
      RAISE EXCEPTION 'idempotency key % already exists for a different work-order payload', p_idempotency_key
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN v_row;
  END IF;

  IF p_source_answer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.cc_decision_answers a
    WHERE a.id = p_source_answer_id
      AND a.app_id = p_app_id
      AND a.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'source answer % does not belong to app %', p_source_answer_id, p_app_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  BEGIN
    INSERT INTO public.agent_work_orders (
      app_id,
      change_spec,
      source_answer_id,
      risk_class,
      idempotency_key,
      cost_cap_usd,
      max_attempts
    ) VALUES (
      p_app_id,
      p_change_spec,
      p_source_answer_id,
      p_risk_class,
      p_idempotency_key,
      p_cost_cap_usd,
      p_max_attempts
    )
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_row
    FROM public.agent_work_orders
    WHERE idempotency_key = p_idempotency_key;

    IF v_row.id IS NULL
      OR v_row.app_id IS DISTINCT FROM p_app_id
      OR v_row.change_spec IS DISTINCT FROM p_change_spec
      OR v_row.risk_class IS DISTINCT FROM p_risk_class
      OR v_row.source_answer_id IS DISTINCT FROM p_source_answer_id
      OR v_row.cost_cap_usd IS DISTINCT FROM p_cost_cap_usd
      OR v_row.max_attempts IS DISTINCT FROM p_max_attempts THEN
      RAISE EXCEPTION 'idempotency key % already exists for a different work-order payload', p_idempotency_key
        USING ERRCODE = 'unique_violation';
    END IF;

    RETURN v_row;
  END;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_row.app_id,
    'system',
    'work_order_created',
    jsonb_build_object(
      'work_order_id', v_row.id,
      'source_answer_id', v_row.source_answer_id,
      'risk_class', v_row.risk_class,
      'idempotency_key', v_row.idempotency_key
    )
  );

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_claim_work_order(
  p_runner text,
  p_lease_seconds int DEFAULT 600
)
RETURNS public.agent_work_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.agent_work_orders;
  v_tries int := 0;
BEGIN
  IF p_runner IS NULL OR btrim(p_runner) = '' THEN
    RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'p_lease_seconds must be between 30 and 3600' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  LOOP
    v_tries := v_tries + 1;
    IF v_tries > 20 THEN
      RETURN NULL;
    END IF;

    BEGIN
      WITH candidate AS (
        SELECT wo.id
        FROM public.agent_work_orders wo
        WHERE wo.deleted_at IS NULL
          AND wo.status IN ('queued','failed')
          AND wo.attempt_count < wo.max_attempts
          AND NOT EXISTS (
            SELECT 1
            FROM public.agent_work_orders active
            WHERE active.app_id = wo.app_id
              AND active.deleted_at IS NULL
              AND active.status IN ('claimed','dispatched','building')
          )
        ORDER BY wo.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.agent_work_orders wo
         SET status = 'claimed',
             claimed_by = p_runner,
             claimed_at = now(),
             lease_expires_at = now() + make_interval(secs => p_lease_seconds),
             attempt_count = wo.attempt_count + 1,
             last_error = NULL
        FROM candidate
       WHERE wo.id = candidate.id
      RETURNING wo.* INTO v_row;

      IF v_row.id IS NULL THEN
        RETURN NULL;
      END IF;

      INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
      VALUES (
        v_row.app_id,
        p_runner,
        'work_order_claimed',
        jsonb_build_object(
          'work_order_id', v_row.id,
          'runner', p_runner,
          'attempt_count', v_row.attempt_count,
          'lease_expires_at', v_row.lease_expires_at
        )
      );

      RETURN v_row;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent claimant won the per-app mutex between candidate selection
      -- and update. Retry so another app's order can still be claimed.
    END;
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_renew_lease(
  p_work_order_id uuid,
  p_runner text,
  p_lease_seconds int DEFAULT 600
)
RETURNS public.agent_work_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.agent_work_orders;
BEGIN
  IF p_runner IS NULL OR btrim(p_runner) = '' THEN
    RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'p_lease_seconds must be between 30 and 3600' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.agent_work_orders
     SET lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   WHERE id = p_work_order_id
     AND deleted_at IS NULL
     AND claimed_by = p_runner
     AND status IN ('claimed','dispatched','building')
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'work order % is not actively claimed by %', p_work_order_id, p_runner
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_complete_work_order(
  p_work_order_id uuid,
  p_pr_url text
)
RETURNS public.agent_work_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.agent_work_orders;
BEGIN
  IF p_pr_url IS NULL OR btrim(p_pr_url) = '' THEN
    RAISE EXCEPTION 'p_pr_url is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.agent_work_orders
     SET status = 'pr_open',
         pr_url = p_pr_url,
         pr_opened_at = now(),
         lease_expires_at = NULL
   WHERE id = p_work_order_id
     AND deleted_at IS NULL
     AND status IN ('claimed','dispatched','building')
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'work order % is not in a completable runner state', p_work_order_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_row.app_id,
    COALESCE(v_row.claimed_by, 'runner'),
    'pr_opened',
    jsonb_build_object('work_order_id', v_row.id, 'pr_url', v_row.pr_url)
  );

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_fail_work_order(
  p_work_order_id uuid,
  p_runner text,
  p_error text
)
RETURNS public.agent_work_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_current public.agent_work_orders;
  v_row public.agent_work_orders;
  v_event_type text;
BEGIN
  IF p_runner IS NULL OR btrim(p_runner) = '' THEN
    RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_error IS NULL OR btrim(p_error) = '' THEN
    RAISE EXCEPTION 'p_error is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_current
  FROM public.agent_work_orders
  WHERE id = p_work_order_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF v_current.id IS NULL THEN
    RAISE EXCEPTION 'work order % not found', p_work_order_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_current.claimed_by IS DISTINCT FROM p_runner THEN
    RAISE EXCEPTION 'work order % is not claimed by %', p_work_order_id, p_runner
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_current.status NOT IN ('claimed','dispatched','building') THEN
    RAISE EXCEPTION 'work order % is not active', p_work_order_id USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_event_type := CASE
    WHEN v_current.attempt_count >= v_current.max_attempts THEN 'work_order_dead_lettered'
    ELSE 'work_order_failed'
  END;

  UPDATE public.agent_work_orders
     SET status = CASE
           WHEN v_current.attempt_count >= v_current.max_attempts THEN 'dead_lettered'
           ELSE 'failed'
         END,
         claimed_by = NULL,
         claimed_at = NULL,
         lease_expires_at = NULL,
         last_error = p_error,
         dead_lettered_at = CASE
           WHEN v_current.attempt_count >= v_current.max_attempts THEN now()
           ELSE dead_lettered_at
         END
   WHERE id = v_current.id
  RETURNING * INTO v_row;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_row.app_id,
    p_runner,
    v_event_type,
    jsonb_build_object(
      'work_order_id', v_row.id,
      'runner', p_runner,
      'attempt_count', v_row.attempt_count,
      'max_attempts', v_row.max_attempts,
      'error', p_error
    )
  );

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_reclaim_expired_leases()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_reclaimed record;
  v_count int := 0;
BEGIN
  FOR v_reclaimed IN
    WITH expired AS (
      SELECT *
      FROM public.agent_work_orders
      WHERE deleted_at IS NULL
        AND status IN ('claimed','dispatched','building')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < now()
      FOR UPDATE
    ), updated AS (
      UPDATE public.agent_work_orders wo
         SET status = CASE
               WHEN expired.attempt_count >= expired.max_attempts THEN 'dead_lettered'
               ELSE 'queued'
             END,
             claimed_by = NULL,
             claimed_at = NULL,
             lease_expires_at = NULL,
             last_error = 'Lease expired before runner completed the work order.',
             dead_lettered_at = CASE
               WHEN expired.attempt_count >= expired.max_attempts THEN now()
               ELSE wo.dead_lettered_at
             END
        FROM expired
       WHERE wo.id = expired.id
      RETURNING
        wo.*,
        expired.claimed_by AS previous_runner
    )
    SELECT * FROM updated
  LOOP
    v_count := v_count + 1;
    INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
    VALUES (
      v_reclaimed.app_id,
      'work_order_sweeper',
      CASE
        WHEN v_reclaimed.status = 'dead_lettered' THEN 'work_order_dead_lettered'
        ELSE 'work_order_lease_expired'
      END,
      jsonb_build_object(
        'work_order_id', v_reclaimed.id,
        'previous_runner', v_reclaimed.previous_runner,
        'attempt_count', v_reclaimed.attempt_count,
        'max_attempts', v_reclaimed.max_attempts
      )
    );
  END LOOP;

  RETURN v_count;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_enqueue_work_order(uuid, jsonb, text, text, uuid, numeric, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_claim_work_order(text, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_renew_lease(uuid, text, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_complete_work_order(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_fail_work_order(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_reclaim_expired_leases() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cc_enqueue_work_order(uuid, jsonb, text, text, uuid, numeric, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_claim_work_order(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_renew_lease(uuid, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_complete_work_order(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_fail_work_order(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_reclaim_expired_leases() TO service_role;

COMMIT;
