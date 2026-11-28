/**
 * Warm, child-friendly Vietnamese elementary-teacher voice prompt bank with
 * anti-repetition rotation, mistake-specific multi-sentence comfort (G27/G28),
 * coaching-style adaptation ("gentle" vs "concise"), and optional praise
 * rate-limiting so ViRead feels like a patient Grade-1 teacher (G23, G27, G28).
 */

import type { ReadingMistakeCategory } from "@/lib/reading/reading-mistake-classifier";
import { getEffectiveTeacherPersona } from "@/lib/reading/session-voice-lock";
import {
  adaptTextToTeacherPersona,
  type VoiceGender,
} from "@/lib/reading/voice-persona";

export type PromptCategory =
  | "comfortToneMistake"
  | "comfortNearSoundMistake"
  | "comfortGeneralMistake"
  | "comfortConciseMistake"
  | "comfortStep2WarmIntro"
  | "comfortStep3Phrase"
  | "comfortGiveUpEffort"
  | "celebrateOvercameWord"
  | "celebrateQuickSelfFix"
  | "wordHelpIntro"
  | "wordSlowIntro"
  | "phraseHelpIntro"
  | "encourageMoveOn"
  | "spelledOutPraise"
  | "sentenceReinforceAfterSuccess"
  | "sentenceReinforceAfterHelp"
  | "sentenceReinforceDone"
  | "pageFluentPraise"
  | "fluentStreakPraise"
  | "postReadingWrongWordsAsk"
  | "postReadingAcceptReview"
  | "postReadingSkipToQuiz"
  | "quizAskChoice"
  | "quizCorrect"
  | "quizTryAgain"
  | "quizRemind";

export const INTERACTIVE_PROMPT_BANKS: Readonly<
  Record<PromptCategory, readonly string[]>
