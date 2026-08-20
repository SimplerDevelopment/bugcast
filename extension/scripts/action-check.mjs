import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = '/Users/dancoyle/src/bugcast/extension/dist';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-')), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
console.log('service worker:', sw.url().endsWith('.js') ? 'loaded ok' : sw.url());
const info = await sw.evaluate(async () => ({
  popup: await chrome.action.getPopup({}),
  title: await chrome.action.getTitle({}),
  manifestPopup: chrome.runtime.getManifest().action?.default_popup,
  icons: Object.keys(chrome.runtime.getManifest().icons ?? {}),
  commands: Object.keys(chrome.runtime.getManifest().commands ?? {}),
  csp: chrome.runtime.getManifest().content_security_policy,
  iconFetch: await fetch(chrome.runtime.getURL('icons/16.png')).then((r) => r.status, (e) => e.message),
}));
console.log(JSON.stringify(info, null, 2));
// Does the registered popup URL actually resolve?
const res = await sw.evaluate((u) => fetch(u).then((r) => `${r.status}`, (e) => `ERR ${e.message}`),
  info.popup);
console.log('popup fetch:', res);
await ctx.close();
