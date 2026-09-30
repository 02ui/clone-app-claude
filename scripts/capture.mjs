#!/usr/bin/env node
// capture.mjs — measure every view of the ORIGINAL or the CLONE, the same way on both sides.
//
// For each view (route or saved state) at each viewport it writes to <out>/<view>--<viewport>/:
//   elements.json  every meaningful element: cid, rect, computed styles, hover deltas
//   shot.png       full-page screenshot (motion frozen, masks applied)
//   meta.json      url, real viewport size, errors
//   dom.html       (original only) the DOM with data-cid on every element — the builder's source
// On the original it also downloads fonts, images and stylesheets to <out>/assets/.
//
// Usage:
//   node capture.mjs --config <ws>/config.json --side original [--only <view-id>] [--headed]
//   node capture.mjs --config <ws>/config.json --side clone --hover-from <ws>/original [--only <view-id>]
// Default --out: <ws>/original or <ws>/clone
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseArgs, loadConfig, loadStates, launch, installGuard, settle, injectProbe, authWall,
  runStep, FREEZE_CSS, writeJSON, readJSON, die,
} from './lib/common.mjs';

const args = parseArgs();
const cfg = loadConfig(args.config);
const side = args.side;
if (side !== 'original' && side !== 'clone') die('--side must be original or clone');
const out = path.resolve(args.out || path.join(cfg.workspace, side));
const baseUrl = side === 'original' ? cfg.target : cfg.clone_url;
let views = loadStates(cfg, args.states);
if (args.only) views = views.filter((v) => String(args.only).split(',').includes(v.id));
if (!views.length) die('no views to capture');
const vpKeys = args.viewport ? String(args.viewport).split(',') : Object.keys(cfg.viewports);

const blocked = [];
const { context, browser } = await launch(cfg, side, { headed: !!args.headed });
if (side === 'original') await installGuard(context, cfg, blocked);
const page = context.pages()[0] || (await context.newPage());
page.on('dialog', (d) => d.dismiss().catch(() => {}));

// Which cids to hover on the clone: the ones that changed on hover in the original.
function hoverTargetsFromOriginal(viewDir) {
  const f = path.join(args['hover-from'] || '', viewDir, 'elements.json');
  if (!args['hover-from'] || !fs.existsSync(f)) return null;
  return readJSON(f).elements.filter((e) => e.hover).map((e) => e.cid);
}

const resources = new Set();
let failures = 0;

