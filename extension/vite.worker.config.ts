import { defineConfig } from 'vite';

/**
 * The Whisper worker, built separately.
 *
 * Its own pass because it is a module worker with its own entry, and bundling it
 * with the offscreen document would defeat the point — the whole reason it
 * exists is to run on a different thread.
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    target: 'esnext',
    rollupOptions: {
      input: { 'whisper-worker': 'src/offscreen/whisper-worker.ts' },
      output: { entryFileNames: 'whisper-worker.js', format: 'es', inlineDynamicImports: true },
    },
  },
});
