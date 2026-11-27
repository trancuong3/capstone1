"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { translateRuntime } from "@/lib/i18n/runtime";
import type { KaraokeLyrics } from "@/types/karaoke";
import {
  browserSingingProvider,
  type SingingRecognizer as Recognition,
  type SingingRecognitionProvider,
} from "@/lib/karaoke/recognition-provider";
import { CaptureWindows } from "@/lib/karaoke/recognition-capture";
import {
  LiveSingingAttempt,
  type LiveSingingScore,
  type LiveWordState,
  type SingingActivity,
} from "@/lib/karaoke/live-singing-score";
import {
  monitorSingingTrack,
  SingingSignalClassifier,
} from "@/lib/karaoke/microphone-signal";
import {
  createBrowserMusicalMonitor,
  type BrowserMusicalMonitor,
  type DspSessionSummary,
  type LiveDspTelemetry,
  type LyricTimeSpan,
} from "@/lib/karaoke/musical-dsp";
import {
  evaluateMusicalPerformance,
  type KaraokePracticeMode,
  type MusicalEvaluationResult,
  type MusicalProfileData,
} from "@/lib/karaoke/musical-scoring";
import { extractLyricSpans } from "@/lib/karaoke/musical-practice";

export interface KaraokeScoringOptions {
  headphoneMode?: boolean;
  practiceMode?: KaraokePracticeMode;
  musicalProfile?: MusicalProfileData | null;
  segmentRange?: LyricTimeSpan | null;
}

type Status =
  | "idle"
  | "arming"
  | "armed"
  | "listening"
  | "paused"
  | "finishing"
  | "scored"
  | "insufficient"
  | "unavailable";

type Snapshot = {
  status: Status;
  score: LiveSingingScore | null;
  liveScore: LiveSingingScore | null;
  songScore: LiveSingingScore | null;
  musicalScore: MusicalEvaluationResult | null;
  songMusicalScore: MusicalEvaluationResult | null;
  liveTelemetry: LiveDspTelemetry | null;
  error: string | null;
  previewWords: ReadonlyMap<string, LiveWordState>;
  liveTranscript: string;
  signal: SingingActivity | "unavailable";
};

function microphoneError(code?: string) {
  switch (code) {
    case "not-allowed":
    case "NotAllowedError":
    case "SecurityError":
    case "service-not-allowed":
      return translateRuntime("entertainment.karaokeRuntime.micDenied");
    case "audio-capture":
    case "NotReadableError":
    case "NotFoundError":
      return translateRuntime("entertainment.karaokeRuntime.micNotFound");
    case "network":
      return translateRuntime("entertainment.karaokeRuntime.micNetwork");
    case "language-not-supported":
      return translateRuntime(
        "entertainment.karaokeRuntime.micLanguageUnsupported",
      );
    default:
      return translateRuntime("entertainment.karaokeRuntime.micFallback");
  }
}

function errorName(error: unknown) {
  if (
    typeof error === "object" &&
    error &&
    "name" in error &&
    typeof error.name === "string"
  )
    return error.name;
}

const emptyPreview: ReadonlyMap<string, LiveWordState> = new Map();
const idle: Snapshot = {
  status: "idle",
  score: null,
  liveScore: null,
  songScore: null,
  musicalScore: null,
  songMusicalScore: null,
  liveTelemetry: null,
  error: null,
  previewWords: emptyPreview,
  liveTranscript: "",
  signal: "unavailable",
};
const supported = () => browserSingingProvider.supported();
const serverSupported = () => false;
const subscribeSupport = () => () => {};
const startWaitMs = 15_000;
const finalWaitMs = 2_000;
const maxEmptyRestarts = 2;

