export interface SynthesizedAudioMeta {
  readonly resolvedVoiceId: string | null;
  readonly usedFallbackVoice: boolean;
  readonly provider?: string | null;
  readonly region?: string | null;
  readonly modelVersion?: string | null;
}

const synthesizedAudioMeta = new WeakMap<Blob, SynthesizedAudioMeta>();

export function setSynthesizedAudioMeta(
  audio: Blob,
  meta: SynthesizedAudioMeta,
): void {
  synthesizedAudioMeta.set(audio, meta);
}

export function getSynthesizedAudioMeta(
  audio: Blob,
): SynthesizedAudioMeta | undefined {
  return synthesizedAudioMeta.get(audio);
}
