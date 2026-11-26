import type { ReadingPageWordDTO } from "@/types/reading";
import type { WordTimestamp } from "@/lib/api/speech-service";
import {
  isLikelyPhonicsCueToken,
  isPhonicsCueForWindow,
  isPhonicsInProgress,
  matchPhonicsSpelling,
} from "@/lib/reading/phonics-spelling";
import {
  normalizeVietnameseWord,
  tokenizeVietnameseText,
} from "@/lib/reading/vietnamese-text";

export type RealtimeWordStatus = "MATCH" | "SUBSTITUTE" | "DELETE" | "REPEATED";

const FILLER_WORDS = new Set(["ờ", "ừm", "ầm", "hừm", "ưm", "ơ", "à"]);

export interface RealtimeWordState {
  wordId: string;
  wordIndex: number;
  text: string;
  status: RealtimeWordStatus;
}

export interface RealtimeRepeatedItem {
  word: string;
  spokenIndex: number;
  bookIndex: number;
  wordId: string;
}

export interface RealtimeHesitation {
  afterSpokenIndex: number;
  beforeSpokenIndex: number;
  pause: number;
  beforeWordId: string | null;
}

export interface RealtimeWordMismatch {
  readonly wordId: string;
  readonly wordIndex: number;
  readonly expectedText: string;
  readonly spokenToken: string;
  readonly seq: number;
}

export interface RealtimeAlignmentSnapshot {
  currentWordId: string | null;
  currentWordIndex: number;
  statusByWordId: Map<string, RealtimeWordState>;
  repeatedWordIds: Set<string>;
  hesitationWordIds: Set<string>;
  repeatedItems: RealtimeRepeatedItem[];
  hesitations: RealtimeHesitation[];
  spokenWords: string[];
  previewMatchedWordIds: Set<string>;
  /** Words first read wrongly/skipped, then fixed by the child in the same capture. */
  correctedWordIds?: Set<string>;
  /** Words where the child uttered a brief slip and immediately self-corrected. */
  selfCorrectedSlipWordIds?: Set<string>;
  /** Words matched after Grade-1 phonics spelling-out (e.g. "ô i ôi tờ ôi tôi"). */
  spelledOutWordIds?: Set<string>;
  /** True while the child is mid-way through spelling out the current word. */
  spellingInProgress?: boolean;
  /** Final segments ignored because they did not follow the book (TV, other speakers). */
  rejectedSegmentCount?: number;
}

export interface RealtimeSpokenWord {
  text: string;
  start: number;
  end: number;
}

interface IndexedBookWord {
  wordId: string;
  wordIndex: number;
  text: string;
  normalizedText: string;
  syllables: readonly string[];
}

/** How far behind the cursor a re-read may start (restart / self-correction). */
const REWIND_WINDOW = 16;
/** How far ahead two consecutive spoken words may re-anchor (line jump). */
const REANCHOR_WINDOW = 30;

/**
 * Chuẩn hóa từ để so sánh.
 * Ví dụ: "ĐI," và "đi" được xem là cùng một từ.
 */
/**
 * Chuẩn hóa từ tiếng Việt để so sánh.
 *
 * - Giữ nguyên dấu thanh.
 * - Giữ nguyên chữ đ.
 * - Chỉ loại bỏ dấu câu và ký tự không thuộc từ ở hai đầu.
 * - Chuẩn hóa Unicode NFC để tránh khác biệt giữa các cách mã hóa.
 *
 * Ví dụ:
 * "ĐI," và "đi" => "đi"
 * "má" và "ma" => khác nhau
 * "da" và "đa" => khác nhau
 */
export function normalizeRealtimeWord(text: string): string {
  return canonicalNumberToken(normalizeVietnameseWord(text));
}

const NUMBER_WORDS = [
  "không",
  "một",
  "hai",
  "ba",
  "bốn",
  "năm",
  "sáu",
  "bảy",
  "tám",
  "chín",
  "mười",
] as const;

/**
 * Sách in "2" còn bộ nhận dạng trả về "hai" (và ngược lại). Chỉ quy đổi các
 * số một tiếng 0–10 để cả hai phía so khớp cùng một dạng; số nhiều tiếng
 * (ví dụ 15 → "mười lăm") chưa được hỗ trợ.
 */
const HIGH_FREQ_VIETNAMESE_FUNCTION_WORDS = new Set([
  "con",
  "và",
  "là",
  "của",
  "một",
  "có",
  "em",
  "đi",
  "không",
  "ở",
  "cho",
  "với",
  "như",
  "đã",
  "đang",
  "sẽ",
  "cũng",
  "rất",
  "thì",
  "mà",
]);

function shouldDeferLookaheadMatch(
  token: string,
  currentBookIndex: number,
  matchedIndex: number,
  totalBookWords: number,
): boolean {
  if (matchedIndex >= totalBookWords - 1) return false;
  const skipCount = matchedIndex - currentBookIndex;
  return skipCount >= 2 || HIGH_FREQ_VIETNAMESE_FUNCTION_WORDS.has(token);
}

function canonicalNumberToken(token: string): string {
  if (!/^\d{1,2}$/u.test(token)) return token;
  const value = Number(token);
  return value <= 10 ? NUMBER_WORDS[value] : token;
}

/**
 * Tách transcript thành các từ.
 */
export function tokenizeRealtimeText(text: string): string[] {
  return tokenizeVietnameseText(text).map(canonicalNumberToken);
}

/** Timestamps must correspond one-to-one to the tokens actually scored. */
export function timingsForTranscript(
  text: string,
  words?: readonly WordTimestamp[] | null,
) {
  const timed =
    words?.filter((item) => !item.type || item.type === "word") ?? [];
  const tokens = tokenizeRealtimeText(text);
  if (!timed.length || timed.length !== tokens.length) return [];
  if (
    !timed.every(
      (item, index) =>
        normalizeRealtimeWord(item.text) === tokens[index] &&
        Number.isFinite(item.start) &&
        Number.isFinite(item.end) &&
        item.start >= 0 &&
        item.end >= item.start &&
        (index === 0 || item.start >= timed[index - 1].start),
    )
  )
    return [];
  return timed;
}

export class RealtimeAlignmentEngine {
  private readonly bookWords: IndexedBookWord[];

