# Bugcast

**Record a QA session. Get files you own.**

Press record, narrate what you're doing, and Bugcast captures the browser video,
transcribes your narration to SRT locally, and writes a correlated timeline of
everything that happened — page navigations, the elements you clicked, console
output, and failed network calls *with their response bodies* — all on one clock.

Then hand the folder to a coding agent.

```
2026-08-20T14-32-09_app-simplerdev-com/
  report.md          # deterministic rendering of the timeline — start here
  session.json       # manifest: capture config, environment, redaction summary
  timeline.json      # events, flat and time-ordered
  events.ndjson      # the same events, appended live as they happen
  speech.ndjson      # narration, appended live as it is recognised
  transcript.srt     # narration, timestamped against the video
  video.webm
  frames/            # a JPEG at each event boundary
```

**Everything runs locally.** No account, no upload, no telemetry. Core recording
makes zero network calls — the only network access at all is downloading the
Whisper model once, and there's an offline path for that too.

---

## ⚠️ Read this before you record

Bugcast writes real session data to disk, and you will hand it to something.

- **A session may contain secrets even with redaction on.** Redaction is
  best-effort heuristics, not a guarantee.
- **Handing a session folder to a hosted model uploads everything in it** —
  including the video, which cannot be redacted.
- **Video and frames capture whatever was on screen in that tab.** Password
  fields render as dots; an API key displayed in a settings page does not.
- **Don't record production with real customer data.**

By default, typed values are **not** captured — a field records that it changed
and roughly what shape the value had, never the characters. Authorization and
Cookie headers, and secrets in URL query strings, are stripped before anything
is written to disk.

## Install

Bugcast is not on the Chrome Web Store yet (submission is in progress — the
`chrome.debugger` permission gets a manual review). Until then:

