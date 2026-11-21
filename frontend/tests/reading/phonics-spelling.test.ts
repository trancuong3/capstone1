import { describe, expect, it } from "vitest";
import {
  decomposeVietnameseSyllable,
  isPhonicsInProgress,
  matchPhonicsSpelling,
} from "@/lib/reading/phonics-spelling";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import type { ReadingPageWordDTO } from "@/types/reading";

function wordsOf(sentence: string): ReadingPageWordDTO[] {
  return sentence.split(/\s+/u).map((text, index) => ({
    word_id: `w-${index}`,
    word_index: index,
    text,
    bbox: [0.1 * index, 0.2, 0.08, 0.05] as const,
  }));
}

describe("Vietnamese Grade-1 phonics spelling-out (G19)", () => {
  describe("syllable decomposition across all 6 tones & onsets", () => {
    it.each([
      ["tôi", "t", "ôi", "tôi", "ngang"],
      ["cá", "c", "a", "ca", "sac"],
      ["mèo", "m", "eo", "meo", "huyen"],
      ["nhỏ", "nh", "o", "nho", "hoi"],
      ["ngã", "ng", "a", "nga", "nga"],
      ["mẹ", "m", "e", "me", "nang"],
      ["đang", "đ", "ang", "đang", "ngang"],
      ["ăn", "", "ăn", "ăn", "ngang"],
      ["nghiêng", "ngh", "iêng", "nghiêng", "ngang"],
      ["quả", "qu", "a", "qua", "hoi"],
      ["gió", "gi", "o", "gio", "sac"],
      ["nước", "n", "ươc", "nươc", "sac"],
    ] as const)(
      "decomposes '%s' into onset='%s', rhyme='%s', tone='%s'",
      (word, onset, rhyme, untoned, tone) => {
        expect(decomposeVietnameseSyllable(word)).toEqual({
          normalized: word,
          onset,
          rhyme,
          untonedSyllable: untoned,
          tone,
        });
      },
    );
  });

  describe("accepted Grade-1 spelling patterns (6 tones, common onsets & rhymes)", () => {
    it.each([
      ["tôi (full rhyme+onset)", "tôi", "ô i ôi tờ ôi tôi"],
      ["tôi (short onset+rhyme)", "tôi", "tờ ôi tôi"],
      ["tôi (letter by letter)", "tôi", "tờ ô i tôi"],
      ["cá (sắc tone)", "cá", "cờ a ca sắc cá"],
      ["cá (with dấu)", "cá", "cờ a ca dấu sắc cá"],
      ["mèo (huyền tone full)", "mèo", "e o eo mờ eo meo huyền mèo"],
      ["mèo (huyền shortened STT)", "mèo", "mờ e me huyền mèo"],
      ["nhỏ (hỏi tone)", "nhỏ", "nhờ o nho hỏi nhỏ"],
      ["ngã (ngã tone)", "ngã", "ngờ a nga ngã ngã"],
      ["mẹ (nặng tone)", "mẹ", "mờ e me nặng mẹ"],
      ["đang (coda ng)", "đang", "a ngờ ang đờ ang đang"],
      ["ăn (vowel initial)", "ăn", "ă nờ ăn"],
      ["cơm (coda m)", "cơm", "ơ mờ ơm cờ ơm cơm"],
      ["học (checked nặng)", "học", "o cờ óc hờ óc hóc nặng học"],
      ["nước (checked sắc)", "nước", "ư ơ cờ ước nờ ước nước sắc nước"],
      ["quả (qu onset)", "quả", "quờ a qua hỏi quả"],
      [
        "trường (tr + iê/ươ)",
        "trường",
        "ư ơ ngờ ương trờ ương trương huyền trường",
      ],
      ["chơi (ch + ơi)", "chơi", "ơ i ơi chờ ơi chơi"],
      ["khỏe (kh + oe)", "khỏe", "o e oe khờ oe khoe hỏi khỏe"],
      ["sách (s + ach)", "sách", "a chờ ách sờ ách sách sắc sách"],
    ] as const)("accepts %s: '%s' <- '%s'", (_label, target, spoken) => {
      const tokens = spoken.split(/\s+/u);
      const match = matchPhonicsSpelling(tokens, target);
      expect(match).not.toBeNull();
      expect(match?.consumedCount).toBe(tokens.length);
    });
  });

  describe("false-positive rejection (wrong tone, wrong target, TV chatter)", () => {
    it.each([
      ["wrong tone ending (tồi != tôi)", "tôi", "ô i ôi tờ ôi tồi"],
      ["wrong tone word (huyền for sắc)", "cá", "cờ a ca huyền cá"],
      ["spelling a different word (cá for mèo)", "mèo", "cờ a ca sắc cá"],
      [
        "unrelated TV chatter ending in target",
        "tôi",
        "hôm nay trời mưa rồi tôi",
      ],
      ["misread word before target", "tôi", "chó tôi"],
      ["wrong onset cue", "tôi", "mờ ôi tôi"],
      ["direct exact word is handled normally, not phonics", "tôi", "tôi"],
    ] as const)("rejects %s", (_label, target, spoken) => {
      const tokens = spoken.split(/\s+/u);
      expect(matchPhonicsSpelling(tokens, target)).toBeNull();
    });
  });

  describe("RealtimeAlignmentEngine integration (multi-chunk pauses, full sentence, preview)", () => {
    it("accepts 'ô i ôi tờ ôi tôi ăn cơm' in one utterance without penalising cues", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Tôi ăn cơm."));
      const snap = engine.addFinalTranscript("ô i ôi tờ ôi tôi ăn cơm");

      expect(snap.statusByWordId.get("w-0")?.status).toBe("MATCH");
      expect(snap.statusByWordId.get("w-1")?.status).toBe("MATCH");
      expect(snap.statusByWordId.get("w-2")?.status).toBe("MATCH");
      expect(snap.spelledOutWordIds?.has("w-0")).toBe(true);
      expect(snap.spelledOutWordIds?.has("w-1")).toBe(false);
      expect(snap.currentWordId).toBeNull();
      expect(snap.rejectedSegmentCount).toBe(0);
    });

    it("holds cursor calmly across slow paused spelling chunks ('ô i ôi' ... 'tờ ôi tôi')", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Tôi ăn cơm."));

      const mid = engine.addFinalTranscript("ô i ôi");
      expect(mid.spellingInProgress).toBe(true);
      expect(mid.currentWordId).toBe("w-0");
      expect(mid.statusByWordId.size).toBe(0);
      expect(mid.rejectedSegmentCount).toBe(0);

      const done = engine.addFinalTranscript("tờ ôi tôi");
      expect(done.spellingInProgress).toBe(false);
      expect(done.statusByWordId.get("w-0")?.status).toBe("MATCH");
      expect(done.spelledOutWordIds?.has("w-0")).toBe(true);
      expect(done.currentWordId).toBe("w-1");
    });

    it("recognises spelling-in-progress during streaming interim preview without marking error", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Tôi ăn cơm."));
      expect(isPhonicsInProgress(["ô", "i", "ôi"], "tôi")).toBe(true);
      expect(isPhonicsInProgress(["hôm", "nay"], "tôi")).toBe(false);

      const midPreview = engine.previewAlignment("ô i ôi");
      expect(midPreview.spellingInProgress).toBe(true);
      expect(midPreview.currentWordId).toBe("w-0");
      expect(midPreview.statusByWordId.size).toBe(0);

      const blendedPreview = engine.previewAlignment("ô i ôi tờ ôi tôi");
      expect(blendedPreview.spellingInProgress).toBe(false);
      expect(blendedPreview.previewMatchedWordIds.has("w-0")).toBe(true);
      expect(blendedPreview.currentWordId).toBe("w-1");
    });

    it("still flags a wrong word if child starts spelling then finishes with wrong syllable", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Tôi ăn cơm."));
      engine.addFinalTranscript("ô i ôi");
      const snap = engine.addFinalTranscript("tồi ăn cơm");
      expect(snap.spellingInProgress).toBe(false);
      expect(snap.statusByWordId.get("w-0")?.status).toBe("SUBSTITUTE");
      expect(snap.statusByWordId.get("w-1")?.status).toBe("MATCH");
      expect(snap.statusByWordId.get("w-2")?.status).toBe("MATCH");
    });

    it("never accepts off-topic TV chatter even when it contains a single vowel cue", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Tôi ăn cơm."));
      const snap = engine.addFinalTranscript("hôm nay trời ô tô đi học");
      expect(snap.rejectedSegmentCount).toBe(1);
      expect(snap.statusByWordId.size).toBe(0);
      expect(snap.currentWordId).toBe("w-0");
    });
  });
});
