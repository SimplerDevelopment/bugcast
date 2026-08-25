import { describe, expect, it } from 'vitest';
import { dedupe, fromScriptParsed } from './scripts';

const parsed = (over = {}) => ({
  scriptId: '42', url: 'https://app.test/assets/main-a1b2.js',
  sourceMapURL: 'main-a1b2.js.map', hash: 'abc123', ...over,
});

/** Stands in for the session redactor: strips a query string, keeps the path. */
const strip = (url: string) => url.replace(/\?.*$/, '?[redacted]');
/** For the cases where redaction is not what is under test. */
const asis = (url: string) => url;

describe('fromScriptParsed', () => {
  it('keeps the fields a resolver needs', () => {
    expect(fromScriptParsed(parsed(), asis)).toEqual({
      scriptId: '42',
      url: 'https://app.test/assets/main-a1b2.js',
      sourceMapURL: 'main-a1b2.js.map',
      hash: 'abc123',
    });
  });

  it('records an inline map as a fact instead of carrying megabytes', () => {
    const out = fromScriptParsed(parsed({ sourceMapURL: 'data:application/json;base64,eyJ2Z' }), asis)!;
    expect(out.inlineMap).toBe(true);
    expect(out.sourceMapURL).toBeUndefined();
  });

  it('keeps a script with no map at all — "no map" is itself the answer', () => {
    const out = fromScriptParsed(parsed({ sourceMapURL: '' }), asis)!;
    expect(out.url).toBe('https://app.test/assets/main-a1b2.js');
    expect(out.sourceMapURL).toBeUndefined();
    expect(out.inlineMap).toBeUndefined();
  });

  it('carries buildId when the build tool emitted one', () => {
    expect(fromScriptParsed(parsed({ buildId: 'deadbeef' }), asis)!.buildId).toBe('deadbeef');
  });

  // AGENTS.md, non-negotiables: the raw value never reaches disk. A bundle
  // served from a signed CDN carries its credential in the query string, and so
  // does a sourceMappingURL pointing at a protected map.
  it('redacts the script URL and the map URL', () => {
    const out = fromScriptParsed(
      parsed({
        url: 'https://cdn.test/app.js?Signature=abc&Key-Pair-Id=K123',
        sourceMapURL: 'https://cdn.test/app.js.map?token=eyJhbGci',
      }),
      strip,
    )!;
    expect(out.url).toBe('https://cdn.test/app.js?[redacted]');
    expect(out.sourceMapURL).toBe('https://cdn.test/app.js.map?[redacted]');
  });

  it('filters our own scripts on the real URL, before redaction touches it', () => {
    expect(fromScriptParsed(parsed({ url: 'chrome-extension://abc/content.js' }), strip)).toBeNull();
  });

  it('skips our own scripts and anonymous eval', () => {
    expect(fromScriptParsed(parsed({ url: 'chrome-extension://abc/content.js' }), asis)).toBeNull();
    expect(fromScriptParsed(parsed({ url: 'devtools://devtools/x.js' }), asis)).toBeNull();
    expect(fromScriptParsed(parsed({ url: '' }), asis)).toBeNull();
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
