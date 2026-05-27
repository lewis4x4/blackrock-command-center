-- ============================================================================
-- Migration 054: tighten shadow suppression RPC parity
-- Target: control-plane Supabase project
--
-- 053 introduced the shadow-mode RPC. This patch keeps the DB-backed issue-ref
-- extraction aligned with the live cc-read-decisions issueDecisionRef() helper
-- so drift events reflect real contract differences, not a broader source_ref
-- fallback that the live edge path does not currently use.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.cc_decision_open_set(p_app_ids uuid[])
RETURNS TABLE (
  app_id uuid,
  decision_external_ref text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
  WITH app_filter AS (
    SELECT DISTINCT unnest(COALESCE(p_app_ids, ARRAY[]::uuid[])) AS app_id
  ), suppressed AS (
    SELECT a.app_id, NULLIF(btrim(a.decision_external_ref), '') AS decision_external_ref
    FROM public.cc_decision_answers a
    JOIN app_filter f ON f.app_id = a.app_id
    WHERE a.deleted_at IS NULL

    UNION

    SELECT s.app_id, NULLIF(btrim(s.decision_external_ref), '') AS decision_external_ref
    FROM public.cc_decision_email_sends s
    JOIN app_filter f ON f.app_id = s.app_id
    WHERE s.deleted_at IS NULL
      AND (
        s.decision_answer_id IS NOT NULL
        OR s.state IN (
          'sent',
          'delivered',
          'opened',
          'clicked',
          'replied',
          'extracting',
          'awaiting_clarify',
          'clarify_sent',
          'awaiting_operator_review',
          'answered',
          'done',
          'reminded'
        )
      )

    UNION

    SELECT i.app_id,
           NULLIF(btrim(COALESCE(
             i.detail ->> 'decision_external_ref',
             i.detail ->> 'external_ref',
             i.detail ->> 'decision_id'
           )), '') AS decision_external_ref
    FROM public.cc_issues i
    JOIN app_filter f ON f.app_id = i.app_id
    WHERE i.deleted_at IS NULL
      AND i.issue_type = 'open_decision'
      AND (
        i.status NOT IN ('surfaced', 'triaging', 'gated')
        OR (i.snoozed_until IS NOT NULL AND i.snoozed_until > now())
      )
  )
  SELECT DISTINCT s.app_id, s.decision_external_ref
  FROM suppressed s
  WHERE s.app_id IS NOT NULL
    AND s.decision_external_ref IS NOT NULL;
$fn$;

COMMENT ON FUNCTION public.cc_decision_open_set(uuid[]) IS
  'Shadow-mode open-lane suppression contract. Returns app-local decision refs that should be hidden from the open Decisions lane.';

REVOKE ALL ON FUNCTION public.cc_decision_open_set(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cc_decision_open_set(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.cc_decision_open_set(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cc_decision_open_set(uuid[]) TO service_role;

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DROP FUNCTION IF EXISTS public.cc_decision_open_set(uuid[]);
-- COMMIT;
