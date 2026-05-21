-- ============================================================================
-- Migration 015: cc_decision_answers — operator decision answer ledger
-- Target: the control-plane Supabase project (gsvhuzpysxaegoecwjmf)
--
-- OS roadmap Phase 2 / §9 — records enumerated operator answers against
-- cc_issues. This stores the answer value and option snapshot only; client
-- business detail stays in the client data plane behind cc_export_detail().
-- ============================================================================

BEGIN;

-- Review-blocker MVP annotations need a small control-plane memory slot on the
-- issue ledger. 007 did not include it; make the add idempotent for safety.
ALTER TABLE public.cc_issues
  ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.cc_issues.context IS
  'Control-plane issue annotations, such as a blocker linked to a client-side decision ref. Never stores client business payloads.';

CREATE TABLE IF NOT EXISTS public.cc_decision_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES public.cc_issues(id) ON DELETE RESTRICT,
  app_id uuid NOT NULL REFERENCES public.registry_apps(id) ON DELETE RESTRICT,
  decision_external_ref text,
  answer_value text NOT NULL,
  answer_options_snapshot jsonb NOT NULL,
  rationale text,
  risk_class text NOT NULL CHECK (risk_class IN ('auto','authorize','destructive','production')),
  answered_by text NOT NULL,
  answered_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

COMMENT ON TABLE public.cc_decision_answers IS
  'Phase 2 operator decision answers. Enumerated answer values only; free-text rationale is operator context, not agent instruction.';
COMMENT ON COLUMN public.cc_decision_answers.decision_external_ref IS
  'Client-side decision identifier from cc_export_detail(); the decision content remains in the client app.';
COMMENT ON COLUMN public.cc_decision_answers.answer_value IS
  'Enumerated option id selected by the operator. Never arbitrary customer free text.';
COMMENT ON COLUMN public.cc_decision_answers.answer_options_snapshot IS
  'The enumerated option set exposed at answer time, retained for audit.';
COMMENT ON COLUMN public.cc_decision_answers.dispatched_at IS
  'Reserved for Phase 4 when answered decisions can dispatch work orders.';

CREATE INDEX IF NOT EXISTS cc_decision_answers_app_answered_idx
  ON public.cc_decision_answers (app_id, answered_at DESC)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS cc_decision_answers_touch ON public.cc_decision_answers;
CREATE TRIGGER cc_decision_answers_touch
  BEFORE UPDATE ON public.cc_decision_answers
  FOR EACH ROW EXECUTE FUNCTION public.fn_cc_touch_updated_at();

ALTER TABLE public.cc_decision_answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cc_decision_answers_service_all ON public.cc_decision_answers;
CREATE POLICY cc_decision_answers_service_all
  ON public.cc_decision_answers FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Explicitly remove browser/client paths for now. The edge function is the only
-- Phase 2 access path and runs with service_role after host/read-token auth.
DROP POLICY IF EXISTS cc_decision_answers_auth_read ON public.cc_decision_answers;
DROP POLICY IF EXISTS cc_decision_answers_anon_read ON public.cc_decision_answers;

REVOKE ALL ON public.cc_decision_answers FROM anon;
REVOKE ALL ON public.cc_decision_answers FROM authenticated;
GRANT ALL ON public.cc_decision_answers TO service_role;

COMMIT;

-- ============================================================================
-- Down migration (commented; copy/paste to revert)
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.cc_decision_answers;
--   ALTER TABLE public.cc_issues DROP COLUMN IF EXISTS context;
-- COMMIT;
