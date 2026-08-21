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
import { runChecks, type Check } from '../lib/self-test';
import type { RedactionSummary } from '../lib/redact';
import {
  DROP_MARKER,
  LIVE_SPEECH,
  OFFSCREEN_SELF_TEST,
  RUN_SELF_TEST,
  INTERACTION,
  OFFSCREEN_FLUSH_VIDEO,
  OFFSCREEN_FRAMES,
  OFFSCREEN_START,
  OFFSCREEN_STOP,
  OFFSCREEN_ZIP,
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
  /** Open for the whole session; events.ndjson is appended to as it goes. */
  stream: FileSystemWritableFileStream | null;
  /** Batched rather than written per event — see below. */
  pending: string[];
  writes: Promise<void>;
  flushTimer: number;
  /**
   * Where the session began. Held separately because `ctx.pageUrl` is *current*
   * page context and navigation mutates it — reading it at stop time reported
   * the last URL as the first one.
   */
  startUrl: string;
}

let active: Recording | null = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // sendMessage broadcasts to every extension context, so a message addressed
  // to the offscreen document arrives here too. The worker never sees its own
  // sends, which hides this in normal operation — but anything else in the
  // extension talking to the recorder would race, and the worker would win with
  // "Unknown message".
  if (msg?.target === 'offscreen') return;
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
    case RUN_SELF_TEST:
      return { ok: true, recording: active !== null, checks: await selfTest(msg.only) } as never;
    case LIVE_SPEECH:
      recordLiveSpeech(msg.segments);
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
  /** Appended to `events` and queued for the live stream in one place. */
  const record = (event: TimelineEvent): void => {
    events.push(event);
    if (active) active.pending.push(JSON.stringify(event));
  };
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
    emit: record,
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
  record({ type: 'navigation', t: 0, pageUrl: ctx.pageUrl, trigger: 'load', from: null });

  cdp.detachedCallback = () => {
    // The user dismissed the debugger infobar, or the tab closed. The session
    // is over either way — but it must be *stopped*, not dropped: discarding
    // `active` threw away everything recorded up to that point, which is the
    // worst thing this tool can do and it was the default.
    if (active) void stop();
  };

  const stream = await openEventStream(id).catch((e) => {
    console.warn('[bugcast] live event stream unavailable', e);
    return null;
  });

  active = {
    cdp,
    ctx,
    events,
    stream,
    pending: [],
    writes: Promise.resolve(),
    // Batched every couple of seconds rather than written per event. Not a
    // micro-optimisation: the File System Access grant lapsing has been the
    // largest real source of failure here, and per-event writes would multiply
    // operations against exactly that permission by orders of magnitude. Two
    // seconds is nothing against the cadence of someone narrating.
    flushTimer: setInterval(() => flushEvents(), FLUSH_MS) as unknown as number,
    startedAt,
    redactor,
    title: title || tab.title || tab.url || 'Session',
    startUrl: ctx.pageUrl,
    id,
    video: Boolean(capture),
  };
  setBadge(true);
  await chrome.storage.local.set({ recording: true });
  return {
    ok: true,
    recording: true,
    captureError,
    // Surfaced at record time, not discovered at the end. An offscreen document
    // cannot prompt for the microphone, so without an existing grant there is
    // simply never a transcript — and finding that out after narrating for ten
    // minutes is the worst possible moment.
    micError: capture ? capture.micError : null,
  };
}

