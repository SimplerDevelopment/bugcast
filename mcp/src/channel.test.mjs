import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe as describeEvent, isNotable } from './channel.mjs';

const net = (over = {}) => ({
  type: 'network', t: 11942, method: 'PATCH',
  url: 'https://app.test/api/posts/487', status: 500, ...over,
});

test('wakes an agent for a marker — the strongest signal there is', () => {
  assert.equal(isNotable({ type: 'marker', t: 0, note: 'this is the bug' }), true);
});

test('wakes for failures, exceptions and console errors', () => {
  assert.equal(isNotable(net()), true);
  assert.equal(isNotable({ type: 'exception', t: 0, text: 'boom' }), true);
  assert.equal(isNotable({ type: 'console', t: 0, level: 'error', text: 'x' }), true);
});

test('stays quiet for the volume — clicks, navigations, ordinary logs, successes', () => {
  for (const event of [
    { type: 'click', t: 0 },
    { type: 'navigation', t: 0 },
    { type: 'console', t: 0, level: 'log', text: 'hi' },
    net({ status: 200 }),
    { type: 'focus', t: 0 },
    { type: 'change', t: 0 },
  ]) {
    assert.equal(isNotable(event), false, event.type + (event.level ?? event.status ?? ''));
  }
});

test('stays quiet for provisional speech, which changes under you', () => {
  assert.equal(isNotable({ type: 'speech', t: 0, text: 'clicking save', provisional: true }), false);
  assert.equal(isNotable({ type: 'speech', t: 0, text: 'clicking save' }), false);
});

test('an aborted request is not a failure — navigation cancels those routinely', () => {
  assert.equal(
    isNotable(net({ status: undefined, failure: { errorText: 'net::ERR_ABORTED', canceled: true } })),
    false,
  );
  assert.equal(
    isNotable(net({ status: undefined, failure: { errorText: 'net::ERR_FAILED', canceled: false } })),
    true,
  );
});

test('describes an event as one actionable line, timestamped', () => {
  assert.equal(
    describeEvent({ type: 'marker', t: 11942, note: 'save is broken' }),
    '[00:11.942] MARKED BY THE TESTER: save is broken',
  );
});

test('carries the response body, which is usually the whole answer', () => {
  const line = describeEvent(net({ response: { body: '{"error":"column x does not exist"}' } }));
  assert.match(line, /-> 500/);
  assert.match(line, /column x does not exist/);
});

test('caps the body so one huge response cannot flood a notification', () => {
  const line = describeEvent(net({ response: { body: 'x'.repeat(5000) } }));
  assert.ok(line.length < 600);
});
