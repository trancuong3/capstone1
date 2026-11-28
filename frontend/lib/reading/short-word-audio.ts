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
  softLimit = false,
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
    const scaled = samples[i] * gain;
    const level = softLimit
      ? 0.94 * Math.tanh(scaled / 0.94)
      : Math.max(-0.9, Math.min(0.9, scaled));
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

  const frameLength = sampleRate / 50; // 20ms (320 samples)
  const frameRms: number[] = [];
  const filteredSamples = new Float32Array(audio.samples.length);
  // Roll off rumble and mic DC below the speech band.
  const highPass = 1 / (1 + (2 * Math.PI * 75) / sampleRate);
  let previous = 0;
  let filtered = 0;
  let power = 0;
  for (let i = 0; i < audio.samples.length; i++) {
    const sample = audio.samples[i];
    filtered = highPass * (filtered + sample - previous);
    previous = sample;
    filteredSamples[i] = filtered;
    power += filtered * filtered;
    if ((i + 1) % frameLength === 0) {
      frameRms.push(Math.sqrt(power / frameLength));
      power = 0;
    }
  }
  if (audio.samples.length % frameLength) {
    frameRms.push(Math.sqrt(power / (audio.samples.length % frameLength)));
  }

  const sortedDesc = [...frameRms].sort((a, b) => b - a);
  const refLevel = sortedDesc[Math.min(1, sortedDesc.length - 1)] ?? 0;
  if (refLevel < 0.00015) return null;

  const activeThresh = Math.max(0.002, refLevel * 0.15);
  const activeIndices: number[] = [];
  const voicedLevels: number[] = [];
  for (let idx = 0; idx < frameRms.length; idx++) {
    if (frameRms[idx] >= activeThresh) {
      activeIndices.push(idx);
      voicedLevels.push(frameRms[idx]);
    }
  }

  if (voicedLevels.length === 0) return null;
  voicedLevels.sort((a, b) => a - b);
  const speechLevel =
    voicedLevels[Math.floor((voicedLevels.length - 1) * 0.9)] ?? 0;
  if (speechLevel < 0.00015) return null;

  const maxDeadSamples = Math.round(sampleRate * 0.3);
  const onsetMargin = Math.round(sampleRate * 0.16);
  const trailMargin = Math.round(sampleRate * 0.2);

  const firstActiveSample = activeIndices[0] * frameLength;
  const lastActiveSample = Math.min(
    filteredSamples.length,
    (activeIndices[activeIndices.length - 1] + 1) * frameLength,
  );
  const leadSilence = firstActiveSample;
  const trailSilence = filteredSamples.length - lastActiveSample;

  const sliceStart =
    leadSilence > maxDeadSamples
      ? Math.max(0, firstActiveSample - onsetMargin)
      : 0;
  const sliceEnd =
    trailSilence > maxDeadSamples
      ? Math.min(filteredSamples.length, lastActiveSample + trailMargin)
      : filteredSamples.length;

  const trimmed =
    sliceEnd > sliceStart
      ? filteredSamples.subarray(sliceStart, sliceEnd)
      : filteredSamples;
  const preservedLead = firstActiveSample - sliceStart;
  const preservedTrail = sliceEnd - lastActiveSample;
  const leadPad = Math.max(0, onsetMargin - preservedLead);
  const trailPad = Math.max(0, trailMargin - preservedTrail);

  const prepared = new Float32Array(leadPad + trimmed.length + trailPad);
  prepared.set(trimmed, leadPad);

  const gain =
    speechLevel >= 0.065 ? 1 : Math.max(1, Math.min(12, 0.085 / speechLevel));
  return encodeMonoWav(prepared, sampleRate, gain, true);
}

export interface PrepareWordSampleOptions {
  readonly repeat?: boolean;
}

/** Prepare a crisp, audible Vietnamese word sample (single read by default). */
export async function prepareWordSampleAudio(
  blob: Blob,
  options?: PrepareWordSampleOptions,
): Promise<Blob> {
  const sampleRate = 24_000;
  const audio = await decodeAudio(blob, sampleRate);
  if (!audio || audio.peak < 0.001) return blob;
  const gain = Math.min(4, 0.84 / audio.peak);
  if (options?.repeat !== true) {
    return encodeMonoWav(audio.samples, sampleRate, gain);
  }
  const gap = Math.round(sampleRate * 0.34);
  const samples = new Float32Array(audio.samples.length * 2 + gap);
  samples.set(audio.samples);
  samples.set(audio.samples, audio.samples.length + gap);
  return encodeMonoWav(samples, sampleRate, gain);
}
