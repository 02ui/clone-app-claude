#!/usr/bin/env node
// sweep.mjs — find every view the app can show, SAFELY.
//
// For each route in config.json it:
//   1. collects same-origin links as NEW ROUTES (it never clicks links),
//   2. opens menus, tabs, popovers and focuses editors, one at a time,
//   3. keeps each action that changed the screen as a STATE (route + steps),
//   4. never clicks anything whose name matches the deny list, never types, never submits,
//   5. blocks write requests at the network level (see installGuard).
//
// Usage: node sweep.mjs --config <workspace>/config.json [--viewport desktop] [--headed]
// Writes: <workspace>/sweep/states.json, routes-found.json, blocked-requests.json, shots/*.png
import path from 'node:path';
import fs from 'node:fs';
import {
  parseArgs, loadConfig, launch, installGuard, settle, injectProbe, authWall, runStep,
  denyPattern, slug, writeJSON, die,
} from './lib/common.mjs';

const args = parseArgs();
const cfg = loadConfig(args.config);
const vpKey = args.viewport || 'desktop';
const [vw, vh] = cfg.viewports[vpKey] || die(`unknown viewport ${vpKey}`);
const out = path.join(cfg.workspace, 'sweep');
fs.mkdirSync(path.join(out, 'shots'), { recursive: true });

const blocked = [];
const { context } = await launch(cfg, 'original', { headed: !!args.headed });
await installGuard(context, cfg, blocked);
const page = context.pages()[0] || (await context.newPage());
page.on('dialog', (d) => d.dismiss().catch(() => {}));
await page.setViewportSize({ width: vw, height: vh });

const deny = denyPattern(cfg);
const states = [];
const routesFound = new Set();

async function openRoute(route) {
  await page.goto(new URL(route, cfg.target).href, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await settle(page);
  const wall = await authWall(page, route);
  if (wall) {
    writeJSON(path.join(out, 'BLOCKED.json'), { route, reason: wall });
    console.error(`BLOCKED on ${route}: ${wall}. Run login.mjs, or stop.`);
    await context.close();
    process.exit(3);
  }
  await injectProbe(page);
  await page.evaluate(() => window.__cloneProbe.stamp());
  return page.evaluate(() => window.__cloneProbe.signature());
}

for (const route of cfg.routes) {
  let baseline = await openRoute(route);
  const { triggers, links } = await page.evaluate((d) => window.__cloneProbe.triggers(d), deny);
  links.forEach((l) => routesFound.add(l));
  const seen = new Set();
  let kept = 0;
  for (const t of triggers) {
    const key = t.tag + '|' + t.name.toLowerCase();
    if (seen.has(key) || !t.cid) continue;
    seen.add(key);
    if (kept >= cfg.safety.max_states_per_route) break;
    try {
      await runStep(page, t);
    } catch (e) {
      baseline = await openRoute(route);
      continue;
    }
    const nowPath = new URL(page.url()).pathname;
    const sig = await page.evaluate(() => window.__cloneProbe && window.__cloneProbe.signature()).catch(() => null);
    if (nowPath !== new URL(route, cfg.target).pathname) {
      routesFound.add(nowPath);
      baseline = await openRoute(route);
      continue;
    }
    if (sig && sig !== baseline) {
      const id = `${slug(route)}--${t.action}-${slug(t.name).slice(0, 30) || t.tag}-${t.cid.slice(-4)}`;
      await injectProbe(page);
      await page.evaluate(() => window.__cloneProbe.stamp());
      await page.screenshot({ path: path.join(out, 'shots', `${id}.png`) });
      states.push({ id, route, label: `${t.action} "${t.name}"`, steps: [{ action: t.action, cid: t.cid }] });
      kept++;
      console.log(`state: ${id}`);
    }
    // Close whatever opened. If the screen did not return to the start, reload the route.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
    const back = await page.evaluate(() => window.__cloneProbe && window.__cloneProbe.signature()).catch(() => null);
    if (back !== baseline) baseline = await openRoute(route);
  }
}

const known = new Set(cfg.routes.map((r) => new URL(r, cfg.target).pathname));
writeJSON(path.join(out, 'states.json'), states);
writeJSON(path.join(out, 'routes-found.json'), [...routesFound].filter((r) => !known.has(r)).sort());
writeJSON(path.join(out, 'blocked-requests.json'), blocked);
await context.close();
console.log(`sweep done: ${states.length} states, ${routesFound.size} links seen, ${blocked.length} write requests blocked`);
console.log(`Review ${path.join(out, 'states.json')} and routes-found.json with the user before capture.`);
