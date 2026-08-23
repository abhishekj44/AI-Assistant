/**
 * AudioWorklet processor for downsampling microphone/system audio to 16kHz Int16 linear PCM
 * for real-time streaming to Deepgram speech-to-text.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Use channel 0 (mono)
    const channelData = input[0];
    if (!channelData || channelData.length === 0) return true;

    const sourceSampleRate = sampleRate; // global sampleRate in AudioWorkletGlobalScope

    if (sourceSampleRate === this.targetSampleRate) {
      // 1:1 Int16 conversion
      const pcm16 = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        const s = Math.max(-1, Math.min(1, channelData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ type: "pcm_data", buffer: pcm16.buffer }, [pcm16.buffer]);
    } else {
      // Linear interpolation downsampling
      const ratio = sourceSampleRate / this.targetSampleRate;
      const targetLength = Math.floor(channelData.length / ratio);
      if (targetLength > 0) {
        const pcm16 = new Int16Array(targetLength);
        for (let i = 0; i < targetLength; i++) {
          const sourceIdx = i * ratio;
          const idx = Math.floor(sourceIdx);
          const fraction = sourceIdx - idx;
          const s0 = channelData[idx] || 0;
          const s1 = channelData[idx + 1] || s0;
          const interpolated = s0 + fraction * (s1 - s0);
          const s = Math.max(-1, Math.min(1, interpolated));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage({ type: "pcm_data", buffer: pcm16.buffer }, [pcm16.buffer]);
      }
    }

    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
