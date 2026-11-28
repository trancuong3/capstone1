"use client";

import {
  BookOpen,
  BookPlus,
  CheckCircle2,
  FolderPlus,
  Lock,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n } from "@/hooks/use-i18n";
import { useParentPrivateBookService } from "@/hooks/use-parent-private-book-service";
import { createParentPrivateBookService } from "@/lib/api/parent-private-book-service";
import { isServiceError } from "@/lib/api/service-error";
import { tokenizeScannedTextToWords } from "@/components/reading/instant-scan-readalong-panel";
import { cn } from "@/lib/utils/cn";
import { CHILD_GRADES } from "@/types/child";
import type {
  ParentPrivateBookSummaryDTO,
  SaveScanToMyBooksResponseDTO,
  ScanSaveMode,
} from "@/types/parent-private-book";

export function suggestBookTitleFromScan(
  ocrText: string,
  fallbackDateTitle: string,
): string {
  const normalized = (ocrText ?? "").normalize("NFC").replace(/\r\n?/g, "\n");
  for (const rawLine of normalized.split("\n")) {
    const cleaned = rawLine
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-–—•·.,;:!?"'“”‘’()[\]{}]+|[-–—•·.,;:!?"'“”‘’()[\]{}]+$/g, "")
      .trim();
    if (cleaned.length >= 2) {
      if (cleaned.length > 64) {
        const sliced = cleaned.slice(0, 64);
        const wordBoundary = sliced.lastIndexOf(" ");
        return `${(wordBoundary > 20 ? sliced.slice(0, wordBoundary) : sliced).trim()}…`;
      }
      return cleaned;
    }
  }
  return fallbackDateTitle;
}

export interface SaveScanToMyBooksModalProps {
  readonly open: boolean;
  readonly file: File | null;
  readonly fileName: string;
  readonly ocrText: string;
  readonly ocrWords?: ReadonlyArray<{
    readonly word_index?: number;
    readonly line_index?: number;
    readonly text: string;
    readonly normalized_text?: string;
    readonly bbox?: readonly [number, number, number, number];
    readonly ocr_confidence?: number | null;
  }>;
  readonly defaultGrade?: number;
  readonly onClose: () => void;
  readonly onSaved?: (result: SaveScanToMyBooksResponseDTO) => void;
}

export function SaveScanToMyBooksModal(props: SaveScanToMyBooksModalProps) {
  if (!props.open) return null;
  return <SaveScanToMyBooksModalContent {...props} />;
}

