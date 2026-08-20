import { describe, expect, it } from 'vitest';
import { chunksToSegments, DEFAULT_TIER, MIN_SAMPLES, MODELS } from './transcribe';

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
