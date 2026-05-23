-- ============================================================================
-- Migration 030: Hotfix for migration 029's reminder cron
--
-- Migration 029 scheduled cc-decision-reminder with the READ token in the
-- x-cc-auto-route-toggle header by mistake — the function (correctly) rejects
-- with 401 because TOGGLE_TOKEN must differ from READ_TOKEN per P0-E. This
-- migration reschedules with the actual CC_AUTO_ROUTE_TOGGLE_TOKEN value.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-decision-reminder') THEN
    PERFORM cron.unschedule('cc-decision-reminder');
  END IF;
END $$;

SELECT cron.schedule(
  'cc-decision-reminder',
  '17 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-decision-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cc-read-token', '85dfc1883530807294c1568fa1c0236f15db9f672a54bd5d3bd0e3009febf8db',
      'x-cc-auto-route-toggle', '5d1cbc93cbc107aafdc309c08680086feeeb278a9b59a303ab6d7cdec367daf3'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

COMMIT;
