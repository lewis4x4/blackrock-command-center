-- ============================================================================
-- Migration 028: Phase 5 cron schedules
-- Target: control plane (gsvhuzpysxaegoecwjmf)
--
-- Schedules three pg_cron jobs that drive the autonomous decision pipeline:
--   1. cc-auto-route-decisions  (every 2 min)  — Slice 2.5 auto-routing
--   2. cc-auto-clarify          (every 5 min)  — Slice 2 clarification sends
--   3. cc-gmail-watch-renew     (every 6 days) — keeps Gmail Pub/Sub watching
--
-- Token note: VITE_CC_READ_TOKEN is embedded in the public frontend bundle,
-- so it is not actually secret. Hardcoding it in a migration here is no worse
-- than the bundle exposure. If the token is ever rotated, re-run this
-- migration with the new value, or update via cron.unschedule + cron.schedule.
-- ============================================================================

BEGIN;

-- Ensure required extensions are enabled. Supabase platform allows both.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- Idempotency: drop existing jobs if re-running this migration.
DO $$
DECLARE v_job_name text;
BEGIN
  FOREACH v_job_name IN ARRAY ARRAY['cc-auto-route-decisions', 'cc-auto-clarify', 'cc-gmail-watch-renew']
  LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job_name) THEN
      PERFORM cron.unschedule(v_job_name);
    END IF;
  END LOOP;
END $$;

-- =========================================================================
-- 1. cc-auto-route-decisions — Slice 2.5 autonomous routing cron
--    Runs every 2 minutes. Phase A finalizes rewrite_ready auto-route rows
--    (cap 10), Phase B claims new eligible cc_issues (cap 10).
-- =========================================================================
SELECT cron.schedule(
  'cc-auto-route-decisions',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-auto-route-decisions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cc-read-token', '85dfc1883530807294c1568fa1c0236f15db9f672a54bd5d3bd0e3009febf8db'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);

-- =========================================================================
-- 2. cc-auto-clarify — Slice 2 clarification email cron
--    Runs every 5 minutes. Picks one awaiting_clarify row, sends Gmail
--    clarification with fresh tokens, transitions to clarify_sent. Atomic
--    claim via cc_claim_clarify_task RPC (built in migration 026 hotfix).
-- =========================================================================
SELECT cron.schedule(
  'cc-auto-clarify',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-auto-clarify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cc-read-token', '85dfc1883530807294c1568fa1c0236f15db9f672a54bd5d3bd0e3009febf8db'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) AS request_id;
  $$
);

-- =========================================================================
-- 3. cc-gmail-watch-renew — Gmail users.watch expires after 7 days.
--    Renew every 6 days at 03:17 UTC (off-peak hour to avoid contending
--    with the other crons; daylight-stable hour for the operator).
-- =========================================================================
SELECT cron.schedule(
  'cc-gmail-watch-renew',
  '17 3 */6 * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-gmail-watch-start?project_id=tidal-orbit-487616-d7',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cc-read-token', '85dfc1883530807294c1568fa1c0236f15db9f672a54bd5d3bd0e3009febf8db'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) AS request_id;
  $$
);

COMMIT;

-- ============================================================================
-- Verification (run manually after migration applies):
--
--   SELECT jobname, schedule, active, jobid
--     FROM cron.job
--    WHERE jobname IN ('cc-auto-route-decisions','cc-auto-clarify','cc-gmail-watch-renew');
--
-- Should return three active rows.
--
-- To see recent invocations + their results:
--   SELECT jobname, status, return_message, start_time, end_time
--     FROM cron.job_run_details
--    ORDER BY start_time DESC
--    LIMIT 20;
-- ============================================================================
