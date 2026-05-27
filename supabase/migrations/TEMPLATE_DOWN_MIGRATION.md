# Down migration template

Command Center migrations use a soft, operator-run rollback convention:

> Down migrations live as commented-out SQL blocks at the bottom of each migration file, marked with `-- Down migration (commented; copy/paste to revert)`.

This is intentionally not an automated rollback framework. Supabase migrations in this repo are applied as forward-only production changes; the down block is a copy/paste recipe for a human operator when a safe revert is needed.

## Convention for new migrations

Add the down block at the bottom of the next migration you author. If a down migration would be unsafe or misleading, include a short commented note instead of fake revert SQL.

```sql
-- ==========================================================================
-- Down migration (commented; copy/paste to revert)
-- ==========================================================================
-- BEGIN;
--
-- -- Reverse only the objects/data introduced by this migration.
-- -- Example:
-- -- DROP POLICY IF EXISTS "example_select" ON public.example_table;
-- -- DROP INDEX IF EXISTS public.example_table_created_at_idx;
-- -- ALTER TABLE public.example_table DROP COLUMN IF EXISTS example_column;
--
-- COMMIT;
```

For irreversible or operationally risky changes:

```sql
-- ==========================================================================
-- Down migration (commented; copy/paste to revert)
-- ==========================================================================
-- No safe down migration: explain why the change cannot be reverted in-place,
-- or point to the follow-up migration/operator runbook that should be used.
```

## Current status

This is a soft convention only. As of 2026-05-27, 24 of 52 existing migrations follow it and 28 do not. Do not retroactively backfill old migrations just to satisfy this template, and do not add a lint rule yet.
