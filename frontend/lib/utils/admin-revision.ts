import type {
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
  AdminRevisionWordDTO,
} from "@/types/admin";

export function canAdminReprocessRevision(
  detail: AdminPageRevisionDetailDTO,
  history: readonly AdminRevisionSummaryUI[],
): boolean {
  if (detail.verification_status !== "VERIFIED") return false;

  const selected = history.find(
    (revision) => revision.page_revision_id === detail.page_revision_id,
  );
  if (!selected?.is_current_verified) return false;

  return history.every(
    (revision) => revision.revision_no <= selected.revision_no,
  );
}

export function areAdminRevisionWordsValid(
  words: readonly AdminRevisionWordDTO[],
): boolean {
  return (
    words.length > 0 &&
    words.every((word, index) => {
      const confidenceIsValid =
        word.ocr_confidence === null ||
        (Number.isFinite(word.ocr_confidence) &&
          word.ocr_confidence >= 0 &&
          word.ocr_confidence <= 1);

      return (
        word.word_index === index &&
        Number.isSafeInteger(word.line_index) &&
        word.line_index >= 0 &&
        Boolean(word.text.trim()) &&
        Boolean(word.normalized_text.trim()) &&
        word.bbox.every(
          (coordinate) =>
            Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1,
        ) &&
        confidenceIsValid
      );
    })
  );
}
