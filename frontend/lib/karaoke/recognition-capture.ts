import {
  BrowserTranscriptCollector,
  type BrowserRecognitionEventLike,
} from "@/lib/reading/browser-transcript-collector";
import { LiveSingingAttempt, type LiveWordState } from "./live-singing-score";
const emptyPreview: ReadonlyMap<string, LiveWordState> = new Map();

type SpeechWindow = { start: number; end: number };

// SpeechRecognition provides final text without word timestamps. Prefer speech
// activity measured on the native music clock; a result-only interval is usable
// only while short enough to locate its utterance. Never invent earlier times.
let captureSequence = 0;

export class CaptureWindows {
  captureId = `browser-${++captureSequence}`;
  private revision = 0;
  private parts: { text: string; range: SpeechWindow }[] = [];
  private breakGroup(attempt: LiveSingingAttempt) {
    this.parts = [];
    this.captureId = `browser-${++captureSequence}`;
    this.revision = 0;
    attempt.beginCapture(this.captureId);
  }
  private readonly collector = new BrowserTranscriptCollector();
  private windows: SpeechWindow[] = [];
  private speakingFrom: number | null = null;
  private interimFrom: number | null = null;
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
    return this.stoppedAt;
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

  consume(event: BrowserRecognitionEventLike, attempt: LiveSingingAttempt) {
    // Transcript activity contradicts a silence verdict, even if ASR rejects
    // its confidence or cannot locate the words reliably.
    if (
      Array.from(event.results).some((result) => result[0]?.transcript?.trim())
    )
      attempt.noteSpeech(this.startedAt, this.now());
    let interimText = "";
    const startIdx = Math.max(0, event.resultIndex ?? 0);
    for (let i = startIdx; i < event.results.length; i++) {
      const res = event.results[i];
      if (res && !res.isFinal) {
        const part = res[0]?.transcript?.trim() ?? "";
        if (part) interimText += (interimText ? " " : "") + part;
      }
    }
    const now = this.now();
    if (interimText && this.interimFrom === null) {
      this.interimFrom =
        this.speakingFrom ?? Math.max(this.startedAt, now - 400);
    }

    const finals: { text: string; usable: boolean }[] = [];
    this.collector.addResults(event, (text, usable) => {
      finals.push({ text, usable });
      return usable;
    });
    if (!finals.length) {
      if (!interimText)
        return { changed: false, preview: emptyPreview, transcript: "" };
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
    const end = now;
    const previous = this.lastFinalMs;
    this.lastFinalMs = end;
    if (this.overflow) {
      this.overflow = false;
      this.windows = [];
      this.speakingFrom = null;
      this.breakGroup(attempt);
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
    const assign = (text: string, range: SpeechWindow) => {
      if (range.end <= range.start || range.end - range.start > 12000)
        return false;
      const last = this.parts.at(-1);
      // Do not bridge a long silence, invalid packet or unbounded capture with
      // a transcript assembled from unrelated utterances.
      if (
        last &&
        (range.start < last.range.end ||
          range.start - last.range.end > 350 ||
          range.end - this.parts[0].range.start > 12000)
      ) {
        this.breakGroup(attempt);
      }
      this.parts.push({ text, range });
      return attempt.acceptCapture(
        this.captureId,
        ++this.revision,
        this.parts.map((part) => part.text).join(" "),
        Math.max(this.parts[0].range.start, this.startedAt),
        range.end,
        this.startedAt,
      );
    };
    const finalTranscript = finals
      .filter((slot) => slot.usable)
      .map((slot) => slot.text.trim())
      .filter(Boolean)
      .join(" ");
    if (ranges.length === 1 && finals.every((slot) => slot.usable)) {
      const ok = assign(finals.map((slot) => slot.text).join(" "), ranges[0]);
      return {
        changed: ok,
        preview: emptyPreview,
        transcript: ok ? finalTranscript : "",
      };
    }
    if (finals.length === 1 && finals[0].usable && ranges.length > 1) {
      const merged: SpeechWindow = {
        start: ranges[0].start,
        end: Math.max(ranges.at(-1)!.end, end),
      };
      const ok = assign(finals[0].text, merged);
      return {
        changed: ok,
        preview: emptyPreview,
        transcript: ok ? finalTranscript : "",
      };
    }
    if (ranges.length !== finals.length) {
      this.breakGroup(attempt);
      return { changed: false, preview: emptyPreview, transcript: "" };
    }
    let changed = false;
    finals.forEach((slot, index) => {
      if (slot.usable && assign(slot.text, ranges[index])) changed = true;
      if (!slot.usable) this.breakGroup(attempt);
    });
    return {
      changed,
      preview: emptyPreview,
      transcript: changed ? finalTranscript : "",
    };
  }
}
