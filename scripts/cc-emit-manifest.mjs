#!/usr/bin/env node
// Print the FULL repo manifest as JSON to stdout (no truncation, no POST).
// Used to seed cc_artifacts via SQL during local development without
// deploying the edge function.
//
// Usage: node scripts/cc-emit-manifest.mjs > /tmp/manifest.json
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';

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
  { path: 'README.md', kind: 'doc' },
  { path: 'netlify.toml', kind: 'doc' },
];

function refineDocKind(p) {
  const l = p.toLowerCase();
  if (l.includes('handoff') || l.includes('plan') || l.includes('roadmap')) return 'spec';
  if (l.includes('report') || l.includes('audit')) return 'report';
  return 'doc';
}

function walk(rootRel) {
  const abs = join(REPO_ROOT, rootRel);
  let s;
  try { s = statSync(abs); } catch { return []; }
  if (!s.isDirectory()) return [];
  const out = [];
  for (const n of readdirSync(abs)) {
    if (n.startsWith('.')) continue;
    const full = join(abs, n);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(join(rootRel, n)));
    else out.push({ relPath: relative(REPO_ROOT, full).split(sep).join('/'), size: st.size, abs: full });
  }
  return out;
}

function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }

function summarizeMd(text) {
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('---')) continue;
    return l.replace(/[*_`]/g, '').slice(0, 200);
  }
  return null;
}

function titleFor(p, kind, text) {
  const base = basename(p, extname(p));
  if (['doc','spec','report'].includes(kind)) {
    const m = (text ?? '').match(/^\s*#\s+(.+?)\s*$/m);
    if (m) return m[1].trim().slice(0, 200);
  }
  if (kind === 'migration') return basename(p);
  if (kind === 'edge_function') {
    const parts = p.split('/');
    return `${parts[2] ?? base} edge function`;
  }
  return base.replace(/[-_]/g, ' ');
}

function summaryFor(p, kind, text) {
  if (text == null) return null;
  if (kind === 'migration') {
    const m = text.match(/--\s*Migration\s+\d+:\s*(.+)/i);
    if (m) return m[1].trim().slice(0, 200);
  }
  if (['doc','spec','report'].includes(kind)) return summarizeMd(text);
  if (['edge_function','script','web_source'].includes(kind)) {
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      const m = l.match(/^(?:\/\/|\*|#)\s*(.+)$/);
      if (m && !m[1].startsWith('===')) return m[1].trim().slice(0, 200);
      break;
    }
  }
  return null;
}

function buildItem(p, size, abs, declared) {
  let text = null;
  try {
    if (size <= 2_000_000 && /\.(md|sql|ts|tsx|js|mjs|cjs|json|toml|css|html|txt)$/i.test(p)) {
      text = readFileSync(abs, 'utf8');
    }
  } catch {}
  let kind = declared;
  if (kind === 'doc') kind = refineDocKind(p);
  const bytes = readFileSync(abs);
  return {
    path: p,
    title: titleFor(p, kind, text),
    kind,
    byte_size: size,
    content_sha: sha(bytes),
    summary: summaryFor(p, kind, text),
  };
}

const items = [];
for (const t of SCAN_TARGETS) for (const f of walk(t.root)) items.push(buildItem(f.relPath, f.size, f.abs, t.kind));
for (const f of ROOT_FILES) {
  try {
    const abs = join(REPO_ROOT, f.path);
    if (statSync(abs).isFile()) items.push(buildItem(f.path, statSync(abs).size, abs, f.kind));
  } catch {}
}

console.log(JSON.stringify({ scanned_at: new Date().toISOString(), items }, null, 2));
