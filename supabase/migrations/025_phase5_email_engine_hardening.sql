-- ============================================================================
-- Migration 025: Phase 5 email decision engine hardening
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Follow-up to 024 after review: enforce issue/app consistency and prevent
-- stale final rewrite claims from lingering forever.
-- ============================================================================

BEGIN;

-- Keep send rows bound to the same app as their source issue. The existing
-- issue id primary key is globally unique; this composite key lets Postgres
-- enforce the invariant directly for new and updated Phase 5 sends.
ALTER TABLE public.cc_issues
  ADD CONSTRAINT cc_issues_id_app_id_key UNIQUE (id, app_id);

ALTER TABLE public.cc_decision_email_sends
  ADD CONSTRAINT cc_decision_email_sends_issue_app_fk
  FOREIGN KEY (issue_id, app_id)
  REFERENCES public.cc_issues(id, app_id)
  ON DELETE RESTRICT;

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

  UPDATE public.cc_decision_email_sends
  SET state = 'failed',
      rewrite_started_at = NULL,
      last_error = COALESCE(last_error, 'rewrite task exhausted attempts and lease expired')
  WHERE deleted_at IS NULL
    AND state = 'rewriting'
    AND attempt_count >= max_attempts
    AND rewrite_started_at IS NOT NULL
    AND rewrite_started_at < now() - v_lease;

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

REVOKE EXECUTE ON FUNCTION public.cc_claim_rewrite_task(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cc_claim_rewrite_task(text, integer) TO service_role;

COMMIT;
