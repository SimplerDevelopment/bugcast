/**
 * Identifying the element a user interacted with.
 *
 * Every selector is emitted rather than one being ranked and picked. Ranking
 * discards what a different consumer needed — a Playwright agent wants
 * `getByRole`, a human reading the artifact wants the CSS path, a test author
 * wants the testid — and together they cost a few hundred bytes against a webm.
 *
 * `selector` holds the best available *identifier*, which is not always a CSS
 * selector: role and text kinds use Playwright's locator syntax, because that
 * is the form an agent can act on. `css` is always present as the fallback.
 *
 * Design: docs/design/issues/06-capture-mechanism-decision.md
 */

import type { Target } from './events';

const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa'];

/** CSS identifiers that need no escaping — anything else goes through [id='…']. */
const SIMPLE_IDENT = /^[A-Za-z][\w-]*$/;

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Accessible name, the lazy way.
 *
 * ponytail: the AccName spec is a long algorithm; this chain covers the
 * overwhelming majority of real controls. Upgrade path is the spec itself, and
 * the symptom that would justify it is names coming out empty or wrong in real
 * artifacts.
 */
export function accessibleName(el: Element): string | null {
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }

  const id = el.getAttribute('id');
  if (id) {
    const label = el.ownerDocument.querySelector(`label[for=${quote(id)}]`);
    const text = label?.textContent?.trim();
    if (text) return text;
  }

  const wrapping = el.closest('label')?.textContent?.trim();
  if (wrapping) return wrapping;

  for (const attr of ['alt', 'title', 'placeholder']) {
    const value = el.getAttribute(attr)?.trim();
    if (value) return value;
  }

  // Text content is a name for a button or a link. For a form control it is
  // not: a <select>'s text is every option concatenated, which produced the
  // accessible name "draftpublished" in a real run.
  if (/^(input|select|textarea)$/.test(el.tagName.toLowerCase())) return null;

  const text = el.textContent?.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 120) : null;
}

/** A path good enough to re-find the element, stopping early at any id. */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  while (node && node.nodeType === 1 && parts.length < 8) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') break;

    const id = node.getAttribute('id');
    if (id && SIMPLE_IDENT.test(id)) {
      parts.unshift(`#${id}`);
      break; // an id is unique — everything above it is noise
    }

    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = [...parent.children].filter((c) => c.tagName === node!.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    node = parent;
  }

  return parts.join(' > ');
}

export function bestSelector(el: Element): { selector: string; kind: Target['selectorKind'] } {
  for (const attr of TEST_ID_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return { selector: `[${attr}=${quote(value)}]`, kind: 'testid' };
  }

  const id = el.getAttribute('id');
  if (id) {
    return { selector: SIMPLE_IDENT.test(id) ? `#${id}` : `[id=${quote(id)}]`, kind: 'id' };
  }

  // Playwright locator syntax, not CSS — this is the form an agent acts on,
  // and `css` below carries the CSS fallback regardless.
  const role = implicitRole(el);
  const name = accessibleName(el);
  if (role && name) return { selector: `role=${role}[name="${name}"]`, kind: 'role' };
  // Leaf elements only. A container's "name" is every descendant's text run
  // together, which produced `text="Quote draftpublished Pin it Save changes…"`
  // for a <main> — a selector that identifies the whole page.
  if (name && name.length <= 60 && el.children.length === 0) {
    return { selector: `text="${name}"`, kind: 'text' };
  }

  return { selector: cssPath(el), kind: 'css' };
}

/** Explicit role wins; otherwise the handful of implicit ones worth knowing. */
export function implicitRole(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'form') return 'form';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return type;
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (type === 'search') return 'searchbox';
    if (type === 'hidden') return null;
    return 'textbox';
  }
  return null;
}

export function describeTarget(el: Element): Target {
  const { selector, kind } = bestSelector(el);
  const rect = el.getBoundingClientRect?.() ?? { x: 0, y: 0, width: 0, height: 0 };
  return {
    selector,
    selectorKind: kind,
    css: cssPath(el),
    role: implicitRole(el),
    name: accessibleName(el),
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120),
    id: el.getAttribute('id'),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
    frameUrl: el.ownerDocument.location?.href ?? '',
  };
}

/**
 * Whether a keydown is worth recording.
 *
 * Per-character typing is the noise firehose, and the typed *value* arrives via
 * `change` anyway — so single printable characters are dropped unless a
 * modifier makes them a shortcut. Bare modifier presses are never interesting.
 */
export function isInterestingKey(key: string, mods: { ctrl: boolean; meta: boolean; alt: boolean }): boolean {
  if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return false;
  if (mods.ctrl || mods.meta || mods.alt) return true;
  return key.length > 1; // named keys: Enter, Escape, Tab, ArrowUp, …
}
