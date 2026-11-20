"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { KaraokeLyrics } from "@/types/karaoke";
import type { BrowserRecognitionEventLike } from "@/lib/reading/browser-transcript-collector";
import {
  LiveSingingAttempt,
  type LiveSingingScore,
  type LiveWordState,
} from "@/lib/karaoke/live-singing-score";

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
  error: string | null;
  previewWords: ReadonlyMap<string, LiveWordState>;
  liveTranscript: string;
};

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: BrowserRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}

function recognitionConstructor() {
  if (typeof window === "undefined") return null;
  const browser = window as Window & {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
}

function microphoneError(code?: string) {
  switch (code) {
    case "not-allowed":
    case "NotAllowedError":
    case "SecurityError":
    case "service-not-allowed":
      return "Micro chưa được cấp quyền. Bé có thể hát tự do hoặc nhờ ba mẹ bật micro.";
    case "audio-capture":
    case "NotReadableError":
    case "NotFoundError":
      return "Chưa tìm thấy micro. Ba mẹ kiểm tra thiết bị giúp bé nhé.";
    case "network":
      return "Kết nối nhận dạng bị gián đoạn. Bé vẫn có thể hát tiếp.";
    case "language-not-supported":
      return "Trình duyệt này chưa nhận dạng được tiếng Việt. Bé có thể hát tự do.";
    default:
      return "Chưa kết nối được micro để chấm điểm. Bé có thể thử lại hoặc hát tự do.";
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
  error: null,
  previewWords: emptyPreview,
  liveTranscript: "",
};
const supported = () => Boolean(recognitionConstructor());
const serverSupported = () => false;
const subscribeSupport = () => () => {};
const startWaitMs = 15_000;
const finalWaitMs = 2_000;
const maxEmptyRestarts = 2;

type SpeechWindow = { start: number; end: number };

function hasUsableSingingConfidence(confidence?: number): boolean {
  // Singing pitch and soft/quiet voices ("hát bé") often produce lower ASR
  // confidence (0.18–0.49) than flat spoken prose while still rejecting noise (<=0.15).
  return (
    confidence === undefined ||
    confidence === 0 ||
    (Number.isFinite(confidence) && confidence >= 0.18 && confidence <= 1)
  );
}

function extractAlternatives(
  result: BrowserRecognitionEventLike["results"][number] | undefined,
): string[] {
  if (!result) return [];
  const list: string[] = [];
  const raw = result as unknown as Record<
    number,
    { transcript?: string } | undefined
  > & { length?: number };
  const limit = Math.max(1, typeof raw.length === "number" ? raw.length : 5);
  for (let k = 0; k < limit; k++) {
    const text = raw[k]?.transcript?.trim();
    if (text && !list.includes(text)) list.push(text);
  }
  return list;
}

// SpeechRecognition provides final text without word timestamps. Prefer speech
// activity measured on the native music clock; a result-only interval is usable
// only while short enough to locate its utterance. Never invent earlier times.
class CaptureWindows {
  private readonly finalSlots = new Set<number>();
  private windows: SpeechWindow[] = [];
  private speakingFrom: number | null = null;
  private interimFrom: number | null = null;
  private lastInterimText = "";
  private hasSpeechEvents = false;
  private startedAt: number;
  private lastFinalMs: number;
  private overflow = false;
  private stoppedAt: number | null = null;

  constructor(
    private readonly clock: () => number,
    private readonly sliced: boolean,
  ) {
    this.lastFinalMs = clock();
    this.startedAt = this.lastFinalMs;
  }

  freeze = () => {
    this.stoppedAt ??= this.clock();
  };
  started = () => {
    this.startedAt = this.now();
    this.lastFinalMs = this.startedAt;
  };
  private now() {
    return this.stoppedAt ?? this.clock();
  }

  speechStart = () => {
    this.hasSpeechEvents = true;
    this.speakingFrom = this.now();
  };
  speechEnd = () => {
    if (this.speakingFrom === null) return;
    const end = this.now();
    if (end > this.speakingFrom) {
      if (this.windows.length === 8) this.overflow = true;
      if (!this.overflow) this.windows.push({ start: this.speakingFrom, end });
    }
    this.speakingFrom = null;
  };

  flushInterim(attempt: LiveSingingAttempt): boolean {
    const text = this.lastInterimText.trim();
    const from = this.interimFrom;
    this.lastInterimText = "";
    this.interimFrom = null;
    if (!text || from === null) return false;
    const start = Math.max(from, this.startedAt);
    const end = Math.max(this.now(), start + 200);
    return (
      end - start <= 12000 && attempt.accept(text, start, end, this.startedAt)
    );
  }

  consume(event: BrowserRecognitionEventLike, attempt: LiveSingingAttempt) {
    const now = this.now();
    let interimText = "";
    const startIdx = Math.max(
      0,
      Number.isSafeInteger(event.resultIndex) ? event.resultIndex : 0,
    );
    const finals: {
      text: string;
      alternatives: string[];
      usable: boolean;
    }[] = [];

    for (let i = startIdx; i < event.results.length; i++) {
      const res = event.results[i];
      if (!res) continue;
      const alternatives = extractAlternatives(res);
      if (!res.isFinal) {
        if (alternatives.length) {
          const from = Math.max(
            this.interimFrom ??
              this.speakingFrom ??
              Math.max(this.startedAt, now - 400),
            this.startedAt,
          );
          const part = attempt.bestAlternative(
            alternatives,
            from,
            now,
            this.startedAt,
          );
          if (part) interimText += (interimText ? " " : "") + part;
        }
        continue;
      }
      if (this.finalSlots.has(i)) continue;
      if (alternatives.length) {
        const usable = hasUsableSingingConfidence(res[0]?.confidence);
        this.finalSlots.add(i);
        finals.push({
          text: alternatives[0],
          alternatives,
          usable,
        });
      }
    }

    if (interimText && this.interimFrom === null) {
      this.interimFrom =
        this.speakingFrom ?? Math.max(this.startedAt, now - 400);
    }

    if (!finals.length) {
      if (!interimText)
        return { changed: false, preview: emptyPreview, transcript: "" };
      this.lastInterimText = interimText;
      const from = Math.max(this.interimFrom ?? this.startedAt, this.startedAt);
      const preview = attempt.preview(
        interimText,
        from,
        Math.max(now, from + 200),
        this.startedAt,
      );
      return {
        changed: true,
        preview,
        transcript: interimText,
      };
    }
    const interimStart = this.interimFrom;
    this.interimFrom = null;
    this.lastInterimText = "";
    const end = now;
    const previous = this.lastFinalMs;
    this.lastFinalMs = end;
    if (this.overflow) {
      this.overflow = false;
      this.windows = [];
      this.speakingFrom = null;
      return { changed: false, preview: emptyPreview, transcript: "" };
    }
    const ranges = this.windows;
    this.windows = [];
    if (this.speakingFrom !== null && finals.length > ranges.length) {
      ranges.push({ start: this.speakingFrom, end });
      this.speakingFrom = end;
    } else if (
      !ranges.length &&
      !this.hasSpeechEvents &&
      end - previous <= (this.sliced ? 8000 : 4000)
    ) {
      ranges.push({ start: previous, end });
    } else if (!ranges.length && interimStart !== null && end > interimStart) {
      ranges.push({ start: interimStart, end });
    }
    const assign = (
      alternatives: readonly string[],
      range: SpeechWindow,
    ): { ok: boolean; chosen: string } => {
      if (range.end <= range.start || range.end - range.start > 12000)
        return { ok: false, chosen: "" };
      const from = Math.max(range.start, this.startedAt);
      const chosen = attempt.bestAlternative(
        alternatives,
        from,
        range.end,
        this.startedAt,
      );
      const ok = attempt.accept(chosen, from, range.end, this.startedAt);
      return { ok, chosen };
    };
    if (ranges.length === 1 && finals.every((slot) => slot.usable)) {
      const joinedChosen = finals
        .map((slot) =>
          attempt.bestAlternative(
            slot.alternatives,
            Math.max(ranges[0].start, this.startedAt),
            ranges[0].end,
            this.startedAt,
          ),
        )
        .join(" ");
      const { ok } = assign([joinedChosen], ranges[0]);
      return {
        changed: ok,
        preview: emptyPreview,
        transcript: ok ? joinedChosen : "",
      };
    }
    if (finals.length === 1 && finals[0].usable && ranges.length > 1) {
      const merged: SpeechWindow = {
        start: ranges[0].start,
        end: Math.max(ranges.at(-1)!.end, end),
      };
      const { ok, chosen } = assign(finals[0].alternatives, merged);
      return {
        changed: ok,
        preview: emptyPreview,
        transcript: ok ? chosen : "",
      };
    }
    if (ranges.length !== finals.length)
      return { changed: false, preview: emptyPreview, transcript: "" };
    let changed = false;
    const acceptedParts: string[] = [];
    finals.forEach((slot, index) => {
      if (slot.usable) {
        const { ok, chosen } = assign(slot.alternatives, ranges[index]);
        if (ok) {
          changed = true;
          acceptedParts.push(chosen);
        }
      }
    });
    return {
      changed,
      preview: emptyPreview,
      transcript: changed ? acceptedParts.join(" ") : "",
    };
  }
}

class KaraokeMicSession {
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
  private practiceLyrics: KaraokeLyrics | null = null;
  private getTime: () => number = () => 0;
  private savedSong: {
    snapshot: Snapshot;
    attempt: LiveSingingAttempt | null;
  } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolveArm: ((started: boolean) => void) | null = null;
  private emptyRestarts = 0;

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(
    status: Status,
    error: string | null = null,
    score: LiveSingingScore | null = null,
  ) {
    this.snapshot = {
      status,
      error,
      score,
      liveScore: this.snapshot.liveScore,
      songScore: this.savedSong ? this.savedSong.snapshot.score : score,
      previewWords: this.snapshot.previewWords ?? emptyPreview,
      liveTranscript: this.snapshot.liveTranscript ?? "",
    };
    for (const listener of this.listeners) listener();
  }

  private closeStream() {
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) {
      track.onended = null;
      track.stop();
    }
    this.stream = null;
  }

  private release(abort: boolean, keepStream = false) {
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
    this.practiceLyrics = null;
    this.savedSong = null;
    this.snapshot = idle;
    this.emptyRestarts = 0;
    this.update("idle");
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
        this.savedSong = { snapshot, attempt: this.attempt };
      }
      this.release(true);
      this.acknowledge(false);
    } else this.reset();
    this.getTime = clock;
    this.practiceLyrics = lineId ? { ...lyrics, lines } : null;
    this.attempt = new LiveSingingAttempt(this.practiceLyrics ?? lyrics, true);
    this.snapshot = { ...idle, liveScore: this.attempt.result(!!lineId) };
    this.emptyRestarts = 0;
    this.update("arming");
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
    this.snapshot = saved.snapshot;
    this.update(
      saved.snapshot.status,
      saved.snapshot.error,
      saved.snapshot.score,
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
    if (!devices?.getUserMedia || (!probe && !this.trackInput)) {
      recognition.start();
      return;
    }
    const stream =
      this.stream ??
      (await devices.getUserMedia({
        audio: {
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
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      this.fail(
        "Trình duyệt này chưa hỗ trợ nhận dạng để chấm điểm. Bé có thể hát tự do.",
      );
      return;
    }
    try {
      const recognition = new Constructor();
      const windows = new CaptureWindows(this.getTime, this.trackInput);
      let capturing = false;
      let noSpeech = false;
      this.windows = windows;
      this.recognition = recognition;
      recognition.lang = "vi-VN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 5;

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
          this.update("listening");
          if (this.trackInput) this.scheduleSlice(recognition, windows);
        }
      };
      recognition.onresult = (event) => {
        if (this.recognition !== recognition || !capturing || !this.attempt)
          return;
        const outcome = windows.consume(event, this.attempt);
        if (outcome.changed) {
          this.emptyRestarts = 0;
          this.snapshot = {
            ...this.snapshot,
            liveScore: this.attempt.result(!!this.savedSong),
            previewWords: outcome.preview,
            liveTranscript: outcome.transcript || this.snapshot.liveTranscript,
          };
          this.update(this.snapshot.status);
        }
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
          this.attempt &&
          windows.flushInterim(this.attempt)
        ) {
          this.emptyRestarts = 0;
          this.snapshot = {
            ...this.snapshot,
            liveScore: this.attempt.result(!!this.savedSong),
            previewWords: emptyPreview,
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
      this.attempt = new LiveSingingAttempt(this.practiceLyrics, true);
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
    if (!this.attempt || !["listening", "armed"].includes(this.snapshot.status))
      return;
    if (
      this.attempt.observePlayback(
        fromMs,
        toMs,
        150,
        this.snapshot.previewWords,
      )
    ) {
      this.snapshot = {
        ...this.snapshot,
        liveScore: this.attempt.result(!!this.savedSong),
      };
      this.update(this.snapshot.status);
    }
  };

  private complete(error = this.snapshot.error) {
    if (this.attempt && this.windows) {
      this.windows.flushInterim(this.attempt);
    }
    this.release(true);
    this.attempt?.flushPlayedOmissions(
      this.getTime(),
      this.snapshot.previewWords,
    );
    const result = this.attempt?.result(!!this.savedSong || !!error);
    this.attempt = null;
    if (result && result.kind !== "insufficient")
      this.update("scored", error, result);
    else this.update("insufficient", error);
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
) {
  const [session] = useState(() => new KaraokeMicSession());
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
