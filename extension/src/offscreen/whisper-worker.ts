/**
 * Whisper, off the main thread.
 *
 * Inference used to run in the offscreen document itself — the same thread that
 * handles `MediaRecorder`'s `ondataavailable` and the AudioWorklet's message
 * port. Every pass therefore blocked video chunk writes and PCM accumulation,
 * so transcribing while recording degraded the recording. A dedicated worker
 * gives the capture pipeline its thread back.
 *
 * Extension APIs are not available in a web worker, so everything this needs —
 * the ONNX runtime path especially — is passed in rather than looked up.
 */

interface LoadRequest {
  type: 'load';
  model: string;
  dtype: unknown;
  /** `chrome.runtime.getURL('ort/')`, resolved by the caller. */
  wasmPath: string;
}

interface TranscribeRequest {
  type: 'transcribe';
  id: number;
  samples: Float32Array;
  /** Milliseconds of session before this window's first sample. */
  offsetMs: number;
}

let pipe: Promise<any> | null = null;

async function load(req: LoadRequest): Promise<any> {
  const { env, pipeline } = await import('@huggingface/transformers');
  const wasm = env.backends?.onnx?.wasm;
  if (!wasm) throw new Error('transformers.js exposed no wasm backend');
  wasm.wasmPaths = req.wasmPath;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;

  return pipeline('automatic-speech-recognition', req.model, {
    device: 'wasm' as never,
    dtype: req.dtype as never,
    progress_callback: ((event: unknown) => self.postMessage({ type: 'progress', event })) as never,
  });
}

self.onmessage = async (e: MessageEvent<LoadRequest | TranscribeRequest>) => {
  const msg = e.data;

  if (msg.type === 'load') {
    pipe ??= load(msg);
    try {
      await pipe;
      self.postMessage({ type: 'ready' });
    } catch (error) {
      pipe = null; // let a later attempt retry rather than wedging forever
      self.postMessage({ type: 'ready', error: String((error as Error)?.message ?? error) });
    }
    return;
  }

  if (msg.type !== 'transcribe') return;
  try {
    if (!pipe) throw new Error('Model not loaded');
    const asr = await pipe;
    const out = await asr(msg.samples, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    self.postMessage({ type: 'result', id: msg.id, chunks: out?.chunks ?? [], text: out?.text ?? '' });
  } catch (error) {
    self.postMessage({ type: 'result', id: msg.id, error: String((error as Error)?.message ?? error) });
  }
};
