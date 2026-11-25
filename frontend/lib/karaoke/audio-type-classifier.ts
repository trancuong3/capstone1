/**
 * Pure client-side Web Audio vocal vs. instrumental classifier (0 MB server RAM).
 *
 * Uses mid/side stereo energy (`L + R` vs `L - R`), vocal-band (300–3400 Hz)
 * spectral ratio, syllabic dynamic modulation (2–8 Hz), voiced pitch periodicity,
 * and onset-flux BPM estimation. Deterministic on synthetic PCM buffers.
 */

export type ClassifiedAudioType =
  "VOCAL_FULL" | "INSTRUMENTAL_ONLY" | "UNKNOWN";

export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioClassificationMetrics {
  readonly midSideRatio: number;
  readonly vocalBandRatio: number;
  readonly modulationDepth: number;
  readonly voicedFrameRatio: number;
  readonly isStereo: boolean;
}

export interface AudioClassificationResult {
  readonly audioType: ClassifiedAudioType;
  readonly estimatedBpm: number | null;
  readonly confidence: number;
  readonly guidanceVi: string;
  readonly metrics: AudioClassificationMetrics;
}

const FFT_SIZE = 1024;
const HOP_SIZE = 512;
const MAX_ANALYSIS_SECONDS = 24;
const VOCAL_LOW_HZ = 300;
const VOCAL_HIGH_HZ = 3400;
const MUSIC_LOW_HZ = 50;
const MUSIC_HIGH_HZ = 8000;
const MIN_BPM = 60;
const MAX_BPM = 180;

const LEADING_TRACK_RE = /^\s*\d{1,3}\s*[-._)]\s*/;
const NOISE_TAG_RE =
  /\s*(?:\[[^\]]*(?:official|mv|video|audio|lyric|karaoke|kbps|mp3|hd|hq|remaster|beat|full)[^\]]*\]|\([^)]*(?:official|mv|video|audio|lyric|karaoke|kbps|mp3|hd|hq|remaster|beat|full)[^)]*\))\s*/gi;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Clean an uploaded MP3 filename into a readable suggested song title. */
export function cleanFilenameToTitle(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  const withoutTrack = stem.replace(LEADING_TRACK_RE, "");
  const normalizedStem = (withoutTrack.trim() ? withoutTrack : stem).replace(
    /_/g,
    " ",
  );
  const withoutNoise = normalizedStem.replace(NOISE_TAG_RE, " ");
  const finalTitle = withoutNoise.trim() ? withoutNoise : normalizedStem;
  return finalTitle
    .normalize("NFC")
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** In-place radix-2 Cooley-Tukey FFT for real/imag Float64Arrays of length 2^k. */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[start + k];
        const uIm = im[start + k];
        const vRe = re[start + k + half] * wRe - im[start + k + half] * wIm;
        const vIm = re[start + k + half] * wIm + im[start + k + half] * wRe;
        re[start + k] = uRe + vRe;
        im[start + k] = uIm + vIm;
        re[start + k + half] = uRe - vRe;
        im[start + k + half] = uIm - vIm;
        const nextRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextRe;
      }
    }
  }
}

const HANN_WINDOW = (() => {
  const win = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  }
  return win;
})();

function bandPowerFromFrame(
  samples: Float32Array,
  offset: number,
  sampleRate: number,
  re: Float64Array,
  im: Float64Array,
): { vocalPower: number; totalPower: number } {
  for (let i = 0; i < FFT_SIZE; i++) {
    re[i] = (samples[offset + i] ?? 0) * HANN_WINDOW[i];
    im[i] = 0;
  }
  fftInPlace(re, im);

  const hzPerBin = sampleRate / FFT_SIZE;
  const maxBin = FFT_SIZE >> 1;
  const musicLowBin = Math.max(1, Math.floor(MUSIC_LOW_HZ / hzPerBin));
  const musicHighBin = Math.min(maxBin, Math.ceil(MUSIC_HIGH_HZ / hzPerBin));
  const vocalLowBin = Math.max(1, Math.floor(VOCAL_LOW_HZ / hzPerBin));
  const vocalHighBin = Math.min(maxBin, Math.ceil(VOCAL_HIGH_HZ / hzPerBin));

  let vocalPower = 0;
  let totalPower = 0;
  for (let k = musicLowBin; k <= musicHighBin; k++) {
    const power = re[k] * re[k] + im[k] * im[k];
    totalPower += power;
    if (k >= vocalLowBin && k <= vocalHighBin) {
      vocalPower += power;
    }
  }
  return { vocalPower, totalPower };
}

