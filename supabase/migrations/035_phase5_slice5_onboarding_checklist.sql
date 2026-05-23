BEGIN;

-- onboarding_steps is an opaque jsonb map of step_id → { done: bool, at: timestamptz, by: text }
-- Used for steps that the platform cannot auto-detect (Gmail test users, client code change).
ALTER TABLE public.registry_apps
  ADD COLUMN IF NOT EXISTS onboarding_steps jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.cc_set_app_onboarding_step(
  p_app_id uuid,
  p_step_id text,
  p_done boolean,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor,'')), 200), '');
  v_step text := NULLIF(btrim(COALESCE(p_step_id, '')), '');
  v_app registry_apps;
  v_entry jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor required' USING ERRCODE='P0001'; END IF;
  IF v_step IS NULL THEN RAISE EXCEPTION 'p_step_id required' USING ERRCODE='P0001'; END IF;
  IF v_step NOT IN ('gmail_test_users_added','client_emits_owner_kind') THEN
    RAISE EXCEPTION 'p_step_id must be one of: gmail_test_users_added, client_emits_owner_kind' USING ERRCODE='P0001';
  END IF;

  IF p_done THEN
    v_entry := jsonb_build_object('done', true, 'at', now()::text, 'by', v_actor);
  ELSE
    v_entry := jsonb_build_object('done', false, 'at', now()::text, 'by', v_actor);
  END IF;

  UPDATE registry_apps
     SET onboarding_steps = COALESCE(onboarding_steps, '{}'::jsonb) || jsonb_build_object(v_step, v_entry)
   WHERE id = p_app_id AND deleted_at IS NULL
  RETURNING * INTO v_app;

  IF NOT FOUND THEN RAISE EXCEPTION 'app not found' USING ERRCODE='P0001'; END IF;

  INSERT INTO cc_audit_events (app_id, actor, event_type, detail)
  VALUES (p_app_id, v_actor, 'app_onboarding_step_updated',
    jsonb_build_object('step_id', v_step, 'done', p_done));

  RETURN jsonb_build_object('app_id', p_app_id, 'onboarding_steps', v_app.onboarding_steps);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_set_app_onboarding_step(uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cc_set_app_onboarding_step(uuid, text, boolean, text) TO service_role;

COMMIT;
