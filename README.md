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
  timeline.json      # flat, time-ordered, discriminated union — the source of truth
  transcript.srt     # your narration, timestamped
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

## Status

**Design complete, implementation starting.** Every architectural decision is
resolved and written down; the capture pipeline is being built now.

## Why the design notes are in the repo

[`docs/design/`](docs/design/) holds the full decision record — a map plus
thirteen resolved tickets. Not a tidied-up architecture doc: the actual
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
