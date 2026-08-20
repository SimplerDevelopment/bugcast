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

let cached: Promise<any> | null = null;

async function load(tier: ModelTier): Promise<any> {
  const { env, pipeline } = await import('@huggingface/transformers');

  // Local runtime binaries. Without this transformers.js fetches them from a
  // CDN at first inference, which would put a network call in the middle of a
  // tool whose entire premise is that it runs locally.
  const wasm = env.backends?.onnx?.wasm;
  if (!wasm) throw new Error('transformers.js exposed no wasm backend to point at local binaries');
  wasm.wasmPaths = chrome.runtime.getURL('ort/');
  env.allowLocalModels = true;
  // The one documented exception to zero-network: the model itself downloads
  // once and caches forever. An offline path is loading it from disk instead.
  env.allowRemoteModels = true;

  // WebGPU where available, WASM otherwise. Deliberately not assumed to be
  // faster — one primary benchmark had WASM *beating* WebGPU for Whisper,
  // contradicting vendor claims, and docs/design/issues/13 deferred settling it
  // to a real measurement on real hardware (#11's self-test).
  const device = 'gpu' in navigator ? 'webgpu' : 'wasm';

  return pipeline('automatic-speech-recognition', MODELS[tier], {
    device: device as never,
    dtype: device === 'webgpu' ? ('fp32' as never) : ('q8' as never),
  });
}

export function transformersEngine(tier: ModelTier = DEFAULT_TIER): TranscriptionEngine {
  return {
    async transcribe(samples, t0Offset) {
      // No speech simply means no .srt. Mic is optional by design and must
      // never cost the recording.
      if (samples.length < MIN_SAMPLES) return [];

      cached ??= load(tier);
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
