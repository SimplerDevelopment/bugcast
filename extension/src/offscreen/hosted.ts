/**
 * Hosted transcription.
 *
 * The counterpart to `./transcribe.ts`, plugged into the same
 * `TranscriptionEngine` seam that file's header set aside for exactly this:
 * `engine → segments → SRT`, so no caller changes.
 *
 * **Why.** The local tiers top out at `small.en` and ship `base.en`, which is
 * weakest precisely where a QA transcript carries its meaning — proper nouns
 * and alphanumeric ids. Session 2026-08-25T16-45-05 rendered "SITE79-001" as
 * "site 79-001", and looped "So, research would open whisper" across four
 * consecutive segments. That loop is a Whisper decoding pathology, not a
 * windowing artefact: the authoritative full-audio pass produced it too, so no
 * window size fixes it.
 *
 * Local is not deleted. It stays the engine when no key is configured, and the
 * only engine that works offline.
 */

import type { Segment } from '../lib/srt';
import { MIN_SAMPLES, type TranscriptionEngine } from './transcribe';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * `whisper-1`, deliberately, though `gpt-4o-transcribe` is the more accurate
 * model on this endpoint.
 *
 * The output of this engine is an SRT, so per-segment timestamps are the whole
 * product — and `timestamp_granularities` requires `response_format:
 * 'verbose_json'`, which `gpt-4o-transcribe` does not support. It returns text
 * only. Choosing it would buy accuracy and lose every timestamp, collapsing a
 * session to one unplaceable blob.
 *
 * Revisit if that endpoint gains timestamps.
 */
export const HOSTED_MODEL = 'whisper-1';

/**
 * Vocabulary bias, the cheapest fix available for the failure that prompted
 * this engine.
 *
 * The endpoint's `prompt` steers decoding toward terms it would otherwise
 * spell phonetically. These are the ones this tool actually hears; the SKU
 * shapes matter most, because they are what tickets get filed against.
 *
 * Hardcoded rather than configured: one operator, one vocabulary. Promote it
 * to a setting when a second project needs different terms — it is three
 * lines and a text input.
 */
export const VOCABULARY_PROMPT =
  'Bugcast QA session narration. Terms: bugcast, SimplerDevelopment, kanban, ' +
  'LocalVocal, Whisper, Drizzle, Postgres, MCP, Vercel, Railway. ' +
  'Ticket SKUs look like PUX-108, SITE79-001, VEQA-012, CRM79-015.';

/**
 * Chunk ceiling for one request.
 *
 * The endpoint caps uploads at 25 MB, and this audio is 16 kHz mono 16-bit —
 * 32 KB per second, so the cap lands at roughly thirteen minutes. That is not
 * a theoretical limit: the session that motivated this engine ran 12.5 minutes
 * and would have encoded to ~24 MB, one minute short of failing outright.
 *
 * Eight minutes leaves real headroom. The cost is one hard cut per chunk, and
 * a word landing on the cut is mangled the same way a live-window boundary
 * mangles one. Splitting on a silence trough instead would remove that; it is
 * not worth the machinery until a transcript is seen to suffer for it.
 */
export const MAX_CHUNK_SAMPLES = 16_000 * 480;

interface VerboseJson {
  segments?: Array<{ start: number; end: number; text: string }>;
  text?: string;
}

/**
 * Float PCM to a 16-bit mono WAV, because the endpoint takes a container and
 * not a raw sample array.
 */
export function encodeWav(samples: Float32Array, sampleRate = 16_000): Blob {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, bytes, true);

  for (let i = 0; i < samples.length; i++) {
    // Clamped before scaling. A float outside [-1, 1] wraps when written as
    // int16 rather than clipping, so one loud syllable becomes a burst of
    // noise — and noise is what Whisper loops on.
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Response to timeline segments. The API reports seconds; the timeline is integer ms. */
export function segmentsFromResponse(
  json: VerboseJson,
  t0Offset: number,
  totalMs: number,
): Segment[] {
  const segments = json.segments ?? [];
  if (!segments.length) {
    // Mirrors the local engine: a response can carry only `text` when the
    // audio is shorter than one segment. One segment spanning the audio beats
    // dropping it.
    const text = json.text?.trim();
    return text ? [{ start: t0Offset, end: t0Offset + Math.round(totalMs), text }] : [];
  }
  return segments.map(({ start, end, text }) => ({
    start: Math.round(t0Offset + start * 1000),
    end: Math.round(t0Offset + end * 1000),
    text,
  }));
}

export function hostedEngine(
  apiKey: string,
  opts: { model?: string; prompt?: string; fetchImpl?: typeof fetch } = {},
): TranscriptionEngine {
  const model = opts.model ?? HOSTED_MODEL;
  const prompt = opts.prompt ?? VOCABULARY_PROMPT;
  const doFetch = opts.fetchImpl ?? fetch;

  async function one(samples: Float32Array, t0Offset: number): Promise<Segment[]> {
    const form = new FormData();
    form.append('file', encodeWav(samples), 'audio.wav');
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    form.append('prompt', prompt);

    const res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      // The body carries the actual reason — a bad key, a rate limit, an
      // oversized upload — and a bare status code sends the reader hunting.
      const body = await res.text().catch(() => '');
      throw new Error(`Transcription failed: ${res.status} ${res.statusText}. ${body}`.trim());
    }
    return segmentsFromResponse(
      (await res.json()) as VerboseJson,
      t0Offset,
      (samples.length / 16_000) * 1000,
    );
  }

  return {
    async transcribe(samples, t0Offset) {
      // Same floor as the local engine: no speech simply means no .srt.
      if (samples.length < MIN_SAMPLES) return [];

      const out: Segment[] = [];
      // Sequential, not parallel. The chunks are only reached on a long session,
      // where firing eight uploads at once is how you meet a rate limit — and a
      // failure here costs the whole transcript, not one window.
      for (let from = 0; from < samples.length; from += MAX_CHUNK_SAMPLES) {
        const chunk = samples.subarray(from, Math.min(from + MAX_CHUNK_SAMPLES, samples.length));
        if (chunk.length < MIN_SAMPLES) break; // a sliver of trailing audio, not speech
        out.push(...(await one(chunk, t0Offset + (from / 16_000) * 1000)));
      }
      return out;
    },
  };
}
