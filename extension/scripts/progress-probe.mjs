// Does progress actually reach storage during a real model download?
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = '/Users/dancoyle/src/bugcast/extension/dist';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-')), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const id = new URL(sw.url()).host;
await sw.evaluate(() => chrome.storage.local.set({ modelTier: 'tiny.en' }));
const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/src/popup/index.html`);
// Detached: the probe watches storage rather than awaiting the check, and
// closing the context mid-call would otherwise reject.
page.evaluate((t) => chrome.runtime.sendMessage({ type: t, only: ['asr'] }), 'bugcast/run-self-test').catch(() => {});
const seen = [];
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const p = await sw.evaluate(() => chrome.storage.local.get('modelProgress'));
  const pct = p?.modelProgress?.percent;
  if (pct !== undefined && seen.at(-1) !== pct) seen.push(pct);
  if (seen.length >= 4) break;
}
console.log('progress samples:', seen.join(' -> ') || 'NONE');
await ctx.close();
process.exitCode = seen.length ? 0 : 1;
