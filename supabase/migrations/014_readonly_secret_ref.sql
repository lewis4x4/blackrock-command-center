-- ============================================================================
-- Migration 014: add read-only data-plane secret refs
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Retires the standing god-credential path by adding a scoped read-only secret
-- pointer for each client data plane. The service-role pointer remains in place
-- during the cutover window as a fallback only.
--
-- SECRETS RULE: readonly_secret_ref stores the name of an edge-function secret
-- such as READ_KEY_QEP. It never stores the raw JWT/key.
-- ============================================================================

BEGIN;

ALTER TABLE public.registry_app_supabase
  ADD COLUMN IF NOT EXISTS readonly_secret_ref text;

COMMENT ON COLUMN public.registry_app_supabase.readonly_secret_ref IS
  'Name of the control-plane edge-function secret carrying a scoped read-only client data-plane JWT. Convention: READ_KEY_<SHORTCODE>.';

UPDATE public.registry_app_supabase s
SET readonly_secret_ref = 'READ_KEY_QEP'
FROM public.registry_apps a
WHERE s.app_id = a.id
  AND a.short_code = 'QEP'
  AND s.readonly_secret_ref IS DISTINCT FROM 'READ_KEY_QEP';

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert during the cutover window)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public.registry_app_supabase
--     DROP COLUMN IF EXISTS readonly_secret_ref;
-- COMMIT;
