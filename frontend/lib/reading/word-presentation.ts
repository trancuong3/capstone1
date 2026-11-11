export type WordPresentationState =
  | "unread"
  | "current"
  | "correct"
  | "incorrect"
  | "omission"
  | "self-corrected"
  | "unresolved"
  | "uncertain";

export const wordPresentationLabels: Record<WordPresentationState, string> = {
  unread: "Chưa đọc",
  current: "Đang đọc",
  correct: "Đúng lượt đầu",
  incorrect: "Thử lại nhé",
  omission: "Mình đọc thêm từ này",
  "self-corrected": "Bé đã tự sửa đúng",
  unresolved: "Mình sẽ luyện thêm",
  uncertain: "Chưa nghe rõ",
};

export const wordPresentationClasses: Record<WordPresentationState, string> = {
  unread: "",
  current: "bg-yellow-200/50 ring-2 ring-yellow-500",
  correct: "bg-green-200 text-green-900 ring-1 ring-green-500",
  incorrect: "bg-orange-200 text-orange-900 ring-1 ring-orange-500",
  omission: "bg-red-200 text-red-900 ring-1 ring-red-500",
  "self-corrected":
    "bg-green-200 text-green-900 ring-2 ring-green-600 ring-offset-2",
  unresolved: "bg-red-200 text-red-900 ring-2 ring-red-600",
  uncertain: "bg-slate-100 text-slate-700 ring-1 ring-slate-400",
};
