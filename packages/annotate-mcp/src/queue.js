// Durable annotation queue. Lives in <project>/.annotate/ so nothing is lost when the
// agent's wait times out, the MCP server restarts, or a new agent session starts.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export class Queue extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = join(dir, 'queue.json');
    mkdirSync(join(dir, 'shots'), { recursive: true });
    try { this.items = JSON.parse(readFileSync(this.file, 'utf8')); } catch { this.items = []; }
    // A new server process re-delivers everything still open.
    this.items = this.items.filter((a) => a.status !== 'done').map(({ deliveredAt, ...a }) => a);
    this.seq = this.items.reduce((m, a) => Math.max(m, Number(a.id.slice(1)) || 0), 0);
    this.delivered = new Set(); // ids handed to the agent by THIS process
  }

  nextId() { return `a${++this.seq}`; }

  addBatch(list) {
    for (const a of list) this.items.push({ ...a, status: 'pending', createdAt: Date.now() });
    this.save();
    this.emit('batch');
  }

  get(id) { return this.items.find((a) => a.id === id); }
  open() { return this.items.filter((a) => a.status !== 'done'); }
  /** Pending annotations not yet given to the agent by this process. */
  undelivered() { return this.open().filter((a) => !this.delivered.has(a.id)); }
  markDelivered(list) {
    // deliveredAt is persisted so the OpenCode push plugin knows the agent already has these.
    for (const a of list) { this.delivered.add(a.id); a.deliveredAt = Date.now(); }
    this.save();
  }

  resolve(ids, note) {
    const done = [];
    for (const id of ids) {
      const a = this.get(id);
      if (a && a.status !== 'done') { a.status = 'done'; a.note = note; done.push(id); this.remember(a); }
    }
    // Finished items are dropped from storage; they never come back in results.
    this.items = this.items.filter((a) => a.status !== 'done');
    this.save();
    return done;
  }

  // Last few resolved annotations; the OpenCode plugin gives these to each fresh session
  // so "undo what you just did" still works.
  remember(a) {
    const file = join(this.dir, 'history.json');
    let h = [];
    try { h = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    h.push({ id: a.id, comment: a.comment.slice(0, 120), selector: a.selector, source: a.source || undefined,
      note: a.note ? a.note.slice(0, 160) : undefined, at: Date.now() });
    writeFileSync(file, JSON.stringify(h.slice(-5)));
  }

  save() { this.flush(); }

  flush() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.items));
    renameSync(tmp, this.file); // atomic on both POSIX and Windows (same volume)
    const lines = ['# Open annotations', '', ...this.open().map((a) =>
      `- [ ] **${a.id}** ${a.url} \`${a.selector}\`${a.source ? ` (${a.source})` : ''}: ${a.comment.replace(/\n/g, ' ')}`)];
    if (lines.length === 2) lines.push('_None. All annotations resolved._');
    writeFileSync(join(this.dir, 'ANNOTATIONS.md'), lines.join('\n') + '\n');
  }
}
