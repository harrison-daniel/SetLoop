/**
 * AudioWorklet processor for voice activity detection preprocessing.
 * AudioContext runs at 16kHz (Chrome resamples from mic natively).
 * Accumulates 512-sample frames for Silero VAD and computes RMS energy.
 */
class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.FRAME_SIZE = 512;
    this.buf = new Float32Array(this.FRAME_SIZE);
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.buf[this.pos++] = input[i];

      if (this.pos >= this.FRAME_SIZE) {
        let sum = 0;
        for (let j = 0; j < this.FRAME_SIZE; j++) {
          sum += this.buf[j] * this.buf[j];
        }
        const frame = this.buf.slice();
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
