#!/usr/bin/env node
// annotate-mcp: 4 small tools. open -> wait_for_feedback -> (edit code) -> resolve_annotation -> wait again.
// Results are kept small by design; heavy data (html, styles, screenshots) is fetched on demand.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, getLock } from 'browser-core';
import { Queue } from './queue.js';

const PROJECT = process.env.ANNOTATE_PROJECT_DIR || process.cwd();
const DIR = join(PROJECT, '.annotate');
const TOKEN_BUDGET = Number(process.env.ANNOTATE_TOKEN_BUDGET || 500);
const SRC = dirname(fileURLToPath(import.meta.url));
const TOOLBAR_SRC = readFileSync(join(SRC, 'toolbar.js'), 'utf8');
const DRAW_SRC = readFileSync(join(SRC, 'draw.js'), 'utf8');
// One init script: draw.js helpers + the toolbar, in a private scope. SNAP_ORIGIN = the App page (no toolbar there).
// Node-side copies of the pure draw.js helpers (cropRect, shapeBox) so the server crops the same way.
const drawLib = (() => { const c = {}; new Function('c', `${DRAW_SRC}\nc.cropRect = cropRect; c.shapeBox = shapeBox;`)(c); return c; })();
const buildToolbar = (snapOrigin) => `(() => {\nconst SNAP_ORIGIN = ${JSON.stringify(snapOrigin)};\n${DRAW_SRC}\n${TOOLBAR_SRC}\n})();`;
// Only layout problems really need eyes; "make it purple" or "bigger" do not. Set ANNOTATE_IMAGES=0 for text-only models.
const VISUAL = /\b(misalign\w*|not aligned|alignment|overlap\w*|crooked|cut off|clipped|off[- ]cent(er|re)|uneven|squished|stretched|broken|looks (off|wrong|weird|bad|broken)|layout)\b/i;
const IMAGES = process.env.ANNOTATE_IMAGES !== '0';
// Push mode: the OpenCode plugin delivers each batch (usually into a fresh session), so agents end their turn
// instead of waiting. On automatically while the plugin is running: it touches .annotate/push.alive every second.
// ANNOTATE_PUSH=1 forces it on, ANNOTATE_PUSH=0 forces it off.
function isPush() {
  if (process.env.ANNOTATE_PUSH === '1') return true;
  if (process.env.ANNOTATE_PUSH === '0') return false;
  try { return Date.now() - statSync(join(DIR, 'push.alive')).mtimeMs < 5000; } catch { return false; }
}
const SHOT_W = 480, SHOT_H = 360; // max screenshot size in px; a few hundred tokens at most

const queue = new Queue(DIR);
const log = (...a) => process.stderr.write(`[annotate] ${a.join(' ')}\n`);
let conn = null;        // { browser, context, session }
let status = 'idle';    // idle | waiting | working  (shown as a dot in the toolbar)
let recentDone = [];    // briefly shown green in the toolbar
const consoleErrors = [];

// ---------- browser ----------
async function ensureBrowser() {
  if (conn?.browser.isConnected()) return conn;
  conn = await connect();
  const { context } = conn;
  await context.exposeBinding('__annotate_send', (src, msg) => onToolbar(src.page, msg));
  await context.addInitScript({ content: buildToolbar(null) });
  const watch = (page) => {
    page.on('console', (m) => m.type() === 'error' && pushErr(m.text()));
    page.on('pageerror', (e) => pushErr(e.message));
  };
  context.pages().forEach(watch);
  context.on('page', watch);
  conn.browser.on('disconnected', () => { conn = null; });
  return conn;
}
function pushErr(t) { if (/\[annotate\]|__annotate/.test(t)) return; consoleErrors.push(t.slice(0, 200)); if (consoleErrors.length > 20) consoleErrors.shift(); }
function takeErrors() { const e = [...new Set(consoleErrors.splice(0))].slice(-5); return e.length ? e : undefined; }

function toolbarState() {
  const open = queue.open().map((a) => ({ id: a.id, n: a.n, kind: a.kind, box: a.box, selector: a.selector, comment: a.comment, path: a.path, state: 'sent' }));
  return { status, open: [...open, ...recentDone] };
}

async function broadcast() {
  if (!conn) return;
  const st = toolbarState();
  await Promise.all(conn.context.pages().map((p) =>
    p.evaluate((s) => window.__annotate?.sync(s), st).catch(() => {})));
}
function setStatus(s) { status = s; broadcast(); }

