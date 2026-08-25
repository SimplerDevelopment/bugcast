import { describe, expect, it } from 'vitest';
import {
  encodeWav,
  hostedEngine,
  segmentsFromResponse,
  HOSTED_MODEL,
  MAX_CHUNK_SAMPLES,
  VOCABULARY_PROMPT,
} from './hosted';

const ok = (json: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => json }) as unknown as Response;

describe('encodeWav', () => {
  it('writes a RIFF header whose declared sizes match the payload', async () => {
    const view = new DataView(await encodeWav(new Float32Array(8)).arrayBuffer());
    const tag = (at: number) =>
      String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));

    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(16); // 8 samples * 2 bytes
    expect(view.getUint32(4, true)).toBe(36 + 16);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it('clamps out-of-range floats instead of letting int16 wrap them', async () => {
    // The bug this prevents is audible, not theoretical: a wrap turns the
    // loudest syllable into full-scale noise of the opposite sign.
    const view = new DataView(await encodeWav(new Float32Array([2, -2])).arrayBuffer());
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
  });
});

describe('segmentsFromResponse', () => {
  it('converts seconds to milliseconds and applies the session offset', () => {
    const out = segmentsFromResponse(
      { segments: [{ start: 1.5, end: 4.02, text: 'hello' }] },
      30_000,
      5_000,
    );
    expect(out).toEqual([{ start: 31_500, end: 34_020, text: 'hello' }]);
  });

  it('falls back to one spanning segment when the response carries only text', () => {
    expect(segmentsFromResponse({ text: '  hi  ' }, 1_000, 2_500)).toEqual([
      { start: 1_000, end: 3_500, text: 'hi' },
    ]);
  });

  it('drops an empty response rather than emitting a blank segment', () => {
    expect(segmentsFromResponse({ text: '   ' }, 0, 1_000)).toEqual([]);
    expect(segmentsFromResponse({}, 0, 1_000)).toEqual([]);
  });
});

describe('hostedEngine', () => {
  it('sends the model, the verbose format and the vocabulary prompt', async () => {
    let body: FormData | undefined;
    const engine = hostedEngine('sk-test', {
      fetchImpl: async (_url, init) => {
        body = init?.body as FormData;
        return ok({ segments: [] });
      },
    });
    await engine.transcribe(new Float32Array(16_000), 0);

    expect(body?.get('model')).toBe(HOSTED_MODEL);
    expect(body?.get('response_format')).toBe('verbose_json');
    expect(body?.get('prompt')).toBe(VOCABULARY_PROMPT);
  });

  it('says nothing below the one-second floor, without calling out', async () => {
    let called = false;
    const engine = hostedEngine('sk-test', {
      fetchImpl: async () => {
        called = true;
        return ok({});
      },
    });
    expect(await engine.transcribe(new Float32Array(100), 0)).toEqual([]);
    expect(called).toBe(false);
  });

  it('splits audio over the upload cap and offsets each chunk by its position', async () => {
    // The 25MB cap lands near thirteen minutes of 16kHz mono; a real session
    // already reached 12.5. Two chunks must not both report from zero.
    const offsets: number[] = [];
    const engine = hostedEngine('sk-test', {
      fetchImpl: async () => ok({ segments: [{ start: 0, end: 1, text: 'x' }] }),
    });
    const out = await engine.transcribe(new Float32Array(MAX_CHUNK_SAMPLES + 16_000 * 60), 0);
    for (const s of out) offsets.push(s.start);

    expect(out).toHaveLength(2);
    expect(offsets).toEqual([0, (MAX_CHUNK_SAMPLES / 16_000) * 1000]);
  });

  it('surfaces the response body on failure, because the status alone names nothing', async () => {
    const engine = hostedEngine('sk-bad', {
      fetchImpl: async () =>
        ({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => '{"error":{"message":"Incorrect API key provided"}}',
        }) as unknown as Response,
    });
    await expect(engine.transcribe(new Float32Array(16_000), 0)).rejects.toThrow(
      /401 Unauthorized.*Incorrect API key/s,
    );
  });
});
