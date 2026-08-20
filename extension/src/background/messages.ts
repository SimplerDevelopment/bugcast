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
  | { ok: true; recording: boolean }
  | {
      ok: true;
      recording: false;
      events: unknown[];
      redaction: unknown;
      sessionId: string;
      /** `folder/session-id`, or null if the write failed. */
      written: string | null;
      report: string;
    }
  | { error: string };
