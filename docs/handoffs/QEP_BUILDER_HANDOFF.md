# Handoff to the QEP code builder — Tier 1 federation cutover

**You are:** an AI code builder working inside the QEP project (`lewis4x4/qep`).
**You have:** direct write access to QEP's Supabase data plane (`iciddijgonywtxoelous`) via the QEP repo's migration tooling.
**This handoff is from:** the BlackRock Command Center orchestrator. The Command Center is a separate platform that aggregates QEP + future client apps under one operator console.

---

## What you're being asked to do

Apply one self-contained migration on the QEP data plane that installs the **Command Center cockpit federation contract**. After this lands, the Command Center cockpit at `/apps/qep` will render real QEP roadmap items, open decisions, and Linear sync health — read through a scoped role that has zero direct table access.

This is a **safety-positive** change: nothing you do will let the Command Center read raw QEP tables, only the safe views and the contract function listed below.

You're getting this handoff because two attempts via the Supabase SQL editor hit operational issues (Supabase-side permission quirks + a connection drop). With direct DB access via the QEP migration tooling, those constraints disappear.

---

## The architecture in one paragraph

The Command Center is a **control plane** at Supabase project `gsvhuzpysxaegoecwjmf`. It holds the app registry, work-order queue, audit log — no client business data, ever. Each client app (QEP today, SCC + others later) keeps its own Supabase project. The control plane reads from each client via two narrow contract functions on the client side: `cc_export_snapshot()` (aggregate counts, polled every 5 min) and `cc_export_detail(text, text)` (item-level reads for the cockpit). Both functions are intentionally narrow surfaces — the client app owns exactly which columns they expose.

