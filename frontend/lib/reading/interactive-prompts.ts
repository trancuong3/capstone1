/**
 * Warm, child-friendly Vietnamese elementary-teacher voice prompt bank with
 * anti-repetition rotation, mistake-specific multi-sentence comfort (G27/G28),
 * coaching-style adaptation ("gentle" vs "concise"), and optional praise
 * rate-limiting so ViRead feels like a patient Grade-1 teacher (G23, G27, G28).
 */

import type { ReadingMistakeCategory } from "@/lib/reading/reading-mistake-classifier";

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
  | "quizAskChoice"
  | "quizCorrect"
  | "quizTryAgain"
  | "quizRemind";

export const INTERACTIVE_PROMPT_BANKS: Readonly<
  Record<PromptCategory, readonly string[]>
> = {
  // Group A (TONE) — >= 8 multi-sentence warm comfort variants
  comfortToneMistake: [
    "Ơi, gần đúng lắm rồi đó con! Đừng buồn nha, chữ này chỉ khác dấu thanh một xíu thôi. Con nhìn kỹ dấu trên chữ “{word}” rồi đọc lại cùng cô nhé!",
    "Suýt trúng rồi bạn nhỏ ơi! Con ghép đúng chữ cái rồi đó, chỉ cần đổi dấu thanh một chút xíu thôi. Mình nhìn lại dấu thanh của chữ “{word}” rồi thử lại nha!",
    "Không sao đâu con, bé đọc gần chuẩn lắm rồi! Chữ “{word}” có dấu thanh đặc biệt nè. Con bình tĩnh nhìn dấu rồi đọc lại cho cô nghe nhé!",
    "Cố lên con yêu, con nhận ra mặt chữ rất tốt rồi đó! Chỉ là dấu thanh bị nhầm một tẹo thôi. Mình chú ý dấu của chữ “{word}” rồi đọc lại lần nữa nha!",
    "Đừng lo lắng nha con, mới học đọc bạn nào cũng hay nhầm dấu thanh mà! Con nhìn nhẹ lên dấu của chữ “{word}” xem là dấu gì, rồi mình đọc lại nhé!",
    "Con giỏi lắm, âm và vần đã đúng hết rồi! Giờ con chỉ cần chỉnh lại dấu thanh của chữ “{word}” một xíu nữa là tuyệt vời luôn, thử lại nào con!",
    "Ôi gần chạm đích rồi nè! Chữ này chỉ khác dấu thanh so với tiếng con vừa đọc thôi. Con hít một hơi nhỏ rồi đọc lại chữ “{word}” cùng cô nha!",
    "Cô khen con đã đọc rất tự tin nha! Mình chỉ cần nhìn kỹ lại dấu thanh trên chữ “{word}” thêm một lần nữa thôi, cô tin con đọc đúng ngay đó!",
  ],

  // Group B (NEAR_SOUND) — >= 8 multi-sentence warm comfort variants
  comfortNearSoundMistake: [
    "Không sao đâu bạn nhỏ ơi, hai âm này giống nhau nên nhiều bạn cũng nhầm lắm! Mình bình tĩnh nhìn kỹ chữ đầu tiên và vần của chữ “{word}” rồi thử lại nha, cô tin con làm được!",
    "Đừng buồn nha con, âm này hơi giống tiếng con vừa đọc thật đó! Con nhìn thật chậm từng nét của chữ “{word}” rồi đọc lại cùng cô nhé!",
    "Suýt đúng rồi đó con ơi! Hai vần này nghe gần giống nhau lắm nên nhầm một xíu là bình thường mà. Con nhìn kỹ chữ “{word}” rồi thử lại lần nữa nha!",
    "Cô thương lắm, chữ này có âm gần giống nhau dễ nhầm ghê! Con cứ thong thả nhìn từ chữ đầu đến chữ cuối của “{word}”, rồi mình đọc lại nhé!",
    "Không sao cả con nha, con đã nghe rất gần âm đúng rồi! Mình để ý kỹ âm đầu và phần vần của chữ “{word}” một chút xíu nữa thôi, thử lại cùng cô nào!",
    "Bạn nhỏ của cô cố gắng tốt lắm! Hai chữ này là anh em gần âm nên dễ làm mình bối rối xíu thôi. Con nhìn kỹ chữ “{word}” rồi đọc lại thật rõ nhé!",
    "Bình tĩnh nha con, không có gì phải vội hết! Chữ “{word}” có âm hơi khác một chút xíu thôi, con nhìn mặt chữ trên trang sách rồi thử lại với cô nha!",
    "Gần đúng lắm rồi con ơi! Chỉ cần chỉnh nhẹ âm của chữ “{word}” một tẹo nữa là chuẩn xác luôn. Cô ngồi nghe con đọc lại đây nhé!",
  ],

  // Group C (GENERAL) — >= 10 multi-sentence anti-fear comfort variants
  comfortGeneralMistake: [
    "Không sao hết con ơi, mới tập đọc ai cũng gặp chữ khó mà! Con cứ thở nhẹ một cái nhé, có cô ngồi đọc cùng con đây. Mình thử nhìn lại chữ “{word}” xem sao nào!",
    "Đừng lo nha bạn nhỏ, đọc nhầm một chút là chuyện rất bình thường khi mình đang lớn lên! Cô vẫn ở ngay bên cạnh con đây. Mình cùng nhìn lại chữ “{word}” rồi thử lại nhé!",
    "Ơi, chữ này hơi lạ một xíu phải không con? Không sao đâu nha, con không cần vội vàng gì hết. Con nhìn chậm vào chữ “{word}” trên sách rồi đọc thử cùng cô nào!",
    "Cô khen con đã mạnh dạn cất tiếng đọc nhé! Chữ này hơi thử thách một chút thôi, cô trò mình cùng bình tĩnh chinh phục chữ “{word}” lại lần nữa nha!",
    "Không có gì phải ngại đâu con yêu! Mỗi lần thử lại là một lần con giỏi hơn hôm qua đó. Giờ con nhìn vào chữ “{word}” được tô sáng rồi đọc chậm lại nhé!",
    "Bình tĩnh nào bạn nhỏ ơi, sai một chữ không sao cả! Cô luôn kiên nhẫn đợi con mà. Mình nhìn kỹ từng chữ cái trong từ “{word}” rồi đọc lại nha!",
    "Chữ này hơi khó nhằn một tẹo ha con! Đừng nản lòng nhé, bạn nhỏ nào mới vào lớp Một cũng từng vấp chữ như vậy đó. Con thử đánh vần hoặc đọc lại chữ “{word}” cùng cô nào!",
    "Có cô đồng hành cùng con đây rồi, con cứ yên tâm đọc nhé! Mình tạm quên tiếng vừa rồi đi, giờ cô trò mình nhìn mới lại chữ “{word}” rồi thử một lần nữa nha!",
    "Thương con quá, chữ này làm con hơi lúng túng một chút đúng không? Con cứ thả lỏng vai và đọc thật chậm thôi nhé. Mình thử lại chữ “{word}” cùng cô nào!",
    "Mọi chuyện vẫn rất ổn con ơi, con đang làm tốt lắm rồi! Gặp chữ chưa quen thì mình dừng lại làm quen với nó thôi. Con nhìn chữ “{word}” rồi thử đọc lại cho cô nghe nhé!",
  ],

  // Concise mode (for fluent readers)
  comfortConciseMistake: [
    "Gần đúng rồi, con nhìn kỹ chữ “{word}” rồi thử lại nhé!",
    "Không sao đâu, mình đọc lại chữ “{word}” một lần nữa nha!",
    "Bình tĩnh nhìn lại chữ “{word}” rồi đọc tiếp cùng cô nhé!",
    "Suýt đúng rồi, con thử đọc lại chữ “{word}” nào!",
  ],

  comfortStep2WarmIntro: [
    "Không sao đâu con, để cô đánh vần mẫu thật chậm giúp con nhé!",
    "Đừng lo nha bạn nhỏ, chữ này mình đánh vần từng bước sẽ dễ lắm nè!",
    "Cô thương nha, giờ cô trò mình tách từng âm ra ghép cho dễ đọc nhé!",
    "Bình tĩnh nha con, cô sẽ đánh vần mẫu thật rõ để con nghe và làm theo nhé!",
    "Chữ này hơi khó một xíu, để cô đánh vần từng tiếng dẫn đường cho con nha!",
    "Có cô giúp con ngay đây, mình nghe đánh vần chậm từng âm một nhé!",
  ],

  comfortStep3Phrase: [
    "Con kiên trì thật đáng khen! Giờ cô đọc liền cả cụm “{phrase}” để con bắt nhịp dễ hơn nhé, rồi con nói nối theo cô nào!",
    "Cô rất tự hào vì con vẫn đang cố gắng! Nghe cô đọc mượt cả cụm “{phrase}” nha, đọc theo cụm sẽ dễ hơn nhiều đó con!",
    "Bạn nhỏ của cô chăm chỉ quá đi thôi! Mình ghép chữ vào cụm “{phrase}” cho xuôi tai nhé, con nghe cô rồi đọc nối theo nha!",
    "Con làm rất cố gắng rồi đó! Để cô đọc cả cụm “{phrase}” làm đà cho con nhé, xong đến lượt con đọc liền theo cô nào!",
    "Kiên nhẫn như con là giỏi nhất lớp rồi! Con nghe cô đọc cụm “{phrase}” một lượt rồi mình đọc nối lại thật tự nhiên nhé!",
    "Không sao hết con yêu, mình thử đọc theo cả cụm “{phrase}” xem sao nhé! Nghe cô đọc trước rồi con nối giọng theo cô nha!",
  ],

  comfortGiveUpEffort: [
    "Hôm nay con đã rất dũng cảm và kiên trì với chữ “{word}” rồi, cô khen con nhiều lắm! Chữ này mình cất vào giỏ luyện sau nhé, giờ cô trò mình đọc tiếp câu chuyện nào!",
    "Ôi, cô tự hào về sự cố gắng của con quá đi! Chữ “{word}” hơi khó nên mình tạm để dành luyện thêm lúc khác nha, giờ con yên tâm đọc tiếp cùng cô nhé!",
    "Con đã thử đi thử lại rất chăm chỉ, vậy là giỏi tuyệt vời rồi đó bạn nhỏ ơi! Mình cho chữ “{word}” nghỉ ngơi trong giỏ ôn tập nhé, cô trò mình đi tiếp trang sách nào!",
    "Không sao đâu con yêu, học đọc là mỗi ngày tiến bộ thêm một chút mà! Hôm nay con nỗ lực với chữ “{word}” rất đáng khen rồi, mình cất lại ôn sau và đọc tiếp nhé!",
    "Cô tặng con một ngôi sao kiên trì vì đã không bỏ cuộc với chữ “{word}” nha! Giờ mình tạm gác chữ này vào giỏ luyện tập để đọc tiếp câu chuyện đang hay nhé!",
    "Bạn nhỏ của cô giỏi lắm, dám thử sức với chữ khó “{word}” tận mấy lần liền! Mình lưu chữ này lại để hôm sau chinh phục tiếp nha, giờ đọc sang chữ kế tiếp thôi nào!",
  ],

  celebrateOvercameWord: [
    "Tuyệt vời quá con ơi! Vừa nãy chữ “{word}” còn làm khó con mà giờ con đọc chuẩn xác luôn rồi, cô khen con nhiều lắm!",
    "Hoan hô bạn nhỏ của cô! Con đã tự mình vượt qua chữ “{word}” thật xuất sắc, giỏi quá chừng luôn!",
    "Ôi hay quá đi thôi! Con bình tĩnh sửa lại đúng chữ “{word}” rồi kìa, cô rất tự hào về con!",
    "Đúng chuẩn chữ “{word}” rồi đó con yêu! Thấy chưa nào, kiên trì một chút là con làm được ngay mà!",
    "Giỏi xuất sắc luôn bạn nhỏ ơi! Con ghép và đọc chữ “{word}” rõ ràng quá, mình tiếp tục phát huy nhé!",
    "Cô vỗ tay khen con nè! Chữ “{word}” khó vậy mà con đã đọc thắng nó rồi, tuyệt vời lắm!",
  ],

  celebrateQuickSelfFix: [
    "Giỏi quá, con tự nhận ra và sửa lại đúng chữ “{word}” ngay luôn!",
    "Tuyệt vời! Con tự sửa đúng chữ “{word}” rất nhanh nhạy!",
    "Hay lắm bạn nhỏ ơi, con tự nghe và sửa đúng chữ “{word}” giỏi ghê!",
  ],

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
    "Con đánh vần chữ “{word}” giỏi quá! Mình đọc tiếp nào!",
    "Tuyệt vời, con tự ghép vần chữ “{word}” chuẩn xác rồi đó!",
    "Hay lắm bạn nhỏ ơi, con đánh vần rất đúng cách lớp Một!",
    "Hoan hô, con tự đánh vần và đọc trơn mượt mà quá!",
  ],
  sentenceReinforceAfterSuccess: [
    "Giỏi lắm con ơi! Giờ cô trò mình nối mượt lại cả câu “{sentence}” nhé.",
    "Đúng chuẩn rồi! Mình đọc liền lại cả câu “{sentence}” cho thật trôi chảy nào.",
    "Tuyệt vời quá! Con thử đọc trơn lại cả câu “{sentence}” nhé.",
  ],
  sentenceReinforceAfterHelp: [
    "Không sao đâu, con cố gắng dũng cảm lắm rồi! Giờ mình cùng đọc lại cả câu “{sentence}” cho quen nhé.",
    "Mình vừa làm quen từ đó rồi. Giờ con bình tĩnh đọc lại cả câu “{sentence}” cùng cô nào.",
    "Con kiên trì tốt lắm! Nào, mình nối lại cả câu “{sentence}” cho xuôi tai nhé.",
  ],
  sentenceReinforceDone: [
    "Hay quá, con đọc cả câu rất mượt mà! Cô khen con nhé, mình đọc tiếp nào!",
    "Giỏi lắm bạn nhỏ ơi, cả câu trôi chảy rồi! Đọc tiếp cùng cô nhé.",
    "Tuyệt vời! Con đọc liền câu rất rõ ràng và tự tin.",
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
