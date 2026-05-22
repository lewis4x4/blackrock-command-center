#!/usr/bin/env node
// ============================================================================
// qep-introspect.mjs — read-only QEP contract introspection.
//
// Purpose:
//   One-shot preflight against QEP's Supabase data plane before applying the
//   Tier 1 Command Center migration. It checks the current cc_export_snapshot()
//   and cc_export_detail(text,text) state, candidate Phase 1b source objects,
//   and the authenticator / command_center roles.
//
// Safety:
//   - Writes nothing.
//   - Creates no helper functions.
//   - Drops nothing.
//   - Exact psql mode runs with PGOPTIONS='-c default_transaction_read_only=on'.
//   - PostgREST fallback uses GETs plus POSTs to the existing read contracts.
//
// Usage:
//   QEP_SERVICE_ROLE_KEY='paste-service-role-key' \
//     node scripts/qep-introspect.mjs
//
// Optional exact mode, if the operator has a direct read-capable Postgres URL:
//   QEP_SERVICE_ROLE_KEY='...' QEP_DATABASE_URL='postgres://...' \
//     node scripts/qep-introspect.mjs
//
// Optional behavioral check with a minted command_center/read JWT:
//   QEP_SERVICE_ROLE_KEY='...' READ_KEY_QEP='paste-command-center-jwt' \
//     node scripts/qep-introspect.mjs
//
// Required env:
//   QEP_SERVICE_ROLE_KEY
// Optional env:
//   QEP_PROJECT_URL        default https://iciddijgonywtxoelous.supabase.co
//   QEP_DATABASE_URL       enables exact pg_catalog / information_schema SELECTs
//   READ_KEY_QEP           command_center JWT for behavioral RPC comparison
//   QEP_COMMAND_CENTER_JWT alias for READ_KEY_QEP
//   QEP_ANON_KEY           optional apikey to pair with READ_KEY_QEP
//
// After running:
//   unset QEP_SERVICE_ROLE_KEY QEP_DATABASE_URL READ_KEY_QEP QEP_COMMAND_CENTER_JWT QEP_ANON_KEY
// ============================================================================

import { execFileSync } from 'node:child_process';

const DEFAULT_QEP_URL = 'https://iciddijgonywtxoelous.supabase.co';
const QEP_PROJECT_URL = stripTrailingSlash(process.env.QEP_PROJECT_URL || DEFAULT_QEP_URL);
const SERVICE_KEY = process.env.QEP_SERVICE_ROLE_KEY || '';
const DATABASE_URL = process.env.QEP_DATABASE_URL || '';
const COMMAND_CENTER_JWT = process.env.QEP_COMMAND_CENTER_JWT || process.env.READ_KEY_QEP || '';
const COMMAND_CENTER_APIKEY = process.env.QEP_ANON_KEY || COMMAND_CENTER_JWT;

const SOURCE_OBJECTS = [
  {
    name: 'qep_roadmap_tasks',
    kind: 'table',
    candidateColumns: ['id', 'stream', 'wave', 'title', 'ship_state', 'owner', 'priority', 'blocker', 'updated_at', 'deleted_at'],
  },
  {
    name: 'qep_decisions',
    kind: 'table',
    candidateColumns: ['id', 'title', 'owner', 'status', 'created_at', 'source_ref', 'updated_at', 'deleted_at', 'owner_kind', 'risk_class'],
  },
  {
    name: 'v_qep_roadmap_sync_health',
    kind: 'view',
    candidateColumns: ['source', 'status', 'total_tasks', 'mirrored_tasks', 'pending_count', 'error_count', 'stale_pending_count', 'last_checked'],
  },
];

if (!SERVICE_KEY) {
  console.error('Missing QEP_SERVICE_ROLE_KEY. Paste it for this one run, then unset it.');
  process.exit(1);
}

const state = {
  approach: [],
  exact: null,
  postgrestMetadata: null,
  rpc: {},
  sourceObjects: [],
  roles: null,
  errors: [],
};

