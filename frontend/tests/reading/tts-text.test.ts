import { describe, expect, it } from "vitest";
import {
  hasMatchingSpeechWords,
  speechWordAtCharacter,
  splitSpeechText,
} from "@/lib/reading/tts-text";

describe("full-page speech text", () => {
  it.each([800, 801, 1600])(
    "keeps all %s words in order under both request limits",
    (count) => {
      const text = Array.from(
        { length: count },
        (_, index) => `w${index}`,
      ).join(" ");
      const chunks = splitSpeechText(text);
      expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
      expect(chunks.flatMap((chunk) => chunk.words)).toEqual(text.split(" "));
      expect(
        chunks.every(
          (chunk) => chunk.words.length <= 800 && chunk.text.length <= 5000,
        ),
      ).toBe(true);
      expect(chunks.map((chunk) => chunk.wordOffset)).toEqual(
        count <= 800 ? [0] : [0, 800],
      );
    },
  );
  it("prefers sentence and paragraph breaks without deleting punctuation", () => {
    const text = "  Bé đi học.\n\nMẹ đọc sách!  Bé đọc theo.\n";
    const chunks = splitSpeechText(text, 26);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks[0].text).toBe("  Bé đi học.\n\n");
    expect(chunks.flatMap((chunk) => chunk.words)).toEqual([
      "Bé",
      "đi",
      "học.",
      "Mẹ",
      "đọc",
      "sách!",
      "Bé",
      "đọc",
      "theo.",
    ]);
  });
  it("also respects character limits when 800 tokens would be too long", () => {
    const text = Array(300).fill("nghiêng-nghiêng").join(" ");
    const chunks = splitSpeechText(text, 2500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.text.length <= 2500)).toBe(true);
  });
  it("maps punctuation and equivalent Unicode but rejects missing, reordered or different accented words", () => {
    expect(hasMatchingSpeechWords("“Bé” đi học.", ["Bé", "đi", "học"])).toBe(
      true,
    );
    expect(hasMatchingSpeechWords("Bé".normalize("NFD"), ["Bé"])).toBe(true);
    for (const words of [
      ["Bé", "học", "đi"],
      ["Bé", "đi"],
      ["Be", "đi", "học"],
    ]) {
      expect(hasMatchingSpeechWords("Bé đi học.", words)).toBe(false);
    }
  });
  it("maps UTF-16 browser boundary positions without using time estimates", () => {
    const text = "🐱 Bé đọc mãi.";
    expect(speechWordAtCharacter(text, text.indexOf("Bé"))).toBe(1);
    expect(speechWordAtCharacter(text, text.indexOf("mãi"))).toBe(3);
    expect(speechWordAtCharacter(text, -1)).toBe(-1);
    expect(speechWordAtCharacter(text, text.length)).toBe(-1);
  });
});
