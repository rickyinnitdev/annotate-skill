// Injected into every page via addInitScript. Plain browser JS, no dependencies.
// Talks to the MCP server only through the exposed binding window.__annotate_send.
(() => {
  if (window.top !== window || window.__annotate) return;
  const KEY = '__annotate_drafts';
  const STYLE_KEYS = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color',
    'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign',
    'border', 'borderRadius', 'gap', 'flexDirection', 'justifyContent', 'alignItems', 'gridTemplateColumns', 'boxShadow', 'opacity'];

  let active = false, hoverEl = null, editing = null, status = 'idle', host, root, ui = {};
  let drafts = load();          // [{n, selector, comment, path}] not yet sent
  let sent = [];                // [{id, n, selector, comment, state}] from server
  const elRefs = new Map();     // n -> element (fast path while still in DOM)

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    for (const k of kids) if (k != null) el.append(k);
    return el;
  }
  function load() { try { return JSON.parse(sessionStorage.getItem(KEY)) || []; } catch { return []; } }
  function persist() { try { sessionStorage.setItem(KEY, JSON.stringify(drafts)); } catch {} }
  const call = (msg) => (window.__annotate_send ? window.__annotate_send(msg) : Promise.reject(new Error('Annotate server not connected')));

  // ---------- element description ----------
  const isHashy = (c) => /\d{3,}|^css-|^sc-|^_|__[a-z0-9]{5,}$|^[a-z0-9]{6,}$/i.test(c) && !/^(col|row|mt|mb|p|m)-?\d/.test(c);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  function unique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } }

  function selectorFor(el) {
    if (el.id && unique('#' + esc(el.id))) return '#' + esc(el.id);
    for (const a of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v) { const s = `${el.tagName.toLowerCase()}[${a}="${v.replace(/"/g, '\\"')}"]`; if (unique(s)) return s; }
    }
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 6; cur = cur.parentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && unique('#' + esc(cur.id))) { parts.unshift('#' + esc(cur.id)); break; }
      const cls = [...cur.classList].filter((c) => !isHashy(c) && !c.startsWith('__annotate')).slice(0, 2);
      if (cls.length) part += '.' + cls.map(esc).join('.');
      const sib = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
      if (sib.length > 1) part += `:nth-of-type(${sib.indexOf(cur) + 1})`;
      parts.unshift(part);
      if (unique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  }

  function sourceFor(el) {
    const tagged = el.closest('[data-source]');
    if (tagged) return tagged.getAttribute('data-source');
    // Astro dev server tags every element: data-astro-source-file="/abs/src/pages/index.astro" data-astro-source-loc="12:5"
    const astro = el.closest('[data-astro-source-file]');
    if (astro) {
      const line = (astro.getAttribute('data-astro-source-loc') || '').split(':')[0];
      return astro.getAttribute('data-astro-source-file') + (line ? ':' + line : '');
    }
    for (let cur = el; cur; cur = cur.parentElement) {
      // Svelte (dev)
      if (cur.__svelte_meta?.loc) { const l = cur.__svelte_meta.loc; return `${l.file}:${l.line + 1}`; }
      // Vue (dev)
      const vf = cur.__vueParentComponent?.type?.__file; if (vf) return vf;
      // React <=18 (dev): _debugSource on the fiber
      const fk = Object.keys(cur).find((k) => k.startsWith('__reactFiber$'));
      for (let f = fk && cur[fk]; f; f = f.return) {
        if (f._debugSource) return `${f._debugSource.fileName}:${f._debugSource.lineNumber}`;
      }
      if (fk) break;
    }
    return '';
  }

  // Author CSS rules that match the element, newest last (those usually win), e.g.
  // "/src/styles/global.css .pegboard". Lets the agent jump to the rule instead of grepping.
  const GENERIC = /^(\*|html|body|:root|:where\(.*\)|\*,\s*.*)$/;
  function cssFor(el) {
    const out = [];
    const walk = (rules, file) => {
      for (const r of rules) {
        if (r.cssRules && !r.selectorText) { walk(r.cssRules, file); continue; } // @media / @supports / @layer
        const sel = r.selectorText;
        if (!sel || GENERIC.test(sel.trim())) continue;
        try { if (el.matches(sel)) out.push(`${file} ${sel.length > 80 ? sel.slice(0, 80) + '…' : sel}`); } catch {}
      }
    };
    for (const sh of document.styleSheets) {
      const node = sh.ownerNode;
      if (node && host && (node === host || host.contains?.(node))) continue;
      const file = node?.getAttribute?.('data-vite-dev-id') || (sh.href ? new URL(sh.href).pathname : 'inline <style>');
      if (/node_modules/.test(file)) continue;
      try { walk(sh.cssRules, file); } catch {} // cross-origin sheets throw
    }
    return [...new Set(out)].slice(-4);
  }

  function describe(el) {
    const cs = getComputedStyle(el), styles = {};
    for (const k of STYLE_KEYS) { const v = cs[k]; if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px') styles[k] = v; }
    const r = el.getBoundingClientRect();
    return {
      selector: selectorFor(el),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      html: el.outerHTML.slice(0, 20000),
      styles,
      source: sourceFor(el),
      css: cssFor(el),
      rect: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }

  function find(d) {
    const ref = elRefs.get(d.n);
    if (ref && ref.isConnected) return ref;
    try { return document.querySelector(d.selector); } catch { return null; }
  }

  // ---------- UI ----------
  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .bar { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; gap: 6px; align-items: center;
      background: #18181b; color: #fafafa; padding: 6px; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.3); }
    button { cursor: pointer; border: 0; border-radius: 8px; padding: 6px 10px; background: #27272a; color: inherit; }
    button:hover { background: #3f3f46; } button.on { background: #6366f1; } button.go { background: #16a34a; }
    button:disabled { opacity: .4; cursor: default; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #71717a; margin: 0 4px; }
    .dot.waiting { background: #22c55e; } .dot.working { background: #f59e0b; animation: p 1s infinite; }
    @keyframes p { 50% { opacity: .3; } }
    .hl { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #6366f1; background: rgba(99,102,241,.12); border-radius: 3px; display: none; }
    .tag { position: absolute; top: -22px; left: -2px; background: #6366f1; color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
    .pin { position: absolute; z-index: 2147483645; width: 22px; height: 22px; border-radius: 50%; background: #6366f1; color: #fff;
      display: grid; place-items: center; font-size: 11px; font-weight: 600; cursor: pointer; transform: translate(-50%,-50%); box-shadow: 0 2px 6px rgba(0,0,0,.3); }
    .pin.sent { background: #f59e0b; } .pin.done { background: #16a34a; }
    .pop { position: fixed; z-index: 2147483647; width: 280px; background: #18181b; color: #fafafa; border-radius: 10px; padding: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
    textarea { width: 100%; min-height: 64px; resize: vertical; border: 1px solid #3f3f46; border-radius: 6px; background: #09090b; color: inherit; padding: 6px; }
    .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; } .hint { color: #a1a1aa; font-size: 11px; margin-right: auto; align-self: center; }
    .layer { position: absolute; left: 0; top: 0; width: 0; height: 0; }`;

  function mount() {
    host = document.createElement('annotate-toolbar');
    root = host.attachShadow({ mode: 'closed' });
    // Built with DOM calls, not innerHTML, so pages with Trusted Types / strict CSP still work.
    const style = h('style'); style.textContent = CSS_TEXT;
    ui = {
      layer: h('div', { class: 'layer' }),
      tag: h('span', { class: 'tag' }),
      dot: h('span', { class: 'dot', title: 'Agent status' }),
      toggle: h('button', { class: 'toggle', title: 'Alt+Shift+A' }, 'Annotate'),
      go: h('button', { class: 'go', title: 'Alt+Shift+S', disabled: '' }, 'Send to AI'),
    };
    ui.hl = h('div', { class: 'hl' }, ui.tag);
    root.append(style, ui.layer, ui.hl, h('div', { class: 'bar' }, ui.dot, ui.toggle, ui.go));
    ui.toggle.onclick = () => setActive(!active);
    ui.go.onclick = sendAll;
    document.documentElement.appendChild(host);
    // Frameworks sometimes wipe <html> children on hydration; re-attach if removed.
    new MutationObserver(() => { if (!host.isConnected) document.documentElement.appendChild(host); })
      .observe(document.documentElement, { childList: true });
    render();
    setInterval(() => { if (drafts.length || sent.length) render(); }, 1000); // follow layout shifts / HMR
    call({ type: 'sync', path: location.pathname }).then(applySync).catch(() => {});
  }

  function setActive(on) {
    active = on;
    ui.toggle.classList.toggle('on', on);
    ui.toggle.textContent = on ? 'Annotating… (Esc)' : 'Annotate';
    if (!on) { ui.hl.style.display = 'none'; hoverEl = null; }
    document.documentElement.style.cursor = on ? 'crosshair' : '';
  }

  function setStatus(s) { status = s; if (!ui.dot) return; ui.dot.className = 'dot ' + s; ui.dot.title = 'Agent: ' + s; }

  let raf = 0;
  function render() { if (!ui.layer) return; cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
  function draw() {
    const pins = [...drafts.map((d) => ({ ...d, state: 'draft' })), ...sent.filter((s) => s.path === location.pathname)];
    ui.layer.textContent = '';
    for (const p of pins) {
      const el = find(p); if (!el) continue;
      const r = el.getBoundingClientRect();
      const pin = document.createElement('div');
      pin.className = 'pin ' + (p.state === 'draft' ? '' : p.state);
      pin.textContent = p.n;
      pin.title = p.comment;
      pin.style.left = r.left + scrollX + 'px'; pin.style.top = r.top + scrollY + 'px';
      pin.style.position = 'absolute';
      if (p.state === 'draft') pin.onclick = (e) => { e.stopPropagation(); openPopover(el, p); };
      ui.layer.appendChild(pin);
    }
    ui.go.disabled = drafts.length === 0;
    ui.go.textContent = drafts.length ? `Send to AI (${drafts.length})` : 'Send to AI';
  }

  function highlight(el) {
    const r = el.getBoundingClientRect();
    Object.assign(ui.hl.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const cls = [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
    ui.tag.textContent = `${el.tagName.toLowerCase()}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function openPopover(el, existing) {
    closePopover();
    const r = el.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'pop';
    const ta = h('textarea', { placeholder: 'What should change?' });
    const saveBtn = h('button', { class: 'save go' }, 'Save');
    const cancelBtn = h('button', { class: 'cancel' }, 'Cancel');
    const del = existing ? h('button', { class: 'del' }, 'Delete') : null;
    pop.append(ta, h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Ctrl+Enter to save'), del, cancelBtn, saveBtn));
    const top = Math.min(innerHeight - 150, Math.max(8, r.bottom + 8));
    const left = Math.min(innerWidth - 290, Math.max(8, r.left));
    Object.assign(pop.style, { top: top + 'px', left: left + 'px' });
    root.appendChild(pop);
    ta.value = existing?.comment || '';
    const save = () => {
      const comment = ta.value.trim();
      if (!comment) return closePopover();
      if (existing) existing.comment = comment, Object.assign(drafts.find((d) => d.n === existing.n), { comment });
      else {
        const n = Math.max(0, ...drafts.map((d) => d.n), ...sent.map((s) => s.n)) + 1;
        elRefs.set(n, el);
        drafts.push({ n, selector: selectorFor(el), comment, path: location.pathname });
      }
      persist(); closePopover(); render();
    };
    saveBtn.onclick = save;
    cancelBtn.onclick = closePopover;
    if (del) del.onclick = () => { drafts = drafts.filter((d) => d.n !== existing.n); persist(); closePopover(); render(); };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
      if (e.key === 'Escape') closePopover();
    });
    editing = pop;
    setTimeout(() => ta.focus(), 0);
  }
  function closePopover() { editing?.remove(); editing = null; }

  async function sendAll() {
    if (!drafts.length) return;
    const items = drafts.map((d) => {
      const el = find(d);
      return { n: d.n, comment: d.comment, path: d.path, ...(el ? describe(el) : { selector: d.selector, text: '', html: '', styles: {}, source: '' }) };
    });
    ui.go.disabled = true; ui.go.textContent = 'Sending…';
    try {
      const res = await call({ type: 'send', url: location.href, path: location.pathname, items });
      drafts = []; persist(); elRefs.clear(); applySync(res); setActive(false);
    } catch (e) {
      ui.go.textContent = 'Failed. Retry'; ui.go.disabled = false; console.warn('[annotate]', e);
    }
  }

  function applySync(res) { if (res) { sent = res.open || []; if (res.status) setStatus(res.status); render(); } }

  // ---------- event capture: block page interaction while annotating ----------
  const ours = (e) => e.composedPath().includes(host);
  const target = (e) => { const t = e.composedPath()[0]; return t && t.nodeType === 1 ? t : null; };
  const block = (e) => { if (active && !ours(e)) { e.preventDefault(); e.stopImmediatePropagation(); } };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu', 'auxclick', 'submit', 'touchstart'])
    window.addEventListener(t, block, { capture: true, passive: false });
  window.addEventListener('click', (e) => {
    if (!active || ours(e)) return;
    block(e);
    const el = target(e); if (el) openPopover(el);
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!active || editing || ours(e)) return;
    const el = target(e);
    if (el && el !== hoverEl) { hoverEl = el; highlight(el); }
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyA') { e.preventDefault(); setActive(!active); }
    else if (e.altKey && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); sendAll(); }
    else if (e.key === 'Escape' && active && !editing) setActive(false);
    else if (active && hoverEl && e.key === 'ArrowUp' && hoverEl.parentElement && hoverEl.parentElement !== document.body) {
      e.preventDefault(); hoverEl = hoverEl.parentElement; highlight(hoverEl); // walk up to the parent
    } else if (active && hoverEl && e.key === 'Enter' && !editing) { e.preventDefault(); openPopover(hoverEl); }
  }, true);
  window.addEventListener('scroll', () => { if (hoverEl && active) highlight(hoverEl); }, { capture: true, passive: true });
  window.addEventListener('resize', render, { passive: true });
  ['pushState', 'replaceState'].forEach((m) => { const o = history[m]; history[m] = function () { const r = o.apply(this, arguments); render(); return r; }; });
  window.addEventListener('popstate', render);

  window.__annotate = {
    setStatus: (s) => host && setStatus(s),
    sync: (r) => { if (r) { sent = r.open || []; status = r.status || status; } if (host) applySync(r); },
    hide: (h) => { if (host) host.style.display = h ? 'none' : ''; },
  };
  if (document.documentElement) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
