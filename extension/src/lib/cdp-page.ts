/**
 * Everything from the page that isn't network: console output, uncaught
 * exceptions, browser-level log entries, and navigation.
 *
 * Note the clock difference — this is a real trap, not a footnote. CDP's
 * `Runtime` and `Log` timestamps are **already epoch milliseconds**, while the
 * `Network` domain's are monotonic seconds. Adjacent domains, same field name,
 * different units.
 *
 * `Log.entryAdded` earns its place twice over: its `source` enum includes
 * `security`, so CSP violations arrive through it directly, and it carries the
 * full human-readable CORS diagnosis for requests whose bodies can never be
 * retrieved.
 *
 * Design: docs/design/issues/06, /13
 */

import type { CdpSession } from './cdp';
import type { CaptureContext } from './cdp-network';
import { runtimeTimestampToEpochMs, toSessionMs } from './time';

/** Render CDP RemoteObjects into something a human can read in a report. */
export function renderArgs(args: any[] | undefined): string {
  if (!args?.length) return '';
  return args
    .map((a) => {
      if (a?.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
      if (a?.description) return a.description;
      if (a?.unserializableValue) return String(a.unserializableValue);
      return a?.type ?? '';
    })
    .join(' ');
}

/** Prefer the description, which carries the stack; fall back to the bare text. */
export function exceptionText(details: any): { text: string; stack?: string } {
  const description: string | undefined = details?.exception?.description;
  const text: string = details?.text ?? 'Uncaught exception';
  if (!description) return { text };
  const [first, ...rest] = description.split('\n');
  return { text: first!.trim(), stack: rest.length ? rest.join('\n').trim() : undefined };
}

export class PageCapture {
  constructor(
    private cdp: CdpSession,
    private ctx: CaptureContext,
  ) {}

  start(): void {
    this.cdp.on('Runtime.consoleAPICalled', (p) => {
      this.ctx.emit({
        type: 'console',
        t: toSessionMs(runtimeTimestampToEpochMs(p.timestamp), this.ctx.t0),
        pageUrl: this.ctx.pageUrl,
        level: p.type ?? 'log',
        text: this.ctx.redactor.body(renderArgs(p.args), undefined),
        source: 'console-api',
      });
    });

    this.cdp.on('Runtime.exceptionThrown', (p) => {
      const { text, stack } = exceptionText(p.exceptionDetails);
      this.ctx.emit({
        type: 'exception',
        t: toSessionMs(runtimeTimestampToEpochMs(p.timestamp), this.ctx.t0),
        pageUrl: this.ctx.pageUrl,
        text: this.ctx.redactor.body(text, undefined),
        stack,
      });
    });

    this.cdp.on('Log.entryAdded', (p) => {
      const entry = p.entry ?? {};
      this.ctx.emit({
        type: 'console',
        t: toSessionMs(runtimeTimestampToEpochMs(entry.timestamp), this.ctx.t0),
        pageUrl: this.ctx.pageUrl,
        level: entry.level ?? 'info',
        text: this.ctx.redactor.body(entry.text ?? '', undefined),
        source: entry.source ?? 'log',
      });
    });

    // Full document load. Sub-frames navigate constantly and are not the
    // session's page context, so only the top frame counts.
    this.cdp.on('Page.frameNavigated', (p) => {
      if (p.frame?.parentId) return;
      this.navigate(p.frame?.url ?? '', 'load');
    });

    // History API — CDP reports these separately, and in a SPA they are the
    // only navigation signal there is.
    this.cdp.on('Page.navigatedWithinDocument', (p) => {
      this.navigate(p.url ?? '', 'pushState');
    });
  }

  private navigate(rawUrl: string, trigger: 'load' | 'pushState'): void {
    const url = this.ctx.redactor.url(rawUrl);
    if (url === this.ctx.pageUrl) return;
    const from = this.ctx.pageUrl || null;
    this.ctx.pageUrl = url;
    this.ctx.emit({
      type: 'navigation',
      // Page navigation events carry no timestamp of their own; the event
      // arrives within a millisecond or two of the navigation, well inside the
      // ±250ms budget, so wall-clock at handler time is honest here.
      t: toSessionMs(Date.now(), this.ctx.t0),
      pageUrl: url,
      trigger,
      from,
    });
  }
}
