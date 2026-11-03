// Shared e2e setup: temp project + browser-core home, a tiny site, an MCP client on annotate-mcp.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connect, ensureSession, shutdown } from 'browser-core';

const here = dirname(fileURLToPath(import.meta.url));

export async function startHarness({ html }) {
  const home = mkdtempSync(join(tmpdir(), 'bc-'));
  const project = mkdtempSync(join(tmpdir(), 'proj-'));
  mkdirSync(join(project, 'src/styles'), { recursive: true });
  writeFileSync(join(project, 'src/styles/global.css'), '.card { color: red }\n');
  process.env.BROWSER_CORE_HOME = home;
  process.env.BROWSER_CORE_HEADLESS = '1';
  const site = createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(typeof html === 'function' ? html(project) : html); }).listen(0);
  const url = `http://127.0.0.1:${site.address().port}/`;
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(here, '../src/server.js')],
    env: { ...process.env, ANNOTATE_PROJECT_DIR: project }, stderr: 'inherit',
  }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    return { json: JSON.parse(r.content[0].text), images: r.content.filter((c) => c.type === 'image') };
  };
  let human = null;
  return {
    project, url, call, client,
    async human() { if (!human) human = await connect(); return human; },
    async close() {
      await human?.browser.close().catch(() => {});
      await client.close().catch(() => {});
      await shutdown(await ensureSession()).catch(() => {});
      site.close();
    },
  };
}

/** Width/height of a baseline JPEG file buffer. */
export function jpegSize(buf) {
  for (let i = 2; i < buf.length;) {
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
