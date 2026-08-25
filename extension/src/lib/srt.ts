/**
 * Whisper segments → SubRip, and → inlined `speech` events.
 *
 * Both, from one source. The `.srt` file exists because it is what a video
 * player wants and what was asked for; the `speech` events exist because an
 * agent reading one file beats an agent stitching two. They cannot drift,
 * because neither is a source — both are renderings of the same segments.
 *
 * That ordering carries real information, which is only visible when speech
 * shares an array with everything else: in the worked example the narration
 * "And clicking save" lands 670ms *before* the click. People narrate intent
 * before acting.
 *
 * Design: docs/design/issues/09-the-artifact-contract.md, /07
 */

import type { SpeechEvent } from './events';
import type { SessionMs } from './time';

export interface Segment {
  /** Milliseconds from t0. */
  start: SessionMs;
  end: SessionMs;
  text: string;
}

/** `00:00:11,210` — SubRip uses a comma for the decimal separator, not a dot. */
export function srtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(clamped % 1000, 3)}`;
}

/**
 * CRLF line endings, deliberately.
 *
 * The SubRip format specifies them. Most players tolerate LF, but "most
 * players" is not a shipping standard — and this project is OS-agnostic by
 * charter, so the Windows-correct form is the one that ships.
 */
export function toSrt(segments: Segment[]): string {
  return (
    segments
      .filter((s) => s.text.trim())
      .map((s, i) => [i + 1, `${srtTime(s.start)} --> ${srtTime(s.end)}`, s.text.trim(), ''].join('\r\n'))
      .join('\r\n') + '\r\n'
  );
}

/**
 * Where a segment was spoken: one page for the whole session, or asked per
 * segment. A session that navigates needs the latter — see `pageUrlResolver`.
 */
export type PageAt = string | ((t: number) => string);

export function toSpeechEvents(segments: Segment[], pageUrl: PageAt): SpeechEvent[] {
  const at = typeof pageUrl === 'function' ? pageUrl : () => pageUrl;
  return segments
    .filter((s) => s.text.trim())
    .map((s) => ({
      type: 'speech',
      t: Math.round(s.start),
      tEnd: Math.round(s.end),
      pageUrl: at(Math.round(s.start)),
      text: s.text.trim(),
    }));
}

/**
 * The page in effect at a moment, from the navigations already in the timeline.
 *
 * Narration was stamped with the session's `startUrl`, which is right only until
 * the first navigation — everything said after it was filed under the page the
 * session opened on. `ctx.pageUrl` is no better here: at stop time it holds the
 * LAST page, which is the mirror-image mistake.
 *
 * Navigations are a step function over `t`, so the page at an utterance is a
 * lookup. `fallback` covers speech transcribed from before the first navigation
 * was recorded, where the session's opening url really is the best answer.
 */
export function pageUrlResolver(
  navigations: ReadonlyArray<{ t: number; pageUrl: string }>,
  fallback: string,
): (t: number) => string {
  const steps = navigations.filter((n) => n.pageUrl).sort((a, b) => a.t - b.t);
  return (t) => {
    let lo = 0;
    let hi = steps.length - 1;
    let found = fallback;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid]!.t <= t) {
        found = steps[mid]!.pageUrl;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
}

/**
 * Whisper emits a segment per breath group, which makes for a choppy transcript
 * and a noisy timeline. Merge neighbours that are close enough to be one
 * thought — but never across a real pause, which is usually the boundary
 * between narrating and reacting.
 */
export function mergeSegments(segments: Segment[], maxGapMs = 400, maxLengthMs = 8000): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    const previous = out[out.length - 1];
    if (
      previous &&
      segment.start - previous.end <= maxGapMs &&
      segment.end - previous.start <= maxLengthMs
    ) {
      previous.end = segment.end;
      previous.text = `${previous.text} ${segment.text}`.replace(/\s+/g, ' ').trim();
    } else {
      out.push({ ...segment, text: segment.text.trim() });
    }
  }
  return out;
}

/**
 * Whisper hallucinates fixed phrases on silence — subtitle-scrape artefacts
 * baked into the training data. They are not transcription errors so much as
 * the model filling a vacuum, and a QA session has plenty of silence.
 */
const HALLUCINATIONS = [
  /^thanks? for watching[.!]?$/i,
  /^thank you[.!]?$/i,
  /^subtitles? by .*$/i,
  /^subscribe.*$/i,
  /^you[.!]?$/i,
  /^bye[.!]?$/i,
  /^\.+$/,
  /^\[\s*(music|silence|blank_audio|inaudible)\s*\]$/i,
];

/**
 * Whisper loops on non-speech. Given silence, or a fan, it emits a phrase and
 * then repeats it — something no person does.
 *
 * Matched structurally rather than by phrase, because the loop is never the
 * same text twice: one session produced "a little bit of" three times over,
 * another "I'm going to go" eight times. A fixed list cannot keep up with that,
 * which is why HALLUCINATIONS above catches none of it.
 */
const LOOP_MAX_GRAM = 6;
const LOOP_MIN_REPEATS = 3;

/**
 * How much of a segment a back-to-back repeat takes up.
 *
 * Coverage rather than mere presence, because a real utterance can END in a
 * repeat: "Okay. No, it's not. Okay. Okay. Okay." is someone talking, and the
 * loop is 43% of it — dropping the segment would cost the "No, it's not" in
 * front. A degenerate loop dominates instead, measured at 60% on real captures.
 * Nothing observed lands between the two, so the threshold sits in open space.
 */
export function loopCoverage(text: string): number {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;

  const repeatsAt = (start: number, size: number): number => {
    let reps = 1;
    outer: for (;;) {
      const next = start + size * reps;
      if (next + size > words.length) break;
      for (let j = 0; j < size; j++) if (words[next + j] !== words[start + j]) break outer;
      reps++;
    }
    return reps;
  };

  let best = 0;
  for (let size = 1; size <= LOOP_MAX_GRAM; size++) {
    for (let i = 0; i + size * LOOP_MIN_REPEATS <= words.length; i++) {
      const reps = repeatsAt(i, size);
      if (reps >= LOOP_MIN_REPEATS) best = Math.max(best, (size * reps) / words.length);
    }
  }
  return best;
}

/** Above this share of a segment, the repeat IS the segment. */
export const LOOP_COVERAGE_LIMIT = 0.5;

export function isLikelyHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (HALLUCINATIONS.some((p) => p.test(trimmed))) return true;
  return loopCoverage(trimmed) >= LOOP_COVERAGE_LIMIT;
}

export function cleanSegments(segments: Segment[]): Segment[] {
  return mergeSegments(segments.filter((s) => !isLikelyHallucination(s.text)));
}
