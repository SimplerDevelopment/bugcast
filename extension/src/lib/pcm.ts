/**
 * Windowing over the live PCM buffer.
 *
 * Pure, and here rather than beside the recorder, because this arithmetic is
 * what silently truncated a transcript once. The live pass used to `shift()`
 * consumed chunks off the array to keep its walk short — but `stop()`
 * transcribes that same array, so every chunk the live pass ate was audio the
 * authoritative pass never saw, and what survived got stamped from zero. The
 * result was a transcript missing its head with every remaining timestamp
 * shifted earlier by however much had been consumed.
 *
 * A cursor keeps the walk O(window) without deleting anything.
 */

/** How far the live pass has read: an index, and the samples before it. */
export interface Cursor {
  index: number;
  samples: number;
}

export const newCursor = (): Cursor => ({ index: 0, samples: 0 });

/**
 * Total samples held.
 *
 * Counted from the cursor rather than from zero: the chunk list grows for the
 * whole recording (~14,000 chunks after fifteen minutes) and this runs every
 * couple of seconds on the same thread as MediaRecorder.
 */
export function availableSamples(chunks: Float32Array[], cursor: Cursor): number {
  let n = cursor.samples;
  for (let i = cursor.index; i < chunks.length; i++) n += chunks[i]!.length;
  return n;
}

/**
 * The samples in `[from, to)`, copied flat.
 *
 * `from` must be at or after the cursor — the caller only ever asks for the
 * window starting where the last one ended.
 */
export function flatten(
  chunks: Float32Array[],
  from: number,
  to: number,
  cursor: Cursor,
): Float32Array {
  const out = new Float32Array(to - from);
  let seen = cursor.samples;
  let written = 0;
  for (let i = cursor.index; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const start = Math.max(from, seen);
    const end = Math.min(to, seen + chunk.length);
    if (end > start) {
      out.set(chunk.subarray(start - seen, end - seen), written);
      written += end - start;
    }
    seen += chunk.length;
    if (seen >= to) break;
  }
  return out;
}

/** Move the cursor past every chunk `to` fully covers. Deletes nothing. */
export function advance(chunks: Float32Array[], to: number, cursor: Cursor): void {
  while (cursor.index < chunks.length && cursor.samples + chunks[cursor.index]!.length <= to) {
    cursor.samples += chunks[cursor.index]!.length;
    cursor.index++;
  }
}
