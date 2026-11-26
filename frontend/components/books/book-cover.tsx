"use client";

import { BookOpen, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  fetchAuthenticatedBlobUrl,
  revokePrivateBlobUrl,
} from "@/lib/api/api-client";
import { isStudioAuthenticatedMediaUrl } from "@/lib/api/book-assets-service";
import { invalidateBrowserTokenCache } from "@/lib/api/browser-auth";
import { cn } from "@/lib/utils/cn";
import type { BookListItemDTO } from "@/types/book";
import type { AssetSourceType } from "@/types/book-assets";

interface CoverPalette {
  readonly id: string;
  readonly bg: string;
  readonly spine: string;
  readonly badgeBg: string;
  readonly accent: string;
  readonly ink: string;
}

const METADATA_PALETTES: readonly CoverPalette[] = [
  {
    id: "warm-sunrise",
    bg: "linear-gradient(155deg, #FFF5E6 0%, #FFE4C4 100%)",
    spine: "#E76F51",
    badgeBg: "rgba(231, 111, 81, 0.14)",
    accent: "#B84A27",
    ink: "#3C1E10",
  },
  {
    id: "meadow-leaf",
    bg: "linear-gradient(155deg, #EDF9F3 0%, #D1F0E0 100%)",
    spine: "#2D9A6B",
    badgeBg: "rgba(45, 154, 107, 0.15)",
    accent: "#1B6B4D",
    ink: "#123A2B",
  },
  {
    id: "sky-voyage",
    bg: "linear-gradient(155deg, #ECF6FF 0%, #D4E9FF 100%)",
    spine: "#2F80ED",
    badgeBg: "rgba(47, 128, 237, 0.14)",
    accent: "#1D4E89",
    ink: "#122B4A",
  },
  {
    id: "honey-star",
    bg: "linear-gradient(155deg, #FFFBE8 0%, #FCE8B2 100%)",
    spine: "#D99B26",
    badgeBg: "rgba(217, 155, 38, 0.18)",
    accent: "#8C5A00",
    ink: "#3E2900",
  },
  {
    id: "berry-story",
    bg: "linear-gradient(155deg, #FDF1F6 0%, #F9D7E5 100%)",
    spine: "#D65B88",
    badgeBg: "rgba(214, 91, 136, 0.15)",
    accent: "#8E294F",
    ink: "#421124",
  },
  {
    id: "lotus-teal",
    bg: "linear-gradient(155deg, #EBF8F8 0%, #CDEEEE 100%)",
    spine: "#218C8D",
    badgeBg: "rgba(33, 140, 141, 0.15)",
    accent: "#165C63",
    ink: "#0E353A",
  },
];

function pickDeterministicPalette(seed: string): CoverPalette {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const index = Math.abs(hash) % METADATA_PALETTES.length;
  return METADATA_PALETTES[index] ?? METADATA_PALETTES[0];
}

function buildVietnameseMonogram(title: string): string {
  const words = title.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "VR";
  if (words.length === 1) {
    return Array.from(words[0]).slice(0, 2).join("").toLocaleUpperCase("vi");
  }
  const first = Array.from(words[0])[0] ?? "";
  const second = Array.from(words[1])[0] ?? "";
  return `${first}${second}`.toLocaleUpperCase("vi");
}

function formatBookGrade(
  book: BookListItemDTO,
  overrideGrade?: string | null,
): string {
  if (overrideGrade && overrideGrade.trim()) {
    return overrideGrade.trim();
  }
  if (book.min_grade === book.max_grade) {
    return `Lớp ${book.min_grade}`;
  }
  return `Lớp ${book.min_grade}–${book.max_grade}`;
}

