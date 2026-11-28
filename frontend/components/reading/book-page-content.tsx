"use client";

import { ArrowDown } from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { useTranslations } from "@/hooks/use-i18n";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import {
  computeUniversalPageWordLayout,
  type WordLayoutEntry,
} from "@/lib/reading/ocr-text-reflow";
import { useReadingAutoScroll } from "@/lib/reading/use-reading-auto-scroll";
import {
  getWordHighlightTier,
  wordPresentationClasses,
  type PageWordEvidence,
  type WordPresentationState,
  wordStateForPage,
} from "@/lib/reading/word-presentation";
import type {
  LucBatWordAnnotation,
  LucBatWordRole,
} from "@/lib/reading/luc-bat-cadence";

import { cn } from "@/lib/utils/cn";
import type { ReadingPageWordDTO } from "@/types/reading";

interface BookPageContentProps extends PageWordEvidence {
  spokenWords?: Set<string>;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  readOnly?: boolean;
  /** Optional instrumentation hook for render-count benchmarks. */
  onWordTokenRender?: (wordId: string) => void;
  /** Optional parent scroll container ref when hosted inside BookPageViewer. */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  /** Optional word node registrar when parent manages container auto-scroll. */
  registerWordNode?: (wordId: string, node: HTMLElement | null) => void;
  /** Optional Lục Bát 6-8 cadence & 6th-syllable rhyme annotations (zero extra DOM nodes). */
  lucBatAnnotations?: ReadonlyMap<string, LucBatWordAnnotation> | null;
}

interface WordTokenProps {
  readonly word: ReadingPageWordDTO;
  readonly pageRevisionId: string;
  readonly lineIndex: number;
  readonly breakCount: number;
  readonly isIndented: boolean;
  readonly presentationState: WordPresentationState;
  readonly stateLabel: string;
  readonly titleText?: string;
  readonly isCurrent: boolean;
  readonly readOnly: boolean;
  readonly lucBatRole?: LucBatWordRole;
  readonly lucBatCaesura?: boolean;
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
  stateLabel,
  titleText,
  isCurrent,
  readOnly,
  lucBatRole,
  lucBatCaesura,
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
          "relative me-1.5 inline-block scroll-mt-4 scroll-mb-6 rounded-control border-b-4 px-2 py-0.5 motion-reduce:transition-none",
          lucBatCaesura && "me-3.5",
          (lucBatRole === "rhyme6_luc" || lucBatRole === "rhyme6_bat") &&
            "underline decoration-amber-500 decoration-wavy underline-offset-4",
          lucBatRole === "rhyme8_bat" &&
            "underline decoration-emerald-600 decoration-dotted underline-offset-4",
          isCurrent || presentationState === "current"
            ? "transition-none"
            : "transition-[background-color,color,border-color,box-shadow] duration-75 ease-out",
          !readOnly &&
            "min-h-11 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
          !readOnly && "cursor-pointer select-none",
          wordPresentationClasses[presentationState],
          isCurrent &&
            presentationState !== "current" &&
            (presentationState === "incorrect"
              ? "shadow-xs"
              : "ring-2 ring-primary/45 shadow-xs"),
          isCurrent && presentationState === "current" && "shadow-xs",
          presentationState === "unread" &&
            !readOnly &&
            "hover:bg-highlight/40",
        )}
        data-bbox={word.bbox.join(",")}
        data-line-index={lineIndex}
        data-luc-bat-caesura={lucBatCaesura ? "true" : undefined}
        data-luc-bat-role={lucBatRole}
        data-page-revision-id={pageRevisionId}
        data-word-id={word.word_id}
        data-reading-state={presentationState}
        data-reading-tier={getWordHighlightTier(presentationState, isCurrent)}
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
        title={readOnly ? undefined : titleText}
        onKeyDown={readOnly ? undefined : handleKeyDown}
      >
        {word.text}
        {!readOnly ? (
          <span hidden id={`text-word-state-${pageRevisionId}-${word.word_id}`}>
            {stateLabel}
          </span>
        ) : null}
        {presentationState === "preview-correct" ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-600"
          />
        ) : null}
        {presentationState === "self-corrected" ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-2 -right-1 rounded-full bg-white/95 px-1 text-[10px] leading-tight text-green-900 shadow-2xs"
          >
            ↺
          </span>
        ) : null}
        {presentationState === "unresolved" ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-2 -right-1 rounded-full bg-white/95 px-1 text-[10px] leading-tight text-red-900 shadow-2xs"
          >
            ◇
          </span>
        ) : null}
        {presentationState === "uncertain" ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-2 -right-1 rounded-full bg-white/95 px-1 text-[10px] leading-tight text-slate-700 shadow-2xs"
          >
            ?
          </span>
        ) : null}
        {presentationState === "assisted" ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-2 -right-1 rounded-full bg-white/95 px-1 text-[10px] leading-tight text-primary shadow-2xs"
          >
            {"\u266A"}
          </span>
        ) : null}
      </span>{" "}
    </Fragment>
  );
});