> = {
  // Group A (TONE) — >= 8 concise 2-sentence warm comfort variants (TTFA < 2s)
  comfortToneMistake: [
    "Gần đúng rồi con! Con nhìn lại dấu thanh chữ “{word}” nhé.",
    "Suýt trúng rồi! Chỉ khác dấu thanh một chút ở chữ “{word}” thôi.",
    "Không sao đâu con! Con nhìn kỹ dấu trên chữ “{word}” rồi đọc lại nha.",
    "Con ghép đúng chữ rồi! Chỉnh nhẹ dấu thanh chữ “{word}” là chuẩn ngay.",
    "Đừng lo nha con! Chú ý dấu thanh chữ “{word}” rồi thử lại nhé.",
    "Con đọc tự tin lắm! Nhìn lại dấu chữ “{word}” một lần nữa nha.",
    "Gần chạm đích rồi nè! Con đọc lại dấu thanh chữ “{word}” cùng cô nhé.",
    "Không sao đâu con ơi! Nhìn rõ dấu chữ “{word}” rồi đọc lại nha.",
  ],

  // Group B (NEAR_SOUND) — >= 8 concise 2-sentence warm comfort variants (TTFA < 2s)
  comfortNearSoundMistake: [
    "Không sao đâu con! Hai âm gần giống nhau, con nhìn kỹ chữ “{word}” nhé.",
    "Suýt đúng rồi! Con nhìn lại âm đầu và vần chữ “{word}” rồi đọc nha.",
    "Đừng lo nha con! Chữ “{word}” có âm hơi khác, mình thử lại nhé.",
    "Gần đúng lắm rồi! Nhìn chậm từng chữ cái của “{word}” rồi đọc lại nha.",
    "Không sao cả con ơi! Chú ý vần của chữ “{word}” thêm chút nữa nhé.",
    "Con cố gắng tốt lắm! Hai âm dễ nhầm thôi, con đọc lại chữ “{word}” nào.",
    "Bình tĩnh nha con! Nhìn kỹ mặt chữ “{word}” rồi đọc rõ lại nhé.",
    "Gần chuẩn rồi con! Chỉnh nhẹ âm chữ “{word}” một xíu là đúng ngay.",
  ],

  // Group C (GENERAL) — >= 10 concise 2-sentence anti-fear comfort variants (TTFA < 2s)
  comfortGeneralMistake: [
    "Không sao hết con ơi! Con nhìn lại chữ “{word}” rồi thử lại nhé.",
    "Đừng lo nha con! Có cô ở đây, mình đọc chậm lại chữ “{word}” nào.",
    "Chữ “{word}” hơi lạ một chút nhé. Con nhìn kỹ rồi đọc lại nha.",
    "Cô khen con đọc rất mạnh dạn! Mình thử lại chữ “{word}” lần nữa nhé.",
    "Không sao đâu con! Con nhìn chữ “{word}” đang sáng rồi đọc chậm nha.",
    "Bình tĩnh nào con ơi! Nhìn từng chữ cái của “{word}” rồi đọc lại nhé.",
    "Chữ này hơi khó xíu ha con. Con thử đọc lại chữ “{word}” cùng cô nào.",
    "Cứ thong thả nha con! Mình nhìn lại chữ “{word}” rồi thử lại nhé.",
    "Con đang làm tốt lắm! Dừng nhẹ một nhịp rồi đọc chữ “{word}” nha.",
    "Không sao đâu bạn nhỏ! Con nhìn rõ chữ “{word}” rồi đọc lại cùng cô nhé.",
  ],

  // Concise mode (for fluent readers)
  comfortConciseMistake: [
    "Gần đúng rồi, con nhìn kỹ chữ “{word}” rồi thử lại nhé!",
    "Không sao đâu, mình đọc lại chữ “{word}” một lần nữa nha!",
    "Bình tĩnh nhìn lại chữ “{word}” rồi đọc tiếp cùng cô nhé!",
    "Suýt đúng rồi, con thử đọc lại chữ “{word}” nào!",
  ],

  comfortStep2WarmIntro: [
    "Để cô đánh vần chậm giúp con nhé!",
    "Mình đánh vần từng bước chữ này nha!",
    "Cô tách từng âm giúp con dễ đọc nhé!",
    "Con nghe cô đánh vần chậm từng âm nào!",
    "Mình ghép từng tiếng cho dễ đọc nha con!",
    "Cô đánh vần dẫn đường giúp con nhé!",
  ],

  comfortStep3Phrase: [
    "Con kiên trì lắm! Giờ đọc nối cụm “{phrase}” cùng cô nhé.",
    "Cô tự hào vì con cố gắng! Nghe cô đọc cụm “{phrase}” rồi nối theo nha.",
    "Mình ghép vào cụm “{phrase}” cho xuôi nhé, đến lượt con nào.",
    "Con làm tốt lắm! Nghe cụm “{phrase}” rồi đọc nối theo cô nha.",
    "Giỏi lắm! Con nghe cụm “{phrase}” rồi đọc lại cho tự nhiên nhé.",
    "Mình đọc cả cụm “{phrase}” cho dễ nhé, con nối theo cô nào.",
  ],

  comfortGiveUpEffort: [
    "Con rất dũng cảm với chữ “{word}”! Mình lưu lại ôn sau rồi đọc tiếp nhé.",
    "Cô tự hào vì con đã cố gắng với “{word}”! Mình đọc tiếp câu chuyện nào.",
    "Con chăm chỉ quá! Cho chữ “{word}” vào giỏ ôn tập rồi đi tiếp nhé.",
    "Nỗ lực với chữ “{word}” rất đáng khen! Mình cất ôn sau và đọc tiếp nha.",
    "Cô tặng con ngôi sao kiên trì cho chữ “{word}”! Mình đọc chữ tiếp theo nhé.",
    "Giỏi lắm, con đã thử sức với “{word}” rồi! Mình đọc tiếp trang sách nào.",
  ],

  celebrateOvercameWord: [
    "Tuyệt vời! Con đã đọc đúng chữ “{word}” rồi.",
    "Hoan hô con! Con vượt qua chữ “{word}” giỏi quá.",
    "Chuẩn xác chữ “{word}” rồi! Cô rất tự hào về con.",
    "Đúng chữ “{word}” rồi đó con! Kiên trì là làm được ngay.",
    "Giỏi quá! Con đọc chữ “{word}” rõ ràng lắm.",
    "Cô khen con nhé! Chữ “{word}” khó vậy mà con đọc chuẩn luôn.",
  ],

  celebrateQuickSelfFix: [
    "Con vừa tự sửa được chữ “{word}”!",
    "Giỏi quá, con tự sửa đúng chữ “{word}” ngay luôn!",
    "Hay lắm, con tự sửa được chữ “{word}” rồi!",
  ],

  wordHelpIntro: [
    "Cô đọc mẫu cho con nhé.",
    "Con nghe cô đọc từ này nhé.",
    "Mình cùng nghe từ này nào.",
  ],
  wordSlowIntro: [
    "Mình đọc chậm hơn chút nhé.",
    "Con nghe cô đọc thật chậm nha.",
    "Mình đọc chậm từng tiếng nhé.",
  ],
  phraseHelpIntro: [
    "Mình ghép vào cả cụm cho dễ đọc nhé.",
    "Con nghe cô đọc cả cụm này nhé.",
    "Đọc liền cả cụm sẽ dễ hơn đó con.",
  ],
  encourageMoveOn: [
    "Con đã cố gắng rất tốt rồi. Mình đọc tiếp nhé!",
    "Không sao đâu, từ này mình luyện thêm sau. Đọc tiếp nào!",
    "Con làm tốt lắm rồi. Mình sang từ tiếp theo nhé!",
  ],
  spelledOutPraise: [
    "Con đánh vần chữ “{word}” giỏi quá! Mình đọc tiếp nào!",
    "Tuyệt vời, con ghép vần chữ “{word}” chuẩn rồi!",
    "Hay lắm, con đánh vần đúng cách rồi đó!",
    "Hoan hô, con đánh vần và đọc trơn mượt quá!",
  ],
  sentenceReinforceAfterSuccess: [
    "Giỏi lắm! Mình nối mượt cả câu “{sentence}” nhé.",
    "Chuẩn rồi! Con đọc liền cả câu “{sentence}” nào.",
    "Tuyệt vời! Con đọc trơn lại cả câu “{sentence}” nhé.",
  ],
  sentenceReinforceAfterHelp: [
    "Con cố gắng lắm! Mình đọc lại cả câu “{sentence}” cho quen nhé.",
    "Mình đọc lại cả câu “{sentence}” cùng cô nào.",
    "Giờ mình nối lại cả câu “{sentence}” cho xuôi tai nhé.",
  ],
  sentenceReinforceDone: [
    "Con đọc cả câu mượt mà quá! Mình đọc tiếp nào!",
    "Giỏi lắm, cả câu trôi chảy rồi! Đọc tiếp nhé.",
    "Tuyệt vời! Con đọc liền câu rõ ràng lắm.",
  ],
  pageFluentPraise: [
    "Con đọc xong trang này trôi chảy quá! Cô khen nhé!",
    "Giỏi quá, mình lật sang trang tiếp theo nhé!",
    "Tuyệt vời, con đọc rõ lắm! Mình sang trang mới nào!",
    "Hoan hô con, trang này con đọc mượt mà quá!",
  ],
  fluentStreakPraise: [
    "Con đọc đều và trôi chảy quá!",
    "Nhịp đọc của con rất tự tin!",
    "Giỏi quá, con đọc rõ từng chữ một luôn!",
  ],
  postReadingWrongWordsAsk: [
    "Con đọc xong bài rồi! Con có muốn cùng cô đọc lại vài từ khó không? Nói có hoặc không nhé!",
    "Chúc mừng con hoàn thành bài! Con muốn ôn lại vài từ khó hay qua phần câu hỏi nhé?",
    "Hoan hô con đã đọc hết bài! Con có muốn đọc lại mấy từ vừa vấp không?",
    "Tuyệt vời, con xong cả bài rồi! Con có muốn luyện lại các từ khó một chút không?",
  ],
  postReadingAcceptReview: [
    "Tuyệt vời! Mình cùng đọc lại từng từ khó cho chuẩn nhé!",
    "Cô khen con chăm chỉ! Mình ôn lại từng từ một nào!",
    "Hay lắm! Mình cùng chinh phục lại các từ khó nhé!",
  ],
  postReadingSkipToQuiz: [
    "Được luôn con ơi! Giờ mình sang phần câu hỏi vui nhé!",
    "Nhất trí nha! Mình chuyển sang trả lời câu hỏi cùng cô nào!",
    "Không sao đâu con! Giờ mình trả lời câu hỏi thú vị nhé!",
  ],
  quizAskChoice: [
    "Bé chọn đáp án nào?",
    "Con chọn đáp án nào nhé?",
    "Theo con, đáp án nào đúng nào?",
  ],
  quizCorrect: [
    "Đúng rồi! Bé nhớ bài rất tốt.",
    "Giỏi quá! Con trả lời chính xác rồi.",
    "Tuyệt vời! Con hiểu câu chuyện rất rõ.",
  ],
  quizTryAgain: [
    "Gần đúng rồi, con nghe kỹ và thử chọn lại nhé.",
    "Chưa chính xác lắm, bé nghĩ thêm chút rồi chọn lại nha.",
    "Suýt đúng rồi! Con thử đáp án khác xem sao nhé.",
  ],
  quizRemind: [
    "Bé nói A, B, C hoặc bấm vào đáp án bé chọn nhé.",
    "Con có thể đọc tên đáp án hoặc chạm trực tiếp trên màn hình nhé.",
  ],
};

