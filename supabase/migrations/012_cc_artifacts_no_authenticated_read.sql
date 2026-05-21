BEGIN;

-- §4.11: browser reads must flow through cc-read-artifacts (service-role mediation).
-- Keep cc_artifacts service-role-only; authenticated SELECT is a latent foot-gun
-- if a future login flow ships publishable key + user session in the browser.
DROP POLICY IF EXISTS cc_artifacts_auth_read ON public.cc_artifacts;
REVOKE SELECT ON public.cc_artifacts FROM authenticated;

COMMIT;
