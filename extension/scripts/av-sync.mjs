/**
 * Does the timeline agree with the video, and does the narration agree with
 * both? Automated, repeatable, and failing loudly when it does not.
 *
 *   bun run av-sync            # events vs video
 *   bun run av-sync --speech   # also narration, needs a fake-mic fixture
 *
 * The problem this solves is that every other check in this repo verifies
 * artifacts EXIST. None of them verifies they line up. A session whose events
 * are all stamped two seconds late is a complete, well-formed, entirely
 * misleading recording, and nothing here would have noticed.
 *
 * How it works — the page carries its own clock into the recording twice, by
 * two independent routes:
 *
 *   1. VISUALLY, as a 16-bit binary counter painted across the top of the page
 *      (scripts/fixtures/timecode.html). Whatever the video shows at some
 *      moment, we can read what the page's clock said at the instant that
 *      frame was painted.
 *   2. AS TEXT, in a console beacon every two seconds carrying the same
 *      counter. That lands in the timeline with the recorder's own timestamp.
 *
 * So for each beacon there are three clocks that must agree: when the timeline
 * says it happened, what the video was showing then, and what the page thought
 * the time was. Comparing (2) against (1) sampled at (2)'s timestamp needs no
 * shared clock and no trust in either subsystem.
 *
 * The residual is what matters. A constant offset would be a calibration
 * question; a GROWING one is drift, which is the failure that actually
 * threatens this tool — docs/design/map.md has carried "tabCapture frame
 * cadence" as an open question since the beginning, and this is what answers
 * it. Both are reported separately.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { launchWithExtension, makeGrantActiveTab } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WANT_SPEECH = process.argv.includes('--speech');
const SECONDS = Number(process.env.AV_SYNC_SECONDS ?? 40);

/**
 * Bit centres as a fraction of the PAGE's width, matching the fixture's `.bit`
 * rule. Not a fraction of the video frame — the page does not fill the frame,
 * which is what the locator is for.
 */
const BIT_X = Array.from({ length: 16 }, (_, i) => (2 + i * 5.5 + 1.5) / 100);
/** Bit row centre, also in page widths: `top: 4vw` plus half of `height: 3vw`. */
const BIT_Y = 0.055;
const TICK_MS = 50;

/**
 * How far a beacon may sit from what the video shows before this is a failure.
 *
 * Not a taste value. The video records at 15fps (67ms between frames) and the
 * counter advances every 50ms, so ~120ms of the budget is quantisation that no
 * correct implementation can avoid. 300ms leaves real headroom above that
 * while still being a fifth of the smallest desync a person would notice.
 */
const TOL_MS = 300;

/** Sampling density, not speed. See the decode pass. */
const DECODE_RATE = 2;

const fixture = fs.readFileSync(path.join(HERE, 'fixtures', 'timecode.html'), 'utf8');
let PORT = 0;
const server = http.createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixture);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
PORT = server.address().port;
const PAGE = `http://localhost:${PORT}/`;

const speechFixture = path.join(HERE, 'fixtures', 'narration.wav');
const speechScript = path.join(HERE, 'fixtures', 'narration.json');
const haveSpeech = fs.existsSync(speechFixture) && fs.existsSync(speechScript);
if (WANT_SPEECH && !haveSpeech) {
  console.error(`No fake-mic fixture. Generate one first:\n  node scripts/make-narration.mjs`);
  server.close();
  process.exit(1);
}

