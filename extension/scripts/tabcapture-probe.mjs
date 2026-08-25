/**
 * Can a CDP toolbar click grant activeTab — and unblock tabCapture?
 *
 * `AGENTS.md` records `chrome.tabCapture.getMediaStreamId` as needing "an
 * activeTab grant that only a real toolbar-icon click produces. Host
 * permissions do not substitute." That is why the smoke drives `buildPipeline`
 * with a synthetic canvas+oscillator stream instead of the real entry point —
 * the one substitution in the harness that skips production code.
 *
 * Chrome now ships a first-party CDP `Extensions` domain, and
 * `Extensions.triggerAction` routes through Chromium's genuine user-action
 * path. In `extension_action_view_model.cc`, verbatim:
 *
 *     // This method is only called to execute an action by the user, so we can
 *     // always grant tab permissions.
 *     constexpr bool kGrantTabPermissions = true;
 *
 * If that reaches ActiveTabPermissionGranter, a protocol-level click is a real
 * click as far as `activeTab` is concerned, and the substitution can go.
 *
 * The docs say nothing about this. Only the source implies it. So: measure.
 *
 * THE CONTROL IS THE POINT. getMediaStreamId is called BEFORE triggerAction and
 * must FAIL. Without that, a success afterwards proves nothing — it could mean
 * the grant was never needed in this configuration. A probe whose control
 * passes has not tested its hypothesis.
 *
 *   node scripts/tabcapture-probe.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error('FAIL: dist/ is not built. Run `bun run build` first.');
  process.exit(1);
}

// A real http origin: chrome:// and about:blank cannot be captured, so a
// failure there would be about the page, not about the grant.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>capture target</title><h1>capture me</h1>');
});
await new Promise((r) => server.listen(0, r));
const PAGE = `http://localhost:${server.address().port}/`;

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tabcap-'));
const PORT = 9500 + (process.pid % 400);

// Deliberately NOT --load-extension: installing through Extensions.loadUnpacked
// is half of what this probe is testing, and it returns the real extension id
// from ExtensionRegistry rather than making us derive it from the path.
const child = spawn(chromium.executablePath(), [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  PAGE,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => {
  child.kill('SIGKILL');
  server.close();
  // Chromium keeps writing to its profile for a moment after SIGKILL, so a
  // synchronous rm races it and throws ENOTEMPTY — which would bury the result
  // this probe exists to print. A leftover temp dir is not worth that.
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    // The OS will reap it.
  }
  process.exit(code);
};

async function endpoint() {
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch {}
  }
  return null;
}

const version = await endpoint();
if (!version) {
  console.error('FAIL: devtools endpoint never came up');
  done(1);
}
console.log(`browser: ${version.Browser}`);

/** One CDP connection, with a deadline on every request so a wedge cannot hang. */
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
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
        reject(new Error(`${method} timed out`));
      }, 12_000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

const browser = connect(version.webSocketDebuggerUrl);
await browser.ready;

// --- Step 1: install through the protocol -----------------------------------
const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
if (loaded.error) {
  console.error(`FAIL: Extensions.loadUnpacked -> ${loaded.error.message}`);
  console.error('That is itself the finding: the domain exists but is gated on this channel.');
  done(1);
}
const extensionId = loaded.result.id;
console.log(`Extensions.loadUnpacked -> ${extensionId}`);
console.log('  (no sha256(path) derivation, no guessing which service_worker is ours)');

// --- Step 2: reach our service worker ---------------------------------------
await sleep(1500);
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const swTarget = targets.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
const pageTarget = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'));
if (!swTarget || !pageTarget) {
  console.error(`FAIL: missing target (sw=${Boolean(swTarget)} page=${Boolean(pageTarget)})`);
  done(1);
}

const sw = connect(swTarget.webSocketDebuggerUrl);
await sw.ready;

