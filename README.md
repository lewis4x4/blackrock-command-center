# BlackRock AI Command Center

One home to run every client app BlackRock AI builds — QEP, SCC, Circle of Life, Foundry, and beyond. Decision capture, build-progress aggregation, and AI-agent dispatch, unified.

**Architecture: federated.** Each client app keeps its own isolated Supabase project (its data plane). This Command Center is one shared control-plane project that holds the app registry, aggregated progress snapshots, and an audit log — and no client business data. A client app's data is never reachable from another client's context.

Full design and roadmaps live in `docs/` — the operating-system roadmap (the current plan), the strategic platform roadmap, and the home UI handoff.

---

## This repo

```
blackrock-command-center/
  README.md
  netlify.toml                          ← deploy config for web/
  docs/                                 ← roadmaps + design
    COMMAND_CENTER_OS_ROADMAP.md          ← the operating-system roadmap (current plan)
    BLACKROCK_COMMAND_CENTER_PLATFORM_ROADMAP.md
    COMMAND_CENTER_HOME_UI_HANDOFF.md
    prototypes/                           ← superseded HTML prototypes
  supabase/
    migrations/
      001_command_center_registry.sql   ← the keystone: the app registry
      002_register_qep_app.sql          ← QEP registered as app #1
      003_aggregator_schedule.sql       ← pg_cron Aggregator schedule
      004_registry_app_url.sql          ← per-app deep-link URL
      005_command_center_anon_read.sql  ← anon read (OS roadmap §1 — to be hardened)
    functions/
      aggregator/                       ← polls every app's cc_export_snapshot()
  scripts/
      aggregator-once.mjs               ← one-shot Aggregator (the cron's seed)
  web/                                  ← the operator app (Vite + React + TS)
```

`001` is the 593-equivalent for the platform — the registry of apps, their isolated Supabase / Linear / repo / owners / integrations, the append-only progress snapshots, the audit log, and the home view.

### web/ — the operator app

The Command Center home + shell. Vite + React + TypeScript, plain CSS. Three-band
home: triage queue, project grid, activity feed — every value wired to a
control-plane source (`v_command_center_home`, `cc_audit_events`,
`registry_app_snapshots`, `registry_app_integrations`).

```
cd web
npm install
cp .env.example .env      # demo mode is on by default
npm run dev               # http://localhost:5173
```

Demo mode renders sample rows with no backend. Set `VITE_DEMO_MODE=false` in
`.env` to read the live control plane (requires an operator sign-in). Deploys to
Netlify via the repo-root `netlify.toml`.

---

## Phase 0 — stand it up

1. **Create the control-plane Supabase project.** Name it `blackrock-command-center`. This is the one shared management database. It will hold the registry — never client data.
2. **Connect the Supabase MCP to it** (same as you did for QEP) so migrations can be applied and verified directly.
3. **Apply `001_command_center_registry.sql`.**
4. **Create the GitHub repo** `blackrock-command-center` and commit this seed.
5. **Create the BlackRock AI GitHub App** — per-repo, short-lived installation tokens. Retire the personal access token.
6. **Stand up a secrets manager** (Doppler or 1Password class). Every client service-role key, Linear key, and webhook secret lives there; the registry stores only `*_secret_ref` pointers.

## Phase 1 — first light

7. **[DONE] Register QEP as app #1** — registry rows inserted (Supabase ref `iciddijgonywtxoelous`, Linear team `QEP`, repo `lewis4x4/qep`, 5 owners, 7 integrations). Control-plane migration `002`.
8. **[DONE] Apply the `cc_export_snapshot()` contract** to QEP's Supabase — QEP migration `608`. The standard read function the Aggregator calls.
9. **[DONE] Build the Aggregator** — `supabase/functions/aggregator` edge function + the `cc-aggregator-hourly` pg_cron job (migration `003`). Polls every registered app and writes `registry_app_snapshots`.
10. **[DONE] Build the Command Center home** — the `web/` app: shell + triage / projects / activity, reading `v_command_center_home`. Demo mode works offline; live mode reads the control plane.

Phase 1 is done — you open one screen and see every project. After that, app building resumes — through the Command Center.

### Operator secrets (control-plane project)

The Aggregator needs two edge-function secrets on the control-plane project. Set them once:

```
supabase secrets set AGGREGATOR_TOKEN="<token>" --project-ref gsvhuzpysxaegoecwjmf
supabase secrets set SVC_KEY_QEP="<QEP service-role key>" --project-ref gsvhuzpysxaegoecwjmf
```

- `AGGREGATOR_TOKEN` — must equal the Supabase Vault secret `aggregator_token` (the cron job sends it as `X-Aggregator-Token`).
- `SVC_KEY_<SHORTCODE>` — each app's data-plane service-role key. The registry column `registry_app_supabase.service_secret_ref` holds the *name* of this secret, never the key.

---

## Conventions

Same house style as the QEP repo: `uuid` primary keys, `created_at` / `updated_at` / `deleted_at`, RLS on every table, `NNN_snake_case` migration names with no gaps. Secrets never live in a table — only `*_secret_ref` pointers into the secrets manager.
