-- ============================================================================
-- Migration 046: Smoke-test remediation (requested Phase 2 mig 045 payload)
-- Target: control plane (gsvhuzpysxaegoecwjmf)
--
-- One-time/idempotent correction for the 2026-05-21 smoke-test answer that
-- created QEP PR #65. Version 045 is already occupied by agent-core grants in
-- this repository and the linked database, so this remediation uses the next
-- safe Supabase migration version while preserving the requested audit label.
-- ============================================================================

BEGIN;

-- A. Soft-delete the literal smoke-test answer.
UPDATE public.cc_decision_answers
SET deleted_at = now(),
    updated_at = now()
WHERE id = 'ae8ceddb-d022-4eea-b2e0-11976199bde5'
  AND answer_value = 'smoke_test_selected'
  AND deleted_at IS NULL;

-- B. Quarantine the work order spawned from the smoke-test answer / PR #65.
UPDATE public.agent_work_orders
SET deleted_at = now(),
    updated_at = now(),
    last_error = COALESCE(last_error, 'Quarantined: smoke_test_selected answer (Phase 2 mig 045)')
WHERE id = '165c1295-d29b-4b75-8bac-e61800830d4c'
  AND source_answer_id = 'ae8ceddb-d022-4eea-b2e0-11976199bde5'
  AND deleted_at IS NULL;

-- C. Guarded aggregate reopen. The audit found legitimate non-smoke answers on
--    this aggregate, so this should no-op today; keep it as a defensive repair.
UPDATE public.cc_issues i
SET status = 'surfaced',
    resolved_at = NULL,
    updated_at = now()
WHERE i.id = '9f808690-db4f-4168-a0f9-7639921412a8'
  AND i.status IN ('answered', 'done')
  AND NOT EXISTS (
    SELECT 1
    FROM public.cc_decision_answers a
    WHERE a.issue_id = i.id
      AND a.deleted_at IS NULL
      AND a.answer_value <> 'smoke_test_selected'
  );

-- D. Record an audit event once. Re-runs must not duplicate the remediation row.
INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
SELECT id,
       'mig:045_smoke_test_remediation',
       'smoke_test_remediation_applied',
       jsonb_build_object(
         'quarantined_answer_id', 'ae8ceddb-d022-4eea-b2e0-11976199bde5',
         'quarantined_work_order_id', '165c1295-d29b-4b75-8bac-e61800830d4c',
         'related_pr_url', 'https://github.com/lewis4x4/qep/pull/65',
         'migration', '045_smoke_test_remediation')
FROM public.registry_apps
WHERE short_code = 'QEP'
  AND NOT EXISTS (
    SELECT 1
    FROM public.cc_audit_events e
    WHERE e.actor = 'mig:045_smoke_test_remediation'
      AND e.event_type = 'smoke_test_remediation_applied'
      AND e.detail->>'quarantined_answer_id' = 'ae8ceddb-d022-4eea-b2e0-11976199bde5'
      AND e.detail->>'quarantined_work_order_id' = '165c1295-d29b-4b75-8bac-e61800830d4c'
  )
LIMIT 1;

COMMIT;

-- Down migration (intentionally commented; preserve auditability of production
-- remediation and only run manually if Brian explicitly asks to reverse it):
--
-- BEGIN;
--
-- UPDATE public.cc_decision_answers
-- SET deleted_at = NULL,
--     updated_at = now()
-- WHERE id = 'ae8ceddb-d022-4eea-b2e0-11976199bde5'
--   AND answer_value = 'smoke_test_selected';
--
-- UPDATE public.agent_work_orders
-- SET deleted_at = NULL,
--     updated_at = now(),
--     last_error = NULL
-- WHERE id = '165c1295-d29b-4b75-8bac-e61800830d4c'
--   AND source_answer_id = 'ae8ceddb-d022-4eea-b2e0-11976199bde5';
--
-- DELETE FROM public.cc_audit_events
-- WHERE actor = 'mig:045_smoke_test_remediation'
--   AND event_type = 'smoke_test_remediation_applied'
--   AND detail->>'quarantined_answer_id' = 'ae8ceddb-d022-4eea-b2e0-11976199bde5'
--   AND detail->>'quarantined_work_order_id' = '165c1295-d29b-4b75-8bac-e61800830d4c';
--
-- COMMIT;
