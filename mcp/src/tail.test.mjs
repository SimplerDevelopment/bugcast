import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLive, tailEvents } from './sessions.mjs';

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
