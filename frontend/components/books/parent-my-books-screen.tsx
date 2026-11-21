"use client";

import {
  AlertTriangle,
  BookMarked,
  BookOpen,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useParentPrivateBookService } from "@/hooks/use-parent-private-book-service";
import { clearPrivateMediaMemoryCache } from "@/lib/api/api-client";
import { isServiceError } from "@/lib/api/service-error";
import { CHILD_GRADES } from "@/types/child";
import {
  SOURCE_USAGE_OPTIONS,
  type ParentPrivateBookSummaryDTO,
  type SourceUsageType,
} from "@/types/parent-private-book";

function getErrorText(error: unknown, fallback: string): string {
  if (isServiceError(error) && error.message) {
    return error.message;
  }
  return fallback;
}

const VALID_SOURCE_TYPES = new Set<string>(
  SOURCE_USAGE_OPTIONS.map((opt) => opt.value),
);

function parseSourceDeclaration(raw: string | null): {
  sourceType: SourceUsageType;
  sourceNote: string;
} {
  const cleaned = (raw ?? "").trim();
  if (!cleaned) {
    return { sourceType: "OWNED_PHYSICAL_BOOK", sourceNote: "" };
  }
  if (cleaned.startsWith("[") && cleaned.includes("]")) {
    const closeIdx = cleaned.indexOf("]");
    const tag = cleaned.slice(1, closeIdx).trim();
    const rest = cleaned.slice(closeIdx + 1).trim();
    if (VALID_SOURCE_TYPES.has(tag)) {
      return { sourceType: tag as SourceUsageType, sourceNote: rest };
    }
  }
  return { sourceType: "OWNED_PHYSICAL_BOOK", sourceNote: cleaned };
}

export function ParentMyBooksScreen() {
  const authRuntime = useAuthRuntime();
  const currentUserId = authRuntime.session?.user?.id ?? "";
  return (
    <ParentMyBooksContent key={currentUserId} currentUserId={currentUserId} />
  );
}

