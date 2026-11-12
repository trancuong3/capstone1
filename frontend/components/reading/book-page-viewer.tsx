"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { BookPageContent } from "@/components/reading/book-page-content";
import { canOverlayPage, containImage } from "@/lib/reading/page-presentation";
import {
  wordPresentationLabels,
  type WordPresentationState,
} from "@/lib/reading/word-presentation";
import { cn } from "@/lib/utils/cn";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";
import type { ComparisonResult } from "@/lib/api/comparison-service";
import type { RealtimeAlignmentSnapshot } from "@/lib/reading/realtime-alignment";

interface BookPageViewerProps {
  correctWordIds?: Set<string>;
  currentWordId: string | null;
  isTransitioning?: boolean;
  mispronouncedWordIds?: Set<string>;
  skippedWordIds?: Set<string>;
  repeatedWordIds?: Set<string>;
  hesitationWordIds?: Set<string>;
  selfCorrectedWordIds?: ReadonlySet<string>;
  unresolvedWordIds?: ReadonlySet<string>;
  uncertainWordIds?: ReadonlySet<string>;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  page: ReadingPageDTO;
  comparisonResult?: ComparisonResult | null;
  spokenWords?: Set<string>;
  previewSnapshot?: RealtimeAlignmentSnapshot | null;
}

export function BookPageViewer(props: BookPageViewerProps) {
  return (
    <PageSurface
      key={`${props.page.page_id}:${props.page.page_revision_id}:${props.page.image_url ?? "text"}`}
      {...props}
    />
  );
}

