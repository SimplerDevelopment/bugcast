/**
 * The capture pipeline.
 *
 * Lives in an offscreen document because `MediaRecorder`, `getUserMedia` and
 * `AudioContext` all need a DOM context and a service worker has none.
 *
 * The shape that matters is the **AudioContext tee**. `chrome.tabCapture`
 * mutes the tab unless its audio is routed through an AudioContext and back to
 * the destination — which conveniently forces the right design. One context
 * takes tab audio and mic, and splits into two branches:
 *
 *   1. mixed into the single `MediaRecorder`, so video and audio share one
 *      timebase and never need demuxing;
 *   2. an `AudioWorklet` tap emitting 16kHz mono PCM for Whisper.
 *
 * One recorder, one clock. `t0` is `Date.now()` sampled synchronously at
 * `start()`, and frame 0 is never trusted as an anchor — tabCapture is
 * paint-driven, so on a static page frames are sparse.
 *
 * Design: docs/design/issues/07, /04, /08
 */

import { idbGet } from '../lib/idb';
import { advance, availableSamples, flatten, newCursor } from '../lib/pcm';
import { cleanSegments, toSpeechEvents } from '../lib/srt';
import type { PlannedFrame } from '../lib/frames';
import { extractFrames } from './frames';
import {
  DEFAULT_TIER,
  DEVICE,
  transformersEngine,
  type ModelTier,
  type TranscriptionEngine,
} from './transcribe';
import {
  installNativeSpeech,
  nativeSpeechStatus,
  startNativeSpeech,
  type NativeSpeechSession,
} from './native-speech';
import { selectEngine } from './hosted';
import {
  CHUNK_MS,
  pickMimeType,
  recorderOptions,
  tabStreamConstraints,
} from '../lib/recorder';
import {
  OFFSCREEN_ERROR,
  OFFSCREEN_FLUSH_VIDEO,
  OFFSCREEN_FRAMES,
  OFFSCREEN_SELF_TEST,
  OFFSCREEN_START,
  OFFSCREEN_ZIP,
  OFFSCREEN_STARTED,
  OFFSCREEN_STOP,
} from '../background/messages';

interface Live {
  recorder: MediaRecorder;
  context: AudioContext;
  streams: MediaStream[];
  writable: FileSystemWritableFileStream | null;
  /**
   * Serialises chunk writes.
   *
   * They were fire-and-forget, so `close()` could — and did — run before any of
   * them landed, producing a zero-byte video. Concurrent `write()` calls on one
   * writable are also not safe to interleave.
   */
  writes: Promise<void>;
  /** Kept only when there is nowhere to stream to. */
  /** Held only when there is nowhere to stream to — see zipSession(). */
  buffered: Blob[];
  pcm: Float32Array[];
  bytes: number;
  /** Drives rolling live transcription. */
  liveTimer: number;
  /** Chrome's on-device pass, when it is doing the live work instead of Whisper. */
  native: NativeSpeechSession | null;
}

let live: Live | null = null;

/**
 * The recording, when it could not be streamed to disk.
 *
 * Only populated in the fallback path, and this is exactly the memory ceiling
 * the File System Access API was chosen to escape — so it is held for as short
 * a time as possible and dropped the moment the zip is built.
 */
let lastBuffered: Blob[] = [];

/** Set at start, because it cannot be read from here. */
let tier: ModelTier = DEFAULT_TIER;

/** Set at start, same reason as `tier`. Empty means transcribe locally. */
let apiKey = '';

/**
 * Hosted when a key is configured, local otherwise.
 *
 * Not a fallback chain. A hosted failure throws rather than quietly retrying
 * locally, because the local path is a ~105MB model download this session has
 * deliberately not paid for — starting one mid-recording to rescue a failed
 * window would cost more than the window. A failed live window is lost and the
 * next one continues; a failed pass at stop is recorded as `transcriptError`.
 */
