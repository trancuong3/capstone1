export type AudioQualityStatus =
  | "UNKNOWN"
  | "NO_AUDIO"
  | "SILENCE"
  | "LOW_VOLUME"
  | "BACKGROUND_NOISE"
  | "SPEECH_DETECTED"
  | "AUDIO_TOO_SHORT"
  | "INVALID_AUDIO";

export interface AudioQualitySnapshot {
  status: AudioQualityStatus;
  durationMs: number;
  speechDurationMs: number;
  silenceDurationMs: number;
  rms: number;
  peak: number;
  noiseFloor: number;
  clipped: boolean;
  isSpeaking: boolean;
}

// Activity is an acoustic heuristic, never a pronunciation/confidence score.
// Keep the entire recording: silence detection must not trim first/last sounds.
export class AudioQualityMonitor {
  private startedAt: number | null = null;
  private previousAt = 0;
  private candidateMs = 0;
  private quietMs = 0;
  private frames = 0;
  private invalid = false;
  private maxRms = 0;
  private snapshot: AudioQualitySnapshot = {
    status: "UNKNOWN",
    durationMs: 0,
    speechDurationMs: 0,
    silenceDurationMs: 0,
    rms: 0,
    peak: 0,
    noiseFloor: 0,
    clipped: false,
    isSpeaking: false,
  };

  addFrame(samples: Float32Array, nowMs: number): AudioQualitySnapshot {
    if (!samples.length || !Number.isFinite(nowMs)) return this.getSnapshot();
    if (this.startedAt === null) {
      this.startedAt = nowMs;
      this.previousAt = nowMs;
    }
    const elapsed = Math.max(0, Math.min(100, nowMs - this.previousAt));
    this.previousAt = nowMs;
    let sum = 0;
    let peak = 0;
    let clippedSamples = 0;
    for (const sample of samples) {
      if (!Number.isFinite(sample) || Math.abs(sample) > 1) {
        this.invalid = true;
        continue;
      }
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      if (Math.abs(sample) >= 0.99) clippedSamples++;
    }
    const rms = Math.sqrt(sum / samples.length);
    this.frames++;
    this.maxRms = Math.max(this.maxRms, rms);
    const durationMs = Math.max(0, nowMs - this.startedAt);
    // Calibrate on the opening room sound, then follow quiet frames slowly.
    // Continuous fan noise is not automatically treated as speech.
    let noise = this.snapshot.noiseFloor;
    if (this.frames === 1) noise = rms;
    else if (durationMs < 250 || !this.snapshot.isSpeaking) {
      noise += (rms < noise ? 0.15 : 0.01) * (rms - noise);
    }
    const onset = Math.max(0.003, noise * 2.8);
    const offset = Math.max(0.0015, noise * 1.6);
    const active =
      durationMs >= 250 && rms > (this.snapshot.isSpeaking ? offset : onset);
    this.candidateMs = active ? this.candidateMs + elapsed : 0;
    this.quietMs = active ? 0 : this.quietMs + elapsed;
    let speaking = this.snapshot.isSpeaking;
    if (this.candidateMs >= 120) speaking = true;
    if (this.quietMs >= 350) speaking = false;
    const speechDurationMs =
      this.snapshot.speechDurationMs + (speaking && active ? elapsed : 0);
    this.snapshot = {
      status: "UNKNOWN",
      durationMs,
      speechDurationMs,
      silenceDurationMs: this.quietMs,
      rms,
      peak,
      noiseFloor: noise,
      clipped: this.snapshot.clipped || clippedSamples / samples.length > 0.05,
      isSpeaking: speaking,
    };
    return this.getSnapshot();
  }

  getSnapshot(): AudioQualitySnapshot {
    let status: AudioQualityStatus = "UNKNOWN";
    if (this.invalid || this.snapshot.clipped) status = "INVALID_AUDIO";
    else if (this.frames) {
      if (this.snapshot.durationMs < 300) status = "AUDIO_TOO_SHORT";
      else if (this.maxRms < 0.0001) status = "SILENCE";
      else if (this.maxRms < 0.008) status = "LOW_VOLUME";
      else if (this.snapshot.speechDurationMs >= 120)
        status = "SPEECH_DETECTED";
      else status = "BACKGROUND_NOISE";
    }
    return { ...this.snapshot, status };
  }
}

export function hasUnusableAudio(quality?: AudioQualitySnapshot): boolean {
  return (
    quality !== undefined &&
    [
      "NO_AUDIO",
      "SILENCE",
      "LOW_VOLUME",
      "BACKGROUND_NOISE",
      "AUDIO_TOO_SHORT",
      "INVALID_AUDIO",
    ].includes(quality.status)
  );
}
