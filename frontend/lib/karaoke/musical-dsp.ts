/**
 * Real client-side Web Audio DSP core for ViRead Musical Karaoke.
 *
 * - Pure TypeScript, zero paid APIs, zero raw audio persisted or uploaded.
 * - YIN fundamental frequency (F0) detector tuned for primary-school child vocals
 *   (130 Hz – 880 Hz) with Cumulative Mean Normalized Difference (CMND),
 *   parabolic interpolation, and periodicity/clarity confidence (0..1).
 * - Vocal-band energy + half-wave rectified spectral-flux onset detector
 *   aligned strictly to the native media playback clock (`currentTimeMs`).
 * - Quality gate distinguishing genuine singing from silence, room noise,
 *   50/60 Hz electrical hum, and constant backing-track speaker bleed.
 * - Pre-allocated typed-array workspaces so real-time monitoring performs
 *   zero heavy heap allocations per audio frame.
 */

export const CHILD_MIN_F0_HZ = 130;
export const CHILD_MAX_F0_HZ = 880;
/** Extended upper bound (~C6) for high-pitched primary-school child singing. */
export const CHILD_EXTENDED_MAX_F0_HZ = 1100;
export const DEFAULT_DSP_SAMPLE_RATE = 48_000;
export const DEFAULT_DSP_FRAME_SIZE = 2048;
export const MIC_LATENCY_MIN_MS = -250;
export const MIC_LATENCY_MAX_MS = 250;
export const DEFAULT_MIC_LATENCY_MS = 40;

export interface LivePitchSample {
  timeMs: number;
  rawMidi: number | null;
  smoothedMidi: number | null;
  frequencyHz: number | null;
  clarity: number;
  rms: number;
  vocalBandRms: number;
  voiced: boolean;
  signalState: LiveDspTelemetry["signalState"];
}

/**
 * Low-latency (<40 ms) real-time F0 pitch smoother with:
 * - 3-frame spike/outlier rejection
 * - Octave-jump guard (suppresses isolated ±12 semitone errors)
 * - Light exponential moving average (EMA) for silk-smooth 60fps drawing
 */
export class RealtimePitchSmoother {
  private lastMidi: number | null = null;
  private pendingJumpMidi: number | null = null;
  private pendingJumpCount = 0;
  private unvoicedStreak = 0;
  private readonly alpha: number;

  constructor(alpha = 0.38) {
    this.alpha = Math.min(0.85, Math.max(0.15, alpha));
  }

  reset(): void {
    this.lastMidi = null;
    this.pendingJumpMidi = null;
    this.pendingJumpCount = 0;
    this.unvoicedStreak = 0;
  }

  update(rawMidi: number | null, voiced: boolean): number | null {
    if (!voiced || rawMidi === null || !Number.isFinite(rawMidi)) {
      this.unvoicedStreak++;
      this.pendingJumpMidi = null;
      this.pendingJumpCount = 0;
      if (this.unvoicedStreak >= 3) {
        this.lastMidi = null;
      }
      return null;
    }

    this.unvoicedStreak = 0;
    if (this.lastMidi === null) {
      this.lastMidi = rawMidi;
      this.pendingJumpMidi = null;
      this.pendingJumpCount = 0;
      return rawMidi;
    }

    let candidate = rawMidi;
    const diff = candidate - this.lastMidi;

    // Guard isolated single-frame ±12 semitone octave jumps.
    if (Math.abs(Math.abs(diff) - 12) <= 1.8) {
      if (
        this.pendingJumpMidi !== null &&
        Math.abs(candidate - this.pendingJumpMidi) <= 1.5
      ) {
        this.pendingJumpCount++;
        if (this.pendingJumpCount < 2) {
          // Fold back for 1 confirmation frame so brief harmonic glitches never jump.
          candidate -= 12 * Math.sign(diff);
        }
      } else {
        this.pendingJumpMidi = candidate;
        this.pendingJumpCount = 1;
        candidate -= 12 * Math.sign(diff);
      }
    } else if (Math.abs(diff) > 6.5) {
      // Large sudden jump (>6.5 semitones): confirm over 2 consecutive frames before snapping.
      if (
        this.pendingJumpMidi !== null &&
        Math.abs(candidate - this.pendingJumpMidi) <= 2.0
      ) {
        this.pendingJumpCount++;
        if (this.pendingJumpCount >= 2) {
          this.lastMidi = candidate;
          this.pendingJumpMidi = null;
          this.pendingJumpCount = 0;
          return candidate;
        }
      } else {
        this.pendingJumpMidi = candidate;
        this.pendingJumpCount = 1;
      }
      return this.lastMidi;
    } else {
      this.pendingJumpMidi = null;
      this.pendingJumpCount = 0;
    }

    const smoothed = this.lastMidi + this.alpha * (candidate - this.lastMidi);
    this.lastMidi = smoothed;
    return smoothed;
  }
}

const FFT_SIZE = 512;
const EPS = 1e-12;

export type AcousticGateReason =
  | "OK"
  | "SILENCE"
  | "NOISE_ONLY"
  | "ELECTRICAL_HUM"
  | "SPEAKER_BLEED"
  | "LOW_COVERAGE";

export interface YinOptions {
  minF0Hz?: number;
  maxF0Hz?: number;
  threshold?: number;
  fallbackThreshold?: number;
  minVocalRms?: number;
  minClarity?: number;
}

export interface YinPitchResult {
  frequencyHz: number | null;
  midiNote: number | null;
  clarity: number;
  cmndMin: number;
  rms: number;
  rmsDb: number;
  vocalBandRms: number;
  lowBandRatio: number;
  highBandRatio: number;
  zeroCrossingRate: number;
  voiced: boolean;
  isHumLike: boolean;
  clipped: boolean;
}

export interface DspFrame {
  timeMs: number;
  frequencyHz: number | null;
  midiNote: number | null;
  clarity: number;
  rms: number;
  rmsDb: number;
  vocalBandRms: number;
  lowBandRatio: number;
  highBandRatio: number;
  spectralFlux: number;
  spectralFlatness: number;
  zeroCrossingRate: number;
  voiced: boolean;
  isHumLike: boolean;
  inLyricSpan: boolean;
  isOnset: boolean;
}

export interface DspOnset {
  timeMs: number;
  strength: number;
  vocalBandRms: number;
  frequencyHz: number | null;
  clarity: number;
}

export interface LyricTimeSpan {
  startMs: number;
  endMs: number;
}

export interface DspQualityGate {
  passed: boolean;
  reason: AcousticGateReason;
  speakerBleedSuspected: boolean;
  bleedScore: number;
  noiseFloorRms: number;
  meanVocalRms: number;
  peakVocalRms: number;
  rmsModulationCv: number;
  lyricMeanRms: number;
  gapMeanRms: number;
  lyricToGapRatio: number | null;
  meanClarity: number;
  meanSpectralFlatness: number;
  humRatio: number;
  silentRatio: number;
  noiseRatio: number;
  voicedCoverageRatio: number;
  activeVocalCoverageRatio: number;
}

