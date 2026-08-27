/**
 * Record a page with bugcast, without touching the browser.
 *
 *   node scripts/record.mjs https://example.com 120
 *   node scripts/record.mjs https://example.com          # until Ctrl+C
 *
 * Attaches to a Chrome you are already running, rather than launching one:
 *
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *     --remote-debugging-port=9222
 *
 * Your own profile means the sessions folder you picked is still granted and
 * the recording lands where your other recordings do. A launched-from-scratch
 * browser gets a fresh profile with no folder, which is why the test harnesses
 * seed an OPFS handle instead — correct for a test, wrong for a real session.
 *
 * The hard part is the activeTab grant. `chrome.tabCapture.getMediaStreamId`
 * needs one and no ordinary automation produces a real toolbar click, so this
 * goes through `Extensions.triggerAction` on the browser endpoint — Chromium's
 * genuine ExecuteUserAction path, which grants tab permissions unconditionally.
 * Two things the protocol will not forgive, both paid for in smoke.mjs: it must
 * be a **tab** target, a distinct type that never appears in /json/list; and
 * the grant lands on the window's ACTIVE web contents, so the page has to be
 * frontmost before it is asked for.
 */

const PORT = Number(process.env.CHROME_CDP_PORT ?? 9222);
const [url, secondsArg] = process.argv.slice(2);
const SECONDS = secondsArg ? Number(secondsArg) : null;

if (!url) {
  console.error('usage: node scripts/record.mjs <url> [seconds]');
  process.exit(1);
}

const version = await fetch(`http://127.0.0.1:${PORT}/json/version`)
  .then((r) => r.json())
  .catch(() => null);
if (!version) {
  console.error(`No Chrome listening on ${PORT}. Start one with:`);
  console.error(`  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${PORT}`);
  console.error('It must be a fully quit-and-relaunched Chrome; the flag has no effect on a running one.');
  process.exit(1);
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('could not open the browser endpoint')), { once: true });
});

let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`));
      else resolve(m.result);
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const attach = async (targetId) =>
  (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;

const evaluate = async (sessionId, expression) => {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? 'evaluate failed');
  return out.result?.value;
};

/**
 * Which extension is bugcast.
 *
 * By manifest name rather than by id, because the id changes with every
 * unpacked reload and hardcoding one would break silently the first time it
 * did. BUGCAST_EXT_ID overrides for the case where the worker is asleep and
 * has no target to ask.
 */
async function findExtension() {
  if (process.env.BUGCAST_EXT_ID) return process.env.BUGCAST_EXT_ID;
  const { targetInfos } = await send('Target.getTargets');
  // Any extension target will do, not just the worker: MV3 workers start
  // lazily and a freshly launched browser has none running, so restricting the
  // search to service_worker finds nothing on exactly the profiles that need
  // it most.
  for (const t of targetInfos) {
    if (!t.url.startsWith('chrome-extension://')) continue;
    const session = await attach(t.targetId);
    const name = await evaluate(session, 'chrome.runtime.getManifest().name').catch(() => null);
    if (typeof name === 'string' && /bugcast/i.test(name)) return new URL(t.url).host;
  }
  return null;
}

const extId = await findExtension();
if (!extId) {
  console.error('Could not find the bugcast extension. It may be installed but its service worker asleep —');
  console.error('open its popup once, or pass BUGCAST_EXT_ID=<id> (chrome://extensions shows it).');
  process.exit(1);
}
console.log(`extension ${extId}`);

// The popup first, and left in the background. It exists only to send messages
// from — an extension page can, and the page under test cannot.
const popup = await send('Target.createTarget', {
  url: `chrome-extension://${extId}/src/popup/index.html`,
  background: true,
});
const popupSession = await attach(popup.targetId);

const page = await send('Target.createTarget', { url });
const pageSession = await attach(page.targetId);
// Nothing here waits for the page to be "ready" in any deep sense: bugcast
// attaches to whatever is there and Debugger.scriptParsed replays what has
// already loaded. Waiting for load only avoids recording an empty white frame.
await evaluate(pageSession, `new Promise((r) => document.readyState === 'complete'
  ? r(true) : addEventListener('load', () => r(true), { once: true }))`).catch(() => {});

// Frontmost BEFORE the grant. ExecuteUserAction runs against the window's
// active web contents, so granting while another tab holds focus reports
// success on the right target id and still leaves tabCapture refused.
await send('Target.activateTarget', { targetId: page.targetId });

const tabs = (await send('Target.getTargets', { filter: [{ type: 'tab' }] })).targetInfos;
const tab = tabs.find((t) => t.url === url || t.url.startsWith(url));
if (!tab) {
  console.error(`No tab target for ${url} — saw ${JSON.stringify(tabs.map((t) => t.url))}`);
  process.exit(1);
}
await send('Extensions.triggerAction', { id: extId, targetId: tab.targetId });

// chrome.tabs ids are not CDP target ids, and the worker speaks the former.
// Asked of the popup rather than the service worker: an extension page has the
// same chrome.tabs access, and it is already open and awake, whereas the worker
// may not be running at all.
const tabId = await evaluate(
  popupSession,
  `chrome.tabs.query({ active: true, currentWindow: true }).then((t) => t[0]?.id ?? null)`,
);
if (tabId == null) {
  console.error('Could not resolve the chrome.tabs id for the page.');
  process.exit(1);
}

const startMessage = {
  type: 'bugcast/start-recording',
  tabId,
  pageUrl: url,
  title: url,
};
const started = await evaluate(
  popupSession,
  `chrome.runtime.sendMessage(${JSON.stringify(startMessage)})`,
);

if (started?.error) {
  console.error(`Recording refused to start: ${started.error}`);
  // The folder grant is the usual reason, and it is the one thing no amount of
  // automation can fix: re-granting File System Access needs a user gesture,
  // which is why start() refuses rather than recording to nowhere.
  process.exit(1);
}
if (started?.captureError) console.warn(`no video: ${started.captureError}`);
console.log(`recording${SECONDS ? ` for ${SECONDS}s` : ' — Ctrl+C to stop'}`);

const stop = async () => {
  const stopped = await evaluate(popupSession, `chrome.runtime.sendMessage({ type: 'bugcast/stop-recording' })`);
  console.log(`\nsession ${stopped?.sessionId ?? '(unknown)'}`);
  if (stopped?.written) console.log(`written to ${stopped.written}`);
  if (stopped?.writeError) console.error(`write failed: ${stopped.writeError}`);
  await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
  ws.close();
};

if (SECONDS) {
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  await stop();
} else {
  process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
  await new Promise(() => {});
}
