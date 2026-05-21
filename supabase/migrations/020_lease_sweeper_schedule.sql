-- ============================================================================
-- Migration 020: Lease sweeper schedule
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Runs cc_reclaim_expired_leases() every minute via pg_cron so crashed or hung
-- runners release their per-app repo mutex automatically.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-work-order-lease-sweeper') THEN
    PERFORM cron.unschedule('cc-work-order-lease-sweeper');
  END IF;
END$$;

SELECT cron.schedule(
  'cc-work-order-lease-sweeper',
  '* * * * *',
  $job$
  SELECT public.cc_reclaim_expired_leases();
  $job$
);

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DO $$
--   BEGIN
--     IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-work-order-lease-sweeper') THEN
--       PERFORM cron.unschedule('cc-work-order-lease-sweeper');
--     END IF;
--   END$$;
-- COMMIT;
