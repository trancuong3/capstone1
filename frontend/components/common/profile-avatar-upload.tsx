"use client";

import { ImagePlus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { ProfileAvatar } from "@/components/common/profile-avatar";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface ProfileAvatarUploadProps {
  displayName: string;
  imageUrl?: string | null;
  selectedFile: File | null;
  isRemoved: boolean;
  onSelectFile: (file: File) => void;
  onRemove: () => void;
}

export function ProfileAvatarUpload({
  displayName,
  imageUrl,
  selectedFile,
  isRemoved,
  onSelectFile,
  onRemove,
}: ProfileAvatarUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLowResolution, setIsLowResolution] = useState(false);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleSelection(file: File | undefined) {
    if (!file) return;

    if (file.size === 0) {
      setError("Tệp ảnh đang trống. Ba mẹ vui lòng chọn ảnh khác.");
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      setError("Chỉ hỗ trợ ảnh PNG, JPG hoặc WEBP.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError("Ảnh cần có dung lượng tối đa 5 MB.");
      return;
    }

    setError(null);
    setIsLowResolution(false);
    setPreviewUrl(URL.createObjectURL(file));
    onSelectFile(file);
  }

  function handleRemove() {
    setIsLowResolution(false);
    setPreviewUrl(null);
    onRemove();
  }

  const visibleImageUrl = isRemoved
    ? null
    : selectedFile && previewUrl
      ? previewUrl
      : imageUrl;
  const hasAvatar = Boolean(selectedFile || (imageUrl && !isRemoved));

  return (
    <div className="flex flex-col gap-3 rounded-control bg-white p-4 sm:flex-row sm:items-center sm:gap-5">
      <ProfileAvatar
        ariaLabel={`Ảnh xem trước của ${displayName || "tài khoản"}`}
        displayName={displayName}
        imageUrl={visibleImageUrl}
        onImageLoad={(width, height) =>
          setIsLowResolution(Math.min(width, height) < 128)
        }
        size="lg"
      />

      <div className="flex min-w-0 flex-col items-start gap-2">
        <p className="text-label font-bold text-ink">Ảnh đại diện</p>
        <div className="flex flex-wrap gap-2">
          <input
            accept="image/jpeg,image/png,image/webp"
            aria-label="Chọn ảnh đại diện PNG, JPG hoặc WEBP"
            className="sr-only"
            onChange={(event) => {
              handleSelection(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
            ref={inputRef}
            type="file"
          />
          <Button
            className="!h-11 !w-auto px-4"
            onClick={() => inputRef.current?.click()}
            type="button"
            variant="secondary"
          >
            {selectedFile ? (
              <RefreshCw aria-hidden="true" className="size-5" />
            ) : (
              <ImagePlus aria-hidden="true" className="size-5" />
            )}
            {selectedFile || imageUrl ? "Thay đổi ảnh" : "Tải ảnh lên"}
          </Button>
          {hasAvatar || isRemoved ? (
            <Button
              className="!h-11 !w-auto px-4"
              onClick={handleRemove}
              type="button"
              variant="quiet"
            >
              <Trash2 aria-hidden="true" className="size-5" />
              {isRemoved ? "Khôi phục ảnh" : "Xóa ảnh"}
            </Button>
          ) : null}
        </div>
        <p className="text-sm text-muted">PNG, JPG hoặc WEBP. Tối đa 5 MB.</p>
        {isLowResolution ? (
          <p className="text-sm text-amber-800" role="status">
            Ảnh có độ phân giải thấp và có thể hơi mờ khi hiển thị.
          </p>
        ) : null}
        {isRemoved ? (
          <p className="text-sm text-muted" role="status">
            Ảnh sẽ được xóa khi ba mẹ lưu thay đổi.
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
