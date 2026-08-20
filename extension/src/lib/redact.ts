/**
 * Redaction.
 *
 * The adversary is not an attacker — it is the user's own next action. The
 * artifact leaves the machine by their hand: pasted into a coding agent,
 * attached to an issue, dropped into Slack. So the goal is that the default
 * folder is safe to hand over without thinking, and the unsafe version takes an
 * explicit act.
 *
 * Two properties this module exists to guarantee:
 *
 *  1. **Redaction runs in memory, before serialization.** The raw value never
 *     reaches disk, so there is no window in which a secret is on the filesystem
 *     waiting to be cleaned up.
 *  2. **Redaction is shape-preserving.** `"[redacted: 32-char hex]"` keeps the
 *     field, the fact that it was populated, and its well-formedness — nearly
 *     all of the debugging value, minus the only part that was dangerous.
 *
 * It errs toward over-redacting. A 40-char git SHA reads as a secret to the
 * entropy scan and will be redacted; that is an accepted cost, because the
 * failure modes are wildly asymmetric — a missed credential is silent,
 * irreversible, and already in a model's context by the time anyone notices.
 *
 * Design: docs/design/issues/05-privacy-and-redaction-defaults.md
 */

export interface RedactionSummary {
  headersRedacted: Record<string, number>;
  urlParamsRedacted: Record<string, number>;
  bodyKeysRedacted: Record<string, number>;
  typedValuesWithheld: number;
  highEntropyMatches: number;
}

export interface Redactor {
  /** Strip secrets from a URL's query string and fragment. */
  url(url: string): string;
  /** Redact header values by name, keeping the name and a shape hint. */
  headers(headers: Record<string, string>): Record<string, string>;
  /** JSON-key-aware plus raw-text entropy scanning. */
  body(body: string, contentType: string | undefined): string;
  summary(): RedactionSummary;
}

const emptySummary = (): RedactionSummary => ({
  headersRedacted: {},
  urlParamsRedacted: {},
  bodyKeysRedacted: {},
  typedValuesWithheld: 0,
  highEntropyMatches: 0,
});

/** Matches header names, query parameter names, and JSON keys alike. */
const SENSITIVE_NAME = /auth|token|key|secret|session|password|passwd|pwd|cred|signature|cookie/i;

/** Names that carry secrets without matching the pattern above. */
const SENSITIVE_EXACT = new Set(['code', 'state', 'sig', 'sid', 'ssn', 'cvv', 'cvc', 'pan']);

function isSensitiveName(name: string): boolean {
  const n = name.toLowerCase();
  return SENSITIVE_NAME.test(n) || SENSITIVE_EXACT.has(n);
}

/**
 * Value-shape patterns.
 *
 * This is the layer that matters most: name-matching only finds secrets in
 * shapes someone anticipated, and the dangerous ones are pasted into fields
 * nobody labelled.
 */
const HIGH_ENTROPY: Array<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'JWT'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, 'GitHub token'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'API key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'Slack token'],
  [/Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, 'Bearer token'],
  [/\b[0-9a-fA-F]{32,}\b/g, 'hex'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, 'base64'],
];

/** Digit runs that pass Luhn — a card number in a checkout QA session is plausible. */
const DIGIT_RUN = /\b(?:\d[ -]?){12,18}\d\b/g;

export function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Classify a value without revealing it. Used for typed input, which is
 * withheld by default, and for the placeholder text elsewhere.
 */
