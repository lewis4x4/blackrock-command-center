-- ============================================================================
-- Migration 031: Phase 5 security rotation + hardening
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_job text;
BEGIN
  FOREACH v_job IN ARRAY ARRAY['cc-decision-reminder', 'cc-auto-route-decisions', 'cc-auto-clarify', 'cc-gmail-watch-renew']
  LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job) THEN
      PERFORM cron.unschedule(v_job);
    END IF;
  END LOOP;
END $$;

-- Operator pre-req (before running this migration):
--   SELECT vault.create_secret('<new-read-token>', 'CC_READ_TOKEN');
--   SELECT vault.create_secret('<new-toggle-token>', 'CC_AUTO_ROUTE_TOGGLE_TOKEN');
-- If either secret is missing, header value resolves NULL and edge auth fails closed.

SELECT cron.schedule(
  'cc-decision-reminder',
  '17 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-decision-reminder',
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

SELECT cron.schedule(
  'cc-auto-route-decisions',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-auto-route-decisions',
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

SELECT cron.schedule(
  'cc-auto-clarify',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-auto-clarify',
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

SELECT cron.schedule(
  'cc-gmail-watch-renew',
  '13 4 */6 * *',
  $$
  SELECT net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-gmail-watch-start',
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

DROP POLICY IF EXISTS registry_apps_auth_read            ON public.registry_apps;
DROP POLICY IF EXISTS registry_apps_auth_write           ON public.registry_apps;
DROP POLICY IF EXISTS registry_app_supabase_auth_read    ON public.registry_app_supabase;
DROP POLICY IF EXISTS registry_app_supabase_auth_write   ON public.registry_app_supabase;
DROP POLICY IF EXISTS registry_app_linear_auth_read      ON public.registry_app_linear;
DROP POLICY IF EXISTS registry_app_linear_auth_write     ON public.registry_app_linear;
DROP POLICY IF EXISTS registry_app_repo_auth_read        ON public.registry_app_repo;
DROP POLICY IF EXISTS registry_app_repo_auth_write       ON public.registry_app_repo;
DROP POLICY IF EXISTS registry_app_owners_auth_write     ON public.registry_app_owners;
DROP POLICY IF EXISTS registry_app_integrations_auth_read  ON public.registry_app_integrations;
DROP POLICY IF EXISTS registry_app_integrations_auth_write ON public.registry_app_integrations;
DROP POLICY IF EXISTS registry_app_snapshots_auth_read   ON public.registry_app_snapshots;
DROP POLICY IF EXISTS cc_audit_events_auth_read          ON public.cc_audit_events;
DROP POLICY IF EXISTS cc_issues_auth_all                 ON public.cc_issues;

REVOKE ALL ON public.registry_apps,
  public.registry_app_supabase,
  public.registry_app_linear,
  public.registry_app_repo,
  public.registry_app_owners,
  public.registry_app_integrations,
  public.registry_app_snapshots,
  public.cc_audit_events,
  public.cc_issues FROM authenticated;

ALTER TABLE public.registry_app_owners
  ADD CONSTRAINT registry_app_owners_portal_role_chk
  CHECK (portal_role IS NULL OR portal_role IN ('owner_all','sales','parts','finance'));

ALTER TABLE public.registry_app_owners
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE public.cc_artifacts
  ADD CONSTRAINT cc_artifacts_work_order_id_fk
    FOREIGN KEY (work_order_id) REFERENCES public.agent_work_orders(id) ON DELETE SET NULL;
ALTER TABLE public.cc_artifacts
  ADD CONSTRAINT cc_artifacts_agent_run_id_fk
    FOREIGN KEY (agent_run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS public.cc_decision_email_sends_pending_reminder_idx;
CREATE INDEX cc_decision_email_sends_pending_reminder_idx
  ON public.cc_decision_email_sends (state, sent_at, reminded_at)
  WHERE deleted_at IS NULL
    AND state IN ('sent','delivered','opened','clicked');

CREATE INDEX IF NOT EXISTS cc_issues_auto_route_candidate_idx
  ON public.cc_issues (issue_type, source_ref, status, surfaced_at ASC)
  WHERE deleted_at IS NULL AND resolved_at IS NULL;

COMMIT;
