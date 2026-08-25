# Bugcast

**Record a QA session. Get files you own.**

Press record, narrate what you're doing, and Bugcast captures the browser video,
transcribes your narration to SRT, and writes a correlated timeline of
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

**Everything runs locally by default.** No account, no telemetry. Core recording
makes zero network calls — the only network access at all is downloading the
Whisper model once, and there's an offline path for that too.

The single exception is opt-in and off unless you turn it on: supplying an
OpenAI API key in Settings sends session **audio** to OpenAI for transcription,
because the local model is not accurate enough on names and ticket ids to trust
for filing tickets. Everything else — video, events, timeline, artifacts — stays
on disk either way, and clearing the key restores fully-local behaviour.

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
- **Hosted transcription sends your narration to OpenAI** if you configure a
  key. Whatever you say out loud while recording — including a customer name you
  read off the screen — goes with it. Leave the key empty to keep audio local.

By default, typed values are **not** captured — a field records that it changed
and roughly what shape the value had, never the characters. Authorization and
Cookie headers, and secrets in URL query strings, are stripped before anything
is written to disk.

## Install

Not on the Chrome Web Store yet — the `chrome.debugger` permission gets a manual
review and that submission is pending. There are no release builds either, so
today you build it. It needs [bun](https://bun.sh) and nothing else:

```bash
git clone https://github.com/SimplerDevelopment/bugcast
cd bugcast/extension
bun install
bun run build          # writes dist/
```

1. Go to `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and select `bugcast/extension/dist`.
2. Click the Bugcast icon and press **Record**. Chrome asks once for a folder to
   write sessions into. **Choose `~/bugcast-sessions`.** The MCP server reads
   that path by default, so picking it here is the entire configuration at both
   ends — see [below](#use-it-from-your-agents-in-any-project).
3. Grant the microphone once, in **Options → Microphone**. Narration is
   transcribed from the mic and nothing else, so without the grant there is no
   transcript at all — and the recorder runs in an offscreen document with no
   UI, which means it can never prompt you for it mid-session.
4. Do the thing. **⌘⇧U** starts and stops, **⌘⇧E** marks the moment you would
   call the bug — `Ctrl` for those on Windows and Linux. That mark is the
   strongest signal in the artifact and the one an agent is told to start from,
   so use it. Press Stop and the folder is written.

   Chrome silently drops a suggested shortcut another extension already claimed,
   so if a key does nothing, **Options → Shortcuts** shows what actually bound.

No sidecar process and no per-platform binary — that part is deliberate, see
[the design notes](docs/design/issues/03-local-transcription-real-costs.md) for
why the obvious `whisper.cpp` approach doesn't work.

### The first recording downloads a model

This section applies to local transcription — the default. With a hosted key
configured there is no download and none of the blocking below applies.

Transcription is local, so the first session has to fetch the Whisper weights
(`base.en` by default) before it can produce a single word. Until that lands:

- `speech.ndjson` stays empty, and
- **Stop blocks.** The authoritative transcript pass waits on the same download,
  so the folder holds only `events.ndjson` and `video.webm` — no `report.md`,
  no `session.json` — until it finishes.

Nothing is broken; it is a one-time download in the critical path. The popup
shows *"Downloading the speech model — N%"*, but the popup closes the moment you
click the page you are testing, so the reliable place to watch it is
`chrome://extensions` → Bugcast → **Inspect views: `offscreen.html`**.

Cached after that, per tier. Changing tier in Options downloads the new one on
your next recording. Do a throwaway ten-second session first and let it warm.

## Settings

Right-click the icon → **Options**, or the **Settings** link in the popup.

| | |
|---|---|
| **Recording** | Video on/off; transcribe-while-recording on/off (it costs CPU alongside the app you're testing) |
| **Microphone** | Which input device, and the one-time permission grant |
| **Transcription** | An optional OpenAI API key, and the local model tier used when there is none. The key is far more accurate on names and ticket ids and avoids the repetition loops the local model falls into — at the cost of sending audio to OpenAI, billed to your account. Stored on this device, never bundled. |
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

## Use it from your agents, in any project

Point an agent at `report.md` and you're done — that's the whole handoff, it
needs nothing installed, and it works with any tool that can read a file.

For longer sessions — where the raw timeline runs to tens of thousands of tokens
— there's an optional read-only MCP server. Register it **once** and it is there
in every project you ever open. **It isn't on npm yet**, so point it at the
clone you already made:

```bash
cd bugcast/mcp && npm install          # one dependency, no build step
claude mcp add --scope user bugcast -- node "$PWD/src/index.mjs"
```

`--scope user` is the whole trick: one registration, every repo, nothing to add
per-project and no config file to copy around. Once it's published this
collapses to `npx -y bugcast`.

If you pointed the extension at `~/bugcast-sessions` there is no path to
configure at either end — that is the directory the server reads by default.
Somewhere else is fine: append `--dir /path/to/sessions`, or set `BUGCAST_DIR`.

| Tool | |
|---|---|
| `sessions_list` | Recent sessions, newest first. One still recording is marked `live`. |
| `session_tail` | Events since a cursor. **Works during recording.** `stream: "speech"` follows narration instead. |
| `session_report` | The rendering of a finished session. Start a post-mortem here. |
| `session_query` | A filtered slice of a finished timeline. `failedOnly: true` answers "what went wrong". |
| `session_frame` | The JPEG nearest a moment, for seeing what the page actually showed. |
| `session_resolve` | A minified stack turned into real files and lines, using the source maps already in your checkout. |

Then, in whatever project the bug lives in, just ask:

> Read the latest bugcast session and tell me what broke.

It calls `sessions_list`, then `session_report`, and takes it from there. A
session is only visible to `sessions_list` once it has been stopped and written
— a recording still in flight has no `session.json` yet, which is what `live`
means and why the tail below exists.

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

So the live version of the ask is just:

> I'm recording a bugcast session right now. Follow it with `session_tail` and
> tell me the moment something fails.

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
