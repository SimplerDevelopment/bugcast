/**
 * `report.md` — a deterministic rendering of `timeline.json`.
 *
 * It is generated, against the instinct to leave raw data as the whole
 * deliverable, but with a hard constraint that resolves the tension: **it
 * contains no analysis, and no model is involved.** A narrative report would
 * need one, which would breach the zero-network-calls rule — and narrative is
 * not what is needed, because the consuming agent brings that. What is needed
 * is an entry point: session header, failures grouped with counts, the
 * interleaved timeline, the redaction summary. All mechanical. All regenerable.
 *
 * The test of this module is that it never says *why* anything happened. In the
 * worked example the answer is an unapplied migration, and the report must not
 * say so — it prints the 500 body that names the missing column and stops.
 *
 * Design: docs/design/issues/09-the-artifact-contract.md
 */

import type { ConsoleEvent, ExceptionEvent, NetworkEvent, TimelineEvent } from './events';
import type { RedactionSummary } from './redact';

export interface ReportMeta {
  id: string;
  title: string;
  startedAt: Date;
  startUrl: string;
  durationMs: number;
  userAgent: string;
  redaction: RedactionSummary;
  files: Array<[name: string, description: string]>;
}

/** `00:12.318` — the form you can paste into a video player's seek box. */
export function stamp(t: number): string {
  const sign = t < 0 ? '-' : '';
  const ms = Math.abs(Math.round(t));
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${sign}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(
    ms % 1000,
  ).padStart(3, '0')}`;
}

const isNetwork = (e: TimelineEvent): e is NetworkEvent => e.type === 'network';

/** A network event that a developer would call a failure. */
export function isFailure(e: NetworkEvent): boolean {
  if (e.failure) return !e.failure.canceled; // aborts are routine, not failures
  return (e.status ?? 0) >= 400;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

const escapeCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function times(events: Array<{ t: number }>): string {
  return events.map((e) => stamp(e.t)).join(' and ');
}

function renderFailures(events: TimelineEvent[]): string {
  const failures = events.filter(isNetwork).filter(isFailure);
  const errors = events.filter(
    (e): e is ConsoleEvent | ExceptionEvent =>
      (e.type === 'console' && e.level === 'error') || e.type === 'exception',
  );

  if (!failures.length && !errors.length) {
    return '## Failures\n\nNone recorded.\n';
  }

  const lines: string[] = ['## Failures\n'];

  if (failures.length) {
    const grouped = groupBy(failures, (e) => `${e.method} ${e.url} ${e.status ?? e.failure?.errorText}`);
    lines.push(
      `**${failures.length} failed request${failures.length === 1 ? '' : 's'}**, ${grouped.size} distinct.\n`,
    );
    for (const [, group] of grouped) {
      const first = group[0]!;
      const outcome = first.status ? `${first.status}` : (first.failure?.errorText ?? 'failed');
      const count = group.length > 1 ? ` (×${group.length}, at ${times(group)})` : ` (at ${stamp(first.t)})`;
      lines.push(`### ${first.method} ${first.url} → ${outcome}${count}\n`);

      if (first.failure) {
        lines.push('```');
        lines.push(first.failure.errorText);
        if (first.failure.corsErrorStatus) lines.push(`CORS: ${first.failure.corsErrorStatus}`);
        if (first.failure.blockedReason) lines.push(`Blocked: ${first.failure.blockedReason}`);
        lines.push('```\n');
      }
      if (first.response?.body) {
        lines.push('```');
        lines.push(first.response.body);
        lines.push('```\n');
        if (first.response.truncated) {
          lines.push(`_Truncated; ${first.response.size} bytes total._\n`);
        }
      } else if (first.response?.omitted) {
        lines.push(`_Body omitted: ${first.response.omitted}._\n`);
      }
      if (first.request?.postData) {
        lines.push(`Request body${first.request.postDataTruncated ? ' (truncated)' : ''}:\n`);
        lines.push('```');
        lines.push(first.request.postData);
        lines.push('```\n');
      }
      const frames = group.map((e) => e.frame).filter(Boolean);
      if (frames.length) lines.push(`Frames: ${frames.map((f) => `\`${f}\``).join(', ')}\n`);
    }
  }

  if (errors.length) {
    const grouped = groupBy(errors, (e) => e.text);
    lines.push(
      `**${errors.length} console error${errors.length === 1 ? '' : 's'}**, ${grouped.size} distinct.\n`,
    );
    for (const [text, group] of grouped) {
      const count = group.length > 1 ? ` (×${group.length}, at ${times(group)})` : ` (at ${stamp(group[0]!.t)})`;
      lines.push(`### \`${text}\`${count}\n`);
      const stack = group[0]!.stack;
      if (stack) lines.push('```\n' + stack + '\n```\n');
    }
  }

  return lines.join('\n');
}

