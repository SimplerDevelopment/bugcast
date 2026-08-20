import { beforeEach, describe, expect, it } from 'vitest';
import { DefaultRedactor, describeValue, isSensitiveField, luhn } from './redact';

// A real-shaped JWT and a Visa test number, so the tests exercise the patterns
// against what they will actually meet.
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CARD = '4242424242424242';

let r: DefaultRedactor;
beforeEach(() => {
  r = new DefaultRedactor();
});

describe('headers', () => {
  it('keeps the scheme but not the credential', () => {
    const out = r.headers({ authorization: 'Bearer abc123def456ghi789' });
    expect(out.authorization).toBe('[redacted: Bearer ***]');
    expect(out.authorization).not.toContain('abc123');
  });

  it('reports cookie count and length without the values', () => {
    const out = r.headers({ cookie: 'a=1; b=2; c=3' });
    expect(out.cookie).toBe('[redacted: 3 cookies, 13 chars]');
  });

  it('catches sensitive names by pattern, not just an allow-list', () => {
    const out = r.headers({ 'X-Api-Key': 'k', 'x-session-id': 's', 'X-Auth-Token': 't' });
    for (const v of Object.values(out)) expect(v).toMatch(/^\[redacted/);
  });

  it('redacts a secret-shaped value under an innocuous header name', () => {
    const out = r.headers({ 'x-request-context': JWT });
    expect(out['x-request-context']).toMatch(/^\[redacted/);
    expect(r.summary().highEntropyMatches).toBe(1);
  });

  it('leaves ordinary headers alone — over-redacting everything is useless too', () => {
    const out = r.headers({ 'content-type': 'application/json', accept: '*/*' });
    expect(out['content-type']).toBe('application/json');
    expect(out.accept).toBe('*/*');
  });

  it('counts what it redacted', () => {
    r.headers({ authorization: 'Bearer x'.repeat(4), cookie: 'a=1' });
    expect(r.summary().headersRedacted).toEqual({ authorization: 1, cookie: 1 });
  });
});

describe('url', () => {
  it('redacts a sensitive query parameter but keeps the rest readable', () => {
    const out = r.url('https://app.example.com/api/media?siteId=12&token=deadbeefcafe0123');
    expect(out).toContain('siteId=12');
    expect(out).not.toContain('deadbeefcafe0123');
    expect(r.summary().urlParamsRedacted).toEqual({ token: 1 });
  });

  it('redacts OAuth code and state, which match no obvious pattern', () => {
    const out = r.url('https://app.example.com/cb?code=abc&state=xyz');
    expect(out).not.toContain('code=abc');
    expect(out).not.toContain('state=xyz');
  });

  it('redacts the fragment — OAuth implicit flow never touches a server but does touch disk', () => {
    const out = r.url(`https://app.example.com/#access_token=${JWT}&expires_in=3600`);
    expect(out).not.toContain('eyJ');
    expect(out).toContain('expires_in=3600');
  });

  it('redacts a secret-shaped value under an innocuous parameter name', () => {
    const out = r.url(`https://app.example.com/?ref=${JWT}`);
    expect(out).not.toContain('eyJhbGci');
  });

  it('leaves a clean URL untouched', () => {
    const clean = 'https://app.example.com/portal/websites/12/posts/487/edit';
    expect(r.url(clean)).toBe(clean);
  });

  it('passes through anything it cannot parse rather than throwing', () => {
    expect(r.url('/relative/path?token=x')).toBe('/relative/path?token=x');
    expect(r.url('')).toBe('');
  });
});

describe('body', () => {
  it('redacts by JSON key, recursively, through arrays', () => {
    const out = r.body(
      JSON.stringify({ user: { name: 'dan', apiKey: 'zzz' }, items: [{ token: 'qqq' }] }),
      'application/json',
    );
    expect(out).toContain('"name":"dan"');
    expect(out).not.toContain('zzz');
    expect(out).not.toContain('qqq');
    expect(r.summary().bodyKeysRedacted).toEqual({ apikey: 1, token: 1 });
  });

  it('catches a secret under an innocuous key, which key-matching alone cannot', () => {
    const out = r.body(JSON.stringify({ note: `here you go: ${JWT}` }), 'application/json');
    expect(out).not.toContain('eyJhbGci');
    expect(out).toContain('here you go');
  });

  it('scrubs form-encoded and plain-text bodies, which have no keys to inspect', () => {
    expect(r.body(`grant_type=refresh&assertion=${JWT}`, 'application/x-www-form-urlencoded'))
      .not.toContain('eyJhbGci');
    expect(r.body(`ghp_abcdefghijklmnopqrstuvwxyz0123`, 'text/plain')).toMatch(/redacted/);
  });

  it('redacts a Luhn-valid card number but not an ordinary long number', () => {
    expect(r.body(`{"pan":"${CARD}"}`, 'application/json')).not.toContain(CARD);
    const notACard = '1234567890123456'; // fails Luhn
    expect(r.body(`ref ${notACard}`, 'text/plain')).toContain(notACard);
  });

  it('survives malformed JSON by falling through to the text pass', () => {
    const out = r.body(`{not json, token=${JWT}`, 'application/json');
    expect(out).not.toContain('eyJhbGci');
  });

  it('preserves a real error body, which is the whole point of capturing it', () => {
    const body = '{"success":false,"error":{"code":"DB_ERROR","message":"column \\"x\\" does not exist"}}';
    expect(r.body(body, 'application/json')).toContain('does not exist');
  });
});

describe('describeValue', () => {
  it.each([
    ['dan@example.com', 'email'],
    ['https://example.com/x', 'url'],
    [JWT, 'jwt'],
    [CARD, 'card'],
    ['+1 (555) 123-4567', 'phone'],
    ['42', 'number'],
    ['hello there', 'text'],
  ])('classifies %s as %s', (value, shape) => {
    expect(describeValue(value).shape).toBe(shape);
  });

  it('reports length without revealing content', () => {
    const d = describeValue('hunter2hunter2');
    expect(d.chars).toBe(14);
    expect(JSON.stringify(d)).not.toContain('hunter');
  });
});

describe('isSensitiveField', () => {
  it('catches type=password', () => {
    expect(isSensitiveField({ type: 'password' })).toBe(true);
  });

  it('catches standardised autocomplete tokens before any heuristic', () => {
    for (const ac of ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc']) {
      expect(isSensitiveField({ type: 'text', autocomplete: ac }), ac).toBe(true);
    }
  });

  it('catches name, id and label patterns', () => {
    expect(isSensitiveField({ name: 'apiKey' })).toBe(true);
    expect(isSensitiveField({ id: 'user-secret' })).toBe(true);
    expect(isSensitiveField({ ariaLabel: 'Card number' })).toBe(true);
  });

  it('catches a secret pasted into a field nobody labelled', () => {
    expect(isSensitiveField({ type: 'text', name: 'notes', value: JWT })).toBe(true);
    expect(isSensitiveField({ type: 'text', name: 'notes', value: CARD })).toBe(true);
  });

  it('leaves an ordinary field alone', () => {
    expect(isSensitiveField({ type: 'text', name: 'quote', value: 'Great service' })).toBe(false);
  });
});

describe('luhn', () => {
  it('accepts known-good test numbers and rejects near-misses', () => {
    expect(luhn('4242424242424242')).toBe(true);
    expect(luhn('4242 4242 4242 4242')).toBe(true);
    expect(luhn('4242424242424243')).toBe(false);
    expect(luhn('123')).toBe(false); // too short to be a card at all
  });
});
