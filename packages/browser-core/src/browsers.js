// Pick which browser to drive. CDP works with Chromium-family browsers only
// (Chrome, Edge, Brave, Chromium, Vivaldi, Opera). Anything else -> bundled Chromium.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { return ''; } };
const which = (...names) => { for (const n of names) { const p = sh(process.platform === 'win32' ? 'where' : 'which', [n]).split(/\r?\n/)[0]; if (p) return p; } return ''; };
const firstExisting = (...paths) => paths.find((p) => p && existsSync(p)) || '';

function find(name) {
  const win = process.platform === 'win32', mac = process.platform === 'darwin';
  const L = process.env.LOCALAPPDATA, P = process.env.PROGRAMFILES, P86 = process.env['PROGRAMFILES(X86)'];
  switch (name) {
    case 'chrome': return { channel: 'chrome' };          // Playwright knows Chrome's path on every OS
    case 'msedge': return { channel: 'msedge' };
    case 'brave': return { executablePath: win
      ? firstExisting(L && join(L, 'BraveSoftware/Brave-Browser/Application/brave.exe'), P && join(P, 'BraveSoftware/Brave-Browser/Application/brave.exe'))
      : mac ? firstExisting('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser') : which('brave-browser', 'brave') };
    case 'vivaldi': return { executablePath: win ? firstExisting(L && join(L, 'Vivaldi/Application/vivaldi.exe')) : which('vivaldi', 'vivaldi-stable') };
    case 'chromium': return { executablePath: win ? '' : which('chromium', 'chromium-browser') };
    case 'opera': return { executablePath: win ? firstExisting(L && join(L, 'Programs/Opera/opera.exe')) : which('opera') };
    default: return null;
  }
}

/** Name of the OS default browser, normalized: chrome | msedge | brave | vivaldi | chromium | opera | firefox | safari | '' */
export function defaultBrowser() {
  let id = '';
  if (process.platform === 'linux') id = sh('xdg-settings', ['get', 'default-web-browser']);
  else if (process.platform === 'win32') id = sh('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']);
  else if (process.platform === 'darwin') id = sh('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers']).match(/LSHandlerRoleAll = "([^"]+)";\s*LSHandlerURLScheme = https/)?.[1] || '';
  id = id.toLowerCase();
  for (const [re, n] of [[/edge|msedgehtm/, 'msedge'], [/brave/, 'brave'], [/vivaldi/, 'vivaldi'], [/opera/, 'opera'],
    [/chromium/, 'chromium'], [/chrome/, 'chrome'], [/firefox/, 'firefox'], [/safari/, 'safari']]) if (re.test(id)) return n;
  return '';
}

/**
 * BROWSER_CORE_BROWSER = default (auto) | bundled | chrome | msedge | brave | vivaldi | chromium | opera | /path/to/exe
 * Returns Playwright launch options plus a label.
 */
export function chooseBrowser(pref = process.env.BROWSER_CORE_BROWSER || 'default') {
  if (pref === 'bundled') return { label: 'bundled chromium', opts: {} };
  if (/[\\/]/.test(pref)) return { label: pref, opts: { executablePath: pref } };
  const name = pref === 'default' ? defaultBrowser() : pref;
  const opts = find(name);
  if (opts && (opts.channel || opts.executablePath)) return { label: name, opts };
  return { label: `bundled chromium (default browser "${name || 'unknown'}" has no CDP support)`, opts: {} };
}