/** One row per event. The `|` column is a compact type marker, not decoration. */
function renderRow(e: TimelineEvent): string {
  const cell = (marker: string, detail: string) =>
    `| ${stamp(e.t)} | ${marker} | ${escapeCell(detail)} |`;

  switch (e.type) {
    case 'navigation':
      return cell('nav', `**${e.trigger}** ${e.pageUrl}`);
    case 'speech':
      return cell('🎙', `*"${e.text}"*`);
    case 'console':
      return cell(e.level === 'error' ? '**err**' : 'log', `\`${e.text}\``);
    case 'exception':
      return cell('**err**', `\`${e.text}\``);
    case 'network': {
      const outcome = e.status ?? e.failure?.errorText ?? '?';
      const duration = e.tEnd !== undefined ? ` (${Math.round(e.tEnd - e.t)}ms)` : '';
      const row = `${e.method} \`${e.url}\` → ${outcome}${duration}`;
      return cell(isFailure(e) ? '**net**' : 'net', isFailure(e) ? `**${row}**` : row);
    }
    case 'click':
      return cell('click', `${e.target.name ? `**${e.target.name}** ` : ''}\`${e.target.selector}\``);
    case 'keydown':
      return cell('key', `\`${[...e.modifiers, e.key].join('+')}\` on \`${e.target.selector}\``);
    case 'change':
      return cell(
        'change',
        `\`${e.target.selector}\` — ${
          e.value.redacted
            ? `value withheld (${e.value.chars} chars, ${e.value.shape})`
            : `\`${e.value.value}\``
        }`,
      );
    case 'submit':
      return cell('submit', `\`${e.target.selector}\``);
    case 'drag':
      return cell(
        'drag',
        `\`${e.from.target.selector}\` → \`${e.to.target.selector}\` (${e.mechanism}${
          e.tEnd !== undefined ? `, ${Math.round(e.tEnd - e.t)}ms` : ''
        })`,
      );
    case 'focus':
      return cell('focus', `\`${e.target.selector}\``);
    case 'marker':
      return cell('**mark**', `**${e.note}**`);
    case 'annotation': {
      const detail = e.detail === undefined ? '' : ` \`${JSON.stringify(e.detail)}\``;
      const duration = e.tEnd !== undefined ? ` (${Math.round(e.tEnd - e.t)}ms)` : '';
      return cell('app', `**${e.name}**${duration}${detail}`);
    }
  }
}

function renderRedaction(summary: RedactionSummary): string {
  const lines = ['## Redaction\n', 'Typed values: **off** (default). Applied this session:\n'];
  const counts = (label: string, value: unknown): void => {
    if (value && typeof value === 'object' && Object.keys(value).length) {
      for (const [k, n] of Object.entries(value as Record<string, number>)) {
        lines.push(`- \`${k}\` ${label} redacted ×${n}`);
      }
    }
  };
  counts('header', summary.headersRedacted);
  counts('URL parameter', summary.urlParamsRedacted);
  counts('body key', summary.bodyKeysRedacted);
  if (summary.typedValuesWithheld) lines.push(`- ${summary.typedValuesWithheld} typed values withheld`);
  if (summary.highEntropyMatches) {
    lines.push(`- ${summary.highEntropyMatches} high-entropy values redacted`);
  }
  if (lines.length === 2) lines.push('- Nothing matched.');

  lines.push(
    '',
    '> ⚠️ **`video.webm` and `frames/` are not redacted.** They show whatever was',
    '> on screen in this tab. Redaction is best-effort heuristics, not a',
    '> guarantee. Review before sharing.',
  );
  return lines.join('\n') + '\n';
}

export function renderReport(meta: ReportMeta, events: TimelineEvent[]): string {
  const when = meta.startedAt.toISOString().replace('T', ' ').slice(0, 19);
  return [
    `# ${meta.title}`,
    '',
    `**Session** \`${meta.id}\``,
    `**Recorded** ${when} UTC · **Duration** ${(meta.durationMs / 1000).toFixed(1)}s`,
    `**Start URL** ${meta.startUrl}`,
    `**User agent** ${meta.userAgent}`,
    '',
    '> This report is a deterministic rendering of `timeline.json`. It contains no',
    '> analysis — every line below is a fact recorded during the session. Read',
    '> `timeline.json` for the full detail.',
    '',
    '---',
    '',
    renderFailures(events),
    '---',
    '',
    '## Timeline',
    '',
    '| Time | | Event |',
    '|---|---|---|',
    ...events.map(renderRow),
    '',
    '---',
    '',
    renderRedaction(meta.redaction),
    '---',
    '',
    '## Files',
    '',
    '| File | |',
    '|---|---|',
    ...meta.files.map(([name, description]) => `| \`${name}\` | ${escapeCell(description)} |`),
    '',
  ].join('\n');
}