1. Download the latest `bugcast.zip` from
   [Releases](https://github.com/SimplerDevelopment/bugcast/releases) and unzip it.
2. Go to `chrome://extensions`, turn on **Developer mode**, and click
   **Load unpacked**. Select the unzipped folder.
3. Click the Bugcast icon and press **Record**.
   *First run only: choose a folder for sessions, and pick a Whisper model tier.*
4. Do the thing. Press **Stop**. Your session folder is where you pointed it.

No terminal, no compiler, no sidecar process. That's deliberate — see
[the design notes](docs/design/issues/03-local-transcription-real-costs.md) for
why the obvious `whisper.cpp` approach doesn't work.

## Settings

Right-click the icon → **Options**, or the **Settings** link in the popup.

| | |
|---|---|
| **Recording** | Video on/off; transcribe-while-recording on/off (it costs CPU alongside the app you're testing) |
| **Microphone** | Which input device, and the one-time permission grant |
| **Transcription** | Model tier — bigger is more accurate and a larger one-time download |
| **Privacy** | Whether typed values are captured. Off by default. |
| **Sessions** | Where sessions are written |
| **Shortcuts** | What actually bound, and how to change it |

## Tell Bugcast about your app

Bugcast records what the *browser* can see. Your project knows things it can't —
which build this is, which route, which flags were on, what the store held when
it broke.

There is no SDK and nothing to install. Mark it with **standard User Timing**,
which your app can call whether or not Bugcast exists:

```js
// A fact about the session. Lands in session.json. Last write wins.
performance.mark('bugcast:session', {
  detail: { buildSha: import.meta.env.VITE_COMMIT, release: '1.4.2' },
});

// A thing that happened. Lands in the timeline, on the same clock as
// everything else, so it interleaves with the clicks and the failed request.
performance.mark('bugcast:checkout-step', { detail: { step: 3, cart: 2 } });

// A thing that took time. `performance.measure` carries duration.
performance.measure('bugcast:save', { start, end, detail: { postId } });
```

Anything prefixed `bugcast:` is collected; everything else on your performance
timeline is ignored. Mark at page load if you like — the observer replays
entries created before recording started, so a build SHA marked during bootstrap
is still captured when you press Record ten minutes later.

**What happens to what you attach.** It is bounded before it leaves the page
(depth 4, 64 keys or items, 1024 characters per string) and each limit leaves a
distinct marker so an agent reading it knows *which* budget was hit rather than
just that something is missing. Then it goes through the same redactor as
response bodies — an `apiKey` in an annotation is treated exactly like an
`apiKey` in a 500. Attaching your whole Redux store is not a good idea, but it
will not blow up the artifact if you do.

## Hand a session to a coding agent

Point it at `report.md` and you're done — that's the whole handoff, and it needs
nothing installed.

For longer sessions — where the raw timeline runs to tens of thousands of tokens
— there's an optional read-only MCP server, registered once for every project
you ever open. **It isn't on npm yet**, so point it at a clone:

```bash
git clone https://github.com/SimplerDevelopment/bugcast
cd bugcast/mcp && npm install          # one dependency, no build step
claude mcp add --scope user bugcast -- node "$PWD/src/index.mjs"
```

Once it's published this collapses back to `npx -y bugcast`.

Point the extension at `~/bugcast-sessions` and no path configuration is needed
at either end.

It can also read a session **while you are still recording it**, so an agent
follows along live rather than waiting for you to finish:

```
session_tail({ sessionId: "latest" })                    -> events
session_tail({ sessionId: "latest", stream: "speech" })  -> narration
```

**The follow-loop is the live pattern.** Pass `waitMs` and the call blocks until
something actually happens instead of returning empty, so an agent spends one
call per burst of activity rather than one per interval:

```
session_tail({ sessionId: "latest", cursor, waitMs: 100000 })
```

The wait is `fs.watch`-driven, so it costs nothing while nothing is happening.
Up to 30s is safe from anywhere. Above that — the ceiling is 110s — is for a
loop running in the **main conversation**, where Claude Code turns a call still
running at two minutes into a background task and carries on. A subagent or a
headless run gets no such rescue and will simply block for the full wait, so
keep those at 30s.

Events and narration are **separate outputs**. Both carry `t` in milliseconds
from the same origin, so merging on it is exact — and worth doing, because
narration lands *before* the action it describes. `report.md` merges them for
you.

See [`mcp/`](mcp/) for the tools. Strictly optional — recording never depends on
it, and `report.md` alone is a complete handoff.

## Status

**Working.** Record a session and you get a folder: `report.md`, `timeline.json`,
`transcript.srt`, `video.webm`, and `frames/`. Every architectural decision is
resolved and written down in [`docs/design/`](docs/design/).

Not yet done: a Chrome Web Store listing (submission pending — the
`chrome.debugger` permission gets a manual review), and three things that need a
human rather than a script to verify — see [`AGENTS.md`](AGENTS.md).

## Why the design notes are in the repo

[`docs/design/`](docs/design/) holds the full decision record — a map plus
fifteen resolved tickets. Not a tidied-up architecture doc: the actual
reasoning, including **the alternatives that were rejected and the ones that
turned out wrong.**

`whisper.cpp` as a local sidecar, killed once we confirmed it
[ships no macOS CLI binary, ever](docs/design/issues/03-local-transcription-real-costs.md).
MAIN-world script injection, [dropped because it bought nothing](docs/design/issues/06-capture-mechanism-decision.md).
A frames-only artifact with no video, which would have missed
[every bug that happens between events](docs/design/issues/08-does-the-video-survive.md).

Most projects can't answer "why is it built this way" a year later. This one can.

## License

MIT

## Development

```bash
cd extension
bun install
bun run build      # writes dist/, loadable via chrome://extensions
bun run test       # unit tests
bun run typecheck
bun run smoke      # end-to-end: launches Chromium with the extension loaded
```

`bun run smoke` needs Playwright's Chromium once: `bunx playwright install chromium`.
It records a real session against a local server that returns a 500 with a body,
a binary error, a CORS-blocked request and a URL carrying a token — then prints
the timeline and the redaction summary. It is the only thing that can tell you
whether the debugger actually attaches and whether eager body capture works.
