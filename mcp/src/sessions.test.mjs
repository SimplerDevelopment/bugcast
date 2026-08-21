import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkSchema,
  filterEvents,
  isFailure,
  navigationIndex,
  pageUrlAt,
  resolveSessionId,
  stampPageUrls,
} from './sessions.mjs';

const LISTING = ['2026-08-20T14-32-09_app-simplerdev-com', '2026-08-19T09-00-00_localhost-3000'];

test('resolveSessionId returns a listed id', () => {
  assert.equal(resolveSessionId(LISTING[0], LISTING), LISTING[0]);
});

test('resolveSessionId refuses path traversal instead of sanitising it', () => {
  for (const evil of ['../../.ssh', '..', './x', '/etc/passwd', 'a/../../b']) {
    assert.throws(() => resolveSessionId(evil, LISTING), /No session/, evil);
  }
});

test('resolveSessionId refuses empty and non-string ids', () => {
  for (const bad of ['', null, undefined, 42, {}]) {
    assert.throws(() => resolveSessionId(bad, LISTING));
  }
});

test('resolveSessionId points the caller at how to find real ids', () => {
  assert.throws(() => resolveSessionId('nope', LISTING), /sessions_list/);
});

test('checkSchema accepts the supported version', () => {
  assert.doesNotThrow(() => checkSchema(1, 'timeline.json'));
});

test('checkSchema refuses a newer schema and says how to upgrade', () => {
  assert.throws(() => checkSchema(2, 'timeline.json'), /npx -y bugcast@latest/);
});

test('checkSchema refuses a file with no schemaVersion at all', () => {
  assert.throws(() => checkSchema(undefined, 'timeline.json'), /is this a bugcast session/);
});

const net = (t, status, extra = {}) => ({ type: 'network', t, status, ...extra });

test('isFailure counts 4xx and 5xx but not an abort', () => {
  assert.equal(isFailure(net(0, 500)), true);
  assert.equal(isFailure(net(0, 404)), true);
  assert.equal(isFailure(net(0, 200)), false);
  assert.equal(
    isFailure({ type: 'network', t: 0, failure: { errorText: 'net::ERR_ABORTED', canceled: true } }),
    false,
  );
});

const EVENTS = [
  { type: 'click', t: 100 },
  net(200, 200),
  net(300, 500),
  { type: 'console', t: 400, level: 'error', text: 'Failed to save post' },
];

test('filterEvents narrows by type', () => {
  assert.equal(filterEvents(EVENTS, { type: 'network' }).total, 2);
  assert.equal(filterEvents(EVENTS, { type: ['click', 'console'] }).total, 2);
});

test('filterEvents answers "what failed" without the rest of the timeline', () => {
  const out = filterEvents(EVENTS, { failedOnly: true });
  assert.equal(out.total, 1);
  assert.equal(out.events[0].t, 300);
});

test('filterEvents narrows by time window', () => {
  assert.equal(filterEvents(EVENTS, { from: 250 }).total, 2);
  assert.equal(filterEvents(EVENTS, { to: 250 }).total, 2);
  assert.equal(filterEvents(EVENTS, { from: 150, to: 350 }).total, 2);
});

test('filterEvents matches text anywhere in the event, case-insensitively', () => {
  assert.equal(filterEvents(EVENTS, { match: 'failed to save' }).total, 1);
});

test('filterEvents reports truncation rather than silently dropping', () => {
  const out = filterEvents(EVENTS, { limit: 2 });
  assert.equal(out.events.length, 2);
  assert.equal(out.total, 4);
  assert.equal(out.truncated, true);
});

test('filterEvents is empty-safe', () => {
  assert.deepEqual(filterEvents([], {}), { total: 0, events: [], truncated: false });
});

// Narration ships `pageUrl: ''` because the offscreen document that writes
// speech.ndjson shares nothing with the event pipeline but the clock. The page
// is derived from the navigations around it instead.
const NAVS = [
  { type: 'navigation', t: 0, pageUrl: 'https://x.test/a' },
  { type: 'navigation', t: 5000, pageUrl: 'https://x.test/b' },
  { type: 'navigation', t: 9000, pageUrl: 'https://x.test/c' },
];

test('navigationIndex keeps only navigations that carry a url, sorted by t', () => {
  const index = navigationIndex([
    { type: 'click', t: 100, pageUrl: 'https://x.test/click' },
    NAVS[2],
    { type: 'navigation', t: 3000, pageUrl: '' },
    NAVS[0],
    NAVS[1],
  ]);
  assert.deepEqual(index.map((n) => n.t), [0, 5000, 9000]);
});

test('pageUrlAt returns the navigation in effect at that moment', () => {
  const index = navigationIndex(NAVS);
  assert.equal(pageUrlAt(index, 0), 'https://x.test/a');
  assert.equal(pageUrlAt(index, 4999), 'https://x.test/a');
  assert.equal(pageUrlAt(index, 5000), 'https://x.test/b', 'boundary is inclusive');
  assert.equal(pageUrlAt(index, 7000), 'https://x.test/b');
  assert.equal(pageUrlAt(index, 99000), 'https://x.test/c', 'past the last nav');
});

test('pageUrlAt yields nothing rather than guessing when it cannot know', () => {
  assert.equal(pageUrlAt([], 1234), '', 'no navigations at all');
  // Speech transcribed from a window that opened before the first navigation.
  assert.equal(pageUrlAt(navigationIndex(NAVS.slice(1)), 10), '');
});

test('stampPageUrls fills the blank narration left by the capture pipeline', () => {
  const out = stampPageUrls(
    [{ type: 'speech', t: 6000, pageUrl: '', text: 'this is the bug' }],
    navigationIndex(NAVS),
  );
  assert.equal(out[0].pageUrl, 'https://x.test/b');
  assert.equal(out[0].text, 'this is the bug', 'the rest of the record is untouched');
});

test('stampPageUrls never overwrites a page the event recorded itself', () => {
  // If capture is fixed later, its value must win over this derivation.
  const real = [{ type: 'speech', t: 6000, pageUrl: 'https://x.test/recorded' }];
  assert.equal(stampPageUrls(real, navigationIndex(NAVS))[0].pageUrl, 'https://x.test/recorded');
});

test('stampPageUrls leaves events alone when there is nothing to derive from', () => {
  const events = [{ type: 'speech', t: 10, pageUrl: '' }];
  assert.deepEqual(stampPageUrls(events, []), events);
});