async function stop(): Promise<Response> {
  if (!active) return { ok: true, recording: false };
  const { cdp, events, startedAt, redactor, title, startUrl, id, video } = active;
  await chrome.storage.local.set({ recording: false });
  clearInterval(active.flushTimer);
  const stream = active.stream;
  const finalFlush = flushEvents();
  active = null;
  setBadge(false);
  await finalFlush;
  await stream?.close().catch(() => {});
  await cdp.detach();
  await unregisterInteractionCapture();

  // Sorted once, at the end — the flat timeline is the contract, and sources
  // arrive interleaved and slightly out of order.
  events.sort((a, b) => a.t - b.t);

  const capture = (await stopCapture()) as
    | { segments?: Segment[]; videoBuffered?: boolean; bytes?: number }
    | null;

  // The recording could not be streamed to disk — usually a File System Access
  // grant that lapsed between choosing the folder and pressing Record. Flush it
  // now, before frames, which read the file back.
  let videoOnDisk = video;
  if (capture?.videoBuffered) {
    const flushed = (await flushVideo(id)) as { ok?: boolean; error?: string } | null;
    videoOnDisk = Boolean(flushed?.ok);
    if (!flushed?.ok) {
      console.warn('[bugcast] buffered video could not be written', flushed?.error);
    }
  }

  // Speech joins the same flat array as everything else, then the whole thing
  // sorts once. The ordering is the information: narration lands *before* the
  // click it describes, because people narrate intent before acting.
  const segments = capture?.segments ?? [];
  if (segments.length) {
    // The authoritative pass supersedes every provisional line. events.ndjson
    // keeps both — it is an append-only log of what was known when — while
    // timeline.json carries only the final text.
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'speech' && e.provisional) events.splice(i, 1);
    }
    events.push(...toSpeechEvents(segments, startUrl));
    events.sort((a, b) => a.t - b.t);
  }

  // Frames are planned only once the timeline is final, because the plan is a
  // function of the events — including the speech that only just arrived.
  // Frames are read back out of video.webm, so they need it to be on disk —
  // which in the zip fallback it never is. No folder means no frame index.
  const hasFolder = Boolean(await storedSessionDirectory());
  let frames = { written: 0, missed: 0 };
  if (videoOnDisk && hasFolder) {
    const plan = planFrames(events);
    for (const frame of plan) for (const i of frame.events) events[i]!.frame = frame.path;
    frames = ((await extractFrames(id, plan)) as typeof frames) ?? frames;
  }

  const redaction = redactor.summary();
  let written: string | null = null;
  let writeError: string | null = null;
  let report = '';
  try {
    report = renderSessionReport(id, title, startedAt, startUrl, events, redaction);
    const files = sessionFiles(id, startedAt, startUrl, events, redaction, report, videoOnDisk, segments, frames.written);
    if (hasFolder) {
      try {
        written = await writeSession(id, files);
      } catch (e) {
        // The folder write can fail for reasons the user cannot act on mid-flow
        // — most often a lapsed File System Access grant, which does not
        // outlive the context that obtained it. Losing a recorded session to
        // that is the worst outcome available, so fall through to the zip
        // rather than throwing away work that already exists.
        console.warn('[bugcast] folder write failed, falling back to a zip', e);
        writeError = `Saved as a zip instead — the folder write failed: ${(e as Error)?.message}`;
        written = await zipSession(id, files);
      }
    } else {
      written = await zipSession(id, files);
    }
  } catch (e) {
    // A failed write must not swallow the session — the caller still gets the
    // events, so a folder problem costs a save rather than the recording.
    // Surfaced, not just logged: a session that recorded fine and then failed
    // to save is exactly the case where the user needs to know why, right now,
    // while the state that caused it still exists.
    writeError = String((e as Error)?.message ?? e);
    console.error('[bugcast] could not write session', e);
  } finally {
    // Closed only once everything is out. The zip path reads the buffered
    // recording from this document's memory, so closing it earlier would
    // silently drop the video from the artifact.
    await closeOffscreen();
  }

  // Persisted, not just returned. The popup closes the moment you click away,
  // so a result that only exists in its state is a result the user may never
  // see — which is how a failed write ends up looking like nothing happened.
  await chrome.storage.local.set({
    lastSession: {
      id,
      written,
      writeError,
      events: events.length,
      frames: frames.written,
      at: Date.now(),
    },
  });

  // Persisted, not just returned. The popup closes the moment you click away,
  // so a result that lives only in its state is one the user may never see —
  // which is how a failed write ends up looking like nothing happened at all.
  await chrome.storage.local.set({
    lastSession: {
      id,
      written,
      writeError,
      events: events.length,
      frames: frames.written,
      // Reported explicitly, because "everything except the video" was
      // impossible to diagnose from the folder alone.
      video: videoOnDisk,
      videoBytes: capture?.bytes ?? 0,
    },
  });

  return { ok: true, recording: false, events, redaction, sessionId: id, written, writeError, report, capture, frames };
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

/** Every text file a session folder contains, as [name, contents]. */
function sessionFiles(
  id: string,
  startedAt: Date,
  startUrl: string,
  events: TimelineEvent[],
  redaction: unknown,
  report: string,
  video: boolean,
  segments: Segment[],
  frameCount: number,
): Array<[string, string]> {
  const durationMs = durationOf(events);

  // Both files carry schemaVersion so either is interpretable alone — which is
  // how an agent will actually read them. Additive changes do not bump it;
  // consumers ignore unknown fields.
  const manifest = JSON.stringify(
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
  );

  return [
    ['session.json', manifest],
    [
      'timeline.json',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, sessionId: id, t0Epoch: startedAt.getTime(), events }, null, 2),
    ],
    ['report.md', report],
    ...(segments.length ? ([['transcript.srt', toSrt(segments)]] as Array<[string, string]>) : []),
  ];
}

