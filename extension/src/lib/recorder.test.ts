import { describe, expect, it } from 'vitest';
import {
  downsampleRatio,
  MIME_CANDIDATES,
  pickMimeType,
  recorderOptions,
  tabStreamConstraints,
  TARGET_SAMPLE_RATE,
} from './recorder';

describe('pickMimeType', () => {
  it('prefers VP8 with Opus', () => {
    expect(pickMimeType(() => true)).toBe('video/webm;codecs=vp8,opus');
  });

  it('degrades through the list rather than failing at the first miss', () => {
    expect(pickMimeType((t) => t === 'video/webm')).toBe('video/webm');
  });

  it('returns null when nothing is supported, so the caller can fail loudly', () => {
    expect(pickMimeType(() => false)).toBeNull();
  });

  it('never offers VP9 — encode CPU competes with the app under test', () => {
    expect(MIME_CANDIDATES.join(' ')).not.toContain('vp9');
  });
});

describe('downsampleRatio', () => {
  it('handles the rates a real AudioContext reports', () => {
    expect(downsampleRatio(48000)).toBe(3);
    expect(downsampleRatio(44100)).toBe(3); // 2.756 rounds to 3
    expect(downsampleRatio(16000)).toBe(1);
  });

  it('never returns 0 or a negative, which would divide by zero in the worklet', () => {
    expect(downsampleRatio(8000)).toBe(1);
    expect(downsampleRatio(0)).toBe(1);
  });

  it('targets what Whisper wants', () => {
    expect(TARGET_SAMPLE_RATE).toBe(16000);
  });
});

describe('tabStreamConstraints', () => {
  it('carries the stream id into both tracks', () => {
    const c = tabStreamConstraints('abc123') as any;
    expect(c.audio.mandatory.chromeMediaSourceId).toBe('abc123');
    expect(c.video.mandatory.chromeMediaSourceId).toBe('abc123');
    expect(c.audio.mandatory.chromeMediaSource).toBe('tab');
  });

  it('caps frame rate but never resolution — legibility is the point', () => {
    const c = tabStreamConstraints('x') as any;
    expect(c.video.mandatory.maxFrameRate).toBe(15);
    expect(c.video.mandatory.maxWidth).toBeUndefined();
    expect(c.video.mandatory.maxHeight).toBeUndefined();
  });
});

describe('recorderOptions', () => {
  it('passes the chosen mime through with both bitrates', () => {
    const o = recorderOptions('video/webm;codecs=vp8,opus');
    expect(o.mimeType).toBe('video/webm;codecs=vp8,opus');
    expect(o.videoBitsPerSecond).toBe(1_500_000);
    expect(o.audioBitsPerSecond).toBe(96_000);
  });
});