export interface DspSessionSummary {
  sampleRate: number;
  frameCount: number;
  activeLyricFrameCount: number;
  voicedFrameCount: number;
  voicedInLyricsCount: number;
  frames: DspFrame[];
  onsets: DspOnset[];
  qualityGate: DspQualityGate;
}

export interface LiveDspTelemetry {
  timeMs: number;
  frequencyHz: number | null;
  midiNote: number | null;
  clarity: number;
  rms: number;
  vocalBandRms: number;
  voiced: boolean;
  signalState: "singing" | "quiet" | "noise" | "hum" | "bleed";
  onsetCount: number;
}

export interface YinWorkspace {
  sampleRate: number;
  frameSize: number;
  maxLag: number;
  diff: Float32Array;
  cmnd: Float32Array;
  hp1: Float32Array;
  hp2: Float32Array;
  vocalBand: Float32Array;
  fftRe: Float32Array;
  fftIm: Float32Array;
  fftWindow: Float32Array;
  prevMag: Float32Array;
  currMag: Float32Array;
  bitReverse: Uint16Array;
  cosTable: Float32Array;
  sinTable: Float32Array;
}

/** Convert frequency in Hz to continuous MIDI note number (A4 = 440 Hz = 69). */
export function hzToMidi(hz: number): number {
  if (!Number.isFinite(hz) || hz <= 0) return Number.NaN;
  return 69 + 12 * Math.log2(hz / 440);
}

/** Convert MIDI note number to frequency in Hz. */
export function midiToHz(midi: number): number {
  if (!Number.isFinite(midi)) return Number.NaN;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Signed semitone distance between two frequencies (positive = sung sharper). */
export function semitoneDifference(sungHz: number, refHz: number): number {
  if (
    !Number.isFinite(sungHz) ||
    !Number.isFinite(refHz) ||
    sungHz <= 0 ||
    refHz <= 0
  ) {
    return Number.NaN;
  }
  return 12 * Math.log2(sungHz / refHz);
}

/**
 * Octave-invariant signed semitone error wrapped to [-6, +6] semitones.
 * A child singing C5 (523.25 Hz) against an adult C4 (261.63 Hz) yields 0.0.
 */
export function octaveInvariantSemitoneError(
  sungHz: number,
  refHz: number,
): number {
  const raw = semitoneDifference(sungHz, refHz);
  if (!Number.isFinite(raw)) return Number.NaN;
  const wrapped = ((((raw + 6) % 12) + 12) % 12) - 6;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/** Absolute octave-invariant error in cents ([0, 600]). */
export function octaveInvariantCentsError(
  sungHz: number,
  refHz: number,
): number {
  const semitones = octaveInvariantSemitoneError(sungHz, refHz);
  return Number.isFinite(semitones) ? Math.abs(semitones) * 100 : Number.NaN;
}

/** Discrete pitch class [0..11] where C=0, C#=1, ..., B=11. */
export function pitchClassFromHz(hz: number): number | null {
  const midi = hzToMidi(hz);
  if (!Number.isFinite(midi)) return null;
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** Clamp helper. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** Convert linear RMS to dBFS floored at -100 dB. */
export function rmsToDb(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 1e-5) return -100;
  return Math.max(-100, 20 * Math.log10(rms));
}

/** Pre-allocate reusable typed arrays for zero-GC real-time DSP frames. */
export function createYinWorkspace(
  sampleRate = DEFAULT_DSP_SAMPLE_RATE,
  minF0Hz = CHILD_MIN_F0_HZ,
  frameSize = DEFAULT_DSP_FRAME_SIZE,
): YinWorkspace {
  const safeRate = Math.max(8000, Math.round(sampleRate));
  const safeSize = Math.max(256, frameSize);
  const maxLag = Math.min(
    Math.floor(safeSize / 2) - 2,
    Math.ceil(safeRate / Math.max(50, minF0Hz)) + 2,
  );
  const fftWindow = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    fftWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  const bitReverse = new Uint16Array(FFT_SIZE);
  const bits = Math.round(Math.log2(FFT_SIZE));
  for (let i = 0; i < FFT_SIZE; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    bitReverse[i] = r;
  }
  const half = FFT_SIZE >> 1;
  const cosTable = new Float32Array(half);
  const sinTable = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    const angle = (-2 * Math.PI * i) / FFT_SIZE;
    cosTable[i] = Math.cos(angle);
    sinTable[i] = Math.sin(angle);
  }
  return {
    sampleRate: safeRate,
    frameSize: safeSize,
    maxLag: Math.max(4, maxLag),
    diff: new Float32Array(Math.max(8, maxLag + 4)),
    cmnd: new Float32Array(Math.max(8, maxLag + 4)),
    hp1: new Float32Array(safeSize),
    hp2: new Float32Array(safeSize),
    vocalBand: new Float32Array(safeSize),
    fftRe: new Float32Array(FFT_SIZE),
    fftIm: new Float32Array(FFT_SIZE),
    fftWindow,
    prevMag: new Float32Array(half),
    currMag: new Float32Array(half),
    bitReverse,
    cosTable,
    sinTable,
  };
}

/** Apply 2nd-order Butterworth high-pass biquad filter in-place (zero allocations). */
function applyHighPassBiquad(
  input: Float32Array,
  output: Float32Array,
  length: number,
  sampleRate: number,
  cutoffHz: number,
): void {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 + cosW0) / 2 / a0;
  const b1 = -(1 + cosW0) / a0;
  const b2 = b0;
  const a1 = (-2 * cosW0) / a0;
  const a2 = (1 - alpha) / a0;

  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    output[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
}

/** Apply 2nd-order Butterworth low-pass biquad filter (zero allocations). */
function applyLowPassBiquad(
  input: Float32Array,
  output: Float32Array,
  length: number,
  sampleRate: number,
  cutoffHz: number,
): void {
  const w0 = (2 * Math.PI * Math.min(cutoffHz, sampleRate * 0.45)) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 - cosW0) / 2 / a0;
  const b1 = (1 - cosW0) / a0;
  const b2 = b0;
  const a1 = (-2 * cosW0) / a0;
  const a2 = (1 - alpha) / a0;

  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    output[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
}

/** In-place radix-2 Cooley-Tukey FFT using workspace tables (zero allocations). */
function computeRadix2Fft(ws: YinWorkspace): void {
  const n = FFT_SIZE;
  const re = ws.fftRe;
  const im = ws.fftIm;
  const rev = ws.bitReverse;

  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const tableStep = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < halfSize; j++, k += tableStep) {
        const idxA = i + j;
        const idxB = idxA + halfSize;
        const c = ws.cosTable[k];
        const s = ws.sinTable[k];
        const tRe = re[idxB] * c - im[idxB] * s;
        const tIm = re[idxB] * s + im[idxB] * c;
        re[idxB] = re[idxA] - tRe;
        im[idxB] = im[idxA] - tIm;
        re[idxA] += tRe;
        im[idxA] += tIm;
      }
    }
  }
}

