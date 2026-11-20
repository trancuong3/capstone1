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
  AdminUploadMimeType,
} from "@/types/admin";

interface AdminPageUploaderProps {
  bookId: string;
  onUploaded: () => void;
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 6000;

const ACCEPTED_UPLOAD_ACCEPT =
  ".jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff,.pdf,.docx,image/jpeg,image/png,image/webp,image/bmp,image/tiff,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const STANDARD_IMAGE_EXTENSIONS: Record<
  string,
  "image/jpeg" | "image/png" | "image/webp"
> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const DOCUMENT_EXTENSIONS: Record<
  string,
  { mime: AdminUploadMimeType; maxBytes: number; label: string }
> = {
  ".bmp": { mime: "image/bmp", maxBytes: MAX_IMAGE_BYTES, label: "BMP" },
  ".tif": { mime: "image/tiff", maxBytes: MAX_DOCUMENT_BYTES, label: "TIFF" },
  ".tiff": { mime: "image/tiff", maxBytes: MAX_DOCUMENT_BYTES, label: "TIFF" },
  ".pdf": {
    mime: "application/pdf",
    maxBytes: MAX_DOCUMENT_BYTES,
    label: "PDF",
  },
  ".docx": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    maxBytes: MAX_DOCUMENT_BYTES,
    label: "DOCX",
  },
};

const GENERIC_MIMES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}

