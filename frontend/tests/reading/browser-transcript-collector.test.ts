import { describe, expect, it } from "vitest";

import {
  BrowserTranscriptCollector,
  resolveTranscriptForSegment,
  type BrowserRecognitionEventLike,
} from "@/lib/reading/browser-transcript-collector";

function event(
  resultIndex: number,
  results: Array<{ text: string; isFinal: boolean }>,
): BrowserRecognitionEventLike {
  return {
    resultIndex,
    results: results.map((result) => ({
      isFinal: result.isFinal,
      0: { transcript: result.text },
    })),
  };
}

describe("BrowserTranscriptCollector", () => {
  it("excludes low-confidence finals from both fallback and emitted tokens", () => {
    const collector = new BrowserTranscriptCollector();
    expect(
      collector.addResults({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: "sai", confidence: 0.1 } }],
      }),
    ).toEqual([]);
    collector.completeRecognitionCycle();
    expect(collector.getTranscript()).toBe("");
  });

  it("keeps emitted final slots consistent with persisted fallback after a changed callback", () => {
    const collector = new BrowserTranscriptCollector();
    expect(
      collector.addResults(event(0, [{ text: "Bé", isFinal: true }])),
    ).toEqual(["Bé"]);
    expect(
      collector.addResults(event(0, [{ text: "Mẹ", isFinal: true }])),
    ).toEqual([]);
    expect(collector.getTranscript()).toBe("Bé");
  });

  it("ignores interim results and records only final speech", () => {
    const collector = new BrowserTranscriptCollector();

    collector.addResults(
      event(0, [
        { text: "Con", isFinal: false },
        { text: "mèo", isFinal: false },
      ]),
    );

    expect(collector.getTranscript()).toBe("");

    collector.addResults(
      event(0, [
        { text: "Con", isFinal: true },
        { text: "mèo", isFinal: false },
      ]),
    );

    expect(collector.getTranscript()).toBe("Con");
  });

  it("does not duplicate stable result indexes on repeated onresult callbacks", () => {
    const collector = new BrowserTranscriptCollector();
    const finalResults = event(0, [
      { text: "Con", isFinal: true },
      { text: "mèo", isFinal: true },
    ]);

    collector.addResults(finalResults);
    collector.addResults(finalResults);
    collector.completeRecognitionCycle();

    expect(collector.getTranscript()).toBe("Con mèo");
  });

  it("emits each final slot once without suppressing genuinely repeated words", () => {
    const collector = new BrowserTranscriptCollector();
    const first = event(0, [{ text: "Bé", isFinal: true }]);
    expect(collector.addResults(first)).toEqual(["Bé"]);
    expect(collector.addResults(first)).toEqual([]);
    expect(
      collector.addResults(
        event(1, [
          { text: "Bé", isFinal: true },
          { text: "Bé", isFinal: true },
        ]),
      ),
    ).toEqual(["Bé"]);
    expect(collector.getTranscript()).toBe("Bé Bé");
    collector.completeRecognitionCycle();
    expect(collector.addResults(first)).toEqual(["Bé"]);
    expect(collector.getTranscript()).toBe("Bé Bé Bé");
  });

  it("preserves final-result order across recognition restarts", () => {
    const collector = new BrowserTranscriptCollector();

    collector.addResults(event(0, [{ text: "Con mèo", isFinal: true }]));
    collector.completeRecognitionCycle();

    // Web Speech may restart and reset result indexes to zero.
    collector.addResults(event(0, [{ text: "đang ngủ", isFinal: true }]));
    collector.completeRecognitionCycle();

    expect(collector.getTranscript()).toBe("Con mèo đang ngủ");
  });

  it("preserves the browser finals already consumed by alignment when the provider disagrees", () => {
    expect(
      resolveTranscriptForSegment(
        "  Provider transcript  ",
        "Browser transcript",
      ),
    ).toBe("Browser transcript");
  });

  it("uses provider speech when no browser final was consumed", () => {
    expect(resolveTranscriptForSegment("  Provider transcript  ", " ")).toBe(
      "Provider transcript",
    );
  });

  it("uses only real browser final text when provider STT fails", () => {
    expect(resolveTranscriptForSegment(null, "  Browser final text  ")).toBe(
      "Browser final text",
    );
  });

  it("does not fabricate a transcript when both recognition sources are empty", () => {
    expect(resolveTranscriptForSegment("  ", null)).toBeNull();
  });

  it("resets all collected speech for a new capture", () => {
    const collector = new BrowserTranscriptCollector();
    collector.addResults(event(0, [{ text: "Con mèo", isFinal: true }]));
    collector.completeRecognitionCycle();

    collector.reset();

    expect(collector.getTranscript()).toBe("");
  });
});
