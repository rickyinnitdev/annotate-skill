# Draw Mode and App Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users circle/mark areas with a comment on web pages (Draw mode), and capture any app window, draw on the frame and send it to the agent (App snapshots). Phase 1 only; Electron attach is a later plan.

**Architecture:** A shared, dependency-free `draw.js` (geometry + SVG/canvas rendering + pointer capture) is bundled into the injected toolbar and also served to a new local "snap" page. The toolbar gains a Draw mode whose drafts carry shapes; the server screenshots the drawn area over CDP. The snap page (served by a tiny HTTP server inside annotate-mcp) uses `getDisplayMedia` to grab frames of any window, crops client-side and sends JPEG data URLs through the existing `__annotate_send` binding.

**Tech Stack:** Node ≥20 ESM, Playwright over CDP (existing browser-core daemon), MCP SDK + zod, plain browser JS, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-04-draw-and-app-annotate-design.md`

## Global Constraints

- No new npm dependencies; no build step; no changes to `packages/browser-core`.
- Toolbar code stays plain browser JS, DOM built without `innerHTML` (Trusted Types pages must keep working; the existing e2e asserts no console errors).
- Images: JPEG, crops ≤480×360 (`SHOT_W`/`SHOT_H`), full frames ≤1600 px wide; at most 2 images per delivered batch; `ANNOTATE_IMAGES=0` disables all images.
- Drawings (`kind:'draw'`) and app annotations (`kind:'app'`) always get their image (within the cap), ordered before element annotations; element annotations keep the `VISUAL` regex rule.
- Tool results stay within `TOKEN_BUDGET` (500 tokens); `under` and `full` are only returned by `get_annotation_details`.
- Drawing colour red `#ef4444`, stroke 3 px; tools `pen` (default), `ellipse`, `arrow`.
- Snap capture stream stays open between captures until the user picks another window or closes the page.
- Existing click-to-annotate, push mode, queue and OpenCode plugin behaviour unchanged.

## Review Focus

- Drawing while the page is scrolled: the stored `box` is in page coordinates and the crop shows the drawn area, not the top of the page. (Task 2 test)
- A click without dragging in Draw mode (box smaller than 6×6 px) creates no drawing and no popover. (Task 1 unit + Task 2 test)
- Drawing over empty page space (only `body`/`html` under it) still sends an annotation with a screenshot and no `source`, and nothing throws. (Task 2 test)
- Drawing at the corner of an app frame: the crop is clamped to the frame and is non-empty. (Task 1 unit + Task 4 test)
- Cancelling the comment (Esc / Cancel) removes the stroke; no orphan drawing is left or sent. (Task 2 test)

---

## File Structure

- Create `packages/annotate-mcp/src/draw.js` — pure geometry (`shapeBox`, `isTiny`, `cropRect`), rendering (`shapeToSvg`, `paintShape`), pointer capture (`attachDrawing`). Defines top-level functions only; no IIFE, no globals beyond those function declarations.
- Modify `packages/annotate-mcp/src/toolbar.js` — Draw button/mode, draw drafts, `elementsUnder`, capture mode, skip on snap origin.
- Create `packages/annotate-mcp/src/snap-server.js` — local HTTP server for the snap page.
- Create `packages/annotate-mcp/src/snap.html`, `packages/annotate-mcp/src/snap.js` — the App snapshot page.
- Modify `packages/annotate-mcp/src/server.js` — bundle, `kind` handling, image rule, `open_app`, details fields, resolve for app items.
- Modify `packages/annotate-mcp/src/queue.js` — `ANNOTATIONS.md` and history lines for draw/app items.
- Create `packages/annotate-mcp/test/draw-unit.test.js`, `packages/annotate-mcp/test/harness.js`, `packages/annotate-mcp/test/draw-app.test.js`.
- Modify `packages/annotate-mcp/test/e2e.test.js` (tool list only), `README.md`, `skills/annotate/SKILL.md`.

---

### Task 1: Shared drawing module

**Files:**
- Create: `packages/annotate-mcp/src/draw.js`
- Modify: `packages/annotate-mcp/src/server.js:16` (bundle)
- Test: `packages/annotate-mcp/test/draw-unit.test.js`

