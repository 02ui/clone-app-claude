#!/usr/bin/env node
// partition-bugs.mjs — split gate failures into fix sets that never share a file.
//
// It finds the file for each failure by searching the clone's source for the literal
// data-cid value. Failures it cannot place go to "shared" — the orchestrator fixes that set
// ALONE, after the parallel sets finish, because it may touch any file.
//
// Usage: node partition-bugs.mjs --config <ws>/config.json --failures <qa>/failures.json --out <dir> [--max 4]
// Writes: <out>/fix-set-{k}.json  ({ files:[...], failures:[...] }), <out>/fix-shared.json, <out>/index.json
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, loadConfig, readJSON, writeJSON, die } from './lib/common.mjs';

const args = parseArgs();
const cfg = loadConfig(args.config);
if (!cfg.output_dir || !fs.existsSync(cfg.output_dir)) die('config.json "output_dir" must point at the clone source');
const failures = readJSON(args.failures || die('--failures is required'));
if (!Array.isArray(failures)) die('failures.json must be an array (the file compare.mjs writes)');
const out = path.resolve(args.out || die('--out is required'));
const max = Math.max(1, parseInt(args.max || '4', 10));

// Index every source file once: cid -> files that contain it.
const SRC = /\.(tsx?|jsx?|vue|svelte|astro|html|css|scss|json|md)$/;
const SKIP = new Set(['node_modules', '.next', 'dist', 'build', '.git', '.turbo', 'out']);
const where = new Map();
(function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name)) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (SRC.test(d.name)) {
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/[a-z0-9]+-[0-9a-f]{12}\b|\bbody\b/g)) {
        const rel = path.relative(cfg.output_dir, p);
        if (!where.has(m[0])) where.set(m[0], new Set());
        where.get(m[0]).add(rel);
      }
    }
  }
})(cfg.output_dir);

const byFile = new Map();
const shared = [];
for (const f of failures) {
  const files = f.cid ? [...(where.get(f.cid) || [])].filter((x) => !x.endsWith('.json') && !x.endsWith('.md')) : [];
  if (files.length === 1) {
    if (!byFile.has(files[0])) byFile.set(files[0], []);
    byFile.get(files[0]).push(f);
  } else shared.push({ ...f, candidate_files: files });
}

// Balance by failure count, largest file group first.
const groups = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
const n = Math.min(max, groups.length);
const sets = Array.from({ length: n }, () => ({ files: [], failures: [] }));
for (const [file, items] of groups) {
  const s = sets.reduce((m, x) => (x.failures.length < m.failures.length ? x : m), sets[0]);
  s.files.push(file);
  s.failures.push(...items);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
sets.forEach((s, k) => writeJSON(path.join(out, `fix-set-${k}.json`), s));
writeJSON(path.join(out, 'fix-shared.json'), { files: 'any', failures: shared });
writeJSON(path.join(out, 'index.json'), { sets: sets.map((s, k) => ({ k, files: s.files, failures: s.failures.length })), shared: shared.length });
console.log(`${failures.length} failures -> ${sets.length} parallel set(s) + ${shared.length} shared`);