function PageSurface(props: BookPageViewerProps) {
  const {
    page,
    currentWordId,
    isTransitioning = false,
    onWordClick,
    previewSnapshot,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState<
    { width: number; height: number } | "failed" | null
  >(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  let source: string | null = null;
  if (page.image_url) {
    try {
      const url = new URL(page.image_url);
      if (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
        source = page.image_url;
    } catch {
      /* Invalid source falls back to the verified text. */
    }
  }
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const width = root.getBoundingClientRect().width;
      const height = Math.min(window.innerHeight * 0.6, 680);
      setFrame((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const rect = containImage(page.width, page.height, frame.width, frame.height);
  const overlay =
    source !== null &&
    image !== null &&
    image !== "failed" &&
    canOverlayPage(page, rect, image.width, image.height);
  const mode = overlay
    ? "image-overlay"
    : source && image !== "failed"
      ? "image-reference"
      : "text";
  const activeId = previewSnapshot
    ? previewSnapshot.currentWordId
    : currentWordId;
  useEffect(() => {
    if (!overlay) return;
    const active = [
      ...(rootRef.current?.querySelectorAll<HTMLElement>("[data-word-id]") ??
        []),
    ].find((element) => element.dataset.wordId === activeId);
    active?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }, [activeId, overlay]);

  function stateFor(word: ReadingPageWordDTO): WordPresentationState {
    const id = word.word_id;
    const preview = previewSnapshot?.statusByWordId.get(id)?.status;
    if (props.selfCorrectedWordIds?.has(id)) return "self-corrected";
    if (props.unresolvedWordIds?.has(id)) return "unresolved";
    if (props.uncertainWordIds?.has(id)) return "uncertain";
    if (props.skippedWordIds?.has(id) || preview === "DELETE")
      return "omission";
    if (props.mispronouncedWordIds?.has(id) || preview === "SUBSTITUTE")
      return "incorrect";
    if (
      props.correctWordIds?.has(id) ||
      preview === "MATCH" ||
      previewSnapshot?.previewMatchedWordIds.has(id)
    )
      return "correct";
    return id === activeId ? "current" : "unread";
  }
  const overlayColors: Record<WordPresentationState, string> = {
    unread: "",
    current: "bg-yellow-300/25 ring-2 ring-yellow-500",
    correct: "bg-green-300/25 ring-1 ring-green-600",
    incorrect: "bg-orange-300/25 ring-1 ring-orange-600",
    omission: "bg-red-300/25 ring-1 ring-red-600",
    "self-corrected": "bg-green-300/25 ring-2 ring-green-700 ring-offset-1",
    unresolved: "bg-red-300/25 ring-2 ring-red-700",
    uncertain: "bg-slate-300/20 ring-1 ring-slate-500",
  };
  return (
    <article
      aria-busy={isTransitioning || undefined}
      aria-label={`Trang sách ${page.page_number}`}
      className={cn(
        "mx-auto w-full min-w-0 max-w-[1008px] rounded-card border border-border bg-cream p-3 shadow-sm sm:p-6",
        isTransitioning && "opacity-60",
      )}
      data-page-id={page.page_id}
      data-page-revision-id={page.page_revision_id}
      data-render-mode={mode}
      data-image-status={
        image === "failed"
          ? "failed"
          : image
            ? "loaded"
            : source
              ? "loading"
              : "none"
      }
    >
      <header className="flex items-center justify-between gap-3 text-sm font-semibold text-muted">
        <span>Trang sách của bé</span>
        <span>Trang {page.page_number}</span>
      </header>
      <div ref={rootRef} className="w-full min-w-0">
        {source && image !== "failed" ? (
          <Image
            key={source}
            alt=""
            aria-hidden="true"
            data-page-image-probe="true"
            src={source}
            width={Math.max(1, page.width)}
            height={Math.max(1, page.height)}
            className="hidden"
            loading="eager"
            unoptimized
            onLoad={(event) => {
              const target = event.currentTarget;
              setImage({
                width: target.naturalWidth,
                height: target.naturalHeight,
              });
            }}
            onError={() => setImage("failed")}
          />
        ) : null}
        {overlay && rect && source ? (
          <div
            className="relative mt-4 w-full"
            style={{ height: frame.height }}
            data-reading-panel="image"
          >
            <Image
              src={source}
              alt={`Ảnh trang sách ${page.page_number}`}
              fill
              unoptimized
              className="object-contain"
              sizes="(max-width: 768px) 100vw, 1008px"
              onError={() => setImage("failed")}
            />
            <div
              className="absolute"
              data-image-overlay="true"
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }}
            >
              {page.words.map((word) => {
                const state = stateFor(word);
                return (
                  <button
                    key={word.word_id}
                    type="button"
                    aria-label={word.text}
                    aria-describedby={`image-word-state-${page.page_revision_id}-${word.word_id}`}
                    aria-current={
                      word.word_id === activeId ? "true" : undefined
                    }
                    data-word-id={word.word_id}
                    data-reading-state={state}
                    data-page-revision-id={page.page_revision_id}
                    data-bbox={word.bbox.join(",")}
                    onClick={() => onWordClick?.(word)}
                    className={cn(
                      "absolute rounded-sm focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      overlayColors[state],
                      word.word_id === activeId && "ring-2 ring-yellow-500",
                    )}
                    style={{
                      left: `${word.bbox[0] * 100}%`,
                      top: `${word.bbox[1] * 100}%`,
                      width: `${word.bbox[2] * 100}%`,
                      height: `${word.bbox[3] * 100}%`,
                    }}
                  >
                    <span className="sr-only">{word.text}</span>
                    <span
                      hidden
                      id={`image-word-state-${page.page_revision_id}-${word.word_id}`}
                    >
                      {wordPresentationLabels[state]}
                    </span>
                    {[
                      "self-corrected",
                      "unresolved",
                      "uncertain",
                      "incorrect",
                      "omission",
                    ].includes(state) ? (
                      <span
                        aria-hidden="true"
                        className="absolute -right-1 -top-3 rounded-full bg-white px-1 text-xs font-extrabold text-ink"
                      >
                        {state === "self-corrected"
                          ? "↺"
                          : state === "uncertain"
                            ? "?"
                            : state === "unresolved"
                              ? "◇"
                              : "!"}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            {source && image !== "failed" ? (
              <details
                onToggle={(event) => setReferenceOpen(event.currentTarget.open)}
                className="mt-3 rounded-control border border-border bg-white/60 p-2"
              >
                <summary className="min-h-11 cursor-pointer px-2 py-3 font-semibold text-primary">
                  Xem ảnh trang sách
                </summary>
                {referenceOpen ? (
                  <Image
                    src={source}
                    alt={`Ảnh tham khảo trang ${page.page_number}`}
                    width={Math.max(1, page.width)}
                    height={Math.max(1, page.height)}
                    unoptimized
                    className="mx-auto h-auto max-h-[55dvh] w-auto max-w-full object-contain"
                    onError={() => setImage("failed")}
                  />
                ) : null}
              </details>
            ) : null}
            <BookPageContent {...props} />
          </>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        Từ hiện tại:{" "}
        {page.words.find((word) => word.word_id === activeId)?.text}
      </p>
    </article>
  );
}
