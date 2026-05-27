-- ============================================================================
-- Migration 051: decision email send superseded state
-- Target: control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Adds a terminal-ish email-send state for co-recipient sends that should stop
-- receiving reminders after a sibling recipient answered the decision.
-- ============================================================================

ALTER TYPE public.cc_decision_email_state
  ADD VALUE IF NOT EXISTS 'superseded';

BEGIN;

ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

COMMENT ON COLUMN public.cc_decision_email_sends.superseded_at IS
  'Set when this recipient send stops awaiting reply because a co-recipient already answered the same decision.';

COMMIT;

BEGIN;

CREATE OR REPLACE FUNCTION public.cc_claim_reminder_task(
  p_lease_seconds integer DEFAULT 60
)
RETURNS public.cc_decision_email_sends
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.cc_decision_email_sends;
  v_lease interval := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 60), 30));
  v_claim uuid := gen_random_uuid();
BEGIN
  UPDATE public.cc_decision_email_sends
  SET claim_token = NULL,
      lease_expires_at = NULL,
      reminder_started_at = NULL
  WHERE deleted_at IS NULL
    AND state IN ('sent', 'delivered', 'opened', 'clicked')
    AND replied_at IS NULL
    AND claim_token IS NOT NULL
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < now();

  UPDATE public.cc_decision_email_sends s
  SET claim_token = v_claim,
      lease_expires_at = now() + v_lease,
      reminder_started_at = now(),
      reminder_attempt_id = gen_random_uuid(),
      reminder_attempt_count = COALESCE(s.reminder_attempt_count, 0) + 1
  WHERE s.id = (
    SELECT x.id
    FROM public.cc_decision_email_sends x
    JOIN public.registry_apps a ON a.id = x.app_id
    JOIN public.cc_issues i ON i.id = x.issue_id
    WHERE x.deleted_at IS NULL
      AND x.created_via IN ('manual', 'auto_route')
      AND x.state IN ('sent', 'delivered', 'opened', 'clicked')
      AND x.replied_at IS NULL
      AND x.reminded_at IS NULL
      AND x.claim_token IS NULL
      AND COALESCE(x.reminder_attempt_count, 0) < 2
      AND x.sent_at IS NOT NULL
      AND x.sent_at < now() - interval '2 days'
      AND x.magic_link_expires_at > now() + interval '24 hours'
      AND a.deleted_at IS NULL
      AND a.auto_route_decisions = true
      AND i.deleted_at IS NULL
      AND i.auto_route_paused_at IS NULL
      AND (i.snoozed_until IS NULL OR i.snoozed_until <= now())
    ORDER BY x.sent_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING s.* INTO v_row;

  RETURN v_row;
END;
$fn$;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.cc_finish_extraction_with_answer(
  p_send_id uuid,
  p_runner text,
  p_claim_token uuid,
  p_option_id text,
  p_confidence numeric,
  p_rationale text,
  p_llm_extraction jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.cc_decision_email_sends%ROWTYPE;
  v_option text := NULLIF(left(btrim(COALESCE(p_option_id, '')), 200), '');
  v_runner text := NULLIF(left(btrim(COALESCE(p_runner, '')), 200), '');
  v_options jsonb;
  v_answer jsonb;
  v_answer_id uuid;
  v_work_order public.agent_work_orders;
  v_change_spec jsonb;
  v_threshold numeric := COALESCE(NULLIF(current_setting('cc.extraction_auto_commit_confidence', true), '')::numeric, 1.01);
BEGIN
  IF v_runner IS NULL THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'P0001'; END IF;
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'p_claim_token is required' USING ERRCODE = 'P0001'; END IF;
  IF v_option IS NULL THEN RAISE EXCEPTION 'p_option_id is required' USING ERRCODE = 'P0001'; END IF;
  IF p_confidence IS NULL OR p_confidence < 0 OR p_confidence > 1 THEN RAISE EXCEPTION 'p_confidence must be in [0,1]' USING ERRCODE = 'P0001'; END IF;
  IF p_llm_extraction IS NULL OR jsonb_typeof(p_llm_extraction) <> 'object' THEN RAISE EXCEPTION 'p_llm_extraction must be a JSON object' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_row
  FROM public.cc_decision_email_sends s
  WHERE s.id = p_send_id
    AND s.deleted_at IS NULL
    AND s.state = 'extracting'
    AND s.extraction_runner_id = v_runner
    AND s.claim_token = p_claim_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'extraction task not claimable by runner (stale claim_token, wrong runner, or wrong state)' USING ERRCODE = 'P0001';
  END IF;

  v_options := (
    SELECT jsonb_agg(opt - 'token_hash' - 'confirm_url')
    FROM jsonb_array_elements(v_row.options_snapshot) opt
  );

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_options, '[]'::jsonb)) opt
    WHERE COALESCE(opt ->> 'id', opt ->> 'value', opt ->> 'key') = v_option
  ) THEN
    RAISE EXCEPTION 'option_id is not valid for this decision' USING ERRCODE = 'P0001';
  END IF;

  IF p_confidence < v_threshold THEN
    RAISE EXCEPTION 'confidence % below auto-commit threshold %; use cc_finish_extraction_with_clarify or cc_finish_extraction_needs_review', p_confidence, v_threshold USING ERRCODE = 'P0001';
  END IF;

  v_answer := public.cc_resolve_issue(
    v_row.issue_id,
    'answer_decision',
    v_option,
    COALESCE(v_options, '[]'::jsonb),
    format('LLM extraction (confidence=%s): %s', p_confidence, COALESCE(left(NULLIF(btrim(COALESCE(p_rationale, '')), ''), 500), '')),
    v_row.risk_class,
    NULL,
    'claude-extraction:' || v_runner,
    v_row.decision_external_ref,
    'auto_extraction'::public.cc_decision_answer_source
  );
  v_answer_id := NULLIF(v_answer ->> 'decision_answer_id', '')::uuid;

  UPDATE public.cc_decision_email_sends
  SET state = 'answered',
      answered_at = now(),
      selected_option = v_option,
      decision_answer_id = v_answer_id,
      llm_extraction = p_llm_extraction,
      extraction_started_at = NULL,
      claim_token = NULL,
      operator_confirmed_by = 'claude-extraction:' || v_runner,
      operator_confirmed_at = now(),
      last_error = NULL
  WHERE id = p_send_id
  RETURNING * INTO v_row;

  BEGIN
    PERFORM net.http_post(
      url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-notify-co-recipients',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cc-write-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CC_WRITE_TOKEN' LIMIT 1)
      ),
      body := jsonb_build_object(
        'issue_id', v_row.issue_id,
        'decision_external_ref', v_row.decision_external_ref,
        'answer_id', v_answer_id,
        'app_id', v_row.app_id
      ),
      timeout_milliseconds := 10000
    );
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
    VALUES (
      v_row.app_id,
      'cc_finish_extraction_with_answer',
      'co_recipient_notify_failed',
      jsonb_build_object(
        'send_id', v_row.id,
        'issue_id', v_row.issue_id,
        'decision_external_ref', v_row.decision_external_ref,
        'answer_id', v_answer_id,
        'error', SQLERRM
      )
    );
  END;

  v_change_spec := jsonb_build_object(
    'intent', format('Apply extracted answer %s to decision %s.', v_option, v_row.raw_decision_title),
    'affected_area', v_row.decision_external_ref,
    'acceptance_criteria', jsonb_build_array('Implement the extracted choice', 'All existing tests pass', 'No schema-destructive operations'),
    'constraints', jsonb_build_array('Single PR', 'Branch must start with cc/', 'Do not modify CI configuration')
  );

  v_work_order := public.cc_enqueue_with_gating(
    v_row.app_id,
    v_change_spec,
    v_row.risk_class,
    'decision_email_extracted:' || v_row.id::text || ':' || v_option,
    v_answer_id,
    NULL,
    'claude-extraction:' || v_runner
  );

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_row.app_id,
    'claude-extraction:' || v_runner,
    'decision_extracted_and_answered',
    jsonb_build_object(
      'send_id', v_row.id,
      'issue_id', v_row.issue_id,
      'decision_answer_id', v_answer_id,
      'work_order_id', v_work_order.id,
      'option_id', v_option,
      'confidence', p_confidence
    )
  );

  RETURN jsonb_build_object('send', to_jsonb(v_row), 'answer', v_answer, 'work_order', to_jsonb(v_work_order));
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_claim_reminder_task(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_finish_extraction_with_answer(uuid, text, uuid, text, numeric, text, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cc_claim_reminder_task(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_finish_extraction_with_answer(uuid, text, uuid, text, numeric, text, jsonb) TO service_role;

COMMIT;

-- ============================================================================
-- Down migration (commented; enum values cannot be removed safely in-place)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public.cc_decision_email_sends DROP COLUMN IF EXISTS superseded_at;
--   -- Removing public.cc_decision_email_state value 'superseded' requires rebuilding the enum
--   -- after all superseded sends are remediated or deleted.
-- COMMIT;
