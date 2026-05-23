BEGIN;

-- 1a. Ensure cc_issues has a unique partial index on (app_id, source_ref) so
--     per-decision rows can be ON CONFLICT-upserted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='cc_issues'
      AND indexname='cc_issues_app_source_ref_active_idx'
  ) THEN
    -- Scoped to per-decision rows only (NOT the legacy aggregator markers
    -- which intentionally share source_ref='aggregate' across rows).
    CREATE UNIQUE INDEX cc_issues_app_source_ref_active_idx
      ON cc_issues (app_id, source_ref)
      WHERE deleted_at IS NULL AND source_ref != 'aggregate';
  END IF;
END $$;

-- 1b. Unique partial index — prevents two active auto-route sends for the
--     same decision_external_ref.
CREATE UNIQUE INDEX IF NOT EXISTS cc_decision_email_sends_per_decision_active_idx
  ON cc_decision_email_sends (app_id, decision_external_ref)
  WHERE deleted_at IS NULL
    AND created_via = 'auto_route'
    AND route_parent_send_id IS NULL
    AND state NOT IN ('failed','expired','bounced','rejected_by_operator');

-- 1c. Atomic claim RPC for per-decision auto-route
CREATE OR REPLACE FUNCTION public.cc_claim_auto_route_decision(
  p_app_id uuid,
  p_decision_external_ref text,
  p_raw_title text,
  p_raw_body text,
  p_options_snapshot jsonb,
  p_risk_class text,
  p_owner_kind text,
  p_owner_role text,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor text := NULLIF(left(btrim(COALESCE(p_actor,'')), 200), '');
  v_owner_kind text := lower(COALESCE(p_owner_kind, ''));
  v_owner_role text := lower(COALESCE(p_owner_role, ''));
  v_risk text := lower(COALESCE(p_risk_class, ''));
  v_app registry_apps;
  v_recipient_count int;
  v_issue cc_issues;
  v_send cc_decision_email_sends;
  v_existing_send_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'p_actor required' USING ERRCODE='P0001'; END IF;
  IF p_app_id IS NULL THEN RAISE EXCEPTION 'p_app_id required' USING ERRCODE='P0001'; END IF;
  IF p_decision_external_ref IS NULL OR btrim(p_decision_external_ref) = '' THEN
    RAISE EXCEPTION 'p_decision_external_ref required' USING ERRCODE='P0001';
  END IF;
  IF p_raw_title IS NULL OR btrim(p_raw_title) = '' THEN
    RAISE EXCEPTION 'p_raw_title required' USING ERRCODE='P0001';
  END IF;

  -- Risk-class gate
  IF v_risk NOT IN ('auto','authorize') THEN
    RETURN jsonb_build_object('skipped', 'risk_class_not_auto_routable', 'risk_class', v_risk);
  END IF;

  -- Explicit client signal gate
  IF v_owner_kind NOT IN ('client','customer') AND v_owner_role NOT LIKE 'client%' THEN
    RETURN jsonb_build_object('skipped', 'no_client_signal', 'owner_kind', v_owner_kind, 'owner_role', v_owner_role);
  END IF;

  -- App eligibility
  SELECT * INTO v_app FROM registry_apps
   WHERE id = p_app_id AND auto_route_decisions = true AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('skipped', 'app_not_auto_route_enabled');
  END IF;

  -- Recipients exist
  SELECT COUNT(*) INTO v_recipient_count FROM registry_app_decision_recipients
   WHERE app_id = p_app_id AND active = true AND deleted_at IS NULL;
  IF v_recipient_count = 0 THEN
    RETURN jsonb_build_object('skipped', 'no_active_recipients');
  END IF;

  -- Existing-send idempotency (Layer 1 — explicit check)
  SELECT id INTO v_existing_send_id FROM cc_decision_email_sends
   WHERE app_id = p_app_id
     AND decision_external_ref = p_decision_external_ref
     AND created_via = 'auto_route'
     AND deleted_at IS NULL
     AND route_parent_send_id IS NULL
     AND state NOT IN ('failed','expired','bounced','rejected_by_operator')
   LIMIT 1;
  IF v_existing_send_id IS NOT NULL THEN
    RETURN jsonb_build_object('skipped', 'already_claimed', 'existing_send_id', v_existing_send_id);
  END IF;

  -- Per-decision cc_issues row (idempotent on app_id + source_ref)
  INSERT INTO cc_issues (app_id, issue_type, source_ref, status, severity, surfaced_at, detail)
  VALUES (
    p_app_id, 'open_decision', p_decision_external_ref, 'surfaced', 'normal', now(),
    jsonb_build_object(
      'title', p_raw_title,
      'body', p_raw_body,
      'options', COALESCE(p_options_snapshot, '[]'::jsonb),
      'owner_kind', v_owner_kind,
      'owner_role', v_owner_role,
      'risk_class', v_risk,
      'source', 'auto_route_discovery'
    )
  )
  ON CONFLICT (app_id, source_ref) WHERE deleted_at IS NULL AND source_ref != 'aggregate' DO UPDATE
    SET status = CASE WHEN cc_issues.status = 'answered' THEN cc_issues.status ELSE 'triaging' END,
        detail = EXCLUDED.detail
  RETURNING * INTO v_issue;

  -- Idempotency Layer 2 — atomic insert protected by unique partial index
  BEGIN
    INSERT INTO cc_decision_email_sends (
      issue_id, app_id, decision_external_ref,
      recipient_email, recipient_name,
      raw_decision_title, raw_decision_body,
      options_snapshot, risk_class,
      magic_link_token_hash, magic_link_expires_at,
      state, created_via, max_attempts
    ) VALUES (
      v_issue.id, p_app_id, p_decision_external_ref,
      'auto-route-pending@blackrockai.co', 'Auto-route pending',
      p_raw_title, p_raw_body,
      COALESCE(p_options_snapshot, '[]'::jsonb), v_risk,
      'auto-route-placeholder:' || encode(gen_random_bytes(8), 'hex'),
      now() + interval '7 days',
      'rewriting', 'auto_route', 3
    )
    RETURNING * INTO v_send;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('skipped', 'race_lost_unique_idx');
  END;

  INSERT INTO cc_audit_events (app_id, actor, event_type, detail)
  VALUES (p_app_id, v_actor, 'decision_auto_route_enqueued',
    jsonb_build_object('send_id', v_send.id, 'issue_id', v_issue.id, 'decision_external_ref', p_decision_external_ref, 'source', 'phase0_discovery'));

  RETURN jsonb_build_object('send_id', v_send.id, 'issue_id', v_issue.id, 'claimed', true);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cc_claim_auto_route_decision(uuid, text, text, text, jsonb, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cc_claim_auto_route_decision(uuid, text, text, text, jsonb, text, text, text, text) TO service_role;

COMMIT;
