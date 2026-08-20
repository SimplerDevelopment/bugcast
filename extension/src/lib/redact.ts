/**
 * Redaction seam.
 *
 * Redaction runs **in memory, before serialization** — the raw value never
 * reaches disk. The implementation lands in #3; this file exists now so that
 * capture is wired through it from the start. Retrofitting redaction into
 * capture afterwards is exactly how redaction gaps happen.
 *
 * Design: docs/design/issues/05-privacy-and-redaction-defaults.md
 */

export interface Redactor {
  /** Strip secrets from a URL's query string. */
  url(url: string): string;
  /** Redact header values by name, keeping the name and a shape hint. */
  headers(headers: Record<string, string>): Record<string, string>;
  /** JSON-key-aware plus raw-text entropy scanning. */
  body(body: string, contentType: string | undefined): string;
}

/**
 * Explicitly does nothing. Named so it is greppable and so a caller can never
 * skip redaction by accident — `Redactor` is a required argument, and passing
 * this is a visible decision rather than an omission.
 *
 * Replaced by the real implementation in #3.
 */
export const NO_REDACTION: Redactor = {
  url: (url) => url,
  headers: (headers) => headers,
  body: (body) => body,
};