await main();

async function main() {
  printHeader();

  if (DATABASE_URL) {
    try {
      state.exact = runExactPsqlMode(DATABASE_URL);
      state.approach.push('Exact metadata mode: psql SELECTs against pg_catalog, pg_tables/pg_views, information_schema.columns, and pg_roles.');
    } catch (error) {
      state.errors.push(`Exact psql mode failed: ${formatError(error)}`);
    }
  }

  if (!state.exact) {
    state.postgrestMetadata = await tryPostgrestMetadataMode();
    if (state.postgrestMetadata.available) {
      state.approach.push('Direct PostgREST metadata mode: pg_catalog/information_schema endpoints were exposed.');
    } else {
      state.approach.push('Behavioral fallback mode: pg_catalog was not exposed over PostgREST, so function metadata is inferred from RPC behavior where possible.');
    }
  }

  state.rpc.serviceRoleSnapshot = await callContractRpc('cc_export_snapshot', {}, SERVICE_KEY, SERVICE_KEY);
  state.rpc.serviceRoleDetail = await callContractRpc(
    'cc_export_detail',
    { p_section: 'all', p_cursor: null },
    SERVICE_KEY,
    SERVICE_KEY,
  );

  if (COMMAND_CENTER_JWT) {
    state.rpc.commandCenterSnapshot = await callContractRpc('cc_export_snapshot', {}, COMMAND_CENTER_JWT, COMMAND_CENTER_APIKEY);
    state.rpc.commandCenterDetail = await callContractRpc(
      'cc_export_detail',
      { p_section: 'all', p_cursor: null },
      COMMAND_CENTER_JWT,
      COMMAND_CENTER_APIKEY,
    );
  }

  state.sourceObjects = state.exact?.sourceObjects || await inspectSourceObjectsViaRest();
  state.roles = state.exact?.roles || state.postgrestMetadata?.roles || await tryRolesViaRest();

  printApproach();
  printFunctionSection('public.cc_export_snapshot()', getFunctionMeta('cc_export_snapshot()'), state.rpc.serviceRoleSnapshot, state.rpc.commandCenterSnapshot);
  printFunctionSection('public.cc_export_detail(text, text)', getFunctionMeta('cc_export_detail(text,text)'), state.rpc.serviceRoleDetail, state.rpc.commandCenterDetail);
  printSourceObjects();
  printRoles();
  printErrors();
  printVerdict();
}

function printHeader() {
  section('QEP Command Center contract introspection');
  line(`Project URL: ${QEP_PROJECT_URL}`);
  line(`Timestamp:   ${new Date().toISOString()}`);
  line('Safety:      read-only checks only; no CREATE, ALTER, DROP, INSERT, UPDATE, or DELETE.');
}