function pitchPeriodicity(
  samples: Float32Array,
  offset: number,
  length: number,
  sampleRate: number,
): number {
  const minLag = Math.max(8, Math.floor(sampleRate / 700));
  const maxLag = Math.min(Math.floor(length / 2), Math.ceil(sampleRate / 140));
  if (maxLag <= minLag) return 0;

  let energy0 = 0;
  for (let i = 0; i < length; i++) {
    const s = samples[offset + i];
    energy0 += s * s;
  }
  if (energy0 < 1e-9) return 0;

  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0;
    let e1 = 0;
    let e2 = 0;
    const span = length - lag;
    for (let i = 0; i < span; i++) {
      const a = samples[offset + i];
      const b = samples[offset + i + lag];
      dot += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const denom = Math.sqrt(e1 * e2);
    if (denom > 1e-9) {
      const corr = dot / denom;
      if (corr > bestCorr) bestCorr = corr;
    }
  }
  return bestCorr;
}

function computeSyllabicModulation(
  envelope: number[],
  frameRate: number,
): number {
  if (envelope.length < 8) return 0;
  let sum = 0;
  for (let i = 0; i < envelope.length; i++) sum += envelope[i];
  const mean = sum / envelope.length;
  if (mean < 1e-7) return 0;

  let variance = 0;
  const centered = new Float64Array(envelope.length);
  for (let i = 0; i < envelope.length; i++) {
    const diff = envelope[i] - mean;
    centered[i] = diff;
    variance += diff * diff;
  }
  variance /= envelope.length;
  const cv = Math.sqrt(variance) / mean;

  // Evaluate modulation energy in human syllabic rate (2–8 Hz) via targeted DFT bins.
  const n = centered.length;
  const minBin = Math.max(1, Math.floor((2 * n) / frameRate));
  const maxBin = Math.min(Math.floor(n / 2), Math.ceil((8 * n) / frameRate));
  let syllabicEnergy = 0;
  let totalEnvEnergy = 0;
  const maxTotalBin = Math.min(
    Math.floor(n / 2),
    Math.ceil((16 * n) / frameRate),
  );
  for (let k = 1; k <= maxTotalBin; k++) {
    let r = 0;
    let im = 0;
    const w = (-2 * Math.PI * k) / n;
    for (let t = 0; t < n; t++) {
      r += centered[t] * Math.cos(w * t);
      im += centered[t] * Math.sin(w * t);
    }
    const mag2 = r * r + im * im;
    totalEnvEnergy += mag2;
    if (k >= minBin && k <= maxBin) {
      syllabicEnergy += mag2;
    }
  }
  const syllabicShare =
    totalEnvEnergy > 1e-9 ? syllabicEnergy / totalEnvEnergy : 0;
  return clamp(0.6 * clamp(cv, 0, 1) + 0.4 * syllabicShare, 0, 1);
}

