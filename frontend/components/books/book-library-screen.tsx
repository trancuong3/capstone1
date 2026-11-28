"use client";

import { BookMarked, BookOpenText, RefreshCw, SearchX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

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
  const {
    state: childState,
    selectedChildId: appSelectedChildId,
    retry: retryChild,
  } = useValidatedSelectedChild();
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
  const filteredBooks = useMemo(() => {
    if (catalogState.status !== "ready") {
      return [];
    }
    if (selectedGrade === null) {
      return catalogState.books;
    }
    return catalogState.books.filter(
      (book) =>
        book.min_grade <= selectedGrade && selectedGrade <= book.max_grade,
    );
  }, [catalogState, selectedGrade]);
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
    if (!appSelectedChildId) {
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
          search: effectiveSearch,
          include_private: true,
        });
        if (!isActive) return;
        const hasFilters = effectiveSearch.length > 0;
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
    appSelectedChildId,
    bookService,
    currentUserId,
    effectiveSearch,
    requestKey,
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
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-3 px-3.5 pt-0 pb-24 sm:gap-6 sm:px-8 sm:py-8">
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

      <div className="mx-auto flex w-full max-w-[1130px] flex-col gap-3.5 sm:gap-6">
        <div className="flex flex-wrap items-end justify-between gap-2.5 border-b border-border pb-3 sm:gap-4 sm:pb-6">
          <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:flex-col sm:items-start sm:gap-2">
            <h1 className="book-title min-w-0 truncate text-xl text-ink sm:whitespace-normal sm:break-words sm:text-4xl lg:text-5xl">
              {child
                ? t("catalog.familyBooksTitle", { alias: child.alias })
                : t("catalog.familyBooksDefaultTitle")}
            </h1>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <ButtonLink
                href="/my-books"
                variant="secondary"
                className="min-h-11! w-auto gap-1.5 px-3! py-1.5! text-xs! sm:min-h-12! sm:gap-2 sm:px-4! sm:py-2! sm:text-sm!"
              >
                <BookMarked aria-hidden="true" className="size-4" />
                {t("catalog.myBooksLink")}
              </ButtonLink>
            </div>
          </div>
          <div className="w-full sm:max-w-sm [&_input]:h-12 [&_input]:pt-5 [&_input]:pb-1.5 [&_input]:text-sm [&_label]:top-1.5 [&_label]:text-[11px] sm:[&_input]:h-[72px] sm:[&_input]:pt-8 sm:[&_input]:pb-3 sm:[&_input]:text-body sm:[&_label]:top-3 sm:[&_label]:text-sm">
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
          <div className="no-scrollbar -mx-3.5 flex flex-nowrap gap-1.5 overflow-x-auto px-3.5 pb-0.5 sm:mx-0 sm:flex-wrap sm:gap-2 sm:overflow-visible sm:px-0 sm:pb-0">
            {[null, ...CHILD_GRADES].map((grade) => {
              const isSelected = selectedGrade === grade;

              return (
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    "flex min-h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:min-h-12 sm:rounded-control sm:border-0 sm:px-4 sm:text-label",
                    isSelected
                      ? "border-primary/30 bg-sky text-primary-hover"
                      : "border-border bg-white text-ink hover:bg-sky",
                  )}
                  key={grade ?? "all"}
                  onClick={() => {
                    if (child) {
                      setPage(1);
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
            className="grid gap-3 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3"
          >
            <span className="sr-only" role="status">
              {t("catalog.loadingText")}
            </span>
            {[0, 1, 2, 3].map((item) => (
              <Skeleton
                className="h-[126px] w-full rounded-card sm:h-[432px] sm:w-64"
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
        filteredBooks.length === 0 &&
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
        filteredBooks.length === 0 &&
        catalogState.hasCatalog ? (
          <EmptyState
            action={
              <Button
                className="max-w-72"
                onClick={() => {
                  setSearch("");
                  setPage(1);
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

        {catalogState.status === "ready" && filteredBooks.length > 0
          ? (() => {
              const totalBooksPages = Math.max(
                1,
                Math.ceil(filteredBooks.length / BOOKS_PAGE_SIZE),
              );
              const safePage = Math.min(Math.max(1, page), totalBooksPages);
              const visibleBooks = filteredBooks.slice(
                (safePage - 1) * BOOKS_PAGE_SIZE,
                safePage * BOOKS_PAGE_SIZE,
              );
              return (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
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
                    total={filteredBooks.length}
                  />
                </>
              );
            })()
          : null}
      </div>
    </section>
  );
}
