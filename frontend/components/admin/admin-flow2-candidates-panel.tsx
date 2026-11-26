"use client";

import { CheckCircle2, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AuthenticatedImage } from "@/components/common/authenticated-image";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import {
  FLOW2_REJECTION_CODE_LABELS,
  type AdminFlow2CandidateDTO,
  type AdminFlow2CandidatePageDTO,
  type Flow2CandidateStatus,
  type Flow2RejectionCode,
} from "@/types/parent-private-book";

const STATUS_FILTERS: readonly {
  readonly key: "" | Flow2CandidateStatus;
  readonly labelKey: string;
}[] = [
  { key: "", labelKey: "common.all" },
  {
    key: "PENDING_VERIFICATION",
    labelKey: "flow2.filters.PENDING_VERIFICATION",
  },
  { key: "VERIFIED", labelKey: "statusBadges.VERIFIED" },
  { key: "SYNC_QUEUED", labelKey: "flow2.filters.SYNC_QUEUED" },
  { key: "SYNCED", labelKey: "flow2.filters.SYNCED" },
  { key: "REJECTED", labelKey: "flow2.filters.REJECTED" },
  { key: "REVOKED", labelKey: "flow2.filters.REVOKED" },
];

const REJECTION_CODES = Object.keys(
  FLOW2_REJECTION_CODE_LABELS,
) as Flow2RejectionCode[];

