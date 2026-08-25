import { describe, expect, it } from 'vitest';
import { assertDtypeKeys, chunksToSegments, DTYPE, DEFAULT_TIER, MIN_SAMPLES, MODELS } from './transcribe';

describe('chunksToSegments', () => {
  it('converts seconds to milliseconds and offsets from t0', () => {
    const out = chunksToSegments([{ timestamp: [1.18, 4.02], text: ' Okay. ' }], 0, 10_000);
    expect(out).toEqual([{ start: 1180, end: 4020, text: ' Okay. ' }]);
  });

  it('shifts by the audio offset, so speech lines up with everything else', () => {
    const out = chunksToSegments([{ timestamp: [0, 1] as [number, number], text: 'x' }], 500, 5000);
    expect(out[0]).toEqual({ start: 500, end: 1500, text: 'x' });
  });

  it('survives a null end timestamp, which the final chunk can have', () => {
    const out = chunksToSegments([{ timestamp: [2, null], text: 'trailing' }], 0, 3500);
    expect(out[0]!.end).toBeGreaterThan(out[0]!.start);
    expect(Number.isFinite(out[0]!.end)).toBe(true);
  });

  it('is empty-safe', () => {
    expect(chunksToSegments([], 0, 0)).toEqual([]);
  });
});

describe('model configuration', () => {
  it('offers three tiers, all English-only — the default is base', () => {
    expect(Object.keys(MODELS)).toEqual(['tiny.en', 'base.en', 'small.en']);
    expect(DEFAULT_TIER).toBe('base.en');
  });

  it('skips transcription below a second of audio rather than downloading a model for silence', () => {
    expect(MIN_SAMPLES).toBe(16_000);
  });
});

describe('assertDtypeKeys', () => {
  it('accepts the shipped config', () => {
    expect(() => assertDtypeKeys(DTYPE)).not.toThrow();
  });

  // The whole point: transformers.js resolves per-module dtype by
  // hasOwnProperty and, on a miss, silently uses the device default — q8 on
  // wasm — which is the one config that fails Whisper session creation. A typo
  // must therefore fail loudly here rather than quietly there.
  it('refuses a typo that would silently become q8', () => {
    expect(() => assertDtypeKeys({ encoder_model: 'fp32', decoder_merged: 'q4' })).toThrow(/q8/);
    expect(() => assertDtypeKeys({ encoder: 'fp32', decoder_model_merged: 'q4' })).toThrow(/Unknown dtype key/);
  });

  it('refuses a missing module rather than letting it default', () => {
    expect(() => assertDtypeKeys({ encoder_model: 'fp32' })).toThrow(/decoder_model_merged/);
    expect(() => assertDtypeKeys({})).toThrow(/Missing dtype key/);
  });
});
