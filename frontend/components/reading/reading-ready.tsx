import { ArrowLeft, ArrowRight, BookOpenText } from "lucide-react";
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

      <div className="mx-auto flex w-full max-w-[744px] flex-col gap-4 sm:gap-6">
        <div className="hidden items-start gap-6 rounded-card bg-cream p-6 sm:flex">
          <Image
            alt=""
            aria-hidden="true"
            height={96}
            src="/images/figma/owl-mascot.svg"
            width={96}
          />
          <div>
            <h1 className="text-[26px] font-extrabold text-ink">
              Sẵn sàng đọc chưa nào?
            </h1>
            <p className="mt-2 text-body text-muted">
              Mình sẽ nhìn trang sách và nghe bé đọc.
            </p>
          </div>
        </div>

        <h1 className="text-heading font-extrabold text-ink sm:hidden">
          Sẵn sàng đọc chưa nào?
        </h1>

        <Image
          alt="Minh họa bé sẵn sàng đọc sách"
          className="mx-auto h-auto w-full max-w-[320px]"
          height={112}
          priority
          src="/images/figma/reading-setup.svg"
          width={320}
        />

        <p className="hidden text-center text-label font-bold text-primary sm:block">
          {child.alias} · {book.title}
        </p>

        <div className="flex items-start gap-3 rounded-card bg-sky p-4 sm:p-6">
          <BookOpenText
            aria-hidden="true"
            className="mt-1 size-6 shrink-0 text-primary"
          />
          <div className="text-left">
            <p className="font-extrabold text-ink">{book.title}</p>
            <p className="mt-1 text-sm text-muted">
              Microphone đã được kiểm tra ở bước chuẩn bị. Khi ba mẹ bắt đầu,
              ViRead sẽ mở microphone để nghe bé đọc.
            </p>
          </div>
        </div>

        <div className="text-left sm:text-center">
          <p className="text-body text-ink sm:text-[26px] sm:font-bold">
            Đặt sách trước mặt bé và đọc to, tự nhiên nhé.
          </p>
          <p className="text-body text-ink sm:mt-3 sm:text-muted">
            Đọc to và tự nhiên nhé.
          </p>
        </div>

        <Button
          className="mx-auto max-w-[360px]"
          isLoading={isStarting}
          onClick={onStart}
        >
          Bắt đầu đọc
          {!isStarting ? (
            <ArrowRight aria-hidden="true" className="size-5" />
          ) : null}
        </Button>
        <div className="hidden sm:block">
          <ButtonLink
            className="mx-auto max-w-[360px]"
            href={detailHref}
            variant="quiet"
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
            Quay lại chi tiết sách
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
