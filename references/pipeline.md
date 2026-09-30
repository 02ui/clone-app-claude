# Pipeline reference

One file. If SKILL.md and this file disagree, this file wins.

## 1. Workspace layout

```
clone-workspace/<name>/
├── config.json                 # you write this at stage 0 (see §2)
├── states.json                 # the interaction states the user kept (copied from sweep/)
├── sweep/                      # stage 1: states.json, routes-found.json, blocked-requests.json, shots/
├── original/                   # stage 2
│   ├── <view>--<viewport>/     # elements.json, shot.png, dom.html, meta.json
│   ├── assets/{fonts,img,css}/ # real downloaded bytes
│   ├── assets.json             # url -> local file, or the download error
│   └── blocked-requests.json   # write requests the guard stopped
├── design/                     # stage 3-4: DESIGN.md, component-map.md, file-tree.md
├── clone/                      # the clone's capture (overwritten each cycle)
├── qa/cycle-<N>/               # metrics.json, failures.json, diff/<view>--<viewport>.png
├── fix/cycle-<N>/              # fix-set-<k>.json, fix-shared.json, index.json
├── progress.md                 # one line per stage and per cycle
└── final-report.md
```

A **view** is a route (`home`, `team-eng-active`) or a saved state (`home--click-filter-a1b2`). Every view is captured at every viewport.

## 2. config.json

```json
{
  "name": "linear",
  "target": "https://linear.app/",
  "routes": ["/", "/team/ENG/active"],
  "output_dir": "../../linear-clone",
  "clone_url": "http://localhost:3000/",
  "viewports": { "desktop": [1440, 900], "tablet": [768, 1024], "mobile": [390, 844] },
  "mask": [],
  "redact": true,
  "gate": { "max_pixel_mismatch_pct": 2, "geometry_tol_px": 2, "style_tol_px": 1, "min_coverage": 1 },
  "safety": { "allow_post": [], "extra_deny": [], "max_states_per_route": 40 }
}
```

