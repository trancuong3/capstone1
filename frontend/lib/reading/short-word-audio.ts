async function decodeAudio(blob: Blob, sampleRate: number) {
  if (typeof OfflineAudioContext === "undefined") return null;
  let decoded: AudioBuffer;
  try {
    const decoder = new OfflineAudioContext(1, 1, sampleRate);
    decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
  } catch {
    // MediaRecorder codecs supported by <audio> may differ from Web Audio.
    return null;
  }

  let peak = 0;
  let samples = decoded.getChannelData(0);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const signal = decoded.getChannelData(channel);
    for (const sample of signal) {
      if (Math.abs(sample) <= peak) continue;
      peak = Math.abs(sample);
      samples = signal;
    }
  }
  return { samples, peak };
}

function encodeMonoWav(
  samples: Float32Array,
  sampleRate: number,
  gain: number,
) {
  const pcmBytes = samples.length * 2;
  const wav = new DataView(new ArrayBuffer(44 + pcmBytes));
  wav.setUint32(0, 0x52494646); // RIFF
  wav.setUint32(4, 36 + pcmBytes, true);
  wav.setUint32(8, 0x57415645); // WAVE
  wav.setUint32(12, 0x666d7420); // fmt
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true); // PCM
  wav.setUint16(22, 1, true); // mono
  wav.setUint32(24, sampleRate, true);
  wav.setUint32(28, sampleRate * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  wav.setUint32(36, 0x64617461); // data
  wav.setUint32(40, pcmBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const level = Math.max(-0.9, Math.min(0.9, samples[i] * gain));
    wav.setInt16(44 + i * 2, Math.round(level * 32767), true);
  }
  return new Blob([wav.buffer], { type: "audio/wav" });
}

/** Condition the signal without cutting the child's initial or final consonants. */
export async function prepareShortWordAudio(blob: Blob): Promise<Blob | null> {
  const sampleRate = 16_000;
  const audio = await decodeAudio(blob, sampleRate);
  if (!audio) return blob;
  if (audio.peak < 0.00015) return null;

  const frameLength = sampleRate / 50;
  const levels: number[] = [];
  const onsetPadding = Math.round(sampleRate * 0.12);
  const endPadding = Math.round(sampleRate * 0.18);
  const prepared = new Float32Array(
    onsetPadding + audio.samples.length + endPadding,
  );
  // Roll off rumble and mic DC below the speech band.
  const highPass = 1 / (1 + (2 * Math.PI * 75) / sampleRate);
  let previous = 0;
  let filtered = 0;
  let power = 0;
  for (let i = 0; i < audio.samples.length; i++) {
    const sample = audio.samples[i];
    filtered = highPass * (filtered + sample - previous);
    previous = sample;
    prepared[onsetPadding + i] = filtered;
    power += filtered * filtered;
    if ((i + 1) % frameLength === 0) {
      levels.push(Math.sqrt(power / frameLength));
      power = 0;
    }
  }
  if (audio.samples.length % frameLength)
    levels.push(Math.sqrt(power / (audio.samples.length % frameLength)));
  levels.sort((left, right) => right - left);
  // Discard the loudest 20 ms when estimating gain, so a click cannot mask speech.
  const speechLevel = levels[Math.min(1, levels.length - 1)] ?? 0;
  if (speechLevel < 0.00015) return null;
  const gain = Math.max(1, Math.min(12, 0.085 / speechLevel));
  return encodeMonoWav(prepared, sampleRate, gain);
}

/** Repeat the exact same Vietnamese sample at a consistent, audible level. */
export async function prepareWordSampleAudio(blob: Blob): Promise<Blob> {
  const sampleRate = 24_000;
  const audio = await decodeAudio(blob, sampleRate);
  if (!audio || audio.peak < 0.001) return blob;
  const gap = Math.round(sampleRate * 0.34);
  const samples = new Float32Array(audio.samples.length * 2 + gap);
  samples.set(audio.samples);
  samples.set(audio.samples, audio.samples.length + gap);
  return encodeMonoWav(samples, sampleRate, Math.min(4, 0.84 / audio.peak));
}