function SaveScanToMyBooksModalContent({
  file,
  fileName,
  ocrText,
  ocrWords,
  defaultGrade = 2,
  onClose,
  onSaved,
}: SaveScanToMyBooksModalProps) {
  const { t, formatNumber, formatDate } = useI18n();
  const privateBookService = useParentPrivateBookService();
  const headingId = useId();

  const fallbackDateLabel = useMemo(() => {
    const formatted = formatDate(new Date(), { fallback: "" });
    return t("scanInstant.saveModal.defaultTitleFallback", {
      date: formatted || new Date().toISOString().slice(0, 10),
    });
  }, [formatDate, t]);

  const suggestedTitle = useMemo(
    () => suggestBookTitleFromScan(ocrText, fallbackDateLabel),
    [fallbackDateLabel, ocrText],
  );

  const [mode, setMode] = useState<ScanSaveMode>("create_book");
  const [title, setTitle] = useState<string>(suggestedTitle);
  const [gradeLevel, setGradeLevel] = useState<number>(
    defaultGrade >= 1 && defaultGrade <= 5 ? defaultGrade : 2,
  );
  const [ownedBooks, setOwnedBooks] = useState<
    readonly ParentPrivateBookSummaryDTO[]
  >([]);
  const [loadingBooks, setLoadingBooks] = useState(true);
  const [targetBookId, setTargetBookId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedResult, setSavedResult] =
    useState<SaveScanToMyBooksResponseDTO | null>(null);

  const wordCount = useMemo(
    () => tokenizeScannedTextToWords(ocrText).length,
    [ocrText],
  );

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void privateBookService
      .list(false, controller.signal)
      .then((items) => {
        if (!active) return;
        const eligible = items.filter(
          (item) =>
            item.lifecycle_status === "ACTIVE" &&
            item.moderation_status === "ACTIVE",
        );
        setOwnedBooks(eligible);
        if (eligible.length > 0) {
          setTargetBookId((current) =>
            current && eligible.some((b) => b.id === current)
              ? current
              : eligible[0]!.id,
          );
        } else {
          setTargetBookId("");
        }
      })
      .catch(() => {
        if (!active) return;
        setOwnedBooks([]);
      })
      .finally(() => {
        if (active) setLoadingBooks(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [privateBookService]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (!file) {
      setErrorMsg(t("scanInstant.saveModal.missingFileError"));
      return;
    }
    if (mode === "append_page" && !targetBookId) {
      setErrorMsg(t("scanInstant.saveModal.emptyBooksNotice"));
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const saveFn =
        privateBookService.saveFromScan?.bind(privateBookService) ??
        createParentPrivateBookService().saveFromScan!;
      const response = await saveFn({
        image: file,
        fileName: fileName || file.name || "scan-page.jpg",
        ocr_text: ocrText,
        mode,
        title: mode === "create_book" ? title.trim() || suggestedTitle : null,
        grade_level: mode === "create_book" ? gradeLevel : null,
        target_book_id: mode === "append_page" ? targetBookId : null,
        words: ocrWords ?? null,
        source_type: "OWNED_PHYSICAL_BOOK",
      });
      setSavedResult(response);
      onSaved?.(response);
    } catch (err) {
      const detail =
        isServiceError(err) && err.message
          ? err.message
          : t("scanInstant.saveModal.saveErrorFallback");
      setErrorMsg(detail);
    } finally {
      setSaving(false);
    }
  };

  const resolvedSavedTitle =
    savedResult?.title ||
    (mode === "append_page"
      ? (ownedBooks.find((b) => b.id === targetBookId)?.title ?? suggestedTitle)
      : title.trim() || suggestedTitle);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/55 p-4 backdrop-blur-[1px]"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) {
          onClose();
        }
      }}
    >
      <div
        aria-labelledby={headingId}
        aria-modal="true"
        className="flex max-h-[92vh] w-full max-w-[540px] flex-col gap-4 overflow-y-auto rounded-card border border-border bg-white p-5 shadow-xl sm:p-6"
        data-testid="save-scan-to-my-books-modal"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
          <div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-900">
              <Lock aria-hidden="true" className="size-3.5" />
              {t("scanInstant.saveModal.privacyBadge")}
            </span>
            <h2
              className="mt-1.5 text-xl font-extrabold text-ink"
              id={headingId}
            >
              {t("scanInstant.saveModal.heading")}
            </h2>
          </div>
          <button
            aria-label={t("scanInstant.saveModal.cancel")}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border bg-white text-ink hover:bg-canvas focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            disabled={saving}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <p className="rounded-xl border border-emerald-200/80 bg-emerald-50/50 px-3.5 py-2.5 text-xs leading-relaxed text-emerald-950">
          {t("scanInstant.saveModal.privacyNotice")}
        </p>

        {savedResult ? (
          <div
            className="flex flex-col gap-4 py-1"
            data-testid="save-scan-success-state"
          >
            <div className="flex items-start gap-3 rounded-2xl border border-emerald-300 bg-emerald-50/80 p-4">
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 size-6 shrink-0 text-emerald-600"
              />
              <div>
                <h3 className="text-base font-extrabold text-emerald-950">
                  {t("scanInstant.saveModal.successTitle")}
                </h3>
                <p className="mt-1 text-sm text-emerald-900">
                  {t("scanInstant.saveModal.successBody", {
                    pageNumber: formatNumber(savedResult.page_number),
                    title: resolvedSavedTitle,
                  })}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
              <ButtonLink
                className="min-h-12 w-full sm:w-auto"
                data-testid="open-saved-scan-book-link"
                href={savedResult.reader_href}
              >
                <BookOpen aria-hidden="true" className="size-5" />
                {t("scanInstant.saveModal.openSavedPageCta", {
                  pageNumber: formatNumber(savedResult.page_number),
                })}
              </ButtonLink>
              <ButtonLink
                className="min-h-12 w-full sm:w-auto"
                href={`/my-books/${encodeURIComponent(savedResult.book_id)}`}
                variant="secondary"
              >
                {t("scanInstant.saveModal.viewInMyBooksCta")}
              </ButtonLink>
              <Button
                className="min-h-12 w-full sm:w-auto"
                onClick={onClose}
                variant="secondary"
              >
                {t("scanInstant.saveModal.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            {/* 1-tap mode switcher */}
            <div
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
              role="tablist"
            >
              <button
                aria-selected={mode === "create_book"}
                className={cn(
                  "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border-2 px-3 py-2 text-sm font-bold transition-colors",
                  mode === "create_book"
                    ? "border-primary bg-sky text-primary"
                    : "border-border bg-white text-ink hover:bg-canvas",
                )}
                data-testid="save-scan-mode-create"
                onClick={() => {
                  setMode("create_book");
                  setErrorMsg(null);
                }}
                role="tab"
                type="button"
              >
                <BookPlus aria-hidden="true" className="size-4" />
                {t("scanInstant.saveModal.modeCreateTab")}
              </button>

              <button
                aria-selected={mode === "append_page"}
                className={cn(
                  "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border-2 px-3 py-2 text-sm font-bold transition-colors",
                  mode === "append_page"
                    ? "border-primary bg-sky text-primary"
                    : "border-border bg-white text-ink hover:bg-canvas",
                )}
                data-testid="save-scan-mode-append"
                onClick={() => {
                  setMode("append_page");
                  setErrorMsg(null);
                }}
                role="tab"
                type="button"
              >
                <FolderPlus aria-hidden="true" className="size-4" />
                {t("scanInstant.saveModal.modeAppendTab")}
              </button>
            </div>

            {mode === "create_book" ? (
              <div className="flex flex-col gap-3.5">
                <div className="flex flex-col gap-1.5">
                  <label
                    className="text-sm font-bold text-ink"
                    htmlFor="scan-save-book-title"
                  >
                    {t("scanInstant.saveModal.bookTitleLabel")}
                  </label>
                  <input
                    className="min-h-12 w-full rounded-control border border-border bg-white px-3.5 text-base text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    data-testid="save-scan-title-input"
                    id="scan-save-book-title"
                    maxLength={200}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t(
                      "scanInstant.saveModal.bookTitlePlaceholder",
                    )}
                    required
                    type="text"
                    value={title}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    className="text-sm font-bold text-ink"
                    htmlFor="scan-save-grade-select"
                  >
                    {t("scanInstant.saveModal.gradeLabel")}
                  </label>
                  <select
                    className="min-h-12 w-full rounded-control border border-border bg-white px-3.5 text-base font-semibold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    data-testid="save-scan-grade-select"
                    id="scan-save-grade-select"
                    onChange={(e) => setGradeLevel(Number(e.target.value))}
                    value={gradeLevel}
                  >
                    {CHILD_GRADES.map((grade) => (
                      <option key={grade} value={grade}>
                        {t("scanInstant.saveModal.gradeOption", { grade })}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <label
                  className="text-sm font-bold text-ink"
                  htmlFor="scan-save-target-book"
                >
                  {t("scanInstant.saveModal.targetBookLabel")}
                </label>
                {loadingBooks ? (
                  <p className="py-2 text-sm text-muted">
                    {t("scanInstant.saveModal.loadingBooks")}
                  </p>
                ) : ownedBooks.length === 0 ? (
                  <StatusMessage title="" tone="info">
                    {t("scanInstant.saveModal.emptyBooksNotice")}
                  </StatusMessage>
                ) : (
                  <select
                    className="min-h-12 w-full rounded-control border border-border bg-white px-3.5 text-base font-semibold text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    data-testid="save-scan-target-book-select"
                    id="scan-save-target-book"
                    onChange={(e) => setTargetBookId(e.target.value)}
                    value={targetBookId}
                  >
                    {ownedBooks.map((book) => (
                      <option key={book.id} value={book.id}>
                        {book.title} (
                        {t("scanInstant.saveModal.targetBookPageCount", {
                          count: formatNumber(book.committed_page_count),
                        })}
                        )
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {file ? (
              <p
                className="rounded-xl border border-border bg-cream/70 px-3.5 py-2.5 text-xs font-semibold text-ink"
                data-testid="save-scan-attached-file-chip"
              >
                {t("scanInstant.saveModal.attachedImageReady", {
                  fileName: fileName || file.name,
                  wordCount: formatNumber(wordCount),
                })}
              </p>
            ) : (
              <StatusMessage title="" tone="error">
                {t("scanInstant.saveModal.missingFileError")}
              </StatusMessage>
            )}

            {errorMsg ? (
              <StatusMessage title="" tone="error">
                {errorMsg}
              </StatusMessage>
            ) : null}

            <div className="flex flex-col-reverse gap-2.5 pt-1 sm:flex-row sm:justify-end">
              <Button
                className="min-h-12 w-full sm:w-auto"
                disabled={saving}
                onClick={onClose}
                type="button"
                variant="secondary"
              >
                {t("scanInstant.saveModal.cancel")}
              </Button>
              <Button
                className="min-h-12 w-full sm:w-auto"
                data-testid="save-scan-submit-btn"
                disabled={
                  saving ||
                  !file ||
                  wordCount === 0 ||
                  (mode === "append_page" &&
                    (loadingBooks || ownedBooks.length === 0 || !targetBookId))
                }
                type="submit"
                variant="primary"
              >
                {saving
                  ? t("scanInstant.saveModal.saving")
                  : mode === "create_book"
                    ? t("scanInstant.saveModal.submitCreate")
                    : t("scanInstant.saveModal.submitAppend")}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
