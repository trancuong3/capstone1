"use client";

import { Trash2, UploadCloud } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  validateUploadDimensions,
  validateUploadFile,
} from "@/lib/utils/admin-upload";
import type {
  AdminPageUploadInputUI,
  AdminPageUploadProgressUI,
} from "@/types/admin";

interface QueuedPageUI {
  readonly input: AdminPageUploadInputUI;
  readonly preview_url: string;
}

function imageDimensions(
  url: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Invalid image"));
    image.src = url;
  });
}

export function AdminPageUploader({
  bookId,
  nextPageNumber,
  onUploaded,
}: {
  bookId: string;
  nextPageNumber: number;
  onUploaded: () => void;
}) {
  const { pages } = useAdminServices();
  const inputRef = useRef<HTMLInputElement>(null);
  const objectUrls = useRef(new Set<string>());
  const [queue, setQueue] = useState<readonly QueuedPageUI[]>([]);
  const [progress, setProgress] = useState<
    Readonly<Record<string, AdminPageUploadProgressUI>>
  >({});
  const [notice, setNotice] = useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(
    () => () => {
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  function clearQueue(): void {
    queue.forEach((item) => {
      URL.revokeObjectURL(item.preview_url);
      objectUrls.current.delete(item.preview_url);
    });
    setQueue([]);
  }

  async function selectFiles(files: FileList | null) {
    if (!files) return;
    clearQueue();
    const valid: QueuedPageUI[] = [];
    const errors: string[] = [];
    for (const [index, file] of [...files].entries()) {
      const checked = validateUploadFile(file, nextPageNumber + index);
      if (!checked.input) {
        if (checked.error) errors.push(checked.error);
        continue;
      }
      const previewUrl = URL.createObjectURL(file);
      objectUrls.current.add(previewUrl);
      try {
        const dimensions = await imageDimensions(previewUrl);
        const input = { ...checked.input, ...dimensions };
        const dimensionError = validateUploadDimensions(input);
        if (dimensionError) {
          errors.push(dimensionError);
          URL.revokeObjectURL(previewUrl);
          objectUrls.current.delete(previewUrl);
        } else {
          valid.push({ input, preview_url: previewUrl });
        }
      } catch {
        errors.push(`${file.name}: không thể đọc ảnh.`);
        URL.revokeObjectURL(previewUrl);
        objectUrls.current.delete(previewUrl);
      }
    }
    setQueue(valid);
    setProgress({});
    setNotice(
      errors.length ? { tone: "error", message: errors.join(" ") } : null,
    );
  }

  function remove(item: QueuedPageUI): void {
    URL.revokeObjectURL(item.preview_url);
    objectUrls.current.delete(item.preview_url);
    setQueue((current) =>
      current.filter(
        (candidate) => candidate.input.client_id !== item.input.client_id,
      ),
    );
  }

  async function upload() {
    if (!queue.length || uploading) return;
    setUploading(true);
    setNotice(null);
    try {
      await pages.upload(
        bookId,
        queue.map((item) => item.input),
        (item) =>
          setProgress((current) => ({ ...current, [item.client_id]: item })),
      );
      clearQueue();
      setNotice({
        tone: "success",
        message: "Đã tải trang lên. OCR mock đang xử lý bản R1.",
      });
      onUploaded();
      if (inputRef.current) inputRef.current.value = "";
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          isServiceError(error) && error.code === "INVALID_UPLOAD"
            ? "Tệp tải lên không hợp lệ. Kiểm tra định dạng, dung lượng, kích thước và số trang."
            : "Tải trang thất bại. Các tệp chưa hoàn tất vẫn có thể thử lại.",
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <section
      aria-labelledby="upload-title"
      className="rounded-card bg-sky p-4 sm:p-6"
    >
      <div className="mb-4">
        <h2 className="text-2xl font-black" id="upload-title">
          Tải trang sách
        </h2>
        <p className="mt-1 text-muted">
          JPEG, PNG hoặc WebP · tối đa 12 MB · tối đa 6000 × 6000 px.
        </p>
      </div>
      {notice ? (
        <StatusMessage className="mb-4" tone={notice.tone}>
          {notice.message}
        </StatusMessage>
      ) : null}
      <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-control border-2 border-dashed border-primary bg-white p-5 text-center focus-within:outline-3 focus-within:outline-primary">
        <UploadCloud aria-hidden className="mb-2 size-8 text-primary" />
        <span className="font-extrabold">
          Chọn một hoặc nhiều ảnh trang sách
        </span>
        <input
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          multiple
          onChange={(event) => void selectFiles(event.target.files)}
          ref={inputRef}
          type="file"
        />
      </label>
      {queue.length ? (
        <ul
          aria-label="Hàng đợi tải lên"
          className="mt-4 grid gap-3 sm:grid-cols-2"
        >
          {queue.map((item) => {
            const state = progress[item.input.client_id];
            return (
              <li
                className="flex items-center gap-3 rounded-control bg-white p-3"
                key={item.input.client_id}
              >
                <div
                  aria-label={`Xem trước ${item.input.file_name}`}
                  className="size-16 shrink-0 rounded-xl bg-desk bg-cover bg-center"
                  role="img"
                  style={{ backgroundImage: `url(${item.preview_url})` }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">
                    Trang {item.input.page_number} · {item.input.file_name}
                  </p>
                  <p aria-live="polite" className="text-sm text-muted">
                    {state
                      ? `${state.status} · ${state.progress_percent}%`
                      : `${item.input.width} × ${item.input.height} px · ${(item.input.size_bytes / 1024 / 1024).toFixed(1)} MB`}
                  </p>
                </div>
                <button
                  aria-label={`Xóa ${item.input.file_name}`}
                  className="grid size-11 place-items-center rounded-full hover:bg-danger-surface"
                  disabled={uploading}
                  onClick={() => remove(item)}
                  type="button"
                >
                  <Trash2 aria-hidden className="size-5" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Button
        className="mt-4 sm:w-auto sm:min-w-52"
        disabled={!queue.length || uploading}
        isLoading={uploading}
        onClick={() => void upload()}
      >
        {uploading ? "Đang tải lên…" : `Tải lên ${queue.length || ""} trang`}
      </Button>
    </section>
  );
}
