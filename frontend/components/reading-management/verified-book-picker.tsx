"use client";

import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  Heart,
  ListChecks,
  Search,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { BookCover } from "@/components/books/book-cover";
import { Button } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useTranslations } from "@/hooks/use-i18n";
import type { BookListItemDTO } from "@/types/book";
import type {
  BookCollectionType,
  ChildBookCollectionDTO,
} from "@/types/reading-management";

const PAGE_SIZE = 5;
const collectionActions = [
  {
    type: "FAVORITE",
    labelKey: "readingManagement.bookPicker.favorite",
    activeLabelKey: "readingManagement.bookPicker.favorited",
    icon: Heart,
  },
  {
    type: "WANT_TO_READ",
    labelKey: "readingManagement.bookPicker.wantToRead",
    activeLabelKey: "readingManagement.bookPicker.savedToRead",
    icon: ListChecks,
  },
] as const;

function searchText(value: string): string {
  return value
    .toLocaleLowerCase("vi")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replaceAll("đ", "d")
    .trim();
}

export function VerifiedBookPicker({
  books,
  childId,
  collections,
  busy,
  onToggle,
  onReload,
}: {
  books: BookListItemDTO[] | null;
  childId: string;
  collections: readonly ChildBookCollectionDTO[];
  busy: boolean;
  onToggle: (bookId: string, type: BookCollectionType) => void;
  onReload: () => void;
}) {
  const t = useTranslations("reports");
  const [expanded, setExpanded] = useState(books === null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const normalizedQuery = searchText(query);
  const matches =
    books?.filter((book) =>
      [book.title, book.author ?? ""].some((value) =>
        searchText(value).includes(normalizedQuery),
      ),
    ) ?? [];
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const activePage = Math.min(Math.max(1, page), pageCount);
  const visible = matches.slice(
    (activePage - 1) * PAGE_SIZE,
    activePage * PAGE_SIZE,
  );

  return (
    <details
      className="group/catalog mt-4 border-t border-border"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-control px-1 font-semibold text-primary hover:bg-sky/45 [&::-webkit-details-marker]:hidden">
        <BookOpen aria-hidden="true" className="size-4 shrink-0" />
        {t("readingManagement.bookPicker.heading")}
        <ChevronDown
          aria-hidden="true"
          className="ms-auto size-4 shrink-0 group-open/catalog:rotate-180"
        />
      </summary>
      {books === null ? (
        <StatusMessage
          tone="error"
          title={t("readingManagement.bookPicker.loadErrorTitle")}
        >
          <Button
            className="mt-2 w-auto!"
            size="compact"
            variant="secondary"
            onClick={onReload}
          >
            {t("readingManagement.bookPicker.reloadLibrary")}
          </Button>
        </StatusMessage>
      ) : books.length === 0 ? (
        <p className="rounded-control bg-cream p-3 text-sm text-muted">
          {t("readingManagement.bookPicker.emptyEligible")}
        </p>
      ) : (
        <>
          <label className="relative mt-2 block">
            <span className="sr-only">
              {t("readingManagement.bookPicker.searchSr")}
            </span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute start-3 top-3 size-4 text-muted"
            />
            <input
              className="min-h-10 w-full rounded-control border border-border bg-cream py-2 ps-9 pe-3 text-sm text-ink"
              type="search"
              placeholder={t("readingManagement.bookPicker.searchPlaceholder")}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <p className="mt-3 text-sm text-muted" role="status">
            {matches.length
              ? t("readingManagement.bookPicker.rangeSummary", {
                  from: (activePage - 1) * PAGE_SIZE + 1,
                  to: (activePage - 1) * PAGE_SIZE + visible.length,
                  total: matches.length,
                })
              : t("readingManagement.bookPicker.noMatches")}
          </p>
          <ul className="divide-y divide-border">
            {visible.map((book) => (
              <li
                className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 py-3"
                key={book.id}
              >
                <BookCover
                  book={book}
                  size="small"
                  showTitle={false}
                  className="row-span-2 self-start"
                />
                <div className="min-w-0">
                  <h4
                    className="viread-learning-content break-words text-base font-bold leading-tight text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    {book.title}
                  </h4>
                  <p className="mt-1 break-words text-sm text-muted">
                    {book.author ? (
                      <span
                        className="viread-learning-content"
                        dir="ltr"
                        lang="vi"
                      >
                        {book.author}
                      </span>
                    ) : (
                      t("readingManagement.bookPicker.authorPending")
                    )}{" "}
                    ·{" "}
                    {book.min_grade === book.max_grade
                      ? t("readingManagement.bookPicker.gradeSingle", {
                          grade: book.min_grade,
                        })
                      : t("readingManagement.bookPicker.gradeRange", {
                          min: book.min_grade,
                          max: book.max_grade,
                        })}
                  </p>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {collectionActions.map(
                    ({ type, labelKey, activeLabelKey, icon: Icon }) => {
                      const selected = collections.some(
                        (entry) =>
                          entry.book_id === book.id &&
                          entry.collection_type === type,
                      );
                      const text = t(selected ? activeLabelKey : labelKey);
                      return (
                        <button
                          key={type}
                          type="button"
                          aria-pressed={selected}
                          aria-label={`${text} ${book.title}`}
                          disabled={busy}
                          onClick={() => onToggle(book.id, type)}
                          className={`inline-flex min-h-9 items-center gap-1 rounded-control px-2 text-sm font-semibold hover:bg-sky disabled:opacity-55 ${selected ? "bg-sky text-primary" : "text-ink"}`}
                        >
                          <Icon
                            aria-hidden="true"
                            className="size-4 shrink-0"
                          />
                          {text}
                        </button>
                      );
                    },
                  )}
                  <Link
                    aria-label={t("readingManagement.bookPicker.openBookAria", {
                      title: book.title,
                    })}
                    href={`/books/${encodeURIComponent(book.id)}?childId=${encodeURIComponent(childId)}`}
                    className="inline-flex min-h-9 items-center gap-1 rounded-control px-2 text-sm font-bold text-primary hover:bg-sky"
                  >
                    {t("readingManagement.bookPicker.openBook")}{" "}
                    <ArrowUpRight
                      aria-hidden="true"
                      className="viread-rtl-flip size-4 shrink-0"
                    />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
          <PaginationBar
            ariaLabel={t("readingManagement.bookPicker.paginationAria")}
            className="mt-2"
            compact
            itemLabel={t("readingManagement.bookPicker.paginationItem")}
            onPageChange={setPage}
            page={activePage}
            pageSize={PAGE_SIZE}
            total={matches.length}
          />
        </>
      )}
    </details>
  );
}
