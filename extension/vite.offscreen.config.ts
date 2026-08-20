import { defineConfig } from 'vite';

/**
 * Third build pass, for the offscreen document's script.
 *
 * Separate from the content-script build because the two need different output
 * formats: a content script is injected as a *classic* script and must be IIFE,
 * while the offscreen document loads its script from HTML and can be a module —
 * which matters, because both import from `src/lib` and rollup cannot emit a
 * shared chunk in IIFE.
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    target: 'esnext',
    rollupOptions: {
      input: { offscreen: 'src/offscreen/main.ts' },
      output: { entryFileNames: 'offscreen.js', format: 'es', inlineDynamicImports: true },
    },
  },
});
