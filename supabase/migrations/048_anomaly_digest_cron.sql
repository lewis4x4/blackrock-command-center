-- ============================================================================
-- Migration 048: Smoke-test anomaly digest + Telegram safety-net alerts
-- Target: control plane (gsvhuzpysxaegoecwjmf)
--
-- Phase 4 remediation: operator-visible safety nets for late replies,
-- smoke-test guardrail blocks, and daily decision-answer anomaly scans.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

COMMIT;

-- New issue type used by the daily digest. Separate transaction keeps the new
-- enum value usable by the functions below on all supported Postgres versions.
ALTER TYPE public.cc_issue_type ADD VALUE IF NOT EXISTS 'governance_alert';

BEGIN;

CREATE OR REPLACE FUNCTION public.cc_post_telegram_alert(
  p_event_type text,
  p_severity text,
  p_app_id uuid,
  p_title text,
  p_body text,
  p_deep_link text DEFAULT '/settings'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_write_token text;
BEGIN
  SELECT btrim(decrypted_secret) INTO v_write_token
  FROM vault.decrypted_secrets
  WHERE name IN ('CC_WRITE_TOKEN', 'CC_AUTO_ROUTE_TOGGLE_TOKEN')
  ORDER BY CASE name WHEN 'CC_WRITE_TOKEN' THEN 0 ELSE 1 END
  LIMIT 1;

  IF NULLIF(v_write_token, '') IS NULL THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-telegram-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cc-write-token', v_write_token
    ),
    body := jsonb_build_object(
      'event_type', p_event_type,
      'severity', p_severity,
      'app_id', p_app_id,
      'title', p_title,
      'body', p_body,
      'deep_link', p_deep_link
    ),
    timeout_milliseconds := 10000
  );
END;
$fn$;

COMMENT ON FUNCTION public.cc_post_telegram_alert(text, text, uuid, text, text, text) IS
  'Shared pg_net helper for Phase 4 Telegram anomaly alerts. Uses CC_WRITE_TOKEN from Vault; no secret is stored in table data.';

CREATE OR REPLACE FUNCTION public.cc_notify_telegram_late_reply_arrived()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_app record;
  v_ref text;
  v_reply_from text;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.issue_type::text <> 'late_reply' THEN
    RETURN NEW;
  END IF;

  SELECT short_code, display_name INTO v_app
  FROM public.registry_apps
  WHERE id = NEW.app_id;

  v_ref := COALESCE(NULLIF(NEW.source_ref, ''), NEW.detail ->> 'decision_external_ref', NEW.context ->> 'decision_external_ref', NEW.id::text);
  v_reply_from := COALESCE(NEW.detail ->> 'recipient_email', NEW.detail ->> 'from', NEW.context ->> 'recipient_email', 'unknown sender');

  PERFORM public.cc_post_telegram_alert(
    'late_reply_arrived',
    'high',
    NEW.app_id,
    '🟡 Late client reply — decision was already closed',
    format('%s received a late client reply from %s for decision %s. Issue: %s. Review Settings → Decisions admin before moving follow-up work.', COALESCE(v_app.short_code, v_app.display_name, NEW.app_id::text), v_reply_from, v_ref, NEW.id::text),
    '/settings'
  );

  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_notify_telegram_smoke_test_blocked_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_title text;
  v_body text;
