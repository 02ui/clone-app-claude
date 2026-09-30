// Shared helpers for the clone-app-claude scripts (Node side).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROBE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe.js');

// Words that must never be clicked on a real, logged-in app.
export const DENY_WORDS = [
  'delete', 'remove', 'archive', 'trash', 'discard', 'destroy', 'erase', 'clear all',
  'log ?out', 'sign ?out', 'leave', 'disconnect', 'revoke', 'reset', 'deactivate', 'disable',
  'send', 'publish', 'post', 'submit', 'save', 'confirm', 'approve', 'merge', 'deploy', 'close issue',
  'pay', 'purchase', 'buy', 'checkout', 'upgrade', 'subscribe', 'unsubscribe', 'cancel', 'invite',
  'transfer', 'mark all', 'import', 'export', 'download', 'upload', 'duplicate', 'move to', 'assign to me',
];

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

export function die(msg, code = 2) { console.error('ERROR: ' + msg); process.exit(code); }

export function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die(`cannot read ${p}: ${e.message}`); }
}

export function writeJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

const expand = (p, base) => path.resolve(base, p.replace(/^~(?=$|\/)/, os.homedir()));

export function loadConfig(p) {
  if (!p) die('--config <workspace>/config.json is required');
  const cfg = readJSON(p);
  const base = path.dirname(path.resolve(p));
  for (const k of ['name', 'target', 'routes']) if (!cfg[k]) die(`config.json is missing "${k}"`);
  if (!Array.isArray(cfg.routes) || !cfg.routes.length) die('config.json "routes" must be a non-empty array');
  cfg.workspace = base;
  cfg.clone_url = cfg.clone_url || 'http://localhost:3000';
  cfg.profile_dir = expand(cfg.profile_dir || `~/.clone-app-claude/profiles/${cfg.name}`, base);
  if (cfg.output_dir) cfg.output_dir = expand(cfg.output_dir, base);
  cfg.viewports = cfg.viewports || { desktop: [1440, 900], tablet: [768, 1024], mobile: [390, 844] };
  cfg.mask = cfg.mask || [];
  cfg.redact = cfg.redact !== false;
  cfg.gate = { max_pixel_mismatch_pct: 2, geometry_tol_px: 2, style_tol_px: 1, min_coverage: 1, ...(cfg.gate || {}) };
  cfg.safety = { allow_post: [], extra_deny: [], max_states_per_route: 40, ...(cfg.safety || {}) };
  cfg.max_hover = cfg.max_hover || 60;
  return cfg;
}

export function denyPattern(cfg) {
  return '\\b(' + [...DENY_WORDS, ...cfg.safety.extra_deny].join('|') + ')\\b';
}

// Route "/" -> "home", "/team/ENG/active" -> "team-eng-active".
export function slug(route) {
  const s = String(route).toLowerCase().replace(/[?#].*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'home';
}

// Base views (one per route) plus any saved interaction states.
export function loadStates(cfg, statesPath) {
  const base = cfg.routes.map((r) => ({ id: slug(r), route: r, steps: [] }));
  const p = statesPath || path.join(cfg.workspace, 'states.json');
  if (!fs.existsSync(p)) return base;
  const extra = readJSON(p).filter((s) => s.keep !== false);
  return [...base, ...extra];
}

export async function launch(cfg, side, { headed = false } = {}) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch {
    die('Playwright is not installed. Run: cd <skill>/scripts && npm install && npx playwright install chromium');
  }
  const opts = { headless: !headed, deviceScaleFactor: 1, viewport: { width: 1440, height: 900 } };
  if (cfg.browser_channel) opts.channel = cfg.browser_channel;
  if (side === 'original') {
    fs.mkdirSync(cfg.profile_dir, { recursive: true });
    return { context: await chromium.launchPersistentContext(cfg.profile_dir, opts), browser: null };
  }
  const browser = await chromium.launch(opts);
  return { context: await browser.newContext({ deviceScaleFactor: 1, viewport: opts.viewport }), browser };
}

// Block writes on the real site. Allows GET, and POSTs that look like GraphQL reads
// or that match safety.allow_post. Everything else is aborted and logged.
export async function installGuard(context, cfg, log) {
  if (cfg.safety.allow_writes === true) return;
  const allow = cfg.safety.allow_post.map((s) => new RegExp(s));
  await context.route('**/*', (route) => {
    const req = route.request();
    const m = req.method();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return route.continue();
    if (m === 'POST') {
      const body = (req.postData() || '').slice(0, 4000);
      const gqlRead = /"query"\s*:\s*"\s*(query\b|\{)/.test(body) && !/\bmutation\b/.test(body);
      if (gqlRead || allow.some((r) => r.test(req.url()))) return route.continue();
    }
    log.push({ method: m, url: req.url().slice(0, 300) });
    return route.abort();
  });
}

export async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  // Scroll the document once so lazy images load, then return to the top.
  await page.evaluate(async () => {
    const h = document.documentElement.scrollHeight;
    if (h > innerHeight * 1.5) {
      for (let y = 0; y < h; y += innerHeight) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
      scrollTo(0, 0);
    }
  }).catch(() => {});
  await page.waitForTimeout(300);
}

export async function injectProbe(page) {
  const has = await page.evaluate(() => !!window.__cloneProbe).catch(() => false);
  if (!has) await page.addScriptTag({ path: PROBE_PATH });
}

// Turn off motion so screenshots and hover reads are stable.
export const FREEZE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';

export async function authWall(page, route) {
  const u = new URL(page.url());
  const wanted = /(login|signin|sign-in|auth|sso)/i.test(route);
  if (!wanted && /(login|signin|sign-in|\/auth|sso)/i.test(u.pathname)) return `redirected to ${u.pathname}`;
  const pw = await page.locator('input[type=password]:visible').count().catch(() => 0);
  if (pw && !wanted) return 'a password field is on screen';
  const bot = await page.locator('iframe[src*="challenge"], iframe[src*="captcha"], #challenge-form').count().catch(() => 0);
  if (bot) return 'a bot check or CAPTCHA is on screen (Claude must not solve it)';
  return null;
}

export async function runStep(page, step) {
  const loc = page.locator(`[data-cid="${step.cid}"]`).first();
  if (!(await loc.count())) throw new Error(`trigger ${step.cid} not found`);
  if (step.action === 'focus') await loc.focus();
  else if (step.action === 'hover') await loc.hover({ timeout: 3000 });
  else await loc.click({ timeout: 3000 });
  await page.waitForTimeout(500);
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
}
