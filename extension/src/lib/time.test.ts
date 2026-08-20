import { describe, expect, it } from 'vitest';
import {
  assertEpochMs,
  calibrateMonotonic,
  monotonicToEpochMs,
  runtimeTimestampToEpochMs,
  toSessionMs,
  wallTimeToEpochMs,
} from './time';

// Real values captured from Chromium during the CDP spike, so the test pins
// the actual shapes rather than invented ones.
// docs/design/issues/13-run-the-outstanding-spikes.md
const MONOTONIC = 92519.3109; // Network.responseReceived.timestamp — seconds
const WALL_TIME = 1787251018.083095; // Network.requestWillBeSent.wallTime — epoch seconds
const RUNTIME = 1787251018333.788; // Runtime.consoleAPICalled.timestamp — epoch ms

describe('the three CDP units', () => {
  it('converts wallTime (epoch seconds) to epoch ms', () => {
    expect(wallTimeToEpochMs(WALL_TIME)).toBeCloseTo(1787251018083.095, 3);
  });

  it('passes Runtime timestamps through, since they are already epoch ms', () => {
    expect(runtimeTimestampToEpochMs(RUNTIME)).toBe(RUNTIME);
  });

  it('converts monotonic seconds to epoch ms via a calibrated offset', () => {
    const offset = calibrateMonotonic(MONOTONIC, WALL_TIME);
    // The instant that produced the calibration round-trips exactly.
    expect(monotonicToEpochMs(MONOTONIC, offset)).toBeCloseTo(WALL_TIME * 1000, 6);
    // And a later monotonic reading advances by the same amount.
    expect(monotonicToEpochMs(MONOTONIC + 1.5, offset)).toBeCloseTo(WALL_TIME * 1000 + 1500, 6);
  });
});

describe('assertEpochMs — the 1000x guard', () => {
  it('rejects epoch seconds passed as milliseconds (lands in 1970)', () => {
    expect(() => assertEpochMs(WALL_TIME, 'x')).toThrow(RangeError);
  });

  it('rejects epoch milliseconds passed as seconds (lands past 2100)', () => {
    expect(() => assertEpochMs(RUNTIME * 1000, 'x')).toThrow(RangeError);
  });

  it('rejects a raw monotonic value, which is neither', () => {
    expect(() => assertEpochMs(MONOTONIC, 'x')).toThrow(RangeError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => assertEpochMs(NaN, 'x')).toThrow(TypeError);
    expect(() => assertEpochMs(Infinity, 'x')).toThrow(TypeError);
  });

  it('names the offending field, so a failure is actionable', () => {
    expect(() => assertEpochMs(0, 'Network.wallTime')).toThrow(/Network\.wallTime/);
  });

  it('accepts a plausible instant', () => {
    expect(assertEpochMs(RUNTIME, 'x')).toBe(RUNTIME);
  });
});

describe('toSessionMs', () => {
  const t0 = 1787251018083;

  it('yields whole milliseconds from t0', () => {
    expect(toSessionMs(t0 + 11942.4, t0)).toBe(11942);
  });

  it('allows negative values — MediaRecorder can deliver data from before start()', () => {
    expect(toSessionMs(t0 - 49, t0)).toBe(-49);
  });
});
