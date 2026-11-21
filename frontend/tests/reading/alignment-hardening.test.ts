import { describe, expect, it } from "vitest";
import { EchoGuard } from "@/lib/reading/echo-guard";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import {
  ReadingEvidencePipeline,
  type CaptureScope,
} from "@/lib/reading/reading-evidence-pipeline";
import { parseVoiceIntent } from "@/lib/reading/voice-intent";
import {
  gradeWord,
  gradeWords,
  needsPractice,
} from "@/lib/reading/word-grading";
import type { ReadingPageWordDTO } from "@/types/reading";

function pageWords(text: string): ReadingPageWordDTO[] {
  return text.split(" ").map((word, index) => ({
    text: word,
    word_index: index,
    word_id: `w${index}`,
    bbox: [0, 0, 1, 1],
  }));
}
const engineFor = (text: string) =>
  new RealtimeAlignmentEngine(pageWords(text), 3, 1);
const status = (e: RealtimeAlignmentEngine, id: string) =>
  e.getSnapshot().statusByWordId.get(id)?.status;

describe("alignment hardening: self-correction, restart, jumps", () => {
  it("upgrades a word the child fixes after moving on, without counting twice", () => {
    const e = engineFor("Mẹ nấu cơm cho cả nhà ăn");
    e.addFinalTranscript("Mẹ nấu cớm cho cơm cho cả nhà ăn");
    const result = e.finish();
    expect(status(e, "w2")).toBe("MATCH");
    expect([...(result.correctedWordIds ?? [])]).toEqual(["w2"]);
    expect(
      [...result.statusByWordId.values()].every((w) => w.status === "MATCH"),
    ).toBe(true);
    expect(result.repeatedItems).toHaveLength(0);
  });

  it("does not upgrade after the capture is finished (first result is kept)", () => {
    const e = engineFor("mèo");
    e.addFinalTranscript("chó");
    e.finish();
    e.addFinalTranscript("mèo");
    expect(status(e, "w0")).toBe("SUBSTITUTE");
  });

  it("replays a restarted sentence without a false substitution", () => {
    const e = engineFor("Bé Lan đi học cùng mẹ");
    e.addFinalTranscript("Bé Lan đi học Bé Lan đi học cùng mẹ");
    const result = e.finish();
    expect([...result.statusByWordId.values()].map((w) => w.status)).toEqual(
      Array(6).fill("MATCH"),
    );
  });

  it("treats a restart after a slip as self-correction, not an error", () => {
    const e = engineFor("Bé Lan đi học cùng mẹ");
    e.addFinalTranscript("Bé Lan đi hộp Bé Lan đi học cùng mẹ");
    expect(e.finish().statusByWordId.get("w3")?.status).toBe("MATCH");
  });

  it("jumps over a skipped line when two words only fit together further ahead", () => {
    const e = engineFor("Trời mưa to Mưa rơi trên mái nhà Mưa tạnh rồi");
    e.addFinalTranscript("Trời mưa to Mưa tạnh rồi");
    const snapshot = e.finish();
    expect(snapshot.statusByWordId.get("w9")?.status).toBe("MATCH");
    expect(snapshot.statusByWordId.get("w10")?.status).toBe("MATCH");
    expect(snapshot.statusByWordId.get("w4")?.status).toBe("DELETE");
  });

  it("keeps duplicate words on their own occurrence when read fluently", () => {
    const e = engineFor("Ba đi làm Ba về nhà Ba ăn cơm");
    e.addFinalTranscript("Ba đi làm Ba về nhà Ba ăn cơm");
    expect(
      [...e.finish().statusByWordId.values()].every(
        (w) => w.status === "MATCH",
      ),
    ).toBe(true);
  });

  it("matches a printed digit with its spoken word in both directions", () => {
    const spoken = engineFor("Mai có 2 quả cam");
    spoken.addFinalTranscript("Mai có hai quả cam");
    expect(spoken.finish().statusByWordId.get("w2")?.status).toBe("MATCH");
    const typed = engineFor("Lan có ba con mèo");
    typed.addFinalTranscript("Lan có 3 con mèo");
    expect(typed.finish().statusByWordId.get("w2")?.status).toBe("MATCH");
    const wrong = engineFor("Lan có 3 con mèo");
    wrong.addFinalTranscript("Lan có bốn con mèo");
    expect(wrong.finish().statusByWordId.get("w2")?.status).toBe("SUBSTITUTE");
  });

  it("composes Unicode: decomposed transcript matches composed book text", () => {
    const e = engineFor("Mẹ ơi");
    e.addFinalTranscript("Mẹ ơi".normalize("NFD"));
    expect(e.finish().statusByWordId.get("w0")?.status).toBe("MATCH");
  });

  it("ignores speech that does not follow the book and does not penalise the child", () => {
    const e = engineFor("Mẹ nấu cơm cho cả nhà ăn");
    const snapshot = e.addFinalTranscript("mẹ ơi nhà mình có khách");
    expect(snapshot.statusByWordId.size).toBe(0);
    expect(snapshot.rejectedSegmentCount).toBe(1);
    expect(snapshot.currentWordIndex).toBe(0);
  });

  it("does not move the preview cursor for off-topic interim speech", () => {
    const e = engineFor("Mẹ nấu cơm cho cả nhà ăn");
    const preview = e.previewAlignment("hôm nay trời mưa to lắm");
    expect(preview.currentWordIndex).toBe(0);
    expect(preview.previewMatchedWordIds.size).toBe(0);
  });

  it("cannot judge one- and two-word segments, so they still score", () => {
    const e = engineFor("Mẹ nấu cơm");
    e.addFinalTranscript("mẹ");
    expect(status(e, "w0")).toBe("MATCH");
  });

  it("keeps the tone distinction through the number/Unicode normalisation", () => {
    const e = engineFor("Bé Lan đi học cùng mẹ");
    e.addFinalTranscript("Bé Lan đi học cung mẹ");
    expect(e.finish().statusByWordId.get("w4")?.status).toBe("SUBSTITUTE");
  });
});

