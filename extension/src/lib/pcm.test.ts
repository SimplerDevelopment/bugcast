import { describe, expect, it } from 'vitest';
import { advance, availableSamples, flatten, newCursor } from './pcm';

/** A session's worth of audio, in the ragged chunks the worklet actually posts. */
function chunks(sizes: number[], start = 0): Float32Array[] {
  let n = start;
  return sizes.map((size) => Float32Array.from({ length: size }, () => n++));
}

describe('live PCM windowing', () => {
  it('returns the requested window across chunk boundaries', () => {
    const pcm = chunks([100, 100, 100]);
    expect(Array.from(flatten(pcm, 50, 150, newCursor()))).toEqual(
      Array.from({ length: 100 }, (_, i) => 50 + i),
    );
  });

  it('reads from the cursor, not from zero', () => {
    const pcm = chunks([100, 100, 100]);
    const cursor = newCursor();
    advance(pcm, 100, cursor);
    expect(cursor).toEqual({ index: 1, samples: 100 });
    expect(Array.from(flatten(pcm, 100, 200, cursor))).toEqual(
      Array.from({ length: 100 }, (_, i) => 100 + i),
    );
  });

  // The regression that cost a transcript: the live pass consumed the buffer
  // that stop() transcribes, so the authoritative pass lost its head and
  // stamped the remainder from zero.
  it('never shrinks the buffer, so stop() still sees the whole session', () => {
    const pcm = chunks([160_000, 160_000, 160_000, 80_000]);
    const cursor = newCursor();
    const total = pcm.reduce((n, c) => n + c.length, 0);

    for (let to = 160_000; to <= 480_000; to += 160_000) advance(pcm, to, cursor);

    expect(pcm).toHaveLength(4);
    expect(pcm.reduce((n, c) => n + c.length, 0)).toBe(total);
    expect(pcm[0]![0]).toBe(0); // the first sample of the session is still there
  });

  it('counts everything held, whatever the cursor has passed', () => {
    const pcm = chunks([100, 100, 100]);
    const cursor = newCursor();
    expect(availableSamples(pcm, cursor)).toBe(300);
    advance(pcm, 200, cursor);
    expect(availableSamples(pcm, cursor)).toBe(300);
    pcm.push(new Float32Array(50));
    expect(availableSamples(pcm, cursor)).toBe(350);
  });
});