for (const vp of vpKeys) {
  const size = cfg.viewports[vp];
  if (!size) die(`unknown viewport ${vp}`);
  await page.setViewportSize({ width: size[0], height: size[1] });
  for (const view of views) {
    const dir = `${view.id}--${vp}`;
    const vdir = path.join(out, dir);
    fs.mkdirSync(vdir, { recursive: true });
    const meta = { view: view.id, viewport: vp, route: view.route, steps: view.steps, errors: [] };
    try {
      await page.goto(new URL(view.route, baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await settle(page);
      if (side === 'original') {
        const wall = await authWall(page, view.route);
        if (wall) {
          writeJSON(path.join(out, 'BLOCKED.json'), { view: dir, reason: wall });
          console.error(`BLOCKED on ${dir}: ${wall}`);
          await context.close(); if (browser) await browser.close();
          process.exit(3);
        }
      }
      await injectProbe(page);
      if (side === 'original') await page.evaluate(() => window.__cloneProbe.stamp());
      for (const step of view.steps) {
        await runStep(page, step);
        await injectProbe(page);
        if (side === 'original') await page.evaluate(() => window.__cloneProbe.stamp());
      }

      const data = await page.evaluate(([s, r]) => window.__cloneProbe.collect(s, r), [side, cfg.redact]);
      meta.url = data.url;
      meta.viewport_actual = data.viewport;

      // Save the DOM before any capture-only CSS is added to the page.
      if (side === 'original') {
        let html = await page.evaluate(() => {
          const root = document.documentElement.cloneNode(true);
          root.querySelectorAll('script').forEach((s) => { if (s.textContent.includes('__cloneProbe')) s.remove(); });
          return '<!doctype html>\n' + root.outerHTML;
        });
        if (cfg.redact) html = html.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'name@example.com');
        fs.writeFileSync(path.join(vdir, 'dom.html'), html);
        const urls = await page.evaluate(() => [
          ...performance.getEntriesByType('resource').map((e) => e.name),
          ...[...document.images].map((i) => i.currentSrc).filter(Boolean),
          ...[...document.querySelectorAll('link[rel~=icon],link[rel=stylesheet]')].map((l) => l.href),
        ]);
        urls.forEach((u) => resources.add(u));
      }
      // Hover: read the delta for each interactive element, with motion frozen so reads are instant.
      await page.addStyleTag({ content: FREEZE_CSS });
      const byCid = new Map(data.elements.map((e) => [e.cid, e]));
      let targets = side === 'clone' ? hoverTargetsFromOriginal(dir) : null;
      if (!targets) {
        const seen = new Set();
        targets = data.elements.filter((e) => {
          if (!e.interactive) return false;
          const k = e.tag + JSON.stringify(e.styles);
          if (seen.has(k)) return false;
          seen.add(k); return true;
        }).slice(0, cfg.max_hover).map((e) => e.cid);
      }
      const hoverProps = await page.evaluate(() => window.__cloneProbe.HOVER_PROPS);
      for (const cid of targets) {
        const el = byCid.get(cid);
        if (!el) continue;
        const loc = page.locator(`[data-cid="${cid}"]`).first();
        try {
          const before = await loc.evaluate((n, p) => window.__cloneProbe.readProps(n, p), hoverProps);
          await loc.hover({ timeout: 1500 });
          const after = await loc.evaluate((n, p) => window.__cloneProbe.readProps(n, p), hoverProps);
          const delta = {};
          for (const p of hoverProps) if (before[p] !== after[p]) delta[p] = after[p];
          if (Object.keys(delta).length || side === 'clone') el.hover = side === 'clone' ? after : delta;
        } catch { /* covered or detached: skip */ }
      }
      await page.mouse.move(size[0] - 1, size[1] - 1);
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(150);

      const maskLocs = cfg.mask.map((s) => page.locator(s));
      await page.screenshot({ path: path.join(vdir, 'shot.png'), fullPage: true, mask: maskLocs, animations: 'disabled' });
      writeJSON(path.join(vdir, 'elements.json'), data);

      console.log(`captured ${dir}: ${data.elements.length} elements`);
    } catch (e) {
      failures++;
      meta.errors.push(String(e.message || e).slice(0, 500));
      console.error(`FAILED ${dir}: ${meta.errors.at(-1)}`);
    }
    writeJSON(path.join(vdir, 'meta.json'), meta);
  }
}

// Download fonts, images and CSS with the logged-in session's cookies.
if (side === 'original') {
  const manifest = [];
  const KIND = [[/\.(woff2?|ttf|otf)(\?|$)/i, 'fonts'], [/\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i, 'img'], [/\.css(\?|$)/i, 'css']];
  for (const url of resources) {
    const kind = (KIND.find(([re]) => re.test(url)) || [])[1];
    if (!kind || url.startsWith('data:')) continue;
    try {
      const res = await context.request.get(url, { timeout: 20000 });
      if (!res.ok()) { manifest.push({ url, error: `HTTP ${res.status()}` }); continue; }
      const body = await res.body();
      if (body.length > 20e6) { manifest.push({ url, error: 'larger than 20 MB' }); continue; }
      const ext = (url.split('?')[0].match(/\.[a-z0-9]+$/i) || ['.bin'])[0];
      const base = path.basename(url.split('?')[0], ext).replace(/[^\w-]+/g, '-').slice(0, 40) || kind;
      const file = path.join('assets', kind, `${base}-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 8)}${ext}`);
      fs.mkdirSync(path.join(out, 'assets', kind), { recursive: true });
      fs.writeFileSync(path.join(out, file), body);
      manifest.push({ url, file, bytes: body.length, type: res.headers()['content-type'] || '' });
    } catch (e) { manifest.push({ url, error: String(e.message).slice(0, 200) }); }
  }
  writeJSON(path.join(out, 'assets.json'), manifest);
  writeJSON(path.join(out, 'blocked-requests.json'), blocked);
  console.log(`assets: ${manifest.filter((m) => m.file).length} downloaded, ${manifest.filter((m) => m.error).length} failed`);
}

await context.close();
if (browser) await browser.close();
console.log(failures ? `${failures} view(s) failed — see meta.json files` : 'capture complete');
process.exit(failures ? 1 : 0);