describe("EchoGuard", () => {
  it("rejects everything while a sample is playing", () => {
    const guard = new EchoGuard();
    guard.playbackStarted("a", "cho", 1000);
    expect(guard.isPlaying()).toBe(true);
    expect(guard.evaluate({ text: "cho", receivedAt: 1200 }).reason).toBe(
      "playing",
    );
    expect(guard.evaluate({ text: "gì đó", receivedAt: 1500 }).accept).toBe(
      false,
    );
  });

  it("rejects speech that began during playback even if it arrives after the end", () => {
    const guard = new EchoGuard();
    guard.playbackStarted("a", "cho", 1000);
    guard.playbackEnded("a", 1600);
    const verdict = guard.evaluate({
      text: "cho",
      receivedAt: 2000,
      onsetAt: 1200,
    });
    expect(verdict).toMatchObject({
      accept: false,
      reason: "onset-during-playback",
    });
  });

  it("accepts the child's own imitation that starts after the echo grace", () => {
    const guard = new EchoGuard();
    guard.playbackStarted("a", "cho", 1000);
    guard.playbackEnded("a", 1600);
    expect(
      guard.evaluate({ text: "cho", receivedAt: 2800, onsetAt: 2000 }).accept,
    ).toBe(true);
  });

  it("without onset info rejects tail echo that repeats the sample but not other words", () => {
    const guard = new EchoGuard();
    guard.playbackStarted("a", "nấu cơm cho", 1000);
    guard.playbackEnded("a", 2400);
    expect(
      guard.evaluate({ text: "nấu cơm cho", receivedAt: 3000 }).reason,
    ).toBe("tail-overlap");
    expect(guard.evaluate({ text: "cả nhà ăn", receivedAt: 3000 }).accept).toBe(
      true,
    );
    expect(
      guard.evaluate({ text: "nấu cơm cho", receivedAt: 9000 }).accept,
    ).toBe(true);
  });

  it("treats a cancelled sample as ended at the cancel time", () => {
    const guard = new EchoGuard();
    guard.playbackStarted("a", "cho", 1000);
    guard.playbackEnded("a", 1100);
    expect(guard.isPlaying()).toBe(false);
    expect(
      guard.evaluate({ text: "mèo", receivedAt: 5000, onsetAt: 4500 }).accept,
    ).toBe(true);
  });
});

