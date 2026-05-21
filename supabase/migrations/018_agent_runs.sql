-- ============================================================================
-- Migration 018: agent_runs — runner cost and outcome ledger
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- OS roadmap Phase 3 / §4 — every runner attempt writes cost, usage, PR, and
-- outcome back to the control plane.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  work_order_id uuid NOT NULL REFERENCES public.agent_work_orders(id) ON DELETE RESTRICT,
  runner text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  heartbeat_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','failed','timed_out','cancelled')),
  cost_usd numeric(10,2),
  tokens_input int,
  tokens_output int,
  pr_url text,
  notes text,

  CONSTRAINT agent_runs_cost_nonnegative CHECK (cost_usd IS NULL OR cost_usd >= 0),
  CONSTRAINT agent_runs_tokens_input_nonnegative CHECK (tokens_input IS NULL OR tokens_input >= 0),
  CONSTRAINT agent_runs_tokens_output_nonnegative CHECK (tokens_output IS NULL OR tokens_output >= 0)
);

COMMENT ON TABLE public.agent_runs IS
  'Phase 3 runner ledger. One row per runner attempt with status, usage, cost, and PR URL.';
COMMENT ON COLUMN public.agent_runs.runner IS
  'Adapter identifier, e.g. claude_code_goal, cursor_bg, codex, gemini, opencode.';

CREATE INDEX IF NOT EXISTS agent_runs_work_order_started_idx
  ON public.agent_runs (work_order_id, started_at DESC);

DROP TRIGGER IF EXISTS agent_runs_touch ON public.agent_runs;
CREATE TRIGGER agent_runs_touch
  BEFORE UPDATE ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_runs_service_all ON public.agent_runs;
CREATE POLICY agent_runs_service_all
  ON public.agent_runs FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS agent_runs_auth_read ON public.agent_runs;
DROP POLICY IF EXISTS agent_runs_anon_read ON public.agent_runs;

REVOKE ALL ON public.agent_runs FROM anon;
REVOKE ALL ON public.agent_runs FROM authenticated;
GRANT ALL ON public.agent_runs TO service_role;

COMMIT;
