"use client";

import { ArrowLeft, CheckCircle2, RotateCcw, Save } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminLoading,
  AdminPageHeader,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import { canAdminReprocessRevision } from "@/lib/utils/admin-revision";
import type {
  AdminBookDTO,
  AdminPageImageUI,
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
  AdminRevisionWordDTO,
} from "@/types/admin";

function wordsFromText(
  text: string,
  existing: readonly AdminRevisionWordDTO[],
): readonly AdminRevisionWordDTO[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => ({
      word_index: index,
      line_index: 0,
      text: word,
      normalized_text: word.normalize("NFC").toLocaleLowerCase("vi"),
      bbox: existing[index]?.bbox ?? [
        0.08 + (index % 5) * 0.17,
        0.2 + Math.floor(index / 5) * 0.08,
        0.14,
        0.06,
      ],
      ocr_confidence: existing[index]?.ocr_confidence ?? null,
    }));
}

export function AdminOcrReviewScreen({
  bookId,
  pageId,
}: {
  bookId: string;
  pageId: string;
}) {
  const { books, pages, ocr, revisions } = useAdminServices();
  const [book, setBook] = useState<AdminBookDTO | null>(null);
  const [image, setImage] = useState<AdminPageImageUI | null>(null);
  const [history, setHistory] = useState<
    readonly AdminRevisionSummaryUI[] | null
  >(null);
  const [detail, setDetail] = useState<AdminPageRevisionDetailDTO | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<"not-found" | "safe" | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState<"save" | "verify" | "reprocess" | null>(
    null,
  );
  const [dialog, setDialog] = useState<
    "verify" | "reprocess" | "lifecycle" | null
  >(null);
  const requestIdRef = useRef(0);
  const revisionChoiceRequestIdRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      revisionChoiceRequestIdRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    const requestId = ++requestIdRef.current;
    setError(null);
    try {
      const [nextBook, bookPages] = await Promise.all([
        books.get(bookId),
        pages.list(bookId),
      ]);
      const belongsToBook = bookPages.some(
        (item) => item.processing.page_id === pageId,
      );
      if (!belongsToBook) {
        if (requestId === requestIdRef.current) setError("not-found");
        return;
      }
      const [nextImage, nextHistory] = await Promise.all([
        pages.getImage(pageId),
        revisions.list(pageId),
      ]);
      const active = nextHistory[0];
      if (!active) throw new Error("No revision");
      const nextDetail = await ocr.getRevision(pageId, active.page_revision_id);
      if (requestId !== requestIdRef.current) return;
      setBook(nextBook);
      setImage(nextImage);
      setHistory(nextHistory);
      setDetail(nextDetail);
      setText(nextDetail.draft_text ?? "");
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      setError(
        isServiceError(cause) && cause.code === "RESOURCE_NOT_FOUND"
          ? "not-found"
          : "safe",
      );
    }
  }, [bookId, books, ocr, pageId, pages, revisions]);
  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);
  async function chooseRevision(revisionId: string) {
    const requestId = ++revisionChoiceRequestIdRef.current;
    try {
      const selected = await ocr.getRevision(pageId, revisionId);
      if (
        !mountedRef.current ||
        requestId !== revisionChoiceRequestIdRef.current
      )
        return;
      setDetail(selected);
      setText(selected.draft_text ?? "");
      setNotice(null);
    } catch {
      if (
        !mountedRef.current ||
        requestId !== revisionChoiceRequestIdRef.current
      )
        return;
      setNotice({ tone: "error", message: "Không thể tải revision đã chọn." });
    }
  }
  async function saveDraft() {
    if (!detail || busy) return;
    setBusy("save");
    setNotice(null);
    try {
      const updated = await ocr.saveDraft(
        pageId,
        detail.page_revision_id,
        text,
        wordsFromText(text, detail.words),
      );
      if (!mountedRef.current) return;
      setDetail(updated);
      setNotice({ tone: "success", message: "Đã lưu bản nháp OCR." });
    } catch {
      if (!mountedRef.current) return;
      setNotice({
        tone: "error",
        message: "Không thể lưu bản nháp. Kiểm tra nội dung và thử lại.",
      });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }
  async function verify() {
    if (!detail || busy) return;
    setBusy("verify");
    try {
      const verified = await revisions.verify(pageId, {
        page_revision_id: detail.page_revision_id,
        corrected_text: text,
        words: wordsFromText(text, detail.words),
      });
      if (!mountedRef.current) return;
      const nextHistory = await revisions.list(pageId);
      if (!mountedRef.current) return;
      setDetail(verified);
      setHistory(nextHistory);
      setNotice({
        tone: "success",
        message: `Đã xác minh R${verified.revision_no}. Revision này đã bất biến.`,
      });
    } catch {
      if (!mountedRef.current) return;
      setNotice({
        tone: "error",
        message: "Không thể xác minh revision ở trạng thái hiện tại.",
      });
    } finally {
      if (mountedRef.current) {
        setBusy(null);
        setDialog(null);
      }
    }
  }
  async function reprocess() {
    if (
      busy ||
      !detail ||
      !history ||
      !canAdminReprocessRevision(detail, history)
    ) {
      return;
    }
    setBusy("reprocess");
    try {
      const review = await revisions.reprocess(pageId, (status) => {
        if (!mountedRef.current) return;
        setNotice({
          tone: "info",
          message: `R${status.revision_no}: ${status.verification_status}`,
        });
      });
      if (!mountedRef.current) return;
      const nextHistory = await revisions.list(pageId);
      if (!mountedRef.current) return;
      setDetail(review);
      setText(review.draft_text ?? "");
      setHistory(nextHistory);
      setNotice({
        tone: "success",
        message: `Đã tạo R${review.revision_no} ở trạng thái NEEDS_REVIEW. Revision cũ vẫn được giữ nguyên.`,
      });
    } catch {
      if (!mountedRef.current) return;
      setNotice({
        tone: "error",
        message: "Không thể chạy lại OCR từ trạng thái revision hiện tại.",
      });
    } finally {
      if (mountedRef.current) {
        setBusy(null);
        setDialog(null);
      }
    }
  }
  async function togglePageLifecycle() {
    if (!detail) return;
    try {
      const status =
        detail.lifecycle_status === "ACTIVE" ? "RETIRED" : "ACTIVE";
      await pages.updateStatus(pageId, { status });
      if (!mountedRef.current) return;
      setDetail({ ...detail, lifecycle_status: status });
      setNotice({
        tone: "success",
        message: "Đã cập nhật vòng đời trang; lịch sử revision không thay đổi.",
      });
    } catch {
      if (!mountedRef.current) return;
      setNotice({
        tone: "error",
        message: "Không thể cập nhật vòng đời trang.",
      });
    } finally {
      if (mountedRef.current) setDialog(null);
    }
  }
  async function reloadProcessing() {
    setNotice({ tone: "info", message: "Đang tải lại trạng thái OCR…" });
    try {
      await pages.reload(pageId);
      if (!mountedRef.current) return;
      await load();
    } catch {
      if (!mountedRef.current) return;
      setNotice({
        tone: "error",
        message: "Không thể tải lại trạng thái OCR.",
      });
    }
  }
  if (error)
    return (
      <EmptyState
        headingLevel={1}
        title={
          error === "not-found" ? "Không tìm thấy trang" : "Không thể tải OCR"
        }
        description={
          error === "not-found"
            ? "Trang không thuộc sách hoặc dữ liệu quản trị hiện tại."
            : "Vui lòng thử lại sau."
        }
        action={
          <Link
            className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
            href={`/admin/books/${bookId}`}
          >
            Quay lại sách
          </Link>
        }
      />
    );
  if (!book || !image || !history || !detail)
    return <AdminLoading label="Đang tải ảnh và revision…" />;
  const editable = detail.verification_status === "NEEDS_REVIEW";
  const canReprocess = canAdminReprocessRevision(detail, history);
  return (
    <>
      <AdminPageHeader
        eyebrow={`${book.title} · Trang ${image.page_number}`}
        title={`Kiểm tra OCR · R${detail.revision_no}`}
        description="Đối chiếu ảnh gốc, sửa văn bản và xác minh đúng revision đang chọn."
        actions={
          <Button
            className="sm:w-auto"
            onClick={() => setDialog("lifecycle")}
            variant="quiet"
          >
            {detail.lifecycle_status === "ACTIVE"
              ? "Ngừng trang"
              : "Kích hoạt trang"}
          </Button>
        }
      />
      <Link
        className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-primary"
        href={`/admin/books/${bookId}`}
      >
        <ArrowLeft aria-hidden className="size-5" /> Chi tiết sách
      </Link>
      {notice ? (
        <StatusMessage className="mb-6" tone={notice.tone}>
          {notice.message}
        </StatusMessage>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(420px,.95fr)]">
        <Card className="bg-white">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-2xl font-black">Ảnh trang gốc</h2>
            <AdminStatusBadge status={detail.lifecycle_status} />
          </div>
          <div className="relative aspect-[3/4] overflow-hidden rounded-control bg-desk">
            <Image
              alt={`Ảnh trang ${image.page_number} của ${book.title}`}
              className="object-contain"
              fill
              sizes="(max-width:1280px) 100vw, 55vw"
              src={image.preview_url}
            />
            <div
              aria-label={`Bounding box từ OCR: ${detail.words.length} vùng từ đã nhận dạng`}
              className="pointer-events-none absolute inset-0"
              role="img"
            >
              {detail.words.map((word) => (
                <span
                  aria-hidden="true"
                  className="absolute border-2 border-primary bg-highlight/20"
                  key={`${word.line_index}-${word.word_index}`}
                  style={{
                    height: `${word.bbox[3] * 100}%`,
                    left: `${word.bbox[0] * 100}%`,
                    top: `${word.bbox[1] * 100}%`,
                    width: `${word.bbox[2] * 100}%`,
                  }}
                />
              ))}
            </div>
          </div>
          <p className="text-sm text-muted">
            {image.width} × {image.height} px · dữ liệu ảnh mock
          </p>
        </Card>
        <div className="grid content-start gap-6">
          <Card className="bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-black">Văn bản OCR</h2>
              <AdminStatusBadge status={detail.verification_status} />
            </div>
            <label className="font-bold" htmlFor="ocr-text">
              Nội dung đã hiệu chỉnh
            </label>
            <textarea
              aria-describedby="ocr-help"
              className="min-h-64 rounded-control border border-border bg-white p-4 text-body outline-none focus:border-primary focus:outline-3 focus:outline-primary/30 disabled:bg-canvas"
              disabled={!editable || busy !== null}
              id="ocr-text"
              onChange={(event) => setText(event.target.value)}
              value={text}
            />
            <p className="text-sm text-muted" id="ocr-help">
              {editable
                ? "Thứ tự từ sẽ được chuẩn hóa theo nội dung khi lưu/xác minh."
                : detail.verification_status === "VERIFIED"
                  ? canReprocess
                    ? "Revision đã xác minh là bất biến. Dùng Chạy lại OCR để tạo revision mới."
                    : "Đây là revision lịch sử. Chỉ revision VERIFIED hiện hành mới nhất có thể chạy lại OCR."
                  : "Chờ xử lý OCR hoàn tất trước khi chỉnh sửa."}
            </p>
            {detail.words.length ? (
              <div
                aria-label="Danh sách từ OCR"
                className="flex flex-wrap gap-2"
              >
                {detail.words.map((word) => (
                  <span
                    className="rounded-full bg-canvas px-3 py-1 text-sm"
                    key={`${word.line_index}-${word.word_index}`}
                  >
                    {word.word_index + 1}. {word.text}
                    {word.ocr_confidence === null
                      ? ""
                      : ` · ${Math.round(word.ocr_confidence * 100)}%`}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {editable ? (
                <>
                  <Button
                    disabled={busy !== null || !text.trim()}
                    isLoading={busy === "save"}
                    onClick={() => void saveDraft()}
                    variant="secondary"
                  >
                    <Save aria-hidden className="size-5" /> Lưu nháp
                  </Button>
                  <Button
                    disabled={busy !== null || !text.trim()}
                    onClick={() => setDialog("verify")}
                  >
                    <CheckCircle2 aria-hidden className="size-5" /> Xác minh
                  </Button>
                </>
              ) : detail.verification_status === "VERIFIED" ? (
                canReprocess ? (
                  <Button
                    className="sm:col-span-2"
                    disabled={busy !== null}
                    onClick={() => setDialog("reprocess")}
                    variant="secondary"
                  >
                    <RotateCcw aria-hidden className="size-5" /> Chạy lại OCR
                  </Button>
                ) : (
                  <p className="text-sm font-bold text-muted sm:col-span-2">
                    Chọn revision VERIFIED hiện hành mới nhất để chạy lại OCR.
                  </p>
                )
              ) : (
                <Button
                  className="sm:col-span-2"
                  onClick={() => void reloadProcessing()}
                  variant="secondary"
                >
                  Tải lại trạng thái
                </Button>
              )}
            </div>
          </Card>
          <Card className="bg-cream">
            <h2 className="text-2xl font-black">Lịch sử revision</h2>
            <ul className="grid gap-3">
              {history.map((item) => (
                <li key={item.page_revision_id}>
                  <button
                    className="flex min-h-16 w-full items-center justify-between gap-3 rounded-control bg-white px-4 text-left hover:bg-sky focus-visible:outline-3 focus-visible:outline-primary"
                    onClick={() => void chooseRevision(item.page_revision_id)}
                    type="button"
                  >
                    <span>
                      <strong>R{item.revision_no}</strong>
                      {item.is_current_verified ? (
                        <span className="ml-2 text-sm text-primary">
                          Hiện hành
                        </span>
                      ) : null}
                      <span className="block text-xs text-muted">
                        {new Date(item.created_at).toLocaleString("vi-VN")}
                      </span>
                    </span>
                    <AdminStatusBadge status={item.verification_status} />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
      <ConfirmDialog
        isOpen={dialog === "verify"}
        title="Xác minh revision này?"
        body="Nội dung và danh sách từ sẽ trở thành bất biến; con trỏ revision hiện hành chuyển sang revision này."
        confirm="Xác minh"
        busy={busy === "verify"}
        onCancel={() => setDialog(null)}
        onConfirm={() => void verify()}
      />
      <ConfirmDialog
        isOpen={dialog === "reprocess"}
        title="Tạo revision OCR mới?"
        body={`Hệ thống sẽ giữ nguyên R${detail.revision_no} và thêm revision kế tiếp qua PROCESSING → NEEDS_REVIEW.`}
        confirm="Chạy lại OCR"
        busy={busy === "reprocess"}
        onCancel={() => setDialog(null)}
        onConfirm={() => void reprocess()}
      />
      <ConfirmDialog
        isOpen={dialog === "lifecycle"}
        title="Đổi vòng đời trang?"
        body="Thao tác không xóa trang hoặc lịch sử revision."
        confirm="Xác nhận"
        busy={false}
        onCancel={() => setDialog(null)}
        onConfirm={() => void togglePageLifecycle()}
      />
    </>
  );
}

function ConfirmDialog({
  isOpen,
  title,
  body,
  confirm,
  busy,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  title: string;
  body: string;
  confirm: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={title}>
      <p className="text-body text-muted">{body}</p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button disabled={busy} isLoading={busy} onClick={onConfirm}>
          {confirm}
        </Button>
        <Button disabled={busy} onClick={onCancel} variant="quiet">
          Hủy
        </Button>
      </div>
    </Modal>
  );
}
