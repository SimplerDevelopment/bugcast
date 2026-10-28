/**
 * Build the fake-microphone fixture for `bun run av-sync --speech`.
 *
 * Chrome can replace the microphone with a WAV file
 * (--use-file-for-fake-audio-capture), which is the only way to test narration
 * without a person talking into a machine. This writes that file plus a JSON
 * script of what is said and when, which is what the assertions compare against.
 *
 * NOT checked in. It is ~1MB of generated audio whose only property that
 * matters — the words and their offsets — is three lines of JSON. Generating it
 * also keeps the fixture honest: a checked-in blob drifts from the script
 * beside it and nobody notices until an assertion is quietly meaningless.
 *
 * macOS only for now, because `say` is what is here. On Linux the same shape
 * works with `espeak-ng -w`; wire that up when CI needs it, not before.
 *
 *   node scripts/make-narration.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const RATE = 16000;

if (process.platform !== 'darwin') {
  console.error('This generator needs macOS `say`. On Linux use espeak-ng and match the format:');
  console.error(`  16kHz mono 16-bit PCM WAV, with fixtures/narration.json listing {keyword, atMs}.`);
  process.exit(1);
}

/**
 * Deliberately unusual phrasings. A keyword the recogniser is likely to emit by
 * chance — "the", "okay" — would make the assertion pass on a transcript that
 * had understood nothing, which is exactly the false confirmation this repo has
 * already been bitten by once.
 */
const SCRIPT = [
  { atMs: 2000, say: 'The purple hexagon is misaligned', keyword: 'purple hexagon' },
  { atMs: 10000, say: 'Now the sidebar collapses too early', keyword: 'sidebar collapses' },
  { atMs: 18000, say: 'Mark this one as a duplicate', keyword: 'duplicate' },
  { atMs: 26000, say: 'The tooltip renders behind the modal', keyword: 'tooltip renders' },
  { atMs: 34000, say: 'That is the bug I wanted to capture', keyword: 'bug I wanted' },
];
const TOTAL_MS = 42000;

fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narration-'));

// One clip per line, then laid into a silent bed at its offset. Concatenating
// instead would make every offset depend on how long the synthesiser felt like
// taking, which is precisely the thing being asserted.
const bed = Buffer.alloc(Math.ceil((TOTAL_MS / 1000) * RATE) * 2);
for (const [i, line] of SCRIPT.entries()) {
  const wav = path.join(tmp, `${i}.wav`);
  execFileSync('say', ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@16000', line.say]);
  const raw = fs.readFileSync(wav);
  // Walk the RIFF chunks rather than assuming a 44-byte header — `say` emits a
  // FLLR padding chunk, so the samples do not start where you would expect.
  let off = 12, dataStart = -1, dataLen = 0;
  while (off + 8 <= raw.length) {
    const id = raw.toString('ascii', off, off + 4);
    const size = raw.readUInt32LE(off + 4);
    if (id === 'data') { dataStart = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error(`no data chunk in ${wav}`);
  const at = Math.floor((line.atMs / 1000) * RATE) * 2;
  raw.copy(bed, at, dataStart, Math.min(dataStart + dataLen, raw.length));
  console.log(`  ${String(line.atMs).padStart(6)}ms  "${line.say}"  (${(dataLen / 2 / RATE).toFixed(1)}s)`);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + bed.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(bed.length, 40);

fs.writeFileSync(path.join(OUT, 'narration.wav'), Buffer.concat([header, bed]));
fs.writeFileSync(
  path.join(OUT, 'narration.json'),
  JSON.stringify({ rate: RATE, totalMs: TOTAL_MS, utterances: SCRIPT }, null, 2) + '\n',
);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nwrote ${path.join(OUT, 'narration.wav')} (${(bed.length / 1024 / 1024).toFixed(1)}MB) and narration.json`);
