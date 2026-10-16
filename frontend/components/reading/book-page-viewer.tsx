import { WordHighlightOverlay } from "@/components/reading/word-highlight-overlay";
import { cn } from "@/lib/utils/cn";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";

interface BookPageViewerProps {
  currentWordId: string | null;
  isTransitioning?: boolean;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  page: ReadingPageDTO;
}

export function BookPageViewer({
  currentWordId,
  isTransitioning = false,
  onWordClick,
  page,
}: BookPageViewerProps) {
  const hasWords = page.words && page.words.length > 0;
  const wordsByLine = new Map<number, ReadingPageWordDTO[]>();
  for (const word of page.words) {
    const lineIndex = word.line_index ?? 0;
    const lineWords = wordsByLine.get(lineIndex) ?? [];
    lineWords.push(word);
    wordsByLine.set(lineIndex, lineWords);
  }
  const wordLines = Array.from(wordsByLine.entries());

  return (
    <article
      aria-busy={isTransitioning || undefined}
      aria-label={`Trang sách ${page.page_number}`}
      className={cn(
        "relative min-h-[552px] w-full overflow-hidden rounded-[8px] bg-cream p-4 shadow-[0_8px_24px_rgba(33,61,66,0.06)] sm:aspect-[3/2] sm:min-h-0 sm:max-w-[1008px] sm:p-8",
        isTransitioning && "opacity-60",
      )}
      data-page-id={page.page_id}
      data-page-revision-id={page.page_revision_id}
    >
      <WordHighlightOverlay currentWordId={currentWordId} page={page} />

      <div className="relative z-10 flex h-full flex-col">
        <header className="mb-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
            <span className="size-2 rounded-full bg-emerald-500" />
            Nội dung OCR đã xác minh
          </span>
          <span className="text-label text-muted">
            Trang {page.page_number}
          </span>
        </header>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-card bg-white/70 p-5 shadow-inner sm:mt-6 sm:p-8">
          {hasWords ? (
            <div className="text-[22px] font-extrabold leading-[1.9] text-ink sm:text-[28px] sm:leading-[1.7]">
              {wordLines.map(([lineIndex, lineWords], position) => {
                const previousLineIndex = wordLines[position - 1]?.[0];
                const startsParagraph =
                  previousLineIndex !== undefined &&
                  lineIndex > previousLineIndex + 1;
                return (
                  <div
                    className={cn(
                      "flex flex-wrap items-baseline gap-x-2 gap-y-1",
                      position > 0 && !startsParagraph && "mt-1",
                      startsParagraph && "mt-5 pl-5",
                    )}
                    data-line-index={lineIndex}
                    key={lineIndex}
                  >
                    {lineWords.map((word) => (
                      <span
                        className={cn(
                          "inline-block rounded-[10px] px-1.5 py-0.5 transition-all duration-150 cursor-pointer select-none hover:bg-highlight/40 active:scale-95",
                          word.word_id === currentWordId &&
                            "bg-highlight scale-105 font-black text-primary shadow-sm ring-2 ring-primary",
                        )}
                        data-bbox={word.bbox.join(",")}
                        data-page-revision-id={page.page_revision_id}
                        data-word-id={word.word_id}
                        key={word.word_id}
                        onClick={() => onWordClick?.(word)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onWordClick?.(word);
                          }
                        }}
                      >
                        {word.text}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : page.text ? (
            <div className="text-[22px] font-bold leading-[1.8] text-ink sm:text-[26px]">
              {page.text.split(/\n{2,}/u).map((paragraph, index) => (
                <p
                  className="mb-4 whitespace-pre-wrap indent-6 last:mb-0"
                  key={index}
                >
                  {paragraph}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-body text-muted">
              Đang tải nội dung văn bản của trang…
            </p>
          )}
        </div>

        <p className="mt-2 text-right text-label text-muted">
          {page.page_number}
        </p>
      </div>

      <span className="sr-only" aria-live="polite">
        Từ hiện tại:{" "}
        {page.words.find((word) => word.word_id === currentWordId)?.text}
      </span>
    </article>
  );
}