function classifyUploadFile(file: File):
  | {
      kind: "image";
      mime: "image/jpeg" | "image/png" | "image/webp";
      maxBytes: number;
    }
  | {
      kind: "document";
      mime: AdminUploadMimeType;
      maxBytes: number;
      label: string;
    }
  | { kind: "invalid"; error: string } {
  const ext = fileExtension(file.name);
  const rawMime = (file.type || "").split(";", 1)[0].trim().toLowerCase();

  if (ext === ".docm") {
    return {
      kind: "invalid",
      error: "Không cho phép tệp Word chứa macro (.docm).",
    };
  }
  if (ext === ".doc") {
    return {
      kind: "invalid",
      error: "Chưa hỗ trợ tệp .doc cũ; hãy lưu sang .docx hoặc .pdf.",
    };
  }

  const stdMime = STANDARD_IMAGE_EXTENSIONS[ext];
  if (stdMime) {
    if (
      !GENERIC_MIMES.has(rawMime) &&
      rawMime !== stdMime &&
      rawMime !== "image/jpg"
    ) {
      return {
        kind: "invalid",
        error: "Định dạng MIME và phần mở rộng tệp không khớp.",
      };
    }
    return { kind: "image", mime: stdMime, maxBytes: MAX_IMAGE_BYTES };
  }

  const docSpec = DOCUMENT_EXTENSIONS[ext];
  if (docSpec) {
    const allowedMimes =
      ext === ".bmp"
        ? new Set(["image/bmp", "image/x-ms-bmp", "image/x-bmp"])
        : ext === ".tif" || ext === ".tiff"
          ? new Set(["image/tiff", "image/x-tiff"])
          : ext === ".pdf"
            ? new Set(["application/pdf", "application/x-pdf"])
            : new Set([
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              ]);
    if (!GENERIC_MIMES.has(rawMime) && !allowedMimes.has(rawMime)) {
      return {
        kind: "invalid",
        error: "Định dạng MIME và phần mở rộng tệp không khớp.",
      };
    }
    return {
      kind: "document",
      mime: docSpec.mime,
      maxBytes: docSpec.maxBytes,
      label: docSpec.label,
    };
  }

  return {
    kind: "invalid",
    error:
      "Định dạng chưa hỗ trợ. Hãy chọn JPEG, PNG, WebP, BMP, TIFF, PDF hoặc DOCX.",
  };
}

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
      setFormError("Hãy chọn ít nhất một ảnh hoặc tài liệu trang sách.");
      return;
    }
    const entries: AdminPageUploadInputUI[] = [];
    const localFailures: AdminPageUploadProgressUI[] = [];
    for (const [index, file] of files.entries()) {
      const clientId = `${index}-${file.name}-${file.size}`;
      const classified = classifyUploadFile(file);
      if (classified.kind === "invalid") {
        localFailures.push({
          client_id: clientId,
          file_name: file.name,
          progress_percent: 0,
          status: "FAILED",
          error_message: classified.error,
        });
        continue;
      }
      if (file.size <= 0 || file.size > classified.maxBytes) {
        const limitMb = Math.round(classified.maxBytes / (1024 * 1024));
        localFailures.push({
          client_id: clientId,
          file_name: file.name,
          progress_percent: 0,
          status: "FAILED",
          error_message:
            file.size <= 0
              ? "Tệp được chọn bị rỗng."
              : `Tệp vượt quá giới hạn dung lượng ${limitMb} MB.`,
        });
        continue;
      }
      if (classified.kind === "document") {
        entries.push({
          client_id: clientId,
          file_name: file.name,
          mime_type: classified.mime,
          size_bytes: file.size,
          upload_kind: "document",
          file,
        });
        continue;
      }
      try {
        const bitmap = await createImageBitmap(file);
        const width = bitmap.width;
        const height = bitmap.height;
        bitmap.close();
        if (
          width <= 0 ||
          height <= 0 ||
          width > MAX_IMAGE_DIMENSION ||
          height > MAX_IMAGE_DIMENSION
        ) {
          localFailures.push({
            client_id: clientId,
            file_name: file.name,
            progress_percent: 0,
            status: "FAILED",
            error_message: "Kích thước ảnh vượt quá giới hạn 6000 × 6000 px.",
          });
          continue;
        }
        entries.push({
          client_id: clientId,
          file_name: file.name,
          mime_type: classified.mime,
          size_bytes: file.size,
          width,
          height,
          upload_kind: "image",
          file,
        });
      } catch {
        localFailures.push({
          client_id: clientId,
          file_name: file.name,
          progress_percent: 0,
          status: "FAILED",
          error_message: "Không thể đọc kích thước ảnh tại trình duyệt.",
        });
      }
    }
    const initialProgress: AdminPageUploadProgressUI[] = [
      ...localFailures,
      ...entries.map((entry) => ({
        client_id: entry.client_id,
        file_name: entry.file_name,
        progress_percent: 0,
        status: "QUEUED" as const,
      })),
    ];
    if (entries.length === 0) {
      setFormError(
        localFailures.length === 1 && localFailures[0].error_message
          ? localFailures[0].error_message
          : "Không có file hợp lệ để upload. Kiểm tra định dạng, dung lượng và kích thước ảnh.",
      );
      return;
    }
    if (localFailures.length > 0) {
      setFormError(
        "Một số tệp không hợp lệ nên chưa được upload. Các tệp hợp lệ vẫn đang được xử lý.",
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
      <h2 className="mb-4 text-2xl font-semibold" id="upload-title">
        Tải ảnh trang sách hoặc tài liệu và chạy OCR
      </h2>
      <p className="mb-4 text-sm text-muted">
        Hỗ trợ ảnh JPEG, PNG, WebP, BMP (tối đa 12 MB, chuẩn hóa tối đa 6000 ×
        6000 px) và tài liệu scan PDF, DOCX, TIFF (tối đa 50 MB, tối đa 30 trang
        mỗi tệp). Sau khi bấm upload, tiến trình vẫn chạy và được giữ khi bạn
        chuyển sang màn hình khác trong cùng tab.
      </p>
      {formError || session.error ? (
        <StatusMessage className="mb-4" tone="error">
          {formError ?? session.error}
        </StatusMessage>
      ) : null}
      <form className="grid gap-4" onSubmit={submit}>
        <p className="text-sm font-semibold text-ink">
          Backend tự động tách trang, đánh số trang liên tục từ 1 theo thứ tự
          tệp/trang và xác định số trang cuối cùng từ PostgreSQL.
        </p>
        <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-control border-2 border-dashed border-border bg-white p-5 text-center">
          <UploadCloud aria-hidden className="mb-2 size-8 text-primary" />
          <span className="font-semibold">
            Chọn một hoặc nhiều ảnh trang sách hoặc tài liệu (PDF, DOCX, TIFF,
            BMP)
          </span>
          <span className="mt-1 text-sm text-muted">
            {files.length
              ? `${files.length} file được chọn`
              : "Tệp sẽ được tách trang và xác minh lại ở Backend"}
          </span>
          <input
            id="page-images"
            accept={ACCEPTED_UPLOAD_ACCEPT}
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
              <span className="break-all text-sm">
                {item.file_name ?? item.client_id}
              </span>
              {item.status === "FAILED" && item.error_message ? (
                <span className="basis-full text-sm text-red-700">
                  {item.error_message}
                </span>
              ) : null}
              <span
                className={
                  item.status === "FAILED"
                    ? "text-sm font-semibold text-red-700"
                    : "text-sm font-semibold"
                }
              >
                {item.status === "FAILED"
                  ? "Thất bại"
                  : item.status === "UPLOADING"
                    ? "Đang tải lên"
                    : item.status === "QUEUED"
                      ? "Đang chờ"
                      : (item.summary_message ?? "OCR đã lưu · Cần duyệt")}
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
