import { ArrowRight, Heart, ListChecks } from "lucide-react";

import { BookCover } from "@/components/books/book-cover";
import { ButtonLink } from "@/components/common/button";
import type { BookListItemDTO } from "@/types/book";
import type { BookCollectionType } from "@/types/reading-management";

export function formatGradeRange(book: BookListItemDTO): string {
  return book.min_grade === book.max_grade
    ? `Lớp ${book.min_grade}`
    : `Lớp ${book.min_grade}–${book.max_grade}`;
}

interface BookCardProps {
  book: BookListItemDTO;
  childId?: string;
  savedTypes?: readonly BookCollectionType[];
  onToggleCollection?: (type: BookCollectionType) => void;
  collectionBusy?: boolean;
}

export function BookCard({ book, childId, savedTypes = [], onToggleCollection, collectionBusy = false }: BookCardProps) {
  const query = childId ? `?childId=${encodeURIComponent(childId)}` : "";

  return (
    <article className="flex min-h-[432px] w-full flex-col items-center gap-3 rounded-card bg-white p-4 shadow-[0_6px_24px_rgba(33,61,66,0.08)] sm:w-64 sm:items-start">
      <BookCover book={book} titleAsHeading />
      <p className="w-full truncate text-label font-bold text-muted">
        {book.author ?? "Tác giả đang cập nhật"}
      </p>
      <p className="w-full text-label font-bold text-primary">
        {formatGradeRange(book)}
      </p>
      <ButtonLink
        aria-label={`Đọc sách ${book.title}`}
        className="mt-auto max-w-56"
        href={`/books/${encodeURIComponent(book.id)}${query}`}
      >
        Đọc sách
        <ArrowRight aria-hidden="true" className="size-5" />
      </ButtonLink>
      {onToggleCollection && childId ? (
        <div className="flex w-full flex-wrap gap-2">
          {(["FAVORITE", "WANT_TO_READ"] as const).map((type) => {
            const saved = savedTypes.includes(type);
            const label = type === "FAVORITE" ? "Yêu thích" : "Muốn đọc";
            const ActionIcon = type === "FAVORITE" ? Heart : ListChecks;
            return (
              <button
                aria-label={(saved ? "Bỏ " : "Thêm ") + book.title + (type === "FAVORITE" ? " " + label.toLowerCase() : " vào danh sách muốn đọc")}
                aria-pressed={saved}
                className={"flex min-h-10 flex-1 items-center justify-center gap-1 rounded-control px-2 text-label font-bold " + (saved ? "bg-sky text-primary" : "border border-border text-ink hover:bg-canvas")}
                disabled={collectionBusy}
                key={type}
                onClick={() => onToggleCollection(type)}
                type="button"
              >
                <ActionIcon aria-hidden="true" className="size-4" />
                {saved ? "Đã lưu" : label}
              </button>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
