// End-to-end smoke test: launch a real Chromium with the built extension,
// record a session against a server that produces the failures the design
// actually cares about, and print what came back.
//
// Nothing here is a unit test — it is the only way to find out whether the
// debugger actually attaches, whether setAutoAttach fires, and whether the
// eager body pull returns bodies. It has already earned its keep twice: it
// caught the redactor destroying an error response's `code` field, and the
// missing initial navigation event.
//
//   bun run smoke
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!fs.existsSync(EXT)) {
  console.error(`No build at ${EXT} — run \`bun run build\` first.`);
  process.exit(1);
}
let PORT = 0; // assigned by the OS — a fixed port collides with a stale run

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>bugcast smoke</title>
      <main>
        <form id="editor">
          <label for="quote">Quote</label>
          <textarea id="quote" data-testid="block-quote"></textarea>
          <input type="password" name="pw" autocomplete="current-password">
          <input type="text" name="notes">
          <select name="status"><option>draft</option><option>published</option></select>
          <label><input type="checkbox" name="pinned"> Pin it</label>
          <button type="submit" data-testid="editor-save">Save changes</button>
        </form>
        <div id="palette" draggable="true" style="width:80px;height:40px">Testimonial</div>
        <div id="canvas" style="width:300px;height:200px">Canvas</div>
      </main>`);
  } else if (url.pathname === '/ok') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end('{"ok":true}');
  } else if (url.pathname === '/e500') {
    res.writeHead(500, { ...cors, 'content-type': 'application/json' });
    res.end('{"success":false,"error":{"code":"DB_ERROR","message":"column \\"cdn_cache_enabled\\" of relation \\"posts\\" does not exist"}}');
  } else if (url.pathname === '/nocors') {
    res.writeHead(200, { 'content-type': 'application/json' }); // no ACAO — blocked
    res.end('{"secret":"should never be captured"}');
  } else if (url.pathname === '/png') {
    res.writeHead(500, { ...cors, 'content-type': 'image/png' });
    res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
  } else {
    res.writeHead(404, cors);
    res.end('nope');
  }
});
await new Promise((r) => server.listen(0, r));
PORT = server.address().port;

// A genuinely different origin. Same-origin /nocors is not a CORS test at all —
// it just succeeds, which is what made the first attempt at this look broken.
const other = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }); // no ACAO
  res.end('{"secret":"should never be captured"}');
});
await new Promise((r) => other.listen(0, r));
const OTHER_PORT = other.address().port;

// Test-only affordance: production requests host permission per-origin at
// record time, but that prompt is a native Chrome dialog no automation can
// accept. The code under test is byte-identical — only the manifest differs,
// and only in the one thing that cannot be granted headlessly.
//
// Applied to a COPY. An earlier version patched dist/manifest.json in place and
// never put it back, so the shipped build quietly carried <all_urls> and Chrome
// warned about it on load. A test must not be able to change the artifact.
const LOADED = fs.mkdtempSync(path.join(os.tmpdir(), 'bugcast-ext-'));
fs.cpSync(EXT, LOADED, { recursive: true });
const manifestPath = path.join(LOADED, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = ['<all_urls>'];
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bugcast-'));
// Playwright's bundled Chromium, not `channel: 'chrome'`. The system-Chrome
// route launches but never registers the MV3 service worker within a sane
// timeout, and chasing that is not worth a ~150MB download avoided:
//   bunx playwright install chromium
// Headed, because the bundled headless shell does not load extensions at all.
let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
      args: [`--disable-extensions-except=${LOADED}`, `--load-extension=${LOADED}`],
  });
} catch (e) {
  console.error('Could not launch Chromium. Run `bunx playwright install chromium`.');
  console.error(String(e.message).split('\n')[0]);
  server.close();
  process.exit(1);
}

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('extension id:', extId);

// The page under test. Playwright attaches to it, which is the interesting
// question: does chrome.debugger.attach conflict with an existing CDP client?
const target = await ctx.newPage();
await target.goto(`http://localhost:${PORT}/`);

