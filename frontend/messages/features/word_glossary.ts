import { useCallback } from "react";

import { useI18n } from "@/hooks/use-i18n";
import { translateMessage } from "@/lib/i18n/formatter";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import type { MessageTree, TranslationParams } from "@/lib/i18n/types";

export const wordGlossaryVi = {
  tabPhonics: "Đánh vần",
  tabMeaning: "Nghĩa & Ví dụ",
  tabsAria: "Chế độ học từ cho bé",
  loadingMeaning: "Đang tìm lời giải nghĩa dễ hiểu cho bé…",
  grade12Badge: "Giải nghĩa Lớp 1–2",
  grade35Badge: "Giải nghĩa Lớp 3–5",
  definitionLabel: "Nghĩa dễ hiểu",
  exampleLabel: "Câu ví dụ ấm áp",
  nuanceLabel: "Mẹo dùng từ hay",
  listenExplanation: "Nghe giải nghĩa & ví dụ",
  stopListeningExplanation: "Dừng nghe",
  saveToNotebook: "Lưu vào Sổ Từ Hay",
  savingToNotebook: "Đang lưu…",
  savedInNotebook: "Đã lưu vào Sổ Từ Hay",
  openNotebookDrawer: "Mở Sổ Từ Hay",
  selectChildHint:
    "Hãy chọn hồ sơ bé để lưu từ yêu thích riêng tư vào Sổ Từ Hay.",
  explainError: "Tạm thời chưa tải được lời giải nghĩa. Bé thử lại nhé!",
  retryExplain: "Thử lại",
  drawerTitle: "Sổ Từ Hay của bé",
  drawerSubtitle:
    "Riêng tư trong gia đình • Nghe lại nghĩa hay mang từ sang trò chơi kể chuyện",
  privateBadge: "Riêng tư gia đình",
  wordCountBadge: "{count} từ đã lưu",
  emptyTitle: "Sổ Từ Hay chưa có từ nào",
  emptyDescription:
    "Khi đọc sách, bé hãy chạm vào từ bất kỳ, chọn tab «Nghĩa & Ví dụ» rồi bấm «Lưu vào Sổ Từ Hay» nhé!",
  listenItem: "Nghe nghĩa & ví dụ",
  removeItem: "Xóa khỏi sổ",
  removingItem: "Đang xóa…",
  closeDrawer: "Đóng Sổ Từ Hay",
  storyPromptBanner: "Từ gợi ý kể chuyện hôm nay:",
  playPictureStoryCta: "Kể chuyện theo tranh với từ hay",
  playMemoryStoryCta: "Chơi Nhớ nhanh & Kể sáng tạo",
  hubNotebookButton: "Sổ Từ Hay ({count})",
  hubNotebookButtonEmpty: "Sổ Từ Hay",
  bonusStoryWordsLabel: "Từ hay trong Sổ của bé:",
  bonusStoryWordsHint:
    "Thử đưa 1–2 từ hay bé đã lưu vào câu chuyện để câu văn thật sinh động nhé!",
} as const satisfies MessageTree;

export const wordGlossaryEn = {
  tabPhonics: "Phonics",
  tabMeaning: "Meaning & Example",
  tabsAria: "Word learning mode",
  loadingMeaning: "Finding a kid-friendly explanation…",
  grade12Badge: "Grades 1–2 Meaning",
  grade35Badge: "Grades 3–5 Meaning",
  definitionLabel: "Kid-friendly meaning",
  exampleLabel: "Warm example sentence",
  nuanceLabel: "Word nuance tip",
  listenExplanation: "Listen to meaning & example",
  stopListeningExplanation: "Stop audio",
  saveToNotebook: "Save to Favorite Words",
  savingToNotebook: "Saving…",
  savedInNotebook: "Saved in Favorite Words",
  openNotebookDrawer: "Open Favorite Words",
  selectChildHint:
    "Select a child profile to save private favorite words to the notebook.",
  explainError: "Could not load the word explanation right now. Please retry!",
  retryExplain: "Retry",
  drawerTitle: "Child's Favorite Words",
  drawerSubtitle:
    "Private to your family • Listen again or bring words into storytelling games",
  privateBadge: "Parent Private",
  wordCountBadge: "{count} saved words",
  emptyTitle: "No favorite words saved yet",
  emptyDescription:
    "While reading, tap any word, switch to “Meaning & Example”, and tap “Save to Favorite Words”!",
  listenItem: "Listen to meaning",
  removeItem: "Remove",
  removingItem: "Removing…",
  closeDrawer: "Close notebook",
  storyPromptBanner: "Today's bonus storytelling words:",
  playPictureStoryCta: "Tell a Picture Story with these words",
  playMemoryStoryCta: "Play Memory & Creative Story",
  hubNotebookButton: "Favorite Words ({count})",
  hubNotebookButtonEmpty: "Favorite Words",
  bonusStoryWordsLabel: "Bonus words from Favorite Notebook:",
  bonusStoryWordsHint:
    "Try weaving 1–2 of your saved favorite words into your story!",
} as const satisfies MessageTree;

export type WordGlossaryMessageKey = keyof typeof wordGlossaryVi;

const fallbackDict = { wordGlossary: wordGlossaryVi } as const;

export function useWordGlossaryTranslations() {
  const { t, locale } = useI18n();
  return useCallback(
    (key: WordGlossaryMessageKey, params?: TranslationParams): string => {
      const fallback = translateMessage(
        fallbackDict,
        fallbackDict,
        locale || DEFAULT_LOCALE,
        `wordGlossary.${key}`,
        params,
        wordGlossaryVi[key],
      );
      return t(`wordGlossary.${key}`, params, fallback);
    },
    [locale, t],
  );
}
