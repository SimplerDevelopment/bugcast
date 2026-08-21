import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLive, MAX_WAIT_MS, SAFE_WAIT_MS, tailEvents, tailEventsWaiting, waitForChange } from './sessions.mjs';

function fixture(ndjson, { timeline = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bugcast-tail-'));
  const id = '2026-08-20T14-32-09_x-test';
  fs.mkdirSync(path.join(root, id));
  fs.writeFileSync(path.join(root, id, 'events.ndjson'), ndjson);
  if (timeline) fs.writeFileSync(path.join(root, id, 'timeline.json'), '{"schemaVersion":1}');
  return { root, id };
}

const line = (t, type = 'click') => JSON.stringify({ t, type, pageUrl: 'https://x.test/' });

test('reads from the start and returns a usable cursor', async () => {
  const { root, id } = fixture([line(1), line(2), line(3)].join('\n') + '\n');
  const out = await tailEvents(root, id);
  assert.equal(out.events.length, 3);
  assert.equal(out.cursor, 3);
  assert.equal(out.more, false);
});

test('resumes from a cursor without re-reading', async () => {
  const { root, id } = fixture([line(1), line(2), line(3)].join('\n') + '\n');
  const out = await tailEvents(root, id, 2);
  assert.deepEqual(out.events.map((e) => e.t), [3]);
  assert.equal(out.cursor, 3);
});

test('reports more when the limit truncates', async () => {
  const { root, id } = fixture([line(1), line(2), line(3)].join('\n') + '\n');
  const out = await tailEvents(root, id, 0, 2);
  assert.equal(out.events.length, 2);
  assert.equal(out.more, true);
  assert.equal(out.total, 3);
});

test('drops a partial trailing line rather than failing on it', async () => {
  // Exactly what a reader sees mid-flush: writes are batched, so a poll can land
  // between the record and its newline.
  const { root, id } = fixture(line(1) + '\n' + '{"t":2,"type":"cli');
  const out = await tailEvents(root, id);
  assert.equal(out.events.length, 1);
  assert.equal(out.cursor, 1);
});

test('a session with a stream and no timeline is still recording', async () => {
  const { root, id } = fixture(line(1) + '\n');
  assert.equal(await isLive(root, id), true);
  assert.equal((await tailEvents(root, id)).live, true);
});

test('a session with a timeline has finished', async () => {
  const { root, id } = fixture(line(1) + '\n', { timeline: true });
  assert.equal(await isLive(root, id), false);
});

test('an absent stream is empty rather than an error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bugcast-tail-'));
  fs.mkdirSync(path.join(root, 'empty'));
  const out = await tailEvents(root, 'empty');
  assert.deepEqual(out.events, []);
  assert.equal(out.total, 0);
});

test('provisional speech is visible as provisional', async () => {
  const provisional = JSON.stringify({ t: 5, type: 'speech', text: 'clicking save', provisional: true });
  const { root, id } = fixture(provisional + '\n');
  const [event] = (await tailEvents(root, id)).events;
  assert.equal(event.provisional, true);
});

test('waitForChange returns as soon as the stream grows', async () => {
  const { root, id } = fixture(line(1) + '\n');
  const started = Date.now();
  const waiting = waitForChange(root, id, 5000);
  setTimeout(() => fs.appendFileSync(path.join(root, id, 'events.ndjson'), line(2) + '\n'), 60);
  assert.equal(await waiting, true);
  // The point of watching rather than polling: it returns on the event, not on
  // an interval boundary.
  assert.ok(Date.now() - started < 2000, 'should not have waited out the deadline');
});

test('waiting tail gives up at the deadline rather than hanging', async () => {
  // fs.watch fires for metadata touches too, so this asserts the *loop*
  // survives a spurious wake rather than returning early on one.
  const { root, id } = fixture(line(1) + '\n');
  const started = Date.now();
  const out = await tailEventsWaiting(root, id, 1, 200, 400);
  assert.deepEqual(out.events, []);
  assert.ok(Date.now() - started >= 350, 'should have waited out the deadline');
});

test('waiting tail returns as soon as real events land', async () => {
  const { root, id } = fixture(line(1) + '\n');
  const started = Date.now();
  const waiting = tailEventsWaiting(root, id, 1, 200, 5000);
  setTimeout(() => fs.appendFileSync(path.join(root, id, 'events.ndjson'), line(2) + '\n'), 80);
  const out = await waiting;
  assert.deepEqual(out.events.map((e) => e.t), [2]);
  assert.ok(Date.now() - started < 2000);
});

test('waiting tail does not wait on a finished session', async () => {
  const { root, id } = fixture(line(1) + '\n', { timeline: true });
  const started = Date.now();
  await tailEventsWaiting(root, id, 1, 200, 5000);
  assert.ok(Date.now() - started < 300, 'no more events can arrive, so do not block');
});

test('waitForChange caps the wait, so a tool call cannot be held open forever', async () => {
  const { root, id } = fixture(line(1) + '\n');
  const started = Date.now();
  // Asks for an hour; must not be honoured.
  const waiting = waitForChange(root, id, 60 * 60 * 1000);
  setTimeout(() => fs.appendFileSync(path.join(root, id, 'events.ndjson'), line(2) + '\n'), 50);
  await waiting;
  assert.ok(Date.now() - started < MAX_WAIT_MS + 1000);
  // The ceiling is opt-in headroom for a main-conversation follow-loop; the
  // value safe from any caller stays 30s.
  assert.equal(MAX_WAIT_MS, 110_000);
  assert.equal(SAFE_WAIT_MS, 30_000);
  assert.ok(SAFE_WAIT_MS < MAX_WAIT_MS);
});

test('waitForChange tolerates a session directory that does not exist yet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bugcast-tail-'));
  // An agent can start following before the first flush creates anything.
  assert.equal(await waitForChange(root, 'not-yet', 150), false);
});

test('zero wait resolves immediately', async () => {
  const { root, id } = fixture(line(1) + '\n');
  const started = Date.now();
  assert.equal(await waitForChange(root, id, 0), false);
  assert.ok(Date.now() - started < 50);
});

test('reads the speech stream separately from events', async () => {
  const { root, id } = fixture(line(1) + '\n');
  fs.writeFileSync(
    path.join(root, id, 'speech.ndjson'),
    JSON.stringify({ t: 900, type: 'speech', text: 'clicking save', provisional: true }) + '\n',
  );
  const events = await tailEvents(root, id, 0, 200, 'events');
  const speech = await tailEvents(root, id, 0, 200, 'speech');
  assert.equal(events.events[0].type, 'click');
  assert.equal(speech.events[0].type, 'speech');
  assert.equal(speech.stream, 'speech');
});

test('an absent speech stream is empty, not an error — a silent session has none', async () => {
  const { root, id } = fixture(line(1) + '\n');
  const out = await tailEvents(root, id, 0, 200, 'speech');
  assert.deepEqual(out.events, []);
});

test('the two streams merge on t, and narration precedes the action', async () => {
  const { root, id } = fixture(JSON.stringify({ t: 1000, type: 'click' }) + '\n');
  fs.writeFileSync(
    path.join(root, id, 'speech.ndjson'),
    JSON.stringify({ t: 330, type: 'speech', text: 'and clicking save' }) + '\n',
  );
  const merged = [
    ...(await tailEvents(root, id, 0, 200, 'events')).events,
    ...(await tailEvents(root, id, 0, 200, 'speech')).events,
  ].sort((a, b) => a.t - b.t);
  assert.deepEqual(merged.map((e) => e.type), ['speech', 'click']);
});
