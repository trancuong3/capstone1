"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { ProfileAvatar } from "@/components/common/profile-avatar";
import { useI18n } from "@/hooks/use-i18n";

const MAX_AVATAR_MB = 5;
const MAX_AVATAR_BYTES = MAX_AVATAR_MB * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type UploadErrorKey = "empty" | "format" | "size";

interface ProfileAvatarUploadProps {
  displayName: string;
  imageUrl?: string | null;
  selectedFile: File | null;
  isRemoved: boolean;
  showOptionalNote?: boolean;
  onSelectFile: (file: File) => void;
  onRemove: () => void;
}

export function ProfileAvatarUpload({
  displayName,
  imageUrl,
  selectedFile,
  isRemoved,
  showOptionalNote = false,
  onSelectFile,
  onRemove,
}: ProfileAvatarUploadProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<UploadErrorKey | null>(null);
  const [isLowResolution, setIsLowResolution] = useState(false);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleSelection(file: File | undefined) {
    if (!file) return;

    if (file.size === 0) {
      setErrorKey("empty");
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      setErrorKey("format");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setErrorKey("size");
      return;
    }

    setErrorKey(null);
    setIsLowResolution(false);
    setPreviewUrl(URL.createObjectURL(file));
    onSelectFile(file);
  }

  function handleRemove() {
    setIsLowResolution(false);
    setPreviewUrl(null);
    onRemove();
  }

  const errorMessage =
    errorKey === "empty"
      ? t("validation.emptyImageFile")
      : errorKey === "format"
        ? t("validation.unsupportedImageFormat")
        : errorKey === "size"
          ? t("validation.imageMaxSize", { maxMb: MAX_AVATAR_MB })
          : null;

  const visibleImageUrl = isRemoved
    ? null
    : selectedFile && previewUrl
      ? previewUrl
      : imageUrl;
  return (
    <div className="flex flex-col items-start gap-4 bg-white">
      <ProfileAvatar
        ariaLabel={t("parent.avatar.previewAria", {
          name: displayName || t("parent.avatar.accountFallback"),
        })}
        displayName={displayName}
        imageUrl={visibleImageUrl}
        onImageLoad={(width, height) =>
          setIsLowResolution(Math.min(width, height) < 128)
        }
        size="lg"
      />

      <div className="flex w-full min-w-0 flex-col items-start gap-2">
        <div className="grid w-full gap-4 sm:grid-cols-2">
          <input
            accept="image/jpeg,image/png,image/webp"
            aria-label={t("parent.avatar.selectInputAria")}
            className="sr-only"
            onChange={(event) => {
              handleSelection(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
            ref={inputRef}
            type="file"
          />
          <Button
            className="px-4"
            onClick={() => inputRef.current?.click()}
            type="button"
            variant="secondary"
          >
            {selectedFile
              ? t("parent.avatar.changeImage")
              : t("parent.avatar.selectImage")}
          </Button>
          <Button
            className="px-4"
            onClick={handleRemove}
            type="button"
            variant="quiet"
          >
            {isRemoved
              ? t("parent.avatar.restoreImage")
              : t("parent.avatar.removeImage")}
          </Button>
        </div>
        {showOptionalNote ? (
          <p className="text-body text-muted">
            {t("parent.avatar.optionalNote")}
          </p>
        ) : null}
        {isLowResolution ? (
          <p className="text-sm text-warning" role="status">
            {t("parent.avatar.lowResolutionNotice")}
          </p>
        ) : null}
        {isRemoved ? (
          <p className="text-sm text-muted" role="status">
            {t("parent.avatar.pendingRemovalNotice")}
          </p>
        ) : null}
        {errorMessage ? (
          <p className="text-sm text-danger" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}
