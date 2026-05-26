-- ============================================================================
-- Migration 047: late reply path
-- Target: control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Adds a distinct issue type for replies that arrive after a decision is
-- already answered/done, so operators see them in a separate lane instead of
-- re-opening closed decisions implicitly.
-- ============================================================================

BEGIN;

ALTER TYPE public.cc_issue_type
  ADD VALUE IF NOT EXISTS 'late_reply';

COMMIT;

BEGIN;

CREATE INDEX IF NOT EXISTS cc_issues_late_reply_open_idx
  ON public.cc_issues (app_id, last_seen_at DESC)
  WHERE issue_type = 'late_reply'::public.cc_issue_type
    AND resolved_at IS NULL
    AND deleted_at IS NULL;

COMMIT;

-- ============================================================================
-- Down migration (commented; enum values cannot be removed safely in-place)
-- ============================================================================
-- BEGIN;
--   DROP INDEX IF EXISTS public.cc_issues_late_reply_open_idx;
--   -- Removing public.cc_issue_type value 'late_reply' requires rebuilding the enum
--   -- after all late_reply rows are remediated or deleted.
-- COMMIT;
