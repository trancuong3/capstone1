import { ArrowRight } from "lucide-react";

import { BookCover } from "@/components/books/book-cover";
import { ButtonLink } from "@/components/common/button";
import type { BookListItemDTO } from "@/types/book";

export function formatGradeRange(book: BookListItemDTO): string {
  return book.min_grade === book.max_grade
    ? `Lớp ${book.min_grade}`
    : `Lớp ${book.min_grade}–${book.max_grade}`;
}

interface BookCardProps {
  book: BookListItemDTO;
  childId?: string;
}

export function BookCard({ book, childId }: BookCardProps) {
  const query = childId ? `?childId=${encodeURIComponent(childId)}` : "";

  return (
    <article className="flex h-[432px] w-full flex-col items-center gap-3 rounded-card bg-white p-4 shadow-[0_6px_24px_rgba(33,61,66,0.08)] sm:w-64 sm:items-start">
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
    </article>
  );
}
