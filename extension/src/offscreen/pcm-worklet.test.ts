import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The worklet is plain JS in public/ because an AudioWorklet is loaded by URL
 * into its own global scope and cannot be bundled. So it is read and evaluated
 * here rather than imported — the file under test is the file that ships.
 */
function processorAt(rate: number): any {
  const src = readFileSync(new URL('../../public/pcm-worklet.js', import.meta.url), 'utf8');
  let Processor: any;
  class AudioWorkletProcessor {
    port = { postMessage: () => {} };
  }
  new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    src,
  )(AudioWorkletProcessor, (_n: string, cls: any) => (Processor = cls), rate);
  return Processor;
}

/** Feed a signal through in 128-frame render quanta, as the browser would. */
function resample(rate: number, signal: Float32Array): Float32Array {
  const processor = new (processorAt(rate))();
  const out: number[] = [];
  processor.port = { postMessage: (b: Float32Array) => out.push(...Array.from(b)) };
  for (let i = 0; i < signal.length; i += 128) {
    processor.process([[signal.subarray(i, Math.min(i + 128, signal.length))]]);
  }
  // Whatever has not reached a full 1024-frame buffer yet still counts.
  for (let i = 0; i < processor.filled; i++) out.push(processor.out[i]);
  return Float32Array.from(out);
}

const tone = (hz: number, rate: number, seconds: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) =>
    Math.sin((2 * Math.PI * hz * i) / rate),
  );

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('the Whisper tap resamples to a real 16kHz', () => {
  // The bug this pins: `Math.round(sampleRate / 16000)` is 3 for 44100 as well
  // as 48000, so a 44.1kHz device produced 14700Hz audio labelled 16000Hz —
  // every word 8.1% slow, and `t = samples / 16000` wrong by the same 8.1%.
  it.each([48000, 44100, 96000, 88200, 32000])('emits 16k samples/sec at %i Hz in', (rate) => {
    const seconds = 2;
    const got = resample(rate, tone(440, rate, seconds));
    // Within a few samples of exact: the filter's group delay costs a fraction
    // of a millisecond at the start.
    expect(Math.abs(got.length - 16000 * seconds)).toBeLessThan(200);
  });
});

describe('the Whisper tap band-limits before it decimates', () => {
  it('passes speech-band content essentially untouched', () => {
    const got = resample(48000, tone(1000, 48000, 0.5));
    // Unity gain in the passband; the sine's own RMS is 1/sqrt(2).
    expect(rms(got.subarray(2000))).toBeGreaterThan(0.6);
  });

  it('keeps the fricative band, which is what tells /s/ from /f/', () => {
    const got = resample(48000, tone(6000, 48000, 0.5));
    expect(rms(got.subarray(2000))).toBeGreaterThan(0.5);
  });

  // 12kHz is above the 8kHz output Nyquist, so without a filter it folds down
  // to 4kHz — the middle of the speech band. The three-tap box average this
  // replaced attenuated it by 9.5dB, which is nowhere near enough.
  it('rejects what would otherwise alias into the speech band', () => {
    const got = resample(48000, tone(12000, 48000, 0.5));
    expect(rms(got.subarray(2000))).toBeLessThan(0.02); // ~-34dB or better
  });

  it('rejects content just above Nyquist too', () => {
    const got = resample(48000, tone(9000, 48000, 0.5));
    expect(rms(got.subarray(2000))).toBeLessThan(0.05);
  });
});
