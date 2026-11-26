"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { ResponsiveTable } from "@/components/common/responsive-table";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { SelectField } from "@/components/common/select-field";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type {
  MetadataQualityDashboardDTO,
  MetadataQualityIssueType,
  MetadataQualityLifecycleStatus,
} from "@/types/metadata-quality";

export function AdminMetadataQualityScreen() {
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
    <>
      <AdminPageHeader
        eyebrow={t("metadataQuality.eyebrow")}
        title={t("metadataQuality.dashboardTitle")}
        description={t("metadataQuality.description")}
        actions={
          <Button
            className="sm:w-auto"
            disabled={loading}
            onClick={() => void load()}
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-5" />
            {t("common.reload")}
          </Button>
        }
      />

      <section aria-label={t("metadataQuality.filterAria")} className="mb-4">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute end-4 top-9 size-5 text-muted"
            />
            <TextField
              label={t("metadataQuality.searchLabel")}
              onChange={(event) => {
                setOffset(0);
                setSearch(event.target.value);
              }}
              value={search}
            />
          </div>
          <SelectField
            label={t("metadataQuality.issueTypeLabel")}
            onChange={(event) => {
              setOffset(0);
              setIssueType(event.target.value as MetadataQualityIssueType | "");
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
          </SelectField>
          <SelectField
            label={t("metadataQuality.lifecycleLabel")}
            onChange={(event) => {
              setOffset(0);
              setLifecycle(
                event.target.value as MetadataQualityLifecycleStatus | "",
              );
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
          </SelectField>
        </div>
        {hasFilters ? (
          <Button
            className="mt-4 sm:w-auto"
            onClick={clearFilters}
            type="button"
            variant="quiet"
          >
            {t("metadataQuality.clearFilters")}
          </Button>
        ) : null}
      </section>

      {loading ? (
        <AdminLoading label={t("metadataQuality.loading")} />
      ) : error ? (
        <StatusMessage
          tone="error"
          title={
            error === "auth"
              ? t("common.authRequiredTitle")
              : error === "forbidden"
                ? t("common.forbiddenTitle")
                : t("metadataQuality.loadErrorTitle")
          }
        >
          {error === "auth" ? (
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-semibold underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/login"
            >
              {t("common.goToLogin")}
            </Link>
          ) : error === "safe" ? (
            <Button
              className="mt-2 sm:w-auto"
              onClick={() => void load()}
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
        <>
          <section
            aria-label={t("metadataQuality.overviewAria")}
            className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            {[
              {
                label: t("metadataQuality.cards.totalBooks"),
                value: dashboard.summary.total_books,
                detail: t("metadataQuality.cards.totalBooksDetail"),
              },
              {
                label: t("metadataQuality.cards.flaggedBooks"),
                value: dashboard.summary.books_with_issues,
                detail: t("metadataQuality.cards.flaggedBooksDetail"),
              },
              {
                label: t("metadataQuality.cards.missingTitle"),
                value: dashboard.summary.missing_title,
                detail: t("metadataQuality.cards.missingTitleDetail"),
              },
              {
                label: t("metadataQuality.cards.missingAuthor"),
                value: dashboard.summary.missing_author,
                detail: t("metadataQuality.cards.missingAuthorDetail"),
              },
              {
                label: t("metadataQuality.cards.invalidGradeRange"),
                value: dashboard.summary.invalid_grade_range,
                detail: t("metadataQuality.cards.invalidGradeRangeDetail"),
              },
              {
                label: t("metadataQuality.cards.duplicateGroups"),
                value: dashboard.summary.possible_duplicate_groups,
                detail: t("metadataQuality.cards.duplicateGroupsDetail", {
                  count: formatNumber(
                    dashboard.summary.books_in_duplicate_groups,
                  ),
                }),
              },
            ].map((metric) => (
              <article
                className="rounded-card border border-border bg-white p-4"
                key={metric.label}
              >
                <p className="text-sm font-semibold text-muted">
                  {metric.label}
                </p>
                <p className="mt-2 text-[32px] font-extrabold tabular-nums text-primary">
                  {formatNumber(metric.value)}
                </p>
                <p className="sr-only">{metric.detail}</p>
              </article>
            ))}
          </section>

          <section className="rounded-card border border-border bg-white p-4 sm:p-6">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-2xl font-extrabold text-ink">
                  {t("metadataQuality.issuesHeading")}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {t("metadataQuality.duplicateNote")}
                </p>
              </div>
              <p
                aria-live="polite"
                className="text-sm font-semibold text-muted"
              >
                {t("metadataQuality.resultsCount", {
                  total: formatNumber(dashboard.total),
                })}
              </p>
            </div>

            {dashboard.items.length === 0 ? (
              <div className="rounded-card bg-cream p-8 text-center">
                <h3 className="font-semibold text-ink">
                  {hasFilters
                    ? t("metadataQuality.emptySearchTitle")
                    : dashboard.summary.books_with_issues === 0
                      ? t("metadataQuality.emptyOkTitle")
                      : t("metadataQuality.emptyPageTitle")}
                </h3>
                <p className="mt-2 text-sm text-muted">
                  {hasFilters
                    ? t("metadataQuality.emptySearchDesc")
                    : t("metadataQuality.emptyOtherDesc")}
                </p>
              </div>
            ) : (
              <>
                <div
                  aria-label={t("metadataQuality.mobileListAria")}
                  className="grid gap-3 md:hidden"
                >
                  {dashboard.items.map((book) => (
                    <article
                      className="rounded-card border border-border bg-canvas/40 p-4"
                      key={book.id}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="break-words text-base font-extrabold text-ink">
                            {book.title?.trim() ? (
                              <span dir="auto">{book.title}</span>
                            ) : (
                              t("metadataQuality.missingTitleFallback")
                            )}
                          </h3>
                          <p className="mt-0.5 text-sm text-muted">
                            {t("metadataQuality.authorLabel", {
                              author: book.author?.trim()
                                ? book.author
                                : t("metadataQuality.authorMissing"),
                            })}{" "}
                            ·{" "}
                            {book.min_grade == null || book.max_grade == null
                              ? t("metadataQuality.gradeInvalidSummary")
                              : t("metadataQuality.gradeRangeSummary", {
                                  min: book.min_grade,
                                  max: book.max_grade,
                                })}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-muted">
                          {t(
                            `metadataQuality.lifecycleLabels.${book.lifecycle_status}`,
                            undefined,
                            book.lifecycle_status,
                          )}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {book.issues.map((issue) => (
                          <span
                            className="inline-flex rounded-full bg-warning-surface px-2.5 py-1 text-xs font-semibold text-warning"
                            key={issue}
                          >
                            {t(`metadataQuality.issueLabels.${issue}`)}
                          </span>
                        ))}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 border-t border-border/70 pt-3">
                        {book.issues.some(
                          (issue) => issue !== "POSSIBLE_DUPLICATE",
                        ) ? (
                          <Link
                            className="inline-flex min-h-12 items-center rounded-control bg-sky px-3.5 text-sm font-bold text-primary-hover focus-visible:outline-3 focus-visible:outline-primary"
                            href={
                              "/admin/books/" +
                              encodeURIComponent(book.id) +
                              "/edit?returnTo=metadata-quality&issue=" +
                              encodeURIComponent(
                                book.issues.find(
                                  (issue) => issue !== "POSSIBLE_DUPLICATE",
                                ) ?? book.issues[0],
                              )
                            }
                          >
                            {book.issues.includes("MISSING_TITLE")
                              ? t("metadataQuality.repairMetadata")
                              : t("metadataQuality.editMetadata")}
                          </Link>
                        ) : null}
                        {book.issues.includes("POSSIBLE_DUPLICATE") ? (
                          <Link
                            className="inline-flex min-h-12 items-center rounded-control border border-border bg-white px-3.5 text-sm font-bold text-primary focus-visible:outline-3 focus-visible:outline-primary"
                            href={"/admin/books/" + encodeURIComponent(book.id)}
                          >
                            {t("metadataQuality.compareBooks")}
                          </Link>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>

                <div className="hidden md:block">
                  <ResponsiveTable ariaLabel={t("metadataQuality.tableAria")}>
                    <table className="w-full min-w-[900px] border-collapse text-start text-sm">
                      <thead>
                        <tr className="border-b border-border bg-sky text-primary">
                          <th className="px-3 py-3 font-semibold" scope="col">
                            {t("metadataQuality.columns.book")}
                          </th>
                          <th className="px-3 py-3 font-semibold" scope="col">
                            {t("metadataQuality.columns.author")}
                          </th>
                          <th className="px-3 py-3 font-semibold" scope="col">
                            {t("metadataQuality.columns.grades")}
                          </th>
                          <th className="px-3 py-3 font-semibold" scope="col">
                            {t("metadataQuality.columns.status")}
                          </th>
                          <th className="px-3 py-3 font-semibold" scope="col">
                            {t("metadataQuality.columns.issues")}
                          </th>
                          <th className="px-3 py-3 font-semibold" scope="col">
                            {t("metadataQuality.columns.actions")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {dashboard.items.map((book) => (
                          <tr
                            className="border-b border-border last:border-0"
                            key={book.id}
                          >
                            <td className="px-3 py-4 font-semibold text-ink">
                              {book.title?.trim() ? (
                                <span dir="auto">{book.title}</span>
                              ) : (
                                t("metadataQuality.missingTitleFallback")
                              )}
                            </td>
                            <td className="px-3 py-4 text-muted">
                              {book.author?.trim()
                                ? book.author
                                : t("metadataQuality.authorMissing")}
                            </td>
                            <td className="px-3 py-4 text-muted">
                              {book.min_grade == null || book.max_grade == null
                                ? t("metadataQuality.gradeInvalidShort")
                                : t("metadataQuality.gradeRangeSummary", {
                                    min: book.min_grade,
                                    max: book.max_grade,
                                  })}
                            </td>
                            <td className="px-3 py-4">
                              <span className="inline-flex rounded-full bg-canvas px-3 py-1 font-semibold text-muted">
                                {t(
                                  `metadataQuality.lifecycleLabels.${book.lifecycle_status}`,
                                  undefined,
                                  book.lifecycle_status,
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-4">
                              <div className="flex max-w-sm flex-wrap gap-2">
                                {book.issues.map((issue) => (
                                  <span
                                    className="inline-flex rounded-full bg-warning-surface px-3 py-1 font-semibold text-warning"
                                    key={issue}
                                  >
                                    {t(`metadataQuality.issueLabels.${issue}`)}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="px-3 py-4">
                              <div className="flex flex-wrap gap-x-3 gap-y-1">
                                {book.issues.some(
                                  (issue) => issue !== "POSSIBLE_DUPLICATE",
                                ) ? (
                                  <Link
                                    className="inline-flex min-h-10 items-center rounded-control px-2 font-semibold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
                                    href={
                                      "/admin/books/" +
                                      encodeURIComponent(book.id) +
                                      "/edit?returnTo=metadata-quality&issue=" +
                                      encodeURIComponent(
                                        book.issues.find(
                                          (issue) =>
                                            issue !== "POSSIBLE_DUPLICATE",
                                        ) ?? book.issues[0],
                                      )
                                    }
                                  >
                                    {book.issues.includes("MISSING_TITLE")
                                      ? t("metadataQuality.repairMetadata")
                                      : t("metadataQuality.editMetadata")}
                                  </Link>
                                ) : null}
                                {book.issues.includes("POSSIBLE_DUPLICATE") ? (
                                  <Link
                                    className="inline-flex min-h-10 items-center rounded-control px-2 font-semibold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
                                    href={
                                      "/admin/books/" +
                                      encodeURIComponent(book.id)
                                    }
                                  >
                                    {t("metadataQuality.compareBooks")}
                                  </Link>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ResponsiveTable>
                </div>
              </>
            )}

            <PaginationBar
              ariaLabel={t("metadataQuality.paginationAria")}
              className="mt-5"
              compact
              disabled={loading}
              itemLabel={t("metadataQuality.itemLabel")}
              onPageChange={(nextPage) => setOffset((nextPage - 1) * limit)}
              page={currentPage}
              pageSize={dashboard.limit}
              showSummaryWhenSinglePage
              total={dashboard.total}
            />
            <p className="mt-4 text-xs text-muted">
              {t("metadataQuality.checkedAtLabel", {
                time: formatDateTime(dashboard.summary.checked_at),
              })}{" "}
              {t("metadataQuality.footerNote")}
            </p>
          </section>
        </>
      ) : null}
    </>
  );
}
