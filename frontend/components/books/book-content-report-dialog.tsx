"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { useBookContentReportService } from "@/hooks/use-book-content-report-service";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type {
  BookContentIssueType,
  BookContentReportDetailDTO,
} from "@/types/book-content-quality";

const ISSUE_TYPES: readonly BookContentIssueType[] = [
  "BOOK_METADATA_ERROR",
  "SPELLING_ERROR",
  "MISSING_CONTENT",
  "OCR_MISMATCH",
  "IMAGE_QUALITY_ERROR",
  "DUPLICATE_PAGE",
  "PAGE_ORDER_ERROR",
  "CHILD_SAFETY_CONCERN",
  "COPYRIGHT_CONCERN",
  "OTHER",
];

interface BookContentReportDialogProps {
  bookId: string;
  bookTitle: string;
  pageId: string | null;
  pageNumber: number | null;
  onClose: () => void;
}

export function BookContentReportDialog({
  bookId,
  bookTitle,
  pageId,
  pageNumber,
  onClose,
}: BookContentReportDialogProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("books");
  const reportService = useBookContentReportService();
  const idempotencyKeyRef = useRef<string | null>(null);
  const [issueType, setIssueType] =
    useState<BookContentIssueType>("SPELLING_ERROR");
  const [description, setDescription] = useState("");
  const [reportedText, setReportedText] = useState("");
  const [suggestedCorrection, setSuggestedCorrection] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<BookContentReportDetailDTO | null>(
    null,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || created) return;
    const normalizedDescription = description.trim();
    if (!normalizedDescription) {
      setError(t("reportDialog.missingDescriptionError"));
      return;
    }
    if (!idempotencyKeyRef.current) {
      if (typeof globalThis.crypto?.randomUUID !== "function") {
        setError(t("reportDialog.unsupportedCryptoError"));
        return;
      }
      idempotencyKeyRef.current = globalThis.crypto.randomUUID();
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await reportService.create(bookId, {
        idempotency_key: idempotencyKeyRef.current,
        issue_type: issueType,
        description: normalizedDescription,
        page_id: pageId ?? undefined,
        reported_text: reportedText.trim() || undefined,
        suggested_correction: suggestedCorrection.trim() || undefined,
      });
      setCreated(result);
    } catch {
      setError(t("reportDialog.saveUnconfirmedError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      closeOnBackdropClick={!submitting}
      closeOnEscape={!submitting}
      footer={
        created ? (
          <div className="flex flex-wrap gap-3">
            <Button fullWidth={false} onClick={onClose}>
              {t("reportDialog.done")}
            </Button>
            <Link
              className="inline-flex min-h-12 items-center rounded-control border border-border px-4 font-semibold text-primary hover:bg-canvas"
              href="/book-reports"
            >
              {t("reportDialog.viewMyReports")}
            </Link>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              disabled={submitting}
              fullWidth={false}
              onClick={onClose}
              type="button"
              variant="secondary"
            >
              {t("reportDialog.cancel")}
            </Button>
            <Button
              disabled={submitting || !description.trim()}
              form="book-content-report-form"
              fullWidth={false}
              type="submit"
            >
              {submitting
                ? t("reportDialog.submitting")
                : t("reportDialog.submit")}
            </Button>
          </div>
        )
      }
      isOpen
      onClose={() => {
        if (!submitting) onClose();
      }}
      showCloseButton={!submitting}
      title={pageId ? t("reportDialog.titlePage") : t("reportDialog.titleBook")}
      tone="paper"
    >
      <div className="mb-4">
        <p className="text-sm font-semibold text-primary">
          {t("reportDialog.brandContext")}
        </p>
        <p className="mt-1 break-words text-sm text-muted">
          <span className="viread-learning-content" dir="ltr" lang="vi">
            {bookTitle}
          </span>
          {pageNumber !== null
            ? t("reportDialog.pageSuffix", { page: pageNumber })
            : t("reportDialog.wholeBookSuffix")}
        </p>
      </div>

      {created ? (
        <div className="space-y-4" role="status">
          <div className="rounded-control border border-emerald-200 bg-emerald-50 p-4">
            <p className="font-semibold text-emerald-900">
              {t("reportDialog.savedTitle")}
            </p>
            <p className="mt-1 text-sm text-emerald-800">
              {t("reportDialog.wholeBookFollowup")}
            </p>
          </div>
          <dl className="grid gap-2 rounded-control border border-border p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">{t("reportDialog.reportIdLabel")}</dt>
              <dd className="break-all font-mono font-semibold text-ink">
                {created.id}
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t("reportDialog.statusLabel")}</dt>
              <dd className="font-semibold text-ink">
                {t(
                  `reportDialog.statuses.${created.status}`,
                  undefined,
                  created.status,
                )}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted">
                {t("reportDialog.scanRequestLabel")}
              </dt>
              <dd className="break-all font-mono text-ink">
                {created.scan_run_id ?? t("reportDialog.noScanIdReturned")}
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <form
          className="space-y-4"
          id="book-content-report-form"
          onSubmit={handleSubmit}
        >
          <div>
            <label
              className="mb-2 block text-sm font-semibold text-ink"
              htmlFor="book-report-issue"
            >
              {t("reportDialog.issueTypeLabel")}
            </label>
            <select
              className="min-h-12 w-full rounded-control border border-border bg-white px-3 text-ink focus-visible:outline-3 focus-visible:outline-primary"
              id="book-report-issue"
              onChange={(event) =>
                setIssueType(event.target.value as BookContentIssueType)
              }
              value={issueType}
            >
              {ISSUE_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`reportDialog.issueTypes.${value}`)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              className="mb-2 block text-sm font-semibold text-ink"
              htmlFor="book-report-description"
            >
              {t("reportDialog.descriptionLabel")}{" "}
              <span className="text-danger">*</span>
            </label>
            <textarea
              className="min-h-28 w-full rounded-control border border-border bg-white p-3 text-ink focus-visible:outline-3 focus-visible:outline-primary"
              id="book-report-description"
              maxLength={4000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("reportDialog.descriptionPlaceholder")}
              required
              value={description}
            />
            <p className="mt-1 text-end text-xs text-muted">
              {formatNumber(description.length)}/{formatNumber(4000)}
            </p>
          </div>

          <div>
            <label
              className="mb-2 block text-sm font-semibold text-ink"
              htmlFor="book-report-text"
            >
              {t("reportDialog.suspectedTextLabel")}
            </label>
            <textarea
              className="viread-learning-content min-h-20 w-full rounded-control border border-border bg-white p-3 text-ink focus-visible:outline-3 focus-visible:outline-primary"
              dir="ltr"
              id="book-report-text"
              lang="vi"
              maxLength={1200}
              onChange={(event) => setReportedText(event.target.value)}
              placeholder={t("reportDialog.suspectedTextPlaceholder")}
              value={reportedText}
            />
          </div>

          <div>
            <label
              className="mb-2 block text-sm font-semibold text-ink"
              htmlFor="book-report-correction"
            >
              {t("reportDialog.suggestedTextLabel")}
            </label>
            <textarea
              className="viread-learning-content min-h-20 w-full rounded-control border border-border bg-white p-3 text-ink focus-visible:outline-3 focus-visible:outline-primary"
              dir="ltr"
              id="book-report-correction"
              lang="vi"
              maxLength={1200}
              onChange={(event) => setSuggestedCorrection(event.target.value)}
              placeholder={t("reportDialog.suggestedTextPlaceholder")}
              value={suggestedCorrection}
            />
          </div>

          {error ? (
            <p
              className="rounded-control bg-red-50 p-3 text-sm font-semibold text-danger"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </form>
      )}
    </Modal>
  );
}
