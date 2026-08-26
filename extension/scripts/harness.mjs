/**
 * The parts of a real-browser run that more than one harness needs.
 *
 * Extracted from smoke.mjs when av-sync.mjs arrived and would otherwise have
 * copied a hundred lines of launch-and-grant. The grant in particular took a
 * probe to get right (scripts/tabcapture-probe.mjs) and must not exist twice —
 * a fix that lands in one copy and not the other is exactly the failure this
 * repo keeps finding.
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/**
 * A copy of the build with `<all_urls>` added.
 *
 * Applied to a COPY. An earlier version patched dist/manifest.json in place and
 * never put it back, so the shipped build quietly carried <all_urls> and Chrome
 * warned about it on load. A test must not be able to change the artifact.
 */
export function stageExtension() {
  if (!fs.existsSync(EXT)) {
    console.error(`No build at ${EXT} — run \`bun run build\` first.`);
    process.exit(1);
  }
  const loaded = fs.mkdtempSync(path.join(os.tmpdir(), 'bugcast-ext-'));
  fs.cpSync(EXT, loaded, { recursive: true });
  const manifestPath = path.join(loaded, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return loaded;
}

/**
 * Playwright's bundled Chromium, not `channel: 'chrome'`. The system-Chrome
 * route launches but never registers the MV3 service worker within a sane
 * timeout, and chasing that is not worth a ~150MB download avoided:
 *   bunx playwright install chromium
 * Headed, because the bundled headless shell does not load extensions at all.
 *
 * `extraArgs` is where a caller adds fake-media flags; nothing here presumes
 * them, because the smoke deliberately runs against a real (silent) device.
 */
export async function launchWithExtension({ extraArgs = [], onFail } = {}) {
  const loaded = stageExtension();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugcast-'));
  // A fixed-ish port for the browser-level CDP session used to grant activeTab.
  const cdpPort = 9600 + (process.pid % 300);
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${loaded}`,
        `--load-extension=${loaded}`,
        // Extensions.triggerAction is a browser-domain command and Playwright's
        // CDP sessions are page-scoped, so the browser endpoint has to be
        // reachable separately. Playwright does honour this flag.
        `--remote-debugging-port=${cdpPort}`,
        ...extraArgs,
      ],
    });
  } catch (e) {
    console.error('Could not launch Chromium. Run `bunx playwright install chromium`.');
    console.error(String(e.message).split('\n')[0]);
    onFail?.();
    process.exit(1);
  }

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  return { ctx, sw, extId, cdpPort };
}

/**
 * Grant activeTab the way a toolbar click does.
 *
 * `chrome.tabCapture.getMediaStreamId` needs an activeTab grant, and this used
 * to be the wall the harness could not climb: no automation produces a real
 * toolbar-icon click, so the smoke ran with video disabled and the capture
 * pipeline was exercised separately against a synthetic canvas+oscillator
 * stream. Chrome's `Extensions` domain changes that — `triggerAction` enters
 * Chromium's genuine ExecuteUserAction path, which grants tab permissions
 * unconditionally (`kGrantTabPermissions = true`).
 *
 * Measured before it was relied on: scripts/tabcapture-probe.mjs, with the
 * pre-click call asserted to fail first.
 *
 * Two things the protocol will not forgive:
 *   - it must be a **tab** target, which is a distinct type from a page target
 *     and does not appear in /json/list at all;
 *   - the browser endpoint is a second CDP client, so it stays strictly on
 *     browser-domain commands and never touches the page (see the note in
 *     cdp.ts about chrome.debugger — one client per target).
 */
export function makeGrantActiveTab({ extId, cdpPort, log = console.log }) {
  return async function grantActiveTab(pageUrl) {
    let version = null;
    for (let i = 0; i < 20 && !version; i++) {
      version = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
        .then((r) => r.json())
        .catch(() => null);
      if (!version) await new Promise((r) => setTimeout(r, 250));
    }
    if (!version) return `devtools endpoint never came up on ${cdpPort}`;
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        const timer = setTimeout(() => { pending.delete(n); reject(new Error(`${method} timed out`)); }, 10_000);
        pending.set(n, (m) => { clearTimeout(timer); resolve(m); });
        ws.send(JSON.stringify({ id: n, method, params }));
      });

    try {
      const tabs = await send('Target.getTargets', { filter: [{ type: 'tab' }] });
      const all = tabs.result?.targetInfos ?? [];
      const tab = all.find((t) => t.url.startsWith(pageUrl));
      if (!tab) {
        return `no tab target for ${pageUrl} — saw ${JSON.stringify(all.map((t) => t.url))}`;
      }
      log(`  granting on tab target ${tab.targetId} (${tab.url})`);
      const out = await send('Extensions.triggerAction', { id: extId, targetId: tab.targetId });
      return out.error ? out.error.message : null;
    } finally {
      ws.close();
    }
  };
}