/**
 * The authoritative pass — hosted when a key is set, local otherwise.
 *
 * This is the one whose text survives: provisional lines are replaced wholesale
 * at stop, so this is where accuracy is worth paying for.
 */
function finalEngine(): TranscriptionEngine {
  return selectEngine(apiKey, tier);
}

/**
 * The live pass is local, always, even with a key set.
 *
 * Running it hosted uploaded the session twice — every 30s window, and then the
 * whole recording again at stop — for output that is discarded by construction:
 * every live line is `provisional` and superseded. Twelve minutes of narration
 * billed as twenty-four, and the extra twelve bought nothing.
 *
 * It also happens to be the right split on the merits. The live pass is the
 * approximate one by design; the local model is the approximate engine. Cheap
 * and now, then accurate at stop.
 */
function liveEngine(): TranscriptionEngine {
  return transformersEngine(tier);
}

/**
 * Consecutive live-window failures.
 *
 * A bad key fails identically every time, so one report is the whole story and
 * a report per window would be thirty of them.
 */
let liveFailures = 0;
const LIVE_FAILURE_REPORT_AT = 2;

/**
 * Rolling live transcription.
 *
 * Thirty seconds, because that is what Whisper's encoder processes no matter
 * what it is handed — the mel input is a fixed 30s window and anything shorter
 * is padded to fill it. Ten seconds therefore cost exactly what thirty costs
 * and bought a third of the audio, which is how the live pass ended up running
 * at roughly a fifteenth of realtime: two windows in a 148-second session.
 *
 * Longer is also better text, because Whisper leans on context and a clipped
 * window has less of it. The price is latency — nothing is emitted until thirty
 * seconds of narration exist. Everything here is provisional and superseded at
 * stop, so boundary damage is acceptable by construction, but it is real: a
 * word split across two windows is mangled in both.
 */
const LIVE_WINDOW_SAMPLES = 16_000 * 30;

/** Samples already sent to the live pass, counted from the start of the session. */
let liveOffset = 0;
let liveBusy = false;

/** `MediaRecorder.start()`, in epoch ms. The clock every `t` is measured from. */
let t0 = 0;

/** Ticks that produced no window, for the heartbeat above. */
let liveWaits = 0;

/**
 * speech.ndjson, owned here rather than by the worker.
 *
 * Narration used to travel to the service worker as a message and be written
 * alongside events. Owning the file here means the two pipelines share nothing
 * but the clock: no message traffic, no shared array, no shared write queue.
 */
let speechStream: { file: FileSystemFileHandle; bytes: number } | null = null;
let speechWrites: Promise<void> = Promise.resolve();

function appendSpeech(lines: string[]): void {
  if (!speechStream || !lines.length) return;
  const batch = lines.join('\n') + '\n';
  speechWrites = speechWrites.then(async () => {
    try {
      const w = await speechStream!.file.createWritable({ keepExistingData: true });
      await w.seek(speechStream!.bytes);
      await w.write(batch);
      await w.close();
      speechStream!.bytes += new TextEncoder().encode(batch).length;
    } catch (e) {
      // A failed narration write costs narration. Capture is unaffected, which
      // is the entire point of keeping these apart — but "costs narration"
      // silently is how a 0-byte speech.ndjson reads as "nobody said anything".
      console.warn('[bugcast] narration write failed', e);
    }
  });
}

/**
 * How far the live pass has read. See `lib/pcm` for why this is a cursor and
 * not, as it once was, a destructive shift off the front of the buffer.
 */
let cursor = newCursor();