**Interfaces:**
- Produces (all top-level `function` declarations in `draw.js`):
  - Shape: `{ tool: 'pen'|'ellipse'|'arrow', points: [[x, y], ...] }` — pen has ≥1 points; ellipse/arrow have exactly 2 (start, end).
  - `shapeBox(shape) -> { x, y, w, h }` — bounding box of points (ellipse: the two points are opposite corners); for arrow add 12 px on each side for the head.
  - `isTiny(box) -> boolean` — `box.w < 6 && box.h < 6`.
  - `cropRect(box, pad, maxW, maxH) -> { x, y, w, h }` — box grown by `pad`, clamped to `[0,maxW]×[0,maxH]`, integers, `w,h ≥ 1`.
  - `shapeToSvg(shape) -> SVGElement` — `path` (pen), `ellipse`, or `g` (line + head) with stroke `#ef4444`, width 3, no fill; uses `document.createElementNS`.
  - `paintShape(ctx, shape, scale = 1, dx = 0, dy = 0)` — same look on a 2D canvas; point `p` maps to `((p.x - dx) * scale, (p.y - dy) * scale)`.
  - `attachDrawing(target, { toLocal(e) -> [x, y], getTool() -> tool, preview(shape|null), onDone(shape) }) -> detach()` — pointerdown/move/up on `target` (pointer capture), calls `preview` while dragging and `preview(null)` + `onDone(shape)` on release; `onDone` is not called when `isTiny(shapeBox(shape))`.
  - server.js: `TOOLBAR` becomes `` `(() => {\nconst SNAP_ORIGIN = ${JSON.stringify(snapOrigin)};\n${DRAW_SRC}\n${TOOLBAR_SRC}\n})();` `` built by `buildToolbar(snapOrigin: string|null) -> string`. In this task call it with `null`; Task 3 passes the real origin.

- [ ] **Step 1: Write the failing test** — load `draw.js` into a `node:vm` context and test the pure functions:

```js
const ctx = vm.createContext({}); vm.runInContext(readFileSync(DRAW, 'utf8'), ctx);
test('shapeBox pen', () => assert.deepEqual({ ...ctx.shapeBox({ tool: 'pen', points: [[10, 20], [30, 5], [15, 40]] }) }, { x: 10, y: 5, w: 20, h: 35 }));
test('shapeBox ellipse from any corner order', () => assert.deepEqual({ ...ctx.shapeBox({ tool: 'ellipse', points: [[50, 60], [10, 20]] }) }, { x: 10, y: 20, w: 40, h: 40 }));
test('shapeBox arrow includes head margin', () => assert.deepEqual({ ...ctx.shapeBox({ tool: 'arrow', points: [[100, 100], [200, 100]] }) }, { x: 88, y: 88, w: 124, h: 24 }));
test('isTiny', () => { assert.equal(ctx.isTiny({ x: 0, y: 0, w: 5, h: 5 }), true); assert.equal(ctx.isTiny({ x: 0, y: 0, w: 5, h: 40 }), false); });
test('cropRect clamps at frame corner', () => assert.deepEqual({ ...ctx.cropRect({ x: 2, y: 3, w: 10, h: 10 }, 24, 800, 600) }, { x: 0, y: 0, w: 36, h: 37 }));
test('cropRect clamps at far edge', () => assert.deepEqual({ ...ctx.cropRect({ x: 790, y: 590, w: 20, h: 20 }, 24, 800, 600) }, { x: 766, y: 566, w: 34, h: 34 }));
test('toolbar bundle parses', () => { new vm.Script(`(() => {const SNAP_ORIGIN=null;\n${readFileSync(DRAW,'utf8')}\n${readFileSync(TOOLBAR,'utf8')}\n})();`); });
```

- [ ] **Step 2: Run it to verify it fails** — `node --test packages/annotate-mcp/test/draw-unit.test.js` → FAIL (`draw.js` missing).
- [ ] **Step 3: Implement `draw.js`** with the signatures above; in `server.js` add `buildToolbar(null)` and use it in `addInitScript`.
- [ ] **Step 4: Run tests** — `npm test` → all pass (existing e2e unaffected).
- [ ] **Step 5: Commit** — `git add packages/annotate-mcp && git commit -m "Add shared drawing module and toolbar bundle"`

---

### Task 2: Draw mode on web pages

**Files:**
- Modify: `packages/annotate-mcp/src/toolbar.js`, `packages/annotate-mcp/src/server.js`, `packages/annotate-mcp/src/queue.js`
- Create: `packages/annotate-mcp/test/harness.js`, `packages/annotate-mcp/test/draw-app.test.js`
- Modify: `skills/annotate/SKILL.md`, `README.md` (Draw mode section + toolbar reference row)

