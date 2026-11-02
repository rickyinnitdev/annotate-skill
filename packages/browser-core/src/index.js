// browser-core client: find or start the shared browser daemon, connect to it,
// and use its take_control / resume_agent lock. Works the same on Linux and Windows.
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const stateDir = () => process.env.BROWSER_CORE_HOME || join(homedir(), '.browser-core');
const stateFile = () => join(stateDir(), 'session.json');
const DAEMON = join(dirname(fileURLToPath(import.meta.url)), 'daemon.js');

function readState() {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { return null; }
}

async function api(state, path, body) {
  const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-browser-core-token': state.token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`browser-core ${path}: HTTP ${res.status}`);
  return res.json();
}

async function alive(state) {
  if (!state) return false;
  try { return (await api(state, '/status')).ok === true; } catch { return false; }
}

/** Returns a live session ({port, token, cdpUrl}), starting the daemon if needed. */
export async function ensureSession({ headless = process.env.BROWSER_CORE_HEADLESS === '1', timeoutMs = 30000 } = {}) {
  let state = readState();
  if (await alive(state)) return state;
  mkdirSync(stateDir(), { recursive: true });
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, BROWSER_CORE_HEADLESS: headless ? '1' : '' },
  });
  child.unref();
  const started = Date.now();
  const prev = state?.token;
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    state = readState();
    if (state && state.token !== prev && (await alive(state))) return state;
  }
  throw new Error(`browser-core daemon did not start within ${timeoutMs}ms. ` +
    `Run "npx playwright install chromium" and check ${join(stateDir(), 'daemon.log')}`);
}

/** Connects Playwright to the shared browser. Returns { browser, context, session }. */
export async function connect(opts) {
  const session = await ensureSession(opts);
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(session.cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return { browser, context, session };
}

export const getLock = (s) => api(s, '/lock');
/** The human takes the browser; agents should pause input. */
export const takeControl = (s, who = 'human') => api(s, '/lock', { holder: who });
/** Hand the browser back to the agent. */
export const resumeAgent = (s) => api(s, '/lock', { holder: 'agent' });
export const shutdown = (s) => api(s, '/shutdown', {});
