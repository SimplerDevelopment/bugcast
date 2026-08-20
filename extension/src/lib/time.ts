/**
 * Time normalisation.
 *
 * CDP mixes **three** different time units across adjacent fields. Confirmed
 * live against Chromium (docs/design/issues/13-run-the-outstanding-spikes.md):
 *
 *   Network.responseReceived.timestamp   92519.3109         monotonic SECONDS
 *   Network.requestWillBeSent.wallTime   1787251018.083095  epoch SECONDS
 *   Runtime.consoleAPICalled.timestamp   1787251018333.788  epoch MILLISECONDS
 *
 * All three are called "timestamp"-ish and all three are plain numbers, so
 * reading one as another is a silent 1000x error that still looks like a date.
 * Every timestamp in the artifact goes through this module — nothing should
 * ever do its own arithmetic on a raw CDP time value.
 *
 * Design: docs/design/issues/04-clock-sources-and-normalization.md
 */

/** Milliseconds since the Unix epoch. */
export type EpochMs = number;

/** Milliseconds since `t0` — the value that appears as `t` in timeline.json. */
export type SessionMs = number;

/** 2000-01-01 and 2100-01-01, in epoch ms. */
const PLAUSIBLE_MIN = 946_684_800_000;
const PLAUSIBLE_MAX = 4_102_444_800_000;

/**
 * Throw if a value is not a plausible epoch-ms instant.
 *
 * This is the guard that catches the 1000x error at its source: epoch *seconds*
 * read as milliseconds lands in 1970, and milliseconds read as seconds lands
 * far past 2100. Both are caught here rather than surfacing as an event
 * ordered fifty years away from everything around it.
 */
export function assertEpochMs(value: number, field: string): EpochMs {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${field}: expected a finite epoch-ms value, got ${value}`);
  }
  if (value < PLAUSIBLE_MIN || value > PLAUSIBLE_MAX) {
    throw new RangeError(
      `${field}: ${value} is not a plausible epoch-ms instant — check the unit ` +
        `(CDP mixes monotonic seconds, epoch seconds and epoch milliseconds)`,
    );
  }
  return value;
}

/**
 * Offset that converts CDP monotonic time to epoch time.
 *
 * Both arguments must come from the **same** `Network.requestWillBeSent` event:
 * that event is the only place CDP hands you a monotonic `timestamp` and an
 * epoch `wallTime` describing the same instant, which is what makes the two
 * clocks relatable at all.
 */
export function calibrateMonotonic(timestamp: number, wallTime: number): number {
  if (!Number.isFinite(timestamp) || !Number.isFinite(wallTime)) {
    throw new TypeError(`calibrateMonotonic: non-finite input (${timestamp}, ${wallTime})`);
  }
  return wallTime * 1000 - timestamp * 1000;
}

/** CDP monotonic seconds (Network domain) -> epoch ms. */
export function monotonicToEpochMs(timestamp: number, offsetMs: number): EpochMs {
  return assertEpochMs(timestamp * 1000 + offsetMs, 'Network.timestamp');
}

/** CDP epoch seconds (`wallTime`) -> epoch ms. */
export function wallTimeToEpochMs(wallTime: number): EpochMs {
  return assertEpochMs(wallTime * 1000, 'Network.wallTime');
}

/**
 * CDP Runtime/Log `timestamp` -> epoch ms.
 *
 * Already epoch milliseconds. The identity is deliberate: it exists so call
 * sites read the same as the other two conversions and get the same guard,
 * rather than quietly skipping normalisation because this one needs no maths.
 */
export function runtimeTimestampToEpochMs(timestamp: number): EpochMs {
  return assertEpochMs(timestamp, 'Runtime.timestamp');
}

/** Epoch ms -> ms since session start. May be negative for pre-`t0` events. */
export function toSessionMs(epochMs: EpochMs, t0: EpochMs): SessionMs {
  return Math.round(epochMs - t0);
}
