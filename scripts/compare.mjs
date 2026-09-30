#!/usr/bin/env node
// compare.mjs — THE GATE. Compares the clone's capture to the ORIGINAL's capture.
//
// For every view it checks, element by element (paired by data-cid):
//   coverage  — every original element exists in the clone
//   style     — every computed property matches (colors per channel, lengths ±style_tol_px,
//               shadows and gradients compared token by token, not by their first number)
//   geometry  — x, y, width, height within ±geometry_tol_px
//   hover     — hover values match where the original changes on hover
//   pixels    — full-page screenshot mismatch % (pixelmatch), with a diff.png
//
// Usage:
//   node compare.mjs --config <ws>/config.json --build-ok true|false --out <ws>/qa/cycle-N
//        [--original <ws>/original] [--clone <ws>/clone] [--only <view-id,...>]
// Writes: <out>/metrics.json (summary + gate verdict), <out>/failures.json (flat list), <out>/diff/*.png
// Exit: 0 = PASS, 1 = FAIL, 2 = usage or input error.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, loadConfig, readJSON, writeJSON, die } from './lib/common.mjs';

const args = parseArgs();
const cfg = loadConfig(args.config);
if (args['build-ok'] === undefined) die('--build-ok true|false is required. Run the build first; the gate needs its result.');
const buildOk = String(args['build-ok']) === 'true';
const origDir = path.resolve(args.original || path.join(cfg.workspace, 'original'));
const cloneDir = path.resolve(args.clone || path.join(cfg.workspace, 'clone'));
const out = path.resolve(args.out || die('--out <dir> is required'));
const G = cfg.gate;

// ---------- value comparison ----------
const COLOR_RE = /^(rgba?|hsla?|color|lab|lch|oklab|oklch|hwb)\(/i;
const TOKEN_RE = /(?:rgba?|hsla?|color|lab|lch|oklab|oklch|hwb)\([^()]*\)|#[0-9a-f]{3,8}\b|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?[a-z%]*|[a-z_-][\w-]*\(?|"[^"]*"|'[^']*'|[(),/]/gi;

function parseColor(s) {
  s = s.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = h.match(/../g).map((x) => parseInt(x, 16));
    return [n[0], n[1], n[2], n.length > 3 ? n[3] / 255 : 1];
  }
  m = s.match(/^rgba?\(([^)]*)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean)
      .map((v, i) => (v.endsWith('%') ? parseFloat(v) * (i < 3 ? 2.55 : 0.01) : parseFloat(v)));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return null; // other color spaces are compared as text
}
function colorsEqual(a, b) {
  const x = parseColor(a), y = parseColor(b);
  if (!x || !y) return a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  if (x[3] === 0 && y[3] === 0) return true;
  return Math.abs(x[0] - y[0]) <= 1 && Math.abs(x[1] - y[1]) <= 1 && Math.abs(x[2] - y[2]) <= 1 && Math.abs(x[3] - y[3]) <= 0.01;
}

function numUnit(t) {
  const m = t.match(/^(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)([a-z%]*)$/i);
  return m ? { n: parseFloat(m[1]), u: m[2].toLowerCase() } : null;
}

