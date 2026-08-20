/**
 * Reading bugcast session folders.
 *
 * Everything here is read-only and everything here is paranoid about paths.
 * A session id arrives from a tool call, which means it arrives from a model,
 * which means it is attacker-influenced the moment anyone shares a session
 * folder. `..` is the obvious way out of the sandbox.
 */

import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
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
  // A live session has no manifest yet — that is not an error, it is the most
  // interesting session there is.
  if (!manifest) return { id, live: await isLive(root, id), recording: true };
  const { session = {}, capture = {} } = manifest;
  return {
    id,
    title: session.title ?? id,
    recorded: session.t0,
    durationMs: session.durationMs,
    startUrl: session.startUrl,
    hasVideo: Boolean(capture.video?.enabled),
    hasTranscript: Boolean(capture.transcript?.enabled),
    live: false,
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

/**
 * A session still being recorded has an event stream but no timeline yet —
 * timeline.json is only written at stop.
 */
export async function isLive(root, id) {
  const has = async (f) => stat(path.join(root, id, f)).then(() => true, () => false);
  return (await has('events.ndjson')) && !(await has('timeline.json'));
}

/**
 * Read the append-only stream from a cursor.
 *
 * The cursor is a line count, not a byte offset: the file only ever grows by
 * whole lines, so a line count is stable, human-readable, and cannot land
 * mid-record the way a byte offset can if a write is still in flight.
 *
 * A trailing partial line is dropped rather than parsed — writes are batched, so
 * a read can land between the write and its newline.
 */
export async function tailEvents(root, id, cursor = 0, limit = 200) {
  const text = await readFile(path.join(root, id, 'events.ndjson'), 'utf8').catch(() => '');
  if (!text) return { events: [], cursor, live: await isLive(root, id), total: 0 };

  const lines = text.split('\n');
  if (lines[lines.length - 1] !== '') lines.pop(); // partial trailing line
  else lines.pop(); // the empty string after the final newline

  const slice = lines.slice(cursor, cursor + limit);
  const events = [];
  for (const line of slice) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // A line that will not parse is a line still being written. Stop here and
      // let the next poll pick it up whole.
      break;
    }
  }
  return {
    events,
    cursor: cursor + events.length,
    total: lines.length,
    more: cursor + events.length < lines.length,
    live: await isLive(root, id),
  };
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

/**
 * Make sure the sessions directory exists.
 *
 * Created rather than demanded when absent. This server is meant to be
 * registered once at user scope and work in every project, so failing to start
 * because nobody has recorded yet would make it look broken on the one path
 * that matters most: the first one. An empty directory is a correct answer to
 * "what sessions exist".
 */
export async function assertReadable(root) {
  const info = await stat(root).catch(() => null);
  if (info?.isDirectory()) return;
  if (info) {
    throw new Error(`${root} exists but is not a directory. Pass --dir to point somewhere else.`);
  }
  await mkdir(root, { recursive: true });
}
