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
import { useTranslations } from "@/hooks/use-i18n";
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

const BOOKS_PAGE_SIZE = 9;

export function BookLibraryScreen() {
  const t = useTranslations("books");
  const tc = useTranslations("child");
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
          text: t("catalog.savedStatusError"),
        });
      });
    return () => {
      isActive = false;
    };
  }, [readingManagementService, selectedChildId, requestKey, t]);

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
          text: t("catalog.removedFromCollection"),
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
          text: t("catalog.savedForChild"),
        });
      }
    } catch {
      setCollectionNotice({
        tone: "error",
        text: t("catalog.saveCollectionFailed"),
      });
    } finally {
      setCollectionBusyKey("");
    }
  }

  useEffect(() => {
    if (childState.status !== "ready") {
      return;
    }

    const scopeKey = currentUserId;
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
          {tc("verification.loading")}
        </span>
        <Skeleton className="h-14 w-full max-w-sm rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title={tc("verification.errorTitle")} tone="error">
          {tc("verification.errorBody")}
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" />
          {tc("verification.retry")}
        </Button>
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      <BookChildHeader
        child={child}
        fullBleedDesktop
        mobileLabel={t("catalog.subtitle")}
      />

      {collectionNotice ? (
        <StatusMessage
          title={
            collectionNotice.tone === "success"
              ? t("catalog.collectionUpdatedStatus")
              : t("catalog.collectionUpdateFailedStatus")
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
              {child
                ? t("catalog.familyBooksTitle", { alias: child.alias })
                : t("catalog.familyBooksDefaultTitle")}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <ButtonLink
                href="/my-books"
                variant="secondary"
                className="min-h-12 w-auto px-4 text-sm"
              >
                <BookMarked aria-hidden="true" className="size-4" />
                {t("catalog.myBooksLink")}
              </ButtonLink>
            </div>
          </div>
          <div className="w-full sm:max-w-sm">
            <TextField
              aria-label={t("catalog.searchAria")}
              label={t("catalog.searchLabel")}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("catalog.searchInputPlaceholder")}
              type="search"
              value={search}
            />
          </div>
        </div>

        <fieldset className="min-w-0">
          <legend className="sr-only">{t("catalog.gradeFilterLegend")}</legend>
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
                  {grade === null
                    ? t("catalog.gradeAllOption")
                    : t("catalog.gradeOption", { grade })}
                </button>
              );
            })}
          </div>
        </fieldset>

        {catalogState.status === "loading" ? (
          <div
            aria-busy="true"
            aria-label={t("catalog.loadingAria")}
            className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
          >
            <span className="sr-only" role="status">
              {t("catalog.loadingText")}
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
            <StatusMessage title={t("catalog.loadErrorTitle")} tone="error">
              {t("catalog.loadErrorBody")}
            </StatusMessage>
            <Button
              className="sm:w-auto sm:self-start sm:px-8"
              onClick={() => setRequestKey((key) => key + 1)}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-5" />
              {t("catalog.retry")}
            </Button>
          </div>
        ) : null}

        {catalogState.status === "ready" &&
        catalogState.books.length === 0 &&
        !catalogState.hasCatalog ? (
          <EmptyState
            description={t("catalog.updatingDescription")}
            icon={
              <BookOpenText
                aria-hidden="true"
                className="size-10 text-primary"
              />
            }
            title={t("catalog.updatingTitle")}
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
                {t("catalog.clearFilter")}
              </Button>
            }
            description={t("catalog.emptyFilteredDescription")}
            icon={
              <SearchX aria-hidden="true" className="size-10 text-primary" />
            }
            title={t("catalog.emptyFilteredTitle")}
          />
        ) : null}

        {catalogState.status === "ready" && catalogState.books.length > 0
          ? (() => {
              const totalBooksPages = Math.max(
                1,
                Math.ceil(catalogState.books.length / BOOKS_PAGE_SIZE),
              );
              const safePage = Math.min(Math.max(1, page), totalBooksPages);
              const visibleBooks = catalogState.books.slice(
                (safePage - 1) * BOOKS_PAGE_SIZE,
                safePage * BOOKS_PAGE_SIZE,
              );
              return (
                <>
                  <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleBooks.map((book) => (
                      <BookCard
                        book={book}
                        key={book.id}
                        savedTypes={visibleSavedCollections
                          .filter((item) => item.book_id === book.id)
                          .map((item) => item.collection_type)}
                        collectionBusy={collectionBusyKey.startsWith(
                          book.id + ":",
                        )}
                        onToggleCollection={(type) =>
                          void toggleSavedCollection(book.id, type)
                        }
                      />
                    ))}
                  </div>
                  <PaginationBar
                    ariaLabel={t("catalog.paginationAria")}
                    compact
                    itemLabel={t("catalog.paginationItemLabel")}
                    onPageChange={setPage}
                    page={safePage}
                    pageSize={BOOKS_PAGE_SIZE}
                    total={catalogState.books.length}
                  />
                </>
              );
            })()
          : null}
      </div>
    </section>
  );
}
