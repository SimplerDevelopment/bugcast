/**
 * Local transcription.
 *
 * In-extension transformers.js, no sidecar. That inversion was forced by a
 * fact: whisper.cpp ships **no macOS CLI binary, ever** — Ubuntu and Windows
 * only, macOS gets an xcframework — so a sidecar could not deliver one-command
 * install on the primary developer's own OS. The consequence is the property
 * worth protecting: install is "load the extension", with no compiler, no
 * per-platform binary and no terminal.
 *
 * The seam here is `engine → segments → SRT`, deliberately narrow, so a
 * bring-your-own-whisper.cpp engine can be bolted on later without any caller
 * changing.
 *
 * Design: docs/design/issues/07, /03
 */

import type { Segment } from '../lib/srt';

export interface TranscriptionEngine {
  /** @param samples mono PCM at 16kHz. @param t0Offset ms of session before audio began. */
  transcribe(samples: Float32Array, t0Offset: number): Promise<Segment[]>;
}

export type ModelTier = 'tiny.en' | 'base.en' | 'small.en';

export const MODELS: Record<ModelTier, string> = {
  'tiny.en': 'Xenova/whisper-tiny.en',
  'base.en': 'Xenova/whisper-base.en',
  'small.en': 'Xenova/whisper-small.en',
};

export const DEFAULT_TIER: ModelTier = 'base.en';

/**
 * The backend actually used. Exported so nothing can report a different one —
 * the self-test previously derived its own label from `'gpu' in navigator` and
 * cheerfully printed "webgpu" for a WASM run.
 */
export const DEVICE = 'wasm';

/**
 * Per-module, because Whisper's encoder and decoder do not quantize the same
 * way — and a uniform `q8` is specifically broken: it fails at session creation
 * with "Missing required scale ... TransposeDQWeightsForMatMulNBits", which
 * reads like a corrupt download and is a dtype mismatch.
 *
 * The encoder stays at full precision and only the decoder is quantised. The
 * encoder is what turns audio into features, so degrading it degrades every
 * word that follows — it is the wrong place to save bytes. `{encoder q8,
 * decoder q4}` was the first choice, purely on download size, and transcription
 * quality was reported as poor.
 *
 * The **q8 decoder** is separately broken — not a uniform q8 config, as first
 * assumed. Any config using `decoder_model_merged: 'q8'` fails session creation
 * with "Missing required scale ... TransposeDQWeightsForMatMulNBits", which
 * reads like a corrupt download and is a dtype mismatch. Verified working on
 * real hardware: all-`fp32`, all-`q4`, `{q8, q4}` and this.
 */
export const DTYPE = { encoder_model: 'fp32', decoder_model_merged: 'q4' };

/** Below this there is no speech worth a model download. */
export const MIN_SAMPLES = 16_000; // one second

/**
 * `chunks` from transformers.js carry `[start, end]` in **seconds**, and the
 * end can be `null` on the final chunk when the audio runs out mid-utterance.
 */
export function chunksToSegments(
  chunks: Array<{ timestamp: [number, number | null]; text: string }>,
  t0Offset: number,
  totalMs: number,
): Segment[] {
  // Rounded, because seconds-to-milliseconds is a float multiply (4.02 * 1000
  // is 4020.0000000000005) and the timeline is integer milliseconds.
  return chunks.map(({ timestamp: [start, end], text }) => ({
    start: Math.round(t0Offset + start * 1000),
    end: Math.round(t0Offset + (end === null ? totalMs / 1000 : end) * 1000),
    text,
  }));
}

/** The runtime files scripts/copy-ort.mjs is responsible for placing. */
const RUNTIME_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.asyncify.mjs'];

async function assertRuntimePresent(): Promise<void> {
  const missing: string[] = [];
  for (const file of RUNTIME_FILES) {
    const ok = await fetch(chrome.runtime.getURL(`ort/${file}`))
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) missing.push(file);
  }
  if (missing.length) {
    throw new Error(
      `Speech runtime missing from this build (${missing.join(', ')}). ` +
        'Rebuild with `bun run build` — a bare `vite build` skips the step that copies it.',
    );
  }
}

const downloading = new Map<string, { loaded: number; total: number }>();

