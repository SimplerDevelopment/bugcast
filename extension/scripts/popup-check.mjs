import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = '/Users/dancoyle/src/bugcast/extension/dist';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-popup-'));
const ctx = await chromium.launchPersistentContext(dir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[PAGE ERROR]', e.message));
page.on('requestfailed', (r) => console.log('[REQ FAILED]', r.url(), r.failure()?.errorText));

await page.goto(`chrome-extension://${id}/src/popup/index.html`);
await page.waitForTimeout(2500);

const html = await page.evaluate(() => document.getElementById('root')?.innerHTML ?? '(no #root)');
console.log('\n=== popup ===');
console.log(html.slice(0, 300) || '(EMPTY)');

// The options page is a separate entry point and a separate way to break.
const options = await ctx.newPage();
options.on('pageerror', (e) => console.log('[OPTIONS ERROR]', e.message));
await options.goto(`chrome-extension://${id}/src/options/index.html`);
await options.waitForTimeout(1500);
const sections = await options.evaluate(() =>
  [...document.querySelectorAll('h2')].map((h) => h.textContent),
);
console.log('\n=== options sections ===');
console.log(sections.join(' · ') || '(EMPTY)');
if (sections.length < 5) {
  console.error('FAIL: options page did not render its sections');
  process.exitCode = 1;
}
console.log('\nbody size:', JSON.stringify(await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }))));
await ctx.close();