function estimateBpmFromEnvelope(
  totalRms: number[],
  frameRate: number,
  durationSeconds: number,
): number | null {
  if (durationSeconds < 3 || totalRms.length < 32) return null;
  const rawFlux = new Float64Array(totalRms.length);
  for (let i = 1; i < totalRms.length; i++) {
    const diff = totalRms[i] - totalRms[i - 1];
    rawFlux[i] = diff > 0 ? diff : 0;
  }

  // 3-tap smoothing prevents sharp impulse peaks from aliasing between integer hop lags.
  const flux = new Float64Array(totalRms.length);
  let meanFlux = 0;
  for (let i = 0; i < totalRms.length; i++) {
    const prev = i > 0 ? rawFlux[i - 1] : 0;
    const next = i + 1 < totalRms.length ? rawFlux[i + 1] : 0;
    flux[i] = 0.25 * prev + 0.5 * rawFlux[i] + 0.25 * next;
    meanFlux += flux[i];
  }
  meanFlux /= flux.length;

  let energy0 = 0;
  for (let i = 0; i < flux.length; i++) {
    flux[i] -= meanFlux;
    energy0 += flux[i] * flux[i];
  }
  if (energy0 < 1e-9) return null;

  const minLag = Math.max(1, Math.floor((60 / MAX_BPM) * frameRate));
  const maxLag = Math.min(
    Math.floor(flux.length / 2),
    Math.ceil((60 / MIN_BPM) * frameRate),
  );
  if (maxLag <= minLag) return null;

  const rawScores = new Float64Array(maxLag + 1);
  let bestLag = -1;
  let bestWeightedScore = 0;
  let bestRawScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0;
    let e1 = 0;
    let e2 = 0;
    const limit = flux.length - lag;
    for (let i = 0; i < limit; i++) {
      const a = flux[i];
      const b = flux[i + lag];
      dot += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const denom = Math.sqrt(e1 * e2);
    const rawScore = denom > 1e-9 ? dot / denom : 0;
    rawScores[lag] = rawScore;
    const candidateBpm = (60 * frameRate) / lag;
    // Mild tempo prior centered at 115 BPM resolves half/double-tempo octave ambiguity.
    const prior =
      0.75 + 0.25 * Math.exp(-0.5 * Math.pow((candidateBpm - 115) / 36, 2));
    const weighted = rawScore * prior;
    if (weighted > bestWeightedScore) {
      bestWeightedScore = weighted;
      bestRawScore = rawScore;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || bestRawScore < 0.15) return null;
  // Parabolic peak interpolation gives sub-frame BPM accuracy.
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const leftVal = rawScores[bestLag - 1];
    const centerVal = rawScores[bestLag];
    const rightVal = rawScores[bestLag + 1];
    const denom = leftVal - 2 * centerVal + rightVal;
    if (Math.abs(denom) > 1e-9) {
      const delta = clamp((0.5 * (leftVal - rightVal)) / denom, -0.5, 0.5);
      refinedLag = bestLag + delta;
    }
  }
  const bpm = Math.round((60 * frameRate) / refinedLag);
  return clamp(bpm, MIN_BPM, MAX_BPM);
}

/**
 * Deterministically classify an AudioBuffer (or synthetic test buffer) into
 * `VOCAL_FULL`, `INSTRUMENTAL_ONLY`, or `UNKNOWN`.
 */