async function writeSession(id: string, files: Array<[string, string]>): Promise<string> {
  const dir = await storedSessionDirectory();
  if (!dir) throw new Error('No sessions folder has been chosen.');
  for (const [name, contents] of files) await writeFile(dir, id, name, contents);
  return `${dir.name}/${id}`;
}

/**
 * Degraded path, for when File System Access is unavailable — which is an
 * enterprise-policy situation, not user error. Documented as degraded because
 * it cannot stream and so re-inherits the memory ceiling FSA was chosen to
 * escape.
 */
async function zipSession(id: string, files: Array<[string, string]>): Promise<string> {
  // Idempotent, so this cannot discard a document already holding the buffered
  // recording — but it is needed when video was off or capture never started,
  // in which case no document exists yet.
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: OFFSCREEN_ZIP,
    sessionId: id,
    files,
  });
  if (!res?.ok) throw new Error(res?.error ?? 'Could not write the session anywhere');
  return `Downloads/bugcast/${id}.zip`;
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
 * Provisional narration from a rolling window.
 *
 * Flagged rather than quietly replaced later, because a consumer reading the
 * stream should be able to tell approximate text from final text. The
 * authoritative pass at stop drops these and re-derives from the whole audio;
 * it never reads them, so a bad window cannot reach the artifact on disk.
 */
function recordLiveSpeech(segments: Segment[] | undefined): void {
  if (!active || !segments?.length) return;
  for (const event of toSpeechEvents(segments, active.ctx.pageUrl)) {
    active.events.push({ ...event, provisional: true });
    active.pending.push(JSON.stringify({ ...event, provisional: true }));
  }
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
 * Keep the service worker alive across a long offscreen operation.
 *
 * MV3 terminates an idle worker after about 30 seconds, and awaiting a
 * `sendMessage` response does not reliably count as activity. When the worker
 * dies the channel dies with it, and the caller sees "A listener indicated an
 * asynchronous response by returning true, but the message channel closed
 * before a response was received" — which describes the symptom and names
 * nothing.
 *
 * It matters most for the two operations that legitimately take minutes: the
 * first model download, and transcribing a long session at stop. Losing a
 * transcript to a worker timeout would be indistinguishable from a bug in the
 * transcription itself.
 *
 * Any extension API call resets the idle timer; getPlatformInfo is the cheapest
 * one with no side effects.
 */
async function whileAlive<T>(work: () => Promise<T>): Promise<T> {
  const ping = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  try {
    return await work();
  } finally {
    clearInterval(ping);
  }
}

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

/** Read here, because the offscreen document has no chrome.storage. */
async function storedTier(): Promise<string> {
  const stored = await chrome.storage.local.get('modelTier');
  return (stored?.modelTier as string) ?? 'base.en';
}

async function startCapture(
  tabId: number,
  session: string,
): Promise<{
  t0: number;
  withMic: boolean;
  micError: string | null;
  streamError: string | null;
} | null> {
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
    tier: await storedTier(),
  });
  if (!res || res.error) throw new Error(res?.error ?? 'Capture failed to start');
  return {
    t0: res.t0,
    withMic: Boolean(res.withMic),
    micError: res.micError ?? null,
    streamError: res.streamError ?? null,
  };
}

async function stopCapture(): Promise<unknown> {
  // Deliberately does NOT close the document — frame extraction still needs a
  // <video>, a canvas and requestVideoFrameCallback, none of which exist in a
  // service worker. closeOffscreen() runs once everything is out.
  //
  // Wrapped, because this is where transcription happens: on a long session it
  // is minutes of work behind a single message.
  return whileAlive(() =>
    chrome.runtime.sendMessage({ target: 'offscreen', type: OFFSCREEN_STOP }).catch(() => null),
  );
}

async function flushVideo(session: string): Promise<unknown> {
  return whileAlive(() =>
    chrome.runtime
      .sendMessage({ target: 'offscreen', type: OFFSCREEN_FLUSH_VIDEO, sessionId: session })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
  );
}