/**
 * Pure TypeScript YIN fundamental frequency detector (de Cheveigné & Kawahara, 2002)
 * with 4th-order 115 Hz hum-rejection high-pass, CMND, and parabolic interpolation.
 */
export function detectPitchYIN(
  samples: Float32Array,
  sampleRate = DEFAULT_DSP_SAMPLE_RATE,
  options: YinOptions = {},
  providedWorkspace?: YinWorkspace,
): YinPitchResult {
  const minF0Hz = options.minF0Hz ?? CHILD_MIN_F0_HZ;
  const maxF0Hz = options.maxF0Hz ?? CHILD_MAX_F0_HZ;
  const threshold = options.threshold ?? 0.18;
  const fallbackThreshold = options.fallbackThreshold ?? 0.28;
  const minVocalRms = options.minVocalRms ?? 0.005;
  const minClarity = options.minClarity ?? 0.72;

  const n = samples.length;
  if (n < 128 || !Number.isFinite(sampleRate) || sampleRate < 8000) {
    return {
      frequencyHz: null,
      midiNote: null,
      clarity: 0,
      cmndMin: 1,
      rms: 0,
      rmsDb: -100,
      vocalBandRms: 0,
      lowBandRatio: 0,
      highBandRatio: 0,
      zeroCrossingRate: 0,
      voiced: false,
      isHumLike: false,
      clipped: false,
    };
  }

  const ws =
    providedWorkspace &&
    providedWorkspace.frameSize >= n &&
    providedWorkspace.sampleRate === Math.round(sampleRate)
      ? providedWorkspace
      : createYinWorkspace(sampleRate, minF0Hz, n);

  // Pass 1: DC offset, full-band RMS, clipping, zero-crossing rate.
  let mean = 0;
  let clipCount = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (!Number.isFinite(s)) {
      return {
        frequencyHz: null,
        midiNote: null,
        clarity: 0,
        cmndMin: 1,
        rms: 0,
        rmsDb: -100,
        vocalBandRms: 0,
        lowBandRatio: 0,
        highBandRatio: 0,
        zeroCrossingRate: 0,
        voiced: false,
        isHumLike: false,
        clipped: true,
      };
    }
    mean += s;
    if (Math.abs(s) >= 0.995) clipCount++;
  }
  mean /= n;

  let fullEnergy = 0;
  let crossings = 0;
  let prevCentered = samples[0] - mean;
  ws.hp1[0] = prevCentered;
  fullEnergy += prevCentered * prevCentered;
  for (let i = 1; i < n; i++) {
    const centered = samples[i] - mean;
    ws.hp1[i] = centered;
    fullEnergy += centered * centered;
    if (
      (centered >= 0 && prevCentered < 0) ||
      (centered < 0 && prevCentered >= 0)
    ) {
      crossings++;
    }
    prevCentered = centered;
  }
  const rms = Math.sqrt(fullEnergy / n);
  const rmsDb = rmsToDb(rms);
  const zeroCrossingRate = crossings / Math.max(1, n - 1);
  const clipped = clipCount > n * 0.05;

  if (rms < 0.0015) {
    return {
      frequencyHz: null,
      midiNote: null,
      clarity: 0,
      cmndMin: 1,
      rms,
      rmsDb,
      vocalBandRms: 0,
      lowBandRatio: 0,
      highBandRatio: 0,
      zeroCrossingRate,
      voiced: false,
      isHumLike: false,
      clipped,
    };
  }

  // Pass 2: 4th-order 115 Hz high-pass (attenuates 50/60 Hz hum by ~23 dB)
  // + 3500 Hz low-pass for vocal-band energy isolation.
  applyHighPassBiquad(ws.hp1, ws.hp2, n, sampleRate, 115);
  applyHighPassBiquad(ws.hp2, ws.hp1, n, sampleRate, 115);
  applyLowPassBiquad(ws.hp1, ws.vocalBand, n, sampleRate, 3500);

  let hpEnergy = 0;
  let vocalEnergy = 0;
  // Skip first 32 transient samples for clean steady-state band-energy ratio.
  const energyStart = Math.min(32, n >> 3);
  const energyCount = Math.max(1, n - energyStart);
  let trimmedFullEnergy = 0;
  for (let i = energyStart; i < n; i++) {
    const raw = samples[i] - mean;
    trimmedFullEnergy += raw * raw;
    const hp = ws.hp1[i];
    hpEnergy += hp * hp;
    const vb = ws.vocalBand[i];
    vocalEnergy += vb * vb;
  }

  const vocalBandRms = Math.sqrt(vocalEnergy / energyCount);
  const lowBandEnergy = Math.max(0, trimmedFullEnergy - hpEnergy);
  const highBandEnergy = Math.max(0, hpEnergy - vocalEnergy);
  const lowBandRatio = clamp01(lowBandEnergy / (trimmedFullEnergy + EPS));
  const highBandRatio = clamp01(highBandEnergy / (trimmedFullEnergy + EPS));
  const isHumLike = lowBandRatio >= 0.65 && rms >= 0.003;

  if (isHumLike || vocalBandRms < minVocalRms) {
    return {
      frequencyHz: null,
      midiNote: null,
      clarity: 0,
      cmndMin: 1,
      rms,
      rmsDb,
      vocalBandRms,
      lowBandRatio,
      highBandRatio,
      zeroCrossingRate,
      voiced: false,
      isHumLike,
      clipped,
    };
  }

  // Pass 3: YIN difference function + CMND on vocal-band filtered signal.
  // Include a small 6% search margin so exact boundary pitches (130 Hz / 880 Hz)
  // always have interior neighbors for parabolic interpolation.
  const minLag = Math.max(2, Math.floor(sampleRate / (maxF0Hz * 1.06)));
  const maxLag = Math.min(
    ws.maxLag,
    Math.floor(n / 2) - 2,
    Math.ceil(sampleRate / (minF0Hz * 0.94)),
  );
  if (maxLag <= minLag + 1) {
    return {
      frequencyHz: null,
      midiNote: null,
      clarity: 0,
      cmndMin: 1,
      rms,
      rmsDb,
      vocalBandRms,
      lowBandRatio,
      highBandRatio,
      zeroCrossingRate,
      voiced: false,
      isHumLike,
      clipped,
    };
  }

  const startOffset = energyStart;
  const windowLen = Math.min(
    Math.floor((n - startOffset) / 2),
    n - startOffset - maxLag - 2,
  );
  const signal = ws.vocalBand;
  const diff = ws.diff;
  const cmnd = ws.cmnd;

  diff[0] = 0;
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    let sum = 0;
    for (let j = 0; j < windowLen; j++) {
      const delta = signal[startOffset + j] - signal[startOffset + j + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
    runningSum += sum;
    cmnd[tau] = runningSum > EPS ? (sum * tau) / runningSum : 1;
  }

  // Pass 4: Absolute threshold search with local-minimum descent.
  let bestTau = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) {
        tau++;
      }
      bestTau = tau;
      break;
    }
  }

  let globalMinTau = minLag;
  let globalMinVal = cmnd[minLag];
  for (let tau = minLag + 1; tau <= maxLag; tau++) {
    if (cmnd[tau] < globalMinVal) {
      globalMinVal = cmnd[tau];
      globalMinTau = tau;
    }
  }

  if (bestTau === -1 && globalMinVal <= fallbackThreshold) {
    bestTau = globalMinTau;
  }

  const cmndMin = bestTau !== -1 ? cmnd[bestTau] : globalMinVal;
  const clarity = clamp01(1 - cmndMin);

  if (bestTau === -1 || clarity < minClarity) {
    return {
      frequencyHz: null,
      midiNote: null,
      clarity,
      cmndMin,
      rms,
      rmsDb,
      vocalBandRms,
      lowBandRatio,
      highBandRatio,
      zeroCrossingRate,
      voiced: false,
      isHumLike: false,
      clipped,
    };
  }

  // Pass 5: Parabolic interpolation around bestTau.
  let refinedTau = bestTau;
  if (bestTau > minLag && bestTau < maxLag) {
    const s0 = cmnd[bestTau - 1];
    const s1 = cmnd[bestTau];
    const s2 = cmnd[bestTau + 1];
    const denom = 2 * (s0 - 2 * s1 + s2);
    if (Math.abs(denom) > EPS) {
      const shift = (s0 - s2) / denom;
      if (Number.isFinite(shift)) {
        refinedTau = bestTau + Math.max(-0.5, Math.min(0.5, shift));
      }
    }
  }

  const frequencyHz = sampleRate / refinedTau;
  const inRange =
    frequencyHz >= minF0Hz * 0.98 && frequencyHz <= maxF0Hz * 1.02;
  const voiced = inRange && clarity >= minClarity && !clipped;

  return {
    frequencyHz: voiced ? frequencyHz : null,
    midiNote: voiced ? hzToMidi(frequencyHz) : null,
    clarity,
    cmndMin,
    rms,
    rmsDb,
    vocalBandRms,
    lowBandRatio,
    highBandRatio,
    zeroCrossingRate,
    voiced,
    isHumLike: false,
    clipped,
  };
}

