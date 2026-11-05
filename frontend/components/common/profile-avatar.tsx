"use client";

import { useState } from "react";

import { cn } from "@/lib/utils/cn";

const avatarSizes = {
  xs: "size-8 text-sm",
  sm: "size-10 text-base",
  md: "size-12 text-lg",
  lg: "size-24 text-3xl",
  xl: "size-32 text-4xl",
  card: "size-[104px] text-4xl",
} as const;

export type ProfileAvatarSize = keyof typeof avatarSizes;

export function getAvatarInitial(
  displayName: string | null | undefined,
): string {
  const name = displayName?.trim() ?? "";
  const firstCharacter = name.match(/^\P{M}\p{M}*/u)?.[0] ?? "?";

  return firstCharacter.toLocaleUpperCase("vi-VN");
}

export function resolveDisplayName(
  profileName: string | null | undefined,
  metadataName: string | null | undefined,
  email: string | null | undefined,
): string | null {
  for (const value of [profileName, metadataName]) {
    const name = value?.trim();
    if (name) return name;
  }

  const emailName = email?.split("@", 1)[0]?.trim();
  return emailName || null;
}

interface ProfileAvatarProps {
  displayName: string | null | undefined;
  imageUrl?: string | null;
  size?: ProfileAvatarSize;
  className?: string;
  ariaLabel?: string;
  onImageLoad?: (width: number, height: number) => void;
}

export function ProfileAvatar({
  displayName,
  imageUrl,
  size = "md",
  className,
  ariaLabel,
  onImageLoad,
}: ProfileAvatarProps) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const showImage = Boolean(imageUrl && imageUrl !== failedImageUrl);
  const isImageLoaded = Boolean(imageUrl && loadedImageUrl === imageUrl);
  const label = ariaLabel ?? (displayName?.trim() || "Ảnh đại diện");

  return (
    <span
      aria-label={label}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-sky font-extrabold leading-none text-primary",
        avatarSizes[size],
        className,
      )}
      role="img"
    >
      {!showImage || !isImageLoaded ? (
        <span aria-hidden="true">{getAvatarInitial(displayName)}</span>
      ) : null}
      {showImage ? (
        // The signed URL is issued by the backend, and unoptimized <img> avoids
        // routing private, expiring URLs through the Next image optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          className={cn(
            "absolute inset-0 size-full rounded-full object-cover object-center transition-opacity",
            isImageLoaded ? "opacity-100" : "opacity-0",
          )}
          onError={() => setFailedImageUrl(imageUrl ?? null)}
          onLoad={(event) => {
            setLoadedImageUrl(imageUrl ?? null);
            onImageLoad?.(
              event.currentTarget.naturalWidth,
              event.currentTarget.naturalHeight,
            );
          }}
          src={imageUrl ?? undefined}
        />
      ) : null}
    </span>
  );
}
