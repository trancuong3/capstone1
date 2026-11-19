import type { ComparisonResult } from "@/lib/api/comparison-service";
import type { RealtimeAlignmentSnapshot } from "@/lib/reading/realtime-alignment";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";

export type WordPresentationState =
  | "unread"
  | "current"
  | "preview-correct"
  | "correct"
  | "incorrect"
  | "omission"
  | "repeated"
  | "hesitation"
  | "self-corrected"
  | "unresolved"
  | "uncertain";

export const wordPresentationLabels: Record<WordPresentationState, string> = {
  unread: "Chưa đọc",
  current: "Đang đọc",
  "preview-correct": "Đang nhận diện từ này",
  correct: "Đúng lượt đầu",
  incorrect: "Thử lại nhé",
  omission: "Mình đọc thêm từ này",
  repeated: "Đọc lặp",
  hesitation: "Ngập ngừng",
  "self-corrected": "Bé đã tự sửa đúng",
  unresolved: "Mình sẽ luyện thêm",
  uncertain: "Chưa nghe rõ",
};

export const wordPresentationClasses: Record<WordPresentationState, string> = {
  unread: "",
  current: "bg-yellow-200/50 ring-2 ring-yellow-500",
  "preview-correct": "bg-success-surface/60 text-success-ink",
  correct: "bg-success-surface text-success-ink",
  incorrect: "bg-red-200 text-red-900 ring-1 ring-red-500",
  omission: "bg-red-200 text-red-900 ring-1 ring-red-500",
  repeated: "bg-purple-200 text-purple-900 ring-1 ring-purple-500",
  hesitation: "bg-purple-200 text-purple-900 ring-1 ring-purple-500",
  "self-corrected":
    "bg-green-200 text-green-900 ring-2 ring-green-600 ring-offset-2",
  unresolved: "bg-red-200 text-red-900 ring-2 ring-red-600",
  uncertain: "bg-slate-100 text-slate-700 ring-1 ring-slate-400",
};

export interface PageWordEvidence {
  page: ReadingPageDTO;
  currentWordId?: string | null;
  previewSnapshot?: RealtimeAlignmentSnapshot | null;
  correctWordIds?: ReadonlySet<string>;
  mispronouncedWordIds?: ReadonlySet<string>;
  skippedWordIds?: ReadonlySet<string>;
  repeatedWordIds?: ReadonlySet<string>;
  hesitationWordIds?: ReadonlySet<string>;
  selfCorrectedWordIds?: ReadonlySet<string>;
  unresolvedWordIds?: ReadonlySet<string>;
  uncertainWordIds?: ReadonlySet<string>;
  activeRetryWordId?: string | null;
  comparisonResult?: Pick<
    ComparisonResult,
    "page_id" | "page_revision_id" | "alignment" | "summary"
  > | null;
}

export function wordStateForPage(props: PageWordEvidence) {
  const { page, comparisonResult, previewSnapshot } = props;
  const comparison =
    comparisonResult?.page_id === page.page_id &&
    comparisonResult.page_revision_id === page.page_revision_id
      ? comparisonResult
      : null;
  const saved = new Map(
    comparison?.summary.initial_assessment?.map((word) => [
      word.word_id,
      word.status,
    ]),
  );
  const aligned = new Map(
    comparison?.alignment.map((item) => [item.book_index, item.status]),
  );
  const repeats = new Set(comparison?.summary.repeated_book_indices);
  const pauses = new Set(
    comparison?.summary.hesitations.map((pause) => pause.before_book_index),
  );
  const activeId = previewSnapshot
    ? previewSnapshot.currentWordId
    : props.currentWordId;

  return (word: ReadingPageWordDTO, index: number): WordPresentationState => {
    const id = word.word_id;
    if (props.selfCorrectedWordIds?.has(id)) return "self-corrected";
    if (id === props.activeRetryWordId) return "current";
    if (props.unresolvedWordIds?.has(id)) return "unresolved";
    // The saved first pass wins over transcript re-alignment. Older reports
    // only have alignment entries, whose indices refer to token positions.
    const status = saved.get(id) ?? aligned.get(index);
    if (
      status === "MISPRONUNCIATION" ||
      status === "SUBSTITUTE" ||
      props.mispronouncedWordIds?.has(id)
    )
      return "incorrect";
    if (
      status === "OMISSION" ||
      status === "DELETE" ||
      props.skippedWordIds?.has(id)
    )
      return "omission";
    if (status === "UNCERTAIN" && props.uncertainWordIds?.has(id))
      return "uncertain";
    if (props.repeatedWordIds?.has(id) || repeats.has(index)) return "repeated";
    if (props.hesitationWordIds?.has(id) || pauses.has(index))
      return "hesitation";
    if (
      status === "CORRECT" ||
      status === "MATCH" ||
      props.correctWordIds?.has(id)
    )
      return "correct";
    if (props.uncertainWordIds?.has(id)) return "uncertain";
    if (previewSnapshot?.previewMatchedWordIds.has(id))
      return "preview-correct";
    return id === activeId ? "current" : "unread";
  };
}
