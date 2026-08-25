import { useCallback, useEffect, useState } from 'react';
import { MODELS, type ModelTier } from '../offscreen/transcribe';
import { DEFAULTS, loadSettings, saveSetting, type Settings } from '../lib/settings';
import { pickSessionDirectory, storedSessionDirectory } from '../lib/session-store';

const TIERS: Record<ModelTier, string> = {
  'tiny.en': 'Tiny — fastest, roughest (~45 MB)',
  'base.en': 'Base — recommended (~105 MB)',
  'small.en': 'Small — most accurate, slowest (~340 MB)',
};

export function Options() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState<chrome.commands.Command[]>([]);
  const [micGranted, setMicGranted] = useState(false);

  const refreshMics = useCallback(async () => {
    // Labels are empty until the microphone has been granted, so an ungranted
    // list is a list of anonymous ids — worse than saying nothing.
    const granted = await navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((p) => p.state === 'granted')
      .catch(() => false);
    setMicGranted(granted);
    if (!granted) return setMics([]);
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    setMics(devices.filter((d) => d.kind === 'audioinput'));
  }, []);

  useEffect(() => {
    void loadSettings().then(setSettings);
    void storedSessionDirectory().then((h) => setFolder(h?.name ?? null));
    void chrome.commands.getAll().then(setShortcuts).catch(() => {});
    void refreshMics();
  }, [refreshMics]);

  const set = useCallback(async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    await saveSetting(key, value);
  }, []);

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-8">
      <header>
        <h1 className="text-lg font-semibold">Bugcast settings</h1>
        <p className="text-sm text-neutral-500">
          {settings.openaiApiKey
            ? 'Session audio is sent to OpenAI for transcription. Everything else stays on this machine.'
            : 'Everything runs on this machine. Nothing is uploaded.'}
        </p>
      </header>

      <Section title="Recording">
        <Toggle
          checked={settings.video}
          onChange={(v) => void set('video', v)}
          label="Record video"
          hint="The timeline records what happened; the video records what it looked like. Layout breakage and a spinner that never resolves have no other evidence."
        />
        <Toggle
          checked={settings.liveTranscription}
          onChange={(v) => void set('liveTranscription', v)}
          label="Transcribe while recording"
          hint="Lets an agent follow your narration live. Runs the speech model continuously, competing for CPU with the app you are testing — turn it off if a session feels sluggish. The full transcript is still produced when you stop."
        />
      </Section>

      <Section title="Microphone">
        {!micGranted ? (
          <button
            onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') })}
            className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-left text-xs text-amber-900 hover:bg-amber-100"
          >
            <span className="font-medium">Enable the microphone</span> — without it a session
            records everything except your narration, so there is no transcript.
          </button>
        ) : (
          <Field label="Input device">
            <select
              value={settings.micDeviceId}
              onChange={(e) => void set('micDeviceId', e.target.value)}
              className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
            >
              <option value="">System default</option>
              {mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 12)}
                </option>
              ))}
            </select>
          </Field>
        )}
      </Section>

      <Section title="Transcription">
        <Field label="OpenAI API key">
          <input
            type="password"
            value={settings.openaiApiKey}
            onChange={(e) => void set('openaiApiKey', e.target.value)}
            placeholder="sk-… — leave empty to transcribe locally"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded border border-neutral-300 px-2 py-1 font-mono text-sm"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Far more accurate on names and ticket ids, and it does not fall into the repetition
            loops the local model does. <strong>Your audio leaves this machine</strong> — it is sent
            to OpenAI and billed to your account. Stored on this device only; it is never bundled
            into the extension.
          </p>
        </Field>

        <Field label={settings.openaiApiKey ? 'Local model (unused while a key is set)' : 'Model'}>
          <select
            value={settings.modelTier}
            onChange={(e) => void set('modelTier', e.target.value as ModelTier)}
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            {(Object.keys(MODELS) as ModelTier[]).map((t) => (
              <option key={t} value={t}>
                {TIERS[t]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-neutral-500">
            {settings.openaiApiKey
              ? 'Used only if you clear the key above. Transcription is running on OpenAI.'
              : 'Downloads once and is cached. Changing tier downloads the new one on the next recording.'}
          </p>
        </Field>
      </Section>

      <Section title="Privacy">
        <Toggle
          checked={settings.typedValues}
          onChange={(v) => void set('typedValues', v)}
          label="Capture what you type"
          hint="Off by default. A detector that misses one field writes a real credential to disk and then into a model's context, with no undo once the folder is shared. Password, card and one-time-code fields stay redacted either way — this relaxes the default, it does not disable detection."
        />
        <p className="text-xs text-neutral-500">
          Video and frames are <strong>never</strong> redacted. They show whatever was on screen.
        </p>
      </Section>

      <Section title="Sessions">
        <Field label="Folder">
          <div className="flex items-center gap-3">
            <span className="text-sm text-neutral-700">{folder ?? 'Not chosen'}</span>
            <button
              onClick={() => void pickSessionDirectory().then((h) => setFolder(h.name))}
              className="text-xs underline hover:text-neutral-900"
            >
              Change
            </button>
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            Choosing <code>~/bugcast-sessions</code> means the MCP server finds sessions with no
            configuration.
          </p>
        </Field>
      </Section>

      <Section title="Shortcuts">
        <ul className="space-y-1 text-sm">
          {shortcuts
            .filter((c) => c.name !== '_execute_action')
            .map((c) => (
              <li key={c.name} className="flex justify-between">
                <span className="text-neutral-700">{c.description || c.name}</span>
                <span className={c.shortcut ? 'font-mono' : 'text-red-600'}>
                  {c.shortcut || 'not set'}
                </span>
              </li>
            ))}
        </ul>
        <button
          onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
          className="text-xs underline hover:text-neutral-900"
        >
          Change shortcuts
        </button>
        <p className="text-xs text-neutral-500">
          Chrome refuses a shortcut that collides with one of its own, without saying so — if one
          shows “not set”, assign it yourself.
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="border-b border-neutral-200 pb-1 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-neutral-700">{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1"
      />
      <span>
        <span className="text-sm text-neutral-800">{label}</span>
        <span className="block text-xs text-neutral-500">{hint}</span>
      </span>
    </label>
  );
}
