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

let cached: Promise<any> | null = null;

/**
 * Report download progress.
 *
 * The first run fetches ~105MB for base.en, and without this the UI showed
 * "Running…" for minutes — indistinguishable from a hang, which is exactly how
 * it was reported. A number moving is the difference between waiting and
 * assuming something is broken.
 */
const downloading = new Map<string, { loaded: number; total: number }>();

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

  // Aggregated across files, not per-file. Several download in parallel and
  // each reports its own percentage, so forwarding those directly produced
  // 0 -> 10 -> 82 -> 35 — a number going backwards reads as a bug.
  let loaded = 0;
  let total = 0;
  for (const entry of downloading.values()) {
    loaded += entry.loaded;
    total += entry.total;
  }
  // The config and tokenizer files are a few KB and finish before the weights
  // start, so an aggregate over only those reads as 100% before the real
  // download has begun. Wait until there is something worth reporting.
  if (total < 1_000_000) return;

  void chrome.runtime
    .sendMessage({
      type: 'bugcast/model-progress',
      percent: Math.min(100, Math.round((loaded / total) * 100)),
      mb: Math.round(total / 1_000_000),
    })
    .catch(() => {});
}

async function load(tier: ModelTier, dtype: unknown = DTYPE): Promise<any> {
  const { env, pipeline } = await import('@huggingface/transformers');

  // Local runtime binaries. Without this transformers.js fetches them from a
  // CDN at first inference, which would put a network call in the middle of a
  // tool whose entire premise is that it runs locally.
  const wasm = env.backends?.onnx?.wasm;
  if (!wasm) throw new Error('transformers.js exposed no wasm backend to point at local binaries');
  wasm.wasmPaths = chrome.runtime.getURL('ort/');

  // Checked before use, because the failure otherwise is
  // "Failed to fetch dynamically imported module ... asyncify.mjs" — which
  // reads like a network problem and is a missing build step. dist/ort/ is
  // populated by scripts/copy-ort.mjs, which runs as part of `bun run build`
  // and NOT as part of a bare `vite build`, so a hand-run build silently ships
  // an extension whose transcription cannot start.
  await assertRuntimePresent();
  // No local models are bundled, so leaving this on makes transformers.js probe
  // /models/... for seven files first and log a "Failed to fetch" for each —
  // seven alarming console errors on a path that was always going to fall
  // through to the download. The offline story is a documented manual step, not
  // this default.
  env.allowLocalModels = false;
  // The one documented exception to zero-network: the model itself downloads
  // once and caches forever. An offline path is loading it from disk instead.
  env.allowRemoteModels = true;

  // WASM, not WebGPU, and pinned rather than auto-selected.
  //
  // WebGPU is not merely unproven here — the one primary benchmark in
  // docs/design/issues/03 had WASM beating it for Whisper — it also costs ~60MB
  // of extra runtime binaries in the extension download, because the WebGPU
  // path pulls in both the jsep and asyncify runtimes. Shipping only the WASM
  // runtime and then letting the code ask for WebGPU is how you get "no
  // available backend found" on a real machine, which is exactly what happened.
  //
  // If a real measurement ever favours WebGPU, both halves change together:
  // this line and scripts/copy-ort.mjs.
  return pipeline('automatic-speech-recognition', MODELS[tier], {
    device: DEVICE as never,
    dtype: dtype as never,
    progress_callback: reportProgress as never,
  });
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

      cached ??= load(tier, dtype);
      const asr = await cached;

      const out = await asr(samples, {
        return_timestamps: true,
        // Whisper's own window. The stride gives overlap so a word straddling
        // a boundary is not lost.
        chunk_length_s: 30,
        stride_length_s: 5,
      });

      const chunks = out?.chunks ?? [];
      if (!chunks.length && out?.text?.trim()) {
        // Some builds return only `text` when the audio is shorter than one
        // chunk. One segment spanning the audio is better than dropping it.
        return [{ start: t0Offset, end: t0Offset + (samples.length / 16) , text: out.text }];
      }
      return chunksToSegments(chunks, t0Offset, (samples.length / 16_000) * 1000);
    },
  };
}
