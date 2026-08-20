/**
 * Generate the action icons.
 *
 * Hand-rolled PNG encoding rather than a dependency: the icon is a filled
 * circle, zlib is in the standard library, and a PNG is four chunks. Adding an
 * image library to draw a dot would be the larger change.
 *
 * A red record dot, because that is what the button means and it reads at 16px
 * where anything with detail does not.
 */
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const SIZES = [16, 32, 48, 128];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function png(size) {
  const centre = (size - 1) / 2;
  const radius = size * 0.42;
  // One filter byte per scanline, then RGBA.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - centre, y - centre);
      // Feathered edge, so it does not look jagged at 16px.
      const alpha = Math.max(0, Math.min(1, radius - d + 0.5));
      raw[p++] = 0xdc;
      raw[p++] = 0x26;
      raw[p++] = 0x26;
      raw[p++] = Math.round(alpha * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of SIZES) fs.writeFileSync(path.join(OUT, `${size}.png`), png(size));
console.log(`icons: wrote ${SIZES.join(', ')} to public/icons/`);
