// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accessibleName,
  bestSelector,
  cssPath,
  describeTarget,
  implicitRole,
  isInterestingKey,
} from './dom-target';

const html = (markup: string): Element => {
  document.body.innerHTML = markup;
  return document.body.firstElementChild!;
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('bestSelector ranking', () => {
  it('prefers a test id over everything else', () => {
    const el = html('<button data-testid="editor-save" id="save" aria-label="Save">Save</button>');
    expect(bestSelector(el)).toEqual({ selector: "[data-testid='editor-save']", kind: 'testid' });
  });

  it('accepts the other test-id conventions', () => {
    for (const attr of ['data-test', 'data-cy', 'data-qa']) {
      const el = html(`<button ${attr}="x">go</button>`);
      expect(bestSelector(el).kind, attr).toBe('testid');
    }
  });

  it('falls to id, then role+name, then text, then css', () => {
    expect(bestSelector(html('<button id="save">Save</button>'))).toEqual({
      selector: '#save',
      kind: 'id',
    });
    expect(bestSelector(html('<button>Save changes</button>'))).toEqual({
      selector: 'role=button[name="Save changes"]',
      kind: 'role',
    });
    expect(bestSelector(html('<span>Just text</span>'))).toEqual({
      selector: 'text="Just text"',
      kind: 'text',
    });
    expect(bestSelector(html('<div></div>')).kind).toBe('css');
  });

  it('escapes quotes rather than producing a broken selector', () => {
    const el = html(`<button data-testid="it's here">x</button>`);
    expect(bestSelector(el).selector).toBe("[data-testid='it\\'s here']");
  });

  it('brackets an id that is not a legal bare CSS identifier', () => {
    const el = html('<button id="1weird:id">x</button>');
    expect(bestSelector(el).selector).toBe("[id='1weird:id']");
  });
});

describe('accessibleName', () => {
  it('prefers aria-label', () => {
    expect(accessibleName(html('<button aria-label="Close dialog">x</button>'))).toBe('Close dialog');
  });

  it('resolves aria-labelledby, including multiple ids', () => {
    document.body.innerHTML =
      '<span id="a">Delete</span><span id="b">post</span><button aria-labelledby="a b">x</button>';
    expect(accessibleName(document.querySelector('button')!)).toBe('Delete post');
  });

  it('finds a label[for] association', () => {
    document.body.innerHTML = '<label for="q">Quote</label><textarea id="q"></textarea>';
    expect(accessibleName(document.querySelector('textarea')!)).toBe('Quote');
  });

  it('finds a wrapping label', () => {
    document.body.innerHTML = '<label>Email <input type="email"></label>';
    expect(accessibleName(document.querySelector('input')!)).toBe('Email');
  });

  it('falls back to placeholder, then text', () => {
    expect(accessibleName(html('<input placeholder="you@example.com">'))).toBe('you@example.com');
    expect(accessibleName(html('<button>  Save   changes </button>'))).toBe('Save changes');
  });

  it('is null when there is nothing to name it with', () => {
    expect(accessibleName(html('<div></div>'))).toBeNull();
  });
});

describe('cssPath', () => {
  it('stops at the nearest id, because everything above it is noise', () => {
    document.body.innerHTML = '<main><div id="canvas"><section><b>x</b></section></div></main>';
    expect(cssPath(document.querySelector('b')!)).toBe('#canvas > section > b');
  });

  it('disambiguates siblings with nth-of-type but not unique children', () => {
    document.body.innerHTML = '<ul><li>a</li><li>b</li></ul>';
    expect(cssPath(document.querySelectorAll('li')[1]!)).toBe('ul > li:nth-of-type(2)');
    document.body.innerHTML = '<ul><li>only</li></ul>';
    expect(cssPath(document.querySelector('li')!)).toBe('ul > li');
  });

  it('produces a path that actually re-finds the element', () => {
    document.body.innerHTML = '<main><form><button>a</button><button>b</button></form></main>';
    const el = document.querySelectorAll('button')[1]!;
    expect(document.querySelector(cssPath(el))).toBe(el);
  });
});

describe('implicitRole', () => {
  it('lets an explicit role win', () => {
    expect(implicitRole(html('<div role="tab">x</div>'))).toBe('tab');
  });

  it('maps input types, which is where the interesting variation is', () => {
    expect(implicitRole(html('<input type="checkbox">'))).toBe('checkbox');
    expect(implicitRole(html('<input type="submit">'))).toBe('button');
    expect(implicitRole(html('<input type="search">'))).toBe('searchbox');
    expect(implicitRole(html('<input>'))).toBe('textbox');
    expect(implicitRole(html('<input type="hidden">'))).toBeNull();
  });

  it('only calls an anchor a link when it has an href', () => {
    expect(implicitRole(html('<a href="/x">x</a>'))).toBe('link');
    expect(implicitRole(html('<a>x</a>'))).toBeNull();
  });
});

describe('describeTarget', () => {
  it('emits every identifier, not just the winning one', () => {
    document.body.innerHTML =
      '<main><form><button data-testid="editor-save" class="btn">Save changes</button></form></main>';
    const t = describeTarget(document.querySelector('button')!);
    expect(t.selector).toBe("[data-testid='editor-save']");
    expect(t.selectorKind).toBe('testid');
    expect(t.css).toBe('main > form > button');
    expect(t.role).toBe('button');
    expect(t.name).toBe('Save changes');
    expect(t.tag).toBe('button');
    expect(t.text).toBe('Save changes');
    expect(t.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('caps text so one verbose element cannot bloat the timeline', () => {
    const t = describeTarget(html(`<div>${'x'.repeat(500)}</div>`));
    expect(t.text).toHaveLength(120);
  });
});

describe('isInterestingKey', () => {
  const none = { ctrl: false, meta: false, alt: false };

  it('keeps named keys', () => {
    for (const k of ['Enter', 'Escape', 'Tab', 'ArrowUp', 'Backspace']) {
      expect(isInterestingKey(k, none), k).toBe(true);
    }
  });

  it('drops per-character typing — the value arrives via change instead', () => {
    for (const k of ['a', 'Z', '4', ' ']) expect(isInterestingKey(k, none), k).toBe(false);
  });

  it('keeps a character when a modifier makes it a shortcut', () => {
    expect(isInterestingKey('k', { ...none, meta: true })).toBe(true);
  });

  it('drops bare modifier presses, which are never the interesting part', () => {
    for (const k of ['Shift', 'Control', 'Alt', 'Meta']) {
      expect(isInterestingKey(k, { ctrl: true, meta: false, alt: false }), k).toBe(false);
    }
  });
});

describe('regressions caught by the smoke test', () => {
  it('never names a form control after its own text content', () => {
    // A <select>'s textContent is every option concatenated, which produced the
    // accessible name "draftpublished" in a real run.
    document.body.innerHTML = '<select name="status"><option>draft</option><option>published</option></select>';
    expect(accessibleName(document.querySelector('select')!)).toBeNull();
    expect(bestSelector(document.querySelector('select')!).kind).toBe('css');
  });

  it('still names a form control from a real label', () => {
    document.body.innerHTML = '<label for="s">Status</label><select id="s"><option>a</option></select>';
    expect(accessibleName(document.querySelector('select')!)).toBe('Status');
  });

  it('does not use a text selector for a container', () => {
    // Its "name" is every descendant's text, so the selector would match the page.
    document.body.innerHTML = '<main><span>Quote</span><span>Save</span></main>';
    expect(bestSelector(document.querySelector('main')!).kind).toBe('css');
    expect(bestSelector(document.querySelector('span')!).kind).toBe('text');
  });
});
