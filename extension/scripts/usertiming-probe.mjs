// Can an ISOLATED-world content script read a mark the MAIN world created?
//
// This is the load-bearing unknown in ticket 17. The whole app-meta extension
// point rests on it: if an isolated world sees main-world `performance.mark`
// entries *with their `detail` intact*, a developer annotates a session with
// three lines of standard platform code and Bugcast needs no page-side API at
// all. If it does not, the bridge needs a CDP `Runtime.evaluate` shim.
//
// Faithful by construction: it uses `chrome.scripting.executeScript` with the
// default world, which is exactly the call `injectInteractionCapture` makes at
// record time — not `Page.createIsolatedWorld`, which is the same Blink
// primitive but not the same code path.
//
// Four questions, because "can it read them" hides three others that each kill
// the design on their own:
//   1. Does the isolated world see marks at all?
//   2. Does `detail` survive, or arrive as undefined? (It is StructuredSerialized
//      on write and StructuredDeserialized on read; worlds are the untested part.)
//   3. Does a PerformanceObserver registered in the isolated world receive marks
//      created afterwards in the main world?
//   4. Does `buffered: true` replay marks created *before* it registered? This
//      is the one that matters most — a content script is injected at record
//      time, and the app's build SHA was marked at page load, long before.
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http';

// A real http origin. A data: URL cannot be injected into, which is how the
// first version of the idle probe ended up measuring nothing.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>probe</title><script>
    // The main world, standing in for the application under test. Marked at
    // load, which is the realistic moment: long before anyone presses Record.
    performance.mark('bugcast:session', {
      detail: { buildSha: 'deadbeef', release: '1.4.2', flags: { newEditor: true, beta: ['a','b'] } },
    });
    performance.mark('plain-no-detail');
    window.markLater = (n) => performance.mark(n, { detail: { n } });
  </script>`);
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const EXT = '/Users/dancoyle/src/bugcast/extension/dist';
const LOADED = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ut-ext-'));
fs.cpSync(EXT, LOADED, { recursive: true });
const m = JSON.parse(fs.readFileSync(path.join(LOADED, 'manifest.json'), 'utf8'));
m.host_permissions = ['<all_urls>']; // the per-origin prompt is a native dialog
fs.writeFileSync(path.join(LOADED, 'manifest.json'), JSON.stringify(m, null, 2));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ut-')), {
  headless: false, args: [`--disable-extensions-except=${LOADED}`, `--load-extension=${LOADED}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });

const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/`);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);

// Q1 + Q2 + Q4: read from the isolated world, and register a buffered observer
// in the same pass so it starts *after* the load-time marks already exist.
const read = await sw.evaluate(async (tabId) => {
  const run = (world, func) =>
    chrome.scripting.executeScript({ target: { tabId }, world, func }).then((r) => r[0]?.result);

  const collector = () => {
    const seen = [];
    // buffered:true is the whole question for Q4 — a content script is injected
    // at record time and every interesting mark predates it.
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) seen.push({ name: e.name, detail: e.detail ?? null });
    }).observe({ type: 'mark', buffered: true });
    globalThis.__probeSeen = seen;
    return true;
  };

  const reader = () =>
    performance.getEntriesByType('mark').map((e) => ({
      name: e.name,
      hasDetail: e.detail !== undefined && e.detail !== null,
      detail: e.detail ?? null,
    }));

  return {
    isolatedSync: await run('ISOLATED', reader),
    mainSync: await run('MAIN', reader),
    observerRegistered: await run('ISOLATED', collector),
  };
}, tabId);

// Q3: the main world marks something new, now that the observer is live.
await page.evaluate(() => window.markLater('after-observer'));
await page.waitForTimeout(300);

const observed = await sw.evaluate(
  (tabId) =>
    chrome.scripting
      .executeScript({ target: { tabId }, world: 'ISOLATED', func: () => globalThis.__probeSeen ?? null })
      .then((r) => r[0]?.result),
  tabId,
);

const iso = read.isolatedSync ?? [];
const main = read.mainSync ?? [];
const seen = observed ?? [];
const find = (a, n) => a.find((e) => e.name === n);

const q1 = iso.length > 0;
const q2 = Boolean(find(iso, 'bugcast:session')?.hasDetail);
const q3 = seen.some((e) => e.name === 'after-observer');
const q4 = seen.some((e) => e.name === 'bugcast:session');

console.log('MAIN world sees      :', main.map((e) => e.name).join(', ') || '(none)');
console.log('ISOLATED world sees  :', iso.map((e) => e.name).join(', ') || '(none)');
console.log('observer collected   :', seen.map((e) => e.name).join(', ') || '(none)');
console.log('');
console.log(`Q1 isolated sees marks at all      : ${q1 ? 'YES' : 'NO'}`);
console.log(`Q2 detail survives the world hop   : ${q2 ? 'YES' : 'NO'}`);
if (q2) console.log('   detail =', JSON.stringify(find(iso, 'bugcast:session').detail));
console.log(`Q3 observer gets later main marks  : ${q3 ? 'YES' : 'NO'}`);
console.log(`Q4 buffered:true replays load-time : ${q4 ? 'YES' : 'NO'}`);
console.log('');
console.log(
  q1 && q2 && q3 && q4
    ? 'PASS — the User Timing bridge is free. No page-side API, no CDP shim.'
    : 'PARTIAL/FAIL — see ticket 17; the fallback is a PerformanceObserver installed via CDP Runtime.evaluate.',
);

await ctx.close();
server.close();