function runExactPsqlMode(databaseUrl) {
  ensurePsqlAvailable();

  const functions = psqlJson(databaseUrl, `
    WITH funcs AS (
      SELECT
        CASE
          WHEN p.proname = 'cc_export_snapshot' AND p.pronargs = 0 THEN 'cc_export_snapshot()'
          WHEN p.proname = 'cc_export_detail' AND oidvectortypes(p.proargtypes) = 'text, text' THEN 'cc_export_detail(text,text)'
        END AS signature,
        p.proname,
        oidvectortypes(p.proargtypes) AS arg_types,
        pg_get_function_identity_arguments(p.oid) AS identity_args,
        p.prosecdef,
        p.proacl::text AS proacl,
        p.proowner::regrole::text AS proowner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (
          (p.proname = 'cc_export_snapshot' AND p.pronargs = 0)
          OR (p.proname = 'cc_export_detail' AND oidvectortypes(p.proargtypes) = 'text, text')
        )
    )
    SELECT coalesce(jsonb_object_agg(signature, jsonb_build_object(
      'exists', true,
      'proname', proname,
      'arg_types', arg_types,
      'identity_args', identity_args,
      'prosecdef', prosecdef,
      'proacl', proacl,
      'proowner', proowner
    )), '{}'::jsonb)
    FROM funcs
    WHERE signature IS NOT NULL;
  `);

  const sourceObjects = psqlJson(databaseUrl, `
    WITH candidates(name) AS (
      VALUES
        ('qep_roadmap_tasks'),
        ('qep_decisions'),
        ('v_qep_roadmap_sync_health')
    )
    SELECT jsonb_agg(jsonb_build_object(
      'name', c.name,
      'exists', EXISTS (
        SELECT 1
        FROM pg_class pc
        JOIN pg_namespace pn ON pn.oid = pc.relnamespace
        WHERE pn.nspname = 'public'
          AND pc.relname = c.name
          AND pc.relkind IN ('r', 'p', 'v', 'm')
      ),
      'in_pg_tables', EXISTS (
        SELECT 1 FROM pg_tables t
        WHERE t.schemaname = 'public' AND t.tablename = c.name
      ),
      'in_pg_views', EXISTS (
        SELECT 1 FROM pg_views v
        WHERE v.schemaname = 'public' AND v.viewname = c.name
      ),
      'relkind', (
        SELECT pc.relkind::text
        FROM pg_class pc
        JOIN pg_namespace pn ON pn.oid = pc.relnamespace
        WHERE pn.nspname = 'public' AND pc.relname = c.name
        LIMIT 1
      ),
      'columns', coalesce((
        SELECT jsonb_agg(ic.column_name ORDER BY ic.ordinal_position)
        FROM information_schema.columns ic
        WHERE ic.table_schema = 'public'
          AND ic.table_name = c.name
      ), '[]'::jsonb)
    ) ORDER BY c.name)
    FROM candidates c;
  `) || [];

  const roles = psqlJson(databaseUrl, `
    SELECT jsonb_build_object(
      'mode', 'exact_pg_roles',
      'authenticator_exists', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator'),
      'command_center_exists', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'command_center')
    );
  `);

  return { functions, sourceObjects, roles };
}

