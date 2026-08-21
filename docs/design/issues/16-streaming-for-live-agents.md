# Streaming the session so an agent can read it as it happens

Type: grilling
Status: resolved
Supersedes part of: [07](07-transcription-architecture-decision.md)

## Question

The artifact is written at stop. Can it be streamed instead, so a coding agent
reads a session while it is still being recorded?

## Answer

**Yes — one append-only `events.ndjson`, carrying everything including speech.**

### Why this reverses ticket 07

07 chose post-hoc transcription on the grounds that ten minutes transcribes in
under a minute either way, so a streaming pipeline was complexity bought for
nothing. That reasoning was sound *for producing an artifact* and does not hold
for **consuming one live**: a minute of latency is fatal to an agent watching
along, however cheap it is in absolute terms.

### The flaw in the obvious version

The first proposal was to stream events and leave the transcript at stop. That
segments them *in time*, and it is wrong for a reason ticket 09 already
established: **events are the *what*, narration is the *why*.** In the worked
example the narration "And clicking save" lands 670ms *before* the click,
because people narrate intent before acting. An agent reading live events
without speech gets the half that does not interpret itself.

So speech streams too, or there is no point.

### Shape

`events.ndjson` — one JSON object per line, appended as things happen, the same
flat discriminated union `timeline.json` already uses. At stop, `timeline.json`,
`transcript.srt` and `report.md` are generated **from it**. Nothing about the
artifact contract changes; the source of truth is simply written progressively
rather than in one burst, and the derived views stay derived.

### Live speech is provisional, and says so

Whisper runs on rolling ~10s windows during the session and emits speech events
flagged `provisional: true`. At stop the authoritative full-audio pass runs
exactly as it does today and supersedes them.

Two properties this buys, both deliberate:

- **The final artifact is unchanged in quality.** The stop pass does not consume
  the live output, so a bad window cannot contaminate the transcript on disk.
- **The live view is honestly labelled.** A consumer can tell approximate text
  from final text, rather than discovering that a line changed under it.

Windowing costs accuracy at boundaries — a word split across two windows is
mangled. Accepted, because it is provisional by construction.

### Writes are batched, not per-event

Buffered in memory and appended every ~2 seconds.

Not a micro-optimisation: the File System Access grant lapsing has been the
single largest source of real failures in this project, and streaming turns one
write burst into hundreds of individual operations against exactly that
permission. Two seconds of latency is nothing against narration cadence.

### The channel is the file

An agent tails `events.ndjson` — no new process, no lifecycle, and it works with
`tail -f`, an editor, or anything else. The MCP server gains a cursor tool so a
Claude agent can poll cheaply without re-reading, but nothing has to be running
before recording starts. Sessions stay self-contained artifacts.

Rejected: a local WebSocket served by the extension. Lowest latency, and it puts
a listening socket inside a tool whose stated identity is that it makes zero
network calls and runs no server.

### Video stays untouched

Timestamps are how an agent reaches the video, not ingestion. `t` is measured
from `t0`, which is sampled inside `MediaRecorder.start()`, so event time *is*
video time — "watch from 02:14.320" resolves without decoding anything, and the
frame index hands a multimodal agent pixels for a moment on request. Streaming
changes none of that.

### Push, after all — Claude Code channels

Recorded because I got this wrong first: I claimed an unsolicited notification
could not wake a model mid-turn, so push was not worth building. **That is
false.** Claude Code 2.1.238 ships channels — an MCP server declaring
`capabilities.experimental["claude/channel"]` can send
`notifications/claude/channel` into a running session and the agent acts on it
without anyone typing. Verified in the binary: the flags are `--channels` and
`--dangerously-load-development-channels`, both hidden from `--help`, which is
why looking there found nothing.

So there are two live surfaces, and they are for different things:

- **`session_tail`** — the agent asks. Complete, cursor-based, cheap to resume.
- **the channel** — the session tells. Filtered to almost nothing.

**The filter is the whole design.** A recording produces hundreds of events and
Claude is turn-based, so pushing all of them does not produce continuous
reasoning — it produces a queue that arrives as one indigestible batch on the
next turn. What goes through is only what a person would interrupt you for:
markers, uncaught exceptions, console errors, and failed requests with their
bodies. Clicks, navigations, successful requests and ordinary logs never do. Nor
does provisional speech, which changes under a reader.

Events inside one poll are batched into a single notification: five wakes for
five errors in the same second is five turns spent on one problem.

### Inference belongs off the capture thread

Reported after the first real use: live transcription was slowing down event
capture. Correct, and the cause was structural rather than incidental — Whisper
ran on the offscreen document's main thread, which is also where
`MediaRecorder`'s `ondataavailable` fires and where the AudioWorklet delivers
PCM. Every inference pass blocked both. Transcribing while recording degraded
the recording.

It now runs in a dedicated module worker. Windows are transferred rather than
copied (a ten-second window is ~640KB, repeatedly).

**Separating execution, not output.** The obvious reading of "record them
separately" is a second file, and that would be a mistake: the whole reason
speech is in the same array is that narration lands *before* the click it
describes. Splitting the streams hands the consumer a merge problem to solve
that this tool exists to have already solved. What needed separating was the
thread.

**Timestamps were never at risk**, which is worth stating because it is not
obvious: speech offsets are derived from the audio sample position
(`sampleOffset / 16000 * 1000`), not from when inference finished. The
transcriber can run arbitrarily far behind without the timeline drifting, and
audio and video share `t0` at `MediaRecorder.start()`.

### Consequences

- **09** — `events.ndjson` becomes the source; `timeline.json` joins
  `transcript.srt` and `report.md` as a derived view. The rule holds.
- **07** — its post-hoc pass survives as the authoritative one. Only the claim
  that streaming buys nothing is withdrawn.
- **12** — the MCP server gains `session_tail`, still read-only.
- **10** — CPU contention during recording is now real and continuous, which is
  the same class of concern that chose VP8 over VP9.
