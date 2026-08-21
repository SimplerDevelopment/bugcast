// Proves a live session actually produces notifications/claude/channel on the
// wire. The filter is unit-tested; this tests that anything is emitted at all.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bugcast-chan-'));

const child = spawn('node', [path.join(here, '..', 'src', 'index.mjs'), '--dir', root], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const notifications = [];
let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === 'notifications/claude/channel') notifications.push(msg.params);
  }
});

let id = 0;
const call = (method, params) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });

const init = await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: { experimental: { 'claude/channel': {} } },
  clientInfo: { name: 'channel-smoke', version: '0' },
});
console.log('server capabilities:', JSON.stringify(init.result.capabilities.experimental ?? {}));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// A session appears and starts streaming — exactly what recording produces.
const id2 = '2026-08-20T23-59-59_x-test';
fs.mkdirSync(path.join(root, id2));
const stream = path.join(root, id2, 'events.ndjson');
fs.writeFileSync(stream, JSON.stringify({ type: 'click', t: 100, pageUrl: 'https://x.test/' }) + '\n');

await new Promise((r) => setTimeout(r, 2600));
fs.appendFileSync(
  stream,
  JSON.stringify({ type: 'marker', t: 5000, note: 'this is the bug' }) + '\n' +
    JSON.stringify({
      type: 'network', t: 5200, method: 'PATCH', url: 'https://x.test/api', status: 500,
      response: { body: '{"error":"column x does not exist"}' },
    }) + '\n' +
    JSON.stringify({ type: 'click', t: 5300, pageUrl: 'https://x.test/' }) + '\n',
);
await new Promise((r) => setTimeout(r, 2600));

console.log(`\n${notifications.length} channel notification(s):`);
for (const n of notifications) console.log(`  [${n.meta?.type}] ${n.content.replace(/\n/g, '\n    ')}`);

child.kill();
const kinds = notifications.map((n) => n.meta?.type);
const events = notifications.find((n) => n.meta?.type === 'session_events');
process.exitCode =
  kinds.includes('session_started') &&
  events?.content.includes('MARKED BY THE TESTER') &&
  events?.content.includes('column x does not exist') &&
  !events?.content.includes('click')
    ? 0
    : 1;
