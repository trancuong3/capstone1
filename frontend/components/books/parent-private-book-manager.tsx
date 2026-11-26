"use client";

import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Clock3,
  FileUp,
  Image as ImageIcon,
  Lock,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { BookCover } from "@/components/books/book-cover";
import { BookCoverStudio } from "@/components/books/book-cover-studio";
import { ParentOcrContributionCard } from "@/components/books/parent-ocr-contribution-card";
import { AuthenticatedImage } from "@/components/common/authenticated-image";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useParentPrivateBookService } from "@/hooks/use-parent-private-book-service";
import { clearPrivateMediaMemoryCache } from "@/lib/api/api-client";
import {
  fetchOcrWorkerHealth,
  type OcrWorkerHealthSnapshot,
} from "@/lib/api/page-match-service";
import { isServiceError } from "@/lib/api/service-error";
import { preprocessScanImage } from "@/lib/reading/scan-image-preprocess";
import { CHILD_GRADES } from "@/types/child";
import type { BookPresentationAssetDTO } from "@/types/book-assets";
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

const STAGE_LABELS: Record<string, string> = {
  PENDING: "Đang xếp hàng chờ OCR",
  RUNNING: "Đang nhận diện OCR",
  COMPLETED: "Hoàn tất",
  PASSED: "Đạt",
  FLAGGED: "Có cảnh báo",
  NO_TEXT_DETECTED: "Trang ảnh / không có chữ",
  SKIPPED: "Bỏ qua (ảnh)",
  FAILED: "Lỗi",
};

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

function describeToolCheckScope(scope: ToolCheckScopeDTO): string {
  const parts: string[] = [];
  if (scope.modality === "TEXT_ONLY") {
    parts.push("Kiểm tra an toàn trẻ em dựa trên văn bản OCR");
  } else {
    parts.push(`Phạm vi: ${scope.modality}`);
  }
  if (scope.local_ai_enforced) {
    parts.push("chạy mô hình cục bộ (Ollama local)");
  } else {
    parts.push(
      "soát chính tả & kiểm tra an toàn qua dịch vụ AI đám mây bảo mật",
    );
  }
  if (!scope.image_visual_safety_checked) {
    parts.push("chưa tự động phân tích hình ảnh minh họa");
  }
  if (scope.copyright_scanner_status === "NOT_CONFIGURED") {
    parts.push("chưa có công cụ quét bản quyền tự động");
  }
  if (scope.total_chunks > 0) {
    parts.push(
      `đã kiểm tra ${scope.chunks_checked}/${scope.total_chunks} đoạn`,
    );
  }
  return `${parts.join("; ")}.`;
}

function lockReasonForSubmission(sub: ParentPageSubmissionDTO): string | null {
  if (sub.can_add_to_book) return null;
  if (sub.workflow_status === "ADDED_TO_BOOK") {
    return "Trang này đã được thêm vào sách đọc.";
  }
  if (sub.tool_check_policy_blocked) {
    return "Nội dung vi phạm mức chặn an toàn trẻ em. Hãy sửa nội dung hoặc thay ảnh trang khác.";
  }
  if (sub.workflow_status === "CHECKING") {
    return "Đang chạy OCR, rà chính tả và kiểm tra an toàn.";
  }
  if (sub.workflow_status === "NEEDS_ADMIN_REVIEW") {
    return "Tool Check đã gắn cờ hoặc trang cần người xem xét. Phải gửi Admin duyệt đúng phiên bản này trước khi thêm vào sách.";
  }
  if (sub.workflow_status === "PENDING_ADMIN") {
    return "Đang chờ Admin duyệt đúng phiên bản này.";
  }
  if (sub.workflow_status === "REJECTED") {
    return "Admin đã từ chối phiên bản này. Hãy sửa nội dung hoặc tải lại trang khác.";
  }
  if (sub.workflow_status === "CHECK_FAILED") {
    return "Bước kiểm tra gặp lỗi. Hãy bấm Thử lại kiểm tra trước khi thêm trang.";
  }
  if (sub.workflow_status === "NEEDS_RECHECK") {
    return "Nội dung đã thay đổi và cần kiểm tra lại trước khi thêm vào sách.";
  }
  if (sub.proofread_suggestions.length > 0 && !sub.spelling_accepted) {
    return "Vui lòng xem và chấp nhận đề xuất chính tả trước khi thêm vào sách.";
  }
  return "Trang chưa đủ điều kiện để thêm vào sách đọc.";
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
): string | null {
  if (!code) return null;
  const upper = code.toUpperCase();
  if (upper.includes("TIMEOUT")) {
    return "Xử lý quá thời gian chờ do mạng hoặc dịch vụ bận — bấm Thử lại kiểm tra cho trang này.";
  }
  if (
    upper.includes("UNAVAILABLE") ||
    upper.includes("OFFLINE") ||
    upper.includes("CONNECT") ||
    upper.includes("WORKER")
  ) {
    return "Dịch vụ OCR/AI tạm dừng hoặc đang khởi động — các trang khác vẫn giữ nguyên, bạn có thể thử lại riêng trang này.";
  }
  if (
    upper.includes("BUSY") ||
    upper.includes("RATE") ||
    upper.includes("429")
  ) {
    return "Hàng đợi xử lý đang quá tải — chờ ít giây rồi bấm Thử lại kiểm tra.";
  }
  if (upper.includes("OCR")) {
    return "Chưa đọc được chữ rõ từ ảnh trang — hãy thử lại hoặc tải ảnh sắc nét hơn.";
  }
  return null;
}

