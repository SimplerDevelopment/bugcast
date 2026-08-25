# Transcription architecture decision

Type: grilling
Status: resolved, amended 2026-08-25
Blocked by: 03

## Question

Given the measured costs, decide the transcription path — this is the single
decision that most constrains the rest of the map, because choosing the sidecar
unlocks real filesystem output and choosing in-browser forecloses it.

- **Sidecar (whisper.cpp), in-browser (transformers.js/WebGPU), or pluggable?**
- If a sidecar: what is it written in, how is it started (does the extension
  detect it and degrade gracefully when absent?), and how does a Windows
  developer install it in one command?
- If in-browser: where does the model come from on first run, given the
  "zero network calls" principle — is a one-time model download an acceptable
  exception, or does the model ship with the extension?
- **Live or post-hoc?** Transcribing the recorded audio track after stop is far
  simpler than a streaming pipeline. Is there any requirement that forces live?
- Is audio recorded as a separate track from the video, so it can be fed to the
  transcriber without demuxing?
- What happens when the user records with no microphone, or says nothing?

## Answer

**In-extension transformers.js. No transcription sidecar.**

Forced by [ticket 03](03-local-transcription-real-costs.md): whisper.cpp ships no
macOS CLI binary in any recent release (verified live — Ubuntu and Windows only;
macOS gets an xcframework), and every Node binding either needs a compiler
toolchain or is a 14-star package unmaintained since 2025. A sidecar therefore
cannot deliver one-command install on the primary developer's own OS, which
fails the map's "any developer, OS-agnostic" constraint outright.

Keep a clean **engine → segments → SRT** seam so a bring-your-own-whisper.cpp
path can be added later as opt-in, without the rest of the system knowing.

### Model delivery — download by default, offline mode available

Ships small; fetches the ONNX model on the first session that needs
transcription, caches it permanently, and never touches the network again.
"Fully local" is a promise about *your data*, not network abstinence — the
extension itself arrives over the network too.

An explicit **offline path** is supported: point at a locally-provided model
file, for air-gapped or high-security environments. Costs one config path and a
README section.

### Model tier — asked once, at first run

No hardcoded default. The first-run dialog presents the trade-off (tiny ~75MB
fast/sloppy · base ~145MB balanced · small ~480MB best on identifiers and
jargon) and remembers the choice.

**This collapses three decisions into one UI moment**: the tier prompt is also
where the download is explained and where the offline/local-model option is
offered. One dialog, not three scattered settings — and it is the only place the
user is asked anything before recording.

### Post-hoc, not streaming

Ticket 03 measured a 10-minute recording transcribing in under a minute even on
the pessimistic benchmark, so there is no requirement forcing a live pipeline.
Transcribe after stop. Drops an entire streaming architecture for nothing lost.

### Audio path — AudioContext tee (resolves a conflict between two tickets)

This ticket originally asked for audio as a **separate track** so the transcriber
would not have to demux, while [ticket 04](04-clock-sources-and-normalization.md)
concluded the opposite — a **single** `MediaRecorder`, because `chrome.tabCapture`
mutes the tab unless routed through an `AudioContext` and separate recorders have
no documented sync guarantee.

The conflict dissolves. Mic → one `AudioContext`, then **tee**:

- one branch mixes into the single `MediaRecorder` — keeps A/V sync, unmutes the tab;
- one branch is an `AudioWorklet` tap emitting raw **16 kHz mono PCM** straight to
  Whisper.

No demux, no sync loss, and Whisper receives exactly the format it wants with no
encode/decode round-trip. Both branches share the `AudioContext` clock, so SRT cue
offsets and video frames stay on the same origin.

### No mic, or silence — optional, default ON

The mic records unless explicitly disabled; narration is the point of the tool, so
the default reflects it. Permission is requested on first record. A session with
no microphone or no speech simply produces **no `.srt`** — the event timeline is
unaffected and the session remains valid. No branching beyond "was there audio".

### Amendment, 2026-08-25 — an optional hosted engine

The `engine → segments → SRT` seam above was kept open for "a
bring-your-own-whisper.cpp path". The first thing through it is not whisper.cpp;
it is a hosted API, added as `offscreen/hosted.ts`. Default remains local and
unchanged: with no key configured, nothing about this ADR's original answer
moves.

**What forced it.** The local tiers top out at `small.en` and ship `base.en`,
and the shipped model is weakest exactly where a QA transcript carries its
meaning — proper nouns and alphanumeric ids. Session `2026-08-25T16-45-05`
rendered a ticket SKU "SITE79-001" as "site 79-001" and looped "So, research
would open whisper" across four consecutive segments. The loop is a Whisper
decoding pathology rather than a windowing artefact: the authoritative
full-audio pass produced it too, so no window size and no tier within reach
fixes it. Live accuracy is also the only accuracy available, because there is
no second, better pass to recover from.

**This contradicts a stated non-negotiable, and that should be read, not
skipped.** `map.md` lists "Anything hosted" under Out of scope and calls the
constraint "the product's identity, not a v1 shortcut". This ADR narrowed the
claim usefully — *"'Fully local' is a promise about your data, not network
abstinence"* — but hosted transcription does not fit inside that narrowing: the
audio **is** your data, and it now leaves the machine. The one-time model
download was network abstinence; this is not.

The exception is deliberately bounded:

- **Off by default.** No key means the local engine, byte for byte as before.
- **The user's own key**, held in `chrome.storage.local` and never in the
  bundle — an extension's source is readable by anyone who installs it.
- **Transcription only.** Video, events, timeline and every artifact stay local.
  No server, no account, no sharing link, no telemetry.
- **Reversible.** Clearing the key restores the original behaviour with no
  migration.

Where the UI previously promised "Nothing is uploaded", it now reads the
setting and says which is true.

**Model choice: `whisper-1`, not `gpt-4o-transcribe`.** The latter is the more
accurate model on the same endpoint, and is still the wrong one here: per-segment
timestamps are the entire product of this path, `timestamp_granularities`
requires `response_format: verbose_json`, and `gpt-4o-transcribe` does not
support it. It returns text only, which would collapse a session to one
unplaceable blob. Revisit if that endpoint gains timestamps.

**Chunking, which the post-hoc decision above did not anticipate.** The endpoint
caps an upload at 25 MB. This audio is 16 kHz mono 16-bit — 32 KB/s — so the cap
lands near thirteen minutes, and the session that motivated this ran 12.5. Long
sessions are split at eight-minute boundaries and offset back onto the session
clock. One hard cut per chunk mangles a word the way a live-window boundary
does; splitting on a silence trough would remove that and is not worth the
machinery until a transcript is seen to suffer.

**Not a fallback chain.** A hosted failure throws rather than retrying locally.
Rescuing a failed window would mean starting a ~105 MB model download
mid-recording, which costs more than the window is worth. A failed live window
is lost and the next continues; a failed pass at stop is recorded as
`transcriptError` on the session.

### Consequences for other tickets

- **[10 How artifacts reach disk](10-how-artifacts-reach-disk.md)** — the sidecar
  option is dead. The real choice is now `chrome.downloads` vs File System Access API.
- **[11 How an agent consumes a session](11-how-an-agent-consumes-a-session.md)** —
  MCP no longer rides along on an existing process; it would cost a separate one.
- **[12 Install and distribution](12-install-and-distribution.md)** — no native
  dependency to distribute. Install is "load the extension", which is exactly what
  the destination needs. Still blocked on 01.