  private uncertain = false;
  /** Set by finish(): later re-reads can no longer overwrite a settled result. */
  private finished = false;
  /**
   * While the child re-reads words behind the cursor (restart / self-fix) the
   * next book index expected in that replay. Replayed words are not counted
   * twice and never move the cursor.
   */
  private replayPos: number | null = null;
  private readonly correctedWordIds = new Set<string>();
  private readonly selfCorrectedSlipWordIds = new Set<string>();
  private readonly spelledOutWordIds = new Set<string>();
  private spellingInProgress = false;
  /**
   * Cross-segment spelling buffer (G26): accumulates Grade-1 phonics cues
   * spoken across separate `isFinal` events ("ê" -> "tờ" -> "ê" -> "tê")
   * without pushing partial cues into `pendingToken`.
   */
  private spellingBuffer: {
    bookIndex: number;
    wordId: string;
    tokens: string[];
  } | null = null;
  private mismatchSeq = 0;
  private trailingMismatch: {
    bookIndex: number;
    wordId: string;
    wordIndex: number;
    expectedText: string;
    spokenToken: string;
    seq: number;
  } | null = null;
  private rejectedSegments = 0;
  private readonly finalSegmentIds = new Set<string>();
  private currentBookIndex = 0;
  private spokenWords: string[] = [];

  /**
   * Giữ lại một từ chưa khớp để chờ từ tiếp theo xác nhận.
   * Tránh một kết quả nhận dạng sai làm lệch toàn bộ các từ phía sau.
   */
  private pendingToken: {
    token: string;
    spokenIndex: number;
    seq: number;
  } | null = null;

  private readonly statusByWordId = new Map<string, RealtimeWordState>();

  private readonly repeatedWordIds = new Set<string>();
  private readonly hesitationWordIds = new Set<string>();

  private readonly repeatedItems: RealtimeRepeatedItem[] = [];
  private readonly hesitations: RealtimeHesitation[] = [];

  /**
   * spokenIndex -> bookIndex.
   * INSERT sẽ không có bookIndex.
   */
  private readonly spokenToBookIndex = new Map<number, number>();

  constructor(
    words: readonly ReadingPageWordDTO[],
    private readonly lookahead = 3,
    private readonly hesitationThreshold = 2,
  ) {
    this.bookWords = words.map((word, index) => ({
      wordId: word.word_id,
      wordIndex: word.word_index ?? index,
      text: word.text,
      normalizedText: normalizeRealtimeWord(word.text),
      syllables: tokenizeRealtimeText(word.text),
    }));
  }

  /**
   * Nhận một đoạn transcript MỚI đã được xác nhận (isFinal).
   *
   * Không truyền toàn bộ transcript tích lũy nhiều lần,
   * vì như vậy các từ cũ sẽ bị xử lý lặp lại.
   */
  markUncertain(): void {
    this.uncertain = true;
    this.pendingToken = null;
    this.spellingBuffer = null;
    this.spellingInProgress = false;
    this.trailingMismatch = null;
  }

  hasUncertainty(): boolean {
    return this.uncertain;
  }

  /** Active phonics cues accumulated for the current book word, if any. */
  getBufferedSpellingTokens(): readonly string[] {
    if (
      this.spellingBuffer &&
      this.spellingBuffer.bookIndex === this.currentBookIndex
    ) {
      return this.spellingBuffer.tokens;
    }
    return [];
  }

  addFinalTranscript(
    text: string,
    segmentId?: string,
  ): RealtimeAlignmentSnapshot {
    if (segmentId && this.finalSegmentIds.has(segmentId))
      return this.getSnapshot();
    if (segmentId) this.finalSegmentIds.add(segmentId);
    let tokens = tokenizeRealtimeText(text);
    if (tokens.length === 0) return this.getSnapshot();

    // Speech that does not follow the book (TV, another speaker) must neither
    // colour words nor penalise the child.
    if (this.isOffTopic(tokens)) {
      this.rejectedSegments += 1;
      return this.getSnapshot();
    }

    // Merge with cross-segment SpellingBuffer if active on the current word
    if (
      this.spellingBuffer &&
      this.spellingBuffer.bookIndex === this.currentBookIndex &&
      this.currentBookIndex < this.bookWords.length
    ) {
      const target = this.bookWords[this.currentBookIndex];
      const combined = [...this.spellingBuffer.tokens, ...tokens];
      const combinedPhonics = matchPhonicsSpelling(
        combined,
        target.normalizedText,
      );
      if (combinedPhonics) {
        this.spellingBuffer = null;
        this.pendingToken = null;
        this.replayPos = null;
        this.spellingInProgress = false;
        this.trailingMismatch = null;
        const spokenIndex = this.spokenWords.length;
        this.spokenWords.push(target.normalizedText);
        this.spokenToBookIndex.set(spokenIndex, this.currentBookIndex);
        this.spelledOutWordIds.add(target.wordId);
        this.setWordStatus(this.currentBookIndex, "MATCH");
        this.currentBookIndex += 1;
        tokens = combined.slice(combinedPhonics.consumedCount);
      } else if (isPhonicsInProgress(combined, target.normalizedText)) {
        this.spellingBuffer = {
          bookIndex: this.currentBookIndex,
          wordId: target.wordId,
          tokens: combined,
        };
        this.spellingInProgress = true;
        this.trailingMismatch = null;
        return this.getSnapshot();
      } else {
        this.spellingBuffer = null;
        this.spellingInProgress = false;
      }
    }

    let index = 0;
    while (index < tokens.length) {
      if (this.currentBookIndex < this.bookWords.length) {
        const target = this.bookWords[this.currentBookIndex];
        const remaining = tokens.slice(index);
        if (
          target.syllables.length > 1 &&
          remaining.length >= target.syllables.length &&
          target.syllables.every((syl, sIdx) => remaining[sIdx] === syl)
        ) {
          this.spellingBuffer = null;
          this.pendingToken = null;
          this.replayPos = null;
          this.spellingInProgress = false;
          this.trailingMismatch = null;
          const spokenIndex = this.spokenWords.length;
          this.spokenWords.push(target.normalizedText);
          this.spokenToBookIndex.set(spokenIndex, this.currentBookIndex);
          this.setWordStatus(this.currentBookIndex, "MATCH");
          this.currentBookIndex += 1;
          index += target.syllables.length;
          continue;
        }
        const phonics = matchPhonicsSpelling(remaining, target.normalizedText);
        if (phonics) {
          this.spellingBuffer = null;
          this.pendingToken = null;
          this.replayPos = null;
          this.spellingInProgress = false;
          this.trailingMismatch = null;
          const spokenIndex = this.spokenWords.length;
          this.spokenWords.push(target.normalizedText);
          this.spokenToBookIndex.set(spokenIndex, this.currentBookIndex);
          this.spelledOutWordIds.add(target.wordId);
          this.setWordStatus(this.currentBookIndex, "MATCH");
          this.currentBookIndex += 1;
          index += phonics.consumedCount;
          continue;
        }
        if (isPhonicsInProgress(remaining, target.normalizedText)) {
          // The child paused halfway through sounding out the current word
          // (e.g. "ê" -> "tờ" -> "ê" -> "tê" or "ô i ôi" -> "tờ ôi tôi").
          this.spellingBuffer = {
            bookIndex: this.currentBookIndex,
            wordId: target.wordId,
            tokens: [...remaining],
          };
          this.spellingInProgress = true;
          this.trailingMismatch = null;
          break;
        }
        // Multi-word Vietnamese phonics sequence guard (2-4 upcoming words):
        // Many Grade 1-2 children spell 2-4 words in a row (e.g. "môi trường tự nhiên")
        // before reading the whole phrase smoothly. Never turn intermediate spelling
        // cues into RED SUBSTITUTE / DELETE errors on subsequent words!
        const aheadConsumed = this.tryConsumeAheadPhonicsCluster(
          remaining,
          this.currentBookIndex,
        );
        if (aheadConsumed > 0) {
          this.pendingToken = null;
          this.spellingInProgress = true;
          this.trailingMismatch = null;
          index += aheadConsumed;
          continue;
        }
        if (
          this.isMultiWordPhonicsCueAt(tokens, index, this.currentBookIndex)
        ) {
          this.pendingToken = null;
          this.spellingInProgress = true;
          this.trailingMismatch = null;
          index += 1;
          continue;
        }
      }
      this.spellingBuffer = null;
      this.spellingInProgress = false;
      this.processToken(tokens[index]);
      index += 1;
    }

    return this.getSnapshot();
  }

