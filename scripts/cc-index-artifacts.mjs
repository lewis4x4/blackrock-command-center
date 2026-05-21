#!/usr/bin/env node
// ============================================================================
// cc-index-artifacts.mjs — repo scanner that feeds cc-index-artifacts.
//
// The cc-index-artifacts edge function does not walk the filesystem (it lives
// in Supabase's edge runtime, which has no view of the repo). This script
// runs on Brian's machine, walks the tracked content directories, produces a
// manifest, and POSTs it to the function.
//
// What it indexes:
//   docs/                  → kind: doc | spec | report (by sub-path heuristic)
//   supabase/migrations/   → kind: migration
//   supabase/functions/    → kind: edge_function
//   web/src/               → kind: web_source
//   web/public/            → kind: web_source
//   scripts/               → kind: script
//   README.md, netlify.toml → kind: doc
//
// Usage:
//   node scripts/cc-index-artifacts.mjs \
//     --url https://gsvhuzpysxaegoecwjmf.supabase.co \
//     --token <AGGREGATOR_TOKEN> \
//     [--prune] [--dry-run]
//
// Env equivalents: CC_FUNCTIONS_URL, AGGREGATOR_TOKEN.
// `--dry-run` prints the manifest and exits without posting.
// `--prune` soft-deletes repo_scan rows whose path is no longer in the scan.
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, basename, extname } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = parseArgs(process.argv.slice(2));
// Normalize operator input so either https://x.supabase.co or https://x.supabase.co/functions/v1 works.
const FUNCTIONS_URL = (args.url ?? process.env.CC_FUNCTIONS_URL ?? '')
  .replace(/\/functions\/v1\/?$/i, '')
  .replace(/\/$/, '');
const TOKEN = args.token ?? process.env.AGGREGATOR_TOKEN ?? '';
const PRUNE = !!args.prune;
const DRY = !!args['dry-run'];
const FORCE = !!args.force;

const REPO_ROOT = process.cwd();

const SCAN_TARGETS = [
  { root: 'docs',                kind: 'doc' },
  { root: 'supabase/migrations', kind: 'migration' },
  { root: 'supabase/functions',  kind: 'edge_function' },
  { root: 'web/src',             kind: 'web_source' },
  { root: 'web/public',          kind: 'web_source' },
  { root: 'scripts',             kind: 'script' },
];

const ROOT_FILES = [
  { path: 'README.md',    kind: 'doc' },
  { path: 'netlify.toml', kind: 'doc' },
];

// Heuristic: a doc whose path or filename suggests "spec" or "report".
function refineDocKind(relPath) {
  const lower = relPath.toLowerCase();
  if (lower.includes('handoff') || lower.includes('plan') || lower.includes('roadmap')) return 'spec';
  if (lower.includes('report')  || lower.includes('audit')) return 'report';
  return 'doc';
}

