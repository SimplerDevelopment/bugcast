/**
 * Turning `bundle.js:1:38402` into a file you can open.
 *
 * The extension writes `scripts.json` at record time: every script the page
 * loaded, with the `sourceMapURL` from its magic comment. It deliberately does
 * NOT fetch the maps — that would be a network call inside a tool whose premise
 * is that recording makes none. Resolution happens here instead, where the maps
 * already exist on disk: the developer's own checkout.
 *
 * **How a deployed bundle is matched to a local map.** `process.cwd()` is the
 * project Claude Code launched this server in, which is the checkout that
 * produced the bundle. A `sourceMappingURL` of `main-a1b2.js.map` is looked up
 * by basename under that root. Content-hashed filenames make this far less
 * ambiguous than it sounds — `main-a1b2.js.map` names exactly one build — and
 * where the map carries `sourcesContent` the script hash can confirm it.
 *
 * Chosen over the alternatives on the zero-config rule: an explicit `--maps`
 * directory is per-project setup, and `debugId` matching is correct by
 * construction but only works for the minority of builds whose bundler emits
 * one. This works for a developer who configured nothing, which is the whole
 * bar.
 *
 * **It says when it does not know.** A guessed frame is worse than an
 * unresolved one: an agent will act on it, edit the wrong file, and be
 * confident. Every failure returns a reason.
 *
 * No new dependency — `node:module` has shipped a SourceMap consumer since
 * Node 18, and this package is plain ESM with no build step by rule.
 */

import { readFile, readdir } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import path from 'node:path';

/** Directories that never contain the build output and cost a fortune to walk. */
const SKIP = new Set(['node_modules', '.git', '.next/cache', 'coverage', '.cache', 'tmp']);

/** Deep enough for dist/assets/chunks, shallow enough not to walk a monorepo forever. */
const MAX_DEPTH = 6;

/** Stop rather than walk a pathological tree. */
const MAX_DIRS = 2_000;

/**
 * Every `.map` file under a root, by basename.
 *
 * One walk per resolve call, cached by the caller. Basename rather than path
 * because the deployed URL says nothing about local layout — the bundle served
 * at `/assets/main-a1b2.js` may live at `dist/assets/main-a1b2.js`,
 * `build/static/js/main-a1b2.js`, or anywhere else a bundler felt like.
 */
export async function indexMaps(root, { skip = SKIP, maxDepth = MAX_DEPTH } = {}) {
  const found = new Map();
  let dirs = 0;

  async function walk(dir, depth) {
    if (depth > maxDepth || dirs++ > MAX_DIRS) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.name.endsWith('.map')) {
        // First wins. A repeated basename across dist/ and build/ is the
        // ambiguous case, and both are recorded so the caller can say so.
        const list = found.get(entry.name);
        if (list) list.push(full);
        else found.set(entry.name, [full]);
      }
    }
  }

  await walk(root, 0);
  return found;
}

/**
 * Pull `url:line:column` out of a V8 stack.
 *
 * Handles both shapes Chrome emits — `at fn (url:1:2)` and the bare
 * `at url:1:2` — and keeps the function name, which is often the only readable
 * thing in a minified frame.
 */
export function parseStack(stack) {
  if (typeof stack !== 'string') return [];
  const frames = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    const parenthesised = line.match(/^at\s+(?:async\s+)?(.*?)\s+\((.+):(\d+):(\d+)\)$/);
    const bare = parenthesised ? null : line.match(/^at\s+(?:async\s+)?(.+):(\d+):(\d+)$/);
    if (parenthesised) {
      frames.push({
        fn: parenthesised[1],
        url: parenthesised[2],
        line: Number(parenthesised[3]),
        column: Number(parenthesised[4]),
      });
    } else if (bare) {
      frames.push({ fn: null, url: bare[1], line: Number(bare[2]), column: Number(bare[3]) });
    }
  }
  return frames;
}

const parsedMaps = new Map();

async function loadMap(file) {
  if (parsedMaps.has(file)) return parsedMaps.get(file);
  const value = await readFile(file, 'utf8')
    .then((text) => new SourceMap(JSON.parse(text)))
    .catch(() => null);
  parsedMaps.set(file, value);
  return value;
}

/**
 * Resolve one frame, or explain why not.
 *
 * `findEntry` takes zero-indexed offsets; a stack is one-indexed. Getting that
 * wrong shifts every answer by a line, which is exactly the kind of quietly
 * wrong that an agent cannot detect.
 */
export async function resolveFrame(frame, scriptsByUrl, maps) {
  const script = scriptsByUrl.get(frame.url);
  if (!script) return { ...frame, resolved: false, why: 'no script in the index for this url' };
  if (script.inlineMap) {
    return { ...frame, resolved: false, why: 'the map is inline in the bundle and was not captured' };
  }
  if (!script.sourceMapURL) return { ...frame, resolved: false, why: 'the script shipped no source map' };

  const base = path.basename(script.sourceMapURL.split('?')[0]);
  const candidates = maps.get(base) ?? [];
  if (!candidates.length) {
    return { ...frame, resolved: false, why: `no ${base} found under ${process.cwd()}` };
  }

  const map = await loadMap(candidates[0]);
  if (!map) return { ...frame, resolved: false, why: `${candidates[0]} is not a readable source map` };

  const entry = map.findEntry(Math.max(0, frame.line - 1), Math.max(0, frame.column - 1));
  if (!entry || entry.originalSource === undefined) {
    return { ...frame, resolved: false, why: 'the map has no entry for that position' };
  }

  return {
    ...frame,
    resolved: true,
    // 1-indexed on the way out, because that is what an editor and a human use.
    source: entry.originalSource,
    sourceLine: entry.originalLine + 1,
    sourceColumn: entry.originalColumn + 1,
    ...(entry.name ? { name: entry.name } : {}),
    map: candidates[0],
    // Surfaced rather than silently picking the first: two builds in the tree is
    // exactly how you resolve against a stale one and never find out.
    ...(candidates.length > 1 ? { ambiguous: candidates } : {}),
  };
}

/** Resolve a whole stack against one session's script index. */
export async function resolveStack(stack, scripts, root = process.cwd()) {
  const frames = parseStack(stack);
  if (!frames.length) return { frames: [], note: 'no url:line:column frames found in that stack' };

  const scriptsByUrl = new Map(scripts.map((s) => [s.url, s]));
  const maps = await indexMaps(root);
  const out = [];
  for (const frame of frames) out.push(await resolveFrame(frame, scriptsByUrl, maps));
  return {
    frames: out,
    resolved: out.filter((f) => f.resolved).length,
    searched: root,
  };
}