// Grab the id while the target is still the active tab — tab.url is not
// readable without the `tabs` permission, so URL matching is not an option.
const tabId = await sw.evaluate(async () => {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t?.id ?? null;
});
console.log('target tabId:', tabId);

// An extension page is needed to reach onMessage — a service worker's own
// sendMessage does not loop back to its own listener.
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/src/popup/index.html`);

const started = await ext.evaluate(
  ([type, tabId, pageUrl, title]) => chrome.runtime.sendMessage({ type, tabId, pageUrl, title }),
  ['bugcast/start-recording', tabId, `http://localhost:${PORT}/`, 'bugcast smoke'],
);
console.log('start ->', JSON.stringify(started));
if (started?.captureError) console.log('capture error:', started.captureError);
if (started?.error) {
  console.log('\nATTACH REFUSED (this is the refuse-to-start path working):', started.error);
  await ctx.close(); server.close(); process.exit(0);
}

await target.bringToFront();

// Interactions, driven as real trusted input so the capture-phase listeners
// see exactly what a user would produce.
await target.click('[data-testid="block-quote"]');
await target.fill('[data-testid="block-quote"]', 'Great service, would recommend');
await target.fill('input[name="pw"]', 'hunter2hunter2');
await target.fill('input[name="notes"]', 'dan@example.com');
await target.selectOption('select[name="status"]', 'published');
await target.check('input[name="pinned"]');
await target.keyboard.press('Escape');
await target.keyboard.press('Tab');
await target.dragAndDrop('#palette', '#canvas');
await target.click('[data-testid="editor-save"]');
await target.waitForTimeout(300);

await target.evaluate((p) => ((window).__otherPort = p), OTHER_PORT);
await target.evaluate(async (port) => {
  console.log('[smoke] hello from the page');
  console.error('Failed to save post');
  await fetch(`http://localhost:${port}/ok`);
  await fetch(`http://localhost:${port}/e500`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer sk-abcdefghijklmnopqrstuvwxyz012345', 'content-type': 'application/json' },
    body: JSON.stringify({ blocks: [], cdnCacheEnabled: true, password: 'hunter2' }),
  }).catch(() => {});
  await fetch(`http://localhost:${port}/png`).catch(() => {});
  await fetch(`http://localhost:${port}/nocors`).catch(() => {});
  // Cross-origin, no ACAO — this one is really blocked.
  await fetch(`http://127.0.0.1:${window.__otherPort}/blocked`).catch(() => {});
  await fetch(`http://localhost:${port}/ok?token=deadbeefcafe0123deadbeefcafe0123`).catch(() => {});
  history.pushState({}, '', '/after-push');
  setTimeout(() => { throw new Error('boom from the page'); }, 0);
}, PORT);

await target.waitForTimeout(1500);

const stopped = await ext.evaluate(
  (type) => chrome.runtime.sendMessage({ type }),
  'bugcast/stop-recording',
);

// The directory grant cannot be scripted — showDirectoryPicker opens a native
// OS dialog. So this asserts the *degradation*: with no folder chosen, the
// session must still come back rather than being lost to a write failure.
console.log('\n=== report.md (first 40 lines) ===');
console.log((stopped.report ?? '(none)').split('\n').slice(0, 40).join('\n'));