BEGIN
  IF NEW.event_type <> 'smoke_test_blocked' THEN
    RETURN NEW;
  END IF;

  v_title := COALESCE(NULLIF(NEW.detail ->> 'title', ''), '🚨 Smoke-test answer blocked');
  v_body := COALESCE(
    NULLIF(NEW.detail ->> 'body', ''),
    format('A smoke-test answer was rejected before it could close a routed production decision. Actor: %s. Issue: %s. Decision: %s.', NEW.actor, COALESCE(NEW.detail ->> 'issue_id', 'unknown'), COALESCE(NEW.detail ->> 'decision_external_ref', 'unknown'))
  );

  PERFORM public.cc_post_telegram_alert('smoke_test_blocked', 'critical', NEW.app_id, v_title, v_body, '/settings');

  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_fire_smoke_test_blocked_alert(
  p_app_id uuid,
  p_issue_id uuid,
  p_decision_external_ref text,
  p_actor text DEFAULT 'postgres-guardrail',
  p_reason text DEFAULT 'smoke_test source blocked on routed decision'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  PERFORM public.cc_post_telegram_alert(
    'smoke_test_blocked',
    'critical',
    p_app_id,
    '🚨 Smoke-test answer blocked',
    format('Rejected a smoke-test answer attempt for routed decision %s. Issue: %s. Actor: %s. Reason: %s.', COALESCE(p_decision_external_ref, 'unknown'), COALESCE(p_issue_id::text, 'unknown'), COALESCE(p_actor, 'unknown'), COALESCE(p_reason, 'guardrail rejected the answer')),
    '/settings'
  );

  INSERT INTO public.cc_audit_events (app_id, actor, event_type, detail)
  VALUES (
    p_app_id,
    COALESCE(NULLIF(p_actor, ''), 'postgres-guardrail'),
    'smoke_test_blocked',
    jsonb_build_object('issue_id', p_issue_id, 'decision_external_ref', p_decision_external_ref, 'reason', p_reason)
  );
END;
$fn$;

COMMENT ON FUNCTION public.cc_fire_smoke_test_blocked_alert(uuid, uuid, text, text, text) IS
  'Callable from Phase 3 source guardrails before rejecting a smoke-test answer attempt. Fires Telegram via pg_net and writes an audit marker.';

DROP TRIGGER IF EXISTS cc_issues_telegram_late_reply ON public.cc_issues;
CREATE TRIGGER cc_issues_telegram_late_reply
  AFTER INSERT ON public.cc_issues
  FOR EACH ROW
  WHEN (NEW.issue_type::text = 'late_reply')
  EXECUTE FUNCTION public.cc_notify_telegram_late_reply_arrived();

DROP TRIGGER IF EXISTS cc_audit_events_telegram_smoke_test_blocked ON public.cc_audit_events;
CREATE TRIGGER cc_audit_events_telegram_smoke_test_blocked
  AFTER INSERT ON public.cc_audit_events
  FOR EACH ROW
  WHEN (NEW.event_type = 'smoke_test_blocked')
  EXECUTE FUNCTION public.cc_notify_telegram_smoke_test_blocked_audit();

CREATE OR REPLACE FUNCTION public.fn_cc_anomaly_digest()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_has_source_col boolean := false;
  v_smoke_answers integer := 0;
  v_fast_answers integer := 0;
  v_late_inbound integer := 0;
  v_stuck_routed integer := 0;
  v_total integer := 0;
  v_app_id uuid;
  v_source_ref text := 'anomaly-digest:' || to_char((now() AT TIME ZONE 'America/Los_Angeles')::date, 'YYYY-MM-DD');
  v_issue_id uuid;
  v_body text;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cc_decision_answers'
      AND column_name = 'source'
  ) INTO v_has_source_col;

  IF v_has_source_col THEN
    EXECUTE $sql$
      SELECT count(*)::integer
      FROM public.cc_decision_answers
      WHERE deleted_at IS NULL
        AND created_at >= now() - interval '24 hours'
        AND source::text = 'smoke_test'
    $sql$ INTO v_smoke_answers;
  ELSE
    SELECT count(*)::integer INTO v_smoke_answers
    FROM public.cc_decision_answers
    WHERE deleted_at IS NULL
      AND created_at >= now() - interval '24 hours'
      AND (
        answer_value ILIKE '%smoke%'
        OR answered_by ILIKE '%smoke%'
        OR answered_by ILIKE '%test%'
        OR COALESCE(rationale, '') ILIKE '%smoke%'
      );
  END IF;

  SELECT count(DISTINCT a.id)::integer INTO v_fast_answers
  FROM public.cc_decision_answers a
  JOIN public.cc_decision_email_sends s
    ON s.app_id = a.app_id
   AND s.decision_external_ref = a.decision_external_ref
   AND s.deleted_at IS NULL
   AND s.sent_at IS NOT NULL
  WHERE a.deleted_at IS NULL
    AND a.answered_at >= now() - interval '24 hours'
    AND a.answered_at >= s.sent_at
    AND a.answered_at - s.sent_at < interval '60 seconds';

  SELECT count(*)::integer INTO v_late_inbound
  FROM (
    SELECT s.id
    FROM public.cc_decision_email_sends s
    JOIN public.cc_issues i ON i.id = s.issue_id
    WHERE s.deleted_at IS NULL
      AND i.deleted_at IS NULL
      AND i.status IN ('answered', 'done')
      AND COALESCE(s.inbound_received_at, s.replied_at) >= now() - interval '24 hours'
    UNION ALL
    SELECT r.id
    FROM public.cc_decision_inbound_extra_replies r
    JOIN public.cc_decision_email_sends s ON s.id = r.send_id
    JOIN public.cc_issues i ON i.id = s.issue_id
    WHERE s.deleted_at IS NULL
      AND i.deleted_at IS NULL
      AND i.status IN ('answered', 'done')
      AND r.received_at >= now() - interval '24 hours'
  ) late_rows;

  SELECT count(DISTINCT i.id)::integer INTO v_stuck_routed
  FROM public.cc_issues i
  WHERE i.deleted_at IS NULL
    AND i.issue_type = 'open_decision'
    AND i.status = 'routed_to_client'
    AND COALESCE(i.last_seen_at, i.surfaced_at, i.created_at) < now() - interval '14 days'
    AND NOT EXISTS (
      SELECT 1 FROM public.cc_decision_answers a
      WHERE a.deleted_at IS NULL
        AND a.app_id = i.app_id
        AND (a.issue_id = i.id OR a.decision_external_ref = i.source_ref)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.cc_decision_email_sends s
      WHERE s.deleted_at IS NULL
        AND s.issue_id = i.id
        AND (s.decision_answer_id IS NOT NULL OR s.raw_reply_text IS NOT NULL OR s.inbound_received_at IS NOT NULL OR s.replied_at IS NOT NULL)
    );

  v_total := v_smoke_answers + v_fast_answers + v_late_inbound + v_stuck_routed;

  IF v_total = 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'anomalies', 0,
      'smoke_test_answers_24h', v_smoke_answers,
      'fast_answers_24h', v_fast_answers,
      'late_inbound_24h', v_late_inbound,
      'stuck_routed_14d', v_stuck_routed
    );
  END IF;

  SELECT app_id INTO v_app_id
  FROM (
    SELECT app_id, max(created_at) AS ts FROM public.cc_decision_answers WHERE deleted_at IS NULL AND created_at >= now() - interval '24 hours' GROUP BY app_id
    UNION ALL
    SELECT app_id, max(created_at) AS ts FROM public.cc_decision_email_sends WHERE deleted_at IS NULL AND created_at >= now() - interval '24 hours' GROUP BY app_id
    UNION ALL
    SELECT app_id, max(created_at) AS ts FROM public.cc_issues WHERE deleted_at IS NULL AND status = 'routed_to_client' GROUP BY app_id
  ) candidates
  ORDER BY ts DESC NULLS LAST
  LIMIT 1;

  IF v_app_id IS NULL THEN
    SELECT id INTO v_app_id FROM public.registry_apps WHERE deleted_at IS NULL ORDER BY criticality DESC, created_at ASC LIMIT 1;
  END IF;

  v_body := format(
    'Daily decision anomaly scan found %s signal(s): %s smoke-test answer(s), %s answer(s) under 60 seconds after route, %s closed-decision inbound repl(ies), %s routed decision(s) stuck over 14 days.',
    v_total, v_smoke_answers, v_fast_answers, v_late_inbound, v_stuck_routed
  );

  IF v_app_id IS NOT NULL THEN
    INSERT INTO public.cc_issues (app_id, issue_type, source_ref, status, severity, title, summary, detail, context)
    SELECT
      v_app_id,
      'governance_alert'::public.cc_issue_type,
      v_source_ref,
      'surfaced'::public.cc_issue_status,
      'normal'::public.cc_issue_severity,
      'Decision answer anomaly digest',
      v_body,
      jsonb_build_object(
        'smoke_test_answers_24h', v_smoke_answers,
        'fast_answers_24h', v_fast_answers,
        'late_inbound_24h', v_late_inbound,
        'stuck_routed_14d', v_stuck_routed,
        'generated_at', now()
      ),
      jsonb_build_object('source', 'fn_cc_anomaly_digest')
    WHERE NOT EXISTS (
      SELECT 1 FROM public.cc_issues
      WHERE app_id = v_app_id
        AND issue_type::text = 'governance_alert'
        AND source_ref = v_source_ref
        AND deleted_at IS NULL
    )
    RETURNING id INTO v_issue_id;
  END IF;

  PERFORM public.cc_post_telegram_alert(
    'answer_source_anomaly',
    'medium',
    v_app_id,
    '🟠 Decision answer anomaly digest',
    v_body,
    '/settings'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'anomalies', v_total,
    'issue_id', v_issue_id,
    'smoke_test_answers_24h', v_smoke_answers,
    'fast_answers_24h', v_fast_answers,
    'late_inbound_24h', v_late_inbound,
    'stuck_routed_14d', v_stuck_routed
  );
END;
$fn$;

COMMENT ON FUNCTION public.fn_cc_anomaly_digest() IS
  'Daily Phase 4 governance scan for smoke-test answers, suspiciously fast answers, late inbound replies on closed decisions, and stale routed decisions.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cc-anomaly-digest') THEN
    PERFORM cron.unschedule('cc-anomaly-digest');
  END IF;
END $$;

-- 07:00 Pacific during daylight time (14:00 UTC); Brian's morning operator scan.
SELECT cron.schedule(
  'cc-anomaly-digest',
  '0 14 * * *',
  $$ SELECT public.fn_cc_anomaly_digest(); $$
);

COMMIT;

-- Verification:
--   SELECT public.fn_cc_anomaly_digest();
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'cc-anomaly-digest';
--   SELECT * FROM net._http_response ORDER BY created DESC LIMIT 5;
