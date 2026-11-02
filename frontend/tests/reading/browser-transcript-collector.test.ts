import { describe, expect, it } from "vitest";

import {
  BrowserTranscriptCollector,
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

  it("preserves final-result order across recognition restarts", () => {
    const collector = new BrowserTranscriptCollector();

    collector.addResults(event(0, [{ text: "Con mèo", isFinal: true }]));
    collector.completeRecognitionCycle();

    // Web Speech may restart and reset result indexes to zero.
    collector.addResults(
      event(0, [{ text: "đang ngủ", isFinal: true }]),
    );
    collector.completeRecognitionCycle();

    expect(collector.getTranscript()).toBe("Con mèo đang ngủ");
  });

  it("resets all collected speech for a new capture", () => {
    const collector = new BrowserTranscriptCollector();
    collector.addResults(event(0, [{ text: "Con mèo", isFinal: true }]));
    collector.completeRecognitionCycle();

    collector.reset();

    expect(collector.getTranscript()).toBe("");
  });
});
