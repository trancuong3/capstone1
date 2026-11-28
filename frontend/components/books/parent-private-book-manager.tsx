"use client";

import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Clock3,
  FileSearch,
  FileUp,
  Image as ImageIcon,
  Lock,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { SmartOcrBlockReviewLoader } from "@/components/admin/smart-ocr-block-review";
import { BookCover } from "@/components/books/book-cover";
import { BookCoverStudio } from "@/components/books/book-cover-studio";
import { PageIllustrationStudio } from "@/components/books/page-illustration-studio";
import { ParentOcrContributionCard } from "@/components/books/parent-ocr-contribution-card";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { AuthenticatedImage } from "@/components/common/authenticated-image";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { OcrServiceStatusBanner } from "@/components/common/ocr-service-status-banner";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useOcrWorkerStatus } from "@/hooks/use-ocr-worker-status";
import { useParentPrivateBookService } from "@/hooks/use-parent-private-book-service";
import { clearPrivateMediaMemoryCache } from "@/lib/api/api-client";
import { emitStudioTasksChanged } from "@/lib/api/global-tasks-service";
import { isServiceError } from "@/lib/api/service-error";
import { preprocessScanImage } from "@/lib/reading/scan-image-preprocess";
import { CHILD_GRADES } from "@/types/child";
import type { BookPresentationAssetDTO } from "@/types/book-assets";
import type { GlobalTaskStatus } from "@/types/global-tasks";
import {
  SOURCE_USAGE_OPTIONS,
  type ParentPageSubmissionDTO,
  type ParentPrivateBookDetailDTO,
  type ParentPrivatePageDTO,
  type SourceUsageType,
  type SubmissionWorkflowStatus,
  type ToolCheckScopeDTO,
} from "@/types/parent-private-book";

const ACCEPTED_UPLOAD_EXTENSIONS =
  ".jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff,.pdf,.docx,image/jpeg,image/png,image/webp,image/bmp,image/tiff,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const WORKFLOW_BADGE_STYLES: Record<SubmissionWorkflowStatus, string> = {
  CHECKING: "border-primary/30 bg-sky text-primary-hover",
  PASSED_READY_TO_ADD: "border-emerald-300 bg-emerald-100 text-emerald-950",
  NEEDS_ADMIN_REVIEW: "border-amber-300 bg-amber-100 text-amber-950",
  CHECK_FAILED: "border-rose-300 bg-rose-100 text-rose-900",
  PENDING_ADMIN: "border-indigo-300 bg-indigo-100 text-indigo-950",
  APPROVED_READY_TO_ADD: "border-emerald-400 bg-emerald-100 text-emerald-950",
  REJECTED: "border-rose-300 bg-rose-100 text-rose-900",
  NEEDS_RECHECK: "border-orange-300 bg-orange-100 text-orange-950",
  ADDED_TO_BOOK: "border-teal-300 bg-teal-100 text-teal-950",
  CANCELLED: "border-slate-300 bg-slate-100 text-slate-700",
};

const STAGE_LABEL_KEYS: Record<string, string> = {
  PENDING: "privateManager.statusLabels.PENDING",
  PENDING_POST_OCR: "privateManager.statusLabels.PENDING_POST_OCR",
  RUNNING: "privateManager.statusLabels.RUNNING",
  COMPLETED: "privateManager.statusLabels.COMPLETED",
  PASSED: "privateManager.statusLabels.PASSED",
  FLAGGED: "privateManager.statusLabels.FLAGGED",
  NO_TEXT_DETECTED: "privateManager.statusLabels.NO_TEXT_DETECTED",
  SKIPPED: "privateManager.statusLabels.SKIPPED",
  FAILED: "privateManager.statusLabels.FAILED",
};

function mapSubmissionStatusToGlobalTaskStatus(
  status: SubmissionWorkflowStatus | undefined,
): GlobalTaskStatus | undefined {
  switch (status) {
    case "PASSED_READY_TO_ADD":
    case "APPROVED_READY_TO_ADD":
    case "ADDED_TO_BOOK":
      return "SUCCEEDED";
    case "NEEDS_ADMIN_REVIEW":
    case "PENDING_ADMIN":
    case "NEEDS_RECHECK":
      return "WAITING_FOR_REVIEW";
    case "CHECK_FAILED":
    case "REJECTED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    case "CHECKING":
      return "RUNNING";
    default:
      return undefined;
  }
}

function generateClientKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `upload-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function errorText(error: unknown, fallback: string): string {
  if (isServiceError(error) && error.message) {
    return error.message;
  }
  return fallback;
}

const VALID_SOURCE_TYPES = new Set<string>(
  SOURCE_USAGE_OPTIONS.map((opt) => opt.value),
);

function parseBookSourceDeclaration(raw: string | null): {
  sourceType: SourceUsageType;
  sourceNote: string;
} {
  const cleaned = (raw ?? "").trim();
  if (!cleaned) {
    return { sourceType: "OWNED_PHYSICAL_BOOK", sourceNote: "" };
  }
  if (cleaned.startsWith("[") && cleaned.includes("]")) {
    const closeIdx = cleaned.indexOf("]");
    const tag = cleaned.slice(1, closeIdx).trim();
    const rest = cleaned.slice(closeIdx + 1).trim();
    if (VALID_SOURCE_TYPES.has(tag)) {
      return { sourceType: tag as SourceUsageType, sourceNote: rest };
    }
  }
  return { sourceType: "OWNED_PHYSICAL_BOOK", sourceNote: cleaned };
}

type BooksTranslateFn = ReturnType<typeof useTranslations>;

function stageStatusLabel(
  status: string,
  stage: "ocr" | "post_ocr",
  t: BooksTranslateFn,
): string {
  if (stage === "post_ocr" && status === "PENDING") {
    return t("privateManager.statusLabels.PENDING_POST_OCR");
  }
  return STAGE_LABEL_KEYS[status] ? t(STAGE_LABEL_KEYS[status]) : status;
}

function parentNoticeMeta(
  sub: ParentPageSubmissionDTO,
  t: BooksTranslateFn,
): { className: string; title: string } {
  if (sub.workflow_status === "CHECK_FAILED") {
    return {
      className: "border-rose-300 bg-rose-50 text-rose-950",
      title: t("privateManager.toolCheckFailedNotice"),
    };
  }
  if (sub.workflow_status === "REJECTED") {
    return {
      className: "border-rose-300 bg-rose-50 text-rose-950",
      title: t("privateManager.toolCheckRejectedNotice"),
    };
  }
  if (
    sub.workflow_status === "PASSED_READY_TO_ADD" ||
    sub.workflow_status === "APPROVED_READY_TO_ADD" ||
    sub.workflow_status === "ADDED_TO_BOOK"
  ) {
    return {
      className: "border-emerald-300 bg-emerald-50 text-emerald-950",
      title: t("privateManager.toolCheckPassedNotice"),
    };
  }
  if (sub.workflow_status === "CHECKING") {
    return {
      className: "border-primary/30 bg-sky text-primary-hover",
      title: t("privateManager.toolCheckCheckingNotice"),
    };
  }
  if (sub.workflow_status === "NEEDS_RECHECK") {
    return {
      className: "border-orange-300 bg-orange-50 text-orange-950",
      title: t("privateManager.toolCheckRecheckNotice"),
    };
  }
  if (sub.tool_check_findings_count > 0) {
    return {
      className: "border-amber-300 bg-amber-50 text-amber-950",
      title: t("privateManager.toolCheckFlaggedNotice", {
        count: sub.tool_check_findings_count,
      }),
    };
  }
  return {
    className: "border-amber-300 bg-amber-50 text-amber-950",
    title: t("privateManager.toolCheckAdminNotice"),
  };
}

function describeToolCheckScope(
  scope: ToolCheckScopeDTO,
  t: BooksTranslateFn,
): string {
  const parts: string[] = [];
  if (scope.modality === "TEXT_ONLY") {
    parts.push(t("privateManager.toolScopeBase"));
  } else {
    parts.push(t("privateManager.toolScopeModality"));
  }
  if (scope.local_ai_enforced) {
    parts.push(t("privateManager.toolScopeLocalModel"));
  } else {
    parts.push(t("privateManager.toolScopeCloudAi"));
  }
  if (!scope.image_visual_safety_checked) {
    parts.push(t("privateManager.toolScopeNoImage"));
  }
  if (scope.copyright_scanner_status === "NOT_CONFIGURED") {
    parts.push(t("privateManager.toolScopeNoCopyright"));
  }
  return `${parts.join("; ")}.`;
}

function lockReasonForSubmission(
  sub: ParentPageSubmissionDTO,
  t: BooksTranslateFn,
  ocrWorkerOffline = false,
): string | null {
  if (sub.can_add_to_book) return null;
  if (sub.workflow_status === "ADDED_TO_BOOK") {
    return t("privateManager.reasonAdded");
  }
  if (sub.tool_check_policy_blocked) {
    return t("privateManager.reasonBlocked");
  }
  if (sub.workflow_status === "CHECKING") {
    if (ocrWorkerOffline && sub.ocr_status === "PENDING") {
      return t("privateManager.reasonQueuedOffline");
    }
    return t("privateManager.reasonChecking");
  }
  if (sub.workflow_status === "NEEDS_ADMIN_REVIEW") {
    return t("privateManager.reasonNeedsAdminReview");
  }
  if (sub.workflow_status === "PENDING_ADMIN") {
    return t("privateManager.reasonPendingAdmin");
  }
  if (sub.workflow_status === "REJECTED") {
    return t("privateManager.reasonRejected");
  }
  if (sub.workflow_status === "CHECK_FAILED") {
    return t("privateManager.reasonCheckFailed");
  }
  if (sub.workflow_status === "NEEDS_RECHECK") {
    return t("privateManager.reasonNeedsRecheck");
  }
  if (sub.proofread_suggestions.length > 0 && !sub.spelling_accepted) {
    return t("privateManager.reasonNeedProofreadAccept");
  }
  return t("privateManager.reasonFallback");
}

type SubmissionFilterGroup =
  "ALL" | "CHECKING" | "READY" | "ADMIN" | "FAILED" | "ADDED";

function submissionFilterGroup(
  sub: ParentPageSubmissionDTO,
): Exclude<SubmissionFilterGroup, "ALL"> {
  if (sub.workflow_status === "ADDED_TO_BOOK") return "ADDED";
  if (sub.workflow_status === "CHECKING") return "CHECKING";
  if (
    sub.workflow_status === "CHECK_FAILED" ||
    sub.workflow_status === "REJECTED" ||
    sub.workflow_status === "NEEDS_RECHECK"
  ) {
    return "FAILED";
  }
  if (
    sub.workflow_status === "NEEDS_ADMIN_REVIEW" ||
    sub.workflow_status === "PENDING_ADMIN"
  ) {
    return "ADMIN";
  }
  if (sub.can_add_to_book || sub.workflow_status === "PASSED_READY_TO_ADD") {
    return "READY";
  }
  return "CHECKING";
}

function describeStageErrorHint(
  code: string | null | undefined,
  t: BooksTranslateFn,
): string | null {
  if (!code) return null;
  const upper = code.toUpperCase();
  if (upper.includes("TIMEOUT")) {
    return t("privateManager.workerErrorTimeout");
  }
  if (
    upper.includes("UNAVAILABLE") ||
    upper.includes("OFFLINE") ||
    upper.includes("CONNECT") ||
    upper.includes("WORKER")
  ) {
    return t("privateManager.workerErrorPaused");
  }
  if (
    upper.includes("BUSY") ||
    upper.includes("RATE") ||
    upper.includes("429") ||
    upper.includes("QUOTA") ||
    upper.includes("ALL_PROVIDERS_SKIPPED")
  ) {
    return t("privateManager.workerErrorOverloaded");
  }
  if (upper.includes("OCR")) {
    return t("privateManager.workerErrorNoText");
  }
  return null;
}

const OVERVIEW_CHIPS_PAGE_SIZE = 16;
const SUBMISSIONS_PAGE_SIZE = 10;
const COMMITTED_PAGES_PAGE_SIZE = 12;

function isStageDone(status: string): boolean {
  return (
    status === "COMPLETED" ||
    status === "PASSED" ||
    status === "FLAGGED" ||
    status === "NO_TEXT_DETECTED" ||
    status === "SKIPPED"
  );
}

function SubmissionCheckingProgressBar({
  submission,
  isQueuedOffline,
}: {
  submission: ParentPageSubmissionDTO;
  isQueuedOffline: boolean;
}) {
  const tCommon = useTranslations("common");
  const isChecking = submission.workflow_status === "CHECKING";

  const derivedPercent = useMemo(() => {
    if (!isChecking) return null;
    if (isQueuedOffline) return 2;
    if (
      typeof submission.progress_pct === "number" &&
      Number.isFinite(submission.progress_pct)
    ) {
      return submission.progress_pct;
    }
    if (!isStageDone(submission.ocr_status)) {
      return submission.ocr_status === "RUNNING" ? 22 : 10;
    }
    if (!isStageDone(submission.proofread_status)) {
      return submission.proofread_status === "RUNNING" ? 54 : 38;
    }
    if (!isStageDone(submission.tool_check_status)) {
      return submission.tool_check_status === "RUNNING" ? 82 : 70;
    }
    return 94;
  }, [
    isChecking,
    isQueuedOffline,
    submission.ocr_status,
    submission.progress_pct,
    submission.proofread_status,
    submission.tool_check_status,
  ]);

  const stageLabel = isQueuedOffline
    ? tCommon("aiProgress.waitingWorker")
    : !isStageDone(submission.ocr_status)
      ? tCommon("aiProgress.ocrExtracting")
      : !isStageDone(submission.proofread_status)
        ? tCommon("aiProgress.proofreading")
        : tCommon("aiProgress.safetyChecking");

  const progress = useAiProgress({
    active: isChecking,
    realPercent: derivedPercent,
    progressMode: isQueuedOffline ? "measured" : "staged",
    expectedDurationMs: 16_000,
  });

  if (!isChecking) return null;

  return (
    <AiProgressBar
      active={!isQueuedOffline}
      elapsedSeconds={isQueuedOffline ? undefined : progress.elapsedSeconds}
      label={stageLabel}
      percent={progress.percent}
      size="sm"
      testId={`submission-progress-${submission.id}`}
      tone={isQueuedOffline ? "warning" : "primary"}
    />
  );
}

interface ParentPrivateBookManagerProps {
  bookId: string;
  returnPage?: number;
}

export function ParentPrivateBookManager({
  bookId,
  returnPage = 1,
}: ParentPrivateBookManagerProps) {
  const authRuntime = useAuthRuntime();
  const currentUserId = authRuntime.session?.user?.id ?? "";
  return (
    <ParentPrivateBookManagerContent
      key={`${currentUserId}:${bookId}`}
      bookId={bookId}
      currentUserId={currentUserId}
      returnPage={returnPage}
    />
  );
}

function ParentPrivateBookManagerContent({
  bookId,
  currentUserId,
  returnPage = 1,
}: ParentPrivateBookManagerProps & { currentUserId: string }) {
  const { formatNumber } = useI18n();
  const t = useTranslations("books");
  const tCommon = useTranslations("common");
  const service = useParentPrivateBookService();
  const taskCenter = useOptionalAiTaskCenter();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const detailRequestIdRef = useRef(0);
  const backHref =
    returnPage > 1 ? `/my-books?page=${Math.floor(returnPage)}` : "/my-books";

  const [detail, setDetail] = useState<ParentPrivateBookDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] =
    useState<SubmissionFilterGroup>("ALL");
  const [overviewPage, setOverviewPage] = useState(1);
  const [submissionsPage, setSubmissionsPage] = useState(1);
  const [committedPage, setCommittedPage] = useState(1);

  // Upload form state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadIdempotencyKey, setUploadIdempotencyKey] = useState<string>(() =>
    generateClientKey(),
  );
  const [uploadSourceType, setUploadSourceType] = useState<SourceUsageType>(
    "OWNED_PHYSICAL_BOOK",
  );
  const [uploadSourceNote, setUploadSourceNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const uploadProgressStages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.preparing") },
      { atPct: 24, label: tCommon("aiProgress.uploading") },
      { atPct: 62, label: tCommon("aiProgress.ocrExtracting") },
      { atPct: 86, label: tCommon("aiProgress.finalizing") },
    ],
    [tCommon],
  );
  const uploadProgress = useAiProgress({
    active: uploading,
    stages: uploadProgressStages,
    expectedDurationMs: 12_000,
  });

  // Per-submission UI state
  const [editingSubId, setEditingSubId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editSourceType, setEditSourceType] = useState<SourceUsageType>(
    "OWNED_PHYSICAL_BOOK",
  );
  const [editSourceNote, setEditSourceNote] = useState("");

  const [reviewFormSubId, setReviewFormSubId] = useState<string | null>(null);
  const [reviewSourceType, setReviewSourceType] = useState<SourceUsageType>(
    "OWNED_PHYSICAL_BOOK",
  );
  const [reviewSourceNote, setReviewSourceNote] = useState("");
  const [reviewRequestNote, setReviewRequestNote] = useState("");

  // Book Edit, Cover Studio & Delete state
  const [showCoverStudio, setShowCoverStudio] = useState(false);
  const [activeCoverAsset, setActiveCoverAsset] =
    useState<BookPresentationAssetDTO | null>(null);
  const [showEditBookForm, setShowEditBookForm] = useState(false);
  const [editBookTitle, setEditBookTitle] = useState("");
  const [editBookAuthor, setEditBookAuthor] = useState("");
  const [editBookMinGrade, setEditBookMinGrade] = useState<number>(1);
  const [editBookMaxGrade, setEditBookMaxGrade] = useState<number>(3);
  const [editBookSourceType, setEditBookSourceType] = useState<SourceUsageType>(
    "OWNED_PHYSICAL_BOOK",
  );
  const [editBookSourceNote, setEditBookSourceNote] = useState("");
  const [confirmDeleteBook, setConfirmDeleteBook] = useState(false);

  // Committed Page Edit & Delete state
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editPageText, setEditPageText] = useState("");
  const [editPageNumber, setEditPageNumber] = useState<number>(1);
  const [editPageSourceType, setEditPageSourceType] = useState<SourceUsageType>(
    "OWNED_PHYSICAL_BOOK",
  );
  const [editPageSourceNote, setEditPageSourceNote] = useState("");
  const [confirmDeletePageId, setConfirmDeletePageId] = useState<string | null>(
    null,
  );
  const [illustrationStudioPageId, setIllustrationStudioPageId] = useState<
    string | null
  >(null);
  const [smartOcrPageId, setSmartOcrPageId] = useState<string | null>(null);

  const loadDetail = useCallback(
    async (silent = false) => {
      const requestId = ++detailRequestIdRef.current;
      if (!silent) {
        setLoading(true);
      }
      setLoadError(null);
      setNotFound(false);
      try {
        const data = await service.get(bookId);
        if (requestId !== detailRequestIdRef.current) return;
        setDetail(data);
      } catch (error) {
        if (requestId !== detailRequestIdRef.current) return;
        if (isServiceError(error) && error.status === 404) {
          setDetail(null);
          setNotFound(true);
        } else {
          setLoadError(errorText(error, t("privateManager.loadErrorFallback")));
        }
      } finally {
        if (!silent && requestId === detailRequestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [bookId, service, t],
  );

  useEffect(() => {
    clearPrivateMediaMemoryCache();
    const requestId = ++detailRequestIdRef.current;
    const controller = new AbortController();
    void service
      .get(bookId, controller.signal)
      .then((data) => {
        if (requestId !== detailRequestIdRef.current) return;
        setDetail(data);
        setNotFound(false);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          requestId !== detailRequestIdRef.current
        ) {
          return;
        }
        if (isServiceError(error) && error.status === 404) {
          setDetail(null);
          setNotFound(true);
        } else {
          setLoadError(errorText(error, t("privateManager.loadErrorFallback")));
        }
      })
      .finally(() => {
        if (requestId === detailRequestIdRef.current) setLoading(false);
      });
    return () => {
      detailRequestIdRef.current += 1;
      controller.abort();
    };
  }, [bookId, currentUserId, service, t]);

  const ocrWorker = useOcrWorkerStatus({
    onRecovered: () => {
      void loadDetail(true);
    },
  });
  const ocrWorkerOffline = ocrWorker.isUnavailable;

  // Auto-poll while any submission is CHECKING with exponential backoff (3s -> 15s),
  // in-flight overlap guard, tab-visibility pause, and gentle >=12s cadence when OCR is offline.
  const hasCheckingSubmission = Boolean(
    detail?.submissions.some((sub) => sub.workflow_status === "CHECKING"),
  );
  const pollInFlightRef = useRef(false);
  const workerOfflineRef = useRef<boolean>(ocrWorkerOffline);
  useEffect(() => {
    workerOfflineRef.current = ocrWorkerOffline;
  }, [ocrWorkerOffline]);

  useEffect(() => {
    if (!hasCheckingSubmission || ocrWorker.isChecking) return;
    let active = true;
    let timerId: number | null = null;
    let idleTicks = 0;
    const ONLINE_BASE_POLL_MS = 3_000;
    const ONLINE_MAX_POLL_MS = 6_000;
    const OFFLINE_MIN_POLL_MS = 12_000;
    const OFFLINE_MAX_POLL_MS = 15_000;

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    const nextDelayMs = () => {
      if (workerOfflineRef.current) {
        // Gentle 12-15s cadence while laptop OCR worker is offline to protect Render DB.
        return idleTicks <= 1 ? OFFLINE_MIN_POLL_MS : OFFLINE_MAX_POLL_MS;
      }
      const step = Math.min(2, idleTicks);
      return Math.min(
        ONLINE_MAX_POLL_MS,
        Math.round(ONLINE_BASE_POLL_MS * Math.pow(1.35, step)),
      );
    };

    const scheduleNext = (delayMs: number) => {
      clearTimer();
      if (!active) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      timerId = window.setTimeout(() => {
        void runTick();
      }, delayMs);
    };

    const runTick = async () => {
      if (!active) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      if (pollInFlightRef.current) {
        scheduleNext(nextDelayMs());
        return;
      }
      pollInFlightRef.current = true;
      try {
        await loadDetail(true);
        idleTicks += 1;
      } finally {
        pollInFlightRef.current = false;
      }
      scheduleNext(nextDelayMs());
    };

    const onVisibilityChange = () => {
      if (!active) return;
      if (document.visibilityState === "hidden") {
        clearTimer();
      } else {
        idleTicks = 0;
        scheduleNext(300);
      }
    };

    scheduleNext(
      workerOfflineRef.current ? OFFLINE_MIN_POLL_MS : ONLINE_BASE_POLL_MS,
    );
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      active = false;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [hasCheckingSubmission, loadDetail, ocrWorker.isChecking]);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setActionNotice(null);
    if (!selectedFile) {
      setActionError(t("privateManager.selectFileRequired"));
      return;
    }

    setUploading(true);
    try {
      const prepared = await preprocessScanImage(selectedFile);
      const response = await service.submitPages(bookId, {
        file: prepared.file,
        idempotency_key: uploadIdempotencyKey,
        source_type: uploadSourceType,
        source_note: uploadSourceNote.trim() || null,
      });
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setUploadIdempotencyKey(generateClientKey());
      setActionNotice(
        ocrWorkerOffline
          ? t("privateManager.uploadQueuedOfflineNotice", {
              total: response.total_pages,
              format: response.source_format,
            })
          : t("privateManager.uploadAcceptedNotice", {
              total: response.total_pages,
              format: response.source_format,
            }),
      );
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, t("privateManager.uploadFailedFallback")),
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleAcceptSpelling(sub: ParentPageSubmissionDTO) {
    if (!sub.candidate_hash) return;
    setBusyKey(`spell:${sub.id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const updated = await service.acceptSpelling(
        bookId,
        sub.id,
        sub.submission_version,
        sub.candidate_hash,
      );
      setActionNotice(
        t("privateManager.proofreadAcceptedNotice", {
          page: sub.source_page_number,
        }),
      );
      taskCenter?.markTaskAlertSeen(sub.id, {
        includeNextSync: true,
        optimisticTask: updated?.updated_at
          ? {
              source: "parent_submission",
              status: mapSubmissionStatusToGlobalTaskStatus(
                updated.workflow_status,
              ),
              updated_at: updated.updated_at,
            }
          : undefined,
      });
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, t("privateManager.proofreadAcceptErrorFallback")),
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleAddPage(sub: ParentPageSubmissionDTO) {
    if (!sub.can_add_to_book || !sub.candidate_hash) return;
    setBusyKey(`add:${sub.id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const result = await service.addPage(bookId, sub.id, {
        expected_submission_version: sub.submission_version,
        expected_candidate_hash: sub.candidate_hash,
        accept_spelling: true,
      });
      setActionNotice(
        result.book_readable_for_children
          ? t("privateManager.committedReadableNotice", {
              page: result.page_number,
            })
          : t("privateManager.committedHoldNotice", {
              page: result.page_number,
            }),
      );
      taskCenter?.markTaskAlertSeen(sub.id, {
        includeNextSync: true,
        optimisticTask: result.submission?.updated_at
          ? {
              source: "parent_submission",
              status:
                mapSubmissionStatusToGlobalTaskStatus(
                  result.submission.workflow_status,
                ) ?? "SUCCEEDED",
              updated_at: result.submission.updated_at,
              completed_at: result.submission.updated_at,
            }
          : undefined,
      });
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(errorText(error, t("privateManager.commitErrorFallback")));
      await loadDetail(true);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRequestAdminReview(sub: ParentPageSubmissionDTO) {
    if (!sub.candidate_hash) return;
    setBusyKey(`review:${sub.id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const updated = await service.requestAdminReview(bookId, sub.id, {
        expected_submission_version: sub.submission_version,
        expected_candidate_hash: sub.candidate_hash,
        source_type: reviewSourceType,
        source_note: reviewSourceNote.trim() || null,
        request_note: reviewRequestNote.trim() || null,
      });
      setReviewFormSubId(null);
      setReviewRequestNote("");
      setActionNotice(
        t("privateManager.submittedAdminNotice", {
          version: sub.submission_version,
        }),
      );
      taskCenter?.markTaskAlertSeen(sub.id, {
        includeNextSync: true,
        optimisticTask: updated?.updated_at
          ? {
              source: "parent_submission",
              status:
                mapSubmissionStatusToGlobalTaskStatus(
                  updated.workflow_status,
                ) ?? "WAITING_FOR_REVIEW",
              updated_at: updated.updated_at,
            }
          : undefined,
      });
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, t("privateManager.submitAdminErrorFallback")),
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRetry(sub: ParentPageSubmissionDTO) {
    setBusyKey(`retry:${sub.id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await service.retrySubmission(bookId, sub.id, "AUTO");
      setActionNotice(
        ocrWorkerOffline
          ? t("privateManager.retriedQueuedOfflineNotice")
          : t("privateManager.retriedNotice"),
      );
      taskCenter?.markTaskAlertSeen(sub.id);
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(errorText(error, t("privateManager.retryErrorFallback")));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSaveEdit(sub: ParentPageSubmissionDTO) {
    setBusyKey(`edit:${sub.id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const updated = await service.editSubmission(bookId, sub.id, {
        candidate_text: editText,
        source_type: editSourceType,
        source_note: editSourceNote.trim() || null,
        expected_lock_version: sub.optimistic_lock_version,
        auto_recheck: true,
      });
      setEditingSubId(null);
      setActionNotice(t("privateManager.editedSubmissionNotice"));
      taskCenter?.markTaskAlertSeen(
        sub.id,
        updated?.workflow_status === "CHECKING"
          ? undefined
          : {
              includeNextSync: true,
              optimisticTask: updated?.updated_at
                ? {
                    source: "parent_submission",
                    status: mapSubmissionStatusToGlobalTaskStatus(
                      updated.workflow_status,
                    ),
                    updated_at: updated.updated_at,
                  }
                : undefined,
            },
      );
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, t("privateManager.editSubmissionErrorFallback")),
      );
    } finally {
      setBusyKey(null);
    }
  }

  function openEditBookForm() {
    if (!detail) return;
    const parsed = parseBookSourceDeclaration(detail.book.source_declaration);
    setConfirmDeleteBook(false);
    setEditBookTitle(detail.book.title);
    setEditBookAuthor(detail.book.author ?? "");
    setEditBookMinGrade(detail.book.min_grade);
    setEditBookMaxGrade(detail.book.max_grade);
    setEditBookSourceType(parsed.sourceType);
    setEditBookSourceNote(parsed.sourceNote);
    setShowEditBookForm(true);
    setActionError(null);
    setActionNotice(null);
  }

  async function handleSaveBookEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setActionNotice(null);
    const trimmedTitle = editBookTitle.trim();
    if (!trimmedTitle) {
      setActionError(t("myBooks.validationTitleEmpty"));
      return;
    }
    if (editBookMinGrade > editBookMaxGrade) {
      setActionError(t("myBooks.validationGradeOrder"));
      return;
    }
    setBusyKey("book:edit");
    try {
      const updated = await service.update(bookId, {
        title: trimmedTitle,
        author: editBookAuthor.trim() || null,
        min_grade: editBookMinGrade,
        max_grade: editBookMaxGrade,
        source_type: editBookSourceType,
        source_note: editBookSourceNote.trim() || null,
      });
      setShowEditBookForm(false);
      setActionNotice(
        updated.pending_submission_count > 0
          ? t("myBooks.updatedRecheckNotice", {
              title: updated.title,
              count: updated.pending_submission_count,
            })
          : t("myBooks.updatedNotice", { title: updated.title }),
      );
      if (updated.pending_submission_count > 0) {
        taskCenter?.markTargetAlertsSeen({ bookId });
        emitStudioTasksChanged({ portal: "parent" });
      }
      await loadDetail(true);
    } catch (error) {
      setActionError(errorText(error, t("myBooks.updateErrorFallback")));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteBook() {
    setBusyKey("book:delete");
    setActionError(null);
    setActionNotice(null);
    try {
      await service.delete(bookId);
      taskCenter?.markTargetAlertsSeen({ bookId });
      emitStudioTasksChanged({ portal: "parent" });
      router.push(backHref);
    } catch (error) {
      setActionError(errorText(error, t("myBooks.deleteErrorFallback")));
    } finally {
      setBusyKey(null);
    }
  }

  function startEditCommittedPage(page: ParentPrivatePageDTO) {
    const parsed = parseBookSourceDeclaration(
      detail?.book.source_declaration ?? null,
    );
    setConfirmDeletePageId(null);
    setEditingPageId(page.page_id);
    setEditPageText(page.verified_text || page.verified_text_preview);
    setEditPageNumber(page.page_number);
    setEditPageSourceType(parsed.sourceType);
    setEditPageSourceNote(parsed.sourceNote);
    setActionError(null);
    setActionNotice(null);
  }

  async function handleSaveCommittedPageEdit(page: ParentPrivatePageDTO) {
    setBusyKey(`page-edit:${page.page_id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const updated = await service.editCommittedPage(bookId, page.page_id, {
        candidate_text: editPageText,
        page_number: editPageNumber,
        source_type: editPageSourceType,
        source_note: editPageSourceNote.trim() || null,
        auto_recheck: true,
      });
      setEditingPageId(null);
      setActionNotice(
        t("privateManager.editedPageNotice", { page: page.page_number }),
      );
      taskCenter?.markTargetAlertsSeen({ bookId, bookPageId: page.page_id });
      if (updated?.id) {
        taskCenter?.markTaskAlertSeen(
          updated.id,
          updated.workflow_status === "CHECKING"
            ? undefined
            : {
                includeNextSync: true,
                optimisticTask: updated.updated_at
                  ? {
                      source: "parent_submission",
                      status: mapSubmissionStatusToGlobalTaskStatus(
                        updated.workflow_status,
                      ),
                      updated_at: updated.updated_at,
                    }
                  : undefined,
              },
        );
      }
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, t("privateManager.editPageErrorFallback")),
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleReplaceCommittedPageFile(
    page: ParentPrivatePageDTO,
    file: File,
  ) {
    setBusyKey(`page-replace:${page.page_id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const updated = await service.replaceCommittedPageFile(
        bookId,
        page.page_id,
        file,
      );
      setEditingPageId(null);
      setActionNotice(
        ocrWorkerOffline
          ? t("privateManager.replacedPageImageQueuedOfflineNotice", {
              page: page.page_number,
            })
          : t("privateManager.replacedPageImageNotice", {
              page: page.page_number,
            }),
      );
      taskCenter?.markTargetAlertsSeen({ bookId, bookPageId: page.page_id });
      if (updated?.id) {
        taskCenter?.markTaskAlertSeen(updated.id);
      }
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, t("privateManager.replaceImageErrorFallback")),
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteCommittedPage(page: ParentPrivatePageDTO) {
    setBusyKey(`page-delete:${page.page_id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await service.deleteCommittedPage(bookId, page.page_id);
      setConfirmDeletePageId(null);
      if (editingPageId === page.page_id) {
        setEditingPageId(null);
      }
      setActionNotice(
        t("privateManager.deletedPageNotice", { page: page.page_number }),
      );
      taskCenter?.markTargetAlertsSeen({ bookId, bookPageId: page.page_id });
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, t("privateManager.deletePageErrorFallback")),
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleReplaceFile(sub: ParentPageSubmissionDTO, file: File) {
    setBusyKey(`replace:${sub.id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const prepared = await preprocessScanImage(file);
      await service.replaceSubmissionFile(
        bookId,
        sub.id,
        prepared.file,
        sub.source_type,
        sub.source_note,
      );
      setActionNotice(
        ocrWorkerOffline
          ? t("privateManager.replacedSubmissionImageQueuedOfflineNotice")
          : t("privateManager.replacedSubmissionImageNotice"),
      );
      taskCenter?.markTaskAlertSeen(sub.id);
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(
          error,
          t("privateManager.replaceSubmissionImageErrorFallback"),
        ),
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCancelSubmission(sub: ParentPageSubmissionDTO) {
    setBusyKey(`cancel:${sub.id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await service.cancelSubmission(bookId, sub.id);
      setActionNotice(t("privateManager.cancelledSubmissionNotice"));
      taskCenter?.markTaskAlertSeen(sub.id);
      emitStudioTasksChanged({ portal: "parent" });
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, t("privateManager.cancelSubmissionErrorFallback")),
      );
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) {
    return (
      <section
        aria-busy="true"
        className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 py-6 sm:px-8"
      >
        <Skeleton className="h-12 w-72 rounded-card" />
        <Skeleton className="h-44 w-full rounded-card" />
        <Skeleton className="h-64 w-full rounded-card" />
      </section>
    );
  }

  if (notFound) {
    return (
      <section className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-10">
        <EmptyState
          action={
            <ButtonLink
              href={backHref}
              variant="secondary"
              className="max-w-64"
            >
              <ArrowLeft
                aria-hidden="true"
                className="viread-rtl-flip size-4"
              />
              {t("privateManager.backToMyBooks")}
            </ButtonLink>
          }
          description={t("privateManager.notFoundDescription")}
          title={t("privateManager.notFoundTitle")}
        />
      </section>
    );
  }

  if (loadError || !detail) {
    return (
      <section className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-10">
        <StatusMessage title={t("privateManager.loadErrorTitle")} tone="error">
          {loadError ?? t("privateManager.loadDataFallback")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start"
          onClick={() => void loadDetail(false)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {t("catalog.retry")}
        </Button>
      </section>
    );
  }

  const { book, pages: committedPages, submissions } = detail;
  const isSuspended = book.moderation_status === "SUSPENDED";
  const activeSubmissions = submissions.filter(
    (item) => item.workflow_status !== "CANCELLED",
  );
  const submissionCounts = activeSubmissions.reduce(
    (acc, item) => {
      const group = submissionFilterGroup(item);
      acc[group] += 1;
      return acc;
    },
    { CHECKING: 0, READY: 0, ADMIN: 0, FAILED: 0, ADDED: 0 },
  );
  const pendingOcrCount = activeSubmissions.filter(
    (item) =>
      item.workflow_status === "CHECKING" && item.ocr_status === "PENDING",
  ).length;
  const runningOcrCount = activeSubmissions.filter(
    (item) =>
      item.workflow_status === "CHECKING" && item.ocr_status === "RUNNING",
  ).length;
  const workerFailureCount = activeSubmissions.filter(
    (item) =>
      Boolean(item.ocr_error_code) ||
      Boolean(item.proofread_error_code) ||
      Boolean(item.tool_check_error_code) ||
      item.workflow_status === "CHECK_FAILED",
  ).length;
  const filteredSubmissions =
    statusFilter === "ALL"
      ? activeSubmissions
      : activeSubmissions.filter(
          (item) => submissionFilterGroup(item) === statusFilter,
        );
  const overviewTotalPages = Math.max(
    1,
    Math.ceil(activeSubmissions.length / OVERVIEW_CHIPS_PAGE_SIZE),
  );
  const safeOverviewPage = Math.min(
    Math.max(1, overviewPage),
    overviewTotalPages,
  );
  const overviewStartIndex = (safeOverviewPage - 1) * OVERVIEW_CHIPS_PAGE_SIZE;
  const visibleOverviewSubmissions = activeSubmissions.slice(
    overviewStartIndex,
    overviewStartIndex + OVERVIEW_CHIPS_PAGE_SIZE,
  );
  const submissionsTotalPages = Math.max(
    1,
    Math.ceil(filteredSubmissions.length / SUBMISSIONS_PAGE_SIZE),
  );
  const safeSubmissionsPage = Math.min(
    Math.max(1, submissionsPage),
    submissionsTotalPages,
  );
  const visibleSubmissions = filteredSubmissions.slice(
    (safeSubmissionsPage - 1) * SUBMISSIONS_PAGE_SIZE,
    safeSubmissionsPage * SUBMISSIONS_PAGE_SIZE,
  );
  const committedTotalPages = Math.max(
    1,
    Math.ceil(committedPages.length / COMMITTED_PAGES_PAGE_SIZE),
  );
  const safeCommittedPage = Math.min(
    Math.max(1, committedPage),
    committedTotalPages,
  );
  const visibleCommittedPages = committedPages.slice(
    (safeCommittedPage - 1) * COMMITTED_PAGES_PAGE_SIZE,
    safeCommittedPage * COMMITTED_PAGES_PAGE_SIZE,
  );

  return (
    <section className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={backHref}
          className="inline-flex min-h-10 items-center gap-1.5 text-sm font-bold text-primary hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
          {t("privateManager.backLink")}
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="w-auto"
            fullWidth={false}
            onClick={() => void loadDetail(false)}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("privateManager.refreshStatus")}
          </Button>
          {book.readable_for_children && !isSuspended ? (
            <ButtonLink
              href={`/books/${encodeURIComponent(book.id)}`}
              className="w-auto"
              fullWidth={false}
            >
              <BookOpen aria-hidden="true" className="size-4" />
              {t("myBooks.openReadWithChild")}
            </ButtonLink>
          ) : (
            <Button className="w-auto" disabled fullWidth={false} type="button">
              <BookOpen aria-hidden="true" className="size-4" />
              {t("myBooks.notOpenReadYet")}
            </Button>
          )}
        </div>
      </div>

      <header className="flex flex-col gap-4 rounded-card border border-border bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-start gap-4">
            <BookCover
              author={book.author}
              book={{
                id: book.id,
                title: book.title,
                author: book.author,
                min_grade: book.min_grade,
                max_grade: book.max_grade,
                lifecycle_status: book.lifecycle_status,
                visibility_scope: book.visibility_scope,
              }}
              coverSourceType={activeCoverAsset?.source_type ?? null}
              coverUrl={activeCoverAsset?.media_url ?? null}
              showTitle={false}
              size="small"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-0.5 text-xs font-bold text-emerald-800">
                  <Lock aria-hidden="true" className="size-3" />
                  {t("card.privateFamilyBadge")}
                </span>
                <span className="text-xs font-semibold text-muted">
                  {book.min_grade === book.max_grade
                    ? t("card.gradeSingle", { grade: book.min_grade })
                    : t("card.gradeRange", {
                        min: book.min_grade,
                        max: book.max_grade,
                      })}
                </span>
                <span className="text-xs text-muted">·</span>
                <span className="text-xs font-semibold text-ink">
                  {t("privateManager.committedPagesSummary", {
                    count: formatNumber(book.committed_page_count),
                  })}
                </span>
              </div>
              <h1
                className="book-title viread-learning-content mt-2 break-words text-3xl text-ink sm:text-4xl"
                dir="ltr"
                lang="vi"
              >
                {book.title}
              </h1>
              {book.author ? (
                <p className="mt-1 break-words text-sm text-muted">
                  {t("privateManager.authorPrefix", { author: book.author })}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted">{book.privacy_notice}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-white px-3 text-xs font-bold text-primary hover:bg-sky/50 focus-visible:outline-3 focus-visible:outline-primary"
              href="/studio/tasks"
            >
              <Sparkles aria-hidden="true" className="size-3.5" />
              {t("privateManager.taskCenterLink")}
            </Link>
            <Button
              className="min-h-11 w-auto px-3 text-xs"
              disabled={isSuspended || busyKey !== null}
              onClick={() => {
                setShowEditBookForm(false);
                setConfirmDeleteBook(false);
                setShowCoverStudio((open) => !open);
              }}
              type="button"
              variant="secondary"
            >
              <ImageIcon aria-hidden="true" className="size-3.5" />
              {showCoverStudio
                ? t("privateManager.closeCoverStudio")
                : t("privateManager.changeCoverAction")}
            </Button>
            <Button
              className="min-h-10 w-auto px-3 text-xs"
              disabled={isSuspended || busyKey !== null}
              onClick={() => {
                setShowCoverStudio(false);
                if (showEditBookForm) {
                  setShowEditBookForm(false);
                } else {
                  openEditBookForm();
                }
              }}
              type="button"
              variant="secondary"
            >
              <Pencil aria-hidden="true" className="size-3.5" />
              {t("myBooks.editBook")}
            </Button>
            <button
              aria-label={t("myBooks.deleteBookAria", { title: book.title })}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-control border border-rose-200 bg-white px-3 text-xs font-bold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busyKey !== null}
              onClick={() => {
                setShowCoverStudio(false);
                setShowEditBookForm(false);
                setConfirmDeleteBook((open) => !open);
              }}
              type="button"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              {t("myBooks.deleteBook")}
            </button>
          </div>
        </div>

        {showCoverStudio ? (
          <BookCoverStudio
            actorRole="parent"
            author={book.author}
            autoLoad
            bookId={book.id}
            bookTitle={book.title}
            initialCoverSourceType={activeCoverAsset?.source_type ?? null}
            initialCoverUrl={activeCoverAsset?.media_url ?? null}
            maxGrade={book.max_grade}
            minGrade={book.min_grade}
            onCoverUpdated={(asset) => {
              setActiveCoverAsset(asset);
            }}
          />
        ) : null}

        {showEditBookForm ? (
          <form
            aria-label={t("privateManager.editInfoAria")}
            className="flex flex-col gap-3 rounded-control border border-amber-300 bg-amber-50/60 p-4 text-xs"
            onSubmit={(event) => void handleSaveBookEdit(event)}
          >
            <p className="font-bold text-amber-950">
              {t("privateManager.editInfoRecheckNotice")}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 font-semibold text-ink">
                {t("myBooks.titleLabel")}
                <input
                  aria-label={t("myBooks.editTitleAria")}
                  className="viread-learning-content min-h-10 rounded-control border border-border bg-white px-3 text-sm text-ink"
                  dir="ltr"
                  lang="vi"
                  onChange={(event) => setEditBookTitle(event.target.value)}
                  required
                  type="text"
                  value={editBookTitle}
                />
              </label>
              <label className="flex flex-col gap-1 font-semibold text-ink">
                {t("myBooks.editAuthorLabel")}
                <input
                  aria-label={t("myBooks.editAuthorAria")}
                  className="viread-learning-content min-h-10 rounded-control border border-border bg-white px-3 text-sm text-ink"
                  dir="ltr"
                  lang="vi"
                  onChange={(event) => setEditBookAuthor(event.target.value)}
                  type="text"
                  value={editBookAuthor}
                />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 font-semibold text-ink">
                {t("myBooks.editMinGradeLabel")}
                <select
                  aria-label={t("myBooks.editMinGradeAria")}
                  className="min-h-10 rounded-control border border-border bg-white px-2.5 text-sm text-ink"
                  onChange={(event) =>
                    setEditBookMinGrade(Number(event.target.value))
                  }
                  value={editBookMinGrade}
                >
                  {CHILD_GRADES.map((grade) => (
                    <option key={grade} value={grade}>
                      {t("card.gradeSingle", { grade })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 font-semibold text-ink">
                {t("myBooks.editMaxGradeLabel")}
                <select
                  aria-label={t("myBooks.editMaxGradeAria")}
                  className="min-h-10 rounded-control border border-border bg-white px-2.5 text-sm text-ink"
                  onChange={(event) =>
                    setEditBookMaxGrade(Number(event.target.value))
                  }
                  value={editBookMaxGrade}
                >
                  {CHILD_GRADES.map((grade) => (
                    <option key={grade} value={grade}>
                      {t("card.gradeSingle", { grade })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 font-semibold text-ink">
                {t("privateManager.editSourceLabel")}
                <select
                  aria-label={t("privateManager.editSourceAria")}
                  className="min-h-10 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                  onChange={(event) =>
                    setEditBookSourceType(event.target.value as SourceUsageType)
                  }
                  value={editBookSourceType}
                >
                  {SOURCE_USAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(`sourceUsage.${opt.value}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 font-semibold text-ink">
                {t("myBooks.editSourceNoteLabel")}
                <input
                  aria-label={t("privateManager.editSourceNoteAria")}
                  className="min-h-10 rounded-control border border-border bg-white px-3 text-xs text-ink"
                  onChange={(event) =>
                    setEditBookSourceNote(event.target.value)
                  }
                  type="text"
                  value={editBookSourceNote}
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                className="min-h-10 w-auto px-4 text-xs"
                isLoading={busyKey === "book:edit"}
                type="submit"
              >
                {t("myBooks.saveAndRecheckAll")}
              </Button>
              <Button
                className="min-h-10 w-auto px-3 text-xs"
                onClick={() => setShowEditBookForm(false)}
                type="button"
                variant="secondary"
              >
                {t("reportDialog.cancel")}
              </Button>
            </div>
          </form>
        ) : null}

        {confirmDeleteBook ? (
          <div
            role="alertdialog"
            aria-label={t("myBooks.deleteDialogAria", { title: book.title })}
            className="flex flex-col gap-2.5 rounded-control border border-rose-300 bg-rose-50 p-4 text-xs text-rose-950"
          >
            <p className="font-bold">
              {t("myBooks.deleteDialogTitle", { title: book.title })}
            </p>
            <p>{t("privateManager.deleteBookConfirmBody")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-h-10 w-auto bg-rose-700 px-4 text-xs text-white hover:bg-rose-800"
                isLoading={busyKey === "book:delete"}
                onClick={() => void handleDeleteBook()}
                type="button"
              >
                {t("privateManager.confirmDeleteBook")}
              </Button>
              <Button
                className="min-h-10 w-auto px-3 text-xs"
                onClick={() => setConfirmDeleteBook(false)}
                type="button"
                variant="secondary"
              >
                {t("reportDialog.cancel")}
              </Button>
            </div>
          </div>
        ) : null}
      </header>

      {book.ocr_contribution && service.updateOcrContribution ? (
        <ParentOcrContributionCard
          bookTitle={book.title}
          disabled={isSuspended || busyKey !== null}
          onUpdate={async (input) => {
            if (!service.updateOcrContribution) return;
            await service.updateOcrContribution(book.id, input);
            await loadDetail(true);
          }}
          state={book.ocr_contribution}
        />
      ) : null}

      {isSuspended ? (
        <StatusMessage
          title={t("privateManager.suspendedAlertTitle")}
          tone="error"
        >
          {book.suspended_reason
            ? t("privateManager.suspendedAdminReason", {
                reason: book.suspended_reason,
              })
            : ""}
          {t("privateManager.suspendedDefaultNotice")}
        </StatusMessage>
      ) : null}

      {book.has_held_multipage_batch ? (
        <StatusMessage
          title={t("privateManager.holdingAlertTitle")}
          tone="warning"
        >
          {t("privateManager.holdingAlertBody")}
        </StatusMessage>
      ) : null}

      {actionError ? (
        <StatusMessage
          title={t("privateManager.actionErrorTitle")}
          tone="error"
        >
          {actionError}
        </StatusMessage>
      ) : null}

      {actionNotice ? (
        <StatusMessage
          title={t("privateManager.actionSuccessTitle")}
          tone="success"
        >
          {actionNotice}
        </StatusMessage>
      ) : null}

      {/* Upload Section */}
      <form
        aria-label={t("privateManager.uploadSectionAria")}
        className="flex flex-col gap-4 rounded-card border border-border bg-white p-5 shadow-sm"
        onSubmit={(event) => void handleUpload(event)}
      >
        <div>
          <h2 className="text-xl font-extrabold text-ink">
            {t("privateManager.uploadTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {t("privateManager.uploadSubtitle")}
          </p>
          <p className="mt-1 text-xs text-muted">
            {t("privateManager.uploadPrivacyTransparency")}
          </p>
        </div>

        <OcrServiceStatusBanner
          isChecking={ocrWorker.isChecking}
          justRecovered={ocrWorker.justRecovered}
          onDismissRecovered={ocrWorker.dismissRecoveredNotice}
          onRecheck={() => void ocrWorker.recheckNow()}
          queuedCount={
            pendingOcrCount > 0 ? pendingOcrCount : ocrWorker.queueDepth
          }
          status={ocrWorker.status}
          testId="private-book-worker-offline-notice"
          variant="parent"
        />

        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1.5 text-label font-semibold text-ink">
            {t("privateManager.chooseFileLabel")}
            <input
              ref={fileInputRef}
              accept={ACCEPTED_UPLOAD_EXTENSIONS}
              aria-label={t("privateManager.chooseFileAria")}
              className="block w-full min-w-0 max-w-full cursor-pointer rounded-control border border-dashed border-primary/50 bg-canvas p-3 text-sm text-ink file:me-3 file:rounded-control file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white hover:file:bg-primary-hover"
              disabled={uploading || isSuspended}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setSelectedFile(file);
                setUploadIdempotencyKey(generateClientKey());
              }}
              type="file"
            />
            {selectedFile ? (
              <span className="text-xs font-medium text-emerald-800">
                {t("privateManager.selectedFileSummary", {
                  name: selectedFile.name,
                  sizeMb: (selectedFile.size / (1024 * 1024)).toFixed(2),
                })}
              </span>
            ) : null}
          </label>

          <label className="flex min-w-0 flex-col gap-1.5 text-label font-semibold text-ink">
            {t("privateManager.uploadSourceLabel")}
            <select
              aria-label={t("privateManager.uploadSourceAria")}
              className="min-h-12 w-full min-w-0 max-w-full truncate rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
              disabled={uploading || isSuspended}
              onChange={(event) =>
                setUploadSourceType(event.target.value as SourceUsageType)
              }
              value={uploadSourceType}
            >
              {SOURCE_USAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(`sourceUsage.${opt.value}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1.5 text-label font-semibold text-ink">
          {t("privateManager.uploadSourceNoteLabel")}
          <input
            aria-label={t("privateManager.uploadSourceNoteAria")}
            className="min-h-11 rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
            disabled={uploading || isSuspended}
            onChange={(event) => setUploadSourceNote(event.target.value)}
            placeholder={t("privateManager.uploadSourceNotePlaceholder")}
            type="text"
            value={uploadSourceNote}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="sm:w-auto"
            disabled={!selectedFile || isSuspended}
            isLoading={uploading}
            type="submit"
          >
            <FileUp aria-hidden="true" className="size-4" />
            {uploading
              ? t("privateManager.uploadingButton")
              : ocrWorker.status === "unavailable"
                ? t("privateManager.uploadOfflineQueueButton")
                : t("privateManager.uploadButton")}
          </Button>
          {hasCheckingSubmission ? (
            ocrWorkerOffline && pendingOcrCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                <Clock3 aria-hidden="true" className="size-4" />
                {t("privateManager.queuedWaitingWorkerShort")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
                <Clock3 aria-hidden="true" className="size-4 animate-spin" />
                {t("privateManager.autoPollingHint")}
              </span>
            )
          ) : null}
        </div>
        {uploading ? (
          <AiProgressBar
            active
            elapsedSeconds={uploadProgress.elapsedSeconds}
            label={uploadProgress.stageLabel ?? tCommon("aiProgress.uploading")}
            percent={uploadProgress.percent}
            size="sm"
            testId="private-book-upload-progress"
          />
        ) : null}
      </form>

      {/* Staged Submissions Queue */}
      <section
        aria-labelledby="submissions-heading"
        className="flex flex-col gap-4"
      >
        <h2
          id="submissions-heading"
          className="text-xl font-extrabold text-ink"
        >
          {t("privateManager.submissionsHeading", {
            count: activeSubmissions.length,
          })}
        </h2>

        {activeSubmissions.length === 0 ? (
          <div className="rounded-card border border-dashed border-border bg-white p-6 text-center text-sm text-muted">
            {t("privateManager.noSubmissionsHint")}
          </div>
        ) : (
          <>
            <div
              aria-label={t("privateManager.filterAria")}
              className="flex flex-wrap items-center gap-2"
              role="group"
            >
              {(
                [
                  {
                    key: "ALL",
                    label: t("privateManager.filterAll", {
                      count: activeSubmissions.length,
                    }),
                  },
                  {
                    key: "CHECKING",
                    label: t("privateManager.filterChecking", {
                      count: submissionCounts.CHECKING,
                    }),
                  },
                  {
                    key: "READY",
                    label: t("privateManager.filterReady", {
                      count: submissionCounts.READY,
                    }),
                  },
                  {
                    key: "ADMIN",
                    label: t("privateManager.filterAdmin", {
                      count: submissionCounts.ADMIN,
                    }),
                  },
                  {
                    key: "FAILED",
                    label: t("privateManager.filterFailed", {
                      count: submissionCounts.FAILED,
                    }),
                  },
                  {
                    key: "ADDED",
                    label: t("privateManager.filterAdded", {
                      count: submissionCounts.ADDED,
                    }),
                  },
                ] as const
              ).map((pill) => {
                const isSelected = statusFilter === pill.key;
                return (
                  <button
                    key={pill.key}
                    aria-pressed={isSelected}
                    className={`min-h-9 rounded-full border px-3 py-1 text-xs font-bold transition-colors ${
                      isSelected
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-canvas text-ink hover:bg-sky/50"
                    }`}
                    onClick={() => {
                      setStatusFilter(pill.key);
                      setSubmissionsPage(1);
                    }}
                    type="button"
                  >
                    {pill.label}
                  </button>
                );
              })}
            </div>
            {activeSubmissions.length > 1 ? (
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <div
                  aria-label={t("privateManager.overviewAria")}
                  className="flex flex-wrap gap-1.5"
                >
                  {visibleOverviewSubmissions.map((sub, offsetIndex) => {
                    const index = overviewStartIndex + offsetIndex;
                    const isChipQueuedOffline =
                      ocrWorkerOffline &&
                      sub.workflow_status === "CHECKING" &&
                      sub.ocr_status === "PENDING";
                    const chipStyle = isChipQueuedOffline
                      ? "border-amber-300 bg-amber-50 text-amber-950"
                      : (WORKFLOW_BADGE_STYLES[sub.workflow_status] ??
                        "border-border bg-canvas text-ink");
                    const chipLabel = isChipQueuedOffline
                      ? t("privateManager.queuedWaitingWorkerBadge")
                      : sub.workflow_status_label;
                    return (
                      <button
                        key={`map-${sub.id}`}
                        className={`inline-flex items-center gap-1 rounded-control border px-2 py-1 text-[11px] font-bold ${chipStyle}`}
                        onClick={() => {
                          setStatusFilter("ALL");
                          setSubmissionsPage(
                            Math.floor(index / SUBMISSIONS_PAGE_SIZE) + 1,
                          );
                          requestAnimationFrame(() => {
                            const target = document.querySelector(
                              `[data-submission-id="${sub.id}"]`,
                            );
                            target?.scrollIntoView?.({
                              behavior: "smooth",
                              block: "nearest",
                            });
                          });
                        }}
                        title={t("privateManager.overviewChipTitle", {
                          page: sub.source_page_number,
                          status: chipLabel,
                        })}
                        type="button"
                      >
                        <span>Tr.{sub.source_page_number}</span>
                        <span className="font-normal">· {chipLabel}</span>
                      </button>
                    );
                  })}
                </div>
                <PaginationBar
                  ariaLabel={t("privateManager.overviewAria")}
                  compact
                  itemLabel={t("privateManager.pageItemLabel")}
                  onPageChange={setOverviewPage}
                  page={safeOverviewPage}
                  pageSize={OVERVIEW_CHIPS_PAGE_SIZE}
                  total={activeSubmissions.length}
                />
              </div>
            ) : null}

            {workerFailureCount > 0 || submissionCounts.CHECKING > 0 ? (
              <div
                className="rounded-control border border-amber-300 bg-amber-50/80 px-3 py-2 text-xs text-amber-950"
                data-testid="private-book-ocr-queue-banner"
              >
                {workerFailureCount > 0 ? (
                  <p className="font-semibold">
                    {t("privateManager.workerFailuresSummary", {
                      count: workerFailureCount,
                    })}
                  </p>
                ) : ocrWorkerOffline && pendingOcrCount > 0 ? (
                  <p className="font-semibold">
                    {t("privateManager.windowsOcrQueueWaiting", {
                      count: pendingOcrCount,
                    })}
                  </p>
                ) : runningOcrCount > 0 ? (
                  <p className="font-semibold">
                    {t("privateManager.ocrRunningStatus", {
                      running: runningOcrCount,
                    })}
                    {pendingOcrCount > 0
                      ? t("privateManager.ocrQueuedSuffix", {
                          count: pendingOcrCount,
                        })
                      : ""}
                    {t("privateManager.ocrOtherPagesStillVisible")}
                  </p>
                ) : (
                  <p className="font-semibold">
                    {pendingOcrCount > 0
                      ? t("privateManager.ocrQueuedOnlyStatus", {
                          count: pendingOcrCount,
                        })
                      : t("privateManager.backgroundProcessingStatus", {
                          count: submissionCounts.CHECKING,
                        })}
                    {t("privateManager.ocrOtherPagesStillVisible")}
                  </p>
                )}
              </div>
            ) : null}
            {visibleSubmissions.length === 0 ? (
              <div className="rounded-card border border-dashed border-border bg-white p-6 text-center text-sm text-muted">
                {t("privateManager.noFilterMatches")}
              </div>
            ) : null}
            <div className="flex flex-col gap-4">
              {visibleSubmissions.map((sub) => {
                const isQueuedOffline =
                  ocrWorkerOffline &&
                  sub.workflow_status === "CHECKING" &&
                  sub.ocr_status === "PENDING";
                const badgeStyle = isQueuedOffline
                  ? "border-amber-300 bg-amber-50 text-amber-950"
                  : (WORKFLOW_BADGE_STYLES[sub.workflow_status] ??
                    "border-border bg-canvas text-ink");
                const badgeLabel = isQueuedOffline
                  ? t("privateManager.queuedWaitingWorkerBadge")
                  : sub.workflow_status_label;
                const lockReason = lockReasonForSubmission(
                  sub,
                  t,
                  ocrWorkerOffline,
                );
                const isEditing = editingSubId === sub.id;
                const isReviewFormOpen = reviewFormSubId === sub.id;
                const isSubBusy =
                  busyKey !== null && busyKey.endsWith(`:${sub.id}`);
                const ocrHint = describeStageErrorHint(sub.ocr_error_code, t);
                const proofreadHint = describeStageErrorHint(
                  sub.proofread_error_code,
                  t,
                );
                const toolCheckHint = describeStageErrorHint(
                  sub.tool_check_error_code,
                  t,
                );
                const parentNotice =
                  sub.tool_check_parent_notice ||
                  sub.tool_check_findings_count > 0
                    ? parentNoticeMeta(sub, t)
                    : null;

                return (
                  <article
                    key={sub.id}
                    data-submission-id={sub.id}
                    data-workflow-status={sub.workflow_status}
                    className="flex flex-col gap-4 rounded-card border border-border bg-white p-5 shadow-sm"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row">
                      {/* Private Authenticated Page Preview */}
                      <div className="w-full shrink-0 lg:w-48">
                        <div className="relative h-56 w-full overflow-hidden rounded-control border border-border bg-cream">
                          <AuthenticatedImage
                            alt={t("privateManager.sourceImageAlt", {
                              page: sub.source_page_number,
                              file: sub.source_file_name,
                            })}
                            className="h-full w-full object-contain p-2"
                            src={sub.image_url}
                          />
                        </div>
                        <p className="mt-1.5 truncate text-xs text-muted">
                          {t("privateManager.sourcePageMeta", {
                            file: sub.source_file_name,
                            page: `${sub.source_page_number}/${sub.batch_total_pages}`,
                          })}
                        </p>
                      </div>

                      {/* Details & Pipeline Stages */}
                      <div className="flex min-w-0 flex-1 flex-col gap-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-bold ${badgeStyle}`}
                              data-testid={
                                isQueuedOffline
                                  ? "submission-queued-offline-badge"
                                  : undefined
                              }
                            >
                              {badgeLabel}
                            </span>
                            {sub.is_image_only ? (
                              <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-950">
                                {t("privateManager.imageOnlyBadge")}
                              </span>
                            ) : null}
                            {sub.tool_check_policy_blocked ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-rose-400 bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-900">
                                <ShieldAlert
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                {t("privateManager.blockedPolicyBadge")}
                              </span>
                            ) : null}
                          </div>

                          {sub.workflow_status !== "ADDED_TO_BOOK" ? (
                            <button
                              aria-label={t("privateManager.cancelPageAria", {
                                page: sub.source_page_number,
                              })}
                              className="inline-flex min-h-9 items-center gap-1 rounded-control border border-border px-2.5 text-xs font-semibold text-muted hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
                              disabled={isSubBusy}
                              onClick={() => void handleCancelSubmission(sub)}
                              type="button"
                            >
                              <Trash2 aria-hidden="true" className="size-3.5" />
                              {t("privateManager.cancelPage")}
                            </button>
                          ) : null}
                        </div>

                        <SubmissionCheckingProgressBar
                          isQueuedOffline={isQueuedOffline}
                          submission={sub}
                        />

                        {/* 3-Stage Status Strip */}
                        <div
                          aria-label={t("privateManager.pipelineAria")}
                          className="grid gap-2 sm:grid-cols-3"
                        >
                          <div className="rounded-control border border-border bg-canvas px-3 py-2 text-xs">
                            <p className="font-bold text-ink">
                              {t("privateManager.stepOcrTitle")}
                            </p>
                            <p className="mt-0.5 text-muted">
                              {sub.ocr_status === "PENDING" && ocrWorkerOffline
                                ? t("privateManager.waitingWindowsOcrShort")
                                : stageStatusLabel(sub.ocr_status, "ocr", t)}
                              {sub.ocr_error_code && !ocrHint
                                ? ` (${sub.ocr_error_code})`
                                : ""}
                            </p>
                            {ocrHint ? (
                              <p className="mt-1 text-[11px] font-medium text-rose-800">
                                {ocrHint}
                              </p>
                            ) : null}
                          </div>
                          <div className="rounded-control border border-border bg-canvas px-3 py-2 text-xs">
                            <p className="font-bold text-ink">
                              {t("privateManager.stepProofreadTitle")}
                            </p>
                            <p className="mt-0.5 text-muted">
                              {stageStatusLabel(
                                sub.proofread_status,
                                "post_ocr",
                                t,
                              )}
                              {sub.proofread_suggestions.length > 0
                                ? t(
                                    "privateManager.proofreadSuggestionsSuffix",
                                    {
                                      count: sub.proofread_suggestions.length,
                                    },
                                  )
                                : ""}
                              {sub.proofread_error_code && !proofreadHint
                                ? ` (${sub.proofread_error_code})`
                                : ""}
                            </p>
                            {proofreadHint ? (
                              <p className="mt-1 text-[11px] font-medium text-rose-800">
                                {proofreadHint}
                              </p>
                            ) : null}
                          </div>
                          <div className="rounded-control border border-border bg-canvas px-3 py-2 text-xs">
                            <p className="font-bold text-ink">
                              {t("privateManager.stepSafetyTitle")}
                            </p>
                            <p className="mt-0.5 text-muted">
                              {stageStatusLabel(
                                sub.tool_check_status,
                                "post_ocr",
                                t,
                              )}
                              {sub.tool_check_findings_count > 0
                                ? t("privateManager.safetyFindingsSuffix", {
                                    count: sub.tool_check_findings_count,
                                  })
                                : ""}
                              {sub.tool_check_error_code && !toolCheckHint
                                ? ` (${sub.tool_check_error_code})`
                                : ""}
                            </p>
                            {toolCheckHint ? (
                              <p className="mt-1 text-[11px] font-medium text-rose-800">
                                {toolCheckHint}
                              </p>
                            ) : null}
                          </div>
                        </div>

                        {/* Tool Check Scope Disclosure */}
                        <p className="rounded-control border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                          <strong>
                            {t("privateManager.toolCheckScopeLabel")}
                          </strong>{" "}
                          {describeToolCheckScope(sub.tool_check_scope, t)}
                        </p>

                        {/* Parent Notice from Tool Check (non-sensitive summary) */}
                        {parentNotice ? (
                          <div
                            className={`rounded-control border p-3 text-xs ${parentNotice.className}`}
                          >
                            <p className="flex items-center gap-1.5 font-bold">
                              {sub.workflow_status === "PASSED_READY_TO_ADD" ||
                              sub.workflow_status === "APPROVED_READY_TO_ADD" ||
                              sub.workflow_status === "ADDED_TO_BOOK" ? (
                                <ShieldCheck
                                  aria-hidden="true"
                                  className="size-4 shrink-0"
                                />
                              ) : (
                                <AlertTriangle
                                  aria-hidden="true"
                                  className="size-4 shrink-0"
                                />
                              )}
                              {parentNotice.title}
                            </p>
                            {sub.tool_check_parent_notice ? (
                              <p className="mt-1">
                                {sub.tool_check_parent_notice}
                              </p>
                            ) : null}
                            {sub.workflow_status === "CHECK_FAILED" &&
                            sub.can_retry ? (
                              <div className="mt-2.5">
                                <Button
                                  className="min-h-10 w-auto px-3.5 text-xs"
                                  disabled={isSubBusy || isSuspended}
                                  isLoading={busyKey === `retry:${sub.id}`}
                                  onClick={() => void handleRetry(sub)}
                                  type="button"
                                  variant="secondary"
                                >
                                  <RotateCcw
                                    aria-hidden="true"
                                    className="size-3.5"
                                  />
                                  {t("privateManager.retryCheckAction")}
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        {/* Candidate Text Preview */}
                        {sub.candidate_text ? (
                          <div className="rounded-control border border-border bg-canvas/70 p-3">
                            <p className="text-xs font-bold text-ink">
                              {t("privateManager.previewTextLabel")}
                            </p>
                            <p
                              className="viread-learning-content mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink"
                              dir="ltr"
                              lang="vi"
                            >
                              {sub.candidate_text}
                            </p>
                          </div>
                        ) : null}

                        {/* Spelling Suggestions */}
                        {sub.proofread_suggestions.length > 0 ? (
                          <div className="rounded-control border border-sky-200 bg-sky/40 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs font-bold text-primary-hover">
                                {t("privateManager.proofreadSectionTitle", {
                                  count: sub.proofread_suggestions.length,
                                })}
                                {sub.uncertain_word_indices.length > 0
                                  ? t("privateManager.uncertainWordsSuffix", {
                                      count: sub.uncertain_word_indices.length,
                                    })
                                  : ""}
                              </p>
                              {sub.spelling_accepted ? (
                                <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800">
                                  <CheckCircle2
                                    aria-hidden="true"
                                    className="size-3.5"
                                  />
                                  {t("privateManager.proofreadAcceptedBadge")}
                                </span>
                              ) : (
                                <Button
                                  className="min-h-9 w-auto px-3 text-xs"
                                  disabled={isSubBusy}
                                  onClick={() => void handleAcceptSpelling(sub)}
                                  type="button"
                                  variant="secondary"
                                >
                                  {t("privateManager.proofreadAcceptAction")}
                                </Button>
                              )}
                            </div>
                            <ul className="mt-2 space-y-1 text-xs text-ink">
                              {sub.proofread_suggestions
                                .slice(0, 6)
                                .map((s, idx) => (
                                  <li key={idx}>
                                    <span
                                      className="viread-learning-content line-through text-rose-700"
                                      dir="ltr"
                                      lang="vi"
                                    >
                                      {s.original}
                                    </span>{" "}
                                    →{" "}
                                    <span
                                      className="viread-learning-content font-bold text-emerald-800"
                                      dir="ltr"
                                      lang="vi"
                                    >
                                      {s.suggested}
                                    </span>
                                    {s.uncertain ? (
                                      <span className="ms-1 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-900">
                                        {t("privateManager.needsCheckWordNote")}
                                      </span>
                                    ) : null}
                                  </li>
                                ))}
                            </ul>
                          </div>
                        ) : null}

                        {/* Admin Decision Feedback */}
                        {sub.admin_decision ? (
                          <div
                            className={`rounded-control border p-3 text-xs ${
                              sub.admin_decision === "APPROVE"
                                ? "border-emerald-300 bg-emerald-50 text-emerald-950"
                                : "border-rose-300 bg-rose-50 text-rose-950"
                            }`}
                          >
                            <p className="font-bold">
                              {t("privateManager.adminDecisionPrefix")}{" "}
                              {sub.admin_decision === "APPROVE"
                                ? t("privateManager.adminDecisionApproved")
                                : sub.admin_decision === "REQUEST_CHANGES"
                                  ? t(
                                      "privateManager.adminDecisionRequestChanges",
                                    )
                                  : t("privateManager.adminDecisionRejected")}
                            </p>
                            {sub.admin_decision_reason ? (
                              <p className="mt-1">
                                {t("privateManager.adminReasonPrefix", {
                                  reason: sub.admin_decision_reason,
                                })}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {/* Inline Edit Text / Source Drawer */}
                        {isEditing ? (
                          <div className="rounded-control border border-primary/40 bg-canvas p-3">
                            <p className="text-xs font-bold text-ink">
                              {t("privateManager.editSubmissionTitle")}
                            </p>
                            <p className="mt-0.5 text-xs text-amber-900">
                              {t("privateManager.editSubmissionNote")}
                            </p>
                            <textarea
                              aria-label={t(
                                "privateManager.editSubmissionTextAria",
                              )}
                              className="viread-learning-content mt-2 min-h-24 w-full rounded-control border border-border bg-white p-2.5 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                              dir="ltr"
                              lang="vi"
                              onChange={(event) =>
                                setEditText(event.target.value)
                              }
                              value={editText}
                            />
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <select
                                aria-label={t(
                                  "privateManager.editSubmissionSourceAria",
                                )}
                                className="min-h-10 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                                onChange={(event) =>
                                  setEditSourceType(
                                    event.target.value as SourceUsageType,
                                  )
                                }
                                value={editSourceType}
                              >
                                {SOURCE_USAGE_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {t(`sourceUsage.${opt.value}`)}
                                  </option>
                                ))}
                              </select>
                              <input
                                aria-label={t(
                                  "privateManager.editSubmissionSourceNoteAria",
                                )}
                                className="min-h-10 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                                onChange={(event) =>
                                  setEditSourceNote(event.target.value)
                                }
                                placeholder={t(
                                  "privateManager.sourceNoteShortPlaceholder",
                                )}
                                value={editSourceNote}
                              />
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                className="min-h-10 w-auto px-4 text-xs"
                                isLoading={busyKey === `edit:${sub.id}`}
                                onClick={() => void handleSaveEdit(sub)}
                                type="button"
                              >
                                {t("privateManager.saveNewVersionAction")}
                              </Button>
                              <Button
                                className="min-h-10 w-auto px-3 text-xs"
                                onClick={() => setEditingSubId(null)}
                                type="button"
                                variant="secondary"
                              >
                                {t("privateManager.closeAction")}
                              </Button>
                            </div>
                          </div>
                        ) : null}

                        {/* Inline Request Admin Review Drawer */}
                        {isReviewFormOpen ? (
                          <div className="rounded-control border border-amber-400 bg-amber-50/70 p-3">
                            <p className="text-xs font-bold text-amber-950">
                              {t("privateManager.submitAdminTitle")}
                            </p>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
                                {t("privateManager.submitAdminSourceLabel")}
                                <select
                                  aria-label={t(
                                    "privateManager.submitAdminSourceAria",
                                  )}
                                  className="min-h-10 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                                  onChange={(event) =>
                                    setReviewSourceType(
                                      event.target.value as SourceUsageType,
                                    )
                                  }
                                  value={reviewSourceType}
                                >
                                  {SOURCE_USAGE_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {t(`sourceUsage.${opt.value}`)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
                                {t("privateManager.submitAdminSourceNoteLabel")}
                                <input
                                  aria-label={t(
                                    "privateManager.submitAdminSourceNoteAria",
                                  )}
                                  className="min-h-10 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                                  onChange={(event) =>
                                    setReviewSourceNote(event.target.value)
                                  }
                                  placeholder={t(
                                    "privateManager.submitAdminSourceNotePlaceholder",
                                  )}
                                  value={reviewSourceNote}
                                />
                              </label>
                            </div>
                            <label className="mt-2 flex flex-col gap-1 text-xs font-semibold text-ink">
                              {t("privateManager.submitAdminMessageLabel")}
                              <textarea
                                aria-label={t(
                                  "privateManager.submitAdminMessageAria",
                                )}
                                className="min-h-20 rounded-control border border-border bg-white p-2 text-xs text-ink"
                                onChange={(event) =>
                                  setReviewRequestNote(event.target.value)
                                }
                                placeholder={t(
                                  "privateManager.submitAdminMessagePlaceholder",
                                )}
                                value={reviewRequestNote}
                              />
                            </label>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                className="min-h-10 w-auto px-4 text-xs"
                                isLoading={busyKey === `review:${sub.id}`}
                                onClick={() =>
                                  void handleRequestAdminReview(sub)
                                }
                                type="button"
                              >
                                <Send aria-hidden="true" className="size-3.5" />
                                {t("privateManager.confirmSendAdmin")}
                              </Button>
                              <Button
                                className="min-h-10 w-auto px-3 text-xs"
                                onClick={() => setReviewFormSubId(null)}
                                type="button"
                                variant="secondary"
                              >
                                {t("reportDialog.cancel")}
                              </Button>
                            </div>
                          </div>
                        ) : null}

                        {/* Primary Action Bar */}
                        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                          {/* Add Page to Book — STRICTLY LOCKED unless can_add_to_book */}
                          {sub.workflow_status !== "ADDED_TO_BOOK" ? (
                            <Button
                              className="min-h-11 w-auto px-4 text-sm"
                              disabled={
                                !sub.can_add_to_book || isSubBusy || isSuspended
                              }
                              isLoading={busyKey === `add:${sub.id}`}
                              onClick={() => void handleAddPage(sub)}
                              type="button"
                            >
                              <ShieldCheck
                                aria-hidden="true"
                                className="size-4"
                              />
                              {t("privateManager.commitPageAction")}
                            </Button>
                          ) : (
                            <span className="inline-flex min-h-10 items-center gap-1.5 rounded-control bg-teal-50 px-3 text-xs font-bold text-teal-900">
                              <CheckCircle2
                                aria-hidden="true"
                                className="size-4"
                              />
                              {t("privateManager.committedPageBadge")}
                            </span>
                          )}

                          {/* Escalate to Admin */}
                          {sub.can_request_admin_review && !isReviewFormOpen ? (
                            <Button
                              className="min-h-11 w-auto px-4 text-sm"
                              disabled={isSubBusy || isSuspended}
                              onClick={() => {
                                setReviewFormSubId(sub.id);
                                setReviewSourceType(sub.source_type);
                                setReviewSourceNote(sub.source_note ?? "");
                                setReviewRequestNote("");
                              }}
                              type="button"
                              variant="secondary"
                            >
                              <Send aria-hidden="true" className="size-4" />
                              {t("privateManager.sendAdminAction")}
                            </Button>
                          ) : null}

                          {/* Stage-preserving Retry (avoid duplicating when already shown in the top error notice) */}
                          {sub.can_retry &&
                          !(
                            sub.workflow_status === "CHECK_FAILED" &&
                            (sub.tool_check_parent_notice ||
                              sub.tool_check_findings_count > 0)
                          ) ? (
                            <Button
                              className="min-h-11 w-auto px-4 text-sm"
                              disabled={isSubBusy || isSuspended}
                              isLoading={busyKey === `retry:${sub.id}`}
                              onClick={() => void handleRetry(sub)}
                              type="button"
                              variant="secondary"
                            >
                              <RotateCcw
                                aria-hidden="true"
                                className="size-4"
                              />
                              {t("privateManager.retryCheckAction")}
                            </Button>
                          ) : null}

                          {/* Edit text / Replace image */}
                          {sub.workflow_status !== "ADDED_TO_BOOK" &&
                          !isSuspended ? (
                            <>
                              <Button
                                className="min-h-10 w-auto px-3 text-xs"
                                disabled={isSubBusy}
                                onClick={() => {
                                  setEditingSubId(sub.id);
                                  setEditText(sub.candidate_text ?? "");
                                  setEditSourceType(sub.source_type);
                                  setEditSourceNote(sub.source_note ?? "");
                                }}
                                type="button"
                                variant="quiet"
                              >
                                <Pencil
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                {t("privateManager.editContentAction")}
                              </Button>

                              <label className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-control border border-border bg-white px-3 text-xs font-semibold text-ink hover:bg-canvas">
                                <Upload
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                {t("privateManager.replaceImageAction")}
                                <input
                                  accept={ACCEPTED_UPLOAD_EXTENSIONS}
                                  aria-label={t(
                                    "privateManager.replaceSubmissionImageAria",
                                    { page: sub.source_page_number },
                                  )}
                                  className="sr-only"
                                  disabled={isSubBusy}
                                  onChange={(event) => {
                                    const nextFile = event.target.files?.[0];
                                    if (nextFile) {
                                      void handleReplaceFile(sub, nextFile);
                                    }
                                    event.target.value = "";
                                  }}
                                  type="file"
                                />
                              </label>
                            </>
                          ) : null}
                        </div>

                        {lockReason &&
                        sub.workflow_status !== "ADDED_TO_BOOK" ? (
                          <p className="text-xs font-medium text-amber-900">
                            <Lock
                              aria-hidden="true"
                              className="me-1 inline size-3.5 align-text-bottom"
                            />
                            {lockReason}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            <PaginationBar
              ariaLabel={t("privateManager.submissionsPaginationAria")}
              compact
              itemLabel={t("privateManager.pageItemLabel")}
              onPageChange={setSubmissionsPage}
              page={safeSubmissionsPage}
              pageSize={SUBMISSIONS_PAGE_SIZE}
              total={filteredSubmissions.length}
            />
          </>
        )}
      </section>

      {/* Committed Pages List */}
      <section
        aria-labelledby="committed-pages-heading"
        className="flex flex-col gap-3"
      >
        <h2
          id="committed-pages-heading"
          className="text-xl font-extrabold text-ink"
        >
          {t("privateManager.committedHeading", {
            count: committedPages.length,
          })}
        </h2>
        {committedPages.length === 0 ? (
          <p className="rounded-card border border-border bg-white p-4 text-sm text-muted">
            {t("privateManager.committedEmpty")}
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visibleCommittedPages.map((page) => {
                const isEditingPage = editingPageId === page.page_id;
                const isConfirmingDelete = confirmDeletePageId === page.page_id;
                const isIllustrationStudioOpen =
                  illustrationStudioPageId === page.page_id;
                const isSmartOcrOpen = smartOcrPageId === page.page_id;
                const isPageBusy =
                  busyKey !== null && busyKey.endsWith(`:${page.page_id}`);
                return (
                  <article
                    key={page.page_id}
                    data-committed-page-id={page.page_id}
                    className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 shadow-sm"
                  >
                    <div className="h-40 w-full overflow-hidden rounded-control bg-cream">
                      <AuthenticatedImage
                        alt={t("privateManager.pageNumberHeading", {
                          page: page.page_number,
                        })}
                        className="h-full w-full object-contain p-2"
                        src={page.image_url}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-bold text-ink">
                        {t("privateManager.pageNumberHeading", {
                          page: page.page_number,
                        })}
                      </p>
                      <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-bold text-teal-800">
                        {t("privateManager.readingActiveBadge")}
                      </span>
                    </div>
                    {page.verified_text_preview ? (
                      <p
                        className="viread-learning-content line-clamp-3 text-xs text-muted"
                        dir="ltr"
                        lang="vi"
                      >
                        {page.verified_text_preview}
                      </p>
                    ) : null}

                    <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
                      {!isSuspended ? (
                        <>
                          <button
                            aria-label={t(
                              "privateManager.editCommittedPageAria",
                              { page: page.page_number },
                            )}
                            className="inline-flex min-h-9 items-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-semibold text-ink hover:bg-canvas disabled:opacity-50"
                            disabled={isPageBusy || busyKey !== null}
                            onClick={() =>
                              isEditingPage
                                ? setEditingPageId(null)
                                : startEditCommittedPage(page)
                            }
                            type="button"
                          >
                            <Pencil aria-hidden="true" className="size-3.5" />
                            {t("privateManager.editPageAction")}
                          </button>
                          <label className="inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-semibold text-ink hover:bg-canvas">
                            <Upload aria-hidden="true" className="size-3.5" />
                            {t("privateManager.replaceImageAction")}
                            <input
                              accept={ACCEPTED_UPLOAD_EXTENSIONS}
                              aria-label={t(
                                "privateManager.replaceCommittedImageAria",
                                { page: page.page_number },
                              )}
                              className="sr-only"
                              disabled={isPageBusy || busyKey !== null}
                              onChange={(event) => {
                                const nextFile = event.target.files?.[0];
                                if (nextFile) {
                                  void handleReplaceCommittedPageFile(
                                    page,
                                    nextFile,
                                  );
                                }
                                event.target.value = "";
                              }}
                              type="file"
                            />
                          </label>
                        </>
                      ) : null}
                      <button
                        aria-expanded={isIllustrationStudioOpen}
                        aria-label={t(
                          isIllustrationStudioOpen
                            ? "privateManager.closePageIllustrationAria"
                            : "privateManager.openPageIllustrationAria",
                          { page: page.page_number },
                        )}
                        className="inline-flex min-h-11 items-center gap-1 rounded-control border border-primary/30 bg-sky/50 px-2.5 text-xs font-semibold text-primary-hover hover:bg-sky disabled:opacity-50"
                        disabled={isSuspended || isPageBusy || busyKey !== null}
                        onClick={() => {
                          setSmartOcrPageId(null);
                          setIllustrationStudioPageId((prev) =>
                            prev === page.page_id ? null : page.page_id,
                          );
                        }}
                        type="button"
                      >
                        <ImageIcon aria-hidden="true" className="size-3.5" />
                        {isIllustrationStudioOpen
                          ? t("privateManager.closePageIllustrationAction")
                          : t("privateManager.pageIllustrationAction")}
                      </button>
                      <button
                        aria-expanded={isSmartOcrOpen}
                        aria-label={t(
                          isSmartOcrOpen
                            ? "privateManager.closePageOcrBlocksAria"
                            : "privateManager.openPageOcrBlocksAria",
                          { page: page.page_number },
                        )}
                        className="inline-flex min-h-11 items-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-semibold text-ink hover:bg-canvas disabled:opacity-50"
                        disabled={isPageBusy || busyKey !== null}
                        onClick={() => {
                          setIllustrationStudioPageId(null);
                          setSmartOcrPageId((prev) =>
                            prev === page.page_id ? null : page.page_id,
                          );
                        }}
                        type="button"
                      >
                        <FileSearch aria-hidden="true" className="size-3.5" />
                        {isSmartOcrOpen
                          ? t("privateManager.closePageOcrBlocksAction")
                          : t("privateManager.openPageOcrBlocksAction")}
                      </button>
                      <button
                        aria-label={t(
                          "privateManager.deleteCommittedPageAria",
                          { page: page.page_number },
                        )}
                        className="inline-flex min-h-9 items-center gap-1 rounded-control border border-rose-200 bg-white px-2.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                        disabled={isPageBusy || busyKey !== null}
                        onClick={() => {
                          setEditingPageId(null);
                          setConfirmDeletePageId((prev) =>
                            prev === page.page_id ? null : page.page_id,
                          );
                        }}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" className="size-3.5" />
                        {t("privateManager.deletePageAction")}
                      </button>
                    </div>

                    {isIllustrationStudioOpen ? (
                      <div className="pt-1">
                        <PageIllustrationStudio
                          actorRole="parent"
                          autoLoad
                          bookId={book.id}
                          canonicalText={
                            page.verified_text || page.verified_text_preview
                          }
                          compact
                          pageId={page.page_id}
                          pageNumber={page.page_number}
                        />
                      </div>
                    ) : null}

                    {isSmartOcrOpen ? (
                      <div className="rounded-control border border-border bg-canvas/50 p-3">
                        <SmartOcrBlockReviewLoader
                          canApplyToDraft={false}
                          isRevisionVerified
                          pageId={page.page_id}
                          pageImageUrl={page.image_url}
                          pageNumber={page.page_number}
                        />
                      </div>
                    ) : null}

                    {isEditingPage ? (
                      <div className="flex flex-col gap-2.5 rounded-control border border-amber-300 bg-amber-50/70 p-3 text-xs">
                        <p className="font-bold text-amber-950">
                          {t("privateManager.editCommittedRecheckNote")}
                        </p>
                        <label className="flex flex-col gap-1 font-semibold text-ink">
                          {t("privateManager.committedPageNumberLabel")}
                          <input
                            aria-label={t(
                              "privateManager.committedPageNumberAria",
                              { page: page.page_number },
                            )}
                            className="min-h-9 w-28 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                            min={1}
                            onChange={(event) =>
                              setEditPageNumber(
                                Math.max(1, Number(event.target.value) || 1),
                              )
                            }
                            type="number"
                            value={editPageNumber}
                          />
                        </label>
                        <label className="flex flex-col gap-1 font-semibold text-ink">
                          {t("privateManager.committedPageTextLabel")}
                          <textarea
                            aria-label={t(
                              "privateManager.committedPageTextAria",
                              { page: page.page_number },
                            )}
                            className="viread-learning-content min-h-24 w-full rounded-control border border-border bg-white p-2 text-xs text-ink"
                            dir="ltr"
                            lang="vi"
                            onChange={(event) =>
                              setEditPageText(event.target.value)
                            }
                            value={editPageText}
                          />
                        </label>
                        <select
                          aria-label={t("privateManager.committedSourceAria", {
                            page: page.page_number,
                          })}
                          className="min-h-9 rounded-control border border-border bg-white px-2 text-xs text-ink"
                          onChange={(event) =>
                            setEditPageSourceType(
                              event.target.value as SourceUsageType,
                            )
                          }
                          value={editPageSourceType}
                        >
                          {SOURCE_USAGE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {t(`sourceUsage.${opt.value}`)}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label={t(
                            "privateManager.committedSourceNoteAria",
                            { page: page.page_number },
                          )}
                          className="min-h-9 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                          onChange={(event) =>
                            setEditPageSourceNote(event.target.value)
                          }
                          placeholder={t(
                            "privateManager.sourceNoteShortPlaceholder",
                          )}
                          type="text"
                          value={editPageSourceNote}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            className="min-h-9 w-auto px-3 text-xs"
                            isLoading={busyKey === `page-edit:${page.page_id}`}
                            onClick={() =>
                              void handleSaveCommittedPageEdit(page)
                            }
                            type="button"
                          >
                            {t("privateManager.saveAndRecheckAction")}
                          </Button>
                          <Button
                            className="min-h-9 w-auto px-3 text-xs"
                            onClick={() => setEditingPageId(null)}
                            type="button"
                            variant="secondary"
                          >
                            {t("reportDialog.cancel")}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {isConfirmingDelete ? (
                      <div
                        role="alertdialog"
                        aria-label={t(
                          "privateManager.deleteCommittedDialogAria",
                          { page: page.page_number },
                        )}
                        className="flex flex-col gap-2 rounded-control border border-rose-300 bg-rose-50 p-3 text-xs text-rose-950"
                      >
                        <p className="font-bold">
                          {t("privateManager.deleteCommittedDialogTitle", {
                            page: page.page_number,
                          })}
                        </p>
                        <p>{t("privateManager.deleteCommittedDialogBody")}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            className="min-h-9 w-auto bg-rose-700 px-3 text-xs text-white hover:bg-rose-800"
                            isLoading={
                              busyKey === `page-delete:${page.page_id}`
                            }
                            onClick={() => void handleDeleteCommittedPage(page)}
                            type="button"
                          >
                            {t("myBooks.confirmDelete")}
                          </Button>
                          <Button
                            className="min-h-9 w-auto px-3 text-xs"
                            onClick={() => setConfirmDeletePageId(null)}
                            type="button"
                            variant="secondary"
                          >
                            {t("reportDialog.cancel")}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
            <PaginationBar
              ariaLabel={t("privateManager.committedPaginationAria")}
              compact
              itemLabel={t("privateManager.pageItemLabel")}
              onPageChange={setCommittedPage}
              page={safeCommittedPage}
              pageSize={COMMITTED_PAGES_PAGE_SIZE}
              total={committedPages.length}
            />
          </>
        )}
      </section>
    </section>
  );
}
