"use client";

import { ArrowLeft, CheckCircle2, RefreshCw, RotateCcw, Save } from "lucide-react";
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
  AdminRevisionWordDTO,
} from "@/types/admin";

type LoadError = "not-found" | "unavailable" | "safe";

export function AdminOcrReviewScreen({ bookId, pageId }: { bookId: string; pageId: string }) {
  const { books, pages, ocr, revisions } = useAdminServices();
  const [book, setBook] = useState<AdminBookDTO | null>(null);
  const [image, setImage] = useState<AdminPageImageUI | null>(null);
  const [history, setHistory] = useState<readonly AdminRevisionSummaryUI[] | null>(null);
  const [detail, setDetail] = useState<AdminPageRevisionDetailDTO | null>(null);
  const [draftText, setDraftText] = useState("");
  const [words, setWords] = useState<AdminRevisionWordDTO[]>([]);
  const [selectedWord, setSelectedWord] = useState<number | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "verify" | "reprocess" | null>(null);
  const requestIdRef = useRef(0);
  const revisionChoiceRequestIdRef = useRef(0);
  const mountedRef = useRef(false);

  const applyDetail = useCallback((next: AdminPageRevisionDetailDTO) => {
    setDetail(next);
    setDraftText(next.draft_text ?? "");
    setWords(next.words.map((word) => ({ ...word, bbox: [...word.bbox] as [number, number, number, number] })));
    setSelectedWord(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      revisionChoiceRequestIdRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setError(null);
    setBook(null);
    setImage(null);
    setHistory(null);
    setDetail(null);
    setNotice(null);
    revisionChoiceRequestIdRef.current += 1;
    try {
      const [nextBook, bookPages] = await Promise.all([books.get(bookId), pages.list(bookId)]);
      const belongsToBook = bookPages.some((item) => item.processing.page_id === pageId);
      if (!belongsToBook) {
        if (requestId === requestIdRef.current) setError("not-found");
        return;
      }
      const [nextImage, nextHistory] = await Promise.all([pages.getImage(pageId), revisions.list(pageId)]);
      const active = nextHistory[0];
      if (!active) {
        if (requestId === requestIdRef.current) setError("unavailable");
        return;
      }
      const nextDetail = await ocr.getRevision(pageId, active.page_revision_id);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setBook(nextBook);
      setImage(nextImage);
      setHistory(nextHistory);
      applyDetail(nextDetail);
    } catch (cause) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setError(
        isServiceError(cause) && cause.code === "RESOURCE_NOT_FOUND"
          ? "not-found"
          : isServiceError(cause) && [501, 503].includes(cause.status)
            ? "unavailable"
            : "safe",
      );
    }
  }, [applyDetail, bookId, books, ocr, pageId, pages, revisions]);

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
      if (!mountedRef.current || requestId !== revisionChoiceRequestIdRef.current) return;
      applyDetail(selected);
      setNotice(null);
    } catch {
      if (!mountedRef.current || requestId !== revisionChoiceRequestIdRef.current) return;
      setNotice("Không thể tải revision đã chọn.");
    }
  }

  function updateWord(index: number, patch: Partial<AdminRevisionWordDTO>) {
    setWords((current) => current.map((word) => word.word_index === index ? { ...word, ...patch } : word));
  }

  function updateBbox(index: number, coordinate: number, value: number) {
    setWords((current) => current.map((word) => {
      if (word.word_index !== index) return word;
      const next = [...word.bbox] as [number, number, number, number];
      next[coordinate] = value;
      return { ...word, bbox: next };
    }));
  }

  function syncTextFromWords() {
    setDraftText(words.map((word) => word.text.trim()).filter(Boolean).join(" "));
  }

  async function saveDraft() {
    if (!detail || detail.verification_status !== "NEEDS_REVIEW") return;
    setBusy("save");
    setNotice(null);
    try {
      const saved = await ocr.saveDraft(pageId, detail.page_revision_id, draftText, words);
      applyDetail(saved);
      setNotice("Đã lưu bản nháp vào database.");
      setHistory(await revisions.list(pageId));
    } catch {
      setNotice("Không thể lưu bản nháp. Kiểm tra các từ, bbox và quyền Admin.");
    } finally {
      setBusy(null);
    }
  }

  async function verifyRevision() {
    if (!detail || detail.verification_status !== "NEEDS_REVIEW") return;
    setBusy("verify");
    setNotice(null);
    try {
      const verified = await revisions.verify(pageId, {
        page_revision_id: detail.page_revision_id,
        corrected_text: draftText,
        words,
      });
      applyDetail(verified);
      setHistory(await revisions.list(pageId));
      setNotice("Đã xác minh revision. Revision này có thể làm ground truth cho session mới nếu trang đang ACTIVE.");
    } catch {
      setNotice("Không thể xác minh. Hãy đồng bộ văn bản với danh sách từ, kiểm tra bbox và thử lại.");
    } finally {
      setBusy(null);
    }
  }

  async function reprocess() {
    if (!detail) return;
    setBusy("reprocess");
    setNotice(null);
    try {
      const result = await revisions.reprocess(pageId, (status) => {
        if (status.page_id !== pageId) return;
      });
      applyDetail(result);
      setHistory(await revisions.list(pageId));
      setNotice("Đã tạo revision mới từ ảnh trong Supabase Storage. Revision cũ vẫn được giữ nguyên.");
    } catch {
      setNotice("Không thể chạy lại OCR. Kiểm tra Storage, Tesseract 5.x, vie.traineddata và thử lại.");
    } finally {
      setBusy(null);
    }
  }

  const verified = detail?.verification_status === "VERIFIED";
  if (error) {
    return (
      <EmptyState
        headingLevel={1}
        title={error === "not-found" ? "Không tìm thấy trang" : error === "unavailable" ? "Dữ liệu OCR chưa khả dụng" : "Không thể tải OCR"}
        description={error === "not-found" ? "Trang không thuộc sách hoặc dữ liệu quản trị hiện tại." : error === "unavailable" ? "Ảnh hoặc revision chưa đáp ứng contract hiện tại. Không sử dụng dữ liệu mẫu thay thế." : "Vui lòng thử lại sau."}
        action={<div className="flex flex-wrap items-center gap-3"><Button onClick={() => void load()} variant="secondary">Thử lại</Button><Link className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold text-primary underline" href={`/admin/books/${bookId}`}>Quay lại sách</Link></div>}
      />
    );
  }
  if (!book || !image || !history || !detail) return <AdminLoading label="Đang tải ảnh và revision…" />;

  return (
    <>
      <AdminPageHeader
        eyebrow={`${book.title} · Trang ${image.page_number}`}
        title={`Kiểm tra OCR · R${detail.revision_no}`}
        description="Sửa nội dung và vị trí từ, lưu nháp, xác minh hoặc tạo revision OCR mới."
        actions={<AdminStatusBadge status={detail.verification_status} />}
      />
      <Link className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-primary" href={`/admin/books/${bookId}`}>
        <ArrowLeft aria-hidden className="size-5" /> Chi tiết sách
      </Link>
      {notice ? <StatusMessage className="mb-6" tone={notice.startsWith("Không thể") ? "error" : "info"}>{notice}</StatusMessage> : null}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,1fr)]">
        <Card className="bg-white">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-2xl font-black">Ảnh trang gốc</h2>
            <span className="text-sm text-muted">{image.width} × {image.height} px</span>
          </div>
          <div className="relative overflow-hidden rounded-control bg-desk" style={{ aspectRatio: `${image.width} / ${image.height}` }}>
            <Image alt={`Ảnh trang ${image.page_number} của ${book.title}`} className="object-contain" fill sizes="(max-width:1280px) 100vw, 55vw" src={image.preview_url} unoptimized />
            <div aria-label={`Bounding box từ OCR: ${words.length} từ`} className="pointer-events-none absolute inset-0" role="img">
              {words.map((word) => (
                <span aria-hidden="true" className={word.word_index === selectedWord ? "absolute border-2 border-orange-500 bg-orange-300/30" : "absolute border border-primary bg-highlight/20"} key={`${word.line_index}-${word.word_index}`} style={{ height: `${word.bbox[3] * 100}%`, left: `${word.bbox[0] * 100}%`, top: `${word.bbox[1] * 100}%`, width: `${word.bbox[2] * 100}%` }} />
              ))}
            </div>
          </div>
          <p className="mt-3 text-sm text-muted">Ảnh được cấp URL có thời hạn từ Supabase Storage; tọa độ bbox dùng hệ quy chiếu chuẩn hóa 0–1.</p>
        </Card>

        <div className="grid content-start gap-6">
          <Card className="bg-white">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-black">Văn bản nháp</h2>
              <AdminStatusBadge status={detail.verification_status} />
            </div>
            <label className="grid gap-2 font-bold" htmlFor="ocr-text">
              Nội dung trang
              <textarea aria-describedby="ocr-help" className="min-h-44 rounded-control border border-border bg-white p-4 font-normal outline-none focus:border-primary focus:outline-3 focus:outline-primary/30 disabled:bg-canvas" disabled={verified} id="ocr-text" onChange={(event) => setDraftText(event.target.value)} value={draftText} />
            </label>
            <p className="mt-2 text-sm text-muted" id="ocr-help">Khi sửa số lượng hoặc thứ tự từ, hãy cập nhật danh sách từ và dùng nút đồng bộ trước khi xác minh.</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button className="sm:w-auto" disabled={verified || busy !== null} isLoading={busy === "save"} onClick={() => void saveDraft()} variant="secondary"><Save aria-hidden className="size-4" /> Lưu bản nháp</Button>
              <Button className="sm:w-auto" disabled={verified || busy !== null || words.length === 0} isLoading={busy === "verify"} onClick={() => void verifyRevision()}><CheckCircle2 aria-hidden className="size-4" /> Xác minh trang</Button>
            </div>
          </Card>

          <Card className="bg-white">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-black">Từ và bounding box</h2>
              <Button className="h-11 w-auto" disabled={verified} onClick={syncTextFromWords} variant="secondary">Đồng bộ văn bản từ danh sách từ</Button>
            </div>
            <p className="mb-4 text-sm text-muted">Chọn từ để làm nổi bật vùng tương ứng trên ảnh. Bốn giá trị bbox là x, y, width, height đã chuẩn hóa.</p>
            <div className="grid gap-3">
              {words.map((word) => (
                <div className={word.word_index === selectedWord ? "rounded-control border-2 border-orange-500 p-3" : "rounded-control border border-border p-3"} key={word.word_index}>
                  <button className="mb-3 text-left text-sm font-bold text-primary underline" onClick={() => setSelectedWord(word.word_index)} type="button">Từ #{word.word_index} · Dòng {word.line_index}</button>
                  <label className="grid gap-1 text-sm font-bold">
                    Văn bản từ
                    <input className="min-h-10 rounded-control border border-border px-3 font-normal disabled:bg-canvas" disabled={verified} onChange={(event) => updateWord(word.word_index, { text: event.target.value, normalized_text: event.target.value.trim().toLocaleLowerCase("vi") })} value={word.text} />
                  </label>
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    {(["x", "y", "w", "h"] as const).map((label, coordinate) => (
                      <label className="grid gap-1 text-xs font-bold" key={label}>
                        {label}
                        <input aria-label={`Từ ${word.word_index} bbox ${label}`} className="min-h-10 min-w-0 rounded-control border border-border px-2 font-normal disabled:bg-canvas" disabled={verified} max={1} min={0} onChange={(event) => updateBbox(word.word_index, coordinate, Number(event.target.value))} step="0.001" type="number" value={word.bbox[coordinate]} />
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted">OCR confidence: {word.ocr_confidence === null ? "không có" : word.ocr_confidence.toFixed(2)}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card className="bg-white">
            <h2 className="mb-3 text-2xl font-black">Lịch sử revision</h2>
            <div className="grid gap-2">
              {history.map((revision) => (
                <button className={revision.page_revision_id === detail.page_revision_id ? "rounded-control border-2 border-primary bg-sky p-3 text-left" : "rounded-control border border-border p-3 text-left"} key={revision.page_revision_id} onClick={() => void chooseRevision(revision.page_revision_id)} type="button">
                  <span className="font-bold">Revision R{revision.revision_no}</span>
                  <span className="ml-2 text-sm text-muted">{revision.verification_status}{revision.is_current_verified ? " · hiện hành" : ""}</span>
                </button>
              ))}
            </div>
            <Button className="mt-4 sm:w-auto" disabled={busy !== null} isLoading={busy === "reprocess"} onClick={() => void reprocess()} variant="secondary"><RotateCcw aria-hidden className="size-4" /> Chạy lại OCR từ ảnh đã lưu</Button>
            <Button className="mt-4 sm:w-auto" disabled={busy !== null} onClick={() => void load()} variant="quiet"><RefreshCw aria-hidden className="size-4" /> Tải lại dữ liệu</Button>
          </Card>
        </div>
      </div>
    </>
  );
}
