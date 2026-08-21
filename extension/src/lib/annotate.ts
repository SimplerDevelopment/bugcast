/**
 * What the application under test contributes.
 *
 * Bugcast records what the *browser* can see. A developer running it against
 * their own project knows things the browser does not — which build this is,
 * which route, which feature flags, what the store held when it went wrong.
 *
 * The extension point is **W3C User Timing**, and the reason is that it is not
 * a Bugcast API at all: `performance.mark(name, {detail})` is standard platform
 * (Baseline since May 2022), so the page never takes a dependency, never
 * imports anything, and works identically when Bugcast is not installed. A
 * developer who adds nothing loses nothing.
 *
 *     performance.mark('bugcast:session', { detail: { buildSha, release } });
 *     performance.mark('bugcast:checkout-step', { detail: { step: 3 } });
 *     performance.measure('bugcast:save', { start, end, detail: { id } });
 *
 * Two shapes, deliberately — they are different things and collapsing them
 * produces a worse artifact. `bugcast:session` is **session-scoped**: one value
 * per session, last write wins, folded into `session.json`. Everything else is
 * **timeline-scoped**: append-only, carries `t` like every other event.
 *
 * Verified rather than assumed (`scripts/usertiming-probe.mjs`): an isolated
 * world reads marks the main world created, `detail` survives the world hop
 * with nested objects intact, and `buffered: true` replays marks made *before*
 * the observer registered — which is the one that matters, because the build
 * SHA was marked at page load and the content script arrives when you press
 * Record.
 *
 * Additive, so `schemaVersion` does not move: a consumer that does not know
 * `annotation` ignores it, which is exactly what ticket 09 designed for.
 *
 * Design: docs/design/issues/17-what-a-project-contributes.md
 */

/** Anything not carrying this is the page's own instrumentation, and not ours. */
export const MARK_PREFIX = 'bugcast:';

/** The one reserved name. Session-scoped; everything else is timeline-scoped. */
export const SESSION_MARK = 'bugcast:session';

/**
 * Three budgets, because depth alone is not a size limit.
 *
 * This is the trap worth naming: depth-limiting caps *nesting*, not size. A
 * depth-2 object with 100k keys passes a depth cap completely untouched — and
 * that is the exact shape of a feature-flag map or a flat store slice, which is
 * what developers actually attach. Breadth is the cap that does the work here;
 * depth is the one people remember.
 *
 * `chars` is per string, not per payload, because one 10MB string under one key
 * clears both of the other two.
 */
export const CAPS = { depth: 4, breadth: 64, chars: 1024 } as const;

export type Caps = typeof CAPS;

/**
 * Distinct sentinels, one per budget.
 *
 * A single `[truncated]` everywhere tells the reading agent that something is
 * missing and not which knob to turn — so a developer whose flag map was
 * clipped cannot tell it from one whose object was too deep. Each sentinel
 * names its own budget and the size of what it withheld.
 */
export const DEPTH = (kind: string): string => `[depth limit: ${kind}]`;
export const BREADTH_KEY = '[breadth limit]';
export const BREADTH = (n: number): string => `${n} more withheld`;
export const CHARS = (n: number): string => `…[string limit: ${n} chars]`;

const kindOf = (v: unknown): string =>
  Array.isArray(v) ? 'Array' : Object.prototype.toString.call(v).slice(8, -1);

/**
 * Bound a page-supplied value to something safe to carry.
 *
 * Runs in the content script, *before* the value crosses `sendMessage` — a
 * capped payload is the point, and capping after the hop would mean a 10MB
 * store had already been serialized and copied to make the trip.
 *
 * Deliberately not a redactor: this bounds size, `lib/redact.ts` removes
 * secrets, and they run at different moments for different reasons.
 */
export function cap(value: unknown, caps: Caps = CAPS, depth = 0): unknown {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string') {
    const s = value as string;
    return s.length <= caps.chars ? s : s.slice(0, caps.chars) + CHARS(s.length);
  }
  if (type === 'number' || type === 'boolean') return value;
  // Functions and symbols do not survive the message hop anyway; dropping them
  // here means the shape an agent reads is the shape that was capped.
  if (type !== 'object') return undefined;

  if (depth >= caps.depth) return DEPTH(kindOf(value));

  if (Array.isArray(value)) {
    const kept = value.slice(0, caps.breadth).map((v) => cap(v, caps, depth + 1));
    if (value.length > caps.breadth) kept.push(BREADTH(value.length - caps.breadth));
    return kept;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries.slice(0, caps.breadth)) {
    const capped = cap(v, caps, depth + 1);
    if (capped !== undefined) out[k] = capped;
  }
  if (entries.length > caps.breadth) out[BREADTH_KEY] = BREADTH(entries.length - caps.breadth);
  return out;
}

export interface HarvestedEntry {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  detail?: unknown;
}

export interface Harvested {
  /** Session-scoped meta replaces; timeline-scoped appends. */
  scope: 'session' | 'timeline';
  /** The name with `bugcast:` stripped. Empty for the session mark. */
  name: string;
  detail: unknown;
  /** Epoch ms, so the worker converts through lib/time.ts like every other source. */
  epochMs: number;
  /** Present only for a `measure`, which has real duration. */
  endEpochMs?: number;
  source: 'mark' | 'measure';
}

/**
 * Turn one performance entry into something the timeline can hold.
 *
 * Returns null for anything not ours — which is almost everything, since a real
 * application's timeline is full of its own marks and framework instrumentation.
 *
 * `timeOrigin + startTime` is the conversion to epoch: entries are relative to
 * their own document's origin, and a session spans documents. Everything then
 * goes through `lib/time.ts` exactly as CDP and interaction timestamps do —
 * there is no second clock here.
 */
export function fromEntry(entry: HarvestedEntry, timeOrigin: number): Harvested | null {
  if (!entry?.name?.startsWith(MARK_PREFIX)) return null;
  const source = entry.entryType === 'measure' ? 'measure' : 'mark';
  const epochMs = timeOrigin + entry.startTime;
  const session = entry.name === SESSION_MARK;
  return {
    scope: session ? 'session' : 'timeline',
    name: session ? '' : entry.name.slice(MARK_PREFIX.length),
    detail: cap(entry.detail),
    epochMs,
    ...(source === 'measure' && entry.duration > 0
      ? { endEpochMs: epochMs + entry.duration }
      : {}),
    source,
  };
}
