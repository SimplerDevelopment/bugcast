/**
 * What does `Debugger.enable` cost the app under test? — the honest harness.
 *
 * `scripts/debugger-cost-probe.mjs` could not answer this, and says so at its
 * own top: Playwright is a CDP client on the page for the life of the context,
 * V8 debug mode is per-isolate and is entered if *any* client enables Debugger,
 * so the control condition was never clean. It reported C measuring *faster*
 * than B, which `Debugger.enable` cannot do.
 *
 * This harness removes the confound by never being a CDP client on the page:
 *
 *   - Chromium is spawned directly with --remote-debugging-port. No Playwright.
 *   - We attach to the **extension's service-worker target only**, and read the
 *     target list without attaching to anything else.
 *   - The page is opened by the extension, via `chrome.tabs.create`.
 *   - Domains are enabled by the extension, via `chrome.debugger` — the same API
 *     a real recording uses.
 *
 * So the only debugger client on that page is the one under test.
 *
 * The benchmark runs through `chrome.scripting.executeScript` in **every**
 * condition, including the one with no debugger attached. That matters: if the
 * benchmark ran through `chrome.debugger`'s own Runtime.evaluate it could not
 * exist in condition A at all, and a measurement method that changes with the
 * condition measures the method.
 *
 * Kept from the first probe because they were the parts that worked: rotation
 * so no condition owns the cold slot, a discarded warm-up round, an IQR overlap
 * verdict rather than bare medians, and partial reporting so a crash at round N
 * does not throw away rounds 1..N-1.
 *
 * MEASURED 2026-08-21, n=25 per condition, rotated, warm-up discarded:
 *
 *   hot    B 278.6ms [269.1-290.3]   C 275.3ms [267.9-295.1]   -1.2% vs B, OVERLAP
 *   churn  B  47.3ms [44.7-52.6]     C  45.6ms [44-52.4]       -3.6% vs B, OVERLAP
 *
 * **No measurable cost.** Unlike the Playwright probe this supersedes, that
 * conclusion means something here: the confound is gone, and the spreads are
 * tight (269-290 against the old 325-399). Both deltas are still faintly
 * negative, which Debugger.enable cannot actually be — so read this as "below
 * this harness's resolution, roughly 3-4% on these workloads", not as a speedup.
 *
 * Attaching today's domains at all (A -> B) costs ~3%, also inside the noise.
 *
 * The harvest is cheap and clean: Debugger.enable returns in ~7ms and replays
 * 40 of 40 module chunks carrying sourceMapURL.
 *
 * WHAT THIS DOES NOT SAY. The workloads are synthetic CPU burners and the page
 * is 40 small modules. A real application — large bundles, heavy DOM, live
 * network — could differ. This clears the domain for use; it does not promise
 * it is free everywhere.
 *
 *   node scripts/debugger-cost-cleanroom.mjs          # 12 rounds
 *   ROUNDS=25 node scripts/debugger-cost-cleanroom.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROUNDS = Number(process.env.ROUNDS ?? 12);

/** Absolute ceiling on the whole run. Belt to the per-request braces. */
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS ?? 15 * 60_000);
const runDeadline = setTimeout(() => {
  console.error(`\nFAIL: run exceeded ${RUN_BUDGET_MS}ms; killing it rather than hanging.`);
  process.exit(1);
}, RUN_BUDGET_MS);
runDeadline.unref();
const CHUNKS = 40;

// Enough distinct scripts that scriptParsed replay is a real cost rather than a
// rounding error, each carrying a sourceMappingURL because harvesting those is
// the entire reason anyone wants this domain.
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/chunk')) {
    const n = req.url.replace(/\D/g, '');
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(`export const f${n} = (x) => x + ${n};\n//# sourceMappingURL=chunk${n}.js.map\n`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    '<!doctype html><title>cleanroom</title>' +
      Array.from({ length: CHUNKS }, (_, i) => `<script type="module" src="/chunk${i}.js"></script>`).join(''),
  );
});
await new Promise((r) => server.listen(0, r));
const PAGE = `http://localhost:${server.address().port}/`;

