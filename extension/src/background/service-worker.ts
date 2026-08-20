import { CdpSession } from '../lib/cdp';
import { NetworkCapture, type CaptureContext } from '../lib/cdp-network';
import { PageCapture } from '../lib/cdp-page';
import type { TimelineEvent } from '../lib/events';
import { DefaultRedactor } from '../lib/redact';
import { SCHEMA_VERSION } from '../lib/events';
import { sessionId, storedSessionDirectory, writeFile } from '../lib/session-store';
import { renderReport } from '../lib/report';
import { toSpeechEvents, toSrt, type Segment } from '../lib/srt';
import { planFrames } from '../lib/frames';
import type { RedactionSummary } from '../lib/redact';
import {
  DROP_MARKER,
  INTERACTION,
  OFFSCREEN_FRAMES,
  OFFSCREEN_START,
  OFFSCREEN_STOP,
  RECORDING_STATE,
  START_RECORDING,
  STOP_RECORDING,
  type Response,
} from './messages';
import { toSessionMs } from '../lib/time';

interface Recording {
  cdp: CdpSession;
  ctx: CaptureContext;
  events: TimelineEvent[];
  startedAt: Date;
  redactor: DefaultRedactor;
  /** The page title at record time — the only human-readable name available. */
  title: string;
  id: string;
  video: boolean;
  /**
   * Where the session began. Held separately because `ctx.pageUrl` is *current*
   * page context and navigation mutates it — reading it at stop time reported
   * the last URL as the first one.
   */
  startUrl: string;
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
      return start(msg.tabId, msg.pageUrl, msg.title, msg.video);
    case STOP_RECORDING:
      return stop();
    case INTERACTION:
      recordInteraction(msg);
      return { ok: true, recording: active !== null };
    case DROP_MARKER:
      return { ok: true, recording: dropMarker(msg.note || 'Marked') };
    default:
      return { error: `Unknown message: ${msg?.type}` };
  }
}

