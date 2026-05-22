-- ============================================================================
-- Migration 023: Apps write RPCs — edit basics + register app
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- Slice 2 Apps page writes. Edge functions authenticate the operator, then call
-- these service-role-only SECURITY DEFINER RPCs so registry writes and audit rows
-- land atomically. Secrets remain references only; raw keys are rejected.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.cc_secret_ref_looks_raw(p_ref text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT
    p_ref IS NULL
    OR btrim(p_ref) = ''
    OR btrim(p_ref) LIKE 'eyJ%'
    OR length(btrim(p_ref)) > 100
    OR btrim(p_ref) ~ '[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
$fn$;

COMMENT ON FUNCTION public.cc_secret_ref_looks_raw(text) IS
  'Returns true when a registry secret reference is missing or resembles a raw JWT/API key instead of a pointer name.';

CREATE OR REPLACE FUNCTION public.cc_edit_app(
  p_app_id uuid,
  p_changes jsonb DEFAULT '{}'::jsonb,
  p_archive boolean DEFAULT false,
  p_actor text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_app public.registry_apps%ROWTYPE;
  v_updated public.registry_apps%ROWTYPE;
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_key text;
  v_display_name text;
  v_app_url text;
  v_criticality integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = 'P0001';
  END IF;

  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION 'changes must be a JSON object' USING ERRCODE = 'P0001';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
    IF v_key NOT IN ('display_name', 'app_url', 'criticality') THEN
      RAISE EXCEPTION 'field % is not editable', v_key
        USING ERRCODE = 'P0001', DETAIL = 'editable fields: display_name, app_url, criticality';
    END IF;
  END LOOP;

  SELECT * INTO v_app
  FROM public.registry_apps
  WHERE id = p_app_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'app not found' USING ERRCODE = 'P0001';
  END IF;

  IF p_archive THEN
    UPDATE public.registry_apps
    SET deleted_at = now()
    WHERE id = p_app_id
    RETURNING * INTO v_updated;

    INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
    VALUES (
      v_updated.id,
      v_actor,
      'app_updated',
      jsonb_build_object(
        'action', 'archive',
        'old', jsonb_build_object(
          'display_name', v_app.display_name,
          'app_url', v_app.app_url,
          'criticality', v_app.criticality,
          'deleted_at', v_app.deleted_at
        ),
        'new', jsonb_build_object('deleted_at', v_updated.deleted_at)
      )
    );

    RETURN to_jsonb(v_updated);
  END IF;

  IF p_changes = '{}'::jsonb THEN
    RAISE EXCEPTION 'at least one editable field is required' USING ERRCODE = 'P0001';
  END IF;

  IF p_changes ? 'display_name' THEN
    v_display_name := NULLIF(left(btrim(COALESCE(p_changes ->> 'display_name', '')), 120), '');
    IF v_display_name IS NULL THEN
      RAISE EXCEPTION 'display_name must be a non-empty string' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_changes ? 'app_url' THEN
    IF jsonb_typeof(p_changes -> 'app_url') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'app_url must be a string or null' USING ERRCODE = 'P0001';
    END IF;
    v_app_url := NULLIF(left(btrim(COALESCE(p_changes ->> 'app_url', '')), 500), '');
    IF v_app_url IS NOT NULL AND v_app_url !~ '^https://[^[:space:]]+$' THEN
      RAISE EXCEPTION 'app_url must be an https URL or null' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_changes ? 'criticality' THEN
    IF jsonb_typeof(p_changes -> 'criticality') <> 'number' THEN
      RAISE EXCEPTION 'criticality must be an integer' USING ERRCODE = 'P0001';
    END IF;
    v_criticality := (p_changes ->> 'criticality')::integer;
    IF v_criticality < 0 OR v_criticality > 1000 THEN
      RAISE EXCEPTION 'criticality must be between 0 and 1000' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.registry_apps
  SET display_name = CASE WHEN p_changes ? 'display_name' THEN v_display_name ELSE display_name END,
      app_url = CASE WHEN p_changes ? 'app_url' THEN v_app_url ELSE app_url END,
      criticality = CASE WHEN p_changes ? 'criticality' THEN v_criticality ELSE criticality END
  WHERE id = p_app_id
  RETURNING * INTO v_updated;

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_updated.id,
    v_actor,
    'app_updated',
    jsonb_build_object(
      'action', 'edit_basics',
      'old', jsonb_build_object(
        'display_name', v_app.display_name,
        'app_url', v_app.app_url,
        'criticality', v_app.criticality
      ),
      'new', jsonb_build_object(
        'display_name', v_updated.display_name,
        'app_url', v_updated.app_url,
        'criticality', v_updated.criticality
      ),
      'changed_fields', (SELECT jsonb_agg(key) FROM jsonb_object_keys(p_changes) AS key)
    )
  );

  RETURN to_jsonb(v_updated);
END;
$fn$;

COMMENT ON FUNCTION public.cc_edit_app(uuid, jsonb, boolean, text) IS
  'Atomically edits app basics or soft-archives an app, then appends an app_updated audit event. Edge functions call this with service_role only.';

CREATE OR REPLACE FUNCTION public.cc_register_app(
  p_short_code text,
  p_display_name text,
  p_project_ref text,
  p_project_url text,
  p_service_secret_ref text,
  p_github_repo text,
  p_readonly_secret_ref text DEFAULT NULL,
  p_actor text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_app public.registry_apps%ROWTYPE;
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor, '')), 500), '');
  v_short_code text := upper(NULLIF(btrim(COALESCE(p_short_code, '')), ''));
  v_display_name text := NULLIF(left(btrim(COALESCE(p_display_name, '')), 120), '');
  v_project_ref text := NULLIF(left(btrim(COALESCE(p_project_ref, '')), 80), '');
  v_project_url text := NULLIF(left(btrim(COALESCE(p_project_url, '')), 500), '');
  v_service_secret_ref text := NULLIF(btrim(COALESCE(p_service_secret_ref, '')), '');
  v_readonly_secret_ref text := NULLIF(btrim(COALESCE(p_readonly_secret_ref, '')), '');
  v_github_repo text := NULLIF(left(btrim(COALESCE(p_github_repo, '')), 200), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = 'P0001';
  END IF;

  IF v_short_code IS NULL OR v_short_code !~ '^[A-Z0-9_]{2,12}$' THEN
    RAISE EXCEPTION 'short_code must be 2-12 uppercase letters, numbers, or underscores' USING ERRCODE = 'P0001';
  END IF;

  IF v_display_name IS NULL THEN
    RAISE EXCEPTION 'display_name is required' USING ERRCODE = 'P0001';
  END IF;
  IF v_project_ref IS NULL THEN
    RAISE EXCEPTION 'project_ref is required' USING ERRCODE = 'P0001';
  END IF;
  IF v_project_url IS NULL OR v_project_url !~ '^https://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'project_url must be an https URL' USING ERRCODE = 'P0001';
  END IF;
  IF v_github_repo IS NULL OR v_github_repo !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' THEN
    RAISE EXCEPTION 'github_repo must be owner/name' USING ERRCODE = 'P0001';
  END IF;
  IF public.cc_secret_ref_looks_raw(v_service_secret_ref) THEN
    RAISE EXCEPTION 'service_secret_ref must be a secret pointer, not a raw key' USING ERRCODE = 'P0001';
  END IF;
  IF v_readonly_secret_ref IS NOT NULL AND public.cc_secret_ref_looks_raw(v_readonly_secret_ref) THEN
    RAISE EXCEPTION 'readonly_secret_ref must be a secret pointer, not a raw key' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.registry_apps (short_code, display_name)
  VALUES (v_short_code, v_display_name)
  RETURNING * INTO v_app;

  INSERT INTO public.registry_app_supabase (
    app_id,
    project_ref,
    project_url,
    service_secret_ref,
    readonly_secret_ref
  ) VALUES (
    v_app.id,
    v_project_ref,
    v_project_url,
    v_service_secret_ref,
    v_readonly_secret_ref
  );

  INSERT INTO public.registry_app_repo (app_id, github_repo)
  VALUES (v_app.id, v_github_repo);

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    v_app.id,
    v_actor,
    'app_provisioned',
    jsonb_build_object(
      'short_code', v_app.short_code,
      'display_name', v_app.display_name,
      'project_ref', v_project_ref,
      'project_url', v_project_url,
      'service_secret_ref', v_service_secret_ref,
      'readonly_secret_ref', v_readonly_secret_ref,
      'github_repo', v_github_repo
    )
  );

  RETURN to_jsonb(v_app);
