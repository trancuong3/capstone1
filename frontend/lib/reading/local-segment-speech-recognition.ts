/**
 * Local-First Utterance-Segment SpeechRecognition (`LocalSegmentSpeechRecognition`).
 *
 * Replaces Chrome's cloud-bound `webkitSpeechRecognition` in real browsers and
 * Android APK WebViews so child audio stays 100% on the local Windows machine
 * (`127.0.0.1:8010` Sherpa-ONNX worker via `/voice/speech-to-text`), while only
 * falling back to Google Cloud STT on the backend when explicitly permitted by
 * parent policy (`local_with_google_fallback` + `allowGoogleSttFallback`).
 *
 * Preserves compatibility with synthetic unit-test `SpeechRecognition` mocks
 * (detected via non-native constructor source).
 */

import type { SpeechService } from "@/lib/api/speech-service";

export interface SegmentSpeechResultAlternative {
  readonly transcript: string;
  readonly confidence?: number;
}

export interface SegmentSpeechResultItem {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SegmentSpeechResultAlternative;
}

export interface SegmentSpeechEvent {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SegmentSpeechResultItem;
  };
}

export interface SegmentSpeechErrorEvent {
  readonly error?: string;
}

export interface SegmentSpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SegmentSpeechEvent) => void) | null;
  onerror: ((event: SegmentSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: (audioTrack?: MediaStreamTrack) => void;
  stop: () => void;
  abort?: () => void;
}

export interface LocalSegmentContextSnapshot {
  readonly sessionId?: string | null;
  readonly pageId?: string | null;
  readonly keyterms?: readonly string[];
}

const TARGET_SAMPLE_RATE = 16_000;
const MIN_SPEECH_RMS_ONSET = 0.0028;
const MIN_SPEECH_RMS_HOLD = 0.0016;
const INITIAL_NOISE_FLOOR = 0.0018;
const MAX_NOISE_FLOOR = 0.0055;
const MIN_NOISE_FLOOR = 0.0009;
const SILENCE_FLUSH_MS = 720;
const MIN_SPEECH_MS = 120;
const MAX_SEGMENT_MS = 4_500;
const PRE_ROLL_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.45);
const QUIET_TAIL_CARRY_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.35);
const OVERLAP_CARRY_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.32);

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE || inputRate <= 0) {
    return new Float32Array(input);
  }
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio) + 1);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j];
      count += 1;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

export function encodeFloat32ToWav16kBlob(samples: Float32Array): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      offset,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function nextTurnId(prefix: string, seq: number): string {
  return `${prefix}_seg_${Date.now().toString(36)}_${seq}`;
}

