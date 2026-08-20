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
      suggested_key: { default: 'Ctrl+Shift+R', mac: 'Command+Shift+R' },
      description: 'Start or stop recording',
    },
    'drop-marker': {
      suggested_key: { default: 'Ctrl+Shift+M', mac: 'Command+Shift+M' },
      description: 'Mark this moment ("this is the bug")',
    },
  },
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
  minimum_chrome_version: '116',
});
