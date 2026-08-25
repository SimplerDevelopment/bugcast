/**
 * The live pass, run by Chrome instead of by us.
 *
 * Whisper-in-WASM is accurate and slow: a thirty-second window is thirty
 * seconds of encoder work on one thread, so narration arrives long after it was
 * spoken and an agent following along is reading the past. Chrome's on-device
 * speech recognition is native code with a model the browser already manages,
 * and it returns a phrase about as fast as you finish saying it.
 *
 * It is *not* the macOS engine. `SFSpeechRecognizer` is reachable only through
 * a Native Messaging host — a binary the user installs — and that is the
 * one-command install this project gave up whisper.cpp to keep
 * (docs/design/issues/03). This is Chrome's own, which costs nothing to install
 * because it is already there.
 *
 * Two things it cannot do, which is why it replaces only the provisional pass:
 *
 *   1. It will not take a MediaStream. It opens the default microphone itself,
 *      so it ignores the chosen input device and runs alongside the recorder's
 *      capture rather than sharing it.
 *   2. It has no timestamps. Text arrives, and the only clock available is the
 *      one on the wall. Every line here is therefore stamped from `speechstart`
 *      to arrival — a real span, but an observed one, not the sample position
 *      the authoritative pass uses.
 *
 * Both are acceptable for provisional narration and neither is acceptable for
 * the transcript that is kept, so Whisper still runs at stop over the recorded
 * PCM and replaces all of this.
 */

export type SpeechAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

/** A recognised phrase, in milliseconds from t0. */
export interface NativeLine {
  t: number;
  tEnd: number;
  text: string;
}

export interface NativeSpeechSession {
  stop(): void;
}

type Ctor = any;

/** Chrome ships it unprefixed; the prefixed name is kept for older builds. */
export function speechCtor(scope: any = globalThis): Ctor | null {
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * Whether Chrome can recognise this language without the network.
 *
 * `processLocally` is the whole point — the cloud path would send audio to
 * Google, which is not a thing this tool does quietly.
 */
/**
 * Bounded, because this is asked on the way into a recording.
 *
 * `available()` is not reliably prompt: it has been seen to sit in
 * `"downloading"` and never settle when the component never installs
 * (brave/brave-browser#55414). This call happens after `MediaRecorder.start()`
 * and before `start()` returns, so a promise that never resolves does not
 * degrade the live pass — it wedges the whole recording at the moment the user
 * pressed Record. A `catch` does nothing about a hang; only a clock does.
 *
 * Timing out means Whisper takes the live pass, which is the same answer as
 * "not available" and the right one.
 */
const STATUS_TIMEOUT_MS = 1_500;

export async function nativeSpeechStatus(
  lang = 'en-US',
  scope: any = globalThis,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<SpeechAvailability> {
  const SR = speechCtor(scope);
  if (!SR || typeof SR.available !== 'function') return 'unavailable';
  try {
    return (await Promise.race([
      SR.available({ processLocally: true, langs: [lang] }),
      new Promise<SpeechAvailability>((resolve) =>
        setTimeout(() => resolve('unavailable'), timeoutMs),
      ),
    ])) as SpeechAvailability;
  } catch {
    return 'unavailable';
  }
}

/**
 * Ask Chrome to fetch the language pack.
 *
 * Reported rather than awaited by the caller: the download is Chrome's to
 * manage, and a session that starts while it is still coming down simply uses
 * the Whisper live pass instead.
 */
export async function installNativeSpeech(lang = 'en-US', scope: any = globalThis): Promise<boolean> {
  const SR = speechCtor(scope);
  if (!SR || typeof SR.install !== 'function') return false;
  try {
    return Boolean(await SR.install({ processLocally: true, langs: [lang] }));
  } catch {
    return false;
  }
}

/**
 * Recognise continuously until stopped.
 *
 * `onend` restarts it, because continuous recognition is not: Chrome ends the
 * session on its own after a silence, and a live pass that quietly stopped
 * after the first pause would be worse than no live pass at all — it would look
 * like the tester had stopped talking.
 */
export function startNativeSpeech(
  now: () => number,
  onLine: (line: NativeLine) => void,
  lang = 'en-US',
  scope: any = globalThis,
): NativeSpeechSession | null {
  const SR = speechCtor(scope);
  if (!SR) return null;

  let stopped = false;
  let spokeAt = now();

  const recognition = new SR();
  recognition.lang = lang;
  recognition.continuous = true;
  // Interim results change under the reader. speech.ndjson is append-only, so
  // a line written cannot be taken back — only final results go in it.
  recognition.interimResults = false;
  recognition.processLocally = true;
  recognition.maxAlternatives = 1;

  recognition.onspeechstart = () => {
    spokeAt = now();
  };

  recognition.onresult = (event: any) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result?.isFinal) continue;
      const text = String(result[0]?.transcript ?? '').trim();
      if (!text) continue;
      const tEnd = now();
      onLine({ t: Math.max(0, Math.min(spokeAt, tEnd)), tEnd, text });
      // The next phrase begins no earlier than this one ended.
      spokeAt = tEnd;
    }
  };

  recognition.onerror = (event: any) => {
    // `no-speech` and `aborted` are ordinary — someone paused, or we stopped it.
    if (event?.error === 'no-speech' || event?.error === 'aborted') return;
    console.warn('[bugcast] native speech error', event?.error, event?.message ?? '');
  };

  recognition.onend = () => {
    if (stopped) return;
    try {
      recognition.start();
    } catch (e) {
      console.warn('[bugcast] native speech could not resume', e);
    }
  };

  try {
    recognition.start();
  } catch (e) {
    console.warn('[bugcast] native speech refused to start', e);
    return null;
  }

  return {
    stop() {
      stopped = true;
      try {
        recognition.stop();
      } catch {
        // Already ended; nothing to stop.
      }
    },
  };
}
