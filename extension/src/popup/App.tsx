import { useCallback, useEffect, useState } from 'react';
import {
  fileSystemAccessAvailable,
  permissionState,
  pickSessionDirectory,
  requestPermission,
  storedSessionDirectory,
} from '../lib/session-store';
import { DEFAULT_TIER, MODELS, type ModelTier } from '../offscreen/transcribe';
import type { CheckResult } from '../lib/self-test';
import {
  DROP_MARKER,
  RECORDING_STATE,
  RUN_SELF_TEST,
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

// Sizes are the full-precision encoder plus the quantised decoder that actually
// ships — see DTYPE. They went up when the encoder stopped being quantised,
// which is the trade that fixed transcription quality.
const TIER_LABELS: Record<ModelTier, string> = {
  'tiny.en': 'Tiny — fastest, roughest (~45 MB)',
  'base.en': 'Base — recommended (~105 MB)',
  'small.en': 'Small — most accurate, slowest (~340 MB)',
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
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [last, setLast] = useState<{
    id: string; written: string | null; writeError: string | null; events: number; frames: number;
    video?: boolean; videoBytes?: number;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [mic, setMic] = useState<PermissionState | 'unknown'>('unknown');
  const [shortcuts, setShortcuts] = useState<chrome.commands.Command[]>([]);

  useEffect(() => {
    // Storage first, and rendered immediately from it. The worker's answer is
    // reconciled after, best-effort, with a deadline.
    //
    // This used to gate the whole UI on sendMessage(RECORDING_STATE). A busy or
    // terminated service worker never answers, `.catch` does not fire on a hang
    // only on a rejection, and the popup opened showing nothing but its title —
    // no Stop button, mid-recording. The one moment the UI must work is the one
    // where it did not.
    void (async () => {
      const stored = await chrome.storage.local.get([
        'modelTier',
        'video',
        'lastSession',
        'recording',
      ]);
      setRecording(Boolean(stored?.recording));
      setTier((stored?.modelTier as ModelTier) ?? DEFAULT_TIER);
      setVideo(stored?.video !== false);
      setLast(stored?.lastSession ?? null);
      setReady(true);

      void storedSessionDirectory().then((h) => setFolder(h?.name ?? null));
      // Chrome drops a suggested shortcut that collides with its own and says
      // nothing, so the only way to know whether one exists is to ask.
      void chrome.commands.getAll().then(setShortcuts).catch(() => {});
      void navigator.permissions
        .query({ name: 'microphone' as PermissionName })
        .then((p) => setMic(p.state))
        .catch(() => setMic('unknown'));

      const answered = await Promise.race([
        chrome.runtime.sendMessage({ type: RECORDING_STATE }).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (answered) setRecording(Boolean(answered.recording));
    })();
  }, []);

  const selfTest = useCallback(async () => {
    setTesting(true);
    setChecks(null);
    try {
      const res = await chrome.runtime.sendMessage({ type: RUN_SELF_TEST });
      setChecks((res?.checks as CheckResult[]) ?? null);
    } finally {
      setTesting(false);
    }
  }, []);

  const choose = useCallback(async () => {
    setError(null);
    try {
      const picked = await pickSessionDirectory();
      setFolder(picked.name);
      // Run once, right after setup — the moment the four subsystems can be
      // proven before anyone trusts a real session to them.
      void selfTest();
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
        // Re-granted here, before stopping. The grant does not outlive the
        // context that obtained it, and this popup closed the moment you went
        // off to do the QA — so by the time the worker writes, permission has
        // lapsed and getDirectoryHandle fails with "not allowed ... in the
        // current context". Stop is a click, so the activation needed to
        // re-grant is already in hand; asking now is free.
        const handle = await storedSessionDirectory();
        if (handle && (await permissionState(handle)) !== 'granted') {
          await requestPermission(handle).catch(() => false);
        }
        const res = await chrome.runtime.sendMessage({ type: STOP_RECORDING });
        setRecording(false);
        if (res?.error) setError(res.error);
        // A failed write returns `written: null` AND a writeError. Showing only
        // the success case is how a lost session looks like nothing happening.
        else if (res?.written && res?.writeError) setNote(`${res.writeError}\n→ ${res.written}`);
        else if (res?.writeError) setError(`Could not save: ${res.writeError}`);
        else if (res?.written) setNote(`Saved to ${res.written}`);
        setLast({
          id: res?.sessionId,
          written: res?.written ?? null,
          writeError: res?.writeError ?? null,
          events: res?.events?.length ?? 0,
          frames: res?.frames?.written ?? 0,
        });
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
        else if (res?.micError) setNote('Recording without a microphone — there will be no transcript.');
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
          this machine. Choosing <code>~/bugcast-sessions</code> means the MCP server finds them
          with no configuration.
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
          cached after that. The first run can take a couple of minutes on a slow connection —
          nothing is wrong if it sits there.
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
          Mark this moment{' '}
          <span className="text-neutral-400">
            {shortcuts.find((c) => c.name === 'drop-marker')?.shortcut || 'no shortcut'}
          </span>
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

      {mic !== 'granted' && !recording && (
        <button
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') })}
          className="w-full rounded border border-amber-300 bg-amber-50 px-3 py-2 text-left text-[11px] leading-snug text-amber-900 hover:bg-amber-100"
        >
          <span className="font-medium">Enable the microphone</span> — without it a session records
          everything except your narration, so there is no transcript.
        </button>
      )}

      {last && !recording && (
        <div className="rounded bg-neutral-50 p-2 text-[11px] leading-snug">
          <div className="font-medium text-neutral-700">Last session</div>
          <div className="break-all text-neutral-500">{last.id}</div>
          <div className="text-neutral-500">
            {last.events} events{last.frames ? `, ${last.frames} frames` : ''}
            {last.video
              ? `, video ${Math.round((last.videoBytes ?? 0) / 1024)} KB`
              : ', no video'}
          </div>
          {last.written ? (
            <div className="break-all text-green-700">→ {last.written}</div>
          ) : (
            <div className="text-red-600">Not saved: {last.writeError ?? 'unknown error'}</div>
          )}
        </div>
      )}

      {shortcuts.some((c) => !c.shortcut) && (
        <button
          onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
          className="w-full rounded border border-amber-300 bg-amber-50 px-3 py-2 text-left text-[11px] leading-snug text-amber-900 hover:bg-amber-100"
        >
          <span className="font-medium">
            {shortcuts.filter((c) => !c.shortcut).length === shortcuts.length
              ? 'No keyboard shortcuts are set'
              : 'A keyboard shortcut did not bind'}
          </span>{' '}
          — Chrome refuses one that collides with its own and does not say so. Assign your own.
        </button>
      )}

      <div className="border-t border-neutral-200 pt-2">
        <button
          onClick={() => void selfTest()}
          disabled={testing || recording}
          className="text-xs text-neutral-500 underline hover:text-neutral-900 disabled:no-underline disabled:opacity-50"
        >
          {testing ? 'Running self-test…' : 'Run self-test'}
        </button>
        {checks && (
          <ul className="mt-2 space-y-1">
            {checks.map((c) => (
              <li key={c.id} className="text-[11px] leading-snug">
                <span className={c.ok ? 'text-green-700' : 'text-red-600'}>{c.ok ? '✓' : '✗'}</span>{' '}
                <span className="font-medium">{c.label}</span>{' '}
                <span className="text-neutral-500">— {c.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
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
