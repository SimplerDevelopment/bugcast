/**
 * The Whisper branch of the AudioContext tee.
 *
 * Emits mono 16kHz Float32 frames. Downsampling here rather than downstream is
 * not a micro-optimisation: ten minutes of 48kHz float32 is ~115MB held in
 * memory, and at 16kHz it is ~38MB.
 *
 * The context stays at its native rate so the MediaRecorder branch keeps full
 * audio quality — one context, two branches, which is what keeps the video and
 * the transcript on the same clock without demuxing anything.
 *
 * Plain JS in public/ deliberately: an AudioWorklet is loaded by URL into its
 * own global scope, so it cannot be part of a bundle.
 */
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in the AudioWorklet scope.
    this.ratio = Math.max(1, Math.round(sampleRate / 16000));
    this.acc = 0;
    this.count = 0;
    this.out = new Float32Array(1024);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;

    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      // Average the channels down to mono, then box-average each decimation
      // window — plain decimation would alias speech badly.
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      this.acc += sum / channels.length;
      this.count++;

      if (this.count === this.ratio) {
        this.out[this.filled++] = this.acc / this.ratio;
        this.acc = 0;
        this.count = 0;
        if (this.filled === this.out.length) {
          this.port.postMessage(this.out.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
