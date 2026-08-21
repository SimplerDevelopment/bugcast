import { describe, expect, it } from 'vitest';
import { dedupe, fromScriptParsed } from './scripts';

const parsed = (over = {}) => ({
  scriptId: '42', url: 'https://app.test/assets/main-a1b2.js',
  sourceMapURL: 'main-a1b2.js.map', hash: 'abc123', ...over,
});

describe('fromScriptParsed', () => {
  it('keeps the fields a resolver needs', () => {
    expect(fromScriptParsed(parsed())).toEqual({
      scriptId: '42',
      url: 'https://app.test/assets/main-a1b2.js',
      sourceMapURL: 'main-a1b2.js.map',
      hash: 'abc123',
    });
  });

  it('records an inline map as a fact instead of carrying megabytes', () => {
    const out = fromScriptParsed(parsed({ sourceMapURL: 'data:application/json;base64,eyJ2Z' }))!;
    expect(out.inlineMap).toBe(true);
    expect(out.sourceMapURL).toBeUndefined();
  });

  it('keeps a script with no map at all — "no map" is itself the answer', () => {
    const out = fromScriptParsed(parsed({ sourceMapURL: '' }))!;
    expect(out.url).toBe('https://app.test/assets/main-a1b2.js');
    expect(out.sourceMapURL).toBeUndefined();
    expect(out.inlineMap).toBeUndefined();
  });

  it('carries buildId when the build tool emitted one', () => {
    expect(fromScriptParsed(parsed({ buildId: 'deadbeef' }))!.buildId).toBe('deadbeef');
  });

  it('skips our own scripts and anonymous eval', () => {
    expect(fromScriptParsed(parsed({ url: 'chrome-extension://abc/content.js' }))).toBeNull();
    expect(fromScriptParsed(parsed({ url: 'devtools://devtools/x.js' }))).toBeNull();
    expect(fromScriptParsed(parsed({ url: '' }))).toBeNull();
  });
});

describe('dedupe', () => {
  it('collapses a script re-parsed across navigations, keeping the newest id', () => {
    const out = dedupe([
      { scriptId: '1', url: 'https://app.test/a.js' },
      { scriptId: '2', url: 'https://app.test/b.js' },
      { scriptId: '9', url: 'https://app.test/a.js', sourceMapURL: 'a.js.map' },
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((e) => e.url.endsWith('a.js'))!;
    expect(a.scriptId).toBe('9');
    expect(a.sourceMapURL).toBe('a.js.map');
  });
});
