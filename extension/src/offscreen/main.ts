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
import { cleanSegments } from '../lib/srt';
import { DEFAULT_TIER, transformersEngine, type ModelTier } from './transcribe';
import {
  CHUNK_MS,
  pickMimeType,
  recorderOptions,
  tabStreamConstraints,
} from '../lib/recorder';
import {
  OFFSCREEN_ERROR,
  OFFSCREEN_START,
  OFFSCREEN_STARTED,
  OFFSCREEN_STOP,
} from '../background/messages';

interface Live {
  recorder: MediaRecorder;
  context: AudioContext;
  streams: MediaStream[];
  writable: FileSystemWritableFileStream | null;
  /** Kept only when there is nowhere to stream to. */
  buffered: Blob[];
  pcm: Float32Array[];
  bytes: number;
}

let live: Live | null = null;

/**
 * The last session's audio, kept here rather than sent anywhere.
 *
 * Transcription (#6) runs in *this* document, because transformers.js needs a
 * DOM and WebGPU — so shipping tens of megabytes of Float32 across a message
 * boundary to the worker and back would be pure loss.
 */
export let lastSamples: Float32Array = new Float32Array(0);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type !== OFFSCREEN_START && msg.type !== OFFSCREEN_STOP) return;
  const handler = msg.type === OFFSCREEN_START ? start(msg) : stop();
  handler.then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true;
});

async function start(msg: {
  streamId: string;
  sessionId: string;
  withMic: boolean;
}): Promise<unknown> {
  if (live) return { error: 'Already recording.' };

  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
  // Fail loudly rather than silently producing an unplayable file.
  if (!mimeType) throw new Error('This browser supports none of the WebM profiles bugcast records.');

  const tabStream = await navigator.mediaDevices.getUserMedia(tabStreamConstraints(msg.streamId));

  let micStream: MediaStream | null = null;
  if (msg.withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Narration is optional by design: no mic simply means no .srt. It must
      // not cost the recording.
      micStream = null;
    }
  }

  const { recorder, context, pcm } = await buildPipeline(tabStream, micStream, mimeType);

  const writable = await openSessionStream(msg.sessionId).catch(() => null);
  const state: Live = {
    recorder,
    context,
    streams: [tabStream, micStream].filter(Boolean) as MediaStream[],
    writable,
    buffered: [],
    pcm,
    bytes: 0,
  };

  state.recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    state.bytes += e.data.size;
    // Streamed straight to disk. Buffering the session in memory is what the
    // File System Access API was chosen to avoid — ~170MB for fifteen minutes.
    if (state.writable) void e.data.arrayBuffer().then((b) => state.writable!.write(b));
    else state.buffered.push(e.data);
  };
  state.recorder.onerror = (e) => {
    void chrome.runtime.sendMessage({ type: OFFSCREEN_ERROR, error: String(e) });
  };

  // t0 is sampled synchronously with start() and nowhere else. Measured skew
  // from the first frame is one frame interval, but tabCapture is paint-driven,
  // so on a static page frame 0 can be seconds stale — never anchor on it.
  state.recorder.start(CHUNK_MS);
  const t0 = Date.now();
  // The tap has been live since it was connected, a few milliseconds before
  // this. Dropping what it collected makes the audio buffer start at t0 exactly
  // — cheaper and more honest than carrying an offset nobody can verify.
  state.pcm.length = 0;

  live = state;
  return { type: OFFSCREEN_STARTED, t0, mimeType, withMic: Boolean(micStream) };
}

async function stop(): Promise<unknown> {
  const state = live;
  live = null;
  if (!state) return { ok: true };

  await new Promise<void>((resolve) => {
    state.recorder.onstop = () => resolve();
    if (state.recorder.state === 'inactive') resolve();
    else state.recorder.stop();
  });

  for (const stream of state.streams) for (const track of stream.getTracks()) track.stop();
  await state.context.close();
  await state.writable?.close();

  // One flat buffer for the transcription engine (#6).
  const total = state.pcm.reduce((n, chunk) => n + chunk.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of state.pcm) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  lastSamples = samples;

  // Post-hoc, not streaming: ten minutes transcribes in under a minute either
  // way, so a streaming pipeline would be complexity bought for nothing.
  let segments: ReturnType<typeof cleanSegments> = [];
  let transcriptError: string | null = null;
  try {
    const tier = await storedTier();
    segments = cleanSegments(await transformersEngine(tier).transcribe(samples, 0));
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

  const mixed = context.createGain();
  for (const stream of [tabStream, micStream]) {
    if (stream && stream.getAudioTracks().length) {
      context.createMediaStreamSource(stream).connect(mixed);
    }
  }

  // Branch 1 — back out to the recorder AND to the speakers. Without the
  // second connection chrome.tabCapture leaves the tab silent for the whole
  // session, which is the most obvious possible way to make a QA tool unusable.
  const sink = context.createMediaStreamDestination();
  mixed.connect(sink);
  mixed.connect(context.destination);

  // Branch 2 — the Whisper tap.
  const tap = new AudioWorkletNode(context, 'pcm-tap');
  mixed.connect(tap);
  const pcm: Float32Array[] = [];
  tap.port.onmessage = (e) => pcm.push(e.data as Float32Array);

  const composed = new MediaStream([
    ...tabStream.getVideoTracks(),
    ...sink.stream.getAudioTracks(),
  ]);

  return { recorder: new MediaRecorder(composed, recorderOptions(mimeType)), context, pcm };
}

async function storedTier(): Promise<ModelTier> {
  const stored = await chrome.storage.local.get('modelTier');
  return (stored?.modelTier as ModelTier) ?? DEFAULT_TIER;
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
};
