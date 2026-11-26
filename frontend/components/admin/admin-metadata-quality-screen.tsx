"use client";

import { AlertTriangle, BookOpen, Copy, FileWarning, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AdminBadge,
  AdminKpiCard,
  AdminKpiGrid,
  AdminLoading,
  AdminPageHeader,
  AdminSearchInput,
  AdminSelect,
  AdminStatusBadge,
  AdminToolbar,
} from "@/components/admin/admin-ui";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { ResponsiveTable } from "@/components/common/responsive-table";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type {
  MetadataQualityDashboardDTO,
  MetadataQualityIssueType,
  MetadataQualityLifecycleStatus,
} from "@/types/metadata-quality";

export interface AdminMetadataQualityScreenProps {
  readonly embedded?: boolean;
  readonly refreshSignal?: number;
}

function getIssueTone(
  issue: MetadataQualityIssueType,
): "danger" | "warning" | "info" {
  switch (issue) {
    case "MISSING_TITLE":
    case "INVALID_GRADE_RANGE":
      return "danger";
    case "POSSIBLE_DUPLICATE":
      return "info";
    case "MISSING_AUTHOR":
    default:
      return "warning";
  }
}

export function AdminMetadataQualityScreen({
  embedded = false,
  refreshSignal = 0,
}: AdminMetadataQualityScreenProps = {}) {
  const { metadataQuality } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDateTime, formatNumber } = useI18n();
  const [dashboard, setDashboard] =
    useState<MetadataQualityDashboardDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"auth" | "forbidden" | "safe" | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [issueType, setIssueType] = useState<MetadataQualityIssueType | "">("");
  const [lifecycle, setLifecycle] = useState<
    MetadataQualityLifecycleStatus | ""
  >("");
  const [offset, setOffset] = useState(0);
  const requestIdRef = useRef(0);
  const lastRefreshSignalRef = useRef(refreshSignal);
  const limit = 10;

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await metadataQuality.get({
        search: search.trim() || undefined,
        issue_type: issueType || undefined,
        lifecycle_status: lifecycle || undefined,
        limit,
        offset,
      });
      if (requestId !== requestIdRef.current) return;
      setDashboard(next);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      setDashboard(null);
      setError(
        isServiceError(cause) && cause.code === "AUTH_REQUIRED"
          ? "auth"
          : isServiceError(cause) && cause.code === "FORBIDDEN"
            ? "forbidden"
            : "safe",
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [issueType, lifecycle, metadataQuality, offset, search]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 180);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (refreshSignal === lastRefreshSignalRef.current) return;
    lastRefreshSignalRef.current = refreshSignal;
    void load();
  }, [load, refreshSignal]);

  function clearFilters() {
    setSearch("");
    setIssueType("");
    setLifecycle("");
    setOffset(0);
  }

  const currentPage = dashboard
    ? Math.floor(dashboard.offset / Math.max(1, dashboard.limit)) + 1
    : 1;
  const hasFilters = Boolean(search.trim() || issueType || lifecycle);

  return (
    <div className="space-y-4">
      {!embedded ? (
        <AdminPageHeader
          actions={
            <Button
              disabled={loading}
              onClick={() => void load()}
              size="admin"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {t("common.reload")}
            </Button>
          }
          description={t("metadataQuality.description")}
          eyebrow={t("metadataQuality.eyebrow")}
          title={t("metadataQuality.dashboardTitle")}
        />
      ) : null}

      {dashboard ? (
        <AdminKpiGrid ariaLabel={t("metadataQuality.overviewAria")} columns={4}>
          <AdminKpiCard
            detail={t("metadataQuality.cards.totalBooksDetail")}
            icon={<BookOpen className="size-4" />}
            label={t("metadataQuality.cards.totalBooks")}
            tone="neutral"
            value={formatNumber(dashboard.summary.total_books)}
          />
          <AdminKpiCard
            active={issueType === ""}
            detail={t("metadataQuality.cards.flaggedBooksDetail")}
            icon={<AlertTriangle className="size-4" />}
            label={t("metadataQuality.cards.flaggedBooks")}
            onClick={() => {
              setOffset(0);
              setIssueType("");
            }}
            tone={
              dashboard.summary.books_with_issues > 0 ? "warning" : "success"
            }
            value={formatNumber(dashboard.summary.books_with_issues)}
          />
          <AdminKpiCard
            active={issueType === "MISSING_TITLE"}
            detail={t(
              "metadataQuality.cards.missingMetadataSummary",
              {
                missingAuthor: formatNumber(dashboard.summary.missing_author),
                invalidGrade: formatNumber(
                  dashboard.summary.invalid_grade_range,
                ),
              },
              "Thiếu tác giả: {missingAuthor} · Sai khối lớp: {invalidGrade}",
            )}
            icon={<FileWarning className="size-4" />}
            label={t("metadataQuality.cards.missingTitle")}
            onClick={() => {
              setOffset(0);
              setIssueType((prev) =>
                prev === "MISSING_TITLE" ? "" : "MISSING_TITLE",
              );
            }}
            tone={dashboard.summary.missing_title > 0 ? "danger" : "neutral"}
            value={formatNumber(dashboard.summary.missing_title)}
          />
          <AdminKpiCard
            active={issueType === "POSSIBLE_DUPLICATE"}
            detail={t("metadataQuality.cards.duplicateGroupsDetail", {
              count: formatNumber(dashboard.summary.books_in_duplicate_groups),
            })}
            icon={<Copy className="size-4" />}
            label={t("metadataQuality.cards.duplicateGroups")}
            onClick={() => {
              setOffset(0);
              setIssueType((prev) =>
                prev === "POSSIBLE_DUPLICATE" ? "" : "POSSIBLE_DUPLICATE",
              );
            }}
            tone={
              dashboard.summary.possible_duplicate_groups > 0
                ? "info"
                : "neutral"
            }
            value={formatNumber(dashboard.summary.possible_duplicate_groups)}
          />
        </AdminKpiGrid>
      ) : null}

      <AdminToolbar
        actions={
          hasFilters ? (
            <Button
              onClick={clearFilters}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("metadataQuality.clearFilters")}
            </Button>
          ) : undefined
        }
        ariaLabel={t("metadataQuality.filterAria")}
      >
        <AdminSearchInput
          label={t("metadataQuality.searchLabel")}
          onChange={(value) => {
            setOffset(0);
            setSearch(value);
          }}
          placeholder={t(
            "metadataQuality.searchPlaceholder",
            undefined,
            "Nhập tiêu đề hoặc tác giả…",
          )}
          role="textbox"
          value={search}
        />
        <AdminSelect
          containerClassName="w-full sm:w-56"
          label={t("metadataQuality.issueTypeLabel")}
          onChange={(value) => {
            setOffset(0);
            setIssueType(value as MetadataQualityIssueType | "");
          }}
          value={issueType}
        >
          <option value="">{t("metadataQuality.allIssues")}</option>
          <option value="MISSING_TITLE">
            {t("metadataQuality.issueLabels.MISSING_TITLE")}
          </option>
          <option value="MISSING_AUTHOR">
            {t("metadataQuality.issueLabels.MISSING_AUTHOR")}
          </option>
          <option value="INVALID_GRADE_RANGE">
            {t("metadataQuality.issueLabels.INVALID_GRADE_RANGE")}
          </option>
          <option value="POSSIBLE_DUPLICATE">
            {t("metadataQuality.issueLabels.POSSIBLE_DUPLICATE")}
          </option>
        </AdminSelect>
        <AdminSelect
          containerClassName="w-full sm:w-44"
          label={t("metadataQuality.lifecycleLabel")}
          onChange={(value) => {
            setOffset(0);
            setLifecycle(value as MetadataQualityLifecycleStatus | "");
          }}
          value={lifecycle}
        >
          <option value="">{t("metadataQuality.allStatuses")}</option>
          <option value="ACTIVE">
            {t("metadataQuality.lifecycleLabels.ACTIVE")}
          </option>
          <option value="RETIRED">
            {t("metadataQuality.lifecycleLabels.RETIRED")}
          </option>
        </AdminSelect>
      </AdminToolbar>

      {loading ? (
        <AdminLoading label={t("metadataQuality.loading")} variant="skeleton" />
      ) : error ? (
        <StatusMessage
          title={
            error === "auth"
              ? t("common.authRequiredTitle")
              : error === "forbidden"
                ? t("common.forbiddenTitle")
                : t("metadataQuality.loadErrorTitle")
          }
          tone="error"
        >
          {error === "auth" ? (
            <Link
              className="inline-flex min-h-10 items-center rounded-md px-1 font-semibold underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/login"
            >
              {t("common.goToLogin")}
            </Link>
          ) : error === "safe" ? (
            <Button
              className="mt-2"
              onClick={() => void load()}
              size="admin"
              type="button"
              variant="secondary"
            >
              {t("common.retry")}
            </Button>
          ) : (
            <p>{t("metadataQuality.forbiddenDesc")}</p>
          )}
        </StatusMessage>
      ) : dashboard ? (
        <section className="rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5">
          <div className="mb-4 flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-lg font-extrabold tracking-tight text-ink">
                {t("metadataQuality.issuesHeading")}
              </h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                {t("metadataQuality.duplicateNote")}
              </p>
            </div>
            <p
              aria-live="polite"
              className="shrink-0 text-xs font-bold tabular-nums text-muted"
            >
              {t("metadataQuality.resultsCount", {
                total: formatNumber(dashboard.total),
              })}
            </p>
          </div>

          {dashboard.items.length === 0 ? (
            <EmptyState
              description={
                hasFilters
                  ? t("metadataQuality.emptySearchDesc")
                  : t("metadataQuality.emptyOtherDesc")
              }
              title={
                hasFilters
                  ? t("metadataQuality.emptySearchTitle")
                  : dashboard.summary.books_with_issues === 0
                    ? t("metadataQuality.emptyOkTitle")
                    : t("metadataQuality.emptyPageTitle")
              }
            />
          ) : (
            <>
              <div
                aria-label={t("metadataQuality.mobileListAria")}
                className="grid gap-3 md:hidden"
              >
                {dashboard.items.map((book) => {
                  const primaryIssue =
                    book.issues.find(
                      (issue) => issue !== "POSSIBLE_DUPLICATE",
                    ) ?? book.issues[0];
                  return (
                    <article
                      className="rounded-xl border border-border bg-surface-subtle/50 p-3.5"
                      key={book.id}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="break-words text-sm font-extrabold text-ink">
                            {book.title?.trim() ? (
                              <span dir="auto">{book.title}</span>
                            ) : (
                              t("metadataQuality.missingTitleFallback")
                            )}
                          </h3>
                          <p className="mt-0.5 text-xs text-muted">
                            {t("metadataQuality.authorLabel", {
                              author: book.author?.trim()
                                ? book.author
                                : t("metadataQuality.authorMissing"),
                            })}{" "}
                            ·{" "}
                            <span className="tabular-nums">
                              {book.min_grade == null || book.max_grade == null
                                ? t("metadataQuality.gradeInvalidSummary")
                                : t("metadataQuality.gradeRangeSummary", {
                                    min: book.min_grade,
                                    max: book.max_grade,
                                  })}
                            </span>
                          </p>
                        </div>
                        <AdminStatusBadge
                          label={t(
                            `metadataQuality.lifecycleLabels.${book.lifecycle_status}`,
                            undefined,
                            book.lifecycle_status,
                          )}
                          status={book.lifecycle_status}
                          tone={
                            book.lifecycle_status === "ACTIVE"
                              ? "success"
                              : "neutral"
                          }
                        />
                      </div>
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {book.issues.map((issue) => (
                          <AdminBadge key={issue} tone={getIssueTone(issue)}>
                            {t(`metadataQuality.issueLabels.${issue}`)}
                          </AdminBadge>
                        ))}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 border-t border-border/80 pt-3">
                        {book.issues.some(
                          (issue) => issue !== "POSSIBLE_DUPLICATE",
                        ) ? (
                          <ButtonLink
                            href={
                              "/admin/books/" +
                              encodeURIComponent(book.id) +
                              "/edit?returnTo=metadata-quality&issue=" +
                              encodeURIComponent(primaryIssue)
                            }
                            size="admin"
                            variant="secondary"
                          >
                            {book.issues.includes("MISSING_TITLE")
                              ? t("metadataQuality.repairMetadata")
                              : t("metadataQuality.editMetadata")}
                          </ButtonLink>
                        ) : null}
                        {book.issues.includes("POSSIBLE_DUPLICATE") ? (
                          <ButtonLink
                            href={"/admin/books/" + encodeURIComponent(book.id)}
                            size="admin"
                            variant="outline"
                          >
                            {t("metadataQuality.compareBooks")}
                          </ButtonLink>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className="hidden md:block">
                <ResponsiveTable ariaLabel={t("metadataQuality.tableAria")}>
                  <table className="w-full min-w-[780px] border-collapse text-start text-sm">
                    <thead>
                      <tr className="border-b border-border bg-surface-subtle text-xs font-bold uppercase tracking-wide text-muted">
                        <th className="px-3.5 py-2.5" scope="col">
                          {t("metadataQuality.columns.book")}
                        </th>
                        <th className="px-3.5 py-2.5" scope="col">
                          {t("metadataQuality.columns.author")}
                        </th>
                        <th className="px-3.5 py-2.5" scope="col">
                          {t("metadataQuality.columns.grades")}
                        </th>
                        <th className="px-3.5 py-2.5" scope="col">
                          {t("metadataQuality.columns.status")}
                        </th>
                        <th className="px-3.5 py-2.5" scope="col">
                          {t("metadataQuality.columns.issues")}
                        </th>
                        <th className="px-3.5 py-2.5 text-end" scope="col">
                          {t("metadataQuality.columns.actions")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.items.map((book) => {
                        const primaryIssue =
                          book.issues.find(
                            (issue) => issue !== "POSSIBLE_DUPLICATE",
                          ) ?? book.issues[0];
                        return (
                          <tr
                            className="border-b border-border transition-colors last:border-0 hover:bg-surface-subtle/60"
                            key={book.id}
                          >
                            <td className="px-3.5 py-3 font-bold text-ink">
                              {book.title?.trim() ? (
                                <span dir="auto">{book.title}</span>
                              ) : (
                                <span className="text-danger">
                                  {t("metadataQuality.missingTitleFallback")}
                                </span>
                              )}
                            </td>
                            <td className="px-3.5 py-3 text-muted">
                              {book.author?.trim()
                                ? book.author
                                : t("metadataQuality.authorMissing")}
                            </td>
                            <td className="px-3.5 py-3 tabular-nums text-muted">
                              {book.min_grade == null || book.max_grade == null
                                ? t("metadataQuality.gradeInvalidShort")
                                : t("metadataQuality.gradeRangeSummary", {
                                    min: book.min_grade,
                                    max: book.max_grade,
                                  })}
                            </td>
                            <td className="px-3.5 py-3">
                              <AdminStatusBadge
                                label={t(
                                  `metadataQuality.lifecycleLabels.${book.lifecycle_status}`,
                                  undefined,
                                  book.lifecycle_status,
                                )}
                                status={book.lifecycle_status}
                                tone={
                                  book.lifecycle_status === "ACTIVE"
                                    ? "success"
                                    : "neutral"
                                }
                              />
                            </td>
                            <td className="px-3.5 py-3">
                              <div className="flex max-w-sm flex-wrap gap-1.5">
                                {book.issues.map((issue) => (
                                  <AdminBadge
                                    key={issue}
                                    tone={getIssueTone(issue)}
                                  >
                                    {t(`metadataQuality.issueLabels.${issue}`)}
                                  </AdminBadge>
                                ))}
                              </div>
                            </td>
                            <td className="px-3.5 py-3">
                              <div className="flex flex-wrap justify-end gap-2">
                                {book.issues.some(
                                  (issue) => issue !== "POSSIBLE_DUPLICATE",
                                ) ? (
                                  <ButtonLink
                                    href={
                                      "/admin/books/" +
                                      encodeURIComponent(book.id) +
                                      "/edit?returnTo=metadata-quality&issue=" +
                                      encodeURIComponent(primaryIssue)
                                    }
                                    size="admin"
                                    variant="secondary"
                                  >
                                    {book.issues.includes("MISSING_TITLE")
                                      ? t("metadataQuality.repairMetadata")
                                      : t("metadataQuality.editMetadata")}
                                  </ButtonLink>
                                ) : null}
                                {book.issues.includes("POSSIBLE_DUPLICATE") ? (
                                  <ButtonLink
                                    href={
                                      "/admin/books/" +
                                      encodeURIComponent(book.id)
                                    }
                                    size="admin"
                                    variant="outline"
                                  >
                                    {t("metadataQuality.compareBooks")}
                                  </ButtonLink>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ResponsiveTable>
              </div>
            </>
          )}

          <PaginationBar
            ariaLabel={t("metadataQuality.paginationAria")}
            className="mt-4"
            compact
            disabled={loading}
            itemLabel={t("metadataQuality.itemLabel")}
            onPageChange={(nextPage) => setOffset((nextPage - 1) * limit)}
            page={currentPage}
            pageSize={dashboard.limit}
            showSummaryWhenSinglePage
            total={dashboard.total}
          />
          <p className="mt-3 text-xs text-muted">
            {t("metadataQuality.checkedAtLabel", {
              time: formatDateTime(dashboard.summary.checked_at),
            })}{" "}
            {t("metadataQuality.footerNote")}
          </p>
        </section>
      ) : null}
    </div>
  );
}
