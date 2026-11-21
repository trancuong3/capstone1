import { describe, expect, it } from "vitest";
import {
  decomposeVietnameseSyllable,
  generateSpokenPhonicsGuide,
  isLikelyPhonicsCueForWord,
  isPhonicsInProgress,
  matchPhonicsSpelling,
} from "@/lib/reading/phonics-spelling";
import {
  hasUsableBrowserConfidence,
  hasUsablePhonicsBrowserConfidence,
  isConfidentPhonicsBrowserRead,
} from "@/lib/reading/recognition-evidence";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import {
  classifyPracticePhraseTranscript,
  classifyRetryTranscript,
} from "@/lib/reading/retry-word-recognition";
import { SentenceReinforcementTracker } from "@/lib/reading/sentence-reinforcement";
import type { ReadingPageWordDTO } from "@/types/reading";

function wordsOf(sentence: string): ReadingPageWordDTO[] {
  return sentence.split(/\s+/u).map((text, index) => ({
    word_id: `w-${index}`,
    word_index: index,
    text,
    bbox: [0.1 * index, 0.2, 0.08, 0.05] as const,
  }));
}

describe("Vietnamese Grade-1 phonics spelling-out & ASR tolerance (G19, G25, G26, G28)", () => {
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

  describe("accepted Grade-1 spelling patterns (vowel-first, onset-first, hesitant & ASR variants)", () => {
    it.each([
      // Classic vowel-first Grade-1 textbook patterns (SGK GDPT 2018)
      ["tê (vowel-first SGK)", "tê", "ê tờ ê tê"],
      ["cá (vowel-first SGK)", "cá", "a cờ a ca sắc cá"],
      ["nhỏ (vowel-first SGK)", "nhỏ", "o nhờ o nho hỏi nhỏ"],
      ["bơ (vowel-first SGK)", "bơ", "ơ bờ ơ bơ"],
      ["tôi (full rhyme+onset)", "tôi", "ô i ôi tờ ôi tôi"],
      ["cơm (vowel-first coda m)", "cơm", "ơ mờ ơm cờ ơm cơm"],
      ["đang (vowel-first coda ng)", "đang", "a ngờ ang đờ ang đang"],
      ["nước (checked sắc)", "nước", "ư ơ cờ ước nờ ước nước sắc nước"],
      ["học (checked nặng)", "học", "o cờ óc hờ óc hóc nặng học"],
      ["mèo (huyền tone full)", "mèo", "e o eo mờ eo meo huyền mèo"],
      [
        "trường (tr + ương)",
        "trường",
        "ư ơ ngờ ương trờ ương trương huyền trường",
      ],
      ["chơi (ch + ơi)", "chơi", "ơ i ơi chờ ơi chơi"],
      ["khỏe (kh + oe)", "khỏe", "o e oe khờ oe khoe hỏi khỏe"],
      ["sách (s + ach)", "sách", "a chờ ách sờ ách sách sắc sách"],

      // Onset-first patterns
      ["tê (onset-first)", "tê", "tờ ê tê"],
      ["tôi (short onset+rhyme)", "tôi", "tờ ôi tôi"],
      ["tôi (letter by letter)", "tôi", "tờ ô i tôi"],
      ["cá (sắc tone)", "cá", "cờ a ca sắc cá"],
      ["cá (with dấu)", "cá", "cờ a ca dấu sắc cá"],
      ["mèo (huyền shortened STT)", "mèo", "mờ e me huyền mèo"],
      ["nhỏ (hỏi tone)", "nhỏ", "nhờ o nho hỏi nhỏ"],
      ["ngã (ngã tone)", "ngã", "ngờ a nga ngã ngã"],
      ["mẹ (nặng tone)", "mẹ", "mờ e me nặng mẹ"],
      ["già (gi onset)", "già", "gi a gia huyền già"],
      ["quả (qu onset)", "quả", "quờ a qua hỏi quả"],
      ["ăn (vowel initial)", "ăn", "ă nờ ăn"],

      // Hesitant / repeated / self-fixing mid-spelling patterns
      ["tê (repeated vowel & cue)", "tê", "ê ê tờ ê tê"],
      ["tôi (repeated onset)", "tôi", "tờ tờ ôi tôi"],
      ["cá (hesitation filler 'à')", "cá", "cờ a ca à sắc cá"],
      ["mẹ (hesitation filler 'ờ dấu')", "mẹ", "mờ e me ờ dấu nặng mẹ"],

      // Real-world ASR phonetic drift on pre-target cues (G25)
      ["tê (STT dropped huyền: tơ)", "tê", "ê tơ ê tê"],
      ["tê (STT added sắc on vowel: ế)", "tê", "ế tờ ê tê"],
      ["tê (STT heavy drift: ế tợ ề tê)", "tê", "ế tợ ề tê"],
      ["tê (STT breathy vowel: hê tơ ê tê)", "tê", "hê tơ ê tê"],
      ["cá (STT á cơ a ca sắt cá)", "cá", "á cơ a ca sắt cá"],
      ["tôi (STT hô i ôi tơ ôi tôi)", "tôi", "hô i ôi tơ ôi tôi"],
      ["đang (STT a ngơ ang đơ ang đang)", "đang", "a ngơ ang đơ ang đang"],
      ["mẹ (STT mơ e me nặn mẹ)", "mẹ", "mơ e me nặn mẹ"],
      ["mèo (STT mơ eo meo hiền mèo)", "mèo", "mơ eo meo hiền mèo"],
      ["ngã (STT ngơ a nga ngả ngã)", "ngã", "ngơ a nga ngả ngã"],
      ["quả (STT cu a qua hỏi quả)", "quả", "cu a qua hỏi quả"],
      ["kẻ (STT ca e ke hỏi kẻ)", "kẻ", "ca e ke hỏi kẻ"],
    ] as const)("accepts %s: '%s' <- '%s'", (_label, target, spoken) => {
      const tokens = spoken.split(/\s+/u);
      const match = matchPhonicsSpelling(tokens, target);
      expect(match).not.toBeNull();
      expect(match?.consumedCount).toBe(tokens.length);
    });
  });

  describe("strict false-positive rejection (wrong final tone, standalone wrong tone, off-topic)", () => {
    it.each([
      ["wrong final tone on tê (tề != tê)", "tê", "ê tờ ê tề"],
      ["wrong final tone on tê (tế != tê)", "tê", "ê tờ ê tế"],
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
      ["repeated exact words in book ('tê tê tê')", "tê", "tê tê tê"],
    ] as const)("rejects %s", (_label, target, spoken) => {
      const tokens = spoken.split(/\s+/u);
      expect(matchPhonicsSpelling(tokens, target)).toBeNull();
    });

    it("never treats single-word tone mistakes ('ma' for 'má', 'từ' for 'tư', 'ờ' for 'ở') as phonics-in-progress", () => {
      expect(isPhonicsInProgress(["ma"], "má")).toBe(false);
      expect(isPhonicsInProgress(["mà"], "má")).toBe(false);
      expect(isPhonicsInProgress(["từ"], "tư")).toBe(false);
      expect(isPhonicsInProgress(["ờ"], "ở")).toBe(false);
    });
  });

  describe("RealtimeAlignmentEngine SpellingBuffer across 3-6 split isFinal events (G26)", () => {
    it("accepts 'ê' -> 'tờ' -> 'ê' -> 'tê' across 4 separate isFinal events with zero intermediate red SUBSTITUTE", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Tê ăn cơm."));

      const s1 = engine.addFinalTranscript("ê");
      expect(s1.spellingInProgress).toBe(true);
      expect(s1.statusByWordId.size).toBe(0);
      expect(engine.getTrailingMismatch()).toBeNull();

      const s2 = engine.addFinalTranscript("tờ");
      expect(s2.spellingInProgress).toBe(true);
      expect(s2.statusByWordId.size).toBe(0);
      expect(engine.getTrailingMismatch()).toBeNull();

      const s3 = engine.addFinalTranscript("ê");
      expect(s3.spellingInProgress).toBe(true);
      expect(s3.statusByWordId.size).toBe(0);

      const s4 = engine.addFinalTranscript("tê");
      expect(s4.spellingInProgress).toBe(false);
      expect(s4.statusByWordId.get("w-0")?.status).toBe("MATCH");
      expect(s4.spelledOutWordIds?.has("w-0")).toBe(true);
      expect(s4.currentWordId).toBe("w-1");
    });

    it("accepts split chunks with real STT phonetic drift ('ế' -> 'tơ' -> 'ê' -> 'tê ăn cơm')", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Tê ăn cơm."));
      engine.addFinalTranscript("ế");
      engine.addFinalTranscript("tơ");
      engine.addFinalTranscript("ê");
      const snap = engine.addFinalTranscript("tê ăn cơm");

      expect(snap.statusByWordId.get("w-0")?.status).toBe("MATCH");
      expect(snap.statusByWordId.get("w-1")?.status).toBe("MATCH");
      expect(snap.statusByWordId.get("w-2")?.status).toBe("MATCH");
      expect(snap.spelledOutWordIds?.has("w-0")).toBe(true);
      expect(snap.rejectedSegmentCount).toBe(0);
    });

    it("accepts 6 split isFinal chunks for vowel-first toned word ('a' -> 'cờ' -> 'a' -> 'ca' -> 'sắc' -> 'cá')", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Cá bơi."));
      for (const cue of ["a", "cờ", "a", "ca", "sắc"]) {
        const mid = engine.addFinalTranscript(cue);
        expect(mid.spellingInProgress).toBe(true);
        expect(mid.statusByWordId.size).toBe(0);
      }
      const done = engine.addFinalTranscript("cá bơi");
      expect(done.statusByWordId.get("w-0")?.status).toBe("MATCH");
      expect(done.statusByWordId.get("w-1")?.status).toBe("MATCH");
    });

    it("rejects split chunks ending in wrong tone ('ê' -> 'tờ' -> 'ê' -> 'tề ăn')", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Tê ăn."));
      engine.addFinalTranscript("ê");
      engine.addFinalTranscript("tờ");
      engine.addFinalTranscript("ê");
      const snap = engine.addFinalTranscript("tề ăn");

      expect(snap.statusByWordId.get("w-0")?.status).toBe("SUBSTITUTE");
      expect(snap.statusByWordId.get("w-1")?.status).toBe("MATCH");
    });

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

    it("recognises spelling-in-progress during streaming interim preview (including after final buffer)", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Tê ăn cơm."));
      engine.addFinalTranscript("ê");
      engine.addFinalTranscript("tờ");

      const midPreview = engine.previewAlignment("ê");
      expect(midPreview.spellingInProgress).toBe(true);
      expect(midPreview.currentWordId).toBe("w-0");

      const donePreview = engine.previewAlignment("ê tê");
      expect(donePreview.spellingInProgress).toBe(false);
      expect(donePreview.previewMatchedWordIds.has("w-0")).toBe(true);
      expect(donePreview.currentWordId).toBe("w-1");
    });

    it("never accepts off-topic TV chatter even when it contains a single vowel cue", () => {
      const engine = new RealtimeAlignmentEngine(wordsOf("Tôi ăn cơm."));
      const snap = engine.addFinalTranscript("hôm nay trời ô tô đi học");
      expect(snap.rejectedSegmentCount).toBe(1);
      expect(snap.statusByWordId.size).toBe(0);
      expect(snap.currentWordId).toBe("w-0");
    });
  });

  describe("Controlled confidence relaxation, Retry mode & Sentence reinforcement sync (G26)", () => {
    it("relaxes browser confidence (>= 0.28) strictly for genuine phonics cues while keeping >= 0.50 for normal speech", () => {
      expect(hasUsableBrowserConfidence(0.35)).toBe(false);
      expect(hasUsablePhonicsBrowserConfidence(0.35)).toBe(true);
      expect(hasUsablePhonicsBrowserConfidence(0.18)).toBe(false);

      expect(isLikelyPhonicsCueForWord("ê", "tê")).toBe(true);
      expect(isLikelyPhonicsCueForWord("tơ", "tê", ["ê"])).toBe(true);
      expect(isLikelyPhonicsCueForWord("ghế", "tê")).toBe(false);

      expect(isConfidentPhonicsBrowserRead("tê", "ê tờ ê tê", 0.34)).toBe(true);
      expect(isConfidentPhonicsBrowserRead("tê", "ê tờ ê tề", 0.95)).toBe(
        false,
      );
    });

    it("accepts Grade-1 phonics spelling in retry-word mode and practice-phrase mode", () => {
      expect(classifyRetryTranscript("tê", "ê tờ ê tê")).toBe("CORRECT");
      expect(classifyRetryTranscript("tê", "ê tơ ê tê")).toBe("CORRECT");
      expect(classifyRetryTranscript("tôi", "ô i ôi tờ ôi tôi")).toBe(
        "CORRECT",
      );
      expect(classifyRetryTranscript("cá", "a cờ a ca sắc cá")).toBe("CORRECT");
      expect(
        classifyRetryTranscript(
          "trường",
          "ư ơ ngờ ương trờ ương trương huyền trường",
        ),
      ).toBe("CORRECT");
      // Rejects wrong final tone in retry mode
      expect(classifyRetryTranscript("tê", "ê tờ ê tề")).toBe("INCORRECT");
      // Rejects teacher phonics prompt bleed
      expect(
        classifyRetryTranscript(
          "tê",
          "Mình đánh vần chậm cùng cô nhé tờ ê tê đọc trơn là tê",
        ),
      ).toBe("UNCERTAIN");

      expect(
        classifyPracticePhraseTranscript("tôi ăn", "ô i ôi tờ ôi tôi ăn"),
      ).toBe("CORRECT");
    });

    it("accepts multi-chunk phonics spelling inside SentenceReinforcementTracker", () => {
      const pageWords = wordsOf("Tê ăn cơm.");
      const tracker = new SentenceReinforcementTracker();
      tracker.beginForWord(pageWords, "w-0", "fixed");

      expect(tracker.consumeSpeech("ê")).toBe("in-progress");
      expect(tracker.consumeSpeech("tờ")).toBe("in-progress");
      expect(tracker.consumeSpeech("ê")).toBe("in-progress");
      expect(tracker.consumeSpeech("tê ăn cơm")).toBe("completed");
    });
  });

  describe("Pedagogical spoken phonics guide generator (G28)", () => {
    it("generates step-by-step SGK Grade-1 spelling guidance for simple, toned, compound & vowel-initial words", () => {
      expect(generateSpokenPhonicsGuide("tê")).toContain("tờ... ê... tê!");
      expect(generateSpokenPhonicsGuide("tê")).toContain("Đọc trơn là: tê.");

      expect(generateSpokenPhonicsGuide("cá")).toContain(
        "cờ... a... ca... sắc... cá!",
      );
      expect(generateSpokenPhonicsGuide("tôi")).toContain(
        "ô... i... ôi, tờ... ôi... tôi!",
      );
      expect(generateSpokenPhonicsGuide("nước")).toContain(
        "ư... ơ... cờ... ước, nờ... ước... nước... sắc... nước!",
      );
      expect(generateSpokenPhonicsGuide("ăn")).toContain("ă... nờ... ăn!");
      expect(generateSpokenPhonicsGuide("ở")).toContain("ơ... hỏi... ở!");
    });
  });
});
