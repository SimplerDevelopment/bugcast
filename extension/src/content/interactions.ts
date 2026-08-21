/**
 * Interaction capture.
 *
 * Isolated world, all frames. **Not** MAIN world: isolated worlds get their own
 * JS realm but share the DOM, which is all this needs. Registering at
 * `document_start` on `window` in the capture phase means it runs before any
 * page handler, so a page calling `stopPropagation()` cannot hide an
 * interaction from it.
 *
 * Six event types, and every exclusion is deliberate: no `hover` (enormous
 * volume, near-zero information), no continuous `scroll` (the video shows it),
 * no per-keystroke `input` (the value arrives on `change`).
 *
 * Design: docs/design/issues/06-capture-mechanism-decision.md
 */

import { describeTarget, isInterestingKey } from '../lib/dom-target';
import { describeValue, isSensitiveField } from '../lib/redact';
import { INTERACTION } from '../background/messages';

/** Below this, a pointer gesture is a click that wobbled, not a drag. */
const DRAG_THRESHOLD_PX = 5;

/** A focus arriving within this of a click on the same element is that click. */
const FOCUS_ECHO_MS = 300;

/**
 * Whether the user opted into capturing typed values.
 *
 * Read once at injection. Content scripts can reach extension storage directly,
 * so this does not need to travel through the worker — and reading it per event
 * would put an async hop inside a capture-phase listener.
 */
let captureTypedValues = false;

/**
 * Whether this script still has a live extension behind it.
 *
 * Reloading the extension does not remove content scripts already injected into
 * open pages — they keep running with a dead context, and every `chrome.*` call
 * then throws **synchronously** with "Extension context invalidated". A
 * `.catch()` does not help: there is no promise, the throw escapes into the
 * page, and the page's console fills with errors from the tool that is supposed
 * to be *recording* that console.
 */
let alive = true;