// tabCapture is paint-driven, and Chrome stops painting a window it thinks
// nobody is looking at. That is why the smoke test tolerates a zero-byte video
// and calls it environmental — but a sync test cannot tolerate it, because a
// video with three frames in it cannot be compared to anything. These are the
// flags that keep the renderer running when the window is occluded or the
// operator is doing something else on the desktop. Measured: the same 30-second
// run produced 814KB with the window in front and 22KB behind it.
const extraArgs = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  // The capture surface, not the window, is what matters here. On a Retina
  // display the tab records at device scale — 2880x1800 — and software VP8 at
  // that size cannot keep up, so tabCapture delivers a handful of frames for a
  // whole session. Pinning the scale factor to 1 and the window small takes the
  // encoder's job from ~5.2 megapixels a frame to ~0.5.
  '--force-device-scale-factor=1',
  '--window-size=1000,700',
];
if (WANT_SPEECH) {
  // Chrome's fake device replaces the microphone with a file. `%noloop` matters:
  // without it the clip repeats and every expected utterance matches twice, at
  // which point the ordering assertion is meaningless.
  extraArgs.push(
    '--use-fake-device-for-media-capture',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${speechFixture}%noloop`,
  );
}

/**
 * Make the browser the frontmost APPLICATION, not just the frontmost tab.
 *
 * `bringToFront` raises a tab within its window and nothing more. macOS stops
 * compositing a window whose application is in the background, and tabCapture
 * only produces frames while the page paints — so an unattended run records a
 * handful of frames and calls it a session. Measured: 24KB and 1 frame for a
 * 30-second recording with the terminal focused.
 *
 * Worth being clear that this is the HARNESS working around a real defect, not
 * a test artefact. A tester who alt-tabs to check something mid-session is in
 * exactly this state, and bugcast currently stops recording video when they do.
 * Filed separately; this only keeps the sync measurement from being starved of
 * frames to measure.
 */
function bringAppForward() {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('osascript', [
      '-e',
      'tell application "System Events" to set frontmost of (first process whose name is "Chromium") to true',
    ], { stdio: 'ignore' });
  } catch {
    // Best effort. If it fails the frame count assertion below will say so.
  }
}

const { ctx, sw, extId, cdpPort } = await launchWithExtension({
  extraArgs,
  onFail: () => server.close(),
});
const grantActiveTab = makeGrantActiveTab({ extId, cdpPort });
console.log('extension id:', extId);

const target = await ctx.newPage();
// A fixed viewport, so a run on one machine is comparable to a run on another.
// It also means the page does not fill the recorded frame — the video is the
// window's content area, the layout is this — which is why the decoder locates
// the page rather than assuming the two rectangles are the same.
await target.setViewportSize({ width: 960, height: 600 });
await target.goto(PAGE);
const tabId = await sw.evaluate(async () => {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t?.id ?? null;
});

const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/src/popup/index.html`);
// Same OPFS trick the smoke uses: a real directory handle with no native picker.
await ext.evaluate(async () => {
  const opfs = await navigator.storage.getDirectory();
  const dir = await opfs.getDirectoryHandle('sessions', { create: true });
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('bugcast', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onsuccess = () => {
      const tx = open.result.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(dir, 'sessionDirectory');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
});

// The recorded tab must stay frontmost for the whole session. rAF throttles in
// a background tab, which would freeze the painted counter — and tabCapture is
// paint-driven, so it would also stop producing video. Nothing below may call
// bringToFront on another page until stop.
await target.bringToFront();
bringAppForward();
const grantError = await grantActiveTab(PAGE).catch((e) => e.message);
console.log(`activeTab: ${grantError ?? 'granted'}`);

const started = await ext.evaluate(
  ([type, tabId, pageUrl, title]) => chrome.runtime.sendMessage({ type, tabId, pageUrl, title }),
  ['bugcast/start-recording', tabId, PAGE, 'bugcast a/v sync'],
);
if (started?.error) {
  console.error('FAIL: recording refused to start —', started.error);
  await ctx.close(); server.close(); process.exit(1);
}
if (started?.captureError) {
  console.error('FAIL: no video capture —', started.captureError);
  await ctx.close(); server.close(); process.exit(1);
}
console.log(`recording ${SECONDS}s...`);

// Real trusted clicks partway through, so the interaction path is exercised on
// the same timeline as the console path. They log their own tick too.
await target.waitForTimeout(Math.floor(SECONDS * 1000 * 0.35));
await target.click('[data-testid="act-a"]');
await target.waitForTimeout(Math.floor(SECONDS * 1000 * 0.3));
await target.click('[data-testid="act-b"]');
await target.waitForTimeout(Math.floor(SECONDS * 1000 * 0.35));

const stopped = await ext.evaluate((type) => chrome.runtime.sendMessage({ type }), 'bugcast/stop-recording');
const sessionId = stopped?.sessionId;
if (!sessionId) {
  console.error('FAIL: stop returned no session id —', JSON.stringify(stopped));
  await ctx.close(); server.close(); process.exit(1);
}
console.log('session:', sessionId);

// ---------------------------------------------------------------- read back

const artifacts = await ext.evaluate(async (id) => {
  const opfs = await navigator.storage.getDirectory();
  const dir = await opfs.getDirectoryHandle('sessions');
  const folder = await dir.getDirectoryHandle(id);
  const read = async (name) => {
    const h = await folder.getFileHandle(name).catch(() => null);
    if (!h) return null;
    return (await h.getFile()).text();
  };
  const names = [];
  for await (const [name, handle] of folder.entries()) {
    names.push(`${name}${handle.kind === 'file' ? ` (${(await handle.getFile()).size} bytes)` : '/'}`);
  }
  const videoHandle = await folder.getFileHandle('video.webm').catch(() => null);
  return {
    names,
    videoBytes: videoHandle ? (await videoHandle.getFile()).size : 0,
    timeline: await read('timeline.json'),
    speech: await read('speech.ndjson'),
    srt: await read('transcript.srt'),
  };
}, sessionId);

console.log('\n=== written ===');
console.log(artifacts.names.map((n) => '  ' + n).join('\n'));

if (!artifacts.videoBytes) {
  console.error('\nFAIL: video.webm is empty. The fixture repaints every frame, so a');
  console.error('paint-starved tab is not the explanation here — this is a real capture failure.');
  await ctx.close(); server.close(); process.exit(1);
}

const timeline = JSON.parse(artifacts.timeline ?? '{}');
const events = timeline.events ?? [];

/** `AVSYNC beacon seq=3 tick=142` out of whatever shape the console event has. */
const beacons = [];
for (const e of events) {
  const text = JSON.stringify(e);
  const m = /AVSYNC beacon seq=(\d+) tick=(\d+)(?: rafs=(\d+) vis=(\w+) focus=(\w+))?/.exec(text);
  if (m) {
    beacons.push({
      seq: Number(m[1]), pageMs: Number(m[2]) * TICK_MS, t: e.t,
      rafs: m[3] === undefined ? null : Number(m[3]), vis: m[4], focus: m[5],
    });
  }
}
const clicks = [];
for (const e of events) {
  const m = /AVSYNC click id=(\S+) tick=(\d+)/.exec(JSON.stringify(e));
  if (m) clicks.push({ id: m[1], pageMs: Number(m[2]) * TICK_MS, t: e.t });
}
console.log(`\nbeacons in timeline: ${beacons.length}, click beacons: ${clicks.length}`);

// Whether the page painted is the first fork in every diagnosis here, and the
// page is the only thing that can answer it. A frozen counter and a starved
// encoder produce the same short video from the outside.
const withRafs = beacons.filter((b) => b.rafs !== null);
if (withRafs.length >= 2) {
  const first = withRafs[0], last = withRafs.at(-1);
  const seconds = (last.t - first.t) / 1000;
  const fps = seconds > 0 ? (last.rafs - first.rafs) / seconds : 0;
  console.log(`page painted at ${fps.toFixed(1)} fps (visibility=${last.vis}, focus=${last.focus})`);
  if (fps < 5) {
    console.log('  the PAGE is not painting — tabCapture has nothing to record. Look at the window,');
    console.log('  not the encoder.');
  } else {
    console.log('  the page is painting fine; a short video is then a capture/encode problem.');
  }
}
if (beacons.length < 5) {
  console.error('FAIL: too few beacons reached the timeline to say anything about sync.');
  await ctx.close(); server.close(); process.exit(1);
}

// ------------------------------------------------------------ decode the video
//
// A linear pass at moderate speed reading requestVideoFrameCallback's mediaTime,
// exactly like the extension's own frame extraction and for the same reason:
// a MediaRecorder webm has no reliable seek index, so seeking would be measuring
// the container rather than the recording. The rate is chosen for SAMPLE
// DENSITY, not for speed — too fast and the compositor drops frames, leaving
// gaps wider than the tolerance being asserted.

// Recording is over, so focus is free again — and the decoder needs it.
// requestVideoFrameCallback throttles in a backgrounded page, so decoding from
// a page sitting behind the recorded tab simply stops part way and never
// finishes. Cost one hung run to find.
await ext.bringToFront();

const decode = await ext.evaluate(
  async ({ id, xs, yFrac, rate, deadlineMs }) => {
    const opfs = await navigator.storage.getDirectory();
    const dir = await opfs.getDirectoryHandle('sessions');
    const folder = await dir.getDirectoryHandle(id);
    const file = await (await folder.getFileHandle('video.webm')).getFile();
    const url = URL.createObjectURL(file);

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });

    const rvfc = video.requestVideoFrameCallback?.bind(video);
    if (!rvfc) return { error: 'requestVideoFrameCallback unavailable' };

    await new Promise((resolve, reject) => {
      video.onerror = () => reject(new Error('could not decode video.webm'));
      video.onloadedmetadata = () => resolve();
    });
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) return { error: 'video has no dimensions' };

    /**
     * Find the page inside the frame, by its magenta locator bar.
     *
     * The alternative — assume the video frame IS the viewport — is what the
     * first version did, and it silently sampled empty desktop and reported a
     * counter that never changed. Measuring costs one full-frame read.
     */
    let page = null;
    const calibrate = () => {
      const { data, width, height } = g.getImageData(0, 0, canvas.width, canvas.height);
      const isMagenta = (i) => data[i] > 140 && data[i + 2] > 140 && data[i + 1] < 110;
      let bestRow = -1, bestCount = 0;
      // Only the top third can hold it, and every 2nd pixel is plenty for a bar
      // that is 3% of the page wide at its thinnest.
      for (let y = 0; y < Math.floor(height / 3); y++) {
        let count = 0;
        for (let x = 0; x < width; x += 2) if (isMagenta((y * width + x) * 4)) count++;
        if (count > bestCount) { bestCount = count; bestRow = y; }
      }
      if (bestRow < 0 || bestCount < 20) return null;
      let left = -1, right = -1;
      for (let x = 0; x < width; x++) {
        if (isMagenta((bestRow * width + x) * 4)) { if (left < 0) left = x; right = x; }
      }
      // The bar sits at the page's top edge, so the topmost magenta row in that
      // column is where the page starts.
      const midX = Math.floor((left + right) / 2);
      let top = bestRow;
      while (top > 0 && isMagenta(((top - 1) * width + midX) * 4)) top--;
      const pageW = right - left;
      if (pageW < 50) return null;
      return { left, right, top, pageW };
    };

    const samples = [];
    let probe = null;
    video.playbackRate = rate;
    await video.play();
    // Never wait forever. A decode that stalls is a real failure mode here —
    // it is what a throttled page does — and a harness that hangs on it tells
    // you nothing, whereas one that gives up after a bounded wait hands back
    // however many frames it managed and lets the assertions speak.
    let done;
    const finish = () => done?.();
    const deadline = setTimeout(finish, deadlineMs);
    await new Promise((resolve) => {
      done = () => { clearTimeout(deadline); resolve(); };
      video.onended = finish;
      const onFrame = (_now, meta) => {
        g.drawImage(video, 0, 0, canvas.width, canvas.height);
        // Calibrate on the third frame — the first can land before the page has
        // painted at all — and once only: the page does not move.
        if (!page && samples.length >= 2) {
          page = calibrate();
          if (page) {
            probe = { ...page, frame: samples.length, videoW: canvas.width, videoH: canvas.height };
          }
        }
        if (page) {
          const y = Math.round(page.top + yFrac * page.pageW);
          let tick = 0;
          for (let i = 0; i < xs.length; i++) {
            const px = g.getImageData(
              Math.min(canvas.width - 1, Math.round(page.left + xs[i] * page.pageW)),
              Math.min(canvas.height - 1, y), 1, 1,
            ).data;
            // Green channel alone: the blocks are pure black or pure white, and
            // one channel survives chroma subsampling better than luma maths
            // over three that VP8 has already discarded information from.
            if (px[1] > 128) tick |= 1 << i;
          }
          samples.push({ mediaMs: meta.mediaTime * 1000, tick });
        } else {
          samples.push({ mediaMs: meta.mediaTime * 1000, tick: null });
        }
        rvfc(onFrame);
      };
      rvfc(onFrame);
    });
    video.pause();
    URL.revokeObjectURL(url);
    return {
      duration: Number.isFinite(video.duration) ? video.duration * 1000 : null,
      samples: samples.filter((s) => s.tick !== null),
      framesSeen: samples.length,
      probe,
      width: canvas.width,
      height: canvas.height,
    };
  },
  { id: sessionId, xs: BIT_X, yFrac: BIT_Y, rate: DECODE_RATE, deadlineMs: (SECONDS / DECODE_RATE + 30) * 1000 },
);

