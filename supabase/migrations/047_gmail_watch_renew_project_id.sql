-- ============================================================================
-- Migration 047: Repair Gmail watch renewal cron
-- Target: control plane (gsvhuzpysxaegoecwjmf)
--
-- Migration 031 rotated cron secrets but accidentally dropped the required
-- project_id query param from cc-gmail-watch-start. pg_cron reported success
-- because pg_net enqueued the request, but the Edge Function returned HTTP 400
-- and the Gmail watch was not renewed.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-gmail-watch-renew') THEN
    PERFORM cron.unschedule('cc-gmail-watch-renew');
  END IF;
END $$;

SELECT cron.schedule(
  'cc-gmail-watch-renew',
  '13 4 */6 * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-gmail-watch-start?project_id=tidal-orbit-487616-d7',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cc-read-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CC_READ_TOKEN' LIMIT 1),
      'x-cc-auto-route-toggle', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CC_AUTO_ROUTE_TOGGLE_TOKEN' LIMIT 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

COMMIT;

-- Down migration (commented): restore the pre-fix broken URL only if explicitly
-- needed for forensic reproduction.
--
-- BEGIN;
-- SELECT cron.unschedule('cc-gmail-watch-renew');
-- SELECT cron.schedule(
--   'cc-gmail-watch-renew',
--   '13 4 */6 * *',
--   $$
--   SELECT net.http_post(
--     url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-gmail-watch-start',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-cc-read-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CC_READ_TOKEN' LIMIT 1),
--       'x-cc-auto-route-toggle', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CC_AUTO_ROUTE_TOGGLE_TOKEN' LIMIT 1)
--     ),
--     body := '{}'::jsonb,
--     timeout_milliseconds := 60000
--   );
--   $$
-- );
-- COMMIT;
