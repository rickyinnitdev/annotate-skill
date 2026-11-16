# Annotate

**Point at your website or app and tell your AI coding agent what to change.**

Open your site in a browser, click any element (or circle an area), type a comment like *"make this button purple"*, and press **Send to AI**.
Building a desktop app instead? Snapshot its window, draw on it and comment the same way.
Your agent (OpenCode, Claude Code, Antigravity, or any MCP-compatible agent) finds the right file and line, edits the code, and the page reloads with the change.

```
 Browser                                   Your agent
┌───────────────────────────────┐         ┌───────────────────────────────────┐
│  [ Buy now ] ← click          │         │ a1 "make this purple"             │
│  ┌──────────────────────────┐ │  Send   │   source: src/pages/index.astro:42│
│  │ make this purple    Save │ │ ──────▶ │   css:    src/styles/global.css:412│
│  └──────────────────────────┘ │ to AI   │           .btn                    │
│        [Annotate] [Send to AI]│         │ → edits the rule, page reloads ✔  │
└───────────────────────────────┘         └───────────────────────────────────┘
```

- **Works on Linux, Windows and macOS.** Plain Node.js, no build step.
- **Uses your default browser** (Chrome, Edge, Brave, Vivaldi, Chromium or Opera). Otherwise it uses a bundled Chromium.
- **Finds the code for you:** file and line for Astro, React, Vue and Svelte, plus the exact CSS rule (file:line) that styles each element.
- **Any app, not just websites:** snapshot any window on your screen (Qt, GTK, Flutter, Electron, Tauri, native…), draw on it and comment.
- **Cheap on tokens:** a typical annotation is about 60 tokens. Screenshots are small and only sent when needed.

---

