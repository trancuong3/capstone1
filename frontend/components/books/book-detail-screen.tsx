"use client";

import { ArrowLeft, ArrowRight, BookX, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { formatGradeRange } from "@/components/books/book-card";
import { BookChildHeader } from "@/components/books/book-child-header";
import { BookCover } from "@/components/books/book-cover";
import { BookPageThumbnail } from "@/components/books/book-page-thumbnail";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useBookService } from "@/hooks/use-book-service";
import { useChildService } from "@/hooks/use-child-service";
import { useReadingServices } from "@/hooks/use-reading-services";
import { isServiceError } from "@/lib/api/service-error";
import type { BookDetailDTO, BookPagePreviewDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";

type DetailState =
  | { status: "loading" }
  | {
      status: "ready";
      book: BookDetailDTO;
      child: ChildProfileDTO | null;
      pages: BookPagePreviewDTO[];
    }
  | { status: "not-found" }
  | { status: "unavailable" }
  | { status: "error" };

interface BookDetailScreenProps {
  bookId: string;
  requestedChildId?: string;
}

function invitationFor(book: BookDetailDTO): string {
  if (book.title === "Chú Mèo Nhỏ") {
    return "Cùng chú mèo nhỏ khám phá một ngày thật vui nhé!";
  }

  return `Cùng bé khám phá câu chuyện ${book.title.toLocaleLowerCase("vi")} nhé!`;
}

export function BookDetailScreen({
  bookId,
  requestedChildId,
}: BookDetailScreenProps) {
  const bookService = useBookService();
  const childService = useChildService();
  const { readingService } = useReadingServices();
  const router = useRouter();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [selectedPage, setSelectedPage] = useState<BookPagePreviewDTO | null>(
    null,
  );
  const [startState, setStartState] = useState<"idle" | "starting" | "error">(
    "idle",
  );

  useEffect(() => {
    let isActive = true;

    async function loadDetail() {
      setState({ status: "loading" });
      setSelectedPage(null);
      setStartState("idle");

      try {
        const [book, pages, child] = await Promise.all([
          bookService.get(bookId),
          bookService.listPages(bookId),
          requestedChildId
            ? childService.get(requestedChildId)
            : childService.list().then((children) => children[0] ?? null),
        ]);

        if (isActive) {
          setState({ status: "ready", book, child, pages });
          setSelectedPage(pages[0] ?? null);
        }
      } catch (error) {
        if (!isActive) {
          return;
        }

        if (isServiceError(error) && error.code === "RESOURCE_NOT_FOUND") {
          setState({ status: "not-found" });
          return;
        }

        if (isServiceError(error) && error.code === "CONTENT_INACTIVE") {
          setState({ status: "unavailable" });
          return;
        }

        setState({ status: "error" });
      }
    }

    void loadDetail();
    return () => {
      isActive = false;
    };
  }, [bookId, bookService, childService, requestKey, requestedChildId]);

  async function handleStartReading() {
    if (
      state.status !== "ready" ||
      !state.child ||
      !selectedPage ||
      startState === "starting"
    ) {
      return;
    }

    setStartState("starting");
    try {
      const session = await readingService.create({
        book_id: state.book.id,
        child_id: state.child.id,
        mode: "realtime",
      });
      router.push(
        `/reading/${encodeURIComponent(session.session_id)}?state=ready&pageId=${encodeURIComponent(selectedPage.page_id)}`,
      );
    } catch {
      setStartState("error");
    }
  }

  const booksHref = requestedChildId
    ? `/books?childId=${encodeURIComponent(requestedChildId)}`
    : "/books";

  if (state.status === "loading") {
    return (
      <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-6 px-4 py-4 sm:px-8 sm:py-8">
        <BookChildHeader child={null} mobileLabel="Đang tải sách" />
        <div
          aria-busy="true"
          aria-label="Đang tải chi tiết sách"
          className="mx-auto flex w-full max-w-[1130px] flex-col gap-6 sm:flex-row sm:gap-12"
        >
          <span className="sr-only" role="status">
            Đang tải sách…
          </span>
          <Skeleton className="h-[518px] w-full rounded-card sm:w-[307px]" />
          <div className="flex flex-1 flex-col gap-4">
            <Skeleton className="h-16 w-3/5" />
            <Skeleton className="h-7 w-2/5" />
            <Skeleton className="h-20 w-4/5" />
            <Skeleton className="h-16 w-full sm:w-[360px]" />
          </div>
        </div>
      </section>
    );
  }

  if (state.status === "not-found" || state.status === "unavailable") {
    const unavailable = state.status === "unavailable";

    return (
      <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-6 px-4 py-4 sm:px-8 sm:py-8">
        <BookChildHeader child={null} mobileLabel="Chi tiết sách" />
        <div className="mx-auto w-full max-w-[720px]">
          <EmptyState
            headingLevel={1}
            action={
              <ButtonLink
                className="max-w-80"
                href={booksHref}
                variant="secondary"
              >
                <ArrowLeft aria-hidden="true" className="size-5" />
                Về thư viện sách
              </ButtonLink>
            }
            description={
              unavailable
                ? "Cuốn sách này chưa có nội dung ACTIVE và VERIFIED để bé đọc."
                : "Cuốn sách không tồn tại hoặc không có trong thư viện hiện tại."
            }
            icon={<BookX aria-hidden="true" className="size-10 text-primary" />}
            title={
              unavailable ? "Sách hiện chưa sẵn sàng" : "Không tìm thấy sách"
            }
          />
        </div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-6 px-4 py-4 sm:px-8 sm:py-8">
        <BookChildHeader child={null} mobileLabel="Chi tiết sách" />
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
          <StatusMessage title="Chưa tải được chi tiết sách" tone="error">
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
      </section>
    );
  }

  const { book, child, pages } = state;

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      <BookChildHeader
        backHref={booksHref}
        child={child}
        mobileLabel={book.title}
      />

      <div className="mx-auto flex w-full max-w-[1130px] flex-col gap-4 sm:flex-row sm:items-start sm:gap-12">
        <article className="hidden h-[518px] w-[307px] shrink-0 flex-col gap-[14px] rounded-card bg-white p-[19px] shadow-[0_7px_24px_rgba(33,61,66,0.08)] sm:flex">
          <BookCover book={book} className="h-72 max-w-none p-[19px]" />
          <p className="text-[19px] font-bold text-muted">
            {book.author ?? "Tác giả đang cập nhật"}
          </p>
          <p className="text-[19px] font-bold text-primary">
            {formatGradeRange(book)}
          </p>
        </article>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <h1 className="text-heading font-extrabold text-ink sm:text-[44px] sm:leading-[1.4]">
            {book.title}
          </h1>

          <BookCover book={book} className="sm:hidden" hero />

          <p className="text-body text-muted">
            {book.author ?? "Tác giả đang cập nhật"} · {formatGradeRange(book)}
          </p>
          <p className="text-[26px] font-bold leading-[1.4] text-ink">
            {invitationFor(book)}
          </p>

          <Button
            className="order-6 sm:order-none sm:w-[360px]"
            disabled={!selectedPage || !child}
            isLoading={startState === "starting"}
            onClick={handleStartReading}
          >
            {startState === "starting" ? "Đang chuẩn bị…" : "Bắt đầu đọc"}
            {startState === "idle" ? (
              <ArrowRight aria-hidden="true" className="size-5" />
            ) : null}
          </Button>

          <div className="order-5 sm:order-none">
            <p className="mb-4 hidden text-label font-bold text-ink sm:block">
              Chọn trang bé muốn đọc
            </p>
            <div
              aria-label="Các trang sách có thể xem trước"
              className="flex gap-4 overflow-x-auto pb-1"
            >
              {pages.map((page) => (
                <BookPageThumbnail
                  isSelected={selectedPage?.page_id === page.page_id}
                  key={page.page_id}
                  onSelect={(nextPage) => {
                    setSelectedPage(nextPage);
                    setStartState("idle");
                  }}
                  page={page}
                />
              ))}
            </div>
          </div>

          {startState === "error" ? (
            <StatusMessage className="order-7 sm:order-none" tone="error">
              Chưa thể chuẩn bị buổi đọc. Ba mẹ vui lòng thử lại.
            </StatusMessage>
          ) : null}
        </div>
      </div>
    </section>
  );
}
