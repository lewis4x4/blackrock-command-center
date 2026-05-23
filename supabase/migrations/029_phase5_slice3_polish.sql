-- ============================================================================
-- Migration 029: Phase 5 Slice 3 polish
-- ============================================================================

BEGIN;

ALTER TABLE public.cc_issues
  ADD COLUMN IF NOT EXISTS auto_route_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_route_paused_by text,
  ADD COLUMN IF NOT EXISTS auto_route_paused_reason text,
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_by text;

ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS reminder_gmail_message_id text,
  ADD COLUMN IF NOT EXISTS reminder_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS reminder_attempt_count integer NOT NULL DEFAULT 0 CHECK (reminder_attempt_count <= 2),
  ADD COLUMN IF NOT EXISTS operator_clarification_count integer NOT NULL DEFAULT 0 CHECK (operator_clarification_count <= 5);

CREATE UNIQUE INDEX IF NOT EXISTS cc_decision_email_sends_reminder_msg_idx
  ON public.cc_decision_email_sends (reminder_gmail_message_id)
  WHERE reminder_gmail_message_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS cc_issues_auto_route_paused_idx
  ON public.cc_issues (auto_route_paused_at)
  WHERE deleted_at IS NULL AND auto_route_paused_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS cc_issues_snoozed_until_idx
  ON public.cc_issues (snoozed_until)
  WHERE deleted_at IS NULL AND snoozed_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS cc_audit_events_extraction_metrics_idx
  ON public.cc_audit_events (occurred_at, event_type)
  WHERE event_type IN ('decision_extracted_and_answered', 'decision_extraction_reverted');

CREATE OR REPLACE VIEW public.cc_extraction_threshold_metrics AS
WITH win AS (
  SELECT (now() - interval '14 days') AS start_at, now() AS end_at
),
a AS (
  SELECT COUNT(*)::numeric AS n
  FROM public.cc_audit_events e, win
  WHERE e.event_type = 'decision_extracted_and_answered'
    AND e.occurred_at >= win.start_at
    AND e.occurred_at < win.end_at
),
r AS (
  SELECT COUNT(*)::numeric AS n
  FROM public.cc_audit_events e, win
  WHERE e.event_type = 'decision_extraction_reverted'
    AND e.occurred_at >= win.start_at
    AND e.occurred_at < win.end_at
)
SELECT
  (SELECT start_at FROM win) AS window_start,
  (SELECT end_at FROM win) AS window_end,
  COALESCE((SELECT n FROM a), 0)::int AS auto_commits_14d,
  COALESCE((SELECT n FROM r), 0)::int AS reverts_14d,
  CASE
    WHEN COALESCE((SELECT n FROM a), 0) > 0
    THEN COALESCE((SELECT n FROM r), 0) / (SELECT n FROM a)
    ELSE 0::numeric
  END AS revert_rate_14d,
  COALESCE(NULLIF(current_setting('cc.extraction_auto_commit_confidence', true), '')::numeric, 1.01) AS current_threshold;

REVOKE ALL ON public.cc_extraction_threshold_metrics FROM anon, authenticated;
GRANT SELECT ON public.cc_extraction_threshold_metrics TO service_role;

