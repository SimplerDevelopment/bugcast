/**
 * Everything configurable, in one place.
 *
 * Defaults are the shipped behaviour, so a fresh profile with no stored values
 * behaves identically to a configured one. Several of these were decided in the
 * design record and then only existed as constants — the typed-value toggle in
 * particular is specified by docs/design/issues/05 and had no way to be turned
 * on.
 */

import { DEFAULT_TIER, type ModelTier } from '../offscreen/transcribe';

export interface Settings {
  /** Whisper model. Bigger is more accurate and a larger one-time download. */
  modelTier: ModelTier;
  /** Empty means the system default input. */
  micDeviceId: string;
  /**
   * Transcribe rolling windows during the session so an agent can follow along.
   * Costs CPU alongside the app under test for the whole session.
   */
  liveTranscription: boolean;
  video: boolean;
  /**
   * Capture what was typed.
   *
   * Off by default and deliberately so: a detector that misses one field writes
   * a real credential to disk and then into a model's context, with no undo
   * once the folder is shared. Sensitive fields stay redacted even when this is
   * on — the toggle relaxes the default, it does not disable detection.
   */
  typedValues: boolean;
  /**
   * OpenAI key for hosted transcription. Empty means the local model.
   *
   * User-supplied and kept in `chrome.storage.local`, never in the bundle —
   * an extension's source is readable by anyone who installs it, so a shipped
   * key is a published key. That is also why this is the operator's own key on
   * the operator's own machine rather than a service credential: the blast
   * radius of a leak is one billing account they control.
   *
   * Setting it sends session audio to OpenAI. Leave it empty to keep every
   * byte local.
   */
  openaiApiKey: string;
}

export const DEFAULTS: Settings = {
  modelTier: DEFAULT_TIER,
  micDeviceId: '',
  liveTranscription: true,
  video: true,
  typedValues: false,
  openaiApiKey: '',
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...(stored as Partial<Settings>) };
}

export const saveSetting = <K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> =>
  chrome.storage.local.set({ [key]: value });