async function transcribeLiveWindow(state: Live): Promise<void> {
  if (liveBusy) return; // a window still running; the next tick will catch up
  const available = availableSamples(state.pcm, cursor);
  if (available - liveOffset < LIVE_WINDOW_SAMPLES) {
    // Says which kind of "not yet" this is.
    //
    // An empty speech.ndjson has three causes that look identical from the
    // artifact: the model is still downloading, the microphone was never
    // granted so the tap has nothing to give, or a window threw. Reporting the
    // buffer every thirty seconds separates the second from the other two —
    // audio stuck at 0.0s is a microphone that is not connected, and audio
    // climbing while nothing is emitted is the model still coming down.
    if (++liveWaits % 15 === 0) {
      console.debug(
        `[bugcast] no window yet — ${(available / 16_000).toFixed(1)}s of mic audio buffered, ` +
          `need ${LIVE_WINDOW_SAMPLES / 16_000}s past ${(liveOffset / 16_000).toFixed(0)}s`,
      );
    }
    return;
  }

  liveBusy = true;
  const from = liveOffset;
  const to = from + LIVE_WINDOW_SAMPLES;
  liveOffset = to;
  const startedAt = performance.now();
  try {
    const window = flatten(state.pcm, from, to, cursor);

    // Move past what this window consumed. Nothing is deleted: stop()
    // transcribes this same buffer, from the beginning of the session.
    advance(state.pcm, to, cursor);

    const active = liveEngine();
    const segments = cleanSegments(
      await active.transcribe(window, (from / 16_000) * 1000),
    );

    // Measured, because "the live pass is slow" was a complaint nobody had a
    // number for. A window that takes longer than the audio it covers means
    // the live pass is losing ground and will never catch up.
    const took = Math.round(performance.now() - startedAt);
    const covers = LIVE_WINDOW_SAMPLES / 16;
    console.debug(
      `[bugcast] live window ${(from / 16_000).toFixed(0)}s–${(to / 16_000).toFixed(0)}s: ` +
        `${took}ms for ${covers}ms of audio (${(took / covers).toFixed(2)}x realtime, ` +
        `${segments.length} segments, ${active.name})${took > covers ? ' — LOSING GROUND' : ''}`,
    );
    liveFailures = 0;
    if (segments.length) {
      appendSpeech(
        toSpeechEvents(segments, '').map((e) => JSON.stringify({ ...e, provisional: true })),
      );
    }
  } catch (e) {
    // A failed window still costs that window and nothing else — the
    // authoritative pass at stop reads the whole audio regardless. What changed
    // is that it no longer costs the *reason*.
    //
    // This block used to be bare, and an empty speech.ndjson therefore looked
    // identical whether the model was still downloading, the microphone was
    // never granted, a window had thrown, or — since the hosted engine landed —
    // the API key was typo'd, expired, or rate-limited. Several different
    // problems, one symptom, no way to tell them apart from the artifact. The
    // hosted ones are the sharpest, because none of them are transient: they
    // produce ten minutes of silence and no explanation if nobody is told.
    // AGENTS.md: refuse, don't degrade.
    liveFailures++;
    console.warn(`[bugcast] live window at ${(from / 16_000).toFixed(0)}s failed`, e);
    if (liveFailures === LIVE_FAILURE_REPORT_AT) {
      void chrome.runtime.sendMessage({
        type: OFFSCREEN_ERROR,
        error: `Live transcription is failing: ${String((e as Error)?.message ?? e)}`,
      });
    }
  } finally {
    liveBusy = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  const handlers: Record<string, () => Promise<unknown>> = {
    [OFFSCREEN_START]: () => start(msg),
    [OFFSCREEN_STOP]: () => stop(),
    [OFFSCREEN_FLUSH_VIDEO]: () => flushVideo(msg.sessionId),
    [OFFSCREEN_FRAMES]: () => frames(msg),
    [OFFSCREEN_SELF_TEST]: () => selfTest(msg.check, msg.tier ?? DEFAULT_TIER),
    [OFFSCREEN_ZIP]: () => zipSession(msg),
  };
  const run = handlers[msg.type];
  if (!run) return;
  const handler = run();
  handler.then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});

