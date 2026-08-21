// How expensive is one append as the file grows? The answer decides whether
// events can flush every 200ms or must stay batched.
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const EXT = '/Users/dancoyle/src/bugcast/extension/dist';
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-')), {
  headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/src/popup/index.html`);

const out = await page.evaluate(async () => {
  const dir = await navigator.storage.getDirectory();
  const file = await dir.getFileHandle('probe.ndjson', { create: true });
  await (await file.createWritable()).close();

  const line = JSON.stringify({ t: 0, type: 'click', pad: 'x'.repeat(200) }) + '\n';
  const batch = line.repeat(10); // a couple of seconds of busy capture
  const samples = [];
  let bytes = 0;

  for (let i = 0; i < 300; i++) {
    const started = performance.now();
    const w = await file.createWritable({ keepExistingData: true });
    await w.seek(bytes);
    await w.write(batch);
    await w.close();
    bytes += batch.length;
    const ms = performance.now() - started;
    if (i % 60 === 0 || i === 299) samples.push({ kb: Math.round(bytes / 1024), ms: +ms.toFixed(1) });
  }
  return samples;
});
console.log('append cost as the file grows:');
for (const s of out) console.log(`  ${String(s.kb).padStart(5)} KB -> ${s.ms} ms`);
await ctx.close();