function normSource(s) {
  if (!s) return '';
  s = s.replace(/^webpack:\/\/[^/]*\//, '').replace(/^file:\/\//, '').replace(/\?[^:]*/, '');
  const m = s.match(/^(.*?)(:\d+(?::\d+)?)?$/);
  let file = m[1];
  if (isAbsolute(file)) {
    const r = relative(PROJECT, file);
    if (!r.startsWith('..')) file = r;
    else if (/^\/[^/]/.test(file) && existsSync(join(PROJECT, file))) file = file.slice(1); // URL path like /src/styles/x.css
  }
  return file.split(sep).join('/') + (m[2] || '');
}

async function shoot(page, selector, id) {
  let cdp;
  try {
    const loc = page.locator(selector).first();
    await loc.scrollIntoViewIfNeeded({ timeout: 1500 });
    const box = await loc.boundingBox({ timeout: 1500 });
    if (!box) return undefined;
    const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY }));
    const x = Math.max(0, box.x - 8), y = Math.max(0, box.y - 8);
    const width = Math.min(box.width + 16, vp.w - x), height = Math.min(box.height + 16, vp.h - y);
    if (width < 2 || height < 2) return undefined;
    const scale = Math.min(1, SHOT_W / width, SHOT_H / height);
    cdp = await page.context().newCDPSession(page);
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 60, clip: { x: x + vp.sx, y: y + vp.sy, width, height, scale } });
    const file = join(DIR, 'shots', `${id}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return relative(PROJECT, file).split(sep).join('/');
  } catch { return undefined; } finally { cdp?.detach().catch(() => {}); }
}

// Screenshot of a drawn area (box in page coordinates), strokes included.
async function shootBox(page, box, id) {
  let cdp;
  try {
    const vp = await page.evaluate((b) => {
      if (b.y < scrollY || b.y + b.h > scrollY + innerHeight) scrollTo(scrollX, Math.max(0, b.y - 40));
      return { w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY,
        dw: document.documentElement.scrollWidth, dh: document.documentElement.scrollHeight };
    }, box);
    await new Promise((r) => setTimeout(r, 50)); // let the overlay re-render after scrolling
    const c = drawLib.cropRect(box, 24, vp.dw, vp.dh);
    const x = Math.max(c.x, vp.sx), y = Math.max(c.y, vp.sy);
    const width = Math.min(c.x + c.w, vp.sx + vp.w) - x, height = Math.min(c.y + c.h, vp.sy + vp.h) - y;
    if (width < 2 || height < 2) return undefined;
    const scale = Math.min(1, SHOT_W / width, SHOT_H / height);
    cdp = await page.context().newCDPSession(page);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: { x, y, width, height, scale } });
    const file = join(DIR, 'shots', `${id}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return relative(PROJECT, file).split(sep).join('/');
  } catch { return undefined; } finally { cdp?.detach().catch(() => {}); }
}

// "file selector" -> "file:line selector", by finding the rule in the source file.
const fileCache = new Map();
function lines(rel) {
  const abs = join(PROJECT, rel);
  try {
    const m = statSync(abs);
    if (m.size > 3e6) return null;
    const c = fileCache.get(abs);
    if (c && c.mtime === m.mtimeMs) return c.lines;
    const ls = readFileSync(abs, 'utf8').split(/\r?\n/);
    fileCache.set(abs, { mtime: m.mtimeMs, lines: ls });
    return ls;
  } catch { return null; }
}
function cssRef(raw) {
  const i = raw.indexOf(' ');
  const file = normSource(raw.slice(0, i));
  // Drop framework scoping so the selector matches what's in the source (Astro, Vue, Svelte).
  const sel = raw.slice(i + 1).replace(/:where\(\.astro-[\w-]+\)|\[data-(astro-cid|v)-[\w-]+\]|\.svelte-[\w]+/g, '').trim();
  const ls = lines(file);
  let line = 0;
  if (ls) {
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tries = [sel, sel.split(',')[0].trim(), sel.split(/[\s>+~]+/).pop()].filter(Boolean);
    for (const t of tries) {
      const re = new RegExp(`(^|[\\s,}])${esc(t)}\\s*[,{]`);
      const n = ls.findIndex((l) => re.test(l));
      if (n >= 0) { line = n + 1; break; }
    }
  }
  return `${file}${line ? ':' + line : ''} ${sel}`;
}