describe("voice intent", () => {
  it.each([
    ["con không biết", "HELP"],
    ["Cô ơi đọc mẫu giúp con", "HELP"],
    ["đọc mẫu giúp con ạ", "HELP"],
    ["đợi con", "WAIT"],
    ["chờ con một chút", "WAIT"],
    ["dừng lại", "STOP"],
    ["con dừng đọc", "STOP"],
    ["đọc tiếp", "RESUME"],
    ["con đọc tiếp", "RESUME"],
  ])("recognises %s as %s", (spoken, type) => {
    expect(parseVoiceIntent(spoken).type).toBe(type);
  });

  it("never finds a command inside a longer sentence", () => {
    expect(
      parseVoiceIntent("hôm nay con đọc tiếp bài thơ về mùa thu").type,
    ).toBe("NONE");
  });

  it("lets the passage win when the phrase is the next book text", () => {
    const result = parseVoiceIntent("dừng lại", {
      upcomingText: "Xe buýt dừng lại ở cổng trường",
    });
    expect(result).toEqual({ type: "NONE", reason: "in-book" });
  });

  it("rejects commands below the confidence floor but accepts unknown confidence", () => {
    expect(parseVoiceIntent("dừng lại", { confidence: 0.3 }).reason).toBe(
      "low-confidence",
    );
    expect(parseVoiceIntent("dừng lại", { confidence: undefined }).type).toBe(
      "STOP",
    );
    expect(parseVoiceIntent("dừng lại", { confidence: 0 }).type).toBe("STOP");
  });
});

describe("word grading", () => {
  it("never marks helped or skipped words as correct", () => {
    expect(gradeWord("MATCH", false)).toBe("CORRECT");
    expect(gradeWord("MATCH", true)).toBe("ASSISTED");
    expect(gradeWord("DELETE", false)).toBe("SKIPPED");
    expect(gradeWord("DELETE", true)).toBe("ASSISTED");
    expect(gradeWord("SUBSTITUTE", true)).toBe("RETRY");
    expect(gradeWord(undefined, false)).toBe("NO_EVIDENCE");
    expect(needsPractice("CORRECT")).toBe(false);
    expect(needsPractice("NO_EVIDENCE")).toBe(false);
    for (const state of ["RETRY", "SKIPPED", "ASSISTED"] as const) {
      expect(needsPractice(state)).toBe(true);
    }
  });

  it("a word the app gave up on is never green even if it was later matched", () => {
    const words = pageWords("mèo chó");
    const e = engineFor("mèo chó");
    e.addFinalTranscript("mèo chó");
    const graded = gradeWords(
      e.getSnapshot(),
      words,
      new Set(),
      new Set(["w1"]),
    );
    expect(graded.get("w0")).toBe("CORRECT");
    expect(graded.get("w1")).toBe("SKIPPED");
  });
});

