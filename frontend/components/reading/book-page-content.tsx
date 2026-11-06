import { Fragment } from "react";

import { cn } from "@/lib/utils/cn";
import type { ComparisonResult } from "@/lib/api/comparison-service";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";
import type { RealtimeAlignmentSnapshot } from "@/lib/reading/realtime-alignment";

interface BookPageContentProps {
  page: ReadingPageDTO;
  comparisonResult?: Pick<ComparisonResult, "alignment" | "summary"> | null;
  currentWordId?: string | null;
  correctWordIds?: Set<string>;
  mispronouncedWordIds?: Set<string>;
  spokenWords?: Set<string>;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  readOnly?: boolean;
  skippedWordIds?: Set<string>;
  repeatedWordIds?: Set<string>;
  hesitationWordIds?: Set<string>;
  previewSnapshot?: RealtimeAlignmentSnapshot | null;
}

export function BookPageContent({
  page,
  comparisonResult,
  currentWordId = null,
  correctWordIds,
  mispronouncedWordIds,
  spokenWords,
  onWordClick,
  readOnly = false,
  skippedWordIds,
  repeatedWordIds,
  hesitationWordIds,
  previewSnapshot,
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

            const isPreviewActive =
              previewSnapshot !== null && previewSnapshot !== undefined;

            const isPreviewCurrent =
              word.word_id === previewSnapshot?.currentWordId;

            // Khi có preview, chỉ sử dụng vị trí preview.
            // Không cộng thêm currentWordId chính thức.
            const isCurrent = isPreviewActive
              ? isPreviewCurrent
              : word.word_id === currentWordId;

            const previewStatus = previewSnapshot?.statusByWordId.get(
              word.word_id,
            );

            const isPreviewMatched =
              previewSnapshot?.previewMatchedWordIds.has(word.word_id) ?? false;

            const isSkipped = Boolean(
              !correctWordIds?.has(word.word_id) &&
              (skippedWordIds?.has(word.word_id) ||
                alignment?.status === "DELETE" ||
                previewStatus?.status === "DELETE"),
            );

            const isRepeated = Boolean(
              repeatedWordIds?.has(word.word_id) ||
              comparisonResult?.summary.repeated_book_indices?.includes(
                wordIndex,
              ) ||
              previewStatus?.status === "REPEATED",
            );

            const isHesitation = Boolean(
              hesitationWordIds?.has(word.word_id) ||
              previewSnapshot?.hesitationWordIds.has(word.word_id) ||
              comparisonResult?.summary.hesitations.some(
                (item) =>
                  typeof item === "object" &&
                  item !== null &&
                  "before_book_index" in item &&
                  item.before_book_index === wordIndex,
              ),
            );

            const isMispronounced = Boolean(
              !correctWordIds?.has(word.word_id) &&
              (mispronouncedWordIds?.has(word.word_id) ||
                alignment?.status === "SUBSTITUTE" ||
                previewStatus?.status === "SUBSTITUTE"),
            );

            const isCorrect = Boolean(
              correctWordIds?.has(word.word_id) ||
              alignment?.status === "MATCH" ||
              previewStatus?.status === "MATCH" ||
              isPreviewMatched,
            );

            const previousWord = page.words[index - 1];
            const lineIndex = word.line_index ?? 0;
            const previousLineIndex = previousWord?.line_index ?? 0;

            const startsLine =
              previousWord !== undefined && lineIndex !== previousLineIndex;

            const verticalGap = previousWord
              ? word.bbox[1] - (previousWord.bbox[1] + previousWord.bbox[3])
              : 0;

            const inferredParagraphBreak =
              startsLine &&
              previousWord !== undefined &&
              verticalGap > Math.max(previousWord.bbox[3], word.bbox[3]) * 1.8;

            const startsParagraph =
              startsLine &&
              ((page.paragraph_start_line_indices ?? []).includes(lineIndex) ||
                inferredParagraphBreak);

            const isIndented =
              (index === 0 || startsLine) &&
              (page.indented_line_indices ?? []).includes(lineIndex);

            const statusClass = isSkipped
              ? "bg-red-200 text-red-900 ring-1 ring-red-500"
              : isMispronounced
                ? "bg-orange-200 text-orange-900 ring-1 ring-orange-500"
                : isRepeated
                  ? "bg-purple-200 text-purple-900 ring-1 ring-purple-500"
                  : isHesitation
                    ? "bg-blue-200 text-blue-900 ring-1 ring-blue-500"
                    : isCorrect
                      ? "bg-green-200 text-green-900 ring-1 ring-green-500"
                      : "";

            const hasConfirmedStatus =
              isSkipped ||
              isMispronounced ||
              isRepeated ||
              isHesitation ||
              isCorrect;

            const currentClass = isCurrent
              ? cn(
                  "scale-105 font-black shadow-sm",
                  hasConfirmedStatus
                    ? "ring-2 ring-current"
                    : "bg-yellow-300 text-primary ring-2 ring-yellow-500",
                )
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
                    !readOnly && "cursor-pointer select-none active:scale-95",
                    statusClass,
                    currentClass,
                    !isCurrent &&
                      isMispronounced &&
                      "font-bold border-b-2 border-orange-500",
                    !isCurrent &&
                      isCorrect &&
                      "font-bold border-b-2 border-emerald-400",
                    !isCurrent &&
                      !hasConfirmedStatus &&
                      !readOnly &&
                      "hover:bg-highlight/40",
                  )}
                  data-bbox={word.bbox.join(",")}
                  data-line-index={lineIndex}
                  data-page-revision-id={page.page_revision_id}
                  data-word-id={word.word_id}
                  onClick={readOnly ? undefined : () => onWordClick?.(word)}
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
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onWordClick?.(word);
                          }
                        }
                  }
                >
                  {word.text}
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
