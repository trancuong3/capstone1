"use client";

import { History, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { ChildSelector } from "@/components/reports/child-selector";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { SessionHistoryItem } from "@/components/reports/session-history-item";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import { mapSessionHistoryItem } from "@/lib/utils/report-mappers";
import type { ChildProfileDTO } from "@/types/child";
import type { SessionHistoryItemViewModelUI } from "@/types/reports";

type ScreenState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly children: readonly ChildProfileDTO[];
      readonly child: ChildProfileDTO;
      readonly items: readonly SessionHistoryItemViewModelUI[];
      readonly hasNext: boolean;
    }
  | { readonly status: "no-children" }
  | { readonly status: "not-found" }
  | { readonly status: "error" };

interface SessionHistoryScreenProps {
  readonly page: number;
  readonly requestedChildId?: string;
}

export function SessionHistoryScreen({
  page,
  requestedChildId,
}: SessionHistoryScreenProps) {
  const { bookService, childService, sessionService } = useReportServices();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ScreenState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      try {
        const children = await childService.list();
        if (children.length === 0) {
          if (active) setState({ status: "no-children" });
          return;
        }
        const child = requestedChildId
          ? await childService.get(requestedChildId)
          : children[0];
        const [history, books] = await Promise.all([
          sessionService.list(child.id, {
            cursor: page > 1 ? `page-${page}` : undefined,
            limit: 2,
          }),
          bookService.list(),
        ]);
        const items = history.sessions.map((session) => {
          const book = books.find(
            (candidate) => candidate.id === session.book_id,
          );
          if (!book) throw new Error("Missing owned catalog item");
          return mapSessionHistoryItem(session, child, book);
        });
        if (active) {
          setState({
            status: "ready",
            children,
            child,
            items,
            hasNext: history.next_cursor !== null,
          });
        }
      } catch (error) {
        if (active) {
          setState({
            status:
              isServiceError(error) && error.status === 404
                ? "not-found"
                : "error",
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [
    bookService,
    childService,
    page,
    requestKey,
    requestedChildId,
    sessionService,
  ]);

  if (state.status === "loading") {
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

  if (state.status === "no-children") {
    return (
      <EmptyState
        headingLevel={1}
        action={<ButtonLink href="/children/new">Tạo hồ sơ bé</ButtonLink>}
        description="Tạo hồ sơ để bắt đầu lưu các buổi đọc."
        icon={<History aria-hidden="true" className="size-10 text-primary" />}
        title="Chưa có hồ sơ bé"
      />
    );
  }

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

  const childQuery = `childId=${encodeURIComponent(state.child.id)}`;
  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 sm:gap-8">
      <ReportPageHeader
        description="Các buổi đọc được sắp xếp từ mới nhất; chỉ hiển thị dữ liệu của gia đình mình."
        eyebrow="Hành trình đọc"
        title="Lịch sử buổi đọc"
      />
      <div className="max-w-md">
        <ChildSelector
          childrenProfiles={state.children}
          selectedChildId={state.child.id}
        />
      </div>
      {state.items.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink href={`/books?${childQuery}`}>
              Chọn sách để đọc
            </ButtonLink>
          }
          description="Khi bé hoàn thành hoặc dừng một buổi đọc, thông tin sẽ xuất hiện ở đây."
          icon={<History aria-hidden="true" className="size-10 text-primary" />}
          title={
            page > 1 ? "Không còn buổi đọc ở trang này" : "Chưa có buổi đọc"
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {state.items.map((item) => (
            <SessionHistoryItem item={item} key={item.session.id} />
          ))}
        </div>
      )}
      <nav
        aria-label="Phân trang lịch sử"
        className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between"
      >
        {page > 1 ? (
          <ButtonLink
            className="sm:w-auto sm:min-w-40"
            href={`/sessions?${childQuery}&page=${page - 1}`}
            variant="secondary"
          >
            Trang trước
          </ButtonLink>
        ) : (
          <span />
        )}
        {state.hasNext ? (
          <ButtonLink
            className="sm:w-auto sm:min-w-40"
            href={`/sessions?${childQuery}&page=${page + 1}`}
          >
            Trang sau
          </ButtonLink>
        ) : null}
      </nav>
    </section>
  );
}
