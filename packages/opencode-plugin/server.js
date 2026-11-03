// OpenCode 2.x server plugin for Annotate.
//
// Each batch you send from the browser starts a NEW agent session. Every round then
// costs about the same small amount, instead of resending an ever-growing conversation.
// The new session gets the last few resolved annotations, so "undo that" still works.
//
// Trigger: annotations that stay undelivered (no agent is waiting for them) for GRACE_MS.
// Pair it with ANNOTATE_PUSH=1 on the annotate MCP server, which tells agents to end
// their turn after each batch instead of waiting.
import { readFileSync, appendFileSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let define = (p) => p;
try { ({ Plugin: { define } } = await import('@opencode/plugin')); } catch {}

const GRACE_MS = 1200;  // an agent that is waiting picks feedback up within milliseconds
const POLL_MS = 1000;   // a tiny local file read; costs no tokens

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const pickId = (r) => r?.id ?? r?.data?.id ?? r?.session?.id ?? r?.info?.id ?? r?.data?.info?.id;

export default define({
  id: 'annotate.push',
  async setup(ctx) {
    const opts = ctx.options || {};
    const dir = ctx.location?.directory || ctx.location?.project?.directory || process.cwd();
    const queueFile = join(dir, '.annotate', 'queue.json');
    const historyFile = join(dir, '.annotate', 'history.json');
    const logFile = join(dir, '.annotate', 'push.log');
    const log = (m) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch {} };
    // Per-project setting: .annotate/settings.json -> { "newSession": false } keeps one long session.
    const settingsFile = join(dir, '.annotate', 'settings.json');
    const reuseNow = () => opts.newSession === false || readJson(settingsFile, {}).newSession === false;
    const reuse = reuseNow();
    const nudged = new Set();
    let busy = false, lastErr = '';

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

    function brief(items) {
      const hist = readJson(historyFile, []).slice(-3);
      const recent = hist.length
        ? '\nEarlier rounds, for context only:\n' + hist.map((h) => `- "${h.comment}" on ${h.selector}${h.note ? ` → ${h.note}` : ''}`).join('\n')
        : '';
      return `[Annotate] ${items.length} new annotation(s) from the browser. ` +
        'Call annotate wait_for_feedback (it returns them immediately), apply each comment to its element, ' +
        'then call resolve_annotation with all the ids and a short note. ' +
        'Finish your reply with one line per change, then exactly: "✅ Annotate done. Waiting for your next annotation."' + recent;
    }

    // Heartbeat: while this file is fresh, the annotate server runs in push mode
    // (agents end their turn after each batch). Skipped when one long session is wanted.
    const alive = join(dir, '.annotate', 'push.alive');
    function heartbeat() {
      if (reuseNow()) return;
      try { const t = new Date(); utimesSync(alive, t, t); }
      catch { try { mkdirSync(join(dir, '.annotate'), { recursive: true }); writeFileSync(alive, ''); } catch {} }
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
        const reuse = reuseNow(); // re-read, so changing the file needs no restart
        const sessionID = (!reuse && (await freshSession(title))) || (await newestSession());
        if (!sessionID) { log(`no session to notify ${lastErr}`); return; }
        stale.forEach((a) => nudged.add(a.id));
        await ctx.session.prompt({ sessionID, delivery: 'queue', text: brief(stale) });
        log(`sent ${stale.map((a) => a.id).join(',')} to ${sessionID}${reuse ? '' : ' (new session)'}`);
        lastErr = '';
      } catch (e) {
        stale.forEach((a) => nudged.delete(a.id));
        const msg = String(e?.message || e).split('\n')[0];
        if (msg !== lastErr) log(`failed: ${msg}`); // log each distinct error once
        lastErr = msg;
      } finally { busy = false; }
    }

    const timer = setInterval(tick, POLL_MS);
    timer.unref?.();
    log(`plugin loaded for ${dir}${reuse ? ' (reusing newest session)' : ''}`);
    return () => clearInterval(timer);
  },
});