## Contents
1. [How It Works](#1-how-it-works)
   - [Architecture Overview](#architecture-overview)
   - [The Annotation Loop](#the-annotation-loop)
   - [Source Mapping](#source-mapping)
   - [Queue and State Management](#queue-and-state-management)
   - [Browser Management](#browser-management)
2. [Setup](#2-setup)
3. [Connect Your Agent](#3-connect-your-agent)
   - [OpenCode 2.x (recommended setup)](#opencode-2x-recommended-setup)
   - [Claude Code](#claude-code)
   - [Antigravity (AGY)](#antigravity-agy)
   - [Other MCP Agents](#other-mcp-agents)
   - [CLI / Direct Use (No Agent)](#cli--direct-use-no-agent)
4. [Using It: A Walkthrough](#4-using-it-a-walkthrough)
5. [Toolbar Reference](#5-toolbar-reference)
   - [Annotating Desktop Apps](#annotating-desktop-apps)
6. [Saving Tokens](#6-saving-tokens)
7. [Settings](#7-settings)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. How It Works

### Architecture Overview

Annotate is a monorepo with three packages:

```
packages/
  browser-core/       Shared browser daemon — one Chromium per user, CDP, control lock
  annotate-mcp/       MCP server with 5 tools, injected toolbar, App page, Babel plugin
  opencode-plugin/    OpenCode 2.x plugin — delivers batches into the right chat session
skills/annotate/      SKILL.md — teaches any agent the annotate loop
```

The system is made of four layers that connect the user's browser to the agent's editing session:

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────────┐     ┌──────────────┐
│   Browser    │     │   MCP Server     │     │   Queue (.annotate/) │     │    Agent     │
│  + Toolbar   │ ──▶ │  (annotate-mcp)  │ ──▶ │  queue.json          │ ──▶ │  (any MCP    │
│  (shadow DOM)│     │  5 tools, stdio  │     │  ANNOTATIONS.md      │     │   client)    │
└──────────────┘     └──────────────────┘     │  history.json        │     └──────────────┘
                             │                │  shots/              │
                     ┌───────┴──────┐         └──────────────────────┘
                     │ browser-core │
                     │  daemon      │
                     │  (CDP, lock) │
                     └──────────────┘
```

**1. browser-core** — A background daemon that owns one visible Chromium instance per user. It:
- Launches your default Chromium-family browser (or a bundled Chromium) with a persistent profile stored in `~/.browser-core/profile`.
- Exposes its Chrome DevTools Protocol (CDP) endpoint on `127.0.0.1` only — nothing leaves your machine.
- Provides a token-protected HTTP API with a **control lock** (`/lock`): either `human` or `agent` holds the browser. The agent pauses input when the human is in control.
- Session state is stored in `~/.browser-core/session.json` (port, token, CDP URL). Other tools can share the same browser instance.
- Closing the browser window stops the daemon; the next `open` call relaunches it automatically.

**2. annotate-mcp** — The MCP server (stdio transport) that:
- Injects the Annotate toolbar into every page via Playwright's `addInitScript`. The toolbar runs in a **closed shadow DOM** (`attachShadow({ mode: 'closed' })`), so your site's CSS can't affect it and it can't affect your site. Works with strict Content Security Policies and Trusted Types.
- Provides **5 MCP tools**: `open`, `open_app`, `wait_for_feedback`, `get_annotation_details`, `resolve_annotation`.
- Receives annotations from the toolbar through an exposed browser binding (`window.__annotate_send`).
- Resolves source file paths and CSS rule line numbers so the agent knows exactly where to edit.
- Takes small, targeted screenshots (max 480×360 px JPEG) only when needed (layout-related comments or drawings).
- Serves the **App page** (for desktop app snapshots) on `127.0.0.1` behind a random token.

**3. Queue** — A durable, file-based annotation queue stored in your project at `<project>/.annotate/`:

| File | Purpose |
|---|---|
| `queue.json` | All open annotations (atomically written via rename) |
| `ANNOTATIONS.md` | Human-readable list of unresolved comments |
| `history.json` | Last 5 resolved annotations (for "undo that" context) |
| `shots/` | Screenshot crops (JPEG) |
| `push.log` | OpenCode plugin delivery log |
| `push.alive` | Heartbeat file (plugin touches it every second) |
| `session.json` | Which OpenCode chat session to deliver batches to |

Nothing is lost when the agent's wait times out, the MCP server restarts, or a new agent session starts. Finished annotations are dropped from storage and never come back in results.

**4. OpenCode plugin** (optional) — Polls `queue.json` once per second (no tokens spent). When annotations aren't picked up within ~1.2 seconds, it queues them as a message in the chat that last used Annotate. The agent doesn't need to be "waiting" — batches arrive as new messages. With `{ "newSession": true }` in `.annotate/settings.json`, each batch gets its own fresh session for minimal token cost.

### The Annotation Loop

The core workflow is a simple loop driven by the agent and the SKILL.md instructions:

```
Agent calls open(url) or open_app()
          │
          ▼
    ┌─── wait_for_feedback() ◀───────────────────────────┐
    │     blocks until user presses "Send to AI"          │
    │           │                                         │
    │           ▼                                         │
    │     Returns annotations:                            │
    │       [{id, comment, selector, source, css, ...}]   │
    │           │                                         │
    │           ▼                                         │
    │     Agent edits the code                            │
    │       - Uses source (file:line) directly            │
    │       - Uses css (file:line selector) for styles    │
    │       - Falls back to element_text / selector       │
    │       - Can call get_annotation_details() for more  │
    │           │                                         │
    │           ▼                                         │
    └─── resolve_annotation(ids, note)                    │
           Reloads the page, returns console errors       │
           Waits for next batch (or ends turn in push)  ──┘
```

**Push mode vs. Wait mode:**
- **Push mode** (OpenCode with plugin): The agent ends its turn after each batch. The plugin delivers the next batch as a new message. No model dependency — works with any LLM.
- **Wait mode** (Claude Code, other agents): The agent stays in a `wait_for_feedback` → `resolve_annotation` loop. It never ends its turn while the user is annotating.

### Source Mapping

Each annotation tells the agent *where* to look, so it doesn't have to search the codebase:

| Field | Example | How it's found |
|---|---|---|
| `source` | `src/pages/index.astro:58` | Reads framework dev-mode attributes: `data-source` (Babel plugin), `data-astro-source-file` (Astro), `__svelte_meta` (Svelte), `__vueParentComponent` (Vue), `__reactFiber$` (React ≤18) |
| `css` | `src/styles/global.css:1431 .shop-tag` | Walks `document.styleSheets`, matches rules against the element, then finds the rule's line number in the source file on disk |
| `element_text` | `Open Sat & Sun` | `el.innerText`, clipped to 200 chars |
| `selector` | `div.shop-tag` | Generated from the DOM: prefers `id`, `data-testid`, `aria-label`, then walks up building a unique path; strips framework hash classes |

For **React 19** (or the most reliable mapping in any React version), add the included Babel plugin:

```js
// vite.config.js
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => ({
  plugins: [react({ babel: { plugins: mode === 'development' ? ['ANNOTATE_DIR/packages/annotate-mcp/src/babel-plugin.cjs'] : [] } })],
}));
```

Every HTML element then gets a `data-source="src/components/Hero.tsx:12"` attribute in development.

### Queue and State Management

The queue uses **atomic writes** (write to `.tmp`, then `rename`) so it's never corrupted even if the process crashes mid-write. Key behaviors:

- On MCP server restart, all open annotations are re-delivered (the `deliveredAt` timestamp is cleared).
- The OpenCode plugin uses `deliveredAt` + a 1.2-second grace period to decide whether the MCP server's agent already picked up annotations or if they need pushing.
- `history.json` keeps the last 5 resolved annotations so a fresh session can reference them ("undo that" still works across sessions).
- `ANNOTATIONS.md` is regenerated on every write — you can always `cat .annotate/ANNOTATIONS.md` to see what's open.

### Browser Management

**browser-core** manages the shared browser daemon:

1. **Browser selection**: Checks `BROWSER_CORE_BROWSER` env var, or detects your OS default. Supports Chrome, Edge, Brave, Vivaldi, Chromium, Opera. Firefox and Safari don't support CDP, so they fall back to bundled Chromium.
2. **Persistent profile**: Stores its profile in `~/.browser-core/profile` (separate from your daily profile, because Chrome blocks automation on active profiles). Log in once to sites; it remembers you.
3. **One daemon per user**: Starts as a detached process. The client polls for `session.json` to appear. Multiple MCP servers can share the same browser.
4. **Security**: The HTTP API requires a random token (stored in `session.json`, mode `0600`). CDP listens on `127.0.0.1` only. The App page requires a separate per-process token.

---

## 2. Setup

You need **Node.js 20 or newer** and **git**.

```bash
git clone https://github.com/rickyinnitdev/annotate-skill.git
cd annotate-skill
npm run setup          # installs dependencies and a fallback Chromium
npm test               # optional: runs the end-to-end test (about 45 s, headless)
```

Note the full path of this folder (`pwd` on Linux/macOS, `cd` on Windows). The steps below call it `ANNOTATE_DIR`,
for example `/home/you/annotate-skill` or `C:\Users\you\annotate-skill`.

## 3. Connect Your Agent

Annotate has three parts. Only the first two are required.

| Part | Folder | What it does |
|---|---|---|
| **MCP server** | `packages/annotate-mcp` | Opens the browser and toolbar and gives your comments to the agent. **Required.** |
| **Skill** | `skills/annotate/SKILL.md` | Teaches the agent the annotate loop. **Required.** |
| **OpenCode plugin** | `packages/opencode-plugin` | Delivers each batch to your chat the moment you press **Send to AI**, so you never have to ask. **Recommended for OpenCode.** |

### OpenCode 2.x (recommended setup)

Edit `~/.config/opencode/opencode.json` (Windows: `%USERPROFILE%\.config\opencode\opencode.json`) and add:

```json
{
  "mcp": {
    "servers": {
      "annotate": {
        "type": "local",
        "command": ["node", "ANNOTATE_DIR/packages/annotate-mcp/src/server.js"]
      }
    }
  },
  "plugin": ["ANNOTATE_DIR/packages/opencode-plugin"]
}
```

Then copy the skill and restart OpenCode:

```bash
mkdir -p ~/.config/opencode/skills/annotate
cp ANNOTATE_DIR/skills/annotate/SKILL.md ~/.config/opencode/skills/annotate/
pkill -f "serve --service"     # OpenCode's background service only loads plugins when it starts
opencode mcp list              # should show: ✓ annotate connected
```

On Windows, use paths like `C:/Users/you/annotate-skill/...` in the JSON (forward slashes work), copy the skill folder in Explorer,
and end the background service by closing OpenCode and ending any `opencode` process in Task Manager.

> **Why the plugin?** Without it, an agent only receives your comments while it's waiting for them, and some models
> (DeepSeek, for example) stop waiting, so you end up typing *"check my annotations"*. With the plugin, nothing depends on the model:
> each batch you send arrives as a new message **in the chat where you opened Annotate**, and the agent starts on it right away.
> If the agent is still busy, the batch waits until it finishes. This switches on automatically; there's nothing to configure.
> To start a fresh, cheaper session for every batch instead, see [Settings](#7-settings).

### Claude Code

```bash
claude mcp add annotate -- node ANNOTATE_DIR/packages/annotate-mcp/src/server.js
mkdir -p ~/.claude/skills/annotate && cp ANNOTATE_DIR/skills/annotate/SKILL.md ~/.claude/skills/annotate/
```

There's no plugin for Claude Code. The agent stays in the loop by waiting: after each change, `resolve_annotation` waits for your next batch.
If it ever stops, say *"check annotations"*. Nothing you sent is lost.

### Antigravity (AGY)

Annotate works with Antigravity as an MCP server. Add it to your MCP config:

**Option A: Global config** — Add to `~/.gemini/antigravity/settings.json` (or your user-level MCP config):

```json
{
  "mcpServers": {
    "annotate": {
      "command": "node",
      "args": ["ANNOTATE_DIR/packages/annotate-mcp/src/server.js"]
    }
  }
}
```

**Option B: Workspace config** — Create `.gemini/settings.json` in your project root:

```json
{
  "mcpServers": {
    "annotate": {
      "command": "node",
      "args": ["ANNOTATE_DIR/packages/annotate-mcp/src/server.js"]
    }
  }
}
```

Then copy the skill:

```bash
# Global (available in all projects)
mkdir -p ~/.gemini/antigravity/skills/annotate
cp ANNOTATE_DIR/skills/annotate/SKILL.md ~/.gemini/antigravity/skills/annotate/

# Or per-workspace (in your project root)
mkdir -p .gemini/skills/annotate
cp ANNOTATE_DIR/skills/annotate/SKILL.md .gemini/skills/annotate/
```

Antigravity uses wait mode (no push plugin needed). Tell the agent:
> open http://localhost:4321 with annotate

If it ever stops waiting, say *"check annotations"*.

### Other MCP Agents

Run `node ANNOTATE_DIR/packages/annotate-mcp/src/server.js` as a **stdio** MCP server from your project folder,
and add the contents of `SKILL.md` to the agent's instructions.

The MCP server exposes these 5 tools:

| Tool | Description |
|---|---|
| `open(url)` | Opens a URL in the shared browser with the Annotate toolbar injected |
| `open_app()` | Opens the App page for desktop app window snapshots |
| `wait_for_feedback(timeout_sec?)` | Blocks until the user presses "Send to AI"; returns annotations |
| `get_annotation_details(id, fields)` | Fetches heavy data on demand: `html`, `styles`, `rect`, `text`, `screenshot`, `under`, `box`, `full` |
| `resolve_annotation(ids, note, wait?, timeout_sec?)` | Marks annotations done, reloads the page, returns console errors and optionally waits for next batch |

### CLI / Direct Use (No Agent)

You can also start the MCP server directly for inspection or debugging:

```bash
# Start the server (it speaks MCP over stdio)
cd ~/my-project
node ANNOTATE_DIR/packages/annotate-mcp/src/server.js

# Or use the npm script from the monorepo
cd ANNOTATE_DIR
npm start
```

**Inspect the queue** without an agent:

```bash
# See all open annotations
cat my-project/.annotate/ANNOTATIONS.md

# See the raw queue
cat my-project/.annotate/queue.json | npx json

# See recent history (last 5 resolved)
cat my-project/.annotate/history.json

# Check OpenCode plugin delivery log
cat my-project/.annotate/push.log
```

**Run the test suite:**

```bash
cd ANNOTATE_DIR
npm test                          # all tests (~45s, headless)
node --test packages/annotate-mcp/test/e2e.test.js    # just the e2e test
node --test packages/annotate-mcp/test/draw-unit.test.js
node --test packages/annotate-mcp/test/draw-app.test.js
node --test packages/opencode-plugin/test/push.test.js
```

**Environment variables** for the MCP server (can also be set in your agent's MCP `env` config):

| Variable | Default | Purpose |
|---|---|---|
| `ANNOTATE_PROJECT_DIR` | `process.cwd()` | Project root where `.annotate/` lives |
| `ANNOTATE_IMAGES` | on | `0` = never attach screenshots (text-only models) |
| `ANNOTATE_PUSH` | auto | `1` = force push mode; `0` = force wait mode |
| `ANNOTATE_TOKEN_BUDGET` | `500` | Warn in stderr when a result exceeds this many tokens |
| `BROWSER_CORE_BROWSER` | `default` | `default`, `bundled`, `chrome`, `msedge`, `brave`, `vivaldi`, `chromium`, `opera`, or a path |
| `BROWSER_CORE_HOME` | `~/.browser-core` | Where the browser profile and daemon state live |
| `BROWSER_CORE_HEADLESS` | off | `1` = no visible window (CI / tests) |

## 4. Using It: A Walkthrough

**1. Start your site's dev server**, as usual:
```bash
cd ~/my-site
npm run dev            # say it prints http://localhost:4321
```

**2. Start your agent in the same folder** (Annotate keeps its files in `my-site/.annotate/`):
```bash
cd ~/my-site
opencode
```

**3. Ask it to open the site:**
> open http://localhost:4321 with annotate

A browser window opens with a small toolbar in the bottom-right corner.

**4. Leave comments.** Click **Annotate**, or press `Alt+Shift+A`. Hover over elements; each one is outlined with its tag and size.
Click the price and type:
> change the price to $100

Press `Ctrl+Enter` to save. A purple pin **1** appears. Add more:
> **2** on the board image: *make this a bit bigger*
> **3** on the shop tag: *move this down a little, it overlaps the board*

**5. Press Send to AI** (or `Alt+Shift+S`). The pins turn amber.

**6. Watch it work.** With OpenCode and the plugin, your batch appears in the chat as a new message and the agent starts right away.
It receives something like this (about 60 tokens per comment):

```json
{ "id": "a3", "comment": "move this down a little, it overlaps the board",
  "selector": "div.shop-tag", "element_text": "Open Sat & Sun",
  "source": "src/pages/index.astro:58",
  "css": ["src/styles/global.css:1431 .shop-tag"],
  "screenshot": ".annotate/shots/a3.jpg" }
```

The agent opens `global.css` at line 1431, changes the margin, and resolves the batch. The page reloads and the pins turn **green**.
Comment #3 mentions an overlap, so it also got a small screenshot.

The agent finishes every batch the same way, so you always know where things stand:

```
- Price in the hero note: $25 → $100 (index.astro:58)
- .pegboard: max-width 430 → 500px (global.css:412)
- .shop-tag: moved down, margin-top -1.15rem → 0.35rem (global.css:1431)
✅ Annotate done. Waiting for your next annotation.
```

The toolbar shows the same thing: **AI working…** while the agent edits, then **Done ✓ Ready for the next one**.

**7. Repeat.** Send the next batch whenever you like. It lands in the same chat.

**Draw instead of clicking.** When a comment is about an area rather than one element ("there's too much space here",
"put a logo here"), click **Draw** (or `Alt+Shift+D`), pick **Pen**, **Ellipse** or **Arrow**, and circle the area.
A comment box opens as soon as you let go. The agent gets a small screenshot with your drawing on it, plus the file,
line and CSS of the element under the drawing.

> **Tip:** you can also just watch the browser. Amber pins mean the agent is working; green means done.

## 5. Toolbar Reference

| Action | How |
|---|---|
| Turn annotate mode on/off | **Annotate** button, or `Alt+Shift+A` |
| Select an element | Click it. Normal clicks and links are blocked while annotating |
| Select the parent element instead | Press `↑` while hovering, then `Enter` |
| Save the comment | `Ctrl+Enter`, or **Save** |
| Edit or delete a comment | Click its numbered pin |
| Circle an area and comment on it | **Draw**, or `Alt+Shift+D`; choose Pen / Ellipse / Arrow, drag, type, `Ctrl+Enter` |
| Throw away a drawing before saving | `Esc` or **Cancel** in its comment box |
| Send all comments | **Send to AI**, or `Alt+Shift+S` |
| Stop annotating or drawing | `Esc` |

| Pin color | Meaning |
|---|---|
| Purple | Draft, not sent yet. Drafts survive page reloads |
| Amber | Sent; the agent has it |
| Green | Done |

The **status label** next to the dot tells you what the agent is doing:

| Label | Meaning |
|---|---|
| **Ready for annotations** | An agent is waiting; send whenever you like |
| **AI working…** (amber) | The agent is applying your batch |
| **Done ✓ Ready for the next one** | The batch is finished; send the next one |

**Writing good comments:** comments always refer to the element you clicked. *"Make this bold"* on a heading changes that heading only.
To change every heading, say so: *"make all section headings bold"*.

### Annotating Desktop Apps

For anything that isn't a web page, ask your agent:
> open the annotate app page

(it calls `open_app`). A page called **Annotate · App** opens in the Annotate browser.

1. **Choose window**: your system's screen-share picker opens. Pick your app's window.
2. **Capture** freezes the current frame. Capture again whenever the app changes; old frames stay in the list.
3. **Draw** on the frame (Pen / Ellipse / Arrow), type a comment, `Ctrl+Enter`. Add as many as you like, on any frame.
4. Optionally type the app's name (for example *"Settings window"*). Browsers can't read window titles, and the name helps the agent find the code.
5. **Send to AI** (or `Alt+Shift+S`).

The agent gets a small crop of each drawing, the comment, the app name and where on the window it was. It can ask for the
whole frame if it needs more context. There's no file and line for native apps, so the agent finds the code from the
visible text, the app name and your project. After the change, restart or hot-reload your app and capture again.

The window stays shared until you pick another one or close the page, so you don't get asked again for every capture.
Your browser shows its usual "sharing" indicator while it's on.

| System | What to expect |
|---|---|
| Linux (Wayland) | Your desktop asks which window to share the first time. Nothing to set up |
| Linux (X11), Windows | The browser shows its own window picker. Nothing to set up |
| macOS | Allow the browser under **System Settings → Privacy & Security → Screen Recording**, then restart it. Otherwise other apps' windows are missing or blank. If Annotate uses the bundled Chromium, it appears there as **Chromium** |

- **Tauri apps:** use App snapshots. Opening a Tauri dev URL in a normal browser often breaks, because the Tauri APIs aren't there.
- **Text-only models** (`ANNOTATE_IMAGES=0`) get no image, only the comment, the app name and the position. Use a model that reads images for App snapshots.

## 6. Saving Tokens

A round costs two things: your comments, and the conversation the agent resends on every turn.
Annotate keeps both small.

| What | How |
|---|---|
| **Fresh session per batch** (OpenCode plugin) | Context stays at roughly 10–20k tokens per round instead of growing to 100k+. This is the biggest saving. |
| **Small annotations** | About 60 tokens each. HTML, computed styles and full screenshots are only fetched if the agent asks (`get_annotation_details`). |
| **Exact CSS lines** | The agent reads about 10 lines instead of scrolling through a stylesheet. |
| **Few screenshots** | Attached only when a comment describes a layout problem ("misaligned", "overlaps", "cut off"), at most 2 per batch, max 480×360 px. Set `ANNOTATE_IMAGES=0` for models without image support. |
| **Batching** | Five comments in one **Send** cost one agent run, not five. |
| **Only open work** | Finished annotations never come back. |
| **Cheap checks** | `resolve_annotation` returns new console errors, so the agent rarely needs a screenshot to verify a change. |

The server logs the size of every result to stderr, and warns if one goes over `ANNOTATE_TOKEN_BUDGET` (default 500 tokens).

## 7. Settings

Set these in the `env` block of the MCP server config:

| Setting | Default | Meaning |
|---|---|---|
| `ANNOTATE_PUSH` | auto | On automatically while the OpenCode plugin runs (agents finish after each batch). `1` forces it on, `0` forces it off |
| `ANNOTATE_IMAGES` | on | `0` = never attach screenshots (for text-only models) |
| `ANNOTATE_PROJECT_DIR` | current folder | Project root, where `.annotate/` lives |
| `ANNOTATE_TOKEN_BUDGET` | `500` | Log a warning when a result is bigger than this |
| `BROWSER_CORE_BROWSER` | `default` | `default` (your system default), `bundled`, `chrome`, `msedge`, `brave`, `vivaldi`, `chromium`, `opera`, or a path to a browser executable |
| `BROWSER_CORE_HOME` | `~/.browser-core` | Where the browser profile and session state live |
| `BROWSER_CORE_HEADLESS` | off | `1` = no visible window (CI and tests) |

**Where batches go** (OpenCode plugin). By default each batch goes to the chat that last used Annotate
(remembered in `.annotate/session.json`). To start a **new session for every batch** instead, create `my-site/.annotate/settings.json`:
```json
{ "newSession": true }
```
Each round then costs about the same small amount, because the conversation doesn't grow. The new session gets a one-line
summary of the last few rounds, so "undo that" still works. The new session gets a one-line summary of the last few rounds, so "undo that" still works. The work happens in the new session, not the chat you're looking at.

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| `opencode mcp list` doesn't show annotate | Check the path in `command`, then run `pkill -f "serve --service"` and start OpenCode again |
| Nothing happens after **Send to AI** (OpenCode) | Look in `my-site/.annotate/push.log`. If it's missing, the plugin isn't loaded: check the `plugin` path and restart the background service. `sent a1 to ses_…` shows which session got the batch |
| Batches go to the wrong chat (OpenCode) | They go to the chat that last used Annotate. Ask the right chat to *"open annotate"* once, or delete `.annotate/session.json` |
| Nothing happens (other agents) | Tell the agent *"check annotations"*. Everything you sent is queued in `.annotate/queue.json` |
| Wrong browser opens | Set `BROWSER_CORE_BROWSER`, for example `chrome`. Firefox and Safari can't be automated this way, so Annotate uses Chromium for them |
| You're logged out on the Annotate window | It uses its own profile (`~/.browser-core/profile`), because Chrome blocks automation on your main profile. Log in once; it remembers you |
| The browser won't start | Run `npx playwright install chromium` in `ANNOTATE_DIR`, and check `~/.browser-core/daemon.log` |
| **Choose window** shows nothing or a black frame | macOS: give the browser Screen Recording permission and restart it. Linux: make sure `xdg-desktop-portal` is running |
| The agent says it "can't see your screen" | It doesn't need to. Annotations include the element, its text, file and CSS. A screenshot is attached for layout problems |
| See open work | `.annotate/ANNOTATIONS.md` lists every unresolved comment |

## License

[MIT](LICENSE). Free to use, change and share; keep the copyright notice.
