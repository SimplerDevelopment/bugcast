// Reloading the extension leaves content scripts running in open pages with a
// dead context. Every chrome.* call then throws SYNCHRONOUSLY, and an unguarded
// one lands in the page's console — which this tool is supposed to be recording,
// not polluting.
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http';

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><button id=b style="width:200px;height:80px">click</button>');
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const EXT = '/Users/dancoyle/src/bugcast/extension/dist';
const LOADED = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-orphan-ext-'));
fs.cpSync(EXT, LOADED, { recursive: true });
const m = JSON.parse(fs.readFileSync(path.join(LOADED, 'manifest.json'), 'utf8'));
m.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(LOADED, 'manifest.json'), JSON.stringify(m, null, 2));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-orphan-')), {
  headless: false, args: [`--disable-extensions-except=${LOADED}`, `--load-extension=${LOADED}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;

const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`http://localhost:${PORT}/`);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);

const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/src/popup/index.html`);
await ext.evaluate(([t, id, url]) => chrome.runtime.sendMessage({ type: t, tabId: id, pageUrl: url, video: false }),
  ['bugcast/start-recording', tabId, `http://localhost:${PORT}/`]);
await page.bringToFront();
await page.click('#b');
await page.waitForTimeout(400);
console.log(`errors before reload: ${pageErrors.length}`);

// Orphan the content script.
await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
await page.waitForTimeout(2500);

// Interact hard with the now-orphaned script.
for (let i = 0; i < 6; i++) {
  await page.click('#b');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
}
await page.waitForTimeout(600);

console.log(`errors after reload:  ${pageErrors.length}`);
for (const e of pageErrors.slice(0, 3)) console.log('  ' + e);
await ctx.close();
server.close();
process.exitCode = pageErrors.length ? 1 : 0;
