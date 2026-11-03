// OpenCode 2.x server plugin: deliver Annotate feedback even if the agent stopped waiting.
//
// MCP can't wake an idle agent. When annotations sit undelivered for a few seconds
// (meaning the agent isn't inside wait_for_feedback / resolve_annotation), this plugin
// sends a short message to the newest session in the project. delivery: "queue" means
// it's delivered as soon as the agent finishes its current turn, so it never interrupts.
import { readFileSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let define = (p) => p;
try { ({ Plugin: { define } } = await import('@opencode/plugin')); } catch {}

const GRACE_MS = 3000;   // the agent normally picks feedback up within milliseconds
const POLL_MS = 1500;    // a small local file read; costs no tokens

export default define({
  id: 'annotate.push',
  async setup(ctx) {
    const dir = ctx.location?.directory || ctx.location?.project?.directory || process.cwd();
    const file = join(dir, '.annotate', 'queue.json');
    const logFile = join(dir, '.annotate', 'push.log');
    const log = (m) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch {} };
    const nudged = new Set();
    let busy = false, lastErr = '';

    async function newestSession() {
      const res = await ctx.session.list({ directory: dir, order: 'desc', limit: 5 });
      const list = res?.data ?? res?.sessions ?? res?.items ?? res;
      const arr = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : [];
      return arr[0]?.id;
    }

    async function tick() {
      if (busy) return;
      try { statSync(file); } catch { return; }
      let items;
      try { items = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
      const now = Date.now();
      const stale = items.filter((a) => a.status !== 'done' && !a.deliveredAt && !nudged.has(a.id)
        && now - (a.createdAt || now) > GRACE_MS);
      if (!stale.length) return;
      busy = true;
      try {
        const sessionID = await newestSession();
        if (!sessionID) { log('no session to notify'); return; }
        stale.forEach((a) => nudged.add(a.id));
        await ctx.session.prompt({
          sessionID,
          delivery: 'queue',
          text: `[Annotate] ${stale.length} new annotation(s) from the browser. ` +
            'Call annotate wait_for_feedback now, apply them, then call resolve_annotation (it waits for the next round). ' +
            'Keep looping; do not end your turn while the user is annotating.',
        });
        lastErr = '';
        log(`notified ${sessionID} about ${stale.map((a) => a.id).join(',')}`);
      } catch (e) {
        stale.forEach((a) => nudged.delete(a.id));
        const msg = String(e?.message || e).split('\n')[0];
        if (msg !== lastErr) log(`notify failed: ${msg}`); // log each distinct error once
        lastErr = msg;
      } finally { busy = false; }
    }

    const timer = setInterval(tick, POLL_MS);
    timer.unref?.();
    log(`plugin loaded for ${dir}`);
    return () => clearInterval(timer);
  },
});
