---
name: clone-app-claude
description: Clones a web app or website from a URL and PROVES the match by comparing the clone to the original, element by element and pixel by pixel. Handles logged-in apps safely (the user logs in by hand, writes are blocked, destructive buttons are never clicked). Use when the user says "clone this app", "replicate this site", "copy this UI", "rebuild this page pixel for pixel", "build a clone of", or gives a URL to reproduce.
argument-hint: <url> <name>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# Clone App (Claude version)

Goal: a clone that matches the original, **measured against the original itself**, not against a token list we wrote ourselves.

Read [`references/pipeline.md`](references/pipeline.md) before stage 1. It holds the file layout, the element-identity rule, the gate, the fix loop and the sub-agent prompts.

## Three rules that make this work

1. **Scripts do the measuring. Agents do the building.** Playwright scripts write every measurement straight to disk. No JSON passes through the chat, so nothing gets retyped or invented.
2. **Every element has an identity.** `capture.mjs` stamps a `data-cid` on every element of the original. The builder copies that `data-cid` onto the matching element in the clone. `compare.mjs` pairs them and checks styles, position, size, hover and pixels.
3. **The real app is never harmed.** The user logs in by hand (`login.mjs`). The sweep never clicks links, never types, never submits, and skips any control whose name matches the deny list (delete, send, pay, log out …). Write requests to the real site are blocked at the network level.

## Setup (once per machine)

```bash
cd <this skill>/scripts && npm install && npx playwright install chromium && npm test
```
`npm test` must print `all checks passed`. If it does not, stop and report the output.

## Stages — stop and check in after each one

After each stage: give a short summary, list the artifact paths, show 2–4 screenshots with Read, then ask **approve / revise / stop**. Do not call a tool until the user replies. **The one exception** is the fix loop in stage 6: the user approves it once, then it runs until a terminal state.

| # | Stage | Who | Command / output |
|---|---|---|---|
| 0 | Setup | you | write `clone-workspace/<name>/config.json`. If the app needs login: `node scripts/login.mjs --config …` (user logs in, closes window). Ask whether a demo workspace exists; prefer it. |
| 1 | Map | script | `node scripts/sweep.mjs --config …` → `sweep/states.json`, `routes-found.json`, `blocked-requests.json`, `sweep/shots/`. User picks which routes and states to keep. Copy the kept states to `<ws>/states.json`; add kept routes to `config.json`. |
| 2 | Capture original | script | `node scripts/capture.mjs --config … --side original` → `original/<view>--<viewport>/{elements.json, shot.png, dom.html}`, `original/assets/`. |
| 3 | Design spec | 1 sub-agent | `design/DESIGN.md` — tokens ranked by frequency, from `elements.json` + downloaded CSS. It guides building and later customizing. **It is not the gate.** |
| 4 | Architecture + foundation | 1 sub-agent, then 1 builder | `design/component-map.md` assigns every cid to a component. Foundation builds tokens, layout, shared components, with `data-cid` on every element. |
| 5 | Build pages + first gate | N sub-agents in parallel (one per route, disjoint files), then scripts | build → `capture --side clone --hover-from <ws>/original` → `compare.mjs` → `qa/cycle-0/metrics.json`. Show the numbers and the worst 3 diff images. |
| 6 | Converge (autonomous) | fix sub-agents + scripts | the loop in `pipeline.md` §5. Ends in PASS, STUCK, CEILING or BLOCKED. Write `final-report.md`. |
| 7 | Extend (only if asked) | sub-agents | new features in the clone's design language. See `pipeline.md` §7. |

## The gate (stage 5 and 6)

```bash
npm run build --prefix <output_dir> && B=true || B=false
node scripts/capture.mjs --config <ws>/config.json --side clone --hover-from <ws>/original
node scripts/compare.mjs --config <ws>/config.json --build-ok $B --out <ws>/qa/cycle-N
```
PASS means all of these at once: build succeeds, 100% of original elements exist in the clone, 0 style / geometry / hover failures, and every view's pixel mismatch is at or below `gate.max_pixel_mismatch_pct` (default 2%). `compare.mjs` exits 0 on PASS and 1 on FAIL. Never report PASS without that exit code.

## Stop conditions

- `capture` or `sweep` exits with code 3 → **BLOCKED** (login wall or bot check). Tell the user. Never try to solve a CAPTCHA. Never type a password.
- Canvas, WebGL or video surfaces → the pixel diff will fail there. Mask them in `config.json` (`"mask": ["[data-cid=canvas-…]"]`) and hand them to the `shader-extract` skill if the user wants them rebuilt.
- Never paste `elements.json` or `failures.json` into the chat. Summarize with `jq`.

## Honesty rules

- A value you did not measure is unknown. Say so.
- Downloaded fonts, images and brand assets belong to the site owner. Tell the user this at stage 2. The clone is for study and internal use unless they hold the rights.
- If the app shows private data (names, emails, customers), tell the user at stage 1. Email addresses are masked in saved text, but screenshots still show everything.
