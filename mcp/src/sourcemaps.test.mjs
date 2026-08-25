import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { indexMaps, parseStack, resolveFrame, resolveStack } from './sourcemaps.mjs';

test('parseStack handles both shapes Chrome emits', () => {
  const frames = parseStack(`Error: boom
    at save (https://app.test/assets/main-a1b2.js:1:2345)
    at https://app.test/assets/main-a1b2.js:1:99
    at async flush (https://app.test/assets/main-a1b2.js:2:10)
    not a frame at all`);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0], {
    fn: 'save', url: 'https://app.test/assets/main-a1b2.js', line: 1, column: 2345,
  });
  assert.equal(frames[1].fn, null);
  assert.equal(frames[2].fn, 'flush');
});

test('parseStack returns nothing for a stack with no locations', () => {
  assert.deepEqual(parseStack('Error: boom\n    at <anonymous>'), []);
  assert.deepEqual(parseStack(undefined), []);
});

/** A real map: one generated line, two authored positions. */
// Decoded by node's own consumer rather than trusted from how it was written:
//   generated col 0  -> src/save.ts   line 0 col 10
//   generated col 19 -> src/flush.ts  line 4 col 10
// The second one is what makes the 0-vs-1 indexing assertion below meaningful;
// the first maps to line 0, where an off-by-one is invisible.
const MAP = {
  version: 3,
  file: 'main-a1b2.js',
  sources: ['src/save.ts', 'src/flush.ts'],
  names: ['save'],
  mappings: 'AAAUE,mBCIA',
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bugcast-maps-'));
  await mkdir(path.join(root, 'dist', 'assets'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'junk'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'assets', 'main-a1b2.js.map'), JSON.stringify(MAP));
  // Must never be indexed: walking node_modules is how this gets slow and wrong.
  await writeFile(path.join(root, 'node_modules', 'junk', 'main-a1b2.js.map'), '{}');
  return root;
}

test('indexMaps finds build output and skips node_modules', async () => {
  const root = await fixture();
  const maps = await indexMaps(root);
  const hits = maps.get('main-a1b2.js.map') ?? [];
  assert.equal(hits.length, 1, 'node_modules must not contribute a candidate');
  assert.ok(hits[0].includes(path.join('dist', 'assets')));
  await rm(root, { recursive: true, force: true });
});

test('resolveStack turns a minified frame into an authored file and line', async () => {
  const root = await fixture();
  const scripts = [{
    scriptId: '1',
    url: 'https://app.test/assets/main-a1b2.js',
    sourceMapURL: 'main-a1b2.js.map',
  }];
  const out = await resolveStack(
    `    at save (https://app.test/assets/main-a1b2.js:1:1)
    at flush (https://app.test/assets/main-a1b2.js:1:20)`,
    scripts,
    root,
  );
  assert.equal(out.frames.length, 2);
  assert.equal(out.resolved, 2);

  assert.equal(out.frames[0].resolved, true, out.frames[0].why);
  assert.equal(out.frames[0].source, 'src/save.ts');

  // The frame that makes the indexing assertion real. A stack is 1-indexed and
  // findEntry is 0-indexed, so an off-by-one shifts every answer by a line and
  // looks entirely plausible — the worst kind of wrong for something an agent
  // will act on. Generated col 19 maps to flush.ts line 4, so 5 on the way out.
  assert.equal(out.frames[1].source, 'src/flush.ts');
  assert.equal(out.frames[1].sourceLine, 5);
  assert.equal(out.frames[1].sourceColumn, 11);
  await rm(root, { recursive: true, force: true });
});

test('every failure says why instead of guessing', async () => {
  const root = await fixture();
  const maps = await indexMaps(root);
  const byUrl = (s) => new Map(s.map((x) => [x.url, x]));
  const frame = { fn: 'x', url: 'https://app.test/a.js', line: 1, column: 1 };

  const unknown = await resolveFrame(frame, byUrl([]), maps);
  assert.equal(unknown.resolved, false);
  assert.match(unknown.why, /no script in the index/);

  const inline = await resolveFrame(
    frame, byUrl([{ url: frame.url, inlineMap: true }]), maps,
  );
  assert.match(inline.why, /inline/);

  const none = await resolveFrame(frame, byUrl([{ url: frame.url }]), maps);
  assert.match(none.why, /no source map/);

  const missing = await resolveFrame(
    frame, byUrl([{ url: frame.url, sourceMapURL: 'nope.js.map' }]), maps,
  );
  assert.match(missing.why, /no nope\.js\.map found/);
  await rm(root, { recursive: true, force: true });
});

test('two builds in the tree are reported, not silently picked between', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'build'), { recursive: true });
  await writeFile(path.join(root, 'build', 'main-a1b2.js.map'), JSON.stringify(MAP));
  const out = await resolveStack(
    '    at save (https://app.test/assets/main-a1b2.js:1:1)',
    [{ url: 'https://app.test/assets/main-a1b2.js', sourceMapURL: 'main-a1b2.js.map' }],
    root,
  );
  assert.ok(out.frames[0].ambiguous?.length >= 2, 'a stale second build must be surfaced');
  await rm(root, { recursive: true, force: true });
});