async function start(msg: {
  streamId: string;
  sessionId: string;
  withMic: boolean;
  /**
   * Passed in, never read here.
   *
   * `chrome.storage` is NOT available inside a real offscreen document, and the
   * failure is `Cannot read properties of undefined (reading 'local')` — which
   * names nothing useful. Note that a *tab* navigated to offscreen.html does
   * have chrome.storage, so probing one to check the other says the opposite of
   * the truth. Same reason the popup passes tabId and pageUrl to the worker.
   */
  tier: ModelTier;
  /** Same reason as `tier`. Empty means transcribe locally. */
  openaiApiKey?: string;
  /** Empty means the system default input. */
  micDeviceId?: string;
  liveTranscription?: boolean;
}): Promise<unknown> {
  if (live) return { error: 'Already recording.' };

  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
  // Fail loudly rather than silently producing an unplayable file.
  if (!mimeType) throw new Error('This browser supports none of the WebM profiles bugcast records.');

  const tabStream = await navigator.mediaDevices.getUserMedia(tabStreamConstraints(msg.streamId));

  let micStream: MediaStream | null = null;
  let micError: string | null = null;
  if (msg.withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // `exact` deliberately: silently falling back to a different
          // microphone than the one chosen is worse than failing, because the
          // result is a transcript of the wrong room.
          ...(msg.micDeviceId ? { deviceId: { exact: msg.micDeviceId } } : {}),
          // Explicit, not default. Tab audio plays through the speakers while
          // recording, so without echo cancellation the mic re-records it;
          // and Whisper is markedly worse on an un-gained, noisy signal.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (e) {
      // Narration is optional by design: no mic simply means no .srt, and it
      // must not cost the recording. But the reason travels back, because an
      // offscreen document has no UI and so can never *prompt* — if the grant
      // does not already exist this fails with "Permission dismissed", and
      // silently producing no transcript is indistinguishable from a bug.
      micStream = null;
      micError = String((e as Error)?.name ?? e);
    }
  }

  const { recorder, context, pcm } = await buildPipeline(tabStream, micStream, mimeType);

  // A failure here is not fatal — chunks buffer in memory and are flushed at
  // stop instead — but it must be *reported*, because the buffered path is the
  // one that used to lose the video entirely.
  speechStream = await openSpeechStream(msg.sessionId).catch(() => null);
  liveOffset = 0;
  liveFailures = 0;
  liveWaits = 0;
  cursor = newCursor();

  let streamError: string | null = null;
  const writable = await openSessionStream(msg.sessionId).catch((e) => {
    streamError = String((e as Error)?.message ?? e);
    return null;
  });
  const state: Live = {
    recorder,
    context,
    streams: [tabStream, micStream].filter(Boolean) as MediaStream[],
    writable,
    writes: Promise.resolve(),
    buffered: [],
    pcm,
    bytes: 0,
    liveTimer: 0,
    native: null,
  };

  state.recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    state.bytes += e.data.size;
    // Streamed straight to disk. Buffering the session in memory is what the
    // File System Access API was chosen to avoid — ~170MB for fifteen minutes.
    if (state.writable) {
      const chunk = e.data;
      state.writes = state.writes.then(async () => {
        await state.writable!.write(await chunk.arrayBuffer());
      });
    } else state.buffered.push(e.data);
  };
  state.recorder.onerror = (e) => {
    void chrome.runtime.sendMessage({ type: OFFSCREEN_ERROR, error: String(e) });
  };

  // t0 is sampled synchronously with start() and nowhere else. Measured skew
  // from the first frame is one frame interval, but tabCapture is paint-driven,
  // so on a static page frame 0 can be seconds stale — never anchor on it.
  liveOffset = 0;
  liveBusy = false;
  // Off means the session still gets a full transcript at stop — it just is not
  // readable while recording, and the CPU stays with the app under test.
  state.recorder.start(CHUNK_MS);
  t0 = Date.now();
  // The tap has been live since it was connected, a few milliseconds before
  // this. Dropping what it collected makes the audio buffer start at t0 exactly
  // — cheaper and more honest than carrying an offset nobody can verify.
  state.pcm.length = 0;

  live = state;
  tier = msg.tier ?? DEFAULT_TIER;

  // The live pass, if it was asked for. Off means the session still gets a full
  // transcript at stop — it just is not readable while recording, and the CPU
  // stays with the app under test.
  //
  // Chrome's on-device recogniser is preferred when it is ready, for one
  // reason: latency. Whisper spends thirty seconds of encoder work on a
  // thirty-second window, so narration reaches a following agent long after it
  // was said, and "follow along live" stops meaning anything. Chrome returns a
  // phrase about as fast as you finish it.
  //
  // Whatever it produces is provisional and replaced wholesale at stop, so the
  // looser timestamps it carries never reach the transcript that is kept.
  if (msg.liveTranscription !== false) {
    const status = await nativeSpeechStatus().catch(() => 'unavailable' as const);
    if (status === 'available') {
      state.native = startNativeSpeech(
        () => Date.now() - t0,
        (line) =>
          appendSpeech([
            JSON.stringify({
              type: 'speech',
              t: line.t,
              tEnd: line.tEnd,
              pageUrl: '',
              text: line.text,
              provisional: true,
            }),
          ]),
      );
    } else if (status === 'downloadable') {
      // Fetched for next time. This session falls back rather than waiting on a
      // download, which is the mistake the Whisper model already taught us.
      void installNativeSpeech();
    }

    if (!state.native) {
      console.debug(`[bugcast] live pass: Whisper (on-device speech is "${status}")`);
      state.liveTimer = setInterval(
        () => void transcribeLiveWindow(state),
        2_000,
      ) as unknown as number;
    } else {
      console.debug('[bugcast] live pass: Chrome on-device speech');
    }
  }
  apiKey = msg.openaiApiKey ?? '';
  return {
    type: OFFSCREEN_STARTED,
    t0,
    mimeType,
    withMic: Boolean(micStream),
    micError,
    streamError,
  };
}

