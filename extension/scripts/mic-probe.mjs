// Does getUserMedia work inside a REAL offscreen document? No fake-media flag,
// so this reflects what a user's Chrome actually does.
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = '/Users/dancoyle/src/bugcast/extension/dist';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-')), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });

const out = await sw.evaluate(async () => {
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'probe',
  }).catch(() => {});
  // Ask the real offscreen document, via the same message channel production uses.
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { target: 'offscreen', type: 'bugcast/offscreen-self-test', check: 'mic' },
      (r) => resolve(r ?? { error: chrome.runtime.lastError?.message }),
    );
  });
});
console.log(JSON.stringify(out));
await ctx.close();
