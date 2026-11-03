// Shared drawing helpers: bundled into the injected toolbar and served to the App page.
// Plain browser JS, top-level function declarations only. A shape is
// { tool: 'pen'|'ellipse'|'arrow', points: [[x, y], ...] }; ellipse/arrow use [start, end].
var DRAW_COLOR = '#ef4444', DRAW_WIDTH = 3, ARROW_HEAD = 12;

function shapeBox(shape) {
  const xs = shape.points.map((p) => p[0]), ys = shape.points.map((p) => p[1]);
  let x = Math.min(...xs), y = Math.min(...ys), x2 = Math.max(...xs), y2 = Math.max(...ys);
  if (shape.tool === 'arrow') { x -= ARROW_HEAD; y -= ARROW_HEAD; x2 += ARROW_HEAD; y2 += ARROW_HEAD; }
  return { x, y, w: x2 - x, h: y2 - y };
}

function isTiny(box) { return box.w < 6 && box.h < 6; }
// A click without a real drag; uses the raw points, so the arrow head margin doesn't count.
function isTinyShape(shape) { return isTiny(shapeBox({ tool: 'pen', points: shape.points })); }

function cropRect(box, pad, maxW, maxH) {
  const x = Math.max(0, Math.floor(box.x - pad)), y = Math.max(0, Math.floor(box.y - pad));
  const x2 = Math.min(maxW, Math.ceil(box.x + box.w + pad)), y2 = Math.min(maxH, Math.ceil(box.y + box.h + pad));
  return { x: Math.min(x, maxW - 1), y: Math.min(y, maxH - 1), w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

function arrowHead(a, b) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  return [ang - Math.PI / 7, ang + Math.PI / 7].map((t) => [b[0] - ARROW_HEAD * Math.cos(t), b[1] - ARROW_HEAD * Math.sin(t)]);
}

function shapeToSvg(shape) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const style = { fill: 'none', stroke: DRAW_COLOR, 'stroke-width': DRAW_WIDTH, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const [a, b] = shape.points;
  if (shape.tool === 'ellipse') {
    const e = b || a;
    return el('ellipse', { ...style, cx: (a[0] + e[0]) / 2, cy: (a[1] + e[1]) / 2, rx: Math.abs(e[0] - a[0]) / 2, ry: Math.abs(e[1] - a[1]) / 2 });
  }
  if (shape.tool === 'arrow') {
    const e = b || a, g = el('g', {}), [h1, h2] = arrowHead(a, e);
    g.append(el('path', { ...style, d: `M${a[0]} ${a[1]}L${e[0]} ${e[1]}M${h1[0]} ${h1[1]}L${e[0]} ${e[1]}L${h2[0]} ${h2[1]}` }));
    return g;
  }
  return el('path', { ...style, d: shape.points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('') });
}

function paintShape(ctx, shape, scale = 1, dx = 0, dy = 0) {
  const m = (p) => [(p[0] - dx) * scale, (p[1] - dy) * scale];
  ctx.save();
  ctx.strokeStyle = DRAW_COLOR; ctx.lineWidth = Math.max(2, DRAW_WIDTH * scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  const [a, b] = shape.points.map(m);
  if (shape.tool === 'ellipse') {
    const e = b || a;
    ctx.ellipse((a[0] + e[0]) / 2, (a[1] + e[1]) / 2, Math.abs(e[0] - a[0]) / 2 || 1, Math.abs(e[1] - a[1]) / 2 || 1, 0, 0, Math.PI * 2);
  } else if (shape.tool === 'arrow') {
    const e = b || a, [h1, h2] = arrowHead(shape.points[0], shape.points[1] || shape.points[0]).map(m);
    ctx.moveTo(a[0], a[1]); ctx.lineTo(e[0], e[1]); ctx.moveTo(h1[0], h1[1]); ctx.lineTo(e[0], e[1]); ctx.lineTo(h2[0], h2[1]);
  } else {
    shape.points.map(m).forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  }
  ctx.stroke();
  ctx.restore();
}

// Pointer capture on `target`: preview(shape) while dragging, preview(null) + onDone(shape) on release.
function attachDrawing(target, { toLocal, getTool, preview, onDone }) {
  let cur = null;
  const down = (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    try { target.setPointerCapture(e.pointerId); } catch {}
    const p = toLocal(e);
    cur = { tool: getTool(), points: [p] };
    preview(cur);
  };
  const move = (e) => {
    if (!cur) return;
    e.preventDefault(); e.stopPropagation();
    const p = toLocal(e);
    if (cur.tool === 'pen') cur.points.push(p); else cur.points[1] = p;
    preview(cur);
  };
  const up = (e) => {
    if (!cur) return;
    e.preventDefault(); e.stopPropagation();
    const shape = cur; cur = null;
    if (shape.tool !== 'pen' && !shape.points[1]) shape.points[1] = shape.points[0];
    shape.points = shape.points.map((p) => [Math.round(p[0]), Math.round(p[1])]);
    preview(null);
    if (!isTinyShape(shape)) onDone(shape);
  };
  target.addEventListener('pointerdown', down);
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
  return () => {
    target.removeEventListener('pointerdown', down);
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
  };
}