if (decode.error) {
  console.error('FAIL: could not read the video back —', decode.error);
  await ctx.close(); server.close(); process.exit(1);
}
const samples = decode.samples ?? [];
console.log(`video: ${decode.width}x${decode.height}, ${decode.framesSeen} frames seen, ${samples.length} decoded`);
if (decode.probe) {
  const p = decode.probe;
  console.log(`  page located at x ${p.left}-${p.right}, y ${p.top} (${p.pageW}px wide) inside the frame`);
} else {
  console.error('  the magenta locator was never found — the decoder could not tell where the page is.');
}
if (samples.length < 10) {
  console.error(`FAIL: only ${samples.length} frames decoded — nothing to compare against.`);
  console.error(`  video.webm was ${artifacts.videoBytes} bytes for a ${SECONDS}s session.`);
  console.error('  That is a capture-side shortfall, not a decode one: tabCapture paints only');
  console.error('  while Chrome believes the window is visible. Check the anti-throttling flags');
  console.error('  above, and that nothing minimised or covered the browser mid-run.');
  await ctx.close(); server.close(); process.exit(1);
}

// A counter that never changes means the decode is reading the wrong pixels,
// not that the page froze — worth separating, because a silently-zero decode
// would make every residual agree perfectly with nothing.
const distinct = new Set(samples.map((s) => s.tick)).size;
if (distinct < 5) {
  console.error(`FAIL: decoded only ${distinct} distinct counter values across ${samples.length} frames.`);
  console.error('The decoder is almost certainly sampling the wrong coordinates, not measuring a real freeze.');
  console.error(`  page located at ${JSON.stringify(decode.probe)}`);
  await ctx.close(); server.close(); process.exit(1);
}

