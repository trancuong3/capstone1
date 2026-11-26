"use client";

import { BarChart3, History, RefreshCw } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";

import { ChildSelector } from "@/components/reports/child-selector";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { SessionHistoryItem } from "@/components/reports/session-history-item";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  groupSessionHistoryByDay,
  historyPageFromCursor,
  mapSessionHistoryItem,
} from "@/lib/utils/report-mappers";
import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type { SessionHistoryItemViewModelUI } from "@/types/reports";

type ScreenState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly children: readonly ChildProfileDTO[];
      readonly child: ChildProfileDTO;
      readonly items: readonly SessionHistoryItemViewModelUI[];
      readonly nextCursor: string | null;
    }
  | { readonly status: "no-children" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" }
  | { readonly status: "error" };

interface SessionHistoryScreenProps {
  readonly page: number;
  readonly requestedChildId?: string;
}

export function SessionHistoryScreen({
  page,
  requestedChildId,
}: SessionHistoryScreenProps) {
  const { childService, sessionService } = useReportServices();
  const appStore = useContext(AppStoreContext);
  const initialStoreChildIdRef = useRef(appStore?.selectedChildId ?? null);
  const currentPage =
    Number.isSafeInteger(page) && page >= 1 && page <= 100000 ? page : 1;
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
        const preferredChildId =
          requestedChildId ?? initialStoreChildIdRef.current ?? undefined;
        const matchedChild = preferredChildId
          ? children.find((item) => item.id === preferredChildId)
          : children[0];
        const child = matchedChild
          ? matchedChild
          : requestedChildId
            ? await childService.get(requestedChildId)
            : children[0];
        const history = await sessionService.list(child.id, {
          cursor: currentPage > 1 ? `page-${currentPage}` : undefined,
          limit: 10,
        });

        // Deduplicate historical book metadata requests per unique book_id on
        // the current page so repeated reads of the same book issue one request.
        const bookPromises = new Map<string, Promise<BookDetailDTO>>();
        const items = await Promise.all(
          history.sessions.map(async (session) => {
            let bookPromise = bookPromises.get(session.book_id);
            if (!bookPromise) {
              bookPromise = sessionService.getBook(session.id);
              bookPromises.set(session.book_id, bookPromise);
            }
            const book = await bookPromise;
            if (book.id !== session.book_id)
              throw new Error("Invalid historical book response");
            return mapSessionHistoryItem(session, child, book);
          }),
        );
        if (active) {
          setState({
            status: "ready",
            children,
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
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [childService, currentPage, requestKey, requestedChildId, sessionService]);

  const syncAvailableChildren = appStore?.syncAvailableChildren;
  const selectChildInStore = appStore?.selectChild;
  const setValidatedSelectedChild = appStore?.setValidatedSelectedChild;
  const syncedChildIdRef = useRef<string | null>(null);
  const readyChild = state.status === "ready" ? state.child : null;
  const readyChildren = state.status === "ready" ? state.children : null;

  useEffect(() => {
    if (!readyChild || !readyChildren) return;
    if (syncedChildIdRef.current === readyChild.id) return;
    syncedChildIdRef.current = readyChild.id;
    syncAvailableChildren?.(readyChildren);
    selectChildInStore?.(readyChild.id);
    setValidatedSelectedChild?.(readyChild);
  }, [
    readyChild,
    readyChildren,
    selectChildInStore,
    setValidatedSelectedChild,
    syncAvailableChildren,
  ]);

  if (state.status === "loading") {
    return (
      <section
        aria-busy="true"
        aria-label="Đang tải lịch sử đọc"
        className="mx-auto flex w-full max-w-[1120px] flex-col gap-5"
      >
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-16 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </section>
    );
  }

  if (state.status === "no-children") {
    return (
      <EmptyState
        headingLevel={1}
        action={<ButtonLink href="/children/new">Tạo hồ sơ bé</ButtonLink>}
        description="Tạo hồ sơ để bắt đầu lưu lại các buổi đọc của bé."
        icon={<History aria-hidden="true" className="size-10 text-primary" />}
        title="Chưa có hồ sơ bé"
      />
    );
  }

  if (state.status === "unavailable")
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          Dữ liệu đang chờ bổ sung
        </h1>
        <StatusMessage tone="info">
          Dữ liệu lịch sử đọc hiện chưa sẵn sàng. Hệ thống không hiển thị dữ
          liệu mẫu thay thế.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" /> Thử lại
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
          <RefreshCw aria-hidden="true" className="size-4" />
          Thử lại
        </Button>
      </div>
    );
  }

  const childQuery = `childId=${encodeURIComponent(state.child.id)}`;
  const nextPage =
    state.nextCursor === null ? null : historyPageFromCursor(state.nextCursor);
  const dayGroups = groupSessionHistoryByDay(state.items);

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-3.5 pb-4 md:gap-5">
      <ReportPageHeader
        action={
          <ButtonLink
            className="min-h-11 w-auto px-3 py-2 text-xs md:px-5 md:text-label"
            href={`/reports?${childQuery}`}
            variant="secondary"
          >
            <BarChart3 aria-hidden="true" className="size-4" />
            Xem tiến bộ
          </ButtonLink>
        }
        description="Các buổi đọc gần nhất được nhóm theo ngày (giờ Việt Nam). Chạm vào một buổi để xem báo cáo đối chiếu."
        eyebrow={`Đang xem · ${state.child.alias} (Lớp ${state.child.grade})`}
        title="Lịch sử đọc"
      />

      <div
        className={
          state.items.length > 0
            ? "flex flex-col justify-between gap-2 rounded-card border border-border bg-white px-3.5 py-2.5 md:flex-row md:items-end md:gap-3 md:p-4"
            : "hidden flex-col justify-between gap-3 rounded-card border border-border bg-white p-3.5 md:flex md:flex-row md:items-end md:p-4"
        }
      >
        <div className="hidden w-full md:block md:max-w-sm">
          <ChildSelector
            childrenProfiles={state.children}
            selectedChildId={state.child.id}
          />
        </div>
        {state.items.length > 0 ? (
          <p className="text-xs font-semibold text-muted tabular-nums">
            Hiển thị {state.items.length} buổi trên trang {currentPage} · Mới
            nhất trước
          </p>
        ) : null}
      </div>

      {state.items.length === 0 ? (
        <EmptyState
          action={
            <ButtonLink href={`/books?${childQuery}`}>
              Chọn sách để đọc
            </ButtonLink>
          }
          description="Các buổi đọc của bé sẽ được lưu lại tại đây, bao gồm cả những buổi đang thực hiện."
          icon={<History aria-hidden="true" className="size-10 text-primary" />}
          title={
            currentPage > 1
              ? "Không còn buổi đọc ở trang này"
              : "Chưa có buổi đọc"
          }
        />
      ) : (
        <div className="flex flex-col gap-3.5 md:gap-5">
          {dayGroups.map((group) => (
            <section
              aria-labelledby={`history-day-${group.dayKey}`}
              className="space-y-2"
              key={group.dayKey}
            >
              <div className="flex items-baseline justify-between gap-2 px-1">
                <h2
                  className="text-sm font-extrabold text-ink"
                  id={`history-day-${group.dayKey}`}
                >
                  {group.heading}
                </h2>
                <span className="text-xs font-semibold text-muted tabular-nums">
                  {group.items.length} buổi
                </span>
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-white">
                {group.items.map((item) => (
                  <SessionHistoryItem
                    item={item}
                    key={item.session.id}
                    page={currentPage}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {currentPage > 1 || nextPage !== null ? (
        <nav
          aria-label="Phân trang lịch sử"
          className="flex flex-col-reverse items-center gap-3 pt-1 sm:flex-row sm:justify-between"
        >
          {currentPage > 1 ? (
            <ButtonLink
              className="sm:w-auto sm:min-w-36"
              href={`/sessions?${childQuery}&page=${currentPage - 1}`}
              variant="secondary"
            >
              Trang trước
            </ButtonLink>
          ) : (
            <span className="hidden sm:block sm:min-w-36" />
          )}
          <span
            aria-current="page"
            className="text-sm font-bold text-muted tabular-nums"
          >
            Trang {currentPage}
          </span>
          {nextPage !== null ? (
            <ButtonLink
              className="sm:w-auto sm:min-w-36"
              href={`/sessions?${childQuery}&page=${nextPage}`}
            >
              Trang sau
            </ButtonLink>
          ) : (
            <span className="hidden sm:block sm:min-w-36" />
          )}
        </nav>
      ) : null}
    </section>
  );
}
