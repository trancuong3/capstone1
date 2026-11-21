import {
  RealtimeAlignmentEngine,
  type RealtimeAlignmentSnapshot,
} from "@/lib/reading/realtime-alignment";
import { ReadingEvidencePipeline } from "@/lib/reading/reading-evidence-pipeline";
import {
  bookWords,
  type CorpusCase,
  type CorpusEvent,
  type CorpusGroup,
  type CorpusLabel,
} from "./alignment-corpus";

export type GradedState =
  | "CORRECT"
  | "RETRY"
  | "SKIPPED"
  | "ASSISTED"
  | "NO_EVIDENCE";

export interface BenchmarkPipeline {
  feed(event: CorpusEvent): void;
  grade(): GradedState[];
}

export type PipelineFactory = (
  words: ReturnType<typeof bookWords>,
) => BenchmarkPipeline;

function gradeLegacy(
  snapshot: RealtimeAlignmentSnapshot,
  count: number,
): GradedState[] {
  return Array.from({ length: count }, (_, index) => {
    const status = snapshot.statusByWordId.get(`w${index}`)?.status;
    if (status === "MATCH") return "CORRECT";
    if (status === "SUBSTITUTE") return "RETRY";
    if (status === "DELETE") return "SKIPPED";
    return "NO_EVIDENCE";
  });
}

/**
 * Behaviour of the screen BEFORE the autopilot work: the engine alone, with
 * browser results dropped only while the assistant audio is playing
 * (`assistantAudioPlayingRef`). No echo tail, no content check.
 */
export const legacyPipeline: PipelineFactory = (words) => {
  const engine = new RealtimeAlignmentEngine(words, 3, 1);
  let playFrom = -1;
  let playUntil = -1;
  return {
    feed(event) {
      if (event.k === "tts") {
        playFrom = event.t;
        playUntil = event.t + event.dur;
      } else if (event.k === "uncertain") engine.markUncertain();
      else if (event.k === "finish") engine.finish();
      else if (event.k === "final") {
        if (event.t >= playFrom && event.t < playUntil) return;
        engine.addFinalTranscript(event.text);
      }
    },
    grade: () => gradeLegacy(engine.getSnapshot(), words.length),
  };
};

/** The autopilot evidence pipeline: echo guard + intent + hardened engine. */
export const autopilotPipeline: PipelineFactory = (words) => {
  const pipeline = new ReadingEvidencePipeline(words);
  let sequence = 0;
  let playback = 0;
  return {
    feed(event) {
      if (event.k === "tts") {
        const id = `tts-${(playback += 1)}`;
        pipeline.playbackStarted(id, event.text, event.t);
        pipeline.playbackEnded(id, event.t + event.dur);
      } else if (event.k === "uncertain") pipeline.markUncertain();
      else if (event.k === "finish") pipeline.finish();
      else if (event.k === "final") {
        sequence += 1;
        pipeline.ingestFinal({
          text: event.text,
          receivedAt: event.t,
          onsetAt: event.onset,
          segmentId: `segment-${sequence}`,
          seq: sequence,
        });
      }
    },
    grade: () => {
      const graded = pipeline.grade();
      return words.map((word) => graded.get(word.word_id) ?? "NO_EVIDENCE");
    },
  };
};

export interface CaseScore {
  readonly id: string;
  readonly group: CorpusGroup;
  readonly words: number;
  readonly falseCorrect: number;
  readonly falseWrong: number;
  readonly missedCorrect: number;
  readonly wrongClass: number;
  readonly failures: string[];
}

export function scoreCase(
  corpusCase: CorpusCase,
  graded: readonly GradedState[],
): CaseScore {
  const labels = corpusCase.expected.split(/\s+/u) as CorpusLabel[];
  if (labels.length !== graded.length) {
    throw new Error(
      `${corpusCase.id}: ${labels.length} labels for ${graded.length} words`,
    );
  }
  let falseCorrect = 0;
  let falseWrong = 0;
  let missedCorrect = 0;
  let wrongClass = 0;
  const failures: string[] = [];
  labels.forEach((label, index) => {
    const got = graded[index];
    const where = `${index}:${label}->${got}`;
    if (label === "L") {
      return;
    }
    if (got === "CORRECT" && label !== "C") {
      falseCorrect += 1;
      failures.push(`false-correct ${where}`);
    }
    if (
      (got === "RETRY" || got === "SKIPPED") &&
      (label === "C" || label === "N")
    ) {
      falseWrong += 1;
      failures.push(`false-wrong ${where}`);
    }
    if (label === "C" && (got === "NO_EVIDENCE" || got === "ASSISTED")) {
      missedCorrect += 1;
      failures.push(`missed-correct ${where}`);
    }
    const ok =
      (label === "C" && got === "CORRECT") ||
      (label === "W" && got === "RETRY") ||
      (label === "S" && got === "SKIPPED") ||
      (label === "H" && got !== "CORRECT") ||
      (label === "N" && got === "NO_EVIDENCE");
    if (!ok) wrongClass += 1;
  });
  return {
    id: corpusCase.id,
    group: corpusCase.group,
    words: labels.filter((label) => label !== "L").length,
    falseCorrect,
    falseWrong,
    missedCorrect,
    wrongClass,
    failures,
  };
}

export function runCase(
  corpusCase: CorpusCase,
  factory: PipelineFactory,
): CaseScore {
  const words = bookWords(corpusCase.book);
  const pipeline = factory(words);
  const ordered = [...corpusCase.events].sort((a, b) => a.t - b.t);
  for (const event of ordered) pipeline.feed(event);
  return scoreCase(corpusCase, pipeline.grade());
}

export interface GroupSummary {
  readonly words: number;
  readonly falseCorrect: number;
  readonly falseWrong: number;
  readonly missedCorrect: number;
  readonly wrongClass: number;
  readonly cases: number;
  readonly failingCases: string[];
}

export function summarize(scores: readonly CaseScore[]) {
  const byGroup: Record<string, GroupSummary> = {};
  const total = {
    words: 0,
    falseCorrect: 0,
    falseWrong: 0,
    missedCorrect: 0,
    wrongClass: 0,
    cases: 0,
    failingCases: [] as string[],
  };
  for (const score of scores) {
    const group = (byGroup[score.group] ??= {
      words: 0,
      falseCorrect: 0,
      falseWrong: 0,
      missedCorrect: 0,
      wrongClass: 0,
      cases: 0,
      failingCases: [],
    });
    for (const target of [group, total]) {
      (target as { words: number }).words += score.words;
      (target as { falseCorrect: number }).falseCorrect += score.falseCorrect;
      (target as { falseWrong: number }).falseWrong += score.falseWrong;
      (target as { missedCorrect: number }).missedCorrect +=
        score.missedCorrect;
      (target as { wrongClass: number }).wrongClass += score.wrongClass;
      (target as { cases: number }).cases += 1;
      if (score.wrongClass) target.failingCases.push(score.id);
    }
  }
  return { total, byGroup };
}