/** Compute vocal-band spectral flux and spectral flatness using pre-allocated FFT buffers. */
function analyzeVocalSpectrum(
  ws: YinWorkspace,
  sampleLength: number,
  sampleRate: number,
  hasPrevSpectrum: boolean,
): { spectralFlux: number; spectralFlatness: number } {
  // Decimate 2x when sampleLength >= 1024 so 512-pt FFT covers 1024 samples (~21 ms @ 48 kHz).
  const stride = sampleLength >= FFT_SIZE * 2 ? 2 : 1;
  const effectiveRate = sampleRate / stride;
  const offset = Math.max(0, sampleLength - FFT_SIZE * stride);

  const src = ws.vocalBand;
  const re = ws.fftRe;
  const im = ws.fftIm;
  const win = ws.fftWindow;
  for (let i = 0; i < FFT_SIZE; i++) {
    const idx = offset + i * stride;
    re[i] = (idx < sampleLength ? src[idx] : 0) * win[i];
    im[i] = 0;
  }

  computeRadix2Fft(ws);

  const half = FFT_SIZE >> 1;
  const binHz = effectiveRate / FFT_SIZE;
  const minBin = Math.max(1, Math.floor(130 / binHz));
  const maxBin = Math.min(half - 1, Math.ceil(3500 / binHz));
  const binCount = Math.max(1, maxBin - minBin + 1);

  let fluxSum = 0;
  let logSum = 0;
  let arithSum = 0;
  for (let k = minBin; k <= maxBin; k++) {
    const mag = Math.hypot(re[k], im[k]) / FFT_SIZE;
    ws.currMag[k] = mag;
    const logMag = Math.log1p(mag * 40);
    if (hasPrevSpectrum) {
      const prevLog = Math.log1p(ws.prevMag[k] * 40);
      const diff = logMag - prevLog;
      if (diff > 0) fluxSum += diff;
    }
    ws.prevMag[k] = mag;
    const power = mag * mag + EPS;
    logSum += Math.log(power);
    arithSum += power;
  }

  const spectralFlux = fluxSum / binCount;
  const geomMean = Math.exp(logSum / binCount);
  const arithMean = arithSum / binCount;
  const spectralFlatness = clamp01(geomMean / (arithMean + EPS));

  return { spectralFlux, spectralFlatness };
}

function isInsideAnySpan(
  timeMs: number,
  spans: readonly LyricTimeSpan[],
): boolean {
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (timeMs >= s.startMs && timeMs <= s.endMs) return true;
  }
  return false;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[idx];
}

/**
 * Stateful session-scoped DSP analyzer.
 * Consumes PCM frames stamped by the song's playback clock (`currentTimeMs`)
 * and emits compact numeric telemetry + end-of-session quality gate summary.
 */
export class MusicalDspAnalyzer {
  private readonly ws: YinWorkspace;
  private readonly sampleRate: number;
  private readonly lyricSpans: LyricTimeSpan[];
  private readonly headphoneMode: boolean;
  private readonly maxF0Hz: number;
  private micLatencyMs: number;
  private readonly frames: DspFrame[] = [];
  private readonly onsets: DspOnset[] = [];
  private readonly pitchSmoother = new RealtimePitchSmoother(0.38);
  private readonly pitchRing: LivePitchSample[] = [];
  private readonly maxPitchRingSize = 600;

  private hasPrevSpectrum = false;
  private prevVocalRms = 0;
  private prevVoiced = false;
  private prevFrequencyHz: number | null = null;
  private lastOnsetMs = -Infinity;

  // Ring buffer of recent novelty values for adaptive onset thresholding (zero GC).
  private readonly noveltyRing = new Float32Array(16);
  private noveltyRingIndex = 0;
  private noveltyRingCount = 0;

