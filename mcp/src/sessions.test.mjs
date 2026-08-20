import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSchema, filterEvents, isFailure, resolveSessionId } from './sessions.mjs';

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
