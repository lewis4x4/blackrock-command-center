-- ============================================================================
-- Migration 027: Phase 5 Slice 2.5 autonomous decision routing
-- ============================================================================

BEGIN;

ALTER TABLE public.registry_apps
  ADD COLUMN IF NOT EXISTS auto_route_decisions boolean NOT NULL DEFAULT false;

UPDATE public.registry_apps
SET auto_route_decisions = true
WHERE short_code = 'QEP';

ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS created_via text NOT NULL DEFAULT 'manual'
  CHECK (created_via IN ('manual', 'auto_route'));

ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS route_parent_send_id uuid REFERENCES public.cc_decision_email_sends(id);

-- Lease for cc_claim_auto_route_finalize claims. Distinct from rewrite/
-- extraction leases (those are tracked via rewrite_started_at /
-- extraction_started_at + the existing claim_token). Auto-route finalize
-- needs its own short lease window so a crashed cron releases its hold
-- and the next cron can retry.
ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS cc_decision_email_sends_auto_route_ready_idx
  ON public.cc_decision_email_sends (state)
  WHERE deleted_at IS NULL AND created_via = 'auto_route' AND state = 'rewrite_ready' AND route_parent_send_id IS NULL;

-- Only constrain AUTO-ROUTE rows to one active parent per issue. Manual
-- operator routing intentionally allows multiple sends per issue (e.g.
-- routing the same decision to different recipient subsets across time).
-- This index prevents the auto-route cron from creating duplicate sends.
CREATE UNIQUE INDEX IF NOT EXISTS cc_decision_email_sends_one_active_auto_route_parent_per_issue_idx
  ON public.cc_decision_email_sends (issue_id)
  WHERE deleted_at IS NULL
    AND created_via = 'auto_route'
    AND route_parent_send_id IS NULL
    AND state NOT IN ('failed', 'expired', 'bounced');

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

CREATE OR REPLACE FUNCTION public.cc_finalize_auto_route(
  p_send_id uuid,
  p_actor text
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
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;

  SELECT s.* INTO v_send
  FROM public.cc_decision_email_sends s
  JOIN public.registry_apps a ON a.id = s.app_id
  WHERE s.id = p_send_id
    AND s.deleted_at IS NULL
    AND s.state = 'rewrite_ready'
    AND s.created_via = 'auto_route'
    AND s.route_parent_send_id IS NULL
    AND a.deleted_at IS NULL
    AND a.auto_route_decisions = true
  FOR UPDATE;

  IF v_send.id IS NULL THEN
    RAISE EXCEPTION 'auto-route send not in rewrite_ready state' USING ERRCODE = 'P0001';
  END IF;

  v_recipients := (
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.contact_email), '[]'::jsonb)
    FROM public.registry_app_decision_recipients r
    WHERE r.app_id = v_send.app_id
      AND r.active = true
      AND r.deleted_at IS NULL
  );

  IF jsonb_array_length(v_recipients) = 0 THEN
    RAISE EXCEPTION 'no active recipients for app' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('send', to_jsonb(v_send), 'recipients', v_recipients);
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

  WITH candidate AS (
    SELECT s.id
    FROM public.cc_decision_email_sends s
    JOIN public.registry_apps a ON a.id = s.app_id
    WHERE s.id = p_send_id
      AND s.deleted_at IS NULL
      AND s.state = 'rewrite_ready'
      AND s.created_via = 'auto_route'
      AND s.route_parent_send_id IS NULL
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

CREATE OR REPLACE FUNCTION public.cc_set_auto_route(
  p_app_id uuid,
  p_enabled boolean,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_app public.registry_apps%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor is required' USING ERRCODE = 'P0001'; END IF;
  IF p_app_id IS NULL THEN RAISE EXCEPTION 'p_app_id is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.registry_apps
  SET auto_route_decisions = COALESCE(p_enabled, false)
  WHERE id = p_app_id
    AND deleted_at IS NULL
  RETURNING * INTO v_app;

  IF v_app.id IS NULL THEN RAISE EXCEPTION 'app not found' USING ERRCODE = 'P0001'; END IF;

  IF v_app.auto_route_decisions = false THEN
    UPDATE public.cc_decision_email_sends
    SET state = 'expired',
        last_error = 'auto-route disabled by operator before send'
    WHERE app_id = p_app_id
      AND created_via = 'auto_route'
      AND state IN ('rewriting', 'rewrite_ready')
      AND deleted_at IS NULL;

    INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
    VALUES (
      v_app.id,
      v_actor,
      'decision_auto_route_aborted_by_operator',
      jsonb_build_object('app_id', v_app.id)
    );
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_app.id, v_actor, 'app_updated', jsonb_build_object('action', 'set_auto_route', 'auto_route_decisions', v_app.auto_route_decisions));

  RETURN to_jsonb(v_app);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_claim_auto_route_candidate(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_finalize_auto_route(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_claim_auto_route_finalize(uuid, text, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_set_auto_route(uuid, boolean, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cc_claim_auto_route_candidate(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_finalize_auto_route(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_claim_auto_route_finalize(uuid, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_set_auto_route(uuid, boolean, text) TO service_role;

COMMIT;