function ParentMyBooksContent({ currentUserId }: { currentUserId: string }) {
  const service = useParentPrivateBookService();
  const router = useRouter();

  const [books, setBooks] = useState<ParentPrivateBookSummaryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [minGrade, setMinGrade] = useState<number>(1);
  const [maxGrade, setMaxGrade] = useState<number>(3);
  const [sourceType, setSourceType] = useState<SourceUsageType>(
    "OWNED_PHYSICAL_BOOK",
  );
  const [sourceNote, setSourceNote] = useState("");
  const [creating, setCreating] = useState(false);

  // Inline Edit & Delete book state
  const [editingBookId, setEditingBookId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editAuthor, setEditAuthor] = useState("");
  const [editMinGrade, setEditMinGrade] = useState<number>(1);
  const [editMaxGrade, setEditMaxGrade] = useState<number>(3);
  const [editSourceType, setEditSourceType] = useState<SourceUsageType>(
    "OWNED_PHYSICAL_BOOK",
  );
  const [editSourceNote, setEditSourceNote] = useState("");
  const [savingBookId, setSavingBookId] = useState<string | null>(null);

  const [confirmDeleteBookId, setConfirmDeleteBookId] = useState<string | null>(
    null,
  );
  const [deletingBookId, setDeletingBookId] = useState<string | null>(null);

  const loadBooks = useCallback(() => {
    setReloadKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    clearPrivateMediaMemoryCache();
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (!active) return;
        setLoading(true);
        setLoadError(null);
        return service.list();
      })
      .then((items) => {
        if (!active || !items) return;
        setBooks(items);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setBooks([]);
        setLoadError(
          getErrorText(
            error,
            "Không thể tải danh sách Sách của tôi. Vui lòng thử lại.",
          ),
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentUserId, reloadKey, service]);

  async function handleCreateBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setActionNotice(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setActionError("Vui lòng nhập tên sách riêng.");
      return;
    }
    if (minGrade > maxGrade) {
      setActionError("Lớp tối thiểu không được lớn hơn lớp tối đa.");
      return;
    }

    setCreating(true);
    try {
      const created = await service.create({
        title: trimmedTitle,
        author: author.trim() || null,
        min_grade: minGrade,
        max_grade: maxGrade,
        source_type: sourceType,
        source_note: sourceNote.trim() || null,
      });
      setTitle("");
      setAuthor("");
      setSourceNote("");
      setShowCreateForm(false);
      setActionNotice(`Đã tạo sách riêng "${created.title}".`);
      setBooks((prev) => [created, ...prev]);
      router.push(`/my-books/${encodeURIComponent(created.id)}`);
    } catch (error) {
      setActionError(
        getErrorText(error, "Không thể tạo sách riêng. Vui lòng thử lại."),
      );
    } finally {
      setCreating(false);
    }
  }

  function startEditBook(book: ParentPrivateBookSummaryDTO) {
    const parsed = parseSourceDeclaration(book.source_declaration);
    setConfirmDeleteBookId(null);
    setEditingBookId(book.id);
    setEditTitle(book.title);
    setEditAuthor(book.author ?? "");
    setEditMinGrade(book.min_grade);
    setEditMaxGrade(book.max_grade);
    setEditSourceType(parsed.sourceType);
    setEditSourceNote(parsed.sourceNote);
    setActionError(null);
    setActionNotice(null);
  }

  async function handleSaveBookEdit(
    event: FormEvent<HTMLFormElement>,
    book: ParentPrivateBookSummaryDTO,
  ) {
    event.preventDefault();
    setActionError(null);
    setActionNotice(null);
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) {
      setActionError("Tên sách riêng không được để trống.");
      return;
    }
    if (editMinGrade > editMaxGrade) {
      setActionError("Lớp tối thiểu không được lớn hơn lớp tối đa.");
      return;
    }

    setSavingBookId(book.id);
    try {
      const updated = await service.update(book.id, {
        title: trimmedTitle,
        author: editAuthor.trim() || null,
        min_grade: editMinGrade,
        max_grade: editMaxGrade,
        source_type: editSourceType,
        source_note: editSourceNote.trim() || null,
      });
      setBooks((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)),
      );
      setEditingBookId(null);
      const totalRecheck = updated.pending_submission_count;
      setActionNotice(
        totalRecheck > 0
          ? `Đã sửa sách "${updated.title}". Toàn bộ ${totalRecheck} trang đã được đưa về kiểm tra lại từ đầu (OCR → Rà chính tả → Tool Check an toàn).`
          : `Đã cập nhật thông tin sách "${updated.title}".`,
      );
    } catch (error) {
      setActionError(
        getErrorText(error, "Không thể sửa sách riêng. Vui lòng thử lại."),
      );
    } finally {
      setSavingBookId(null);
    }
  }

  async function handleDeleteBook(book: ParentPrivateBookSummaryDTO) {
    setActionError(null);
    setActionNotice(null);
    setDeletingBookId(book.id);
    try {
      await service.delete(book.id);
      setBooks((prev) => prev.filter((item) => item.id !== book.id));
      setConfirmDeleteBookId(null);
      if (editingBookId === book.id) {
        setEditingBookId(null);
      }
      setActionNotice(`Đã xóa sách riêng "${book.title}".`);
    } catch (error) {
      setActionError(
        getErrorText(error, "Không thể xóa sách riêng. Vui lòng thử lại."),
      );
    } finally {
      setDeletingBookId(null);
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-primary">
            Không gian riêng của gia đình
          </p>
          <h1 className="book-title mt-1 text-3xl text-ink sm:text-4xl">
            Sách của tôi
          </h1>
          <p className="mt-2 max-w-2xl text-body text-muted">
            Tạo sách riêng và tải ảnh trang hoặc tài liệu (JPEG, PNG, WebP, BMP,
            TIFF, PDF, DOCX — tối đa 30 trang/tệp). Mỗi trang đều chạy OCR, rà
            chính tả và kiểm tra an toàn trước khi thêm vào sách đọc.
          </p>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
          <Button
            className="w-auto"
            onClick={() => void loadBooks()}
            variant="secondary"
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Tải lại
          </Button>
          <Button
            className="w-auto"
            onClick={() => setShowCreateForm((open) => !open)}
          >
            <Plus aria-hidden="true" className="size-4" />
            {showCreateForm ? "Đóng biểu mẫu" : "Tạo sách riêng"}
          </Button>
        </div>
      </header>

      <div
        role="note"
        className="flex items-start gap-3 rounded-card border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-950"
      >
        <Lock
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-emerald-700"
        />
        <div>
          <p className="font-bold">Riêng tư tuyệt đối cho gia đình bạn</p>
          <p className="mt-0.5 text-emerald-900">
            Chỉ bạn và các hồ sơ trẻ thuộc tài khoản này có thể đọc sách riêng
            sau khi trang hoàn tất kiểm tra. Sách riêng không bao giờ xuất hiện
            trong thư viện chung và không dùng để huấn luyện mô hình AI chung.
          </p>
        </div>
      </div>

      {actionError ? (
        <StatusMessage title="Thao tác chưa hoàn tất" tone="error">
          {actionError}
        </StatusMessage>
      ) : null}

      {actionNotice ? (
        <StatusMessage title="Đã cập nhật" tone="success">
          {actionNotice}
        </StatusMessage>
      ) : null}

      {showCreateForm ? (
        <form
          aria-label="Tạo sách riêng mới"
          className="flex flex-col gap-4 rounded-card border border-border bg-white p-5 shadow-sm"
          onSubmit={(event) => void handleCreateBook(event)}
        >
          <h2 className="text-xl font-extrabold text-ink">
            Thông tin sách riêng mới
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Tên sách *"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Ví dụ: Truyện cổ tích bé An thích"
              required
              value={title}
            />
            <TextField
              label="Tác giả (không bắt buộc)"
              onChange={(event) => setAuthor(event.target.value)}
              placeholder="Ví dụ: Gia đình bé An"
              value={author}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-label font-semibold text-ink">
              Phù hợp từ lớp
              <select
                aria-label="Phù hợp từ lớp"
                className="min-h-12 rounded-control border border-border bg-white px-3 text-body text-ink focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) => setMinGrade(Number(event.target.value))}
                value={minGrade}
              >
                {CHILD_GRADES.map((grade) => (
                  <option key={grade} value={grade}>
                    Lớp {grade}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-label font-semibold text-ink">
              Đến lớp
              <select
                aria-label="Đến lớp"
                className="min-h-12 rounded-control border border-border bg-white px-3 text-body text-ink focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) => setMaxGrade(Number(event.target.value))}
                value={maxGrade}
              >
                {CHILD_GRADES.map((grade) => (
                  <option key={grade} value={grade}>
                    Lớp {grade}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-label font-semibold text-ink">
              Nguồn nội dung sách
              <select
                aria-label="Nguồn nội dung sách"
                className="min-h-12 rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) =>
                  setSourceType(event.target.value as SourceUsageType)
                }
                value={sourceType}
              >
                {SOURCE_USAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <TextField
              label="Ghi chú nguồn sách (không bắt buộc)"
              onChange={(event) => setSourceNote(event.target.value)}
              placeholder="Ví dụ: Sách giấy gia đình mua cho bé luyện đọc tại nhà"
              value={sourceNote}
            />
          </div>

          <div className="flex flex-wrap gap-3 pt-2">
            <Button className="sm:w-auto" isLoading={creating} type="submit">
              {creating ? "Đang tạo sách…" : "Lưu và thêm trang"}
            </Button>
            <Button
              className="sm:w-auto"
              onClick={() => setShowCreateForm(false)}
              type="button"
              variant="secondary"
            >
              Hủy
            </Button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <div
          aria-busy="true"
          aria-label="Đang tải danh sách Sách của tôi"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-56 w-full rounded-card" />
          ))}
        </div>
      ) : loadError ? (
        <div className="flex flex-col gap-4">
          <StatusMessage title="Chưa tải được Sách của tôi" tone="error">
            {loadError}
          </StatusMessage>
          <Button
            className="sm:w-auto sm:self-start"
            onClick={() => void loadBooks()}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Thử lại
          </Button>
        </div>
      ) : books.length === 0 ? (
        <EmptyState
          action={
            <Button
              className="max-w-72"
              onClick={() => setShowCreateForm(true)}
            >
              <Plus aria-hidden="true" className="size-4" />
              Tạo sách riêng đầu tiên
            </Button>
          }
          description="Tạo sách riêng để chụp trang sách giấy hoặc tải PDF/DOCX cho bé luyện đọc tại nhà."
          icon={
            <BookMarked aria-hidden="true" className="size-10 text-primary" />
          }
          title="Bạn chưa có sách riêng nào"
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {books.map((book) => {
            const isSuspended = book.moderation_status === "SUSPENDED";
            const gradeLabel =
              book.min_grade === book.max_grade
                ? `Lớp ${book.min_grade}`
                : `Lớp ${book.min_grade}–${book.max_grade}`;
            return (
              <article
                key={book.id}
                className="flex flex-col gap-3 rounded-card border border-border bg-white p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                    <Lock aria-hidden="true" className="size-3" />
                    Sách riêng
                  </span>
                  {isSuspended ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-900">
                      <AlertTriangle aria-hidden="true" className="size-3" />
                      Đang bị đình chỉ
                    </span>
                  ) : book.readable_for_children ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-900">
                      <ShieldCheck aria-hidden="true" className="size-3" />
                      Bé có thể đọc
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-bold text-amber-950">
                      Chưa sẵn sàng đọc
                    </span>
                  )}
                </div>

                <div>
                  <h2 className="book-title text-xl text-ink">{book.title}</h2>
                  <p className="mt-1 text-sm text-muted">
                    {book.author ?? "Gia đình tự tải lên"} · {gradeLabel}
                  </p>
                </div>

                {isSuspended && book.suspended_reason ? (
                  <p className="rounded-control border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-900">
                    <strong>Lý do đình chỉ:</strong> {book.suspended_reason}
                  </p>
                ) : null}

                {book.has_held_multipage_batch ? (
                  <p className="rounded-control border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-950">
                    Tài liệu nhiều trang đang có trang bị giữ lại chờ xử lý hoặc
                    Admin duyệt nên sách chưa mở đọc trọn bộ.
                  </p>
                ) : null}

                <dl className="grid grid-cols-2 gap-2 rounded-control bg-canvas p-3 text-xs">
                  <div>
                    <dt className="text-muted">Đã thêm vào sách</dt>
                    <dd className="text-base font-extrabold text-ink">
                      {book.committed_page_count} trang
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Đang kiểm tra / chờ</dt>
                    <dd className="text-base font-extrabold text-ink">
                      {book.pending_submission_count}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Cần Admin duyệt</dt>
                    <dd className="text-base font-extrabold text-amber-800">
                      {book.flagged_submission_count}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Kiểm tra lỗi</dt>
                    <dd className="text-base font-extrabold text-rose-800">
                      {book.failed_submission_count}
                    </dd>
                  </div>
                </dl>

                <div className="mt-auto flex flex-col gap-2 pt-2">
                  <ButtonLink
                    href={`/my-books/${encodeURIComponent(book.id)}`}
                    className="min-h-11"
                  >
                    Quản lý & thêm trang
                  </ButtonLink>

                  {book.readable_for_children && !isSuspended ? (
                    <Link
                      href={`/books/${encodeURIComponent(book.id)}`}
                      className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-primary bg-sky px-3 text-sm font-bold text-primary-hover hover:bg-primary/10"
                    >
                      <BookOpen aria-hidden="true" className="size-4" />
                      Mở đọc cùng bé
                    </Link>
                  ) : (
                    <span
                      aria-disabled="true"
                      className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-border bg-canvas px-3 text-xs font-semibold text-muted"
                    >
                      Chưa mở đọc cùng bé
                    </span>
                  )}

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      aria-label={`Sửa sách ${book.title}`}
                      className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-border bg-white px-3 text-xs font-bold text-ink transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={
                        isSuspended ||
                        savingBookId === book.id ||
                        deletingBookId === book.id
                      }
                      onClick={() =>
                        editingBookId === book.id
                          ? setEditingBookId(null)
                          : startEditBook(book)
                      }
                      type="button"
                    >
                      <Pencil aria-hidden="true" className="size-3.5" />
                      Sửa sách
                    </button>
                    <button
                      aria-label={`Xóa sách ${book.title}`}
                      className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-rose-200 bg-white px-3 text-xs font-bold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={
                        savingBookId === book.id || deletingBookId === book.id
                      }
                      onClick={() => {
                        setEditingBookId(null);
                        setConfirmDeleteBookId((prev) =>
                          prev === book.id ? null : book.id,
                        );
                      }}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                      Xóa sách
                    </button>
                  </div>
                </div>

                {editingBookId === book.id ? (
                  <form
                    aria-label={`Chỉnh sửa sách ${book.title}`}
                    className="flex flex-col gap-3 rounded-control border border-amber-300 bg-amber-50/60 p-3.5 text-xs"
                    onSubmit={(event) => void handleSaveBookEdit(event, book)}
                  >
                    <p className="font-bold text-amber-950">
                      Lưu ý: Khi sửa sách, toàn bộ các trang của sách sẽ phải
                      kiểm tra lại từ đầu (OCR → Rà chính tả → Tool Check an
                      toàn) và tạm khóa đọc cùng bé cho đến khi hoàn tất.
                    </p>
                    <label className="flex flex-col gap-1 font-semibold text-ink">
                      Tên sách *
                      <input
                        aria-label="Tên sách chỉnh sửa"
                        className="min-h-10 rounded-control border border-border bg-white px-2.5 text-sm text-ink"
                        onChange={(event) => setEditTitle(event.target.value)}
                        required
                        type="text"
                        value={editTitle}
                      />
                    </label>
                    <label className="flex flex-col gap-1 font-semibold text-ink">
                      Tác giả
                      <input
                        aria-label="Tác giả chỉnh sửa"
                        className="min-h-10 rounded-control border border-border bg-white px-2.5 text-sm text-ink"
                        onChange={(event) => setEditAuthor(event.target.value)}
                        type="text"
                        value={editAuthor}
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex flex-col gap-1 font-semibold text-ink">
                        Từ lớp
                        <select
                          aria-label="Từ lớp chỉnh sửa"
                          className="min-h-10 rounded-control border border-border bg-white px-2 text-xs text-ink"
                          onChange={(event) =>
                            setEditMinGrade(Number(event.target.value))
                          }
                          value={editMinGrade}
                        >
                          {CHILD_GRADES.map((grade) => (
                            <option key={grade} value={grade}>
                              Lớp {grade}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 font-semibold text-ink">
                        Đến lớp
                        <select
                          aria-label="Đến lớp chỉnh sửa"
                          className="min-h-10 rounded-control border border-border bg-white px-2 text-xs text-ink"
                          onChange={(event) =>
                            setEditMaxGrade(Number(event.target.value))
                          }
                          value={editMaxGrade}
                        >
                          {CHILD_GRADES.map((grade) => (
                            <option key={grade} value={grade}>
                              Lớp {grade}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="flex flex-col gap-1 font-semibold text-ink">
                      Nguồn nội dung
                      <select
                        aria-label="Nguồn nội dung chỉnh sửa"
                        className="min-h-10 rounded-control border border-border bg-white px-2 text-xs text-ink"
                        onChange={(event) =>
                          setEditSourceType(
                            event.target.value as SourceUsageType,
                          )
                        }
                        value={editSourceType}
                      >
                        {SOURCE_USAGE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 font-semibold text-ink">
                      Ghi chú nguồn
                      <input
                        aria-label="Ghi chú nguồn chỉnh sửa"
                        className="min-h-10 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                        onChange={(event) =>
                          setEditSourceNote(event.target.value)
                        }
                        type="text"
                        value={editSourceNote}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        className="min-h-10 w-auto px-3 text-xs"
                        isLoading={savingBookId === book.id}
                        type="submit"
                      >
                        Lưu & kiểm tra lại toàn bộ
                      </Button>
                      <Button
                        className="min-h-10 w-auto px-3 text-xs"
                        onClick={() => setEditingBookId(null)}
                        type="button"
                        variant="secondary"
                      >
                        Hủy
                      </Button>
                    </div>
                  </form>
                ) : null}

                {confirmDeleteBookId === book.id ? (
                  <div
                    role="alertdialog"
                    aria-label={`Xác nhận xóa sách ${book.title}`}
                    className="flex flex-col gap-2.5 rounded-control border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-950"
                  >
                    <p className="font-bold">
                      Xóa sách &ldquo;{book.title}&rdquo;?
                    </p>
                    <p>
                      Sách sẽ bị xóa ngay khỏi Sách của tôi (không cần kiểm tra
                      lại).
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        className="min-h-10 w-auto bg-rose-700 px-3 text-xs text-white hover:bg-rose-800"
                        isLoading={deletingBookId === book.id}
                        onClick={() => void handleDeleteBook(book)}
                        type="button"
                      >
                        Xác nhận xóa
                      </Button>
                      <Button
                        className="min-h-10 w-auto px-3 text-xs"
                        onClick={() => setConfirmDeleteBookId(null)}
                        type="button"
                        variant="secondary"
                      >
                        Hủy
                      </Button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
