// What does `Debugger.enable` cost the app under test?
//
// Ticket 17 wants a script index (scriptId -> url, sourceMapURL, buildId) so an
// agent can resolve a minified frame against the developer's checkout. The
// index is free; the domain is not. `Debugger.enable` puts V8 in debug mode,
// which costs optimization and code-cache paths — materially different from
// Network/Runtime/Log, the only domains attached today. No published number was
// found, so this measures it.
//
// ⚠️ MEASURED 2026-08-21, AND IT DID NOT ANSWER THE QUESTION. n=15 per
// condition, rotated, warm-up discarded: C vs B came out at -8.0% (hot) and
// -8.1% (churn) with interquartile ranges that OVERLAP in both — i.e. no
// measurable difference. And the sign is the tell: `Debugger.enable` cannot
// make a page *faster*, so a consistent negative delta means the harness is
// measuring its own noise, or the confound below is real and C adds nothing
// because debug mode was already on. This probe cannot tell those apart.
//
// What it *does* establish: whatever the cost is, it is below this harness's
// resolution — roughly 8% on deliberately JIT-heavy workloads. That is an upper
// bound, not a clearance. Ticket 17's gate stays shut.
//
// To actually settle it, the harness has to stop being a CDP client on the page:
// drive Chromium raw (spawn with --remote-debugging-port), attach ONLY to the
// extension's service-worker target, open the page via chrome.tabs.create, and
// run the benchmark through chrome.debugger's own Runtime.evaluate. Then the
// only debugger client on that page is the one under test.
//
// ⚠️ READ THIS BEFORE TRUSTING A SMALL NUMBER. Playwright is itself a CDP client
// on this target for the life of the context. V8 debug mode is per-isolate and
// is entered if *any* client enables Debugger — so if Playwright has already
// enabled it, conditions A and B are polluted and C's delta collapses to noise.
// A near-zero result here is therefore INCONCLUSIVE, not a green light. The
// positive control below (scriptParsed replay count) proves only that *our*
// enable took effect, not that nobody beat us to it. Same class of confound as
// scripts/idle-probe.mjs, and worth the same suspicion.
//
// Ordering bias is the trap here, and it already caught this probe once. Run
// A,B,C in that order every round and A pays every cold-start cost while C runs
// warmest — the first version measured exactly that and reported attaching MORE
// domains making the page 7-33% FASTER, which is not a result, it is a warm-up
// curve. Conditions therefore ROTATE (round r starts at r % 3) and a full
// warm-up round is discarded before anything is recorded.
//
// Three conditions:
//   A  nothing attached                          (floor)
//   B  Network + Runtime + Log                   (Bugcast today)
//   C  Network + Runtime + Log + Debugger        (Bugcast with source maps)
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http';

const ROUNDS = Number(process.env.ROUNDS ?? 3);

// A JIT-sensitive workload. A tight monomorphic numeric loop is what TurboFan
// optimizes hardest and therefore what loses most when it cannot — if debug
// mode costs anything, it shows here. The object churn is a second shape,
// because a single benchmark measuring one thing is how you conclude "free".
const BENCH = `
  window.__bench = () => {
    const hot = () => { let s = 0; for (let i = 0; i < 3e7; i++) s += (i * 2.5) % 7; return s; };
    const churn = () => {
      let n = 0;
      for (let i = 0; i < 2e6; i++) { const o = { a: i, b: String(i), c: [i, i + 1] }; n += o.c[1] - o.a; }
      return n;
    };
    const t0 = performance.now(); hot(); const tHot = performance.now() - t0;
    const t1 = performance.now(); churn(); const tChurn = performance.now() - t1;
    return { hot: +tHot.toFixed(1), churn: +tChurn.toFixed(1) };
  };
`;

// Enough distinct scripts that scriptParsed replay is a real cost, not a rounding
// error — a modern app ships dozens of chunks.
const CHUNKS = 40;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/chunk')) {
    const n = req.url.replace(/\D/g, '');
    res.writeHead(200, { 'content-type': 'application/javascript' });
    // A sourceMappingURL comment, because harvesting it is the entire point.
    res.end(`export const f${n} = (x) => x + ${n};\n//# sourceMappingURL=chunk${n}.js.map\n`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    `<!doctype html><title>bench</title><script>${BENCH}</script>` +
      Array.from({ length: CHUNKS }, (_, i) => `<script type=module src="/chunk${i}.js"></script>`).join(''),
  );
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const EXT = '/Users/dancoyle/src/bugcast/extension/dist';
const LOADED = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dbg-ext-'));
fs.cpSync(EXT, LOADED, { recursive: true });
const m = JSON.parse(fs.readFileSync(path.join(LOADED, 'manifest.json'), 'utf8'));
m.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(LOADED, 'manifest.json'), JSON.stringify(m, null, 2));

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dbg-')), {
  headless: false, args: [`--disable-extensions-except=${LOADED}`, `--load-extension=${LOADED}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });

const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/`);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);

// MV3 suspends an idle worker at ~30s, and this probe idles between rounds by
// construction. A dead worker makes `sw.evaluate` hang rather than throw, which
// is how the first run of this probe timed out at two minutes with no output.
const worker = async () => {
  if (sw && !sw.isClosed?.()) return sw;
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  return sw;
};
const wake = setInterval(() => { void worker().then((w) => w.evaluate(() => chrome.runtime.id).catch(() => {})); }, 10_000);

