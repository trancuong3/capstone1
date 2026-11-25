import type { ComparisonResult } from "@/lib/api/comparison-service";
import type { RealtimeAlignmentSnapshot } from "@/lib/reading/realtime-alignment";
import { getEffectiveTeacherPersona } from "@/lib/reading/session-voice-lock";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
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
  | "assisted"
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
  assisted: "Cô đã đọc mẫu từ này",
  uncertain: "Chưa nghe rõ",
};

export const wordPresentationClasses: Record<WordPresentationState, string> = {
  unread: "",
  current:
    "bg-yellow-200/60 ring-2 ring-yellow-500 border-b-4 border-amber-600 font-semibold",
  "preview-correct":
    "bg-emerald-50 text-emerald-950 border-b-2 border-dashed border-emerald-500",
  correct:
    "bg-success-surface text-success-ink border-b-2 border-solid border-emerald-700/60",
  incorrect: "bg-red-200 text-red-900 ring-1 ring-red-500",
  omission: "bg-red-200 text-red-900 ring-1 ring-red-500",
  repeated: "bg-purple-200 text-purple-900 ring-1 ring-purple-500",
  hesitation: "bg-purple-200 text-purple-900 ring-1 ring-purple-500",
  "self-corrected":
    "bg-green-200 text-green-900 ring-2 ring-green-600 ring-offset-2",
  unresolved: "bg-red-200 text-red-900 ring-2 ring-red-600",
  // Not colour alone: dotted underline marks "the app read this one for you".
  assisted:
    "bg-sky text-primary underline decoration-dotted decoration-2 underline-offset-4",
  uncertain: "bg-slate-100 text-slate-700 ring-1 ring-slate-400",
};

export function getWordPresentationLabel(state: WordPresentationState): string {
  const base = wordPresentationLabels[state];
  if (state === "assisted") {
    return adaptTextToTeacherPersona(base, getEffectiveTeacherPersona().gender);
  }
  return base;
}

export function getWordHighlightTier(
  state: WordPresentationState,
  isCurrent: boolean,
): "interim" | "confirmed" | "upcoming" | undefined {
  if (state === "preview-correct") return "interim";
  if (
    state === "correct" ||
    state === "self-corrected" ||
    state === "assisted"
  ) {
    return "confirmed";
  }
  if (isCurrent || state === "current") return "upcoming";
  return undefined;
}

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
  /** Words the app read aloud first: practised, never plain green. */
  assistedWordIds?: ReadonlySet<string>;
  uncertainWordIds?: ReadonlySet<string>;
  activeRetryWordId?: string | null;
  comparisonResult?: Pick<
    ComparisonResult,
    "page_id" | "page_revision_id" | "alignment" | "summary"
  > | null;
}

interface ComparisonWordLookups {
  readonly saved: ReadonlyMap<
    string,
    "CORRECT" | "MISPRONUNCIATION" | "OMISSION" | "UNCERTAIN"
  >;
  readonly aligned: ReadonlyMap<number | null, string>;
  readonly repeats: ReadonlySet<number>;
  readonly pauses: ReadonlySet<number | null | undefined>;
}

const comparisonLookupCache = new WeakMap<object, ComparisonWordLookups>();

function getComparisonLookups(
  comparison: NonNullable<PageWordEvidence["comparisonResult"]>,
): ComparisonWordLookups {
  const cached = comparisonLookupCache.get(comparison);
  if (cached) return cached;
  const lookups: ComparisonWordLookups = {
    saved: new Map(
      comparison.summary.initial_assessment?.map((word) => [
        word.word_id,
        word.status,
      ]),
    ),
    aligned: new Map(
      comparison.alignment.map((item) => [item.book_index, item.status]),
    ),
    repeats: new Set(comparison.summary.repeated_book_indices),
    pauses: new Set(
      comparison.summary.hesitations.map((pause) => pause.before_book_index),
    ),
  };
  comparisonLookupCache.set(comparison, lookups);
  return lookups;
}

export function wordStateForPage(props: PageWordEvidence) {
  const { page, comparisonResult, previewSnapshot } = props;
  const comparison =
    comparisonResult?.page_id === page.page_id &&
    comparisonResult.page_revision_id === page.page_revision_id
      ? comparisonResult
      : null;
  const lookups = comparison ? getComparisonLookups(comparison) : null;
  const activeId = previewSnapshot
    ? previewSnapshot.currentWordId
    : props.currentWordId;

  return (word: ReadingPageWordDTO, index: number): WordPresentationState => {
    const id = word.word_id;
    if (props.selfCorrectedWordIds?.has(id)) return "self-corrected";
    if (id === props.activeRetryWordId) return "current";
    if (props.unresolvedWordIds?.has(id)) return "unresolved";
    if (props.assistedWordIds?.has(id)) return "assisted";
    // The saved first pass wins over transcript re-alignment. Older reports
    // only have alignment entries, whose indices refer to token positions.
    const status = lookups?.saved.get(id) ?? lookups?.aligned.get(index);
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
    if (props.repeatedWordIds?.has(id) || lookups?.repeats.has(index))
      return "repeated";
    if (props.hesitationWordIds?.has(id) || lookups?.pauses.has(index))
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
