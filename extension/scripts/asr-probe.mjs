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
page.on('pageerror', (e) => console.log('[PAGE ERROR]', e.message));
await page.goto(`chrome-extension://${id}/offscreen.html`);
const res = await page.evaluate(async () => {
  const hooks = globalThis.__bugcastTestHooks;
  if (!hooks?.transformersEngine) return { error: 'hooks missing' };
  // Whatever the extension actually ships, so this probe tracks the real config.
  const candidates = [['shipped default', undefined]];
  const results = [];
  for (const [label, dtype] of candidates) {
    try {
      const engine = dtype ? hooks.transformersEngine('tiny.en', dtype) : hooks.transformersEngine('tiny.en');
      const started = performance.now();
      await engine.transcribe(new Float32Array(16000 * 2), 0);
      results.push(`${label}: OK (${Math.round(performance.now() - started)}ms)`);
    } catch (e) {
      results.push(`${label}: ${String(e?.message ?? e).slice(0, 90)}`);
    }
  }
  return { results };
});
for (const line of res.results ?? [JSON.stringify(res)]) console.log(' ', line);
await ctx.close();