END;
$fn$;

COMMENT ON FUNCTION public.cc_register_app(text, text, text, text, text, text, text, text) IS
  'Atomically registers an app across registry_apps, registry_app_supabase, registry_app_repo, then appends app_provisioned. Secret refs must be pointers only.';

REVOKE ALL ON FUNCTION public.cc_secret_ref_looks_raw(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cc_secret_ref_looks_raw(text) FROM anon;
REVOKE ALL ON FUNCTION public.cc_secret_ref_looks_raw(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cc_secret_ref_looks_raw(text) TO service_role;

REVOKE ALL ON FUNCTION public.cc_edit_app(uuid, jsonb, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cc_edit_app(uuid, jsonb, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.cc_edit_app(uuid, jsonb, boolean, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cc_edit_app(uuid, jsonb, boolean, text) TO service_role;

REVOKE ALL ON FUNCTION public.cc_register_app(text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cc_register_app(text, text, text, text, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.cc_register_app(text, text, text, text, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cc_register_app(text, text, text, text, text, text, text, text) TO service_role;

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DROP FUNCTION IF EXISTS public.cc_register_app(text, text, text, text, text, text, text, text);
--   DROP FUNCTION IF EXISTS public.cc_edit_app(uuid, jsonb, boolean, text);
--   DROP FUNCTION IF EXISTS public.cc_secret_ref_looks_raw(text);
-- COMMIT;
