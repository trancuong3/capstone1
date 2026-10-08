"use client";

import { ArrowLeft, RotateCcw } from "lucide-react";
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
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type {
  AdminBookDTO,
  AdminPageImageUI,
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
} from "@/types/admin";

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
  const [error, setError] = useState<
    "not-found" | "unavailable" | "safe" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    setBook(null);
    setImage(null);
    setHistory(null);
    setDetail(null);
    setNotice(null);
    revisionChoiceRequestIdRef.current += 1;
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
      if (!active) {
        if (requestId === requestIdRef.current) setError("unavailable");
        return;
      }
      const nextDetail = await ocr.getRevision(pageId, active.page_revision_id);
      if (requestId !== requestIdRef.current) return;
      setBook(nextBook);
      setImage(nextImage);
      setHistory(nextHistory);
      setDetail(nextDetail);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      setError(
        isServiceError(cause) && cause.code === "RESOURCE_NOT_FOUND"
          ? "not-found"
          : isServiceError(cause) && [501, 503].includes(cause.status)
            ? "unavailable"
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
      setNotice(null);
    } catch {
      if (
        !mountedRef.current ||
        requestId !== revisionChoiceRequestIdRef.current
      )
        return;
      setNotice("Không thể tải revision đã chọn.");
    }
  }
  if (error)
    return (
      <EmptyState
        headingLevel={1}
        title={
          error === "not-found"
            ? "Không tìm thấy trang"
            : error === "unavailable"
              ? "Dữ liệu OCR đang chờ bổ sung"
              : "Không thể tải OCR"
        }
        description={
          error === "not-found"
            ? "Trang không thuộc sách hoặc dữ liệu quản trị hiện tại."
            : error === "unavailable"
              ? "Ảnh, số revision hoặc bounding box chưa đáp ứng contract hiện tại. Không sử dụng dữ liệu mẫu thay thế."
              : "Vui lòng thử lại sau."
        }
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void load()} variant="secondary">
              Thử lại
            </Button>
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
              href={`/admin/books/${bookId}`}
            >
              Quay lại sách
            </Link>
          </div>
        }
      />
    );
  if (!book || !image || !history || !detail)
    return <AdminLoading label="Đang tải ảnh và revision…" />;
  return (
    <>
      <AdminPageHeader
        eyebrow={`${book.title} · Trang ${image.page_number}`}
        title={`Kiểm tra OCR · R${detail.revision_no}`}
        description="Xem ảnh, văn bản và revision từ database. Chỉnh sửa, xác minh và chạy OCR chưa sẵn sàng."
        actions={
          <Button disabled className="sm:w-auto" variant="quiet">
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
        <StatusMessage className="mb-6" tone="error">
          {notice}
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
              unoptimized
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
            {image.width} × {image.height} px · ảnh từ API
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
              disabled
              id="ocr-text"
              value={detail.draft_text ?? ""}
            />
            <p className="text-sm text-muted" id="ocr-help">
              Chế độ chỉ đọc: hiển thị văn bản đã lưu, không chạy OCR hoặc tạo
              bounding box giả.
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
              <Button disabled variant="secondary">
                <RotateCcw aria-hidden className="size-5" /> Chạy lại OCR
              </Button>
              <Button onClick={() => void load()} variant="secondary">
                Tải lại trạng thái
              </Button>
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
    </>
  );
}