  /**
   * Segments of three or more words are scored only when at least half of
   * their words follow the book from the current position (ahead, repeated,
   * re-read or re-anchored). One- and two-word segments cannot be judged.
   */
  /** True when a final segment would be ignored as not following the book. */
  isOffTopicText(text: string): boolean {
    return this.isOffTopic(tokenizeRealtimeText(text));
  }

  private isTokenNearCursor(token: string): boolean {
    const start = Math.max(0, this.currentBookIndex - 2);
    const end = Math.min(this.bookWords.length, this.currentBookIndex + 6);
    for (let i = start; i < end; i += 1) {
      if (this.bookWords[i].normalizedText === token) return true;
    }
    return false;
  }

  private isOffTopic(tokens: readonly string[]): boolean {
    const contentTokens = tokens.filter(
      (token) => !FILLER_WORDS.has(token) || this.isTokenNearCursor(token),
    );
    if (contentTokens.length < 3) return false;
    return this.alignedTokenCount(contentTokens) / contentTokens.length < 0.5;
  }

  private getPhonicsWindowTargets(cursor: number): string[] {
    const end = Math.min(this.bookWords.length, cursor + 4);
    const targets: string[] = [];
    for (let i = cursor; i < end; i += 1) {
      targets.push(this.bookWords[i].normalizedText);
    }
    return targets;
  }

  /**
   * Detects when a child spells an upcoming word (cursor+1 .. cursor+3) in a
   * 2-4 word cluster before coming back to read the full phrase smoothly.
   * Returns consumed cue+syllable count so we hold at `cursor` without painting
   * skipped words RED.
   */
  private tryConsumeAheadPhonicsCluster(
    remaining: readonly string[],
    cursor: number,
  ): number {
    if (remaining.length < 2) return 0;
    const maxAhead = Math.min(this.bookWords.length - 1, cursor + 3);
    for (let ahead = cursor + 1; ahead <= maxAhead; ahead += 1) {
      const aheadMatch = matchPhonicsSpelling(
        remaining,
        this.bookWords[ahead].normalizedText,
      );
      if (aheadMatch && aheadMatch.consumedCount >= 2) {
        return aheadMatch.consumedCount;
      }
    }
    return 0;
  }

