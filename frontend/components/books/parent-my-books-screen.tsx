"use client";

import {
  AlertTriangle,
  BookMarked,
  BookOpen,
  Clock3,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { FamilyStoryweaverModal } from "@/components/books/family-storyweaver-modal";
import { ReadabilityBadge } from "@/components/books/readability-badge";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { OcrServiceStatusBanner } from "@/components/common/ocr-service-status-banner";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { CreateMicroStoryModal } from "@/components/reports/create-micro-story-modal";
import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useTranslations } from "@/hooks/use-i18n";
import { useMicroStoryTranslations } from "@/messages/features/micro_story";
import { useOcrWorkerStatus } from "@/hooks/use-ocr-worker-status";
import { useParentPrivateBookService } from "@/hooks/use-parent-private-book-service";
import { emitStudioTasksChanged } from "@/lib/api/global-tasks-service";
import { isServiceError } from "@/lib/api/service-error";
import {
  DEFAULT_USER_CACHE_TTL_MS,
  PERSISTENT_USER_CACHE_MAX_STALE_MS,
  readUserCacheWithStale,
  writeUserCache,
} from "@/lib/cache/user-query-cache";
import { CHILD_GRADES } from "@/types/child";
import {
  SOURCE_USAGE_OPTIONS,
  type ParentPrivateBookSummaryDTO,
  type SourceUsageType,
} from "@/types/parent-private-book";

type BookStatusFilter = "ALL" | "READY" | "PROCESSING" | "ATTENTION";

interface CachedPrivateBooksPage {
  readonly items: ParentPrivateBookSummaryDTO[];
  readonly total: number;
}

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

const PAGE_SIZE = 9;

interface ParentMyBooksScreenProps {
  initialPage?: number;
}

export function ParentMyBooksScreen({
  initialPage = 1,
}: ParentMyBooksScreenProps) {
  const authRuntime = useAuthRuntime();
  const currentUserId = authRuntime.session?.user?.id ?? "";
  return (
    <ParentMyBooksContent
      key={currentUserId}
      currentUserId={currentUserId}
      initialPage={initialPage}
    />
  );
}