// ------------------------------------------------------------------- compare

/**
 * Fit the video's clock against the page's clock, using every frame.
 *
 * The obvious method — for each beacon, find the nearest frame and compare —
 * throws away all but a dozen of the frames and inherits the full quantisation
 * error of the one it keeps. At the frame rates tabCapture actually delivers
 * that noise floor is larger than any desync worth catching, which is how the
 * first version came to fail a recording that was fine.
 *
 * A least-squares fit over all frames gives two things instead of one:
 *
 *   intercept — the constant offset between the two clocks. A calibration
 *               question, not a fault.
 *   slope     — how fast the video's clock runs against the page's. This is
 *               drift, measured directly rather than inferred from the ends of
 *               a noisy series, and it is the failure that actually matters:
 *               docs/design/map.md has carried "tabCapture frame cadence" as
 *               open since the beginning.
 */
const n = samples.length;
const meanX = samples.reduce((a, s) => a + s.mediaMs, 0) / n;
const meanY = samples.reduce((a, s) => a + s.tick * TICK_MS, 0) / n;
let sxy = 0, sxx = 0;
for (const s of samples) {
  sxy += (s.mediaMs - meanX) * (s.tick * TICK_MS - meanY);
  sxx += (s.mediaMs - meanX) ** 2;
}
const slope = sxx > 0 ? sxy / sxx : NaN;
const intercept = meanY - slope * meanX;
const predict = (mediaMs) => intercept + slope * mediaMs;