export function classifyAudioBuffer(
  buffer: AudioBufferLike,
): AudioClassificationResult {
  const { sampleRate, length, numberOfChannels } = buffer;
  const duration =
    Number.isFinite(buffer.duration) && buffer.duration > 0
      ? buffer.duration
      : sampleRate > 0
        ? length / sampleRate
        : 0;

  if (
    !sampleRate ||
    sampleRate < 8000 ||
    numberOfChannels < 1 ||
    length < FFT_SIZE ||
    duration < 0.4
  ) {
    return {
      audioType: "UNKNOWN",
      estimatedBpm: null,
      confidence: 0.2,
      guidanceVi:
        "Đoạn âm thanh quá ngắn để phân loại tự động. Bạn có thể chọn loại nhạc hoặc dán lời trực tiếp.",
      metrics: {
        midSideRatio: 0,
        vocalBandRatio: 0,
        modulationDepth: 0,
        voicedFrameRatio: 0,
        isStereo: numberOfChannels >= 2,
      },
    };
  }

  const left = buffer.getChannelData(0);
  const right = numberOfChannels >= 2 ? buffer.getChannelData(1) : null;

  // Analyze up to MAX_ANALYSIS_SECONDS centered in the audio to stay fast and low-RAM.
  const maxSamples = Math.min(
    length,
    Math.floor(sampleRate * MAX_ANALYSIS_SECONDS),
  );
  const startSample = Math.max(0, Math.floor((length - maxSamples) / 2));
  const mid = new Float32Array(maxSamples);
  const side = right ? new Float32Array(maxSamples) : null;

  let midEnergySum = 0;
  let sideEnergySum = 0;
  for (let i = 0; i < maxSamples; i++) {
    const l = left[startSample + i] ?? 0;
    if (right && side) {
      const r = right[startSample + i] ?? 0;
      const m = 0.5 * (l + r);
      const s = 0.5 * (l - r);
      mid[i] = m;
      side[i] = s;
      midEnergySum += m * m;
      sideEnergySum += s * s;
    } else {
      mid[i] = l;
      midEnergySum += l * l;
    }
  }

  const overallRms = Math.sqrt((midEnergySum + sideEnergySum) / maxSamples);
  if (overallRms < 1e-4) {
    return {
      audioType: "UNKNOWN",
      estimatedBpm: null,
      confidence: 0.2,
      guidanceVi:
        "File âm thanh gần như im lặng. Hãy kiểm tra lại file MP3 trước khi tạo karaoke.",
      metrics: {
        midSideRatio: 0,
        vocalBandRatio: 0,
        modulationDepth: 0,
        voicedFrameRatio: 0,
        isStereo: Boolean(right),
      },
    };
  }

  const hasStereoSeparation = Boolean(
    side && sideEnergySum > Math.max(midEnergySum, 1e-12) * 1e-4,
  );

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);

  let midVocalTotal = 0;
  let midMusicTotal = 0;
  let sideVocalTotal = 0;
  let sideMusicTotal = 0;
  let activeFrames = 0;
  let voicedFrames = 0;

  const vocalEnvelope: number[] = [];
  const totalEnvelope: number[] = [];

  for (let offset = 0; offset + FFT_SIZE <= maxSamples; offset += HOP_SIZE) {
    const midBand = bandPowerFromFrame(mid, offset, sampleRate, re, im);
    midVocalTotal += midBand.vocalPower;
    midMusicTotal += midBand.totalPower;
    let frameMusicPower = midBand.totalPower;

    if (side && hasStereoSeparation) {
      const sideBand = bandPowerFromFrame(side, offset, sampleRate, re, im);
      sideVocalTotal += sideBand.vocalPower;
      sideMusicTotal += sideBand.totalPower;
      frameMusicPower += sideBand.totalPower;
    }

    const frameVocalRms = Math.sqrt(midBand.vocalPower / FFT_SIZE);
    const frameTotalRms = Math.sqrt(frameMusicPower / FFT_SIZE);
    vocalEnvelope.push(frameVocalRms);
    totalEnvelope.push(frameTotalRms);

    if (frameTotalRms > overallRms * 0.15) {
      activeFrames++;
      const frameVocalRatio =
        midBand.totalPower > 1e-12
          ? midBand.vocalPower / midBand.totalPower
          : 0;
      if (frameVocalRatio >= 0.32) {
        const periodicity = pitchPeriodicity(mid, offset, FFT_SIZE, sampleRate);
        if (periodicity >= 0.45) {
          voicedFrames++;
        }
      }
    }
  }

  const totalCombinedMusic = midMusicTotal + sideMusicTotal;
  const vocalBandRatio =
    totalCombinedMusic > 1e-12 ? midVocalTotal / totalCombinedMusic : 0;
  const midSideRatio = hasStereoSeparation
    ? clamp(midVocalTotal / Math.max(sideVocalTotal, 1e-12), 0, 10)
    : 1;
  const frameRate = sampleRate / HOP_SIZE;
  const modulationDepth = computeSyllabicModulation(vocalEnvelope, frameRate);
  const voicedFrameRatio = activeFrames > 0 ? voicedFrames / activeFrames : 0;
  const estimatedBpm = estimateBpmFromEnvelope(
    totalEnvelope,
    frameRate,
    maxSamples / sampleRate,
  );

  const vocalBandScore = clamp((vocalBandRatio - 0.24) / 0.44, 0, 1);
  const modulationScore = clamp((modulationDepth - 0.12) / 0.28, 0, 1);
  const voicedScore = clamp((voicedFrameRatio - 0.15) / 0.45, 0, 1);

  let vocalEvidence: number;
  if (hasStereoSeparation) {
    const midSideScore = clamp((midSideRatio - 0.9) / 1.1, 0, 1);
    vocalEvidence =
      0.35 * vocalBandScore +
      0.3 * modulationScore +
      0.15 * voicedScore +
      0.2 * midSideScore;
    if (midSideRatio < 0.85) {
      vocalEvidence -= 0.25;
    }
  } else {
    vocalEvidence =
      0.45 * vocalBandScore + 0.4 * modulationScore + 0.15 * voicedScore;
  }
  vocalEvidence = clamp(vocalEvidence, 0, 1);

  let audioType: ClassifiedAudioType;
  let confidence: number;
  let guidanceVi: string;

  if (vocalEvidence >= 0.55 && vocalBandRatio >= 0.3) {
    audioType = "VOCAL_FULL";
    confidence = clamp(0.56 + (vocalEvidence - 0.55) * 0.9, 0.56, 0.96);
    guidanceVi =
      "Phát hiện bài hát có giọng hát. Hệ thống có thể tự đọc lời nhúng hoặc nhận diện giọng hát miễn phí nếu chưa có lời.";
  } else if (
    vocalEvidence <= 0.38 ||
    vocalBandRatio < 0.24 ||
    (hasStereoSeparation && midSideRatio < 0.9 && vocalBandRatio < 0.55)
  ) {
    audioType = "INSTRUMENTAL_ONLY";
    confidence = clamp(
      0.56 + (0.45 - Math.min(vocalEvidence, 0.45)) * 0.9,
      0.56,
      0.95,
    );
    guidanceVi =
      "Phát hiện nhạc nền không lời (Instrumental). Bạn nên dán lời bài hát hoặc chọn file .lrc kèm theo để tự tạo mốc nhanh.";
  } else {
    audioType = "UNKNOWN";
    confidence = 0.45;
    guidanceVi =
      "Chưa chắc chắn bài hát có giọng hay chỉ có nhạc nền. Bạn có thể bấm Tự động tạo karaoke hoặc chọn loại nhạc thủ công.";
  }

  return {
    audioType,
    estimatedBpm,
    confidence: roundMetric(confidence),
    guidanceVi,
    metrics: {
      midSideRatio: roundMetric(midSideRatio),
      vocalBandRatio: roundMetric(vocalBandRatio),
      modulationDepth: roundMetric(modulationDepth),
      voicedFrameRatio: roundMetric(voicedFrameRatio),
      isStereo: hasStereoSeparation,
    },
  };
}

