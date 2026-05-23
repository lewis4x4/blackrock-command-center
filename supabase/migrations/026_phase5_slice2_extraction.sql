-- ============================================================================
-- Migration 026: Phase 5 Slice 2 extraction loop
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Adds extraction-claim fencing, inbound dedup hardening, clarify message
-- matching, operator review queue state, and extraction finish/fail RPCs.
-- ============================================================================

-- ============================================================================
-- Transaction 1: enum extension only.
-- ============================================================================
BEGIN;

ALTER TYPE public.cc_decision_email_state
  ADD VALUE IF NOT EXISTS 'awaiting_operator_review' BEFORE 'reminded';
ALTER TYPE public.cc_decision_email_state
  ADD VALUE IF NOT EXISTS 'rejected_by_operator' BEFORE 'reminded';

COMMIT;

-- ============================================================================
-- Transaction 2: schema + RPCs.
-- ============================================================================
BEGIN;

ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS clarification_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS clarification_gmail_message_id text,
  ADD COLUMN IF NOT EXISTS inbound_gmail_message_id text,
  ADD COLUMN IF NOT EXISTS inbound_received_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS cc_decision_email_sends_inbound_msg_idx
  ON public.cc_decision_email_sends (inbound_gmail_message_id)
  WHERE inbound_gmail_message_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cc_decision_email_sends_clarify_msg_idx
  ON public.cc_decision_email_sends (clarification_gmail_message_id)
  WHERE clarification_gmail_message_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS cc_decision_email_sends_operator_review_idx
  ON public.cc_decision_email_sends (state, updated_at DESC)
  WHERE deleted_at IS NULL AND state IN ('awaiting_operator_review', 'extracting');

CREATE INDEX IF NOT EXISTS cc_decision_email_sends_awaiting_clarify_idx
  ON public.cc_decision_email_sends (state, updated_at ASC)
  WHERE deleted_at IS NULL AND state = 'awaiting_clarify';

-- Threshold GUC intentionally NOT set here — managed Supabase rejects
-- ALTER DATABASE for custom GUCs (permission denied: superuser only).
-- Every reader uses COALESCE(NULLIF(current_setting('cc.extraction_auto_commit_confidence', true), '')::numeric, 1.01)
-- which defaults to 1.01 (auto-commit OFF) when the GUC is unset. To enable
-- auto-commit later, set the value via the Supabase dashboard under
-- Database → Postgres → Custom Parameters, or call:
--   SELECT set_config('cc.extraction_auto_commit_confidence', '0.85', false);
-- inside an opt-in RPC. See SLICE_2_EXTRACTION_DESIGN.md §0 for the hard
-- build gate before any value < 1.0 is permitted.

CREATE TABLE IF NOT EXISTS public.cc_decision_inbound_extra_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id uuid NOT NULL REFERENCES public.cc_decision_email_sends(id) ON DELETE CASCADE,
  inbound_gmail_message_id text NOT NULL,
  raw_reply_text text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (send_id, inbound_gmail_message_id)
);

ALTER TABLE public.cc_decision_inbound_extra_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS extra_replies_service_all ON public.cc_decision_inbound_extra_replies;
CREATE POLICY extra_replies_service_all
  ON public.cc_decision_inbound_extra_replies
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.cc_decision_inbound_extra_replies FROM anon, authenticated;
GRANT ALL ON public.cc_decision_inbound_extra_replies TO service_role;

