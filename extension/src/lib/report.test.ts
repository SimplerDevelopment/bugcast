import { describe, expect, it } from 'vitest';
import { isFailure, renderReport, stamp, type ReportMeta } from './report';
import type { NetworkEvent, TimelineEvent } from './events';

const meta: ReportMeta = {
  id: '2026-08-20T14-32-09_app-simplerdev-com',
  title: 'Saving the homepage draft',
  startedAt: new Date('2026-08-20T14:32:09.412Z'),
  startUrl: 'https://app.simplerdev.com/portal/websites/12/posts/487/edit',
  durationMs: 26480,
  userAgent: 'Chrome/141',
  redaction: {
    headersRedacted: { authorization: 14 },
    urlParamsRedacted: {},
    bodyKeysRedacted: {},
    typedValuesWithheld: 1,
    highEntropyMatches: 0,
  },
  files: [['timeline.json', 'full detail']],
};

const failing = (t: number): NetworkEvent => ({
  type: 'network',
  t,
  tEnd: t + 342,
  pageUrl: 'https://app.simplerdev.com/x',
  requestId: `r${t}`,
  method: 'PATCH',
  url: 'https://app.simplerdev.com/api/portal/posts/487',
  resourceType: 'Fetch',
  status: 500,
  response: {
    headers: {},
    body: '{"error":{"code":"DB_ERROR","message":"column \\"cdn_cache_enabled\\" does not exist"}}',
    truncated: false,
  },
});

describe('stamp', () => {
  it('formats as mm:ss.mmm, which is what a player seek box takes', () => {
    expect(stamp(0)).toBe('00:00.000');
    expect(stamp(11942)).toBe('00:11.942');
    expect(stamp(134320)).toBe('02:14.320');
  });

  it('handles the negative offsets MediaRecorder can produce', () => {
    expect(stamp(-49)).toBe('-00:00.049');
  });
});

describe('isFailure', () => {
  it('counts 4xx and 5xx', () => {
    expect(isFailure({ ...failing(0), status: 404 })).toBe(true);
    expect(isFailure({ ...failing(0), status: 200 })).toBe(false);
  });

  it('counts a real network failure', () => {
    expect(
      isFailure({ ...failing(0), status: undefined, failure: { errorText: 'net::ERR_FAILED', canceled: false } }),
    ).toBe(true);
  });

  it('does NOT count an abort — navigation and AbortController cancel routinely', () => {
    expect(
      isFailure({ ...failing(0), status: undefined, failure: { errorText: 'net::ERR_ABORTED', canceled: true } }),
    ).toBe(false);
  });
});

describe('renderReport', () => {
  it('groups identical failures with a count, so a repeat is visible as a repeat', () => {
    const md = renderReport(meta, [failing(11942), failing(21103)]);
    expect(md).toContain('**2 failed requests**, 1 distinct.');
    expect(md).toContain('(×2, at 00:11.942 and 00:21.103)');
  });

  it('prints the response body — it is the whole reason the artifact exists', () => {
    expect(renderReport(meta, [failing(11942)])).toContain('column \\"cdn_cache_enabled\\" does not exist');
  });

  it('never explains why anything happened', () => {
    const md = renderReport(meta, [failing(11942)]).toLowerCase();
    for (const word of ['because', 'root cause', 'likely', 'probably', 'suggests', 'migration']) {
      expect(md, word).not.toContain(word);
    }
  });

  it('says plainly that it contains no analysis', () => {
    expect(renderReport(meta, [])).toContain('contains no');
  });

  it('reports no failures rather than omitting the section', () => {
    expect(renderReport(meta, [])).toContain('## Failures\n\nNone recorded.');
  });

  it('renders every event type without throwing', () => {
    const target = {
      selector: '#x', selectorKind: 'id' as const, css: '#x', role: 'button',
      name: 'Save', tag: 'button', text: 'Save', id: 'x',
      rect: { x: 0, y: 0, w: 0, h: 0 }, frameUrl: 'https://x.test/',
    };
    const events: TimelineEvent[] = [
      { type: 'navigation', t: 0, pageUrl: 'https://x.test/', trigger: 'load', from: null },
      { type: 'speech', t: 1, pageUrl: 'https://x.test/', text: 'hello' },
      { type: 'click', t: 2, pageUrl: 'https://x.test/', target },
      { type: 'keydown', t: 3, pageUrl: 'https://x.test/', key: 'k', modifiers: ['meta'], target },
      { type: 'change', t: 4, pageUrl: 'https://x.test/', target, value: { redacted: true, chars: 8, shape: 'email' } },
      { type: 'submit', t: 5, pageUrl: 'https://x.test/', target },
      { type: 'drag', t: 6, tEnd: 9, pageUrl: 'https://x.test/', mechanism: 'pointer', from: { target }, to: { target, point: { x: 1, y: 2 } } },
      { type: 'focus', t: 7, pageUrl: 'https://x.test/', target },
      { type: 'console', t: 8, pageUrl: 'https://x.test/', level: 'log', text: 'hi', source: 'console-api' },
      { type: 'exception', t: 9, pageUrl: 'https://x.test/', text: 'boom' },
      failing(10),
    ];
    const md = renderReport(meta, events);
    // One table row per event, plus header and separator.
    expect(md.split('\n').filter((l) => l.startsWith('| 00:')).length).toBe(events.length);
    expect(md).toContain('value withheld (8 chars, email)');
    expect(md).toContain('`meta+k`');
  });

  it('escapes pipes so one URL cannot destroy the table', () => {
    const e: NetworkEvent = { ...failing(0), url: 'https://x.test/a|b', status: 200 };
    const row = renderReport(meta, [e]).split('\n').find((l) => l.startsWith('| 00:'))!;
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(4); // the four real cell borders
  });

  it('carries the unredactable-pixels warning, which is release-blocking', () => {
    expect(renderReport(meta, [])).toContain('not redacted');
  });
});

describe('marker rendering', () => {
  it('stands out in the timeline, since it is the one row a human placed', () => {
    const md = renderReport(meta, [
      { type: 'marker', t: 5000, pageUrl: 'https://x.test/', note: 'This is the bug' },
    ]);
    expect(md).toContain('**mark**');
    expect(md).toContain('**This is the bug**');
  });
});