  /**
   * Returns true when `tokens[index]` is an intermediate Vietnamese spelling cue
   * (e.g. "ô", "i", "mờ", "nặng", "ự", "iên", "huyền") within a multi-word
   * spelling sequence for the upcoming 4-word window.
   *
   * Strictly excludes normal book words in `[cursor - 2 .. cursor + 3]` so
   * repeated words ("ba ba") and normal misreads ("tồi" for "tôi") are NEVER
   * swallowed as spelling cues.
   */
  private isMultiWordPhonicsCueAt(
    tokens: readonly string[],
    index: number,
    cursor: number,
  ): boolean {
    const token = tokens[index];
    if (!token || cursor >= this.bookWords.length) return false;

    // Never swallow any actual book word around the cursor (preserves repeats & skips)
    const nearbyStart = Math.max(0, cursor - 2);
    const nearbyEnd = Math.min(this.bookWords.length, cursor + 4);
    for (let i = nearbyStart; i < nearbyEnd; i += 1) {
      if (this.bookWords[i].normalizedText === token) return false;
    }

    const windowTargets = this.getPhonicsWindowTargets(cursor);
    const tokenIsUniversalCue = isLikelyPhonicsCueToken(token);
    const tokenIsPureRhymeCue =
      !tokenIsUniversalCue &&
      /^[aeiouyàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/u.test(
        token,
      ) &&
      isPhonicsCueForWindow(token, windowTargets);

    if (!tokenIsUniversalCue && !tokenIsPureRhymeCue) return false;

    // Require either active spelling mode OR an adjacent unambiguous phonics cue token
    if (this.spellingInProgress) return true;

    const prev = index > 0 ? tokens[index - 1] : null;
    const next = index + 1 < tokens.length ? tokens[index + 1] : null;
    return Boolean(
      (prev && isLikelyPhonicsCueToken(prev)) ||
      (next && isLikelyPhonicsCueToken(next)),
    );
  }

  private alignedTokenCount(tokens: readonly string[]): number {
    let cursor = this.currentBookIndex;
    let matched = 0;
    const buffered =
      this.spellingBuffer?.bookIndex === this.currentBookIndex
        ? this.spellingBuffer.tokens
        : [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (cursor < this.bookWords.length) {
        const remaining = tokens.slice(index);
        if (index === 0 && buffered.length > 0) {
          const combined = [...buffered, ...remaining];
          const bufferedPhonics = matchPhonicsSpelling(
            combined,
            this.bookWords[cursor].normalizedText,
          );
          if (
            bufferedPhonics &&
            bufferedPhonics.consumedCount > buffered.length
          ) {
            const consumedFromNew =
              bufferedPhonics.consumedCount - buffered.length;
            matched += consumedFromNew;
            index += consumedFromNew - 1;
            cursor += 1;
            continue;
          }
          if (
            isPhonicsInProgress(combined, this.bookWords[cursor].normalizedText)
          ) {
            matched += remaining.length;
            break;
          }
        }
        if (
          this.bookWords[cursor].syllables.length > 1 &&
          remaining.length >= this.bookWords[cursor].syllables.length &&
          this.bookWords[cursor].syllables.every(
            (syl, sIdx) => remaining[sIdx] === syl,
          )
        ) {
          const consumed = this.bookWords[cursor].syllables.length;
          matched += consumed;
          index += consumed - 1;
          cursor += 1;
          continue;
        }
        if (this.bookWords[cursor].normalizedText === token) {
          matched += 1;
          cursor += 1;
          continue;
        }
        const phonics = matchPhonicsSpelling(
          remaining,
          this.bookWords[cursor].normalizedText,
        );
        if (phonics) {
          matched += phonics.consumedCount;
          index += phonics.consumedCount - 1;
          cursor += 1;
          continue;
        }
        if (
          isPhonicsInProgress(remaining, this.bookWords[cursor].normalizedText)
        ) {
          matched += remaining.length;
          break;
        }
        const aheadPhonicsCount = this.tryConsumeAheadPhonicsCluster(
          remaining,
          cursor,
        );
        if (aheadPhonicsCount > 0) {
          matched += aheadPhonicsCount;
          index += aheadPhonicsCount - 1;
          continue;
        }
        if (this.isMultiWordPhonicsCueAt(tokens, index, cursor)) {
          matched += 1;
          continue;
        }
      }
      if (cursor > 0 && this.bookWords[cursor - 1]?.normalizedText === token) {
        matched += 1;
        continue;
      }
      const ahead = this.findAheadFrom(cursor, token);
      if (ahead !== -1) {
        matched += 1;
        cursor = ahead + 1;
        continue;
      }
      if (this.findBehindFrom(cursor, token) !== -1) {
        matched += 1;
        continue;
      }
      if (index + 1 < tokens.length) {
        const anchor = this.findReanchor(cursor, token, tokens[index + 1]);
        if (anchor !== -1) {
          matched += 2;
          index += 1;
          cursor = anchor + 2;
        }
      }
    }
    return matched;
  }

  private findBehindFrom(cursor: number, token: string): number {
    const start = Math.max(0, cursor - REWIND_WINDOW);
    // Nearest first. cursor-1 is the "repeated word" case, handled elsewhere.
    for (
      let index = Math.min(cursor, this.bookWords.length) - 2;
      index >= start;
      index -= 1
    ) {
      if (this.bookWords[index].normalizedText === token) return index;
    }
    return -1;
  }

  /** Two consecutive spoken words found together further ahead (line jump). */
  private findReanchor(
    cursor: number,
    first: string,
    second: string,
    maxWindow = REANCHOR_WINDOW,
  ): number {
    const last = Math.min(cursor + maxWindow, this.bookWords.length - 2);
    for (let index = cursor + 1; index <= last; index += 1) {
      if (
        this.bookWords[index].normalizedText === first &&
        this.bookWords[index + 1].normalizedText === second
      ) {
        return index;
      }
    }
    return -1;
  }

  previewAlignment(text: string): RealtimeAlignmentSnapshot {
    const tokens = tokenizeRealtimeText(text);

    // Lấy snapshot hiện tại nhưng không thay đổi trạng thái chính thức.
    const snapshot = this.getSnapshot();

    // Interim speech that does not follow the book must not move the cursor.
    if (this.isOffTopic(tokens)) return snapshot;

    const statusByWordId = new Map(snapshot.statusByWordId);
    const repeatedWordIds = new Set(snapshot.repeatedWordIds);
    const previewMatchedWordIds = new Set<string>();

    let cursor = this.currentBookIndex;
    let targetIndex: number | null = null;
    let previewSpelling = this.spellingInProgress;

    const setPreviewStatus = (
      bookIndex: number,
      status: RealtimeWordStatus,
    ) => {
      const word = this.bookWords[bookIndex];

      if (!word) return;

      statusByWordId.set(word.wordId, {
        wordId: word.wordId,
        wordIndex: word.wordIndex,
        text: word.text,
        status,
      });

      if (status === "MATCH") {
        previewMatchedWordIds.add(word.wordId);
      }

      if (status === "REPEATED") {
        repeatedWordIds.add(word.wordId);
      }
    };

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      const token = tokens[tokenIndex];
      if (cursor >= this.bookWords.length) {
        const previousIndex = cursor - 1;

        if (
          previousIndex >= 0 &&
          this.bookWords[previousIndex].normalizedText === token
        ) {
          setPreviewStatus(previousIndex, "REPEATED");
          targetIndex = previousIndex;
        }

        continue;
      }

      const currentWord = this.bookWords[cursor];

      // 1. Khớp chính xác với từ hiện tại.
      if (currentWord.normalizedText === token) {
        setPreviewStatus(cursor, "MATCH");
        previewSpelling = false;

        cursor += 1;
        targetIndex =
          cursor < this.bookWords.length ? cursor : Math.max(0, cursor - 1);
        continue;
      }

      // 1b. Đánh vần lớp 1 (kể cả ghép tiếp từ SpellingBuffer đang dở).
      const remaining = tokens.slice(tokenIndex);
      const buffered =
        tokenIndex === 0 && this.spellingBuffer?.bookIndex === cursor
          ? this.spellingBuffer.tokens
          : [];
      if (buffered.length > 0) {
        const combined = [...buffered, ...remaining];
        const bufferedPhonics = matchPhonicsSpelling(
          combined,
          currentWord.normalizedText,
        );
        if (
          bufferedPhonics &&
          bufferedPhonics.consumedCount > buffered.length
        ) {
          setPreviewStatus(cursor, "MATCH");
          previewSpelling = false;
          cursor += 1;
          targetIndex =
            cursor < this.bookWords.length ? cursor : Math.max(0, cursor - 1);
          tokenIndex += bufferedPhonics.consumedCount - buffered.length - 1;
          continue;
        }
        if (isPhonicsInProgress(combined, currentWord.normalizedText)) {
          previewSpelling = true;
          targetIndex = cursor;
          break;
        }
      }
      if (
        currentWord.syllables.length > 1 &&
        remaining.length >= currentWord.syllables.length &&
        currentWord.syllables.every((syl, sIdx) => remaining[sIdx] === syl)
      ) {
        setPreviewStatus(cursor, "MATCH");
        previewSpelling = false;
        cursor += 1;
        targetIndex =
          cursor < this.bookWords.length ? cursor : Math.max(0, cursor - 1);
        tokenIndex += currentWord.syllables.length - 1;
        continue;
      }
      const phonics = matchPhonicsSpelling(
        remaining,
        currentWord.normalizedText,
      );
      if (phonics) {
        setPreviewStatus(cursor, "MATCH");
        previewSpelling = false;
        cursor += 1;
        targetIndex =
          cursor < this.bookWords.length ? cursor : Math.max(0, cursor - 1);
        tokenIndex += phonics.consumedCount - 1;
        continue;
      }
      if (isPhonicsInProgress(remaining, currentWord.normalizedText)) {
        previewSpelling = true;
        targetIndex = cursor;
        break;
      }

      // 2. Phát hiện đọc lặp từ ngay trước đó.
      const previousIndex = cursor - 1;

      if (
        previousIndex >= 0 &&
        this.bookWords[previousIndex].normalizedText === token
      ) {
        setPreviewStatus(previousIndex, "REPEATED");

        targetIndex = previousIndex;
        continue;
      }

      // 3. Tìm từ ở phía trước (tránh nhảy qua >=2 từ hoặc hư từ tần suất cao nếu thiếu từ kế tiếp xác nhận).
      const matchedIndex = this.findAheadFrom(cursor, token);

      if (matchedIndex !== -1) {
        const defer = shouldDeferLookaheadMatch(
          token,
          cursor,
          matchedIndex,
          this.bookWords.length,
        );
        const confirmedByNext =
          tokenIndex + 1 < tokens.length &&
          matchedIndex + 1 < this.bookWords.length &&
          tokens[tokenIndex + 1] ===
            this.bookWords[matchedIndex + 1].normalizedText;
        if (!defer || confirmedByNext) {
          for (let index = cursor; index < matchedIndex; index += 1) {
            const existing = statusByWordId.get(this.bookWords[index].wordId);
            if (existing?.status !== "SUBSTITUTE") {
              setPreviewStatus(index, "DELETE");
            }
          }

          setPreviewStatus(matchedIndex, "MATCH");
          previewSpelling = false;

          cursor = matchedIndex + 1;
          targetIndex = cursor < this.bookWords.length ? cursor : matchedIndex;
          continue;
        }
      }

      // 3b. Khôi phục con trỏ khi bé nhảy dòng / lệch 4–8 từ với bằng chứng 2 từ liên tiếp
      // (giới hạn cửa sổ ở interim để tránh nhảy cóc 18–30 từ cuối trang trước khi chốt final).
      if (tokenIndex + 1 < tokens.length) {
        const anchor = this.findReanchor(cursor, token, tokens[tokenIndex + 1], 8);
        if (anchor !== -1) {
          for (let index = cursor; index < anchor; index += 1) {
            const existing = statusByWordId.get(this.bookWords[index].wordId);
            if (existing?.status !== "SUBSTITUTE") {
              setPreviewStatus(index, "DELETE");
            }
          }
          setPreviewStatus(anchor, "MATCH");
          setPreviewStatus(anchor + 1, "MATCH");
          previewSpelling = false;

          cursor = anchor + 2;
          targetIndex = cursor < this.bookWords.length ? cursor : anchor + 1;
          tokenIndex += 1;
          continue;
        }
      }

      // 4. Từ không khớp ở cuối interim: có thể bé đang ghép vần hoặc sắp tự sửa
      // ("bàn... bạn") → chỉ đánh dấu SUBSTITUTE tạm khi còn từ kế tiếp xác nhận,
      // không vội nháy đỏ ở âm tiết cuối cùng của interim.
      if (tokenIndex < tokens.length - 1) {
        setPreviewStatus(cursor, "SUBSTITUTE");
      }
      previewSpelling = false;

      targetIndex = cursor;
    }

    const activeIndex = targetIndex ?? this.currentBookIndex;
    const targetWord = this.bookWords[activeIndex] ?? null;

    return {
      ...snapshot,
      currentWordId: targetWord?.wordId ?? null,
      currentWordIndex: targetWord?.wordIndex ?? -1,
      statusByWordId,
      repeatedWordIds,
      previewMatchedWordIds,
      spellingInProgress: previewSpelling,
    };
  }

