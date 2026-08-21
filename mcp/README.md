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
| `session_tail` | Events since a cursor, **works during recording**. Poll with the returned cursor to follow along. |
| `session_report` | The human-readable rendering of a finished session. Start here for a post-mortem. |
| `session_query` | A filtered slice of a finished timeline. `failedOnly: true` answers "what went wrong". |
| `session_frame` | The JPEG nearest a moment, for seeing what the page showed. |

## Following a live session

```
session_tail({ sessionId: "latest", waitMs: 30000 })
  -> { events, cursor, live: true }
session_tail({ sessionId: "latest", cursor, waitMs: 30000 })
  -> returns the moment something happens, or empty at the deadline
```

**Use `waitMs` instead of a polling loop.** The call blocks until events arrive
past your cursor, watching the file rather than re-checking it, so you make one
call per burst of activity instead of one per interval. Polling's real cost is
not latency — it is that every empty check leaves a tool call and its result in
the agent's context.

Capped at 30s so a call cannot be held open indefinitely. A finished session
returns immediately; there is nothing more to wait for.

Speech events flagged `provisional: true` come from a rolling ~10s window during
recording. They are **replaced** by the authoritative full-audio transcript when
the session stops — approximate now, correct later, and labelled so you can tell
which you are reading.

Timestamps are how you reach the video. Every `t` is milliseconds from `t0`,
which is sampled inside `MediaRecorder.start()`, so event time *is* video time:
say "watch from 02:14.320", or ask `session_frame` for that moment. Nothing
needs to decode the recording.

## Read-only, always

No write, no delete, no move. An agent must not be able to destroy the evidence
it was asked to look at.

Session ids are resolved against the actual directory listing rather than joined
onto a path — an id arrives from a model, which makes it attacker-influenced the
moment anyone shares a session folder, and `..` is the obvious way out.

An unknown `schemaVersion` is refused rather than parsed best-effort, because
subtly wrong answers to an agent that will act on them are worse than none.

MIT.
