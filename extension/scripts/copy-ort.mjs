/**
 * Copy the ONNX Runtime wasm binaries into dist/ort/.
 *
 * transformers.js otherwise fetches them from a CDN at first inference, which
 * would put a network call in the middle of a tool whose entire premise is that
 * it runs locally.
 *
 * Only two of the four runtimes are copied. Shipping the whole directory is
 * 94MB — an unreasonable download for an extension — and most of it is variants
 * this never selects:
 *
 *   ort-wasm-simd-threaded.wasm       13MB  the WASM backend
 *   ort-wasm-simd-threaded.jsep.wasm  25MB  the WebGPU backend (JSEP)
 *   ...asyncify.wasm                  22MB  not used — asyncify is for the
 *                                           older non-JSEP async path
 *   ...jspi.wasm                      14MB  not used — needs the JSPI flag
 *
 * Copied at build time rather than committed: they are a dependency's build
 * output, and 38MB of binaries do not belong in git.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(here, '..', 'node_modules', 'onnxruntime-web', 'dist');
const to = path.resolve(here, '..', 'dist', 'ort');

if (!fs.existsSync(from)) {
  console.error(`onnxruntime-web not installed at ${from}`);
  process.exit(1);
}

fs.mkdirSync(to, { recursive: true });
let copied = 0;
const WANTED = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];

for (const file of WANTED) {
  const source = path.join(from, file);
  if (!fs.existsSync(source)) {
    console.error(`ort: expected ${file} in onnxruntime-web/dist — did the package layout change?`);
    process.exit(1);
  }
  fs.copyFileSync(source, path.join(to, file));
  copied++;
}
console.log(`ort: copied ${copied} runtime files to dist/ort/`);
