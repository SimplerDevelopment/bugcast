// Does a recording survive an idle gap longer than MV3's ~30s worker timeout?
// The scripted smoke never idles, which is why this class of bug reached a user.
//
// ⚠️ IT DOES NOT ANSWER THAT QUESTION. Measured 2026-08-20: delete keepAwake()
// from the built bundle entirely and this still prints PASS. Chrome does not
// terminate a service worker that is being inspected, and Playwright is
// CDP-attached to the worker target for the life of the context — so the thing
// the probe exists to detect cannot happen while the probe is watching. The
// open extension page below is a second confound of the same kind.
//
// So: a PASS here means nothing, and a FAIL is still worth reading. Do not add
// it to a gate, and do not let it stand in for evidence from a real session.
// Making it honest needs a way to terminate the worker deliberately (CDP
// Target.closeTarget / chrome.runtime.reload) and to assert on what the user is
// told afterwards — the "worker restarted mid-session" path — rather than
// waiting on an idle timer that a debugger is holding off.
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http';

// A real http origin: a data: URL cannot be debugged or injected into, so the
// first version of this probe recorded nothing and looked like a product bug.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><button id=b>click</button>');
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;
const EXT = '/Users/dancoyle/src/bugcast/extension/dist';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-idle-'));
// Host permission, as the main smoke does: interaction capture needs
// executeScript, and the per-origin prompt is a native dialog.
const manifestPath = path.join(EXT, 'manifest.json');
const LOADED = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-idle-ext-'));
fs.cpSync(EXT, LOADED, { recursive: true });
const m = JSON.parse(fs.readFileSync(path.join(LOADED, 'manifest.json'), 'utf8'));
m.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(LOADED, 'manifest.json'), JSON.stringify(m, null, 2));

const ctx = await chromium.launchPersistentContext(dir, {
  headless: false, args: [`--disable-extensions-except=${LOADED}`, `--load-extension=${LOADED}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
void manifestPath;

const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/`);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);

const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/src/popup/index.html`);
await ext.evaluate(async () => {
  const opfs = await navigator.storage.getDirectory();
  const d = await opfs.getDirectoryHandle('sessions', { create: true });
  await new Promise((res, rej) => {
    const o = indexedDB.open('bugcast', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('handles');
    o.onsuccess = () => { const t = o.result.transaction('handles', 'readwrite');
      t.objectStore('handles').put(d, 'sessionDirectory'); t.oncomplete = res; t.onerror = () => rej(t.error); };
    o.onerror = () => rej(o.error);
  });
});

const started = await ext.evaluate(([t, id, url]) => chrome.runtime.sendMessage({ type: t, tabId: id, pageUrl: url, video: false }),
  ['bugcast/start-recording', tabId, `http://localhost:${PORT}/`]);
console.log('start ->', JSON.stringify(started));
await ext.evaluate(() => new Promise((r) => setTimeout(r, 500)));

await page.bringToFront();
await page.click('#b');
const before = Date.now();

const GAP_MS = 40_000;
console.log(`idling ${GAP_MS / 1000}s (MV3 suspends an idle worker at ~30s)...`);
await page.waitForTimeout(GAP_MS);

// One event after the gap. If the worker was suspended, this is dropped.
await page.click('#b');
await page.waitForTimeout(1500);

const readLines = async () => ext.evaluate(async () => {
  const opfs = await navigator.storage.getDirectory();
  const d = await opfs.getDirectoryHandle('sessions');
  for await (const [, h] of d.entries()) {
    if (h.kind !== 'directory') continue;
    const f = await h.getFileHandle('events.ndjson').catch(() => null);
    if (!f) continue;
    const text = await (await f.getFile()).text();
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l).t);
  }
  return [];
});

// FSA locks the file while a write is in flight, so a read through the same API
// can transiently fail. A real consumer reads through the OS filesystem and
// never sees this.
let lines = [];
for (let i = 0; i < 10; i++) {
  try {
    lines = await readLines();
    break;
  } catch {
    await ext.waitForTimeout(300);
  }
}
const afterGap = lines.filter((t) => t > GAP_MS - 5000);
console.log(`events: ${lines.length} total, ${afterGap.length} after the idle gap`);
console.log(afterGap.length ? 'PASS — the session survived the gap' : 'FAIL — events after the gap were lost');
await ctx.close();
server.close();
process.exitCode = afterGap.length ? 0 : 1;
