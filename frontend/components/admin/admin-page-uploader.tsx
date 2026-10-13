"use client";

import { useRef, useState, type FormEvent } from "react";
import { UploadCloud } from "lucide-react";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import type {
  AdminPageUploadInputUI,
  AdminPageUploadProgressUI,
} from "@/types/admin";

interface AdminPageUploaderProps {
  bookId: string;
  nextPageNumber: number;
  onUploaded: () => void;
}

const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function AdminPageUploader({
  bookId,
  nextPageNumber,
  onUploaded,
}: AdminPageUploaderProps) {
  const { pages } = useAdminServices();
  const [files, setFiles] = useState<File[]>([]);
  const [startNumber, setStartNumber] = useState(String(nextPageNumber));
  const [progress, setProgress] = useState<AdminPageUploadProgressUI[]>([]);
  const progressRef = useRef<AdminPageUploadProgressUI[]>([]);
  const [retryEntries, setRetryEntries] = useState<AdminPageUploadInputUI[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateProgress(item: AdminPageUploadProgressUI) {
    const current = progressRef.current;
    const found = current.some((entry) => entry.client_id === item.client_id);
    const next = found
      ? current.map((entry) =>
          entry.client_id === item.client_id ? item : entry,
        )
      : [...current, item];
    progressRef.current = next;
    setProgress(next);
  }

  async function retryFailed() {
    const failed = retryEntries.filter((entry) =>
      progressRef.current.some(
        (item) =>
          item.client_id === entry.client_id && item.status === "FAILED",
      ),
    );
    if (!failed.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      await pages.upload(bookId, failed, updateProgress);
      onUploaded();
      const stillFailed = failed.filter((entry) =>
        progressRef.current.some(
          (item) =>
            item.client_id === entry.client_id && item.status === "FAILED",
        ),
      );
      setRetryEntries(stillFailed);
      if (stillFailed.length)
        setError(
          "Một số file vẫn thất bại. Kiểm tra cấu hình Backend/Storage rồi thử lại.",
        );
    } catch {
      setError(
        "Không thể tải lại danh sách trang sau khi thử lại. Hãy tải lại dữ liệu để xác minh.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const start = Number(startNumber);
    if (!files.length) {
      setError("Hãy chọn ít nhất một ảnh trang sách.");
      return;
    }
    if (
      !Number.isInteger(start) ||
      start < 1 ||
      start + files.length - 1 > 32767
    ) {
      setError("Số trang bắt đầu không hợp lệ.");
      return;
    }

    setBusy(true);
    const entries: AdminPageUploadInputUI[] = [];
    const localFailures: AdminPageUploadProgressUI[] = [];
    for (const [index, file] of files.entries()) {
      const clientId = `${index}-${file.name}-${file.size}`;
      if (!acceptedTypes.has(file.type)) {
        localFailures.push({
          client_id: clientId,
          progress_percent: 0,
          status: "FAILED",
        });
        continue;
      }
      if (file.size <= 0 || file.size > 12 * 1024 * 1024) {
        localFailures.push({
          client_id: clientId,
          progress_percent: 0,
          status: "FAILED",
        });
        continue;
      }
      try {
        const bitmap = await createImageBitmap(file);
        const width = bitmap.width;
        const height = bitmap.height;
        bitmap.close();
        if (width <= 0 || height <= 0 || width > 6000 || height > 6000) {
          localFailures.push({
            client_id: clientId,
            progress_percent: 0,
            status: "FAILED",
          });
          continue;
        }
        entries.push({
          client_id: clientId,
          file_name: file.name,
          mime_type: file.type as AdminPageUploadInputUI["mime_type"],
          size_bytes: file.size,
          page_number: start + index,
          width,
          height,
          file,
        });
      } catch {
        localFailures.push({
          client_id: clientId,
          progress_percent: 0,
          status: "FAILED",
        });
      }
    }
    const initialProgress = [
      ...localFailures,
      ...entries.map((entry) => ({
        client_id: entry.client_id,
        progress_percent: 0,
        status: "QUEUED" as const,
      })),
    ];
    progressRef.current = initialProgress;
    setProgress(initialProgress);
    setRetryEntries(entries);

    try {
      if (entries.length) {
        await pages.upload(bookId, entries, updateProgress);
      }
      const failedEntries = entries.filter((entry) =>
        progressRef.current.some(
          (item) =>
            item.client_id === entry.client_id && item.status === "FAILED",
        ),
      );
      setRetryEntries(failedEntries);
      if (entries.length === 0 || localFailures.length === files.length) {
        setError(
          "Không có file hợp lệ để upload. Kiểm tra định dạng, dung lượng và kích thước ảnh.",
        );
      } else if (localFailures.length || failedEntries.length) {
        setError(
          "Một số file không hợp lệ hoặc upload thất bại. Dùng nút thử lại cho file thất bại.",
        );
      }
      if (entries.length) onUploaded();
      setFiles([]);
      const input = document.getElementById(
        "page-images",
      ) as HTMLInputElement | null;
      if (input) input.value = "";
    } catch {
      setError(
        "Không thể tải danh sách trang sau upload. Dữ liệu có thể đã được lưu; hãy tải lại để xác minh.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="upload-title"
      className="mb-8 rounded-card bg-sky p-4 sm:p-6"
    >
      <h2 className="mb-4 text-2xl font-black" id="upload-title">
        Tải ảnh trang sách và chạy OCR
      </h2>
      <p className="mb-4 text-sm text-muted">
        JPEG, PNG hoặc WebP; tối đa 12 MB mỗi ảnh, kích thước tối đa 6000 × 6000
        px. Mỗi ảnh được gửi thành một request riêng.
      </p>
      {error ? (
        <StatusMessage className="mb-4" tone="error">
          {error}
        </StatusMessage>
      ) : null}
      <form className="grid gap-4" onSubmit={submit}>
        <label className="grid gap-2 font-bold" htmlFor="page-number-start">
          Số trang đầu tiên
          <input
            id="page-number-start"
            className="min-h-12 max-w-40 rounded-control border border-border bg-white px-3"
            min={1}
            onChange={(event) => setStartNumber(event.target.value)}
            type="number"
            value={startNumber}
          />
        </label>
        <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-control border-2 border-dashed border-border bg-white p-5 text-center">
          <UploadCloud aria-hidden className="mb-2 size-8 text-primary" />
          <span className="font-extrabold">
            Chọn một hoặc nhiều ảnh trang sách
          </span>
          <span className="mt-1 text-sm text-muted">
            {files.length
              ? `${files.length} file được chọn`
              : "Ảnh sẽ được xác minh lại ở Backend"}
          </span>
          <input
            id="page-images"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            multiple
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            type="file"
          />
        </label>
        <Button
          className="sm:w-auto sm:justify-self-start"
          isLoading={busy}
          type="submit"
        >
          Upload và chạy OCR
        </Button>
      </form>
      {progress.length ? (
        <div className="mt-5 grid gap-2" aria-live="polite">
          {progress.map((item) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-white p-3"
              key={item.client_id}
            >
              <span className="break-all text-sm">{item.client_id}</span>
              <span
                className={
                  item.status === "FAILED"
                    ? "text-sm font-bold text-red-700"
                    : "text-sm font-bold"
                }
              >
                {item.status === "FAILED"
                  ? "Thất bại"
                  : item.status === "UPLOADING"
                    ? "Đang tải lên"
                    : item.status === "QUEUED"
                      ? "Đang chờ"
                      : "OCR đã lưu · Cần duyệt"}
              </span>
              <span className="text-sm tabular-nums">
                {item.progress_percent}%
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {retryEntries.length ? (
        <Button
          className="mt-4 sm:w-auto"
          disabled={busy}
          isLoading={busy}
          onClick={() => void retryFailed()}
          variant="secondary"
        >
          Thử lại các file thất bại
        </Button>
      ) : null}
    </section>
  );
}
