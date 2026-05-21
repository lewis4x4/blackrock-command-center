-- ============================================================================
-- Migration 004: registry_apps.app_url
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- The Command Center home deep-links from triage items and app cards into each
-- app's own surface (its Decision Inbox, sync view, etc.). That needs a per-app
-- live URL. This adds it to registry_apps and re-exposes it through
-- v_command_center_home so the frontend gets it in the single home query.
-- ============================================================================

BEGIN;

ALTER TABLE public.registry_apps
  ADD COLUMN IF NOT EXISTS app_url text;

COMMENT ON COLUMN public.registry_apps.app_url IS
  'The app''s live/portal URL. Deep-link target for the Command Center home.';

UPDATE public.registry_apps
SET app_url = 'https://qep.blackrockai.co'
WHERE short_code = 'QEP';

-- Recreate the home view with app_url appended (new column at the end so
-- CREATE OR REPLACE is valid).
CREATE OR REPLACE VIEW public.v_command_center_home
WITH (security_invoker = on) AS
SELECT
  a.id,
  a.short_code,
  a.display_name,
  a.client_name,
  a.status,
  a.lifecycle_phase,
  a.criticality,
  s.captured_at        AS last_snapshot_at,
  s.build_status,
  s.roadmap_counts,
  s.decision_counts,
  s.sync_health,
  a.app_url
FROM public.registry_apps a
LEFT JOIN LATERAL (
  SELECT * FROM public.registry_app_snapshots ss
  WHERE ss.app_id = a.id
  ORDER BY ss.captured_at DESC
  LIMIT 1
) s ON true
WHERE a.deleted_at IS NULL
ORDER BY a.criticality DESC, a.short_code ASC;

COMMENT ON VIEW public.v_command_center_home IS
  'One row per active app with its most recent snapshot. The Command Center home reads this.';

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   -- restore the migration-001 view shape (without app_url), then:
--   ALTER TABLE public.registry_apps DROP COLUMN IF EXISTS app_url;
-- COMMIT;