function ensurePsqlAvailable() {
  execFileSync('psql', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function psqlJson(databaseUrl, sql) {
  const output = execFileSync('psql', [
    '-X',
    '-q',
    '-t',
    '-A',
    '-v',
    'ON_ERROR_STOP=1',
    '-d',
    databaseUrl,
    '-c',
    sql,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PGOPTIONS: `${process.env.PGOPTIONS || ''} -c default_transaction_read_only=on`.trim(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  if (!output) return null;
  return JSON.parse(output.split('\n').filter(Boolean).at(-1));
}

async function tryPostgrestMetadataMode() {
  const result = { available: false, functions: {}, roles: null, notes: [] };

  const pgProc = await restGet('pg_proc?select=proname,pronargs,proargtypes,prosecdef,proacl,proowner&proname=in.(cc_export_snapshot,cc_export_detail)');
  if (pgProc.ok && Array.isArray(pgProc.json)) {
    result.available = true;
    result.notes.push('pg_proc was reachable, but proowner is an OID unless pg_roles is also exposed. Prefer exact psql mode for owner names.');
    for (const row of pgProc.json) {
      if (row.proname === 'cc_export_snapshot' && Number(row.pronargs) === 0) {
        result.functions['cc_export_snapshot()'] = { exists: true, ...row, mode: 'postgrest_pg_proc' };
      }
      if (row.proname === 'cc_export_detail') {
        result.functions['cc_export_detail(text,text)'] = { exists: true, ...row, mode: 'postgrest_pg_proc' };
      }
    }
  }

  const roles = await tryRolesViaRest();
  if (roles?.mode === 'postgrest_pg_roles') {
    result.available = true;
    result.roles = roles;
  }

  if (!result.available) {
    result.notes.push('pg_catalog / pg_roles were not reachable through this Supabase REST API, which is the normal Supabase configuration.');
  }

  return result;
}

async function tryRolesViaRest() {
  const res = await restGet('pg_roles?select=rolname&rolname=in.(authenticator,command_center)');
  if (!res.ok || !Array.isArray(res.json)) {
    return {
      mode: 'unavailable',
      authenticator_exists: null,
      command_center_exists: null,
      note: 'pg_roles is not exposed over PostgREST; role checks require QEP_DATABASE_URL exact mode.',
    };
  }

  const names = new Set(res.json.map((row) => row.rolname));
  return {
    mode: 'postgrest_pg_roles',
    authenticator_exists: names.has('authenticator'),
    command_center_exists: names.has('command_center'),
  };
}

async function inspectSourceObjectsViaRest() {
  const objects = [];

  for (const object of SOURCE_OBJECTS) {
    const sample = await restGet(`${object.name}?select=*&limit=1`);
    const exists = sample.ok;
    const columnsFromSample = exists && Array.isArray(sample.json) && sample.json[0]
      ? Object.keys(sample.json[0])
      : [];
    const candidateColumns = [];
    const missingCandidateColumns = [];
    const unknownCandidateColumns = [];

    if (exists) {
      for (const column of object.candidateColumns) {
        const probe = await restGet(`${object.name}?select=${encodeURIComponent(column)}&limit=0`);
        if (probe.ok) candidateColumns.push(column);
        else if (isMissingColumn(probe)) missingCandidateColumns.push(column);
        else unknownCandidateColumns.push(`${column} (${probe.status})`);
      }
    }

    objects.push({
      name: object.name,
      expected_kind: object.kind,
      exists,
      mode: 'postgrest_public_probe',
      status: sample.status,
      error: exists ? null : oneLine(sample.text),
      columns: columnsFromSample,
      candidate_columns_confirmed: candidateColumns,
      candidate_columns_missing: missingCandidateColumns,
      candidate_columns_unknown: unknownCandidateColumns,
      note: columnsFromSample.length
        ? 'Column list inferred from one returned row. Exact information_schema.columns requires QEP_DATABASE_URL mode.'
        : 'Object is readable but returned no sample row, or it is not readable. Candidate columns were probed individually when possible.',
    });
  }

  return objects;
}

async function callContractRpc(functionName, body, bearer, apikey) {
  const res = await restPost(`rpc/${functionName}`, body, bearer, apikey);
  const classification = classifyRpc(res);
  return {
    functionName,
    status: res.status,
    ok: res.ok,
    classification,
    bodySummary: summarizeJson(res.json),
    error: res.ok ? null : oneLine(res.text),
  };
}

function classifyRpc(res) {
  const text = `${res.text || ''} ${JSON.stringify(res.json || {})}`.toLowerCase();

  if (res.ok) return 'exists_and_executable';
  if (res.status === 404 || text.includes('could not find the function') || text.includes('pgrst202')) return 'missing_or_not_in_schema_cache';
  if (text.includes('permission denied for function') || text.includes('permission denied')) return 'exists_but_permission_denied_or_invoker_read_failed';
  if (res.status === 401 || res.status === 403) return 'auth_failed_or_not_executable';
  return 'unknown_error';
}

async function restGet(path) {
  return rest('GET', path, null, SERVICE_KEY, SERVICE_KEY);
}

async function restPost(path, body, bearer, apikey) {
  return rest('POST', path, body, bearer, apikey);
}

async function rest(method, path, body, bearer, apikey) {
  const headers = {
    apikey,
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/json',
  };

  if (body !== null) headers['Content-Type'] = 'application/json';

  try {
    const response = await fetch(`${QEP_PROJECT_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      json: parseMaybeJson(text),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: formatError(error),
      json: null,
    };
  }
}

function getFunctionMeta(signature) {
  return state.exact?.functions?.[signature] || state.postgrestMetadata?.functions?.[signature] || null;
}

function printApproach() {
  section('Approach used');
  for (const item of state.approach) line(`- ${item}`);
  if (COMMAND_CENTER_JWT) {
    line('- Behavioral comparison includes READ_KEY_QEP / QEP_COMMAND_CENTER_JWT calls.');
  } else {
    line('- No READ_KEY_QEP / QEP_COMMAND_CENTER_JWT provided; command_center RPC behavior was not tested.');
  }
}

function printFunctionSection(title, meta, serviceRpc, commandRpc) {
  section(title);

  if (meta) {
    line(`Exists:            ${yesNo(meta.exists !== false)}`);
    line(`prosecdef:         ${formatUnknown(meta.prosecdef)}`);
    line(`proacl:            ${formatUnknown(meta.proacl)}`);
    line(`proowner:          ${formatUnknown(meta.proowner)}`);
    if (meta.arg_types) line(`arg_types:         ${meta.arg_types}`);
    if (meta.identity_args) line(`identity_args:     ${meta.identity_args}`);
    if (meta.mode) line(`metadata_mode:     ${meta.mode}`);
  } else {
    line('Exists:            unknown from metadata');
    line('prosecdef:         unknown from metadata');
    line('proacl:            unknown from metadata');
    line('proowner:          unknown from metadata');
  }

  line(`service_role RPC:  HTTP ${serviceRpc.status} — ${serviceRpc.classification}`);
  if (serviceRpc.ok) line(`service_role body: ${serviceRpc.bodySummary}`);
  else line(`service_role err:  ${serviceRpc.error}`);

  if (commandRpc) {
    line(`command_center RPC: HTTP ${commandRpc.status} — ${commandRpc.classification}`);
    if (commandRpc.ok) line(`command_center body: ${commandRpc.bodySummary}`);
    else line(`command_center err:  ${commandRpc.error}`);
  } else {
    line('command_center RPC: not tested (set READ_KEY_QEP or QEP_COMMAND_CENTER_JWT).');
  }
}

function printSourceObjects() {
  section('Candidate Phase 1b source objects');

  for (const object of state.sourceObjects || []) {
    line(`- ${object.name}`);
    line(`  exists:      ${yesNo(object.exists)}`);
    if ('in_pg_tables' in object) line(`  pg_tables:   ${yesNo(object.in_pg_tables)}`);
    if ('in_pg_views' in object) line(`  pg_views:    ${yesNo(object.in_pg_views)}`);
    if (object.relkind) line(`  relkind:     ${object.relkind}`);
    if (object.expected_kind) line(`  expected:    ${object.expected_kind}`);
    if (object.columns?.length) line(`  columns:     ${object.columns.join(', ')}`);
    else line('  columns:     none reported');
    if (object.candidate_columns_confirmed?.length) line(`  confirmed:   ${object.candidate_columns_confirmed.join(', ')}`);
    if (object.candidate_columns_missing?.length) line(`  missing:     ${object.candidate_columns_missing.join(', ')}`);
    if (object.candidate_columns_unknown?.length) line(`  unknown:     ${object.candidate_columns_unknown.join(', ')}`);
    if (object.note) line(`  note:        ${object.note}`);
    if (object.error) line(`  error:       ${object.error}`);
  }
}

function printRoles() {
  section('Roles');
  const roles = state.roles || {};
  line(`authenticator exists: ${formatUnknown(roles.authenticator_exists)}`);
  line(`command_center exists: ${formatUnknown(roles.command_center_exists)} (expected before Tier 1: false)`);
  if (roles.mode) line(`mode: ${roles.mode}`);
  if (roles.note) line(`note: ${roles.note}`);
}

function printErrors() {
  if (!state.errors.length && !state.postgrestMetadata?.notes?.length) return;

  section('Notes / limitations');
  for (const note of state.postgrestMetadata?.notes || []) line(`- ${note}`);
  for (const error of state.errors) line(`- ${error}`);
}

function printVerdict() {
  section('Overall verdict');

  const snapshot = getFunctionMeta('cc_export_snapshot()');
  const detail = getFunctionMeta('cc_export_detail(text,text)');
  const roles = state.roles || {};
  const missingSources = (state.sourceObjects || []).filter((object) => object.exists === false).map((object) => object.name);

  if (snapshot?.exists === true && snapshot.prosecdef === true) {
    line('cc_export_snapshot(): OK — exact metadata says SECURITY DEFINER is already true. Tier 1 does not need ALTER FUNCTION for Blocker 1.');
  } else if (snapshot?.exists === true && snapshot.prosecdef === false) {
    line('cc_export_snapshot(): BLOCKED — exact metadata says SECURITY DEFINER is false. Add: ALTER FUNCTION public.cc_export_snapshot() SECURITY DEFINER;');
  } else if (state.rpc.commandCenterSnapshot?.ok) {
    line('cc_export_snapshot(): BEHAVIOR PASSED with command_center/read JWT, but exact prosecdef is unknown. If the audit requires literal pg_proc proof, rerun with QEP_DATABASE_URL.');
  } else if (state.rpc.serviceRoleSnapshot?.ok) {
    line('cc_export_snapshot(): EXISTS for service_role, but SECURITY DEFINER is unknown. Do not close Blocker 1 from this run alone; rerun with QEP_DATABASE_URL or READ_KEY_QEP.');
  } else {
    line('cc_export_snapshot(): NOT READY — RPC did not succeed and exact metadata did not prove the function exists.');
  }

  if (detail?.exists === true) {
    line(`cc_export_detail(text,text): present; SECURITY DEFINER=${formatUnknown(detail.prosecdef)}.`);
  } else if (state.rpc.serviceRoleDetail?.ok) {
    line('cc_export_detail(text,text): callable by service_role; exact metadata unknown.');
  } else {
    line('cc_export_detail(text,text): not proven callable. Inspect before relying on cockpit detail.');
  }

  if (roles.authenticator_exists === false) {
    line('Role sanity: BLOCKED — authenticator role was not found.');
  } else if (roles.authenticator_exists === true) {
    line('Role sanity: authenticator exists.');
  } else {
    line('Role sanity: authenticator existence unknown without exact pg_roles access.');
  }

  if (roles.command_center_exists === true) {
    line('Role sanity: command_center already exists. That is unexpected before Tier 1; make the migration idempotent or inspect prior application.');
  } else if (roles.command_center_exists === false) {
    line('Role sanity: command_center does not exist yet, as expected before Tier 1.');
  } else {
    line('Role sanity: command_center existence unknown without exact pg_roles access.');
  }

  if (missingSources.length) {
    line(`Phase 1b sources: missing/not readable — ${missingSources.join(', ')}.`);
  } else {
    line('Phase 1b sources: all candidate objects were found/readable by the available check.');
  }
}

function isMissingColumn(res) {
  const text = `${res.text || ''} ${JSON.stringify(res.json || {})}`.toLowerCase();
  return res.status === 400 && (text.includes('column') || text.includes('pgrst204'));
}

function summarizeJson(value) {
  if (value === null || value === undefined) return '(empty)';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const bits = keys.slice(0, 8).join(', ');
    return `object keys: ${bits}${keys.length > 8 ? ', ...' : ''}`;
  }
  return String(value).slice(0, 120);
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function section(title) {
  console.log(`\n## ${title}`);
}

function line(text) {
  console.log(text);
}

function yesNo(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'unknown';
}

function formatUnknown(value) {
  if (value === null || value === undefined) return 'unknown';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(empty)';
  return String(value);
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500) || '(empty)';
}

function formatError(error) {
  if (error?.stderr) return oneLine(error.stderr.toString());
  if (error?.message) return oneLine(error.message);
  return oneLine(String(error));
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}