function ParentMyBooksContent({
  currentUserId,
  initialPage,
}: {
  currentUserId: string;
  initialPage: number;
}) {
  const t = useTranslations("books");
  const tMicroStory = useMicroStoryTranslations();
  const service = useParentPrivateBookService();
  const [showMicroStoryModal, setShowMicroStoryModal] = useState(false);
  const taskCenter = useOptionalAiTaskCenter();
  const router = useRouter();
  const requestIdRef = useRef(0);

  const [books, setBooks] = useState<ParentPrivateBookSummaryDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(() =>
    Number.isFinite(initialPage) && initialPage > 0
      ? Math.floor(initialPage)
      : 1,
  );
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const hasLoadedOnceRef = useRef(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<BookStatusFilter>("ALL");

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showStoryweaverModal, setShowStoryweaverModal] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [minGrade, setMinGrade] = useState<number>(1);
  const [maxGrade, setMaxGrade] = useState<number>(3);
  const [sourceType, setSourceType] = useState<SourceUsageType>(
    "OWNED_PHYSICAL_BOOK",
  );
  const [sourceNote, setSourceNote] = useState("");
  const [creating, setCreating] = useState(false);

  // Modal Edit & Delete book state
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

  const editingBook = useMemo(
    () => books.find((item) => item.id === editingBookId) ?? null,
    [books, editingBookId],
  );
  const confirmDeleteBook = useMemo(
    () => books.find((item) => item.id === confirmDeleteBookId) ?? null,
    [books, confirmDeleteBookId],
  );

  const syncPageUrl = useCallback(
    (nextPage: number) => {
      const safePage = Math.max(1, Math.floor(nextPage));
      router.replace(
        safePage > 1 ? `/my-books?page=${safePage}` : "/my-books",
        {
          scroll: false,
        },
      );
    },
    [router],
  );

  const handlePageChange = useCallback(
    (nextPage: number) => {
      const safePage = Math.max(1, Math.floor(nextPage));
      setEditingBookId(null);
      setConfirmDeleteBookId(null);
      setPage(safePage);
      syncPageUrl(safePage);
    },
    [syncPageUrl],
  );

  const loadBooks = useCallback(() => {
    setReloadKey((prev) => prev + 1);
  }, []);

  const ocrWorker = useOcrWorkerStatus({
    onRecovered: loadBooks,
  });

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    const offset = (page - 1) * PAGE_SIZE;
    const cacheKey = `my-books:p${page}`;
    const canUseSwrCache =
      Boolean(currentUserId) && process.env.NODE_ENV !== "test";

    let hydratedFromCache = false;
    void Promise.resolve()
      .then(() => {
        if (requestId !== requestIdRef.current) return;
        if (canUseSwrCache && reloadKey === 0) {
          const cached = readUserCacheWithStale<CachedPrivateBooksPage>(
            currentUserId,
            cacheKey,
            DEFAULT_USER_CACHE_TTL_MS,
            PERSISTENT_USER_CACHE_MAX_STALE_MS,
          )?.data;
          if (cached) {
            hydratedFromCache = true;
            hasLoadedOnceRef.current = true;
            setBooks(cached.items);
            setTotal(cached.total);
            setLoading(false);
          }
        }
        if (!hasLoadedOnceRef.current && !hydratedFromCache) {
          setLoading(true);
        }
        setFetching(true);
        setLoadError(null);
        return service.listPage(
          { limit: PAGE_SIZE, offset },
          controller.signal,
        );
      })
      .then((result) => {
        if (requestId !== requestIdRef.current || !result) return;
        const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
        if (result.total > 0 && page > totalPages) {
          setPage(totalPages);
          syncPageUrl(totalPages);
          return;
        }
        hasLoadedOnceRef.current = true;
        setBooks(result.items);
        setTotal(result.total);
        if (canUseSwrCache) {
          writeUserCache<CachedPrivateBooksPage>(currentUserId, cacheKey, {
            items: result.items,
            total: result.total,
          });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestId !== requestIdRef.current) {
          return;
        }
        if (!hydratedFromCache) {
          setBooks([]);
          setTotal(0);
          setLoadError(getErrorText(error, t("myBooks.loadErrorFallback")));
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setFetching(false);
        }
      });
    return () => {
      requestIdRef.current += 1;
      controller.abort();
    };
  }, [currentUserId, page, reloadKey, service, syncPageUrl, t]);

  const filterCounts = useMemo(() => {
    let ready = 0;
    let processing = 0;
    let attention = 0;
    for (const book of books) {
      const isSuspended = book.moderation_status === "SUSPENDED";
      if (
        isSuspended ||
        book.flagged_submission_count > 0 ||
        book.failed_submission_count > 0 ||
        book.has_held_multipage_batch
      ) {
        attention += 1;
      } else if (book.pending_submission_count > 0) {
        processing += 1;
      } else if (book.readable_for_children) {
        ready += 1;
      }
    }
    return {
      all: books.length,
      ready,
      processing,
      attention,
    };
  }, [books]);

  const filteredBooks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return books.filter((book) => {
      const isSuspended = book.moderation_status === "SUSPENDED";
      const hasAttention =
        isSuspended ||
        book.flagged_submission_count > 0 ||
        book.failed_submission_count > 0 ||
        book.has_held_multipage_batch;
      const isProcessing = !hasAttention && book.pending_submission_count > 0;
      const isReady = !isSuspended && book.readable_for_children;

      if (statusFilter === "READY" && !isReady) return false;
      if (statusFilter === "PROCESSING" && !isProcessing) return false;
      if (statusFilter === "ATTENTION" && !hasAttention) return false;

      if (!query) return true;
      return (
        book.title.toLowerCase().includes(query) ||
        (book.author ?? "").toLowerCase().includes(query)
      );
    });
  }, [books, searchQuery, statusFilter]);

  const hasActiveFilter = statusFilter !== "ALL" || searchQuery.trim() !== "";

  async function handleCreateBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setActionNotice(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setActionError(t("myBooks.validationTitleRequired"));
      return;
    }
    if (minGrade > maxGrade) {
      setActionError(t("myBooks.validationGradeOrder"));
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
      setActionNotice(t("myBooks.createdNotice", { title: created.title }));
      setTotal((prev) => prev + 1);
      if (page !== 1) {
        setPage(1);
      } else {
        setBooks((prev) => [created, ...prev].slice(0, PAGE_SIZE));
        setReloadKey((prev) => prev + 1);
      }
      router.push(`/my-books/${encodeURIComponent(created.id)}`);
    } catch (error) {
      setActionError(getErrorText(error, t("myBooks.createErrorFallback")));
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
      setActionError(t("myBooks.validationTitleEmpty"));
      return;
    }
    if (editMinGrade > editMaxGrade) {
      setActionError(t("myBooks.validationGradeOrder"));
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
          ? t("myBooks.updatedRecheckNotice", {
              title: updated.title,
              count: totalRecheck,
            })
          : t("myBooks.updatedNotice", { title: updated.title }),
      );
      if (totalRecheck > 0) {
        taskCenter?.markTargetAlertsSeen({ bookId: book.id });
        emitStudioTasksChanged({ portal: "parent" });
      }
      setReloadKey((prev) => prev + 1);
    } catch (error) {
      setActionError(getErrorText(error, t("myBooks.updateErrorFallback")));
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
      taskCenter?.markTargetAlertsSeen({ bookId: book.id });
      emitStudioTasksChanged({ portal: "parent" });
      setConfirmDeleteBookId(null);
      if (editingBookId === book.id) {
        setEditingBookId(null);
      }
      setActionNotice(t("myBooks.deletedNotice", { title: book.title }));
      if (books.length <= 1 && page > 1) {
        const prevPage = page - 1;
        setPage(prevPage);
        syncPageUrl(prevPage);
      } else {
        setBooks((prev) => prev.filter((item) => item.id !== book.id));
        setTotal((prev) => Math.max(0, prev - 1));
        setReloadKey((prev) => prev + 1);
      }
    } catch (error) {
      setActionError(getErrorText(error, t("myBooks.deleteErrorFallback")));
    } finally {
      setDeletingBookId(null);
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-primary">
            {t("myBooks.eyebrow")}
          </p>
          <h1 className="book-title mt-1 text-3xl text-ink sm:text-4xl">
            {t("myBooks.title")}
          </h1>
          <p className="mt-2 max-w-2xl text-body text-muted">
            {t("myBooks.headingSubtitle")}
          </p>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
          <Button
            className="w-auto"
            fullWidth={false}
            onClick={() => void loadBooks()}
            variant="secondary"
            disabled={loading || fetching}
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("myBooks.reload")}
          </Button>
          <Button
            className="w-auto"
            data-testid="my-books-open-micro-story-cta"
            fullWidth={false}
            onClick={() => setShowMicroStoryModal(true)}
            variant="secondary"
          >
            <Sparkles aria-hidden="true" className="size-4 text-primary" />
            {tMicroStory("ctaButton")}
          </Button>
          <Button
            className="w-auto"
            data-testid="open-storyweaver-modal"
            fullWidth={false}
            onClick={() => setShowStoryweaverModal(true)}
            variant="secondary"
          >
            <WandSparkles aria-hidden="true" className="size-4" />
            {t("myBooks.storyweaver.openAction")}
          </Button>
          <Button
            className="w-auto"
            fullWidth={false}
            onClick={() => setShowCreateForm((open) => !open)}
          >
            <Plus aria-hidden="true" className="size-4" />
            {showCreateForm
              ? t("myBooks.closeCreateForm")
              : t("myBooks.createPrivateBook")}
          </Button>
        </div>
      </header>

      <FamilyStoryweaverModal
        isOpen={showStoryweaverModal}
        onClose={() => setShowStoryweaverModal(false)}
        onCreated={() => {
          setActionNotice(t("myBooks.storyweaver.createdNotice"));
          void loadBooks();
        }}
      />

      <div
        role="note"
        className="flex items-center gap-2.5 rounded-control border border-emerald-200/80 bg-emerald-50/60 px-3.5 py-2.5 text-xs text-emerald-950 sm:text-sm"
      >
        <Lock aria-hidden="true" className="size-4 shrink-0 text-emerald-700" />
        <p className="min-w-0 leading-relaxed text-emerald-900">
          <strong className="font-bold text-emerald-950">
            {t("myBooks.privacyBannerTitle")}:
          </strong>{" "}
          {t("myBooks.privacyBannerBody")}
        </p>
      </div>

      <OcrServiceStatusBanner
        compact
        isChecking={ocrWorker.isChecking}
        justRecovered={ocrWorker.justRecovered}
        onDismissRecovered={ocrWorker.dismissRecoveredNotice}
        onRecheck={() => void ocrWorker.recheckNow()}
        queuedCount={ocrWorker.queueDepth}
        status={ocrWorker.status}
        variant="parent"
      />

      {actionError ? (
        <StatusMessage title={t("myBooks.actionErrorTitle")} tone="error">
          {actionError}
        </StatusMessage>
      ) : null}

      {actionNotice ? (
        <StatusMessage title={t("myBooks.actionSuccessTitle")} tone="success">
          {actionNotice}
        </StatusMessage>
      ) : null}

      {showCreateForm ? (
        <form
          aria-label={t("myBooks.createFormAria")}
          className="flex flex-col gap-4 rounded-card border border-border bg-white p-5 shadow-sm"
          onSubmit={(event) => void handleCreateBook(event)}
        >
          <h2 className="text-xl font-extrabold text-ink">
            {t("myBooks.createFormTitle")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t("myBooks.titleLabel")}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("myBooks.titlePlaceholder")}
              required
              value={title}
            />
            <TextField
              label={t("myBooks.authorLabel")}
              onChange={(event) => setAuthor(event.target.value)}
              placeholder={t("myBooks.authorPlaceholder")}
              value={author}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-label font-semibold text-ink">
              {t("myBooks.minGradeLabel")}
              <select
                aria-label={t("myBooks.minGradeLabel")}
                className="min-h-12 rounded-control border border-border bg-white px-3 text-body text-ink focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) => setMinGrade(Number(event.target.value))}
                value={minGrade}
              >
                {CHILD_GRADES.map((grade) => (
                  <option key={grade} value={grade}>
                    {t("card.gradeSingle", { grade })}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-label font-semibold text-ink">
              {t("myBooks.maxGradeLabel")}
              <select
                aria-label={t("myBooks.maxGradeLabel")}
                className="min-h-12 rounded-control border border-border bg-white px-3 text-body text-ink focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) => setMaxGrade(Number(event.target.value))}
                value={maxGrade}
              >
                {CHILD_GRADES.map((grade) => (
                  <option key={grade} value={grade}>
                    {t("card.gradeSingle", { grade })}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-label font-semibold text-ink">
              {t("myBooks.sourceUsageLabel")}
              <select
                aria-label={t("myBooks.sourceUsageLabel")}
                className="min-h-12 rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) =>
                  setSourceType(event.target.value as SourceUsageType)
                }
                value={sourceType}
              >
                {SOURCE_USAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(`sourceUsage.${opt.value}`, undefined, opt.label)}
                  </option>
                ))}
              </select>
            </label>

            <TextField
              label={t("myBooks.sourceNoteLabel")}
              onChange={(event) => setSourceNote(event.target.value)}
              placeholder={t("myBooks.sourceNotePlaceholder")}
              value={sourceNote}
            />
          </div>

          <div className="flex flex-wrap gap-3 pt-2">
            <Button className="sm:w-auto" isLoading={creating} type="submit">
              {creating ? t("myBooks.creating") : t("myBooks.saveAndAddPages")}
            </Button>
            <Button
              className="sm:w-auto"
              onClick={() => setShowCreateForm(false)}
              type="button"
              variant="secondary"
            >
              {t("reportDialog.cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <div
          aria-busy="true"
          aria-label={t("myBooks.loadingListAria")}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-56 w-full rounded-card" />
          ))}
        </div>
      ) : loadError ? (
        <div className="flex flex-col gap-4">
          <StatusMessage title={t("myBooks.loadErrorTitle")} tone="error">
            {loadError}
          </StatusMessage>
          <Button
            className="sm:w-auto sm:self-start"
            onClick={() => void loadBooks()}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("catalog.retry")}
          </Button>
        </div>
      ) : books.length === 0 && total === 0 ? (
        <EmptyState
          action={
            <Button
              className="max-w-72"
              onClick={() => setShowCreateForm(true)}
            >
              <Plus aria-hidden="true" className="size-4" />
              {t("myBooks.createFirstAction")}
            </Button>
          }
          description={t("myBooks.emptyDescription")}
          icon={
            <BookMarked aria-hidden="true" className="size-10 text-primary" />
          }
          title={t("myBooks.emptyTitle")}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-3 rounded-card border border-border bg-white/80 p-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
              />
              <input
                aria-label={t("myBooks.searchAria")}
                className="min-h-11 w-full rounded-control border border-border bg-white py-2 pr-9 pl-10 text-sm text-ink placeholder:text-muted focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("myBooks.searchPlaceholder")}
                type="search"
                value={searchQuery}
              />
              {searchQuery ? (
                <button
                  aria-label={t("myBooks.clearFilters")}
                  className="absolute top-1/2 right-2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-canvas hover:text-ink"
                  onClick={() => setSearchQuery("")}
                  type="button"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              ) : null}
            </div>

            <div
              aria-label={t("myBooks.filterAria")}
              className="flex flex-wrap items-center gap-1.5"
              role="group"
            >
              {(
                [
                  {
                    id: "ALL",
                    label: t("myBooks.filterAll"),
                    count: filterCounts.all,
                  },
                  {
                    id: "READY",
                    label: t("myBooks.filterReady"),
                    count: filterCounts.ready,
                  },
                  {
                    id: "PROCESSING",
                    label: t("myBooks.filterProcessing"),
                    count: filterCounts.processing,
                  },
                  {
                    id: "ATTENTION",
                    label: t("myBooks.filterAttention"),
                    count: filterCounts.attention,
                  },
                ] as const
              ).map((pill) => {
                const active = statusFilter === pill.id;
                return (
                  <button
                    key={pill.id}
                    aria-pressed={active}
                    className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-bold transition ${
                      active
                        ? "border-primary bg-primary text-white shadow-xs"
                        : "border-border bg-white text-ink hover:bg-canvas"
                    }`}
                    onClick={() => setStatusFilter(pill.id)}
                    type="button"
                  >
                    <span>{pill.label}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.25 text-[11px] font-extrabold ${
                        active
                          ? "bg-white/20 text-white"
                          : "bg-canvas text-muted"
                      }`}
                    >
                      {pill.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {total > PAGE_SIZE ? (
            <PaginationBar
              ariaLabel={t("myBooks.paginationTopAria")}
              compact
              disabled={fetching}
              itemLabel={t("catalog.paginationItemLabel")}
              onPageChange={handlePageChange}
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
            />
          ) : null}

          {filteredBooks.length === 0 && hasActiveFilter ? (
            <EmptyState
              action={
                <Button
                  className="max-w-60"
                  onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("ALL");
                  }}
                  variant="secondary"
                >
                  {t("myBooks.clearFilters")}
                </Button>
              }
              description={t("myBooks.filterEmptyDesc")}
              icon={
                <Search aria-hidden="true" className="size-9 text-primary" />
              }
              title={t("myBooks.filterEmptyTitle")}
            />
          ) : (
            <div
              aria-busy={fetching || undefined}
              className={`grid items-stretch gap-5 sm:grid-cols-2 lg:grid-cols-3 ${fetching ? "opacity-75 transition-opacity" : ""}`}
            >
              {filteredBooks.map((book) => {
                const isSuspended = book.moderation_status === "SUSPENDED";
                const gradeLabel =
                  book.min_grade === book.max_grade
                    ? t("card.gradeSingle", { grade: book.min_grade })
                    : t("card.gradeRange", {
                        min: book.min_grade,
                        max: book.max_grade,
                      });
                const detailHref =
                  page > 1
                    ? `/my-books/${encodeURIComponent(book.id)}?fromPage=${page}`
                    : `/my-books/${encodeURIComponent(book.id)}`;
                const hasConditionPills =
                  book.pending_submission_count > 0 ||
                  book.flagged_submission_count > 0 ||
                  book.failed_submission_count > 0;
                return (
                  <article
                    key={book.id}
                    data-private-book-id={book.id}
                    className="flex h-full min-w-0 flex-col gap-3 rounded-card border border-border bg-white p-5 shadow-sm transition hover:border-primary/40 hover:shadow-md"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {isSuspended ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-900">
                          <AlertTriangle
                            aria-hidden="true"
                            className="size-3 shrink-0"
                          />
                          {t("myBooks.suspendedBadge")}
                        </span>
                      ) : book.readable_for_children ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-900">
                          <ShieldCheck
                            aria-hidden="true"
                            className="size-3 shrink-0"
                          />
                          {t("myBooks.readableBadge")}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-bold text-amber-950">
                          <Clock3
                            aria-hidden="true"
                            className="size-3 shrink-0"
                          />
                          {t("myBooks.notReadyBadge")}
                        </span>
                      )}

                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted">
                        <Lock
                          aria-hidden="true"
                          className="size-3 shrink-0 text-emerald-700"
                        />
                        {t("myBooks.privateBadge")}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <h2
                        className="book-title viread-learning-content line-clamp-2 break-words text-xl text-ink"
                        dir="ltr"
                        lang="vi"
                        title={book.title}
                      >
                        {book.title}
                      </h2>
                      <p className="mt-1 line-clamp-1 break-words text-sm text-muted">
                        {book.author ? (
                          <span
                            className="viread-learning-content"
                            dir="ltr"
                            lang="vi"
                          >
                            {book.author}
                          </span>
                        ) : (
                          t("myBooks.defaultAuthor")
                        )}{" "}
                        · {gradeLabel}
                      </p>
                      <ReadabilityBadge
                        className="mt-2"
                        readability={book.readability}
                      />
                    </div>

                    {isSuspended && book.suspended_reason ? (
                      <p className="break-words rounded-control border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-900">
                        <strong>{t("myBooks.suspendedReasonLabel")}</strong>{" "}
                        {book.suspended_reason}
                      </p>
                    ) : null}

                    {book.has_held_multipage_batch ? (
                      <p className="rounded-control border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-950">
                        {t("myBooks.multiPageHoldingNotice")}
                      </p>
                    ) : null}

                    {ocrWorker.isUnavailable &&
                    book.pending_submission_count > 0 ? (
                      <div
                        className="flex items-center gap-2 rounded-control border border-amber-300 bg-amber-50/90 px-2.5 py-2 text-xs font-semibold text-amber-950"
                        data-testid={`book-waiting-ocr-${book.id}`}
                      >
                        <Clock3
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-amber-700"
                        />
                        <span>{t("myBooks.waitingOcrReopenBadge")}</span>
                      </div>
                    ) : null}

                    <div className="flex flex-col gap-2 rounded-control bg-canvas/85 px-3 py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-ink">
                          {book.committed_page_count > 0
                            ? t("myBooks.readyPagesSummary", {
                                count: book.committed_page_count,
                              })
                            : t("myBooks.noReadyPagesSummary")}
                        </span>
                        <span className="font-bold text-primary">
                          {t("catalog.pagesCount", {
                            count: book.committed_page_count,
                          })}
                        </span>
                      </div>

                      {hasConditionPills ? (
                        <div className="flex flex-wrap gap-1.5">
                          {book.pending_submission_count > 0 ? (
                            <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-900">
                              {t("myBooks.pillPending", {
                                count: book.pending_submission_count,
                              })}
                            </span>
                          ) : null}
                          {book.flagged_submission_count > 0 ? (
                            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-900">
                              {t("myBooks.pillFlagged", {
                                count: book.flagged_submission_count,
                              })}
                            </span>
                          ) : null}
                          {book.failed_submission_count > 0 ? (
                            <span className="inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-900">
                              {t("myBooks.pillFailed", {
                                count: book.failed_submission_count,
                              })}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-auto flex flex-col gap-2 pt-2">
                      {book.readable_for_children && !isSuspended ? (
                        <>
                          <Link
                            href={`/books/${encodeURIComponent(book.id)}`}
                            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-control bg-primary px-3 text-sm font-bold text-white shadow-xs transition hover:bg-primary-hover"
                          >
                            <BookOpen aria-hidden="true" className="size-4" />
                            {t("myBooks.openReadWithChild")}
                          </Link>
                          <ButtonLink
                            href={detailHref}
                            className="min-h-10"
                            variant="secondary"
                          >
                            {t("myBooks.manageAndAddPages")}
                          </ButtonLink>
                        </>
                      ) : (
                        <>
                          <ButtonLink href={detailHref} className="min-h-11">
                            {t("myBooks.manageAndAddPages")}
                          </ButtonLink>
                          <span
                            aria-disabled="true"
                            className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-border bg-canvas px-3 text-xs font-semibold text-muted"
                          >
                            {t("myBooks.notOpenReadYet")}
                          </span>
                        </>
                      )}

                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <button
                          aria-label={t("myBooks.editBookAria", {
                            title: book.title,
                          })}
                          className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-border bg-white px-3 text-xs font-bold text-ink transition hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={
                            isSuspended ||
                            savingBookId === book.id ||
                            deletingBookId === book.id
                          }
                          onClick={() => startEditBook(book)}
                          type="button"
                        >
                          <Pencil aria-hidden="true" className="size-3.5" />
                          {t("myBooks.editBook")}
                        </button>
                        <button
                          aria-label={t("myBooks.deleteBookAria", {
                            title: book.title,
                          })}
                          className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-control border border-rose-200 bg-white px-3 text-xs font-bold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={
                            savingBookId === book.id ||
                            deletingBookId === book.id
                          }
                          onClick={() => {
                            setEditingBookId(null);
                            setConfirmDeleteBookId(book.id);
                          }}
                          type="button"
                        >
                          <Trash2 aria-hidden="true" className="size-3.5" />
                          {t("myBooks.deleteBook")}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          <PaginationBar
            ariaLabel={t("myBooks.paginationBottomAria")}
            disabled={fetching}
            itemLabel={t("catalog.paginationItemLabel")}
            onPageChange={handlePageChange}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
          />
        </div>
      )}

      <Modal
        closeOnBackdropClick
        isOpen={Boolean(editingBook)}
        onClose={() => setEditingBookId(null)}
        title={t("myBooks.editModalTitle")}
        tone="paper"
      >
        {editingBook ? (
          <form
            aria-label={t("myBooks.editFormAria", {
              title: editingBook.title,
            })}
            className="flex flex-col gap-3.5 text-sm"
            onSubmit={(event) => void handleSaveBookEdit(event, editingBook)}
          >
            <p className="rounded-control border border-amber-300 bg-amber-50 p-3 text-xs font-semibold leading-relaxed text-amber-950">
              {t("myBooks.editRecheckNotice")}
            </p>
            <label className="flex flex-col gap-1 font-semibold text-ink">
              {t("myBooks.titleLabel")}
              <input
                aria-label={t("myBooks.editTitleAria")}
                className="min-h-11 rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) => setEditTitle(event.target.value)}
                required
                type="text"
                value={editTitle}
              />
            </label>
            <label className="flex flex-col gap-1 font-semibold text-ink">
              {t("myBooks.editAuthorLabel")}
              <input
                aria-label={t("myBooks.editAuthorAria")}
                className="min-h-11 rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) => setEditAuthor(event.target.value)}
                type="text"
                value={editAuthor}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 font-semibold text-ink">
                {t("myBooks.editMinGradeLabel")}
                <select
                  aria-label={t("myBooks.editMinGradeAria")}
                  className="min-h-11 rounded-control border border-border bg-white px-2.5 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                  onChange={(event) =>
                    setEditMinGrade(Number(event.target.value))
                  }
                  value={editMinGrade}
                >
                  {CHILD_GRADES.map((grade) => (
                    <option key={grade} value={grade}>
                      {t("card.gradeSingle", { grade })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 font-semibold text-ink">
                {t("myBooks.editMaxGradeLabel")}
                <select
                  aria-label={t("myBooks.editMaxGradeAria")}
                  className="min-h-11 rounded-control border border-border bg-white px-2.5 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                  onChange={(event) =>
                    setEditMaxGrade(Number(event.target.value))
                  }
                  value={editMaxGrade}
                >
                  {CHILD_GRADES.map((grade) => (
                    <option key={grade} value={grade}>
                      {t("card.gradeSingle", { grade })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1 font-semibold text-ink">
              {t("myBooks.editSourceLabel")}
              <select
                aria-label={t("myBooks.editSourceAria")}
                className="min-h-11 rounded-control border border-border bg-white px-2.5 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) =>
                  setEditSourceType(event.target.value as SourceUsageType)
                }
                value={editSourceType}
              >
                {SOURCE_USAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(`sourceUsage.${opt.value}`, undefined, opt.label)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 font-semibold text-ink">
              {t("myBooks.editSourceNoteLabel")}
              <input
                aria-label={t("myBooks.editSourceNoteAria")}
                className="min-h-11 rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                onChange={(event) => setEditSourceNote(event.target.value)}
                type="text"
                value={editSourceNote}
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button
                className="min-h-11 w-auto px-4 text-sm"
                fullWidth={false}
                onClick={() => setEditingBookId(null)}
                type="button"
                variant="secondary"
              >
                {t("reportDialog.cancel")}
              </Button>
              <Button
                className="min-h-11 w-auto px-4 text-sm"
                fullWidth={false}
                isLoading={savingBookId === editingBook.id}
                type="submit"
              >
                {t("myBooks.saveAndRecheckAll")}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal
        closeOnBackdropClick
        isOpen={Boolean(confirmDeleteBook)}
        onClose={() => setConfirmDeleteBookId(null)}
        role="alertdialog"
        title={t("myBooks.deleteModalTitle")}
        tone="paper"
      >
        {confirmDeleteBook ? (
          <div className="flex flex-col gap-4 text-sm text-ink">
            <p className="break-words font-bold text-rose-950">
              {t("myBooks.deleteDialogTitle", {
                title: confirmDeleteBook.title,
              })}
            </p>
            <p className="text-muted">{t("myBooks.deleteDialogBody")}</p>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button
                className="min-h-11 w-auto px-4 text-sm"
                fullWidth={false}
                onClick={() => setConfirmDeleteBookId(null)}
                type="button"
                variant="secondary"
              >
                {t("reportDialog.cancel")}
              </Button>
              <Button
                className="min-h-11 w-auto bg-rose-700 px-4 text-sm text-white hover:bg-rose-800"
                fullWidth={false}
                isLoading={deletingBookId === confirmDeleteBook.id}
                onClick={() => void handleDeleteBook(confirmDeleteBook)}
                type="button"
              >
                {t("myBooks.confirmDelete")}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
      <CreateMicroStoryModal
        isOpen={showMicroStoryModal}
        onClose={() => setShowMicroStoryModal(false)}
        onStoryCreated={() => {
          loadBooks();
        }}
      />
    </section>
  );
}
