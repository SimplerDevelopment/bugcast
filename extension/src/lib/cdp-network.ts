/**
 * Network capture.
 *
 * Metadata for every request; bodies only for failures. Request *count* is
 * itself a QA signal ("that button fired twelve identical POSTs"), and the
 * successful requests are how an agent rules things out rather than finds
 * things.
 *
 * The load-bearing rule is that bodies are pulled **eagerly**, inside the
 * `loadingFinished` handler. Bodies do not survive a navigation, and
 * `Network.configureDurableMessages` is accepted but does not help — both
 * confirmed live against Chromium. Defer or batch the retrieval and the
 * artifact silently ships with empty bodies, which is the difference between a
 * session that diagnoses itself and one that is worthless: in the worked
 * example the console error said only "Failed to save post", while the 500 body
 * named the missing column.
 *
 * Design: docs/design/issues/06, /02, /13
 */

import type { CdpSession, Source } from './cdp';
import type { EmitEvent, NetworkEvent } from './events';
import type { Redactor } from './redact';
import {
  calibrateMonotonic,
  monotonicToEpochMs,
  toSessionMs,
  wallTimeToEpochMs,
  type EpochMs,
} from './time';

export const BODY_CAP_BYTES = 65_536;

export interface CaptureContext {
  t0: EpochMs;
  /** Mutated by navigation capture; read as page context for every event. */
  pageUrl: string;
  emit: EmitEvent;
  redactor: Redactor;
}

/**
 * Whether a payload is worth storing as text.
 *
 * Base64 image bytes tell an agent nothing and inflate the artifact by 4/3, so
 * binary is recorded as a note rather than data.
 */
export function isTextual(contentType: string | undefined): boolean {
  if (!contentType) return true; // no type given — assume text and let the cap protect us
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'application/x-www-form-urlencoded' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  );
}

/** Streams never fire `loadingFinished`, so their bodies are structurally absent. */
export function isStream(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]!.trim().toLowerCase() === 'text/event-stream';
}

export function prepareBody(
  raw: string,
  base64Encoded: boolean,
  contentType: string | undefined,
): NonNullable<NetworkEvent['response']> {
  const headers = {};
  if (isStream(contentType)) return { headers, omitted: 'stream', size: raw.length };
  if (base64Encoded || !isTextual(contentType)) {
    return { headers, omitted: 'binary', size: raw.length };
  }
  // Error bodies are small JSON or an HTML error page, and the first 64KB of a
  // stack-trace page is the useful part. The cap is ours, not the protocol's —
  // the spike retrieved 600KB without complaint.
  if (raw.length > BODY_CAP_BYTES) {
    return { headers, body: raw.slice(0, BODY_CAP_BYTES), truncated: true, size: raw.length };
  }
  return { headers, body: raw, truncated: false, size: raw.length };
}

interface Pending {
  event: NetworkEvent;
  sessionId?: string;
  contentType?: string;
  monotonicStart: number;
}

export class NetworkCapture {
  private pending = new Map<string, Pending>();
  /** Derived once, from the first requestWillBeSent that carries a wallTime. */
  private monotonicOffset: number | null = null;

  constructor(
    private cdp: CdpSession,
    private ctx: CaptureContext,
  ) {}

  start(): void {
    this.cdp.on('Network.requestWillBeSent', (p, s) => this.onRequest(p, s));
    this.cdp.on('Network.responseReceived', (p) => this.onResponse(p));
    this.cdp.on('Network.loadingFinished', (p) => void this.onFinished(p));
    this.cdp.on('Network.loadingFailed', (p) => this.onFailed(p));
  }

  private key(requestId: string, source?: Source): string {
    // requestIds are only unique per target, so child sessions get their own space.
    return source?.sessionId ? `${source.sessionId}:${requestId}` : requestId;
  }

