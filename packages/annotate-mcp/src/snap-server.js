// Tiny local HTTP server for the App page (snapshot any window, draw, comment).
// Only three fixed files are served; the page itself needs the per-process token.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const FILES = {
  '/snap': ['snap.html', 'text/html; charset=utf-8'],
  '/snap.js': ['snap.js', 'text/javascript; charset=utf-8'],
  '/draw.js': ['draw.js', 'text/javascript; charset=utf-8'],
};

/** Starts the server on 127.0.0.1:<free port>. Returns { origin, url, close }. */
export function startSnapServer({ token }) {
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const f = FILES[u.pathname];
    if (!f || req.method !== 'GET') { res.writeHead(404); return res.end('not found'); }
    if (u.pathname === '/snap' && u.searchParams.get('t') !== token) { res.writeHead(403); return res.end('forbidden'); }
    try {
      res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' });
      res.end(readFileSync(join(SRC, f[0])));
    } catch { res.writeHead(500); res.end(); }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ origin, url: `${origin}/snap?t=${token}`, close: () => server.close() });
    });
  });
}
