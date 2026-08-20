# Working on bugcast

Operating instructions for an agent picking this up. Read this before touching code.

## What this is

A Chrome MV3 extension that records a QA session — tab video, narrated audio
transcribed locally to SRT, and a correlated timeline of navigations,
interactions, console output and failed network calls — and writes raw files you
own, to hand to a coding agent. Free, open source, **fully local**.

## The one loop

**One issue per commit.** Do not batch. Each open GitHub issue carries its full
spec, derived from a resolved design ticket, so it is already specified — you are
implementing a decision, not making one.

1. Pick the lowest-numbered open issue unless something else is obviously blocking.
2. Build it. Gates, all four, before committing:
   ```bash
   cd extension
   bun run typecheck && bun run test && bun run build && bun run smoke
   ```
3. Commit with `Closes #N`, conventional format, and a `Tokens (approx): ~Nk`
   trailer above `Co-Authored-By`.
4. **Then compact or clear context.** A pushed commit is a natural boundary: the
   issue holds the spec, the commit holds the reasoning, the code holds the
   behaviour. The transcript holds nothing the next unit needs. Carrying a
   finished ticket's context into the next one is how focus degrades.

If a unit turns out to need a design decision that is not already in
`docs/design/`, **stop and ask** rather than inventing one. The design is
complete; a gap in it is a real finding.

## Non-negotiables

Breaking any of these is a bug even if every test passes.

- **Fully local.** Core recording makes zero network calls. No account, no
  upload, no telemetry. The only network access anywhere is the one-time Whisper
  model download, which has an offline path.
- **Redaction runs in memory, before serialization.** The raw value never
  reaches disk. `NO_REDACTION` must have no call sites outside its own file.
- **Refuse, don't degrade.** A session missing network or console is
  indistinguishable, to the agent that later reads it, from a session where
  nothing failed — so it will confidently conclude the wrong thing. Fail loudly.
- **Nothing runs on any page until you press record.** No declared content
  scripts, no `<all_urls>` host permission. Host access is requested per-origin
  at record time.
- **One source of truth, many derived views, zero interpretation.**
  webm → frames. timeline → report. Whisper segments → both `.srt` and inlined
  `speech` events. A derived view is safe to materialise *because* it cannot
  drift. A second source is not.

## Traps already paid for

Every one of these was found the expensive way. Do not rediscover them.

- **CDP mixes three time units in adjacent, similarly-named fields.** Network
  `timestamp` is monotonic *seconds*; `wallTime` is epoch *seconds*; Runtime and
  Log `timestamp` are epoch *milliseconds*. Never do arithmetic on a raw CDP time
  value — everything goes through `lib/time.ts`, which guards the 1000x error.
- **Response bodies must be pulled eagerly, inside `loadingFinished`.** They do
  not survive a navigation and `configureDurableMessages` does not help. Defer
  the pull and the artifact silently ships empty bodies — which is the whole
  difference between a session that diagnoses itself and one that is worthless.
- **Service worker traffic is invisible** without `Target.setAutoAttach` plus a
  per-target `Network.enable`.
- **Focus fires on mousedown**, so it arrives *before* the click. Dedupe against
  the preceding `pointerdown`, never against a previous click.
- **`drop` only fires if the target called `preventDefault` on dragover.**
  `dragend` is the reliable terminator for a native drag.
- **Text content is not an accessible name for a form control** — a `<select>`'s
  is every option concatenated. And a container's "name" identifies the whole
  page, so text selectors are leaf-only.
- **`showDirectoryPicker` never exposes an absolute path**, and a
  `FileSystemDirectoryHandle` only survives in IndexedDB — `chrome.storage`
  serializes to JSON and would destroy it.
- **`tab.url` is not readable in the worker** without the broad `tabs`
  permission unless `activeTab` was granted by a gesture. The popup passes it.
- **`use_dynamic_url: true` on a web-accessible resource changes its origin** to
  `chrome-extension://<uuid>/`, which silently breaks `audioWorklet.addModule` —
  worklet modules are same-origin restricted, and the failure is a bare "Unable
  to load a worklet's module" while a plain `fetch` of the same URL returns 200.
  An extension page needs no `web_accessible_resources` entry to load its own
  files at all.
- **`chrome.tabCapture.getMediaStreamId` needs an `activeTab` grant** that only a
  real toolbar-icon click produces. Host permissions do not substitute.
- **transformers.js fetches its ONNX wasm runtime from a CDN** unless
  `env.backends.onnx.wasm.wasmPaths` points at local files — a network call in
  the middle of a tool whose premise is that it runs locally. `scripts/copy-ort.mjs`
  copies the two runtimes actually used; copying all of them is 94MB.

## `bun run smoke` is not optional

It launches a real Chromium with the built extension and records against a
server that returns a 500 with a body, a binary error, a CORS-blocked request
and a URL carrying a token.

**It has found nine bugs so far that unit tests structurally could not**,
including a live credential leak (`?pw=` sailing through the URL redactor,
because the same blind spot wrote both the pattern and its tests). Unit tests
verify what you believed; this verifies what Chrome does.

Two things it cannot check, because both are native OS dialogs no automation can
drive — they need a human, and this is already recorded in
`docs/design/issues/10`:

- the File System Access directory grant, and whether it really re-prompts only
  once per browser restart;
- whether `tabCapture`'s paint-driven cadence leaves the webm's timeline
  tracking wall-clock;
- `tabCapture` itself, which needs an activeTab grant no automation can produce.
  The harness works around this by driving `buildPipeline` — the real function —
  with a canvas+oscillator stream, which does verify the worklet, the tee,
  MediaRecorder and the 48k→16k decimation.

## Where things are

- `docs/design/map.md` — the decision map. Thirteen resolved tickets in
  `docs/design/issues/`, each with its reasoning **and its rejected
  alternatives**. Read the relevant one before changing behaviour it settled.
- `docs/design/prototype/` — a hand-authored example session. The artifact
  contract, concretely. Build against it.
- `extension/src/lib/` — pure, tested modules. Prefer putting logic here.
- `extension/src/background/` — the service worker: orchestration only.
- `extension/src/content/` — injected at record time, never declared.

## Status

Shipped: #1 clock · #2 CDP capture · #3 redaction · #7 disk output ·
#4 interactions · #9 artifact assembly · #5 offscreen capture · #6 transcription ·
#8 frame index.

Open: #10 recording UX · #11 self-test · #12 MCP server ·
#13 CI and release · #14 CORS row reads as 200 · #15 zip fallback.