async function stop(): Promise<unknown> {
  const state = live;
  live = null;
  if (!state) return { ok: true };

  clearInterval(state.liveTimer);
  state.native?.stop();
  await speechWrites;
  await new Promise<void>((resolve) => {
    state.recorder.onstop = () => resolve();
    if (state.recorder.state === 'inactive') resolve();
    else state.recorder.stop();
  });

  for (const stream of state.streams) for (const track of stream.getTracks()) track.stop();
  await state.context.close();
  // Every queued chunk must land before the file is closed.
  await state.writes.catch((e) => console.error('[bugcast] chunk write failed', e));
  await state.writable?.close();

  // One flat buffer for the transcription engine (#6).
  //
  // The whole session, from t0 — which is why the live pass moves a cursor
  // instead of shifting chunks off the front. It ate this buffer once, and the
  // authoritative pass silently transcribed only the leftovers and stamped them
  // from zero. `transcribe(samples, 0)` is correct precisely because sample 0
  // here is still sample 0 of the recording.
  const total = state.pcm.reduce((n, chunk) => n + chunk.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of state.pcm) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }


  // Post-hoc, not streaming: ten minutes transcribes in under a minute either
  // way, so a streaming pipeline would be complexity bought for nothing.
  let segments: ReturnType<typeof cleanSegments> = [];
  let transcriptError: string | null = null;
  try {
    segments = cleanSegments(await finalEngine().transcribe(samples, 0));
  } catch (e) {
    // No speech means no .srt, and a transcription failure must not cost the
    // session — every other artifact is already complete by this point.
    transcriptError = String((e as Error)?.message ?? e);
  }

  return {
    ok: true,
    bytes: state.bytes,
    pcmSamples: total,
    videoWritten: state.writable !== null,
    // Held in memory because the stream could not be opened at start. The
    // worker asks for a flush once it knows the folder is usable.
    videoBuffered: lastBuffered.length > 0,
    segments,
    transcriptError,
  };
}

