import type {
  RealtimeAlignmentSnapshot,
} from "@/lib/reading/realtime-alignment";

/**
 * Trạng thái hiển thị/lưu của từng từ, tách bạch với con trỏ tạm:
 * - CORRECT      đọc đúng (màu xanh) — chỉ từ bằng chứng ổn định, chưa được trợ giúp
 * - RETRY        đọc sai, cần thử lại
 * - SKIPPED      bỏ qua / hết lượt thử, KHÔNG tô xanh, lưu "Cần luyện lại"
 * - ASSISTED     app đã đọc mẫu từ này; không tính là bé tự đọc đúng
 * - NO_EVIDENCE  chưa có bằng chứng đáng tin
 */
export type GradedWordState =
  | "CORRECT"
  | "RETRY"
  | "SKIPPED"
  | "ASSISTED"
  | "NO_EVIDENCE";

export interface GradeableWord {
  readonly word_id: string;
}

export function gradeWord(
  status: "MATCH" | "SUBSTITUTE" | "DELETE" | "REPEATED" | undefined,
  helped: boolean,
): GradedWordState {
  if (status === "SUBSTITUTE") return "RETRY";
  if (status === "MATCH") return helped ? "ASSISTED" : "CORRECT";
  if (status === "DELETE") return helped ? "ASSISTED" : "SKIPPED";
  return helped ? "ASSISTED" : "NO_EVIDENCE";
}

export function gradeWords(
  snapshot: Pick<RealtimeAlignmentSnapshot, "statusByWordId">,
  words: readonly GradeableWord[],
  helpedWordIds: ReadonlySet<string> = new Set(),
  /** Words the app gave up on after the allowed attempts (never green). */
  gaveUpWordIds: ReadonlySet<string> = new Set(),
): Map<string, GradedWordState> {
  const graded = new Map<string, GradedWordState>();
  for (const word of words) {
    const status = snapshot.statusByWordId.get(word.word_id)?.status;
    let state = gradeWord(status, helpedWordIds.has(word.word_id));
    if (gaveUpWordIds.has(word.word_id)) {
      state = helpedWordIds.has(word.word_id) ? "ASSISTED" : "SKIPPED";
    }
    graded.set(word.word_id, state);
  }
  return graded;
}

/** "Cần luyện lại": everything the child did not read correctly alone. */
export function needsPractice(state: GradedWordState): boolean {
  return state === "RETRY" || state === "SKIPPED" || state === "ASSISTED";
}
