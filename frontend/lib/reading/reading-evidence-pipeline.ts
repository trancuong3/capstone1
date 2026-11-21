import {
  EchoGuard,
  type EchoGuardOptions,
  type EchoVerdictReason,
} from "@/lib/reading/echo-guard";
import {
  RealtimeAlignmentEngine,
  tokenizeRealtimeText,
  type RealtimeAlignmentSnapshot,
} from "@/lib/reading/realtime-alignment";
import { gradeWords, type GradedWordState } from "@/lib/reading/word-grading";
import { parseVoiceIntent, type VoiceIntent } from "@/lib/reading/voice-intent";
import type { ReadingPageWordDTO } from "@/types/reading";

/** Words per millisecond of detected speech beyond which text is implausible. */
const MIN_SPEECH_MS_PER_WORD = 150;

export type EvidenceRejectReason =
  | EchoVerdictReason
  | "duplicate-segment"
  | "out-of-order"
  | "unusable"
  | "implausible-speed"
  | "empty"
  | "stale-scope"
  | "paused";

/** Identity of one capture run; late events from another run are dropped. */
export interface CaptureScope {
  readonly sessionId: string;
  readonly pageId: string;
  readonly revisionId: string;
  readonly runId: number;
}

export function sameCaptureScope(a: CaptureScope, b: CaptureScope): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.pageId === b.pageId &&
    a.revisionId === b.revisionId &&
    a.runId === b.runId
  );
}

export interface EvidenceSegment {
  readonly text: string;
  readonly receivedAt: number;
  readonly onsetAt?: number | null;
  readonly segmentId?: string;
  /** Monotonic sequence from the provider; lower than the last one is stale. */
  readonly seq?: number;
  /** Already passed provider-specific quality gates (see recognition-evidence). */
  readonly usable?: boolean;
  /** Browser confidence 0..1; 0/undefined means "not supplied". */
  readonly confidence?: number | null;
  /** Capture run this result belongs to (stale results are rejected). */
  readonly scope?: CaptureScope;
  /** Detected speech inside this segment's audio, when known. */
  readonly speechDurationMs?: number | null;
}

export type EvidenceOutcome =
  | { readonly kind: "scored"; readonly snapshot: RealtimeAlignmentSnapshot }
  | { readonly kind: "off-topic"; readonly snapshot: RealtimeAlignmentSnapshot }
  | { readonly kind: "intent"; readonly intent: VoiceIntent }
  | { readonly kind: "rejected"; readonly reason: EvidenceRejectReason };

export interface EvidencePipelineOptions {
  readonly scope?: CaptureScope;
  readonly echo?: EchoGuardOptions;
  readonly lookahead?: number;
  readonly hesitationThreshold?: number;
}

/**
 * One reading capture of one page revision: echo gate → plausibility →
 * voice-command intent → alignment. Holds NO timers and does no I/O so the
 * same behaviour is reproducible in tests and in the reading screen.
 */
export class ReadingEvidencePipeline {
  readonly engine: RealtimeAlignmentEngine;
  readonly echo: EchoGuard;
  private readonly helped = new Set<string>();
  private readonly gaveUp = new Set<string>();
  private readonly seenSegments = new Set<string>();
  private lastSeq = -1;
  private rejectedSegments = 0;
  private readonly scope?: CaptureScope;

  constructor(
    private readonly words: readonly ReadingPageWordDTO[],
    options: EvidencePipelineOptions = {},
  ) {
    this.engine = new RealtimeAlignmentEngine(
      words,
      options.lookahead ?? 3,
      options.hesitationThreshold ?? 1,
    );
    this.echo = new EchoGuard(options.echo);
    this.scope = options.scope;
  }

  get rejectedCount(): number {
    return this.rejectedSegments;
  }

  playbackStarted(
    id: string,
    text: string,
    now: number,
    helpedWordIds?: readonly string[],
  ): void {
    this.echo.playbackStarted(id, text, now);
    for (const wordId of helpedWordIds ?? this.resolveSampleWords(text)) {
      this.helped.add(wordId);
    }
  }