/**
 * The AudioContext tee, built around whatever stream it is handed.
 *
 * Exported and source-agnostic on purpose: `tabCapture` needs an activeTab
 * grant that only a real toolbar click produces, so the smoke harness drives
 * this exact function with a canvas+oscillator stream instead. Testing the real
 * pipeline from a different source beats not testing it.
 */
export async function buildPipeline(
  tabStream: MediaStream,
  micStream: MediaStream | null,
  mimeType: string,
): Promise<{ recorder: MediaRecorder; context: AudioContext; pcm: Float32Array[] }> {
  // Native rate, not 16k — the recorder branch keeps full audio quality, and
  // the worklet decimates only for its own branch.
  const context = new AudioContext();
  // No web_accessible_resources entry, deliberately. An extension page loads
  // its own resources without one — and declaring it with `use_dynamic_url`
  // actively breaks this: the dynamic URL is a different *origin*
  // (chrome-extension://<uuid>/ rather than <extension-id>), and AudioWorklet
  // modules are same-origin restricted, so addModule fails with a bare
  // "Unable to load a worklet's module" while a plain fetch of the same URL
  // returns 200. Removing the entry also drops <all_urls> from the manifest.
  await context.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));

  // The routing matters more than it looks, and getting it wrong is audible.
  //
  //   tab ──┬─> recorder        (you want to hear the app in the video)
  //         └─> speakers        (tabCapture mutes the tab otherwise)
  //   mic ──┬─> recorder
  //         └─> Whisper         (mic ONLY — never the speakers)
  //
  // Routing the mic to the speakers is a feedback loop, and feeding tab audio
  // into Whisper asks it to transcribe your narration over the top of whatever
  // the page is playing. The first version did both.
  const sink = context.createMediaStreamDestination();
  const tap = new AudioWorkletNode(context, 'pcm-tap');

  if (tabStream.getAudioTracks().length) {
    const tab = context.createMediaStreamSource(tabStream);
    tab.connect(sink);
    tab.connect(context.destination);
  }

  if (micStream?.getAudioTracks().length) {
    const mic = context.createMediaStreamSource(micStream);
    mic.connect(sink);
    // The transcript is the narration. Nothing else reaches the model.
    mic.connect(tap);
  }
  const pcm: Float32Array[] = [];
  tap.port.onmessage = (e) => pcm.push(e.data as Float32Array);

  const composed = new MediaStream([
    ...tabStream.getVideoTracks(),
    ...sink.stream.getAudioTracks(),
  ]);

  return { recorder: new MediaRecorder(composed, recorderOptions(mimeType)), context, pcm };
}

/**
 * Extract the frame index, after the timeline is final.
 *
 * Runs here rather than in the worker because it needs a <video>, a canvas and
 * `requestVideoFrameCallback`, none of which exist in a service worker.
 */
/**
 * Write the recording that had to be buffered.
 *
 * The streaming path is the normal one; this exists for when opening the file
 * at record start failed — most often a File System Access grant that lapsed
 * between choosing the folder and pressing Record. Without it those chunks were
 * simply discarded at stop, which is how a session arrived complete except for
 * the video.
 */
async function flushVideo(sessionId: string): Promise<unknown> {
  if (!lastBuffered.length) return { ok: true, bytes: 0 };
  const blob = new Blob(lastBuffered, { type: 'video/webm' });

  const dir = await idbGet<FileSystemDirectoryHandle>('sessionDirectory');
  if (!dir) return { ok: false, error: 'No sessions folder' };

  const folder = await dir.getDirectoryHandle(sessionId, { create: true });
  const file = await folder.getFileHandle('video.webm', { create: true });
  const writable = await file.createWritable();
  await writable.write(await blob.arrayBuffer());
  await writable.close();

  lastBuffered = [];
  return { ok: true, bytes: blob.size };
}