`cc_export_snapshot()` already exists on QEP (it's been polled by the Command Center Aggregator since the original setup). This migration **does NOT touch it** — its security mode conversion is a separate follow-up (see "Deferred to Tier 1.5" at the bottom).

This migration installs `cc_export_detail(text, text)` and the safe-view layer it reads from. After this, the Command Center cockpit can fetch item-level QEP data through a JWT signed with `role: "command_center"` — without that role ever holding `SELECT` on raw QEP tables.

---

## The federation contract — what this migration enforces

| Role | What it can do | What it cannot do |
|---|---|---|
| `command_center` | `EXECUTE public.cc_export_detail(text, text)` | Read raw QEP tables. Read raw QEP views. Anything outside `EXECUTE` on the two contract functions. |
| `cc_contract_owner` | Hold `SELECT` on QEP source tables/views. Own `cc_export_detail` so it runs under DEFINER with the right grants. | Be assumed via JWT — `NOLOGIN`. Has no PostgREST exposure. |
| Three safe views (`cc_safe_roadmap_items`, `cc_safe_decision_items`, `cc_safe_sync_items`) | Project exactly the columns the cockpit needs. Filter out internal-only rows (e.g. answered decisions). | Expose customer PII, raw notes, secrets, or columns outside the cockpit contract. |

`command_center` only ever calls `cc_export_detail()`. Because that function is `SECURITY DEFINER` and owned by `cc_contract_owner`, it runs with `cc_contract_owner`'s grants — which include the safe views. `command_center` itself has no `SELECT` privileges anywhere.

---

## The SQL — full migration, single transaction

Apply this via the QEP repo's migration tooling (it should land cleanly with direct DB access — the SQL editor is what kept failing). Idempotent; safe to re-run.

```sql
-- ============================================================================
-- QEP Tier 1 — Command Center cockpit federation contract
--
-- Installs:
--   - command_center role (NOLOGIN, granted to authenticator for PostgREST role-switch)
--   - cc_contract_owner role (NOLOGIN, owns the function under DEFINER)
--   - Three safe views projecting the cockpit-safe column subset
--   - cc_export_detail(text, text) SECURITY DEFINER, owned by cc_contract_owner
--
-- Does NOT touch:
--   - cc_export_snapshot() — deferred to Tier 1.5 (see bottom of handoff)
--   - Any existing QEP business table (only adds GRANT SELECT to cc_contract_owner)
--
-- All steps are idempotent. Single transaction; safe to retry on failure.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_center') THEN
    CREATE ROLE command_center NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cc_contract_owner') THEN
    CREATE ROLE cc_contract_owner NOLOGIN;
  END IF;
END$$;

-- PostgREST switches into role: "command_center" claim from the JWT. Needs
-- authenticator to be a member of command_center.
GRANT command_center TO authenticator;

-- The role running this migration must be a member of cc_contract_owner to
-- execute ALTER FUNCTION ... OWNER TO cc_contract_owner below. Idempotent.
GRANT cc_contract_owner TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO command_center;
GRANT USAGE ON SCHEMA public TO cc_contract_owner;

-- ---------------------------------------------------------------------------
-- 2. cc_contract_owner gets SELECT on QEP source tables + views.
--    These grants stay on cc_contract_owner. They are NEVER granted to
--    command_center. command_center only EXECUTEs the function.
-- ---------------------------------------------------------------------------

GRANT SELECT ON public.qep_roadmap_tasks         TO cc_contract_owner;
GRANT SELECT ON public.qep_decisions             TO cc_contract_owner;
GRANT SELECT ON public.v_qep_roadmap_sync_health TO cc_contract_owner;

-- ---------------------------------------------------------------------------
-- 3. Safe views — map QEP's real columns to the cockpit's expected shape.
--    Column mappings derived from QEP's actual schema (see Tier 1 design doc).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.cc_safe_roadmap_items AS
  SELECT
    id::text             AS id,
    stream,
    wave,
    title,
    ship_state           AS status,
    owner,
    sort_order::text     AS priority,
    blocking_decision    AS blocker,
    updated_at
  FROM public.qep_roadmap_tasks;

CREATE OR REPLACE VIEW public.cc_safe_decision_items AS
  SELECT
    id::text             AS id,
    question_plain       AS title,
    owner_role           AS owner,
    status,
    code                 AS source_ref,
    options,
    updated_at,
    CASE
      WHEN lower(coalesce(decision_class::text, ''))
        IN ('auto', 'authorize', 'destructive', 'production')
        THEN lower(decision_class::text)
      ELSE 'authorize'
    END                  AS risk_class,
    EXTRACT(DAY FROM (now() - created_at))::int AS age_days,
    CASE
      WHEN lower(coalesce(owner_role, '')) LIKE 'client%'
        THEN 'client'
      ELSE 'operator'
    END                  AS owner_kind
  FROM public.qep_decisions
  WHERE answered_at IS NULL;

CREATE OR REPLACE VIEW public.cc_safe_sync_items AS
  SELECT
    'linear'::text       AS source,
    CASE
      WHEN error_count   > 0 THEN 'error'
      WHEN pending_count > 0 THEN 'pending'
      ELSE                       'healthy'
    END                  AS status,
    total_tasks,
    mirrored_tasks,
    pending_count,
    error_count,
    last_synced_at       AS last_checked
  FROM public.v_qep_roadmap_sync_health;

GRANT SELECT ON public.cc_safe_roadmap_items  TO cc_contract_owner;
GRANT SELECT ON public.cc_safe_decision_items TO cc_contract_owner;
GRANT SELECT ON public.cc_safe_sync_items     TO cc_contract_owner;

-- ---------------------------------------------------------------------------
-- 4. cc_export_detail(text, text) — SECURITY DEFINER, owned by cc_contract_owner.
--    The Command Center calls this through PostgREST RPC. command_center has
--    EXECUTE only; the function reads safe views under cc_contract_owner's grants.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cc_export_detail(
  p_section text DEFAULT 'all',
  p_cursor  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_section   text    := lower(coalesce(nullif(trim(p_section), ''), 'all'));
  v_limit     integer := 50;
  v_roadmap   jsonb   := jsonb_build_object('items', '[]'::jsonb, 'next_cursor', NULL);
  v_decisions jsonb   := jsonb_build_object('items', '[]'::jsonb, 'next_cursor', NULL);
  v_sync      jsonb   := jsonb_build_object('items', '[]'::jsonb, 'next_cursor', NULL);
BEGIN
  IF v_section NOT IN ('all', 'roadmap', 'decisions', 'sync') THEN
    RAISE EXCEPTION 'cc_export_detail: invalid section %', p_section
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_section IN ('all', 'roadmap') THEN
    SELECT jsonb_build_object(
      'items', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',         id,
        'stream',     stream,
        'wave',       wave,
        'title',      title,
        'status',     status,
        'owner',      owner,
        'priority',   priority,
        'blocker',    blocker,
        'updated_at', updated_at
      ))), '[]'::jsonb),
      'next_cursor', NULL
    ) INTO v_roadmap
    FROM (
      SELECT id, stream, wave, title, status, owner, priority, blocker, updated_at
      FROM public.cc_safe_roadmap_items
      ORDER BY updated_at DESC NULLS LAST
      LIMIT v_limit
    ) r;
  END IF;

  IF v_section IN ('all', 'decisions') THEN
    SELECT jsonb_build_object(
      'items', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id',          id,
        'title',       title,
        'owner',       owner,
        'owner_kind',  owner_kind,
        'risk_class',  risk_class,
        'options',     options,
        'status',      status,
        'age',         age_days::text || 'd',
        'source_ref',  source_ref,
        'updated_at',  updated_at
      ))), '[]'::jsonb),
      'next_cursor', NULL
    ) INTO v_decisions
    FROM (
      SELECT id, title, owner, owner_kind, risk_class, options, status, age_days, source_ref, updated_at
      FROM public.cc_safe_decision_items
      ORDER BY age_days DESC NULLS LAST
      LIMIT v_limit
    ) d;
  END IF;

  IF v_section IN ('all', 'sync') THEN
    SELECT jsonb_build_object(
      'items', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'source',         source,
        'status',         status,
        'total_tasks',    total_tasks,
        'mirrored_tasks', mirrored_tasks,
        'pending_count',  pending_count,
        'error_count',    error_count,
        'last_checked',   last_checked
      ))), '[]'::jsonb),
      'next_cursor', NULL
    ) INTO v_sync
    FROM public.cc_safe_sync_items;
  END IF;

  RETURN jsonb_build_object(
    'roadmap',   v_roadmap,
    'decisions', v_decisions,
    'sync',      v_sync
  );
END;
$fn$;

ALTER FUNCTION public.cc_export_detail(text, text) OWNER TO cc_contract_owner;

COMMENT ON FUNCTION public.cc_export_detail(text, text) IS
  'Command Center cockpit detail contract. SECURITY DEFINER. Owned by cc_contract_owner. command_center holds EXECUTE only.';

REVOKE EXECUTE ON FUNCTION public.cc_export_detail(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cc_export_detail(text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.cc_export_detail(text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.cc_export_detail(text, text) TO command_center;

COMMIT;
```

---

## Known failure modes the SQL editor hit (you can ignore these with direct DB access)

These already failed once each via the Supabase SQL editor, in case the migration tooling has similar quirks:

1. **`postgres` is not a Supabase superuser.** A prior version of this SQL tried to reassign `cc_export_snapshot()` ownership to `postgres` and convert it to `SECURITY DEFINER`. That broke immediately with `permission denied for view v_qep_roadmap_sync_health` because that view is owned by `supabase_admin` and `postgres` lacks `SELECT` on it. **The current SQL above does not touch `cc_export_snapshot()`** — that's deferred to Tier 1.5 (see below). If you discover the migration tooling runs as a role with broader privileges, this might still be relevant for the Tier 1.5 follow-up.

2. **`ALTER FUNCTION ... OWNER TO cc_contract_owner` requires SET ROLE membership.** PostgreSQL won't let a role reassign object ownership unless it's a member of the target role. The fix is the `GRANT cc_contract_owner TO CURRENT_USER` line just after the role creation. **The current SQL above already includes this line** — keep it; it's idempotent.

3. **Connection drops mid-transaction.** The Supabase SQL editor dropped the connection on the third attempt. Direct DB access shouldn't hit this. If somehow it does, the migration is a single `BEGIN/COMMIT` so any drop produces a clean rollback — just retry.

---

## What to send back when done

Two artifacts. Paste both responses into the conversation.

### Artifact 1 — Verify the cockpit federation works

```sql
SET ROLE command_center;
SELECT public.cc_export_detail('all', NULL);
RESET ROLE;
```

Expected: a `jsonb` value with three keys (`roadmap`, `decisions`, `sync`), each containing an `items` array populated with real QEP data. Specifically:

- `roadmap.items` — recent roadmap tasks (up to 50, ordered by `updated_at desc`).
- `decisions.items` — currently-open decisions (`answered_at IS NULL`, ordered by `age_days desc`).
- `sync.items` — one row from `v_qep_roadmap_sync_health` with derived status.

Paste the actual JSON output back (or a truncated form if it's large; full structure of the first item in each section is enough).

### Artifact 2 — Negative verification (the federation boundary holds)

```sql
SET ROLE command_center;
SELECT * FROM public.qep_decisions LIMIT 1;
SELECT * FROM public.qep_roadmap_tasks LIMIT 1;
SELECT * FROM public.cc_safe_decision_items LIMIT 1;
RESET ROLE;
```

Expected: **all three should fail** with `permission denied`. That's the proof that `command_center` has no direct table or view access — only the function. Paste the error messages back (or just say "all three correctly returned permission denied").

### Artifact 3 — Function body for the Tier 1.5 follow-up

```sql
SELECT pg_get_functiondef(oid) AS body
  FROM pg_proc
 WHERE proname = 'cc_export_snapshot'
   AND pronamespace = 'public'::regnamespace;
```

This returns the full body of `cc_export_snapshot()`. Paste it back verbatim. The orchestrator uses it to compose Tier 1.5 (the snapshot function's safe conversion to `SECURITY DEFINER` with the right owner — see below).

---

## Deferred to Tier 1.5 (separate follow-up, not your job today)

`cc_export_snapshot()` currently exists on QEP as `SECURITY INVOKER` (inferred from behavior — service-role calls succeed, the function body references `supabase_admin`-owned views). For the cockpit federation, we don't need to touch it. For full god-credential retirement on the Command Center side, we'll eventually need to convert it to `SECURITY DEFINER` with an owner role that has `SELECT` on every relation the function reads.

That follow-up is composed once Artifact 3 (the function body) is in hand. It's not your job today — just send the body back and the orchestrator handles the next slice.

---

## Out of scope (do not do these)

- Do NOT modify, ALTER, or REASSIGN OWNED on `cc_export_snapshot()`. Leave it exactly as-is.
- Do NOT grant `SELECT` on any table to `command_center`. The whole point of this federation contract is that role has zero direct table access.
- Do NOT publish these views to the Supabase REST API surface beyond what the function needs. If your migration tooling has a "publish to API" toggle, leave the new views OFF.
- Do NOT change anything about `qep_roadmap_tasks`, `qep_decisions`, `v_qep_roadmap_sync_health`, or any existing QEP business object. The safe views are NEW objects.

---

## Rollback (if needed)

If anything goes sideways and you need to undo this migration cleanly:

```sql
BEGIN;
DROP FUNCTION IF EXISTS public.cc_export_detail(text, text);
DROP VIEW IF EXISTS public.cc_safe_roadmap_items;
DROP VIEW IF EXISTS public.cc_safe_decision_items;
DROP VIEW IF EXISTS public.cc_safe_sync_items;
-- Roles are intentionally left in place; they're harmless when empty.
-- Drop them only if explicitly requested:
-- REVOKE ALL ON ALL TABLES IN SCHEMA public FROM cc_contract_owner;
-- REVOKE ALL ON SCHEMA public FROM cc_contract_owner, command_center;
-- REVOKE command_center FROM authenticator;
-- REVOKE cc_contract_owner FROM CURRENT_USER;
-- DROP ROLE IF EXISTS command_center;
-- DROP ROLE IF EXISTS cc_contract_owner;
COMMIT;
```

The original `cc_export_snapshot()` is untouched in either direction.

---

That's everything. Apply when ready. Send the three artifacts back. Thanks for taking this off the SQL editor's broken path.