const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const LOADED = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-clean-ext-'));
fs.cpSync(EXT, LOADED, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(LOADED, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(LOADED, 'manifest.json'), JSON.stringify(manifest, null, 2));

// The extension id comes from the browser, not from arithmetic.
//
// This used to derive it by hashing the absolute path — Chrome's own scheme for
// unpacked extensions, sha256 then a hex→a-p mapping — because nothing better
// was available. It worked, but it is a reimplementation of an internal detail,
// and it only existed because the obvious alternative (take the first
// service_worker target in /json/list) grabs a Chrome *component* extension and
// fails later with `chrome.scripting` undefined, which is a confusing way to
// learn you are inside someone else's extension.
//
// `Extensions.loadUnpacked` returns the id from the real ExtensionRegistry, so
// both the arithmetic and the trap go away. See scripts/tabcapture-probe.mjs,
// where the same command is used.
const EXT_PATH = fs.realpathSync(LOADED);

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-clean-'));
const PORT = 9333 + (process.pid % 500);

// Playwright is used for exactly one thing: the path to a Chromium that exists.
// It never connects.
const child = spawn(chromium.executablePath(), [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  // No --load-extension: Extensions.loadUnpacked installs it below and hands
  // back the id, which is the point.
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`).catch(() => null);
  return res ? res.json() : [];
}

// Install through the protocol, and take the id it returns.
// The endpoint is not up the instant spawn() returns, so wait for it rather
// than racing it — an ECONNREFUSED here reads as "the domain is missing".
let browserInfo = null;
for (let i = 0; i < 40 && !browserInfo; i++) {
  await sleep(500);
  browserInfo = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    .then((r) => r.json())
    .catch(() => null);
}
if (!browserInfo) {
  console.error('FAIL: devtools endpoint never came up');
  child.kill(); server.close(); process.exit(1);
}
const browserWs = new WebSocket(browserInfo.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  browserWs.addEventListener('open', resolve, { once: true });
  browserWs.addEventListener('error', reject, { once: true });
});
const EXT_ID = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Extensions.loadUnpacked timed out')), 20_000);
  browserWs.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== 1) return;
    clearTimeout(timer);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result.id);
  });
  browserWs.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: EXT_PATH } }));
});
browserWs.close();

// Wait for OUR service worker — matched by the id the browser gave us.
// MV3 workers are lazy and suspend when idle, so if it is not there we wake it
// by opening one of the extension's own pages and look again.
let sw = null;
for (let i = 0; i < 40 && !sw; i++) {
  await sleep(500);
  sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  if (!sw && i === 8) {
    await fetch(
      `http://127.0.0.1:${PORT}/json/new?chrome-extension://${EXT_ID}/src/popup/index.html`,
      { method: 'PUT' },
    ).catch(() => {});
  }
}
if (!sw) {
  console.error(`FAIL: no service worker for ${EXT_ID}. Is dist/ built (bun run build)?`);
  console.error('service workers seen:');
  for (const t of await targets()) if (t.type === 'service_worker') console.error(`  ${t.url}`);
  child.kill();
  server.close();
  process.exit(1);
}
console.log(`extension id: ${EXT_ID}`);
console.log(`service worker: ${sw.url}`);
console.log('(this is the ONLY target this harness attaches to)\n');

const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