async function onToolbar(page, msg) {
  if (msg?.type === 'sync') return toolbarState();
  if (msg?.type !== 'send' || !Array.isArray(msg.items)) return toolbarState();
  const ui = (fn, arg) => page.evaluate(([f, a]) => window.__annotate?.[f](a), [fn, arg]).catch(() => {});
  const batch = [];
  for (const it of msg.items.slice(0, 50)) {
    const id = queue.nextId();
    const draw = it.kind === 'draw' && validBox(it.box);
    let screenshot;
    if (draw) { await ui('capture', true); screenshot = await shootBox(page, it.box, id); await ui('capture', false); }
    else if (it.selector) { await ui('hide', true); screenshot = await shoot(page, it.selector, id); await ui('hide', false); }
    batch.push({
      id, n: it.n, comment: String(it.comment).slice(0, 2000), url: msg.url, path: it.path,
      ...(draw ? { kind: 'draw', box: it.box, under: Array.isArray(it.under)
        ? it.under.slice(0, 3).map((u) => ({ selector: String(u.selector || ''), source: normSource(u.source) || undefined })) : [] } : {}),
      selector: it.selector, text: it.text, html: it.html, styles: it.styles, rect: it.rect,
      source: normSource(it.source),
      css: Array.isArray(it.css) ? it.css.slice(0, 4).map(cssRef) : [],
      screenshot,
    });
  }
  queue.addBatch(batch);
  log(`received ${batch.length} annotation(s)`);
  return toolbarState();
}

function validBox(b) {
  return b && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(b[k])) && b.w >= 0 && b.h >= 0;
}

// ---------- result helpers ----------
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s);
function summary(a) {
  const o = { id: a.id, comment: a.comment };
  if (a.kind) o.kind = a.kind;
  o.url = a.path;
  if (a.selector) o.selector = a.selector;
  if (a.source) o.source = a.source;
  if (a.text) o.element_text = clip(a.text, 80);
  if (a.css?.length) o.css = a.css;
  if (a.screenshot) o.screenshot = a.screenshot;
  return o;
}
function imageBlock(a) {
  try { return { type: 'image', mimeType: 'image/jpeg', data: readFileSync(join(PROJECT, a.screenshot)).toString('base64') }; }
  catch { return null; }
}
function reply(tool, obj, images = [], { budget = true } = {}) {
  const text = JSON.stringify(obj);
  const tokens = Math.ceil(text.length / 4);
  log(`${tool} -> ~${tokens} tokens${images.length ? ` + ${images.length} image(s)` : ''}`);
  if (budget && tokens > TOKEN_BUDGET) log(`WARNING: ${tool} result over ${TOKEN_BUDGET}-token budget (treat as a bug)`);
  return { content: [{ type: 'text', text }, ...images] };
}
const fail = (tool, e) => reply(tool, { error: String(e?.message || e).split('\n')[0] });

// ---------- tools ----------
const server = new McpServer({ name: 'annotate', version: '0.1.0' });

