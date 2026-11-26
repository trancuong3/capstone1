"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { RefreshCw, UploadCloud } from "lucide-react";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { getApiBaseUrl } from "@/lib/supabase/config";
import {
  emptyAdminBookUploadSession,
  getAdminBookUploadSession,
  hasRetryableAdminBookUploads,
  retryAdminBookUpload,
  runAdminBookUpload,
  subscribeAdminBookUploadSession,
} from "@/lib/admin/admin-book-upload-session";
import type { TranslateFn } from "@/lib/i18n/types";
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

function classifyUploadFile(
  file: File,
  t: TranslateFn,
):
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
      error: t("books.uploader.errors.docm"),
    };
  }
  if (ext === ".doc") {
    return {
      kind: "invalid",
      error: t("books.uploader.errors.docLegacy"),
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
        error: t("books.uploader.errors.mimeMismatch"),
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
        error: t("books.uploader.errors.mimeMismatch"),
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
    error: t("books.uploader.errors.unsupportedType"),
  };
}

export function AdminPageUploader({
  bookId,
  onUploaded,
}: AdminPageUploaderProps) {
  const { pages } = useAdminServices();
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
  const [files, setFiles] = useState<File[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [workerStatus, setWorkerStatus] = useState<
    "checking" | "ready" | "offline" | "unreachable"
  >("checking");
  const [healthNonce, setHealthNonce] = useState(0);
  const session = useSyncExternalStore(
    (onChange) => subscribeAdminBookUploadSession(bookId, onChange),
    () => getAdminBookUploadSession(bookId),
    () => emptyAdminBookUploadSession,
  );
  const lastCompletedRunIdRef = useRef(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), 10_000);
    async function probeOcrWorker() {
      try {
        const res = await fetch(`${getApiBaseUrl()}/health`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!active) return;
        if (!res.ok) {
          setWorkerStatus("unreachable");
          return;
        }
        const body = (await res.json()) as {
          ocr?: { ready?: boolean; probe_degraded?: boolean };
        };
        if (!active) return;
        if (body?.ocr?.probe_degraded) {
          setWorkerStatus("unreachable");
        } else if (body?.ocr?.ready === false) {
          setWorkerStatus("offline");
        } else {
          setWorkerStatus("ready");
        }
      } catch {
        if (!active) return;
        setWorkerStatus("unreachable");
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    void probeOcrWorker();
    return () => {
      active = false;
      globalThis.clearTimeout(timer);
      controller.abort();
    };
  }, [healthNonce]);

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
      setFormError(t("books.uploader.errors.noFilesSelected"));
      return;
    }
    const entries: AdminPageUploadInputUI[] = [];
    const localFailures: AdminPageUploadProgressUI[] = [];
    for (const [index, file] of files.entries()) {
      const clientId = `${index}-${file.name}-${file.size}`;
      const classified = classifyUploadFile(file, t);
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
              ? t("books.uploader.errors.emptyFile")
              : t("books.uploader.errors.sizeExceeded", { limitMb }),
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
            error_message: t("books.uploader.errors.imageDimensions"),
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
          error_message: t("books.uploader.errors.imageUnreadable"),
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
          : t("books.uploader.errors.noValidFiles"),
      );
      return;
    }
    if (localFailures.length > 0) {
      setFormError(t("books.uploader.errors.someInvalidFiles"));
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
        {t("books.uploader.heading")}
      </h2>
      <p className="mb-4 text-sm text-muted">
        {t("books.uploader.instructions")}
      </p>
      {workerStatus === "offline" || workerStatus === "unreachable" ? (
        <div
          className="mb-4 flex flex-col gap-2"
          data-testid="admin-ocr-worker-offline-banner"
        >
          <StatusMessage
            title={
              workerStatus === "offline"
                ? "Máy chủ OCR Windows hiện đang tắt"
                : "Chưa kiểm tra được trạng thái máy chủ OCR"
            }
            tone="warning"
          >
            {workerStatus === "offline"
              ? "Bạn vẫn có thể upload ảnh hoặc PDF/DOCX ngay bây giờ: hệ thống sẽ xếp hàng an toàn và tự động chạy OCR khi máy chủ OCR Windows hoạt động."
              : "Backend đang khởi động hoặc mạng chậm. Bạn vẫn có thể bấm Kiểm tra lại hoặc upload để xếp hàng OCR."}
          </StatusMessage>
          <Button
            className="sm:w-auto sm:self-start"
            onClick={() => {
              setWorkerStatus("checking");
              setHealthNonce((n) => n + 1);
            }}
            size="compact"
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-4" />
            Kiểm tra lại kết nối OCR
          </Button>
        </div>
      ) : null}
      {formError || session.error ? (
        <StatusMessage className="mb-4" tone="error">
          {formError ?? session.error}
        </StatusMessage>
      ) : null}
      <form className="grid gap-4" onSubmit={submit}>
        <p className="text-sm font-semibold text-ink">
          {t("books.uploader.orderingNote")}
        </p>
        <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-control border-2 border-dashed border-border bg-white p-5 text-center">
          <UploadCloud aria-hidden className="mb-2 size-8 text-primary" />
          <span className="font-semibold">
            {t("books.uploader.selectFilesLabel")}
          </span>
          <span className="mt-1 text-sm text-muted">
            {files.length
              ? t("books.uploader.filesSelected", { count: files.length })
              : t("books.uploader.noFilesHint")}
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
          {t("books.uploader.submit")}
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
                  ? t("books.uploader.statusFailed")
                  : item.status === "UPLOADING"
                    ? t("books.uploader.statusUploading")
                    : item.status === "QUEUED"
                      ? t("books.uploader.statusPending")
                      : (item.summary_message ??
                        t("books.uploader.statusSavedFallback"))}
              </span>
              <span className="text-sm tabular-nums">
                {formatNumber(item.progress_percent)}%
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
          {t("books.uploader.retryFailed")}
        </Button>
      ) : null}
    </section>
  );
}