// tabCapture needs an activeTab grant only a real toolbar click can produce,
// so drive the real pipeline with a synthetic stream instead: a canvas for
// video, an oscillator for audio. Proves the worklet loads, the tee wires up,
// MediaRecorder produces bytes, and PCM comes out the tap.
// The self-test is reachable from any extension page, so the harness can run
// the real thing. No folder is chosen here, so `disk` is expected to fail —
// which is itself worth asserting: the failure has to name what to do.
console.log('\n=== self-test (asr excluded — it downloads a model) ===');
// Not `asr`: it downloads a speech model, which is exactly what that check is
// for and several minutes nobody wants on every push.
const selfTest = await ext.evaluate(
  (type) => chrome.runtime.sendMessage({ type, only: ['cdp', 'disk', 'capture'] }),
  'bugcast/run-self-test',
);
for (const c of selfTest?.checks ?? []) {
  console.log(`${c.ok ? 'PASS' : 'fail'}  ${c.label} — ${c.detail} (${c.ms}ms)`);
}
const cdp = (selfTest?.checks ?? []).find((c) => c.id === 'cdp');
if (!cdp?.ok) {
  console.error('FAIL: the debugger self-test could not attach');
  process.exitCode = 1;
}

console.log('\n=== pipeline (synthetic stream) ===');
const off = await ctx.newPage();
await off.goto(`chrome-extension://${extId}/offscreen.html`);
const pipeline = await off.evaluate(async () => {
  const hooks = globalThis.__bugcastTestHooks;
  if (!hooks) return { error: 'test hooks missing — offscreen.js did not load' };

  // Diagnose the worklet URL before using it — "Unable to load a worklet's
  // module" is the same message for 404, wrong MIME and a throwing module.
  const workletUrl = chrome.runtime.getURL('pcm-worklet.js');
  const probe = await fetch(workletUrl).then(
    (r) => `${r.status} ${r.headers.get('content-type')}`,
    (e) => `fetch failed: ${e.message}`,
  );

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const g = canvas.getContext('2d');
  const paint = () => {
    g.fillStyle = `hsl(${Date.now() % 360},70%,50%)`;
    g.fillRect(0, 0, 320, 240);
    requestAnimationFrame(paint);
  };
  paint();

  const audioCtx = new AudioContext();
  const osc = audioCtx.createOscillator();
  const dest = audioCtx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();

  // Split, because the Whisper tap takes mic only: the oscillator has to arrive
  // as the mic or the tap stays silent and this fails for the wrong reason.
  const tabOnly = new MediaStream(canvas.captureStream(15).getVideoTracks());
  const micOnly = new MediaStream(dest.stream.getAudioTracks());

  const mime = hooks.pickMimeType((t) => MediaRecorder.isTypeSupported(t));
  let built;
  try {
    built = await hooks.buildPipeline(tabOnly, micOnly, mime);
  } catch (e) {
    return { error: `buildPipeline: ${e.name}: ${e.message}`, workletUrl, probe, mime };
  }
  const { recorder, context, pcm } = built;

  let bytes = 0;
  const parts = [];
  recorder.ondataavailable = (e) => {
    bytes += e.data.size;
    parts.push(e.data);
  };
  const RECORD_MS = 1200;
  recorder.start(200);
  await new Promise((r) => setTimeout(r, RECORD_MS));
  await new Promise((r) => {
    recorder.onstop = r;
    recorder.stop();
  });
  const sampleRate = context.sampleRate;
  await context.close();
  osc.stop();

  // Feed the recording straight back into the real extractor. Proves the
  // linear requestVideoFrameCallback pass finds its moments and that JPEGs
  // come out the other side.
  const written = [];
  const frames = await hooks.extractFrames(
    new Blob(parts, { type: mime }),
    [
      { t: 200, path: 'frames/000000200-click.jpg', events: [0] },
      { t: 700, path: 'frames/000000700-navigation.jpg', events: [1] },
    ],
    async (path, image) => written.push({ path, bytes: image.size, type: image.type }),
  );

  return {
    workletUrl,
    probe,
    mime,
    bytes,
    pcmChunks: pcm.length,
    pcmSamples: pcm.reduce((n, c) => n + c.length, 0),
    sampleRate,
    // Should track wall-clock at exactly 16kHz if decimation is right.
    pcmSeconds: +(pcm.reduce((n, c) => n + c.length, 0) / 16000).toFixed(3),
    recordedSeconds: RECORD_MS / 1000,
    frames,
    frameFiles: written,
  };
});
console.log(JSON.stringify(pipeline, null, 2));
if (pipeline.error || !pipeline.bytes || !pipeline.pcmSamples) {
  console.error('FAIL: pipeline produced no video bytes or no PCM');
  process.exitCode = 1;
} else if (!pipeline.frames?.written || pipeline.frameFiles?.some((f) => !f.bytes)) {
  console.error('FAIL: frame extraction produced no images');
  process.exitCode = 1;
} else if (Math.abs(pipeline.pcmSeconds - pipeline.recordedSeconds) > 0.25) {
  console.error(
    `FAIL: PCM is ${pipeline.pcmSeconds}s for ${pipeline.recordedSeconds}s recorded — decimation ratio is wrong`,
  );
  process.exitCode = 1;
}

