/**
 * The Whisper branch of the AudioContext tee.
 *
 * Emits mono 16kHz Float32 frames. Downsampling here rather than downstream is
 * not a micro-optimisation: ten minutes of 48kHz float32 is ~115MB held in
 * memory, and at 16kHz it is ~38MB.
 *
 * The context stays at its native rate so the MediaRecorder branch keeps full
 * audio quality — one context, two branches, which is what keeps the video and
 * the transcript on the same clock without demuxing anything. That constraint
 * is why the resampling below is done by hand rather than by opening a second
 * AudioContext at 16kHz and letting the browser do it: a second context is a
 * second clock, and narration timestamps are only exact against the video
 * because they are counted in the same one.
 *
 * Plain JS in public/ deliberately: an AudioWorklet is loaded by URL into its
 * own global scope, so it cannot be part of a bundle. `pcm-worklet.test.ts` reads this
 * file and evaluates it, so it is tested as shipped rather than as a copy.
 */

/** Whisper's input rate. Not negotiable — the model is trained at it. */
const TARGET_RATE = 16000;

/**
 * Low-pass cutoff, just under the 8kHz output Nyquist.
 *
 * The margin is a real trade and both directions cost something. Lower and the
 * fricatives go: /s/, /f/ and /th/ are distinguished almost entirely by energy
 * above 4kHz, and a model that cannot hear the difference guesses. Higher and
 * the transition band runs past Nyquist, so what is left folds back into
 * speech. 7600Hz keeps the fricatives and leaves the taper room to land.
 */
const CUTOFF = 7600;

/**
 * 129 taps, Hamming-windowed.
 *
 * Hamming gives about -53dB of stopband rejection. The filter this replaced
 * was a three-sample box average, which gives -3.5dB at Nyquist and -9.5dB an
 * octave up — so a 12kHz keyboard click folded down to 4kHz barely attenuated,
 * landing in the middle of the band the model is listening to.
 *
 * Odd so the filter is symmetric and linear-phase; the group delay is a
 * constant (N-1)/2 samples, 1.3ms at 48kHz, which nothing here can perceive.
 *
 * The cost is 129 multiply-adds per input sample — about 16k per 128-frame
 * render quantum, against a budget of 2.7ms. It is not close.
 */
const TAPS = 129;

/** Hamming-windowed sinc, normalised to unity gain at DC. */
function lowpass(cutoff, rate, taps) {
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  const w = (2 * Math.PI * cutoff) / rate;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    // sinc(0) is the limit, not a division.
    const sinc = n === 0 ? w : Math.sin(w * n) / n;
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * window;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in the AudioWorklet scope.
    this.h = lowpass(Math.min(CUTOFF, sampleRate / 2 - 1), sampleRate, TAPS);

    /**
     * Input samples per output sample — fractional on purpose.
     *
     * This used to be `Math.round(sampleRate / 16000)`, which is 3 for both
     * 48000 and 44100. At 44.1kHz that produced 14700Hz audio labelled 16000Hz:
     * every word 8.1% slow and flat, and `t = samples / 16000` drifting by the
     * same 8.1% — about 49 seconds of error by the end of a ten-minute session.
     * 44.1kHz is what most USB interfaces and Bluetooth headsets run at.
     */
    this.step = sampleRate / TARGET_RATE;

    this.history = new Float32Array(TAPS);
    this.cursor = 0;
    this.index = 0; // input samples seen, ever
    this.next = 0; // position of the next output sample, in input-sample space
    this.prev = 0; // previous filtered value, for the interpolation below
    this.out = new Float32Array(1024);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;

    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      this.history[this.cursor] = sum / channels.length;
      this.cursor = (this.cursor + 1) % TAPS;

      // Convolve at the input rate. Everything above the cutoff is gone after
      // this, which is what makes the interpolation below safe.
      let y = 0;
      for (let k = 0; k < TAPS; k++) {
        y += this.h[k] * this.history[(this.cursor - 1 - k + TAPS * 2) % TAPS];
      }

      // Then read off at the output positions, interpolating when they fall
      // between input samples — which at 44.1kHz they almost always do. Linear
      // is enough here only because the signal is already band-limited to
      // 7.6kHz and still sampled at 44.1: six times its own Nyquist, where the
      // straight line between two points is very close to the curve.
      while (this.next <= this.index) {
        const frac = this.next - (this.index - 1);
        this.out[this.filled++] = this.prev + (y - this.prev) * frac;
        this.next += this.step;
        if (this.filled === this.out.length) {
          this.port.postMessage(this.out.slice(0));
          this.filled = 0;
        }
      }

      this.prev = y;
      this.index++;
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