describe("ReadingEvidencePipeline", () => {
  const words = pageWords("Mẹ nấu cơm cho cả nhà ăn");
  const scope: CaptureScope = {
    sessionId: "s",
    pageId: "p1",
    revisionId: "r1",
    runId: 1,
  };

  it("grades echo of its own sample as assisted, never correct", () => {
    const p = new ReadingEvidencePipeline(words);
    p.ingestFinal({ text: "Mẹ nấu cơm", receivedAt: 1000 });
    p.playbackStarted("t1", "cho", 2000);
    p.playbackEnded("t1", 2600);
    expect(p.ingestFinal({ text: "cho", receivedAt: 2300 })).toMatchObject({
      kind: "rejected",
      reason: "playing",
    });
    expect(
      p.ingestFinal({ text: "cho", receivedAt: 3000, onsetAt: 2200 }),
    ).toMatchObject({
      kind: "rejected",
      reason: "onset-during-playback",
    });
    p.ingestFinal({ text: "cả nhà ăn", receivedAt: 6000, onsetAt: 5200 });
    p.finish();
    const graded = p.grade();
    expect(graded.get("w3")).toBe("ASSISTED");
    expect(graded.get("w2")).toBe("CORRECT");
    expect(graded.get("w6")).toBe("CORRECT");
  });

  it("drops duplicates, out-of-order and other-page results", () => {
    const p = new ReadingEvidencePipeline(words, { scope });
    expect(
      p.ingestFinal({
        text: "Mẹ nấu",
        receivedAt: 1,
        segmentId: "a",
        seq: 5,
        scope,
      }).kind,
    ).toBe("scored");
    expect(
      p.ingestFinal({
        text: "Mẹ nấu",
        receivedAt: 2,
        segmentId: "a",
        seq: 6,
        scope,
      }),
    ).toMatchObject({ reason: "duplicate-segment" });
    expect(
      p.ingestFinal({
        text: "cơm cho",
        receivedAt: 3,
        segmentId: "b",
        seq: 4,
        scope,
      }),
    ).toMatchObject({ reason: "out-of-order" });
    expect(
      p.ingestFinal({
        text: "cơm cho",
        receivedAt: 4,
        segmentId: "c",
        seq: 7,
        scope: { ...scope, pageId: "p2" },
      }),
    ).toMatchObject({ reason: "stale-scope" });
    expect(
      p.ingestFinal({
        text: "cơm cho",
        receivedAt: 5,
        segmentId: "d",
        seq: 8,
        scope: { ...scope, revisionId: "r2" },
      }),
    ).toMatchObject({ reason: "stale-scope" });
    expect(p.grade().get("w2")).toBe("NO_EVIDENCE");
  });

  it("refuses text that is implausibly fast for the detected speech (provider auto-fill)", () => {
    const p = new ReadingEvidencePipeline(words);
    const outcome = p.ingestFinal({
      text: "Mẹ nấu cơm cho cả nhà ăn",
      receivedAt: 1,
      speechDurationMs: 200,
    });
    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "implausible-speed",
    });
    expect(p.grade().get("w0")).toBe("NO_EVIDENCE");
  });

  it("refuses results the provider gates marked unusable", () => {
    const p = new ReadingEvidencePipeline(words);
    expect(
      p.ingestFinal({ text: "Mẹ nấu cơm", receivedAt: 1, usable: false }),
    ).toMatchObject({
      reason: "unusable",
    });
  });

  it("routes spoken commands to intents instead of scoring them", () => {
    const p = new ReadingEvidencePipeline(words);
    const outcome = p.ingestFinal({ text: "con không biết", receivedAt: 1 });
    expect(outcome).toEqual({ kind: "intent", intent: { type: "HELP" } });
    expect(p.snapshot().statusByWordId.size).toBe(0);
  });

  it("lets a book sentence win over a command phrase", () => {
    const text = pageWords("Con dừng lại ở cổng");
    const p = new ReadingEvidencePipeline(text);
    expect(
      p.ingestFinal({ text: "Con dừng lại ở cổng", receivedAt: 1 }).kind,
    ).toBe("scored");
  });

  it("resolves which book words a sample covers", () => {
    const p = new ReadingEvidencePipeline(words);
    p.ingestFinal({ text: "Mẹ nấu cơm", receivedAt: 1 });
    expect(p.resolveSampleWords("cho")).toEqual(["w3"]);
    expect(p.resolveSampleWords("cho cả nhà")).toEqual(["w3", "w4", "w5"]);
    expect(p.resolveSampleWords("Đến lượt con đọc nhé")).toEqual([]);
  });
});
