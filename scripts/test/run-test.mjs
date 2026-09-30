#!/usr/bin/env node
// run-test.mjs — proves the pipeline end to end on a local fixture, with no network.
//   1. sweep finds the Filter menu, and never clicks "Delete workspace" or sends a write.
//   2. a perfect clone PASSES the gate.
//   3. a broken clone FAILS with exactly the defects we planted
//      (shadow, gradient colors, letter-spacing, a missing row, hover).
//   4. partition-bugs places each failure in the right file.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.dirname(here);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-app-claude-test-'));
const ws = path.join(tmp, 'ws');
const cloneSrc = path.join(tmp, 'clone-src');
fs.mkdirSync(ws); fs.mkdirSync(cloneSrc);

const writes = [];
function serve(dir, port, logWrites) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.method !== 'GET') { if (logWrites) writes.push(`${req.method} ${req.url}`); res.end('ok'); return; }
      const f = path.join(dir, req.url === '/' ? 'index.html' : req.url);
      if (!fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', f.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(fs.readFileSync(f));
    }).listen(port, '127.0.0.1', () => resolve(s));
  });
}
const orig = await serve(path.join(here, 'fixture'), 4711, true);
const clone = await serve(cloneSrc, 4712, false);

fs.writeFileSync(path.join(ws, 'config.json'), JSON.stringify({
  name: 'fixture', target: 'http://127.0.0.1:4711/', clone_url: 'http://127.0.0.1:4712/', routes: ['/'],
  output_dir: cloneSrc, profile_dir: path.join(tmp, 'profile'),
  viewports: { desktop: [1000, 700], mobile: [390, 700] },
}));
const cfg = path.join(ws, 'config.json');
// Async on purpose: the fixture servers live in this process and must keep answering.
const node = (script, ...a) => new Promise((resolve) => {
  execFile('node', [path.join(scripts, script), ...a], { encoding: 'utf8', timeout: 180000 }, (e, stdout, stderr) =>
    resolve({ code: e ? (e.code ?? 1) : 0, out: stdout + stderr }));
});

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };

try {
  // 1. sweep
  const sw = await node('sweep.mjs', '--config', cfg);
  const states = JSON.parse(fs.readFileSync(path.join(ws, 'sweep', 'states.json'), 'utf8'));
  check(states.some((s) => /filter/i.test(s.label)), `sweep found the Filter menu (${states.length} states)`);
  check(!states.some((s) => /delete|save/i.test(s.label)), 'sweep never clicked Delete or Save');
  check(writes.length === 0, `no write request reached the server (${writes.join(', ') || 'none'})`);
  if (sw.code !== 0) console.log(sw.out);
  fs.copyFileSync(path.join(ws, 'sweep', 'states.json'), path.join(ws, 'states.json'));

  // 2. capture the original
  const co = await node('capture.mjs', '--config', cfg, '--side', 'original');
  check(co.code === 0, 'original capture succeeded');
  const dom = fs.readFileSync(path.join(ws, 'original', 'home--desktop', 'dom.html'), 'utf8');
  check(!dom.includes('jane.doe@company.com'), 'email address was redacted from dom.html');
  check(!dom.includes('__cloneProbe'), 'probe script was not saved into dom.html');

  // 3. perfect clone = the stamped DOM itself -> must PASS
  fs.writeFileSync(path.join(cloneSrc, 'index.html'), dom);
  const cc = await node('capture.mjs', '--config', cfg, '--side', 'clone', '--hover-from', path.join(ws, 'original'));
  check(cc.code === 0, 'clone capture succeeded');
  const good = await node('compare.mjs', '--config', cfg, '--build-ok', 'true', '--out', path.join(ws, 'qa', 'good'));
  check(good.code === 0, `perfect clone passes: ${good.out.trim()}`);

  // 4. broken clone -> must FAIL on each planted defect
  const broken = dom
    .replace('</head>', `<style>
      .card { box-shadow: rgba(0, 0, 0, 0.9) 0px 20px 40px 0px !important; }
      .btn { background-image: linear-gradient(135deg, rgb(255, 0, 0) 0%, rgb(0, 255, 0) 100%) !important; }
      .btn:hover { opacity: 1 !important; }
      h1 { letter-spacing: 0px !important; }
    </style></head>`)
    .replace(/<div class="row"[^>]*>Refactor sidebar<\/div>/, '');
  fs.writeFileSync(path.join(cloneSrc, 'index.html'), broken);
  await node('capture.mjs', '--config', cfg, '--side', 'clone', '--hover-from', path.join(ws, 'original'));
  const bad = await node('compare.mjs', '--config', cfg, '--build-ok', 'true', '--out', path.join(ws, 'qa', 'bad'));
  check(bad.code === 1, `broken clone fails: ${bad.out.trim()}`);
  const f = JSON.parse(fs.readFileSync(path.join(ws, 'qa', 'bad', 'failures.json'), 'utf8'));
  const has = (kind, prop) => f.some((x) => x.kind === kind && (!prop || x.prop === prop));
  check(has('style', 'boxShadow'), 'caught the wrong shadow (the old script passed it)');
  check(has('style', 'backgroundImage'), 'caught the wrong gradient colors (the old script passed them)');
  check(has('style', 'letterSpacing'), 'caught the letter-spacing change');
  check(has('hover', 'opacity'), 'caught the missing hover state');
  check(has('geometry') || has('missing'), 'caught the removed row (layout shift)');
  check(has('pixels'), 'pixel diff flagged the view');
  check(!f.some((x) => x.kind === 'style' && x.prop === 'backgroundColor' && x.cid === 'body'),
    'did not flag the identical body color (the old script failed "rgb(255,255,255)" vs "rgb(255, 255, 255)")');

  // 5. build flag is required
  const nob = await node('compare.mjs', '--config', cfg, '--out', path.join(ws, 'qa', 'x'));
  check(nob.code === 2, 'gate refuses to run without a build result');

  // 6. partition
  const pb = await node('partition-bugs.mjs', '--config', cfg, '--failures', path.join(ws, 'qa', 'bad', 'failures.json'), '--out', path.join(ws, 'fix'));
  const idx = JSON.parse(fs.readFileSync(path.join(ws, 'fix', 'index.json'), 'utf8'));
  check(idx.sets.length === 1 && idx.sets[0].files[0] === 'index.html', `partition placed failures in index.html (${pb.out.trim()})`);
} finally {
  orig.close(); clone.close();
  console.log(`\nworkspace kept for inspection: ${ws}`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