  private findAheadFrom(cursor: number, token: string): number {
    const endIndex = Math.min(
      cursor + this.lookahead,
      this.bookWords.length - 1,
    );

    for (let index = cursor + 1; index <= endIndex; index += 1) {
      if (this.bookWords[index].normalizedText === token) {
        return index;
      }
    }

    return -1;
  }

  private processToken(token: string): void {
    if (!token) return;

    // Ignore pure breath/hesitation fillers ("ờ", "ừm", "ầm", "hừm") when they do NOT
    // appear in the nearby book words so post-pause inhales never mark the next word RED.
    if (
      (token === "ờ" || token === "ừm" || token === "ầm" || token === "hừm") &&
      this.currentBookIndex < this.bookWords.length
    ) {
      const start = Math.max(0, this.currentBookIndex - 1);
      const end = Math.min(this.bookWords.length, this.currentBookIndex + 4);
      let inBook = false;
      for (let i = start; i < end; i += 1) {
        if (this.bookWords[i].normalizedText === token) {
          inBook = true;
          break;
        }
      }
      if (!inBook) return;
    }

    const spokenIndex = this.spokenWords.length;
    this.spokenWords.push(token);

    // Đã đọc hết nội dung sách: chỉ còn có thể nhận diện từ lặp ở cuối.
    if (this.currentBookIndex >= this.bookWords.length) {
      this.tryMarkRepeatedWord(token, spokenIndex);
      return;
    }

    const currentWord = this.bookWords[this.currentBookIndex];

    // An unclear segment breaks the connection between speech and the cursor.
    // Wait for a reliable matching word before scoring further mistakes.
    if (this.uncertain) {
      const anchor =
        currentWord.normalizedText === token
          ? this.currentBookIndex
          : this.findAhead(token);
      if (anchor !== -1) {
        this.uncertain = false;
        this.processConfirmedMatch(spokenIndex, anchor);
      }
      return;
    }

    /*
     * Re-reading words behind the cursor (restart of the sentence or going
     * back to fix a word) is replayed without counting anything twice.
     */
    if (this.replayPos !== null) {
      const replayIndex = this.replayPos;
      if (
        replayIndex < this.currentBookIndex &&
        this.bookWords[replayIndex].normalizedText === token
      ) {
        this.applyReplayMatch(replayIndex);
        return;
      }
      this.replayPos = null;
    }

    /*
     * Nếu đang có một từ chưa khớp:
     * - Từ mới khớp vị trí hiện tại: bỏ từ pending (có thể là nhiễu
     *   hoặc lỗi nhận dạng), không làm lệch con trỏ.
     * - Từ mới khớp phía trước: xác nhận pending là SUBSTITUTE,
     *   sau đó xử lý từ mới theo vị trí mới.
     * - Vẫn không khớp: xác nhận pending là SUBSTITUTE rồi xử lý tiếp.
     */
    if (this.pendingToken) {
      const pending = this.pendingToken;
      this.pendingToken = null;

      if (token === currentWord.normalizedText) {
        // Nếu pending lặp lại từ ngay trước con trỏ, xác nhận lần đọc lặp.
        // Nếu không, bé vừa tự sửa ngay một tiếng đọc nhỡ ở từ hiện tại.
        if (!this.tryMarkRepeatedWord(pending.token, pending.spokenIndex)) {
          this.selfCorrectedSlipWordIds.add(currentWord.wordId);
        }

        this.processConfirmedMatch(spokenIndex, this.currentBookIndex);
        return;
      }

      // Two consecutive words that fit together ahead (deferred multi-word/function-word
      // lookahead or line jump): confirm the skip with 2-token evidence.
      const anchor = this.findReanchor(
        this.currentBookIndex,
        pending.token,
        token,
      );
      if (anchor !== -1) {
        this.jumpTo(anchor, pending.spokenIndex, spokenIndex);
        return;
      }

      const nextMatchedIndex = this.findAhead(token);

      if (nextMatchedIndex !== -1) {
        // Ví dụ sách: "tôi thích cậu cậu làm".
        // Nếu bé đọc thừa "cậu" sau từ "cậu" đầu tiên, token pending
        // phải được tính là lặp, không phải SUBSTITUTE cho từ kế tiếp.
        if (this.tryMarkRepeatedWord(pending.token, pending.spokenIndex)) {
          this.processTokenAtCurrentPosition(token, spokenIndex);
          return;
        }

        this.recordSubstitute(
          this.currentBookIndex,
          pending.token,
          pending.spokenIndex,
        );
        this.currentBookIndex += 1;

        this.processTokenAtCurrentPosition(token, spokenIndex);
        return;
      }

      // The child went back to a word behind the cursor: the pending word was
      // a self-corrected slip, not a confirmed error.
      if (this.tryStartReplay(token)) return;

      // Hai từ liên tiếp đều không khớp: xác nhận từ trước là đọc sai.
      this.recordSubstitute(
        this.currentBookIndex,
        pending.token,
        pending.spokenIndex,
      );
      this.currentBookIndex += 1;

      this.processTokenAtCurrentPosition(token, spokenIndex);
      return;
    }

    // Khớp chính xác: xác nhận ngay, không cần chờ thêm từ tiếp theo.
    if (token === currentWord.normalizedText) {
      this.processConfirmedMatch(spokenIndex, this.currentBookIndex);
      return;
    }

    if (this.tryMarkRepeatedWord(token, spokenIndex)) return;

    if (this.tryStartReplay(token)) return;

    // Từ xuất hiện ở phía trước: yêu cầu bằng chứng 2 từ trước khi đánh DELETE nhiều từ
    // hoặc khi từ khớp là hư từ tiếng Việt tần suất cao ("và", "con", "là", "của", ...).
    const matchedIndex = this.findAhead(token);

    if (
      matchedIndex !== -1 &&
      !shouldDeferLookaheadMatch(
        token,
        this.currentBookIndex,
        matchedIndex,
        this.bookWords.length,
      )
    ) {
      for (
        let index = this.currentBookIndex;
        index < matchedIndex;
        index += 1
      ) {
        this.setWordStatus(index, "DELETE");
      }

      this.setWordStatus(matchedIndex, "MATCH");
      this.trailingMismatch = null;
      this.spokenToBookIndex.set(spokenIndex, matchedIndex);
      this.currentBookIndex = matchedIndex + 1;
      return;
    }

    // Chưa đủ bằng chứng để kết luận SUBSTITUTE hoặc multi-word DELETE. Chờ thêm một từ.
    this.mismatchSeq += 1;
    this.pendingToken = { token, spokenIndex, seq: this.mismatchSeq };
  }

