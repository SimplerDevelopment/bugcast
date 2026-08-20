export const START_RECORDING = 'bugcast/start-recording';
export const STOP_RECORDING = 'bugcast/stop-recording';
export const RECORDING_STATE = 'bugcast/recording-state';

export type Response = { ok: true; recording: boolean } | { error: string };
