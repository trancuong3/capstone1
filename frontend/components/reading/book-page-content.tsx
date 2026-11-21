"use client";

import { Fragment, useEffect, useRef } from "react";
import {
  wordPresentationClasses,
  wordPresentationLabels,
  type PageWordEvidence,
  wordStateForPage,
} from "@/lib/reading/word-presentation";

import { cn } from "@/lib/utils/cn";
import type { ReadingPageWordDTO } from "@/types/reading";

interface BookPageContentProps extends PageWordEvidence {
  spokenWords?: Set<string>;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  readOnly?: boolean;
}

export function BookPageContent(props: BookPageContentProps) {
  const {
    page,
    currentWordId,
    onWordClick,
    previewSnapshot,
    readOnly = false,
  } = props;
  const stateFor = wordStateForPage(props);
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
      className="mt-4 min-h-0 flex-1 py-3 sm:mt-6 sm:py-2"
    >
      {hasWords ? (
        <p className="text-balance text-[24px] font-bold leading-[2] text-ink sm:text-[30px] sm:leading-[1.85]">
          {page.words.map((word, index) => {
            const isCurrent = activeWordId === word.word_id;
            const presentationState = stateFor(word, index);
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
                    "mr-2 inline-block scroll-mt-24 scroll-mb-40 rounded-control px-2 py-0.5 transition-colors duration-150",
                    !readOnly &&
                      "min-h-11 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    !readOnly && "cursor-pointer select-none",
                    wordPresentationClasses[presentationState],
                    isCurrent && "scale-105 font-semibold shadow-sm",
                    presentationState === "incorrect" &&
                      "font-semibold border-b-2 border-red-500",
                    presentationState === "unread" &&
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
                      : isCurrent && presentationState === "incorrect"
                        ? `Chưa chính xác: "${word.text}". Bé đọc lại từ này nhé.`
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
                  {presentationState === "assisted" ? (
                    <span aria-hidden="true" className="ml-1 text-sm">
                      {"\u266A"}
                    </span>
                  ) : null}
                </span>
              </Fragment>
            );
          })}
        </p>
      ) : page.text ? (
        <p className="whitespace-pre-wrap text-[22px] font-semibold leading-[1.8] text-ink sm:text-[26px]">
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
