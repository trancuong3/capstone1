import { Fragment } from "react";

import { cn } from "@/lib/utils/cn";
import type { ComparisonResult } from "@/lib/api/comparison-service";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";

interface BookPageContentProps {
  page: ReadingPageDTO;
  comparisonResult?: Pick<ComparisonResult, "alignment" | "summary"> | null;
  currentWordId?: string | null;
  correctWordIds?: Set<string>;
  mispronouncedWordIds?: Set<string>;
  reviewedWordIds?: Set<string>;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  readOnly?: boolean;
}

export function BookPageContent({
  page,
  comparisonResult,
  currentWordId = null,
  correctWordIds,
  mispronouncedWordIds,
  reviewedWordIds,
  onWordClick,
  readOnly = false,
}: BookPageContentProps) {
  const hasWords = page.words.length > 0;

  return (
    <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-card bg-white/70 p-5 shadow-inner sm:mt-6 sm:p-8">
      {hasWords ? (
        <p className="text-[22px] font-extrabold leading-[1.8] text-ink sm:text-[28px] sm:leading-[1.6]">
          {page.words.map((word, index) => {
            const wordIndex = word.word_index ?? index;

            const alignment = comparisonResult?.alignment.find(
              (item) => item.book_index === wordIndex,
            );

            const isCurrent = word.word_id === currentWordId;

            const isMispronounced = Boolean(
              mispronouncedWordIds?.has(word.word_id),
            );

            const isCorrect = Boolean(correctWordIds?.has(word.word_id));
            const isReviewed = Boolean(reviewedWordIds?.has(word.word_id));
            const tokenStatus =
              isCurrent && isMispronounced
                ? "NEEDS_REVIEW"
                : isCurrent
                  ? "ACTIVE"
                  : isReviewed
                    ? "REVIEWED"
                    : isMispronounced
                      ? "NEEDS_REVIEW"
                      : isCorrect
                        ? "CORRECT"
                        : "NOT_REACHED";
            const accessibleStatus = {
              NOT_REACHED: "chưa đọc đến",
              ACTIVE: "đang đọc",
              CORRECT: "đã đọc đúng",
              NEEDS_REVIEW: "cần đọc lại",
              REVIEWED: "đã đọc lại đúng",
            }[tokenStatus];

            const previousWord = page.words[index - 1];
            const lineIndex = word.line_index ?? 0;
            const previousLineIndex = previousWord?.line_index ?? 0;

            const startsLine =
              previousWord !== undefined &&
              lineIndex !== previousLineIndex;

            const verticalGap = previousWord
              ? word.bbox[1] -
                (previousWord.bbox[1] + previousWord.bbox[3])
              : 0;

            const inferredParagraphBreak =
              startsLine &&
              previousWord !== undefined &&
              verticalGap >
                Math.max(previousWord.bbox[3], word.bbox[3]) * 1.8;

            const startsParagraph =
              startsLine &&
              ((page.paragraph_start_line_indices ?? []).includes(
                lineIndex,
              ) ||
                inferredParagraphBreak);

            const isIndented =
              (index === 0 || startsLine) &&
              (page.indented_line_indices ?? []).includes(lineIndex);

            const colorClass =
              alignment?.status === "DELETE"
                ? "bg-red-200 text-red-900 ring-1 ring-red-500"
                : alignment?.status === "SUBSTITUTE"
                  ? "bg-orange-200 text-orange-900 ring-1 ring-orange-500"
                  : alignment?.status === "MATCH"
                    ? "bg-green-200 text-green-900 ring-1 ring-green-500"
                    : "";

            return (
              <Fragment key={word.word_id}>
                {startsLine ? <br /> : null}
                {startsParagraph ? <br /> : null}

                {isIndented ? (
                  <span
                    aria-hidden="true"
                    className="inline-block w-[1.25em]"
                  />
                ) : null}

                <span
                  className={cn(
                    "mr-2 inline-block rounded-[10px] px-2 py-0.5 transition-all duration-150",
                    !readOnly &&
                      "cursor-pointer select-none active:scale-95",
                    colorClass,

                    isCurrent &&
                      isMispronounced &&
                      "bg-rose-100 text-rose-700 font-black scale-105 ring-2 ring-rose-500 shadow-sm animate-pulse",

                    !isCurrent &&
                      isMispronounced &&
                      "bg-rose-50 text-rose-800 font-bold border-b-2 border-rose-400",

                    isCurrent &&
                      !isMispronounced &&
                      "bg-highlight scale-105 font-black text-primary shadow-sm ring-2 ring-primary",

                    !isCurrent &&
                      !isMispronounced &&
                      isReviewed &&
                      "bg-sky-50 text-sky-900 font-bold border-b-2 border-sky-500",

                    !isCurrent &&
                      !isMispronounced &&
                      !isReviewed &&
                      isCorrect &&
                      "bg-emerald-50 text-emerald-800 font-bold border-b-2 border-emerald-400",

                    !isCurrent &&
                      !isMispronounced &&
                      !isCorrect &&
                      !colorClass &&
                      !readOnly &&
                      "hover:bg-highlight/40",
                  )}
                  aria-label={`${word.text}, ${accessibleStatus}`}
                  data-word-status={tokenStatus}
                  data-bbox={word.bbox.join(",")}
                  data-line-index={lineIndex}
                  data-page-revision-id={page.page_revision_id}
                  data-word-id={word.word_id}
                  onClick={
                    readOnly ? undefined : () => onWordClick?.(word)
                  }
                  role={readOnly ? undefined : "button"}
                  tabIndex={readOnly ? undefined : 0}
                  title={
                    readOnly
                      ? undefined
                      : isCurrent && isMispronounced
                        ? `Chưa chính xác: "${word.text}". Bé đọc lại từ này nhé!`
                        : `Bấm để nghe đọc mẫu chữ: "${word.text}"`
                  }
                  onKeyDown={
                    readOnly
                      ? undefined
                      : (event) => {
                          if (
                            event.key === "Enter" ||
                            event.key === " "
                          ) {
                            event.preventDefault();
                            onWordClick?.(word);
                          }
                        }
                  }
                >
                  {word.text}
                  {tokenStatus === "REVIEWED" || tokenStatus === "CORRECT" ? (
                    <span aria-hidden="true" className="ml-1 text-[0.7em] font-black">✓</span>
                  ) : tokenStatus === "NEEDS_REVIEW" ? (
                    <span aria-hidden="true" className="ml-1 text-[0.7em] font-black">!</span>
                  ) : null}
                </span>
              </Fragment>
            );
          })}
        </p>
      ) : page.text ? (
        <p className="whitespace-pre-wrap text-[22px] font-bold leading-[1.8] text-ink sm:text-[26px]">
          {page.text}
        </p>
      ) : (
        <p className="text-body text-muted">
          Đang tải nội dung văn bản của trang…
        </p>
      )}
    </div>
  );
}