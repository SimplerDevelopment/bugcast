import { useCallback, useEffect, useState } from 'react';
import {
  fileSystemAccessAvailable,
  permissionState,
  pickSessionDirectory,
  requestPermission,
  storedSessionDirectory,
} from '../lib/session-store';
import { DEFAULT_TIER, MODELS, type ModelTier } from '../offscreen/transcribe';
import {
  DROP_MARKER,
  RECORDING_STATE,
  START_RECORDING,
  STOP_RECORDING,
} from '../background/messages';

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

const TIER_LABELS: Record<ModelTier, string> = {
  'tiny.en': 'Tiny — fastest, roughest (~75 MB)',
  'base.en': 'Base — recommended (~145 MB)',
  'small.en': 'Small — most accurate, slowest (~470 MB)',
};

export function App() {
  const [recording, setRecording] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [tier, setTier] = useState<ModelTier>(DEFAULT_TIER);
  const [video, setVideo] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      const [state, handle, stored] = await Promise.all([
        chrome.runtime.sendMessage({ type: RECORDING_STATE }).catch(() => null),
        storedSessionDirectory(),
        chrome.storage.local.get(['modelTier', 'video']),
      ]);
      setRecording(Boolean(state?.recording));
      setFolder(handle?.name ?? null);
      setTier((stored?.modelTier as ModelTier) ?? DEFAULT_TIER);
      setVideo(stored?.video !== false);
      setReady(true);
    })();
  }, []);

  const choose = useCallback(async () => {
    setError(null);
    try {
      setFolder((await pickSessionDirectory()).name);
    } catch (e) {
      // An aborted picker is a decision, not a failure.
      if ((e as Error)?.name !== 'AbortError') setError(String((e as Error).message));
    }
  }, []);

  const chooseTier = useCallback(async (next: ModelTier) => {
    setTier(next);
    await chrome.storage.local.set({ modelTier: next });
  }, []);

  const toggleVideo = useCallback(async (next: boolean) => {
    setVideo(next);
    await chrome.storage.local.set({ video: next });
  }, []);

  const mark = useCallback(async () => {
    await chrome.runtime.sendMessage({ type: DROP_MARKER, note: 'This is the bug' });
    setNote('Marked.');
    setTimeout(() => setNote(null), 1500);
  }, []);

  const toggle = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (recording) {
        const res = await chrome.runtime.sendMessage({ type: STOP_RECORDING });
        setRecording(false);
        if (res?.error) setError(res.error);
        else if (res?.written) setNote(`Saved to ${res.written}`);
        return;
      }

      const handle = await storedSessionDirectory();
      if (!handle) {
        setError('Choose a folder for sessions first.');
        return;
      }
      // Re-granting needs a user gesture, so it happens here and not in the
      // worker. Expect it after a browser restart even though the handle itself
      // survived — the grant does not persist with it.
      if ((await permissionState(handle)) !== 'granted' && !(await requestPermission(handle))) {
        setError('Bugcast needs write access to that folder to save the session.');
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      // Per-origin host permission, requested here because it needs a gesture.
      // It is what lets interaction capture survive a navigation — activeTab
      // alone cannot back registerContentScripts.
      const origin = originOf(tab?.url);
      if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
        await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      }

      const res = await chrome.runtime.sendMessage({
        type: START_RECORDING,
        tabId: tab?.id,
        pageUrl: tab?.url,
        title: tab?.title,
        video,
      });
      if (res?.error) setError(res.error);
      else {
        setRecording(true);
        if (res?.captureError) setNote(`Recording without video: ${res.captureError}`);
      }
    } finally {
      setBusy(false);
    }
  }, [recording, video]);

  if (!fileSystemAccessAvailable()) {
    return (
      <Shell>
        <p className="text-xs text-red-600">
          This browser blocks the File System Access API, which Bugcast needs to write sessions.
          Enterprise policy is the usual cause.
        </p>
      </Shell>
    );
  }

  if (!ready) return <Shell />;

  // First run is one dialog, deliberately. It is the only moment the model
  // download can be explained before it happens, so folder, quality and that
  // explanation belong together rather than as three separate interruptions.
  if (!folder) {
    return (
      <Shell>
        <p className="text-xs text-neutral-600">
          Sessions are written to a folder you choose. Nothing is uploaded — transcription runs on
          this machine.
        </p>
        <button
          onClick={choose}
          className="w-full rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800"
        >
          Choose a folder for sessions
        </button>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700">Transcription quality</span>
          <select
            value={tier}
            onChange={(e) => void chooseTier(e.target.value as ModelTier)}
            className="w-full rounded border border-neutral-300 px-2 py-1 text-xs"
          >
            {(Object.keys(MODELS) as ModelTier[]).map((t) => (
              <option key={t} value={t}>
                {TIER_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] leading-snug text-neutral-500">
          The speech model downloads once, the first time you record with a microphone, and is
          cached after that. To stay fully offline, place the model files in the folder yourself —
          see the README.
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </Shell>
    );
  }

  return (
    <Shell>
      <button
        onClick={toggle}
        disabled={busy}
        className={`w-full rounded px-3 py-2 text-sm font-medium text-white disabled:opacity-40 ${
          recording ? 'bg-red-600 hover:bg-red-700' : 'bg-neutral-900 hover:bg-neutral-800'
        }`}
      >
        {recording ? 'Stop recording' : 'Record'}
      </button>

      {recording ? (
        <button
          onClick={mark}
          className="w-full rounded border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50"
        >
          Mark this moment <span className="text-neutral-400">⌘⇧M</span>
        </button>
      ) : (
        <label className="flex items-center gap-2 text-xs text-neutral-600">
          <input type="checkbox" checked={video} onChange={(e) => void toggleVideo(e.target.checked)} />
          Record video
        </label>
      )}

      <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
        <span className="truncate">Saving to {folder}</span>
        <button onClick={choose} className="shrink-0 underline hover:text-neutral-900">
          Change
        </button>
      </div>

      {note && <p className="text-xs text-neutral-600 break-all">{note}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </Shell>
  );
}

function Shell({ children }: { children?: React.ReactNode }) {
  return (
    <main className="w-72 space-y-3 p-4">
      <h1 className="text-sm font-semibold">Bugcast</h1>
      {children}
    </main>
  );
}
