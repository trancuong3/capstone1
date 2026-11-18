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
import { StatusMessage } from "@/components/common/status-message";
import type { BookListItemDTO } from "@/types/book";
import type {
  BookCollectionType,
  ChildBookCollectionDTO,
} from "@/types/reading-management";

const PAGE_SIZE = 5;
const collectionActions = [
  {
    type: "FAVORITE",
    label: "Yêu thích",
    activeLabel: "Đã yêu thích",
    icon: Heart,
  },
  {
    type: "WANT_TO_READ",
    label: "Muốn đọc",
    activeLabel: "Đã lưu đọc",
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
  const activePage = Math.min(page, pageCount);
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
        Thêm từ thư viện sách đã xác minh
        <ChevronDown
          aria-hidden="true"
          className="ml-auto size-4 shrink-0 group-open/catalog:rotate-180"
        />
      </summary>
      {books === null ? (
        <StatusMessage tone="error" title="Chưa tải được thư viện sách">
          <Button
            className="mt-2 w-auto!"
            size="compact"
            variant="secondary"
            onClick={onReload}
          >
            Tải lại thư viện
          </Button>
        </StatusMessage>
      ) : books.length === 0 ? (
        <p className="rounded-control bg-cream p-3 text-sm text-muted">
          Hiện chưa có sách khả dụng phù hợp với lớp của bé.
        </p>
      ) : (
        <>
          <label className="relative mt-2 block">
            <span className="sr-only">Tìm theo tên sách hoặc tác giả</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-3 size-4 text-muted"
            />
            <input
              className="min-h-10 w-full rounded-control border border-border bg-cream py-2 pl-9 pr-3 text-sm text-ink"
              type="search"
              placeholder="Tên sách hoặc tác giả"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <p className="mt-3 text-sm text-muted" role="status">
            {matches.length
              ? `${(activePage - 1) * PAGE_SIZE + 1}–${(activePage - 1) * PAGE_SIZE + visible.length} / ${matches.length} cuốn`
              : "Không tìm thấy sách phù hợp."}
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
                  <h4 className="break-words text-base font-bold leading-tight text-ink">
                    {book.title}
                  </h4>
                  <p className="mt-1 break-words text-sm text-muted">
                    {book.author || "Tác giả đang cập nhật"} ·{" "}
                    {book.min_grade === book.max_grade
                      ? `Lớp ${book.min_grade}`
                      : `Lớp ${book.min_grade}–${book.max_grade}`}
                  </p>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {collectionActions.map(
                    ({ type, label, activeLabel, icon: Icon }) => {
                      const selected = collections.some(
                        (entry) =>
                          entry.book_id === book.id &&
                          entry.collection_type === type,
                      );
                      const text = selected ? activeLabel : label;
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
                    aria-label={`Mở sách ${book.title}`}
                    href={`/books/${encodeURIComponent(book.id)}?childId=${encodeURIComponent(childId)}`}
                    className="inline-flex min-h-9 items-center gap-1 rounded-control px-2 text-sm font-bold text-primary hover:bg-sky"
                  >
                    Mở sách{" "}
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
          {pageCount > 1 ? (
            <nav
              aria-label="Trang thư viện sách"
              className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3"
            >
              <Button
                className="w-auto!"
                size="compact"
                variant="secondary"
                disabled={activePage === 1}
                onClick={() => setPage(activePage - 1)}
              >
                Trước
              </Button>
              <p className="text-sm text-muted">
                Trang {activePage}/{pageCount}
              </p>
              <Button
                className="w-auto!"
                size="compact"
                variant="secondary"
                disabled={activePage === pageCount}
                onClick={() => setPage(activePage + 1)}
              >
                Sau
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </details>
  );
}
