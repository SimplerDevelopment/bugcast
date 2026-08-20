// Speaks real MCP over stdio to the real server, against the hand-authored
// example session in docs/design/prototype/. Proves the handshake, the tool
// list, and that a query returns the failure the artifact was built around.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(here, '..', '..', 'docs', 'design', 'prototype');

const child = spawn('node', [path.join(here, '..', 'src', 'index.mjs'), '--dir', DIR], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

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
    pending.get(msg.id)?.(msg);
  }
});

let id = 0;
const call = (method, params) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });

await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = await call('tools/list', {});
console.log('tools:', tools.result.tools.map((t) => t.name).join(', '));

const list = await call('tools/call', { name: 'sessions_list', arguments: {} });
const sessions = JSON.parse(list.result.content[0].text);
console.log('sessions:', sessions.map((s) => `${s.id} (${s.title})`).join(', '));

const failures = await call('tools/call', {
  name: 'session_query',
  arguments: { sessionId: sessions[0].id, failedOnly: true },
});
const found = JSON.parse(failures.result.content[0].text);
console.log(`failedOnly -> ${found.total} of the timeline`);
console.log('body:', found.events[0]?.response?.body?.slice(0, 110));

const evil = await call('tools/call', {
  name: 'session_query',
  arguments: { sessionId: '../../../etc', failedOnly: true },
});
console.log('traversal:', evil.result.isError ? 'refused' : 'ALLOWED — BUG');

child.kill();
process.exitCode = found.total === 2 && evil.result.isError ? 0 : 1;
