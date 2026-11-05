"use client";

import { BookOpenText, Check, RefreshCw, SearchX } from "lucide-react";
import { useEffect, useState } from "react";

import { BookCard } from "@/components/books/book-card";
import { BookChildHeader } from "@/components/books/book-child-header";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
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

export function BookLibraryScreen() {
  const bookService = useBookService();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const readingManagementService = useReadingManagementService();
  const [catalogState, setCatalogState] = useState<CatalogState>({
    status: "loading",
  });
  const [search, setSearch] = useState("");
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

    let isActive = true;

    async function loadCatalog() {
      setCatalogState({ status: "loading" });

      try {
        const books = await bookService.list({
          grade: selectedGrade ?? undefined,
          search,
        });
        // A second request is only needed to distinguish an empty catalog
        // from an empty filtered result. Never substitute sample books.
        const hasFilters = selectedGrade !== null || search.trim().length > 0;
        const hasCatalog =
          books.length > 0 ||
          (hasFilters && (await bookService.list()).length > 0);

        if (isActive) {
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
    requestKey,
    search,
    selectedChildId,
    selectedGrade,
  ]);

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[1130px] px-4 py-8"
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
      <BookChildHeader child={child} />
      {child ? (
        <div className="mx-auto w-full max-w-[1130px]">
          <SelectedChildIdentity child={child} />
        </div>
      ) : null}

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

      <div className="mx-auto flex w-full max-w-[1130px] flex-col gap-4 sm:gap-6">
        <div className="flex flex-col gap-4 lg:min-h-16 lg:flex-row lg:items-center lg:gap-6">
          <h1
            aria-label={
              child
                ? `${child.alias} muốn đọc gì hôm nay?`
                : "Bé muốn đọc gì hôm nay?"
            }
            className="min-w-0 flex-1 text-heading font-extrabold text-ink"
          >
            <span className="hidden sm:inline">
              {child
                ? `${child.alias} muốn đọc gì hôm nay?`
                : "Bé muốn đọc gì hôm nay?"}
            </span>
            <span className="sm:hidden">Bé muốn đọc gì hôm nay?</span>
          </h1>
          <div className="w-full lg:w-[486px]">
            <TextField
              aria-label="Tìm theo tên sách hoặc tác giả"
              label="Tìm cuốn sách bé thích…"
              onChange={(event) => setSearch(event.target.value)}
              type="search"
              value={search}
            />
          </div>
        </div>

        <fieldset className="min-w-0">
          <legend className="sr-only">Lọc sách theo lớp</legend>
          <div className="flex gap-3 overflow-x-auto pb-1 sm:flex-wrap">
            {[null, ...CHILD_GRADES].map((grade) => {
              const isSelected = selectedGrade === grade;

              return (
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    "flex h-16 min-w-[132px] shrink-0 items-center justify-center gap-2 rounded-control px-4 text-button font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                    isSelected
                      ? "bg-sky text-primary-hover ring-2 ring-primary"
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
                  {isSelected ? (
                    <Check aria-hidden="true" className="size-5 shrink-0" />
                  ) : null}
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
            className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
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
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {catalogState.books.map((book) => (
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
        ) : null}
      </div>

      <p className="mt-auto text-center text-body text-muted">
        Mỗi câu chuyện là một điều mới để khám phá.
      </p>
    </section>
  );
}