export class LocalSegmentSpeechRecognition implements SegmentSpeechRecognitionLike {
  continuous = true;
  interimResults = true;
  lang = "vi-VN";
  maxAlternatives = 1;
  onresult: ((event: SegmentSpeechEvent) => void) | null = null;
  onerror: ((event: SegmentSpeechErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;

  private active = false;
  private stopping = false;
  private ownedStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private abortController: AbortController | null = null;
  private resultsHistory: SegmentSpeechResultItem[] = [];
  private preRoll: Float32Array = new Float32Array(0);
  private speechChunks: Float32Array[] = [];
  private speechSamples = 0;
  private silenceSamples = 0;
  private quietFrameStreak = 0;
  private inSpeech = false;
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private turnSeq = 0;
  private pendingUploads: Set<Promise<void>> = new Set();
  private uploadChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly speechService: SpeechService,
    private readonly getContext?: () => LocalSegmentContextSnapshot,
  ) {}

  /** True while the child is currently speaking or an STT segment upload is still in flight. */
  hasPendingUploads(): boolean {
    return this.inSpeech || this.pendingUploads.size > 0;
  }

  start(audioTrack?: MediaStreamTrack): void {
    if (this.active) return;
    this.active = true;
    this.stopping = false;
    this.abortController = new AbortController();
    this.resultsHistory = [];
    this.uploadChain = Promise.resolve();
    this.resetSegmentState();
    void this.openAudioGraph(audioTrack);
  }

  stop(): void {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    // Flush any pending speech segment before emitting onend
    if (
      this.inSpeech &&
      this.speechSamples >= (TARGET_SAMPLE_RATE * MIN_SPEECH_MS) / 1000
    ) {
      this.flushCurrentSegment();
    } else {
      this.resetSegmentState();
    }
    this.teardownAudioGraph();
    const inflight = Array.from(this.pendingUploads);
    void Promise.allSettled(inflight).finally(() => {
      this.active = false;
      this.stopping = false;
      this.onend?.();
    });
  }

  abort(): void {
    if (!this.active) return;
    this.active = false;
    this.stopping = false;
    this.abortController?.abort();
    this.resetSegmentState();
    this.teardownAudioGraph();
    this.onend?.();
  }

  private resetSegmentState(): void {
    this.preRoll = new Float32Array(0);
    this.speechChunks = [];
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.inSpeech = false;
  }

  private teardownAudioGraph(): void {
    try {
      if (this.processorNode) {
        this.processorNode.onaudioprocess = null;
        this.processorNode.disconnect();
      }
    } catch {
      // Ignore disconnect errors
    }
    this.processorNode = null;
    try {
      this.sourceNode?.disconnect();
    } catch {
      // Ignore
    }
    this.sourceNode = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    if (this.ownedStream) {
      this.ownedStream.getTracks().forEach((t) => t.stop());
      this.ownedStream = null;
    }
  }

  private async openAudioGraph(audioTrack?: MediaStreamTrack): Promise<void> {
    try {
      let stream: MediaStream;
      if (audioTrack && audioTrack.readyState === "live") {
        stream = new MediaStream([audioTrack]);
      } else {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("not-allowed");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (!this.active || this.stopping) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.ownedStream = stream;
      }

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) {
        throw new Error("audio-capture");
      }
      const ctx = new AudioCtx();
      this.audioCtx = ctx;
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => undefined);
        if (ctx.state === "suspended") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          await ctx.resume().catch(() => undefined);
        }
      }

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;

      this.sourceNode = source;
      this.processorNode = processor;

      processor.onaudioprocess = (ev: AudioProcessingEvent) => {
        if (!this.active || this.stopping) return;
        const raw = ev.inputBuffer.getChannelData(0);
        const mono16 = downsampleTo16k(raw, ctx.sampleRate);
        this.consumeSamples16k(mono16);
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);
    } catch (err) {
      if (!this.active) return;
      this.active = false;
      this.teardownAudioGraph();
      const isDenied =
        err instanceof Error &&
        (err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError" ||
          err.message === "not-allowed");
      this.onerror?.({ error: isDenied ? "not-allowed" : "audio-capture" });
      this.onend?.();
    }
  }

  private consumeSamples16k(chunk: Float32Array): void {
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      const sample = chunk[i];
      sumSq += sample * sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, chunk.length));
    const onsetThreshold = Math.max(
      MIN_SPEECH_RMS_ONSET,
      this.noiseFloor * 2.0,
    );
    const holdThreshold = Math.max(MIN_SPEECH_RMS_HOLD, this.noiseFloor * 1.4);
    const isOnsetFrame = rms >= onsetThreshold || peak >= onsetThreshold * 3.0;
    const isVoicedFrame = rms >= holdThreshold || peak >= holdThreshold * 3.0;

    if (!this.inSpeech) {
      if (isOnsetFrame) {
        this.inSpeech = true;
        this.silenceSamples = 0;
        this.quietFrameStreak = 0;
        if (this.preRoll.length > 0) {
          this.speechChunks.push(this.preRoll);
          this.speechSamples += this.preRoll.length;
          this.preRoll = new Float32Array(0);
        }
        this.speechChunks.push(chunk);
        this.speechSamples += chunk.length;
      } else {
        this.noiseFloor = Math.min(
          MAX_NOISE_FLOOR,
          Math.max(MIN_NOISE_FLOOR, this.noiseFloor * 0.95 + rms * 0.05),
        );
        const merged = new Float32Array(this.preRoll.length + chunk.length);
        merged.set(this.preRoll, 0);
        merged.set(chunk, this.preRoll.length);
        this.preRoll =
          merged.length > PRE_ROLL_SAMPLES
            ? merged.slice(merged.length - PRE_ROLL_SAMPLES)
            : merged;
      }
      return;
    }

    this.speechChunks.push(chunk);
    this.speechSamples += chunk.length;
    if (!isVoicedFrame) {
      this.quietFrameStreak += 1;
      // Ignore single-frame (~42ms) glottal dips inside Vietnamese hỏi/ngã/nặng/huyền tones
      if (this.quietFrameStreak >= 2) {
        this.silenceSamples += chunk.length;
      }
    } else {
      this.quietFrameStreak = 0;
      this.silenceSamples = 0;
    }

    const silenceMs = (this.silenceSamples / TARGET_SAMPLE_RATE) * 1000;
    const speechMs = (this.speechSamples / TARGET_SAMPLE_RATE) * 1000;

    if (silenceMs >= SILENCE_FLUSH_MS && speechMs >= MIN_SPEECH_MS) {
      this.flushCurrentSegment(false);
    } else if (speechMs >= MAX_SEGMENT_MS) {
      this.flushCurrentSegment(true);
    }
  }

  private flushCurrentSegment(carryOverlap = false): void {
    if (!this.speechChunks.length) {
      this.resetSegmentState();
      return;
    }
    const total = this.speechSamples;
    const silenceTailSamples = this.silenceSamples;
    const combined = new Float32Array(total);
    let offset = 0;
    for (const part of this.speechChunks) {
      combined.set(part, offset);
      offset += part.length;
    }
    // Always preserve a rolling pre-roll across flushes!
    // - On silence flush: carry the quiet tail (<= 350ms, strictly within silenceTailSamples)
    //   so the onset of the very next sentence's first word is NEVER chopped, with zero duplication.
    // - On max-length forced flush: carry 320ms overlap so mid-sentence syllables aren't split.
    const carryCount = carryOverlap
      ? Math.min(combined.length, OVERLAP_CARRY_SAMPLES)
      : Math.min(combined.length, silenceTailSamples, QUIET_TAIL_CARRY_SAMPLES);
    const preservedPreRoll =
      carryCount > 0 ? combined.slice(combined.length - carryCount) : null;
    this.resetSegmentState();
    this.quietFrameStreak = 0;
    if (preservedPreRoll) {
      this.preRoll = preservedPreRoll;
    }

    const wavBlob = encodeFloat32ToWav16kBlob(combined);
    const seq = ++this.turnSeq;
    const ctx = this.getContext?.() ?? {};
    const turnId = nextTurnId(ctx.pageId ?? "live", seq);
    const signal = this.abortController?.signal;

    const transcribeOnce = () =>
      this.speechService.transcribe(wavBlob, {
        filename: "segment.wav",
        languageCode: "vi",
        keyterms: ctx.keyterms,
        sessionId: ctx.sessionId ?? null,
        pageId: ctx.pageId ?? null,
        turnId,
        source: "local_live_segment",
        signal,
        timeoutMs: 12_000,
      });

    const transcribeWithRetry = async () => {
      try {
        return await transcribeOnce();
      } catch (err) {
        if (signal?.aborted || (!this.active && !this.stopping)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (signal?.aborted || (!this.active && !this.stopping)) throw err;
        return await transcribeOnce();
      }
    };

    // Start upload immediately, but deliver results strictly in FIFO order via uploadChain
    // so segment N+1 NEVER overtakes segment N and causes false RED alignment skips!
    const responsePromise = transcribeWithRetry();
    const deliveryTask = this.uploadChain
      .then(async () => {
        const res = await responsePromise;
        if (!this.active && !this.stopping) return;
        const text = (res.text ?? "").normalize("NFC").trim();
        if (!text) return;
        const resultIndex = this.resultsHistory.length;
        const item: SegmentSpeechResultItem = {
          isFinal: true,
          length: 1,
          0: {
            transcript: text,
            // 0 denotes uncalibrated confidence so recognition-evidence treats it honestly
            confidence: 0,
          },
        };
        this.resultsHistory.push(item);
        const resultsObj: Record<number, SegmentSpeechResultItem> & {
          length: number;
        } = { length: this.resultsHistory.length };
        for (let i = 0; i < this.resultsHistory.length; i += 1) {
          resultsObj[i] = this.resultsHistory[i];
        }
        this.onresult?.({
          resultIndex,
          results: resultsObj,
        });
      })
      .catch(() => {
        // Segment error is handled gracefully; final recorder transcription remains as backup
      })
      .finally(() => {
        this.pendingUploads.delete(deliveryTask);
      });

    this.uploadChain = deliveryTask;
    this.pendingUploads.add(deliveryTask);
  }
}

