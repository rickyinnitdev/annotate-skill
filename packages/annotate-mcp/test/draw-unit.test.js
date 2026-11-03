// Unit tests for the pure parts of draw.js (shared by the toolbar and the App page).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
const DRAW = join(src, 'draw.js'), TOOLBAR = join(src, 'toolbar.js');
const ctx = vm.createContext({});
vm.runInContext(readFileSync(DRAW, 'utf8'), ctx);

test('shapeBox pen', () => assert.deepEqual({ ...ctx.shapeBox({ tool: 'pen', points: [[10, 20], [30, 5], [15, 40]] }) }, { x: 10, y: 5, w: 20, h: 35 }));
test('shapeBox ellipse from any corner order', () => assert.deepEqual({ ...ctx.shapeBox({ tool: 'ellipse', points: [[50, 60], [10, 20]] }) }, { x: 10, y: 20, w: 40, h: 40 }));
test('shapeBox arrow includes head margin', () => assert.deepEqual({ ...ctx.shapeBox({ tool: 'arrow', points: [[100, 100], [200, 100]] }) }, { x: 88, y: 88, w: 124, h: 24 }));
test('isTiny', () => {
  assert.equal(ctx.isTiny({ x: 0, y: 0, w: 5, h: 5 }), true);
  assert.equal(ctx.isTiny({ x: 0, y: 0, w: 5, h: 40 }), false);
});
test('isTinyShape ignores arrow head padding', () => {
  assert.equal(ctx.isTinyShape({ tool: 'arrow', points: [[50, 50], [52, 51]] }), true);
  assert.equal(ctx.isTinyShape({ tool: 'ellipse', points: [[50, 50], [50, 50]] }), true);
  assert.equal(ctx.isTinyShape({ tool: 'arrow', points: [[50, 50], [90, 50]] }), false);
});
test('cropRect clamps at frame corner', () => assert.deepEqual({ ...ctx.cropRect({ x: 2, y: 3, w: 10, h: 10 }, 24, 800, 600) }, { x: 0, y: 0, w: 36, h: 37 }));
test('cropRect clamps at far edge', () => assert.deepEqual({ ...ctx.cropRect({ x: 790, y: 590, w: 20, h: 20 }, 24, 800, 600) }, { x: 766, y: 566, w: 34, h: 34 }));
test('toolbar bundle parses', () => {
  new vm.Script(`(() => {const SNAP_ORIGIN=null;\n${readFileSync(DRAW, 'utf8')}\n${readFileSync(TOOLBAR, 'utf8')}\n})();`);
});