// A freshly installed MV3 worker sits paused for a debugger and executes
// nothing — indistinguishable from a hang, and a single runIfWaitingForDebugger
// is not always enough because the pause can arrive after we send it. So:
// release, then PROVE it executes before trusting anything it says.
let responsive = false;
for (let attempt = 0; attempt < 6 && !responsive; attempt++) {
  await sw.send('Runtime.runIfWaitingForDebugger').catch(() => {});
  await sw.send('Runtime.enable').catch(() => {});
  const alive = await sw
    .send('Runtime.evaluate', {
      expression: 'typeof chrome?.tabCapture?.getMediaStreamId === "function"',
      returnByValue: true,
      timeout: 2000,
    })
    .catch(() => null);
  responsive = alive?.result?.result?.value === true;
  if (!responsive) await sleep(700);
}
if (!responsive) {
  console.error('FAIL: the service worker never executed, or has no tabCapture API');
  done(1);
}
console.log('service worker responsive');

const inWorker = async (expression) => {
  const out = await sw.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  // An undefined return read as "refused" in the first version of this probe,
  // which is the same class of mistake as a control that passes: absence of a
  // result is not evidence of a refusal.
  const thrown = out.result?.exceptionDetails;
  if (thrown) throw new Error(thrown.exception?.description ?? thrown.text ?? 'worker threw');
  if (!('value' in (out.result?.result ?? {}))) {
    throw new Error(`worker returned nothing (${JSON.stringify(out.result?.result ?? null)})`);
  }
  return out.result.result.value;
};

// NOT a url-filtered query: bugcast has no `tabs` permission and no host
// permissions, so `chrome.tabs.query({url})` matches nothing — AGENTS.md records
// exactly this ("tab.url is not readable in the worker without the broad tabs
// permission"). The active tab is what start() uses, and tab.id is always
// readable.
const tabId = await inWorker(`
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
`);
if (tabId == null) {
  console.error('FAIL: the worker could not see the target tab');
  done(1);
}

const tryCapture = () => inWorker(`
  return await new Promise((resolve) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: ${tabId} }, (id) => {
      resolve({ id: id ?? null, error: chrome.runtime.lastError?.message ?? null });
    });
  });
`);

// --- Step 3: the control. This MUST fail. -----------------------------------
let before;
try {
  before = await tryCapture();
} catch (e) {
  console.error(`\nFAIL: the control could not even run — ${e.message}`);
  done(1);
}
console.log(`\nbefore triggerAction: ${before.id ? `streamId ${before.id}` : `refused — ${before.error ?? 'no id, no error'}`}`);
if (before.id) {
  console.error('\nFAIL: the control succeeded, so this probe proves nothing about activeTab.');
  console.error('tabCapture worked without any grant — the hypothesis was never tested.');
  done(1);
}

// --- Step 4: the protocol-level toolbar click -------------------------------
// `Action can only be triggered on a tab target.` — tab targets are a distinct
// type from page targets and do not appear in /json/list at all, so they have to
// come from Target.getTargets with an explicit filter.
const tabs = await browser.send('Target.getTargets', { filter: [{ type: 'tab' }] });
const tabTarget = (tabs.result?.targetInfos ?? []).find((t) => t.url.startsWith('http://localhost'));
if (!tabTarget) {
  console.error('FAIL: no tab target for the page under test');
  console.error('  saw:', JSON.stringify((tabs.result?.targetInfos ?? []).map((t) => `${t.type} ${t.url}`)));
  done(1);
}
const clicked = await browser.send('Extensions.triggerAction', {
  id: extensionId,
  targetId: tabTarget.targetId,
});
if (clicked.error) {
  console.error(`\nExtensions.triggerAction -> ${clicked.error.message}`);
  console.log('So a CDP click is not available here; the synthetic-stream substitution stays.');
  done(1);
}
console.log('Extensions.triggerAction -> ok');

await sleep(800);
const after = await tryCapture().catch((e) => ({ id: null, error: e.message }));
console.log(`after  triggerAction: ${after.id ? `streamId ${after.id}` : `refused — ${after.error ?? 'no id, no error'}`}`);

console.log('');
if (after.id) {
  console.log('RESULT: a CDP toolbar click DOES confer activeTab.');
  console.log('tabCapture is automatable. The synthetic canvas+oscillator stream can retire,');
  console.log('and the smoke can drive the real capture entry point end to end.');
} else {
  console.log('RESULT: it does not. kGrantTabPermissions did not reach this path here,');
  console.log('so AGENTS.md stands and the synthetic stream keeps earning its place.');
}
done(after.id ? 0 : 2);
