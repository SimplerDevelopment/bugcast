import { describe, expect, it } from 'vitest';
import { BODY_CAP_BYTES, isStream, isTextual, prepareBody } from './cdp-network';

describe('isTextual', () => {
  it('accepts the shapes error bodies actually arrive in', () => {
    for (const t of [
      'application/json; charset=utf-8',
      'text/html',
      'application/problem+json',
      'application/xml',
      'application/x-www-form-urlencoded',
    ]) {
      expect(isTextual(t), t).toBe(true);
    }
  });

  it('rejects binary', () => {
    for (const t of ['image/png', 'video/webm', 'application/octet-stream', 'font/woff2']) {
      expect(isTextual(t), t).toBe(false);
    }
  });

  it('assumes text when no content-type is given — the cap still protects us', () => {
    expect(isTextual(undefined)).toBe(true);
  });
});

describe('prepareBody', () => {
  it('keeps a small text body whole', () => {
    const r = prepareBody('{"error":"nope"}', false, 'application/json');
    expect(r.body).toBe('{"error":"nope"}');
    expect(r.truncated).toBe(false);
    expect(r.size).toBe(16);
  });

  it('truncates at the cap but reports the real size', () => {
    const raw = 'x'.repeat(BODY_CAP_BYTES + 5000);
    const r = prepareBody(raw, false, 'text/html');
    expect(r.body).toHaveLength(BODY_CAP_BYTES);
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(BODY_CAP_BYTES + 5000);
  });

  it('omits binary rather than storing base64 that inflates the artifact 4/3x', () => {
    const r = prepareBody('iVBORw0KGgo=', true, 'image/png');
    expect(r.omitted).toBe('binary');
    expect(r.body).toBeUndefined();
  });

  it('omits binary on content-type alone, even when not base64-flagged', () => {
    expect(prepareBody('...', false, 'application/octet-stream').omitted).toBe('binary');
  });

  it('marks event streams as streams — loadingFinished never fires for them', () => {
    const r = prepareBody('data: hi', false, 'text/event-stream');
    expect(r.omitted).toBe('stream');
    expect(r.body).toBeUndefined();
  });

  it('checks the stream case before the binary case', () => {
    // text/event-stream is textual, so ordering is what makes this reachable.
    expect(isStream('text/event-stream; charset=utf-8')).toBe(true);
    expect(prepareBody('data: hi', false, 'text/event-stream; charset=utf-8').omitted).toBe('stream');
  });
});