console.log('\n=== capture ===');
console.log(JSON.stringify(stopped.capture ?? '(none)'));

console.log('\n=== disk ===');
console.log('sessionId:', stopped.sessionId);
console.log('written:  ', stopped.written ?? `(nothing written: ${stopped.writeError})`);
// No folder is chosen here, so this exercises the enterprise-policy fallback:
// the session must still land somewhere, as a single zip in Downloads.
if (!stopped.written?.includes('.zip')) {
  console.error('FAIL: with no folder, the session should fall back to a zip');
  process.exitCode = 1;
}

// A cross-origin request with no ACAO must be recorded as a failure carrying
// the CORS reason. Recorded naively it reads as a clean success, which is not
// merely incomplete but the opposite of what the developer saw.
const cors = (stopped.events ?? []).find((e) => e.type === 'network' && e.url.includes('/blocked'));
console.log('\n=== cors ===');
console.log(cors?.failure ? `blocked: ${cors.failure.errorText} / ${cors.failure.corsErrorStatus}` : 'NOT RECORDED AS A FAILURE');
if (!cors?.failure?.corsErrorStatus) {
  console.error('FAIL: a CORS-blocked request was not recorded as a failure');
  process.exitCode = 1;
}

console.log('\n=== redaction summary ===');
console.log(JSON.stringify(stopped.redaction, null, 2));
console.log(`\n=== ${stopped.events?.length ?? 0} events ===`);
for (const e of stopped.events ?? []) {
  const bits = [String(e.t).padStart(6), e.type.padEnd(10)];
  if (e.type === 'network') {
    bits.push(`${e.method} ${e.url.replace(`http://localhost:${PORT}`, '')} -> ${e.status ?? '?'}`);
    if (e.failure) bits.push(`[FAILED: ${e.failure.errorText}${e.failure.corsErrorStatus ? ' / ' + e.failure.corsErrorStatus : ''}]`);
    if (e.response?.body) bits.push(`\n         body: ${e.response.body.slice(0, 160)}`);
    if (e.response?.omitted) bits.push(`[omitted: ${e.response.omitted}]`);
    if (e.request?.postData) bits.push(`\n         post: ${e.request.postData.slice(0, 160)}`);
    if (e.request?.headers?.authorization) bits.push(`\n         auth: ${e.request.headers.authorization}`);
  } else if (e.type === 'console') bits.push(`[${e.level}] ${e.text.slice(0, 120)}`);
  else if (e.type === 'drag') {
    bits.push(`${e.from?.target?.selector} -> ${e.to?.target?.selector} (${e.mechanism})`);
  } else if (e.target) {
    bits.push(e.target.selector);
    if (e.value) bits.push(`value=${JSON.stringify(e.value)}`);
    if (e.key) bits.push(`key=${e.key}`);
    if (e.mechanism) bits.push(`(${e.mechanism}) -> ${e.to?.target?.selector}`);
  }
  else if (e.type === 'exception') bits.push(e.text.slice(0, 120));
  else if (e.type === 'navigation') bits.push(`${e.trigger} ${e.pageUrl}`);
  console.log(bits.join(' '));
}

await ctx.close();
server.close();
other.close();
