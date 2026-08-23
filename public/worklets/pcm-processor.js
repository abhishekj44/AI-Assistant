class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.frameSize = 512; // 32ms at 16 kHz
    this.output = new Int16Array(this.frameSize);
    this.outputIndex = 0;
    this.phase = 0;
    this.sum = 0;
    this.sampleCount = 0;
    this.stopped = false;

    this.port.onmessage = (event) => {
      if (event.data?.command === "stop") {
        this.flush();
        this.stopped = true;
      }
    };
  }

  emitSample(sample) {
    const clipped = Math.max(-1, Math.min(1, sample));
    this.output[this.outputIndex++] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
    if (this.outputIndex >= this.frameSize) this.flush();
  }

  flush() {
    if (this.outputIndex === 0) return;
    const frame = this.outputIndex === this.frameSize ? this.output : this.output.slice(0, this.outputIndex);
    const buffer = frame.buffer;
    this.port.postMessage({ type: "pcm_data", buffer }, [buffer]);
    this.output = new Int16Array(this.frameSize);
    this.outputIndex = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;

    // Average groups of source samples. This behaves as a simple low-pass decimator and
    // handles common browser rates (44.1/48 kHz) without assuming an integer ratio.
    for (let i = 0; i < input.length; i += 1) {
      this.sum += input[i];
      this.sampleCount += 1;
      this.phase += this.targetRate;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.emitSample(this.sum / Math.max(1, this.sampleCount));
        this.sum = 0;
        this.sampleCount = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
