"use client";

import Link from "next/link";
import { BookHeart, Trash2 } from "lucide-react";

import { Button } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { useTranslations } from "@/hooks/use-i18n";
import type { BookListItemDTO } from "@/types/book";
import type {
  BookCollectionType,
  ChildBookCollectionDTO,
} from "@/types/reading-management";
import { COLLECTIONS_PAGE_SIZE } from "./reading-management-utils";
import { VerifiedBookPicker } from "./verified-book-picker";

export interface ReadingCollectionsSectionProps {
  readonly childId: string;
  readonly collections: readonly ChildBookCollectionDTO[];
  readonly books: BookListItemDTO[] | null;
  readonly filter: "ALL" | BookCollectionType;
  readonly onFilterChange: (next: "ALL" | BookCollectionType) => void;
  readonly page: number;
  readonly onPageChange: (next: number) => void;
  readonly busyKey: string;
  readonly isLoading: boolean;
  readonly onToggleCollection: (
    bookId: string,
    type: BookCollectionType,
  ) => void;
  readonly onReload: () => void;
}

export function ReadingCollectionsSection({
  childId,
  collections,
  books,
  filter,
  onFilterChange,
  page,
  onPageChange,
  busyKey,
  isLoading,
  onToggleCollection,
  onReload,
}: ReadingCollectionsSectionProps) {
  const t = useTranslations("reports");

  const favoritesCount = collections.filter(
    (entry) => entry.collection_type === "FAVORITE",
  ).length;
  const readingListCount = collections.filter(
    (entry) => entry.collection_type === "WANT_TO_READ",
  ).length;

  const filteredCollections =
    filter === "ALL"
      ? collections
      : collections.filter((entry) => entry.collection_type === filter);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredCollections.length / COLLECTIONS_PAGE_SIZE),
  );
  const safePage = Math.min(Math.max(1, page), totalPages);
  const visibleCollections = filteredCollections.slice(
    (safePage - 1) * COLLECTIONS_PAGE_SIZE,
    safePage * COLLECTIONS_PAGE_SIZE,
  );

  return (
    <section
      aria-label={t("readingManagement.collectionsSectionAria")}
      className="min-w-0 rounded-card border border-border bg-white p-3.5"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky/70 text-primary"
          >
            <BookHeart className="size-4" />
          </span>
          <h2 className="min-w-0 break-words text-sm font-extrabold leading-snug text-ink sm:text-base">
            {t("readingManagement.collectionsTitle")}
          </h2>
          <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-xs font-bold tabular-nums text-muted">
            {collections.length}
          </span>
        </div>
      </div>

      {collections.length > 0 ? (
        <div
          role="group"
          aria-label={t("readingManagement.collectionsFilterAria")}
          className="mb-2 flex flex-wrap gap-1.5"
        >
          {(
            [
              {
                key: "ALL",
                label: t("readingManagement.filterAll", {
                  count: collections.length,
                }),
              },
              {
                key: "FAVORITE",
                label: t("readingManagement.filterFavorites", {
                  count: favoritesCount,
                }),
              },
              {
                key: "WANT_TO_READ",
                label: t("readingManagement.filterReadingList", {
                  count: readingListCount,
                }),
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              aria-pressed={filter === tab.key}
              onClick={() => onFilterChange(tab.key)}
              className={`inline-flex min-h-8 items-center rounded-full border px-2.5 text-xs font-bold tabular-nums transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-7 ${
                filter === tab.key
                  ? "border-primary bg-sky text-primary-hover"
                  : "border-border bg-white text-ink hover:bg-canvas"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}

      {collections.length === 0 ? (
        <p className="mt-2 rounded-control border border-dashed border-border/80 bg-canvas/50 px-3 py-3 text-center text-sm text-muted">
          {t("readingManagement.collectionsEmpty")}
        </p>
      ) : filteredCollections.length === 0 ? (
        <p className="mt-2 rounded-control border border-dashed border-border/80 bg-canvas/50 px-3 py-3 text-center text-sm text-muted">
          {t("readingManagement.collectionsEmptyFiltered")}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border/70">
            {visibleCollections.map((entry) => (
              <li
                key={entry.id}
                data-collection-id={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-1 last:pb-1"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-col items-start gap-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
                    <strong
                      className="viread-learning-content break-words text-sm font-bold text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {entry.book.title}
                    </strong>
                    <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[11px] font-semibold text-muted">
                      {entry.collection_type === "FAVORITE"
                        ? t("readingManagement.favorite")
                        : t("readingManagement.wantToRead")}
                    </span>
                  </div>
                  {entry.book.lifecycle_status === "RETIRED" ? (
                    <span className="mt-0.5 block text-xs text-muted">
                      {t("readingManagement.unavailableToRead")}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {entry.book.lifecycle_status === "ACTIVE" ? (
                    <Link
                      className="inline-flex h-8 min-h-8 items-center rounded-control px-2 text-xs font-bold text-primary hover:bg-sky hover:underline sm:h-7 sm:min-h-7"
                      href={`/books/${encodeURIComponent(entry.book_id)}?childId=${encodeURIComponent(childId)}`}
                    >
                      {t("readingManagement.openBook")}
                    </Link>
                  ) : null}
                  <Button
                    variant="quiet"
                    size="compact"
                    fullWidth={false}
                    className="h-8! min-h-8! w-auto! border border-border bg-white px-2! py-0.5! text-xs! text-primary sm:h-7! sm:min-h-7!"
                    disabled={Boolean(busyKey)}
                    onClick={() =>
                      onToggleCollection(entry.book_id, entry.collection_type)
                    }
                  >
                    <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
                    {t("readingManagement.removeBook")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <PaginationBar
            ariaLabel={t("readingManagement.collectionsPaginationAria")}
            className="mt-2.5"
            compact
            itemLabel={t("readingManagement.collectionsPaginationItem")}
            onPageChange={onPageChange}
            page={safePage}
            pageSize={COLLECTIONS_PAGE_SIZE}
            total={filteredCollections.length}
          />
        </>
      )}

      <VerifiedBookPicker
        key={childId}
        books={books}
        busy={Boolean(busyKey) || isLoading}
        childId={childId}
        collections={collections}
        onReload={onReload}
        onToggle={onToggleCollection}
      />
    </section>
  );
}