  private processTokenAtCurrentPosition(
    token: string,
    spokenIndex: number,
  ): void {
    if (this.currentBookIndex >= this.bookWords.length) {
      this.tryMarkRepeatedWord(token, spokenIndex);
      return;
    }

    const currentWord = this.bookWords[this.currentBookIndex];

    if (token === currentWord.normalizedText) {
      this.processConfirmedMatch(spokenIndex, this.currentBookIndex);
      return;
    }

    // Nếu từ vừa nói trùng với từ ngay trước con trỏ, ưu tiên nhận diện
    // là lặp trước khi tìm từ ở phía trước. Điều này tránh bỏ nhầm từ hiện tại.
    if (this.tryMarkRepeatedWord(token, spokenIndex)) {
      return;
    }

    if (this.tryStartReplay(token)) return;

    const matchedIndex = this.findAhead(token);

    if (
      matchedIndex !== -1 &&
      !shouldDeferLookaheadMatch(
        token,
        this.currentBookIndex,
        matchedIndex,
        this.bookWords.length,
      )
    ) {
      for (
        let index = this.currentBookIndex;
        index < matchedIndex;
        index += 1
      ) {
        this.setWordStatus(index, "DELETE");
      }

      this.setWordStatus(matchedIndex, "MATCH");
      this.trailingMismatch = null;
      this.spokenToBookIndex.set(spokenIndex, matchedIndex);
      this.currentBookIndex = matchedIndex + 1;
      return;
    }

    this.mismatchSeq += 1;
    this.pendingToken = { token, spokenIndex, seq: this.mismatchSeq };
  }

  private recordSubstitute(
    bookIndex: number,
    spokenToken: string,
    spokenIndex: number,
  ): void {
    const word = this.bookWords[bookIndex];
    this.setWordStatus(bookIndex, "SUBSTITUTE");
    this.spokenToBookIndex.set(spokenIndex, bookIndex);
    if (word && !this.trailingMismatch) {
      this.mismatchSeq += 1;
      this.trailingMismatch = {
        bookIndex,
        wordId: word.wordId,
        wordIndex: word.wordIndex,
        expectedText: word.text,
        spokenToken,
        seq: this.mismatchSeq,
      };
    }
  }