server.registerTool('open', {
  description: 'Open a URL in the visible browser with the Annotate toolbar.',
  inputSchema: { url: z.string().describe('e.g. http://localhost:3000') },
}, async ({ url }) => {
  try {
    const { context, session } = await ensureBrowser();
    if ((await getLock(session)).holder === 'human') return reply('open', { status: 'human_has_control' });
    const origin = new URL(url).origin;
    let page = context.pages().find((p) => { try { return new URL(p.url()).origin === origin; } catch { return false; } })
      || context.pages().find((p) => p.url() === 'about:blank') || (await context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.bringToFront();
    return reply('open', { ok: true, title: clip(await page.title(), 60), pending: queue.open().length, errors: takeErrors(),
      next: isPush() ? 'Tell the user: "✅ Annotate ready. Click elements, comment, then Send to AI." and end your turn.'
        : 'Call wait_for_feedback. Never end your turn while the user annotates.' });
  } catch (e) { return fail('open', e); }
});

async function waitForFeedback(tool, timeout_sec, extra) {
  let items = queue.undelivered();
  if (!items.length) {
    setStatus('waiting');
    const token = extra?._meta?.progressToken;
    let beat;
    if (token !== undefined) { // keeps clients that reset timeouts on progress from giving up
      let i = 0;
      beat = setInterval(() => extra.sendNotification({ method: 'notifications/progress',
        params: { progressToken: token, progress: ++i, message: 'waiting for feedback' } }).catch(() => {}), 25000);
    }
    await new Promise((res) => {
      const done = () => { clearTimeout(t); queue.off('batch', done); extra?.signal?.removeEventListener('abort', done); res(); };
      const t = setTimeout(done, timeout_sec * 1000);
      queue.on('batch', done);
      extra?.signal?.addEventListener('abort', done);
    });
    clearInterval(beat);
    items = queue.undelivered();
  }
  if (!items.length) { setStatus('idle'); return null; }
  queue.markDelivered(items);
  setStatus('working');
  // Drawings and app snapshots are visual by nature: they always get their image. Elements only for layout words.
  const wantsImage = [...items.filter((a) => a.kind && a.screenshot), ...items.filter((a) => !a.kind && a.screenshot && VISUAL.test(a.comment))];
  const images = IMAGES ? wantsImage.slice(0, 2).map(imageBlock).filter(Boolean) : [];
  return { annotations: items.map(summary), images };
}

// The exact line agents should end each round with, so the user always knows the state.
const DONE_LINE = '✅ Annotate done. Waiting for your next annotation.';
const NEXT_PUSH = `List the changes one line each, end with exactly: "${DONE_LINE}" and end your turn.`;

server.registerTool('wait_for_feedback', {
  description: 'Get the user\'s annotations (blocks until "Send to AI"). Follow the `next` field of results.',
  inputSchema: { timeout_sec: z.number().int().min(10).max(3600).optional().describe('default 300') },
}, async ({ timeout_sec = 300 }, extra) => {
  try { await ensureBrowser(); } catch (e) { return fail('wait_for_feedback', e); }
  const r = await waitForFeedback('wait_for_feedback', timeout_sec, extra);
  if (!r) return reply('wait_for_feedback', isPush() ? { status: 'waiting', next: 'End your turn; the next batch is delivered to you.' }
    : { status: 'waiting', next: 'call wait_for_feedback again' });
  return reply('wait_for_feedback', { annotations: r.annotations }, r.images);
});

server.registerTool('get_annotation_details', {
  description: 'Heavy details for one annotation; ask only for what you need.',
  inputSchema: {
    id: z.string(),
    fields: z.array(z.enum(['html', 'styles', 'rect', 'text', 'screenshot', 'under', 'box'])).min(1),
  },
}, async ({ id, fields }) => {
  const a = queue.get(id);
  if (!a) return reply('get_annotation_details', { error: `unknown or resolved id ${id}` });
  const out = { id };
  for (const f of fields) if (f !== 'screenshot') out[f] = f === 'html' ? clip(a.html, 6000) : a[f];
  const images = fields.includes('screenshot') && a.screenshot ? [imageBlock(a)].filter(Boolean) : [];
  if (fields.includes('screenshot') && !images.length) out.screenshot = 'unavailable';
  return reply('get_annotation_details', out, images, { budget: false });
});

server.registerTool('resolve_annotation', {
  description: 'Mark annotations done after editing; reloads the page, returns console errors. Follow the `next` field.',
  inputSchema: {
    ids: z.array(z.string()).min(1),
    note: z.string().max(300).optional(),
    wait: z.boolean().optional().describe('wait for the next batch; default depends on mode'),
    timeout_sec: z.number().int().min(10).max(3600).optional().describe('default 300'),
  },
}, async ({ ids, note, wait, timeout_sec = 300 }, extra) => {
  const push = isPush();
  wait ??= !push;
  const opened = new Map(queue.open().map((a) => [a.id, a]));
  const done = queue.resolve(ids, note);
  recentDone = done.map((id) => {
    const { n, kind, box, selector, comment, path } = opened.get(id);
    return { id, n, kind, box, selector, comment, path, state: 'done' };
  });
  setTimeout(() => { recentDone = []; broadcast(); }, 8000);
  // Reload annotated tabs so the user sees the new code even when hot reload is broken.
  const urls = new Set(done.map((id) => opened.get(id).url));
  if (conn) await Promise.all(conn.context.pages().filter((p) => urls.has(p.url()))
    .map((p) => p.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})));
  await new Promise((r) => setTimeout(r, 400)); // let errors surface
  const out = { resolved: done, open: queue.open().length, errors: takeErrors() };
  if (!wait) {
    if (!out.open) setStatus(push ? 'done' : 'idle'); else broadcast();
    return reply('resolve_annotation', { ...out, next: push ? NEXT_PUSH : `Tell the user: "${DONE_LINE}"` });
  }
  const r = await waitForFeedback('resolve_annotation', timeout_sec, extra);
  if (!r) return reply('resolve_annotation', { ...out, status: 'waiting', next: `Tell the user: "${DONE_LINE}" then call wait_for_feedback` });
  return reply('resolve_annotation', { ...out, annotations: r.annotations }, r.images);
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready. project=${PROJECT}`);
const exit = () => { queue.flush(); process.exit(0); };
process.stdin.on('close', exit);
process.on('SIGINT', exit);
process.on('SIGTERM', exit);