CREATE OR REPLACE FUNCTION public.cc_get_decision_confirm_data(
  p_token_hash text,
  p_option_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_hash text := NULLIF(btrim(COALESCE(p_token_hash, '')), '');
  v_option text := NULLIF(left(btrim(COALESCE(p_option_id, '')), 200), '');
  v_row public.cc_decision_email_sends%ROWTYPE;
  v_token jsonb;
  v_options jsonb;
  v_selected jsonb;
BEGIN
  IF v_hash IS NULL THEN RAISE EXCEPTION 'token hash is required' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_row
  FROM public.cc_decision_email_sends s
  WHERE s.deleted_at IS NULL
    AND s.state IN ('sent','delivered','opened','clicked','replied','extracting','awaiting_clarify','clarify_sent','awaiting_operator_review')
    AND s.magic_link_expires_at > now()
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(s.magic_link_tokens) tok
      WHERE tok ->> 'token_hash' = v_hash
        AND (v_option IS NULL OR tok ->> 'option_id' = v_option)
    )
  ORDER BY s.sent_at DESC NULLS LAST, s.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN RAISE EXCEPTION 'decision link is invalid or expired' USING ERRCODE = 'P0001'; END IF;

  SELECT tok INTO v_token
  FROM jsonb_array_elements(v_row.magic_link_tokens) tok
  WHERE tok ->> 'token_hash' = v_hash
    AND (v_option IS NULL OR tok ->> 'option_id' = v_option)
  LIMIT 1;

  v_option := COALESCE(v_option, v_token ->> 'option_id');
  v_options := (
    SELECT jsonb_agg(opt - 'token_hash' - 'confirm_url')
    FROM jsonb_array_elements(v_row.options_snapshot) opt
  );
  SELECT opt - 'token_hash' - 'confirm_url' INTO v_selected
  FROM jsonb_array_elements(v_row.options_snapshot) opt
  WHERE COALESCE(opt ->> 'id', opt ->> 'value', opt ->> 'key') = v_option
  LIMIT 1;

  RETURN jsonb_build_object(
    'send_id', v_row.id,
    'app_id', v_row.app_id,
    'issue_id', v_row.issue_id,
    'decision_external_ref', v_row.decision_external_ref,
    'recipient_name', v_row.recipient_name,
    'recipient_email', v_row.recipient_email,
    'subject', v_row.rewritten_subject,
    'body', v_row.rewritten_body,
    'raw_title', v_row.raw_decision_title,
    'raw_body', v_row.raw_decision_body,
    'options', COALESCE(v_options, '[]'::jsonb),
    'selected_option', v_selected,
    'selected_option_id', v_option,
    'expires_at', v_row.magic_link_expires_at,
    'state', v_row.state
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_confirm_decision_token(
  p_token_hash text,
  p_option_id text,
  p_actor text DEFAULT 'client-magic-link'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_hash text := NULLIF(btrim(COALESCE(p_token_hash, '')), '');
  v_option text := NULLIF(left(btrim(COALESCE(p_option_id, '')), 200), '');
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_row public.cc_decision_email_sends%ROWTYPE;
  v_options jsonb;
  v_answer jsonb;
  v_answer_id uuid;
  v_work_order public.agent_work_orders;
  v_change_spec jsonb;
BEGIN
  IF v_hash IS NULL THEN RAISE EXCEPTION 'token hash is required' USING ERRCODE = 'P0001'; END IF;
  IF v_option IS NULL THEN RAISE EXCEPTION 'option_id is required' USING ERRCODE = 'P0001'; END IF;
  IF v_actor IS NULL THEN v_actor := 'client-magic-link'; END IF;

  SELECT * INTO v_row
  FROM public.cc_decision_email_sends s
  WHERE s.deleted_at IS NULL
    AND s.state IN ('sent','delivered','opened','clicked','replied','extracting','awaiting_clarify','clarify_sent','awaiting_operator_review')
    AND s.magic_link_expires_at > now()
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(s.magic_link_tokens) tok
      WHERE tok ->> 'token_hash' = v_hash
        AND tok ->> 'option_id' = v_option
    )
  ORDER BY s.sent_at DESC NULLS LAST, s.created_at DESC
  FOR UPDATE
  LIMIT 1;

  IF NOT FOUND THEN RAISE EXCEPTION 'decision link is invalid or expired' USING ERRCODE = 'P0001'; END IF;

  v_options := (
    SELECT jsonb_agg(opt - 'token_hash' - 'confirm_url')
    FROM jsonb_array_elements(v_row.options_snapshot) opt
  );

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_options, '[]'::jsonb)) opt
    WHERE COALESCE(opt ->> 'id', opt ->> 'value', opt ->> 'key') = v_option
  ) THEN
    RAISE EXCEPTION 'option_id is not valid for this decision' USING ERRCODE = 'P0001';
  END IF;

  v_answer := public.cc_resolve_issue(
    v_row.issue_id,
    'answer_decision',
    v_option,
    COALESCE(v_options, '[]'::jsonb),
    format('Client confirmed by magic link: %s', v_row.recipient_email),
    v_row.risk_class,
    NULL,
    v_actor,
    v_row.decision_external_ref
  );
  v_answer_id := NULLIF(v_answer ->> 'decision_answer_id', '')::uuid;

  UPDATE public.cc_decision_email_sends
  SET state = 'answered',
      answered_at = now(),
      operator_confirmed_by = v_actor,
      operator_confirmed_at = now(),
      selected_option = v_option,
      decision_answer_id = v_answer_id,
      clicked_at = COALESCE(clicked_at, now()),
      claim_token = NULL,
      extraction_started_at = NULL
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  v_change_spec := jsonb_build_object(
    'intent', format('Apply client answer %s to decision %s.', v_option, v_row.raw_decision_title),
    'affected_area', v_row.decision_external_ref,
    'acceptance_criteria', jsonb_build_array('Implement the confirmed client choice', 'All existing tests pass', 'No schema-destructive operations'),
    'constraints', jsonb_build_array('Single PR', 'Branch must start with cc/', 'Do not modify CI configuration')
  );

  v_work_order := public.cc_enqueue_with_gating(
    v_row.app_id,
    v_change_spec,
    v_row.risk_class,
    'decision_email:' || v_row.id::text || ':' || v_option,
    v_answer_id,
    NULL,
    v_actor
  );

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, v_actor, 'decision_answered_by_recipient', jsonb_build_object(
    'send_id', v_row.id,
    'issue_id', v_row.issue_id,
    'decision_answer_id', v_answer_id,
    'work_order_id', v_work_order.id,
    'recipient_email', v_row.recipient_email,
    'selected_option', v_option
  ));

  RETURN jsonb_build_object('send', to_jsonb(v_row), 'answer', v_answer, 'work_order', to_jsonb(v_work_order), 'dispatched', v_work_order.status = 'queued');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_claim_extraction_task(
  p_runner text,
  p_lease_seconds integer DEFAULT 300
)
RETURNS public.cc_decision_email_sends
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.cc_decision_email_sends;
  v_runner text := NULLIF(left(btrim(COALESCE(p_runner, '')), 200), '');
  v_lease interval := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 30));
  v_claim uuid := gen_random_uuid();
