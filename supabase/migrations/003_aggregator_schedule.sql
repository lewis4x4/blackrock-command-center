-- ============================================================================
-- Migration 003: schedule the Aggregator
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- The Aggregator edge function polls every registered app's cc_export_snapshot()
-- and writes registry_app_snapshots. This migration drives it on a clock:
-- pg_cron fires an hourly net.http_post to the function.
--
-- AUTH: the function is verify_jwt=false and checks an X-Aggregator-Token header.
-- The token lives ONLY in Supabase Vault (secret name 'aggregator_token') and as
-- the function's AGGREGATOR_TOKEN secret. The cron job reads the Vault copy at
-- call time, so the raw token never appears in this committed migration nor in
-- the cron.job table as plaintext.
--
-- OPERATIONAL PREREQUISITES (not done by this migration):
--   1. Vault secret 'aggregator_token' must exist (set via vault.create_secret).
--   2. Control-plane edge-function secrets must be set:
--        AGGREGATOR_TOKEN  = same value as the Vault secret
--        SVC_KEY_QEP       = QEP data-plane service-role key
--   Until (2) is done the hourly poll runs but returns 401 / records
--   snapshot_failed — zero-blocking, no damage.
--
-- SECRET-NAME CONVENTION: registry_app_supabase.service_secret_ref holds the
-- NAME of the control-plane edge-function secret carrying that app's
-- service-role key. Convention: SVC_KEY_<SHORTCODE>. This migration corrects
-- QEP's pointer to that convention.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extensions — scheduler + HTTP client
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ----------------------------------------------------------------------------
-- 2. Registry pointer — name of QEP's service-role-key secret
-- ----------------------------------------------------------------------------
UPDATE public.registry_app_supabase
SET service_secret_ref = 'SVC_KEY_QEP'
WHERE app_id = (SELECT id FROM public.registry_apps WHERE short_code = 'QEP');

-- ----------------------------------------------------------------------------
-- 3. Hourly Aggregator poll
--    cron.schedule upserts by job name, so re-running this migration is safe.
-- ----------------------------------------------------------------------------
SELECT cron.schedule(
  'cc-aggregator-hourly',
  '0 * * * *',
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

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- SELECT cron.unschedule('cc-aggregator-hourly');
-- -- extensions left in place; drop only if nothing else uses them:
-- -- DROP EXTENSION IF EXISTS pg_net;
-- -- DROP EXTENSION IF EXISTS pg_cron;
