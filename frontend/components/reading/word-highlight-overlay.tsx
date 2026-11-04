import type { ReadingPageDTO } from "@/types/reading";
import type { ComparisonResult } from "@/lib/api/comparison-service";
import type { RealtimeAlignmentSnapshot } from "@/lib/reading/realtime-alignment";

interface WordHighlightOverlayProps {
  currentWordId: string | null;
  page: ReadingPageDTO;
  correctWordIds?: Set<string>;
  mispronouncedWordIds?: Set<string>;
  skippedWordIds?: Set<string>;
  repeatedWordIds?: Set<string>;
  hesitationWordIds?: Set<string>;
  ambiguousWordIds?: Set<string>;
  previewSnapshot?: RealtimeAlignmentSnapshot | null;
}

function normalizeWord(word: string): string {
  return word
    .toLocaleLowerCase("vi")
    .normalize("NFC")
    .replace(/[.,!?;:"“”()]/g, "");
}

function getWordStatus(
  wordId: string,
  currentWordId: string | null,
  correctWordIds?: Set<string>,
  mispronouncedWordIds?: Set<string>,
  skippedWordIds?: Set<string>,
  repeatedWordIds?: Set<string>,
  hesitationWordIds?: Set<string>,
  ambiguousWordIds?: Set<string>,
  previewSnapshot?: RealtimeAlignmentSnapshot | null,
): string {
  const previewStatus = previewSnapshot?.statusByWordId.get(wordId);

  if (skippedWordIds?.has(wordId) || previewStatus?.status === "DELETE") {
    return "missing";
  }

  if (
    mispronouncedWordIds?.has(wordId) ||
    previewStatus?.status === "SUBSTITUTE"
  ) {
    return "wrong";
  }

  if (
    repeatedWordIds?.has(wordId) ||
    previewSnapshot?.repeatedWordIds.has(wordId)
  ) {
    return "repeated";
  }

  if (
    hesitationWordIds?.has(wordId) ||
    previewSnapshot?.hesitationWordIds.has(wordId)
  ) {
    return "hesitation";
  }

  if (
    ambiguousWordIds?.has(wordId) ||
    previewStatus?.status === "AMBIGUOUS"
  ) {
    return "ambiguous";
  }

  if (
    wordId === currentWordId
  ) {
    return "current";
  }

  if (
    correctWordIds?.has(wordId) ||
    previewStatus?.status === "MATCH" ||
    previewSnapshot?.previewMatchedWordIds.has(wordId)
  ) {
    return "correct";
  }

  return "";
}

function getWordColor(status: string): string {
  switch (status) {
    case "current":
      return "border-yellow-500 bg-yellow-300 scale-105 font-black text-primary shadow-sm ring-2 ring-primary";

    case "correct":
      return "border-green-500 bg-green-100";

    case "missing":
      return "border-red-500 bg-red-100";

    case "wrong":
      return "border-orange-500 bg-orange-100";

    case "hesitation":
      return "border-blue-500 bg-blue-100";

    case "repeated":
      return "border-purple-500 bg-purple-100";

    case "ambiguous":
      return "border-slate-400 bg-slate-100";

    default:
      return "";
  }
}

export function WordHighlightOverlay({
  currentWordId,
  page,
  correctWordIds,
  mispronouncedWordIds,
  skippedWordIds,
  repeatedWordIds,
  hesitationWordIds,
  ambiguousWordIds,
  previewSnapshot,
}: WordHighlightOverlayProps) {
  const word = page.words.find(
    (item) => item.word_id === currentWordId,
  );

  return (
    <>
      {page.words.map((item, index) => {
        const wordIndex = item.word_index ?? index;
        const status = getWordStatus(
          item.word_id,
          currentWordId,
          correctWordIds,
          mispronouncedWordIds,
          skippedWordIds,
          repeatedWordIds,
          hesitationWordIds,
          ambiguousWordIds,
          previewSnapshot,
        );

        return (
          <span
            key={item.word_id}
            className="sr-only"
            data-bbox={item.bbox.join(",")}
            data-page-revision-id={page.page_revision_id}
            data-overlay-word-id={item.word_id}
            data-comparison-status={status}
            data-comparison-class={getWordColor(status)}
          >
            {item.text}
          </span>
        );
      })}

      {word && (
        <span
          className="sr-only"
          data-bbox={word.bbox.join(",")}
          data-page-revision-id={page.page_revision_id}
          data-overlay-word-id={word.word_id}
          data-current-word="true"
        >
          Vùng tô sáng từ hiện tại theo bounding box
        </span>
      )}
    </>
  );
}