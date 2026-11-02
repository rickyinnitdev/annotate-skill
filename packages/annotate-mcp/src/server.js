#!/usr/bin/env node
// annotate-mcp: 4 small tools. open -> wait_for_feedback -> (edit code) -> resolve_annotation -> wait again.
// Results are kept small by design; heavy data (html, styles, screenshots) is fetched on demand.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, getLock } from 'browser-core';
import { Queue } from './queue.js';

const PROJECT = process.env.ANNOTATE_PROJECT_DIR || process.cwd();
const DIR = join(PROJECT, '.annotate');
const TOKEN_BUDGET = Number(process.env.ANNOTATE_TOKEN_BUDGET || 500);
const TOOLBAR = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'toolbar.js'), 'utf8');
const VISUAL = /\b(look|looks|align|aligned|misalign|spacing|space|gap|color|colour|overlap|font|size|bigger|smaller|margin|padding|position|layout|visual|ugly|crooked|blurry|cut off|centered|center|icon|image|shadow)\b/i;

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
  await context.addInitScript({ content: TOOLBAR });
  const watch = (page) => {
    page.on('console', (m) => m.type() === 'error' && pushErr(m.text()));
    page.on('pageerror', (e) => pushErr(e.message));
  };
  context.pages().forEach(watch);
  context.on('page', watch);
  conn.browser.on('disconnected', () => { conn = null; });
  return conn;
}
function pushErr(t) { consoleErrors.push(t.slice(0, 200)); if (consoleErrors.length > 20) consoleErrors.shift(); }
function takeErrors() { const e = [...new Set(consoleErrors.splice(0))].slice(-5); return e.length ? e : undefined; }

function toolbarState() {
  const open = queue.open().map((a) => ({ id: a.id, n: a.n, selector: a.selector, comment: a.comment, path: a.path, state: 'sent' }));
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
  if (isAbsolute(file)) { const r = relative(PROJECT, file); if (!r.startsWith('..')) file = r; }
  return file.split(sep).join('/') + (m[2] || '');
}

async function shoot(page, selector, id) {
  try {
    const loc = page.locator(selector).first();
    await loc.scrollIntoViewIfNeeded({ timeout: 1500 });
    const box = await loc.boundingBox({ timeout: 1500 });
    const vp = page.viewportSize() || (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    if (!box) return undefined;
    const x = Math.max(0, box.x - 8), y = Math.max(0, box.y - 8);
    const clip = { x, y, width: Math.min(box.width + 16, vp.width - x, 1200), height: Math.min(box.height + 16, vp.height - y, 900) };
    if (clip.width < 2 || clip.height < 2) return undefined;
    const file = join(DIR, 'shots', `${id}.jpg`);
    await page.screenshot({ path: file, clip, type: 'jpeg', quality: 70, scale: 'css', animations: 'disabled' });
    return relative(PROJECT, file).split(sep).join('/');
  } catch { return undefined; }
}

async function onToolbar(page, msg) {
  if (msg?.type === 'sync') return toolbarState();
  if (msg?.type !== 'send' || !Array.isArray(msg.items)) return toolbarState();
  await page.evaluate(() => window.__annotate?.hide(true)).catch(() => {});
  const batch = [];
  for (const it of msg.items.slice(0, 50)) {
    const id = queue.nextId();
    batch.push({
      id, n: it.n, comment: String(it.comment).slice(0, 2000), url: msg.url, path: it.path,
      selector: it.selector, text: it.text, html: it.html, styles: it.styles, rect: it.rect,
      source: normSource(it.source), screenshot: await shoot(page, it.selector, id),
    });
  }
  await page.evaluate(() => window.__annotate?.hide(false)).catch(() => {});
  queue.addBatch(batch);
  log(`received ${batch.length} annotation(s)`);
  return toolbarState();
}

// ---------- result helpers ----------
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s);
function summary(a) {
  const o = { id: a.id, comment: a.comment, url: a.path, selector: a.selector };
  if (a.source) o.source = a.source; else if (a.text) o.text = clip(a.text, 80);
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
  description: 'Open a URL in the shared visible browser with the Annotate toolbar.',
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
    return reply('open', { ok: true, title: clip(await page.title(), 60), pending: queue.open().length, errors: takeErrors() });
  } catch (e) { return fail('open', e); }
});

server.registerTool('wait_for_feedback', {
  description: 'Block until the user clicks "Send to AI". Returns pending annotations, or {status:"waiting"} on timeout (then call again).',
  inputSchema: { timeout_sec: z.number().int().min(10).max(3600).optional().describe('default 300') },
}, async ({ timeout_sec = 300 }, extra) => {
  try { await ensureBrowser(); } catch (e) { return fail('wait_for_feedback', e); }
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
  if (!items.length) { setStatus('idle'); return reply('wait_for_feedback', { status: 'waiting' }); }
  queue.markDelivered(items);
  setStatus('working');
  const images = items.filter((a) => a.screenshot && VISUAL.test(a.comment)).slice(0, 3).map(imageBlock).filter(Boolean);
  return reply('wait_for_feedback', { annotations: items.map(summary) }, images);
});

server.registerTool('get_annotation_details', {
  description: 'Fetch heavy details for one annotation only when needed.',
  inputSchema: {
    id: z.string(),
    fields: z.array(z.enum(['html', 'styles', 'rect', 'text', 'screenshot'])).min(1),
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
  description: 'Mark annotations done after editing the code. Returns new console errors, if any.',
  inputSchema: { ids: z.array(z.string()).min(1), note: z.string().max(300).optional() },
}, async ({ ids, note }) => {
  const opened = new Map(queue.open().map((a) => [a.id, a]));
  const done = queue.resolve(ids, note);
  recentDone = done.map((id) => {
    const { n, selector, comment, path } = opened.get(id);
    return { id, n, selector, comment, path, state: 'done' };
  });
  setTimeout(() => { recentDone = []; broadcast(); }, 8000);
  if (!queue.open().length) setStatus('idle'); else broadcast();
  await new Promise((r) => setTimeout(r, 400)); // let hot reload surface errors
  return reply('resolve_annotation', { resolved: done, open: queue.open().length, errors: takeErrors() });
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready. project=${PROJECT}`);
const exit = () => { queue.flush(); process.exit(0); };
process.stdin.on('close', exit);
process.on('SIGINT', exit);
process.on('SIGTERM', exit);
