/**
 * The first-run self-test.
 *
 * Bugcast has four independent subsystems and every one of them fails
 * **quietly**, producing a bad artifact rather than an error: a debugger that
 * will not attach, a capture that yields no bytes, a folder that cannot be
 * written, a model that never downloads. The asymmetry is the whole
 * justification — the alternative is someone narrating ten careful minutes and
 * then discovering the transcript never happened.
 *
 * Design: docs/design/issues/12-install-and-distribution.md
 */

export type CheckId = 'cdp' | 'capture' | 'disk' | 'asr';

export interface CheckResult {
  id: CheckId;
  label: string;
  ok: boolean;
  /** What happened, in a form a user can act on. */
  detail: string;
  ms: number;
}

export interface Check {
  id: CheckId;
  label: string;
  run: () => Promise<string>;
}

/**
 * Runs every check even after one fails.
 *
 * Stopping at the first failure would report "the debugger is blocked" and hide
 * that the folder is unwritable too, costing the user a second round trip for
 * information already available.
 */
export async function runChecks(
  checks: Check[],
  now: () => number = Date.now,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const started = now();
    try {
      const detail = await check.run();
      results.push({ id: check.id, label: check.label, ok: true, detail, ms: now() - started });
    } catch (e) {
      results.push({
        id: check.id,
        label: check.label,
        ok: false,
        detail: describeError(e),
        ms: now() - started,
      });
    }
  }
  return results;
}

/**
 * A failure detail a user can act on.
 *
 * `String(value)` on a plain object yields "[object Object]", and a self-test
 * whose failure message is "[object Object]" has told you nothing — which is
 * the exact failure mode this whole feature exists to prevent.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export const summarise = (results: CheckResult[]): string => {
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return `All ${results.length} checks passed.`;
  return `${failed.length} of ${results.length} failed: ${failed.map((r) => r.label).join(', ')}.`;
};
