/**
 * Warm, child-friendly Vietnamese voice prompt bank with anti-repetition
 * rotation and frequency limiting so ViRead sounds encouraging without ever
 * chattering or interrupting the child's reading rhythm (G23).
 */

export type PromptCategory =
  | "wordHelpIntro"
  | "wordSlowIntro"
  | "phraseHelpIntro"
  | "encourageMoveOn"
  | "spelledOutPraise"
  | "sentenceReinforceAfterSuccess"
  | "sentenceReinforceAfterHelp"
  | "sentenceReinforceDone"
  | "pageFluentPraise"
  | "quizAskChoice"
  | "quizCorrect"
  | "quizTryAgain"
  | "quizRemind";

export const INTERACTIVE_PROMPT_BANKS: Readonly<
  Record<PromptCategory, readonly string[]>
> = {
  wordHelpIntro: [
    "Cô đọc mẫu cho con nhé.",
    "Con nghe cô đọc từ này nhé.",
    "Mình cùng nghe từ này nào.",
  ],
  wordSlowIntro: [
    "Mình đọc chậm và rõ hơn một chút nhé.",
    "Con nghe cô đọc thật chậm từ này nhé.",
    "Nào, mình đọc chậm lại từng tiếng nhé.",
  ],
  phraseHelpIntro: [
    "Mình ghép vào cả cụm cho dễ đọc nhé.",
    "Con nghe cô đọc cả cụm này nhé.",
    "Đọc liền cả cụm sẽ dễ hơn đó con.",
  ],
  encourageMoveOn: [
    "Con đã cố gắng rất tốt rồi. Mình đọc tiếp nhé!",
    "Không sao đâu, từ này mình sẽ luyện thêm sau. Đọc tiếp nào con!",
    "Con làm tốt lắm rồi. Mình bước sang từ tiếp theo nhé!",
  ],
  spelledOutPraise: [
    "Con đánh vần giỏi quá!",
    "Tuyệt vời, con ghép tiếng đúng rồi!",
    "Hay lắm, con tự đánh vần được rồi đó!",
  ],
  sentenceReinforceAfterSuccess: [
    "Giỏi lắm! Giờ con đọc lại cả câu “{sentence}” nhé.",
    "Đúng rồi! Mình đọc nối lại cả câu “{sentence}” cho mượt nào.",
    "Tuyệt vời! Con thử đọc trơn lại cả câu “{sentence}” nhé.",
  ],
  sentenceReinforceAfterHelp: [
    "Không sao đâu, con cố gắng lắm rồi. Mình cùng đọc lại cả câu “{sentence}” nhé.",
    "Mình vừa nghe từ đó rồi. Giờ con đọc lại cả câu “{sentence}” nào.",
    "Con làm tốt lắm. Nào, mình nối lại cả câu “{sentence}” cho quen nhé.",
  ],
  sentenceReinforceDone: [
    "Hay quá, con đọc cả câu rất mượt! Mình đọc tiếp nhé.",
    "Giỏi lắm, cả câu trôi chảy rồi! Đọc tiếp nào con.",
    "Tuyệt vời! Con đọc liền câu rất rõ ràng.",
  ],
  pageFluentPraise: [
    "Con đọc xong trang này rất trôi chảy!",
    "Giỏi quá, mình lật sang trang tiếp theo nhé!",
    "Tuyệt vời, con đọc rõ ràng lắm!",
  ],
  quizAskChoice: [
    "Bé chọn đáp án nào?",
    "Con chọn đáp án nào nhé?",
    "Theo con, đáp án nào đúng nào?",
  ],
  quizCorrect: [
    "Đúng rồi! Bé nhớ bài rất tốt.",
    "Giỏi quá! Con trả lời chính xác rồi.",
    "Tuyệt vời! Con hiểu câu chuyện rất rõ đó.",
  ],
  quizTryAgain: [
    "Gần đúng rồi, con nghe kỹ và thử chọn lại nhé.",
    "Chưa chính xác lắm, bé nghĩ thêm chút rồi chọn lại nha.",
    "Suýt đúng rồi đó! Con thử đáp án khác xem sao nhé.",
  ],
  quizRemind: [
    "Bé nói A, B, C hoặc bấm vào đáp án bé chọn nhé.",
    "Con có thể đọc tên đáp án hoặc chạm trực tiếp trên màn hình nhé.",
  ],
};

/** Optional praise categories are throttled so they never interrupt reading rhythm. */
const OPTIONAL_COOLDOWN_MS: Partial<Record<PromptCategory, number>> = {
  spelledOutPraise: 25_000,
  pageFluentPraise: 15_000,
};

export class InteractivePromptSelector {
  private readonly lastIndex = new Map<PromptCategory, number>();
  private readonly lastOptionalAt = new Map<PromptCategory, number>();

  /**
   * Pick the next prompt for `category`, guaranteed never to repeat the
   * immediately preceding phrase from that category (when bank size >= 2).
   */
  next(
    category: PromptCategory,
    vars?: Readonly<Record<string, string>>,
  ): string {
    const bank = INTERACTIVE_PROMPT_BANKS[category];
    const prev = this.lastIndex.get(category) ?? -1;
    const nextIdx = (prev + 1) % bank.length;
    this.lastIndex.set(category, nextIdx);
    let template = bank[nextIdx];
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        template = template.replaceAll(`{${key}}`, value);
      }
    }
    return template;
  }

  /**
   * Rate-limited optional praise: returns `null` if spoken too recently so we
   * never clutter or interrupt the child's natural reading pace.
   */
  nextIfAllowed(
    category: PromptCategory,
    nowMs: number,
    vars?: Readonly<Record<string, string>>,
  ): string | null {
    const cooldown = OPTIONAL_COOLDOWN_MS[category] ?? 0;
    const last = this.lastOptionalAt.get(category);
    if (cooldown > 0 && last !== undefined && nowMs - last < cooldown) {
      return null;
    }
    this.lastOptionalAt.set(category, nowMs);
    return this.next(category, vars);
  }

  reset(): void {
    this.lastIndex.clear();
    this.lastOptionalAt.clear();
  }
}
