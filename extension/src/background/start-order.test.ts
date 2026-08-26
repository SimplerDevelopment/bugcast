import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The service worker cannot be imported under test — it reaches for `chrome`
 * at module scope — so this reads it, the way pcm-worklet.test.ts reads the
 * worklet it cannot import.
 *
 * The invariant is an ordering one and there is nothing else that catches it.
 * `Debugger.scriptParsed` replays every already-loaded script once, the instant
 * the domain is enabled inside `attach`. Register the handler after `attach`
 * and the whole burst lands on the floor, which is how sessions came out with
 * `scripts: {enabled: false}` on a page full of scripts. The smoke test does
 * not catch it: it races, and on a small page it usually wins.
 */
describe('start() wiring order', () => {
  const source = readFileSync(new URL('./service-worker.ts', import.meta.url), 'utf8');

  it('registers the scriptParsed handler before attaching, or the index is empty', () => {
    const handler = source.indexOf("cdp.on('Debugger.scriptParsed'");
    const attach = source.indexOf('cdp.attach(');
    expect(handler).toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(-1);
    expect(handler).toBeLessThan(attach);
  });
});