  constructor(
    options: {
      sampleRate?: number;
      frameSize?: number;
      lyricSpans?: LyricTimeSpan[];
      headphoneMode?: boolean;
      maxF0Hz?: number;
      micLatencyMs?: number;
    } = {},
  ) {
    this.sampleRate = Math.max(
      8000,
      Math.round(options.sampleRate ?? DEFAULT_DSP_SAMPLE_RATE),
    );
    this.lyricSpans = options.lyricSpans ?? [];
    this.headphoneMode = options.headphoneMode ?? false;
    this.maxF0Hz = options.maxF0Hz ?? CHILD_EXTENDED_MAX_F0_HZ;
    this.micLatencyMs = Math.max(
      MIC_LATENCY_MIN_MS,
      Math.min(MIC_LATENCY_MAX_MS, Math.round(options.micLatencyMs ?? 0)),
    );
    this.ws = createYinWorkspace(
      this.sampleRate,
      CHILD_MIN_F0_HZ,
      options.frameSize ?? DEFAULT_DSP_FRAME_SIZE,
    );
  }

  setMicLatencyMs(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.micLatencyMs = Math.max(
      MIC_LATENCY_MIN_MS,
      Math.min(MIC_LATENCY_MAX_MS, Math.round(ms)),
    );
  }

  getPitchRing(): readonly LivePitchSample[] {
    return this.pitchRing;
  }

  getLatestPitchSample(): LivePitchSample | null {
    return this.pitchRing.length > 0
      ? this.pitchRing[this.pitchRing.length - 1]
      : null;
  }

  reset(): void {
    this.frames.length = 0;
    this.onsets.length = 0;
    this.pitchRing.length = 0;
    this.pitchSmoother.reset();
    this.hasPrevSpectrum = false;
    this.prevVocalRms = 0;
    this.prevVoiced = false;
    this.prevFrequencyHz = null;
    this.lastOnsetMs = -Infinity;
    this.noveltyRing.fill(0);
    this.noveltyRingIndex = 0;
    this.noveltyRingCount = 0;
    this.ws.prevMag.fill(0);
  }

  /** Analyze one PCM frame at exact audio-clock timestamp `timeMs` (with latency compensation). */
  processFrame(samples: Float32Array, rawTimeMs: number): DspFrame {
    const timeMs = Math.max(0, Math.round(rawTimeMs - this.micLatencyMs));
    const pitch = detectPitchYIN(
      samples,
      this.sampleRate,
      { maxF0Hz: this.maxF0Hz },
      this.ws,
    );
    const { spectralFlux, spectralFlatness } = analyzeVocalSpectrum(
      this.ws,
      samples.length,
      this.sampleRate,
      this.hasPrevSpectrum,
    );
    this.hasPrevSpectrum = true;

    const inLyricSpan =
      this.lyricSpans.length === 0 || isInsideAnySpan(timeMs, this.lyricSpans);

    // Combined onset novelty: spectral flux + positive vocal-band log-energy rise.
    const logCurr = Math.log1p(pitch.vocalBandRms * 60);
    const logPrev = Math.log1p(this.prevVocalRms * 60);
    const energyRise = Math.max(0, logCurr - logPrev);
    const novelty = 0.55 * spectralFlux + 0.45 * energyRise;

    // Adaptive baseline over recent ring buffer.
    let ringSum = 0;
    for (let i = 0; i < this.noveltyRingCount; i++) {
      ringSum += this.noveltyRing[i];
    }
    const adaptiveMean =
      this.noveltyRingCount > 0 ? ringSum / this.noveltyRingCount : 0;

    // Detect note/syllable attack: either clear novelty spike OR voiced onset/pitch step.
    const voicedEntry =
      pitch.voiced && !this.prevVoiced && pitch.vocalBandRms >= 0.01;
    const pitchJumpSemitones =
      pitch.voiced &&
      this.prevVoiced &&
      pitch.frequencyHz !== null &&
      this.prevFrequencyHz !== null
        ? Math.abs(semitoneDifference(pitch.frequencyHz, this.prevFrequencyHz))
        : 0;
    const strongNoveltySpike =
      novelty > Math.max(0.085, adaptiveMean * 1.9 + 0.035) &&
      pitch.vocalBandRms >= 0.01 &&
      !pitch.isHumLike &&
      spectralFlatness < 0.48;
    const pitchAttack =
      pitchJumpSemitones >= 1.2 &&
      (energyRise > 0.04 || spectralFlux > 0.03) &&
      pitch.vocalBandRms >= 0.01;

    const refractoryOk = timeMs - this.lastOnsetMs >= 115;
    const isOnset =
      refractoryOk && (voicedEntry || strongNoveltySpike || pitchAttack);

    if (isOnset) {
      this.lastOnsetMs = timeMs;
      this.onsets.push({
        timeMs,
        strength: Number((novelty + (voicedEntry ? 0.12 : 0)).toFixed(4)),
        vocalBandRms: pitch.vocalBandRms,
        frequencyHz: pitch.frequencyHz,
        clarity: pitch.clarity,
      });
    }

    this.noveltyRing[this.noveltyRingIndex] = novelty;
    this.noveltyRingIndex =
      (this.noveltyRingIndex + 1) % this.noveltyRing.length;
    if (this.noveltyRingCount < this.noveltyRing.length) {
      this.noveltyRingCount++;
    }
    this.prevVocalRms = pitch.vocalBandRms;
    this.prevVoiced = pitch.voiced;
    this.prevFrequencyHz = pitch.frequencyHz;

    const frame: DspFrame = {
      timeMs,
      frequencyHz: pitch.frequencyHz,
      midiNote: pitch.midiNote,
      clarity: pitch.clarity,
      rms: pitch.rms,
      rmsDb: pitch.rmsDb,
      vocalBandRms: pitch.vocalBandRms,
      lowBandRatio: pitch.lowBandRatio,
      highBandRatio: pitch.highBandRatio,
      spectralFlux,
      spectralFlatness,
      zeroCrossingRate: pitch.zeroCrossingRate,
      voiced: pitch.voiced,
      isHumLike: pitch.isHumLike,
      inLyricSpan,
      isOnset,
    };
    this.frames.push(frame);

    const smoothedMidi = this.pitchSmoother.update(
      pitch.midiNote,
      pitch.voiced && !pitch.isHumLike && spectralFlatness < 0.35,
    );
    let signalState: LiveDspTelemetry["signalState"] = "quiet";
    if (pitch.isHumLike) signalState = "hum";
    else if (pitch.rms < 0.004) signalState = "quiet";
    else if (pitch.voiced && spectralFlatness < 0.35) signalState = "singing";
    else if (spectralFlatness >= 0.35 || pitch.clarity < 0.45)
      signalState = "noise";
    else signalState = "bleed";

    this.pitchRing.push({
      timeMs,
      rawMidi: pitch.midiNote,
      smoothedMidi,
      frequencyHz: pitch.frequencyHz,
      clarity: pitch.clarity,
      rms: pitch.rms,
      vocalBandRms: pitch.vocalBandRms,
      voiced: pitch.voiced && !pitch.isHumLike,
      signalState,
    });
    if (this.pitchRing.length > this.maxPitchRingSize) {
      this.pitchRing.splice(0, this.pitchRing.length - this.maxPitchRingSize);
    }

    return frame;
  }

