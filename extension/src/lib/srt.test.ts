import { describe, expect, it } from 'vitest';
import {
  cleanSegments,
  isLikelyHallucination,
  mergeSegments,
  srtTime,
  toSpeechEvents,
  toSrt,
  type Segment,
} from './srt';

const seg = (start: number, end: number, text: string): Segment => ({ start, end, text });

describe('srtTime', () => {
  it('uses a comma for the decimal separator, as SubRip specifies', () => {
    expect(srtTime(11210)).toBe('00:00:11,210');
  });

  it('carries hours', () => {
    expect(srtTime(3_723_456)).toBe('01:02:03,456');
  });

  it('clamps negatives — MediaRecorder can deliver data from before start()', () => {
    expect(srtTime(-49)).toBe('00:00:00,000');
  });
});

describe('toSrt', () => {
  it('numbers cues from 1 and uses the arrow form players expect', () => {
    const out = toSrt([seg(1180, 4020, 'Okay, I am in the editor.')]);
    expect(out).toContain('1\r\n00:00:01,180 --> 00:00:04,020\r\n');
  });

  it('uses CRLF throughout — the format specifies it and Windows is a target', () => {
    const out = toSrt([seg(0, 1000, 'a'), seg(2000, 3000, 'b')]);
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('drops empty cues rather than emitting a blank subtitle', () => {
    expect(toSrt([seg(0, 1, '   '), seg(2, 3, 'real')])).toContain('1\r\n00:00:00,002');
  });

  it('is empty-safe', () => {
    expect(toSrt([])).toBe('\r\n');
  });
});

describe('toSpeechEvents', () => {
  it('produces timeline events from the same segments the SRT came from', () => {
    const events = toSpeechEvents([seg(1180, 4020, ' hello ')], 'https://x.test/');
    expect(events).toEqual([
      { type: 'speech', t: 1180, tEnd: 4020, pageUrl: 'https://x.test/', text: 'hello' },
    ]);
  });
});

describe('mergeSegments', () => {
  it('joins breath groups that are one thought', () => {
    const out = mergeSegments([seg(0, 1000, 'And clicking'), seg(1200, 1800, 'save.')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('And clicking save.');
    expect(out[0]!.end).toBe(1800);
  });

  it('never merges across a real pause — that is usually narrate-then-react', () => {
    const out = mergeSegments([seg(0, 1000, 'Clicking save.'), seg(4000, 5000, "It's spinning.")]);
    expect(out).toHaveLength(2);
  });

  it('caps merged length so one monologue is not a single unreadable cue', () => {
    const many = Array.from({ length: 20 }, (_, i) => seg(i * 1000, i * 1000 + 900, `part${i}`));
    expect(mergeSegments(many).length).toBeGreaterThan(1);
  });
});

describe('isLikelyHallucination', () => {
  it('catches the phrases Whisper invents over silence', () => {
    for (const text of ['Thanks for watching.', 'Thank you', 'Subtitles by the community', '...', '[BLANK_AUDIO]', 'you']) {
      expect(isLikelyHallucination(text), text).toBe(true);
    }
  });

  it('leaves real narration alone, including short real utterances', () => {
    for (const text of ['And clicking save.', "It's just spinning.", 'Same thing twice.', 'Yep']) {
      expect(isLikelyHallucination(text), text).toBe(false);
    }
  });
});

describe('cleanSegments', () => {
  it('drops hallucinations before merging, so they cannot glue real speech together', () => {
    const out = cleanSegments([
      seg(0, 1000, 'Clicking save.'),
      seg(1100, 1200, 'Thanks for watching.'),
      seg(5000, 6000, 'It failed.'),
    ]);
    expect(out.map((s) => s.text)).toEqual(['Clicking save.', 'It failed.']);
  });
});
