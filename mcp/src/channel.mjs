/**
 * Push notable session events into a running Claude Code session.
 *
 * Claude Code channels let an MCP server wake a session without the user typing
 * anything — the counterpart to `session_tail`, which the agent has to ask for.
 * Registered with:
 *
 *   claude --dangerously-load-development-channels bugcast
 *
 * (`--channels` once a server is on the approved allowlist; both flags are
 * hidden from --help.)
 *
 * **This filters hard, on purpose.** A recording produces hundreds of events —
 * every click, every request, every navigation — and waking an agent for each
 * would be worse than useless: Claude is turn-based, so a flood queues up and
 * arrives as one indigestible batch on its next turn. What goes through is only
 * what someone would interrupt you for.
 */

import path from 'node:path';
import { isLive, listSessionIds, tailEvents, waitForChange } from './sessions.mjs';

/**
 * How long to sit on the watcher before re-reading anyway.
 *
 * Not a poll interval — the watch below is what actually wakes this. It is the
 * backstop for the two things `fs.watch` will not tell you: a *different*
 * session starting while we are watching this one's folder, and a network
 * filesystem where the watch silently never fires.
 */
const POLL_MS = 2_000;

/**
 * Worth waking an agent for.
 *
 * Deliberately excludes successful requests, ordinary logs, clicks and
 * navigations — an agent that wants those calls `session_tail`. And excludes
 * provisional speech, which changes under you: only a marker or the final
 * transcript is worth an interrupt.
 */
export function isNotable(event) {
  switch (event.type) {
    case 'marker':
      return true;
    case 'exception':
      return true;
    case 'console':
      return event.level === 'error';
    case 'network':
      return event.failure ? !event.failure.canceled : (event.status ?? 0) >= 400;
    default:
      return false;
  }
}

const stamp = (t) => {
  const ms = Math.max(0, Math.round(t));
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(
    Math.floor((ms % 60000) / 1000),
  ).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

/** One line an agent can act on, not a JSON dump it has to parse. */
export function describe(event) {
  const at = stamp(event.t);
  switch (event.type) {
    case 'marker':
      return `[${at}] MARKED BY THE TESTER: ${event.note}`;
    case 'exception':
      return `[${at}] Uncaught exception: ${event.text}`;
    case 'console':
      return `[${at}] Console error: ${event.text}`;
    case 'network': {
      const outcome = event.status ?? event.failure?.errorText ?? 'failed';
      const body = event.response?.body ? `\n  body: ${event.response.body.slice(0, 400)}` : '';
      return `[${at}] ${event.method} ${event.url} -> ${outcome}${body}`;
    }
    default:
      return `[${at}] ${event.type}`;
  }
}

/**
 * Follow the newest live session and push what matters.
 *
 * Returns a stop function. Failures are swallowed: a channel that throws would
 * take down a server whose actual job — answering tool calls — is unaffected by
 * anything going wrong here.
 */
export function startChannel(server, root, { pollMs = POLL_MS } = {}) {
  let following = null;
  let cursor = 0;
  let stopped = false;
  let warnedAboutPush = false;

  const push = async (content, meta) => {
    try {
      await server.notification({
        method: 'notifications/claude/channel',
        params: { content, meta },
      });
    } catch (error) {
      // Still not a reason to stop serving tools — but not a reason to say
      // nothing either. Swallowed entirely, an unregistered channel is
      // indistinguishable from a recording that produced nothing worth
      // reporting: both are silence, and the silence reads as lag. Once, on
      // stderr, because stdout is the transport.
      if (!warnedAboutPush) {
        warnedAboutPush = true;
        console.error(
          `[bugcast] channel push failed: ${error?.message ?? error}\n` +
            '[bugcast] nothing will be pushed to this client. If that is not intended, relaunch\n' +
            '[bugcast] with: claude --dangerously-load-development-channels bugcast',
        );
      }
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const [newest] = await listSessionIds(root);
      if (!newest) return;

      if (newest !== following) {
        if (!(await isLive(root, newest))) return; // a finished session is not news
        following = newest;
        cursor = 0;
        await push(`Recording started: ${newest}`, { type: 'session_started', sessionId: newest });
      }

      const out = await tailEvents(root, following, cursor, 500);
      cursor = out.cursor;

      const notable = out.events.filter(isNotable);
      if (notable.length) {
        // Batched into one notification: five separate wakes for five errors in
        // the same second is five turns spent on one problem.
        await push(notable.map(describe).join('\n'), {
          type: 'session_events',
          sessionId: following,
          count: notable.length,
        });
      }

      if (!out.live) {
        await push(
          `Recording finished: ${following}. The full artifact is on disk — call session_report for the summary.`,
          { type: 'session_finished', sessionId: following },
        );
        following = null;
        cursor = 0;
      }
    } catch {
      // Transient: a directory mid-creation, a partial flush. Next tick retries.
    }
  };

  // Watch, do not poll. The read itself is cheap, but a fixed interval put up
  // to `pollMs` of latency in front of every event for nothing — and an error
  // the tester is watching for is exactly the moment that lag is felt. The
  // watcher already exists; `session_tail` waits on the same one.
  void (async () => {
    while (!stopped) {
      await tick();
      if (stopped) return;
      // `following` is null between sessions, and `path.join(root, '.')` is
      // `root` — so the idle case watches the folder a new session appears in.
      await waitForChange(root, following ?? '.', pollMs, { unref: true });
    }
  })();

  return () => {
    stopped = true;
  };
}

export const sessionsRoot = (root) => path.resolve(root);
