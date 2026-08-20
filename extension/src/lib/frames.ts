/**
 * Planning which frames to extract.
 *
 * Extraction is **post-hoc**, from the finished webm — never live. Capturing at
 * event boundaries during the session would cost a `Page.captureScreenshot`
 * round-trip per event, perturbing the timing of the very thing being measured,
 * and would mean guessing which instants matter before anyone knows what the
 * bug was. The webm is the source; this is a derived view of it.
 *
 * Design: docs/design/issues/08-does-the-video-survive.md
 */

import type { TimelineEvent } from './events';

/**
 * Frames are taken *after* the event, not at it.
 *
 * A frame at the moment of a click shows the state before the effect, which is
 * the half nobody needs — the interesting pixels are what the click produced.
 */
export const FRAME_OFFSET_MS = 400;

/** Events closer together than this share a frame; the pixels would be identical. */
export const FRAME_DEDUPE_MS = 250;

/** A pathological session should not write five thousand JPEGs. */
export const MAX_FRAMES = 300;

export interface PlannedFrame {
  /** Session-relative time to sample, in ms. */
  t: number;
  /** Path relative to the session folder. */
  path: string;
  /** Indexes into the event array that should reference this frame. */
  events: number[];
}

/**
 * Whether an event is worth a frame.
 *
 * Interactions qualify because the pixels show what they produced. Navigations,
 * errors and failed requests qualify because they have no interaction to hang
 * off and are exactly the moments someone will want to look at. Successful
 * requests, ordinary logs and speech do not — they would triple the frame count
 * to show a page that did not change.
 */
export function deservesFrame(event: TimelineEvent): boolean {
  switch (event.type) {
    case 'click':
    case 'keydown':
    case 'change':
    case 'submit':
    case 'drag':
    case 'focus':
    case 'navigation':
    case 'exception':
    // A marker is someone saying "look here" — the single most likely frame to
    // be wanted in the whole session.
    case 'marker':
      return true;
    case 'console':
      return event.level === 'error';
    case 'network':
      return event.failure ? !event.failure.canceled : (event.status ?? 0) >= 400;
    default:
      return false;
  }
}

/** `000012340-network-500` — sorts chronologically and says what it is. */
export function frameName(event: TimelineEvent, t: number): string {
  const stamp = String(Math.max(0, Math.round(t))).padStart(9, '0');
  let kind: string = event.type;
  if (event.type === 'network') kind = `network-${event.status ?? 'failed'}`;
  else if (event.type === 'console') kind = `console-${event.level}`;
  return `frames/${stamp}-${kind}.jpg`;
}

export function planFrames(events: TimelineEvent[]): PlannedFrame[] {
  const plan: PlannedFrame[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (!deservesFrame(event)) continue;

    const t = Math.max(0, event.t + FRAME_OFFSET_MS);
    const previous = plan[plan.length - 1];
    if (previous && t - previous.t <= FRAME_DEDUPE_MS) {
      previous.events.push(i);
      continue;
    }
    plan.push({ t, path: frameName(event, t), events: [i] });
  }

  if (plan.length <= MAX_FRAMES) return plan;

  // Past the cap, keep only the moments that cannot be inferred from the
  // timeline text — a wrong-looking page, not a click that clearly happened.
  const essential = plan.filter((frame) =>
    frame.events.some((i) => {
      const e = events[i]!;
      return (
        e.type === 'marker' ||
        e.type === 'navigation' ||
        e.type === 'exception' ||
        e.type === 'network' ||
        (e.type === 'console' && e.level === 'error')
      );
    }),
  );
  return essential.slice(0, MAX_FRAMES);
}