  /**
   * The child re-reads a word behind the cursor that is not also a plausible
   * skip-ahead. Wrong/skipped words they fix are upgraded; nothing is counted
   * twice and the cursor stays where it was.
   */
  private tryStartReplay(token: string): boolean {
    if (this.finished) return false;
    if (this.findAhead(token) !== -1) return false;
    const behind = this.findBehindFrom(this.currentBookIndex, token);
    if (behind === -1) return false;
    this.pendingToken = null;
    this.trailingMismatch = null;
    this.applyReplayMatch(behind);
    return true;
  }

  private applyReplayMatch(bookIndex: number): void {
    const word = this.bookWords[bookIndex];
    if (!word) return;
    const status = this.statusByWordId.get(word.wordId)?.status;
    if (!this.finished && (status === "SUBSTITUTE" || status === "DELETE")) {
      this.setWordStatus(bookIndex, "MATCH");
      this.correctedWordIds.add(word.wordId);
    }
    this.replayPos =
      bookIndex + 1 < this.currentBookIndex ? bookIndex + 1 : null;
  }

  private jumpTo(anchor: number, firstSpoken: number, secondSpoken: number) {
    for (let index = this.currentBookIndex; index < anchor; index += 1) {
      this.setWordStatus(index, "DELETE");
    }
    this.setWordStatus(anchor, "MATCH");
    this.setWordStatus(anchor + 1, "MATCH");
    this.trailingMismatch = null;
    this.spokenToBookIndex.set(firstSpoken, anchor);
    this.spokenToBookIndex.set(secondSpoken, anchor + 1);
    this.currentBookIndex = anchor + 2;
  }

  private processConfirmedMatch(spokenIndex: number, bookIndex: number): void {
    const bookWord = this.bookWords[bookIndex];
    if (!bookWord) return;

    this.trailingMismatch = null;
    this.setWordStatus(bookIndex, "MATCH");
    this.spokenToBookIndex.set(spokenIndex, bookIndex);
    this.currentBookIndex = bookIndex + 1;
  }

  /**
   * Non-mutating inspection of an unresolved wrong-word attempt at the reading
   * frontier (G27). Returns `null` when the child is spelling out (`SpellingBuffer`),
   * when no mistake occurred, or when the child already read further and
   * matched subsequent words on the page.
   */
  getTrailingMismatch(): RealtimeWordMismatch | null {
    if (this.spellingInProgress || this.uncertain || this.finished) {
      return null;
    }
    if (this.trailingMismatch) {
      return {
        wordId: this.trailingMismatch.wordId,
        wordIndex: this.trailingMismatch.wordIndex,
        expectedText: this.trailingMismatch.expectedText,
        spokenToken: this.trailingMismatch.spokenToken,
        seq: this.trailingMismatch.seq,
      };
    }
    if (this.pendingToken && this.currentBookIndex < this.bookWords.length) {
      const prev = this.bookWords[this.currentBookIndex - 1];
      if (prev && prev.normalizedText === this.pendingToken.token) {
        return null;
      }
      const current = this.bookWords[this.currentBookIndex];
      return {
        wordId: current.wordId,
        wordIndex: current.wordIndex,
        expectedText: current.text,
        spokenToken: this.pendingToken.token,
        seq: this.pendingToken.seq,
      };
    }
    return null;
  }

  /**
   * Called after the short self-correction grace window (~1.4s) expires while
   * the child paused on a wrong word (G27). Marks the misread word `SUBSTITUTE`
   * (preserving first-pass mispronunciation evidence) and holds the cursor on
   * that word so the teacher can comfort & coach that exact word.
   */
  holdAtTrailingMismatchForCoaching(): {
    snapshot: RealtimeAlignmentSnapshot;
    mismatch: RealtimeWordMismatch;
  } | null {
    const mismatch = this.getTrailingMismatch();
    if (!mismatch) return null;

    if (this.trailingMismatch) {
      const targetBookIndex = this.trailingMismatch.bookIndex;
      this.pendingToken = null;
      this.spellingBuffer = null;
      this.spellingInProgress = false;
      this.trailingMismatch = null;
      this.currentBookIndex = targetBookIndex;
      return { snapshot: this.getSnapshot(), mismatch };
    }

    if (this.pendingToken && this.currentBookIndex < this.bookWords.length) {
      const pending = this.pendingToken;
      this.pendingToken = null;
      this.spellingBuffer = null;
      this.spellingInProgress = false;
      this.trailingMismatch = null;
      this.setWordStatus(this.currentBookIndex, "SUBSTITUTE");
      this.spokenToBookIndex.set(pending.spokenIndex, this.currentBookIndex);
      return { snapshot: this.getSnapshot(), mismatch };
    }

    return null;
  }

  /**
   * Xác nhận từ cuối cùng đang chờ khi người đọc dừng/kết thúc trang.
   * Gọi trước khi đánh dấu các từ còn lại là DELETE.
   */
  private flushPendingToken(): void {
    if (!this.pendingToken) return;

    const pending = this.pendingToken;
    this.pendingToken = null;

    if (this.currentBookIndex >= this.bookWords.length) {
      this.tryMarkRepeatedWord(pending.token, pending.spokenIndex);
      return;
    }

    if (this.tryMarkRepeatedWord(pending.token, pending.spokenIndex)) {
      return;
    }

    const ahead = this.findAhead(pending.token);
    if (
      ahead !== -1 &&
      !shouldDeferLookaheadMatch(
        pending.token,
        this.currentBookIndex,
        ahead,
        this.bookWords.length,
      )
    ) {
      for (let index = this.currentBookIndex; index < ahead; index += 1) {
        this.setWordStatus(index, "DELETE");
      }
      this.setWordStatus(ahead, "MATCH");
      this.spokenToBookIndex.set(pending.spokenIndex, ahead);
      this.currentBookIndex = ahead + 1;
      return;
    }

    this.setWordStatus(this.currentBookIndex, "SUBSTITUTE");
    this.spokenToBookIndex.set(pending.spokenIndex, this.currentBookIndex);
    this.currentBookIndex += 1;
  }

  private findAhead(token: string): number {
    const endIndex = Math.min(
      this.currentBookIndex + this.lookahead,
      this.bookWords.length - 1,
    );

    for (let index = this.currentBookIndex + 1; index <= endIndex; index += 1) {
      if (this.bookWords[index].normalizedText === token) {
        return index;
      }
    }

    return -1;
  }

