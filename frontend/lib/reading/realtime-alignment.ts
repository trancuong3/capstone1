import type { ReadingPageWordDTO } from "@/types/reading";
import {
  normalizeVietnameseWord,
  tokenizeVietnameseText,
} from "@/lib/reading/vietnamese-text";

export type RealtimeWordStatus = "MATCH" | "SUBSTITUTE" | "DELETE" | "REPEATED";

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
}

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
  return normalizeVietnameseWord(text);
}
/**
 * Tách transcript thành các từ.
 */
export function tokenizeRealtimeText(text: string): string[] {
  return tokenizeVietnameseText(text);
}

export class RealtimeAlignmentEngine {
  private readonly bookWords: IndexedBookWord[];

  private uncertain = false;
  private readonly finalSegmentIds = new Set<string>();
  private currentBookIndex = 0;
  private spokenWords: string[] = [];

  /**
   * Giữ lại một từ chưa khớp để chờ từ tiếp theo xác nhận.
   * Tránh một kết quả nhận dạng sai làm lệch toàn bộ các từ phía sau.
   */
  private pendingToken: { token: string; spokenIndex: number } | null = null;

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
  }

  hasUncertainty(): boolean {
    return this.uncertain;
  }

  addFinalTranscript(
    text: string,
    segmentId?: string,
  ): RealtimeAlignmentSnapshot {
    if (segmentId && this.finalSegmentIds.has(segmentId))
      return this.getSnapshot();
    if (segmentId) this.finalSegmentIds.add(segmentId);
    const tokens = tokenizeRealtimeText(text);

    for (const token of tokens) {
      this.processToken(token);
    }

    return this.getSnapshot();
  }

  previewAlignment(text: string): RealtimeAlignmentSnapshot {
    const tokens = tokenizeRealtimeText(text);

    // Lấy snapshot hiện tại nhưng không thay đổi trạng thái chính thức.
    const snapshot = this.getSnapshot();

    const statusByWordId = new Map(snapshot.statusByWordId);
    const repeatedWordIds = new Set(snapshot.repeatedWordIds);
    const previewMatchedWordIds = new Set<string>();

    let cursor = this.currentBookIndex;
    let targetIndex: number | null = null;

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

    for (const token of tokens) {
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

        targetIndex = cursor;
        cursor += 1;
        continue;
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

      // 3. Tìm từ ở phía trước.
      const matchedIndex = this.findAheadFrom(cursor, token);

      if (matchedIndex !== -1) {
        // Kiểm tra từ hiện tại đã được nhận diện là đọc sai trước đó chưa.
        const currentWord = this.bookWords[cursor];
        const previousStatus = statusByWordId.get(currentWord.wordId);

        if (previousStatus?.status !== "SUBSTITUTE") {
          // Chưa có bằng chứng đọc sai: đánh dấu từ bị bỏ qua.
          for (let index = cursor; index < matchedIndex; index += 1) {
            setPreviewStatus(index, "DELETE");
          }
        }

        setPreviewStatus(matchedIndex, "MATCH");

        targetIndex = matchedIndex;
        cursor = matchedIndex + 1;
        continue;
      }

      // 4. Từ không khớp: đánh dấu SUBSTITUTE tạm thời.
      setPreviewStatus(cursor, "SUBSTITUTE");

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

    const spokenIndex = this.spokenWords.length;
    this.spokenWords.push(token);

    // Đã đọc hết nội dung sách: chỉ còn có thể nhận diện từ lặp ở cuối.
    if (this.currentBookIndex >= this.bookWords.length) {
      this.tryMarkRepeatedWord(token, spokenIndex);
      return;
    }

    const currentWord = this.bookWords[this.currentBookIndex];

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
        // Nếu không, coi pending là nhiễu/interim sai và giữ nguyên con trỏ.
        if (!this.tryMarkRepeatedWord(pending.token, pending.spokenIndex)) {
          // Không có bằng chứng đủ mạnh để gán pending vào sách.
        }

        this.processConfirmedMatch(spokenIndex, this.currentBookIndex);
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

        this.setWordStatus(this.currentBookIndex, "SUBSTITUTE");
        this.spokenToBookIndex.set(pending.spokenIndex, this.currentBookIndex);
        this.currentBookIndex += 1;

        this.processTokenAtCurrentPosition(token, spokenIndex);
        return;
      }

      // Hai từ liên tiếp đều không khớp: xác nhận từ trước là đọc sai.
      this.setWordStatus(this.currentBookIndex, "SUBSTITUTE");
      this.spokenToBookIndex.set(pending.spokenIndex, this.currentBookIndex);
      this.currentBookIndex += 1;

      this.processTokenAtCurrentPosition(token, spokenIndex);
      return;
    }

    // Khớp chính xác: xác nhận ngay, không cần chờ thêm từ tiếp theo.
    if (token === currentWord.normalizedText) {
      this.processConfirmedMatch(spokenIndex, this.currentBookIndex);
      return;
    }

    // Từ xuất hiện ở phía trước: chỉ xác nhận bỏ sót khi đã có từ
    // tiếp theo làm bằng chứng, tránh kết luận DELETE quá sớm.
    const matchedIndex = this.findAhead(token);

    if (matchedIndex !== -1) {
      for (
        let index = this.currentBookIndex;
        index < matchedIndex;
        index += 1
      ) {
        this.setWordStatus(index, "DELETE");
      }

      this.setWordStatus(matchedIndex, "MATCH");
      this.spokenToBookIndex.set(spokenIndex, matchedIndex);
      this.currentBookIndex = matchedIndex + 1;
      return;
    }

    // Chưa đủ bằng chứng để kết luận SUBSTITUTE. Chờ thêm một từ.
    this.pendingToken = { token, spokenIndex };
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

    const matchedIndex = this.findAhead(token);

    if (matchedIndex !== -1) {
      for (
        let index = this.currentBookIndex;
        index < matchedIndex;
        index += 1
      ) {
        this.setWordStatus(index, "DELETE");
      }

      this.setWordStatus(matchedIndex, "MATCH");
      this.spokenToBookIndex.set(spokenIndex, matchedIndex);
      this.currentBookIndex = matchedIndex + 1;
      return;
    }

    this.pendingToken = { token, spokenIndex };
  }

  private processConfirmedMatch(spokenIndex: number, bookIndex: number): void {
    const bookWord = this.bookWords[bookIndex];
    if (!bookWord) return;

    this.setWordStatus(bookIndex, "MATCH");
    this.spokenToBookIndex.set(spokenIndex, bookIndex);
    this.currentBookIndex = bookIndex + 1;
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
   * Nếu từ vừa nói giống từ sách ngay trước con trỏ,
   * xem đó là một lần đọc lặp.
   */
  private tryMarkRepeatedWord(token: string, spokenIndex: number): boolean {
    const previousIndex = this.currentBookIndex - 1;

    if (previousIndex < 0) return false;

    const previousWord = this.bookWords[previousIndex];

    if (previousWord.normalizedText !== token) {
      return false;
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
    // Missing/low-confidence audio is not evidence of a child omission or substitution.
    if (this.uncertain && (status === "DELETE" || status === "SUBSTITUTE"))
      return;

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
   * Gọi khi kết thúc đọc một trang.
   * Những từ còn lại phía sau con trỏ được đánh dấu DELETE.
   */
  finish(): RealtimeAlignmentSnapshot {
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
    };
  }
}
