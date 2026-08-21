# bugcast (MCP server)

Read [bugcast](https://github.com/SimplerDevelopment/bugcast) QA sessions from a
coding agent — including **while they are still being recorded**.

## Setup, once, for every project

```bash
claude mcp add --scope user bugcast -- npx -y bugcast
```

`--scope user` is the point: registered once, available in every project you
open, with nothing to add per-repo.

No `--dir` needed if you point the extension at **`~/bugcast-sessions`**, which
is what this server reads by default. The path cannot be discovered
automatically — the File System Access API never exposes an absolute path, so
the extension does not know it either — so the two ends agree by convention
instead. Somewhere else is fine: `npx -y bugcast --dir /path/to/sessions`, or set
`BUGCAST_DIR`.

The directory is created if it does not exist. An empty one is a correct answer
to "what sessions exist", not a reason to fail on the first run.

## Tools

| Tool | |
|---|---|
| `sessions_list` | Recent sessions, newest first. A session still recording is marked `live`. |
| `session_tail` | Events since a cursor, **works during recording**. `stream: "speech"` follows narration instead. |
| `session_report` | The human-readable rendering of a finished session. Start here for a post-mortem. |
| `session_query` | A filtered slice of a finished timeline. `failedOnly: true` answers "what went wrong". |
| `session_frame` | The JPEG nearest a moment, for seeing what the page showed. |
| `session_resolve` | Turn a minified stack into real files and lines, using the source maps already in your checkout. |

## Following a live session

```
session_tail({ sessionId: "latest", waitMs: 30000 })
  -> { events, cursor, live: true }
session_tail({ sessionId: "latest", cursor, waitMs: 30000 })
  -> returns the moment something happens, or empty at the deadline
```

Events and narration are separate streams. Both carry `t` in milliseconds from
the same origin — `t0` at `MediaRecorder.start()`, with speech offsets taken from
the audio sample position rather than from when transcription finished — so
merging on `t` is exact. Worth doing: narration lands *before* the action it
describes, because people narrate intent before acting.

**Use `waitMs` instead of a polling loop.** The call blocks until events arrive
past your cursor, watching the file rather than re-checking it, so you make one
call per burst of activity instead of one per interval. Polling's real cost is
not latency — it is that every empty check leaves a tool call and its result in
the agent's context.

Up to 30s is safe from anywhere. Above that — the ceiling is 110s — is for a
loop in the **main conversation**, where Claude Code turns a call still running
at two minutes into a background task and carries on. A subagent or a headless
run gets no such rescue and blocks for the whole wait, so keep those at 30s. A
finished session returns immediately; there is nothing more to wait for.

Speech events flagged `provisional: true` come from a rolling ~10s window during
recording. They are **replaced** by the authoritative full-audio transcript when
the session stops — approximate now, correct later, and labelled so you can tell
which you are reading.

Timestamps are how you reach the video. Every `t` is milliseconds from `t0`,
which is sampled inside `MediaRecorder.start()`, so event time *is* video time:
say "watch from 02:14.320", or ask `session_frame` for that moment. Nothing
needs to decode the recording.

## Being told instead of asking (experimental)

Claude Code can register this server as a **channel**, so a recording pushes into
a running session and the agent reacts without you typing anything:

```bash
claude --dangerously-load-development-channels bugcast
```

**Start with `session_tail` above, not this.** The flag is not decoration and it
is not a formality we expect to drop: `--channels` accepts only plugins on an
allowlist Anthropic curates, and the two documented ways onto it are a partner
listing, which a repo cannot ship, and a Team/Enterprise `allowedChannelPlugins`
setting that *replaces* the default list rather than extending it and names a
plugin plus a marketplace — so a bare `server:bugcast` entry cannot be
allowlisted at all, and none of it helps on Pro, Max, or no org.

Channels are a research preview whose "protocol contract may change based on
feedback", and neither flag appears in `claude --help`. So: a real thing that
really works, worth using if you are willing to type the flag, and never
something to build a workflow on. The follow-loop needs no flag and no
permission.

If nothing arrives, look at stderr — a failed push warns once there, because
Claude Code acknowledges nothing and returns no error when a server is not
loaded as a channel.

What gets pushed is deliberately almost nothing — only what a person would
interrupt you for:

| Pushed | Not pushed |
|---|---|
| Moments the tester marked (⌘⇧M) | Clicks, navigations, focus, typing |
| Uncaught exceptions | Successful requests |
| Console errors | Ordinary console output |
| Failed requests, with response bodies | Provisional speech (it changes under you) |

Claude is turn-based, so pushing everything would not produce continuous
reasoning — it would produce a queue arriving as one indigestible batch. Events
within the same poll are batched into a single notification for the same reason.

Use `session_tail` when the agent wants the *whole* stream; use the channel to be
told that something happened.

## Resolving a minified stack

A captured frame is `bundle.js:1:38402`. You are sitting in the repo that
produced that bundle, so the answer is already on your disk:

```
session_resolve({ sessionId: "latest", stack: "<the stack from the event>" })
  -> [{ resolved: true, source: "src/editor/save.ts", sourceLine: 142, ... }]
```

The extension records every script the page loaded with its `sourceMappingURL`,
but deliberately **does not fetch the maps** — that would be a network call
inside a tool whose whole premise is that recording makes none. Resolution
happens here instead, against `process.cwd()`: the project this server was
launched in. Maps are matched by basename, which content-hashed filenames make
far less ambiguous than it sounds, and nothing is downloaded.

**It tells you when it does not know.** A frame it cannot place says why — no
map shipped, the map was inline in the bundle, no such `.map` in this checkout,
no entry at that position. A guessed frame is worse than an unresolved one,
because an agent will act on it and edit the wrong file with confidence. If two
builds are lying around, both are reported rather than one being silently
preferred, since resolving against a stale `build/` is exactly how you get a
plausible wrong answer.

## Read-only, always

No write, no delete, no move. An agent must not be able to destroy the evidence
it was asked to look at.

Session ids are resolved against the actual directory listing rather than joined
onto a path — an id arrives from a model, which makes it attacker-influenced the
moment anyone shares a session folder, and `..` is the obvious way out.

An unknown `schemaVersion` is refused rather than parsed best-effort, because
subtly wrong answers to an agent that will act on them are worse than none.

MIT.
