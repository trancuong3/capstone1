import { describe, expect, it } from "vitest";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import { splitSpeechText } from "@/lib/reading/tts-text";
import type { ReadingPageWordDTO } from "@/types/reading";

const vocabulary = ["Bé", "đi", "học", "và", "chăm", "đọc", "sách"];
const sizes = [1, 20, 50, 200, 800, 801, 1600];

function content(size: number, identity: string) {
  const words: ReadingPageWordDTO[] = Array.from(
    { length: size },
    (_, index) => ({
      word_id: `${identity}:${index}`,
      word_index: index,
      text: vocabulary[index % vocabulary.length],
      bbox: [0, 0, 1, 1],
    }),
  );
  return { words, text: words.map((word) => word.text).join(" ") };
}

describe("Phase 7 reading content scale and independent sessions", () => {
  it.each(sizes)(
    "retains all %i words through alignment and timed TTS chunk boundaries",
    (size) => {
      const { words, text } = content(size, `size-${size}`);
      const chunks = splitSpeechText(text);
      expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
      expect(chunks.flatMap((chunk) => chunk.words)).toEqual(
        words.map((word) => word.text),
      );
      const engine = new RealtimeAlignmentEngine(words);
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk.words.length).toBeLessThanOrEqual(800);
        expect(chunk.text.length).toBeLessThanOrEqual(5000);
        engine.addFinalTranscript(chunk.text, `segment-${index}`);
        engine.addFinalTranscript(chunk.text, `segment-${index}`);
      }
      const snapshot = engine.finish();
      expect(snapshot.spokenWords).toHaveLength(size);
      expect(snapshot.statusByWordId.size).toBe(size);
      expect(
        [...snapshot.statusByWordId.values()].map((word) => [
          word.wordId,
          word.status,
        ]),
      ).toEqual(words.map((word) => [word.word_id, "MATCH"]));
      expect([...snapshot.repeatedWordIds]).toEqual([]);
    },
  );

  it.each([1, 5, 10, 20])(
    "isolates %i interleaved engine instances with identical Vietnamese text",
    (count) => {
      const sessions = Array.from({ length: count }, (_, index) => {
        const { words } = content(200, `session-${index}`);
        return { words, engine: new RealtimeAlignmentEngine(words) };
      });
      const started = performance.now();
      for (let offset = 0; offset < 200; offset += 20) {
        for (const session of sessions) {
          session.engine.addFinalTranscript(
            session.words
              .slice(offset, offset + 20)
              .map((word) => word.text)
              .join(" "),
            `same-capture-id:${offset}`,
          );
        }
      }
      for (const session of sessions) {
        const result = session.engine.finish();
        expect([...result.statusByWordId.keys()]).toEqual(
          session.words.map((word) => word.word_id),
        );
        expect(
          [...result.statusByWordId.values()].every(
            (word) => word.status === "MATCH",
          ),
        ).toBe(true);
        session.engine.reset();
        const reset = session.engine.getSnapshot();
        expect(reset.statusByWordId.size).toBe(0);
        expect(reset.spokenWords).toEqual([]);
        expect(reset.repeatedItems).toEqual([]);
        expect(reset.hesitations).toEqual([]);
      }
      console.info(
        JSON.stringify({
          scope: "in-process-interleaved-engines",
          instances: count,
          wordsPerInstance: 200,
          elapsedMs: performance.now() - started,
        }),
      );
    },
  );
});
