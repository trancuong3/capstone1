import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOLDOUT_CASES,
  TUNING_CASES,
  type CorpusCase,
} from "./alignment-corpus";
import {
  autopilotPipeline,
  legacyPipeline,
  runCase,
  summarize,
  type PipelineFactory,
} from "./alignment-benchmark";

/**
 * Locked gates G1–G4 (see docs/reading/DELIVERY_STATUS.md §2.2):
 *  G1 false-correct = 0
 *  G2 fluent false-wrong = 0 and total false-wrong <= 2% of scored words
 *  G3 no mis-assigned words in the duplicate-words group
 *  G4 echo group: no false-correct (TTS audio never turns a word green)
 *
 * The holdout split is evaluated only when READING_BENCH_HOLDOUT=1 so that it
 * is run once, for the final verdict.
 */
function evaluate(
  name: string,
  cases: readonly CorpusCase[],
  factory: PipelineFactory,
  outFile?: string,
) {
  const scores = cases.map((corpusCase) => runCase(corpusCase, factory));
  const summary = summarize(scores);
  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          pipeline: name,
          kind: "synthetic transcript-level (no audio, no child voice)",
          summary,
          failures: scores
            .filter((score) => score.failures.length)
            .map((score) => ({ id: score.id, failures: score.failures })),
        },
        null,
        2,
      ),
    );
  }
  return { scores, summary };
}

function assertGates(label: string, result: ReturnType<typeof evaluate>): void {
  const { summary, scores } = result;
  const detail = JSON.stringify(
    scores.filter((score) => score.failures.length),
    null,
    1,
  );
  expect(
    summary.total.falseCorrect,
    `${label} G1 false-correct\n${detail}`,
  ).toBe(0);
  expect(
    summary.byGroup.fluent?.falseWrong ?? 0,
    `${label} G2 fluent false-wrong\n${detail}`,
  ).toBe(0);
  expect(
    summary.total.falseWrong / summary.total.words,
    `${label} G2 total false-wrong rate\n${detail}`,
  ).toBeLessThanOrEqual(0.02);
  expect(
    summary.byGroup["duplicate-words"]?.wrongClass ?? 0,
    `${label} G3 duplicate-words mis-assignment\n${detail}`,
  ).toBe(0);
  expect(
    summary.byGroup.echo?.falseCorrect ?? 0,
    `${label} G4 echo false-correct\n${detail}`,
  ).toBe(0);
}

describe("autopilot evidence benchmark (synthetic transcript-level)", () => {
  it("meets the locked gates on the TUNING split", () => {
    const result = evaluate(
      "autopilot",
      TUNING_CASES,
      autopilotPipeline,
      process.env.READING_BENCH_OUT_DIR
        ? `${process.env.READING_BENCH_OUT_DIR}/after-autopilot-tuning.json`
        : undefined,
    );
    assertGates("tuning", result);
    // Informational: every tuning case should also classify each word exactly.
    expect(
      result.summary.total.failingCases,
      "tuning cases with any misclassified word",
    ).toEqual([]);
  });

  it("keeps the legacy pipeline as a measurable baseline (must still fail G1/G2)", () => {
    const legacy = evaluate("legacy", TUNING_CASES, legacyPipeline);
    expect(
      legacy.summary.total.falseCorrect + legacy.summary.total.falseWrong,
    ).toBeGreaterThan(0);
  });

  it.skipIf(!process.env.READING_BENCH_HOLDOUT)(
    "meets the locked gates on the HOLDOUT split (run once for the verdict)",
    () => {
      const dir = process.env.READING_BENCH_OUT_DIR;
      const result = evaluate(
        "autopilot",
        HOLDOUT_CASES,
        autopilotPipeline,
        dir ? `${dir}/final-autopilot-holdout.json` : undefined,
      );
      if (dir) {
        evaluate(
          "legacy",
          HOLDOUT_CASES,
          legacyPipeline,
          `${dir}/final-legacy-holdout.json`,
        );
      }
      assertGates("holdout", result);
    },
  );
});
