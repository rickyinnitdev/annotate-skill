// End-to-end for Draw mode (web pages) and App snapshots (any window), headless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, jpegSize } from './harness.js';

const HTML = `<!doctype html><html><head><style>body { margin: 0; height: 2400px }</style></head><body>
<section class="card" data-source="src/Card.tsx:4" style="position:absolute;top:900px;left:100px;width:300px;height:200px;background:#eee">Card</section>
</body></html>`;

const drag = async (page, [x1, y1], [x2, y2]) => {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 10 });
  await page.mouse.up();
};

test('draw mode and app snapshots', { timeout: 240000 }, async (t) => {
  const h = await startHarness({ html: HTML });
  try {
    assert.equal((await h.call('open', { url: h.url })).json.ok, true);
    const { context } = await h.human();
    const page = context.pages().find((p) => p.url() === h.url);
    const shot = (a) => jpegSize(readFileSync(join(h.project, a.screenshot)));

    await t.test('tiny click makes no drawing', async () => {
      await page.keyboard.press('Alt+Shift+D');
      await page.mouse.move(300, 50); await page.mouse.down(); await page.mouse.up();
      await page.keyboard.press('Alt+Shift+S');
      assert.equal((await h.call('wait_for_feedback', { timeout_sec: 10 })).json.status, 'waiting');
      await page.keyboard.press('Alt+Shift+D');
    });

    await t.test('cancel removes the stroke', async () => {
      await page.keyboard.press('Alt+Shift+D');
      await drag(page, [200, 200], [300, 300]);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Alt+Shift+S');
      assert.equal((await h.call('wait_for_feedback', { timeout_sec: 10 })).json.status, 'waiting');
      await page.keyboard.press('Alt+Shift+D');
    });

    await t.test('draw circle over element while scrolled', async () => {
      await page.evaluate(() => scrollTo(0, 800));
      const waiting = h.call('wait_for_feedback', { timeout_sec: 60 });
      await page.keyboard.press('Alt+Shift+D');
      await drag(page, [120, 120], [380, 260]);
      await page.keyboard.type('Make this card blue');
      await page.keyboard.press('Control+Enter');
      await page.keyboard.press('Alt+Shift+S');
      const { json, images } = await waiting;
      const a = json.annotations[0];
      assert.equal(json.annotations.length, 1);
      assert.equal(a.kind, 'draw');
      assert.equal(a.comment, 'Make this card blue');
      assert.equal(a.source, 'src/Card.tsx:4');
      assert.ok(existsSync(join(h.project, a.screenshot)), 'screenshot saved');
      const s = shot(a);
      assert.ok(s.w > 0 && s.w <= 480 && s.h <= 360, `crop is small (${s.w}x${s.h})`);
      assert.equal(images.length, 1, 'drawings always attach their image');
      assert.ok(JSON.stringify(json).length / 4 < 500, 'within token budget');
      const det = (await h.call('get_annotation_details', { id: a.id, fields: ['under', 'box'] })).json;
      assert.ok(Array.isArray(det.under));
      assert.ok(det.box.y >= 800, `box is in page coordinates (y=${det.box.y})`);
      assert.match(readFileSync(join(h.project, '.annotate/ANNOTATIONS.md'), 'utf8'), /\[drawing\]/);
      await h.call('resolve_annotation', { ids: [a.id], wait: false });
    });

    await t.test('drawing over empty space', async () => {
      await new Promise((r) => setTimeout(r, 1000)); // page reloads after resolve
      await page.evaluate(() => scrollTo(0, 0));
      const waiting = h.call('wait_for_feedback', { timeout_sec: 60 });
      await page.keyboard.press('Alt+Shift+D');
      await drag(page, [20, 20], [90, 90]);
      await page.keyboard.type('Add a logo here');
      await page.keyboard.press('Control+Enter');
      await page.keyboard.press('Alt+Shift+S');
      const a = (await waiting).json.annotations[0];
      assert.equal(a.kind, 'draw');
      assert.equal(a.source, undefined);
      assert.ok(a.screenshot && existsSync(join(h.project, a.screenshot)));
      const res = await h.call('resolve_annotation', { ids: [a.id], wait: false });
      assert.equal(res.json.errors, undefined, 'no page errors');
    });

    await t.test('open_app serves snap page', async () => {
      const r = (await h.call('open_app')).json;
      assert.equal(r.ok, true);
      assert.match(r.next, /Choose a window|wait_for_feedback/);
      const snap = context.pages().find((p) => /\/snap\?t=/.test(p.url()));
      assert.ok(snap, 'snap page open');
      await snap.waitForLoadState('domcontentloaded');
      assert.equal(await snap.title(), 'Annotate · App');
      assert.equal(await snap.evaluate(() => !!document.querySelector('meta[name=annotate-snap]')), true);
      assert.equal(await snap.evaluate(() => !!document.querySelector('annotate-toolbar')), false, 'no toolbar on the App page');
      const origin = new URL(snap.url()).origin;
      assert.equal((await fetch(origin + '/snap')).status, 403, 'token required');
      assert.equal((await fetch(origin + '/snap?t=nope')).status, 403);
      assert.equal((await fetch(origin + '/draw.js')).status, 200);
      assert.equal((await fetch(origin + '/etc/passwd')).status, 404);
      assert.equal((await h.call('open_app')).json.ok, true, 'second call reuses the page');
      assert.equal(context.pages().filter((p) => /\/snap\?t=/.test(p.url())).length, 1);
    });
  } finally {
    await h.close();
  }
});