CREATE OR REPLACE FUNCTION public.cc_pause_auto_route(
  p_issue_id uuid,
  p_actor text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_reason text := NULLIF(left(btrim(COALESCE(p_reason, '')), 500), '');
  v_row public.cc_issues%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_issues
  SET auto_route_paused_at = now(),
      auto_route_paused_by = v_actor,
      auto_route_paused_reason = v_reason
  WHERE id = p_issue_id
    AND deleted_at IS NULL
    AND issue_type = 'open_decision'
    AND source_ref = 'aggregate'
    AND auto_route_paused_at IS NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'issue not pausable' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_row.app_id,
    v_actor,
    'decision_auto_route_paused',
    jsonb_build_object('issue_id', v_row.id, 'paused_at', v_row.auto_route_paused_at, 'reason', v_reason)
  );

  RETURN to_jsonb(v_row);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_resume_auto_route(
  p_issue_id uuid,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_row public.cc_issues%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_issues
  SET auto_route_paused_at = NULL,
      auto_route_paused_by = NULL,
      auto_route_paused_reason = NULL
  WHERE id = p_issue_id
    AND deleted_at IS NULL
    AND auto_route_paused_at IS NOT NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'issue not paused' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_row.app_id,
    v_actor,
    'decision_auto_route_resumed',
    jsonb_build_object('issue_id', v_row.id)
  );

  RETURN to_jsonb(v_row);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_snooze_decision(
  p_issue_id uuid,
  p_until timestamptz,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_max timestamptz := now() + interval '30 days';
  v_row public.cc_issues%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;
  IF p_until IS NULL THEN RAISE EXCEPTION 'p_until is required' USING ERRCODE = 'P0001'; END IF;
  IF p_until <= now() THEN RAISE EXCEPTION 'p_until must be in the future' USING ERRCODE = 'P0001'; END IF;
  IF p_until > v_max THEN RAISE EXCEPTION 'p_until exceeds 30-day cap' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_issues
  SET snoozed_until = p_until,
      snoozed_by = v_actor
  WHERE id = p_issue_id
    AND deleted_at IS NULL
    AND issue_type = 'open_decision'
    AND source_ref = 'aggregate'
    AND status IN ('surfaced', 'triaging', 'routed_to_client', 'gated')
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'issue not snoozable' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, v_actor, 'decision_snoozed', jsonb_build_object('issue_id', v_row.id, 'snoozed_until', p_until));

  RETURN to_jsonb(v_row);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_unsnooze_decision(
  p_issue_id uuid,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_row public.cc_issues%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_issues
  SET snoozed_until = NULL,
      snoozed_by = NULL
  WHERE id = p_issue_id
    AND deleted_at IS NULL
    AND snoozed_until IS NOT NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'issue not snoozed' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, v_actor, 'decision_unsnoozed', jsonb_build_object('issue_id', v_row.id));

  RETURN to_jsonb(v_row);
END;
$fn$;

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