type BrowserAudioContextCtor = new () => {
  decodeAudioData(audioData: ArrayBuffer): Promise<AudioBufferLike>;
  close(): Promise<void>;
};

function getAudioContextCtor(): BrowserAudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    AudioContext?: BrowserAudioContextCtor;
    webkitAudioContext?: BrowserAudioContextCtor;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

/** Decode an uploaded File in the browser (0 MB server RAM) and classify its audio type. */
export async function classifyAudioFile(
  file: File,
): Promise<AudioClassificationResult> {
  const Ctor = getAudioContextCtor();
  if (!Ctor || typeof file.arrayBuffer !== "function") {
    return {
      audioType: "UNKNOWN",
      estimatedBpm: null,
      confidence: 0,
      guidanceVi:
        "Trình duyệt chưa hỗ trợ phân tích âm thanh tự động. Bạn vẫn có thể tải MP3 bình thường.",
      metrics: {
        midSideRatio: 0,
        vocalBandRatio: 0,
        modulationDepth: 0,
        voicedFrameRatio: 0,
        isStereo: false,
      },
    };
  }

  let ctx: InstanceType<BrowserAudioContextCtor> | null = null;
  try {
    const raw = await file.arrayBuffer();
    ctx = new Ctor();
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    return classifyAudioBuffer(decoded);
  } catch {
    return {
      audioType: "UNKNOWN",
      estimatedBpm: null,
      confidence: 0,
      guidanceVi:
        "Không thể tự phân loại âm thanh trên trình duyệt. Máy chủ vẫn sẽ đọc thẻ ID3 và kiểm tra file MP3 khi tải lên.",
      metrics: {
        midSideRatio: 0,
        vocalBandRatio: 0,
        modulationDepth: 0,
        voicedFrameRatio: 0,
        isStereo: false,
      },
    };
  } finally {
    if (ctx) {
      await ctx.close().catch(() => {});
    }
  }
}
