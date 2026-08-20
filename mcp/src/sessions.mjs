/**
 * Reading bugcast session folders.
 *
 * Everything here is read-only and everything here is paranoid about paths.
 * A session id arrives from a tool call, which means it arrives from a model,
 * which means it is attacker-influenced the moment anyone shares a session
 * folder. `..` is the obvious way out of the sandbox.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** The schema this server understands. Bumped only by a breaking change. */
export const SUPPORTED_SCHEMA = 1;

/**
 * Resolve a session id against what is actually on disk.
 *
 * Deliberately a lookup, never a join. `path.join(root, id)` with an id of
 * `../../.ssh` escapes the folder, and no amount of string sanitising is as
 * trustworthy as refusing to construct the path at all.
 */
export function resolveSessionId(id, listing) {
  if (typeof id !== 'string' || !id) throw new Error('A session id is required');
  const match = listing.find((entry) => entry === id);
  if (!match) {
    throw new Error(`No session "${id}". Use sessions_list to see what exists.`);
  }
  return match;
}

export async function listSessionIds(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first — ids lead with a sortable timestamp
}

/**
 * Refuse loudly on a version this server does not know.
 *
 * Best-effort parsing of an unfamiliar format would return subtly wrong answers
 * to an agent that will act on them, which is worse than returning nothing.
 */
export function checkSchema(schemaVersion, file) {
  if (schemaVersion === SUPPORTED_SCHEMA) return;
  if (typeof schemaVersion !== 'number') {
    throw new Error(`${file} has no schemaVersion — is this a bugcast session?`);
  }
  throw new Error(
    schemaVersion > SUPPORTED_SCHEMA
      ? `${file} is schema v${schemaVersion}; this server understands v${SUPPORTED_SCHEMA}. Upgrade: npx -y bugcast@latest`
      : `${file} is schema v${schemaVersion}, which this server no longer reads.`,
  );
}

async function readJson(root, id, file) {
  const text = await readFile(path.join(root, id, file), 'utf8');
  const parsed = JSON.parse(text);
  checkSchema(parsed.schemaVersion, file);
  return parsed;
}

export const readManifest = (root, id) => readJson(root, id, 'session.json');
export const readTimeline = (root, id) => readJson(root, id, 'timeline.json');

export async function readReport(root, id) {
  return readFile(path.join(root, id, 'report.md'), 'utf8');
}

export async function summarise(root, id) {
  const manifest = await readManifest(root, id).catch(() => null);
  if (!manifest) return { id, unreadable: true };
  const { session = {}, capture = {} } = manifest;
  return {
    id,
    title: session.title ?? id,
    recorded: session.t0,
    durationMs: session.durationMs,
    startUrl: session.startUrl,
    hasVideo: Boolean(capture.video?.enabled),
    hasTranscript: Boolean(capture.transcript?.enabled),
  };
}

/** A failure the way a developer means it — an abort is not one. */
export const isFailure = (event) =>
  event.type === 'network' &&
  (event.failure ? !event.failure.canceled : (event.status ?? 0) >= 400);

/**
 * The reason this server exists.
 *
 * A fifteen-minute session's raw timeline runs to roughly 50k tokens, and
 * pasting all of it to ask "what failed" is exactly the waste the tool is meant
 * to remove.
 */
export function filterEvents(events, { type, failedOnly, from, to, match, limit = 100 } = {}) {
  const types = type ? (Array.isArray(type) ? type : [type]) : null;
  const needle = match?.toLowerCase();

  const filtered = events.filter((event) => {
    if (types && !types.includes(event.type)) return false;
    if (failedOnly && !isFailure(event)) return false;
    if (from !== undefined && event.t < from) return false;
    if (to !== undefined && event.t > to) return false;
    if (needle && !JSON.stringify(event).toLowerCase().includes(needle)) return false;
    return true;
  });

  return { total: filtered.length, events: filtered.slice(0, limit), truncated: filtered.length > limit };
}

export async function readFrame(root, id, at) {
  const dir = path.join(root, id, 'frames');
  const files = await readdir(dir).catch(() => []);
  if (!files.length) throw new Error(`Session "${id}" has no frames.`);

  // Frame names lead with a zero-padded millisecond offset, so the nearest one
  // is a numeric comparison rather than a guess.
  const withTimes = files
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => ({ file: f, t: Number.parseInt(f.slice(0, 9), 10) }))
    .filter((f) => Number.isFinite(f.t));
  if (!withTimes.length) throw new Error(`Session "${id}" has no readable frames.`);

  const nearest = withTimes.reduce((best, f) =>
    Math.abs(f.t - at) < Math.abs(best.t - at) ? f : best,
  );
  const bytes = await readFile(path.join(dir, nearest.file));
  return { file: nearest.file, t: nearest.t, base64: bytes.toString('base64') };
}

export async function assertReadable(root) {
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`--dir ${root} is not a directory. Point it at the folder you chose in the extension.`);
  }
}
