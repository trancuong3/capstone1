"use client";

import { BookMarked, BookOpenText, RefreshCw, SearchX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { BookCard } from "@/components/books/book-card";
import { BookChildHeader } from "@/components/books/book-child-header";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useBookService } from "@/hooks/use-book-service";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { useReadingManagementService } from "@/hooks/use-reading-management-service";
import { cn } from "@/lib/utils/cn";
import type { BookListItemDTO } from "@/types/book";
import type {
  BookCollectionType,
  ChildBookCollectionDTO,
} from "@/types/reading-management";
import { CHILD_GRADES } from "@/types/child";

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; books: BookListItemDTO[]; hasCatalog: boolean }
  | { status: "error" };

const BOOKS_PAGE_SIZE = 12;

export function BookLibraryScreen() {
  const authRuntime = useAuthRuntime();
  const currentUserId = authRuntime.session?.user?.id ?? "";
  const bookService = useBookService();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const readingManagementService = useReadingManagementService();
  const [catalogState, setCatalogState] = useState<CatalogState>({
    status: "loading",
  });
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const effectiveSearch = search.trim() ? debouncedSearch : "";
  const [page, setPage] = useState(1);
  const knownNonEmptyCatalogRef = useRef<{
    scopeKey: string;
    nonEmpty: boolean;
  }>({ scopeKey: "", nonEmpty: false });
  const [gradeSelection, setGradeSelection] = useState<{
    childId: string;
    grade: number | null;
  } | null>(null);
  const [requestKey, setRequestKey] = useState(0);
  const [savedCollections, setSavedCollections] = useState<
    ChildBookCollectionDTO[]
  >([]);
  const [savedCollectionOwner, setSavedCollectionOwner] = useState("");
  const [collectionBusyKey, setCollectionBusyKey] = useState("");
  const [collectionNotice, setCollectionNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const child = childState.status === "ready" ? childState.child : null;
  const selectedChildId = child?.id ?? "";
  const selectedGrade = child
    ? gradeSelection && gradeSelection.childId === child.id
      ? gradeSelection.grade
      : child.grade
    : null;
  const visibleSavedCollections =
    savedCollectionOwner === selectedChildId ? savedCollections : [];

  useEffect(() => {
    if (!search.trim() || debouncedSearch === search) {
      return;
    }
    const timer = globalThis.setTimeout(() => {
      setDebouncedSearch(search);
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [debouncedSearch, search]);

  useEffect(() => {
    if (!selectedChildId) {
      return;
    }
    let isActive = true;
    void readingManagementService
      .listCollections(selectedChildId)
      .then((items) => {
        if (!isActive) return;
        setSavedCollections(items);
        setSavedCollectionOwner(selectedChildId);
        setCollectionNotice(null);
      })
      .catch(() => {
        if (!isActive) return;
        setSavedCollections([]);
        setSavedCollectionOwner(selectedChildId);
        setCollectionNotice({
          tone: "error",
          text: "Chưa tải được trạng thái sách đã lưu. Hãy kiểm tra backend và migration Reading Management.",
        });
      });
    return () => {
      isActive = false;
    };
  }, [readingManagementService, selectedChildId, requestKey]);

  async function toggleSavedCollection(
    bookId: string,
    type: BookCollectionType,
  ) {
    if (!selectedChildId || collectionBusyKey) return;
    const existing = visibleSavedCollections.find(
      (item) => item.book_id === bookId && item.collection_type === type,
    );
    setCollectionBusyKey(bookId + ":" + type);
    setCollectionNotice(null);
    try {
      if (existing) {
        await readingManagementService.removeCollection(
          selectedChildId,
          bookId,
          type,
        );
        setSavedCollections((items) =>
          items.filter((item) => item.id !== existing.id),
        );
        setCollectionNotice({
          tone: "success",
          text: "Đã gỡ sách khỏi danh sách.",
        });
      } else {
        const saved = await readingManagementService.addCollection(
          selectedChildId,
          bookId,
          type,
        );
        setSavedCollections((items) =>
          items.some((item) => item.id === saved.id)
            ? items
            : [...items, saved],
        );
        setCollectionNotice({
          tone: "success",
          text: "Đã lưu sách cho hồ sơ bé.",
        });
      }
    } catch {
      setCollectionNotice({
        tone: "error",
        text: "Không lưu được thay đổi. Vui lòng thử lại; trạng thái chưa được cập nhật.",
      });
    } finally {
      setCollectionBusyKey("");
    }
  }

  useEffect(() => {
    if (childState.status !== "ready") {
      return;
    }

    const scopeKey = `${currentUserId}:${selectedChildId}`;
    if (knownNonEmptyCatalogRef.current.scopeKey !== scopeKey) {
      knownNonEmptyCatalogRef.current = { scopeKey, nonEmpty: false };
    }
    let isActive = true;

    async function loadCatalog() {
      setCatalogState((current) =>
        current.status === "loading" ? current : { status: "loading" },
      );

      try {
        const books = await bookService.list({
          grade: selectedGrade ?? undefined,
          search: effectiveSearch,
          include_private: true,
        });
        if (!isActive) return;
        const hasFilters = selectedGrade !== null || effectiveSearch.length > 0;
        let hasCatalog = books.length > 0;
        if (!hasCatalog && hasFilters) {
          hasCatalog =
            knownNonEmptyCatalogRef.current.nonEmpty ||
            (await bookService.list({ include_private: true })).length > 0;
        }

        if (isActive) {
          knownNonEmptyCatalogRef.current = { scopeKey, nonEmpty: hasCatalog };
          setPage(1);
          setCatalogState({
            status: "ready",
            books,
            hasCatalog,
          });
        }
      } catch {
        if (isActive) {
          setCatalogState({ status: "error" });
        }
      }
    }

    void loadCatalog();
    return () => {
      isActive = false;
    };
  }, [
    bookService,
    childState.status,
    currentUserId,
    effectiveSearch,
    requestKey,
    selectedChildId,
    selectedGrade,
  ]);

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[1280px] px-4 py-8"
      >
        <span className="sr-only" role="status">
          Đang xác minh hồ sơ trẻ…
        </span>
        <Skeleton className="h-14 w-full max-w-sm rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title="Không thể xác minh hồ sơ trẻ" tone="error">
          Chưa thể xác nhận hồ sơ thuộc tài khoản hiện tại. Ba mẹ vui lòng thử
          lại.
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      <BookChildHeader
        child={child}
        fullBleedDesktop
        mobileLabel="Cùng bé chọn một cuốn sách"
      />

      {collectionNotice ? (
        <StatusMessage
          title={
            collectionNotice.tone === "success"
              ? "Đã cập nhật danh sách"
              : "Không thể cập nhật danh sách"
          }
          tone={collectionNotice.tone}
        >
          {collectionNotice.text}
        </StatusMessage>
      ) : null}

      <div className="mx-auto flex w-full max-w-[1130px] flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5 sm:pb-6">
          <div className="flex flex-col gap-2">
            <h1 className="book-title min-w-0 break-words text-2xl text-ink sm:text-4xl lg:text-5xl">
              Tủ sách{child ? ` của ${child.alias}` : " của bé"}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <ButtonLink
                href="/my-books"
                variant="secondary"
                className="min-h-12 w-auto px-4 text-sm"
              >
                <BookMarked aria-hidden="true" className="size-4" />
                Sách của tôi
              </ButtonLink>
            </div>
          </div>
          <div className="w-full sm:max-w-sm">
            <TextField
              aria-label="Tìm theo tên sách hoặc tác giả"
              label="Tìm cuốn sách bé thích…"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Tìm theo tên sách hoặc tác giả"
              type="search"
              value={search}
            />
          </div>
        </div>

        <fieldset className="min-w-0">
          <legend className="sr-only">Lọc sách theo lớp</legend>
          <div className="flex flex-wrap gap-2">
            {[null, ...CHILD_GRADES].map((grade) => {
              const isSelected = selectedGrade === grade;

              return (
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    "flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-control px-4 text-label font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                    isSelected
                      ? "bg-sky text-primary-hover"
                      : "bg-white text-ink hover:bg-sky",
                  )}
                  key={grade ?? "all"}
                  onClick={() => {
                    if (child) {
                      setGradeSelection({ childId: child.id, grade });
                    }
                  }}
                  type="button"
                >
                  {grade === null ? "Tất cả" : `Lớp ${grade}`}
                </button>
              );
            })}
          </div>
        </fieldset>

        {catalogState.status === "loading" ? (
          <div
            aria-busy="true"
            aria-label="Đang tải thư viện sách"
            className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
          >
            <span className="sr-only" role="status">
              Đang tải sách…
            </span>
            {[0, 1, 2, 3].map((item) => (
              <Skeleton
                className="h-[432px] w-full rounded-card sm:w-64"
                key={item}
              />
            ))}
          </div>
        ) : null}

        {catalogState.status === "error" ? (
          <div className="flex flex-col gap-4">
            <StatusMessage title="Chưa tải được thư viện sách" tone="error">
              Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
            </StatusMessage>
            <Button
              className="sm:w-auto sm:self-start sm:px-8"
              onClick={() => setRequestKey((key) => key + 1)}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-5" />
              Thử lại
            </Button>
          </div>
        ) : null}

        {catalogState.status === "ready" &&
        catalogState.books.length === 0 &&
        !catalogState.hasCatalog ? (
          <EmptyState
            description="Các câu chuyện đã xác minh sẽ xuất hiện tại đây khi sẵn sàng."
            icon={
              <BookOpenText
                aria-hidden="true"
                className="size-10 text-primary"
              />
            }
            title="Thư viện đang được cập nhật"
          />
        ) : null}

        {catalogState.status === "ready" &&
        catalogState.books.length === 0 &&
        catalogState.hasCatalog ? (
          <EmptyState
            action={
              <Button
                className="max-w-72"
                onClick={() => {
                  setSearch("");
                  setGradeSelection({
                    childId: selectedChildId,
                    grade: null,
                  });
                }}
                variant="secondary"
              >
                Xóa bộ lọc
              </Button>
            }
            description="Thử tên sách, tác giả hoặc lớp khác nhé."
            icon={
              <SearchX aria-hidden="true" className="size-10 text-primary" />
            }
            title="Không tìm thấy cuốn sách phù hợp"
          />
        ) : null}

        {catalogState.status === "ready" && catalogState.books.length > 0 ? (
          <>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {catalogState.books
                .slice((page - 1) * BOOKS_PAGE_SIZE, page * BOOKS_PAGE_SIZE)
                .map((book) => (
                  <BookCard
                    book={book}
                    key={book.id}
                    savedTypes={visibleSavedCollections
                      .filter((item) => item.book_id === book.id)
                      .map((item) => item.collection_type)}
                    collectionBusy={collectionBusyKey.startsWith(book.id + ":")}
                    onToggleCollection={(type) =>
                      void toggleSavedCollection(book.id, type)
                    }
                  />
                ))}
            </div>
            <PaginationBar
              ariaLabel="Phân trang thư viện sách"
              itemLabel="cuốn sách"
              onPageChange={setPage}
              page={page}
              pageSize={BOOKS_PAGE_SIZE}
              total={catalogState.books.length}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}
