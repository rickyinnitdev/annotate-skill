# Draw mode and annotating any app — design

Date: 2026-11-04 · Status: draft, awaiting approval

## Intent

Annotate today only works on web pages: the user clicks a DOM element in the Annotate browser, comments, and the
agent gets `file:line` + CSS rule. The user wants two things:

1. **Annotate any app built in the project**, not just websites: desktop apps (Qt, GTK, Flutter, Electron, Tauri,
   native…), so users can point at something in it and the agent fixes it.
2. **Draw mode**: circle / mark an area freehand and attach a comment to the drawing, as an alternative to clicking
   one element.

The common denominator across "any app" is a picture: every app can be captured, but only web tech can tell us
`file:line`. So draw mode is also the way non-web apps get annotated. Precise source mapping for web-based desktop
apps (Electron) comes as a second phase on top.

## Goals

- Draw mode on live web pages in the Annotate browser (pen, ellipse, arrow), each drawing carrying a comment.
- Snapshot mode: capture any app window on the user's screen, draw + comment on the capture, send to the agent.
- Works on Linux (Wayland and X11), Windows, macOS with no new native dependencies.
- Agent receives a cropped image of the marked area with the drawing baked in, plus whatever text context exists
  (window title, the elements under the drawing for web pages).
- Phase 2 (separate plan): attach Annotate to a running Electron app over CDP so click-to-annotate and draw mode work inside it
  with real `file:line`.

## Non-goals

- A transparent overlay drawing on the live desktop (rejected approach B).
- Source mapping for native toolkits (Qt, GTK, Flutter, SwiftUI…). The agent finds code from image + window
  title + the project; per-framework adapters can come later.
- Mobile apps / emulators, terminal apps (a terminal window can still be snapshotted like any window).
- Tauri CDP attach: WebKitGTK/WKWebView have no CDP. Tauri dev builds serve their UI from a dev server URL, so
  `open http://localhost:1420` loads the UI, but `window.__TAURI__`/`invoke` don't exist in a normal browser and
  many Tauri UIs will show error states there. Snapshot mode is the reliable path for Tauri.

## Anti-goals

- Breaking the token discipline: element annotations stay ~60 tokens; images remain small (≤480×360 JPEG).
- Breaking the existing click-to-annotate flow, the queue, push mode or the OpenCode plugin.
- New heavy dependencies (Electron, native screenshot binaries, OCR).

## Constraints

- Plain Node ≥20, no build step; toolbar stays dependency-free browser JS in `toolbar.js` (injected via
  `addInitScript`, talks only through `window.__annotate_send`).
- Wayland: CLI screenshot tools can't grab other windows. `navigator.mediaDevices.getDisplayMedia()` works on
  all platforms: Chromium shows its own picker on Windows, macOS and X11, and the xdg-desktop-portal / PipeWire
  picker on Wayland. It needs a user gesture.
- macOS: the browser needs Screen Recording permission (System Settings → Privacy) and a restart, otherwise other
  apps' windows are missing or blank. With the bundled Chromium the permission is for a separate "Chromium" app.
  README must say this.
- Web content cannot read the captured window's title: `track.label` is an internal id like `window:12345:0` (or
  empty on PipeWire) and `displaySurface` is only `window|monitor|browser`.
- Text-only models (`ANNOTATE_IMAGES=0`) get no image; for snapshot annotations they only get the comment, window
  title and normalized region. That is a known limit, not something to work around.

## Approaches considered

- **A. Snapshot + draw inside the existing Annotate browser** — chosen. Reuses toolbar, queue, MCP tools; works
  everywhere via `getDisplayMedia`; trade-off: you draw on a still frame, not the live app.
- **B. Transparent always-on-top desktop overlay** — rejected: needs Electron (~100 MB), per-OS work, and
  Wayland blocks overlays/capture of other apps.
- **C. Per-framework precise mapping** — adopted as phase 2 for Electron only, layered on A.

User picked "A now, C for Electron next".

## Design

### 1. Draw mode on web pages (toolbar.js)

- New toolbar button **Draw** next to Annotate. While active, a full-viewport canvas (inside the toolbar's
  shadow host, `pointer-events` on only while drawing) captures strokes. Tools: pen (default), ellipse, arrow;
  one colour (red); Esc / undo removes the last unsaved drawing.
- On stroke end, a comment box opens anchored at the drawing (same component as the element comment box).
  Save → becomes a draft with a number badge, like element drafts. Drafts persist in `sessionStorage` with
  page-coordinates (scroll-aware) so they survive scroll; they're drawn on an overlay layer.
- Draft shape for drawings: `{ n, kind: 'draw', comment, path, shapes: [{tool, points:[[x,y]...]}], box }` where
  `box` is the drawing's bounding rect in page coordinates.
- On send, for each drawing the toolbar also computes the elements under it: `elementsFromPoint` at the box
  centre and at a 3×3 grid within the box, ignore annotate UI, pick the smallest element that contains the box
  centre and up to 3 distinct others; run the existing `selectorFor` / `sourceFor` / `cssFor` on the best one,
  and send selectors + sources for the rest.

### 2. Server handling of drawings (server.js)

- `onToolbar` accepts items with `kind: 'draw'`. Screenshot: crop the box + 24 px padding with the drawing
  visible (server tells the toolbar to keep the drawing layer shown but hide the rest of the UI during capture),
  scaled to SHOT_W×SHOT_H.
- Annotation record: `kind: 'draw'`, `selector`/`source`/`css` from the best element (as today), `under:
  [{selector, source}]` (max 3), `screenshot`.
