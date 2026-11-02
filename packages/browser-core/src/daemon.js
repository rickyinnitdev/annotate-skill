// browser-core daemon: owns one visible Chromium (persistent profile), exposes its
// CDP endpoint on 127.0.0.1 and a tiny token-protected HTTP API for the control lock.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync, rmSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';

const DIR = process.env.BROWSER_CORE_HOME || join(homedir(), '.browser-core');
const STATE = join(DIR, 'session.json');
const LOG = join(DIR, 'daemon.log');
mkdirSync(DIR, { recursive: true });
const log = (...a) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {} };

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.unref();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function main() {
  const token = randomBytes(24).toString('hex');
  const cdpPort = await freePort();
  const context = await chromium.launchPersistentContext(join(DIR, 'profile'), {
    headless: process.env.BROWSER_CORE_HEADLESS === '1',
    viewport: null,
    args: [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1', '--no-first-run'],
  });
  let cdpUrl = null;
  for (let i = 0; i < 50 && !cdpUrl; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
      cdpUrl = v.webSocketDebuggerUrl;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!cdpUrl) throw new Error('CDP endpoint never came up');

  let lock = { holder: 'agent', since: Date.now() };
  const cleanup = () => {
    try {
      const s = JSON.parse(readFileSync(STATE, 'utf8'));
      if (s.token === token) rmSync(STATE, { force: true });
    } catch {}
  };
  const quit = async () => { cleanup(); try { await context.close(); } catch {} process.exit(0); };

  const server = createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-browser-core-token'] !== token) return send(401, { error: 'bad token' });
    let body = '';
    for await (const c of req) { body += c; if (body.length > 1e4) return send(413, {}); }
    const data = body ? JSON.parse(body) : {};
    if (req.url === '/status') return send(200, { ok: true, cdpUrl, lock, pid: process.pid });
    if (req.url === '/lock' && req.method === 'GET') return send(200, lock);
    if (req.url === '/lock') {
      if (!['agent', 'human'].includes(data.holder)) return send(400, { error: 'holder must be agent|human' });
      lock = { holder: data.holder, since: Date.now() };
      return send(200, lock);
    }
    if (req.url === '/shutdown') { send(200, { ok: true }); return quit(); }
    send(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    writeFileSync(STATE, JSON.stringify({ pid: process.pid, port, token, cdpUrl }), { mode: 0o600 });
    log('ready', port, cdpUrl);
  });

  // Browser closed by the user -> daemon exits so next ensureSession() relaunches.
  context.on('close', () => { cleanup(); process.exit(0); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, quit);
}

main().catch((e) => { log('fatal', e.stack || e); process.exit(1); });