function walk(rootRel) {
  const abs = join(REPO_ROOT, rootRel);
  let stat;
  try { stat = statSync(abs); } catch { return []; }
  if (!stat.isDirectory()) return [];

  const out = [];
  for (const name of readdirSync(abs)) {
    if (name.startsWith('.')) continue;
    const full = join(abs, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walk(join(rootRel, name)));
    } else {
      out.push({ relPath: relative(REPO_ROOT, full).split(sep).join('/'), size: s.size, abs: full });
    }
  }
  return out;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function summarizeMarkdown(text) {
  // First non-blank line that isn't a heading marker, max 200 chars.
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('---')) continue;
    return line.replace(/[*_`]/g, '').slice(0, 200);
  }
  return null;
}

function titleFor(relPath, kind, text) {
  const base = basename(relPath, extname(relPath));
  if (kind === 'doc' || kind === 'spec' || kind === 'report') {
    // Look for the first markdown H1.
    const m = (text ?? '').match(/^\s*#\s+(.+?)\s*$/m);
    if (m) return m[1].trim().slice(0, 200);
  }
  if (kind === 'migration') return basename(relPath);
  if (kind === 'edge_function') {
    // supabase/functions/<name>/index.ts → "<name> edge function"
    const parts = relPath.split('/');
    const fnName = parts[2] ?? base;
    return `${fnName} edge function`;
  }
  // default: humanize the basename
  return base.replace(/[-_]/g, ' ');
}

function summaryFor(relPath, kind, text) {
  if (text == null) return null;
  if (kind === 'migration') {
    // First comment block header.
    const m = text.match(/--\s*Migration\s+\d+:\s*(.+)/i);
    if (m) return m[1].trim().slice(0, 200);
  }
  if (kind === 'doc' || kind === 'spec' || kind === 'report') {
    return summarizeMarkdown(text);
  }
  if (kind === 'edge_function' || kind === 'script' || kind === 'web_source') {
    // First non-blank comment/jsdoc line stripped of // or *.
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(?:\/\/|\*|#)\s*(.+)$/);
      if (m && !m[1].startsWith('===')) return m[1].trim().slice(0, 200);
      break;
    }
  }
  return null;
}

function buildItem(relPath, size, abs, declaredKind) {
  let text = null;
  try {
    if (size <= 2_000_000 && /\.(md|sql|ts|tsx|js|mjs|cjs|json|toml|css|html|txt)$/i.test(relPath)) {
      text = readFileSync(abs, 'utf8');
    }
  } catch { /* binary or unreadable */ }

  let kind = declaredKind;
  if (kind === 'doc') kind = refineDocKind(relPath);

  const bytes = readFileSync(abs);
  return {
    path: relPath,
    title: titleFor(relPath, kind, text),
    kind,
    byte_size: size,
    content_sha: sha256(bytes),
    summary: summaryFor(relPath, kind, text),
  };
}

function isGitRepo() {
  if (existsSync(join(REPO_ROOT, '.git'))) return true;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function listGitTrackedItems() {
  const out = [];
  const tracked = execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const relPath of tracked) {
    const target = SCAN_TARGETS.find((t) => relPath === t.root || relPath.startsWith(`${t.root}/`));
    if (target) {
      const abs = join(REPO_ROOT, relPath);
      const s = statSync(abs);
      if (s.isFile()) out.push(buildItem(relPath, s.size, abs, target.kind));
      continue;
    }
    const rootFile = ROOT_FILES.find((f) => f.path === relPath);
    if (rootFile) {
      const abs = join(REPO_ROOT, relPath);
      const s = statSync(abs);
      if (s.isFile()) out.push(buildItem(relPath, s.size, abs, rootFile.kind));
    }
  }

  return out;
}

function listFsItems() {
  const items = [];
  for (const t of SCAN_TARGETS) {
    for (const f of walk(t.root)) {
      items.push(buildItem(f.relPath, f.size, f.abs, t.kind));
    }
  }
  for (const f of ROOT_FILES) {
    try {
      const abs = join(REPO_ROOT, f.path);
      const s = statSync(abs);
      if (s.isFile()) items.push(buildItem(f.path, s.size, abs, f.kind));
    } catch { /* missing root file is fine */ }
  }
  return items;
}

function buildManifest() {
  const items = isGitRepo() ? listGitTrackedItems() : listFsItems();

  return {
    scanned_at: new Date().toISOString(),
    produced_by: 'cc-index-artifacts (local scanner)',
    prune: PRUNE,
    force: PRUNE && FORCE,
    items,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { out[a.slice(2)] = argv[++i]; }
    else out[a.slice(2)] = true;
  }
  return out;
}

const manifest = buildManifest();

if (DRY) {
  console.log(JSON.stringify({ ...manifest, items_count: manifest.items.length, items: manifest.items.slice(0, 5) }, null, 2));
  console.log(`\n# Dry run — would POST ${manifest.items.length} items.`);
  process.exit(0);
}

if (PRUNE && manifest.items.length < 5 && !FORCE) {
  console.error(`Refusing to prune with ${manifest.items.length} items (< 5) — pass --force to override.`);
  process.exit(4);
}

if (!FUNCTIONS_URL || !TOKEN) {
  console.error('Missing --url / CC_FUNCTIONS_URL or --token / AGGREGATOR_TOKEN.');
  console.error('Tip: --dry-run prints the manifest without posting.');
  process.exit(2);
}

const endpoint = `${FUNCTIONS_URL}/functions/v1/cc-index-artifacts`;
const res = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-aggregator-token': TOKEN,
  },
  body: JSON.stringify(manifest),
});

const bodyText = await res.text();
if (!res.ok) {
  console.error(`cc-index-artifacts -> ${res.status}`);
  console.error(bodyText);
  process.exit(3);
}
console.log(bodyText);
