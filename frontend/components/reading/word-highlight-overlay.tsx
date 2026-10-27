import type { ReadingPageDTO } from "@/types/reading";
import type { ComparisonResult } from "@/lib/api/comparison-service";

interface WordHighlightOverlayProps {
  currentWordId: string | null;
  page: ReadingPageDTO;
  comparisonResult?: ComparisonResult | null;
}

function normalizeWord(word: string): string {
  return word
    .toLocaleLowerCase("vi")
    .normalize("NFC")
    .replace(/[.,!?;:"“”()]/g, "");
}

function getWordStatus(
  wordIndex: number,
  wordText: string,
  result?: ComparisonResult | null,
): string {
  if (!result) return "";

  const item = result.alignment.find(
    (entry) => entry.book_index === wordIndex,
  );

  if (!item) return "";

  if (item.status === "DELETE") return "missing";
  if (item.status === "SUBSTITUTE") return "wrong";

  const normalized = normalizeWord(wordText);

  const repeated = result.summary.repeated_words.some(
    (word) => normalizeWord(word) === normalized,
  );

  if (repeated) return "repeated";

  const hesitation = result.summary.hesitations.some((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("after_word" in item)
    ) {
      return false;
    }

    return (
      normalizeWord(String(item.after_word)) === normalized
    );
  });

  if (hesitation) return "hesitation";

  if (item.status === "MATCH") return "correct";

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

    default:
      return "";
  }
}

export function WordHighlightOverlay({
  currentWordId,
  page,
  comparisonResult,
}: WordHighlightOverlayProps) {
  const word = page.words.find(
    (item) => item.word_id === currentWordId,
  );

  return (
    <>
      {page.words.map((item, index) => {
        const wordIndex = item.word_index ?? index;
        const status =
          item.word_id === currentWordId
            ? "current"
            : getWordStatus(
              wordIndex,
              item.text,
              comparisonResult,
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