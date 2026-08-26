# Handoff — bugcast transcription, audio, and artifact integrity

**`main` is at `bd15337`. Zero open PRs. Four merged on 2026-08-25 (#27, #28, #29, #30).**
**Written 2026-08-25, after the first session that verified any of it.**

## Goal

Test the bugcast loop end to end for real — a human recording in Chrome while an
agent follows live over MCP — and fix what that turns up. It turned up a lot.
Most is fixed and now, finally, mostly verified.

## What is on main

| commit | |
|---|---|
| `2363b1a` #27 | live pass no longer eats the audio `stop()` needs; 30s window; `transcript.srt` keepalive; frames failure reported; `Debugger.setSkipAllPauses`; script URLs redacted; mcp CI fixed |
| `213e913` #29 | Whisper tap band-limited properly; 44.1kHz rate bug |
| `2e2523b` #28 | optional hosted OpenAI engine; live/final engine split; `api.openai.com` permission |
| `bd15337` #30 | refuse to start on a lapsed folder grant; Chrome on-device live pass; availability-check timeout |

237 tests, 19 files. CI runs typecheck, test, build, and a Playwright smoke test
under xvfb. **Every significant bug found today was invisible to all four.**

## VERIFIED — session `2026-08-25T21-11-40_www-simplerdevelopment-com`

Keep this session. It is the only end-to-end evidence that exists.

388.7s, complete, all seven files present:

```
events.ndjson 165,949   report.md 11,708   session.json 1,539
speech.ndjson     999   timeline.json 202,498   transcript.srt 496
video.webm  8,464,366
```

- **`transcript.srt` exists.** That was the open question from the keepalive fix
  — MV3 worker suspension is not reproducible in CI, so it was on main on the
  strength of a diagnosis alone. It is not any more.
- **Chrome's on-device speech ran.** The live timestamps are `7074, 8983, 13682,
  54944 …` — arrival-stamped spans, not multiples of 30000. Whisper windows
  would land on 30s boundaries. So the language pack installed and the on-device
  engine took the live pass.
- The folder-grant guard works: a session that starts writes its streaming files.

## THE FINDING — the authoritative pass is now the weak link

The design assumes provisional-then-authoritative: the live pass is approximate,
Whisper at stop is correct and replaces it. **On this evidence that is backwards.**

Live (Chrome on-device), nine clean lines with tight spans:

```
 7074– 8983  "Can you hear me at all"
95595–109507 "Move pux-115 to the planned column"
348819–353829 "Move pux 115 back to the backlog"
```

Authoritative (Whisper over the full recording), five segments, two of them
absurd and full of invention:

```
00:01:03,800 --> 00:03:50,120   (166 seconds in one segment)
  "Start listening to Bugcast. Move PUX-115 to the planned column. Thank you.. Okay. Okay."
00:03:50,120 --> 00:06:27,000   (157 seconds)
  "Now move right back. the the.. Move PUX115 back to the backlog.
   So, we're going to go ahead and get started. I'm going to go."
```

`"Thank you.. Okay. Okay."`, `"the the.."` and the entire closing sentence were
never said. This is Whisper's long-form failure mode on sparse, silence-heavy
audio — the session has real gaps (22s→54s, 66s→95s, 147s→229s) and it fills
them with plausible noise. `chunk_length_s: 30, stride_length_s: 5` over a
6.5-minute buffer is what produces the 166-second segments.

Note this persists **after** the resampling fix, so aliasing was not the cause of
the hallucination — or not the only one.

**The decision this forces:** `transcript.srt` is the artifact a user keeps and
hands to an agent, and it is currently worse than the provisional lines it
replaces. Options, none taken yet:

1. Keep the on-device lines as authoritative when they exist, and drop the
   Whisper pass. Costs sample-accurate timestamps — the live ones are
   arrival-stamped, so `t` stops being exactly video time.
2. Voice-activity-gate the Whisper pass so it never sees long silence.
3. Reconcile: use Whisper text where the two agree, on-device spans for timing.
4. Leave it. The report merges both and a reader can see the disagreement.

## Still broken or unverified

- **`frames: {enabled: false}` again**, two sessions running. #27 added a
  `console.warn` naming the reason (`[bugcast] no frames extracted`). Nobody has
  read it. The offscreen console has the answer in one line.
- ~~**`scripts: {enabled: false}`**~~ — **found, fixed in #32.** The first
  diagnosis here was wrong and is worth keeping as a warning. It blamed #27's
  `Debugger.disable()` fallback; that fallback only runs when
  `setSkipAllPauses` rejects, and it was not running. #27 changed nothing about
  ordering.

  The real cause: `Debugger.scriptParsed` replays every already-loaded script
  in **one burst, the instant the domain is enabled** — inside `attach()`. The
  handler was registered sixty lines later, after `await startCapture()` went
  off to negotiate `tabCapture`. Unlike network and console traffic, which
  keeps arriving, a one-shot burst missed is missed entirely.

  Why `scripts/smoke.mjs` passes while asserting `scripts.length`: it is a
  race, not a certainty. Five scripts and no video, and the continuation wins.
  A real page with `tabCapture` in the way, and it never does. Network capture
  in the same broken session worked perfectly, which is the tell.

  **Generalise this.** "Regression, and the last change to that file is mine"
  is a seductive shape and it was wrong here. The `enabled: false` came from an
  empty array, not from a disabled domain — reading which of the two it was
  would have cost one grep.
- **The hosted OpenAI path has never made a real request.** `hosted.test.ts`
  injects a fake `fetch`. The CORS/host-permission reasoning in #28 is reasoned,
  not observed.
- **The audio resampler is verified only against synthetic tones.** 44.1kHz
  hardware in particular has never been tried — this machine is 48kHz, which is
  why the rate bug survived so long.
- **Live-window realtime ratio never measured.** #27 added a
  `[bugcast] live window … Nx realtime` log. Chrome's on-device engine now takes
  the live pass on this machine, so the Whisper live path may rarely run at all.

## What worked

- **Reading the session folder before theorising.** Sizes and mtimes alone
  reconstructed two separate failures. The decisive one: *every file opened at
  start was missing, every file written at stop was present* — which is a
  permission that changed mid-session, not an audio bug.
- **Measuring instead of asserting.** The box-filter response (−9.5dB at 12kHz,
  folding to 4kHz) and the 44.1kHz→14700Hz arithmetic were both computed, not
  argued. Both turned into tests that fail against the old code.
- **Testing the shipped file.** `pcm-worklet.test.ts` reads
  `public/pcm-worklet.js` and evaluates it, because an AudioWorklet cannot be
  imported. What is under test is what ships.
- **Checking the browser rather than the docs.** Running
  `SpeechRecognition.available({processLocally:true})` in the actual Chrome 151
  settled the on-device question in one call, after two doc sources failed to.
- **Reviewing green PRs anyway.** #30 was green when review found a hang that
  would have wedged recording at start.

## What didn't work — don't repeat

- **`bun run smoke` cannot test the seam.** It seeds an OPFS handle, so it writes
  where the MCP server cannot read. `showDirectoryPicker` is a native dialog no
  automation drives.
- **CI cannot test worker suspension.** `AGENTS.md`: Playwright attaches a
  debugger to the service worker, which prevents it.
- **Hunting the extension's storage in the Chrome profile.** Tried twice, failed
  twice, for settings and for the transformers cache. Nothing under
  `~/Library/Application Support/Google/Chrome/*/Local Extension Settings`.
  **Instrument the code instead** — that is what finally worked.
- **Inferring cause from an empty `speech.ndjson`.** Model downloading, mic never
  granted, and a thrown window are indistinguishable from the artifact. #30 added
  a heartbeat and two `console.warn`s precisely so they no longer are.

## Next steps

1. **Read the offscreen console during one recording.** `chrome://extensions` →
   Bugcast → **Inspect views: `offscreen.html`**. It now names the live engine,
   why frames produced nothing, and how much mic audio is buffered. Three open
   questions, one console.
2. **Investigate the script index regression** (above). Most likely something I
   broke in #27.
3. **Decide what `transcript.srt` should be**, given the authoritative pass is
   currently worse than the provisional one.
4. **Try a 44.1kHz input device** — a USB interface or Bluetooth headset — to
   exercise the resampler path that has never run.

## Things worth knowing

- Sessions live in `~/bugcast-sessions`. Only `2026-08-25T21-11-40_*` remains and
  it is the sole verification of anything. **Do not delete it.**
- `sessions_list` only sees a stopped-and-written session; one in flight has no
  `session.json`. Empty `[]` is not an error. `session_tail({sessionId:"latest"})`
  does follow a live one — confirmed working against a real recording.
- Shortcuts: **⌘⇧U** record, **⌘⇧E** mark. Chrome silently drops a suggested
  shortcut another extension already claimed. Starting via the shortcut after a
  Chrome restart now refuses with an explanation rather than half-starting.
- Chrome's on-device engine is **not** macOS's. `SFSpeechRecognizer` needs a
  Native Messaging host — the sidecar this project gave up whisper.cpp to avoid
  (`docs/design/issues/03`). It also takes no MediaStream and carries no
  timestamps, which is why it drives only the provisional pass.
- The working tree has been **shared with a second Claude session** all day. It
  committed from this tree at least twice, once producing `b48824d` — a commit
  importing a module it did not track, which did not compile until `5068ed1`
  supplied it. Check `git log` and `git status` before assuming the tree is yours.
- `AGENTS.md` holds the hard-won CDP and MV3 gotchas, and its non-negotiables now
  describe the opt-in network boundary. Read it before touching capture.
