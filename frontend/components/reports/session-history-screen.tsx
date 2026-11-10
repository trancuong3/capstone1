"use client";

import { History, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { ReportPageHeader } from "@/components/reports/report-page-header";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { SessionHistoryItem } from "@/components/reports/session-history-item";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  historyPageFromCursor,
  mapSessionHistoryItem,
} from "@/lib/utils/report-mappers";
import type { ChildProfileDTO } from "@/types/child";
import type { SessionHistoryItemViewModelUI } from "@/types/reports";

type ScreenState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly child: ChildProfileDTO;
      readonly items: readonly SessionHistoryItemViewModelUI[];
      readonly nextCursor: string | null;
    }
  | { readonly status: "not-found"; readonly childId: string }
  | { readonly status: "unavailable"; readonly childId: string }
  | { readonly status: "error"; readonly childId: string };

interface SessionHistoryScreenProps {
  readonly page: number;
}

export function SessionHistoryScreen({ page }: SessionHistoryScreenProps) {
  const { sessionService } = useReportServices();
  const { state: childState, retry: retryChild } =
    useValidatedSelectedChild();
  const selectedChild =
    childState.status === "ready" ? childState.child : null;
  const currentPage =
    Number.isSafeInteger(page) && page >= 1 && page <= 100000 ? page : 1;
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ScreenState>({ status: "loading" });

  useEffect(() => {
    if (childState.status !== "ready") {
      return;
    }
    let active = true;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      const child = childState.child;
      try {
        const history = await sessionService.list(child.id, {
          cursor: currentPage > 1 ? `page-${currentPage}` : undefined,
          limit: 2,
        });
        const items = await Promise.all(
          history.sessions.map(async (session) => {
            const book = await sessionService.getBook(session.id);
            if (book.id !== session.book_id)
              throw new Error("Invalid historical book response");
            return mapSessionHistoryItem(session, child, book);
          }),
        );
        if (active) {
          setState({
            status: "ready",
            child,
            items,
            nextCursor: history.next_cursor,
          });
        }
      } catch (error) {
        if (active) {
          setState({
            status:
              isServiceError(error) && error.status === 404
                ? "not-found"
                : isServiceError(error) &&
                    (error.status === 501 || error.status === 503)
                  ? "unavailable"
                  : "error",
            childId: child.id,
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [childState.status, selectedChild?.id, currentPage, requestKey, sessionService]);

  if (
    childState.status === "loading" ||
    childState.status === "redirecting" ||
    (childState.status === "ready" && state.status === "loading")
  ) {
    return (
      <section
        aria-busy="true"
        aria-label="Đang tải lịch sử đọc"
        className="mx-auto flex max-w-[1120px] flex-col gap-6"
      >
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-40 rounded-card" />
        <Skeleton className="h-40 rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <StatusMessage title="Không thể xác minh hồ sơ trẻ" tone="error">
          Chưa thể xác nhận hồ sơ thuộc tài khoản hiện tại. Ba mẹ vui lòng thử
          lại.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={retryChild}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }
  if (
    !selectedChild ||
    (state.status === "ready" && state.child.id !== selectedChild.id) ||
    (state.status !== "ready" &&
      state.status !== "loading" &&
      state.childId !== selectedChild.id)
  ) {
    return (
      <section
        aria-busy="true"
        aria-label="Đang cập nhật lịch sử đọc"
        className="mx-auto flex max-w-[1120px] flex-col gap-6"
      >
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-40 rounded-card" />
      </section>
    );
  }

  if (state.status === "unavailable")
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          Dữ liệu đang chờ bổ sung
        </h1>
        <StatusMessage tone="info">
          Dữ liệu của mục này chưa sẵn sàng theo định dạng hiện tại. Không có dữ
          liệu mẫu thay thế.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" /> Thử lại
        </Button>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/children"
          variant="secondary"
        >
          Quản lý hồ sơ bé
        </ButtonLink>
      </section>
    );
  if (state.status === "not-found") {
    return (
      <StatusMessage title="Không tìm thấy lịch sử" tone="error">
        Dữ liệu không tồn tại hoặc không thuộc tài khoản hiện tại.
      </StatusMessage>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <StatusMessage title="Chưa tải được lịch sử" tone="error">
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
    );
  }

  if (state.status !== "ready") {
    return (
      <section
        aria-busy="true"
        aria-label="Đang tải lịch sử đọc"
        className="mx-auto flex max-w-[1120px] flex-col gap-6"
      >
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-40 rounded-card" />
      </section>
    );
  }

  const nextPage =
    state.nextCursor === null ? null : historyPageFromCursor(state.nextCursor);
  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 sm:gap-8">
      <ReportPageHeader
        description="Các buổi đọc được sắp xếp từ mới nhất; chỉ hiển thị dữ liệu của gia đình mình."
        eyebrow="Hành trình đọc"
        title="Lịch sử buổi đọc"
      />
      <SelectedChildIdentity child={state.child} />
      {state.items.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink href="/books">
              Chọn sách để đọc
            </ButtonLink>
          }
          description="Các buổi đọc được lưu của bé sẽ xuất hiện ở đây, kể cả buổi đang thực hiện."
          icon={<History aria-hidden="true" className="size-10 text-primary" />}
          title={
            currentPage > 1
              ? "Không còn buổi đọc ở trang này"
              : "Chưa có buổi đọc"
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {state.items.map((item) => (
            <SessionHistoryItem
              item={item}
              key={item.session.id}
              page={currentPage}
            />
          ))}
        </div>
      )}
      <nav
        aria-label="Phân trang lịch sử"
        className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between"
      >
        {currentPage > 1 ? (
          <ButtonLink
            className="sm:w-auto sm:min-w-40"
            href={`/sessions?page=${currentPage - 1}`}
            variant="secondary"
          >
            Trang trước
          </ButtonLink>
        ) : (
          <span />
        )}
        {nextPage !== null ? (
          <ButtonLink
            className="sm:w-auto sm:min-w-40"
            href={`/sessions?page=${nextPage}`}
          >
            Trang sau
          </ButtonLink>
        ) : null}
      </nav>
    </section>
  );
}