- `profile_dir` defaults to `~/.clone-app-claude/profiles/<name>`. It holds the login session. It never goes in git.
- `safety.allow_post`: regex list of READ endpoints that use POST (for example Notion's `/api/v3/loadPageChunk`). Look at `blocked-requests.json` after stage 1. If a view loads empty because a read was blocked, add that endpoint and ask the user first.
- `browser_channel: "chrome"` uses the installed Chrome instead of Playwright's Chromium. Try it if a site rejects the default browser.
- `mask`: selectors for regions that change on every load (relative times, avatars, ads). Use `[data-cid=…]` selectors so they work on both sides.

## 3. Element identity — the one rule every builder follows

`capture.mjs --side original` stamps `data-cid="<tag>-<12 hex>"` on every element. The value comes from the element's DOM path, so it is stable between loads. `dom.html` in each view folder holds the full DOM with those attributes.

**The builder puts the same `data-cid` on the matching element in the clone.** Every element listed in `original/<view>--<viewport>/elements.json` must exist in the clone with its cid.

- `body` has cid `body`. Put `data-cid="body"` on the clone's `<body>`.
- Repeated items (list rows, cards): the original keeps the first 2 of each identical sibling group. Store those cids in the mock data and render them: `data-cid={row.cid}`. Rows 3+ need no cid.
- Elements that exist only after an interaction (menus, panels, editor toolbars) have cids in the state views (`<view>--click-…`). The trigger the sweep clicked has a cid too. The clone must render that trigger with that cid, and the same click must reveal the same UI.
- A cid can appear in several viewports. Use one element for all of them; responsive CSS handles the differences.

Useful reads (never paste the whole file into the chat):
```bash
jq -r '.elements[] | [.cid, .tag, (.rect|"\(.x),\(.y) \(.w)x\(.h)"), .text] | @tsv' original/home--desktop/elements.json | head -80
jq '.elements[] | select(.cid=="button-3fa2c1d09e4b")' original/home--desktop/elements.json
jq -r '[.[] | .kind] | group_by(.) | map("\(.[0]): \(length)") | .[]' qa/cycle-3/failures.json
```

## 4. The gate — what compare.mjs checks

Paired by cid, per view and viewport:

| Check | Rule |
|---|---|
| coverage | every original element exists in the clone (`missing` otherwise) |
| style | every property in `probe.js` PROPS. Colors per channel ±1 and alpha ±0.01. Lengths ±`style_tol_px`. Shadows, gradients, filters and transforms are compared token by token, so a wrong color stop or blur fails. Font family compares the first family only. |
| geometry | x, y, width, height within ±`geometry_tol_px` |
| hover | where the original changes on hover, the clone must reach the same values |
| pixels | full-page screenshot mismatch ≤ `max_pixel_mismatch_pct`, with `qa/cycle-N/diff/<view>.png` |
| build | `--build-ok true` is required. The gate refuses to run without it. |

`metrics.json` has `pass`, `reasons`, `coverage`, `totals` and one row per view. `failures.json` is sorted top of page first, because a wrong header height moves everything below it.

## 5. The convergence loop (stage 6)

```
git -C <output_dir> init (if needed); commit "cycle-0"
prev = totals.failures of cycle 0; stall = 0
for N in 1..10:
  node scripts/partition-bugs.mjs --config … --failures qa/cycle-<N-1>/failures.json --out fix/cycle-<N> --max 4
  run one FIX sub-agent per fix-set-<k>.json IN PARALLEL (they edit only their files, no browser)
  then run ONE fix sub-agent on fix-shared.json ALONE (missing elements, page-level pixel failures)
  build → capture clone → compare → qa/cycle-<N>
  if pass: CONVERGED-PASS; stop
  if totals.failures >= prev:
      for each set k: if its files' failure count did not drop → git checkout -- <its files>
      stall += 1
  else stall = 0
  git commit -am "cycle-<N>"; prev = min(prev, totals.failures)
  if stall >= 2: STUCK; stop
after 10 cycles: CEILING
```

Fix agents never open a browser and never measure. Only the orchestrator measures, once per cycle, so parallel edits never corrupt each other's readings.

Terminal states: `CONVERGED-PASS`, `STUCK`, `CEILING`, `BLOCKED`. Each one writes `final-report.md` with: final metrics, the failure count per cycle, the remaining failures grouped by kind, and the 3 worst diff images.

## 6. Sub-agent prompts

Every prompt has these parts, in this order: ROLE, INPUTS (exact paths), TASK, OUTPUTS (exact paths), RULES, DONE WHEN. Sub-agents have no memory of this conversation. Give them paths, not summaries.

**Design spec (stage 3)**
```
ROLE: You write the design system for a clone of {target}.
INPUTS: <ws>/original/*/elements.json, <ws>/original/assets.json, <ws>/original/assets/css/*.css
TASK: 1) Count every value of color, backgroundColor, backgroundImage, fontFamily, fontSize, fontWeight,
lineHeight, letterSpacing, padding*, *Radius, boxShadow across all views (use jq, weight by element count).
2) Name the most frequent values as tokens. 3) Read the CSS files for custom properties (--*), @font-face,
@media breakpoints and :hover rules. 4) Map each font family to a downloaded file in assets/fonts.
OUTPUTS: <ws>/design/DESIGN.md — theme paragraph, color / gradient / type / spacing / radius / shadow / motion
/ breakpoint tables, each row with its evidence (count + one example cid).
RULES: every value comes from a file. Unknown = "unknown", never a guess. List font files whose licence
the user must check.
DONE WHEN: DESIGN.md exists and every token row has evidence.
```

**Architecture (stage 4a)**
```
ROLE: You plan the clone's code.
INPUTS: <ws>/design/DESIGN.md, <ws>/original/*/dom.html, <ws>/original/*/elements.json, <ws>/config.json
TASK: choose the stack (default Next.js App Router + plain CSS with custom properties). Write the file tree.
Assign EVERY cid in every elements.json to one component file. Assign repeated rows to a data file.
OUTPUTS: <ws>/design/file-tree.md, <ws>/design/component-map.md (component -> file -> cids)
DONE WHEN: `jq` over all elements.json gives no cid missing from component-map.md.
```

**Foundation and page builders (stage 4b and 5)**
```
ROLE: You build {scope} of the clone in {output_dir}.
INPUTS: design/DESIGN.md, design/component-map.md, original/<view>--*/dom.html, original/assets/
TASK: build the assigned components. Copy structure and class-free styling from dom.html. Use the CSS
tokens from the foundation only. Put the exact data-cid from component-map.md on every element.
Use the downloaded fonts and images from original/assets — never placeholders.
OUTPUTS: only the files assigned to you in component-map.md.
RULES: never edit another builder's files. Keep `npm run build` passing.
DONE WHEN: your files build and every cid assigned to you is rendered.
```

**Fix (stage 6)**
```
ROLE: You fix measured differences between the clone and the original.
INPUTS: fix/cycle-N/fix-set-K.json (files you own + failures), design/DESIGN.md,
original/<view>--<viewport>/dom.html and elements.json for the views named in the failures,
qa/cycle-(N-1)/diff/<view>.png
TASK: for each failure, top of page first: set the property to the "expected" value, in the owned file.
For geometry failures, fix the element's own size and spacing first; many follow from one parent.
For "missing", render the element with that cid.
OUTPUTS: edits to your owned files only.
RULES: no browser, no measuring, no edits outside your files. Do not change a value that is not in
your failure list.
DONE WHEN: every failure in your set has an edit, or a one-line reason why not.
```

## 7. Extend (only when the user asks)

New features have no original to compare to. Build them from existing components and DESIGN.md tokens only. Check them by eye with the user. If the user wants an API or an MCP server for the clone, build it against the clone's own mock data. Never connect it to the real app.