async function start(
  tabId?: number,
  pageUrl?: string,
  title?: string,
  wantVideo = true,
): Promise<Response> {
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
  const id = sessionId(startedAt, pageUrl ?? tab.url ?? '');

  // Capture starts before the clock does, because t0 belongs to
  // MediaRecorder.start() and nothing else. If video is unavailable the session
  // still runs — it just anchors on wall-clock instead.
  // Video absence is degraded-but-honest rather than ambiguous: session.json
  // declares `video: {enabled: false}`, so a reader cannot mistake it for
  // "nothing was on screen". But it is still reported back so the popup can say
  // so at record time, rather than the user finding out at the end.
  let captureError: string | null = null;
  const capture = !wantVideo
    ? null
    : await startCapture(tab.id, id).catch((e) => {
        captureError = String(e?.message ?? e);
        console.warn('[bugcast] capture unavailable', e);
        return null;
      });
  const redactor = new DefaultRedactor();
  const ctx: CaptureContext = {
    // Sampled inside MediaRecorder.start(), so every source in the artifact
    // shares one origin with the video. Falls back to wall-clock only when
    // there is no recorder to anchor to.
    t0: capture?.t0 ?? Date.now(),
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
  await injectInteractionCapture(tab.id);

  // Recording almost always starts on an already-loaded page, so
  // Page.frameNavigated never fires for it and the timeline would never say
  // where the session began. Found by the smoke test.
  events.push({ type: 'navigation', t: 0, pageUrl: ctx.pageUrl, trigger: 'load', from: null });

  cdp.detachedCallback = () => {
    // The user dismissed the infobar mid-session. The session is over either
    // way, so end it cleanly instead of collecting a half-recorded artifact.
    active = null;
  };

  active = {
    cdp,
    ctx,
    events,
    startedAt,
    redactor,
    title: title || tab.title || tab.url || 'Session',
    startUrl: ctx.pageUrl,
    id,
    video: Boolean(capture),
  };
  setBadge(true);
  return { ok: true, recording: true, captureError };
}

async function stop(): Promise<Response> {
  if (!active) return { ok: true, recording: false };
  const { cdp, events, startedAt, redactor, title, startUrl, id, video } = active;
  active = null;
  setBadge(false);
  await cdp.detach();
  await unregisterInteractionCapture();

  // Sorted once, at the end — the flat timeline is the contract, and sources
  // arrive interleaved and slightly out of order.
  events.sort((a, b) => a.t - b.t);

  const capture = (await stopCapture()) as { segments?: Segment[] } | null;

  // Speech joins the same flat array as everything else, then the whole thing
  // sorts once. The ordering is the information: narration lands *before* the
  // click it describes, because people narrate intent before acting.
  const segments = capture?.segments ?? [];
  if (segments.length) {
    events.push(...toSpeechEvents(segments, startUrl));
    events.sort((a, b) => a.t - b.t);
  }

  // Frames are planned only once the timeline is final, because the plan is a
  // function of the events — including the speech that only just arrived.
  let frames = { written: 0, missed: 0 };
  if (video) {
    const plan = planFrames(events);
    for (const frame of plan) for (const i of frame.events) events[i]!.frame = frame.path;
    frames = ((await extractFrames(id, plan)) as typeof frames) ?? frames;
  }
  await closeOffscreen();

  const redaction = redactor.summary();
  let written: string | null = null;
  let report = '';
  try {
    report = renderSessionReport(id, title, startedAt, startUrl, events, redaction);
    written = await writeSession(id, startedAt, startUrl, events, redaction, report, video, segments, frames.written);
  } catch (e) {
    // A failed write must not swallow the session — the caller still gets the
    // events, so a folder problem costs a save rather than the recording.
    console.error('[bugcast] could not write session', e);
  }

  return { ok: true, recording: false, events, redaction, sessionId: id, written, report, capture, frames };
}

function durationOf(events: TimelineEvent[]): number {
  return events.length ? Math.max(...events.map((e) => e.tEnd ?? e.t)) : 0;
}

function renderSessionReport(
  id: string,
  title: string,
  startedAt: Date,
  startUrl: string,
  events: TimelineEvent[],
  redaction: RedactionSummary,
): string {
  return renderReport(
    {
      id,
      title,
      startedAt,
      startUrl,
      durationMs: durationOf(events),
      userAgent: navigator.userAgent,
      redaction,
      files: [
        ['timeline.json', `${events.length} events — full detail, the source of truth`],
        ['session.json', 'manifest — capture config, environment, redaction summary'],
      ],
    },
    events,
  );
}

async function writeSession(
  id: string,
  startedAt: Date,
  startUrl: string,
  events: TimelineEvent[],
  redaction: unknown,
  report: string,
  video: boolean,
  segments: Segment[],
  frameCount: number,
): Promise<string> {
  const dir = await storedSessionDirectory();
  if (!dir) throw new Error('No sessions folder has been chosen.');

  const durationMs = durationOf(events);

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
          video: video
            ? { enabled: true, file: 'video.webm', frameRate: 15, codec: 'vp8/opus' }
            : { enabled: false },
          transcript: segments.length
            ? { enabled: true, file: 'transcript.srt', segments: segments.length }
            : { enabled: false },
          frames: frameCount
            ? { enabled: true, dir: 'frames/', count: frameCount, longEdge: 1280 }
            : { enabled: false },
        },
        redaction: {
          typedValues: 'off',
          summary: redaction,
          warnings: [
            'Redaction is best-effort heuristics, not a guarantee. Review before sharing.',
          ],
        },
        files: {
          timeline: 'timeline.json',
          report: 'report.md',
          ...(video ? { video: 'video.webm' } : {}),
          ...(segments.length ? { transcript: 'transcript.srt' } : {}),
          ...(frameCount ? { frames: 'frames/' } : {}),
        },
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

  await writeFile(dir, id, 'report.md', report);
  if (segments.length) await writeFile(dir, id, 'transcript.srt', toSrt(segments));

  return `${dir.name}/${id}`;
}

const CONTENT_SCRIPT_ID = 'bugcast-interactions';

/**
 * Two injections, because they cover different moments.
 *
 * `executeScript` reaches the page that is already open — but it cannot run at
 * `document_start` there, so on that first page a listener the page registered
 * during its own bootstrap could in principle win the capture phase. Rare, and
 * it costs clicks rather than the session.
 *
 * `registerContentScripts` covers everything the session navigates to
 * afterwards, at `document_start`, where registration order is ours.
 */
async function injectInteractionCapture(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
  } catch (e) {
    // A restricted page (chrome://, the Web Store) refuses injection. Network
    // and console still work, so this is a reduced session rather than none.
    console.warn('[bugcast] interaction capture unavailable on this page', e);
  }

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        js: ['content.js'],
        matches: ['<all_urls>'],
        runAt: 'document_start',
        allFrames: true,
        persistAcrossSessions: false,
      },
    ]);
  } catch (e) {
    // Needs host permission, which the popup requests per-origin. Without it
    // the current page is still captured; later navigations are not.
    console.warn('[bugcast] interaction capture will not survive navigation', e);
  }
}