  /**
   * Book words a sample covers: the first run of words, from just before the
   * cursor onwards, that spells the sample text. Prompts that are not book
   * text ("Đến lượt con đọc nhé") resolve to nothing.
   */
  resolveSampleWords(text: string): string[] {
    const sample = tokenizeRealtimeText(text);
    if (!sample.length) return [];
    const book = this.words.map((word) => tokenizeRealtimeText(word.text)[0]);
    const cursor = Math.max(0, this.engine.getSnapshot().currentWordIndex);
    const last = Math.min(book.length - sample.length, cursor + 12);
    for (let start = Math.max(0, cursor - 1); start <= last; start += 1) {
      if (sample.every((token, offset) => book[start + offset] === token)) {
        return sample.map((_, offset) => this.words[start + offset].word_id);
      }
    }
    return [];
  }

  playbackEnded(id: string, now: number): void {
    this.echo.playbackEnded(id, now);
  }

  markGaveUp(wordId: string): void {
    this.gaveUp.add(wordId);
    this.engine.giveUpWord(wordId);
  }

  markUncertain(): void {
    this.engine.markUncertain();
  }

  ingestFinal(segment: EvidenceSegment): EvidenceOutcome {
    const reject = (reason: EvidenceRejectReason): EvidenceOutcome => {
      this.rejectedSegments += 1;
      return { kind: "rejected", reason };
    };
    if (
      this.scope &&
      segment.scope &&
      !sameCaptureScope(this.scope, segment.scope)
    ) {
      return reject("stale-scope");
    }
    if (segment.usable === false) return reject("unusable");
    const tokens = tokenizeRealtimeText(segment.text);
    if (!tokens.length) return reject("empty");

    if (segment.seq !== undefined) {
      if (segment.seq <= this.lastSeq) return reject("out-of-order");
    }
    const identity = segment.segmentId;
    if (identity) {
      if (this.seenSegments.has(identity)) return reject("duplicate-segment");
    }

    const verdict = this.echo.evaluate(segment);
    if (!verdict.accept) return reject(verdict.reason);

    if (
      tokens.length >= 3 &&
      segment.speechDurationMs != null &&
      segment.speechDurationMs < tokens.length * MIN_SPEECH_MS_PER_WORD
    ) {
      return reject("implausible-speed");
    }

    if (identity) this.seenSegments.add(identity);
    if (segment.seq !== undefined) this.lastSeq = segment.seq;

    const intent = parseVoiceIntent(segment.text, {
      confidence: segment.confidence,
      upcomingText: this.upcomingText(),
    });
    if (intent.type !== "NONE") return { kind: "intent", intent };

    const before = this.engine.getSnapshot().rejectedSegmentCount ?? 0;
    const snapshot = this.engine.addFinalTranscript(segment.text, identity);
    if ((snapshot.rejectedSegmentCount ?? 0) > before) {
      this.rejectedSegments += 1;
      return { kind: "off-topic", snapshot };
    }
    return { kind: "scored", snapshot };
  }

  finish(): RealtimeAlignmentSnapshot {
    return this.engine.finish();
  }

  snapshot(): RealtimeAlignmentSnapshot {
    return this.engine.getSnapshot();
  }

  grade(): Map<string, GradedWordState> {
    return gradeWords(
      this.engine.getSnapshot(),
      this.words,
      this.helped,
      this.gaveUp,
    );
  }

  helpedWordIds(): ReadonlySet<string> {
    return this.helped;
  }

  /** The next dozen words the child is expected to read. */
  private upcomingText(): string {
    const snapshot = this.engine.getSnapshot();
    if (snapshot.currentWordIndex < 0) return "";
    const from = snapshot.currentWordIndex;
    return this.words
      .slice(from, from + 12)
      .map((word) => word.text)
      .join(" ");
  }
}
