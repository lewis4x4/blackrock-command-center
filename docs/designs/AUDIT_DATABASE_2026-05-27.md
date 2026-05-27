# Database audit — 2026-05-27

Scope audited: `supabase/migrations/**/*.sql` plus live linked Supabase introspection with `supabase db query --linked`. Stayed in the database lane; no edge function or frontend code changes.

## P0

No unresolved P0 findings.

- **RLS coverage:** all live base tables in `public` have RLS enabled. `agent_core.model_prices` has RLS disabled, but it is reference pricing/config data with only `service_role` table grants in the audited live schema, not user data.
- **Audit integrity:** `public.cc_audit_events` has no UPDATE/DELETE RLS policies. Live policies are `SELECT` and `INSERT` for `service_role`; no grantable role has UPDATE/DELETE/TRUNCATE. Immutable triggers are enabled for UPDATE, DELETE, and TRUNCATE.
- **Orphans / missing FK coverage:** no `app_id`, `issue_id`, `work_order_id`, `run_id`, `tenant_id`, `source_answer_id`, `decision_answer_id`, or `recipient_id` columns were found without FK constraints in the audited live base tables.
- **Leaky `USING (true)` policies:** live broad `USING (true)` policies on control-plane tables are service-role-only except a stale `registry_app_owners_auth_read` policy; authenticated grants on that table were revoked by migration 031, so the policy is not an active exposure path.

## P1

### Fixed — Task #33 duplicate decision answers

Finding: live `public.cc_decision_answers` had one active duplicate group for `(issue_id, decision_external_ref)`:

- `issue_id`: `9f808690-db4f-4168-a0f9-7639921412a8`
- `decision_external_ref`: `e4c13fc9-0661-445f-9196-6b76b9fc3f61`
- older answer soft-deleted: `95ed183c-5fb5-4fa6-a900-24d7b5f7f935` (`do_not_allow`, `rylee@qepusa.com`, created `2026-05-26T02:13:28Z`)
- kept active answer: `6202ed15-660f-4326-8f9e-ebdd86d50de6` (`disallow_prospect_quotes`, `brian.lewis@blackrockai.co`, created `2026-05-26T16:33:02Z`)

Fix in `supabase/migrations/052_audit_database_fixes.sql`:

- Soft-deletes older active duplicates while keeping the newest answer for each logical key.
- Inserts an audit event for any duplicate answer soft-deleted by the migration.
- Adds `cc_decision_answers_issue_decision_active_uidx`:
  `UNIQUE (issue_id, decision_external_ref) WHERE deleted_at IS NULL`.

Verification:

- Active duplicate groups after migration: `0`.
- Older task #33 answer has `deleted_at IS NOT NULL`: `1` row.
- Newer task #33 answer remains active: `1` row.
- Unique guard exists in live schema: `1` index.

### Fixed — Missing FK/read-path indexes

Finding: live FK index audit showed missing standalone support for several FK columns and sibling Performance audit requested decision-suppression/unresolved-issue lookup indexes.

Fix in `052_audit_database_fixes.sql` added these indexes:

- `cc_decision_answers_issue_idx`
- `agent_work_orders_source_answer_idx`
- `cc_artifacts_work_order_idx`
- `cc_artifacts_agent_run_idx`
- `cc_decision_email_sends_decision_answer_idx`
- `cc_decision_email_sends_recipient_idx`
- `cc_decision_email_sends_route_parent_idx`
- `registry_app_integrations_app_idx`
- `registry_app_owners_app_idx`
- `idx_agent_messages_tenant_created`
- `idx_oauth_states_tenant_expires`

Read-path indexes requested/confirmed from Performance audit:

- `cc_decision_answers_app_decision_ref_idx`
- `cc_decision_email_sends_app_decision_ref_idx`
- `cc_issues_unresolved_app_surfaced_idx`

Verification: live schema contains all 14 new indexes.

### Fixed — `cc_decision_email_sends` superseded state consistency

Finding: migration 051 added enum state `superseded` and `superseded_at`, but no schema-level guard required timestamp evidence when a send enters that terminal-ish state.

Fix in `052_audit_database_fixes.sql`:

- Added `cc_decision_email_sends_superseded_at_chk`:
  `CHECK (state <> 'superseded' OR superseded_at IS NOT NULL)`.

Verification:

- Existing live rows violating the check before migration: `0`.
- Constraint exists after migration: `1`.

## P2 / documented only

- Several historical migrations are not fully re-runnable/idempotent (`024`, `025`, `031`, `038`, `040`, `043`). They are already applied; per instruction, no existing migration files were modified.
- Some tables intentionally diverge from the full `created_at` / `updated_at` / `deleted_at` convention:
  - append-only/singleton tables such as `cc_audit_events`, `registry_app_snapshots`, `cc_gmail_history_cursor`, and `cc_decision_inbound_extra_replies`
  - Agent Core telemetry/config tables such as rollups, counters, messages, and pricing
- Stale broad grants remain visible on a few legacy objects (for example historical anon grants on registry companion tables and all-grants on `v_command_center_home`), but live RLS policies prevent table access where no anon policy exists. Recommend a later least-privilege grant cleanup pass coordinated with the Security agent.
- `public.cc_decision_email_sends_issue_app_fk` is the only FK whose exact composite `(issue_id, app_id)` order is not backed by a matching composite index. It is still covered by `cc_decision_email_sends_issue_idx` for issue-parent lookups and by app/state indexes for app queries; left as documented rather than adding a redundant composite index.
- `cc_operator_handoffs` is mutable and lacks `updated_at`; adding it would be low-risk, but was left as P2 because no P0/P1 integrity or performance issue was observed.

## Migration applied

Applied to linked Supabase project:

- `supabase/migrations/052_audit_database_fixes.sql`

`supabase migration list --linked` now shows local and remote aligned through `052`.

## Verification log

Commands run:

- `supabase migration list --linked`
- `supabase db push --linked --include-all --yes`
- `supabase db query --linked` live checks for RLS, policies, grants, FK index coverage, audit triggers/policies/grants, duplicate answers, superseded consistency, and new index/constraint existence

Key live verification results:

- migration `052` present locally and remotely
- active duplicate answer groups: `0`
- task #33 older duplicate soft-deleted: `1`
- task #33 newer answer active: `1`
- unique answer guard exists: `1`
- superseded check exists: `1`
- new index count: `14`
- `cc_audit_events` immutable UPDATE/DELETE/TRUNCATE triggers enabled and no UPDATE/DELETE policies present
