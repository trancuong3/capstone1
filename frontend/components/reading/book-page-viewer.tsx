"use client";

import { ArrowDown, BookOpen, Eye, Image as ImageIcon } from "lucide-react";
import Image from "next/image";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BookPageContent } from "@/components/reading/book-page-content";
import {
  fetchAuthenticatedBlobUrl,
  isPrivateApiMediaUrl,
  revokePrivateBlobUrl,
} from "@/lib/api/api-client";
import { isStudioAuthenticatedMediaUrl } from "@/lib/api/book-assets-service";
import { invalidateBrowserTokenCache } from "@/lib/api/browser-auth";
import { canOverlayPage, containImage } from "@/lib/reading/page-presentation";
import { useReadingAutoScroll } from "@/lib/reading/use-reading-auto-scroll";
import {
  getWordHighlightTier,
  getWordPresentationLabel,
  type WordPresentationState,
  type PageWordEvidence,
  wordStateForPage,
} from "@/lib/reading/word-presentation";
import { cn } from "@/lib/utils/cn";
import type { ReadingDisplayMode } from "@/types/book-assets";
import type { ReadingPageWordDTO } from "@/types/reading";

interface BookPageViewerProps extends PageWordEvidence {
  title?: string;
  illustration?: ReactNode;
  isTransitioning?: boolean;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  onRefreshImageUrl?: (pageId: string) => Promise<string | null | undefined>;
  spokenWords?: Set<string>;
  illustrationUrl?: string | null;
  illustrationTextFree?: boolean;
  initialReadingMode?: ReadingDisplayMode;
}

const OVERLAY_COLORS: Record<WordPresentationState, string> = {
  unread: "",
  current: "bg-yellow-300/25 ring-2 ring-amber-600 border-b-2 border-primary",
  "preview-correct":
    "bg-emerald-300/15 ring-1 ring-emerald-600/70 border-b-2 border-dashed border-emerald-600",
  correct:
    "bg-green-300/25 ring-1 ring-green-600 border-b-2 border-solid border-emerald-700",
  incorrect: "bg-red-300/25 ring-1 ring-red-600",
  repeated: "bg-purple-300/25 ring-1 ring-purple-600",
  hesitation: "bg-purple-300/25 ring-1 ring-purple-600",
  omission: "bg-red-300/25 ring-1 ring-red-600",
  "self-corrected": "bg-green-300/25 ring-2 ring-green-700 ring-offset-1",
  unresolved: "bg-red-300/25 ring-2 ring-red-700",
  assisted:
    "bg-sky-300/25 ring-2 ring-sky-600 border-b-2 border-dotted border-sky-700",
  uncertain: "bg-slate-300/20 ring-1 ring-slate-500",
};

interface OverlayWordButtonProps {
  readonly word: ReadingPageWordDTO;
  readonly pageRevisionId: string;
  readonly state: WordPresentationState;
  readonly isCurrent: boolean;
  readonly onSelectWord: (word: ReadingPageWordDTO) => void;
  readonly registerNode: (
    wordId: string,
    node: HTMLButtonElement | null,
  ) => void;
}

const MemoOverlayWordButton = memo(function OverlayWordButton({
  word,
  pageRevisionId,
  state,
  isCurrent,
  onSelectWord,
  registerNode,
}: OverlayWordButtonProps) {
  const handleRef = useCallback(
    (node: HTMLButtonElement | null) => registerNode(word.word_id, node),
    [registerNode, word.word_id],
  );
  const handleClick = useCallback(
    () => onSelectWord(word),
    [onSelectWord, word],
  );
  return (
    <button
      ref={handleRef}
      type="button"
      aria-label={word.text}
      aria-describedby={`image-word-state-${pageRevisionId}-${word.word_id}`}
      aria-current={isCurrent ? "true" : undefined}
      data-word-id={word.word_id}
      data-reading-state={state}
      data-reading-tier={getWordHighlightTier(state, isCurrent)}
      data-page-revision-id={pageRevisionId}
      data-bbox={word.bbox.join(",")}
      onClick={handleClick}
      className={cn(
        "absolute rounded-sm transition-colors duration-100 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
        OVERLAY_COLORS[state],
      )}
      style={{
        left: `${word.bbox[0] * 100}%`,
        top: `${word.bbox[1] * 100}%`,
        width: `${word.bbox[2] * 100}%`,
        height: `${word.bbox[3] * 100}%`,
      }}
    >
      <span className="sr-only">{word.text}</span>
      <span hidden id={`image-word-state-${pageRevisionId}-${word.word_id}`}>
        {getWordPresentationLabel(state)}
      </span>
      {[
        "preview-correct",
        "self-corrected",
        "unresolved",
        "uncertain",
        "incorrect",
        "omission",
        "assisted",
      ].includes(state) ? (
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-3 rounded-full bg-white px-1 text-xs font-semibold text-ink"
        >
          {state === "preview-correct"
            ? "·"
            : state === "self-corrected"
              ? "↺"
              : state === "uncertain"
                ? "?"
                : state === "unresolved"
                  ? "◇"
                  : state === "assisted"
                    ? "♪"
                    : "!"}
        </span>
      ) : null}
    </button>
  );
});

function isSafeIllustrationUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/\\")) {
    return null;
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://")
  ) {
    return trimmed;
  }
  return null;
}

export function BookPageViewer(props: BookPageViewerProps) {
  const refreshedPageIdsRef = useRef<Set<string>>(new Set());
  const claimExpiredImageRefresh = useCallback((pageId: string) => {
    if (refreshedPageIdsRef.current.has(pageId)) {
      return false;
    }
    refreshedPageIdsRef.current.add(pageId);
    return true;
  }, []);
  return (
    <PageSurface
      key={`${props.page.page_id}:${props.page.page_revision_id}:${props.page.image_url ?? "text"}`}
      claimExpiredImageRefresh={claimExpiredImageRefresh}
      {...props}
    />
  );
}

function PageSurface(
  props: BookPageViewerProps & {
    readonly claimExpiredImageRefresh: (pageId: string) => boolean;
  },
) {
  const {
    page,
    currentWordId,
    isTransitioning = false,
    onWordClick,
    onRefreshImageUrl,
    previewSnapshot,
    claimExpiredImageRefresh,
    illustrationUrl,
    illustrationTextFree,
    initialReadingMode,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const overlayNodesRef = useRef(new Map<string, HTMLButtonElement>());
  const textNodesRef = useRef(new Map<string, HTMLElement>());
  const onWordClickRef = useRef(onWordClick);
  useEffect(() => {
    onWordClickRef.current = onWordClick;
  });
  const registerOverlayNode = useCallback(
    (wordId: string, node: HTMLButtonElement | null) => {
      if (node) overlayNodesRef.current.set(wordId, node);
      else overlayNodesRef.current.delete(wordId);
    },
    [],
  );
  const registerTextNode = useCallback(
    (wordId: string, node: HTMLElement | null) => {
      if (node) textNodesRef.current.set(wordId, node);
      else textNodesRef.current.delete(wordId);
    },
    [],
  );
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState<
    { width: number; height: number } | "failed" | null
  >(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [refreshedImageUrl, setRefreshedImageUrl] = useState<string | null>(
    null,
  );
  const [privateRetryNonce, setPrivateRetryNonce] = useState(0);
  const privateRetriedRef = useRef(false);
  const [privateBlobUrl, setPrivateBlobUrl] = useState<string | null>(null);
  const activeImageUrl = refreshedImageUrl ?? page.image_url;
  const isPrivateSource = isPrivateApiMediaUrl(activeImageUrl);

  // V2 3-mode Storybook Reading state (preserves legacy behavior when V2 props omitted)
  const safeIllustrationUrl = isSafeIllustrationUrl(illustrationUrl);
  const hasVerifiedIllustration =
    Boolean(safeIllustrationUrl) && illustrationTextFree === true;
  const isV2ModeEnabled =
    illustrationUrl !== undefined || initialReadingMode !== undefined;
  const illustrationNeedsAuth =
    hasVerifiedIllustration &&
    isStudioAuthenticatedMediaUrl(safeIllustrationUrl);

  const [illustrationAuthState, setIllustrationAuthState] = useState<{
    src: string;
    blobUrl: string | null;
    failed: boolean;
  }>({ src: "", blobUrl: null, failed: false });
  const [failedDirectIllustration, setFailedDirectIllustration] = useState<
    string | null
  >(null);

  const defaultV2Mode: ReadingDisplayMode =
    initialReadingMode === "ORIGINAL"
      ? "ORIGINAL"
      : initialReadingMode === "TEXT"
        ? "TEXT"
        : hasVerifiedIllustration
          ? "ILLUSTRATED"
          : "TEXT";

  const [selectedReadingMode, setSelectedReadingMode] =
    useState<ReadingDisplayMode>(defaultV2Mode);

  useEffect(() => {
    if (!illustrationNeedsAuth || !safeIllustrationUrl) {
      return;
    }
    const controller = new AbortController();
    let createdBlob: string | null = null;
    let active = true;

    void fetchAuthenticatedBlobUrl(safeIllustrationUrl, controller.signal)
      .then((blobUrl) => {
        if (!active) {
          revokePrivateBlobUrl(blobUrl);
          return;
        }
        createdBlob = blobUrl;
        setIllustrationAuthState({
          src: safeIllustrationUrl,
          blobUrl,
          failed: false,
        });
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setIllustrationAuthState({
          src: safeIllustrationUrl,
          blobUrl: null,
          failed: true,
        });
      });

    return () => {
      active = false;
      controller.abort();
      if (createdBlob) {
        revokePrivateBlobUrl(createdBlob);
      }
    };
  }, [illustrationNeedsAuth, safeIllustrationUrl]);

  const resolvedIllustrationSrc = !hasVerifiedIllustration
    ? null
    : illustrationNeedsAuth
      ? illustrationAuthState.src === safeIllustrationUrl &&
        !illustrationAuthState.failed
        ? illustrationAuthState.blobUrl
        : null
      : failedDirectIllustration !== safeIllustrationUrl
        ? safeIllustrationUrl
        : null;

  const illustrationFailed =
    hasVerifiedIllustration &&
    (illustrationNeedsAuth
      ? illustrationAuthState.src === safeIllustrationUrl &&
        illustrationAuthState.failed
      : failedDirectIllustration === safeIllustrationUrl);

  const canShowIllustratedMode = hasVerifiedIllustration && !illustrationFailed;

  const effectiveReadingMode: ReadingDisplayMode =
    selectedReadingMode === "ILLUSTRATED" && !canShowIllustratedMode
      ? "TEXT"
      : selectedReadingMode === "ORIGINAL" && !activeImageUrl
        ? "TEXT"
        : selectedReadingMode;

  const shouldLoadOriginalSource =
    !isV2ModeEnabled || effectiveReadingMode === "ORIGINAL";

  useEffect(() => {
    if (!shouldLoadOriginalSource || !isPrivateSource || !activeImageUrl) {
      return;
    }
    const controller = new AbortController();
    let createdUrl: string | null = null;
    let cancelled = false;
    void fetchAuthenticatedBlobUrl(activeImageUrl, controller.signal)
      .then((blobUrl) => {
        if (cancelled) {
          revokePrivateBlobUrl(blobUrl);
          return;
        }
        createdUrl = blobUrl;
        setPrivateBlobUrl(blobUrl);
      })
      .catch(() => {
        if (!cancelled) {
          if (!privateRetriedRef.current) {
            privateRetriedRef.current = true;
            invalidateBrowserTokenCache();
            setPrivateRetryNonce((value) => value + 1);
            return;
          }
          setImage("failed");
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (createdUrl) {
        revokePrivateBlobUrl(createdUrl);
      }
      setPrivateBlobUrl(null);
    };
  }, [
    activeImageUrl,
    isPrivateSource,
    privateRetryNonce,
    shouldLoadOriginalSource,
  ]);

  const handleImageLoadError = useCallback(() => {
    if (isPrivateSource && !privateRetriedRef.current) {
      privateRetriedRef.current = true;
      invalidateBrowserTokenCache();
      setPrivateRetryNonce((value) => value + 1);
      return;
    }
    if (
      !isPrivateSource &&
      onRefreshImageUrl &&
      activeImageUrl &&
      claimExpiredImageRefresh(page.page_id)
    ) {
      void Promise.resolve(onRefreshImageUrl(page.page_id))
        .then((nextUrl) => {
          if (nextUrl && nextUrl !== activeImageUrl) {
            setImage(null);
            setRefreshedImageUrl(nextUrl);
            return;
          }
          setImage("failed");
        })
        .catch(() => setImage("failed"));
      return;
    }
    setImage("failed");
  }, [
    activeImageUrl,
    claimExpiredImageRefresh,
    isPrivateSource,
    onRefreshImageUrl,
    page.page_id,
  ]);

  let source: string | null = null;
  if (isPrivateSource) {
    source = privateBlobUrl;
  } else if (activeImageUrl) {
    try {
      const url = new URL(activeImageUrl);
      if (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
        source = activeImageUrl;
    } catch {
      /* Invalid source falls back to the verified text. */
    }
  }
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const width = root.getBoundingClientRect().width;
      const availableHeight = root.clientHeight;
      const defaultHeight = Math.min(window.innerHeight * 0.6, 680);
      const height =
        availableHeight > 120
          ? Math.max(160, Math.min(defaultHeight, availableHeight - 24))
          : defaultHeight;
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
    shouldLoadOriginalSource &&
    source !== null &&
    image !== null &&
    image !== "failed" &&
    canOverlayPage(page, rect, image.width, image.height);
  const legacyMode = overlay
    ? "image-overlay"
    : source && image !== "failed"
      ? "image-reference"
      : "text";
  const renderMode = isV2ModeEnabled
    ? effectiveReadingMode === "ILLUSTRATED"
      ? "illustrated"
      : effectiveReadingMode === "TEXT"
        ? "text"
        : legacyMode
    : legacyMode;

  const activeId = previewSnapshot
    ? previewSnapshot.currentWordId
    : currentWordId;

  const getActiveNode = useCallback(() => {
    if (!activeId) return null;
    if (overlay) {
      return overlayNodesRef.current.get(activeId) ?? null;
    }
    return textNodesRef.current.get(activeId) ?? null;
  }, [activeId, overlay]);

  const { isDetached, resumeAutoFollow } = useReadingAutoScroll({
    containerRef: rootRef,
    getActiveElement: getActiveNode,
    activeWordId: activeId,
    pageKey: `${page.page_id}:${page.page_revision_id}`,
  });

  const handleSelectWord = useCallback(
    (word: ReadingPageWordDTO) => {
      resumeAutoFollow();
      onWordClickRef.current?.(word);
    },
    [resumeAutoFollow],
  );

  const stateFor = wordStateForPage(props);
  return (
    <article
      aria-busy={isTransitioning || undefined}
      aria-label={`Trang sách ${page.page_number}`}
      className={cn(
        "reader-sheet mx-auto w-full min-w-0 max-w-[1104px]",
        isTransitioning && "opacity-60",
      )}
      data-page-id={page.page_id}
      data-page-revision-id={page.page_revision_id}
      data-render-mode={renderMode}
      data-reading-mode={isV2ModeEnabled ? effectiveReadingMode : undefined}
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
      <header className="reader-bookplate">
        <div className="min-w-0">
          <p className="reader-folio">Trang {page.page_number}</p>
          <h1 className="book-title line-clamp-1 break-words text-lg sm:line-clamp-none sm:text-3xl">
            {props.title ?? "Trang sách của bé"}
          </h1>
          {isV2ModeEnabled ? (
            <div
              aria-label="Chế độ đọc trang sách"
              className="mt-2 inline-flex flex-wrap items-center gap-1.5"
              data-testid="reading-mode-switcher"
              role="tablist"
            >
              {canShowIllustratedMode ? (
                <button
                  aria-selected={effectiveReadingMode === "ILLUSTRATED"}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-primary",
                    effectiveReadingMode === "ILLUSTRATED"
                      ? "border-primary bg-primary text-white shadow-xs"
                      : "border-border bg-white text-ink hover:bg-canvas",
                  )}
                  onClick={() => setSelectedReadingMode("ILLUSTRATED")}
                  role="tab"
                  type="button"
                >
                  <ImageIcon aria-hidden="true" className="size-3.5" />
                  Minh họa
                </button>
              ) : null}
              <button
                aria-selected={effectiveReadingMode === "TEXT"}
                className={cn(
                  "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-primary",
                  effectiveReadingMode === "TEXT"
                    ? "border-primary bg-primary text-white shadow-xs"
                    : "border-border bg-white text-ink hover:bg-canvas",
                )}
                onClick={() => setSelectedReadingMode("TEXT")}
                role="tab"
                type="button"
              >
                <BookOpen aria-hidden="true" className="size-3.5" />
                Đọc chữ
              </button>
              {activeImageUrl ? (
                <button
                  aria-selected={effectiveReadingMode === "ORIGINAL"}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-primary",
                    effectiveReadingMode === "ORIGINAL"
                      ? "border-primary bg-primary text-white shadow-xs"
                      : "border-border bg-white text-ink hover:bg-canvas",
                  )}
                  onClick={() => setSelectedReadingMode("ORIGINAL")}
                  role="tab"
                  type="button"
                >
                  <Eye aria-hidden="true" className="size-3.5" />
                  Trang gốc đối chiếu
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {props.illustration}
      </header>
      <div
        ref={rootRef}
        className="reader-leaf w-full min-w-0"
        data-reading-scroll-container="true"
        data-auto-follow={isDetached ? "paused" : "active"}
        tabIndex={0}
      >
        {shouldLoadOriginalSource && source && image !== "failed" ? (
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
            onError={handleImageLoadError}
          />
        ) : null}

        {isV2ModeEnabled && effectiveReadingMode === "ILLUSTRATED" ? (
          <div className="flex flex-col gap-4" data-reading-panel="illustrated">
            {resolvedIllustrationSrc ? (
              <figure
                className="overflow-hidden rounded-card border border-border/80 bg-cream/70 p-2 shadow-xs"
                data-testid="storybook-illustration-card"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={`Tranh minh họa trang ${page.page_number}`}
                  className="mx-auto h-auto max-h-[28dvh] w-auto max-w-full rounded-control object-contain sm:max-h-[38dvh]"
                  onError={() => {
                    if (illustrationNeedsAuth && safeIllustrationUrl) {
                      setIllustrationAuthState({
                        src: safeIllustrationUrl,
                        blobUrl: null,
                        failed: true,
                      });
                    } else if (safeIllustrationUrl) {
                      setFailedDirectIllustration(safeIllustrationUrl);
                    }
                  }}
                  src={resolvedIllustrationSrc}
                />
              </figure>
            ) : (
              <div
                aria-busy="true"
                className="h-44 w-full animate-pulse rounded-card bg-cream"
                data-testid="storybook-illustration-loading"
              />
            )}
            <BookPageContent
              {...props}
              onWordClick={handleSelectWord}
              registerWordNode={registerTextNode}
              scrollContainerRef={rootRef}
            />
          </div>
        ) : isV2ModeEnabled && effectiveReadingMode === "TEXT" ? (
          <BookPageContent
            {...props}
            onWordClick={handleSelectWord}
            registerWordNode={registerTextNode}
            scrollContainerRef={rootRef}
          />
        ) : overlay && rect && source ? (
          <div
            className="relative mt-1 w-full overflow-hidden"
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
              onError={handleImageLoadError}
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
              {page.words.map((word, index) => (
                <MemoOverlayWordButton
                  key={word.word_id}
                  word={word}
                  pageRevisionId={page.page_revision_id}
                  state={stateFor(word, index)}
                  isCurrent={word.word_id === activeId}
                  onSelectWord={handleSelectWord}
                  registerNode={registerOverlayNode}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
            {source && image !== "failed" ? (
              isV2ModeEnabled && effectiveReadingMode === "ORIGINAL" ? (
                <div
                  className="mb-3 rounded-control border border-border bg-white/80 p-2"
                  data-testid="original-page-reference-panel"
                >
                  <p className="mb-1.5 text-xs font-semibold text-muted">
                    Ảnh trang gốc (đối chiếu)
                  </p>
                  <Image
                    src={source}
                    alt={`Ảnh trang gốc trang ${page.page_number}`}
                    width={Math.max(1, page.width)}
                    height={Math.max(1, page.height)}
                    unoptimized
                    className="mx-auto h-auto max-h-[42dvh] w-auto max-w-full object-contain"
                    onError={handleImageLoadError}
                  />
                </div>
              ) : (
                <details
                  onToggle={(event) =>
                    setReferenceOpen(event.currentTarget.open)
                  }
                  className="mb-2 rounded-control border border-border bg-white/70 p-1.5"
                >
                  <summary className="min-h-11 cursor-pointer px-2 py-2.5 text-sm font-semibold text-primary">
                    Xem ảnh trang sách
                  </summary>
                  {referenceOpen ? (
                    <Image
                      src={source}
                      alt={`Ảnh tham khảo trang ${page.page_number}`}
                      width={Math.max(1, page.width)}
                      height={Math.max(1, page.height)}
                      unoptimized
                      className="mx-auto h-auto max-h-[42dvh] w-auto max-w-full object-contain"
                      onError={handleImageLoadError}
                    />
                  ) : null}
                </details>
              )
            ) : null}
            <BookPageContent
              {...props}
              onWordClick={handleSelectWord}
              registerWordNode={registerTextNode}
              scrollContainerRef={rootRef}
            />
          </>
        )}
        {isDetached && activeId ? (
          <div className="pointer-events-none sticky bottom-3 z-20 flex h-0 justify-end overflow-visible">
            <button
              type="button"
              data-testid="resume-auto-follow-btn"
              onClick={resumeAutoFollow}
              className="pointer-events-auto inline-flex min-h-11 -translate-y-full items-center gap-1.5 rounded-full border border-primary/40 bg-primary px-3.5 py-2 text-xs font-bold text-white shadow-md hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <ArrowDown aria-hidden="true" className="size-4 shrink-0" />
              Về từ đang đọc
            </button>
          </div>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        Từ hiện tại:{" "}
        {page.words.find((word) => word.word_id === activeId)?.text}
      </p>
    </article>
  );
}