const SUBMISSIONS_PAGE_SIZE = 10;
const COMMITTED_PAGES_PAGE_SIZE = 12;

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
  const service = useParentPrivateBookService();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const detailRequestIdRef = useRef(0);
  const backHref =
    returnPage > 1 ? `/my-books?page=${Math.floor(returnPage)}` : "/my-books";

  const [detail, setDetail] = useState<ParentPrivateBookDetailDTO | null>(null);
  const [ocrWorkerHealth, setOcrWorkerHealth] =
    useState<OcrWorkerHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] =
    useState<SubmissionFilterGroup>("ALL");
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
          setLoadError(
            errorText(
              error,
              "Không thể tải chi tiết sách riêng. Vui lòng thử lại.",
            ),
          );
        }
      } finally {
        if (!silent && requestId === detailRequestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [bookId, service],
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
          setLoadError(
            errorText(
              error,
              "Không thể tải chi tiết sách riêng. Vui lòng thử lại.",
            ),
          );
        }
      })
      .finally(() => {
        if (requestId === detailRequestIdRef.current) setLoading(false);
      });
    return () => {
      detailRequestIdRef.current += 1;
      controller.abort();
    };
  }, [bookId, currentUserId, service]);

  // Auto-poll while any submission is CHECKING with exponential backoff (3s -> 15s),
  // in-flight overlap guard, tab-visibility pause, and throttled /health checks (<= 1/30s).
  const hasCheckingSubmission = Boolean(
    detail?.submissions.some((sub) => sub.workflow_status === "CHECKING"),
  );
  const pollInFlightRef = useRef(false);
  const lastHealthCheckAtRef = useRef(0);
  const workerOnlineRef = useRef<boolean | null>(null);
  useEffect(() => {
    workerOnlineRef.current = ocrWorkerHealth?.workerOnline ?? null;
  }, [ocrWorkerHealth]);

  useEffect(() => {
    if (!hasCheckingSubmission) return;
    let active = true;
    let timerId: number | null = null;
    let idleTicks = 0;
    const BASE_POLL_MS = 3_000;
    const MAX_POLL_MS = 15_000;
    const HEALTH_POLL_MIN_INTERVAL_MS = 30_000;

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };
    const maybePollWorkerHealth = async (force = false) => {
      const now = Date.now();
      if (
        !force &&
        now - lastHealthCheckAtRef.current < HEALTH_POLL_MIN_INTERVAL_MS
      ) {
        return;
      }
      lastHealthCheckAtRef.current = now;
      const snapshot = await fetchOcrWorkerHealth();
      if (active && snapshot) {
        setOcrWorkerHealth(snapshot);
      }
    };

    const nextDelayMs = () => {
      const offline = workerOnlineRef.current === false;
      const step = offline
        ? Math.min(4, idleTicks + 1)
        : Math.min(3, idleTicks);
      return Math.min(
        MAX_POLL_MS,
        Math.round(BASE_POLL_MS * Math.pow(1.6, step)),
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
        void maybePollWorkerHealth(false).catch(() => undefined);
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

    void maybePollWorkerHealth(true);
    scheduleNext(BASE_POLL_MS);
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
  }, [hasCheckingSubmission, loadDetail]);

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setActionNotice(null);
    if (!selectedFile) {
      setActionError("Vui lòng chọn ảnh trang sách hoặc tài liệu PDF/DOCX.");
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
        `Đã nhận ${response.total_pages} trang từ tệp (${response.source_format}). Hệ thống đang chạy OCR, rà chính tả và kiểm tra an toàn.`,
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(
          error,
          "Không thể tải tệp lên. Kiểm tra định dạng (JPEG/PNG/WebP/BMP/TIFF/PDF/DOCX), dung lượng (≤ 50 MB) và số trang (≤ 30 trang).",
        ),
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
      await service.acceptSpelling(
        bookId,
        sub.id,
        sub.submission_version,
        sub.candidate_hash,
      );
      setActionNotice(
        `Đã xác nhận đề xuất chính tả cho trang nguồn ${sub.source_page_number}.`,
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, "Không thể xác nhận chính tả. Vui lòng tải lại."),
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
          ? `Đã thêm trang ${result.page_number} vào sách riêng. Bé đã có thể mở sách để đọc!`
          : `Đã thêm trang ${result.page_number} vào sách. Hãy hoàn tất các trang đang giữ lại trong cùng tài liệu để bé có thể đọc trọn bộ.`,
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(
          error,
          "Không thể thêm trang vào sách. Phiên bản hoặc trạng thái duyệt chưa hợp lệ.",
        ),
      );
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
      await service.requestAdminReview(bookId, sub.id, {
        expected_submission_version: sub.submission_version,
        expected_candidate_hash: sub.candidate_hash,
        source_type: reviewSourceType,
        source_note: reviewSourceNote.trim() || null,
        request_note: reviewRequestNote.trim() || null,
      });
      setReviewFormSubId(null);
      setReviewRequestNote("");
      setActionNotice(
        `Đã gửi phiên bản v${sub.submission_version} sang Admin để xem xét.`,
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(
          error,
          "Không thể gửi yêu cầu xem xét tới Admin. Vui lòng tải lại.",
        ),
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
        `Đã xếp hàng thử lại bước bị lỗi (giữ nguyên các bước đã hoàn tất trước đó).`,
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(errorText(error, "Không thể thử lại kiểm tra lúc này."));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSaveEdit(sub: ParentPageSubmissionDTO) {
    setBusyKey(`edit:${sub.id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await service.editSubmission(bookId, sub.id, {
        candidate_text: editText,
        source_type: editSourceType,
        source_note: editSourceNote.trim() || null,
        expected_lock_version: sub.optimistic_lock_version,
        auto_recheck: true,
      });
      setEditingSubId(null);
      setActionNotice(
        "Đã tạo phiên bản mới từ chỉnh sửa của bạn và xếp hàng kiểm tra lại từ đầu (Rà chính tả → Tool Check an toàn).",
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, "Không thể lưu chỉnh sửa trang. Vui lòng tải lại."),
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
      setActionError("Tên sách riêng không được để trống.");
      return;
    }
    if (editBookMinGrade > editBookMaxGrade) {
      setActionError("Lớp tối thiểu không được lớn hơn lớp tối đa.");
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
          ? `Đã sửa sách "${updated.title}". Toàn bộ ${updated.pending_submission_count} trang đã được đưa về kiểm tra lại từ đầu (OCR → Rà chính tả → Tool Check an toàn).`
          : `Đã cập nhật thông tin sách "${updated.title}".`,
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, "Không thể sửa thông tin sách. Vui lòng thử lại."),
      );
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
      router.push(backHref);
    } catch (error) {
      setActionError(
        errorText(error, "Không thể xóa sách riêng. Vui lòng thử lại."),
      );
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
      await service.editCommittedPage(bookId, page.page_id, {
        candidate_text: editPageText,
        page_number: editPageNumber,
        source_type: editPageSourceType,
        source_note: editPageSourceNote.trim() || null,
        auto_recheck: true,
      });
      setEditingPageId(null);
      setActionNotice(
        `Đã sửa trang ${page.page_number}. Trang đã được tạm gỡ khỏi sách đọc và xếp hàng kiểm tra lại từ đầu.`,
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, "Không thể sửa trang này. Vui lòng kiểm tra lại."),
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
      await service.replaceCommittedPageFile(bookId, page.page_id, file);
      setEditingPageId(null);
      setActionNotice(
        `Đã thay ảnh trang ${page.page_number}. Trang đã được tạm gỡ khỏi sách đọc và đang chạy kiểm tra lại toàn bộ từ đầu (OCR → Rà chính tả → Tool Check an toàn).`,
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(
          error,
          "Không thể thay ảnh cho trang này. Hãy chọn đúng 1 ảnh hợp lệ.",
        ),
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
        `Đã xóa trang ${page.page_number} khỏi sách đọc (không cần kiểm tra lại các trang khác).`,
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(error, "Không thể xóa trang này. Vui lòng thử lại."),
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
        "Đã thay ảnh trang mới. Kết quả kiểm tra và phê duyệt cũ đã bị hủy; hệ thống đang kiểm tra lại toàn bộ.",
      );
      await loadDetail(true);
    } catch (error) {
      setActionError(
        errorText(
          error,
          "Không thể thay ảnh trang. Hãy chọn đúng 1 ảnh hợp lệ.",
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
      setActionNotice("Đã hủy bản tải lên đang chờ.");
      await loadDetail(true);
    } catch (error) {
      setActionError(errorText(error, "Không thể hủy trang này."));
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
              <ArrowLeft aria-hidden="true" className="size-4" />
              Về Sách của tôi
            </ButtonLink>
          }
          description="Sách riêng không tồn tại hoặc không thuộc tài khoản của bạn."
          title="Không tìm thấy sách riêng"
        />
      </section>
    );
  }

  if (loadError || !detail) {
    return (
      <section className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-10">
        <StatusMessage title="Chưa tải được sách riêng" tone="error">
          {loadError ?? "Không thể tải dữ liệu."}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start"
          onClick={() => void loadDetail(false)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          Thử lại
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
  const ocrWorkerOffline =
    ocrWorkerHealth !== null && !ocrWorkerHealth.workerOnline;
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
  const submissionsTotalPages = Math.max(
    1,
    Math.ceil(filteredSubmissions.length / SUBMISSIONS_PAGE_SIZE),
  );
  const safeSubmissionsPage = Math.min(submissionsPage, submissionsTotalPages);
  const visibleSubmissions = filteredSubmissions.slice(
    (safeSubmissionsPage - 1) * SUBMISSIONS_PAGE_SIZE,
    safeSubmissionsPage * SUBMISSIONS_PAGE_SIZE,
  );
  const committedTotalPages = Math.max(
    1,
    Math.ceil(committedPages.length / COMMITTED_PAGES_PAGE_SIZE),
  );
  const safeCommittedPage = Math.min(committedPage, committedTotalPages);
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
          <ArrowLeft aria-hidden="true" className="size-4" />
          Quay lại Sách của tôi
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="w-auto"
            fullWidth={false}
            onClick={() => void loadDetail(false)}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Làm mới trạng thái
          </Button>
          {book.readable_for_children && !isSuspended ? (
            <ButtonLink
              href={`/books/${encodeURIComponent(book.id)}`}
              className="w-auto"
              fullWidth={false}
            >
              <BookOpen aria-hidden="true" className="size-4" />
              Mở đọc cùng bé
            </ButtonLink>
          ) : (
            <Button className="w-auto" disabled fullWidth={false} type="button">
              <BookOpen aria-hidden="true" className="size-4" />
              Chưa mở đọc cùng bé
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
                  Sách riêng của gia đình
                </span>
                <span className="text-xs font-semibold text-muted">
                  Lớp {book.min_grade}
                  {book.min_grade !== book.max_grade
                    ? `–${book.max_grade}`
                    : ""}
                </span>
                <span className="text-xs text-muted">·</span>
                <span className="text-xs font-semibold text-ink">
                  {book.committed_page_count} trang đã thêm vào sách đọc
                </span>
              </div>
              <h1 className="book-title mt-2 break-words text-3xl text-ink sm:text-4xl">
                {book.title}
              </h1>
              {book.author ? (
                <p className="mt-1 break-words text-sm text-muted">
                  Tác giả: {book.author}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted">{book.privacy_notice}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="min-h-10 w-auto px-3 text-xs"
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
              {showCoverStudio ? "Đóng ảnh bìa" : "Đổi ảnh bìa"}
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
              Sửa sách
            </Button>
            <button
              aria-label={`Xóa sách ${book.title}`}
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
              Xóa sách
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
            aria-label="Chỉnh sửa thông tin sách riêng"
            className="flex flex-col gap-3 rounded-control border border-amber-300 bg-amber-50/60 p-4 text-xs"
            onSubmit={(event) => void handleSaveBookEdit(event)}
          >
            <p className="font-bold text-amber-950">
              Lưu ý: Khi sửa thông tin sách, toàn bộ các trang của sách sẽ được
              đưa về kiểm tra lại từ đầu (OCR → Rà chính tả → Tool Check an
              toàn) và tạm khóa đọc cùng bé cho đến khi hoàn tất.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 font-semibold text-ink">
                Tên sách *
                <input
                  aria-label="Tên sách chỉnh sửa"
                  className="min-h-10 rounded-control border border-border bg-white px-3 text-sm text-ink"
                  onChange={(event) => setEditBookTitle(event.target.value)}
                  required
                  type="text"
                  value={editBookTitle}
                />
              </label>
              <label className="flex flex-col gap-1 font-semibold text-ink">
                Tác giả
                <input
                  aria-label="Tác giả chỉnh sửa"
                  className="min-h-10 rounded-control border border-border bg-white px-3 text-sm text-ink"
                  onChange={(event) => setEditBookAuthor(event.target.value)}
                  type="text"
                  value={editBookAuthor}
                />
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 font-semibold text-ink">
                Từ lớp
                <select
                  aria-label="Từ lớp chỉnh sửa"
                  className="min-h-10 rounded-control border border-border bg-white px-2.5 text-sm text-ink"
                  onChange={(event) =>
                    setEditBookMinGrade(Number(event.target.value))
                  }
                  value={editBookMinGrade}
                >
                  {CHILD_GRADES.map((grade) => (
                    <option key={grade} value={grade}>
                      Lớp {grade}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 font-semibold text-ink">
                Đến lớp
                <select
                  aria-label="Đến lớp chỉnh sửa"
                  className="min-h-10 rounded-control border border-border bg-white px-2.5 text-sm text-ink"
                  onChange={(event) =>
                    setEditBookMaxGrade(Number(event.target.value))
                  }
                  value={editBookMaxGrade}
                >
                  {CHILD_GRADES.map((grade) => (
                    <option key={grade} value={grade}>
                      Lớp {grade}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 font-semibold text-ink">
                Nguồn nội dung sách
                <select
                  aria-label="Nguồn nội dung sách chỉnh sửa"
                  className="min-h-10 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                  onChange={(event) =>
                    setEditBookSourceType(event.target.value as SourceUsageType)
                  }
                  value={editBookSourceType}
                >
                  {SOURCE_USAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 font-semibold text-ink">
                Ghi chú nguồn
                <input
                  aria-label="Ghi chú nguồn sách chỉnh sửa"
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
                Lưu & kiểm tra lại toàn bộ
              </Button>
              <Button
                className="min-h-10 w-auto px-3 text-xs"
                onClick={() => setShowEditBookForm(false)}
                type="button"
                variant="secondary"
              >
                Hủy
              </Button>
            </div>
          </form>
        ) : null}

        {confirmDeleteBook ? (
          <div
            role="alertdialog"
            aria-label={`Xác nhận xóa sách ${book.title}`}
            className="flex flex-col gap-2.5 rounded-control border border-rose-300 bg-rose-50 p-4 text-xs text-rose-950"
          >
            <p className="font-bold">
              Xác nhận xóa sách &ldquo;{book.title}&rdquo;?
            </p>
            <p>
              Sách và các trang thuộc sách này sẽ bị xóa ngay khỏi Sách của tôi
              và không cần kiểm tra lại.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-h-10 w-auto bg-rose-700 px-4 text-xs text-white hover:bg-rose-800"
                isLoading={busyKey === "book:delete"}
                onClick={() => void handleDeleteBook()}
                type="button"
              >
                Xác nhận xóa sách
              </Button>
              <Button
                className="min-h-10 w-auto px-3 text-xs"
                onClick={() => setConfirmDeleteBook(false)}
                type="button"
                variant="secondary"
              >
                Hủy
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
        <StatusMessage title="Sách riêng đang bị đình chỉ" tone="error">
          {book.suspended_reason
            ? `Lý do từ Admin: ${book.suspended_reason}. `
            : ""}
          Bé không thể mở đọc hoặc tải thêm trang cho tới khi vấn đề được xử lý.
        </StatusMessage>
      ) : null}

      {book.has_held_multipage_batch ? (
        <StatusMessage
          title="Tài liệu nhiều trang đang có trang bị giữ lại"
          tone="warning"
        >
          Có ít nhất một trang trong cùng tệp tải lên đang kiểm tra hoặc cần
          Admin duyệt. Sách sẽ chỉ mở đọc cho bé khi toàn bộ trang hợp lệ trong
          tệp đã được thêm hoặc các trang bị giữ đã được hủy/xử lý.
        </StatusMessage>
      ) : null}

      {actionError ? (
        <StatusMessage title="Không thể thực hiện" tone="error">
          {actionError}
        </StatusMessage>
      ) : null}

      {actionNotice ? (
        <StatusMessage title="Cập nhật thành công" tone="success">
          {actionNotice}
        </StatusMessage>
      ) : null}

      {/* Upload Section */}
      <form
        aria-label="Tải ảnh trang hoặc tài liệu vào sách riêng"
        className="flex flex-col gap-4 rounded-card border border-border bg-white p-5 shadow-sm"
        onSubmit={(event) => void handleUpload(event)}
      >
        <div>
          <h2 className="text-xl font-extrabold text-ink">
            Tải ảnh trang hoặc tài liệu
          </h2>
          <p className="mt-1 text-sm text-muted">
            Hỗ trợ JPEG, PNG, WebP, BMP, TIFF, PDF, DOCX · tối đa{" "}
            <strong>30 trang mỗi tệp</strong> (≤ 50 MB). Mỗi trang tự động chạy:{" "}
            <strong>OCR → Rà chính tả → Tool Check an toàn</strong>.
          </p>
          <p className="mt-1 text-xs text-muted">
            Minh bạch quyền riêng tư: Sách riêng chỉ hiển thị trong tài khoản
            gia đình; văn bản trang sách tải lên được rà soát chính tả và an
            toàn trẻ em tự động (mô hình cục bộ hoặc dịch vụ AI đám mây bảo mật
            tùy cấu hình máy chủ) và mặc định không dùng để huấn luyện OCR.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-label font-semibold text-ink">
            Chọn tệp trang sách hoặc tài liệu *
            <input
              ref={fileInputRef}
              accept={ACCEPTED_UPLOAD_EXTENSIONS}
              aria-label="Chọn tệp trang sách hoặc tài liệu"
              className="block w-full cursor-pointer rounded-control border border-dashed border-primary/50 bg-canvas p-3 text-sm text-ink file:mr-3 file:rounded-control file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white hover:file:bg-primary-hover"
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
                Đã chọn: {selectedFile.name} (
                {(selectedFile.size / 1024).toFixed(1)} KB)
              </span>
            ) : null}
          </label>

          <label className="flex flex-col gap-1.5 text-label font-semibold text-ink">
            Khai báo nguồn nội dung (phục vụ gia đình / rà soát)
            <select
              aria-label="Khai báo nguồn nội dung"
              className="min-h-12 rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
              disabled={uploading || isSuspended}
              onChange={(event) =>
                setUploadSourceType(event.target.value as SourceUsageType)
              }
              value={uploadSourceType}
            >
              {SOURCE_USAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1.5 text-label font-semibold text-ink">
          Ghi chú nguồn / bản quyền (không bắt buộc)
          <input
            aria-label="Ghi chú nguồn hoặc bản quyền"
            className="min-h-11 rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
            disabled={uploading || isSuspended}
            onChange={(event) => setUploadSourceNote(event.target.value)}
            placeholder="Ví dụ: Chụp từ sách giấy gia đình đã mua cho bé luyện đọc"
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
            {uploading ? "Đang tải lên và xếp hàng…" : "Tải lên & kiểm tra"}
          </Button>
          {hasCheckingSubmission ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
              <Clock3 aria-hidden="true" className="size-4 animate-spin" />
              Đang tự động cập nhật tiến trình kiểm tra…
            </span>
          ) : null}
        </div>
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
          Các trang đang kiểm tra & duyệt ({activeSubmissions.length})
        </h2>

        {activeSubmissions.length === 0 ? (
          <div className="rounded-card border border-dashed border-border bg-white p-6 text-center text-sm text-muted">
            Chưa có trang nào được tải lên. Hãy chọn ảnh hoặc tệp PDF/DOCX ở
            trên để bắt đầu chạy OCR, rà chính tả và kiểm tra an toàn.
          </div>
        ) : (
          <>
            <div
              aria-label="Lọc trạng thái từng trang"
              className="flex flex-wrap items-center gap-2"
              role="group"
            >
              {(
                [
                  {
                    key: "ALL",
                    label: `Tất cả (${activeSubmissions.length})`,
                  },
                  {
                    key: "CHECKING",
                    label: `Đang kiểm tra (${submissionCounts.CHECKING})`,
                  },
                  {
                    key: "READY",
                    label: `Sẵn sàng thêm (${submissionCounts.READY})`,
                  },
                  {
                    key: "ADMIN",
                    label: `Chờ / Cần Admin (${submissionCounts.ADMIN})`,
                  },
                  {
                    key: "FAILED",
                    label: `Lỗi kiểm tra (${submissionCounts.FAILED})`,
                  },
                  {
                    key: "ADDED",
                    label: `Đã thêm (${submissionCounts.ADDED})`,
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
              <div
                aria-label="Tổng quan nhanh trạng thái các trang"
                className="flex flex-wrap gap-1.5 border-t border-border pt-3"
              >
                {activeSubmissions.map((sub, index) => {
                  const chipStyle =
                    WORKFLOW_BADGE_STYLES[sub.workflow_status] ??
                    "border-border bg-canvas text-ink";
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
                      title={`Trang nguồn ${sub.source_page_number}: ${sub.workflow_status_label}`}
                      type="button"
                    >
                      <span>Tr.{sub.source_page_number}</span>
                      <span className="font-normal">
                        · {sub.workflow_status_label}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {workerFailureCount > 0 || submissionCounts.CHECKING > 0 ? (
              <div
                className="rounded-control border border-amber-300 bg-amber-50/80 px-3 py-2 text-xs text-amber-950"
                data-testid="private-book-ocr-queue-banner"
              >
                {workerFailureCount > 0 ? (
                  <p className="font-semibold">
                    Có {workerFailureCount} trang gặp lỗi OCR/AI (dịch vụ kiểm
                    tra có thể đang bận hoặc tạm ngắt). Các trang đạt chuẩn hoặc
                    chờ Admin bên cạnh không bị ảnh hưởng — hãy bấm «Thử lại
                    kiểm tra» ở từng trang bị lỗi.
                  </p>
                ) : ocrWorkerOffline && pendingOcrCount > 0 ? (
                  <p className="font-semibold">
                    Đang chờ máy chủ OCR Windows bật (hàng đợi an toàn —{" "}
                    {pendingOcrCount} trang đã được lưu an toàn và sẽ tự động
                    nhận diện ngay khi máy chủ OCR hoạt động).
                  </p>
                ) : runningOcrCount > 0 ? (
                  <p className="font-semibold">
                    Đang nhận diện OCR {runningOcrCount} trang
                    {pendingOcrCount > 0
                      ? ` (${pendingOcrCount} trang đang xếp hàng tiếp theo)`
                      : ""}
                    . Các trang đã kiểm tra xong vẫn hiển thị đầy đủ để bạn thao
                    tác ngay.
                  </p>
                ) : (
                  <p className="font-semibold">
                    {pendingOcrCount > 0
                      ? `Đang xếp hàng chờ OCR cho ${pendingOcrCount} trang`
                      : `Đang xử lý song song ${submissionCounts.CHECKING} trang ở chế độ nền`}
                    . Các trang đã kiểm tra xong vẫn hiển thị đầy đủ để bạn thao
                    tác ngay.
                  </p>
                )}
              </div>
            ) : null}
            {visibleSubmissions.length === 0 ? (
              <div className="rounded-card border border-dashed border-border bg-white p-6 text-center text-sm text-muted">
                Không có trang nào thuộc nhóm trạng thái đang lọc.
              </div>
            ) : null}
            <div className="flex flex-col gap-4">
              {visibleSubmissions.map((sub) => {
                const badgeStyle =
                  WORKFLOW_BADGE_STYLES[sub.workflow_status] ??
                  "border-border bg-canvas text-ink";
                const lockReason = lockReasonForSubmission(sub);
                const isEditing = editingSubId === sub.id;
                const isReviewFormOpen = reviewFormSubId === sub.id;
                const isSubBusy =
                  busyKey !== null && busyKey.endsWith(`:${sub.id}`);

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
                            alt={`Ảnh trang nguồn ${sub.source_page_number} của ${sub.source_file_name}`}
                            className="h-full w-full object-contain p-2"
                            src={sub.image_url}
                          />
                        </div>
                        <p className="mt-1.5 truncate text-xs text-muted">
                          {sub.source_file_name} · Trang nguồn{" "}
                          {sub.source_page_number}/{sub.batch_total_pages}
                        </p>
                        <p className="text-[11px] font-mono text-muted">
                          Phiên bản v{sub.submission_version}
                          {sub.candidate_hash
                            ? ` · #${sub.candidate_hash.slice(0, 8)}`
                            : ""}
                        </p>
                      </div>

                      {/* Details & Pipeline Stages */}
                      <div className="flex min-w-0 flex-1 flex-col gap-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-bold ${badgeStyle}`}
                            >
                              {sub.workflow_status_label}
                            </span>
                            {sub.is_image_only ? (
                              <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-950">
                                Trang chỉ có hình / không đọc được chữ
                              </span>
                            ) : null}
                            {sub.tool_check_policy_blocked ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-rose-400 bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-900">
                                <ShieldAlert
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                Chặn theo chính sách an toàn
                              </span>
                            ) : null}
                          </div>

                          {sub.workflow_status !== "ADDED_TO_BOOK" ? (
                            <button
                              aria-label={`Hủy trang nguồn ${sub.source_page_number}`}
                              className="inline-flex min-h-9 items-center gap-1 rounded-control border border-border px-2.5 text-xs font-semibold text-muted hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
                              disabled={isSubBusy}
                              onClick={() => void handleCancelSubmission(sub)}
                              type="button"
                            >
                              <Trash2 aria-hidden="true" className="size-3.5" />
                              Hủy trang
                            </button>
                          ) : null}
                        </div>

                        {/* 3-Stage Status Strip */}
                        <div
                          aria-label="Tiến trình 3 bước kiểm tra"
                          className="grid gap-2 sm:grid-cols-3"
                        >
                          <div className="rounded-control border border-border bg-canvas px-3 py-2 text-xs">
                            <p className="font-bold text-ink">
                              1. OCR tiếng Việt
                            </p>
                            <p className="mt-0.5 text-muted">
                              {sub.ocr_status === "PENDING" && ocrWorkerOffline
                                ? "Chờ máy chủ OCR Windows bật"
                                : (STAGE_LABELS[sub.ocr_status] ??
                                  sub.ocr_status)}
                              {sub.ocr_error_code
                                ? ` (${sub.ocr_error_code})`
                                : ""}
                            </p>
                            {describeStageErrorHint(sub.ocr_error_code) ? (
                              <p className="mt-1 text-[11px] font-medium text-rose-800">
                                {describeStageErrorHint(sub.ocr_error_code)}
                              </p>
                            ) : null}
                          </div>
                          <div className="rounded-control border border-border bg-canvas px-3 py-2 text-xs">
                            <p className="font-bold text-ink">2. Rà chính tả</p>
                            <p className="mt-0.5 text-muted">
                              {STAGE_LABELS[sub.proofread_status] ??
                                sub.proofread_status}
                              {sub.proofread_suggestions.length > 0
                                ? ` · ${sub.proofread_suggestions.length} đề xuất`
                                : ""}
                              {sub.proofread_error_code
                                ? ` (${sub.proofread_error_code})`
                                : ""}
                            </p>
                            {describeStageErrorHint(
                              sub.proofread_error_code,
                            ) ? (
                              <p className="mt-1 text-[11px] font-medium text-rose-800">
                                {describeStageErrorHint(
                                  sub.proofread_error_code,
                                )}
                              </p>
                            ) : null}
                          </div>
                          <div className="rounded-control border border-border bg-canvas px-3 py-2 text-xs">
                            <p className="font-bold text-ink">
                              3. Tool Check an toàn
                            </p>
                            <p className="mt-0.5 text-muted">
                              {STAGE_LABELS[sub.tool_check_status] ??
                                sub.tool_check_status}
                              {sub.tool_check_findings_count > 0
                                ? ` · ${sub.tool_check_findings_count} cảnh báo`
                                : ""}
                              {sub.tool_check_error_code
                                ? ` (${sub.tool_check_error_code})`
                                : ""}
                            </p>
                            {describeStageErrorHint(
                              sub.tool_check_error_code,
                            ) ? (
                              <p className="mt-1 text-[11px] font-medium text-rose-800">
                                {describeStageErrorHint(
                                  sub.tool_check_error_code,
                                )}
                              </p>
                            ) : null}
                          </div>
                        </div>

                        {/* Tool Check Scope Disclosure */}
                        <p className="rounded-control border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                          <strong>Phạm vi Tool Check:</strong>{" "}
                          {describeToolCheckScope(sub.tool_check_scope)}
                        </p>

                        {/* Parent Notice from Tool Check (non-sensitive summary) */}
                        {sub.tool_check_parent_notice ||
                        sub.tool_check_findings_count > 0 ? (
                          <div className="rounded-control border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                            <p className="flex items-center gap-1.5 font-bold">
                              <AlertTriangle
                                aria-hidden="true"
                                className="size-4 shrink-0"
                              />
                              {sub.tool_check_findings_count > 0
                                ? `Tool Check phát hiện ${sub.tool_check_findings_count} điểm cần người lớn xem xét.`
                                : "Trang cần Admin xem xét trước khi thêm vào sách."}
                            </p>
                            {sub.tool_check_parent_notice ? (
                              <p className="mt-1">
                                {sub.tool_check_parent_notice}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {/* Candidate Text Preview */}
                        {sub.candidate_text ? (
                          <div className="rounded-control border border-border bg-canvas/70 p-3">
                            <p className="text-xs font-bold text-ink">
                              Nội dung dự kiến thêm vào sách:
                            </p>
                            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">
                              {sub.candidate_text}
                            </p>
                          </div>
                        ) : null}

                        {/* Spelling Suggestions */}
                        {sub.proofread_suggestions.length > 0 ? (
                          <div className="rounded-control border border-sky-200 bg-sky/40 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs font-bold text-primary-hover">
                                Đề xuất chính tả (
                                {sub.proofread_suggestions.length})
                                {sub.uncertain_word_indices.length > 0
                                  ? ` · ${sub.uncertain_word_indices.length} từ cần chú ý`
                                  : ""}
                              </p>
                              {sub.spelling_accepted ? (
                                <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800">
                                  <CheckCircle2
                                    aria-hidden="true"
                                    className="size-3.5"
                                  />
                                  Đã chấp nhận đề xuất
                                </span>
                              ) : (
                                <Button
                                  className="min-h-9 w-auto px-3 text-xs"
                                  disabled={isSubBusy}
                                  onClick={() => void handleAcceptSpelling(sub)}
                                  type="button"
                                  variant="secondary"
                                >
                                  Chấp nhận đề xuất chính tả
                                </Button>
                              )}
                            </div>
                            <ul className="mt-2 space-y-1 text-xs text-ink">
                              {sub.proofread_suggestions
                                .slice(0, 6)
                                .map((s, idx) => (
                                  <li key={idx}>
                                    <span className="line-through text-rose-700">
                                      {s.original}
                                    </span>{" "}
                                    →{" "}
                                    <span className="font-bold text-emerald-800">
                                      {s.suggested}
                                    </span>
                                    {s.uncertain ? (
                                      <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-900">
                                        cần kiểm tra
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
                              Quyết định từ Admin:{" "}
                              {sub.admin_decision === "APPROVE"
                                ? "Đã phê duyệt đúng phiên bản này"
                                : sub.admin_decision === "REQUEST_CHANGES"
                                  ? "Yêu cầu chỉnh sửa"
                                  : "Đã từ chối"}
                            </p>
                            {sub.admin_decision_reason ? (
                              <p className="mt-1">
                                Lý do: {sub.admin_decision_reason}
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {/* Inline Edit Text / Source Drawer */}
                        {isEditing ? (
                          <div className="rounded-control border border-primary/40 bg-canvas p-3">
                            <p className="text-xs font-bold text-ink">
                              Chỉnh sửa nội dung hoặc nguồn trang
                            </p>
                            <p className="mt-0.5 text-xs text-amber-900">
                              Lưu ý: Chỉnh sửa sẽ tạo phiên bản mới, hủy kết quả
                              kiểm tra / phê duyệt cũ và kiểm tra lại từ đầu (Rà
                              chính tả → Tool Check an toàn).
                            </p>
                            <textarea
                              aria-label="Chỉnh sửa văn bản trang"
                              className="mt-2 min-h-24 w-full rounded-control border border-border bg-white p-2.5 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                              onChange={(event) =>
                                setEditText(event.target.value)
                              }
                              value={editText}
                            />
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <select
                                aria-label="Nguồn nội dung khi chỉnh sửa"
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
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                              <input
                                aria-label="Ghi chú nguồn khi chỉnh sửa"
                                className="min-h-10 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                                onChange={(event) =>
                                  setEditSourceNote(event.target.value)
                                }
                                placeholder="Ghi chú nguồn…"
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
                                Lưu phiên bản mới & kiểm tra lại
                              </Button>
                              <Button
                                className="min-h-10 w-auto px-3 text-xs"
                                onClick={() => setEditingSubId(null)}
                                type="button"
                                variant="secondary"
                              >
                                Đóng
                              </Button>
                            </div>
                          </div>
                        ) : null}

                        {/* Inline Request Admin Review Drawer */}
                        {isReviewFormOpen ? (
                          <div className="rounded-control border border-amber-400 bg-amber-50/70 p-3">
                            <p className="text-xs font-bold text-amber-950">
                              Gửi phiên bản v{sub.submission_version} sang Admin
                              xem xét
                            </p>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
                                Nguồn nội dung
                                <select
                                  aria-label="Nguồn nội dung gửi Admin"
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
                                      {opt.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
                                Ghi chú nguồn
                                <input
                                  aria-label="Ghi chú nguồn gửi Admin"
                                  className="min-h-10 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                                  onChange={(event) =>
                                    setReviewSourceNote(event.target.value)
                                  }
                                  placeholder="Ví dụ: Sách gia đình mua cho bé"
                                  value={reviewSourceNote}
                                />
                              </label>
                            </div>
                            <label className="mt-2 flex flex-col gap-1 text-xs font-semibold text-ink">
                              Lời nhắn cho Admin (giải thích ngữ cảnh)
                              <textarea
                                aria-label="Lời nhắn cho Admin"
                                className="min-h-20 rounded-control border border-border bg-white p-2 text-xs text-ink"
                                onChange={(event) =>
                                  setReviewRequestNote(event.target.value)
                                }
                                placeholder="Ví dụ: Đây là truyện ngụ ngôn lớp 2, mong Admin xem xét duyệt trang này."
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
                                Xác nhận gửi Admin
                              </Button>
                              <Button
                                className="min-h-10 w-auto px-3 text-xs"
                                onClick={() => setReviewFormSubId(null)}
                                type="button"
                                variant="secondary"
                              >
                                Hủy
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
                              Thêm trang vào sách
                            </Button>
                          ) : (
                            <span className="inline-flex min-h-10 items-center gap-1.5 rounded-control bg-teal-50 px-3 text-xs font-bold text-teal-900">
                              <CheckCircle2
                                aria-hidden="true"
                                className="size-4"
                              />
                              Đã thêm vào sách đọc
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
                              Gửi Admin xem xét
                            </Button>
                          ) : null}

                          {/* Stage-preserving Retry */}
                          {sub.can_retry ? (
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
                              Thử lại kiểm tra
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
                                Sửa nội dung
                              </Button>

                              <label className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-control border border-border bg-white px-3 text-xs font-semibold text-ink hover:bg-canvas">
                                <Upload
                                  aria-hidden="true"
                                  className="size-3.5"
                                />
                                Thay ảnh
                                <input
                                  accept={ACCEPTED_UPLOAD_EXTENSIONS}
                                  aria-label={`Thay ảnh cho trang nguồn ${sub.source_page_number}`}
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
                              className="mr-1 inline size-3.5 align-text-bottom"
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
              ariaLabel="Phân trang các trang đang kiểm tra"
              compact
              itemLabel="trang"
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
          Các trang đã thêm vào sách đọc ({committedPages.length})
        </h2>
        {committedPages.length === 0 ? (
          <p className="rounded-card border border-border bg-white p-4 text-sm text-muted">
            Chưa có trang nào trong sách đọc. Sau khi trang đạt kiểm tra (hoặc
            được Admin duyệt), bấm <strong>Thêm trang vào sách</strong> ở trên.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visibleCommittedPages.map((page) => {
                const isEditingPage = editingPageId === page.page_id;
                const isConfirmingDelete = confirmDeletePageId === page.page_id;
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
                        alt={`Ảnh trang ${page.page_number}`}
                        className="h-full w-full object-contain p-2"
                        src={page.image_url}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-bold text-ink">
                        Trang {page.page_number}
                      </p>
                      <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-bold text-teal-800">
                        Đang mở đọc
                      </span>
                    </div>
                    {page.verified_text_preview ? (
                      <p className="line-clamp-3 text-xs text-muted">
                        {page.verified_text_preview}
                      </p>
                    ) : null}

                    <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
                      {!isSuspended ? (
                        <>
                          <button
                            aria-label={`Sửa nội dung trang ${page.page_number}`}
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
                            Sửa trang
                          </button>
                          <label className="inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-semibold text-ink hover:bg-canvas">
                            <Upload aria-hidden="true" className="size-3.5" />
                            Thay ảnh
                            <input
                              accept={ACCEPTED_UPLOAD_EXTENSIONS}
                              aria-label={`Thay ảnh cho trang ${page.page_number}`}
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
                        aria-label={`Xóa trang ${page.page_number}`}
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
                        Xóa trang
                      </button>
                    </div>

                    {isEditingPage ? (
                      <div className="flex flex-col gap-2.5 rounded-control border border-amber-300 bg-amber-50/70 p-3 text-xs">
                        <p className="font-bold text-amber-950">
                          Lưu ý: Khi sửa trang đã thêm, trang sẽ tạm gỡ khỏi
                          sách đọc và kiểm tra lại từ đầu (Rà chính tả → Tool
                          Check an toàn).
                        </p>
                        <label className="flex flex-col gap-1 font-semibold text-ink">
                          Số trang
                          <input
                            aria-label={`Số trang chỉnh sửa trang ${page.page_number}`}
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
                          Nội dung văn bản trang
                          <textarea
                            aria-label={`Chỉnh sửa văn bản trang ${page.page_number}`}
                            className="min-h-24 w-full rounded-control border border-border bg-white p-2 text-xs text-ink"
                            onChange={(event) =>
                              setEditPageText(event.target.value)
                            }
                            value={editPageText}
                          />
                        </label>
                        <select
                          aria-label={`Nguồn nội dung trang ${page.page_number}`}
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
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label={`Ghi chú nguồn trang ${page.page_number}`}
                          className="min-h-9 rounded-control border border-border bg-white px-2.5 text-xs text-ink"
                          onChange={(event) =>
                            setEditPageSourceNote(event.target.value)
                          }
                          placeholder="Ghi chú nguồn…"
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
                            Lưu & kiểm tra lại
                          </Button>
                          <Button
                            className="min-h-9 w-auto px-3 text-xs"
                            onClick={() => setEditingPageId(null)}
                            type="button"
                            variant="secondary"
                          >
                            Hủy
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {isConfirmingDelete ? (
                      <div
                        role="alertdialog"
                        aria-label={`Xác nhận xóa trang ${page.page_number}`}
                        className="flex flex-col gap-2 rounded-control border border-rose-300 bg-rose-50 p-3 text-xs text-rose-950"
                      >
                        <p className="font-bold">
                          Xóa trang {page.page_number} ngay?
                        </p>
                        <p>
                          Trang sẽ bị xóa khỏi sách đọc ngay lập tức và không
                          cần kiểm tra lại các trang khác.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            className="min-h-9 w-auto bg-rose-700 px-3 text-xs text-white hover:bg-rose-800"
                            isLoading={
                              busyKey === `page-delete:${page.page_id}`
                            }
                            onClick={() => void handleDeleteCommittedPage(page)}
                            type="button"
                          >
                            Xác nhận xóa
                          </Button>
                          <Button
                            className="min-h-9 w-auto px-3 text-xs"
                            onClick={() => setConfirmDeletePageId(null)}
                            type="button"
                            variant="secondary"
                          >
                            Hủy
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
            <PaginationBar
              ariaLabel="Phân trang các trang đã thêm vào sách"
              compact
              itemLabel="trang"
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