export function mistakeCategoryToPromptCategory(
  mistake: ReadingMistakeCategory,
  coachingStyle: "gentle" | "concise" = "gentle",
): PromptCategory {
  if (coachingStyle === "concise") {
    return "comfortConciseMistake";
  }
  if (mistake === "TONE") return "comfortToneMistake";
  if (mistake === "NEAR_SOUND") return "comfortNearSoundMistake";
  return "comfortGeneralMistake";
}

/** Optional praise categories are throttled so they never interrupt reading rhythm. */
const OPTIONAL_COOLDOWN_MS: Partial<Record<PromptCategory, number>> = {
  spelledOutPraise: 20_000,
  celebrateOvercameWord: 12_000,
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
    gender?: VoiceGender,
  ): string {
    const bank = INTERACTIVE_PROMPT_BANKS[category];
    const prev = this.lastIndex.get(category) ?? -1;
    const nextIdx = (prev + 1) % bank.length;
    this.lastIndex.set(category, nextIdx);
    const resolvedGender = gender ?? getEffectiveTeacherPersona().gender;
    let template = adaptTextToTeacherPersona(bank[nextIdx], resolvedGender);
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
    gender?: VoiceGender,
  ): string | null {
    const cooldown = OPTIONAL_COOLDOWN_MS[category] ?? 0;
    const last = this.lastOptionalAt.get(category);
    if (cooldown > 0 && last !== undefined && nowMs - last < cooldown) {
      return null;
    }
    this.lastOptionalAt.set(category, nowMs);
    return this.next(category, vars, gender);
  }

  reset(): void {
    this.lastIndex.clear();
    this.lastOptionalAt.clear();
  }
}
