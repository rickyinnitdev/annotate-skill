# Annotate

Click any element of your running web app, write a comment, press **Send to AI**, and your coding agent edits the code. Then it waits for the next round.

```
packages/
  browser-core/   shared Chromium session (CDP), control lock, security token
  annotate-mcp/   MCP server (4 tools) + injected toolbar + Babel source plugin
skills/annotate/SKILL.md
```

Works on **Linux and Windows** (and macOS). Plain Node ESM, no build step. Requires Node 20+.

## Install

```bash
npm run setup        # npm install + playwright install chromium
npm test             # end-to-end test (headless)
```

## Connect your agent

The server runs over stdio. Set `ANNOTATE_PROJECT_DIR` to the project being edited (default: the current directory).

**OpenCode** (`opencode.json`):
```json
{ "mcp": { "annotate": { "type": "local",
  "command": ["node", "/path/to/Annotate/packages/annotate-mcp/src/server.js"],
  "environment": { "ANNOTATE_PROJECT_DIR": "." } } } }
```

**Claude Code**:
```bash
claude mcp add annotate -- node /path/to/Annotate/packages/annotate-mcp/src/server.js
```

On Windows, use a path like `C:\\path\\to\\Annotate\\packages\\annotate-mcp\\src\\server.js`.

Copy `skills/annotate/SKILL.md` into your agent's skills folder.

**OpenCode 2.x: make feedback arrive automatically (recommended).** An agent only receives annotations while it is waiting for them,
and some models (DeepSeek, for example) end their turn instead of waiting. The bundled plugin fixes this: if annotations sit
undelivered for 3 seconds, it sends a short message into your newest OpenCode session for that project,
so the agent picks them up without you asking. It uses OpenCode's `delivery: "queue"`, so it never interrupts a turn in progress.
Add it to `~/.config/opencode/opencode.json`, then restart OpenCode:

```json
{ "plugin": ["/path/to/Annotate/packages/opencode-plugin"] }
```

Each message it sends is logged in `.annotate/push.log`. Then tell it: *"open localhost:3000 and wait for my feedback"*.

## Using the toolbar

| Action | How |
|---|---|
| Toggle annotate mode | **Annotate** button or `Alt+Shift+A` |
| Select element | Click it. Page clicks and links are blocked while annotating |
| Select the parent instead | `↑` while hovering, then `Enter` |
| Save comment | `Ctrl+Enter` |
| Edit or delete a draft | Click its numbered pin |
| Send the batch | **Send to AI** or `Alt+Shift+S` |

Pin colors: purple = draft, amber = sent, green = resolved. The status dot is green when the agent is waiting and amber when it is working. Drafts survive page reloads.

## Exact source mapping (recommended)

Without this, the agent searches by text and class names. With it, each element carries `data-source="src/Hero.tsx:12"`.

- **Vite + React**: `react({ babel: { plugins: mode === 'development' ? ['annotate-mcp/babel'] : [] } })`
- **Babel**: `"env": { "development": { "plugins": ["annotate-mcp/babel"] } }`
- Automatic fallbacks without the plugin: React ≤18 dev builds (`_debugSource`), Vue dev builds (`__file`), Svelte dev builds (`__svelte_meta`).

## Token efficiency (by design)

- Only 4 tools with one-line descriptions. Longer guidance lives in `SKILL.md`.
- `wait_for_feedback` returns a small summary (~40 tokens per annotation): comment, selector, source, and the element's text.
  HTML, styles, and screenshots come from `get_annotation_details` only on request.
- Screenshots are cropped to the element, capped at 1200×900 CSS px, saved as JPEG on disk, and returned only as a path.
  An image is attached automatically only when the comment sounds visual ("misaligned", "spacing", "color"…).
- Waiting blocks quietly (default 300s) and sends progress pings so clients don't time out. On timeout it returns `{"status":"waiting"}`.
- Resolved annotations are deleted and never come back. The queue persists in `.annotate/queue.json` and `.annotate/ANNOTATIONS.md`.
- `resolve_annotation` reloads the page, returns new console errors, and then waits for the next round, so the loop never stalls.
- Every result's size is logged to stderr. Anything over `ANNOTATE_TOKEN_BUDGET` (default 500) logs a warning.

## Which browser?

By default Annotate opens **your default browser** if it supports the Chrome DevTools Protocol:
Chrome, Edge, Brave, Chromium, Vivaldi, or Opera (Linux, Windows, macOS). Firefox and Safari don't support it,
so Annotate falls back to the bundled Chromium. Override this with `BROWSER_CORE_BROWSER` (see the table below).

Annotate uses its own browser profile (`~/.browser-core/profile`), not your everyday one. Chrome blocks automation on your main profile,
so log in once in the Annotate window and it remembers you from then on.

## browser-core

One detached daemon per user owns a visible Chromium with a persistent profile in `~/.browser-core/profile`, so logins persist.
Both the CDP endpoint and the HTTP lock API listen only on `127.0.0.1`. The lock API needs a random token stored in `~/.browser-core/session.json`.
Future tools such as `computer-mcp` call `connect()` to share the same window, and `takeControl()` / `resumeAgent()` for the lock.
Closing the browser stops the daemon, and the next `open` relaunches it.

| Env | Meaning |
|---|---|
| `ANNOTATE_PROJECT_DIR` | project root for `.annotate/` and relative source paths |
| `ANNOTATE_TOKEN_BUDGET` | warning threshold, default 500 |
| `BROWSER_CORE_HOME` | state and profile dir, default `~/.browser-core` |
| `BROWSER_CORE_BROWSER` | `default` (auto), `bundled`, `chrome`, `msedge`, `brave`, `vivaldi`, `chromium`, `opera`, or a path to the browser executable |
| `BROWSER_CORE_HEADLESS=1` | headless (CI/tests) |
