import { RECORDING_STATE, START_RECORDING, STOP_RECORDING, type Response } from './messages';

let recording = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg?.type).then(sendResponse);
  return true; // async response
});

async function handle(type: string | undefined): Promise<Response> {
  switch (type) {
    case RECORDING_STATE:
      return { ok: true, recording };

    case START_RECORDING:
      // ponytail: not wired yet. The capture pipeline lands next —
      // chrome.debugger attach, tabCapture through an AudioContext tee, and an
      // offscreen document owning MediaRecorder. See docs/design/map.md.
      return { error: 'Capture is not implemented yet.' };

    case STOP_RECORDING:
      recording = false;
      return { ok: true, recording };

    default:
      return { error: `Unknown message: ${type}` };
  }
}
