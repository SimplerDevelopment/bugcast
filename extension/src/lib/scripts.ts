/**
 * The script index — where the code actually came from.
 *
 * A captured stack frame is `bundle.js:1:38402`. The agent reading the session
 * is sitting *in the repo that produced that bundle*, and cannot get from one to
 * the other without a source map.
 *
 * CDP hands this to nobody for free — the Chrome DevTools team had to import
 * DevTools' own machinery into chrome-devtools-mcp to do it. What the protocol
 * *does* give, cheaply, is `Debugger.scriptParsed`: it "is also fired for all
 * known and uncollected scripts upon enabling debugger", so enabling the domain
 * at record time replays every script already loaded, each carrying the
 * `sourceMapURL` from its magic comment.
 *
 * So the split is: **index at capture time, resolve at read time.** Writing the
 * index is local and costs nothing. Fetching the maps is not — that would be a
 * network call in the middle of a tool whose premise is that recording makes
 * none — so resolution belongs to the MCP server, reading the developer's own
 * checkout where the maps already are.
 *
 * The domain is safe to enable: measured at no cost above the domains already
 * attached (`scripts/debugger-cost-cleanroom.mjs`, n=25).
 *
 * Design: docs/design/issues/17-what-a-project-contributes.md
 */

export interface ScriptEntry {
  /** Per-target, so it is only meaningful alongside the session that recorded it. */
  scriptId: string;
  url: string;
  /** From V8's magic comment. Relative to `url` unless absolute. */
  sourceMapURL?: string;
  /**
   * The map was a `data:` URI embedded in the bundle.
   *
   * Recorded as a fact rather than captured: an inline map is routinely
   * megabytes, and the artifact is meant to be handed to a model. A reader that
   * knows the map was inline can say so; one that finds nothing cannot tell
   * "no map" from "map we declined to carry".
   */
  inlineMap?: true;
  /** SHA-256 of the script content, from CDP. The honest way to match a bundle. */
  hash?: string;
  /** The `debugId` magic comment, where a build tool emitted one. */
  buildId?: string;
}

/** Our own code is not the developer's, and indexing it is noise. */
const isOurs = (url: string): boolean =>
  url.startsWith('chrome-extension://') || url.startsWith('devtools://');

/**
 * Normalize one `Debugger.scriptParsed` into an index entry.
 *
 * Returns null for anything not worth carrying: our own scripts, and the
 * anonymous `eval`/`new Function` scripts that have no URL to resolve against.
 */
export function fromScriptParsed(p: any, redactUrl: (url: string) => string): ScriptEntry | null {
  const raw: string = p?.url ?? '';
  // Filtered on the real URL — `isOurs` matches a scheme, and redaction is free
  // to rewrite anything after it.
  if (!raw || isOurs(raw)) return null;

  // Redaction takes the same parameter here as everywhere else. A bundle served
  // from a signed CDN carries its credential in the query string, and
  // `//# sourceMappingURL=…?token=…` carries one too — so this is the same
  // secret as an Authorization header, arriving by a different door.
  // AGENTS.md, non-negotiables: the raw value never reaches disk.
  const url = redactUrl(raw);
  const map: string = p?.sourceMapURL ?? '';
  const entry: ScriptEntry = { scriptId: String(p.scriptId), url };

  if (map.startsWith('data:')) entry.inlineMap = true;
  else if (map) entry.sourceMapURL = redactUrl(map);

  if (p?.hash) entry.hash = String(p.hash);
  if (p?.buildId) entry.buildId = String(p.buildId);
  return entry;
}

/**
 * Collapse to one entry per URL.
 *
 * A script re-parsed after a navigation arrives again with a fresh scriptId, and
 * an index holding the same bundle five times is five times the tokens for no
 * information. Last one wins — it is the one whose scriptId matches the frames
 * an agent is most likely to be asking about.
 */
export function dedupe(entries: ScriptEntry[]): ScriptEntry[] {
  const byUrl = new Map<string, ScriptEntry>();
  for (const entry of entries) byUrl.set(entry.url, entry);
  return [...byUrl.values()];
}
