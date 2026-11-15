"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { UploadCloud } from "lucide-react";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import {
  emptyAdminBookUploadSession,
  getAdminBookUploadSession,
  hasRetryableAdminBookUploads,
  retryAdminBookUpload,
  runAdminBookUpload,
  subscribeAdminBookUploadSession,
} from "@/lib/admin/admin-book-upload-session";
import type {
  AdminPageUploadInputUI,
  AdminPageUploadProgressUI,
} from "@/types/admin";

interface AdminPageUploaderProps {
  bookId: string;
  onUploaded: () => void;
}

const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function AdminPageUploader({
  bookId,
  onUploaded,
}: AdminPageUploaderProps) {
  const { pages } = useAdminServices();
  const [files, setFiles] = useState<File[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const session = useSyncExternalStore(
    (onChange) => subscribeAdminBookUploadSession(bookId, onChange),
    () => getAdminBookUploadSession(bookId),
    () => emptyAdminBookUploadSession,
  );
  const lastCompletedRunIdRef = useRef(0);

  useEffect(() => {
    if (
      session.completedRunId > lastCompletedRunIdRef.current &&
      !session.busy
    ) {
      lastCompletedRunIdRef.current = session.completedRunId;
      onUploaded();
    }
  }, [onUploaded, session.busy, session.completedRunId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!files.length) {
      setFormError("Hãy chọn ít nhất một ảnh trang sách.");
      return;
    }
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
    const initialProgress: AdminPageUploadProgressUI[] = [
      ...localFailures,
      ...entries.map((entry) => ({
        client_id: entry.client_id,
        progress_percent: 0,
        status: "QUEUED" as const,
      })),
    ];
    if (entries.length === 0) {
      setFormError(
        "Không có file hợp lệ để upload. Kiểm tra định dạng, dung lượng và kích thước ảnh.",
      );
      return;
    }
    if (localFailures.length > 0) {
      setFormError(
        "Một số ảnh không hợp lệ nên chưa được upload. Hãy thay ảnh sai định dạng, dung lượng hoặc kích thước.",
      );
    }
    setFiles([]);
    const input = document.getElementById(
      "page-images",
    ) as HTMLInputElement | null;
    if (input) input.value = "";
    void runAdminBookUpload(bookId, pages, entries, initialProgress);
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
        px. Mỗi ảnh được gửi thành một request riêng. Sau khi bấm upload, tiến
        trình vẫn chạy và được giữ khi bạn chuyển sang màn hình khác trong cùng
        tab.
      </p>
      {formError || session.error ? (
        <StatusMessage className="mb-4" tone="error">
          {formError ?? session.error}
        </StatusMessage>
      ) : null}
      <form className="grid gap-4" onSubmit={submit}>
        <p className="text-sm font-semibold text-ink">
          Backend tự động đánh số trang liên tục từ 1. Thứ tự chọn ảnh quyết
          định thứ tự gửi; số trang cuối cùng được xác định từ PostgreSQL.
        </p>
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
          disabled={session.busy}
          isLoading={session.busy}
          type="submit"
        >
          Upload và chạy OCR
        </Button>
      </form>
      {session.progress.length ? (
        <div className="mt-5 grid gap-2" aria-live="polite">
          {session.progress.map((item) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-white p-3"
              key={item.client_id}
            >
              <span className="break-all text-sm">{item.client_id}</span>
              {item.status === "FAILED" && item.error_message ? (
                <span className="basis-full text-sm text-red-700">
                  {item.error_message}
                </span>
              ) : null}
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
      {hasRetryableAdminBookUploads(bookId) ? (
        <Button
          className="mt-4 sm:w-auto"
          disabled={session.busy}
          isLoading={session.busy}
          onClick={() => void retryAdminBookUpload(bookId, pages)}
          variant="secondary"
        >
          Thử lại các file thất bại
        </Button>
      ) : null}
    </section>
  );
}
