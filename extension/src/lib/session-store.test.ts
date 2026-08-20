import { describe, expect, it } from 'vitest';
import { sessionId } from './session-store';

const AT = new Date('2026-08-20T14:32:09.412Z');

describe('sessionId', () => {
  it('matches the shape the artifact contract specifies', () => {
    expect(sessionId(AT, 'https://app.simplerdev.com/portal/websites/12/posts/487/edit')).toBe(
      '2026-08-20T14-32-09_app-simplerdev-com',
    );
  });

  it('never contains a colon — they are illegal in Windows filenames', () => {
    expect(sessionId(AT, 'https://x.test/')).not.toContain(':');
  });

  it('contains only characters legal in a filename on every platform', () => {
    const id = sessionId(AT, 'https://user:pw@Foo_Bar.example.com:8443/path?q=1#h');
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('sorts chronologically as a string, which is why the stamp leads', () => {
    const earlier = sessionId(new Date('2026-08-20T09:00:00Z'), 'https://x.test/');
    const later = sessionId(new Date('2026-08-20T14:00:00Z'), 'https://x.test/');
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('keeps the port, since localhost:3000 and localhost:8080 are different apps', () => {
    expect(sessionId(AT, 'http://localhost:3000/')).toContain('localhost-3000');
  });

  it('falls back rather than throwing on a URL it cannot parse', () => {
    expect(sessionId(AT, 'not a url')).toBe('2026-08-20T14-32-09_unknown');
    expect(sessionId(AT, '')).toBe('2026-08-20T14-32-09_unknown');
  });
});