**Interfaces:**
- Consumes: Task 1 `draw.js` functions.
- Produces:
  - Toolbar: **Draw** button (title `Alt+Shift+D`) and a small tool picker (Pen / Ellipse / Arrow) visible while drawing. Draw and Annotate modes are mutually exclusive. Draw drafts in `drafts`: `{ n, kind: 'draw', comment, path, shapes: [shape], box }` with page coordinates. Rendered as SVG in `ui.layer` (sized to `document.documentElement.scrollWidth/Height`) with a numbered pin at `box.x, box.y`. Cancel/Esc on the popover discards the stroke.
  - `elementsUnder(box) -> Element[]` in toolbar.js: `elementsFromPoint` at the centre and a 3×3 grid of the box (viewport coords), skipping the toolbar host, `html`, `body`; order: smallest element containing the centre first, then up to 3 distinct others.
  - Send item for drawings: `{ n, kind: 'draw', comment, path, box, shapes, ...describe(best), under: rest.slice(0, 3).map(el => ({ selector: selectorFor(el), source: sourceFor(el) })) }`; if no element, `selector: ''`, `source: ''`.
  - `window.__annotate.capture(on: boolean)` — hides bar, pins and popovers but keeps strokes visible.
  - Server: `shootBox(page, box, id) -> relPath|undefined` — scrolls `box` into view, clips `cropRect(box, 24, docW, docH)` in viewport coordinates scaled to ≤480×360; `onToolbar` uses `capture(true)` around `shootBox` for draw items and `hide(true)` for element items as today. Record gains `kind`, `box`, `under`. `summary()` adds `kind:'draw'` and omits `selector` when empty. `toolbarState()` open entries add `kind` and `box`. Image selection: `[...draw/app items with screenshot, ...element items matching VISUAL].slice(0, 2)`. `get_annotation_details` field enum gains `'under'` and `'box'`.
  - `queue.flush` line for draw: `- [ ] **a5** /path [drawing] (src/x.tsx:3): comment`; `remember` stores `selector: a.selector || '[drawing]'`.
  - `test/harness.js`: `export async function startHarness({ html }) -> { project, url, call(name, args), human() -> Promise<{ browser, page }>, close() }`, extracted from `e2e.test.js` setup (own temp `BROWSER_CORE_HOME`, headless, project dir with `src/styles/global.css`).

- [ ] **Step 1: Write the failing tests** in `draw-app.test.js` using the harness and a page with a tall body (`<div style="height:2000px">`), an element `<section class="card" data-source="src/Card.tsx:4" style="position:absolute;top:900px;left:100px;width:300px;height:200px">Card</section>`:
  - `draw circle over element while scrolled`: `open`; human scrolls to y=800, presses `Alt+Shift+D`, drags mouse from (120,120)→(380,260) in 10 steps, types `Make this card blue`, Ctrl+Enter, `Alt+Shift+S`. Assert annotation `kind === 'draw'`, `source === 'src/Card.tsx:4'`, `screenshot` exists with width ≤480 and height ≤360, `images.length === 1`, token size < 500; `get_annotation_details(id, ['under'])` returns an array; `get_annotation_details(id, ['box'])` returns `box.y >= 800`.
  - `tiny click makes no drawing`: in Draw mode, `mouse.down/up` at one point → no popover in the page (`await page.evaluate(() => document.querySelector('annotate-toolbar') !== null)` and Send button stays disabled — assert by `Alt+Shift+S` then `wait_for_feedback({timeout_sec:10})` returns `status:'waiting'`).
  - `cancel removes the stroke`: drag, press Escape in the popover, then `Alt+Shift+S` → `wait_for_feedback` returns `waiting`.
  - `drawing over empty space`: drag in an empty area at top (20,20)→(90,90) at scroll 0, comment, send → `kind:'draw'`, no `source`, `screenshot` present, `errors` undefined after `resolve_annotation`.
- [ ] **Step 2: Run them to verify they fail** — `node --test packages/annotate-mcp/test/draw-app.test.js` → FAIL (no Draw mode).
- [ ] **Step 3: Implement** the toolbar, server and queue changes above; refactor `e2e.test.js` setup onto `harness.js` only if it stays green, otherwise leave it.
- [ ] **Step 4: Update docs** — SKILL.md: annotations may have `kind:'draw'` (the comment is about the circled area; `source`/`css` describe the main element under it; ask `get_annotation_details(id, ['under'])` for neighbours; the image is attached). README: "Draw mode" subsection in walkthrough and a toolbar reference row for Draw / `Alt+Shift+D`.
- [ ] **Step 5: Run tests** — `npm test` → all pass.
- [ ] **Step 6: Commit** — `git commit -m "Add Draw mode: circle an area and comment on it"`