  /** Latest lightweight telemetry for UI HUD (never holds raw audio). */
  getLiveTelemetry(): LiveDspTelemetry | null {
    const last = this.frames[this.frames.length - 1];
    if (!last) return null;
    let signalState: LiveDspTelemetry["signalState"] = "quiet";
    if (last.isHumLike) signalState = "hum";
    else if (last.rms < 0.004) signalState = "quiet";
    else if (last.voiced && last.spectralFlatness < 0.35)
      signalState = "singing";
    else if (last.spectralFlatness >= 0.35 || last.clarity < 0.45)
      signalState = "noise";
    else signalState = "bleed";

    return {
      timeMs: last.timeMs,
      frequencyHz: last.frequencyHz,
      midiNote: last.midiNote,
      clarity: last.clarity,
      rms: last.rms,
      vocalBandRms: last.vocalBandRms,
      voiced: last.voiced,
      signalState,
      onsetCount: this.onsets.length,
    };
  }

  /** Compute full session DSP summary & acoustic quality gate. */
  summarize(range?: LyricTimeSpan | null): DspSessionSummary {
    const frames = range
      ? this.frames.filter(
          (f) => f.timeMs >= range.startMs && f.timeMs <= range.endMs,
        )
      : this.frames;
    const onsets = range
      ? this.onsets.filter(
          (o) => o.timeMs >= range.startMs && o.timeMs <= range.endMs,
        )
      : this.onsets;

    const frameCount = frames.length;
    if (frameCount === 0) {
      return {
        sampleRate: this.sampleRate,
        frameCount: 0,
        activeLyricFrameCount: 0,
        voicedFrameCount: 0,
        voicedInLyricsCount: 0,
        frames,
        onsets,
        qualityGate: {
          passed: false,
          reason: "SILENCE",
          speakerBleedSuspected: false,
          bleedScore: 0,
          noiseFloorRms: 0,
          meanVocalRms: 0,
          peakVocalRms: 0,
          rmsModulationCv: 0,
          lyricMeanRms: 0,
          gapMeanRms: 0,
          lyricToGapRatio: null,
          meanClarity: 0,
          meanSpectralFlatness: 0,
          humRatio: 0,
          silentRatio: 1,
          noiseRatio: 0,
          voicedCoverageRatio: 0,
          activeVocalCoverageRatio: 0,
        },
      };
    }

    let silentCount = 0;
    let humCount = 0;
    let noiseCount = 0;
    let voicedCount = 0;
    let activeLyricFrameCount = 0;
    let voicedInLyricsCount = 0;
    let activeNonNoiseInLyricsCount = 0;

    let vocalRmsSum = 0;
    let peakVocalRms = 0;
    let lyricRmsSum = 0;
    let gapRmsSum = 0;
    let gapFrameCount = 0;
    let activeClaritySum = 0;
    let activeFlatnessSum = 0;
    let nonSilentCount = 0;

    const allRms: number[] = [];
    const vocalRmsList: number[] = [];

    for (let i = 0; i < frameCount; i++) {
      const f = frames[i];
      allRms.push(f.rms);
      vocalRmsList.push(f.vocalBandRms);
      vocalRmsSum += f.vocalBandRms;
      if (f.vocalBandRms > peakVocalRms) peakVocalRms = f.vocalBandRms;

      const isSilent = f.rms < 0.004;
      const isNoise =
        !isSilent &&
        !f.isHumLike &&
        !f.voiced &&
        (f.spectralFlatness >= 0.34 || f.clarity < 0.45);

      if (isSilent) silentCount++;
      else {
        nonSilentCount++;
        activeClaritySum += f.clarity;
        activeFlatnessSum += f.spectralFlatness;
      }
      if (f.isHumLike) humCount++;
      if (isNoise) noiseCount++;
      if (f.voiced) voicedCount++;

      if (f.inLyricSpan) {
        activeLyricFrameCount++;
        lyricRmsSum += f.vocalBandRms;
        if (f.voiced) voicedInLyricsCount++;
        if (!isSilent && !f.isHumLike && !isNoise && f.vocalBandRms >= 0.008) {
          activeNonNoiseInLyricsCount++;
        }
      } else {
        gapFrameCount++;
        gapRmsSum += f.vocalBandRms;
      }
    }

    const noiseFloorRms = percentile(allRms, 0.15);
    const meanVocalRms = vocalRmsSum / frameCount;
    let varianceSum = 0;
    for (let i = 0; i < vocalRmsList.length; i++) {
      const d = vocalRmsList[i] - meanVocalRms;
      varianceSum += d * d;
    }
    const rmsStd = Math.sqrt(varianceSum / frameCount);
    const rmsModulationCv = meanVocalRms > EPS ? rmsStd / meanVocalRms : 0;

    const lyricMeanRms =
      activeLyricFrameCount > 0
        ? lyricRmsSum / activeLyricFrameCount
        : meanVocalRms;
    const gapMeanRms = gapFrameCount > 0 ? gapRmsSum / gapFrameCount : 0;
    const lyricToGapRatio =
      gapFrameCount >= 4 && gapMeanRms > 0.003
        ? lyricMeanRms / gapMeanRms
        : null;

    const meanClarity =
      nonSilentCount > 0 ? activeClaritySum / nonSilentCount : 0;
    const meanSpectralFlatness =
      nonSilentCount > 0 ? activeFlatnessSum / nonSilentCount : 0;

    const silentRatio = silentCount / frameCount;
    const humRatio = humCount / frameCount;
    const noiseRatio = noiseCount / frameCount;
    const lyricDenom = Math.max(1, activeLyricFrameCount);
    const voicedCoverageRatio = voicedInLyricsCount / lyricDenom;
    const activeVocalCoverageRatio = activeNonNoiseInLyricsCount / lyricDenom;

    // Speaker-bleed scoring: constant low-modulation backing track bleeding into mic
    // without phrase contrast between lyric spans and instrumental gaps.
    let bleedScore = 0;
    if (nonSilentCount > 0 && !this.headphoneMode) {
      if (
        lyricToGapRatio !== null &&
        gapMeanRms >= 0.006 &&
        lyricToGapRatio < 1.32
      ) {
        bleedScore += 0.45;
      }
      if (
        rmsModulationCv < 0.24 &&
        meanVocalRms >= 0.006 &&
        meanVocalRms < 0.06
      ) {
        bleedScore += 0.35;
      }
      if (meanClarity < 0.72 && meanSpectralFlatness > 0.12) {
        bleedScore += 0.25;
      }
      if (onsets.length <= Math.max(1, Math.floor(frameCount / 60))) {
        bleedScore += 0.15;
      }
    }
    bleedScore = clamp01(bleedScore);
    const speakerBleedSuspected =
      !this.headphoneMode &&
      bleedScore >= 0.65 &&
      (lyricToGapRatio === null || lyricToGapRatio < 1.38) &&
      rmsModulationCv < 0.3;

    let reason: AcousticGateReason = "OK";
    if (silentRatio >= 0.85 || peakVocalRms < 0.005) {
      reason = humRatio >= 0.45 ? "ELECTRICAL_HUM" : "SILENCE";
    } else if (humRatio >= 0.5 && voicedCoverageRatio < 0.15) {
      reason = "ELECTRICAL_HUM";
    } else if (
      noiseRatio >= 0.6 &&
      voicedCoverageRatio < 0.15 &&
      activeVocalCoverageRatio < 0.15
    ) {
      reason = "NOISE_ONLY";
    } else if (
      speakerBleedSuspected &&
      (voicedCoverageRatio < 0.35 || meanClarity < 0.7)
    ) {
      reason = "SPEAKER_BLEED";
    } else if (activeVocalCoverageRatio < 0.15) {
      reason = "LOW_COVERAGE";
    }

    const finalBleedSuspected =
      speakerBleedSuspected &&
      reason !== "SILENCE" &&
      reason !== "NOISE_ONLY" &&
      reason !== "ELECTRICAL_HUM";

    return {
      sampleRate: this.sampleRate,
      frameCount,
      activeLyricFrameCount,
      voicedFrameCount: voicedCount,
      voicedInLyricsCount,
      frames,
      onsets,
      qualityGate: {
        passed: reason === "OK",
        reason,
        speakerBleedSuspected: finalBleedSuspected,
        bleedScore: Number(bleedScore.toFixed(3)),
        noiseFloorRms: Number(noiseFloorRms.toFixed(5)),
        meanVocalRms: Number(meanVocalRms.toFixed(5)),
        peakVocalRms: Number(peakVocalRms.toFixed(5)),
        rmsModulationCv: Number(rmsModulationCv.toFixed(3)),
        lyricMeanRms: Number(lyricMeanRms.toFixed(5)),
        gapMeanRms: Number(gapMeanRms.toFixed(5)),
        lyricToGapRatio:
          lyricToGapRatio !== null ? Number(lyricToGapRatio.toFixed(3)) : null,
        meanClarity: Number(meanClarity.toFixed(3)),
        meanSpectralFlatness: Number(meanSpectralFlatness.toFixed(3)),
        humRatio: Number(humRatio.toFixed(3)),
        silentRatio: Number(silentRatio.toFixed(3)),
        noiseRatio: Number(noiseRatio.toFixed(3)),
        voicedCoverageRatio: Number(voicedCoverageRatio.toFixed(3)),
        activeVocalCoverageRatio: Number(activeVocalCoverageRatio.toFixed(3)),
      },
    };
  }
}

