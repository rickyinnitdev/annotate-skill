// End-to-end: real MCP client -> annotate-mcp -> browser-core daemon -> Chromium (headless).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connect, ensureSession, shutdown } from 'browser-core';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = (project) => `<!doctype html><html><head>
<style data-vite-dev-id="${project}/src/styles/global.css">* { box-sizing: border-box } .hero a { color: red } @media (min-width: 1px) { #cta { margin-top: 4px } }</style></head><body>
<p data-astro-source-file="${project}/src/pages/index.astro" data-astro-source-loc="7:3">Price $25</p><section class="hero" data-source="src/Hero.tsx:12">
<h1>We build digital experiences.</h1><a id="cta" href="/gone" onclick="window.clicked=1">Go</a></section></body></html>`;

test('annotate loop', { timeout: 90000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bc-'));
  const project = mkdtempSync(join(tmpdir(), 'proj-'));
  mkdirSync(join(project, 'src/styles'), { recursive: true });
  writeFileSync(join(project, 'src/styles/global.css'), '* { box-sizing: border-box }\n\n.hero a {\n  color: red;\n}\n@media (min-width: 1px) {\n  #cta { margin-top: 4px }\n}\n');
  process.env.BROWSER_CORE_HOME = home;
  process.env.BROWSER_CORE_HEADLESS = '1';
  const site = createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.setHeader('content-security-policy', "require-trusted-types-for 'script'"); r.end(HTML(project)); }).listen(0);
  const url = `http://127.0.0.1:${site.address().port}/`;

  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(here, '../src/server.js')],
    env: { ...process.env, ANNOTATE_PROJECT_DIR: project }, stderr: 'inherit',
  }));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    return { json: JSON.parse(r.content[0].text), images: r.content.filter((c) => c.type === 'image') };
  };
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['get_annotation_details', 'open', 'open_app', 'resolve_annotation', 'wait_for_feedback']);

    assert.equal((await call('open', { url })).json.ok, true);
    assert.equal((await call('wait_for_feedback', { timeout_sec: 10 })).json.status, 'waiting');

    // Act as the human in the same shared browser.
    const { browser, context } = await connect();
    const page = context.pages().find((p) => p.url() === url);
    const waiting = call('wait_for_feedback', { timeout_sec: 60 });
    await page.keyboard.press('Alt+Shift+A');
    await page.click('#cta', { force: true });
    assert.equal(await page.evaluate(() => window.clicked), undefined, 'page click must be blocked');
    assert.equal(page.url(), url, 'link must not navigate');
    await page.keyboard.type('Make this more minimal');
    await page.keyboard.press('Control+Enter');
    await page.mouse.move(200, 30);
    await page.keyboard.press('Alt+Shift+S');

    const { json, images } = await waiting;
    const a = json.annotations[0];
    assert.equal(json.annotations.length, 1);
    assert.equal(a.comment, 'Make this more minimal');
    assert.equal(a.selector, '#cta');
    assert.equal(a.source, 'src/Hero.tsx:12');
    assert.equal(a.element_text, 'Go', 'element text always included');
    assert.deepEqual(a.css, ['src/styles/global.css:3 .hero a', 'src/styles/global.css:7 #cta'], 'CSS rules with line numbers, generic ones skipped');
    const jpg = readFileSync(join(project, a.screenshot));
    const sof = jpg.indexOf(Buffer.from([0xff, 0xc0]));
    const h = jpg.readUInt16BE(sof + 5), w = jpg.readUInt16BE(sof + 7);
    assert.ok(w > 0 && w <= 480 && h <= 360, `screenshot is small (${w}x${h})`);
    assert.ok(existsSync(join(project, a.screenshot)), 'screenshot saved');
    assert.equal(images.length, 0, 'no image for non-visual comment');
    assert.ok(JSON.stringify(json).length / 4 < 500, 'within token budget');

    const det = await call('get_annotation_details', { id: a.id, fields: ['html', 'styles', 'screenshot'] });
    assert.match(det.json.html, /id="cta"/);
    assert.equal(det.images.length, 1);

    assert.match(readFileSync(join(project, '.annotate/ANNOTATIONS.md'), 'utf8'), /more minimal/);
    // resolve now keeps the loop alive: it waits for the next round itself.
    const next = call('resolve_annotation', { ids: [a.id], timeout_sec: 60 });
    await new Promise((r) => setTimeout(r, 1500)); // page reloads after resolve
    await page.keyboard.press('Alt+Shift+A');
    await page.click('p', { force: true });
    await page.keyboard.type('Bigger headline');
    await page.keyboard.press('Control+Enter');
    await page.keyboard.press('Alt+Shift+S');
    const res = (await next).json;
    assert.deepEqual(res.resolved, [a.id]);
    assert.equal(res.annotations[0].comment, 'Bigger headline');
    assert.equal(res.annotations[0].source, 'src/pages/index.astro:7', 'Astro dev source tags');
    assert.equal(res.errors, undefined, 'toolbar must not throw (Trusted Types page)');
    const fin = await call('resolve_annotation', { ids: [res.annotations[0].id], wait: false });
    assert.equal(fin.json.open, 0);
    await browser.close().catch(() => {});
  } finally {
    await client.close();
    await shutdown(await ensureSession()).catch(() => {});
    site.close();
  }
});