const attach = (domains) =>
  sw.evaluate(async ({ tabId, domains }) => {
    globalThis.__scripts = [];
    globalThis.__onEvent ??= (src, method, params) => {
      if (method === 'Debugger.scriptParsed') globalThis.__scripts.push(params);
    };
    chrome.debugger.onEvent.removeListener(globalThis.__onEvent);
    chrome.debugger.onEvent.addListener(globalThis.__onEvent);
    await chrome.debugger.attach({ tabId }, '1.3');
    const timings = {};
    for (const d of domains) {
      const t = performance.now();
      await chrome.debugger.sendCommand({ tabId }, `${d}.enable`);
      timings[d] = +(performance.now() - t).toFixed(1);
    }
    // scriptParsed replays asynchronously after enable resolves.
    await new Promise((r) => setTimeout(r, 250));
    return { timings, scriptsSeen: globalThis.__scripts.length,
             withMaps: globalThis.__scripts.filter((s) => s.sourceMapURL).length };
  }, { tabId, domains });

const detach = () =>
  sw.evaluate((tabId) => chrome.debugger.detach({ tabId }).catch(() => {}), tabId);

const results = { A: [], B: [], C: [] };
let harvest = null;

const CONDITIONS = [
  ['A', []],
  ['B', ['Network', 'Runtime', 'Log']],
  ['C', ['Network', 'Runtime', 'Log', 'Debugger']],
];

// A long run kills the browser sometimes — repeated attach/detach across dozens
// of navigations is not a load Chromium is asked to carry often. Rounds are
// therefore wrapped: a crash reports what it already has instead of discarding
// it, which is how a 25-round run once threw away 11 good rounds at round 12.
let died = null;
try {
// Round -1 is thrown away: the first measurement of the process is always the
// slowest and it must not land on whichever condition happens to go first.
for (let round = -1; round < ROUNDS; round++) {
  const warmup = round < 0;
  process.stderr.write(warmup ? 'warmup: ' : `round ${round + 1}/${ROUNDS}: `);
  // Rotate, so each condition takes every slot across the run.
  const order = CONDITIONS.map((_, i) => CONDITIONS[(i + Math.max(round, 0)) % 3]);
  for (const [label, domains] of order) {
    // Fresh load every time, so JIT state starts equal and the attach happens
    // against the same page shape a real recording would attach to.
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForTimeout(120);
    let info = null;
    if (domains.length) info = await attach(domains);
    if (label === 'C' && !warmup && !harvest) harvest = info;
    const out = await page.evaluate(() => window.__bench());
    if (!warmup) results[label].push(out);
    if (domains.length) await detach();
    process.stderr.write(`${label}${warmup ? '~' : ''} `);
    await page.waitForTimeout(80);
  }
  process.stderr.write('\n');
}
} catch (e) {
  died = e?.message ?? String(e);
  process.stderr.write(`\n(stopped early: ${died})\n`);
}
clearInterval(wake);
if (!results.B.length) {
  console.log('no complete rounds — nothing to report.');
} else {
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const stat = (label, key) => median(results[label].map((r) => r[key]));
// IQR, not min-max: one scheduler hiccup blows out a range and makes every
// comparison look like noise even when it is not.
const iqr = (label, key) => {
  const xs = results[label].map((r) => r[key]).sort((a, b) => a - b);
  const q = (f) => xs[Math.min(xs.length - 1, Math.floor(xs.length * f))];
  return { lo: q(0.25), hi: q(0.75) };
};
const spread = (label, key) => { const { lo, hi } = iqr(label, key); return `${lo}-${hi}`; };
const overlaps = (key) => {
  const b = iqr('B', key), c = iqr('C', key);
  return b.lo <= c.hi && c.lo <= b.hi;
};

if (died) console.log(`⚠️  stopped early after ${results.B.length} complete rounds: ${died}\n`);
console.log(`rounds: ${results.B.length} of ${ROUNDS} requested, rotated A/B/C\n`);
for (const key of ['hot', 'churn']) {
  const a = stat('A', key), b = stat('B', key), c = stat('C', key);
  const pct = (x, base) => `${x > base ? '+' : ''}${(((x - base) / base) * 100).toFixed(1)}%`;
  console.log(`${key.padEnd(6)} A none ${String(a).padStart(7)}ms [${spread('A', key)}] | B net+rt+log ${String(b).padStart(7)}ms [${spread('B', key)}] (${pct(b, a)}) | C +Debugger ${String(c).padStart(7)}ms [${spread('C', key)}] (${pct(c, a)} vs A, ${pct(c, b)} vs B)`);
  console.log(`${''.padEnd(6)} B vs C interquartile ranges ${overlaps(key) ? 'OVERLAP -> no measurable difference' : 'are DISJOINT -> a real difference'}`);
}
console.log('\nthe number that decides it: C vs B, because B is what ships today.');
console.log('\nharvest (one-time, at record start):');
console.log(`  Debugger.enable returned in ${harvest?.timings?.Debugger}ms`);
console.log(`  scriptParsed replayed: ${harvest?.scriptsSeen} scripts, ${harvest?.withMaps} carrying sourceMapURL`);
console.log('\nif C vs B is ~0%, or the IQRs overlap, re-read the warning at the top of this file.');
console.log(`n = ${results.B.length} per condition`);
}

await ctx.close();
server.close();
