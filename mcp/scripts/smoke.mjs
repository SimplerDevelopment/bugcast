// Speaks real MCP over stdio to the real server, against the hand-authored
// example session in docs/design/prototype/. Proves the handshake, the tool
// list, and that a query returns the failure the artifact was built around.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(here, '..', '..', 'docs', 'design', 'prototype');

/**
 * A stand-in for the developer's checkout.
 *
 * `session_resolve` searches `process.cwd()` — the project this server was
 * launched in — so the server is spawned with its cwd here, and the map is
 * placed where a bundler would leave it. The map is real: node's own SourceMap
 * consumer decodes generated column 19 to flush.ts line 4, which is what the
 * assertion below checks against.
 */
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'bugcast-project-'));
fs.mkdirSync(path.join(PROJECT, 'dist', 'assets'), { recursive: true });
fs.writeFileSync(
  path.join(PROJECT, 'dist', 'assets', 'portal-4f2a9c.js.map'),
  JSON.stringify({
    version: 3,
    file: 'portal-4f2a9c.js',
    sources: ['src/portal/editor/save.ts', 'src/portal/editor/flush.ts'],
    names: ['savePost'],
    mappings: 'AAAUE,mBCIA',
  }),
);

const child = spawn('node', [path.join(here, '..', 'src', 'index.mjs'), '--dir', DIR], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: PROJECT,
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

// The two halves of source-map support, tested against each other for the first
// time. The extension writes scripts.json (its own smoke proves that, including
// that sourceMapURL survives the scriptParsed replay); this proves the server
// reads that same shape and resolves a frame through a map on disk. Each half
// passing alone is not evidence they agree — events.ndjson and timeline.json
// diverged exactly that way once.
const resolved = await call('tools/call', {
  name: 'session_resolve',
  arguments: {
    sessionId: sessions[0].id,
    stack: `Error: Failed to save post
    at savePost (https://app.simplerdev.com/assets/portal-4f2a9c.js:1:20)
    at flush (https://app.simplerdev.com/assets/vendor-8b1e2d.js:1:5)
    at tick (https://cdn.plausible.io/js/script.js:1:1)`,
  },
});
const frames = JSON.parse(resolved.result.content[0].text).frames ?? [];
console.log('resolve:', frames.map((f) => (f.resolved ? `${f.source}:${f.sourceLine}` : `unresolved (${f.why})`)).join(' | '));

// Frame 1 has a map on disk and must resolve. Column 20 in a 1-indexed stack is
// generated column 19, which this map sends to flush.ts line 4 — so line 5 out.
// An off-by-one here would look entirely plausible, which is why it is asserted
// on a non-zero line rather than the first mapping.
const first = frames[0];
const mapped = first?.resolved && first.source === 'src/portal/editor/flush.ts' && first.sourceLine === 5;
if (!mapped) console.error('FAIL: a frame with a map on disk did not resolve —', JSON.stringify(first));

// Frame 2 is indexed with a sourceMapURL but the map is not in this checkout,
// and frame 3 is not in the index at all. Both must say so rather than guess: an
// agent acts on what it is told, and a confidently wrong file is the worst
// answer this tool can give.
const explained = frames.slice(1).every((f) => !f.resolved && typeof f.why === 'string' && f.why.length);
if (!explained) console.error('FAIL: an unresolvable frame did not explain itself —', JSON.stringify(frames.slice(1)));

const evil = await call('tools/call', {
  name: 'session_query',
  arguments: { sessionId: '../../../etc', failedOnly: true },
});
console.log('traversal:', evil.result.isError ? 'refused' : 'ALLOWED — BUG');

child.kill();
fs.rmSync(PROJECT, { recursive: true, force: true });
process.exitCode = found.total === 2 && evil.result.isError && mapped && explained ? 0 : 1;
