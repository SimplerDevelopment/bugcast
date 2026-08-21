/**
 * What does reading a session actually cost?
 *
 * `tailEvents` reads the whole ndjson and splits it on every call, then slices
 * from a line cursor. That is O(file) per call, and the channel calls it on
 * every watcher wake for the life of a recording — so the obvious reaction is
 * "replace the line cursor with a byte offset."
 *
 * Ticket 17 rejected that on principle, and the principle is real: a line count
 * cannot land mid-record the way a byte offset can while a write is in flight,
 * the reader already drops a trailing partial line, and it breaks on an
 * unparseable line rather than corrupting the cursor. Trading that for an
 * unmeasured win is a bad trade.
 *
 * So: measure first. This exists to produce a number, not to justify a change.
 * A null result is a result.
 *
 * MEASURED 2026-08-21 — and the answer is **leave it alone**:
 *
 *     500 events  (279 KB)   whole follow-loop  42ms total   0.42ms/wake
 *   2,000 events  (1.1 MB)   whole follow-loop 497ms total   1.24ms/wake
 *  10,000 events  (5.6 MB)   whole follow-loop  12.3s total  6.17ms/wake
 *
 * A fifteen-minute session is the first row. Forty-two milliseconds spread
 * across the entire recording is not a cost worth trading a correctness
 * property for. The O(n²) is real and shows up in the third row — a
 * pathological 10k-event session spends 12s of CPU across the whole run, about
 * 1.3% of one core — but that is still not the shape of a problem anyone has.
 *
 * `filterEvents` with `match` stringifies every event and costs 15ms at 10k.
 * It runs once per query, not per wake. Fine.
 *
 * Re-run this before revisiting the cursor. If sessions ever get an order of
 * magnitude longer, the answer changes — and the fix is a cached byte offset
 * *alongside* the line cursor, not instead of it.
 *
 *   node scripts/tail-probe.mjs
 */
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tailEvents, filterEvents } from '../src/sessions.mjs';

/** A network event with headers and a body — the big ones, not the cheap ones. */
const fatEvent = (i) => JSON.stringify({
  type: 'network', t: i * 90, tEnd: i * 90 + 40, pageUrl: 'https://app.example.com/editor/42',
  requestId: `${i}.${i}`, method: 'POST', url: `https://app.example.com/api/posts/${i}`,
  resourceType: 'Fetch', status: i % 11 === 0 ? 500 : 200,
  request: { headers: { accept: 'application/json', 'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', referer: 'https://app.example.com/editor/42' },
    postData: JSON.stringify({ blocks: [], title: `post ${i}`, tags: ['a', 'b'] }) },
  response: { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    ...(i % 11 === 0 ? { body: JSON.stringify({ success: false, error: { code: 'DB_ERROR', message: 'column does not exist' } }) } : {}) },
});

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (n) => `${n.toFixed(2)}ms`;

async function build(root, id, count) {
  await mkdir(path.join(root, id), { recursive: true });
  const lines = Array.from({ length: count }, (_, i) => fatEvent(i)).join('\n') + '\n';
  await writeFile(path.join(root, id, 'events.ndjson'), lines);
  return Buffer.byteLength(lines);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'bugcast-tailprobe-'));

console.log('=== one tailEvents call, by session size and cursor position ===');
console.log('a 15-minute session runs to a few hundred events; 10k is a pathological one\n');
for (const count of [500, 2_000, 10_000]) {
  const id = `s${count}`;
  const bytes = await build(root, id, count);
  const at = async (cursor) => {
    const runs = [];
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      await tailEvents(root, id, cursor, 200);
      runs.push(performance.now() - t);
    }
    return median(runs);
  };
  console.log(
    `${String(count).padStart(6)} events (${String(Math.round(bytes / 1024)).padStart(5)} KB)  ` +
      `cursor=0 ${ms(await at(0)).padStart(8)}   ` +
      `cursor=mid ${ms(await at(Math.floor(count / 2))).padStart(8)}   ` +
      `cursor=end ${ms(await at(count)).padStart(8)}`,
  );
}

console.log('\n=== the number that actually matters: a whole follow-loop ===');
console.log('the channel re-reads from its cursor on every wake, all session long\n');
for (const [count, burst] of [[500, 5], [2_000, 5], [10_000, 5]]) {
  const id = `loop${count}`;
  await mkdir(path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, 'events.ndjson'), '');
  let cursor = 0;
  let total = 0;
  let wakes = 0;
  for (let i = 0; i < count; i += burst) {
    await appendFile(
      path.join(root, id, 'events.ndjson'),
      Array.from({ length: burst }, (_, k) => fatEvent(i + k)).join('\n') + '\n',
    );
    const t = performance.now();
    const out = await tailEvents(root, id, cursor, 500);
    total += performance.now() - t;
    cursor = out.cursor;
    wakes++;
  }
  console.log(
    `${String(count).padStart(6)} events in ${String(wakes).padStart(4)} wakes  ` +
      `total ${ms(total).padStart(9)}  per wake ${ms(total / wakes).padStart(8)}`,
  );
}

console.log('\n=== filterEvents with `match`, which stringifies every event ===\n');
for (const count of [500, 2_000, 10_000]) {
  const events = Array.from({ length: count }, (_, i) => JSON.parse(fatEvent(i)));
  const runs = [];
  for (let i = 0; i < 15; i++) {
    const t = performance.now();
    filterEvents(events, { match: 'DB_ERROR', limit: 100 });
    runs.push(performance.now() - t);
  }
  console.log(`${String(count).padStart(6)} events   match ${ms(median(runs)).padStart(8)}`);
}

await rm(root, { recursive: true, force: true });
console.log('\nRead this against how often it happens: a wake per burst of activity,');
console.log('not per interval — the channel switched to fs.watch in 521299d.');
