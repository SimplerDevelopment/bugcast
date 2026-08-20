import { CdpSession } from '../lib/cdp';
import { NetworkCapture, type CaptureContext } from '../lib/cdp-network';
import { PageCapture } from '../lib/cdp-page';
import type { TimelineEvent } from '../lib/events';
import { DefaultRedactor } from '../lib/redact';
import { SCHEMA_VERSION } from '../lib/events';
import { sessionId, storedSessionDirectory, writeFile } from '../lib/session-store';
import { RECORDING_STATE, START_RECORDING, STOP_RECORDING, type Response } from './messages';

interface Recording {
  cdp: CdpSession;
  ctx: CaptureContext;
  events: TimelineEvent[];
  startedAt: Date;
  redactor: DefaultRedactor;
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
  const startedAt = new Date();
  const redactor = new DefaultRedactor();
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
    redactor,
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

  active = { cdp, ctx, events, startedAt, redactor };
  return { ok: true, recording: true };
}

async function stop(): Promise<Response> {
  if (!active) return { ok: true, recording: false };
  const { cdp, events, startedAt, redactor } = active;
  const startUrl = active.ctx.pageUrl;
  active = null;
  await cdp.detach();

  // Sorted once, at the end — the flat timeline is the contract, and sources
  // arrive interleaved and slightly out of order.
  events.sort((a, b) => a.t - b.t);

  const id = sessionId(startedAt, startUrl);
  const redaction = redactor.summary();
  let written: string | null = null;
  try {
    written = await writeSession(id, startedAt, startUrl, events, redaction);
  } catch (e) {
    // A failed write must not swallow the session — the caller still gets the
    // events, so a folder problem costs a save rather than the recording.
    console.error('[bugcast] could not write session', e);
  }

  return { ok: true, recording: false, events, redaction, sessionId: id, written };
}

async function writeSession(
  id: string,
  startedAt: Date,
  startUrl: string,
  events: TimelineEvent[],
  redaction: unknown,
): Promise<string> {
  const dir = await storedSessionDirectory();
  if (!dir) throw new Error('No sessions folder has been chosen.');

  const durationMs = events.length ? Math.max(...events.map((e) => e.tEnd ?? e.t)) : 0;

  // Both files carry schemaVersion so either is interpretable alone — which is
  // how an agent will actually read them. Additive changes do not bump it;
  // consumers ignore unknown fields.
  await writeFile(
    dir,
    id,
    'session.json',
    JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        tool: { name: 'bugcast', version: chrome.runtime.getManifest().version },
        session: {
          id,
          t0: startedAt.toISOString(),
          t0Epoch: startedAt.getTime(),
          durationMs,
          startUrl,
        },
        environment: { userAgent: navigator.userAgent },
        // ponytail: video (#5), transcript (#6) and frames (#8) are not built
        // yet. Declaring them false is honest — an artifact that silently omits
        // a section reads as "nothing to report" rather than "not captured".
        capture: {
          network: { enabled: true, bodiesFor: ['status>=400'], bodyCapBytes: 65536 },
          console: { enabled: true },
          video: { enabled: false },
          transcript: { enabled: false },
          frames: { enabled: false },
        },
        redaction: {
          typedValues: 'off',
          summary: redaction,
          warnings: [
            'Redaction is best-effort heuristics, not a guarantee. Review before sharing.',
          ],
        },
        files: { timeline: 'timeline.json' },
      },
      null,
      2,
    ),
  );

  await writeFile(
    dir,
    id,
    'timeline.json',
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, sessionId: id, t0Epoch: startedAt.getTime(), events }, null, 2),
  );

  return `${dir.name}/${id}`;
}