const covered = { from: Math.min(...samples.map((s) => s.mediaMs)), to: Math.max(...samples.map((s) => s.mediaMs)) };
const gaps = samples.slice(1).map((s, i) => s.mediaMs - samples[i].mediaMs).sort((a, b) => a - b);
const medianGap = gaps[Math.floor(gaps.length / 2)] ?? 0;
const fps = medianGap > 0 ? 1000 / medianGap : 0;

/**
 * What the method can actually resolve, rather than what would be nice.
 *
 * Half a frame interval because that is how far the truth can sit from the
 * nearest sample, plus one counter tick of quantisation, plus a floor so a
 * high frame rate does not assert a precision the counter cannot express.
 */
const resolution = Math.max(150, medianGap / 2 + TICK_MS);

const rows = [];
for (const b of [...beacons, ...clicks.map((c) => ({ ...c, seq: `click:${c.id}` }))]) {
  const inRange = b.t >= covered.from - medianGap && b.t <= covered.to + medianGap;
  rows.push({ ...b, residual: inRange ? predict(b.t) - b.pageMs : null });
}
rows.sort((a, b) => a.t - b.t);

const measured = rows.filter((r) => r.residual !== null);
console.log(`\nvideo covers ${(covered.from / 1000).toFixed(1)}-${(covered.to / 1000).toFixed(1)}s at ~${fps.toFixed(1)}fps (resolution ±${Math.round(resolution)}ms)`);
console.log('\n=== event vs video ===');
console.log('  seq          timeline t    page clock   video shows   residual');
for (const r of rows) {
  if (r.residual === null) {
    console.log(`  ${String(r.seq).padEnd(12)} ${String(r.t).padStart(8)}ms ${String(r.pageMs).padStart(11)}ms        —      outside the recorded span`);
    continue;
  }
  const shown = Math.round(r.pageMs + r.residual);
  console.log(
    `  ${String(r.seq).padEnd(12)} ${String(r.t).padStart(8)}ms ${String(r.pageMs).padStart(11)}ms ${String(shown).padStart(11)}ms   ${r.residual > 0 ? '+' : ''}${r.residual.toFixed(0)}ms`,
  );
}

