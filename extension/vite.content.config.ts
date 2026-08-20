import { defineConfig } from 'vite';

/**
 * A second, deliberately plain build for the interaction content script.
 *
 * It cannot ride the main CRXJS build, because CRXJS only emits what the
 * manifest declares — and this script is *not* declared. It is injected
 * programmatically at record time so that nothing runs on any page until you
 * press record (docs/design/issues/05).
 *
 * IIFE, not ESM: a script injected via `chrome.scripting` runs as a classic
 * script, so a module wrapper would simply fail to execute.
 *
 * Runs after the main build with emptyOutDir off, so it adds to dist/ rather
 * than replacing it.
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    target: 'esnext',
    rollupOptions: {
      input: { content: 'src/content/interactions.ts' },
      output: { entryFileNames: 'content.js', format: 'iife', inlineDynamicImports: true },
    },
  },
});