/**
 * Report download progress, aggregated across files.
 *
 * Forwarded from the worker, because the worker has no extension APIs and so
 * cannot message the rest of the extension itself.
 *
 * Aggregated because several files download in parallel and each reports its
 * own percentage — forwarding those directly produced 0 -> 10 -> 82 -> 35, and
 * a number going backwards reads as a bug.
 */
function reportProgress(event: {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
}): void {
  if (!event?.file) return;
  if (event.status === 'progress' && typeof event.total === 'number') {
    downloading.set(event.file, { loaded: event.loaded ?? 0, total: event.total });
  } else if (event.status === 'done') {
    const entry = downloading.get(event.file);
    if (entry) entry.loaded = entry.total;
  } else {
    return;
  }

  let loaded = 0;
  let total = 0;
  for (const entry of downloading.values()) {
    loaded += entry.loaded;
    total += entry.total;
  }
  // The config and tokenizer are a few KB and finish before the weights start,
  // so an aggregate over only those reads as 100% before the real download has
  // begun.
  if (total < 1_000_000) return;

  void chrome.runtime
    .sendMessage({
      type: 'bugcast/model-progress',
      percent: Math.min(100, Math.round((loaded / total) * 100)),
      mb: Math.round(total / 1_000_000),
    })
    .catch(() => {});
}

let worker: Worker | null = null;
let loaded: Promise<void> | null = null;
let nextId = 0;
const inflight = new Map<number, (value: { chunks: any[]; text: string; error?: string }) => void>();

/**
 * The worker, started once and kept.
 *
 * Starting it lazily rather than at record time matters: the model load is the
 * expensive part and a session with no narration should never pay it.
 */
function ensureWorker(tier: ModelTier, dtype: unknown): Promise<void> {
  if (loaded) return loaded;

  // Checked here rather than in the worker: this side has the extension APIs,
  // and a missing runtime should say so instead of surfacing as an opaque
  // worker failure.
  const runtimeReady = assertRuntimePresent();

  worker = new Worker(chrome.runtime.getURL('whisper-worker.js'), { type: 'module' });
  worker.onmessage = (e: MessageEvent<any>) => {
    const msg = e.data;
    if (msg?.type === 'progress') return reportProgress(msg.event ?? {});
    if (msg?.type === 'result') {
      inflight.get(msg.id)?.(msg);
      inflight.delete(msg.id);
    }
  };

  loaded = new Promise<void>((resolve, reject) => {
    const onReady = (e: MessageEvent<any>) => {
      if (e.data?.type !== 'ready') return;
      worker!.removeEventListener('message', onReady);
      if (e.data.error) {
        loaded = null;
        reject(new Error(e.data.error));
      } else resolve();
    };
    worker!.addEventListener('message', onReady);
    void runtimeReady.catch((e) => {
      loaded = null;
      reject(e);
    });
    worker!.postMessage({
      type: 'load',
      model: MODELS[tier],
      dtype,
      // Extension APIs do not exist in a worker, so the runtime path is
      // resolved here and handed over.
      wasmPath: chrome.runtime.getURL('ort/'),
    });
  });

  return loaded;
}

export function transformersEngine(
  tier: ModelTier = DEFAULT_TIER,
  dtype: unknown = DTYPE,
): TranscriptionEngine {
  return {
    async transcribe(samples, t0Offset) {
      // No speech simply means no .srt. Mic is optional by design and must
      // never cost the recording.
      if (samples.length < MIN_SAMPLES) return [];

      await ensureWorker(tier, dtype);

      const id = ++nextId;
      const out = await new Promise<{ chunks: any[]; text: string; error?: string }>((resolve) => {
        inflight.set(id, resolve);
        // Transferred, not copied: a ten-second window is ~640KB and this runs
        // repeatedly during a session.
        worker!.postMessage({ type: 'transcribe', id, samples, offsetMs: t0Offset }, [
          samples.buffer,
        ]);
      });
      if (out.error) throw new Error(out.error);

      if (!out.chunks.length && out.text?.trim()) {
        // Some builds return only `text` when the audio is shorter than one
        // chunk. One segment spanning the audio beats dropping it.
        return [{ start: t0Offset, end: t0Offset + samples.length / 16, text: out.text }];
      }
      return chunksToSegments(out.chunks, t0Offset, (samples.length / 16_000) * 1000);
    },
  };
}