(() => {
  const w = window as unknown as { __bugcast?: boolean };
  if (w.__bugcast) return; // injection can race a navigation
  w.__bugcast = true;

  const listeners: Array<[keyof WindowEventMap, EventListener]> = [];

  /**
   * Stop cleanly once the extension is gone.
   *
   * Without this every subsequent click, keypress and scroll would throw again
   * — an orphaned script quietly vandalising a page it can no longer report on.
   */
  const teardown = (): void => {
    if (!alive) return;
    alive = false;
    for (const [type, handler] of listeners) {
      window.removeEventListener(type, handler, { capture: true } as EventListenerOptions);
    }
    listeners.length = 0;
    w.__bugcast = false; // let a fresh injection take over this page
  };

  /** `chrome.runtime.id` is undefined once the context has been invalidated. */
  const contextGone = (): boolean => {
    try {
      return !chrome?.runtime?.id;
    } catch {
      return true;
    }
  };

  try {
    void chrome.storage.local
      .get('typedValues')
      .then((s) => (captureTypedValues = s?.typedValues === true))
      .catch(() => {});
  } catch {
    teardown();
    return;
  }

  const send = (kind: string, payload: Record<string, unknown>): void => {
    if (!alive) return;
    if (contextGone()) return teardown();
    // try/catch, not just .catch(): an invalidated context throws
    // synchronously, so there is no promise to reject. Nothing this script does
    // may ever surface in the page being recorded.
    try {
      void chrome.runtime
        .sendMessage({ type: INTERACTION, kind, epochMs: Date.now(), ...payload })
        .catch(() => {});
    } catch {
      teardown();
    }
  };

  const on = <K extends keyof WindowEventMap>(
    type: K,
    handler: (e: WindowEventMap[K]) => void,
  ): void => {
    // Wrapped so a throw anywhere in capture cannot reach the page, and kept so
    // teardown can remove it.
    const guarded = ((e: Event) => {
      if (!alive) return;
      try {
        handler(e as WindowEventMap[K]);
      } catch {
        // A single malformed element must not break capture, and must not
        // surface in the console being recorded.
      }
    }) as EventListener;
    listeners.push([type, guarded]);
    window.addEventListener(type, guarded, { capture: true, passive: true });
  };

  const elementOf = (e: Event): Element | null => {
    // composedPath sees through open shadow roots; a *closed* root retargets to
    // its host and no mechanism can do better, MAIN world included.
    const path = e.composedPath?.();
    const first = path?.[0] as Element | undefined;
    const node = first ?? (e.target as Element | null);
    return node?.nodeType === 1 ? node : (node as any)?.parentElement ?? null;
  };

  /**
   * Set on pointerdown, which is what focus dedupe keys off.
   *
   * The obvious implementation — remember the last click and drop a focus that
   * follows it — never fires, because focus happens on *mousedown* and so
   * arrives strictly before the click. A mouse-driven focus is always preceded
   * by a pointerdown on the same element; a keyboard-driven one never is.
   */
  let lastPointerDown: { el: Element; at: number } | null = null;

  on('click', (e) => {
    const el = elementOf(e);
    if (el) send('click', { target: describeTarget(el) });
  });

  on('keydown', (e) => {
    const mods = { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey };
    if (!isInterestingKey(e.key, mods)) return;
    const el = elementOf(e);
    if (!el) return;
    send('keydown', {
      key: e.key,
      modifiers: Object.entries({ ...mods, shift: e.shiftKey })
        .filter(([, on]) => on)
        .map(([name]) => name),
      target: describeTarget(el),
    });
  });

  on('change', (e) => {
    const el = elementOf(e);
    if (!el) return;
    send('change', { target: describeTarget(el), value: describeFieldValue(el) });
  });

  on('submit', (e) => {
    const el = elementOf(e);
    if (el) send('submit', { target: describeTarget(el) });
  });

  /**
   * Focus is recorded only when it was *not* the echo of a click, which leaves
   * the keyboard-driven moves — the tab-order and focus-trap bugs that justify
   * the event. Unfiltered it would duplicate every click.
   */
  on('focusin', (e) => {
    const el = elementOf(e);
    if (!el) return;
    if (
      lastPointerDown &&
      (lastPointerDown.el === el || el.contains(lastPointerDown.el)) &&
      Date.now() - lastPointerDown.at < FOCUS_ECHO_MS
    ) {
      return;
    }
    send('focus', { target: describeTarget(el) });
  });

  // --- drag, both mechanisms ------------------------------------------------
  // HTML5 drag events fire only for natively `draggable` elements. dnd-kit,
  // react-beautiful-dnd and every pointer-based editor dispatch none of them,
  // so listening for native drag alone would capture nothing in exactly the
  // cases that motivate capturing drag at all.

  let nativeDrag: { target: Element; at: number } | null = null;
  let nativeDragEndedAt = 0;

  const emitNativeDrag = (to: Element | null, x: number, y: number): void => {
    if (!nativeDrag) return;
    send('drag', {
      mechanism: 'native',
      startedAt: nativeDrag.at,
      from: { target: describeTarget(nativeDrag.target) },
      to: { target: describeTarget(to ?? nativeDrag.target), point: { x, y } },
    });
    nativeDrag = null;
    nativeDragEndedAt = Date.now();
  };

  on('dragstart', (e) => {
    const el = elementOf(e);
    if (el) nativeDrag = { target: el, at: Date.now() };
  });

  on('drop', (e) => {
    const me = e as unknown as MouseEvent;
    emitNativeDrag(elementOf(e), me.clientX, me.clientY);
  });

  /**
   * `drop` only fires when the target opted in by calling preventDefault on
   * dragover — so dragging onto anything that is not a registered drop zone
   * produces no drop at all, and the gesture would vanish. `dragend` always
   * fires, so it is the reliable terminator.
   */
  on('dragend', (e) => {
    const me = e as unknown as MouseEvent;
    emitNativeDrag(
      document.elementFromPoint(me.clientX, me.clientY),
      me.clientX,
      me.clientY,
    );
  });

  let pointer: { target: Element; x: number; y: number; at: number; dragging: boolean } | null = null;

  on('pointerdown', (e) => {
    const el = elementOf(e);
    if (!el) return;
    lastPointerDown = { el, at: Date.now() };
    pointer = { target: el, x: e.clientX, y: e.clientY, at: Date.now(), dragging: false };
  });

  on('pointermove', (e) => {
    if (!pointer || pointer.dragging) return;
    if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > DRAG_THRESHOLD_PX) {
      pointer.dragging = true;
    }
  });

  on('pointerup', (e) => {
    const start = pointer;
    pointer = null;
    if (!start?.dragging) return;
    // A native drag reported this same gesture. The window matters because
    // dragend clears `nativeDrag` and can land before pointerup.
    if (nativeDrag || Date.now() - nativeDragEndedAt < 1000) return;
    const to = elementOf(e);
    send('drag', {
      mechanism: 'pointer',
      startedAt: start.at,
      from: { target: describeTarget(start.target) },
      to: {
        target: describeTarget(to ?? start.target),
        point: { x: e.clientX, y: e.clientY },
      },
    });
  });

  on('pointercancel', () => {
    pointer = null;
  });
})();

/**
 * What a field's value becomes in the timeline.
 *
 * Free-text values are withheld by default and replaced with a shape
 * descriptor, because a heuristic that misses one field leaks a credential
 * silently and irreversibly, while the safe default merely costs a re-record.
 *
 * Selects, checkboxes and radios are different and are recorded in full: their
 * possible values are a fixed list already sitting in the page's own markup, so
 * withholding the chosen one protects nothing and loses a great deal.
 */
function describeFieldValue(
  el: Element,
): { redacted: true; chars: number; shape: string } | { redacted: false; value: string } {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();

  if (type === 'checkbox' || type === 'radio') {
    return { redacted: false, value: (el as HTMLInputElement).checked ? 'checked' : 'unchecked' };
  }
  if (tag === 'select') {
    const select = el as HTMLSelectElement;
    return { redacted: false, value: select.selectedOptions?.[0]?.text?.trim() ?? select.value };
  }

  const value = (el as HTMLInputElement).value ?? '';
  // Detection runs regardless: the setting relaxes the default, it does not
  // disable the check. A password stays withheld even with capture turned on.
  if (
    isSensitiveField({
      type,
      autocomplete: el.getAttribute('autocomplete'),
      name: el.getAttribute('name'),
      id: el.getAttribute('id'),
      ariaLabel: el.getAttribute('aria-label'),
      value,
    })
  ) {
    // Even the shape is withheld here — "card" or "jwt" is itself a disclosure.
    return { redacted: true, chars: value.length, shape: 'sensitive' };
  }
  if (captureTypedValues) return { redacted: false, value };
  return { redacted: true, ...describeValue(value) };
}
