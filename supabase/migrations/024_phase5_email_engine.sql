-- ============================================================================
-- Migration 024: Phase 5 email decision engine
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Slice 1: outbound Gmail routing, AI rewrite task queue, magic-link confirm,
-- per-app decision recipients, and Gmail inbound cursor storage.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. registry_app_decision_recipients — per-app point-of-contact list.
-- ============================================================================

CREATE TABLE public.registry_app_decision_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE CASCADE,
  contact_name text NOT NULL,
  contact_email text NOT NULL,
  contact_role text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT registry_app_decision_recipients_email_chk
    CHECK (contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

CREATE UNIQUE INDEX registry_app_decision_recipients_email_idx
  ON public.registry_app_decision_recipients (app_id, lower(contact_email))
  WHERE deleted_at IS NULL;

CREATE INDEX registry_app_decision_recipients_active_idx
  ON public.registry_app_decision_recipients (app_id, active)
  WHERE deleted_at IS NULL;

CREATE TRIGGER registry_app_decision_recipients_touch
  BEFORE UPDATE ON public.registry_app_decision_recipients
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.registry_app_decision_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY recipients_service_all
  ON public.registry_app_decision_recipients FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON public.registry_app_decision_recipients FROM anon, authenticated;
GRANT ALL ON public.registry_app_decision_recipients TO service_role;

-- ============================================================================
-- 2. cc_decision_email_sends — one row per outbound recipient send.
-- ============================================================================

CREATE TYPE public.cc_decision_email_state AS ENUM (
  'queued', 'rewriting', 'rewrite_ready', 'sent', 'delivered',
  'opened', 'clicked', 'replied', 'extracting',
  'awaiting_clarify', 'clarify_sent',
  'answered', 'done',
  'reminded', 'bounced', 'expired', 'failed'
);

CREATE TABLE public.cc_decision_email_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  -- Provenance
  decision_answer_id uuid REFERENCES public.cc_decision_answers(id) ON DELETE SET NULL,
  issue_id uuid NOT NULL REFERENCES public.cc_issues(id) ON DELETE RESTRICT,
  app_id uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE RESTRICT,
  decision_external_ref text NOT NULL,
  recipient_id uuid REFERENCES public.registry_app_decision_recipients(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  recipient_name text,

  -- Content snapshots (what was actually sent)
  raw_decision_title text NOT NULL,
  raw_decision_body text,
  rewritten_subject text,
  rewritten_body text,
  rewrite_approved_by text,
  rewrite_approved_at timestamptz,
  options_snapshot jsonb NOT NULL,

  -- Slice 1 support fields.
  risk_class text NOT NULL DEFAULT 'authorize'
    CHECK (risk_class IN ('auto','authorize','destructive','production')),
  magic_link_tokens jsonb NOT NULL DEFAULT '[]'::jsonb,
  rewrite_started_at timestamptz,
  rewrite_runner_id text,

  -- Gmail send metadata
  gmail_message_id text,
  gmail_thread_id text,

  -- Magic-link auth
  magic_link_token_hash text NOT NULL,
  magic_link_expires_at timestamptz NOT NULL,

  -- State machine
  state public.cc_decision_email_state NOT NULL DEFAULT 'queued',
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,
  answered_at timestamptz,
  reminded_at timestamptz,
  expired_at timestamptz,
  bounced_at timestamptz,

  -- Reply + extraction
  raw_reply_text text,
  llm_extraction jsonb,
  extraction_started_at timestamptz,
  extraction_runner_id text,
  clarification_attempt_count integer NOT NULL DEFAULT 0,
  clarification_sent_at timestamptz,

  -- Operator confirm
  operator_confirmed_by text,
  operator_confirmed_at timestamptz,
  selected_option text,

  -- Error / retry
  last_error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),

  CONSTRAINT cc_decision_email_sends_options_array
    CHECK (jsonb_typeof(options_snapshot) = 'array'),
  CONSTRAINT cc_decision_email_sends_tokens_array
    CHECK (jsonb_typeof(magic_link_tokens) = 'array'),
  CONSTRAINT cc_decision_email_sends_clarify_cap
    CHECK (clarification_attempt_count <= 1),
  CONSTRAINT cc_decision_email_sends_answer_consistency
    CHECK (
      state NOT IN ('answered','done')
      OR (decision_answer_id IS NOT NULL AND answered_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX cc_decision_email_sends_token_hash_idx
  ON public.cc_decision_email_sends (magic_link_token_hash)
  WHERE deleted_at IS NULL;
CREATE INDEX cc_decision_email_sends_magic_tokens_gin_idx
  ON public.cc_decision_email_sends USING gin (magic_link_tokens)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX cc_decision_email_sends_gmail_msg_idx
  ON public.cc_decision_email_sends (gmail_message_id)
  WHERE gmail_message_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX cc_decision_email_sends_issue_idx
  ON public.cc_decision_email_sends (issue_id) WHERE deleted_at IS NULL;
CREATE INDEX cc_decision_email_sends_app_state_idx
  ON public.cc_decision_email_sends (app_id, state, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX cc_decision_email_sends_rewrite_claim_idx
  ON public.cc_decision_email_sends (state, rewrite_started_at, created_at)
  WHERE deleted_at IS NULL AND state = 'rewriting';
CREATE INDEX cc_decision_email_sends_pending_reminder_idx
  ON public.cc_decision_email_sends (state, sent_at, reminded_at)
  WHERE deleted_at IS NULL AND state IN ('sent','delivered','opened');
CREATE INDEX cc_decision_email_sends_expiry_idx
  ON public.cc_decision_email_sends (magic_link_expires_at)
  WHERE deleted_at IS NULL AND state NOT IN ('answered','done','expired','bounced');
CREATE INDEX cc_decision_email_sends_thread_idx
  ON public.cc_decision_email_sends (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER cc_decision_email_sends_touch
  BEFORE UPDATE ON public.cc_decision_email_sends
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.cc_decision_email_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_sends_service_all
  ON public.cc_decision_email_sends FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON public.cc_decision_email_sends FROM anon, authenticated;
GRANT ALL ON public.cc_decision_email_sends TO service_role;

-- ============================================================================
-- 3. cc_gmail_history_cursor — tracks last processed Gmail history ID.
-- ============================================================================

CREATE TABLE public.cc_gmail_history_cursor (
  id integer PRIMARY KEY DEFAULT 1,
  history_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cc_gmail_history_cursor_singleton CHECK (id = 1)
);
INSERT INTO public.cc_gmail_history_cursor (id) VALUES (1);

CREATE TRIGGER cc_gmail_history_cursor_touch
  BEFORE UPDATE ON public.cc_gmail_history_cursor
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.cc_gmail_history_cursor ENABLE ROW LEVEL SECURITY;
CREATE POLICY gmail_cursor_service_all
  ON public.cc_gmail_history_cursor FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON public.cc_gmail_history_cursor FROM anon, authenticated;
GRANT ALL ON public.cc_gmail_history_cursor TO service_role;

-- ============================================================================
-- 4. Seed QEP recipients. Addresses are plan placeholders pending operator
-- confirmation of real recipient inboxes.
-- ============================================================================

INSERT INTO public.registry_app_decision_recipients (app_id, contact_name, contact_email, contact_role)
SELECT app.id, seed.contact_name, seed.contact_email, seed.contact_role
FROM public.registry_apps app
CROSS JOIN (VALUES
  ('Rylee', 'rylee@qep.com', 'primary'),
  ('Ryan McKenzie', 'ryan@qep.com', 'primary')
) AS seed(contact_name, contact_email, contact_role)
WHERE app.short_code = 'QEP'
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 5. Recipient CRUD RPCs.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cc_add_decision_recipient(
  p_app_id uuid,
  p_contact_name text,
  p_contact_email text,
  p_contact_role text DEFAULT NULL,
  p_actor text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_name text := NULLIF(left(btrim(COALESCE(p_contact_name, '')), 160), '');
  v_email text := lower(NULLIF(left(btrim(COALESCE(p_contact_email, '')), 320), ''));
  v_role text := NULLIF(left(btrim(COALESCE(p_contact_role, '')), 80), '');
  v_row public.registry_app_decision_recipients%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'actor is required' USING ERRCODE = 'P0001'; END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'contact_name is required' USING ERRCODE = 'P0001'; END IF;
  IF v_email IS NULL OR v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'contact_email must be a valid email' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.registry_apps WHERE id = p_app_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'app not found' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.registry_app_decision_recipients (app_id, contact_name, contact_email, contact_role)
  VALUES (p_app_id, v_name, v_email, v_role)
  RETURNING * INTO v_row;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (p_app_id, v_actor, 'app_updated', jsonb_build_object('action','add_decision_recipient','recipient_id',v_row.id,'owner_name',v_row.contact_name,'owner_email',v_row.contact_email));

  RETURN to_jsonb(v_row);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_edit_decision_recipient(
  p_recipient_id uuid,
  p_contact_name text DEFAULT NULL,
  p_contact_email text DEFAULT NULL,
  p_contact_role text DEFAULT NULL,
  p_active boolean DEFAULT NULL,
  p_actor text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_existing public.registry_app_decision_recipients%ROWTYPE;
  v_row public.registry_app_decision_recipients%ROWTYPE;
  v_name text;
  v_email text;
  v_role text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'actor is required' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_existing FROM public.registry_app_decision_recipients WHERE id = p_recipient_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recipient not found' USING ERRCODE = 'P0001'; END IF;

  v_name := COALESCE(NULLIF(left(btrim(COALESCE(p_contact_name, '')), 160), ''), v_existing.contact_name);
  v_email := COALESCE(lower(NULLIF(left(btrim(COALESCE(p_contact_email, '')), 320), '')), v_existing.contact_email);
  v_role := CASE WHEN p_contact_role IS NULL THEN v_existing.contact_role ELSE NULLIF(left(btrim(COALESCE(p_contact_role, '')), 80), '') END;
  IF v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'contact_email must be a valid email' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.registry_app_decision_recipients
  SET contact_name = v_name,
      contact_email = v_email,
      contact_role = v_role,
      active = COALESCE(p_active, active)
  WHERE id = p_recipient_id
  RETURNING * INTO v_row;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, v_actor, 'app_updated', jsonb_build_object('action','edit_decision_recipient','recipient_id',v_row.id,'owner_name',v_row.contact_name,'owner_email',v_row.contact_email,'active',v_row.active));

  RETURN to_jsonb(v_row);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_delete_decision_recipient(
  p_recipient_id uuid,
  p_actor text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_row public.registry_app_decision_recipients%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'actor is required' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.registry_app_decision_recipients
  SET deleted_at = now(), active = false
  WHERE id = p_recipient_id AND deleted_at IS NULL
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'recipient not found' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, v_actor, 'app_updated', jsonb_build_object('action','delete_decision_recipient','recipient_id',v_row.id,'owner_name',v_row.contact_name,'owner_email',v_row.contact_email));

  RETURN to_jsonb(v_row);
END;
$fn$;

-- ============================================================================
-- 6. Rewrite runner RPCs.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cc_claim_rewrite_task(
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
BEGIN
  IF v_runner IS NULL THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_decision_email_sends s
  SET rewrite_started_at = now(),
      rewrite_runner_id = v_runner,
      attempt_count = s.attempt_count + 1,
      last_error = NULL
  WHERE s.id = (
    SELECT id
    FROM public.cc_decision_email_sends
    WHERE deleted_at IS NULL
      AND state = 'rewriting'
      AND attempt_count < max_attempts
      AND (rewrite_started_at IS NULL OR rewrite_started_at < now() - v_lease)
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_finish_rewrite_task(
  p_send_id uuid,
  p_runner text,
  p_rewritten_subject text,
  p_rewritten_body text,
  p_options_snapshot jsonb
)
RETURNS public.cc_decision_email_sends
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row public.cc_decision_email_sends;
  v_runner text := NULLIF(left(btrim(COALESCE(p_runner, '')), 200), '');
  v_subject text := NULLIF(left(btrim(COALESCE(p_rewritten_subject, '')), 300), '');
  v_body text := NULLIF(left(btrim(COALESCE(p_rewritten_body, '')), 8000), '');
BEGIN
  IF v_runner IS NULL THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'P0001'; END IF;
  IF v_subject IS NULL THEN RAISE EXCEPTION 'rewritten_subject is required' USING ERRCODE = 'P0001'; END IF;
  IF v_body IS NULL THEN RAISE EXCEPTION 'rewritten_body is required' USING ERRCODE = 'P0001'; END IF;
  IF p_options_snapshot IS NULL OR jsonb_typeof(p_options_snapshot) <> 'array' THEN
    RAISE EXCEPTION 'options_snapshot must be an array' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.cc_decision_email_sends
  SET rewritten_subject = v_subject,
      rewritten_body = v_body,
      options_snapshot = p_options_snapshot,
      state = 'rewrite_ready',
      rewrite_started_at = NULL,
      last_error = NULL
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND state = 'rewriting'
    AND rewrite_runner_id = v_runner
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RAISE EXCEPTION 'rewrite task not claimable by runner' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, v_runner, 'decision_rewrite_ready', jsonb_build_object('send_id', v_row.id, 'issue_id', v_row.issue_id, 'decision_external_ref', v_row.decision_external_ref));

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_fail_rewrite_task(
  p_send_id uuid,
  p_runner text,
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
  v_error text := left(COALESCE(p_error, 'rewrite failed'), 2000);
BEGIN
  IF v_runner IS NULL THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'P0001'; END IF;

  UPDATE public.cc_decision_email_sends
  SET state = CASE WHEN attempt_count >= max_attempts THEN 'failed'::public.cc_decision_email_state ELSE 'rewriting'::public.cc_decision_email_state END,
      rewrite_started_at = NULL,
      last_error = v_error
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND state = 'rewriting'
    AND rewrite_runner_id = v_runner
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RAISE EXCEPTION 'rewrite task not claimable by runner' USING ERRCODE = 'P0001'; END IF;

  IF v_row.state = 'failed' THEN
    INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
    VALUES (v_row.app_id, v_runner, 'decision_rewrite_failed', jsonb_build_object('send_id', v_row.id, 'issue_id', v_row.issue_id, 'error', v_error));
  END IF;

  RETURN v_row;
END;
$fn$;

-- ============================================================================
-- 7. Magic-link confirm read/commit RPCs.
-- ============================================================================

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
    AND s.state IN ('sent','delivered','opened','clicked')
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
    AND s.state IN ('sent','delivered','opened','clicked')
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
      clicked_at = COALESCE(clicked_at, now())
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

-- cc_resolve_issue must permit answer_decision after Slice 1 has routed an
-- issue to a client. This preserves the Phase 4 function body except the
-- allowed answer statuses now include routed_to_client.
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

  IF v_actor IS NULL THEN RAISE EXCEPTION 'actor is required' USING ERRCODE = 'P0001'; END IF;
  IF v_risk_class IS NOT NULL AND v_risk_class NOT IN ('auto', 'authorize', 'destructive', 'production') THEN
    RAISE EXCEPTION 'invalid risk class' USING ERRCODE = 'P0001', DETAIL = 'risk_class must be one of auto, authorize, destructive, production';
  END IF;

  SELECT * INTO v_issue FROM public.cc_issues WHERE id = issue_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'issue not found' USING ERRCODE = 'P0001'; END IF;
  IF v_issue.status IN ('done', 'dismissed', 'answered') THEN
    RAISE EXCEPTION 'issue is already closed' USING ERRCODE = 'P0001', DETAIL = v_issue.status::text;
  END IF;

  IF v_action = 'answer_decision' THEN
    IF v_issue.status NOT IN ('surfaced', 'triaging', 'routed_to_client') THEN
      RAISE EXCEPTION 'issue status % cannot be answered', v_issue.status USING ERRCODE = 'P0001';
    END IF;
    IF v_answer_value IS NULL THEN RAISE EXCEPTION 'answer_value is required for answer_decision' USING ERRCODE = 'P0001'; END IF;
    IF v_risk_class IS NULL THEN RAISE EXCEPTION 'invalid risk class' USING ERRCODE = 'P0001', DETAIL = 'risk_class must be one of auto, authorize, destructive, production'; END IF;
    IF answer_options_snapshot IS NULL OR jsonb_typeof(answer_options_snapshot) <> 'array' THEN
      RAISE EXCEPTION 'answer_options_snapshot must contain at least one enumerated option' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(answer_options_snapshot) AS opt(value)
      WHERE CASE jsonb_typeof(opt.value)
        WHEN 'string' THEN NULLIF(btrim(opt.value #>> '{}'), '')
        WHEN 'object' THEN COALESCE(NULLIF(btrim(opt.value ->> 'id'), ''), NULLIF(btrim(opt.value ->> 'value'), ''), NULLIF(btrim(opt.value ->> 'key'), ''))
        ELSE NULL
      END IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'answer_options_snapshot must contain at least one enumerated option' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(answer_options_snapshot) AS opt(value)
      WHERE v_answer_value = CASE jsonb_typeof(opt.value)
        WHEN 'string' THEN NULLIF(btrim(opt.value #>> '{}'), '')
        WHEN 'object' THEN COALESCE(NULLIF(btrim(opt.value ->> 'id'), ''), NULLIF(btrim(opt.value ->> 'value'), ''), NULLIF(btrim(opt.value ->> 'key'), ''))
        ELSE NULL
      END
    ) THEN
      RAISE EXCEPTION 'answer_value must match an enumerated option id' USING ERRCODE = 'P0001';
    END IF;
    IF v_decision_external_ref IS NULL AND v_issue.source_ref <> '' AND v_issue.source_ref NOT IN ('aggregate', 'build', 'sync', 'blocked') THEN
      v_decision_external_ref := v_issue.source_ref;
    END IF;

    INSERT INTO public.cc_decision_answers (issue_id, app_id, decision_external_ref, answer_value, answer_options_snapshot, rationale, risk_class, answered_by)
    VALUES (v_issue.id, v_issue.app_id, v_decision_external_ref, v_answer_value, answer_options_snapshot, v_rationale, v_risk_class, v_actor)
    RETURNING id INTO v_answer_id;

    UPDATE public.cc_issues SET status = 'answered' WHERE id = v_issue.id RETURNING * INTO v_updated_issue;
    v_event_type := 'issue_resolved';
  ELSIF v_action = 'acknowledge' THEN
    IF v_issue.status NOT IN ('surfaced', 'triaging', 'gated') THEN RAISE EXCEPTION 'issue status % cannot be acknowledged', v_issue.status USING ERRCODE = 'P0001'; END IF;
    UPDATE public.cc_issues SET status = CASE WHEN v_issue.status = 'surfaced' THEN 'triaging'::public.cc_issue_status ELSE v_issue.status END WHERE id = v_issue.id RETURNING * INTO v_updated_issue;
    v_event_type := 'issue_acknowledged';
  ELSIF v_action = 'dismiss' THEN
    IF v_issue.status NOT IN ('surfaced', 'triaging', 'gated') THEN RAISE EXCEPTION 'issue status % cannot be dismissed', v_issue.status USING ERRCODE = 'P0001'; END IF;
    UPDATE public.cc_issues SET status = 'dismissed', resolved_at = now() WHERE id = v_issue.id RETURNING * INTO v_updated_issue;
    v_event_type := 'issue_dismissed';
  ELSIF v_action = 'link_to_decision' THEN
    IF v_issue.status NOT IN ('surfaced', 'triaging', 'gated') THEN RAISE EXCEPTION 'issue status % cannot be linked to a decision', v_issue.status USING ERRCODE = 'P0001'; END IF;
    IF v_linked_decision_ref IS NULL THEN RAISE EXCEPTION 'linked_decision_ref is required for link_to_decision' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.cc_issues
    SET status = 'triaging',
        context = COALESCE(context, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('linked_decision_ref', v_linked_decision_ref, 'linked_to_decision_at', now(), 'linked_to_decision_by', v_actor, 'rationale', v_rationale))
    WHERE id = v_issue.id RETURNING * INTO v_updated_issue;
    v_event_type := 'issue_acknowledged';
  END IF;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_issue.app_id, v_actor, v_event_type, jsonb_build_object('issue_id', v_issue.id, 'issue_type', v_issue.issue_type, 'source_ref', v_issue.source_ref, 'action', v_action, 'decision_answer_id', v_answer_id));

  RETURN jsonb_build_object('id', v_updated_issue.id, 'app_id', v_updated_issue.app_id, 'issue_type', v_updated_issue.issue_type, 'source_ref', v_updated_issue.source_ref, 'status', v_updated_issue.status, 'severity', v_updated_issue.severity, 'title', v_updated_issue.title, 'summary', v_updated_issue.summary, 'surfaced_at', v_updated_issue.surfaced_at, 'last_seen_at', v_updated_issue.last_seen_at, 'updated_at', v_updated_issue.updated_at, 'context', v_updated_issue.context, 'decision_answer_id', v_answer_id);
END;
$fn$;

-- ============================================================================
-- 8. Grants.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.cc_add_decision_recipient(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_edit_decision_recipient(uuid, text, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_delete_decision_recipient(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_claim_rewrite_task(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_finish_rewrite_task(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_fail_rewrite_task(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_get_decision_confirm_data(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_confirm_decision_token(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_resolve_issue(uuid, text, text, jsonb, text, text, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cc_add_decision_recipient(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_edit_decision_recipient(uuid, text, text, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_delete_decision_recipient(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_claim_rewrite_task(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_finish_rewrite_task(uuid, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_fail_rewrite_task(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_get_decision_confirm_data(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_confirm_decision_token(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cc_resolve_issue(uuid, text, text, jsonb, text, text, text, text, text) TO service_role;

COMMIT;
