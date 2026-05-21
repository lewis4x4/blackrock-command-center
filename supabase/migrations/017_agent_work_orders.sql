-- ============================================================================
-- Migration 017: agent_work_orders — persistent runner queue
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- OS roadmap Phase 3 / §4 — the work-order queue. The build target is bound
-- server-side from registry_app_repo; producers supply intent, not repo choice.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  app_id uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE RESTRICT,
  target_repo text NOT NULL,
  target_branch text NOT NULL DEFAULT 'main',
  change_spec jsonb NOT NULL,
  source_answer_id uuid REFERENCES public.cc_decision_answers(id) ON DELETE SET NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('auto','authorize','destructive','production')),
  idempotency_key text NOT NULL UNIQUE,
  cost_cap_usd numeric(10,2),

  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','claimed','dispatched','building','pr_open','done','failed','dead_lettered','cancelled')),
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  last_error text,
  dispatched_at timestamptz,
  pr_opened_at timestamptz,
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  pr_url text,

  CONSTRAINT agent_work_orders_change_spec_object CHECK (jsonb_typeof(change_spec) = 'object'),
  CONSTRAINT agent_work_orders_cost_cap_nonnegative CHECK (cost_cap_usd IS NULL OR cost_cap_usd >= 0),
  CONSTRAINT agent_work_orders_attempt_count_nonnegative CHECK (attempt_count >= 0)
);

COMMENT ON TABLE public.agent_work_orders IS
  'Phase 3 runner queue. One row per build task, with atomic claim/lease/dead-letter RPCs.';
COMMENT ON COLUMN public.agent_work_orders.target_repo IS
  'Server-bound GitHub repo from registry_app_repo.github_repo. Producer payloads must never choose this value.';
COMMENT ON COLUMN public.agent_work_orders.target_branch IS
  'Server-bound branch from registry_app_repo.default_branch, stored explicitly per work order.';
COMMENT ON COLUMN public.agent_work_orders.change_spec IS
  'Structured intent only: intent, affected_area, acceptance_criteria, constraints, and provenance-safe values.';
COMMENT ON COLUMN public.agent_work_orders.source_answer_id IS
  'Nullable provenance link to cc_decision_answers. Not every work order originates from a decision answer.';

CREATE INDEX IF NOT EXISTS agent_work_orders_app_status_idx
  ON public.agent_work_orders (app_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_work_orders_status_lease_idx
  ON public.agent_work_orders (status, lease_expires_at)
  WHERE deleted_at IS NULL;

-- Belt-and-suspenders repo mutex. The claim RPC also checks this, but the
-- partial unique index makes two active runner clones for one app a DB error,
-- not a race.
CREATE UNIQUE INDEX IF NOT EXISTS agent_work_orders_active_app_mutex
  ON public.agent_work_orders (app_id)
  WHERE deleted_at IS NULL AND status IN ('claimed','dispatched','building');

CREATE OR REPLACE FUNCTION public.fn_agent_work_orders_bind_repo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_repo public.registry_app_repo%ROWTYPE;
BEGIN
  SELECT * INTO v_repo
  FROM public.registry_app_repo
  WHERE app_id = NEW.app_id;

  IF v_repo.id IS NULL THEN
    RAISE EXCEPTION 'no registry_app_repo row for app_id %', NEW.app_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.target_repo := v_repo.github_repo;
  NEW.target_branch := COALESCE(NULLIF(v_repo.default_branch, ''), 'main');
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_agent_work_orders_bind_repo() IS
  'Binds agent_work_orders.target_repo/target_branch from registry_app_repo before insert or app_id changes.';

DROP TRIGGER IF EXISTS agent_work_orders_bind_repo ON public.agent_work_orders;
CREATE TRIGGER agent_work_orders_bind_repo
  BEFORE INSERT OR UPDATE OF app_id ON public.agent_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_agent_work_orders_bind_repo();

DROP TRIGGER IF EXISTS agent_work_orders_touch ON public.agent_work_orders;
CREATE TRIGGER agent_work_orders_touch
  BEFORE UPDATE ON public.agent_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.agent_work_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_work_orders_service_all ON public.agent_work_orders;
CREATE POLICY agent_work_orders_service_all
  ON public.agent_work_orders FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS agent_work_orders_auth_read ON public.agent_work_orders;
DROP POLICY IF EXISTS agent_work_orders_anon_read ON public.agent_work_orders;

REVOKE ALL ON public.agent_work_orders FROM anon;
REVOKE ALL ON public.agent_work_orders FROM authenticated;
GRANT ALL ON public.agent_work_orders TO service_role;

COMMIT;