export interface BrowserMusicalMonitorOptions {
  stream: MediaStream;
  getCurrentMs: () => number;
  lyricSpans?: LyricTimeSpan[];
  headphoneMode?: boolean;
  micLatencyMs?: number;
  pollIntervalMs?: number;
  telemetryThrottleMs?: number;
  /** Optional existing analyzer to continue accumulating across pause/resume within one song. */
  existingAnalyzer?: MusicalDspAnalyzer;
  onTelemetry?: (telemetry: LiveDspTelemetry) => void;
  onSample?: (sample: LivePitchSample) => void;
}

export interface BrowserMusicalMonitor {
  stop: () => void;
  setMicLatencyMs: (ms: number) => void;
  getSummary: (range?: LyricTimeSpan | null) => DspSessionSummary;
  getAnalyzer: () => MusicalDspAnalyzer;
  getPitchRing: () => readonly LivePitchSample[];
  getLatestPitchSample: () => LivePitchSample | null;
}

const VOCAL_WORKLET_PROCESSOR_SOURCE = `
class ViReadVocalDspProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._write = 0;
    this._hop = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const len = ch.length;
    const buf = this._buf;
    for (let i = 0; i < len; i++) {
      buf[this._write] = ch[i];
      this._write = (this._write + 1) & 2047;
    }
    this._hop += len;
    if (this._hop >= 1024) {
      this._hop = 0;
      const ordered = new Float32Array(2048);
      const tail = 2048 - this._write;
      ordered.set(buf.subarray(this._write), 0);
      ordered.set(buf.subarray(0, this._write), tail);
      this.port.postMessage(ordered, [ordered.buffer]);
    }
    return true;
  }
}
registerProcessor("viread-vocal-dsp-processor", ViReadVocalDspProcessor);
`;

/**
 * Real-time browser Web Audio analyzer wrapper.
 * Prefers `AudioWorkletNode` for jitter-free capture and automatically falls back
 * to `AnalyserNode` (`getFloatTimeDomainData`) in older browsers/WebViews/jsdom.
 * Automatic teardown on stop/pause/visibilitychange/viread:android-background.
 */