async function frames(msg: { sessionId: string; plan: PlannedFrame[] }): Promise<unknown> {
  if (!msg.plan?.length) return { written: 0, missed: 0 };

  const dir = await idbGet<FileSystemDirectoryHandle>('sessionDirectory');
  if (!dir) return { written: 0, missed: msg.plan.length, error: 'No sessions folder' };

  const folder = await dir.getDirectoryHandle(msg.sessionId, { create: true });
  const handle = await folder.getFileHandle('video.webm').catch(() => null);
  if (!handle) return { written: 0, missed: msg.plan.length, error: 'No recording to extract from' };

  const video = await handle.getFile();
  return extractFrames(video, msg.plan, async (relPath, image) => {
    // `frames/000012340-click.jpg` — one nested segment to create.
    const [dirName, fileName] = relPath.split('/');
    const target = await folder.getDirectoryHandle(dirName!, { create: true });
    const file = await target.getFileHandle(fileName!, { create: true });
    const writable = await file.createWritable();
    await writable.write(await image.arrayBuffer());
    await writable.close();
  });
}

/**
 * The two checks that need a DOM.
 *
 * `capture` builds the real pipeline from a synthetic stream rather than
 * tabCapture — the point is to prove the worklet loads, the tee wires up and
 * MediaRecorder produces bytes, none of which depend on where the pixels came
 * from, and tabCapture needs an activeTab grant this context does not have.
 */