function tokensEqual(a, b, tol) {
  if (/^#|^(rgba?|hsla?|color|lab|lch|oklab|oklch|hwb)\(/i.test(a) || /^#|^(rgba?|hsla?)\(/i.test(b)) return colorsEqual(a, b);
  const x = numUnit(a), y = numUnit(b);
  if (x && y) {
    if (x.u !== y.u) return x.n === 0 && y.n === 0;
    const t = x.u === 'px' ? tol : x.u === 'deg' ? 0.5 : x.u === '%' ? 0.5 : x.u === 's' ? 0.005 : x.u === 'ms' ? 5 : 0.001;
    return Math.abs(x.n - y.n) <= t;
  }
  return a.toLowerCase() === b.toLowerCase();
}

function valuesEqual(prop, expected, actual, tol = G.style_tol_px) {
  if (expected == null) return true;
  if (actual == null) return false;
  const e = String(expected).trim(), a = String(actual).trim();
  if (e === a) return true;
  if (prop === 'fontFamily') {
    const first = (s) => s.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
    return first(e) === first(a);
  }
  const te = e.match(TOKEN_RE) || [], ta = a.match(TOKEN_RE) || [];
  if (te.length !== ta.length) return false;
  return te.every((t, i) => tokensEqual(t, ta[i], tol));
}

// ---------- pixel comparison ----------
async function pixelDiff(a, b, diffPath) {
  let PNG, pixelmatch;
  try {
    ({ PNG } = await import('pngjs'));
    pixelmatch = (await import('pixelmatch')).default;
  } catch { die('pngjs and pixelmatch are not installed. Run: cd <skill>/scripts && npm install'); }
  const A = PNG.sync.read(fs.readFileSync(a)), B = PNG.sync.read(fs.readFileSync(b));
  const w = Math.max(A.width, B.width), h = Math.max(A.height, B.height);
  const pad = (img) => {
    if (img.width === w && img.height === h) return img;
    const p = new PNG({ width: w, height: h });
    p.data.fill(255);
    PNG.bitblt(img, p, 0, 0, img.width, img.height, 0, 0);
    return p;
  };
  const pa = pad(A), pb = pad(B), diff = new PNG({ width: w, height: h });
  const n = pixelmatch(pa.data, pb.data, diff.data, w, h, { threshold: 0.1 });
  fs.mkdirSync(path.dirname(diffPath), { recursive: true });
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  return { pct: Math.round((n / (w * h)) * 10000) / 100, size_original: [A.width, A.height], size_clone: [B.width, B.height] };
}

// ---------- main ----------
if (!fs.existsSync(origDir)) die(`original capture not found at ${origDir}`);
let viewDirs = fs.readdirSync(origDir).filter((d) => fs.existsSync(path.join(origDir, d, 'elements.json')));
if (args.only) {
  const only = String(args.only).split(',');
  viewDirs = viewDirs.filter((d) => only.includes(d) || only.includes(d.replace(/--[^-]+$/, '')));
}
if (!viewDirs.length) die('no captured views found in the original folder');

const failures = [];
const views = [];
let totalEl = 0, matchedEl = 0;

for (const vd of viewDirs) {
  const o = readJSON(path.join(origDir, vd, 'elements.json'));
  const cPath = path.join(cloneDir, vd, 'elements.json');
  const v = { view: vd, elements: o.elements.length, missing: 0, style: 0, geometry: 0, hover: 0, pixel_mismatch_pct: null };
  totalEl += o.elements.length;
  if (!fs.existsSync(cPath)) {
    const meta = path.join(cloneDir, vd, 'meta.json');
    const err = fs.existsSync(meta) ? readJSON(meta).errors.join('; ') : 'view not captured';
    failures.push({ view: vd, kind: 'view-missing', detail: err || 'view not captured' });
    v.missing = o.elements.length;
    views.push(v);
    continue;
  }
  const c = readJSON(cPath);
  if (o.viewport.w !== c.viewport.w) failures.push({ view: vd, kind: 'viewport', expected: o.viewport.w, actual: c.viewport.w });
  const clone = new Map(c.elements.map((e) => [e.cid, e]));
  for (const el of o.elements) {
    const ce = clone.get(el.cid);
    const who = { view: vd, cid: el.cid, tag: el.tag, text: el.text, y: el.rect.y };
    if (!ce) { v.missing++; failures.push({ ...who, kind: 'missing' }); continue; }
    matchedEl++;
    for (const [prop, exp] of Object.entries(el.styles)) {
      if (!valuesEqual(prop, exp, ce.styles[prop])) {
        v.style++; failures.push({ ...who, kind: 'style', prop, expected: exp, actual: ce.styles[prop] ?? null });
      }
    }
    for (const k of ['x', 'y', 'w', 'h']) {
      if (Math.abs(el.rect[k] - ce.rect[k]) > G.geometry_tol_px) {
        v.geometry++; failures.push({ ...who, kind: 'geometry', prop: k, expected: el.rect[k], actual: ce.rect[k] });
      }
    }
    for (const [prop, exp] of Object.entries(el.hover || {})) {
      const act = ce.hover ? ce.hover[prop] : null;
      if (!valuesEqual(prop, exp, act)) {
        v.hover++; failures.push({ ...who, kind: 'hover', prop, expected: exp, actual: act });
      }
    }
  }
  const oShot = path.join(origDir, vd, 'shot.png'), cShot = path.join(cloneDir, vd, 'shot.png');
  if (fs.existsSync(oShot) && fs.existsSync(cShot)) {
    const d = await pixelDiff(oShot, cShot, path.join(out, 'diff', `${vd}.png`));
    v.pixel_mismatch_pct = d.pct;
    if (d.pct > G.max_pixel_mismatch_pct) failures.push({ view: vd, kind: 'pixels', expected: `<= ${G.max_pixel_mismatch_pct}%`, actual: `${d.pct}%`, detail: `diff/${vd}.png` });
  }
  views.push(v);
}

// Top of the page first: a wrong header height shifts everything below it.
failures.sort((a, b) => (a.view > b.view ? 1 : a.view < b.view ? -1 : (a.y ?? -1) - (b.y ?? -1)));
failures.forEach((f, i) => { f.id = `F-${String(i + 1).padStart(4, '0')}`; });

const coverage = totalEl ? Math.round((matchedEl / totalEl) * 10000) / 10000 : 0;
const count = (k) => failures.filter((f) => f.kind === k).length;
const reasons = [];
if (!buildOk) reasons.push('build failed');
if (coverage < G.min_coverage) reasons.push(`coverage ${coverage} < ${G.min_coverage}`);
for (const k of ['view-missing', 'viewport', 'style', 'geometry', 'hover', 'pixels']) if (count(k)) reasons.push(`${count(k)} ${k} failure(s)`);

const metrics = {
  pass: reasons.length === 0,
  reasons,
  build_ok: buildOk,
  coverage,
  totals: { views: views.length, elements: totalEl, failures: failures.length,
    missing: count('missing'), style: count('style'), geometry: count('geometry'), hover: count('hover'), pixels: count('pixels') },
  gate: G,
  views,
};
writeJSON(path.join(out, 'metrics.json'), metrics);
writeJSON(path.join(out, 'failures.json'), failures);
console.log(`${metrics.pass ? 'PASS' : 'FAIL'} — coverage ${(coverage * 100).toFixed(1)}%, ` +
  `${metrics.totals.style} style, ${metrics.totals.geometry} geometry, ${metrics.totals.hover} hover, ` +
  `${metrics.totals.missing} missing, ${metrics.totals.pixels} pixel failures, build ${buildOk ? 'ok' : 'FAILED'}`);
process.exit(metrics.pass ? 0 : 1);