BEGIN
  IF v_runner IS NULL THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_decision_email_sends
  SET state = 'awaiting_operator_review',
      extraction_started_at = NULL,
      claim_token = NULL,
      last_error = COALESCE(last_error, 'extraction exhausted attempts and lease expired'),
      llm_extraction = jsonb_set(COALESCE(llm_extraction, '{}'::jsonb), '{requires_human}', 'true'::jsonb)
  WHERE deleted_at IS NULL
    AND state IN ('replied', 'extracting')
    AND attempt_count >= max_attempts
    AND extraction_started_at IS NOT NULL
    AND extraction_started_at < now() - v_lease;

  UPDATE public.cc_decision_email_sends s
  SET state = 'extracting',
      extraction_started_at = now(),
      extraction_runner_id = v_runner,
      claim_token = v_claim,
      attempt_count = s.attempt_count + 1,
      last_error = NULL
  WHERE s.id = (
    SELECT id
    FROM public.cc_decision_email_sends
    WHERE deleted_at IS NULL
      AND (
        (state = 'replied' AND llm_extraction IS NULL) OR
        (state = 'extracting' AND extraction_started_at < now() - v_lease)
      )
      AND attempt_count < max_attempts
      AND raw_reply_text IS NOT NULL
    ORDER BY replied_at ASC NULLS LAST, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING * INTO v_row;

  IF v_row.id IS NOT NULL THEN
    INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
    VALUES (
      v_row.app_id,
      'claude-extraction:' || v_runner,
      'decision_extraction_started',
      jsonb_build_object(
        'send_id', v_row.id,
        'issue_id', v_row.issue_id,
        'attempt_count', v_row.attempt_count,
        'runner_id', v_runner,
        'claim_token', v_claim
      )
    );
  END IF;

  RETURN v_row;
END;
$fn$;

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
    v_row.decision_external_ref
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

CREATE OR REPLACE FUNCTION public.cc_finish_extraction_with_clarify(
  p_send_id uuid,
  p_runner text,
  p_claim_token uuid,
  p_clarifying_question text,
  p_confidence numeric,
  p_llm_extraction jsonb
)
RETURNS public.cc_decision_email_sends
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.cc_decision_email_sends;
  v_runner text := NULLIF(left(btrim(COALESCE(p_runner, '')), 200), '');
  v_question text := NULLIF(left(btrim(COALESCE(p_clarifying_question, '')), 400), '');
BEGIN
  IF v_runner IS NULL THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'P0001'; END IF;
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'p_claim_token is required' USING ERRCODE = 'P0001'; END IF;
  IF v_question IS NULL THEN RAISE EXCEPTION 'p_clarifying_question is required' USING ERRCODE = 'P0001'; END IF;
  IF p_confidence IS NULL OR p_confidence < 0 OR p_confidence > 1 THEN RAISE EXCEPTION 'p_confidence must be in [0,1]' USING ERRCODE = 'P0001'; END IF;
  IF p_llm_extraction IS NULL OR jsonb_typeof(p_llm_extraction) <> 'object' THEN RAISE EXCEPTION 'p_llm_extraction must be a JSON object' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_decision_email_sends
  SET state = 'awaiting_clarify',
      llm_extraction = p_llm_extraction || jsonb_build_object('proposed_clarifying_question', v_question),
      extraction_started_at = NULL,
      claim_token = NULL,
      last_error = NULL
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND state = 'extracting'
    AND extraction_runner_id = v_runner
    AND claim_token = p_claim_token
    AND clarification_attempt_count < 1
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'extraction task not claimable by runner OR clarification budget exhausted' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_row.app_id,
    'claude-extraction:' || v_runner,
    'decision_extraction_proposed_clarify',
    jsonb_build_object('send_id', v_row.id, 'issue_id', v_row.issue_id, 'confidence', p_confidence)
  );

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_finish_extraction_needs_review(
  p_send_id uuid,
  p_runner text,
  p_claim_token uuid,
  p_llm_extraction jsonb,
  p_reason text
)
RETURNS public.cc_decision_email_sends
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.cc_decision_email_sends;
  v_runner text := NULLIF(left(btrim(COALESCE(p_runner, '')), 200), '');
  v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 80), '');
