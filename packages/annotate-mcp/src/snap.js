// App page: snapshot any window via getDisplayMedia, draw on the frozen frame, comment, send.
// Uses draw.js (loaded before this file). Talks to the MCP server through window.__annotate_send.
(() => {
  const TOKEN = new URLSearchParams(location.search).get('t');
  const NAME_KEY = 'annotate.appName';
  const LABELS = { waiting: 'Ready for annotations', working: 'AI working…', done: 'Done ✓ Ready for the next one' };
  const $ = (id) => document.getElementById(id);
  const ui = { choose: $('choose'), capture: $('capture'), name: $('app-name'), tools: $('tools'), send: $('send'),
    status: $('status'), frame: $('frame'), empty: $('empty'), live: $('live'), frames: $('frames'), list: $('list') };
  const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); e.append(...kids); return e; };
  const call = (msg) => (window.__annotate_send ? window.__annotate_send(msg) : Promise.reject(new Error('Annotate server not connected')));

  let stream = null, tool = 'pen', previewShape = null, pending = null, pop = null;
  const frames = [];   // [{ canvas, label }]
  let cur = -1;        // index of the frame shown
  let items = [];      // [{ n, frame, shape, box, comment, state: 'draft'|'sent'|'done' }]

  try { ui.name.value = localStorage.getItem(NAME_KEY) || ''; } catch {}
  ui.name.addEventListener('input', () => { try { localStorage.setItem(NAME_KEY, ui.name.value); } catch {} });
  const isRealTitle = (l) => !!l && !/^(window|screen|web-contents-media-stream):/i.test(l);

  // ---------- drawing surface ----------
  const canvas = h('canvas');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [t, label] of [['pen', 'Pen'], ['ellipse', 'Ellipse'], ['arrow', 'Arrow']]) {
    const b = h('button', { class: t === tool ? 'on' : '', 'data-tool': t }, label);
    b.onclick = () => { tool = t; for (const x of ui.tools.children) x.classList.toggle('on', x.dataset.tool === t); };
    ui.tools.append(b);
  }
  attachDrawing(svg, {
    toLocal: (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; },
    getTool: () => tool,
    preview: (s) => { previewShape = s; render(); },
    onDone: (s) => openPopover(s),
  });

  function showFrame(i) {
    cur = i;
    const f = frames[i];
    canvas.width = f.canvas.width; canvas.height = f.canvas.height;
    canvas.getContext('2d').drawImage(f.canvas, 0, 0);
    svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
    if (!canvas.isConnected) { ui.empty.remove(); ui.frame.append(canvas, svg); }
    closePopover();
    render();
  }

  function addFrame(src, label) {
    const c = h('canvas');
    c.width = src.videoWidth || src.naturalWidth || src.width; c.height = src.videoHeight || src.naturalHeight || src.height;
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    frames.push({ canvas: c, label });
    if (isRealTitle(label) && !ui.name.value) ui.name.value = label;
    showFrame(frames.length - 1);
  }

  function render() {
    svg.textContent = '';
    const NS = 'http://www.w3.org/2000/svg';
    for (const it of items.filter((x) => x.frame === cur)) {
      svg.appendChild(shapeToSvg(it.shape));
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', it.box.x); t.setAttribute('y', Math.max(16, it.box.y - 4));
      t.setAttribute('fill', '#ef4444'); t.setAttribute('font-size', Math.max(14, canvas.width / 60)); t.setAttribute('font-weight', '700');
      t.textContent = it.n;
      svg.appendChild(t);
    }
    for (const s of [pending, previewShape]) if (s) svg.appendChild(shapeToSvg(s));
    // thumbnails
    ui.frames.textContent = '';
    frames.forEach((f, i) => {
      const th = h('canvas', { class: i === cur ? 'on' : '', title: `Frame ${i + 1}` });
      th.width = 144; th.height = Math.round(144 * f.canvas.height / f.canvas.width) || 1;
      th.getContext('2d').drawImage(f.canvas, 0, 0, th.width, th.height);
      th.onclick = () => showFrame(i);
      ui.frames.append(th);
    });
    // comment list
    ui.list.textContent = '';
    for (const it of items) {
      const li = h('li', { class: it.state === 'draft' ? '' : it.state }, `${it.n}. ${it.comment}`);
      li.title = it.state === 'draft' ? 'Not sent yet' : it.state === 'sent' ? 'The agent has it' : 'Done';
      li.onclick = () => showFrame(it.frame);
      ui.list.append(li);
    }
    const drafts = items.filter((x) => x.state === 'draft').length;
    ui.send.disabled = drafts === 0;
    ui.send.textContent = drafts ? `Send to AI (${drafts})` : 'Send to AI';
  }

  function openPopover(shape) {
    closePopover();
    pending = shape;
    const box = shapeBox(shape);
    const r = canvas.getBoundingClientRect(), fr = ui.frame.getBoundingClientRect(), k = r.width / canvas.width;
    pop = h('div', { class: 'pop' });
    const ta = h('textarea', { placeholder: 'What should change here?' });
    const save = h('button', { class: 'go' }, 'Save'), cancel = h('button', {}, 'Cancel');
    pop.append(ta, h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Ctrl+Enter to save'), cancel, save));
    pop.style.left = Math.max(8, Math.min(fr.width - 290, (box.x) * k)) + 'px';
    pop.style.top = Math.max(8, Math.min(fr.height - 140, (box.y + box.h) * k + 8)) + 'px';
    ui.frame.append(pop);
    const done = () => {
      const comment = ta.value.trim();
      if (!comment) return closePopover();
      const n = Math.max(0, ...items.map((x) => x.n)) + 1;
      items.push({ n, frame: cur, shape, box, comment, state: 'draft' });
      pending = null; closePopover(); render();
    };
    save.onclick = done; cancel.onclick = closePopover;
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done();
      if (e.key === 'Escape') closePopover();
    });
    ta.focus();
    render();
  }
  function closePopover() { pop?.remove(); pop = null; if (pending) { pending = null; render(); } }

  // ---------- capture ----------
  ui.choose.onclick = async () => {
    let s;
    try { s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
    catch { ui.status.textContent = 'Window not shared'; return; }
    stream?.getTracks().forEach((t) => t.stop());
    stream = s;
    const track = s.getVideoTracks()[0];
    if (isRealTitle(track?.label)) ui.name.value = track.label;
    track?.addEventListener('ended', () => {
      if (stream !== s) return;
      stream = null; ui.capture.disabled = true; ui.live.classList.remove('on'); ui.status.textContent = 'Window sharing stopped';
    });
    ui.live.srcObject = s; ui.live.classList.add('on');
    await ui.live.play().catch(() => {});
    ui.capture.disabled = false;
    ui.status.textContent = 'Sharing. Press Capture to freeze a frame';
  };
  ui.capture.onclick = () => { if (stream && ui.live.videoWidth) addFrame(ui.live, stream.getVideoTracks()[0]?.label); };

  // ---------- send ----------
  function jpeg(src, sx, sy, sw, sh, scale, q, shape) {
    const c = h('canvas');
    c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
    const g = c.getContext('2d');
    g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    if (shape) paintShape(g, shape, scale, sx, sy);
    return c.toDataURL('image/jpeg', q);
  }
  const r3 = (v) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));

  async function sendAll() {
    const drafts = items.filter((x) => x.state === 'draft');
    if (!drafts.length) return;
    const used = [...new Set(drafts.map((d) => d.frame))];
    const out = used.map((i) => { const f = frames[i].canvas; return jpeg(f, 0, 0, f.width, f.height, Math.min(1, 1600 / f.width), 0.7); });
    const payload = drafts.map((d) => {
      const f = frames[d.frame].canvas, c = cropRect(d.box, 24, f.width, f.height);
      return { n: d.n, comment: d.comment, frame: used.indexOf(d.frame),
        region: { x: r3(d.box.x / f.width), y: r3(d.box.y / f.height), w: r3(d.box.w / f.width), h: r3(d.box.h / f.height) },
        crop: jpeg(f, c.x, c.y, c.w, c.h, Math.min(1, 480 / c.w, 360 / c.h), 0.6, d.shape) };
    });
    ui.send.disabled = true; ui.send.textContent = 'Sending…';
    try {
      const res = await call({ type: 'send', kind: 'app', token: TOKEN, url: location.href, path: '/snap',
        app: ui.name.value.trim(), frames: out, items: payload });
      for (const d of drafts) d.state = 'sent';
      sync(res);
    } catch (e) {
      ui.send.textContent = 'Failed. Retry'; ui.send.disabled = false; console.warn('[annotate]', e);
    }
  }
  ui.send.onclick = sendAll;
  window.addEventListener('keydown', (e) => { if (e.altKey && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); sendAll(); } });

  // ---------- status from the server ----------
  function setStatus(s) { if (LABELS[s]) ui.status.textContent = LABELS[s]; }
  function sync(st) {
    if (!st) return;
    for (const it of items) {
      if (it.state === 'draft') continue;
      const e = (st.open || []).find((o) => o.path === '/snap' && o.n === it.n);
      if (e) it.state = e.state === 'done' ? 'done' : 'sent';
    }
    if (st.status) setStatus(st.status);
    render();
  }
  window.__annotate = { sync, setStatus, hide() {}, capture() {} };
  window.__snap = {
    useFrame: (url, label) => new Promise((res, rej) => { const img = new Image(); img.onload = () => { addFrame(img, label); res(); }; img.onerror = rej; img.src = url; }),
    frameCount: () => frames.length,
  };
  call({ type: 'sync', path: location.pathname }).then(sync).catch(() => {});
})();
