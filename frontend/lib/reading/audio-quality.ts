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

export type AudioQualityMode = "passage" | "child-passage" | "short-word";

export interface AudioQualityMonitorOptions {
  readonly mode?: AudioQualityMode;
}

interface AudioQualityProfile {
  readonly calibrationWindowMs: number;
  readonly minDurationMs: number;
  readonly minSpeechDurationMs: number;
  readonly minPeakRms: number;
  readonly candidateOnsetMs: number;
  readonly hangoverMs: number;
  readonly onsetFloor: number;
  readonly onsetMultiplier: number;
  readonly offsetFloor: number;
  readonly offsetMultiplier: number;
}

const AUDIO_QUALITY_PROFILES: Record<AudioQualityMode, AudioQualityProfile> = {
  passage: {
    calibrationWindowMs: 250,
    minDurationMs: 300,
    minSpeechDurationMs: 120,
    minPeakRms: 0.008,
    candidateOnsetMs: 120,
    hangoverMs: 350,
    onsetFloor: 0.003,
    onsetMultiplier: 2.8,
    offsetFloor: 0.0015,
    offsetMultiplier: 1.6,
  },
  // Grade-1 child reading profile: captures softer child voices (RMS 0.005+)
  // and holds speaking activity across brief mid-syllable spelling pauses (~450ms)
  // while still rejecting silence, constant fan noise, and brief clicks.
  "child-passage": {
    calibrationWindowMs: 180,
    minDurationMs: 220,
    minSpeechDurationMs: 80,
    minPeakRms: 0.0045,
    candidateOnsetMs: 80,
    hangoverMs: 480,
    onsetFloor: 0.0024,
    onsetMultiplier: 2.3,
    offsetFloor: 0.0012,
    offsetMultiplier: 1.4,
  },
  // Short-word mode captures single Grade-1 syllables ("có", "lo", "dậy")
  // cleanly within ~160–400ms without early-speech floor poisoning.
  "short-word": {
    calibrationWindowMs: 60,
    minDurationMs: 160,
    minSpeechDurationMs: 60,
    minPeakRms: 0.003,
    candidateOnsetMs: 50,
    hangoverMs: 220,
    onsetFloor: 0.0022,
    onsetMultiplier: 2.4,
    offsetFloor: 0.0012,
    offsetMultiplier: 1.4,
  },
};

// Activity is an acoustic heuristic, never a pronunciation/confidence score.
// Keep the entire recording: silence detection must not trim first/last sounds.
export class AudioQualityMonitor {
  private readonly mode: AudioQualityMode;
  private readonly profile: AudioQualityProfile;
  private startedAt: number | null = null;
  private previousAt = 0;
  private candidateMs = 0;
  private quietMs = 0;
  private frames = 0;
  private invalid = false;
  private maxRms = 0;
  /** Sliding 300ms window of recent frames for sustained clipping detection. */
  private readonly clipWindow: Array<{
    readonly atMs: number;
    readonly elapsedMs: number;
    readonly clipped: boolean;
  }> = [];
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

  constructor(options?: AudioQualityMonitorOptions) {
    this.mode = options?.mode ?? "passage";
    this.profile = AUDIO_QUALITY_PROFILES[this.mode];
  }

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
    const frameClipped = clippedSamples / samples.length > 0.05;
    this.clipWindow.push({ atMs: nowMs, elapsedMs: elapsed, clipped: frameClipped });
    const windowStartMs = nowMs - 300;
    while (this.clipWindow.length > 0 && this.clipWindow[0].atMs < windowStartMs) {
      this.clipWindow.shift();
    }
    let clippedFramesInWindow = 0;
    let clippedMsInWindow = 0;
    for (const entry of this.clipWindow) {
      if (entry.clipped) {
        clippedFramesInWindow += 1;
        clippedMsInWindow += entry.elapsedMs;
      }
    }
    // Require sustained clipping across the 300ms window (>= 120ms and >= 3 frames,
    // or >= 50% of frames over >= 3 frames) instead of permanently latching a single plosive.
    const sustainedClipped =
      clippedFramesInWindow >= 3 &&
      (clippedMsInWindow >= 120 ||
        clippedFramesInWindow / this.clipWindow.length >= 0.5);

    const rms = Math.sqrt(sum / samples.length);
    this.frames++;
    this.maxRms = Math.max(this.maxRms, rms);
    const durationMs = Math.max(0, nowMs - this.startedAt);
    // Calibrate on the opening room sound, then follow quiet frames slowly.
    // Continuous fan noise is not automatically treated as speech.
    let noise = this.snapshot.noiseFloor;
    if (this.frames === 1) {
      noise = this.mode === "short-word" ? Math.min(rms, 0.008) : rms;
    } else if (
      durationMs < this.profile.calibrationWindowMs ||
      !this.snapshot.isSpeaking
    ) {
      const sampleRms =
        this.mode === "short-word" &&
        durationMs < this.profile.calibrationWindowMs &&
        rms >= 0.015
          ? Math.min(rms, 0.008)
          : rms;
      noise += (sampleRms < noise ? 0.15 : 0.01) * (sampleRms - noise);
    }
    const onset = Math.max(
      this.profile.onsetFloor,
      noise * this.profile.onsetMultiplier,
    );
    const offset = Math.max(
      this.profile.offsetFloor,
      noise * this.profile.offsetMultiplier,
    );
    const calibrated =
      durationMs >= this.profile.calibrationWindowMs ||
      (this.mode === "short-word" && rms > Math.max(onset, 0.0055));
    const active =
      calibrated && rms > (this.snapshot.isSpeaking ? offset : onset);
    this.candidateMs = active ? this.candidateMs + elapsed : 0;
    this.quietMs = active ? 0 : this.quietMs + elapsed;
    let speaking = this.snapshot.isSpeaking;
    if (this.candidateMs >= this.profile.candidateOnsetMs) speaking = true;
    if (this.quietMs >= this.profile.hangoverMs) speaking = false;
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
      clipped: sustainedClipped,
      isSpeaking: speaking,
    };
    return this.getSnapshot();
  }

  getSnapshot(): AudioQualitySnapshot {
    let status: AudioQualityStatus = "UNKNOWN";
    if (this.invalid || this.snapshot.clipped) status = "INVALID_AUDIO";
    else if (this.frames) {
      if (this.snapshot.durationMs < this.profile.minDurationMs)
        status = "AUDIO_TOO_SHORT";
      else if (this.maxRms < 0.0001) status = "SILENCE";
      else if (this.maxRms < this.profile.minPeakRms) status = "LOW_VOLUME";
      else if (
        this.snapshot.speechDurationMs >= this.profile.minSpeechDurationMs
      )
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

/**
 * Trong luyện đọc từ ngắn, giọng đọc nhỏ ("LOW_VOLUME") hoặc nền ồn nhẹ
 * ("BACKGROUND_NOISE") vẫn mang đầy đủ âm vị tiếng Việt để gửi lên STT.
 * Chỉ chặn âm thanh rỗng, câm hoàn toàn, quá ngắn hoặc bị vỡ tiếng.
 */
export function hasShortWordBlockingAudioIssue(
  quality?: AudioQualitySnapshot,
): boolean {
  return (
    quality !== undefined &&
    ["NO_AUDIO", "SILENCE", "AUDIO_TOO_SHORT", "INVALID_AUDIO"].includes(
      quality.status,
    )
  );
}