async function selfTest(
  check: 'capture' | 'asr' | 'mic',
  tier: ModelTier,
): Promise<{ detail: string } | { error: string }> {
  try {
    if (check === 'mic') {
      // An offscreen document has no UI, so it cannot show a permission prompt.
      // If the grant does not already exist, this is where it fails.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = stream.getAudioTracks().length;
      for (const t of stream.getTracks()) t.stop();
      return { detail: `microphone available (${tracks} track)` };
    }

    if (check === 'capture') {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 120;
      const paint = canvas.getContext('2d')!;
      // Repainted on an interval, not once and not via requestAnimationFrame.
      // captureStream only emits a frame when the canvas actually changes, and
      // rAF is throttled to nothing in a document that is not visible — which
      // an offscreen document never is. Painting once makes this check pass or
      // fail on timing luck.
      let tick = 0;
      const repaint = setInterval(() => {
        paint.fillStyle = tick++ % 2 ? '#000' : '#fff';
        paint.fillRect(0, 0, 160, 120);
      }, 50);

      const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
      if (!mimeType) throw new Error('No supported WebM profile in this browser');

      const audio = new AudioContext();
      const dest = audio.createMediaStreamDestination();
      const osc = audio.createOscillator();
      osc.connect(dest);
      osc.start();

      // The oscillator goes in as the MIC, not as tab audio: the Whisper tap
      // takes mic only, so passing it as tab would leave the tap silent and the
      // check would fail for the wrong reason. Video rides the tab branch.
      const tabOnly = new MediaStream(canvas.captureStream(15).getVideoTracks());
      const micOnly = new MediaStream(dest.stream.getAudioTracks());
      const { recorder, context, pcm } = await buildPipeline(tabOnly, micOnly, mimeType);

      let bytes = 0;
      recorder.ondataavailable = (e) => (bytes += e.data.size);
      recorder.start(200);
      await new Promise((r) => setTimeout(r, 1000));
      await new Promise<void>((r) => {
        recorder.onstop = () => r();
        recorder.stop();
      });
      clearInterval(repaint);
      osc.stop();
      await context.close();
      await audio.close();

      const samples = pcm.reduce((n, c) => n + c.length, 0);
      if (!bytes) throw new Error('MediaRecorder produced no data');
      if (!samples) throw new Error('The audio tap produced no samples');
      return { detail: `${(bytes / 1024).toFixed(0)}KB video, ${samples} audio samples` };
    }

    // Model load plus one inference. This is deliberately NOT an accuracy
    // check: shipping a speech clip to assert known text would be better, and
    // there is none to ship. What it does prove is the expensive, most
    // platform-dependent, most silently-failing step — that the model downloads
    // and inference completes at all. It also reports which backend was chosen
    // and how long it took, which is the WebGPU-vs-WASM measurement
    // docs/design/issues/13 deferred to real hardware.
    const started = performance.now();
    const silence = new Float32Array(16_000 * 2);
    await transformersEngine(tier).transcribe(silence, 0);
    return {
      detail: `${DEVICE}, first run (model download + inference) in ${((performance.now() - started) / 1000).toFixed(1)}s`,
    };
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
}

/**
 * The degraded path: one zip through chrome.downloads.
 *
 * Exists for enterprise policy, not user error — managed Chrome can disable
 * File System Access writes outright (DefaultFileSystemWriteGuardSetting),
 * which without this leaves a corporate user with a completely dead tool.
 *
 * One zip rather than two hundred files, because chrome.downloads would
 * otherwise mean two hundred shelf entries, and its default `uniquify`
 * collision handling appends " (1)" — silently invalidating every frame path
 * inside timeline.json.
 *
 * It cannot stream, so it re-inherits the memory ceiling FSA avoids. That is
 * the reason it is documented as degraded rather than as an equal option.
 */
async function zipSession(msg: {
  sessionId: string;
  files: Array<[name: string, contents: string]>;
}): Promise<unknown> {
  const { zipSync, strToU8 } = await import('fflate');

  const entries: Record<string, Uint8Array> = {};
  for (const [name, contents] of msg.files) entries[name] = strToU8(contents);

  if (lastBuffered.length) {
    const blob = new Blob(lastBuffered, { type: 'video/webm' });
    entries['video.webm'] = new Uint8Array(await blob.arrayBuffer());
    lastBuffered = [];
  }

  // level 0 for the webm — it is already compressed, and spending CPU to make
  // it 0.5% smaller is worse than not.
  const zipped = zipSync(entries, { level: 6 });

  // The URL crosses to the worker rather than the bytes. `chrome.downloads` is
  // not exposed to an offscreen document at all, and a blob URL is a handle —
  // sending the zip itself would mean serialising tens of megabytes through a
  // JSON message channel.
  const url = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
  return { ok: true, url, bytes: zipped.byteLength, files: Object.keys(entries).length };
}

async function openSpeechStream(
  session: string,
): Promise<{ file: FileSystemFileHandle; bytes: number } | null> {
  const dir = await idbGet<FileSystemDirectoryHandle>('sessionDirectory');
  if (!dir) return null;
  const folder = await dir.getDirectoryHandle(session, { create: true });
  const file = await folder.getFileHandle('speech.ndjson', { create: true });
  await (await file.createWritable()).close();
  return { file, bytes: 0 };
}

async function openSessionStream(session: string): Promise<FileSystemWritableFileStream> {
  // The handle only survives in IndexedDB — it cannot travel through
  // sendMessage, which is JSON-serialized. Same extension origin, so this
  // document reads it directly.
  const dir = await idbGet<FileSystemDirectoryHandle>('sessionDirectory');
  if (!dir) throw new Error('No sessions folder chosen');
  if ((await (dir as any).queryPermission({ mode: 'readwrite' })) !== 'granted') {
    throw new Error('No write permission for the sessions folder');
  }
  const folder = await dir.getDirectoryHandle(session, { create: true });
  const file = await folder.getFileHandle('video.webm', { create: true });
  return file.createWritable();
}

// Exposed for scripts/smoke.mjs only. tabCapture cannot be granted headlessly,
// so the harness reaches in here to drive the real pipeline with a synthetic
// stream. Nothing in the extension reads this.
(globalThis as unknown as Record<string, unknown>).__bugcastTestHooks = {
  buildPipeline,
  pickMimeType,
  extractFrames,
  transformersEngine,
};