- Image attachment rule: drawings always get their image (the user drew because it's visual), still capped at 2
  images per batch, drawings first; element annotations keep the `VISUAL` regex rule. `ANNOTATE_IMAGES=0` still
  disables all images.

### 3. Snapshot mode for any app

- Toolbar button **App** (also reachable as an MCP tool, below). Opens a dedicated Annotate page served by the
  MCP server itself (`http://127.0.0.1:<port>/snap`, a tiny local HTTP server started by `server.js`, token in
  the URL), so it doesn't depend on the user's dev site. The toolbar is injected there as on any page.
- The snap page has **Choose window** → `getDisplayMedia({ video: true })` → user picks a window in the system
  picker. The stream is kept open so later captures don't re-prompt; a live preview is shown, **Capture** freezes
  the current frame onto a canvas (full resolution kept locally). **Choose window** again switches apps.
- The user draws and comments on the frozen frame with the same draw tools as §1. Multiple drawings per frame,
  multiple frames per batch.
- On send: server stores the full frame (JPEG q≈70, ≤1600 px wide) at `.annotate/shots/<id>-full.jpg` and a crop
  around each drawing (≤480×360, drawing baked in) at `.annotate/shots/<id>.jpg`.
- **App name** (builder's call, since the title can't be read): the snap page has a small optional "App / screen
  name" text field next to Choose window, remembered in `localStorage` per page. If the track label looks like a
  real title (not `window:\d+…`/`screen:…`) it prefills the field.
- Frame upload: the toolbar sends the frozen frame's pixels (JPEG data URL, ≤1600 px wide, crop computed
  client-side too) through `__annotate_send`; the server cannot screenshot other windows itself. Raise the
  binding payload handling accordingly (one frame per send item group, not per drawing).
- Annotation record: `kind: 'app'`, `comment`, `app` (the name field, omitted if empty), `region` (drawing box normalized
  0–1 of the frame), `screenshot` (crop), `full` (full-frame path, fetched only via `get_annotation_details`).
  No selector/source.
- Summary to the agent: `{id, comment, kind:'app', app, region, screenshot}`, crop image always attached (same
  2-image cap). The skill text tells the agent: no file:line is given for app annotations, find the code from the
  window title, visible text in the image and the project; use `get_annotation_details` field `full` for context.
- `resolve_annotation` on app annotations: nothing to reload; `next` tells the agent to ask the user to restart /
  hot-reload their app if needed. The snap page shows the annotation as done (green) like element ones.

### 4. MCP tool changes

- New tool `open_app` (no args): opens/focuses the snap page and returns the same `next` guidance as `open`.
  Keeps tool count small; `open` is unchanged.
- `get_annotation_details` gains fields `full` (full-frame image) and `under`.
- `summary()` handles `kind`. Tool result budget unchanged.
- `queue.js` / `ANNOTATIONS.md`: app items render as `**a7** [app: <title>] (region): comment`.

### 5. Phase 2 — Electron attach (separate plan, after phase 1 ships)

- New tool `attach_app({ cdp_url })`, e.g. `http://127.0.0.1:9222` from an Electron app launched with
  `--remote-debugging-port=9222`. Server does `chromium.connectOverCDP`, injects the same toolbar into existing
  and new pages (`addInitScript` + `evaluate` for already-loaded pages), exposes the same binding, and routes
  reloads/screenshots to those pages. Click-to-annotate, draw mode and source mapping then work unchanged inside
  the Electron renderer. README documents how to start an Electron app with the flag.
- Known risk: `server.js` holds one `conn`; `broadcast`, `onToolbar`, reload and screenshots must become
  multi-connection. Some Electron versions reject browser-level CDP calls Playwright makes on connect; the phase 2
  plan starts with a spike against a real Electron app.

### 6. Tests

- Extend `e2e.test.js` (headless): draw mode — simulate a stroke via `__annotate` test hook or pointer events,
  send, assert `kind:'draw'`, `source`, `under`, an image attached.
- Snapshot mode: headless Chromium has no desktop sources, so the e2e test opens the snap page, injects a canvas
  frame as the "captured" frame through a test hook (bypassing `getDisplayMedia`), draws, sends, and asserts
  `kind:'app'`, `region`, `app`, crop + full files exist and the crop image is attached. `getDisplayMedia` itself
  is verified manually on Linux/Wayland (the user's machine).
- Tool list assertion updated to include `open_app`.

### 7. Docs

README: new "Draw mode" and "Annotating desktop apps" sections, toolbar reference, the Wayland picker note, the
text-only-model limit. `skills/annotate/SKILL.md`: how to handle `kind: 'draw'` and `kind: 'app'`.

## Calls made without asking (check these)

- Window title can't be read → optional, remembered "App / screen name" field on the snap page.
- No changes to `browser-core` launch flags are needed (test bypasses `getDisplayMedia`), so the shared daemon
  stays untouched in phase 1.
- Several annotate-mcp instances on one browser: keep today's behaviour (every instance's binding receives
  sends); the snap page only accepts sync/sends whose URL token matches its own server, so a stale instance
  ignores frames from another instance's snap page.
- Drawings always attach their crop image (within the 2-per-batch cap); elements keep the keyword rule.

## Left to the builder

- Exact toolbar visuals/icons for Draw/App, ellipse vs freehand detection details, stroke smoothing.
- Port selection for the snap page server (free port, like the daemon).
- Whether to store drawing points in page or viewport coordinates internally, as long as drafts survive scrolling.
