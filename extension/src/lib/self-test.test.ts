import { describe, expect, it } from 'vitest';
import { runChecks, summarise, type Check } from './self-test';

const check = (id: any, run: () => Promise<string>): Check => ({ id, label: id, run });

describe('runChecks', () => {
  it('reports each check with its own detail and timing', async () => {
    let t = 0;
    const results = await runChecks(
      [check('cdp', async () => 'attached and detached')],
      () => (t += 50),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'cdp', ok: true, detail: 'attached and detached' });
    expect(results[0]!.ms).toBe(50);
  });

  it('keeps going after a failure — a user should learn everything in one pass', async () => {
    const results = await runChecks([
      check('cdp', async () => {
        throw new Error('DevTools is attached');
      }),
      check('disk', async () => 'wrote and read back'),
    ]);
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(results[0]!.detail).toBe('DevTools is attached');
  });

  it('turns a thrown non-Error into something readable rather than [object Object]', async () => {
    const results = await runChecks([
      check('asr', async () => {
        throw { code: 42 };
      }),
    ]);
    expect(results[0]!.detail).not.toContain('[object');
  });
});

describe('summarise', () => {
  it('names what failed, not just how many', async () => {
    const results = await runChecks([
      check('cdp', async () => 'ok'),
      check('asr', async () => {
        throw new Error('no model');
      }),
    ]);
    expect(summarise(results)).toBe('1 of 2 failed: asr.');
  });

  it('is unambiguous when everything passes', async () => {
    expect(summarise(await runChecks([check('disk', async () => 'ok')]))).toBe('All 1 checks passed.');
  });
});
