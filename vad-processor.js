/**
 * AudioWorklet processor for voice activity detection preprocessing.
 * Runs on the Web Audio rendering thread — not throttled by tab visibility.
 * Resamples 48kHz mic input to 16kHz and computes RMS energy per frame.
 */
class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.FRAME_SIZE = 512;
    this.RATIO = 3; // 48kHz → 16kHz
    this.SAMPLES_NEEDED = this.FRAME_SIZE * this.RATIO;
    this.buf = new Float32Array(this.SAMPLES_NEEDED);
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.buf[this.pos++] = input[i];

      if (this.pos >= this.SAMPLES_NEEDED) {
        const frame = new Float32Array(this.FRAME_SIZE);
        let sum = 0;
        for (let j = 0; j < this.FRAME_SIZE; j++) {
          frame[j] = this.buf[j * this.RATIO];
          sum += frame[j] * frame[j];
        }
        this.port.postMessage(
          { audio: frame, rms: Math.sqrt(sum / this.FRAME_SIZE) },
          [frame.buffer]
        );
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor("vad-processor", VadProcessor);
