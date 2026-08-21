import { describe, expect, it } from 'vitest';
import { DEFAULTS } from './settings';

describe('defaults', () => {
  it('does not capture typed values', () => {
    // The asymmetry that decided this: a missed detection writes a real
    // credential to disk and then into a model's context, with no undo once the
    // folder is shared. The safe default merely costs a re-record.
    expect(DEFAULTS.typedValues).toBe(false);
  });

  it('records video and transcribes live', () => {
    expect(DEFAULTS.video).toBe(true);
    expect(DEFAULTS.liveTranscription).toBe(true);
  });

  it('uses the system microphone unless one is chosen', () => {
    expect(DEFAULTS.micDeviceId).toBe('');
  });

  it('defaults to the middle model tier', () => {
    expect(DEFAULTS.modelTier).toBe('base.en');
  });
});