/**
 * Every request gets a deadline.
 *
 * The first version of this had none, and a CDP reply that never arrived hung
 * the harness for seven and a half hours with three lines of output. A probe
 * that can wedge indefinitely is worse than one that fails: a failure gets
 * looked at, a wedge just looks like work in progress.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 45_000);

let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} did not answer within ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

// A freshly-woken service worker can be sitting paused for a debugger, in which
// case it accepts the connection and then executes nothing — which looks exactly
// like a hang. Runtime.enable plus runIfWaitingForDebugger is the incantation
// that releases it; both are harmless if it was already running.
// Prove the worker executes before asking it to do anything real, so a failure
// names the right cause instead of blaming chrome.tabs.create.
//
// Retried, not asked once. Two separate reasons, and the second only appeared
// after switching to Extensions.loadUnpacked: a freshly-woken worker can sit
// paused for a debugger and execute nothing (which looks exactly like a hang),
// and a freshly *installed* worker can exist as a target before its chrome.*
// bindings are attached. A single check caught the first and flaked on the
// second — `NO (no chrome.tabs)` on one run and `yes` on the next, same code.
let ok = false;
let lastError = null;
for (let attempt = 0; attempt < 20 && !ok; attempt++) {
  await send('Runtime.runIfWaitingForDebugger').catch(() => {});
  await send('Runtime.enable').catch(() => {});
  const alive = await send('Runtime.evaluate', {
    expression: 'typeof chrome?.tabs?.create === "function"',
    returnByValue: true,
  }).catch((e) => ({ error: e.message }));
  ok = alive?.result?.result?.value === true;
  lastError = alive?.error ?? null;
  if (!ok) await sleep(1000);
}
console.log(`worker responsive: ${ok ? 'yes' : `NO (${lastError ?? 'no chrome.tabs after 20s'})`}`);
if (!ok) {
  console.error('FAIL: the worker is attached but not executing, or lacks the tabs API.');
  ws.close(); child.kill(); server.close();
  process.exit(1);
}

/** Run an async expression inside the service worker and return its value. */
async function inWorker(expression) {
  const out = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (out.result?.exceptionDetails) {
    throw new Error(out.result.exceptionDetails.exception?.description ?? 'worker threw');
  }
  return out.result?.result?.value;
}

let tabId;
try {
  tabId = await inWorker(`
    const tab = await chrome.tabs.create({ url: ${JSON.stringify(PAGE)}, active: true });
    await new Promise((r) => setTimeout(r, 2000));
    return tab.id;
  `);
} catch (e) {
  console.error(`FAIL: the service worker never opened the page — ${e.message}`);
  console.error('The worker is attached but not answering. Usually it suspended, or an');
  console.error('earlier run left a Chromium holding this profile. Check for strays:');
  console.error('  pgrep -fl bc-clean-');
  ws.close();
  child.kill();
  server.close();
  process.exit(1);
}
console.log(`page opened by the extension: tab ${tabId}\n`);

const CONDITIONS = [
  ['A', []],
  ['B', ['Network', 'Runtime', 'Log']],
  ['C', ['Network', 'Runtime', 'Log', 'Debugger']],
];

const results = { A: [], B: [], C: [] };
let harvest = null;
let died = null;

