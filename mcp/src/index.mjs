#!/usr/bin/env node
/**
 * bugcast MCP server.
 *
 * Optional, and strictly additive. Recording never depends on this: a user who
 * never configures MCP still points their agent at `report.md` and gets
 * everything. If this ever becomes the only good way to read a session,
 * something has gone wrong.
 *
 * Read-only, always. No write, no delete, no move — an agent must not be able
 * to destroy the evidence it was asked to look at, and there is no use case
 * that needs it.
 *
 * Usage:
 *   npx -y bugcast --dir ~/qa-sessions
 */

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import os from 'node:os';
import {
  assertReadable,
  filterEvents,
  tailEvents,
  listSessionIds,
  readFrame,
  readReport,
  readTimeline,
  resolveSessionId,
  summarise,
} from './sessions.mjs';

/**
 * Where sessions live.
 *
 * Defaulted rather than required, so this server can be registered once at user
 * scope and work in every project without per-project configuration. The
 * extension cannot tell us the path — the File System Access API never exposes
 * one — so the default is a convention both ends can agree on by name.
 */
export const DEFAULT_DIR = path.join(os.homedir(), 'bugcast-sessions');

function parseDir(argv) {
  const i = argv.indexOf('--dir');
  const value = i >= 0 ? argv[i + 1] : process.env.BUGCAST_DIR;
  // Resolved once, here, and never joined with anything user-supplied again.
  return path.resolve(value || DEFAULT_DIR);
}

const ROOT = parseDir(process.argv.slice(2));
await assertReadable(ROOT);

const server = new McpServer({ name: 'bugcast', version: '0.1.0' });

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/** Every session id is resolved against the real listing, never joined. */
const resolve = async (id) => resolveSessionId(id, await listSessionIds(ROOT));

server.registerTool(
  'sessions_list',
  {
    title: 'List recorded sessions',
    description: 'Recent bugcast QA sessions, newest first, with duration and what was captured.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20).optional() },
  },
  async ({ limit = 20 }) => {
    const ids = (await listSessionIds(ROOT)).slice(0, limit);
    return text(await Promise.all(ids.map((id) => summarise(ROOT, id))));
  },
);

server.registerTool(
  'session_report',
  {
    title: 'Read a session report',
    description:
      'The human-readable rendering of a session: failures grouped with counts, the interleaved timeline, and the redaction summary. Start here.',
    inputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => text(await readReport(ROOT, await resolve(sessionId))),
);

server.registerTool(
  'session_query',
  {
    title: 'Query a session timeline',
    description:
      'A filtered slice of the timeline. Prefer this over reading timeline.json whole — a fifteen-minute session is roughly 50k tokens. Use failedOnly:true for "what went wrong".',
    inputSchema: {
      sessionId: z.string(),
      type: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('navigation, speech, click, keydown, change, submit, drag, focus, marker, network, console, exception'),
      failedOnly: z.boolean().optional().describe('Only failed requests. Aborts do not count.'),
      from: z.number().optional().describe('Milliseconds from session start'),
      to: z.number().optional(),
      match: z.string().optional().describe('Case-insensitive substring across the whole event'),
      limit: z.number().int().min(1).max(500).default(100).optional(),
    },
  },
  async ({ sessionId, ...query }) => {
    const timeline = await readTimeline(ROOT, await resolve(sessionId));
    return text(filterEvents(timeline.events ?? [], query));
  },
);

server.registerTool(
  'session_tail',
  {
    title: 'Read a session as it is being recorded',
    description:
      'Events since a cursor, from the append-only stream. Works while recording is still in progress — poll with the returned cursor to follow along. Speech events flagged provisional:true are from a rolling window and are replaced by the final transcript when the session stops.',
    inputSchema: {
      sessionId: z.string().describe('Or "latest" for the most recent session.'),
      cursor: z.number().int().min(0).default(0).optional(),
      limit: z.number().int().min(1).max(500).default(200).optional(),
    },
  },
  async ({ sessionId, cursor = 0, limit = 200 }) => {
    const ids = await listSessionIds(ROOT);
    const id = sessionId === 'latest' ? ids[0] : resolveSessionId(sessionId, ids);
    if (!id) return text({ error: 'No sessions recorded yet.' });
    return text(await tailEvents(ROOT, id, cursor, limit));
  },
);

server.registerTool(
  'session_frame',
  {
    title: 'Get the frame nearest a moment',
    description:
      'A JPEG from the recording at the closest captured moment to `at` (milliseconds from session start). For looking at what the page actually showed.',
    inputSchema: { sessionId: z.string(), at: z.number() },
  },
  async ({ sessionId, at }) => {
    const frame = await readFrame(ROOT, await resolve(sessionId), at);
    return {
      content: [
        { type: 'text', text: `${frame.file} (${frame.t}ms)` },
        { type: 'image', data: frame.base64, mimeType: 'image/jpeg' },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