---

### Task 3: Snap page server and `open_app` tool

**Files:**
- Create: `packages/annotate-mcp/src/snap-server.js`, `packages/annotate-mcp/src/snap.html` (placeholder shell in this task: title, `<meta name="annotate-snap">`, `<script src="/draw.js">`, `<script src="/snap.js">`), `packages/annotate-mcp/src/snap.js` (empty stub)
- Modify: `packages/annotate-mcp/src/server.js`, `packages/annotate-mcp/src/toolbar.js:4`, `packages/annotate-mcp/test/e2e.test.js:39`, `packages/annotate-mcp/test/draw-app.test.js`

**Interfaces:**
- Produces:
  - `startSnapServer({ token: string }) -> Promise<{ origin: string, url: string, close() }>` — binds `127.0.0.1:0`; serves `GET /snap?t=<token>` → snap.html (403 on wrong/missing token), `GET /snap.js`, `GET /draw.js` (from `src/`), all with `cache-control: no-store`; everything else 404.
  - server.js: module-level `snap` started once (lazily) in `ensureBrowser()` before `addInitScript(buildToolbar(snap.origin))`; `SNAP_TOKEN = randomBytes(16).toString('hex')`.
  - toolbar.js line 4 guard adds `|| (typeof SNAP_ORIGIN === 'string' && location.origin === SNAP_ORIGIN)`.
  - Tool `open_app` — description `'Open the Annotate App page to snapshot any app window on screen, draw on it and comment.'`, no input; finds a page whose URL starts with `snap.url` or opens one, `bringToFront`, returns `{ ok: true, pending, next }` with the same `next` strings as `open` but the ready line `'✅ Annotate ready. Choose a window, capture, draw and comment, then Send to AI.'`.

- [ ] **Step 1: Write the failing tests** — e2e tool list becomes `['get_annotation_details', 'open', 'open_app', 'resolve_annotation', 'wait_for_feedback']`; new test `open_app serves snap page`: call `open_app` → `ok`; human finds the page whose title is `Annotate · App`; assert `await page.evaluate(() => !!document.querySelector('meta[name=annotate-snap]'))` and that no `annotate-toolbar` element exists; `fetch(origin + '/snap')` without token → 403.
- [ ] **Step 2: Run to verify fail** — `npm test` → FAIL (no `open_app`).
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4: Run tests** — `npm test` → pass.
- [ ] **Step 5: Commit** — `git commit -m "Serve the App snapshot page and add open_app tool"`

---

### Task 4: App snapshots — capture, draw, send, resolve

**Files:**
- Modify: `packages/annotate-mcp/src/snap.html`, `packages/annotate-mcp/src/snap.js`, `packages/annotate-mcp/src/server.js`, `packages/annotate-mcp/src/queue.js`, `packages/annotate-mcp/test/draw-app.test.js`, `skills/annotate/SKILL.md`, `README.md`