async function unregisterInteractionCapture(): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(() => {});
}

/**
 * Content scripts report wall-clock, since they have no idea what t0 is. Both
 * sides are epoch-ms on the same machine, so the conversion is exact.
 */
function recordInteraction(msg: any): void {
  if (!active) return;
  // `type` must be destructured away too — otherwise ...rest carries the
  // message type and overwrites the event kind it is spread after.
  const { type: _messageType, kind, epochMs, startedAt, ...rest } = msg;
  const t = toSessionMs(epochMs, active.ctx.t0);
  active.events.push({
    type: kind,
    t: startedAt ? toSessionMs(startedAt, active.ctx.t0) : t,
    ...(startedAt ? { tEnd: t } : {}),
    pageUrl: active.ctx.pageUrl,
    ...rest,
  } as TimelineEvent);
  if (rest?.value?.redacted) active.redactor.countWithheldValue();
}

/**
 * The toolbar badge is the second recording indicator.
 *
 * chrome.debugger's infobar is the first, and it is not something to apologise
 * for — a tool capturing your microphone and your Authorization headers should
 * be impossible to forget about. The badge adds the piece the infobar cannot:
 * which extension, and a way back to Stop.
 */
function setBadge(recording: boolean): void {
  void chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  void chrome.action.setTitle({
    title: recording ? 'Bugcast — recording. Click to stop.' : 'Bugcast',
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'drop-marker') {
    dropMarker('Marked from the keyboard');
    return;
  }
  if (command !== 'toggle-recording') return;

  // Stop always works. Start needs a folder permission that only a click inside
  // an extension page can re-grant, so when it is not already granted the
  // honest move is to say so rather than half-start.
  if (active) void stop();
  else void start().then((res) => {
    if ('error' in res) void chrome.action.setBadgeText({ text: '!' });
  });
});

/**
 * Mark the moment.
 *
 * The hand-authored example exposed this gap: the narration carried "save is
 * just broken on this page", which a human reads and a query cannot. A marker
 * is that same claim, findable.
 */
function dropMarker(note: string): boolean {
  if (!active) return false;
  active.events.push({
    type: 'marker',
    t: toSessionMs(Date.now(), active.ctx.t0),
    pageUrl: active.ctx.pageUrl,
    note,
  });
  return true;
}

const OFFSCREEN_URL = 'offscreen.html';

/**
 * The offscreen document is created lazily and torn down after each session.
 *
 * Chrome allows exactly one per extension, and a stale one from a crashed
 * session would silently refuse the next `createDocument`.
 */
async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Recording tab video and microphone audio for a QA session.',
  });
}

async function startCapture(tabId: number, session: string): Promise<{ t0: number } | null> {
  await ensureOffscreen();

  // MV3 mints a stream id in the worker which the offscreen document then
  // redeems — `chrome.tabCapture.capture()` cannot run in a worker at all.
  // Promisified by hand: this one is still callback-typed, and the callback
  // form is where chrome.runtime.lastError actually surfaces — "Cannot capture
  // a tab without user gesture" arrives there rather than as a rejection.
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message ?? 'No media stream id'));
      else resolve(id);
    });
  });

  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: OFFSCREEN_START,
    streamId,
    sessionId: session,
    // Optional, default on. No speech simply means no .srt; it must never cost
    // the recording.
    withMic: true,
  });
  if (!res || res.error) throw new Error(res?.error ?? 'Capture failed to start');
  return { t0: res.t0 };
}

async function stopCapture(): Promise<unknown> {
  // Deliberately does NOT close the document — frame extraction still needs a
  // <video>, a canvas and requestVideoFrameCallback, none of which exist in a
  // service worker. closeOffscreen() runs once everything is out.
  return chrome.runtime
    .sendMessage({ target: 'offscreen', type: OFFSCREEN_STOP })
    .catch(() => null);
}

async function extractFrames(session: string, plan: unknown[]): Promise<unknown> {
  if (!plan.length) return { written: 0, missed: 0 };
  return chrome.runtime
    .sendMessage({ target: 'offscreen', type: OFFSCREEN_FRAMES, sessionId: session, plan })
    .catch(() => ({ written: 0, missed: plan.length }));
}

async function closeOffscreen(): Promise<void> {
  await chrome.offscreen.closeDocument().catch(() => {});
}
