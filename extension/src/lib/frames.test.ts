import { describe, expect, it } from 'vitest';
import { deservesFrame, FRAME_OFFSET_MS, frameName, MAX_FRAMES, planFrames } from './frames';
import type { TimelineEvent } from './events';

const target = {
  selector: '#x', selectorKind: 'id' as const, css: '#x', role: null, name: null,
  tag: 'div', text: '', id: 'x', rect: { x: 0, y: 0, w: 0, h: 0 }, frameUrl: 'https://x.test/',
};
const click = (t: number): TimelineEvent => ({ type: 'click', t, pageUrl: 'https://x.test/', target });
const ok = (t: number): TimelineEvent => ({
  type: 'network', t, pageUrl: 'https://x.test/', requestId: `${t}`, method: 'GET',
  url: 'https://x.test/a', resourceType: 'Fetch', status: 200,
});
const bad = (t: number): TimelineEvent => ({ ...(ok(t) as any), status: 500 });

describe('deservesFrame', () => {
  it('includes every interaction — the pixels show what it produced', () => {
    for (const type of ['click', 'keydown', 'change', 'submit', 'drag', 'focus'] as const) {
      expect(deservesFrame({ type, t: 0, pageUrl: '', target } as any), type).toBe(true);
    }
  });

  it('includes navigations, exceptions and failed requests — no interaction to hang off', () => {
    expect(deservesFrame({ type: 'navigation', t: 0, pageUrl: '', trigger: 'load', from: null })).toBe(true);
    expect(deservesFrame({ type: 'exception', t: 0, pageUrl: '', text: 'boom' })).toBe(true);
    expect(deservesFrame(bad(0))).toBe(true);
  });

  it('excludes what would show a page that did not change', () => {
    expect(deservesFrame(ok(0))).toBe(false);
    expect(deservesFrame({ type: 'console', t: 0, pageUrl: '', level: 'log', text: 'x', source: 'c' })).toBe(false);
    expect(deservesFrame({ type: 'speech', t: 0, pageUrl: '', text: 'hello' })).toBe(false);
  });

  it('excludes an aborted request — navigation cancels those routinely', () => {
    expect(deservesFrame({ ...(ok(0) as any), status: undefined, failure: { errorText: 'net::ERR_ABORTED', canceled: true } })).toBe(false);
  });
});

describe('frameName', () => {
  it('zero-pads so the directory sorts chronologically', () => {
    expect(frameName(click(0), 12340)).toBe('frames/000012340-click.jpg');
  });

  it('says what the moment was, so a frame is findable without the timeline', () => {
    expect(frameName(bad(0), 12340)).toBe('frames/000012340-network-500.jpg');
    expect(frameName({ type: 'console', t: 0, pageUrl: '', level: 'error', text: 'x', source: 'c' }, 5))
      .toBe('frames/000000005-console-error.jpg');
  });
});

describe('planFrames', () => {
  it('samples after the event, not at it', () => {
    expect(planFrames([click(1000)])[0]!.t).toBe(1000 + FRAME_OFFSET_MS);
  });

  it('shares one frame between events too close to differ', () => {
    const plan = planFrames([click(1000), click(1100), click(1200)]);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.events).toEqual([0, 1, 2]);
  });

  it('keeps separate frames once the page has had time to change', () => {
    expect(planFrames([click(1000), click(2000)])).toHaveLength(2);
  });

  it('ignores events that do not deserve a frame', () => {
    expect(planFrames([ok(1000), ok(5000)])).toHaveLength(0);
  });

  it('never plans a negative time', () => {
    expect(planFrames([{ ...click(-1000) }])[0]!.t).toBe(0);
  });

  it('falls back to the moments that cannot be inferred from text when capped', () => {
    const many: TimelineEvent[] = [];
    for (let i = 0; i < MAX_FRAMES + 50; i++) many.push(click(i * 1000));
    many.push(bad((MAX_FRAMES + 60) * 1000));
    const plan = planFrames(many);
    expect(plan.length).toBeLessThanOrEqual(MAX_FRAMES);
    // The failure survives the cull; a click among hundreds does not.
    expect(plan.some((f) => f.path.includes('network-500'))).toBe(true);
  });
});

describe('marker', () => {
  it('always deserves a frame — it is someone saying "look here"', () => {
    expect(deservesFrame({ type: 'marker', t: 0, pageUrl: '', note: 'This is the bug' })).toBe(true);
  });

  it('survives the cap, because it is the most likely frame to be wanted', () => {
    const many: TimelineEvent[] = [];
    for (let i = 0; i < MAX_FRAMES + 50; i++) many.push(click(i * 1000));
    many.push({ type: 'marker', t: (MAX_FRAMES + 60) * 1000, pageUrl: '', note: 'here' });
    const plan = planFrames(many);
    expect(plan.length).toBeLessThanOrEqual(MAX_FRAMES);
    expect(plan.some((f) => f.path.includes('marker'))).toBe(true);
  });
});