function isSafeImageSrc(url: string | null | undefined): string | null {
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

export interface BookCoverProps {
  book: BookListItemDTO;
  className?: string;
  hero?: boolean;
  titleAsHeading?: boolean;
  showTitle?: boolean;
  size?: "default" | "medium" | "small";
  coverUrl?: string | null;
  author?: string | null;
  grade?: string | null;
  coverSourceType?: AssetSourceType | null;
}

export function BookCover({
  book,
  className,
  hero = false,
  titleAsHeading = false,
  showTitle = true,
  size = "default",
  coverUrl,
  author,
  grade,
  coverSourceType,
}: BookCoverProps) {
  const candidateFromBook = (
    book as BookListItemDTO & { cover_url?: string | null }
  ).cover_url;
  const requestedUrl = isSafeImageSrc(coverUrl ?? candidateFromBook ?? null);
  const needsAuth = isStudioAuthenticatedMediaUrl(requestedUrl);

  const retriedSrcRef = useRef<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [authState, setAuthState] = useState<{
    src: string;
    blobUrl: string | null;
    failed: boolean;
  }>({ src: "", blobUrl: null, failed: false });
  const [failedDirectUrl, setFailedDirectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!needsAuth || !requestedUrl) {
      return;
    }

    const controller = new AbortController();
    let createdBlob: string | null = null;
    let active = true;

    void fetchAuthenticatedBlobUrl(requestedUrl, controller.signal)
      .then((blobUrl) => {
        if (!active) {
          revokePrivateBlobUrl(blobUrl);
          return;
        }
        createdBlob = blobUrl;
        setAuthState({ src: requestedUrl, blobUrl, failed: false });
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        if (retriedSrcRef.current !== requestedUrl) {
          retriedSrcRef.current = requestedUrl;
          invalidateBrowserTokenCache();
          setRetryNonce((value) => value + 1);
          return;
        }
        setAuthState({ src: requestedUrl, blobUrl: null, failed: true });
      });

    return () => {
      active = false;
      controller.abort();
      if (createdBlob) {
        revokePrivateBlobUrl(createdBlob);
      }
    };
  }, [needsAuth, requestedUrl, retryNonce]);

  const resolvedImageSrc =
    requestedUrl && needsAuth
      ? authState.src === requestedUrl && !authState.failed
        ? authState.blobUrl
        : null
      : requestedUrl && failedDirectUrl !== requestedUrl
        ? requestedUrl
        : null;

  const hasRenderableCoverImage = Boolean(resolvedImageSrc);
  const effectiveSource: AssetSourceType = hasRenderableCoverImage
    ? coverSourceType && coverSourceType !== "METADATA_RENDER"
      ? coverSourceType
      : "USER_UPLOAD"
    : "METADATA_RENDER";

  const palette = pickDeterministicPalette(`${book.id}:${book.title}`);
  const displayTitle = book.title.normalize("NFC").trim() || "Sách đọc ViRead";
  const displayAuthor = (author ?? book.author ?? "").normalize("NFC").trim();
  const displayGrade = formatBookGrade(book, grade);
  const monogram = buildVietnameseMonogram(displayTitle);
  const compact = size !== "default";
  const coverDimensions =
    size === "small"
      ? { width: 56, height: 80 }
      : size === "medium"
        ? { width: 112, height: 144 }
        : undefined;

  const handleImageError = () => {
    if (!requestedUrl) return;
    if (needsAuth) {
      if (retriedSrcRef.current !== requestedUrl) {
        retriedSrcRef.current = requestedUrl;
        invalidateBrowserTokenCache();
        setRetryNonce((value) => value + 1);
        return;
      }
      setAuthState({ src: requestedUrl, blobUrl: null, failed: true });
      return;
    }
    setFailedDirectUrl(requestedUrl);
  };

  if (hasRenderableCoverImage && resolvedImageSrc) {
    if (hero) {
      return (
        <div
          className={cn(
            "relative h-[205px] w-full overflow-hidden rounded-control bg-cream",
            className,
          )}
          data-cover-source={effectiveSource}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={`Ảnh bìa sách ${displayTitle}`}
            className="h-full w-full object-cover"
            onError={handleImageError}
            src={resolvedImageSrc}
          />
          {effectiveSource === "AI_GENERATED" ? (
            <span
              className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-bold text-ink shadow-xs"
              data-testid="book-cover-ai-badge"
            >
              <Sparkles aria-hidden="true" className="size-3 text-primary" />
              Bìa AI
            </span>
          ) : null}
        </div>
      );
    }

    return (
      <div
        className={cn(
          "relative flex w-full flex-col overflow-hidden rounded-card border border-border bg-cream",
          compact ? "shrink-0" : "h-[260px]",
          className,
        )}
        data-cover-source={effectiveSource}
        style={coverDimensions}
      >
        <div className="relative min-h-0 flex-1 w-full overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={`Ảnh bìa sách ${displayTitle}`}
            className="h-full w-full object-cover"
            onError={handleImageError}
            src={resolvedImageSrc}
          />
        </div>
        {showTitle && !compact ? (
          <div className="bg-white/95 px-3 py-2 text-center">
            {titleAsHeading ? (
              <h2 className="line-clamp-2 text-base font-extrabold leading-snug text-ink">
                {displayTitle}
              </h2>
            ) : (
              <p className="line-clamp-2 text-base font-extrabold leading-snug text-ink">
                {displayTitle}
              </p>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  // Deterministic Vietnamese Unicode typography metadata cover fallback
  // Never falsely labeled as AI-generated, and renders title at most once (zero duplicated title!).
  if (hero) {
    return (
      <div
        aria-hidden="true"
        className={cn(
          "relative flex h-[205px] w-full overflow-hidden rounded-control border border-black/5 shadow-xs",
          className,
        )}
        data-cover-palette={palette.id}
        data-cover-source="METADATA_RENDER"
        style={{ background: palette.bg, color: palette.ink }}
      >
        <div
          className="h-full w-3 shrink-0"
          style={{ backgroundColor: palette.spine }}
        />
        <div className="flex min-w-0 flex-1 flex-col justify-between p-4">
          <div className="flex items-center justify-between gap-2">
            <span
              className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold"
              style={{
                backgroundColor: palette.badgeBg,
                color: palette.accent,
              }}
            >
              {displayGrade}
            </span>
            <span
              className="inline-flex size-8 items-center justify-center rounded-full text-xs font-black tracking-tight"
              style={{
                backgroundColor: palette.badgeBg,
                color: palette.accent,
              }}
            >
              {monogram}
            </span>
          </div>

          <div className="my-auto py-1">
            <p className="line-clamp-3 break-words font-extrabold leading-snug text-lg">
              {displayTitle}
            </p>
            {displayAuthor ? (
              <p
                className="mt-1 line-clamp-1 text-xs font-semibold opacity-80"
                style={{ color: palette.accent }}
              >
                {displayAuthor}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5 text-[11px] font-semibold opacity-75">
            <BookOpen aria-hidden="true" className="size-3.5 shrink-0" />
            <span>ViRead</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex w-full overflow-hidden rounded-card border border-black/5 shadow-xs",
        compact ? "shrink-0" : "h-[260px]",
        className,
      )}
      data-cover-palette={palette.id}
      data-cover-source="METADATA_RENDER"
      style={{
        ...coverDimensions,
        background: palette.bg,
        color: palette.ink,
      }}
    >
      <div
        aria-hidden="true"
        className={cn("h-full shrink-0", size === "small" ? "w-1.5" : "w-3")}
        style={{ backgroundColor: palette.spine }}
      />
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col justify-between",
          size === "small"
            ? "items-center justify-center p-1 text-center"
            : size === "medium"
              ? "p-2.5"
              : "p-5",
        )}
      >
        {size === "small" ? (
          <>
            <span
              aria-hidden="true"
              className="text-sm font-black tracking-tight"
              style={{ color: palette.accent }}
            >
              {monogram}
            </span>
            {showTitle ? (
              titleAsHeading ? (
                <h2 className="line-clamp-2 text-[10px] font-extrabold leading-tight">
                  {displayTitle}
                </h2>
              ) : (
                <p className="line-clamp-2 text-[10px] font-extrabold leading-tight">
                  {displayTitle}
                </p>
              )
            ) : null}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span
                className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold"
                style={{
                  backgroundColor: palette.badgeBg,
                  color: palette.accent,
                }}
              >
                {displayGrade}
              </span>
              <span
                aria-hidden="true"
                className="inline-flex size-7 items-center justify-center rounded-full text-xs font-black"
                style={{
                  backgroundColor: palette.badgeBg,
                  color: palette.accent,
                }}
              >
                {monogram}
              </span>
            </div>

            <div className="my-auto flex flex-col gap-1 py-1 text-left">
              {showTitle ? (
                titleAsHeading ? (
                  <h2
                    className={cn(
                      "line-clamp-3 break-words font-extrabold leading-snug",
                      size === "medium" ? "text-xs" : "text-xl",
                    )}
                  >
                    {displayTitle}
                  </h2>
                ) : (
                  <p
                    className={cn(
                      "line-clamp-3 break-words font-extrabold leading-snug",
                      size === "medium" ? "text-xs" : "text-xl",
                    )}
                  >
                    {displayTitle}
                  </p>
                )
              ) : (
                <span
                  aria-hidden="true"
                  className="text-lg font-black"
                  style={{ color: palette.accent }}
                >
                  {monogram}
                </span>
              )}
              {displayAuthor && size === "default" ? (
                <p
                  className="line-clamp-1 text-xs font-semibold opacity-85"
                  style={{ color: palette.accent }}
                >
                  {displayAuthor}
                </p>
              ) : null}
            </div>

            <div
              aria-hidden="true"
              className="flex items-center gap-1.5 text-[11px] font-semibold opacity-75"
            >
              <BookOpen className="size-3.5 shrink-0" />
              <span>ViRead</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
