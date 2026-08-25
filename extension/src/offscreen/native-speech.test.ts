import { describe, expect, it, vi } from 'vitest';
import { nativeSpeechStatus, speechCtor, startNativeSpeech } from './native-speech';

/** Enough of Chrome's SpeechRecognition to drive the wrapper. */
function fakeScope(opts: { available?: string; throwOnStart?: boolean } = {}) {
  const instances: any[] = [];
  class SpeechRecognition {
    lang = '';
    continuous = false;
    interimResults = true;
    processLocally = false;
    maxAlternatives = 0;
    onresult: any;
    onend: any;
    onerror: any;
    onspeechstart: any;
    started = 0;
    stopped = 0;
    constructor() {
      instances.push(this);
    }
    start() {
      if (opts.throwOnStart) throw new Error('nope');
      this.started++;
    }
    stop() {
      this.stopped++;
    }
    static available = vi.fn(async () => opts.available ?? 'available');
    static install = vi.fn(async () => true);
  }
  return { scope: { SpeechRecognition } as any, instances };
}

/** One final result, as Chrome delivers it. */
const result = (transcript: string) => ({
  resultIndex: 0,
  results: [Object.assign([{ transcript }], { isFinal: true })],
});

describe('nativeSpeechStatus', () => {
  it('asks only about local processing — the cloud path is not on the table', async () => {
    const { scope } = fakeScope();
    await nativeSpeechStatus('en-US', scope);
    expect(scope.SpeechRecognition.available).toHaveBeenCalledWith({
      processLocally: true,
      langs: ['en-US'],
    });
  });

  it('reports unavailable when the browser has no SpeechRecognition at all', async () => {
    expect(await nativeSpeechStatus('en-US', {} as any)).toBe('unavailable');
  });

  // available() has been seen to sit in "downloading" and never settle. This is
  // asked after MediaRecorder.start(), so a hang there wedges the recording
  // rather than merely costing the live pass.
  it('gives up rather than hanging the recording', async () => {
    const scope = {
      SpeechRecognition: class {
        static available = () => new Promise(() => {}); // never settles
      },
    } as any;
    expect(await nativeSpeechStatus('en-US', scope, 10)).toBe('unavailable');
  });

  it('passes a downloadable pack through rather than treating it as ready', async () => {
    const { scope } = fakeScope({ available: 'downloadable' });
    expect(await nativeSpeechStatus('en-US', scope)).toBe('downloadable');
  });
});

describe('startNativeSpeech', () => {
  it('configures for continuous, final-only, on-device recognition', () => {
    const { scope, instances } = fakeScope();
    startNativeSpeech(() => 0, () => {}, 'en-US', scope);
    const r = instances[0];
    expect(r.continuous).toBe(true);
    expect(r.processLocally).toBe(true);
    // Interim results rewrite themselves, and speech.ndjson is append-only.
    expect(r.interimResults).toBe(false);
    expect(r.started).toBe(1);
  });

  it('stamps a line from when speech began to when the text arrived', () => {
    const { scope, instances } = fakeScope();
    const lines: any[] = [];
    let clock = 0;
    startNativeSpeech(() => clock, (l) => lines.push(l), 'en-US', scope);

    clock = 1000;
    instances[0].onspeechstart();
    clock = 2500;
    instances[0].onresult(result('the save button does nothing'));

    expect(lines).toEqual([{ t: 1000, tEnd: 2500, text: 'the save button does nothing' }]);
  });

  // Chrome ends recognition after a silence even with continuous set. A live
  // pass that stopped at the first pause would read as "they stopped talking".
  it('restarts itself when Chrome ends the session', () => {
    const { scope, instances } = fakeScope();
    startNativeSpeech(() => 0, () => {}, 'en-US', scope);
    instances[0].onend();
    expect(instances[0].started).toBe(2);
  });

  it('stays stopped once stopped', () => {
    const { scope, instances } = fakeScope();
    const session = startNativeSpeech(() => 0, () => {}, 'en-US', scope)!;
    session.stop();
    instances[0].onend();
    expect(instances[0].started).toBe(1);
    expect(instances[0].stopped).toBe(1);
  });

  it('returns null when the browser refuses, so the caller can fall back', () => {
    const { scope } = fakeScope({ throwOnStart: true });
    expect(startNativeSpeech(() => 0, () => {}, 'en-US', scope)).toBeNull();
  });

  it('has no constructor to find in a browser without the API', () => {
    expect(speechCtor({} as any)).toBeNull();
  });
});
