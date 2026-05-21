-- ============================================================================
-- Migration 011: cc_artifacts hardening check for repo_scan path integrity
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Ensures repo_scan rows always carry a non-empty path so indexer/source
-- invariants hold even under manual writes.
-- ============================================================================

BEGIN;

ALTER TABLE public.cc_artifacts
  ADD CONSTRAINT cc_artifacts_repo_scan_needs_path
  CHECK (source <> 'repo_scan' OR (path IS NOT NULL AND btrim(path) <> ''));

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public.cc_artifacts
--     DROP CONSTRAINT cc_artifacts_repo_scan_needs_path;
-- COMMIT;
