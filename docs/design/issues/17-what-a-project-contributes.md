# What a developer's own project contributes, and how an agent follows it live

Type: research
Status: resolved
Revises: [16](16-streaming-for-live-agents.md) (its channel section), [09](09-the-artifact-contract.md) (the event union), [11](11-how-an-agent-consumes-a-session.md) (reopens the no-skill decision)

## Question

Bugcast records what the *browser* can see. There are three things it cannot
see, and a developer running it against their own project already knows all
three.

- **Application meta.** Build SHA, release, route, tenant, feature flags, store
  state. Can the page under test contribute structured context *without* Bugcast
  becoming a dependency the app has to install — and without the per-project
  setup step that would cost the zero-config property?
- **Where the code actually is.** A captured stack frame is
  `bundle.js:1:38402`. The agent reading the session is sitting *in the repo
  that produced that bundle*. Is resolving that the highest-leverage gap?
- **A live agent, for someone who is not me.** The channel from 16 works here,
  behind `--dangerously-load-development-channels`. Does it work for a stranger?

And one constraint over all three: **anyone who adds nothing must still get
everything they get today.**

## Answer

Three decisions, one correction, and two things deliberately left unmeasured.

---

### 1. The live-agent path is `session_tail`. The channel is a garnish.

**This corrects ticket 16.** That ticket recorded, correctly and with evident
relief, that channels exist and that an MCP server can wake a session without
anyone typing. What it did not establish — and what turns out to be decisive —
is *who is allowed to*.

`--channels` accepts only plugins on an allowlist Anthropic curates: the
`claude-plugins-official` set. Everything else needs the development flag. The
documented escapes are two, and both fail for a project shaped like this one:

- an Anthropic partner contact for an official-marketplace listing, which is not
  something a repo can ship;
- a Team/Enterprise admin setting `allowedChannelPlugins` — which **replaces**
  the default list rather than extending it, names a *plugin plus its
  marketplace* so a bare `server:bugcast` entry cannot be allowlisted at all,
  and does nothing whatsoever for Pro/Max/no-org users, who are most of the
  audience of a solo-maintained OSS extension.

