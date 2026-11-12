// The push plugin delivers each batch to the session that used Annotate, with a fake OpenCode context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import plugin from '../server.js';

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out');
};

function fakeCtx(dir, events = []) {
  const prompts = [], created = [];
  return {
    prompts, created,
    location: { directory: dir },
    event: { subscribe: ({ signal }) => ({ async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
      await new Promise((r) => signal.addEventListener('abort', r));
    } }) },
    session: {
      list: async () => ({ data: [{ id: 'ses_newest' }] }),
      create: async (i) => { created.push(i); return { data: { id: `ses_fresh${created.length}` } }; },
      prompt: async (p) => { prompts.push(p); },
    },
  };
}

function project(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'annotate-push-'));
  mkdirSync(join(dir, '.annotate'));
  if (settings) writeFileSync(join(dir, '.annotate', 'settings.json'), JSON.stringify(settings));
  return dir;
}
const send = (dir, id = 'a1') => writeFileSync(join(dir, '.annotate', 'queue.json'),
  JSON.stringify([{ id, comment: 'make it purple', status: 'pending', createdAt: Date.now() - 5000 }]));
const toolEvent = (sessionID, name) => ({ type: 'session.tool.input.started', data: { sessionID, id: 'c1', name } });

test('batch goes to the session that opened annotate', async () => {
  const dir = project();
  const ctx = fakeCtx(dir, [toolEvent('ses_other', 'bash'), toolEvent('ses_mine', 'annotate.open')]);
  const stop = await plugin.setup(ctx);
  try {
    await until(() => existsSession(dir));
    send(dir);
    const p = await until(() => ctx.prompts[0]);
    assert.equal(p.sessionID, 'ses_mine');
    assert.equal(p.delivery, 'queue');
    assert.equal(ctx.created.length, 0);
    assert.match(readFileSync(join(dir, '.annotate', 'push.log'), 'utf8'), /sent a1 to ses_mine \(annotate session\)/);
  } finally { stop(); }
});

test('remembered session survives a plugin restart', async () => {
  const dir = project();
  writeFileSync(join(dir, '.annotate', 'session.json'), JSON.stringify({ sessionID: 'ses_before' }));
  const ctx = fakeCtx(dir);
  const stop = await plugin.setup(ctx);
  try { send(dir); assert.equal((await until(() => ctx.prompts[0])).sessionID, 'ses_before'); } finally { stop(); }
});

test('falls back to the newest session when annotate was never used', async () => {
  const dir = project();
  const ctx = fakeCtx(dir);
  const stop = await plugin.setup(ctx);
  try { send(dir); assert.equal((await until(() => ctx.prompts[0])).sessionID, 'ses_newest'); } finally { stop(); }
});

test('newSession: true starts a fresh session per batch', async () => {
  const dir = project({ newSession: true });
  const ctx = fakeCtx(dir, [toolEvent('ses_mine', 'annotate.open')]);
  const stop = await plugin.setup(ctx);
  try {
    send(dir);
    assert.equal((await until(() => ctx.prompts[0])).sessionID, 'ses_fresh1');
  } finally { stop(); }
});

function existsSession(dir) {
  try { return JSON.parse(readFileSync(join(dir, '.annotate', 'session.json'), 'utf8')).sessionID === 'ses_mine'; } catch { return false; }
}
