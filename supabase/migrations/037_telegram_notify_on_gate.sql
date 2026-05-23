-- ============================================================================
-- Migration 037: Telegram notifications for operator-attention events
-- Target: control plane (gsvhuzpysxaegoecwjmf)
--
-- Adds additive pg_net trigger hooks for outbound-only Telegram notifications.
-- The edge function holds TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_CHAT_ID; SQL
-- only posts event payloads to cc-telegram-notify. The edge function is the kill
-- switch and severity gate. Internal auth uses the server-only CC_WRITE_TOKEN
-- from Supabase Vault so the public/read token cannot send Telegram messages.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.cc_notify_telegram_work_order_gated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_app record;
  v_title text;
  v_body text;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.status <> 'gated' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT short_code, display_name INTO v_app
  FROM public.registry_apps
  WHERE id = NEW.app_id;

  v_title := 'Work order ready to authorize';
  v_body := COALESCE(v_app.short_code, v_app.display_name, NEW.app_id::text)
    || ' has a gated work order waiting for Brian.'
    || ' Reason: ' || COALESCE(NEW.gated_reason, NEW.risk_class, 'operator approval required')
    || '. Work order: ' || NEW.id::text;

  PERFORM net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-telegram-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cc-write-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CC_WRITE_TOKEN' LIMIT 1)
    ),
    body := jsonb_build_object(
      'event_type', 'work_order_gated',
      'severity', 'high',
      'app_id', NEW.app_id,
      'title', v_title,
      'body', v_body,
      'deep_link', '/agents'
    ),
    timeout_milliseconds := 10000
  );

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.cc_notify_telegram_work_order_gated() IS
  'AFTER INSERT/UPDATE trigger hook: posts high-severity work_order_gated events to cc-telegram-notify via pg_net. Non-blocking; pg_net records request delivery separately.';

CREATE OR REPLACE FUNCTION public.cc_notify_telegram_handoff_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_app record;
  v_title text;
  v_body text;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.status <> 'open' THEN
    RETURN NEW;
  END IF;

  SELECT short_code, display_name INTO v_app
  FROM public.registry_apps
  WHERE id = NEW.app_id;

  v_title := 'Manual handoff required';
  v_body := COALESCE(v_app.short_code, v_app.display_name, NEW.app_id::text)
    || ' has an operator handoff open.'
    || ' Kind: ' || NEW.kind
    || '. Handoff: ' || NEW.id::text;

  PERFORM net.http_post(
    url := 'https://gsvhuzpysxaegoecwjmf.supabase.co/functions/v1/cc-telegram-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cc-write-token', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CC_WRITE_TOKEN' LIMIT 1)
    ),
    body := jsonb_build_object(
      'event_type', 'handoff_created',
      'severity', NEW.severity::text,
      'app_id', NEW.app_id,
      'title', v_title,
      'body', v_body,
      'deep_link', '/agents'
    ),
    timeout_milliseconds := 10000
  );

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.cc_notify_telegram_handoff_created() IS
  'AFTER INSERT trigger hook: posts handoff_created events to cc-telegram-notify via pg_net. The edge function only pings critical severity.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'agent_work_orders_telegram_gated'
      AND tgrelid = 'public.agent_work_orders'::regclass
  ) THEN
    CREATE TRIGGER agent_work_orders_telegram_gated
      AFTER INSERT OR UPDATE OF status ON public.agent_work_orders
      FOR EACH ROW
      WHEN (NEW.status = 'gated')
      EXECUTE FUNCTION public.cc_notify_telegram_work_order_gated();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'cc_operator_handoffs_telegram_created'
      AND tgrelid = 'public.cc_operator_handoffs'::regclass
  ) THEN
    CREATE TRIGGER cc_operator_handoffs_telegram_created
      AFTER INSERT ON public.cc_operator_handoffs
      FOR EACH ROW
      WHEN (NEW.status = 'open')
      EXECUTE FUNCTION public.cc_notify_telegram_handoff_created();
  END IF;
END $$;

COMMIT;

-- Verification:
--   INSERT/UPDATE a gated agent_work_orders row, then inspect net._http_response
--   or Supabase pg_net request logs for the POST to cc-telegram-notify.
