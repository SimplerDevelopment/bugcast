import { useEffect, useState } from 'react';
import { RECORDING_STATE, START_RECORDING, STOP_RECORDING } from '../background/messages';

export function App() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: RECORDING_STATE }).then(
      (r) => setRecording(Boolean(r?.recording)),
      () => setRecording(false),
    );
  }, []);

  async function toggle() {
    setError(null);
    const type = recording ? STOP_RECORDING : START_RECORDING;
    const res = await chrome.runtime.sendMessage({ type });
    // Attach failure refuses to start rather than degrading — a session missing
    // network and console is indistinguishable, to the agent reading it, from a
    // session where nothing failed. See docs/design/issues/06.
    if (res?.error) setError(res.error);
    else setRecording(!recording);
  }

  return (
    <main className="p-4 space-y-3">
      <h1 className="text-sm font-semibold">Bugcast</h1>
      <button
        onClick={toggle}
        className={`w-full rounded px-3 py-2 text-sm font-medium text-white ${
          recording ? 'bg-red-600 hover:bg-red-700' : 'bg-neutral-900 hover:bg-neutral-800'
        }`}
      >
        {recording ? 'Stop recording' : 'Record'}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </main>
  );
}