  /**
   * Nếu từ vừa nói giống từ sách ngay trước con trỏ:
   * - Nếu từ đó đang bị đánh dấu SUBSTITUTE hoặc DELETE và trang chưa kết thúc,
   *   nâng cấp thành MATCH (bé tự sửa ngay từ vừa đọc sai ở cursor-1).
   * - Ngược lại, ghi nhận là lần đọc lặp.
   */
  private tryMarkRepeatedWord(token: string, spokenIndex: number): boolean {
    const previousIndex = this.currentBookIndex - 1;

    if (previousIndex < 0) return false;

    const previousWord = this.bookWords[previousIndex];

    if (previousWord.normalizedText !== token) {
      return false;
    }

    const existingStatus = this.statusByWordId.get(previousWord.wordId)?.status;
    if (
      !this.finished &&
      (existingStatus === "SUBSTITUTE" || existingStatus === "DELETE")
    ) {
      this.setWordStatus(previousIndex, "MATCH");
      this.correctedWordIds.add(previousWord.wordId);
      this.trailingMismatch = null;
      this.spokenToBookIndex.set(spokenIndex, previousIndex);
      return true;
    }

    this.repeatedWordIds.add(previousWord.wordId);
    // Repetition is additional fluency evidence. Keep the confirmed first
    // reading status instead of replacing a match/error with a presentation state.

    this.repeatedItems.push({
      word: token,
      spokenIndex,
      bookIndex: previousWord.wordIndex,
      wordId: previousWord.wordId,
    });

    return true;
  }

  private setWordStatus(
    bookArrayIndex: number,
    status: RealtimeWordStatus,
  ): void {
    const word = this.bookWords[bookArrayIndex];

    if (!word) return;
    this.statusByWordId.set(word.wordId, {
      wordId: word.wordId,
      wordIndex: word.wordIndex,
      text: word.text,
      status,
    });
  }

  /**
   * Gọi khi có word timestamps để phát hiện ngập ngừng.
   * Timestamp phải thuộc cùng một đoạn transcript đã xử lý,
   * theo đúng thứ tự từ được nói.
   */

  addHesitations(
    words: RealtimeSpokenWord[],
    spokenIndexOffset = 0,
  ): RealtimeAlignmentSnapshot {
    const sortedWords = [...words].sort((a, b) => a.start - b.start);

    for (let index = 1; index < sortedWords.length; index += 1) {
      const previous = sortedWords[index - 1];
      const current = sortedWords[index];

      const pause = current.start - previous.end;

      if (pause < this.hesitationThreshold) continue;

      const beforeSpokenIndex = spokenIndexOffset + index;
      const bookIndex = this.spokenToBookIndex.get(beforeSpokenIndex);

      const beforeWordId =
        bookIndex !== undefined
          ? (this.bookWords[bookIndex]?.wordId ?? null)
          : null;

      if (beforeWordId) {
        this.hesitationWordIds.add(beforeWordId);
      }

      this.hesitations.push({
        afterSpokenIndex: beforeSpokenIndex - 1,
        beforeSpokenIndex,
        pause: Number(pause.toFixed(2)),
        beforeWordId,
      });
    }

    return this.getSnapshot();
  }

  /**
   * The app gave up on a word after the allowed attempts (and encouraged the
   * child): it counts as skipped — never green — and the cursor moves past it.
   */
  giveUpWord(wordId: string): RealtimeAlignmentSnapshot {
    const index = this.bookWords.findIndex((word) => word.wordId === wordId);
    if (index === -1) return this.getSnapshot();
    this.pendingToken = null;
    this.replayPos = null;
    this.spellingBuffer = null;
    this.spellingInProgress = false;
    this.trailingMismatch = null;
    const from = index >= this.currentBookIndex ? this.currentBookIndex : index;
    for (let at = from; at <= index; at += 1) this.setWordStatus(at, "DELETE");
    this.currentBookIndex = Math.max(this.currentBookIndex, index + 1);
    return this.getSnapshot();
  }

  /**
   * Gọi khi kết thúc đọc một trang.
   * Những từ còn lại phía sau con trỏ được đánh dấu DELETE.
   */
  finish(): RealtimeAlignmentSnapshot {
    this.finished = true;
    this.replayPos = null;
    this.spellingBuffer = null;
    this.spellingInProgress = false;
    this.trailingMismatch = null;
    if (this.uncertain) return this.getSnapshot();
    this.flushPendingToken();

    while (this.currentBookIndex < this.bookWords.length) {
      this.setWordStatus(this.currentBookIndex, "DELETE");
      this.currentBookIndex += 1;
    }

    return this.getSnapshot();
  }

  /**
   * Reset khi bắt đầu một phiên đọc mới hoặc đọc lại trang.
   */
  reset(): RealtimeAlignmentSnapshot {
    this.currentBookIndex = 0;
    this.uncertain = false;
    this.finished = false;
    this.replayPos = null;
    this.correctedWordIds.clear();
    this.selfCorrectedSlipWordIds.clear();
    this.spelledOutWordIds.clear();
    this.spellingInProgress = false;
    this.spellingBuffer = null;
    this.trailingMismatch = null;
    this.rejectedSegments = 0;
    this.finalSegmentIds.clear();
    this.spokenWords = [];
    this.pendingToken = null;

    this.statusByWordId.clear();
    this.repeatedWordIds.clear();
    this.hesitationWordIds.clear();

    this.repeatedItems.length = 0;
    this.hesitations.length = 0;
    this.spokenToBookIndex.clear();

    return this.getSnapshot();
  }

  getSnapshot(): RealtimeAlignmentSnapshot {
    const currentWord = this.bookWords[this.currentBookIndex] ?? null;

    return {
      currentWordId: currentWord?.wordId ?? null,
      currentWordIndex: currentWord?.wordIndex ?? -1,
      statusByWordId: new Map(this.statusByWordId),
      repeatedWordIds: new Set(this.repeatedWordIds),
      hesitationWordIds: new Set(this.hesitationWordIds),
      repeatedItems: [...this.repeatedItems],
      hesitations: [...this.hesitations],
      spokenWords: [...this.spokenWords],
      previewMatchedWordIds: new Set(),
      correctedWordIds: new Set(this.correctedWordIds),
      selfCorrectedSlipWordIds: new Set(this.selfCorrectedSlipWordIds),
      spelledOutWordIds: new Set(this.spelledOutWordIds),
      spellingInProgress: this.spellingInProgress,
      rejectedSegmentCount: this.rejectedSegments,
    };
  }
}
