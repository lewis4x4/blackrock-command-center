-- ============================================================================
-- Migration 008: Aggregator poll — hourly -> every 5 minutes
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- OS roadmap Phase 0 — the freshness quick win.
--
-- Migration 003 scheduled the Aggregator hourly ('0 * * * *'), which leaves the
-- board up to ~60 minutes stale. This drops the poll interval to 5 minutes.
-- Push-ingest (Phase 1) will later make most refreshes event-driven; this
-- 5-minute poll then stays as the safety-net heartbeat.
--
-- The hourly job is unscheduled by name and replaced with cc-aggregator-5min,
-- so the cron.job row name no longer says "hourly". Auth is unchanged from 003:
-- the job resolves the X-Aggregator-Token from Supabase Vault at call time, so
-- the raw token never appears in this migration nor in cron.job as plaintext.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Retire the hourly job (idempotent — cron.unschedule errors on a missing
--    job, so guard it).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-aggregator-hourly') THEN
    PERFORM cron.unschedule('cc-aggregator-hourly');
  END IF;
END$$;

-- ----------------------------------------------------------------------------
-- 2. Schedule the 5-minute poll. cron.schedule upserts by name — safe to re-run.
-- ----------------------------------------------------------------------------
SELECT cron.schedule(
  'cc-aggregator-5min',
  '*/5 * * * *',
  $job$
  SELECT net.http_post(
    url     := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/aggregator',
    headers := jsonb_build_object(
      'Content-Type',       'application/json',
      'X-Aggregator-Token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'aggregator_token')
    ),
    body    := '{}'::jsonb
  );
  $job$
);

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DO $$
--   BEGIN
--     IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-aggregator-5min') THEN
--       PERFORM cron.unschedule('cc-aggregator-5min');
--     END IF;
--   END$$;
--   SELECT cron.schedule(
--     'cc-aggregator-hourly',
--     '0 * * * *',
--     $job$
--     SELECT net.http_post(
--       url     := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/aggregator',
--       headers := jsonb_build_object(
--         'Content-Type',       'application/json',
--         'X-Aggregator-Token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'aggregator_token')
--       ),
--       body    := '{}'::jsonb
--     );
--     $job$
--   );
-- COMMIT;
