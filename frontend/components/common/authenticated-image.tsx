"use client";

import { useEffect, useState } from "react";

import {
  fetchAuthenticatedBlobUrl,
  isPrivateApiMediaUrl,
  revokePrivateBlobUrl,
} from "@/lib/api/api-client";

interface AuthenticatedImageProps {
  src: string;
  alt: string;
  className?: string;
  onImageLoad?: (size: { width: number; height: number }) => void;
  onImageError?: () => void;
  fallbackLabel?: string;
}

/**
 * Renders an image safely whether it is a public/signed URL or a private
 * FastAPI authenticated proxy URL. Private images are fetched with the active
 * Bearer token (`cache: "no-store"`) and revoked immediately on unmount or src change.
 */
export function AuthenticatedImage({
  src,
  alt,
  className,
  onImageLoad,
  onImageError,
  fallbackLabel = "Không tải được ảnh trang",
}: AuthenticatedImageProps) {
  const needsAuth = isPrivateApiMediaUrl(src);
  const [resolved, setResolved] = useState<{
    src: string;
    blobUrl: string | null;
    failed: boolean;
  }>({ src: "", blobUrl: null, failed: false });

  useEffect(() => {
    if (!needsAuth) {
      return;
    }

    const controller = new AbortController();
    let createdBlob: string | null = null;
    let active = true;

    void fetchAuthenticatedBlobUrl(src, controller.signal)
      .then((blobUrl) => {
        if (!active) {
          revokePrivateBlobUrl(blobUrl);
          return;
        }
        createdBlob = blobUrl;
        setResolved({ src, blobUrl, failed: false });
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setResolved({ src, blobUrl: null, failed: true });
        onImageError?.();
      });

    return () => {
      active = false;
      controller.abort();
      if (createdBlob) {
        revokePrivateBlobUrl(createdBlob);
      }
    };
  }, [needsAuth, onImageError, src]);

  const effectiveSrc = needsAuth
    ? resolved.src === src
      ? resolved.blobUrl
      : null
    : src;
  const isFailed = needsAuth && resolved.src === src && resolved.failed;

  if (isFailed) {
    return (
      <div
        className="flex h-full w-full items-center justify-center rounded-lg bg-cream p-3 text-center text-xs font-semibold text-muted"
        role="img"
        aria-label={alt}
      >
        {fallbackLabel}
      </div>
    );
  }

  if (!effectiveSrc) {
    return (
      <div
        aria-busy="true"
        aria-label={alt}
        className="h-full w-full animate-pulse rounded-lg bg-cream"
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={alt}
      className={className}
      src={effectiveSrc}
      onLoad={(event) => {
        onImageLoad?.({
          width: event.currentTarget.naturalWidth,
          height: event.currentTarget.naturalHeight,
        });
      }}
      onError={() => onImageError?.()}
    />
  );
}