if (measured.length < 5) {
  console.error('\nFAIL: not enough beacons fell inside the recorded video to judge sync.');
  await ctx.close(); server.close(); process.exit(1);
}

const residuals = measured.map((r) => r.residual);
const median = [...residuals].sort((a, b) => a - b)[Math.floor(residuals.length / 2)];
const worst = Math.max(...residuals.map((r) => Math.abs(r - median)));
// Slope is dimensionless: 1.0 means the video's clock and the page's advance
// together. Expressed as ms lost or gained over the whole session, which is
// what a reader can judge.
const driftOverSession = (slope - 1) * (covered.to - covered.from);

console.log('\n=== verdict ===');
console.log(`  samples          ${measured.length} beacons against ${n} frames`);
console.log(`  clock ratio      ${slope.toFixed(5)}  (video vs page; 1.00000 is perfect)`);
console.log(`  drift            ${driftOverSession > 0 ? '+' : ''}${driftOverSession.toFixed(0)}ms over ${((covered.to - covered.from) / 1000).toFixed(0)}s`);
console.log(`  constant offset  ${median > 0 ? '+' : ''}${median.toFixed(0)}ms`);
console.log(`  worst scatter    ${worst.toFixed(0)}ms  (resolution ±${Math.round(resolution)}ms)`);

let failed = false;
if (worst > resolution) {
  console.error(`\nFAIL: an event sits ${worst.toFixed(0)}ms from what the video shows, beyond the ±${Math.round(resolution)}ms this run can resolve.`);
  failed = true;
}
if (Math.abs(driftOverSession) > resolution) {
  console.error(`\nFAIL: ${driftOverSession.toFixed(0)}ms of drift — the timeline and the video run at different rates.`);
  failed = true;
}
/**
 * Does the video last as long as the session did?
 *
 * Sync is only half the question. A perfectly aligned recording that stops
 * early is still missing the end of what happened, and every alignment number
 * above would stay green while it did — the beacons past the end simply drop
 * out of the fit. Worth its own assertion for the same reason transcript.srt
 * needed one: the artifact claimed a span it did not have.
 */
const lastEvent = Math.max(...events.map((e) => e.t ?? 0));
const shortfall = lastEvent - covered.to;
console.log(`  video span       ${(covered.to / 1000).toFixed(1)}s vs ${(lastEvent / 1000).toFixed(1)}s of timeline`);
if (shortfall > Math.max(3000, medianGap * 3)) {
  console.error(`\nFAIL: the video stops ${(shortfall / 1000).toFixed(1)}s before the session does.`);
  console.error('  Events kept arriving after the last frame, so this is the recording ending');
  console.error('  early rather than the page going quiet.');
  failed = true;
}

if (!failed) {
  console.log('\n  the timeline, the video and the page agree.');
}

// ------------------------------------------------------------------- speech

if (WANT_SPEECH) {
  const script = JSON.parse(fs.readFileSync(speechScript, 'utf8'));
  const lines = (artifacts.speech ?? '')
    .trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  console.log(`\n=== narration ===\n  ${lines.length} speech lines`);

  let lastT = -Infinity;
  for (const utt of script.utterances) {
    const hit = lines.find((l) => String(l.text ?? '').toLowerCase().includes(utt.keyword.toLowerCase()));
    if (!hit) {
      console.error(`  MISSING  "${utt.keyword}" (expected around ${utt.atMs}ms)`);
      failed = true;
      continue;
    }
    const t = hit.t ?? hit.start ?? 0;
    // Deliberately not a tight bound. The engine stamps a line when it decides
    // the phrase is over, so a late stamp is correct behaviour, not desync.
    // What must hold is ORDER — a transcript that reorders what was said is
    // worse than one that lags, because it changes the meaning.
    const late = t - utt.atMs;
    const bad = t < lastT;
    console.log(`  ${bad ? 'ORDER' : 'ok   '}    "${utt.keyword}" at ${t}ms (spoken ~${utt.atMs}ms, ${late > 0 ? '+' : ''}${late}ms)`);
    if (bad) { console.error(`         out of order — follows a line stamped ${lastT}ms`); failed = true; }
    lastT = t;
  }
}

await ctx.close();
server.close();
if (failed) { console.error('\nav-sync FAILED'); process.exit(1); }
console.log('\nav-sync passed');
