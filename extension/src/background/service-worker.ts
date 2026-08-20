import { CdpSession } from '../lib/cdp';
import { NetworkCapture, type CaptureContext } from '../lib/cdp-network';
import { PageCapture } from '../lib/cdp-page';
import type { TimelineEvent } from '../lib/events';
import { NO_REDACTION } from '../lib/redact';
import { RECORDING_STATE, START_RECORDING, STOP_RECORDING, type Response } from './messages';

interface Recording {
  cdp: CdpSession;
  ctx: CaptureContext;
  events: TimelineEvent[];
}

let active: Recording | null = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg?.type).then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
  return true; // async response
});

async function handle(type: string | undefined): Promise<Response> {
  switch (type) {
    case RECORDING_STATE:
      return { ok: true, recording: active !== null };
    case START_RECORDING:
      return start();
    case STOP_RECORDING:
      return stop();
    default:
      return { error: `Unknown message: ${type}` };
  }
}

async function start(): Promise<Response> {
  if (active) return { ok: true, recording: true };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
    pageUrl: tab.url ?? '',
    emit: (event) => events.push(event),
    // #3 replaces this. Named so it is greppable and so nothing ships
    // un-redacted by omission rather than by decision.
    redactor: NO_REDACTION,
  };

  new NetworkCapture(cdp, ctx).start();
  new PageCapture(cdp, ctx).start();

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
  const { cdp, events } = active;
  active = null;
  await cdp.detach();

  // Events are sorted once, at the end — the flat timeline is the contract,
  // and sources arrive interleaved and slightly out of order.
  events.sort((a, b) => a.t - b.t);
  // ponytail: disk output is #7, artifact assembly is #9.
  console.log(`[bugcast] captured ${events.length} events`, events);
  return { ok: true, recording: false };
}