export function isInjectedTestSpeechRecognition(
  ctor: unknown,
): ctor is new () => SegmentSpeechRecognitionLike {
  if (typeof ctor !== "function") return false;
  try {
    const src = Function.prototype.toString.call(ctor);
    return !src.includes("[native code]");
  } catch {
    return false;
  }
}

/**
 * Returns the injected mock constructor in unit/E2E tests, and otherwise returns
 * a `LocalSegmentSpeechRecognition` constructor in all real browsers & Android
 * APK WebViews so Chrome's cloud `webkitSpeechRecognition` is never invoked!
 */
export function resolveLocalFirstSpeechRecognitionConstructor(
  win: {
    SpeechRecognition?: new () => SegmentSpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SegmentSpeechRecognitionLike;
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  },
  speechService: SpeechService,
  getContext?: () => LocalSegmentContextSnapshot,
  getLiveTrack?: () => MediaStreamTrack | undefined,
): (new () => SegmentSpeechRecognitionLike) | undefined {
  const candidate = win.SpeechRecognition || win.webkitSpeechRecognition;
  if (isInjectedTestSpeechRecognition(candidate)) {
    return candidate;
  }
  const explicitlyDisabled =
    Object.prototype.hasOwnProperty.call(win, "SpeechRecognition") &&
    win.SpeechRecognition === undefined &&
    Object.prototype.hasOwnProperty.call(win, "webkitSpeechRecognition") &&
    win.webkitSpeechRecognition === undefined;
  if (explicitlyDisabled) {
    return undefined;
  }
  const hasNativeWebSpeech = typeof candidate === "function";
  const hasWebAudio =
    typeof win.AudioContext === "function" ||
    typeof win.webkitAudioContext === "function";
  if (!hasNativeWebSpeech && !hasWebAudio) {
    return undefined;
  }
  return class BoundLocalSegmentSpeechRecognition extends LocalSegmentSpeechRecognition {
    constructor() {
      super(speechService, getContext);
    }
    override start(audioTrack?: MediaStreamTrack): void {
      super.start(audioTrack ?? getLiveTrack?.());
    }
  };
}
