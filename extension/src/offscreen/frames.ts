/**
 * Extracting the frame index from a finished recording.
 *
 * One linear pass at high playback rate, reading `requestVideoFrameCallback`'s
 * `mediaTime` as each frame goes by — **never seeking**. Seeking would be the
 * obvious implementation and it depends on the webm's timeline tracking
 * wall-clock, which is exactly the `tabCapture`-cadence question still marked
 * unverified. A linear pass does not care.
 *
 * Design: docs/design/issues/08-does-the-video-survive.md
 */

import type { PlannedFrame } from '../lib/frames';

/** Frames downscale even though the video does not — they have different jobs. */
export const FRAME_LONG_EDGE = 1280;
export const FRAME_QUALITY = 0.8;

/** Fast enough to be quick, slow enough that frames still get decoded. */
const PLAYBACK_RATE = 8;

export interface ExtractResult {
  written: number;
  /** Frames whose moment never arrived — the video ended first. */
  missed: number;
}

export async function extractFrames(
  video: Blob,
  plan: PlannedFrame[],
  write: (path: string, image: Blob) => Promise<void>,
): Promise<ExtractResult> {
  if (!plan.length || !video.size) return { written: 0, missed: plan.length };

  const url = URL.createObjectURL(video);
  const element = document.createElement('video');
  element.muted = true;
  element.playsInline = true;
  element.src = url;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2d canvas context for frame extraction');

  // rVFC is what makes this exact; without it there is no per-frame timestamp
  // and the whole approach collapses back to seeking.
  const rvfc = (element as any).requestVideoFrameCallback?.bind(element);
  if (!rvfc) throw new Error('requestVideoFrameCallback unavailable');

  let written = 0;
  let next = 0;
  const pending: Array<Promise<void>> = [];

  try {
    await new Promise<void>((resolve, reject) => {
      element.onerror = () => reject(new Error('Could not decode the recording'));
      element.onloadedmetadata = () => resolve();
    });

    // Sized once from the real frame, so the aspect ratio is the video's.
    const scale = Math.min(1, FRAME_LONG_EDGE / Math.max(element.videoWidth, element.videoHeight));
    canvas.width = Math.max(1, Math.round(element.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(element.videoHeight * scale));

    element.playbackRate = PLAYBACK_RATE;
    await element.play();

    await new Promise<void>((resolve) => {
      element.onended = () => resolve();

      const onFrame = (_now: number, metadata: { mediaTime: number }) => {
        const t = metadata.mediaTime * 1000;

        // Frames arrive in order, so anything still wanted at or before now is
        // as close as it will ever get. Catching up rather than skipping is
        // what keeps a sparse recording — a static page paints rarely — from
        // silently dropping most of the index.
        while (next < plan.length && plan[next]!.t <= t) {
          const wanted = plan[next]!;
          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          pending.push(
            new Promise<void>((done) => {
              canvas.toBlob(
                (image) => {
                  if (image) {
                    written++;
                    void write(wanted.path, image).then(done, done);
                  } else done();
                },
                'image/jpeg',
                FRAME_QUALITY,
              );
            }),
          );
          next++;
        }

        if (next >= plan.length) resolve();
        else rvfc(onFrame);
      };

      rvfc(onFrame);
    });

    await Promise.all(pending);
  } finally {
    element.pause();
    element.src = '';
    URL.revokeObjectURL(url);
  }

  return { written, missed: plan.length - written };
}
