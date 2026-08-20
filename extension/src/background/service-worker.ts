import { CdpSession } from '../lib/cdp';
import { NetworkCapture, type CaptureContext } from '../lib/cdp-network';
import { PageCapture } from '../lib/cdp-page';
import type { TimelineEvent } from '../lib/events';
import { DefaultRedactor } from '../lib/redact';
import { RECORDING_STATE, START_RECORDING, STOP_RECORDING, type Response } from './messages';

interface Recording {
  cdp: CdpSession;
  ctx: CaptureContext;
  events: TimelineEvent[];
}

let active: Recording | null = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true; // async response
});

async function handle(msg: any): Promise<Response> {
  switch (msg?.type) {
    case RECORDING_STATE:
      return { ok: true, recording: active !== null };
    case START_RECORDING:
      return start(msg.tabId, msg.pageUrl);
    case STOP_RECORDING:
      return stop();
    default:
      return { error: `Unknown message: ${msg?.type}` };
  }
}

async function start(tabId?: number, pageUrl?: string): Promise<Response> {
  if (active) return { ok: true, recording: true };

  const tab =
    tabId == null
      ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
      : await chrome.tabs.get(tabId);
  if (!tab?.id) return { error: 'No active tab to record.' };

  const cdp = new CdpSession();
  try {
    await cdp.attach(tab.id);
  } catch (e) {
    // Refuse to start rather than degrade — see cdp.ts for why.
    return { error: String((e as Error).message) };
  }

  const events: TimelineEvent[] = [];
  const ctx: CaptureContext = {
    // ponytail: t0 belongs to MediaRecorder.start() once capture lands (#5).
    // Until then the CDP clock still needs an origin, and Date.now() here is
    // the same instant to within the attach round-trip.
    t0: Date.now(),
    // The popup passes this. Without the broad `tabs` permission a worker can
    // only read tab.url when activeTab has been granted by a user gesture, and
    // relying on that would make page context silently empty in other flows.
    pageUrl: pageUrl ?? tab.url ?? '',
    emit: (event) => events.push(event),
    // Runs in memory, before anything is serialized — the raw value never
    // reaches disk. See lib/redact.ts.
    redactor: new DefaultRedactor(),
  };

  new NetworkCapture(cdp, ctx).start();
  new PageCapture(cdp, ctx).start();

  // Recording almost always starts on an already-loaded page, so
  // Page.frameNavigated never fires for it and the timeline would never say
  // where the session began. Found by the smoke test.
  events.push({ type: 'navigation', t: 0, pageUrl: ctx.pageUrl, trigger: 'load', from: null });

  cdp.detachedCallback = () => {
    // The user dismissed the infobar mid-session. The session is over either
    // way, so end it cleanly instead of collecting a half-recorded artifact.
    active = null;
  };

  active = { cdp, ctx, events };
  return { ok: true, recording: true };
}

async function stop(): Promise<Response> {
  if (!active) return { ok: true, recording: false };
  const { cdp, ctx, events } = active;
  active = null;
  await cdp.detach();

  // Events are sorted once, at the end — the flat timeline is the contract,
  // and sources arrive interleaved and slightly out of order.
  events.sort((a, b) => a.t - b.t);
  // ponytail: until #7 writes to disk, the response *is* the output.
  console.log(`[bugcast] captured ${events.length} events`, events);
  return { ok: true, recording: false, events, redaction: ctx.redactor.summary() };
}