export function createBrowserMusicalMonitor(
  options: BrowserMusicalMonitorOptions,
): BrowserMusicalMonitor | null {
  if (typeof AudioContext === "undefined") return null;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let workletNode: AudioWorkletNode | undefined;
  let silentSink: GainNode | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let workletActive = false;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    try {
      if (workletNode) {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      }
    } catch {
      /* Already disconnected. */
    }
    try {
      silentSink?.disconnect();
    } catch {
      /* Already disconnected. */
    }
    try {
      source?.disconnect();
    } catch {
      /* Already disconnected. */
    }
    try {
      analyser?.disconnect();
    } catch {
      /* Already disconnected. */
    }
    if (context && context.state !== "closed") {
      void context.close().catch(() => {});
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("viread:android-background", stop);
    }
  };

  try {
    context = new AudioContext();
    if (
      typeof context.createMediaStreamSource !== "function" ||
      typeof context.createAnalyser !== "function"
    ) {
      stop();
      return null;
    }
    source = context.createMediaStreamSource(options.stream);
    analyser = context.createAnalyser();
    analyser.fftSize = DEFAULT_DSP_FRAME_SIZE;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    const sampleRate = context.sampleRate || DEFAULT_DSP_SAMPLE_RATE;
    const analyzer =
      options.existingAnalyzer ??
      new MusicalDspAnalyzer({
        sampleRate,
        frameSize: analyser.fftSize,
        lyricSpans: options.lyricSpans,
        headphoneMode: options.headphoneMode,
        micLatencyMs: options.micLatencyMs ?? DEFAULT_MIC_LATENCY_MS,
      });
    if (options.existingAnalyzer && options.micLatencyMs !== undefined) {
      analyzer.setMicLatencyMs(options.micLatencyMs);
    }
    // Single pre-allocated PCM buffer reused for AnalyserNode fallback frames.
    const pcmBuffer = new Float32Array(analyser.fftSize);
    const pollMs = Math.max(16, options.pollIntervalMs ?? 32);
    const telemetryThrottleMs = Math.max(50, options.telemetryThrottleMs ?? 80);
    let lastTelemetryWall = 0;
    let lastMediaMs = -1;

    const ingestFrame = (samples: Float32Array) => {
      if (stopped || !context) return;
      const track = options.stream.getAudioTracks?.()[0];
      if (
        context.state !== "running" ||
        !track ||
        track.readyState !== "live" ||
        !track.enabled ||
        track.muted
      ) {
        return;
      }
      const mediaMs = options.getCurrentMs();
      if (!Number.isFinite(mediaMs) || mediaMs === lastMediaMs) return;
      lastMediaMs = mediaMs;
      analyzer.processFrame(samples, mediaMs);

      const latest = analyzer.getLatestPitchSample();
      if (latest && options.onSample) {
        options.onSample(latest);
      }

      if (options.onTelemetry) {
        const now =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        if (now - lastTelemetryWall >= telemetryThrottleMs) {
          lastTelemetryWall = now;
          const telemetry = analyzer.getLiveTelemetry();
          if (telemetry) options.onTelemetry(telemetry);
        }
      }
    };

    if (typeof context.resume === "function") {
      void context.resume().catch(() => {});
    }
    if (typeof document !== "undefined") {
      document.addEventListener("viread:android-background", stop);
    }

    // Attempt AudioWorkletNode upgrade asynchronously while AnalyserNode polling runs immediately.
    if (
      typeof AudioWorkletNode !== "undefined" &&
      context.audioWorklet &&
      typeof context.audioWorklet.addModule === "function" &&
      typeof Blob !== "undefined" &&
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function"
    ) {
      let workletUrl: string | null = null;
      try {
        workletUrl = URL.createObjectURL(
          new Blob([VOCAL_WORKLET_PROCESSOR_SOURCE], {
            type: "application/javascript",
          }),
        );
        const ctxRef = context;
        const srcRef = source;
        void ctxRef.audioWorklet
          .addModule(workletUrl)
          .then(() => {
            if (workletUrl) {
              URL.revokeObjectURL(workletUrl);
              workletUrl = null;
            }
            if (stopped || ctxRef.state === "closed") return;
            const node = new AudioWorkletNode(
              ctxRef,
              "viread-vocal-dsp-processor",
            );
            node.port.onmessage = (event: MessageEvent<Float32Array>) => {
              if (stopped) return;
              const chunk = event.data;
              if (chunk instanceof Float32Array && chunk.length > 0) {
                ingestFrame(chunk);
              }
            };
            const sink = ctxRef.createGain();
            sink.gain.value = 0;
            srcRef.connect(node);
            node.connect(sink);
            sink.connect(ctxRef.destination);
            workletNode = node;
            silentSink = sink;
            workletActive = true;
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
          })
          .catch(() => {
            if (workletUrl) {
              URL.revokeObjectURL(workletUrl);
              workletUrl = null;
            }
          });
      } catch {
        if (workletUrl) URL.revokeObjectURL(workletUrl);
      }
    }

    timer = setInterval(() => {
      if (stopped || workletActive || !analyser) return;
      analyser.getFloatTimeDomainData(pcmBuffer);
      ingestFrame(pcmBuffer);
    }, pollMs);

    return {
      stop,
      setMicLatencyMs: (ms) => analyzer.setMicLatencyMs(ms),
      getSummary: (range) => analyzer.summarize(range),
      getAnalyzer: () => analyzer,
      getPitchRing: () => analyzer.getPitchRing(),
      getLatestPitchSample: () => analyzer.getLatestPitchSample(),
    };
  } catch {
    stop();
    return null;
  }
}

export interface LocalVocalRecorder {
  start: () => void;
  stop: () => Promise<string | null>;
  dispose: () => void;
}

/**
 * Local-only in-memory vocal replay recorder for the Score Card.
 * Strictly NEVER uploads raw audio — blob URLs are always revoked on dispose/unmount.
 */
export function createLocalVocalRecorder(
  stream: MediaStream,
): LocalVocalRecorder | null {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null;
  }
  const preferredMimes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg",
  ];
  let mimeType = "";
  if (typeof MediaRecorder.isTypeSupported === "function") {
    for (const candidate of preferredMimes) {
      if (MediaRecorder.isTypeSupported(candidate)) {
        mimeType = candidate;
        break;
      }
    }
  }

  let recorder: MediaRecorder | null = null;
  const chunks: Blob[] = [];
  let objectUrl: string | null = null;
  let disposed = false;

  try {
    recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    recorder.ondataavailable = (event: BlobEvent) => {
      if (!disposed && event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };
  } catch {
    return null;
  }

  const revokeUrl = () => {
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* Safe revoke. */
      }
      objectUrl = null;
    }
  };

  return {
    start() {
      if (disposed || !recorder || recorder.state !== "inactive") return;
      chunks.length = 0;
      revokeUrl();
      try {
        recorder.start(500);
      } catch {
        /* Ignore unsupported recording state. */
      }
    },
    stop() {
      if (disposed || !recorder) return Promise.resolve(null);
      if (recorder.state === "inactive") {
        if (objectUrl) return Promise.resolve(objectUrl);
        if (chunks.length > 0) {
          objectUrl = URL.createObjectURL(
            new Blob(chunks, { type: mimeType || "audio/webm" }),
          );
          return Promise.resolve(objectUrl);
        }
        return Promise.resolve(null);
      }
      return new Promise<string | null>((resolve) => {
        if (!recorder) {
          resolve(null);
          return;
        }
        const active = recorder;
        const finish = () => {
          if (disposed || chunks.length === 0) {
            resolve(null);
            return;
          }
          revokeUrl();
          objectUrl = URL.createObjectURL(
            new Blob(chunks, { type: mimeType || active.mimeType || "audio/webm" }),
          );
          resolve(objectUrl);
        };
        active.onstop = finish;
        try {
          active.stop();
        } catch {
          resolve(null);
        }
      });
    },
    dispose() {
      disposed = true;
      chunks.length = 0;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.onstop = null;
          recorder.stop();
        } catch {
          /* Safe stop. */
        }
      }
      recorder = null;
      revokeUrl();
    },
  };
}
