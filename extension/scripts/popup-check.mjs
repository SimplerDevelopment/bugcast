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
console.log('\n=== rendered ===');
console.log(html.slice(0, 500) || '(EMPTY)');
console.log('\nbody size:', JSON.stringify(await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }))));
await ctx.close();