class KaraokeMicSession {
  constructor(
    private readonly provider: SingingRecognitionProvider = browserSingingProvider,
  ) {}
  private snapshot = idle;
  private listeners = new Set<() => void>();
  private recognition: Recognition | null = null;
  private trackInput = false;
  private stream: MediaStream | null = null;
  private sliceClock: ReturnType<typeof setInterval> | undefined;
  private drainingSlice = false;
  private windows: CaptureWindows | null = null;
  private lineEnds: number[] = [];
  private attempt: LiveSingingAttempt | null = null;
  private activeLyrics: KaraokeLyrics | null = null;
  private practiceLyrics: KaraokeLyrics | null = null;
  private getTime: () => number = () => 0;
  private savedSong: {
    snapshot: Snapshot;
    attempt: LiveSingingAttempt | null;
    dspSummary: DspSessionSummary | null;
  } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolveArm: ((started: boolean) => void) | null = null;
  private emptyRestarts = 0;
  private stopSignal: (() => void) | null = null;
  private signalClassifier = new SingingSignalClassifier();
  private musicalMonitor: BrowserMusicalMonitor | null = null;
  private lastDspSummary: DspSessionSummary | null = null;
  private options: KaraokeScoringOptions = {};

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setOptions = (options: KaraokeScoringOptions) => {
    this.options = options;
  };

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private update(
    status: Status,
    error: string | null = null,
    score: LiveSingingScore | null = null,
    musicalScore: MusicalEvaluationResult | null = this.snapshot.musicalScore,
  ) {
    this.snapshot = {
      status,
      error,
      score,
      liveScore: this.snapshot.liveScore,
      songScore: this.savedSong ? this.savedSong.snapshot.score : score,
      musicalScore,
      songMusicalScore: this.savedSong
        ? this.savedSong.snapshot.musicalScore
        : musicalScore,
      liveTelemetry: this.snapshot.liveTelemetry,
      previewWords: this.snapshot.previewWords ?? emptyPreview,
      liveTranscript: this.snapshot.liveTranscript ?? "",
      signal: this.snapshot.signal,
    };
    this.notify();
  }

  private stopMusicalMonitor(captureSummary = true) {
    if (!this.musicalMonitor) return;
    if (captureSummary) {
      const summary = this.musicalMonitor.getSummary(this.options.segmentRange);
      if (summary.frameCount > 0) {
        this.lastDspSummary = summary;
      }
    }
    this.musicalMonitor.stop();
    this.musicalMonitor = null;
  }

  private closeStream() {
    this.stopMusicalMonitor(true);
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    this.stream = null;
    this.signalClassifier = new SingingSignalClassifier();
  }

  private release(abort: boolean, keepStream = false) {
    if (this.attempt?.flushPlayedOmissions(this.getTime())) {
      this.snapshot = {
        ...this.snapshot,
        liveScore: this.attempt.result(!!this.savedSong),
      };
    }
    this.attempt?.closeCapture();
    this.stopSignal?.();
    this.stopSignal = null;
    if (!keepStream) {
      this.stopMusicalMonitor(true);
    }
    this.snapshot = {
      ...this.snapshot,
      previewWords: emptyPreview,
      signal: "unavailable",
      liveTelemetry: keepStream ? this.snapshot.liveTelemetry : null,
    };
    clearTimeout(this.timer);
    clearInterval(this.sliceClock);
    this.windows = null;
    this.drainingSlice = false;
    const recognition = this.recognition;
    this.recognition = null;
    if (!keepStream) this.closeStream();
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onstart = null;
    recognition.onspeechstart = null;
    recognition.onspeechend = null;
    recognition.onerror = null;
    if (abort) {
      try {
        recognition.abort();
      } catch {
        /* Already disconnected. */
      }
    }
  }

  private acknowledge(started: boolean) {
    const resolve = this.resolveArm;
    this.resolveArm = null;
    resolve?.(started);
  }

  reset = () => {
    this.release(true);
    this.acknowledge(false);
    this.attempt = null;
    this.activeLyrics = null;
    this.practiceLyrics = null;
    this.savedSong = null;
    this.lastDspSummary = null;
    this.snapshot = idle;
    this.emptyRestarts = 0;
    this.update("idle", null, null, null);
  };

  arm = (
    lyrics: KaraokeLyrics,
    clock: () => number,
    lineId?: string,
  ): Promise<boolean> => {
    const lines = lineId
      ? lyrics.lines.filter((line) => line.id === lineId)
      : lyrics.lines;
    if (!lines.length) return Promise.resolve(false);
    this.lineEnds = lyrics.lines.flatMap((line) =>
      line.end_ms === null ? [] : [line.end_ms],
    );
    if (lineId) {
      if (!this.savedSong) {
        const status = this.snapshot.status;
        const snapshot =
          status === "listening" || status === "armed" || status === "paused"
            ? { ...this.snapshot, status: "paused" as const }
            : status === "arming"
              ? idle
              : this.snapshot;
        this.savedSong = {
          snapshot,
          attempt: this.attempt,
          dspSummary: this.lastDspSummary,
        };
      }
      this.release(true);
      this.acknowledge(false);
    } else this.reset();
    this.getTime = clock;
    this.practiceLyrics = lineId ? { ...lyrics, lines } : null;
    this.activeLyrics = this.practiceLyrics ?? lyrics;
    this.lastDspSummary = null;
    this.attempt = new LiveSingingAttempt(this.activeLyrics);
    this.snapshot = { ...idle, liveScore: this.attempt.result(!!lineId) };
    this.emptyRestarts = 0;
    this.update("arming", null, null, null);
    return new Promise<boolean>((resolve) => {
      this.resolveArm = resolve;
      this.open(true);
    });
  };

