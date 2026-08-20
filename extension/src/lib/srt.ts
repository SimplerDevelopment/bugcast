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

export function toSpeechEvents(segments: Segment[], pageUrl: string): SpeechEvent[] {
  return segments
    .filter((s) => s.text.trim())
    .map((s) => ({
      type: 'speech',
      t: Math.round(s.start),
      tEnd: Math.round(s.end),
      pageUrl,
      text: s.text.trim(),
    }));
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

export function isLikelyHallucination(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || HALLUCINATIONS.some((p) => p.test(trimmed));
}

export function cleanSegments(segments: Segment[]): Segment[] {
  return mergeSegments(segments.filter((s) => !isLikelyHallucination(s.text)));
}
