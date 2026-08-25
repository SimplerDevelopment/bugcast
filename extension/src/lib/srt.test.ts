import { describe, expect, it } from 'vitest';
import {
  cleanSegments,
  isLikelyHallucination,
  LOOP_COVERAGE_LIMIT,
  loopCoverage,
  mergeSegments,
  pageUrlResolver,
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

  it('asks per segment when given a resolver, so a navigating session is not collapsed', () => {
    const at = pageUrlResolver(
      [
        { t: 0, pageUrl: 'https://x.test/board' },
        { t: 5000, pageUrl: 'https://x.test/board/card-1' },
      ],
      'https://x.test/board',
    );
    const events = toSpeechEvents([seg(1000, 1800, 'on the board'), seg(6000, 6800, 'in the card')], at);
    expect(events.map((e) => e.pageUrl)).toEqual([
      'https://x.test/board',
      'https://x.test/board/card-1',
    ]);
  });
});

describe('pageUrlResolver', () => {
  const NAVS = [
    { t: 0, pageUrl: 'https://x.test/a' },
    { t: 5000, pageUrl: 'https://x.test/b' },
    { t: 9000, pageUrl: 'https://x.test/c' },
  ];

  it('returns the navigation in effect, treating the boundary as the new page', () => {
    const at = pageUrlResolver(NAVS, 'https://fallback.test/');
    expect(at(4999)).toBe('https://x.test/a');
    expect(at(5000)).toBe('https://x.test/b');
    expect(at(99000)).toBe('https://x.test/c');
  });

  it('falls back only for speech that predates every navigation', () => {
    const at = pageUrlResolver(NAVS.slice(1), 'https://fallback.test/');
    expect(at(10)).toBe('https://fallback.test/');
    expect(at(5000)).toBe('https://x.test/b');
  });

  it('sorts and ignores navigations with no url rather than trusting input order', () => {
    const at = pageUrlResolver(
      [NAVS[2]!, { t: 3000, pageUrl: '' }, NAVS[0]!, NAVS[1]!],
      'https://fallback.test/',
    );
    expect(at(3500)).toBe('https://x.test/a');
    expect(at(9500)).toBe('https://x.test/c');
  });

  it('uses the fallback when there are no navigations at all', () => {
    expect(pageUrlResolver([], 'https://fallback.test/')(1234)).toBe('https://fallback.test/');
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

// Whisper loops on silence. The fixed HALLUCINATIONS list cannot catch it —
// the looped phrase is different every session — so it is matched structurally.
describe('loop detection', () => {
  // Verbatim from 2026-08-21T12-05-36, where 8 lines looked like this.
  const LOOP = 'So, we\'re going to be doing a little bit of a little bit of a little bit of a little';
  // Also verbatim from that session, and a real person talking.
  const REAL = 'Okay. No, it\'s not. Okay. Okay. Okay.';

  it('drops a segment the repeat has taken over', () => {
    expect(loopCoverage(LOOP)).toBeGreaterThanOrEqual(LOOP_COVERAGE_LIMIT);
    expect(isLikelyHallucination(LOOP)).toBe(true);
  });

  it('keeps real speech that merely ends in a repeat', () => {
    // The loop is under half the words; dropping this would cost "No, it's not".
    expect(loopCoverage(REAL)).toBeLessThan(LOOP_COVERAGE_LIMIT);
    expect(isLikelyHallucination(REAL)).toBe(false);
  });

  it('does not mistake a list of distinct tokens for a loop', () => {
    // A mic check that must survive: every token differs, so coverage is 0.
    expect(loopCoverage('A, B, C, D, E, F, G, H, I, J, K')).toBe(0);
    expect(isLikelyHallucination('I am just trying to see if my speech shows up here.')).toBe(false);
  });

  it('needs three repeats, so ordinary doubling is left alone', () => {
    expect(loopCoverage('that that')).toBe(0);
    expect(loopCoverage('no no no')).toBeGreaterThan(0);
  });

  it('scores an empty or whitespace segment at zero rather than dividing by it', () => {
    expect(loopCoverage('')).toBe(0);
    expect(loopCoverage('   ')).toBe(0);
  });

  it('still catches the lexical hallucinations it always did', () => {
    for (const t of ['Thanks for watching', 'you', '[ Silence ]', '...']) {
      expect(isLikelyHallucination(t)).toBe(true);
    }
  });

  it('removes looped segments from a real transcript without touching the rest', () => {
    const kept = cleanSegments([seg(0, 1000, LOOP), seg(2000, 3000, 'the save button is broken')]);
    expect(kept.map((s) => s.text)).toEqual(['the save button is broken']);
  });
});
