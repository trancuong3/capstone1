import { ArrowLeft, ArrowRight, Mic } from "lucide-react";
import Image from "next/image";

import { BookChildHeader } from "@/components/books/book-child-header";
import { Button, ButtonLink } from "@/components/common/button";
import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";

interface ReadingReadyProps {
  book: BookDetailDTO;
  child: ChildProfileDTO;
  isStarting: boolean;
  onStart: () => void;
}

export function ReadingReady({
  book,
  child,
  isStarting,
  onStart,
}: ReadingReadyProps) {
  const detailHref = `/books/${encodeURIComponent(book.id)}`;

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      <BookChildHeader
        backHref={detailHref}
        child={child}
        mobileLabel={`${child.alias} · ${book.title}`}
      />

      <article className="mx-auto grid w-full max-w-[900px] overflow-hidden rounded-card border border-border bg-white sm:grid-cols-[0.85fr_1fr]">
        <div className="flex items-center justify-center bg-cream px-8 py-6 sm:py-12">
          <Image
            alt=""
            src="/images/figma/reading-setup.svg"
            width={320}
            height={220}
            priority
            className="h-auto w-full max-w-72"
          />
        </div>
        <div className="flex flex-col items-start justify-center gap-5 p-6 sm:p-9">
          <div>
            <p className="mb-2 text-sm font-bold text-primary">
              {child.alias} · Lớp {child.grade}
            </p>
            <h1 className="book-title text-4xl text-ink">{book.title}</h1>
          </div>
          <p className="text-lg leading-relaxed text-ink">
            Đặt sách trước mặt bé. Khi sẵn sàng, bé hãy đọc to từng dòng.
          </p>
          <p className="flex items-start gap-3 border-t border-border pt-4 text-sm text-muted">
            <Mic className="size-5 shrink-0 text-primary" aria-hidden="true" />
            Microphone sẽ bật khi bắt đầu đọc.
          </p>
          <Button isLoading={isStarting} onClick={onStart}>
            Bắt đầu đọc <ArrowRight aria-hidden="true" className="size-5" />
          </Button>
          <ButtonLink href={detailHref} variant="quiet">
            <ArrowLeft aria-hidden="true" className="size-5" />
            Quay lại chi tiết sách
          </ButtonLink>
        </div>
      </article>
    </section>
  );
}
