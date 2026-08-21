/**
 * The timeline event union — the artifact contract, in types.
 *
 * `timeline.json` is one flat, time-ordered array discriminated by `type`.
 * Correlating separate per-source streams is exactly the work this tool exists
 * to eliminate, so producing streams would just export our convenience as the
 * consumer's problem.
 *
 * Worked example: docs/design/prototype/2026-08-20T14-32-09_app-simplerdev-com/
 * Design: docs/design/issues/09-the-artifact-contract.md
 */

import type { SessionMs } from './time';

export const SCHEMA_VERSION = 1;

/**
 * Common to every event.
 *
 * `pageUrl`, not `url` — network events already have a `url` meaning the
 * request target, and a field name that means "page context" on one event type
 * and "request target" on another is a bug factory. Found by hand-authoring a
 * real session rather than by writing a schema.
 *
 * `tEnd` is optional but is *not* network-specific: speech has cue duration,
 * drag has gesture duration, network has request duration. Events are
 * intervals, not instants, and consumers must assume any event may span time.
 */
interface BaseEvent {
  t: SessionMs;
  tEnd?: SessionMs;
  pageUrl: string;
  /** Path to the extracted frame for this moment, if one was kept. */
  frame?: string;
}

/** How an element was identified, emitted in full rather than ranked-and-picked. */
export interface Target {
  /** Best available identifier. */
  selector: string;
  selectorKind: 'testid' | 'id' | 'role' | 'text' | 'css';
  /** Always present, as a fallback for consumers that want a path. */
  css: string;
  role: string | null;
  /** Accessible name. */
  name: string | null;
  tag: string;
  text: string;
  id: string | null;
  rect: { x: number; y: number; w: number; h: number };
  /** The frame the element lives in — content scripts run in all frames. */
  frameUrl: string;
}

export interface NavigationEvent extends BaseEvent {
  type: 'navigation';
  trigger: 'load' | 'pushState' | 'replaceState' | 'popstate';
  from: string | null;
}

export interface SpeechEvent extends BaseEvent {
  type: 'speech';
  text: string;
  /**
   * Emitted from a rolling window during the session, and superseded by the
   * authoritative full-audio pass at stop.
   *
   * Flagged rather than silently replaced so a consumer reading live can tell
   * approximate text from final text — discovering that a line changed under
   * you is worse than being told it might.
   */
  provisional?: true;
}

export interface ClickEvent extends BaseEvent {
  type: 'click';
  target: Target;
}

export interface KeydownEvent extends BaseEvent {
  type: 'keydown';
  key: string;
  modifiers: string[];
  target: Target;
}

export interface ChangeEvent extends BaseEvent {
  type: 'change';
  target: Target;
  /** Shape-preserving by default — the characters are withheld. */
  value: { redacted: true; chars: number; shape: string } | { redacted: false; value: string };
}

export interface SubmitEvent extends BaseEvent {
  type: 'submit';
  target: Target;
}

export interface DragEvent extends BaseEvent {
  type: 'drag';
  /**
   * `pointer` covers dnd-kit, react-beautiful-dnd and every pointer-based
   * editor, none of which dispatch HTML5 drag events at all.
   */
  mechanism: 'native' | 'pointer';
  from: { target: Target };
  to: { target: Target; point: { x: number; y: number } };
}

/**
 * A moment the recorder marked by hand.
 *
 * Identified as a real gap while hand-authoring the example session: the
 * narration said "save is just broken on this page", which works for a human
 * and is invisible to a query. A marker is the same claim, machine-findable.
 */
export interface MarkerEvent extends BaseEvent {
  type: 'marker';
  note: string;
}

export interface FocusEvent extends BaseEvent {
  type: 'focus';
  target: Target;
}

export interface NetworkEvent extends BaseEvent {
  type: 'network';
  requestId: string;
  method: string;
  /** The request target. Distinct from `pageUrl`. */
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  encodedDataLength?: number;
  initiator?: string;
  request?: {
    headers: Record<string, string>;
    postData?: string;
    postDataTruncated?: boolean;
    postDataSize?: number;
  };
  response?: {
    headers: Record<string, string>;
    body?: string;
    truncated?: boolean;
    size?: number;
    /** Set instead of `body` when the payload was binary or a live stream. */
    omitted?: 'binary' | 'stream';
  };
  /** Present only for `Network.loadingFailed` — there is never a body. */
  failure?: {
    errorText: string;
    corsErrorStatus?: string;
    blockedReason?: string;
    /** Navigation and AbortController cancel routinely; not a real failure. */
    canceled: boolean;
  };
}

export interface ConsoleEvent extends BaseEvent {
  type: 'console';
  level: string;
  text: string;
  source: string;
  stack?: string;
}

export interface ExceptionEvent extends BaseEvent {
  type: 'exception';
  text: string;
  stack?: string;
}

/**
 * What the application under test said about itself.
 *
 * Produced by the page calling `performance.mark('bugcast:<name>', {detail})` —
 * standard User Timing, not a Bugcast API, so a project takes no dependency to
 * use it and loses nothing by ignoring it. See `lib/annotate.ts`.
 *
 * Additive: `schemaVersion` deliberately does **not** move. A consumer that
 * does not know this type ignores it, which is the compatibility promise ticket
 * 09 made when it said additive changes do not bump.
 */
export interface AnnotationEvent extends BaseEvent {
  type: 'annotation';
  /** The mark name with the `bugcast:` prefix stripped. */
  name: string;
  /**
   * Whatever the page attached, bounded by three caps and then redacted.
   * Sentinels name which budget was hit — see `lib/annotate.ts`.
   */
  detail?: unknown;
  /** A `measure` carries real duration and sets `tEnd`; a `mark` is an instant. */
  source: 'mark' | 'measure';
}

/**
 * `exception` stays distinct from `console` because CDP distinguishes
 * `Runtime.exceptionThrown` from `Runtime.consoleAPICalled`; flattening them
 * would discard that.
 */
export type TimelineEvent =
  | NavigationEvent
  | SpeechEvent
  | ClickEvent
  | KeydownEvent
  | ChangeEvent
  | SubmitEvent
  | DragEvent
  | FocusEvent
  | MarkerEvent
  | AnnotationEvent
  | NetworkEvent
  | ConsoleEvent
  | ExceptionEvent;

export type EmitEvent = (event: TimelineEvent) => void;
