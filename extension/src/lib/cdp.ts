/**
 * chrome.debugger / CDP session lifecycle.
 *
 * CDP is not one option among several — it is the only mechanism that sees the
 * network below JS. An isolated-world content script patches its own `window`,
 * so it never touches the page's real `fetch`/`console`/XHR; MAIN-world
 * injection fixes that but stays structurally blind to service workers, web
 * workers, `sendBeacon`, and `<img>`/CSS-initiated loads.
 *
 * Design: docs/design/issues/02, /06
 */

/** Flattened auto-attach adds `sessionId` to the event source. */
export type Source = chrome.debugger.Debuggee & { sessionId?: string };

type Handler = (params: any, source: Source) => void;

const PROTOCOL_VERSION = '1.3';

export class CdpSession {
  private tabId: number | null = null;
  private handlers = new Map<string, Handler[]>();
  private onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== this.tabId) return;
    for (const h of this.handlers.get(method) ?? []) h(params ?? {}, source as Source);
  };
  private onDetach = (source: chrome.debugger.Debuggee) => {
    if (source.tabId === this.tabId) this.tabId = null;
    this.detachedCallback?.();
  };

  /** Called if the debugger goes away underneath us — e.g. the user hits Cancel. */
  detachedCallback?: () => void;

  on(method: string, handler: Handler): void {
    const list = this.handlers.get(method);
    if (list) list.push(handler);
    else this.handlers.set(method, [handler]);
  }

  /**
   * Attach, then enable every domain the capture needs.
   *
   * Throws with an actionable message rather than degrading. A session missing
   * network and console is indistinguishable, to the agent that later reads it,
   * from a session where nothing failed — so it would confidently conclude the
   * wrong thing. Failing loudly costs one retry; failing quietly costs a wrong
   * diagnosis. (docs/design/issues/06)
   */
  async attach(tabId: number): Promise<void> {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (cause) {
      const message = String((cause as Error)?.message ?? cause);
      // One debugger client per target, so an open DevTools window is the
      // overwhelmingly common cause and deserves the specific instruction.
      throw new Error(
        /another debugger|already attached/i.test(message)
          ? 'DevTools is attached to this tab — close it and try again.'
          : `Could not attach to this tab: ${message}`,
        { cause },
      );
    }

    this.tabId = tabId;
    chrome.debugger.onEvent.addListener(this.onEvent);
    chrome.debugger.onDetach.addListener(this.onDetach);

    await this.send('Network.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Page.enable');

    // Service-worker traffic is invisible without this — the spike saw only the
    // document URL, not even /sw.js. Child targets then need their own
    // Network.enable, which `Target.attachedToTarget` below drives.
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    this.on('Target.attachedToTarget', ({ sessionId }: { sessionId: string }) => {
      // Child targets die and respawn freely; a failure here must not take the
      // session down, so this is best-effort by design.
      void this.send('Network.enable', {}, sessionId).catch(() => {});
    });
  }

  async send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.tabId === null) throw new Error(`CDP not attached (sending ${method})`);
    const target = { tabId: this.tabId, ...(sessionId ? { sessionId } : {}) };
    return (await chrome.debugger.sendCommand(target, method, params)) as T;
  }

  async detach(): Promise<void> {
    chrome.debugger.onEvent.removeListener(this.onEvent);
    chrome.debugger.onDetach.removeListener(this.onDetach);
    const tabId = this.tabId;
    this.tabId = null;
    this.handlers.clear();
    // Already gone is the expected case when the user dismissed the infobar.
    if (tabId !== null) await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  get attached(): boolean {
    return this.tabId !== null;
  }
}
