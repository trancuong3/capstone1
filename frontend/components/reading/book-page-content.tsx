"use client";

import { Fragment, useEffect, useRef } from "react";
import {
  wordPresentationClasses,
  wordPresentationLabels,
  type WordPresentationState,
} from "@/lib/reading/word-presentation";

import { cn } from "@/lib/utils/cn";
import type { ComparisonResult } from "@/lib/api/comparison-service";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";
import type { RealtimeAlignmentSnapshot } from "@/lib/reading/realtime-alignment";

interface BookPageContentProps {
  selfCorrectedWordIds?: ReadonlySet<string>;
  unresolvedWordIds?: ReadonlySet<string>;
  uncertainWordIds?: ReadonlySet<string>;
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
  selfCorrectedWordIds,
  unresolvedWordIds,
  uncertainWordIds,
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
  const contentRef = useRef<HTMLDivElement>(null);
  const activeWordId = previewSnapshot
    ? previewSnapshot.currentWordId
    : currentWordId;
  useEffect(() => {
    const active = [
      ...(contentRef.current?.querySelectorAll<HTMLElement>("[data-word-id]") ??
        []),
    ].find((element) => element.dataset.wordId === activeWordId);
    active?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }, [activeWordId, page.page_revision_id]);
  const alignmentByIndex = new Map(
    comparisonResult?.alignment.map((item) => [item.book_index, item]),
  );
  const savedById = new Map(
    comparisonResult?.summary.initial_assessment?.map((item) => [
      item.word_id,
      item,
    ]),
  );
  const textTokens = [...(page.text ?? "").matchAll(/\S+/gu)];
  const textMatchesWords =
    textTokens.length === page.words.length &&
    textTokens.every(
      (match, index) =>
        match[0].normalize("NFC") === page.words[index].text.normalize("NFC"),
    );

  return (
    <div
      ref={contentRef}
      data-reading-panel="text"
      className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-card bg-white/70 p-3 shadow-inner sm:mt-6 sm:p-6"
    >
      {hasWords ? (
        <p className="text-[22px] font-extrabold leading-[1.8] text-ink sm:text-[28px] sm:leading-[1.6]">
          {page.words.map((word, index) => {
            const wordIndex = word.word_index ?? index;

            const initial = savedById.get(word.word_id);
            const alignment = initial
              ? {
                  status:
                    initial.status === "CORRECT"
                      ? "MATCH"
                      : initial.status === "MISPRONUNCIATION"
                        ? "SUBSTITUTE"
                        : initial.status === "OMISSION"
                          ? "DELETE"
                          : "UNCERTAIN",
                }
              : alignmentByIndex.get(wordIndex);

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

            const presentationState: WordPresentationState =
              selfCorrectedWordIds?.has(word.word_id)
                ? "self-corrected"
                : unresolvedWordIds?.has(word.word_id)
                  ? "unresolved"
                  : uncertainWordIds?.has(word.word_id) ||
                      initial?.status === "UNCERTAIN"
                    ? "uncertain"
                    : isSkipped
                      ? "omission"
                      : isMispronounced
                        ? "incorrect"
                        : isCorrect
                          ? "correct"
                          : isCurrent
                            ? "current"
                            : "unread";
            const statusClass = [
              "self-corrected",
              "unresolved",
              "uncertain",
            ].includes(presentationState)
              ? wordPresentationClasses[presentationState]
              : isSkipped
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
                {textMatchesWords ? (
                  Array.from(
                    {
                      length: Math.min(
                        2,
                        (
                          page
                            .text!.slice(
                              index === 0
                                ? 0
                                : textTokens[index - 1].index! +
                                    textTokens[index - 1][0].length,
                              textTokens[index].index,
                            )
                            .match(/\n/gu) ?? []
                        ).length,
                      ),
                    },
                    (_, breakIndex) => <br key={breakIndex} />,
                  )
                ) : (
                  <>
                    {startsLine ? <br /> : null}
                    {startsParagraph ? <br /> : null}
                  </>
                )}

                {isIndented ? (
                  <span
                    aria-hidden="true"
                    className="inline-block w-[1.25em]"
                  />
                ) : null}

                <span
                  className={cn(
                    "mr-2 inline-block scroll-mt-24 scroll-mb-40 rounded-[10px] px-2 py-0.5 transition-all duration-150",
                    !readOnly &&
                      "min-h-11 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
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
                  data-reading-state={presentationState}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-label={readOnly ? undefined : word.text}
                  aria-describedby={
                    readOnly
                      ? undefined
                      : `text-word-state-${page.page_revision_id}-${word.word_id}`
                  }
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
                  {!readOnly ? (
                    <span
                      hidden
                      id={`text-word-state-${page.page_revision_id}-${word.word_id}`}
                    >
                      {wordPresentationLabels[presentationState]}
                    </span>
                  ) : null}
                  {presentationState === "self-corrected" ? (
                    <span aria-hidden="true" className="ml-1 text-sm">
                      ↺
                    </span>
                  ) : null}
                  {presentationState === "unresolved" ? (
                    <span aria-hidden="true" className="ml-1 text-sm">
                      ◇
                    </span>
                  ) : null}
                  {presentationState === "uncertain" ? (
                    <span aria-hidden="true" className="ml-1 text-sm">
                      ?
                    </span>
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
