import { describe, expect, it } from "vitest";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import type { ReadingPageWordDTO } from "@/types/reading";

function engine(text: string) {
  const words: ReadingPageWordDTO[] = text
    .split(" ")
    .map((text, word_index) => ({
      text,
      word_index,
      word_id: `word-${word_index}`,
      bbox: [0, 0, 1, 1],
    }));
  return new RealtimeAlignmentEngine(words);
}
function statuses(e: RealtimeAlignmentEngine) {
  return [...e.getSnapshot().statusByWordId.values()].map((w) => [
    w.wordId,
    w.status,
  ]);
}

describe("sequential capture alignment", () => {
  it("keeps a confirmed match when the same word is repeated", () => {
    const e = engine("Bé mèo đọc");
    e.addFinalTranscript("Bé mèo mèo đọc");
    const result = e.finish();
    expect(result.statusByWordId.get("word-1")?.status).toBe("MATCH");
    expect([...result.repeatedWordIds]).toEqual(["word-1"]);
    expect(result.repeatedItems).toHaveLength(1);
    expect(result.spokenWords).toEqual(["bé", "mèo", "mèo", "đọc"]);
  });
  it("does not replace a confirmed first error when the target is repeated later", () => {
    const e = engine("mèo");
    e.addFinalTranscript("chó");
    expect(e.finish().statusByWordId.get("word-0")?.status).toBe("SUBSTITUTE");
    e.addFinalTranscript("mèo");
    const result = e.finish();
    expect(result.statusByWordId.get("word-0")?.status).toBe("SUBSTITUTE");
    expect([...result.repeatedWordIds]).toEqual(["word-0"]);
    expect(result.repeatedItems).toHaveLength(1);
  });
  it("does not finalize interim previews or segment boundaries", () => {
    const e = engine("Ba đi học");
    e.previewAlignment("Ba đi họ");
    expect(statuses(e)).toEqual([]);
    e.addFinalTranscript("Ba", "capture-1:0");
    expect(statuses(e)).toEqual([["word-0", "MATCH"]]);
    e.addFinalTranscript("đi", "capture-1:1");
    e.addFinalTranscript("học", "capture-2:0");
    expect(e.finish().statusByWordId.get("word-2")?.status).toBe("MATCH");
  });
  it("ignores duplicate segment identity without removing genuine repetition", () => {
    const e = engine("Ba ba đi học");
    e.addFinalTranscript("Ba", "capture:0");
    e.addFinalTranscript("Ba", "capture:0");
    e.addFinalTranscript("ba", "capture:1");
    expect(e.getSnapshot().spokenWords).toEqual(["ba", "ba"]);
    expect(statuses(e)).toEqual([
      ["word-0", "MATCH"],
      ["word-1", "MATCH"],
    ]);
  });
  it("flushes a missing final word only on explicit completion", () => {
    const e = engine("Ba đi học");
    e.addFinalTranscript("Ba đi");
    expect(e.getSnapshot().statusByWordId.has("word-2")).toBe(false);
    expect(e.finish().statusByWordId.get("word-2")?.status).toBe("DELETE");
  });
  it("preserves confirmed words but does not infer omissions across uncertain audio", () => {
    const e = engine("Ba đi học");
    e.addFinalTranscript("Ba");
    e.markUncertain();
    e.addFinalTranscript("học");
    e.finish();
    expect(statuses(e)).toEqual([
      ["word-0", "MATCH"],
      ["word-2", "MATCH"],
    ]);
    e.reset();
    expect(e.hasUncertainty()).toBe(false);
  });
  it.each([
    ["má", "ma"],
    ["đi", "di"],
    ["học", "họp"],
  ])("does not erase the distinction %s/%s", (expected, actual) => {
    const e = engine(expected);
    e.addFinalTranscript(actual);
    expect(e.finish().statusByWordId.get("word-0")?.status).toBe("SUBSTITUTE");
  });
});
