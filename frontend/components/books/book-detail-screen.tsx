"use client";

import { ArrowLeft, ArrowRight, BookX, RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { formatGradeRange } from "@/components/books/book-card";
import { BookChildHeader } from "@/components/books/book-child-header";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { BookCover } from "@/components/books/book-cover";
import { BookPageThumbnail } from "@/components/books/book-page-thumbnail";
import { BookContentReportDialog } from "@/components/books/book-content-report-dialog";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useBookService } from "@/hooks/use-book-service";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { isServiceError } from "@/lib/api/service-error";
import type { BookDetailDTO, BookPagePreviewDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";

type DetailState =
  | { status: "loading" }
  | {
      status: "ready";
      book: BookDetailDTO;
      child: ChildProfileDTO;
      pages: BookPagePreviewDTO[];
      previewUnavailable: boolean;
    }
  | { status: "not-found" }
  | { status: "unavailable" }
  | { status: "error" };

interface BookDetailScreenProps {
  bookId: string;
}

function invitationFor(book: BookDetailDTO): string {
  if (book.title === "Chú Mèo Nhỏ") {
    return "Cùng chú mèo nhỏ khám phá một ngày thật vui nhé!";
  }

  return `Cùng bé khám phá câu chuyện ${book.title.toLocaleLowerCase("vi")} nhé!`;
}

export function BookDetailScreen({ bookId }: BookDetailScreenProps) {
  const bookService = useBookService();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const router = useRouter();
  const searchParams = useSearchParams();
  const targetPageId = searchParams.get("pageId");
  const confidenceParam = searchParams.get("confidence");
  const targetConfidenceValue =
    confidenceParam === null ? Number.NaN : Number(confidenceParam);
  const targetConfidence = Number.isFinite(targetConfidenceValue)
    ? targetConfidenceValue
    : null;

  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [selectedPage, setSelectedPage] = useState<BookPagePreviewDTO | null>(
    null,
  );
  const [selectedEndPageId, setSelectedEndPageId] = useState<string | null>(
    null,
  );
  const [startState, setStartState] = useState<"idle" | "starting">("idle");
  const [reportTarget, setReportTarget] = useState<{
    pageId: string | null;
    pageNumber: number | null;
  } | null>(null);

  useEffect(() => {
    let isActive = true;

    async function loadDetail() {
      setState({ status: "loading" });
      setSelectedPage(null);
      setSelectedEndPageId(null);
      setStartState("idle");

      if (childState.status !== "ready") return;
      const selectedChild = childState.child;

      try {
        const book = await bookService.get(bookId);

        let pages: BookPagePreviewDTO[] = [];
        let previewUnavailable = false;
        try {
          pages = await bookService.listPages(bookId);
          pages.sort((left, right) => left.page_number - right.page_number);
          previewUnavailable = pages.length === 0;
        } catch (error) {
          if (isServiceError(error) && error.status === 503) {
            previewUnavailable = true;
          } else {
            throw error;
          }
        }

        if (isActive) {
          setState({
            status: "ready",
            book,
            child: selectedChild,
            pages,
            previewUnavailable,
          });
          // Nếu có targetPageId truyền từ dashboard sang thì ưu tiên chọn trang đó
          const matchedPage = targetPageId
            ? pages.find((p) => p.page_id === targetPageId)
            : null;
          // Never silently substitute page 1 when OCR supplied an invalid pageId.
          const startPage = targetPageId
            ? (matchedPage ?? null)
            : (pages[0] ?? null);
          setSelectedPage(startPage);
          setSelectedEndPageId(
            pages[pages.length - 1]?.page_id ?? startPage?.page_id ?? null,
          );
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
  }, [bookId, bookService, childState, requestKey, targetPageId]);

  useEffect(() => {
    if (
      state.status !== "ready" ||
      !targetPageId ||
      !state.pages.some((candidate) => candidate.page_id === targetPageId)
    ) {
      return;
    }
    const btn = document.getElementById("start-reading-button");
    if (btn) {
      btn.scrollIntoView?.({ behavior: "smooth", block: "center" });
      btn.focus();
    }
  }, [state, targetPageId]);

  function handleStartReading() {
    if (
      state.status !== "ready" ||
      !state.child ||
      !selectedPage ||
      !selectedEndPageId ||
      selectedRangeHasGap ||
      startState === "starting"
    ) {
      return;
    }

    setStartState("starting");
    const params = new URLSearchParams({
      bookId: state.book.id,
      pageId: selectedPage.page_id,
      endPageId: selectedEndPageId,
    });
    if (targetConfidence !== null) {
      params.set("confidence", String(targetConfidence));
    }
    router.push(`/reading-preparation?${params.toString()}`);
  }

  const booksHref = "/books";

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[900px] px-4 py-8"
      >
        <span className="sr-only" role="status">
          Đang xác minh hồ sơ trẻ…
        </span>
        <Skeleton className="h-14 w-full max-w-sm rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title="Không thể xác minh hồ sơ trẻ" tone="error">
          Chưa thể xác nhận hồ sơ thuộc tài khoản hiện tại. Ba mẹ vui lòng thử
          lại.
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }

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

  const { book, child, pages, previewUnavailable } = state;
  const selectedEndPage =
    pages.find((candidate) => candidate.page_id === selectedEndPageId) ?? null;
  const selectedRangePages =
    selectedPage && selectedEndPage
      ? pages.filter(
          (candidate) =>
            candidate.page_number >= selectedPage.page_number &&
            candidate.page_number <= selectedEndPage.page_number,
        )
      : [];
  const selectedRangeHasGap =
    selectedRangePages.some(
      (candidate, index) =>
        candidate.page_number !==
        (index === 0
          ? selectedPage?.page_number
          : (selectedRangePages[index - 1]?.page_number ?? 0) + 1),
    ) ||
    Boolean(
      selectedPage &&
      selectedEndPage &&
      (selectedRangePages[0]?.page_number !== selectedPage.page_number ||
        selectedRangePages[selectedRangePages.length - 1]?.page_number !==
          selectedEndPage.page_number),
    );

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      {reportTarget ? (
        <BookContentReportDialog
          bookId={book.id}
          bookTitle={book.title}
          onClose={() => setReportTarget(null)}
          pageId={reportTarget.pageId}
          pageNumber={reportTarget.pageNumber}
        />
      ) : null}
      <BookChildHeader
        backHref={booksHref}
        child={child}
        mobileLabel={book.title}
      />
      <div className="mx-auto w-full max-w-[1130px]">
        <SelectedChildIdentity child={child} />
      </div>

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
          <div className="flex flex-wrap gap-3">
            <Button
              className="sm:w-auto"
              onClick={() =>
                setReportTarget({ pageId: null, pageNumber: null })
              }
              variant="secondary"
            >
              Báo lỗi sách
            </Button>
            <Button
              className="sm:w-auto"
              disabled={!selectedPage}
              onClick={() =>
                selectedPage
                  ? setReportTarget({
                      pageId: selectedPage.page_id,
                      pageNumber: selectedPage.page_number,
                    })
                  : undefined
              }
              variant="secondary"
            >
              Báo lỗi trang này
            </Button>
          </div>

          <BookCover book={book} className="sm:hidden" hero />

          <p className="text-body text-muted">
            {book.author ?? "Tác giả đang cập nhật"} · {formatGradeRange(book)}
          </p>
          <p className="text-[26px] font-bold leading-[1.4] text-ink">
            {invitationFor(book)}
          </p>

          {targetPageId &&
          targetConfidence !== null &&
          targetConfidence >= 0 &&
          targetConfidence <= 1 ? (
            <p className="text-sm font-bold text-primary">
              Trang nhận diện:{" "}
              {selectedPage
                ? `Trang ${selectedPage.page_number}`
                : "chưa xác nhận"}{" "}
              · Độ tin cậy {Math.round(targetConfidence * 100)}%
            </p>
          ) : null}

          {targetPageId && !selectedPage ? (
            <StatusMessage
              title="Không tìm thấy trang được nhận diện"
              tone="warning"
            >
              Trang OCR trả về không nằm trong danh sách trang có thể đọc của
              cuốn sách này. Ba mẹ hãy chọn đúng trang trong danh sách bên dưới;
              ViRead sẽ không tự chọn một trang khác thay thế.
            </StatusMessage>
          ) : null}

          <div className="order-4 grid gap-4 rounded-card border border-line bg-white p-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-bold text-ink">Trang bắt đầu</span>
              <span className="text-body text-primary">
                {selectedPage
                  ? `Trang ${selectedPage.page_number}`
                  : "Chưa chọn trang"}
              </span>
              <span className="text-sm text-muted">
                Chọn hình trang bên dưới để thay đổi trang bắt đầu.
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <label
                className="text-sm font-bold text-ink"
                htmlFor="reading-end-page"
              >
                Trang kết thúc
              </label>
              <select
                className="min-h-11 rounded-control border border-line bg-white px-3 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                disabled={
                  !selectedPage ||
                  pages.length === 0 ||
                  startState === "starting"
                }
                id="reading-end-page"
                onChange={(event) => {
                  setSelectedEndPageId(event.target.value || null);
                  setStartState("idle");
                }}
                value={selectedEndPageId ?? ""}
              >
                {pages
                  .filter((candidate) =>
                    selectedPage
                      ? candidate.page_number >= selectedPage.page_number
                      : false,
                  )
                  .map((candidate) => (
                    <option key={candidate.page_id} value={candidate.page_id}>
                      Trang {candidate.page_number}
                    </option>
                  ))}
              </select>
            </div>
            {selectedPage && selectedEndPage ? (
              <p className="text-sm text-muted sm:col-span-2">
                Phạm vi đọc: Trang {selectedPage.page_number}–
                {selectedEndPage.page_number} ({selectedRangePages.length} trang
                hợp lệ)
              </p>
            ) : null}
            {selectedRangeHasGap ? (
              <div className="sm:col-span-2">
                <StatusMessage title="Khoảng trang chưa liên tục" tone="error">
                  Trong phạm vi đã chọn có trang thiếu hoặc chưa đủ điều kiện
                  đọc. Hãy chọn khoảng khác.
                </StatusMessage>
              </div>
            ) : null}
          </div>

          <Button
            id="start-reading-button"
            className="order-6 sm:order-none sm:w-[360px]"
            disabled={
              !selectedPage ||
              !selectedEndPageId ||
              !child ||
              selectedRangeHasGap ||
              pages.length === 0
            }
            isLoading={startState === "starting"}
            onClick={handleStartReading}
          >
            {startState === "starting"
              ? "Đang mở bước chuẩn bị…"
              : "Chuẩn bị đọc"}
            {startState === "idle" ? (
              <ArrowRight aria-hidden="true" className="size-5" />
            ) : null}
          </Button>

          <div className="order-5 sm:order-none">
            {previewUnavailable ? (
              <div className="mb-4 flex flex-col gap-3">
                <StatusMessage title="Ảnh xem trước chưa sẵn sàng" tone="info">
                  Ảnh trang sách sẽ hiển thị khi được bổ sung. Thông tin sách ở
                  trên lấy từ dữ liệu hiện có.
                </StatusMessage>
                <Button
                  className="sm:w-auto sm:self-start"
                  onClick={() => setRequestKey((key) => key + 1)}
                  variant="secondary"
                >
                  <RefreshCw aria-hidden="true" className="size-5" />
                  Thử tải ảnh lại
                </Button>
              </div>
            ) : null}
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
                    setSelectedEndPageId((currentEndId) => {
                      const currentEnd = pages.find(
                        (candidate) => candidate.page_id === currentEndId,
                      );
                      return !currentEnd ||
                        currentEnd.page_number < nextPage.page_number
                        ? nextPage.page_id
                        : currentEnd.page_id;
                    });
                    setStartState("idle");
                  }}
                  page={page}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
