"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useBookContentReportService } from "@/hooks/use-book-content-report-service";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type {
  BookContentReportDetailDTO,
  BookContentReportDTO,
} from "@/types/book-content-quality";

export function MobileBookReportsScreen() {
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
  const limit = 20;

  async function toggleDetail(reportId: string) {
    if (selectedDetail?.id === reportId) {
      setSelectedDetail(null);
      setDetailError(null);
      return;
    }
    setLoadingDetailId(reportId);
    setDetailError(null);
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
    const timer = globalThis.setTimeout(() => {
      void load();
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [load]);

  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <section className="flex w-full flex-col gap-4 pb-2">
      <header className="flex flex-col gap-2.5">
        <span className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary">
          {t("bookReports.eyebrow")}
        </span>
        <h1 className="book-title text-[26px] leading-tight text-ink">
          {t("bookReports.heading")}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {t("bookReports.subtitle")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            fullWidth={false}
            onClick={() => void load()}
            size="touch"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("bookReports.reload")}
          </Button>
          <ButtonLink fullWidth={false} href="/books" size="touch">
            {t("bookReports.libraryLink")}
          </ButtonLink>
        </div>
      </header>

      {loading ? (
        <div
          aria-busy="true"
          aria-label={t("bookReports.loading")}
          className="flex flex-col gap-3"
        >
          <span className="sr-only" role="status">
            {t("bookReports.loading")}
          </span>
          <Skeleton className="h-36 w-full rounded-3xl" />
          <Skeleton className="h-36 w-full rounded-3xl" />
        </div>
      ) : error ? (
        <StatusMessage
          compact
          title={
            error === "auth"
              ? t("bookReports.errorExpired")
              : error === "forbidden"
                ? t("bookReports.errorForbidden")
                : t("bookReports.errorGeneric")
          }
          tone="error"
        >
          {t("bookReports.errorHint")}
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          description={t("bookReports.emptyDescription")}
          title={t("bookReports.emptyTitle")}
        />
      ) : (
        <div className="flex flex-col gap-3.5">
          {items.map((item) => (
            <article
              className="flex flex-col gap-3 rounded-3xl border border-border bg-white p-4 shadow-2xs"
              key={item.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h2
                    className="viread-learning-content break-words text-base font-extrabold leading-snug text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    {item.book_title}
                  </h2>
                  <p className="mt-1 text-xs font-semibold text-muted">
                    {t(`reportDialog.issueTypes.${item.issue_type}`)}
                    {item.page_number !== null
                      ? t("reportDialog.pageSuffix", { page: item.page_number })
                      : t("reportDialog.wholeBookSuffix")}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-sky px-3 py-1 text-xs font-extrabold text-primary">
                  {t(`reportDialog.statuses.${item.status}`)}
                </span>
              </div>

              <p className="break-words whitespace-pre-wrap text-sm leading-relaxed text-ink">
                {item.description}
              </p>

              {item.reported_text ? (
                <p className="break-words rounded-2xl border border-border bg-canvas/60 px-3 py-2 text-xs text-muted">
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

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                <time
                  className="text-xs font-semibold text-muted tabular-nums"
                  dateTime={item.created_at}
                >
                  {formatDateTime(item.created_at, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
                <Button
                  disabled={loadingDetailId === item.id}
                  fullWidth={false}
                  onClick={() => void toggleDetail(item.id)}
                  size="touch"
                  type="button"
                  variant="secondary"
                >
                  {selectedDetail?.id === item.id
                    ? t("bookReports.hideAdminResponse")
                    : t("bookReports.showAdminResponse")}
                </Button>
              </div>

              {detailError?.reportId === item.id && loadingDetailId === null ? (
                <p className="text-xs font-semibold text-danger" role="alert">
                  {detailError.message}
                </p>
              ) : null}

              {selectedDetail?.id === item.id ? (
                <div
                  className="flex flex-col gap-2 rounded-2xl border border-border bg-canvas/70 p-3.5 text-sm"
                  data-testid="parent-report-detail"
                >
                  <p className="font-extrabold text-ink">
                    {t("bookReports.adminResponseTitle")}
                  </p>
                  <p className="text-sm leading-relaxed text-muted">
                    {selectedDetail.admin_resolution_note ??
                      t("bookReports.adminResponsePending")}
                  </p>
                  {selectedDetail.history.length ? (
                    <ul className="space-y-1 border-t border-border pt-2 text-xs text-muted">
                      {selectedDetail.history.map((entry, idx) => (
                        <li key={`${entry.created_at}:${idx}`}>
                          <span className="font-semibold text-ink">
                            {t(`reportDialog.statuses.${entry.to_status}`)}
                          </span>
                          {entry.note ? ` · ${entry.note}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="break-all border-t border-border pt-2 text-[11px] text-muted">
                    {t("bookReports.reportIdPrefix")}
                    <span className="font-mono">{item.id}</span>
                  </p>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}

      <PaginationBar
        ariaLabel={t("bookReports.paginationAria")}
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