-- Pause gates live in SQL claim predicates.
CREATE OR REPLACE FUNCTION public.cc_claim_auto_route_candidate(p_actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_issue public.cc_issues%ROWTYPE;
  v_app public.registry_apps%ROWTYPE;
  v_send public.cc_decision_email_sends%ROWTYPE;
  v_detail jsonb;
  v_decision_external_ref text;
  v_risk_class text;
  v_options jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;

  SELECT i.*
  INTO v_issue
  FROM public.cc_issues i
  JOIN public.registry_apps a ON a.id = i.app_id
  WHERE i.deleted_at IS NULL
    AND i.issue_type = 'open_decision'
    AND i.source_ref = 'aggregate'
    AND i.status = 'surfaced'
    AND i.auto_route_paused_at IS NULL
    AND (i.snoozed_until IS NULL OR i.snoozed_until <= now())
    AND a.deleted_at IS NULL
    AND a.auto_route_decisions = true
    AND EXISTS (
      SELECT 1
      FROM public.registry_app_decision_recipients r
      WHERE r.app_id = i.app_id
        AND r.active = true
        AND r.deleted_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.cc_decision_email_sends s
      WHERE s.issue_id = i.id
        AND s.deleted_at IS NULL
    )
    AND lower(NULLIF(btrim(i.detail ->> 'risk_class'), '')) IN ('auto', 'authorize')
    AND (
      lower(COALESCE(i.detail ->> 'owner_kind', '')) IN ('client','customer')
      OR lower(COALESCE(i.detail ->> 'owner_role', '')) LIKE 'client%'
      OR lower(COALESCE(i.detail ->> 'auto_route_eligible', 'false')) IN ('true','t','1','yes')
    )
  ORDER BY i.surfaced_at ASC, i.created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_issue.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_detail := COALESCE(v_issue.detail, '{}'::jsonb);

  SELECT * INTO v_app
  FROM public.registry_apps
  WHERE id = v_issue.app_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF v_app.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_decision_external_ref := NULLIF(left(btrim(COALESCE(v_detail ->> 'decision_external_ref', '')), 200), '');
  IF v_decision_external_ref IS NULL THEN
    v_decision_external_ref := NULLIF(left(btrim(COALESCE(v_issue.source_ref, '')), 200), '');
  END IF;
  IF v_decision_external_ref IS NULL THEN
    v_decision_external_ref := 'decision';
  END IF;

  v_risk_class := lower(NULLIF(btrim(v_detail ->> 'risk_class'), ''));
  IF v_risk_class IS NULL OR v_risk_class NOT IN ('auto', 'authorize') THEN
    RETURN NULL;
  END IF;

  v_options := COALESCE(
    CASE
      WHEN jsonb_typeof(v_detail -> 'options') = 'array' THEN v_detail -> 'options'
      WHEN jsonb_typeof(v_detail -> 'answer_options') = 'array' THEN v_detail -> 'answer_options'
      WHEN jsonb_typeof(v_detail -> 'choices') = 'array' THEN v_detail -> 'choices'
      WHEN jsonb_typeof(v_detail -> 'allowed_answers') = 'array' THEN v_detail -> 'allowed_answers'
      ELSE '[]'::jsonb
    END,
    '[]'::jsonb
  );

  INSERT INTO public.cc_decision_email_sends (
    issue_id,
    app_id,
    decision_external_ref,
    recipient_email,
    recipient_name,
    raw_decision_title,
    raw_decision_body,
    options_snapshot,
    risk_class,
    magic_link_token_hash,
    magic_link_expires_at,
    state,
    max_attempts,
    created_via
  )
  VALUES (
    v_issue.id,
    v_issue.app_id,
    v_decision_external_ref,
    'auto-route-pending@blackrockai.co',
    'Auto-route pending',
    COALESCE(NULLIF(left(btrim(COALESCE(v_issue.title, '')), 500), ''), 'Decision'),
    NULLIF(left(btrim(COALESCE(v_issue.summary, '')), 5000), ''),
    v_options,
    v_risk_class,
    'rewrite-placeholder:' || encode(gen_random_bytes(16), 'hex'),
    now() + interval '7 days',
    'rewriting',
    3,
    'auto_route'
  )
  RETURNING * INTO v_send;

  UPDATE public.cc_issues
  SET status = 'triaging'
  WHERE id = v_issue.id
    AND deleted_at IS NULL;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_issue.app_id,
    v_actor,
    'decision_auto_route_enqueued',
    jsonb_build_object('send_id', v_send.id, 'issue_id', v_issue.id)
  );

  RETURN jsonb_build_object('send_id', v_send.id, 'issue_id', v_issue.id, 'app_id', v_issue.app_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_claim_auto_route_finalize(
  p_send_id uuid,
  p_actor text,
  p_lease_seconds int DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_send public.cc_decision_email_sends%ROWTYPE;
  v_recipients jsonb;
  v_claim_token uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;
  IF p_send_id IS NULL THEN RAISE EXCEPTION 'p_send_id is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_decision_email_sends
  SET claim_token = NULL,
      clarification_started_at = NULL,
      lease_expires_at = NULL
  WHERE deleted_at IS NULL
    AND id = p_send_id
    AND created_via = 'auto_route'
    AND route_parent_send_id IS NULL
    AND state = 'rewrite_ready'
    AND claim_token IS NOT NULL
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < now();

  WITH candidate AS (
    SELECT s.id
    FROM public.cc_decision_email_sends s
    JOIN public.registry_apps a ON a.id = s.app_id
    JOIN public.cc_issues i ON i.id = s.issue_id
    WHERE s.id = p_send_id
      AND s.deleted_at IS NULL
      AND s.state = 'rewrite_ready'
      AND s.created_via = 'auto_route'
      AND s.route_parent_send_id IS NULL
      AND s.claim_token IS NULL
      AND i.auto_route_paused_at IS NULL
      AND (i.snoozed_until IS NULL OR i.snoozed_until <= now())
      AND a.deleted_at IS NULL
      AND a.auto_route_decisions = true
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.cc_decision_email_sends s
  SET claim_token = v_claim_token,
      clarification_started_at = now(),
      lease_expires_at = now() + make_interval(secs => GREATEST(30, LEAST(COALESCE(p_lease_seconds, 120), 900)))
  FROM candidate
  WHERE s.id = candidate.id
  RETURNING s.* INTO v_send;

  IF v_send.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_recipients := (
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.contact_email), '[]'::jsonb)
    FROM public.registry_app_decision_recipients r
    WHERE r.app_id = v_send.app_id
      AND r.active = true
      AND r.deleted_at IS NULL
  );

  IF jsonb_array_length(v_recipients) = 0 THEN
    UPDATE public.cc_decision_email_sends
    SET claim_token = NULL,
        clarification_started_at = NULL,
        lease_expires_at = NULL
    WHERE id = v_send.id;
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'claim_token', v_claim_token,
    'send', to_jsonb(v_send),
    'recipients', v_recipients
  );
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
  UPDATE public.cc_decision_email_sends s
  SET claim_token = NULL,
      clarification_started_at = NULL
  FROM public.cc_issues i
  WHERE s.issue_id = i.id
    AND s.deleted_at IS NULL
    AND s.state = 'awaiting_clarify'
    AND s.clarification_attempt_count < 1
    AND s.claim_token IS NOT NULL
    AND s.clarification_started_at IS NOT NULL
    AND s.clarification_started_at < now() - v_lease
    AND i.deleted_at IS NULL
    AND i.auto_route_paused_at IS NULL
    AND (i.snoozed_until IS NULL OR i.snoozed_until <= now());

  UPDATE public.cc_decision_email_sends s
  SET claim_token = v_claim,
      clarification_started_at = now()
  WHERE s.id = (
    SELECT s2.id
    FROM public.cc_decision_email_sends s2
    JOIN public.cc_issues i ON i.id = s2.issue_id
    WHERE s2.deleted_at IS NULL
      AND s2.state = 'awaiting_clarify'
      AND s2.clarification_attempt_count < 1
      AND s2.claim_token IS NULL
      AND i.deleted_at IS NULL
      AND i.auto_route_paused_at IS NULL
      AND (i.snoozed_until IS NULL OR i.snoozed_until <= now())
    ORDER BY s2.updated_at ASC, s2.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_pause_auto_route(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_resume_auto_route(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_snooze_decision(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_unsnooze_decision(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_claim_reminder_task(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_claim_auto_route_candidate(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_claim_auto_route_finalize(uuid, text, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_claim_clarify_task(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cc_pause_auto_route(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_resume_auto_route(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_snooze_decision(uuid, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_unsnooze_decision(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_claim_reminder_task(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_claim_auto_route_candidate(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_claim_auto_route_finalize(uuid, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_claim_clarify_task(integer) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-decision-reminder') THEN
    PERFORM cron.unschedule('cc-decision-reminder');
  END IF;
END $$;

SELECT cron.schedule(
  'cc-decision-reminder',
  '17 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-decision-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cc-read-token', '85dfc1883530807294c1568fa1c0236f15db9f672a54bd5d3bd0e3009febf8db',
      'x-cc-auto-route-toggle', '5d1cbc93cbc107aafdc309c08680086feeeb278a9b59a303ab6d7cdec367daf3'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

COMMIT;
