import type { ReadingPageDTO } from "@/types/reading";

interface WordHighlightOverlayProps {
  currentWordId: string | null;
  page: ReadingPageDTO;
}

export function WordHighlightOverlay({
  currentWordId,
  page,
}: WordHighlightOverlayProps) {
  const word = page.words.find((item) => item.word_id === currentWordId);

  if (!word) {
    return null;
  }

  return (
    <span
      className="sr-only"
      data-bbox={word.bbox.join(",")}
      data-page-revision-id={page.page_revision_id}
      data-overlay-word-id={word.word_id}
    >
      Vùng tô sáng từ hiện tại theo bounding box
    </span>
  );
}