Two feature requests asking for exactly the user-scope escape hatch
(anthropics/claude-code#47767, #58152) were closed as duplicates — acknowledged,
unimplemented.

So the channel cannot be the onboarding story, and the README must not imply it
is. **It stays**, documented as an experimental extra with its flag, because for
the author and anyone willing to type the flag it is genuinely the best surface
there is.

**The flag-free path already exists and is better resourced than we were using
it.** A Claude Code main-conversation MCP call still running at 120s is moved to
a background task rather than blocking the session (v2.1.212+, tunable via
`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). Stdio servers additionally get a
~30-minute idle window and no 60s per-request timer — that one applies to
HTTP/SSE servers only. `MAX_WAIT_MS = 30_000` is therefore four times more
conservative than the platform requires, and since the wait is already
`fs.watch`-driven on the session directory, a longer ceiling costs nothing while
nothing is happening.

Raise it as an **opt-in ceiling (~110s), not a new default**, because the
backgrounding that makes a long wait safe is explicitly main-conversation only:
never subagents, never IDE-server calls, never non-interactive mode unless
`CLAUDE_AUTO_BACKGROUND_TASKS=1`. A subagent issuing a 110s call just blocks for
110s.

**Two hazards to defend against, both live:**

- On the v2 MCP runtime (default from v2.1.232), a channel server that
  negotiates protocol revision `2026-07-28` is **not registered as a channel at
  all**, silently. Our plain-ESM server is protected only by accident — it still
  speaks the legacy handshake. Bumping `@modelcontextprotocol/sdk` can therefore
  break the channel with no error at either end. The documented workaround
  (`MCP_PROTOCOL_NEGOTIATION=legacy`) is process-wide and would downgrade every
  other server the user has, so it is not something we can ship.
- Delivery is fire-and-forget. Claude Code does not acknowledge notifications
  and drops them silently when a server is not loaded as a channel. The
  warn-once-on-stderr in `channel.mjs` is the *only* signal a user ever gets;
  keep it.

The documented remedy for the no-ack problem is to expose a reply tool Claude
can call to report status back. **Refused** — that is a write path, and 11's
read-only rule is not negotiable for a server whose whole job is to hold
evidence.

Recorded because it was assumed and is false: channel distribution is *not*
plugin-only. `claude --dangerously-load-development-channels server:webhook` is
the documented bare-server form, so the current shape is right, and repackaging
as a plugin would not buy a zero-flag path anyway.

### 2. The extension point is User Timing, and it is not a Bugcast API

The cheapest correct way for an application to contribute structured context is
the one that **does not require the application to know Bugcast exists**:
`performance.mark()` / `performance.measure()` with a structured-clone `detail`
payload. Baseline since May 2022, zero dependencies, already in the platform.

The adjacent API is a trap and needs writing down, because it looks like the
obvious choice. **`console.timeStamp` is a dead end.** Chrome's own docs draw
the line — User Timing "adds entries to the browser's internal performance
timeline"; `console.timeStamp` "does not". It is trace-only. And it is confirmed
from the other direction too: CDP's `Runtime.consoleAPICalled` `type` enum
contains no `timeStamp` member, so the Runtime domain we already attach would
never see it either. A recorder that is not a tracing tool cannot read it at
all.

Read the marks with a `PerformanceObserver` registered with `buffered: true`,
**not** by polling `getEntriesByType`: the page may call `performance.clearMarks()`
and destroy entries we have not read. Entries are per-document and reset on
navigation, and cross-origin iframes keep separate timelines — both of which
match how `pageUrl` already behaves.

### 3. Two shapes, not one — and none of the configuration

Session-scoped metadata and timeline-scoped annotation are different things, and
collapsing them produces a worse artifact. OpenReplay draws the same line in
plain language: metadata is "information your user does not generate, but that
somehow relates to that user", whereas "if the user clicks on a specific link
[…] that's not metadata, that's a custom event."

So:

- **Session-scoped** — build SHA, release, route, tenant. Last write wins, one
  value per session, folded into `session.json` beside `environment`.
- **Timeline-scoped** — an append-only event carrying `t` exactly like every
  other event, joining the union in `events.ndjson`.

The union today is `navigation | speech | click | keydown | change | submit |
drag | focus | marker | network | console | exception` and has no extension
point at all.

**Corrected during implementation: this does *not* bump `schemaVersion`.** The
first draft of this ticket said it did. 09's rule is explicit — "additive
changes do not bump it; consumers ignore unknown fields" — and a new event type
plus a new `session.json` key is exactly additive. Bumping would have been
actively harmful: `checkSchema` throws on any version it does not equal, so v2
would make the MCP server refuse **every session recorded before the change**.
The compatibility promise 11 made load-bearing is what *prevents* the bump here,
not what requires it.

**Take the split; refuse the configuration.** OpenReplay pays for its metadata
with a declare-your-fields-first step in a web platform, string-only values,
overwrite-on-repeat, and a hard cap of ten keys backed by fixed `metadata1`…
`metadata10` columns. That ritual is exactly the per-project setup the
zero-config non-negotiable forbids, and it buys nothing we need.

### 4. Three caps, three sentinels

Anything the page hands us is attacker-shaped in the ordinary way: it is a
developer's object graph, and developers attach Redux stores.

The mechanism everyone cites — depth limiting — is **not sufficient on its
own**, and the reason is worth stating because it is counterintuitive.
Sentry's `normalizeDepth` caps *nesting, not size*: a depth-2 object with 100k
keys, or a depth-1 object holding a 10MB string, passes it completely untouched.
That is the exact shape of a feature-flag map or a flat store slice. Hence the
pairing with `normalizeMaxBreadth` and `maxValueLength`.

**Depth + breadth + string length, each with a distinct sentinel**, so the
reading agent learns *which* budget was hit rather than just seeing a hole.
Note that past a depth limit Sentry keeps only the omitted subtree's type —
not its key names, not its child count — which is more lossy than "preserves
shape" suggests, and worth improving on given 05 already established
shape-preserving redaction as the house style.

This applies **twice**, and the second one is a gap we already have:
`renderArgs` in `cdp-page.ts` flattens `Runtime.consoleAPICalled` args to a
string, so a logged object arrives as text with its structure gone. Same caps,
same place — in memory, before serialization, alongside the existing redactor.
No new permission, no new network call.

### 5. Source maps: index at capture, resolve at read

This is the highest-leverage feature gap, and CDP does **not** hand it over for
free.

The Chrome DevTools team had to build it explicitly for `chrome-devtools-mcp`.
Issue #695 states the pre-fix behaviour exactly as ours reads today: "the
returned stack traces do not reflect source-mapped locations, even if the
JavaScript bundle includes valid sourcemaps and Chrome DevTools itself can
resolve them". A maintainer: "We are already working on making it possible to
re-use the DevTools frontend implementation via the MCP server" — i.e. they
imported DevTools' own machinery rather than getting it from the protocol. It
shipped Feb 2026, was promoted to a README headline feature by a deliberate
commit, and has a mature trail behind it (stack traces, uncaught errors, 1-based
line/column plus wasm offsets, logged `Error` objects, a 50-line cap, and
`x_google_ignoreList` frame hiding).

Ours does none of it. `exceptionText()` splits `exception.description` on
newlines and ships the remainder as a raw minified `stack` string; it never
reads `exceptionDetails.stackTrace.callFrames`, and there is no sourcemap logic
anywhere in the tree.

The enabling primitive is available and documented as stable.
`Debugger.scriptParsed` "is also fired for all known and uncollected scripts
upon enabling debugger" — verified in V8's `V8DebuggerAgentImpl::enableImpl()`,
which enumerates already-compiled scripts and feeds them through the same
`didParseSource()` that emits live ones, so replayed scripts are
indistinguishable. Its `sourceMapURL` field carries **no** experimental flag
while seven of its siblings do, which is a real signal rather than an absence of
one. `buildId` is likewise unflagged and documented as the `debugId` magic
comment — the Sentry-style build-matching key.

**The split that keeps the non-negotiables:**

- **Capture time** — write a `scriptId → {url, sourceMapURL, hash, buildId}`
  index. Local, cheap, no network. Re-fetching maps over the network during
  recording would break zero-network core recording and is refused.
- **Read time** — the MCP server resolves against the developer's own checkout,
  where the maps already are. This also means it works for developers who add
  nothing to their app, which is the whole point.

Four caveats: only scripts still live in that isolate are replayed (GC'd ones
are not, which is self-limiting — they produce no frames); scope is per-target,
so OOPIFs and workers need the `Target.setAutoAttach` we already use;
`sourceMapURL` reflects V8's magic comment only, so header-based `SourceMap:`
maps are missed, though our own Network capture could cover that; and values may
be relative to the script URL or an inline `data:` URI.

**And one real cost, unmeasured.** `Debugger.enable` puts V8 in debug mode,
costing certain optimization and code-cache paths. That is materially different
from Network/Runtime/Log, which are the only domains we attach today, and it
sits directly against refuse-don't-degrade. **Measure before adopting**, and
expect the answer to be an opt-in per-session domain rather than always-on.

---

## Rejected

- **A channel reply tool**, to solve the no-ack problem. Breaks read-only MCP
  (11). The silence stays; the stderr warning is the mitigation.
- **OpenReplay's declare-fields-first metadata model.** Breaks zero-config.
- **Fetching source maps during recording.** Breaks zero network calls in core
  recording. Hence the capture-index / read-resolve split.
- **`console.timeStamp` as the annotation channel.** Trace-only; invisible to
  both `performance.getEntries*` and the Runtime domain.
- **Depending on `--dangerously-load-development-channels` for the primary live
  story.** Breaks "install is load the extension" (12).
- **A byte-offset cursor for `session_tail`, on principle.** The line cursor is
  a deliberate correctness property — it cannot land mid-record the way a byte
  offset can while a write is in flight — and the read is `O(file)` per *burst
  of activity*, not per interval, since the channel switched to `fs.watch`. The
  rewrite trades a correctness property for an unmeasured win. Gate it on a
  measurement at realistic session sizes.

## Unverified

Both gate work above; neither is a design risk.

- ~~**Can an isolated-world content script read a mark created by the main
  world?**~~ **Answered — yes, on all four counts.** Measured 2026-08-21 by
  `scripts/usertiming-probe.mjs`, which uses `chrome.scripting.executeScript`
  with the default world, i.e. the same call `injectInteractionCapture` already
  makes at record time rather than a `Page.createIsolatedWorld` stand-in:

  | | |
  |---|---|
  | isolated world sees main-world marks | yes |
  | `detail` survives the world hop | yes — nested objects and arrays intact |
  | observer receives *later* main-world marks | yes |
  | `buffered: true` replays marks made *before* it registered | yes |

  The fourth is the one that mattered and the one most likely to have failed: a
  content script is injected when you press Record, and the app's build SHA was
  marked at page load, minutes earlier. Buffered replay means those marks are
  still there to collect. **The CDP `Runtime.evaluate` fallback is not needed**,
  and the bridge costs the page nothing it does not already do.

- **What `Debugger.enable` actually costs the app under test.** **Measured
  2026-08-21, still open.** `scripts/debugger-cost-probe.mjs`, n=15 per
  condition, conditions rotated, warm-up round discarded:

  Two workloads, `hot` (tight numeric loop) and `churn` (object allocation):

  | | `hot` median | `churn` median | vs today |
  |---|---|---|---|
  | B — Network+Runtime+Log *(ships today)* | 361.4ms [325.7-399.4] | 63.3ms [55.4-92.2] | — |
  | C — B + Debugger | 332.5ms [300-469.2] | 58.2ms [52.1-97.5] | −8.0% / −8.1%, **IQRs overlap** |

  No measurable difference — and the *sign* is why this is not a clearance.
  `Debugger.enable` cannot make a page faster, so a consistent negative delta
  means either the harness is measuring its own noise, or Playwright had already
  put V8 in debug mode and C added nothing. The probe cannot distinguish those,
  because Playwright is itself a CDP client on the target for the life of the
  context — the same class of confound `scripts/idle-probe.mjs` documents.

  **Upper bound, not permission:** whatever the cost is, it is below ~8% on
  deliberately JIT-heavy workloads. Settling it needs a harness that is not a
  CDP client on the page — spawn Chromium with `--remote-debugging-port`, attach
  only to the service-worker target, open the tab via `chrome.tabs.create`, and
  benchmark through `chrome.debugger`'s own `Runtime.evaluate`.

  **What did come out clean** — the one-time harvest at record start:
  `Debugger.enable` returns in ~50ms (a 287ms first-run outlier was cold start)
  and replays **42 scripts, 40 of them carrying `sourceMapURL`**, on a page
  serving 40 module chunks. So the index itself is cheap and the replay
  behaviour is exactly what the protocol documents.

Recorded so it cannot be reused: the circulating `Runtime.addBinding` latency
figures (9.3ms vs 0.7ms native; 29.6ms vs 1.8ms) come from a single hobby
proof-of-concept and did not survive verification. Do not budget per-annotation
cost from them.

## Built

The extension point shipped with this ticket; source maps did not, and are still
behind their measurement gate.

`lib/annotate.ts` holds the caps and the prefix routing, pure and unit-tested.
The harvest is a buffered `PerformanceObserver` in the existing content script;
capping runs **in the page**, before the value crosses `sendMessage`, so a large
store is never serialized and copied just to be trimmed on the far side.
Redaction runs in the worker through the same JSON-key-aware body redactor that
guards response bodies — an `apiKey` in an annotation is treated exactly as an
`apiKey` in a 500.

Verified by `bun run smoke`, which now marks `bugcast:session` during the test
page's own bootstrap — *before* recording starts — and asserts it arrives:

```
session.json app: {"buildSha":"smoke-sha","apiKey":"[redacted: text]"}
annotations: boot, save-span, live-step
```

That single line covers what unit tests structurally cannot: buffered replay in
a real isolated world, the message hop, the redactor, and the write to disk.

One harness bug fell out of it, pre-existing but widened by the extra writes:
the smoke's click-to-disk latency loop polls `events.ndjson` while the worker is
rewriting it, and `createWritable()` commits through a swap file — so a read
landing in that window throws, as `NotFoundError` or `NotReadableError`
depending on where it lands. The loop already retried and already treated a
missing file as "not yet"; the read is now guarded to mean the same thing.

## Consequences

- **09** — the event union gains an annotation type and `session.json` gains a
  page-contributed block. `schemaVersion` bumps to 2. The one-source-of-truth
  rule is unaffected: annotations arrive through `events.ndjson` like everything
  else and the derived views stay derived.
- **16** — its channel section is corrected, not withdrawn. Push works; it
  cannot be the third-party story.
- **11** — `session_tail` is promoted from "the cursor tool" to *the* documented
  live-agent surface, and its `waitMs` ceiling becomes opt-in-larger. Read-only
  survives intact, and its "no skill ships" decision is **reopened**: it was
  reasoned from the format being self-describing, which was never tested against
  a third party, and no evidence was found either way.
- **12** — the README's live-agent section is rewritten around the follow-loop,
  with the channel demoted to a flagged extra.
- **New standing hazard** — the MCP SDK version is now load-bearing for the
  channel. Note it wherever the dependency is bumped.

## Sources

Fetched 2026-08-20; the channel surface is a research preview Anthropic
explicitly says may change, so re-check before any release that leans on it.

- `code.claude.com/docs/en/channels`, `/channels-reference`, `/mcp`
- `anthropics/claude-code` issues #47767, #58152, #71792
- `w3c.github.io/user-timing/`; MDN `PerformanceMark/detail`,
  `console/timeStamp_static`; `developer.chrome.com/docs/devtools/performance/extension`
- `docs.openreplay.com` — metadata methods and projects API
- `docs.sentry.io` configuration options and size limits; `sentry-javascript`
  `packages/core/src/utils/normalize.ts`
- `chromedevtools.github.io/devtools-protocol/tot/Debugger/`;
  `devtools-protocol` `json/js_protocol.json`; `v8/v8`
  `src/inspector/v8-debugger-agent-impl.cc`
- `ChromeDevTools/chrome-devtools-mcp` issues #695, #903 and README