export function BookPageContent(props: BookPageContentProps) {
  const t = useTranslations("reading");
  const teacherPersona = useTeacherPersona();
  const isMalePersona = teacherPersona.gender === "male";
  const {
    page,
    currentWordId,
    onWordClick,
    previewSnapshot,
    readOnly = false,
    onWordTokenRender,
    scrollContainerRef,
    registerWordNode,
    lucBatAnnotations = null,
  } = props;
  const stateFor = wordStateForPage(props);
  const hasWords = page.words.length > 0;
  const panelRef = useRef<HTMLDivElement>(null);
  const wordNodesRef = useRef(new Map<string, HTMLSpanElement>());
  const onWordClickRef = useRef(onWordClick);
  const registerWordNodeRef = useRef(registerWordNode);
  useEffect(() => {
    onWordClickRef.current = onWordClick;
    registerWordNodeRef.current = registerWordNode;
  }, [onWordClick, registerWordNode]);

  const registerNode = useCallback(
    (wordId: string, node: HTMLSpanElement | null) => {
      if (node) wordNodesRef.current.set(wordId, node);
      else wordNodesRef.current.delete(wordId);
      registerWordNodeRef.current?.(wordId, node);
    },
    [],
  );

  const reflow = useMemo(() => computeUniversalPageWordLayout(page), [page]);
  const layout: WordLayoutEntry[] = reflow.entries;

  const activeWordId = previewSnapshot
    ? previewSnapshot.currentWordId
    : currentWordId;
  const activeWordIdRef = useRef(activeWordId);
  useEffect(() => {
    activeWordIdRef.current = activeWordId;
  }, [activeWordId]);

  const isManagedByParent = Boolean(registerWordNode);
  const effectiveScrollRef = scrollContainerRef ?? panelRef;

  const getActiveWordNode = useCallback(
    () =>
      activeWordIdRef.current
        ? (wordNodesRef.current.get(activeWordIdRef.current) ?? null)
        : null,
    [],
  );

  const { isDetached, resumeAutoFollow } = useReadingAutoScroll({
    containerRef: effectiveScrollRef,
    getActiveElement: getActiveWordNode,
    activeWordId,
    pageKey: `${page.page_id}:${page.page_revision_id}`,
    enabled: !isManagedByParent && !readOnly,
  });

  const handleSelectWord = useCallback(
    (word: ReadingPageWordDTO) => {
      if (!isManagedByParent) {
        resumeAutoFollow();
      }
      onWordClickRef.current?.(word);
    },
    [isManagedByParent, resumeAutoFollow],
  );

  return (
    <div
      ref={panelRef}
      data-reading-panel="text"
      data-reflow-mode={reflow.mode}
      data-reading-scroll-container={
        !isManagedByParent && !scrollContainerRef ? "true" : undefined
      }
      data-auto-follow={
        !isManagedByParent ? (isDetached ? "paused" : "active") : undefined
      }
      className="min-h-0 flex-1 py-2"
    >
      {hasWords ? (
        <p
          className="viread-learning-content w-full max-w-[62ch] text-[24px] font-bold leading-[2] tracking-[0.01em] text-ink sm:text-[30px] sm:leading-[1.95]"
          dir="ltr"
          lang="vi"
        >
          {layout.map((entry) => {
            const pState = stateFor(entry.word, entry.index);
            const isCurr = activeWordId === entry.word.word_id;
            const stateLabel =
              pState === "assisted" && isMalePersona
                ? t("wordStates.assistedMale")
                : t(`wordStates.${pState}`);
            const titleText = readOnly
              ? undefined
              : isCurr && pState === "incorrect"
                ? t("pageContent.incorrectWordAria", { word: entry.word.text })
                : t("pageContent.tapToListenAria", { word: entry.word.text });
            const lb = lucBatAnnotations?.get(entry.word.word_id);
            return (
              <MemoWordToken
                key={entry.word.word_id}
                word={entry.word}
                pageRevisionId={page.page_revision_id}
                lineIndex={entry.lineIndex}
                breakCount={entry.breakCount}
                isIndented={entry.isIndented}
                presentationState={pState}
                stateLabel={stateLabel}
                titleText={titleText}
                isCurrent={isCurr}
                readOnly={readOnly}
                lucBatRole={lb?.role}
                lucBatCaesura={lb?.caesuraAfter}
                onSelectWord={handleSelectWord}
                registerNode={registerNode}
                onRender={onWordTokenRender}
              />
            );
          })}
        </p>
      ) : page.text ? (
        <p
          className="viread-learning-content whitespace-pre-wrap text-[22px] font-semibold leading-[1.8] text-ink sm:text-[26px]"
          dir="ltr"
          lang="vi"
        >
          {page.text}
        </p>
      ) : (
        <p className="text-body text-muted">{t("pageContent.loadingText")}</p>
      )}
      {!isManagedByParent && isDetached && activeWordId ? (
        <div className="pointer-events-none sticky bottom-3 z-20 flex h-0 justify-end overflow-visible">
          <button
            type="button"
            data-testid="resume-auto-follow-btn"
            onClick={resumeAutoFollow}
            className="pointer-events-auto inline-flex min-h-11 -translate-y-full items-center gap-1.5 rounded-full border border-primary/40 bg-primary px-3.5 py-2 text-xs font-bold text-white shadow-md hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <ArrowDown aria-hidden="true" className="size-4 shrink-0" />
            {t("pageContent.scrollToCurrentWord")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