async function extractFrames(session: string, plan: unknown[]): Promise<unknown> {
  if (!plan.length) return { written: 0, missed: 0 };
  return whileAlive(() =>
    chrome.runtime
      .sendMessage({ target: 'offscreen', type: OFFSCREEN_FRAMES, sessionId: session, plan })
      .catch(() => ({ written: 0, missed: plan.length })),
  );
}

async function closeOffscreen(): Promise<void> {
  await chrome.offscreen.closeDocument().catch(() => {});
}

/**
 * Four checks, one per subsystem that can fail quietly.
 *
 * Ordered cheapest-first so a user waiting on the model download has already
 * seen the other three resolve.
 */
async function selfTest(only?: string[]): Promise<unknown> {
  const checks: Check[] = [
    {
      id: 'cdp',
      label: 'Debugger',
      run: async () => {
        // Its own throwaway tab, not the user's: attaching to whatever they had
        // open would flash an infobar across their work for no reason.
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        try {
          const session = new CdpSession();
          await session.attach(tab.id!);
          await session.detach();
          return 'attached and detached cleanly';
        } finally {
          await chrome.tabs.remove(tab.id!).catch(() => {});
        }
      },
    },
    {
      id: 'disk',
      label: 'Sessions folder',
      run: async () => {
        const dir = await storedSessionDirectory();
        if (!dir) throw new Error('No folder chosen yet');
        if ((await (dir as any).queryPermission({ mode: 'readwrite' })) !== 'granted') {
          throw new Error('No write permission — open the popup and press Record once');
        }
        // Written and read back, because a handle that reports "granted" can
        // still fail on a disconnected volume.
        const probe = `bugcast self-test ${Date.now()}`;
        await writeFile(dir, '.bugcast-self-test', 'probe.txt', probe);
        const folder = await dir.getDirectoryHandle('.bugcast-self-test');
        const text = await (await folder.getFileHandle('probe.txt')).getFile().then((f) => f.text());
        await dir.removeEntry('.bugcast-self-test', { recursive: true }).catch(() => {});
        if (text !== probe) throw new Error('Wrote a probe file but read back different contents');
        return `wrote and read back in ${dir.name}`;
      },
    },
    {
      id: 'capture',
      label: 'Tab capture',
      run: () => offscreenCheck('capture'),
    },
    {
      id: 'mic',
      label: 'Microphone',
      // Checked from the offscreen document, not the popup, because that is
      // where recording actually asks — and it is the context that cannot
      // prompt. A grant that exists for the popup but not here would pass a
      // check and still produce no transcript.
      run: () => offscreenCheck('mic'),
    },
    {
      id: 'asr',
      label: 'Speech model',
      run: () => offscreenCheck('asr'),
    },
  ];

  // `only` exists for CI: the speech check downloads a model, which is the
  // point of it and also several minutes nobody wants on every push.
  const results = await runChecks(only ? checks.filter((c) => only.includes(c.id)) : checks);
  await closeOffscreen();
  return results;
}

async function offscreenCheck(which: 'capture' | 'mic' | 'asr'): Promise<string> {
  await ensureOffscreen();
  const tier = await storedTier();
  const res = await whileAlive(() =>
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: OFFSCREEN_SELF_TEST,
      check: which,
      tier,
    }),
  );
  if (!res || res.error) throw new Error(res?.error ?? 'No response from the recorder');
  return res.detail as string;
}

/** How often queued events reach disk. */
const FLUSH_MS = 2_000;

async function openEventStream(session: string): Promise<FileSystemWritableFileStream | null> {
  const dir = await storedSessionDirectory();
  if (!dir) return null;
  const folder = await dir.getDirectoryHandle(session, { create: true });
  const file = await folder.getFileHandle('events.ndjson', { create: true });
  // One writable held open for the session. Its position advances with each
  // write, so successive batches append rather than overwrite.
  return file.createWritable();
}

/**
 * Append whatever has accumulated.
 *
 * Serialised through a promise chain for the same reason the video chunks are:
 * concurrent writes on one writable interleave, and a close that races them
 * truncates the file.
 */
function flushEvents(): Promise<void> {
  const session = active;
  if (!session?.stream || !session.pending.length) return session?.writes ?? Promise.resolve();

  const batch = session.pending.join('\n') + '\n';
  session.pending = [];
  session.writes = session.writes.then(() =>
    session.stream!.write(batch).catch((e) => console.warn('[bugcast] event flush failed', e)),
  );
  return session.writes;
}
