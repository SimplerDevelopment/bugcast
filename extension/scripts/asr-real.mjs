// Runs the ASR self-test the way production does: extension page -> service
// worker -> a REAL offscreen document created by chrome.offscreen.createDocument.
// The distinction matters — a tab navigated to offscreen.html has a different
// API surface, which is what made an earlier probe report the opposite of the
// truth.
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = '/Users/dancoyle/src/bugcast/extension/dist';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-')), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const id = new URL(sw.url()).host;

// Smallest model, so this is a download measured in tens of megabytes.
await sw.evaluate(() => chrome.storage.local.set({ modelTier: 'tiny.en' }));

const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/src/popup/index.html`);
const res = await page.evaluate(
  (type) => chrome.runtime.sendMessage({ type, only: ['asr'] }),
  'bugcast/run-self-test',
);
for (const c of res?.checks ?? []) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label} — ${c.detail} (${Math.round(c.ms / 1000)}s)`);
}
await ctx.close();
process.exitCode = res?.checks?.[0]?.ok ? 0 : 1;