try {
  for (let round = -1; round < ROUNDS; round++) {
    const warmup = round < 0;
    process.stderr.write(warmup ? 'warmup: ' : `round ${round + 1}/${ROUNDS}: `);
    const order = CONDITIONS.map((_, i) => CONDITIONS[(i + Math.max(round, 0)) % 3]);

    for (const [label, domains] of order) {
      const out = await inWorker(`
        const tabId = ${tabId};
        // Wait for the load to COMPLETE, not for a guessed interval. A fixed
        // sleep raced the reload and executeScript hit "Frame with ID 0 was
        // removed" — the frame is torn down and rebuilt, and 1200ms only
        // usually beat it.
        await new Promise((resolve) => {
          const onUpdated = (id, info) => {
            if (id !== tabId || info.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
          chrome.tabs.reload(tabId);
          // Backstop: a reload that never reports complete must not wedge the run.
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }, 8000);
        });
        // Modules still need a beat after 'complete' to parse and run.
        await new Promise((r) => setTimeout(r, 300));

        let scripts = 0, withMaps = 0, enableMs = 0;
        const domains = ${JSON.stringify(domains)};
        if (domains.length) {
          const seen = [];
          const onEvent = (src, method, params) => {
            if (method === 'Debugger.scriptParsed') seen.push(params);
          };
          chrome.debugger.onEvent.addListener(onEvent);
          await chrome.debugger.attach({ tabId }, '1.3');
          for (const d of domains) {
            const t = performance.now();
            await chrome.debugger.sendCommand({ tabId }, d + '.enable');
            if (d === 'Debugger') enableMs = performance.now() - t;
          }
          await new Promise((r) => setTimeout(r, 300));
          scripts = seen.length;
          withMaps = seen.filter((s) => s.sourceMapURL).length;
          chrome.debugger.onEvent.removeListener(onEvent);
        }

        // Same measurement method in every condition, including the one with no
        // debugger attached — otherwise the method varies with the condition.
        const [res] = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: () => {
            const hot = () => { let s = 0; for (let i = 0; i < 3e7; i++) s += (i * 2.5) % 7; return s; };
            const churn = () => {
              let n = 0;
              for (let i = 0; i < 2e6; i++) { const o = { a: i, b: String(i), c: [i, i + 1] }; n += o.c[1] - o.a; }
              return n;
            };
            const t0 = performance.now(); hot(); const tHot = performance.now() - t0;
            const t1 = performance.now(); churn(); const tChurn = performance.now() - t1;
            return { hot: +tHot.toFixed(1), churn: +tChurn.toFixed(1) };
          },
        });

        if (domains.length) await chrome.debugger.detach({ tabId }).catch(() => {});
        return { ...res.result, scripts, withMaps, enableMs: +enableMs.toFixed(1) };
      `);

      if (!warmup) results[label].push(out);
      if (label === 'C' && !warmup && !harvest) harvest = out;
      process.stderr.write(`${label}${warmup ? '~' : ''} `);
    }
    process.stderr.write('\n');
  }
} catch (e) {
  died = e?.message ?? String(e);
  process.stderr.write(`\n(stopped early: ${died})\n`);
}

if (died) console.log(`\n⚠️  stopped early after ${results.B.length} complete rounds: ${died}`);

if (!results.B.length) {
  console.log('no complete rounds — nothing to report.');
} else {
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const stat = (l, k) => median(results[l].map((r) => r[k]));
  const iqr = (l, k) => {
    const xs = results[l].map((r) => r[k]).sort((a, b) => a - b);
    const q = (f) => xs[Math.min(xs.length - 1, Math.floor(xs.length * f))];
    return { lo: q(0.25), hi: q(0.75) };
  };
  const overlaps = (k) => {
    const b = iqr('B', k), c = iqr('C', k);
    return b.lo <= c.hi && c.lo <= b.hi;
  };

  console.log(`\nrounds: ${results.B.length} of ${ROUNDS} requested, rotated A/B/C\n`);
  for (const key of ['hot', 'churn']) {
    const a = stat('A', key), b = stat('B', key), c = stat('C', key);
    const pct = (x, base) => `${x > base ? '+' : ''}${(((x - base) / base) * 100).toFixed(1)}%`;
    const r = (l) => { const { lo, hi } = iqr(l, key); return `[${lo}-${hi}]`; };
    console.log(
      `${key.padEnd(6)} A none ${String(a).padStart(7)}ms ${r('A')} | ` +
        `B net+rt+log ${String(b).padStart(7)}ms ${r('B')} (${pct(b, a)}) | ` +
        `C +Debugger ${String(c).padStart(7)}ms ${r('C')} (${pct(c, b)} vs B)`,
    );
    console.log(
      `${''.padEnd(6)} B vs C interquartile ranges ${
        overlaps(key) ? 'OVERLAP -> no measurable difference' : 'are DISJOINT -> a real difference'
      }`,
    );
  }
  console.log('\nC vs B is the number that decides it: B is what ships today.');
  console.log('\nharvest (one-time, at record start):');
  console.log(`  Debugger.enable returned in ${harvest?.enableMs}ms`);
  console.log(`  scriptParsed replayed: ${harvest?.scripts} scripts, ${harvest?.withMaps} with sourceMapURL`);
  console.log(`\nn = ${results.B.length} per condition`);
}

ws.close();
child.kill();
server.close();
