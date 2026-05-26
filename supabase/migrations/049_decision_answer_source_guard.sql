-- ============================================================================
-- Migration 046: decision answer source guard
-- Target: control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Adds explicit provenance to cc_decision_answers and blocks smoke-test writes
-- from landing on decisions already routed to real recipients.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cc_decision_answer_source') THEN
    CREATE TYPE public.cc_decision_answer_source AS ENUM (
      'operator',
      'client_reply',
      'auto_extraction',
      'smoke_test',
      'system',
      'manual_remediation'
    );
  END IF;
END $$;

ALTER TABLE public.cc_decision_answers
  ADD COLUMN IF NOT EXISTS source public.cc_decision_answer_source;

ALTER TABLE public.cc_decision_answers
  ALTER COLUMN source SET DEFAULT 'operator';

UPDATE public.cc_decision_answers
SET source = CASE
    WHEN COALESCE(answered_by, '') ~* '^(smoke|test)'
      OR COALESCE(answer_value, '') ~* 'smoke[_ -]?test'
      OR COALESCE(rationale, '') ~* 'smoke[_ -]?test'
      THEN 'smoke_test'::public.cc_decision_answer_source
    WHEN COALESCE(answered_by, '') ~* '^client-magic-link'
      THEN 'client_reply'::public.cc_decision_answer_source
    WHEN COALESCE(answered_by, '') ~* '^claude-extraction'
      THEN 'auto_extraction'::public.cc_decision_answer_source
    WHEN COALESCE(answered_by, '') ~* '^manual-remediation'
      THEN 'manual_remediation'::public.cc_decision_answer_source
    WHEN COALESCE(answered_by, '') ~* '^system'
      THEN 'system'::public.cc_decision_answer_source
    ELSE 'operator'::public.cc_decision_answer_source
  END
WHERE source IS NULL;

ALTER TABLE public.cc_decision_answers
  ALTER COLUMN source SET NOT NULL;

ALTER TABLE public.cc_decision_answers
  ALTER COLUMN source DROP DEFAULT;