**Interfaces:**
- Consumes: Task 1 `draw.js` (loaded as `/draw.js`), Task 3 snap server/token.
- Produces:
  - Snap page UI (ids are test contract): `#choose` (Choose window → `getDisplayMedia({ video: true, audio: false })`, keeps the `MediaStream`; picking again stops the old tracks), `#capture` (freeze current video frame into a new frame; disabled until a stream exists), `#app-name` (text input, persisted in `localStorage['annotate.appName']` inside try/catch; prefilled from `track.label` only when it doesn't match `/^(window|screen|web-contents-media-stream):/`), `#frame` (wrapper with the frozen frame canvas + SVG overlay in frame pixel coordinates; tool picker Pen/Ellipse/Arrow), `#send` (`Send to AI (n)`, disabled with no drafts), `#status` (status line from sync). Picker rejection (user cancels) shows `Window not shared` in `#status` and doesn't throw. Stream `ended` event shows `Window sharing stopped`.
  - Drafts: `{ n, frame: index, shape, box, comment }`; each stroke → comment popover (Save/Cancel; Cancel discards). Thumbnails/list of frames is the builder's call.
  - Test hook: `window.__snap.useFrame(dataUrl: string, label?: string) -> Promise<void>` adds a frame from an image without `getDisplayMedia`.
  - `window.__annotate = { sync(state), setStatus(s), hide() {}, capture() {} }` defined by snap.js so server broadcasts update `#status` and mark drafts sent/done (same labels as toolbar `LABELS`).
  - Send message: `{ type: 'send', kind: 'app', token, url: location.href, path: '/snap', app, frames: [jpegDataUrl], items: [{ n, comment, frame, region: { x, y, w, h } /* 0–1, 3 decimals */, crop: jpegDataUrl }] }` — full frames JPEG q 0.7 scaled to ≤1600 px wide, only frames that have drafts (re-indexed); crops = `cropRect(box, 24, frameW, frameH)` painted with `paintShape`, scaled to ≤480×360, JPEG q 0.6.
  - server.js `onToolbar`: `msg.kind === 'app'` path — reject (return `toolbarState()`) unless `msg.token === SNAP_TOKEN`; accept ≤5 frames and ≤50 items; each data URL must start with `data:image/jpeg;base64,` and decode to ≤4 MB, else that item is skipped. Writes `shots/<id>.jpg` (crop) per item and `shots/<firstIdOfFrame>-full.jpg` per frame. Record: `{ id, n, kind: 'app', comment, url, path, app, region, screenshot, full }`.
  - `summary()` for app: `{ id, comment, kind: 'app', app?, region: [x, y, w, h], screenshot }`. Images: included per Task 2 rule. `get_annotation_details` field `'full'` returns the full-frame image block (`'screenshot'` keeps returning the crop).
  - `resolve_annotation`: app items aren't reloaded; when any resolved id is `kind:'app'`, append to `next`: `' For app annotations, tell the user to restart or hot-reload their app to see the change.'`.
  - queue.js: line `- [ ] **a7** [app: <app or 'window'>] (x,y w×h): comment`; `remember` stores `selector: a.selector || \`[app: ${a.app || 'window'}]\``.

- [ ] **Step 1: Write the failing tests** in `draw-app.test.js`:
  - `app snapshot round trip`: `open_app`; human page; `__snap.useFrame(<800×600 PNG/JPEG data URL drawn with a canvas in page.evaluate>, 'window:1:0')`; fill `#app-name` with `My Settings`; drag on `#frame` from 10%,10% → 40%,30% of its box; type `Bigger save button`, Ctrl+Enter; click `#send`. Assert annotation `kind === 'app'`, `app === 'My Settings'`, `region` 4 numbers in [0,1] with `region[0]` ≈ 0.1 (±0.03), `images.length === 1`, crop file ≤480×360, `get_annotation_details(id, ['full'])` returns 1 image; `.annotate/ANNOTATIONS.md` contains `[app: My Settings]`; the label `window:1:0` did not prefill the name (clear the field first and check `#app-name` value is `''` after `useFrame`, before filling).
  - `crop at frame corner`: drag from (1,1)px → (40,30)px of the frame → crop file exists, width and height > 0.
  - `wrong token is ignored`: from the human page, `window.__annotate_send({ type: 'send', kind: 'app', token: 'nope', items: [...] })` then `wait_for_feedback({ timeout_sec: 10 })` → `status: 'waiting'`.
  - `resolve app annotation`: `resolve_annotation({ ids, wait: false })` → `next` mentions `restart or hot-reload`; snap page `#status` shows `Done ✓`.
- [ ] **Step 2: Run to verify fail** — `node --test packages/annotate-mcp/test/draw-app.test.js` → FAIL.
- [ ] **Step 3: Implement** snap page and server/queue changes above.
- [ ] **Step 4: Update docs** — SKILL.md: new `open_app` start option; `kind:'app'` annotations have no `source`: use `app`, the attached image's visible text and the project to find the code; `get_annotation_details(id, ['full'])` for the whole window. README: "Annotating desktop apps" section (Choose window, Capture, draw, name field, sharing indicator stays on; Linux Wayland portal prompt; Windows nothing to set; macOS Screen Recording permission + restart, bundled Chromium appears as "Chromium"; text-only models (`ANNOTATE_IMAGES=0`) get no image; Tauri: use App snapshots) and `open_app` in tools list.
- [ ] **Step 5: Run tests** — `npm test` → all pass.
- [ ] **Step 6: Manual check on Linux/Wayland** — run the MCP server via the agent, `open_app`, Choose window → portal picker → pick a real window, Capture, draw, Send; confirm the agent receives the crop. Record the result in the PR description.
- [ ] **Step 7: Commit** — `git commit -m "Add App snapshots: capture any window, draw and comment"`
