export const RUN_SELF_TEST = 'bugcast/run-self-test';
export const OFFSCREEN_SELF_TEST = 'bugcast/offscreen-self-test';
export const DROP_MARKER = 'bugcast/drop-marker';
export const OFFSCREEN_FRAMES = 'bugcast/offscreen-frames';
export const OFFSCREEN_START = 'bugcast/offscreen-start';
export const OFFSCREEN_STOP = 'bugcast/offscreen-stop';
export const OFFSCREEN_STARTED = 'bugcast/offscreen-started';
export const OFFSCREEN_ERROR = 'bugcast/offscreen-error';
export const INTERACTION = 'bugcast/interaction';
export const START_RECORDING = 'bugcast/start-recording';
export const STOP_RECORDING = 'bugcast/stop-recording';
export const RECORDING_STATE = 'bugcast/recording-state';

export interface StartMessage {
  type: typeof START_RECORDING;
  /**
   * The tab to record. The popup reads it and passes it along, because the
   * active tab can change between the popup's query and the worker's.
   */
  tabId?: number;
  /** The popup reads this too — see the worker for why it is not re-read there. */
  pageUrl?: string;
  /** The page title at record time — the only human-readable session name. */
  title?: string;
}

export type Response =
  | { ok: true; recording: boolean; captureError?: string | null }
  | {
      ok: true;
      recording: false;
      events: unknown[];
      redaction: unknown;
      sessionId: string;
      /** `folder/session-id`, or null if the write failed. */
      written: string | null;
      report: string;
      capture: unknown;
      frames: { written: number; missed: number };
    }
  | { error: string };