BEGIN
  IF v_runner IS NULL THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'P0001'; END IF;
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'p_claim_token is required' USING ERRCODE = 'P0001'; END IF;
  IF v_reason IS NULL OR v_reason NOT IN ('off_topic','unparseable','budget_exhausted','option_hallucinated','low_confidence') THEN
    RAISE EXCEPTION 'p_reason must be one of off_topic, unparseable, budget_exhausted, option_hallucinated, low_confidence' USING ERRCODE = 'P0001';
  END IF;
  IF p_llm_extraction IS NULL OR jsonb_typeof(p_llm_extraction) <> 'object' THEN RAISE EXCEPTION 'p_llm_extraction must be a JSON object' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_decision_email_sends
  SET state = 'awaiting_operator_review',
      llm_extraction = p_llm_extraction || jsonb_build_object('requires_human', true, 'reason', v_reason),
      extraction_started_at = NULL,
      claim_token = NULL,
      last_error = NULL
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND state = 'extracting'
    AND extraction_runner_id = v_runner
    AND claim_token = p_claim_token
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'extraction task not claimable by runner (stale claim_token or wrong state)' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_row.app_id,
    'claude-extraction:' || v_runner,
    'decision_extraction_needs_review',
    jsonb_build_object(
      'send_id', v_row.id,
      'issue_id', v_row.issue_id,
      'reason', v_reason,
      'matched_option_id', p_llm_extraction ->> 'matched_option_id',
      'confidence', p_llm_extraction -> 'confidence'
    )
  );

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_claim_clarify_task(
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
      clarification_started_at = NULL
  WHERE deleted_at IS NULL
    AND state = 'awaiting_clarify'
    AND clarification_attempt_count < 1
    AND claim_token IS NOT NULL
    AND clarification_started_at IS NOT NULL
    AND clarification_started_at < now() - v_lease;

  UPDATE public.cc_decision_email_sends s
  SET claim_token = v_claim,
      clarification_started_at = now()
  WHERE s.id = (
    SELECT id
    FROM public.cc_decision_email_sends
    WHERE deleted_at IS NULL
      AND state = 'awaiting_clarify'
      AND clarification_attempt_count < 1
      AND claim_token IS NULL
    ORDER BY updated_at ASC, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_fail_extraction_task(
  p_send_id uuid,
  p_runner text,
  p_claim_token uuid,
  p_error text
)
RETURNS public.cc_decision_email_sends
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.cc_decision_email_sends;
  v_runner text := NULLIF(left(btrim(COALESCE(p_runner, '')), 200), '');
  v_error text := left(COALESCE(p_error, 'extraction failed'), 2000);
BEGIN
  IF v_runner IS NULL THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'P0001'; END IF;
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'p_claim_token is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_decision_email_sends
  SET state = CASE
        WHEN attempt_count >= max_attempts THEN 'awaiting_operator_review'::public.cc_decision_email_state
        ELSE 'replied'::public.cc_decision_email_state
      END,
      extraction_started_at = NULL,
      claim_token = NULL,
      last_error = v_error
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND state = 'extracting'
    AND extraction_runner_id = v_runner
    AND claim_token = p_claim_token
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'extraction task not claimable by runner (stale claim_token or wrong state)' USING ERRCODE = 'P0001';
  END IF;

  IF v_row.state = 'awaiting_operator_review' THEN
    INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
    VALUES (
      v_row.app_id,
      'claude-extraction:' || v_runner,
      'decision_extraction_exhausted',
      jsonb_build_object(
        'send_id', v_row.id,
        'issue_id', v_row.issue_id,
        'attempt_count', v_row.attempt_count,
        'last_error', v_row.last_error
      )
    );
  END IF;

  RETURN v_row;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_get_decision_confirm_data(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_confirm_decision_token(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_claim_extraction_task(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_finish_extraction_with_answer(uuid, text, uuid, text, numeric, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_finish_extraction_with_clarify(uuid, text, uuid, text, numeric, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_finish_extraction_needs_review(uuid, text, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_claim_clarify_task(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_fail_extraction_task(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cc_get_decision_confirm_data(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_confirm_decision_token(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_claim_extraction_task(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_finish_extraction_with_answer(uuid, text, uuid, text, numeric, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_finish_extraction_with_clarify(uuid, text, uuid, text, numeric, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_finish_extraction_needs_review(uuid, text, uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_claim_clarify_task(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_fail_extraction_task(uuid, text, uuid, text) TO service_role;

COMMIT;
