import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { TUNING_CASES } from "./alignment-corpus";
import { legacyPipeline, runCase, summarize } from "./alignment-benchmark";

/**
 * Baseline measurement of the pre-autopilot behaviour on the TUNING split.
 * Writes JSON only when READING_BENCH_OUT is set; otherwise it just checks the
 * corpus is well formed (every label count matches the book).
 */
describe("alignment benchmark baseline (legacy engine, tuning split)", () => {
  it("scores the tuning corpus with the legacy pipeline", () => {
    const scores = TUNING_CASES.map((c) => runCase(c, legacyPipeline));
    const summary = summarize(scores);
    const out = process.env.READING_BENCH_OUT;
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        JSON.stringify(
          {
            pipeline: "legacy",
            split: "tuning",
            kind: "synthetic transcript-level (no audio, no child voice)",
            summary,
            failures: scores
              .filter((s) => s.failures.length)
              .map((s) => ({ id: s.id, failures: s.failures })),
          },
          null,
          2,
        ),
      );
    }
    expect(summary.total.cases).toBe(TUNING_CASES.length);
  });
});