  private onRequest(p: any, source: Source): void {
    // The only place CDP hands you a monotonic timestamp and an epoch wallTime
    // describing the same instant — which is what makes the clocks relatable.
    if (this.monotonicOffset === null && typeof p.wallTime === 'number') {
      this.monotonicOffset = calibrateMonotonic(p.timestamp, p.wallTime);
    }

    const r = this.ctx.redactor;
    const postData: string | undefined = p.request?.postData;
    const event: NetworkEvent = {
      type: 'network',
      t: toSessionMs(this.epoch(p.timestamp, p.wallTime), this.ctx.t0),
      pageUrl: this.ctx.pageUrl,
      requestId: p.requestId,
      method: p.request?.method ?? 'GET',
      url: r.url(p.request?.url ?? ''),
      resourceType: p.type ?? 'Other',
      initiator: p.initiator?.type,
      request: {
        headers: r.headers(p.request?.headers ?? {}),
        // Free — requestWillBeSent already carries it, and "the button sent the
        // wrong payload" is a top-three QA finding.
        ...(postData
          ? {
              postData: r.body(postData.slice(0, BODY_CAP_BYTES), undefined),
              postDataTruncated: postData.length > BODY_CAP_BYTES,
              postDataSize: postData.length,
            }
          : {}),
      },
    };

    this.pending.set(this.key(p.requestId, source), {
      event,
      sessionId: source?.sessionId,
      monotonicStart: p.timestamp,
    });
  }

  private onResponse(p: any): void {
    const entry = this.pending.get(this.key(p.requestId));
    if (!entry) return;
    entry.event.status = p.response?.status;
    entry.event.statusText = p.response?.statusText;
    entry.contentType = p.response?.mimeType;
    entry.event.response = { headers: this.ctx.redactor.headers(p.response?.headers ?? {}) };
  }

  private async onFinished(p: any): Promise<void> {
    const key = this.key(p.requestId);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);

    const { event } = entry;
    event.tEnd = toSessionMs(this.epochFromMonotonic(p.timestamp), this.ctx.t0);
    event.encodedDataLength = p.encodedDataLength;

    // Bodies for failures only. The eager pull happens here and nowhere else.
    if ((event.status ?? 0) >= 400) {
      try {
        const { body, base64Encoded } = await this.cdp.send<{
          body: string;
          base64Encoded: boolean;
        }>('Network.getResponseBody', { requestId: p.requestId }, entry.sessionId);

        const prepared = prepareBody(body, base64Encoded, entry.contentType);
        event.response = {
          ...prepared,
          headers: event.response?.headers ?? {},
          ...(prepared.body
            ? { body: this.ctx.redactor.body(prepared.body, entry.contentType) }
            : {}),
        };
      } catch {
        // CORS-blocked and preflight responses refuse their body permanently —
        // spike-confirmed. Log.entryAdded carries the human-readable diagnosis,
        // which for QA is more useful than the body would have been, so this is
        // a recorded absence rather than an error.
        event.response = { headers: event.response?.headers ?? {}, omitted: 'binary' };
      }
    }

    this.ctx.emit(event);
  }

  private onFailed(p: any): void {
    const key = this.key(p.requestId);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);

    const { event } = entry;
    event.tEnd = toSessionMs(this.epochFromMonotonic(p.timestamp), this.ctx.t0);
    // There is never a body here — loadingFailed fires *instead of*
    // responseReceived, so the browser never received bytes to buffer.
    event.failure = {
      errorText: p.errorText ?? 'unknown',
      corsErrorStatus: p.corsErrorStatus?.corsError,
      blockedReason: p.blockedReason,
      // Navigation cancels in-flight requests and AbortController churn is
      // routine, so flagging these as failures would fill the artifact with
      // false positives.
      canceled: Boolean(p.canceled),
    };
    this.ctx.emit(event);
  }

  private epoch(timestamp: number, wallTime?: number): EpochMs {
    if (typeof wallTime === 'number') return wallTimeToEpochMs(wallTime);
    return this.epochFromMonotonic(timestamp);
  }

  private epochFromMonotonic(timestamp: number): EpochMs {
    if (this.monotonicOffset === null) return Date.now();
    return monotonicToEpochMs(timestamp, this.monotonicOffset);
  }
}
