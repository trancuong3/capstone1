"use client";

import { useCallback, useEffect, useState } from "react";

import { RefreshCw } from "lucide-react";

import { AdminLoading } from "@/components/admin/admin-ui";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useBookContentReportService } from "@/hooks/use-book-content-report-service";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type {
  BookContentReportDetailDTO,
  BookContentReportDTO,
} from "@/types/book-content-quality";

export function ParentBookReportsScreen() {
  const { formatDateTime } = useI18n();
  const t = useTranslations("books");
  const reportService = useBookContentReportService();
  const [items, setItems] = useState<BookContentReportDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"auth" | "forbidden" | "safe" | null>(
    null,
  );
  const [selectedDetail, setSelectedDetail] =
    useState<BookContentReportDetailDTO | null>(null);
  const [detailError, setDetailError] = useState<{
    reportId: string;
    message: string;
  } | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const limit = 10;
  const HISTORY_PAGE_SIZE = 5;

  async function toggleDetail(reportId: string) {
    if (selectedDetail?.id === reportId) {
      setSelectedDetail(null);
      setDetailError(null);
      setHistoryPage(1);
      return;
    }
    setLoadingDetailId(reportId);
    setDetailError(null);
    setHistoryPage(1);
    try {
      setSelectedDetail(await reportService.getMine(reportId));
    } catch {
      setDetailError({
        reportId,
        message: t("bookReports.detailLoadError"),
      });
    } finally {
      setLoadingDetailId(null);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await reportService.listMine({ limit, offset });
      if (page.total > 0 && offset >= page.total) {
        const lastPage = Math.max(1, Math.ceil(page.total / limit));
        setOffset((lastPage - 1) * limit);
        return;
      }
      setItems(page.items);
      setTotal(page.total);
    } catch (cause) {
      setItems([]);
      setTotal(0);
      setError(
        isServiceError(cause) && cause.code === "AUTH_REQUIRED"
          ? "auth"
          : isServiceError(cause) && cause.code === "FORBIDDEN"
            ? "forbidden"
            : "safe",
      );
    } finally {
      setLoading(false);
    }
  }, [offset, reportService]);

  useEffect(() => {
    // Defer the fetch kickoff so the effect does not synchronously schedule
    // state updates during the effect phase.
    const timer = globalThis.setTimeout(() => {
      void load();
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(Math.floor(offset / limit) + 1, totalPages);

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-label font-bold text-primary">
            {t("bookReports.eyebrow")}
          </p>
          <h1 className="mt-1 text-heading font-extrabold text-ink">
            {t("bookReports.heading")}
          </h1>
          <p className="mt-2 max-w-2xl text-body text-muted">
            {t("bookReports.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className="w-auto"
            onClick={() => void load()}
            size="compact"
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-4" />
            {t("bookReports.reload")}
          </Button>
          <ButtonLink className="w-auto" href="/books" size="compact">
            {t("bookReports.libraryLink")}
          </ButtonLink>
        </div>
      </header>

      {loading ? (
        <AdminLoading label={t("bookReports.loading")} />
      ) : error ? (
        <StatusMessage
          tone="error"
          title={
            error === "auth"
              ? t("bookReports.errorExpired")
              : error === "forbidden"
                ? t("bookReports.errorForbidden")
                : t("bookReports.errorGeneric")
          }
        >
          {t("bookReports.errorHint")}
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("bookReports.emptyTitle")}
          description={t("bookReports.emptyDescription")}
        />
      ) : (
        <div className="grid gap-4">
          {items.map((item) => (
            <article
              className="rounded-card border border-border bg-white p-4 sm:p-5"
              key={item.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2
                    className="viread-learning-content break-words font-semibold text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    {item.book_title}
                  </h2>
                  <p className="mt-1 text-sm text-muted">
                    {t(`reportDialog.issueTypes.${item.issue_type}`)}
                    {item.page_number !== null
                      ? t("reportDialog.pageSuffix", { page: item.page_number })
                      : t("reportDialog.wholeBookSuffix")}
                  </p>
                </div>
                <span className="rounded-full bg-sky px-3 py-1 text-sm font-semibold text-primary-hover">
                  {t(`reportDialog.statuses.${item.status}`)}
                </span>
              </div>
              <p className="mt-3 break-words whitespace-pre-wrap text-sm leading-6 text-ink">
                {item.description}
              </p>
              {item.reported_text ? (
                <p className="mt-2 break-words text-sm text-muted">
                  {t("bookReports.suspectedPrefix")}
                  <span
                    className="viread-learning-content font-semibold text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    {item.reported_text}
                  </span>
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3 text-xs text-muted">
                <time dateTime={item.created_at}>
                  {formatDateTime(item.created_at, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </div>
              <div className="mt-3">
                <Button
                  className="h-9 px-3 text-xs"
                  disabled={loadingDetailId === item.id}
                  fullWidth={false}
                  onClick={() => void toggleDetail(item.id)}
                  type="button"
                  variant="secondary"
                >
                  {selectedDetail?.id === item.id
                    ? t("bookReports.hideAdminResponse")
                    : t("bookReports.showAdminResponse")}
                </Button>
              </div>
              {detailError?.reportId === item.id && loadingDetailId === null ? (
                <p className="mt-2 text-xs text-danger" role="alert">
                  {detailError.message}
                </p>
              ) : null}
              {selectedDetail?.id === item.id ? (
                <div
                  className="mt-3 rounded-control border border-border bg-canvas p-3 text-sm"
                  data-testid="parent-report-detail"
                >
                  <p className="font-bold text-ink">
                    {t("bookReports.adminResponseTitle")}
                  </p>
                  <p className="mt-1 text-muted">
                    {selectedDetail.admin_resolution_note ??
                      t("bookReports.adminResponsePending")}
                  </p>
                  {selectedDetail.history.length ? (() => {
                    const totalHistoryPages = Math.max(
                      1,
                      Math.ceil(
                        selectedDetail.history.length / HISTORY_PAGE_SIZE,
                      ),
                    );
                    const safeHistoryPage = Math.min(
                      Math.max(1, historyPage),
                      totalHistoryPages,
                    );
                    const historyOffset =
                      (safeHistoryPage - 1) * HISTORY_PAGE_SIZE;
                    const visibleHistory = selectedDetail.history.slice(
                      historyOffset,
                      historyOffset + HISTORY_PAGE_SIZE,
                    );
                    return (
                      <>
                        <ul className="mt-2 grid gap-1 border-t border-border pt-2 text-xs text-muted">
                          {visibleHistory.map((entry, idx) => (
                            <li
                              key={`${entry.created_at}:${historyOffset + idx}`}
                            >
                              <span className="font-semibold text-ink">
                                {t(`reportDialog.statuses.${entry.to_status}`)}
                              </span>
                              {entry.note ? ` · ${entry.note}` : ""}
                            </li>
                          ))}
                        </ul>
                        <PaginationBar
                          className="mt-2"
                          compact
                          onPageChange={setHistoryPage}
                          page={safeHistoryPage}
                          pageSize={HISTORY_PAGE_SIZE}
                          total={selectedDetail.history.length}
                        />
                      </>
                    );
                  })() : null}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}

      <PaginationBar
        ariaLabel={t("bookReports.paginationAria")}
        compact
        disabled={loading}
        itemLabel={t("bookReports.paginationItemLabel")}
        onPageChange={(nextPage) => setOffset((nextPage - 1) * limit)}
        page={currentPage}
        pageSize={limit}
        total={total}
      />
    </section>
  );
}
