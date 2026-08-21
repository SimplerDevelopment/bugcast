import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'Bugcast — Video QA Recorder',
  version: pkg.version,
  description:
    'Record a QA session — video, narrated audio transcribed to SRT, and a correlated timeline of clicks, console logs and failed network calls — as raw files you own.',

  // Deliberately NOT `<all_urls>`, and no declared content_scripts.
  // The interaction listener is injected programmatically at record time
  // (activeTab), then registerContentScripts covers document_start for the
  // rest of the session and unregisters on stop. See docs/design/issues/05.
  permissions: [
    'debugger', // the only mechanism that sees network below JS. issues/02, /06
    'tabCapture', // video + tab audio. issues/08
    'offscreen', // MediaRecorder and Whisper need a DOM context. issues/07
    'scripting', // programmatic injection at record time. issues/05
    'activeTab',
    'storage',
    'downloads', // zip fallback when File System Access is blocked. issues/10
  ],

  // Requested per-origin at record time rather than granted up front. This is
  // a better privacy story than a blanket manifest grant *and* it is required:
  // `activeTab` covers executeScript on the current page but cannot back
  // registerContentScripts, which is what keeps interaction capture alive
  // across navigations during a session.
  optional_host_permissions: ['<all_urls>'],

  // MV3's default CSP forbids WebAssembly outright — the failure is a
  // CompileError saying "neither 'wasm-eval' nor 'unsafe-eval' is an allowed
  // source", which reads like a code problem and is a policy one. This is the
  // documented allowance, and it is narrow: wasm only, no eval, no remote
  // script. Local Whisper does not run without it.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },

  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  action: {
    default_popup: 'src/popup/index.html',
    default_icon: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png' },
  },

  // A keyboard shortcut is a user gesture, which is what makes starting from
  // one possible at all — Chrome grants activeTab for commands exactly as it
  // does for a toolbar click.
  commands: {
    'toggle-recording': {
      // Chrome silently drops a suggested_key that collides with one of its
      // own — no warning, the command simply has no shortcut. Cmd+Shift+R (hard
      // reload) and Cmd+Shift+M (profile switcher) were both lost that way.
      // Guessing is unreliable, so the popup reports what actually bound and
      // links to chrome://extensions/shortcuts.
      suggested_key: { default: 'Ctrl+Shift+U', mac: 'Command+Shift+U' },
      description: 'Start or stop recording',
    },
    'drop-marker': {
      // Cmd+Shift+M is Chrome's profile switcher on macOS.
      suggested_key: { default: 'Ctrl+Shift+E', mac: 'Command+Shift+E' },
      description: 'Mark this moment ("this is the bug")',
    },
  },
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
  minimum_chrome_version: '116',
});
