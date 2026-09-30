#!/usr/bin/env node
// login.mjs — open a visible browser with the clone's private profile so the USER logs in by hand.
// Claude never types a password. The session stays in the profile folder for later runs.
//
// Usage: node login.mjs --config <workspace>/config.json
import { parseArgs, loadConfig, launch } from './lib/common.mjs';

const args = parseArgs();
const cfg = loadConfig(args.config);
const { context } = await launch(cfg, 'original', { headed: true });
const page = context.pages()[0] || (await context.newPage());
await page.goto(cfg.target, { waitUntil: 'domcontentloaded' }).catch(() => {});
console.log(`A browser window is open on ${cfg.target}.`);
console.log('Log in there yourself. Then close the window to save the session.');
console.log(`Profile folder: ${cfg.profile_dir}`);
await new Promise((resolve) => context.on('close', resolve));
console.log('Session saved.');
