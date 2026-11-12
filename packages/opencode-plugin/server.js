// OpenCode 2.x server plugin for Annotate.
//
// Each batch you send from the browser is delivered to the chat you're working in: the session
// that opened Annotate (called one of its tools). You never have to say "check my annotations".
// The agent ends its turn after each batch, and the next batch arrives as a new message.
//
// Setting .annotate/settings.json -> { "newSession": true } starts a NEW session for every batch
// instead. Each round then costs about the same small amount, and the new session gets the last
// few resolved annotations, so "undo that" still works. But it runs out of sight, in another session.
//
// Trigger: annotations that stay undelivered (no agent is waiting for them) for GRACE_MS.
import { readFileSync, appendFileSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let define = (p) => p;
try { ({ Plugin: { define } } = await import('@opencode/plugin')); } catch {}

const GRACE_MS = 1200;  // an agent that is waiting picks feedback up within milliseconds
const POLL_MS = 1000;   // a tiny local file read; costs no tokens
// Tools of the annotate MCP server, as OpenCode names them ("annotate.open", "annotate.wait_for_feedback", ...).
const ANNOTATE_TOOL = /annotate[._:-](open|open_app|wait_for_feedback|resolve_annotation|get_annotation_details)$/i;

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const pickId = (r) => r?.id ?? r?.data?.id ?? r?.session?.id ?? r?.info?.id ?? r?.data?.info?.id;

export default define({
  id: 'annotate.push',
  async setup(ctx) {
    const opts = ctx.options || {};
    const dir = ctx.location?.directory || ctx.location?.project?.directory || process.cwd();
    const ann = join(dir, '.annotate');
    const queueFile = join(ann, 'queue.json');
    const historyFile = join(ann, 'history.json');
    const sessionFile = join(ann, 'session.json'); // the chat Annotate was opened from; survives restarts
    const logFile = join(ann, 'push.log');
    const log = (m) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch {} };
    // Per-project setting, re-read on every batch so changing it needs no restart.
    const settingsFile = join(ann, 'settings.json');
    const freshNow = () => opts.newSession === true || readJson(settingsFile, {}).newSession === true;
    const nudged = new Set();
    let busy = false, lastErr = '', where;
    let home = readJson(sessionFile, {}).sessionID;

    function setHome(id) {
      if (!id || id === home) return;
      home = id;
      try { mkdirSync(ann, { recursive: true }); writeFileSync(sessionFile, JSON.stringify({ sessionID: id, at: Date.now() })); } catch {}
      log(`annotate used in session ${id}; batches go there`);
    }

    // Learn which session uses Annotate: OpenCode emits an event when a tool call starts.
    const stopWatch = new AbortController();
    (async () => {
      try {
        const events = ctx.event?.subscribe?.({ types: ['session.tool.input.started'], signal: stopWatch.signal });
        if (!events) { log('no event API; batches go to the newest session'); return; }
        for await (const ev of events) {
          const d = ev?.data ?? ev?.properties ?? ev;
          if (d?.sessionID && ANNOTATE_TOOL.test(String(d.name ?? d.tool ?? ''))) setHome(d.sessionID);
        }
      } catch (e) { if (!stopWatch.signal.aborted) log(`event watch stopped: ${String(e?.message || e).split('\n')[0]}`); }
    })();

    async function newestSession() {
      const res = await ctx.session.list({ directory: dir, order: 'desc', limit: 5 });
      const list = res?.data ?? res?.sessions ?? res?.items ?? res;
      const arr = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : [];
      return arr.find((s) => !s.parentID)?.id ?? arr[0]?.id;
    }

    async function freshSession(title) {
      for (const input of [{ title, directory: dir }, { title }, {}]) {
        try { const id = pickId(await ctx.session.create(input)); if (id) return id; } catch (e) { lastErr = String(e?.message || e); }
      }
      return undefined;
    }

    function brief(items, fresh) {
      const hist = fresh ? readJson(historyFile, []).slice(-3) : [];
      const recent = hist.length
        ? '\nEarlier rounds, for context only:\n' + hist.map((h) => `- "${h.comment}" on ${h.selector}${h.note ? ` → ${h.note}` : ''}`).join('\n')
        : '';
      return `[Annotate] ${items.length} new annotation(s) from the browser. ` +
        'Call annotate wait_for_feedback (it returns them immediately), apply each comment to its element, ' +
        'then call resolve_annotation with all the ids and a short note. ' +
        'Finish your reply with one line per change, then exactly: "✅ Annotate done. Waiting for your next annotation."' + recent;
    }

    // Heartbeat: while this file is fresh, the annotate server runs in push mode
    // (agents end their turn after each batch, and this plugin delivers the next one).
    const alive = join(ann, 'push.alive');
    function heartbeat() {
      try { const t = new Date(); utimesSync(alive, t, t); }
      catch { try { mkdirSync(ann, { recursive: true }); writeFileSync(alive, ''); } catch {} }
    }

    async function tick() {
      heartbeat();
      if (busy) return;
      const now = Date.now();
      const stale = readJson(queueFile, []).filter((a) => a.status !== 'done' && !a.deliveredAt
        && !nudged.has(a.id) && now - (a.createdAt || now) > GRACE_MS);
      if (!stale.length) return;
      busy = true;
      try {
        const title = `Annotate: ${stale[0].comment.slice(0, 40)}${stale.length > 1 ? ` (+${stale.length - 1})` : ''}`;
        const fresh = freshNow();
        let sessionID; where = undefined;
        if (fresh) { sessionID = await freshSession(title); where = 'new session'; }
        if (!sessionID && home) { sessionID = home; where = 'annotate session'; }
        if (!sessionID) { sessionID = await newestSession(); where = 'newest session'; }
        if (!sessionID) { log(`no session to notify ${lastErr}`); return; }
        stale.forEach((a) => nudged.add(a.id));
        // 'queue': if the agent is mid-reply, the batch waits for it to finish instead of interrupting.
        await ctx.session.prompt({ sessionID, delivery: 'queue', text: brief(stale, where === 'new session') });
        log(`sent ${stale.map((a) => a.id).join(',')} to ${sessionID} (${where})`);
        lastErr = '';
      } catch (e) {
        stale.forEach((a) => nudged.delete(a.id));
        const msg = String(e?.message || e).split('\n')[0];
        if (where === 'annotate session') { log(`session ${home} unavailable (${msg}); using the newest one`); home = undefined; }
        if (msg !== lastErr) log(`failed: ${msg}`); // log each distinct error once
        lastErr = msg;
      } finally { busy = false; }
    }

    const timer = setInterval(tick, POLL_MS);
    timer.unref?.();
    log(`plugin loaded for ${dir}${freshNow() ? ' (new session per batch)' : home ? ` (batches go to ${home})` : ''}`);
    return () => { clearInterval(timer); stopWatch.abort(); };
  },
});
