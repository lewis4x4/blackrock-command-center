-- ============================================================================
-- Migration 021: agent_work_orders gated status
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- OS roadmap Phase 4 / §3 — answered decisions always create work orders;
-- risky ones wait in a gated state until the operator approves dispatch.
-- ============================================================================

BEGIN;

ALTER TABLE public.agent_work_orders
  DROP CONSTRAINT IF EXISTS agent_work_orders_status_check;

ALTER TABLE public.agent_work_orders
  ADD CONSTRAINT agent_work_orders_status_check
  CHECK (status IN ('queued','gated','claimed','dispatched','building','pr_open','done','failed','dead_lettered','cancelled'));

ALTER TABLE public.agent_work_orders
  ADD COLUMN IF NOT EXISTS gated_reason text,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

COMMENT ON COLUMN public.agent_work_orders.gated_reason IS
  'Phase 4 dispatch gate reason. NULL unless status is gated; examples: authorize_class, over_cost_cap, destructive_class, production_class.';
COMMENT ON COLUMN public.agent_work_orders.approved_by IS
  'Operator identity that approved a gated work order for daemon pickup.';
COMMENT ON COLUMN public.agent_work_orders.approved_at IS
  'Timestamp when a gated work order moved back to queued for daemon pickup.';

-- Recreate the per-app active runner mutex explicitly after adding gated.
-- Gated orders are not running and should not block another work order for the
-- same app; claimed/dispatched/building are the only active repo states.
DROP INDEX IF EXISTS public.agent_work_orders_active_app_mutex;
CREATE UNIQUE INDEX agent_work_orders_active_app_mutex
  ON public.agent_work_orders (app_id)
  WHERE deleted_at IS NULL AND status IN ('claimed','dispatched','building');

COMMIT;

