"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  computeUniversalPageWordLayout,
  type WordLayoutEntry,
} from "@/lib/reading/ocr-text-reflow";
import {
  wordPresentationClasses,
  wordPresentationLabels,
  type PageWordEvidence,
  type WordPresentationState,
  wordStateForPage,
} from "@/lib/reading/word-presentation";

import { cn } from "@/lib/utils/cn";
import type { ReadingPageWordDTO } from "@/types/reading";

interface BookPageContentProps extends PageWordEvidence {
  spokenWords?: Set<string>;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  readOnly?: boolean;
  /** Optional instrumentation hook for render-count benchmarks. */
  onWordTokenRender?: (wordId: string) => void;
}

interface WordTokenProps {
  readonly word: ReadingPageWordDTO;
  readonly pageRevisionId: string;
  readonly lineIndex: number;
  readonly breakCount: number;
  readonly isIndented: boolean;
  readonly presentationState: WordPresentationState;
  readonly isCurrent: boolean;
  readonly readOnly: boolean;
  readonly onSelectWord: (word: ReadingPageWordDTO) => void;
  readonly registerNode: (wordId: string, node: HTMLSpanElement | null) => void;
  readonly onRender?: (wordId: string) => void;
}

const MemoWordToken = memo(function WordToken({
  word,
  pageRevisionId,
  lineIndex,
  breakCount,
  isIndented,
  presentationState,
  isCurrent,
  readOnly,
  onSelectWord,
  registerNode,
  onRender,
}: WordTokenProps) {
  onRender?.(word.word_id);
  const handleRef = useCallback(
    (node: HTMLSpanElement | null) => registerNode(word.word_id, node),
    [registerNode, word.word_id],
  );
  const handleClick = useCallback(() => {
    if (!readOnly) onSelectWord(word);
  }, [onSelectWord, readOnly, word]);
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLSpanElement>) => {
      if (readOnly) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelectWord(word);
      }
    },
    [onSelectWord, readOnly, word],
  );

  return (
    <Fragment>
      {breakCount >= 1 ? <br /> : null}
      {breakCount >= 2 ? <br /> : null}
      {isIndented ? (
        <span aria-hidden="true" className="inline-block w-[1.25em]" />
      ) : null}
      <span
        ref={handleRef}
        className={cn(
          "mr-1.5 inline-block scroll-mt-24 scroll-mb-40 rounded-control px-2 py-0.5 transition-[background-color,color,border-color,box-shadow] duration-200 ease-out motion-reduce:transition-none",
          !readOnly &&
            "min-h-11 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
          !readOnly && "cursor-pointer select-none",
          wordPresentationClasses[presentationState],
          isCurrent && "font-semibold ring-2 ring-primary/45 shadow-xs",
          presentationState === "incorrect" &&
            "font-semibold border-b-2 border-red-500",
          presentationState === "unread" &&
            !readOnly &&
            "hover:bg-highlight/40",
        )}
        data-bbox={word.bbox.join(",")}
        data-line-index={lineIndex}
        data-page-revision-id={pageRevisionId}
        data-word-id={word.word_id}
        data-reading-state={presentationState}
        aria-current={isCurrent ? "true" : undefined}
        aria-label={readOnly ? undefined : word.text}
        aria-describedby={
          readOnly
            ? undefined
            : `text-word-state-${pageRevisionId}-${word.word_id}`
        }
        onClick={readOnly ? undefined : handleClick}
        role={readOnly ? undefined : "button"}
        tabIndex={readOnly ? undefined : 0}
        title={
          readOnly
            ? undefined
            : isCurrent && presentationState === "incorrect"
              ? `Chưa chính xác: "${word.text}". Bé đọc lại từ này nhé.`
              : `Bấm để nghe đọc mẫu chữ: "${word.text}"`
        }
        onKeyDown={readOnly ? undefined : handleKeyDown}
      >
        {word.text}
        {!readOnly ? (
          <span hidden id={`text-word-state-${pageRevisionId}-${word.word_id}`}>
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
      </span>{" "}
    </Fragment>
  );
});

export function BookPageContent(props: BookPageContentProps) {
  const {
    page,
    currentWordId,
    onWordClick,
    previewSnapshot,
    readOnly = false,
    onWordTokenRender,
  } = props;
  const stateFor = wordStateForPage(props);
  const hasWords = page.words.length > 0;
  const wordNodesRef = useRef(new Map<string, HTMLSpanElement>());
  const onWordClickRef = useRef(onWordClick);
  useEffect(() => {
    onWordClickRef.current = onWordClick;
  });

  const handleSelectWord = useCallback((word: ReadingPageWordDTO) => {
    onWordClickRef.current?.(word);
  }, []);

  const registerNode = useCallback(
    (wordId: string, node: HTMLSpanElement | null) => {
      if (node) wordNodesRef.current.set(wordId, node);
      else wordNodesRef.current.delete(wordId);
    },
    [],
  );

  const reflow = useMemo(() => computeUniversalPageWordLayout(page), [page]);
  const layout: WordLayoutEntry[] = reflow.entries;

  const activeWordId = previewSnapshot
    ? previewSnapshot.currentWordId
    : currentWordId;

  useEffect(() => {
    if (!activeWordId) return;
    const active = wordNodesRef.current.get(activeWordId);
    active?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }, [activeWordId, page.page_revision_id]);

  return (
    <div
      data-reading-panel="text"
      data-reflow-mode={reflow.mode}
      className="mt-4 min-h-0 flex-1 py-3 sm:mt-6 sm:py-2"
    >
      {hasWords ? (
        <p className="w-full max-w-[58ch] text-[24px] font-bold leading-[2] tracking-[0.01em] text-ink sm:text-[30px] sm:leading-[1.9]">
          {layout.map((entry) => (
            <MemoWordToken
              key={entry.word.word_id}
              word={entry.word}
              pageRevisionId={page.page_revision_id}
              lineIndex={entry.lineIndex}
              breakCount={entry.breakCount}
              isIndented={entry.isIndented}
              presentationState={stateFor(entry.word, entry.index)}
              isCurrent={activeWordId === entry.word.word_id}
              readOnly={readOnly}
              onSelectWord={handleSelectWord}
              registerNode={registerNode}
              onRender={onWordTokenRender}
            />
          ))}
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
