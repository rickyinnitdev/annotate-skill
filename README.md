# Annotate

**Point at your website and tell your AI coding agent what to change.**

Open your site in a browser, click any element, type a comment like *"make this button purple"*, and press **Send to AI**.
Your agent (OpenCode, Claude Code, or any MCP-compatible agent) finds the right file and line, edits the code, and the page reloads with the change.

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
- **Cheap on tokens:** a typical annotation is about 60 tokens. Screenshots are small and only sent when needed. With OpenCode, each batch starts a fresh session, so cost doesn't grow over time.

---

## Contents
1. [Setup](#1-setup)
2. [Connect your agent](#2-connect-your-agent)
3. [Using it: a walkthrough](#3-using-it-a-walkthrough)
4. [Toolbar reference](#4-toolbar-reference)
5. [How the agent finds your code](#5-how-the-agent-finds-your-code)
6. [Saving tokens](#6-saving-tokens)
7. [Settings](#7-settings)
8. [Troubleshooting](#8-troubleshooting)
9. [How it works](#9-how-it-works)

---

## 1. Setup

You need **Node.js 20 or newer** and **git**.

```bash
git clone https://github.com/rickyinnitdev/annotate-skill.git
cd annotate-skill
npm run setup          # installs dependencies and a fallback Chromium
npm test               # optional: runs the end-to-end test (about 45 s, headless)
```

Note the full path of this folder (`pwd` on Linux/macOS, `cd` on Windows). The steps below call it `ANNOTATE_DIR`,
for example `/home/you/annotate-skill` or `C:\Users\you\annotate-skill`.

## 2. Connect your agent

Annotate has three parts. Only the first two are required.

| Part | Folder | What it does |
|---|---|---|
| **MCP server** | `packages/annotate-mcp` | Opens the browser and toolbar and gives your comments to the agent. **Required.** |
| **Skill** | `skills/annotate/SKILL.md` | Teaches the agent the annotate loop. **Required.** |
| **OpenCode plugin** | `packages/opencode-plugin` | Delivers comments automatically and starts a fresh, cheap session for each batch. **Recommended for OpenCode.** |

### OpenCode 2.x (recommended setup)

Edit `~/.config/opencode/opencode.json` (Windows: `%USERPROFILE%\.config\opencode\opencode.json`) and add:

```json
{
  "mcp": {
    "servers": {
      "annotate": {
        "type": "local",
        "command": ["node", "ANNOTATE_DIR/packages/annotate-mcp/src/server.js"],
        "env": { "ANNOTATE_PUSH": "1" }
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

> **Why the plugin and `ANNOTATE_PUSH`?** An agent can only receive your comments while it's waiting for them, and some models
> (DeepSeek, for example) stop waiting. With the plugin, nothing depends on the model: each batch you send starts a **new session**
> containing just that batch, plus a one-line summary of the last few rounds so "undo that" still works.
> `ANNOTATE_PUSH=1` tells the agent to finish after each batch instead of waiting.
> To keep everything in one session instead, see [Settings](#7-settings).

### Claude Code

```bash
claude mcp add annotate -- node ANNOTATE_DIR/packages/annotate-mcp/src/server.js
mkdir -p ~/.claude/skills/annotate && cp ANNOTATE_DIR/skills/annotate/SKILL.md ~/.claude/skills/annotate/
```

There's no plugin for Claude Code. The agent stays in the loop by waiting: after each change, `resolve_annotation` waits for your next batch.
If it ever stops, say *"check annotations"*. Nothing you sent is lost.

### Other MCP agents

Run `node ANNOTATE_DIR/packages/annotate-mcp/src/server.js` as a **stdio** MCP server from your project folder,
and add the contents of `SKILL.md` to the agent's instructions.

## 3. Using it: a walkthrough

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

**6. Watch it work.** With OpenCode and the plugin, a new session named **"Annotate: change the price to $100 (+2)"** starts.
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

**7. Repeat.** Send the next batch whenever you like. Each batch gets its own fresh session.

> **Tip:** you'll see new sessions appear in OpenCode's session list. You don't need to switch to them: watch the
> browser instead. Amber pins mean the agent is working; green means done.

## 4. Toolbar reference

| Action | How |
|---|---|
| Turn annotate mode on/off | **Annotate** button, or `Alt+Shift+A` |
| Select an element | Click it. Normal clicks and links are blocked while annotating |
| Select the parent element instead | Press `↑` while hovering, then `Enter` |
| Save the comment | `Ctrl+Enter`, or **Save** |
| Edit or delete a comment | Click its numbered pin |
| Send all comments | **Send to AI**, or `Alt+Shift+S` |
| Stop annotating | `Esc` |

| Pin color | Meaning |
|---|---|
| Purple | Draft, not sent yet. Drafts survive page reloads |
| Amber | Sent; the agent has it |
| Green | Done |

The **status dot** on the toolbar is green when an agent is waiting and amber while it's working.

**Writing good comments:** comments always refer to the element you clicked. *"Make this bold"* on a heading changes that heading only.
To change every heading, say so: *"make all section headings bold"*.

## 5. How the agent finds your code

Each annotation tells the agent where to look, so it doesn't have to search:

| Field | Example | Where it comes from |
|---|---|---|
| `source` | `src/pages/index.astro:58` | The file and line that rendered the element |
| `css` | `src/styles/global.css:1431 .shop-tag` | Up to 4 CSS rules that style the element, with line numbers |
| `element_text` | `Open Sat & Sun` | The element's visible text, used when there's no `source` |
| `selector` | `div.shop-tag` | A CSS selector for the element |

`source` works automatically in development mode for:
- **Astro:** reads the tags the Astro dev server adds.
- **Vue**, **Svelte**, and **React 18 or older**.

For **React 19** or the most reliable mapping in React, add the included Babel plugin (development only):

```js
// vite.config.js
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => ({
  plugins: [react({ babel: { plugins: mode === 'development' ? ['ANNOTATE_DIR/packages/annotate-mcp/src/babel-plugin.cjs'] : [] } })],
}));
```

Every HTML element then gets a `data-source="src/components/Hero.tsx:12"` attribute in development.

## 6. Saving tokens

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
| `ANNOTATE_PUSH` | off | `1` = agents finish after each batch; the OpenCode plugin delivers the next one. Use together with the plugin. |
| `ANNOTATE_IMAGES` | on | `0` = never attach screenshots (for text-only models) |
| `ANNOTATE_PROJECT_DIR` | current folder | Project root, where `.annotate/` lives |
| `ANNOTATE_TOKEN_BUDGET` | `500` | Log a warning when a result is bigger than this |
| `BROWSER_CORE_BROWSER` | `default` | `default` (your system default), `bundled`, `chrome`, `msedge`, `brave`, `vivaldi`, `chromium`, `opera`, or a path to a browser executable |
| `BROWSER_CORE_HOME` | `~/.browser-core` | Where the browser profile and session state live |
| `BROWSER_CORE_HEADLESS` | off | `1` = no visible window (CI and tests) |

**Keep one session instead of a new one per batch** (OpenCode plugin). Create `my-site/.annotate/settings.json`:
```json
{ "newSession": false }
```
Then remove `ANNOTATE_PUSH` from the MCP config, so the agent waits between batches. Every batch now goes to your newest session.
This costs more tokens as the conversation grows, but the agent remembers everything from earlier rounds.

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| `opencode mcp list` doesn't show annotate | Check the path in `command`, then run `pkill -f "serve --service"` and start OpenCode again |
| Nothing happens after **Send to AI** (OpenCode) | Look in `my-site/.annotate/push.log`. If it's missing, the plugin isn't loaded: check the `plugin` path and restart the background service |
| Nothing happens (other agents) | Tell the agent *"check annotations"*. Everything you sent is queued in `.annotate/queue.json` |
| Wrong browser opens | Set `BROWSER_CORE_BROWSER`, for example `chrome`. Firefox and Safari can't be automated this way, so Annotate uses Chromium for them |
| You're logged out on the Annotate window | It uses its own profile (`~/.browser-core/profile`), because Chrome blocks automation on your main profile. Log in once; it remembers you |
| The browser won't start | Run `npx playwright install chromium` in `ANNOTATE_DIR`, and check `~/.browser-core/daemon.log` |
| The agent says it "can't see your screen" | It doesn't need to. Annotations include the element, its text, file and CSS. A screenshot is attached for layout problems |
| See open work | `.annotate/ANNOTATIONS.md` lists every unresolved comment |

## 9. How it works

```
packages/
  browser-core/     one shared browser (Chrome DevTools Protocol), control lock, security token
  annotate-mcp/     MCP server with 4 tools, the injected toolbar, and the Babel plugin
  opencode-plugin/  delivers batches into fresh OpenCode sessions
skills/annotate/    instructions for the agent
```

- **browser-core** starts one background process per user. It runs your browser with remote debugging, listening only on
  `127.0.0.1`. Its control API needs a random token, stored in `~/.browser-core/session.json`. Other tools can share the same window.
  Closing the browser stops the process, and the next `open` restarts it.
- **The toolbar** is injected into every page and runs in a closed shadow root, so your site's CSS can't affect it and it can't affect your site.
  It works on pages with strict security policies (Trusted Types).
- **The 4 tools:** `open`, `wait_for_feedback`, `get_annotation_details`, `resolve_annotation`.
- **The queue** lives in your project at `.annotate/`: `queue.json`, a readable `ANNOTATIONS.md`, `history.json` (the last 5 rounds),
  `shots/` and `push.log`. Add `.annotate/` to your `.gitignore`.
- **The OpenCode plugin** checks the queue once a second, which costs no tokens. When a batch hasn't been picked up within about a second,
  it creates a session titled `Annotate: <first comment>` and queues a short message there. It never interrupts a running turn.