COMMENT ON COLUMN public.cc_decision_answers.source IS
  'Required provenance for answer rows. No table default: every writer must choose an explicit source.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'cc_decision_answers_source_known_chk'
      AND conrelid = 'public.cc_decision_answers'::regclass
  ) THEN
    ALTER TABLE public.cc_decision_answers
      ADD CONSTRAINT cc_decision_answers_source_known_chk
      CHECK (source IN ('operator', 'client_reply', 'auto_extraction', 'smoke_test', 'system', 'manual_remediation'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS cc_decision_answers_source_idx
  ON public.cc_decision_answers (source, answered_at DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.fn_cc_decision_answer_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.source = 'smoke_test'::public.cc_decision_answer_source
     AND EXISTS (
      SELECT 1
      FROM public.cc_issues i
      WHERE i.id = NEW.issue_id
        AND i.deleted_at IS NULL
        AND i.status IN ('routed_to_client', 'answered', 'done')
        AND EXISTS (
          SELECT 1
          FROM public.cc_decision_email_sends s
          WHERE s.deleted_at IS NULL
            AND s.issue_id = NEW.issue_id
            AND s.state IN ('sent', 'delivered', 'opened', 'clicked')
            AND (
              NEW.decision_external_ref IS NULL
              OR s.decision_external_ref = NEW.decision_external_ref
            )
        )
     ) THEN
    RAISE EXCEPTION 'smoke_test_blocked_on_routed_decision'
      USING ERRCODE = 'P0001',
            DETAIL = 'source=smoke_test answers cannot be inserted on decisions routed to real recipients';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS cc_decision_answers_source_guard ON public.cc_decision_answers;
CREATE TRIGGER cc_decision_answers_source_guard
  BEFORE INSERT ON public.cc_decision_answers
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_decision_answer_source_guard();

REVOKE ALL ON FUNCTION public.fn_cc_decision_answer_source_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cc_decision_answer_source_guard() TO service_role;

-- Recreate the issue-resolution RPC so all answer rows are inserted with an
-- explicit source now that cc_decision_answers.source has no default.
DROP FUNCTION IF EXISTS public.cc_resolve_issue(uuid, text, text, jsonb, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.cc_resolve_issue(
  issue_id uuid,
  action text,
  answer_value text DEFAULT NULL,
  answer_options_snapshot jsonb DEFAULT NULL,
  rationale text DEFAULT NULL,
  risk_class text DEFAULT NULL,
  linked_decision_ref text DEFAULT NULL,
  actor text DEFAULT NULL,
  decision_external_ref text DEFAULT NULL,
  answer_source public.cc_decision_answer_source DEFAULT NULL
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
  v_answer_source public.cc_decision_answer_source := answer_source;
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

    IF v_answer_source IS NULL THEN
      v_answer_source := CASE
        WHEN v_actor ~* '^client-magic-link' THEN 'client_reply'::public.cc_decision_answer_source
        WHEN v_actor ~* '^claude-extraction' THEN 'auto_extraction'::public.cc_decision_answer_source
        WHEN v_actor ~* '^(smoke|test)' THEN 'smoke_test'::public.cc_decision_answer_source
        WHEN v_actor ~* '^manual-remediation' THEN 'manual_remediation'::public.cc_decision_answer_source
        WHEN v_actor ~* '^system' THEN 'system'::public.cc_decision_answer_source
        ELSE 'operator'::public.cc_decision_answer_source
      END;
    END IF;

    INSERT INTO public.cc_decision_answers (issue_id, app_id, decision_external_ref, answer_value, answer_options_snapshot, rationale, risk_class, answered_by, source)
    VALUES (v_issue.id, v_issue.app_id, v_decision_external_ref, v_answer_value, answer_options_snapshot, v_rationale, v_risk_class, v_actor, v_answer_source)
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
  VALUES (v_issue.app_id, v_actor, v_event_type, jsonb_build_object('issue_id', v_issue.id, 'issue_type', v_issue.issue_type, 'source_ref', v_issue.source_ref, 'action', v_action, 'decision_answer_id', v_answer_id, 'answer_source', v_answer_source));

  RETURN jsonb_build_object('id', v_updated_issue.id, 'app_id', v_updated_issue.app_id, 'issue_type', v_updated_issue.issue_type, 'source_ref', v_updated_issue.source_ref, 'status', v_updated_issue.status, 'severity', v_updated_issue.severity, 'title', v_updated_issue.title, 'summary', v_updated_issue.summary, 'surfaced_at', v_updated_issue.surfaced_at, 'last_seen_at', v_updated_issue.last_seen_at, 'updated_at', v_updated_issue.updated_at, 'context', v_updated_issue.context, 'decision_answer_id', v_answer_id, 'answer_source', v_answer_source);
END;
$fn$;

COMMENT ON FUNCTION public.cc_resolve_issue(uuid, text, text, jsonb, text, text, text, text, text, public.cc_decision_answer_source) IS
  'Atomically resolves/triages one cc_issues row, optionally records an enumerated decision answer with explicit provenance, appends the audit event, and returns decision_answer_id.';

REVOKE EXECUTE ON FUNCTION public.cc_resolve_issue(uuid, text, text, jsonb, text, text, text, text, text, public.cc_decision_answer_source) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cc_resolve_issue(uuid, text, text, jsonb, text, text, text, text, text, public.cc_decision_answer_source) TO service_role;

REVOKE ALL ON public.cc_decision_answers FROM anon;
REVOKE ALL ON public.cc_decision_answers FROM authenticated;
GRANT ALL ON public.cc_decision_answers TO service_role;

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DROP TRIGGER IF EXISTS cc_decision_answers_source_guard ON public.cc_decision_answers;
--   DROP FUNCTION IF EXISTS public.fn_cc_decision_answer_source_guard();
--   DROP INDEX IF EXISTS public.cc_decision_answers_source_idx;
--   ALTER TABLE public.cc_decision_answers DROP COLUMN IF EXISTS source;
--   DROP TYPE IF EXISTS public.cc_decision_answer_source;
--   -- Re-apply the previous cc_resolve_issue definition from migration 024/026 if rolling back.
-- COMMIT;
