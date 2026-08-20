/**
 * Capture settings, isolated from the DOM so they can be reasoned about and
 * tested without a browser.
 *
 * Design: docs/design/issues/08-does-the-video-survive.md, /07, /04
 */

/**
 * Preference order. VP8 first and deliberately, not because it compresses
 * better — it does not — but because software VP9 encode at 1080p can saturate
 * a core, and the encode runs *alongside the app under test*. A saturated core
 * changes the timing of the thing being measured, which makes codec choice a
 * correctness question rather than a size one.
 */
export const MIME_CANDIDATES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

/** Native resolution — legibility is the point; a downscale mushes small text. */
export const FRAME_RATE = 15;
export const VIDEO_BITS_PER_SECOND = 1_500_000;
export const AUDIO_BITS_PER_SECOND = 96_000;

/** How often MediaRecorder hands us a chunk to stream to disk. */
export const CHUNK_MS = 1_000;

/** What Whisper wants. */
export const TARGET_SAMPLE_RATE = 16_000;

export function pickMimeType(isSupported: (type: string) => boolean): string | null {
  return MIME_CANDIDATES.find(isSupported) ?? null;
}

/**
 * Tab capture in MV3 goes through a stream id minted in the service worker,
 * then redeemed here with the legacy `chromeMediaSource` constraints —
 * `chrome.tabCapture.capture()` itself cannot run in a worker.
 */
export function tabStreamConstraints(streamId: string): MediaStreamConstraints {
  return {
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxFrameRate: FRAME_RATE,
      },
    },
  } as unknown as MediaStreamConstraints;
}

/** Integer decimation factor from a context's rate down to Whisper's. */
export function downsampleRatio(sourceRate: number, targetRate = TARGET_SAMPLE_RATE): number {
  return Math.max(1, Math.round(sourceRate / targetRate));
}

export function recorderOptions(mimeType: string): MediaRecorderOptions {
  return {
    mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  };
}