export function AdminFlow2CandidatesPanel() {
  const { bookContentQuality } = useAdminServices();
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
  const FLOW2_PAGE_SIZE = 50;
  const [statusFilter, setStatusFilter] = useState<"" | Flow2CandidateStatus>(
    "PENDING_VERIFICATION",
  );
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AdminFlow2CandidatePageDTO | null>(null);
  const [loading, setLoading] = useState(() =>
    Boolean(bookContentQuality.listFlow2Candidates),
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [rejectionCode, setRejectionCode] = useState<Flow2RejectionCode>(
    "LABEL_IMAGE_MISMATCH",
  );
  const [rejectionReason, setRejectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const selected: AdminFlow2CandidateDTO | null =
    page?.items.find((item) => item.id === selectedId) ??
    page?.items[0] ??
    null;

  const selectCandidate = useCallback(
    (item: AdminFlow2CandidateDTO | null) => {
      if (item?.id === selectedId) return;
      setSelectedId(item?.id ?? null);
      if (item) {
        setLabelDraft(item.verified_label ?? item.proposed_label);
        setRejectionReason("");
        setActionError(null);
      }
    },
    [selectedId],
  );

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setReloadKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    const listFn = bookContentQuality.listFlow2Candidates;
    if (!listFn) {
      return;
    }
    let cancelled = false;
    listFn({
      status: statusFilter,
      limit: FLOW2_PAGE_SIZE,
      offset,
    })
      .then((data) => {
        if (cancelled) return;
        if (data.items.length === 0 && offset > 0 && data.total > 0) {
          setOffset(Math.max(0, offset - FLOW2_PAGE_SIZE));
          return;
        }
        setPage(data);
        setSelectedId((prev) => {
          const next =
            (prev ? data.items.find((i) => i.id === prev) : null) ??
            data.items[0] ??
            null;
          if (next) {
            setLabelDraft(next.verified_label ?? next.proposed_label);
            setRejectionReason("");
            setActionError(null);
          }
          return next?.id ?? null;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(isServiceError(err) ? err.message : t("flow2.loadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookContentQuality, offset, statusFilter, reloadKey, t]);

  async function handleApprove() {
    if (!selected || !bookContentQuality.decideFlow2Candidate) return;
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await bookContentQuality.decideFlow2Candidate(selected.id, {
        decision: "APPROVE",
        verified_label: labelDraft.trim(),
      });
      setActionNotice(t("flow2.verifiedNotice"));
      reload();
    } catch (err) {
      setActionError(
        isServiceError(err) ? err.message : t("flow2.verifyError"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!selected || !bookContentQuality.decideFlow2Candidate) return;
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await bookContentQuality.decideFlow2Candidate(selected.id, {
        decision: "REJECT",
        rejection_code: rejectionCode,
        reason:
          rejectionReason.trim() || t(`flow2.rejectionCodes.${rejectionCode}`),
      });
      setActionNotice(t("flow2.rejectedNotice"));
      reload();
    } catch (err) {
      setActionError(
        isServiceError(err) ? err.message : t("flow2.rejectError"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-white p-4">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => {
            const summaryTotal = page
              ? Object.values(page.summary).reduce(
                  (sum, value) => sum + value,
                  0,
                )
              : 0;
            const count =
              f.key === ""
                ? summaryTotal || (statusFilter === "" ? (page?.total ?? 0) : 0)
                : (page?.summary[f.key] ?? 0);
            const active = statusFilter === f.key;
            return (
              <button
                key={f.key || "ALL"}
                className={`rounded-full border px-3 py-1.5 text-xs font-bold transition ${
                  active
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-white text-ink hover:bg-surface-subtle"
                }`}
                onClick={() => {
                  if (active) return;
                  setLoading(Boolean(bookContentQuality.listFlow2Candidates));
                  setError(null);
                  setOffset(0);
                  setStatusFilter(f.key);
                }}
                type="button"
              >
                {t(f.labelKey)} ({formatNumber(count)})
              </button>
            );
          })}
        </div>
        <Button
          className="min-h-9 w-auto px-3 text-xs"
          disabled={loading}
          onClick={reload}
          type="button"
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
          {t("common.refresh")}
        </Button>
      </div>

      <p className="text-xs text-muted">{t("flow2.privacyBanner")}</p>

      {error ? (
        <StatusMessage title={t("flow2.queueErrorTitle")} tone="error">
          {error}
        </StatusMessage>
      ) : null}

      {actionError ? (
        <StatusMessage title={t("flow2.actionErrorTitle")} tone="error">
          {actionError}
        </StatusMessage>
      ) : null}

      {actionNotice ? (
        <StatusMessage title={t("flow2.successTitle")} tone="success">
          {actionNotice}
        </StatusMessage>
      ) : null}

      {loading ? (
        <Skeleton className="h-48 w-full rounded-card" />
      ) : !page || page.items.length === 0 ? (
        <EmptyState
          description={t("flow2.emptyDesc")}
          title={t("flow2.emptyTitle")}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 rounded-card border border-border bg-white p-3 lg:max-h-[600px] lg:overflow-y-auto">
              {page.items.map((item) => {
                const isSelected = selected?.id === item.id;
                return (
                  <button
                    key={item.id}
                    className={`flex flex-col items-start gap-1 rounded-control border p-3 text-start text-xs transition ${
                      isSelected
                        ? "border-primary bg-sky/40"
                        : "border-border bg-white hover:bg-surface-subtle"
                    }`}
                    onClick={() => selectCandidate(item)}
                    type="button"
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="truncate font-extrabold text-ink">
                        {item.book_title}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-muted">
                        {t("flow2.itemTitle", {
                          pageNumber: item.page_number,
                          lineNumber: item.line_index + 1,
                        })}
                      </span>
                    </div>
                    <p
                      className="viread-learning-content line-clamp-2 text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {item.proposed_label}
                    </p>
                    <span className="text-[11px] text-muted">
                      {item.rights_basis_label}
                    </span>
                  </button>
                );
              })}
            </div>
            <PaginationBar
              ariaLabel={t("flow2.paginationAria")}
              compact
              disabled={loading || busy}
              itemLabel={t("flow2.itemLabel")}
              onPageChange={(nextPage) => {
                setLoading(true);
                setOffset((nextPage - 1) * FLOW2_PAGE_SIZE);
              }}
              page={Math.floor(offset / FLOW2_PAGE_SIZE) + 1}
              pageSize={FLOW2_PAGE_SIZE}
              total={page.total}
            />
          </div>

          {selected ? (
            <div className="flex flex-col gap-4 rounded-card border border-border bg-white p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                <div>
                  <h3 className="text-base font-extrabold text-ink">
                    {t("flow2.selectedHeader", {
                      title: selected.book_title,
                      pageNumber: selected.page_number,
                      lineNumber: selected.line_index + 1,
                    })}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted">
                    {t("flow2.rightsMeta", {
                      rights: selected.rights_basis_label,
                      consentVersion: selected.consent_version,
                      sha: selected.image_sha256.slice(0, 12),
                    })}
                  </p>
                </div>
                <span className="rounded-full border border-border bg-surface-subtle px-2.5 py-0.5 text-xs font-bold text-ink">
                  {selected.status_label}
                </span>
              </div>

              {selected.pii_check_status !== "CLEAR" ? (
                <div className="flex items-center gap-2 rounded-control border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900">
                  <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
                  <span>
                    {t("flow2.piiWarning", {
                      flags: selected.pii_flags.join(", "),
                    })}
                  </span>
                </div>
              ) : null}

              <div className="rounded-control border border-border bg-slate-50 p-4">
                <p className="mb-2 text-xs font-bold text-muted">
                  {t("flow2.cropHeading")}
                </p>
                <AuthenticatedImage
                  alt={t("flow2.cropAlt", {
                    lineNumber: selected.line_index + 1,
                    pageNumber: selected.page_number,
                  })}
                  className="max-h-40 w-auto max-w-full rounded border border-border bg-white object-contain"
                  src={selected.crop_image_url}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label
                  className="text-xs font-bold text-ink"
                  htmlFor="flow2-verified-label-input"
                >
                  {t("flow2.labelInputHeading")}
                </label>
                <input
                  id="flow2-verified-label-input"
                  className="viread-learning-content w-full rounded-control border border-border bg-white px-3 py-2 text-sm font-medium text-ink focus:border-primary focus:outline-none"
                  dir="ltr"
                  disabled={busy || selected.status !== "PENDING_VERIFICATION"}
                  lang="vi"
                  onChange={(event) => setLabelDraft(event.target.value)}
                  type="text"
                  value={labelDraft}
                />
                <p className="text-[11px] text-muted">
                  {t("flow2.proposedHint", {
                    proposed: selected.proposed_label,
                  })}
                </p>
              </div>

              {selected.status === "PENDING_VERIFICATION" ? (
                <div className="flex flex-col gap-3 border-t border-border pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      className="min-h-10 w-auto px-4 text-xs"
                      disabled={busy || !labelDraft.trim()}
                      onClick={() => void handleApprove()}
                      type="button"
                    >
                      <CheckCircle2 aria-hidden="true" className="size-4" />
                      {busy
                        ? t("flow2.verifySubmitting")
                        : t("flow2.verifySubmit")}
                    </Button>
                  </div>

                  <div className="flex flex-col gap-2 rounded-control border border-rose-200 bg-rose-50/50 p-3">
                    <p className="text-xs font-bold text-rose-900">
                      {t("flow2.rejectSectionTitle")}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <select
                        aria-label={t("flow2.rejectCodeAria")}
                        className="rounded-control border border-border bg-white px-2.5 py-2 text-xs text-ink"
                        disabled={busy}
                        onChange={(event) =>
                          setRejectionCode(
                            event.target.value as Flow2RejectionCode,
                          )
                        }
                        value={rejectionCode}
                      >
                        {REJECTION_CODES.map((code) => (
                          <option key={code} value={code}>
                            {t(`flow2.rejectionCodes.${code}`)}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={t("flow2.rejectNotesAria")}
                        className="rounded-control border border-border bg-white px-2.5 py-2 text-xs text-ink"
                        disabled={busy}
                        onChange={(event) =>
                          setRejectionReason(event.target.value)
                        }
                        placeholder={t("flow2.rejectNotesPlaceholder")}
                        type="text"
                        value={rejectionReason}
                      />
                    </div>
                    <div>
                      <Button
                        className="min-h-9 w-auto px-3 text-xs"
                        disabled={busy}
                        onClick={() => void handleReject()}
                        type="button"
                        variant="secondary"
                      >
                        <XCircle aria-hidden="true" className="size-3.5" />
                        {t("flow2.rejectSubmit")}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : selected.rejection_reason ? (
                <p className="text-xs text-rose-800">
                  <strong>{t("flow2.rejectionReasonLabel")}</strong>{" "}
                  {selected.rejection_reason}
                </p>
              ) : selected.revoke_reason ? (
                <p className="text-xs text-amber-800">
                  <strong>{t("flow2.revokeReasonLabel")}</strong>{" "}
                  {selected.revoke_reason}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
