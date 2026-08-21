import { describe, expect, it } from 'vitest';
import { BREADTH_KEY, CAPS, cap, fromEntry, SESSION_MARK } from './annotate';

const entry = (over: Partial<Parameters<typeof fromEntry>[0]> = {}) => ({
  name: 'bugcast:thing', entryType: 'mark', startTime: 500, duration: 0, ...over,
});

describe('fromEntry', () => {
  it("ignores the page's own marks", () => {
    expect(fromEntry(entry({ name: 'react-render' }), 1000)).toBeNull();
    expect(fromEntry(entry({ name: 'my-app:boot' }), 1000)).toBeNull();
  });

  it('strips the prefix and converts to epoch through timeOrigin', () => {
    const out = fromEntry(entry(), 1_000_000)!;
    expect(out.name).toBe('thing');
    expect(out.scope).toBe('timeline');
    expect(out.epochMs).toBe(1_000_500);
  });

  it('routes the reserved name to session scope with no name', () => {
    const out = fromEntry(entry({ name: SESSION_MARK, detail: { buildSha: 'abc' } }), 0)!;
    expect(out.scope).toBe('session');
    expect(out.name).toBe('');
    expect(out.detail).toEqual({ buildSha: 'abc' });
  });

  it('gives a measure an end and a mark none — events are intervals', () => {
    const measure = fromEntry(entry({ entryType: 'measure', duration: 250 }), 0)!;
    expect(measure.source).toBe('measure');
    expect(measure.endEpochMs).toBe(750);
    // A zero-duration measure is an instant; inventing tEnd === t would be noise.
    expect(fromEntry(entry({ entryType: 'measure', duration: 0 }), 0)!.endEpochMs).toBeUndefined();
    expect(fromEntry(entry(), 0)!.endEpochMs).toBeUndefined();
  });
});

describe('cap', () => {
  it('passes ordinary values through untouched', () => {
    expect(cap({ a: 1, b: 'x', c: true, d: null, e: [1, 2] })).toEqual({
      a: 1, b: 'x', c: true, d: null, e: [1, 2],
    });
  });

  it('caps depth and names the type it withheld', () => {
    const deep = { a: { b: { c: { d: { e: 'gone' } } } } };
    const out = cap(deep) as any;
    expect(out.a.b.c.d).toBe('[depth limit: Object]');
  });

  // The one that matters: depth-limiting alone does nothing for the shape
  // developers actually attach — a flat map of a few hundred feature flags.
  it('caps a wide, shallow object that a depth limit would not touch', () => {
    const flags = Object.fromEntries(
      Array.from({ length: CAPS.breadth + 40 }, (_, i) => [`flag${i}`, true]),
    );
    const out = cap(flags) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(CAPS.breadth + 1); // + the sentinel
    expect(out[BREADTH_KEY]).toBe('40 more withheld');
  });

  it('caps long arrays too, with the sentinel as the final element', () => {
    const out = cap(Array.from({ length: CAPS.breadth + 5 }, (_, i) => i)) as unknown[];
    expect(out).toHaveLength(CAPS.breadth + 1);
    expect(out[CAPS.breadth]).toBe('5 more withheld');
  });

  it('caps one huge string that clears both other budgets', () => {
    const out = cap({ blob: 'x'.repeat(5000) }) as any;
    expect(out.blob).toHaveLength(CAPS.chars + '…[string limit: 5000 chars]'.length);
    expect(out.blob.endsWith('…[string limit: 5000 chars]')).toBe(true);
  });

  it('uses a distinct sentinel per budget, so the reader knows which knob to turn', () => {
    const sentinels = new Set([
      String((cap({ a: { b: { c: { d: {} } } } }) as any).a.b.c.d),
      String((cap(Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, 1]))) as any)[BREADTH_KEY]),
      String((cap({ s: 'y'.repeat(2000) }) as any).s.slice(-30)),
    ]);
    expect(sentinels.size).toBe(3);
  });

  it('drops what cannot survive the message hop rather than faking it', () => {
    const out = cap({ fn: () => 1, ok: 2 }) as Record<string, unknown>;
    expect(out).toEqual({ ok: 2 });
  });
});