  endPractice = () => {
    const saved = this.savedSong;
    if (!saved) return;
    this.release(true);
    this.acknowledge(false);
    this.savedSong = null;
    this.practiceLyrics = null;
    this.emptyRestarts = 0;
    this.attempt = saved.attempt;
    this.lastDspSummary = saved.dspSummary;
    this.snapshot = saved.snapshot;
    this.update(
      saved.snapshot.status,
      saved.snapshot.error,
      saved.snapshot.score,
      saved.snapshot.musicalScore,
    );
  };

  private fail(message: string) {
    const finishing = this.snapshot.status === "finishing";
    this.release(true);
    this.acknowledge(false);
    if (finishing) this.complete(message);
    else this.update("unavailable", message);
  }

  // Overload arity is zero on browsers that support start(audioTrack).
  // A stopped track must throw InvalidStateError synchronously. Older engines
  // ignore the argument; that native recognition becomes the permission probe.
  // The temporary stream is already closed before either branch runs.
  private async startInput(recognition: Recognition, probe: boolean) {
    const devices = navigator.mediaDevices;
    if (
      recognition.managesOwnMicrophone ||
      !devices?.getUserMedia ||
      (!probe && !this.trackInput)
    ) {
      recognition.start();
      return;
    }
    const useRawHeadphoneAudio = Boolean(this.options.headphoneMode);
    const stream =
      this.stream ??
      (await devices.getUserMedia({
        audio: useRawHeadphoneAudio
          ? {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            }
          : {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
      }));
    if (
      this.recognition !== recognition ||
      this.snapshot.status === "finishing"
    ) {
      for (const track of stream.getTracks()) track.stop();
      if (this.recognition === recognition) this.complete();
      return;
    }
    this.stream = stream;
    const track = stream
      .getAudioTracks()
      .find((item) => item.readyState === "live");
    if (!track)
      throw new DOMException("Microphone unavailable", "NotFoundError");
    if (probe) {
      this.closeStream();
      this.trackInput = false;
      try {
        recognition.start(track);
      } catch (error) {
        if (errorName(error) === "TypeError") {
          recognition.start();
          return;
        }
        if (errorName(error) !== "InvalidStateError") throw error;
        this.trackInput = true;
        this.release(false);
        this.update("armed");
        this.acknowledge(true);
      }
      return;
    }
    track.onended = () => {
      if (this.stream === stream && this.recognition)
        this.fail(microphoneError("audio-capture"));
    };
    recognition.start(track);
  }

  private scheduleSlice(recognition: Recognition, windows: CaptureWindows) {
    const start = this.getTime();
    const boundary =
      this.lineEnds.find((end) => end >= start + 3000 && end <= start + 7000) ??
      start + 6000;
    this.sliceClock = setInterval(() => {
      if (this.recognition !== recognition || this.getTime() < boundary) return;
      clearInterval(this.sliceClock);
      windows.freeze();
      this.drainingSlice = true;
      this.timer = setTimeout(() => {
        if (this.recognition !== recognition || !this.drainingSlice) return;
        this.release(true, true);
        this.update("armed");
        this.open(false);
      }, finalWaitMs);
      try {
        recognition.stop();
      } catch {
        this.fail(microphoneError());
      }
    }, 100);
  }

  private open(probe: boolean) {
    if (!this.provider.supported()) {
      this.fail(
        translateRuntime("entertainment.karaokeRuntime.micScoringUnsupported"),
      );
      return;
    }
    try {
      const recognition = this.provider.create();
      if (!recognition) throw new Error("Recognition unavailable");
      const windows = new CaptureWindows(this.getTime, this.trackInput);
      let capturing = false;
      let noSpeech = false;
      this.windows = windows;
      this.recognition = recognition;

      recognition.onstart = () => {
        if (this.recognition !== recognition) return;
        if (this.snapshot.status === "finishing") return;
        clearTimeout(this.timer);
        if (probe) {
          // Discard this entire cycle, including speech delivered after countdown.
          this.release(true);
          this.update("armed");
          this.acknowledge(true);
        } else {
          capturing = true;
          windows.started();
          this.attempt?.beginCapture(windows.captureId);
          if (this.trackInput && this.stream) {
            this.stopSignal = monitorSingingTrack(
              this.stream,
              this.getTime,
              (from, to, activity) => {
                if (
                  this.recognition !== recognition ||
                  this.drainingSlice ||
                  this.snapshot.status !== "listening"
                )
                  return;
                this.attempt?.observeAudio(from, to, activity);
                if (activity !== this.snapshot.signal) {
                  this.snapshot = { ...this.snapshot, signal: activity };
                  this.update(this.snapshot.status);
                }
              },
              this.signalClassifier,
            );
            if (!this.musicalMonitor && this.activeLyrics) {
              this.musicalMonitor = createBrowserMusicalMonitor({
                stream: this.stream,
                getCurrentMs: this.getTime,
                lyricSpans: extractLyricSpans(
                  this.activeLyrics,
                  this.options.segmentRange,
                ),
                headphoneMode: Boolean(this.options.headphoneMode),
                pollIntervalMs: 40,
                telemetryThrottleMs: 100,
                onTelemetry: (telemetry) => {
                  if (this.snapshot.status !== "listening") return;
                  this.snapshot = {
                    ...this.snapshot,
                    liveTelemetry: telemetry,
                  };
                  this.notify();
                },
              });
            }
          }
          this.update("listening");
          if (this.trackInput) this.scheduleSlice(recognition, windows);
        }
      };
      recognition.onresult = (event) => {
        if (this.recognition !== recognition || !capturing || !this.attempt)
          return;
        const outcome = windows.consume(event, this.attempt);
        if (outcome.changed) this.emptyRestarts = 0;
        this.snapshot = {
          ...this.snapshot,
          liveScore: this.attempt.result(!!this.savedSong),
          previewWords: outcome.preview,
          liveTranscript: outcome.transcript,
        };
        this.update(this.snapshot.status);
      };
      if (!probe) {
        recognition.onspeechstart = windows.speechStart;
        recognition.onspeechend = windows.speechEnd;
      }
      recognition.onerror = ({ error }) => {
        if (this.recognition !== recognition) return;
        if (error === "no-speech") {
          noSpeech = true;
          return;
        }
        this.fail(microphoneError(error));
      };
      recognition.onend = () => {
        if (this.recognition !== recognition) return;
        const deliberate = this.drainingSlice;
        const finishing = this.snapshot.status === "finishing";
        if (
          !probe &&
          capturing &&
          this.attempt?.settleThrough(windows.freeze())
        ) {
          this.snapshot = {
            ...this.snapshot,
            liveScore: this.attempt.result(!!this.savedSong),
          };
        }
        this.release(false, !probe && !finishing);
        if (finishing) this.complete();
        else if (
          probe ||
          (!deliberate && !noSpeech && ++this.emptyRestarts > maxEmptyRestarts)
        )
          this.fail(microphoneError());
        else {
          this.update("armed");
          this.open(false);
        }
      };
      this.timer = setTimeout(() => {
        if (this.recognition === recognition) this.fail(microphoneError());
      }, startWaitMs);
      void this.startInput(recognition, probe).catch((error: unknown) => {
        if (this.recognition === recognition)
          this.fail(microphoneError(errorName(error)));
      });
    } catch {
      this.fail(microphoneError());
    }
  }

  resume = () => {
    if (this.recognition || !["armed", "paused"].includes(this.snapshot.status))
      return;
    this.open(false);
  };

  pause = () => {
    const { status } = this.snapshot;
    if (
      status !== "listening" &&
      !(this.recognition && (status === "armed" || status === "paused"))
    )
      return;
    this.release(true);
    this.update("paused");
  };

  seekBoundary = (repeatPractice = false) => {
    if (
      !this.recognition ||
      this.snapshot.status === "arming" ||
      this.snapshot.status === "finishing"
    )
      return;
    this.pause();
    if (repeatPractice && this.practiceLyrics) {
      this.attempt = new LiveSingingAttempt(this.practiceLyrics);
      this.lastDspSummary = null;
      this.snapshot = {
        ...this.snapshot,
        liveScore: this.attempt.result(true),
      };
      this.emptyRestarts = 0;
      this.update("paused");
    }
    this.resume();
  };

  observePlayback = (fromMs: number, toMs: number) => {
    if (
      !this.attempt ||
      this.snapshot.status !== "listening" ||
      this.drainingSlice
    )
      return;
    if (this.attempt.observePlayback(fromMs, toMs)) {
      this.snapshot = {
        ...this.snapshot,
        liveScore: this.attempt.result(!!this.savedSong),
      };
      this.update(this.snapshot.status);
    }
  };

  private complete(error = this.snapshot.error) {
    this.release(true);
    this.attempt?.flushPlayedOmissions(this.getTime());
    const result = this.attempt?.result(!!this.savedSong || !!error) ?? null;
    const musicalResult = this.activeLyrics
      ? evaluateMusicalPerformance({
          lyrics: this.activeLyrics,
          dspSummary: this.lastDspSummary,
          liveLyricsScore: result,
          referenceProfile: this.options.musicalProfile ?? null,
          practiceMode:
            this.options.practiceMode ??
            (this.savedSong ? "LINE_PRACTICE" : "FULL_SONG"),
          headphoneMode: Boolean(this.options.headphoneMode),
          segmentRange: this.options.segmentRange ?? null,
        })
      : null;

    this.attempt = null;
    const hasLyricsResult = result !== null && result.kind !== "insufficient";
    const hasMusicalResult =
      musicalResult !== null &&
      musicalResult.scoringMode !== "INSUFFICIENT_EVIDENCE";

    if (hasLyricsResult || hasMusicalResult) {
      this.update(
        "scored",
        error,
        hasLyricsResult ? result : null,
        musicalResult,
      );
    } else {
      this.update("insufficient", error, null, musicalResult);
    }
  }

  finish = () => {
    if (
      !["listening", "paused", "armed", "unavailable"].includes(
        this.snapshot.status,
      )
    )
      return;
    if (!this.recognition) {
      this.complete();
      return;
    }
    this.update("finishing");
    this.windows?.freeze();
    clearInterval(this.sliceClock);
    clearTimeout(this.timer);
    const ending = this.recognition;
    this.timer = setTimeout(() => {
      if (this.recognition === ending && this.snapshot.status === "finishing")
        this.complete();
    }, finalWaitMs);
    try {
      if (!this.drainingSlice) this.recognition.stop();
      this.closeStream();
    } catch {
      this.complete();
    }
  };
}

export function useKaraokeScoring(
  lyrics: KaraokeLyrics,
  getCurrentMs: () => number,
  options?: KaraokeScoringOptions,
) {
  const [session] = useState(() => new KaraokeMicSession());
  const headphoneMode = options?.headphoneMode;
  const practiceMode = options?.practiceMode;
  const musicalProfile = options?.musicalProfile;
  const segmentStartMs = options?.segmentRange?.startMs;
  const segmentEndMs = options?.segmentRange?.endMs;
  useEffect(() => {
    session.setOptions({
      headphoneMode,
      practiceMode,
      musicalProfile,
      segmentRange:
        segmentStartMs !== undefined && segmentEndMs !== undefined
          ? { startMs: segmentStartMs, endMs: segmentEndMs }
          : null,
    });
  }, [
    session,
    headphoneMode,
    practiceMode,
    musicalProfile,
    segmentStartMs,
    segmentEndMs,
  ]);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const available = useSyncExternalStore(
    subscribeSupport,
    supported,
    serverSupported,
  );
  useEffect(() => session.reset, [session, lyrics]);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") session.reset();
    };
    const onAndroidBackground = () => session.reset();
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("viread:android-background", onAndroidBackground);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener(
        "viread:android-background",
        onAndroidBackground,
      );
    };
  }, [session]);
  const arm = useCallback(
    (lineId?: string) => session.arm(lyrics, getCurrentMs, lineId),
    [session, lyrics, getCurrentMs],
  );
  return {
    ...state,
    supported: available,
    listening: state.status === "listening",
    arm,
    observePlayback: session.observePlayback,
    endPractice: session.endPractice,
    seekBoundary: session.seekBoundary,
    pause: session.pause,
    resume: session.resume,
    finish: session.finish,
    reset: session.reset,
  };
}