export function describeValue(value: string): { chars: number; shape: string } {
  const chars = value.length;
  const v = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { chars, shape: 'email' };
  if (/^https?:\/\//i.test(v)) return { chars, shape: 'url' };
  if (/^eyJ[A-Za-z0-9_-]+\./.test(v)) return { chars, shape: 'jwt' };
  if (luhn(v)) return { chars, shape: 'card' };
  if (/^[0-9a-fA-F]{16,}$/.test(v)) return { chars, shape: `${v.length}-char hex` };
  if (/^[+\d][\d\s()-]{6,}$/.test(v)) return { chars, shape: 'phone' };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { chars, shape: 'number' };
  return { chars, shape: 'text' };
}

/**
 * Whether a form field must have its value withheld even when the user has
 * turned typed-value capture on. The toggle relaxes the default; it does not
 * disable detection.
 */
export function isSensitiveField(field: {
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  ariaLabel?: string | null;
  value?: string | null;
}): boolean {
  if (field.type?.toLowerCase() === 'password') return true;

  // `autocomplete` is the best signal available because it is standardised, so
  // it is checked before anything heuristic.
  const ac = field.autocomplete?.toLowerCase() ?? '';
  if (/current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/.test(ac)) return true;

  for (const attr of [field.name, field.id, field.ariaLabel]) {
    if (attr && (isSensitiveName(attr) || /\bcard\b|\bcvv\b|\bssn\b/i.test(attr))) return true;
  }

  // Last line: a secret pasted into a field nobody labelled.
  if (field.value && looksSecret(field.value)) return true;
  return false;
}

function looksSecret(value: string): boolean {
  for (const [pattern] of HIGH_ENTROPY) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return luhn(value);
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

export class DefaultRedactor implements Redactor {
  private counts = emptySummary();

  summary(): RedactionSummary {
    return {
      ...this.counts,
      headersRedacted: { ...this.counts.headersRedacted },
      urlParamsRedacted: { ...this.counts.urlParamsRedacted },
      bodyKeysRedacted: { ...this.counts.bodyKeysRedacted },
    };
  }

  /** Count a typed value the content script chose to withhold. */
  countWithheldValue(): void {
    this.counts.typedValuesWithheld += 1;
  }

  /**
   * URLs are the leak vector people forget, and they appear in navigation
   * events, every network row *and* `Referer` — so this is one shared
   * normaliser rather than three call sites each doing their own thing.
   *
   * The fragment matters as much as the query: OAuth implicit flow returns
   * `#access_token=...`, which never reaches a server but is very much on disk.
   */
  url(raw: string): string {
    if (!raw) return raw;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return raw; // relative or malformed — nothing to parse safely
    }

    for (const [key, value] of [...parsed.searchParams]) {
      if (isSensitiveName(key) || looksSecret(value)) {
        parsed.searchParams.set(key, `[redacted: ${describeValue(value).shape}]`);
        bump(this.counts.urlParamsRedacted, key.toLowerCase());
      }
    }

    if (parsed.hash.length > 1) {
      const frag = new URLSearchParams(parsed.hash.slice(1));
      let touched = false;
      for (const [key, value] of [...frag]) {
        if (isSensitiveName(key) || looksSecret(value)) {
          frag.set(key, `[redacted: ${describeValue(value).shape}]`);
          bump(this.counts.urlParamsRedacted, key.toLowerCase());
          touched = true;
        }
      }
      if (touched) parsed.hash = frag.toString();
    }

    return parsed.toString();
  }

  headers(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (isSensitiveName(lower)) {
        out[name] = headerPlaceholder(lower, value);
        bump(this.counts.headersRedacted, lower);
      } else if (looksSecret(value)) {
        out[name] = `[redacted: ${describeValue(value).shape}]`;
        bump(this.counts.headersRedacted, lower);
        this.counts.highEntropyMatches += 1;
      } else {
        out[name] = value;
      }
    }
    return out;
  }

  body(body: string, contentType: string | undefined): string {
    if (!body) return body;
    let out = body;

    // Structural pass first: JSON keys tell us what a value *is*, which the
    // entropy scan can only guess at.
    if (!contentType || /json/i.test(contentType)) {
      try {
        out = JSON.stringify(this.walkJson(JSON.parse(out)));
      } catch {
        // Not JSON after all — the text pass below still applies.
      }
    }

    return this.scrubText(out);
  }

  private walkJson(node: unknown): unknown {
    if (Array.isArray(node)) return node.map((n) => this.walkJson(n));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (isSensitiveName(key)) {
          out[key] =
            typeof value === 'string'
              ? `[redacted: ${describeValue(value).shape}]`
              : '[redacted]';
          bump(this.counts.bodyKeysRedacted, key.toLowerCase());
        } else {
          out[key] = this.walkJson(value);
        }
      }
      return out;
    }
    return node;
  }

  /**
   * Applies to every body regardless of format, because a secret can sit under
   * a perfectly innocuous key — or in form-encoded, XML or plain text where
   * there are no keys to inspect at all.
   */
  private scrubText(text: string): string {
    let out = text;
    for (const [pattern, label] of HIGH_ENTROPY) {
      out = out.replace(pattern, () => {
        this.counts.highEntropyMatches += 1;
        return `[redacted: ${label}]`;
      });
    }
    out = out.replace(DIGIT_RUN, (match) => {
      if (!luhn(match)) return match;
      this.counts.highEntropyMatches += 1;
      return '[redacted: card]';
    });
    return out;
  }
}

function headerPlaceholder(name: string, value: string): string {
  if (name === 'authorization' || name === 'proxy-authorization') {
    const scheme = value.split(/\s+/)[0];
    return scheme && /^[A-Za-z]+$/.test(scheme)
      ? `[redacted: ${scheme} ***]`
      : `[redacted: ${value.length} chars]`;
  }
  if (name === 'cookie' || name === 'set-cookie') {
    const count = value.split(';').filter((p) => p.includes('=')).length;
    return `[redacted: ${count} cookie${count === 1 ? '' : 's'}, ${value.length} chars]`;
  }
  return `[redacted: ${value.length} chars]`;
}

/**
 * Explicitly does nothing. Kept so a test or a debugging build can opt out
 * visibly rather than by omission — never wire this into a real session.
 */
export const NO_REDACTION: Redactor = {
  url: (url) => url,
  headers: (headers) => headers,
  body: (body) => body,
  summary: emptySummary,
};
