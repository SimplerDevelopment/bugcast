/**
 * Copy the ONNX Runtime wasm binaries into dist/ort/.
 *
 * transformers.js otherwise fetches them from a CDN at first inference, which
 * would put a network call in the middle of a tool whose entire premise is that
 * it runs locally.
 *
 * Only the WASM backend is copied — 13MB, where shipping every runtime is
 * ~94MB of extension download.
 *
 * That is a deliberate trade rather than a saving. Enabling WebGPU drags in the
 * jsep AND asyncify runtimes (the WebGPU path loads asyncify at init; excluding
 * it is what produced "no available backend found" on a real machine), which is
 * ~60MB more for a win nobody has demonstrated: the one primary benchmark in
 * docs/design/issues/03 had WASM *beating* WebGPU for Whisper, contradicting
 * vendor claims.
 *
 * Revisit if a real measurement on real hardware says otherwise — #11's
 * self-test reports the backend and first-inference time, which is where that
 * evidence would come from.
 *
 * Copied at build time rather than committed: it is a dependency's build
 * output, and binaries do not belong in git.
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
  // Required even on the plain WASM backend, which is not obvious: the runtime
  // loads it at init regardless of device. Excluding it produces
  // "no available backend found ... Failed to fetch dynamically imported
  // module", which reads like a network problem and is a missing file.
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
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
