"use client";

import { BookOpenText, Check, RefreshCw, SearchX } from "lucide-react";
import { useEffect, useState } from "react";

import { BookCard } from "@/components/books/book-card";
import { BookChildHeader } from "@/components/books/book-child-header";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useBookService } from "@/hooks/use-book-service";
import { useChildService } from "@/hooks/use-child-service";
import { cn } from "@/lib/utils/cn";
import type { BookListItemDTO } from "@/types/book";
import { CHILD_GRADES, type ChildProfileDTO } from "@/types/child";

type ChildContextState =
  | { status: "loading" }
  | { status: "ready"; child: ChildProfileDTO | null }
  | { status: "error" };

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; books: BookListItemDTO[]; hasCatalog: boolean }
  | { status: "error" };

interface BookLibraryScreenProps {
  requestedChildId?: string;
}

export function BookLibraryScreen({
  requestedChildId,
}: BookLibraryScreenProps) {
  const bookService = useBookService();
  const childService = useChildService();
  const [childState, setChildState] = useState<ChildContextState>({
    status: "loading",
  });
  const [catalogState, setCatalogState] = useState<CatalogState>({
    status: "loading",
  });
  const [search, setSearch] = useState("");
  const [selectedGrade, setSelectedGrade] = useState<number | null>(null);
  const [requestKey, setRequestKey] = useState(0);

  useEffect(() => {
    let isActive = true;

    async function loadChild() {
      try {
        const child = requestedChildId
          ? await childService.get(requestedChildId)
          : ((await childService.list())[0] ?? null);

        if (isActive) {
          setChildState({ status: "ready", child });
          if (child) {
            setSelectedGrade((current) => current ?? child.grade);
          }
        }
      } catch {
        if (isActive) {
          setChildState({ status: "error" });
        }
      }
    }

    void loadChild();
    return () => {
      isActive = false;
    };
  }, [childService, requestedChildId]);

  useEffect(() => {
    if (childState.status !== "ready") {
      return;
    }

    let isActive = true;

    async function loadCatalog() {
      setCatalogState({ status: "loading" });

      try {
        const [books, allBooks] = await Promise.all([
          bookService.list({
            grade: selectedGrade ?? undefined,
            search,
          }),
          bookService.list(),
        ]);

        if (isActive) {
          setCatalogState({
            status: "ready",
            books,
            hasCatalog: allBooks.length > 0,
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
  }, [bookService, childState.status, requestKey, search, selectedGrade]);

  const child = childState.status === "ready" ? childState.child : null;
  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      <BookChildHeader child={child} />

      {childState.status === "error" ? (
        <StatusMessage title="Không thể chọn hồ sơ bé" tone="error">
          Hồ sơ này không tồn tại hoặc không thuộc tài khoản hiện tại.
        </StatusMessage>
      ) : null}

      <div className="mx-auto flex w-full max-w-[1130px] flex-col gap-4 sm:gap-6">
        <div className="flex flex-col gap-4 lg:min-h-16 lg:flex-row lg:items-center lg:gap-6">
          <h1
            aria-label={
              child
                ? `${child.alias} muốn đọc gì hôm nay?`
                : "Bé muốn đọc gì hôm nay?"
            }
            className="min-w-0 flex-1 text-heading font-extrabold text-ink"
          >
            <span className="hidden sm:inline">
              {child
                ? `${child.alias} muốn đọc gì hôm nay?`
                : "Bé muốn đọc gì hôm nay?"}
            </span>
            <span className="sm:hidden">Bé muốn đọc gì hôm nay?</span>
          </h1>
          <div className="w-full lg:w-[486px]">
            <TextField
              aria-label="Tìm theo tên sách hoặc tác giả"
              label="Tìm cuốn sách bé thích…"
              onChange={(event) => setSearch(event.target.value)}
              type="search"
              value={search}
            />
          </div>
        </div>

        <fieldset className="min-w-0">
          <legend className="sr-only">Lọc sách theo lớp</legend>
          <div className="flex gap-3 overflow-x-auto pb-1 sm:flex-wrap">
            {[null, ...CHILD_GRADES].map((grade) => {
              const isSelected = selectedGrade === grade;

              return (
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    "flex h-16 min-w-[132px] shrink-0 items-center justify-center gap-2 rounded-control px-4 text-button font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                    isSelected
                      ? "bg-sky text-primary-hover ring-2 ring-primary"
                      : "bg-white text-ink hover:bg-sky",
                  )}
                  key={grade ?? "all"}
                  onClick={() => setSelectedGrade(grade)}
                  type="button"
                >
                  {isSelected ? (
                    <Check aria-hidden="true" className="size-5 shrink-0" />
                  ) : null}
                  {grade === null ? "Tất cả" : `Lớp ${grade}`}
                </button>
              );
            })}
          </div>
        </fieldset>

        {catalogState.status === "loading" ? (
          <div
            aria-busy="true"
            aria-label="Đang tải thư viện sách"
            className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            <span className="sr-only" role="status">
              Đang tải sách…
            </span>
            {[0, 1, 2, 3].map((item) => (
              <Skeleton
                className="h-[432px] w-full rounded-card sm:w-64"
                key={item}
              />
            ))}
          </div>
        ) : null}

        {catalogState.status === "error" ? (
          <div className="flex flex-col gap-4">
            <StatusMessage title="Chưa tải được thư viện sách" tone="error">
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
        ) : null}

        {catalogState.status === "ready" &&
        catalogState.books.length === 0 &&
        !catalogState.hasCatalog ? (
          <EmptyState
            description="Các câu chuyện đã xác minh sẽ xuất hiện tại đây khi sẵn sàng."
            icon={
              <BookOpenText
                aria-hidden="true"
                className="size-10 text-primary"
              />
            }
            title="Thư viện đang được cập nhật"
          />
        ) : null}

        {catalogState.status === "ready" &&
        catalogState.books.length === 0 &&
        catalogState.hasCatalog ? (
          <EmptyState
            action={
              <Button
                className="max-w-72"
                onClick={() => {
                  setSearch("");
                  setSelectedGrade(null);
                }}
                variant="secondary"
              >
                Xóa bộ lọc
              </Button>
            }
            description="Thử tên sách, tác giả hoặc lớp khác nhé."
            icon={
              <SearchX aria-hidden="true" className="size-10 text-primary" />
            }
            title="Không tìm thấy cuốn sách phù hợp"
          />
        ) : null}

        {catalogState.status === "ready" && catalogState.books.length > 0 ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {catalogState.books.map((book) => (
              <BookCard book={book} childId={child?.id} key={book.id} />
            ))}
          </div>
        ) : null}
      </div>

      <p className="mt-auto text-center text-body text-muted">
        Mỗi câu chuyện là một điều mới để khám phá.
      </p>
    </section>
  );
}
