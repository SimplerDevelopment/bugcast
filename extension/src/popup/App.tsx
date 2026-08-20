import { useCallback, useEffect, useState } from 'react';
import {
  fileSystemAccessAvailable,
  permissionState,
  pickSessionDirectory,
  requestPermission,
  storedSessionDirectory,
} from '../lib/session-store';
import { RECORDING_STATE, START_RECORDING, STOP_RECORDING } from '../background/messages';

/** `https://app.example.com/*`, or null for a page that cannot be recorded. */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol, host } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? `${protocol}//${host}/*` : null;
  } catch {
    return null;
  }
}

export function App() {
  const [recording, setRecording] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void chrome.runtime
      .sendMessage({ type: RECORDING_STATE })
      .then((r) => setRecording(Boolean(r?.recording)))
      .catch(() => {});
    void storedSessionDirectory().then((h) => setFolder(h?.name ?? null));
  }, []);

  const choose = useCallback(async () => {
    setError(null);
    try {
      const handle = await pickSessionDirectory();
      setFolder(handle.name);
    } catch (e) {
      // An aborted picker is a decision, not a failure.
      if ((e as Error)?.name !== 'AbortError') setError(String((e as Error).message));
    }
  }, []);

  const toggle = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (recording) {
        const res = await chrome.runtime.sendMessage({ type: STOP_RECORDING });
        if (res?.error) setError(res.error);
        setRecording(false);
        return;
      }

      // Re-granting needs a user gesture, so it has to happen here and not in
      // the worker. Expect this after a browser restart even though the handle
      // itself survived — the grant does not persist with it.
      const handle = await storedSessionDirectory();
      if (!handle) {
        setError('Choose a folder for sessions first.');
        return;
      }
      if ((await permissionState(handle)) !== 'granted' && !(await requestPermission(handle))) {
        setError('Bugcast needs write access to that folder to save the session.');
        return;
      }

      // Per-origin host permission, requested here because it needs a user
      // gesture. It is what lets interaction capture survive a navigation —
      // activeTab alone cannot back registerContentScripts.
      const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
      const origin = originOf(current?.url);
      if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
        await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      }

      // Read the tab here and pass it along — the active tab can change between
      // this query and the worker's, and tab.url is not readable in the worker
      // without the broad `tabs` permission.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res = await chrome.runtime.sendMessage({
        type: START_RECORDING,
        tabId: tab?.id,
        pageUrl: tab?.url,
      });
      if (res?.error) setError(res.error);
      else setRecording(true);
    } finally {
      setBusy(false);
    }
  }, [recording]);

  if (!fileSystemAccessAvailable()) {
    return (
      <main className="p-4 space-y-2">
        <h1 className="text-sm font-semibold">Bugcast</h1>
        <p className="text-xs text-red-600">
          This browser blocks the File System Access API, which Bugcast needs to write sessions.
          Enterprise policy is the usual cause.
        </p>
      </main>
    );
  }

  return (
    <main className="p-4 space-y-3">
      <h1 className="text-sm font-semibold">Bugcast</h1>

      <button
        onClick={toggle}
        disabled={busy || !folder}
        className={`w-full rounded px-3 py-2 text-sm font-medium text-white disabled:opacity-40 ${
          recording ? 'bg-red-600 hover:bg-red-700' : 'bg-neutral-900 hover:bg-neutral-800'
        }`}
      >
        {recording ? 'Stop recording' : 'Record'}
      </button>

      <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
        <span className="truncate">{folder ? `Saving to ${folder}` : 'No folder chosen'}</span>
        <button onClick={choose} className="shrink-0 underline hover:text-neutral-900">
          {folder ? 'Change' : 'Choose folder'}
        </button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
    </main>
  );
}
