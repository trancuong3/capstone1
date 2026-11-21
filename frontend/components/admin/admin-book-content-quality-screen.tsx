"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw, Search } from "lucide-react";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type {
  BookApprovalStatus,
  BookContentIssueType,
  BookContentReportDetailDTO,
  BookContentReportStatus,
  BookContentRightsProfileDTO,
  BookQualityBookDetailDTO,
  BookQualityBookPageDTO,
  BookQualityFindingDTO,
  BookQualityFindingStatus,
  BookQualityIssueFilter,
  BookQualityPageItemDTO,
  BookQualityReportAdminPageDTO,
  BookQualityScanDetailDTO,
  ContentRightsStatus,
  ContentRightsUsageBasis,
} from "@/types/book-content-quality";

type QualityWorkspaceTab = "books" | "reports";

const issueLabels: Record<BookContentIssueType, string> = {
  BOOK_METADATA_ERROR: "Sai thông tin sách",
  SPELLING_ERROR: "Sai chính tả",
  MISSING_CONTENT: "Thiếu từ hoặc câu",
  OCR_MISMATCH: "Nội dung không khớp ảnh gốc",
  IMAGE_QUALITY_ERROR: "Ảnh trang sách bị lỗi",
  DUPLICATE_PAGE: "Trang có dấu hiệu bị trùng",
  PAGE_ORDER_ERROR: "Trang sai thứ tự",
  CHILD_UNSAFE_CONTENT: "Nội dung không phù hợp với trẻ",
  COPYRIGHT_CONCERN: "Nghi vấn quyền sử dụng",
  OTHER: "Lỗi khác",
};

const reportStatusLabels: Record<BookContentReportStatus, string> = {
  OPEN: "Mới",
  UNDER_REVIEW: "Đang xử lý",
  RESOLVED: "Đã xử lý",
  REJECTED: "Không chấp nhận",
};

const reportStatusStyles: Record<BookContentReportStatus, string> = {
  OPEN: "bg-amber-100 text-amber-950 border-amber-300",
  UNDER_REVIEW: "bg-sky text-primary-hover border-primary/30",
  RESOLVED: "bg-emerald-100 text-emerald-950 border-emerald-300",
  REJECTED: "bg-slate-100 text-slate-800 border-slate-300",
};

const findingStatusLabels: Record<BookQualityFindingStatus, string> = {
  NEEDS_REVIEW: "Cần xem xét",
  CONFIRMED: "Đã xác nhận",
  DISMISSED: "Đã bỏ qua",
  RESOLVED: "Đã sửa",
  STALE: "Revision đã cũ",
};

const scanStatusLabels: Record<string, string> = {
  QUEUED: "Đang chờ",
  RUNNING: "Đang quét",
  COMPLETED: "Hoàn tất",
  PARTIAL: "Hoàn tất một phần",
  FAILED: "Thất bại",
};

const approvalStatusLabels: Record<BookApprovalStatus, string> = {
  PROCESSING: "Đang kiểm tra",
  SCAN_FAILED: "Kiểm tra lỗi",
  PENDING_ADMIN_REVIEW: "Cần Admin xử lý",
  READY_FOR_CHILDREN: "Sẵn sàng phê duyệt",
  PUBLISHED: "Đã xuất bản (cũ)",
  APPROVED_BY_ADMIN: "Đã phê duyệt",
  REJECTED_FOR_CHILDREN: "Đã từ chối",
  STALE: "Cần kiểm tra lại",
};

const approvalStatusStyles: Record<BookApprovalStatus, string> = {
  PROCESSING: "bg-sky text-primary-hover border-primary/30",
  SCAN_FAILED: "bg-rose-100 text-rose-900 border-rose-300",
  PENDING_ADMIN_REVIEW: "bg-amber-100 text-amber-950 border-amber-300",
  READY_FOR_CHILDREN: "bg-emerald-100 text-emerald-950 border-emerald-300",
  PUBLISHED: "bg-emerald-100 text-emerald-950 border-emerald-300",
  APPROVED_BY_ADMIN: "bg-emerald-100 text-emerald-950 border-emerald-300",
  REJECTED_FOR_CHILDREN: "bg-rose-100 text-rose-900 border-rose-300",
  STALE: "bg-orange-100 text-orange-950 border-orange-300",
};

const rightsStatusLabels: Record<ContentRightsStatus, string> = {
  NOT_ASSESSED: "Chưa đánh giá",
  MISSING_EVIDENCE: "Thiếu bằng chứng",
  CONCERNS_FOUND: "Có nghi vấn",
  REVIEWED: "Đã rà soát quyền sử dụng",
};

const rightsStatusStyles: Record<ContentRightsStatus, string> = {
  NOT_ASSESSED: "bg-slate-100 text-slate-800 border-slate-300",
  MISSING_EVIDENCE: "bg-amber-100 text-amber-950 border-amber-300",
  CONCERNS_FOUND: "bg-rose-100 text-rose-900 border-rose-300",
  REVIEWED: "bg-emerald-100 text-emerald-950 border-emerald-300",
};

const rightsUsageBasisLabels: Record<ContentRightsUsageBasis, string> = {
  OWN_ORIGINAL: "Tác phẩm tự sáng tác / sở hữu của đơn vị",
  WRITTEN_LICENSE: "Có văn bản cấp phép sử dụng",
  PUBLIC_DOMAIN: "Thuộc phạm vi công cộng",
  OPEN_LICENSE: "Giấy phép mở (Creative Commons / tương đương)",
  EDUCATIONAL_PERMISSION: "Được phép dùng cho mục đích giáo dục",
  UNKNOWN: "Chưa rõ nguồn gốc quyền",
  OTHER: "Căn cứ khác",
};

const referenceCheckLabels: Record<string, string> = {
  NOT_RUN: "Chưa kiểm tra trùng lặp nội bộ",
  NO_MATCH_IN_ALLOWED_CORPUS: "Không phát hiện trùng lặp trong kho nội bộ",
  OVERLAP_CONCERN: "Phát hiện đoạn văn bản trùng lặp đáng chú ý trong kho",
};

const contentIssueLabels: Record<string, string> = {
  MISSING_IMAGE: "Thiếu ảnh",
  MISSING_REVISION: "Chưa có bản OCR",
  EMPTY_OCR: "OCR trống",
  OCR_PROCESSING: "Đang xử lý OCR",
  NEEDS_VERIFICATION: "Chưa xác minh",
  DUPLICATE_PAGE_NUMBER: "Trùng số trang",
  UNRESOLVED_UNCERTAIN_WORDS: "Còn từ nghi vấn",
  COVER_OR_IMAGE_ONLY_NEEDS_IMAGE_REVIEW: "Trang bìa/hình chưa rà soát ảnh",
  IMAGE_SAFETY_CONCERN: "Ảnh có lo ngại an toàn",
};

const bookIssueFilterOptions: readonly {
  value: "" | BookQualityIssueFilter;
  label: string;
}[] = [
  { value: "", label: "Tất cả sách" },
  { value: "MISSING_CONTENT", label: "Thiếu nội dung" },
  { value: "SAFETY_ALERTS", label: "Có cảnh báo an toàn" },
  { value: "MISSING_RIGHTS", label: "Thiếu hồ sơ quyền" },
  { value: "OPEN_REPORTS", label: "Có báo cáo mới" },
  { value: "READY_FOR_APPROVAL", label: "Sẵn sàng phê duyệt" },
];

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  if (isServiceError(error) && error.code === "AUTH_REQUIRED") {
    return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
  }
  if (isServiceError(error) && error.code === "FORBIDDEN") {
    return "Tài khoản hiện tại không có quyền Admin.";
  }
  if (isServiceError(error) && (error.status === 409 || error.status === 422)) {
    return error.message;
  }
  return "Không thể hoàn tất thao tác. Vui lòng tải lại dữ liệu và thử lại.";
}

function pageReviewHref(
  bookId: string,
  pageId: string,
  revisionId?: string | null,
): string {
  const query = revisionId
    ? `?revisionId=${encodeURIComponent(revisionId)}`
    : "";
  return `/admin/books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}${query}`;
}

function describePageSafety(page: BookQualityPageItemDTO): {
  label: string;
  tone: string;
} {
  if (page.high_finding_count > 0 || page.safety_suitability === "NOT_RECOMMENDED") {
    return {
      label: `Cảnh báo chặn (${page.high_finding_count} HIGH)`,
      tone: "bg-rose-100 text-rose-900 border-rose-300",
    };
  }
  if (page.image_safety_status === "MANUAL_REVIEWED_CONCERN") {
    return {
      label: "Ảnh có lo ngại",
      tone: "bg-rose-100 text-rose-900 border-rose-300",
    };
  }
  if (page.safety_status === "FAILED") {
    return {
      label: "Lỗi quét an toàn",
      tone: "bg-rose-100 text-rose-900 border-rose-300",
    };
  }
  if (page.safety_status === "STALE") {
    return {
      label: "Cần kiểm tra lại",
      tone: "bg-amber-100 text-amber-950 border-amber-300",
    };
  }
  if (page.safety_status === "CONFIRMED") {
    return {
      label:
        page.safety_finding_count > 0
          ? `Đã xác nhận (${page.safety_finding_count} lưu ý)`
          : "Đã xác nhận an toàn",
      tone: "bg-emerald-100 text-emerald-950 border-emerald-300",
    };
  }
  if (page.safety_status === "PROVISIONAL") {
    return {
      label:
        page.safety_finding_count > 0
          ? `Chờ xác nhận (${page.safety_finding_count} cảnh báo)`
          : "Chờ Admin xác nhận",
      tone: "bg-amber-100 text-amber-950 border-amber-300",
    };
  }
  return {
    label: "Chưa kiểm tra",
    tone: "bg-slate-100 text-slate-800 border-slate-300",
  };
}

function describePageContent(page: BookQualityPageItemDTO): {
  label: string;
  tone: string;
} {
  if (page.content_issues.length > 0) {
    const primary = page.content_issues[0] ?? "NEEDS_VERIFICATION";
    return {
      label: contentIssueLabels[primary] ?? primary,
      tone:
        primary === "MISSING_IMAGE" ||
        primary === "EMPTY_OCR" ||
        primary === "DUPLICATE_PAGE_NUMBER" ||
        primary === "IMAGE_SAFETY_CONCERN"
          ? "bg-rose-100 text-rose-900 border-rose-300"
          : "bg-amber-100 text-amber-950 border-amber-300",
    };
  }
  if (page.verification_status === "VERIFIED") {
    return {
      label: "Đã xác minh",
      tone: "bg-emerald-100 text-emerald-950 border-emerald-300",
    };
  }
  return {
    label: "Chờ xác minh",
    tone: "bg-amber-100 text-amber-950 border-amber-300",
  };
}

export function AdminBookContentQualityScreen() {
  const { bookContentQuality } = useAdminServices();
  const [activeTab, setActiveTab] = useState<QualityWorkspaceTab>("books");
  const [reports, setReports] = useState<BookQualityReportAdminPageDTO | null>(
    null,
  );
  const [books, setBooks] = useState<BookQualityBookPageDTO | null>(null);
  const [loadingReports, setLoadingReports] = useState(true);
  const [loadingBooks, setLoadingBooks] = useState(true);
  const [reportError, setReportError] = useState<string | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // Book filters
  const [bookSearch, setBookSearch] = useState("");
  const [bookIssueFilter, setBookIssueFilter] = useState<
    "" | BookQualityIssueFilter
  >("");
  const [bookApprovalFilter, setBookApprovalFilter] = useState<
    BookApprovalStatus | ""
  >("");
  const [bookOffset, setBookOffset] = useState(0);
  const [onlyIssuePages, setOnlyIssuePages] = useState(false);

  // Report filters
  const [search, setSearch] = useState("");
  const [createdAfter, setCreatedAfter] = useState("");
  const [createdBefore, setCreatedBefore] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    BookContentReportStatus | ""
  >("");
  const [scopeFilter, setScopeFilter] = useState<"" | "BOOK" | "PAGE">("");
  const [issueFilter, setIssueFilter] = useState<BookContentIssueType | "">("");
  const [bookFilter, setBookFilter] = useState("");
  const [reportOffset, setReportOffset] = useState(0);

  // Selected detail state
  const [selectedBook, setSelectedBook] =
    useState<BookQualityBookDetailDTO | null>(null);
  const [selectedScan, setSelectedScan] =
    useState<BookQualityScanDetailDTO | null>(null);
  const [selectedReport, setSelectedReport] =
    useState<BookContentReportDetailDTO | null>(null);

  // Forms
  const [resolutionNote, setResolutionNote] = useState("");
  const [bookDecisionReason, setBookDecisionReason] = useState("");
  const [expectedPageCountInput, setExpectedPageCountInput] = useState("");
  const [rightsStatus, setRightsStatus] =
    useState<ContentRightsStatus>("NOT_ASSESSED");
  const [rightsSourceName, setRightsSourceName] = useState("");
  const [rightsHolder, setRightsHolder] = useState("");
  const [rightsUsageBasis, setRightsUsageBasis] =
    useState<ContentRightsUsageBasis>("UNKNOWN");
  const [rightsEvidenceUrl, setRightsEvidenceUrl] = useState("");
  const [rightsEvidenceRef, setRightsEvidenceRef] = useState("");
  const [rightsNotes, setRightsNotes] = useState("");

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const reportRequestId = useRef(0);
  const bookRequestId = useRef(0);
  const reportLimit = 10;
  const bookLimit = 10;

  const syncRightsInputs = useCallback(
    (profile: BookContentRightsProfileDTO | null) => {
      setRightsStatus(profile?.status ?? "NOT_ASSESSED");
      setRightsSourceName(profile?.source_name ?? "");
      setRightsHolder(profile?.rights_holder ?? "");
      setRightsUsageBasis(
        (profile?.usage_basis as ContentRightsUsageBasis | null) ?? "UNKNOWN",
      );
      setRightsEvidenceUrl(profile?.evidence_url ?? "");
      setRightsEvidenceRef(profile?.evidence_reference ?? "");
      setRightsNotes(profile?.notes ?? "");
    },
    [],
  );

  const loadReports = useCallback(async () => {
    const requestId = ++reportRequestId.current;
    setLoadingReports(true);
    setReportError(null);
    try {
      const next = await bookContentQuality.listReports({
        status: statusFilter || undefined,
        issue_type: issueFilter || undefined,
        scope: scopeFilter || undefined,
        book_id: bookFilter || undefined,
        search: search.trim() || undefined,
        created_after: createdAfter
          ? new Date(`${createdAfter}T00:00:00`).toISOString()
          : undefined,
        created_before: createdBefore
          ? new Date(`${createdBefore}T23:59:59.999`).toISOString()
          : undefined,
        limit: reportLimit,
        offset: reportOffset,
      });
      if (requestId === reportRequestId.current) setReports(next);
    } catch (error) {
      if (requestId === reportRequestId.current) {
        setReports(null);
        setReportError(errorMessage(error));
      }
    } finally {
      if (requestId === reportRequestId.current) setLoadingReports(false);
    }
  }, [
    bookContentQuality,
    bookFilter,
    createdAfter,
    createdBefore,
    issueFilter,
    reportOffset,
    scopeFilter,
    search,
    statusFilter,
  ]);

  const loadBooks = useCallback(async () => {
    const requestId = ++bookRequestId.current;
    setLoadingBooks(true);
    setBookError(null);
    try {
      const next = await bookContentQuality.listBooks({
        search: bookSearch.trim() || undefined,
        approval_status: bookApprovalFilter || undefined,
        issue_filter: bookIssueFilter || undefined,
        limit: bookLimit,
        offset: bookOffset,
      });
      if (requestId === bookRequestId.current) setBooks(next);
    } catch (error) {
      if (requestId === bookRequestId.current) {
        setBooks(null);
        setBookError(errorMessage(error));
      }
    } finally {
      if (requestId === bookRequestId.current) setLoadingBooks(false);
    }
  }, [
    bookApprovalFilter,
    bookContentQuality,
    bookIssueFilter,
    bookOffset,
    bookSearch,
  ]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void loadReports(), 120);
    return () => {
      globalThis.clearTimeout(timeout);
      reportRequestId.current += 1;
    };
  }, [loadReports]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void loadBooks(), 120);
    return () => {
      globalThis.clearTimeout(timeout);
      bookRequestId.current += 1;
    };
  }, [loadBooks]);

  const refreshSelectedBook = useCallback(
    async (bookId: string) => {
      const detail = await bookContentQuality.getBook(bookId);
      setSelectedBook(detail);
      setSelectedScan(detail.latest_scan_detail);
      setExpectedPageCountInput(
        detail.expected_page_count ? String(detail.expected_page_count) : "",
      );
      syncRightsInputs(detail.rights_profile);
    },
    [bookContentQuality, syncRightsInputs],
  );

  useEffect(() => {
    const activeScan =
      selectedBook?.latest_scan_detail?.status === "QUEUED" ||
      selectedBook?.latest_scan_detail?.status === "RUNNING";
    const activeWorkflow = selectedBook?.ai_workflows.some((workflow) =>
      ["QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"].includes(
        workflow.status,
      ),
    );
    if (!selectedBook || (!activeScan && !activeWorkflow)) return;
    const timeout = globalThis.setTimeout(() => {
      void refreshSelectedBook(selectedBook.book_id).catch(() =>
        setActionError("Không thể cập nhật tiến trình kiểm tra. Vui lòng tải lại."),
      );
    }, 3000);
    return () => globalThis.clearTimeout(timeout);
  }, [refreshSelectedBook, selectedBook]);

  async function openBook(bookId: string) {
    setBusyKey(`book:${bookId}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await refreshSelectedBook(bookId);
      setBookDecisionReason("");
      setOnlyIssuePages(false);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function saveExpectedPageCount() {
    if (!selectedBook) return;
    setBusyKey(`expected-pages:${selectedBook.book_id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const trimmed = expectedPageCountInput.trim();
      const parsed = trimmed ? Number.parseInt(trimmed, 10) : null;
      if (trimmed && (!Number.isInteger(parsed) || (parsed ?? 0) < 1)) {
        setActionError("Số trang nguồn dự kiến phải là số nguyên dương.");
        return;
      }
      await bookContentQuality.updateExpectedPageCount(
        selectedBook.book_id,
        parsed,
      );
      await Promise.all([
        refreshSelectedBook(selectedBook.book_id),
        loadBooks(),
      ]);
      setActionNotice("Đã cập nhật số trang nguồn dự kiến để đối chiếu.");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function saveBookRightsProfile() {
    if (!selectedBook) return;
    setBusyKey(`rights:${selectedBook.book_id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      await bookContentQuality.upsertRightsProfile(selectedBook.book_id, {
        status: rightsStatus,
        source_name: rightsSourceName.trim() || null,
        rights_holder: rightsHolder.trim() || null,
        usage_basis: rightsUsageBasis,
        evidence_url: rightsEvidenceUrl.trim() || null,
        evidence_reference: rightsEvidenceRef.trim() || null,
        notes: rightsNotes.trim() || null,
      });
      await Promise.all([
        refreshSelectedBook(selectedBook.book_id),
        loadBooks(),
      ]);
      setActionNotice("Đã lưu hồ sơ quyền sử dụng nội dung.");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function runRightsOverlapCheck() {
    if (!selectedBook) return;
    setBusyKey(`rights-overlap:${selectedBook.book_id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const updated = await bookContentQuality.runRightsOverlapCheck(
        selectedBook.book_id,
      );
      await Promise.all([
        refreshSelectedBook(selectedBook.book_id),
        loadBooks(),
      ]);
      setActionNotice(
        referenceCheckLabels[updated.reference_check_status] ??
          "Đã hoàn tất kiểm tra trùng lặp nội bộ kho sách.",
      );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function decideBook(decision: "APPROVE" | "REJECT" | "REQUEST_RESCAN") {
    if (!selectedBook) return;
    setBusyKey(`book-decision:${selectedBook.book_id}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const result = await bookContentQuality.decideBook(selectedBook.book_id, {
        decision,
        reason: bookDecisionReason.trim(),
        rights_confirmed:
          decision === "APPROVE" &&
          selectedBook.assessment.rights_profile_status === "REVIEWED",
      });
      setSelectedBook((previous) =>
        previous?.book_id === result.book_id
          ? {
              ...previous,
              assessment: result.assessment,
              decision_history: result.decision_history,
            }
          : previous,
      );
      await loadBooks();
      setBookDecisionReason("");
      setActionNotice(
        decision === "APPROVE"
          ? "Đã phê duyệt sách cho thư viện trẻ em."
          : decision === "REJECT"
            ? "Đã ghi nhận từ chối sách."
            : "Đã gửi yêu cầu kiểm tra lại các bước cần thiết.",
      );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function enqueueBookScan(bookId: string) {
    setBusyKey(`scan:${bookId}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const scan = await bookContentQuality.enqueueScan(bookId);
      await Promise.all([loadBooks(), refreshSelectedBook(bookId)]);
      setSelectedScan(await bookContentQuality.getScan(scan.id));
      setActionNotice("Đã đưa yêu cầu quét toàn bộ sách vào hàng đợi.");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function openScan(scanId: string) {
    setBusyKey(`scan-detail:${scanId}`);
    setActionError(null);
    try {
      setSelectedScan(await bookContentQuality.getScan(scanId));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function updateFinding(
    finding: BookQualityFindingDTO,
    nextStatus: Exclude<BookQualityFindingStatus, "STALE">,
  ) {
    setBusyKey(`finding:${finding.id}`);
    setActionError(null);
    try {
      await bookContentQuality.updateFinding(
        finding.id,
        nextStatus,
        nextStatus === "DISMISSED"
          ? "Admin đã xem xét và xác định cảnh báo không cần xử lý."
          : undefined,
      );
      if (selectedBook) {
        await refreshSelectedBook(selectedBook.book_id);
        if (selectedScan) {
          setSelectedScan(await bookContentQuality.getScan(selectedScan.id));
        }
      }
      await loadBooks();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function openReport(reportId: string) {
    setBusyKey(`report:${reportId}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const detail = await bookContentQuality.getReport(reportId);
      setSelectedReport(detail);
      setResolutionNote(detail.admin_resolution_note ?? "");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function changeReportStatus(
    reportId: string,
    nextStatus: BookContentReportStatus,
  ) {
    setBusyKey(`report-status:${reportId}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const detail = await bookContentQuality.updateReportStatus(
        reportId,
        nextStatus,
        resolutionNote,
      );
      setSelectedReport(detail);
      await loadReports();
      setActionNotice(
        `Đã cập nhật trạng thái báo cáo thành "${reportStatusLabels[nextStatus]}".`,
      );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  const pageNumberToItem = useMemo(() => {
    const map = new Map<number, BookQualityPageItemDTO>();
    for (const page of selectedBook?.pages ?? []) {
      map.set(page.page_number, page);
    }
    return map;
  }, [selectedBook?.pages]);

  const visiblePages = useMemo(() => {
    const allPages = selectedBook?.pages ?? [];
    return onlyIssuePages ? allPages.filter((page) => page.has_issues) : allPages;
  }, [onlyIssuePages, selectedBook?.pages]);

  const issuePageCount = useMemo(
    () => (selectedBook?.pages ?? []).filter((page) => page.has_issues).length,
    [selectedBook?.pages],
  );

  const openReportsCount =
    (reports?.summary?.OPEN ?? 0) + (reports?.summary?.UNDER_REVIEW ?? 0);
  const openSafetyReportsCount = reports?.summary?.OPEN_SAFETY ?? 0;

  const canApproveSelectedBook = Boolean(
    selectedBook &&
      bookDecisionReason.trim() &&
      selectedBook.assessment.blockers.length === 0 &&
      selectedBook.assessment.rights_profile_status === "REVIEWED" &&
      selectedBook.assessment.page_count > 0 &&
      selectedBook.assessment.ocr_completed_pages ===
        selectedBook.assessment.page_count &&
      selectedBook.assessment.ocr_approval_valid_pages ===
        selectedBook.assessment.page_count &&
      selectedBook.assessment.child_safety_status === "COMPLETED" &&
      selectedBook.assessment.failed_or_unscanned_page_count === 0 &&
      selectedBook.assessment.finding_count === 0 &&
      !selectedBook.ai_workflows.some(
        (workflow) =>
          workflow.suitability === "REVIEW_REQUIRED" ||
          workflow.suitability === "NOT_RECOMMENDED",
      ) &&
      busyKey !== `book-decision:${selectedBook.book_id}`,
  );

  const reportLast = reports
    ? Math.min(reports.offset + reports.limit, reports.total)
    : 0;
  const bookLast = books
    ? Math.min(books.offset + books.limit, books.total)
    : 0;

  return (
    <section className="mt-10 border-t border-border pt-8">
      <AdminPageHeader
        eyebrow="Quản trị chất lượng sách"
        title="Chất lượng sách và Báo cáo phụ huynh"
        description="Nhìn nhanh sách nào thiếu nội dung, trang nào cần kiểm tra, hồ sơ quyền sử dụng và các báo cáo phụ huynh đang chờ xử lý."
        actions={
          <Button
            className="h-11 w-auto"
            disabled={loadingReports || loadingBooks}
            onClick={() => void Promise.all([loadReports(), loadBooks()])}
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-4" />
            Tải lại
          </Button>
        }
      />

      {actionError ? (
        <StatusMessage className="mb-4" tone="error" title="Thao tác chưa hoàn tất">
          {actionError}
        </StatusMessage>
      ) : null}
      {actionNotice ? (
        <StatusMessage className="mb-4" tone="success" title="Đã cập nhật">
          {actionNotice}
        </StatusMessage>
      ) : null}

      {/* 2 Clear Workspaces */}
      <div
        aria-label="Khu vực làm việc Chất lượng sách"
        className="mb-6 flex flex-wrap gap-2 border-b border-border pb-3"
        role="tablist"
      >
        <button
          aria-controls="quality-panel-books"
          aria-selected={activeTab === "books"}
          className={
            "inline-flex min-h-11 items-center gap-2 rounded-control border px-4 text-sm font-bold transition " +
            (activeTab === "books"
              ? "border-primary bg-primary text-white"
              : "border-border bg-white text-ink hover:bg-canvas")
          }
          id="quality-tab-books"
          onClick={() => setActiveTab("books")}
          role="tab"
          type="button"
        >
          Tình trạng sách
          <span
            className={
              "rounded-full px-2 py-0.5 text-xs tabular-nums " +
              (activeTab === "books"
                ? "bg-white/20 text-white"
                : "bg-canvas text-ink")
            }
          >
            {books?.total ?? 0}
          </span>
        </button>

        <button
          aria-controls="quality-panel-reports"
          aria-selected={activeTab === "reports"}
          className={
            "inline-flex min-h-11 items-center gap-2 rounded-control border px-4 text-sm font-bold transition " +
            (activeTab === "reports"
              ? "border-primary bg-primary text-white"
              : "border-border bg-white text-ink hover:bg-canvas")
          }
          id="quality-tab-reports"
          onClick={() => setActiveTab("reports")}
          role="tab"
          type="button"
        >
          Báo cáo phụ huynh
          <span
            className={
              "rounded-full px-2 py-0.5 text-xs tabular-nums " +
              (activeTab === "reports"
                ? "bg-white/20 text-white"
                : openReportsCount > 0
                  ? "bg-amber-100 text-amber-950"
                  : "bg-canvas text-ink")
            }
          >
            {openReportsCount} chờ
          </span>
          {openSafetyReportsCount > 0 ? (
            <span className="rounded-full bg-rose-700 px-2 py-0.5 text-xs font-extrabold text-white">
              {openSafetyReportsCount} an toàn
            </span>
          ) : null}
        </button>
      </div>

      {/* WORKSPACE 1: TÌNH TRẠNG SÁCH */}
      {activeTab === "books" ? (
        <div
          aria-labelledby="quality-tab-books"
          id="quality-panel-books"
          role="tabpanel"
        >
          <section className="rounded-card border border-border bg-white p-4 sm:p-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold text-ink">
                  Danh sách tình trạng sách
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Chọn bộ lọc nhanh để tìm đúng sách cần xử lý.
                </p>
              </div>
              <span className="text-sm font-semibold text-muted">
                {books?.total ?? 0} sách
              </span>
            </div>

            {/* 5 Quick Book Filters */}
            <div
              aria-label="Bộ lọc nhanh tình trạng sách"
              className="mt-4 flex flex-wrap gap-2"
              role="group"
            >
              {bookIssueFilterOptions.map((option) => {
                const active = bookIssueFilter === option.value;
                const count =
                  option.value === ""
                    ? undefined
                    : books?.issue_filter_summary?.[option.value];
                return (
                  <button
                    aria-pressed={active}
                    className={
                      "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-xs font-bold transition " +
                      (active
                        ? "border-primary bg-sky text-primary-hover"
                        : "border-border bg-canvas text-ink hover:bg-white")
                    }
                    key={option.value || "ALL"}
                    onClick={() => {
                      setBookOffset(0);
                      setBookIssueFilter(option.value);
                    }}
                    type="button"
                  >
                    <span>{option.label}</span>
                    {count !== undefined ? (
                      <span className="rounded-full bg-white px-1.5 py-0.5 text-[11px] tabular-nums text-ink">
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_240px]">
              <label className="block text-sm font-semibold text-ink">
                Tìm sách
                <span className="relative mt-1 block">
                  <Search
                    aria-hidden
                    className="absolute left-3 top-3 size-4 text-muted"
                  />
                  <input
                    className="min-h-11 w-full rounded-control border border-border bg-white pl-9 pr-3 font-normal"
                    onChange={(event) => {
                      setBookOffset(0);
                      setBookSearch(event.target.value);
                    }}
                    placeholder="Nhập tên hoặc tiêu đề sách…"
                    value={bookSearch}
                  />
                </span>
              </label>
              <label className="block text-sm font-semibold text-ink">
                Trạng thái phê duyệt
                <select
                  className="mt-1 min-h-11 w-full rounded-control border border-border bg-white px-3 font-normal"
                  onChange={(event) => {
                    setBookOffset(0);
                    setBookApprovalFilter(
                      event.target.value as BookApprovalStatus | "",
                    );
                  }}
                  value={bookApprovalFilter}
                >
                  <option value="">Tất cả trạng thái</option>
                  {Object.entries(approvalStatusLabels).map(([status, label]) => (
                    <option key={status} value={status}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {loadingBooks ? (
              <AdminLoading label="Đang tải tình trạng sách…" />
            ) : bookError ? (
              <StatusMessage
                className="mt-4"
                tone="error"
                title="Không thể tải danh sách sách"
              >
                {bookError}
              </StatusMessage>
            ) : !books || books.items.length === 0 ? (
              <div className="mt-4">
                <EmptyState
                  title="Không có sách phù hợp"
                  description="Thử chọn bộ lọc khác hoặc xóa từ khóa tìm kiếm."
                />
              </div>
            ) : (
              <div className="mt-4 grid gap-3">
                {books.items.map((book) => {
                  const verifiedPages =
                    book.verified_page_count ||
                    book.assessment.ocr_completed_pages;
                  const totalPages = book.assessment.page_count;
                  const isSelected = selectedBook?.book_id === book.book_id;
                  return (
                    <article
                      className={
                        "rounded-control border p-4 transition " +
                        (isSelected
                          ? "border-primary bg-sky/30"
                          : "border-border bg-white")
                      }
                      key={book.book_id}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-base font-bold text-ink">
                              {book.book_title}
                            </h3>
                            <span
                              className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-bold ${approvalStatusStyles[book.assessment.status]}`}
                            >
                              {approvalStatusLabels[book.assessment.status]}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                            <span className="rounded-control bg-canvas px-2.5 py-1 font-semibold text-ink tabular-nums">
                              {verifiedPages}/{totalPages} trang đã xác minh
                            </span>
                            {book.issue_page_count > 0 ? (
                              <span className="rounded-control border border-amber-300 bg-amber-50 px-2.5 py-1 font-semibold text-amber-950">
                                {book.issue_page_count} trang cần xử lý
                              </span>
                            ) : null}
                            {book.has_missing_content ? (
                              <span className="rounded-control border border-rose-300 bg-rose-50 px-2.5 py-1 font-semibold text-rose-900">
                                Thiếu nội dung
                              </span>
                            ) : null}
                            {book.has_safety_alerts ? (
                              <span className="rounded-control border border-rose-300 bg-rose-50 px-2.5 py-1 font-semibold text-rose-900">
                                Cảnh báo an toàn ({book.assessment.finding_count})
                              </span>
                            ) : null}
                            {book.has_missing_rights ? (
                              <span className="rounded-control border border-amber-300 bg-amber-50 px-2.5 py-1 font-semibold text-amber-950">
                                Quyền: {rightsStatusLabels[book.assessment.rights_profile_status]}
                              </span>
                            ) : (
                              <span className="rounded-control border border-emerald-300 bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-950">
                                Quyền: {rightsStatusLabels[book.assessment.rights_profile_status]}
                              </span>
                            )}
                            {book.open_report_count > 0 ? (
                              <span className="rounded-control border border-primary/30 bg-sky px-2.5 py-1 font-semibold text-primary-hover">
                                {book.open_report_count} báo cáo chờ
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <Button
                          className="h-10 w-auto px-4 text-sm"
                          disabled={busyKey === `book:${book.book_id}`}
                          onClick={() => void openBook(book.book_id)}
                          variant={isSelected ? "primary" : "secondary"}
                        >
                          Xem chi tiết
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {books && books.total > bookLimit ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted">
                  {books.offset + 1}–{bookLast} / {books.total}
                </p>
                <div className="flex gap-2">
                  <Button
                    className="h-10 w-auto px-3 text-sm"
                    disabled={bookOffset === 0 || loadingBooks}
                    onClick={() =>
                      setBookOffset((value) => Math.max(0, value - bookLimit))
                    }
                    variant="secondary"
                  >
                    Trước
                  </Button>
                  <Button
                    className="h-10 w-auto px-3 text-sm"
                    disabled={bookOffset + bookLimit >= books.total || loadingBooks}
                    onClick={() => setBookOffset((value) => value + bookLimit)}
                    variant="secondary"
                  >
                    Tiếp
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          {/* BOOK DETAIL — 3 CLEAR SECTIONS */}
          {selectedBook ? (
            <section
              aria-label={`Chi tiết chất lượng sách ${selectedBook.book_title}`}
              className="mt-6 grid gap-6 rounded-card border border-border bg-white p-4 sm:p-6"
              data-testid="book-quality-detail"
            >
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-bold text-ink">
                      {selectedBook.book_title}
                    </h2>
                    <span
                      className={`rounded-full border px-3 py-1 text-xs font-extrabold ${approvalStatusStyles[selectedBook.assessment.status]}`}
                    >
                      {approvalStatusLabels[selectedBook.assessment.status]}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {selectedBook.assessment.ocr_completed_pages}/
                    {selectedBook.assessment.page_count} trang đã xác minh ·{" "}
                    {issuePageCount} trang cần xử lý ·{" "}
                    {selectedBook.reports.filter((r) =>
                      ["OPEN", "UNDER_REVIEW"].includes(r.status),
                    ).length}{" "}
                    báo cáo đang chờ
                  </p>
                </div>
                <Button
                  className="h-10 w-auto px-3 text-sm"
                  onClick={() => setSelectedBook(null)}
                  variant="secondary"
                >
                  Đóng chi tiết
                </Button>
              </div>

              {/* PHẦN 1: NỘI DUNG VÀ TRANG */}
              <section
                aria-labelledby="detail-section-pages"
                className="rounded-control border border-border bg-canvas p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3
                      className="text-base font-extrabold text-ink"
                      id="detail-section-pages"
                    >
                      1. Nội dung và trang
                    </h3>
                    <p className="mt-1 text-xs text-muted">
                      Phát hiện thiếu ảnh, OCR trống, trùng trang, khoảng hở số
                      trang và mở nhanh từng trang cần xử lý.
                    </p>
                  </div>
                  <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-control border border-border bg-white px-3 text-xs font-bold text-ink">
                    <input
                      checked={onlyIssuePages}
                      onChange={(event) =>
                        setOnlyIssuePages(event.target.checked)
                      }
                      type="checkbox"
                    />
                    Chỉ hiện trang có vấn đề ({issuePageCount})
                  </label>
                </div>

                {/* Chẩn đoán thiếu trang / nguồn */}
                <div className="mt-4 grid gap-3 rounded-control border border-border bg-white p-3 text-xs">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="font-bold text-ink">
                        Đối chiếu số trang nguồn
                      </p>
                      <p className="mt-1 text-muted">
                        {selectedBook.assessment.expected_page_count_status ===
                        "UNKNOWN_SOURCE_PAGE_COUNT"
                          ? "Chưa có số trang nguồn để đối chiếu."
                          : selectedBook.assessment.expected_page_count_status ===
                              "UNDER_EXPECTED"
                            ? `Nghi thiếu trang: hiện có ${selectedBook.assessment.page_count} trang, ít hơn số trang nguồn (${selectedBook.assessment.expected_page_count}).`
                            : selectedBook.assessment.expected_page_count_status ===
                                "OVER_EXPECTED"
                              ? `Số trang hiện có (${selectedBook.assessment.page_count}) nhiều hơn số trang nguồn (${selectedBook.assessment.expected_page_count}).`
                              : `Khớp số trang nguồn (${selectedBook.assessment.page_count}/${selectedBook.assessment.expected_page_count} trang).`}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="font-semibold text-ink">
                        Số trang nguồn
                        <input
                          className="mt-1 block min-h-9 w-28 rounded-control border border-border px-2 font-normal"
                          inputMode="numeric"
                          min={1}
                          onChange={(event) =>
                            setExpectedPageCountInput(event.target.value)
                          }
                          placeholder="Chưa có"
                          type="number"
                          value={expectedPageCountInput}
                        />
                      </label>
                      <Button
                        className="h-9 w-auto px-3 text-xs"
                        disabled={
                          busyKey === `expected-pages:${selectedBook.book_id}`
                        }
                        onClick={() => void saveExpectedPageCount()}
                        type="button"
                        variant="secondary"
                      >
                        Lưu số trang nguồn
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {selectedBook.assessment.missing_page_numbers.length > 0 ? (
                      <span className="rounded-control border border-rose-300 bg-rose-50 px-2.5 py-1 font-semibold text-rose-900">
                        Nghi thiếu trang số:{" "}
                        {selectedBook.assessment.missing_page_numbers.join(", ")}
                      </span>
                    ) : null}
                    {selectedBook.assessment.duplicate_page_numbers.length > 0 ? (
                      <span className="rounded-control border border-rose-300 bg-rose-50 px-2.5 py-1 font-semibold text-rose-900">
                        Trùng số trang:{" "}
                        {selectedBook.assessment.duplicate_page_numbers.join(", ")}
                      </span>
                    ) : null}
                    {selectedBook.assessment.missing_image_page_numbers.length >
                    0 ? (
                      <span className="rounded-control border border-rose-300 bg-rose-50 px-2.5 py-1 font-semibold text-rose-900">
                        Thiếu ảnh trang:{" "}
                        {selectedBook.assessment.missing_image_page_numbers.join(
                          ", ",
                        )}
                      </span>
                    ) : null}
                    {selectedBook.assessment.empty_ocr_page_numbers.length > 0 ? (
                      <span className="rounded-control border border-amber-300 bg-amber-50 px-2.5 py-1 font-semibold text-amber-950">
                        OCR trống ở trang:{" "}
                        {selectedBook.assessment.empty_ocr_page_numbers.join(", ")}
                      </span>
                    ) : null}
                    {selectedBook.assessment.image_only_page_numbers.length > 0 ? (
                      <span className="rounded-control border border-border bg-canvas px-2.5 py-1 font-semibold text-ink">
                        Trang bìa / chỉ có hình:{" "}
                        {selectedBook.assessment.image_only_page_numbers.join(", ")}
                      </span>
                    ) : null}
                    {selectedBook.assessment.missing_page_numbers.length === 0 &&
                    selectedBook.assessment.duplicate_page_numbers.length ===
                      0 &&
                    selectedBook.assessment.missing_image_page_numbers.length ===
                      0 &&
                    selectedBook.assessment.empty_ocr_page_numbers.length ===
                      0 ? (
                      <span className="rounded-control border border-emerald-300 bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-950">
                        Không phát hiện thiếu ảnh, trùng số trang hay khoảng hở số
                        trang.
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Danh sách trang gọn gàng */}
                {visiblePages.length === 0 ? (
                  <p className="mt-4 rounded-control bg-white p-4 text-sm text-muted">
                    {onlyIssuePages
                      ? "Không có trang nào đang có vấn đề."
                      : "Sách hiện chưa có trang nào."}
                  </p>
                ) : (
                  <div className="mt-4 grid gap-2">
                    {visiblePages.map((page) => {
                      const contentBadge = describePageContent(page);
                      const safetyBadge = describePageSafety(page);
                      const targetRevision =
                        page.latest_revision_id ??
                        page.current_verified_revision_id;
                      return (
                        <div
                          className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border bg-white p-3"
                          key={page.page_id}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <strong className="text-sm text-ink">
                                Trang {page.page_number}
                              </strong>
                              {page.content_type === "COVER_OR_IMAGE_ONLY" ? (
                                <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] font-semibold text-muted">
                                  Trang bìa / chỉ có hình
                                </span>
                              ) : null}
                              <span
                                className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${contentBadge.tone}`}
                              >
                                {contentBadge.label}
                              </span>
                              <span
                                className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${safetyBadge.tone}`}
                              >
                                An toàn: {safetyBadge.label}
                              </span>
                              <span
                                className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${rightsStatusStyles[page.rights_status]}`}
                              >
                                Quyền: {rightsStatusLabels[page.rights_status]}
                                {page.has_rights_override ? " (riêng trang)" : ""}
                              </span>
                              {page.open_report_count > 0 ? (
                                <span className="rounded-full border border-primary/30 bg-sky px-2.5 py-0.5 text-xs font-bold text-primary-hover">
                                  {page.open_report_count} báo cáo mở
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <Link
                            className="inline-flex min-h-10 items-center rounded-control border border-primary px-3 text-xs font-bold text-primary hover:bg-sky"
                            href={pageReviewHref(
                              selectedBook.book_id,
                              page.page_id,
                              targetRevision,
                            )}
                          >
                            Mở trang
                          </Link>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* PHẦN 2: AN TOÀN VÀ QUYỀN SỬ DỤNG */}
              <section
                aria-labelledby="detail-section-safety-rights"
                className="grid gap-5 rounded-control border border-border bg-canvas p-4"
              >
                <div>
                  <h3
                    className="text-base font-extrabold text-ink"
                    id="detail-section-safety-rights"
                  >
                    2. An toàn cho trẻ và Quyền sử dụng nội dung
                  </h3>
                  <p className="mt-1 text-xs text-muted">
                    Tách bạch kiểm tra tự động và phần Admin xác nhận. Sách chỉ
                    được phê duyệt khi đủ điều kiện cả hai phần.
                  </p>
                </div>

                {selectedBook.assessment.legacy_published_needs_rights_review ? (
                  <div
                    className="rounded-control border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950"
                    role="status"
                  >
                    <strong>Sách xuất bản theo phiên bản cũ:</strong> Sách này
                    được xuất bản trước khi áp dụng hồ sơ quyền sử dụng và chưa
                    được đánh dấu đạt quyền. Vui lòng rà soát và lưu hồ sơ quyền
                    sử dụng bên dưới.
                  </div>
                ) : null}

                {/* 2A. Tóm tắt An toàn cho trẻ */}
                <div className="rounded-control border border-border bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-extrabold text-ink">
                      An toàn cho trẻ (Lớp 1–5 · phạm vi văn bản)
                    </h4>
                    <span className="text-xs font-semibold text-muted">
                      {selectedBook.assessment.child_safety_completed_pages}/
                      {selectedBook.assessment.page_count} trang hoàn tất ·{" "}
                      {selectedBook.assessment.finding_count} cảnh báo (HIGH:{" "}
                      {selectedBook.assessment.high_finding_count}, MEDIUM:{" "}
                      {selectedBook.assessment.medium_finding_count})
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    AI chỉ quét văn bản từng trang; hình ảnh minh họa cần Admin
                    đối chiếu trực tiếp khi mở trang.
                  </p>

                  {selectedBook.assessment.finding_groups.length > 0 ? (
                    <div className="mt-3 grid gap-2">
                      {selectedBook.assessment.finding_groups.map((group) => {
                        const isHigh = group.severity.toUpperCase() === "HIGH";
                        return (
                          <details
                            className={
                              "rounded-control border p-3 " +
                              (isHigh
                                ? "border-rose-300 bg-rose-50"
                                : "border-border bg-canvas")
                            }
                            key={`${group.category}:${group.severity}`}
                          >
                            <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm font-bold text-ink">
                              <span>
                                {group.category.replaceAll("_", " ")}
                              </span>
                              <span
                                className={
                                  "rounded-full px-2 py-0.5 text-xs font-extrabold " +
                                  (isHigh
                                    ? "bg-rose-700 text-white"
                                    : "bg-white text-ink")
                                }
                              >
                                {group.severity}
                              </span>
                              <span className="text-xs font-normal text-muted">
                                {group.finding_count} cảnh báo trên{" "}
                                {group.page_count} trang (trang{" "}
                                {group.page_numbers.join(", ")})
                              </span>
                            </summary>
                            <div className="mt-3 grid gap-2 border-t border-border pt-3">
                              {group.examples.map((example, index) => {
                                const matchedPage = pageNumberToItem.get(
                                  example.page_number,
                                );
                                return (
                                  <div
                                    className="rounded-control bg-white p-3 text-xs"
                                    key={`${example.page_number}:${index}`}
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <strong className="text-ink">
                                        Trang {example.page_number}
                                      </strong>
                                      {matchedPage ? (
                                        <Link
                                          className="font-bold text-primary underline"
                                          href={pageReviewHref(
                                            selectedBook.book_id,
                                            matchedPage.page_id,
                                            matchedPage.latest_revision_id ??
                                              matchedPage.current_verified_revision_id,
                                          )}
                                        >
                                          Mở trang {example.page_number}
                                        </Link>
                                      ) : null}
                                    </div>
                                    <blockquote className="mt-1 border-l-2 border-primary pl-2 text-ink">
                                      “{example.evidence_text}”
                                    </blockquote>
                                    <p className="mt-1 text-muted">
                                      {example.explanation}
                                    </p>
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted">
                      Chưa ghi nhận nhóm cảnh báo an toàn văn bản nào.
                    </p>
                  )}
                </div>

                {/* 2B. Hồ sơ quyền sử dụng nội dung */}
                <div
                  className="rounded-control border border-border bg-white p-4"
                  data-testid="book-rights-profile-card"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-extrabold text-ink">
                        Hồ sơ quyền sử dụng nội dung
                      </h4>
                      <p className="mt-1 text-xs text-muted">
                        Tự động chỉ đối chiếu trùng lặp nội bộ kho sách ViRead
                        (local). Admin xác nhận nguồn, căn cứ sử dụng và bằng
                        chứng.
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-3 py-1 text-xs font-extrabold ${rightsStatusStyles[selectedBook.assessment.rights_profile_status]}`}
                    >
                      {
                        rightsStatusLabels[
                          selectedBook.assessment.rights_profile_status
                        ]
                      }
                    </span>
                  </div>

                  {selectedBook.rights_profile?.reviewed_at ? (
                    <p className="mt-2 text-xs text-muted">
                      Rà soát gần nhất:{" "}
                      {formatDate(selectedBook.rights_profile.reviewed_at)}
                      {selectedBook.rights_profile.reviewed_by_name
                        ? ` · ${selectedBook.rights_profile.reviewed_by_name}`
                        : ""}
                      {" · Phiên bản hồ sơ #"}
                      {selectedBook.rights_profile.profile_version}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-control bg-canvas p-3 text-xs">
                    <div>
                      <strong className="text-ink">
                        Đối chiếu trùng lặp nội bộ kho sách:
                      </strong>{" "}
                      <span>
                        {referenceCheckLabels[
                          selectedBook.rights_profile?.reference_check_status ??
                            "NOT_RUN"
                        ] ?? "Chưa chạy"}
                      </span>
                    </div>
                    <Button
                      className="h-9 w-auto px-3 text-xs"
                      disabled={
                        busyKey === `rights-overlap:${selectedBook.book_id}`
                      }
                      onClick={() => void runRightsOverlapCheck()}
                      type="button"
                      variant="secondary"
                    >
                      Kiểm tra trùng lặp nội bộ
                    </Button>
                  </div>

                  {selectedBook.rights_profile?.reference_check_evidence
                    ?.length ? (
                    <details className="mt-2 rounded-control border border-amber-300 bg-amber-50 p-3 text-xs">
                      <summary className="cursor-pointer font-bold text-amber-950">
                        Xem bằng chứng trùng lặp nội bộ (
                        {
                          selectedBook.rights_profile.reference_check_evidence
                            .length
                        }
                        )
                      </summary>
                      <ul className="mt-2 space-y-2">
                        {selectedBook.rights_profile.reference_check_evidence.map(
                          (item, index) => (
                            <li
                              className="rounded-control bg-white p-2"
                              key={index}
                            >
                              <p className="font-bold text-ink">
                                Trang {String(item.source_page_number ?? "?")} ↔{" "}
                                {String(item.matched_book_title ?? "Sách khác")}{" "}
                                (Trang {String(item.matched_page_number ?? "?")})
                              </p>
                              <p className="mt-1 text-muted">
                                “{String(item.excerpt ?? "")}”
                              </p>
                            </li>
                          ),
                        )}
                      </ul>
                    </details>
                  ) : null}

                  <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                    <label className="font-semibold text-ink">
                      Trạng thái hồ sơ quyền sử dụng
                      <select
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-2 font-normal"
                        onChange={(event) =>
                          setRightsStatus(
                            event.target.value as ContentRightsStatus,
                          )
                        }
                        value={rightsStatus}
                      >
                        {Object.entries(rightsStatusLabels).map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className="font-semibold text-ink">
                      Căn cứ sử dụng
                      <select
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-2 font-normal"
                        onChange={(event) =>
                          setRightsUsageBasis(
                            event.target.value as ContentRightsUsageBasis,
                          )
                        }
                        value={rightsUsageBasis}
                      >
                        {Object.entries(rightsUsageBasisLabels).map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className="font-semibold text-ink">
                      Nguồn tài liệu
                      <input
                        className="mt-1 min-h-10 w-full rounded-control border border-border px-2 font-normal"
                        maxLength={300}
                        onChange={(event) =>
                          setRightsSourceName(event.target.value)
                        }
                        placeholder="Nhà xuất bản / nguồn biên soạn…"
                        value={rightsSourceName}
                      />
                    </label>
                    <label className="font-semibold text-ink">
                      Chủ thể quyền
                      <input
                        className="mt-1 min-h-10 w-full rounded-control border border-border px-2 font-normal"
                        maxLength={300}
                        onChange={(event) => setRightsHolder(event.target.value)}
                        placeholder="Tác giả / tổ chức nắm quyền…"
                        value={rightsHolder}
                      />
                    </label>
                    <label className="font-semibold text-ink">
                      Mã văn bản / Số giấy phép
                      <input
                        className="mt-1 min-h-10 w-full rounded-control border border-border px-2 font-normal"
                        maxLength={500}
                        onChange={(event) =>
                          setRightsEvidenceRef(event.target.value)
                        }
                        placeholder="Số hợp đồng / giấy phép…"
                        value={rightsEvidenceRef}
                      />
                    </label>
                    <label className="font-semibold text-ink">
                      Liên kết bằng chứng (nếu có)
                      <input
                        className="mt-1 min-h-10 w-full rounded-control border border-border px-2 font-normal"
                        maxLength={1000}
                        onChange={(event) =>
                          setRightsEvidenceUrl(event.target.value)
                        }
                        placeholder="https://..."
                        value={rightsEvidenceUrl}
                      />
                    </label>
                  </div>
                  <label className="mt-3 block text-xs font-semibold text-ink">
                    Ghi chú rà soát quyền sử dụng
                    <textarea
                      className="mt-1 min-h-16 w-full rounded-control border border-border p-2 font-normal"
                      maxLength={2000}
                      onChange={(event) => setRightsNotes(event.target.value)}
                      value={rightsNotes}
                    />
                  </label>
                  <div className="mt-3">
                    <Button
                      className="h-10 w-auto px-4 text-xs"
                      disabled={busyKey === `rights:${selectedBook.book_id}`}
                      onClick={() => void saveBookRightsProfile()}
                      type="button"
                      variant="secondary"
                    >
                      Lưu hồ sơ quyền sử dụng
                    </Button>
                  </div>
                </div>

                {/* 2C. Phê duyệt sách */}
                <div className="rounded-control border border-border bg-white p-4">
                  <h4 className="text-sm font-extrabold text-ink">
                    Phê duyệt sách cho thư viện trẻ em
                  </h4>
                  <p className="mt-1 text-xs text-muted">
                    ViRead không tự động phê duyệt sách. Chỉ mở phê duyệt khi
                    toàn bộ trang đã xác minh, an toàn cho trẻ hoàn tất không
                    còn cảnh báo chặn, và hồ sơ quyền sử dụng ở trạng thái “Đã
                    rà soát quyền sử dụng”.
                  </p>
                  {selectedBook.assessment.blockers.length > 0 ? (
                    <ul className="mt-3 list-disc space-y-1 rounded-control border border-amber-300 bg-amber-50 p-3 pl-7 text-xs text-amber-950">
                      {selectedBook.assessment.blockers.map((blocker, idx) => (
                        <li key={`${idx}-${blocker}`}>{blocker}</li>
                      ))}
                    </ul>
                  ) : null}
                  {selectedBook.assessment.admin_approved_at ? (
                    <p className="mt-3 rounded-control border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-950">
                      Đã phê duyệt lúc{" "}
                      {formatDate(selectedBook.assessment.admin_approved_at)}
                      {selectedBook.assessment.admin_approved_by_name
                        ? ` · ${selectedBook.assessment.admin_approved_by_name}`
                        : ""}
                      {selectedBook.assessment.admin_reason
                        ? ` · ${selectedBook.assessment.admin_reason}`
                        : ""}
                    </p>
                  ) : null}

                  <label className="mt-3 block text-xs font-semibold text-ink">
                    Lý do / ghi chú quyết định · bắt buộc
                    <textarea
                      className="mt-1 min-h-20 w-full rounded-control border border-border bg-white p-3 font-normal"
                      maxLength={2000}
                      onChange={(event) =>
                        setBookDecisionReason(event.target.value)
                      }
                      placeholder="Nêu căn cứ phê duyệt, từ chối hoặc yêu cầu kiểm tra lại…"
                      value={bookDecisionReason}
                    />
                  </label>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      className="h-10 w-auto px-4 text-sm"
                      disabled={!canApproveSelectedBook}
                      onClick={() => void decideBook("APPROVE")}
                    >
                      Phê duyệt toàn bộ sách
                    </Button>
                    <Button
                      className="h-10 w-auto px-4 text-sm"
                      disabled={
                        !bookDecisionReason.trim() ||
                        busyKey === `book-decision:${selectedBook.book_id}`
                      }
                      onClick={() => void decideBook("REJECT")}
                      variant="secondary"
                    >
                      Từ chối sách
                    </Button>
                    <Button
                      className="h-10 w-auto px-4 text-sm"
                      disabled={
                        !bookDecisionReason.trim() ||
                        busyKey === `book-decision:${selectedBook.book_id}`
                      }
                      onClick={() => void decideBook("REQUEST_RESCAN")}
                      variant="secondary"
                    >
                      Yêu cầu kiểm tra lại
                    </Button>
                  </div>
                </div>
              </section>

              {/* PHẦN 3: LỊCH SỬ KIỂM TRA */}
              <section
                aria-labelledby="detail-section-history"
                className="rounded-control border border-border bg-canvas p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3
                    className="text-base font-extrabold text-ink"
                    id="detail-section-history"
                  >
                    3. Lịch sử kiểm tra
                  </h3>
                  <Button
                    className="h-9 w-auto px-3 text-xs"
                    disabled={
                      busyKey === `scan:${selectedBook.book_id}` ||
                      selectedBook.scans.some(
                        (run) =>
                          run.status === "QUEUED" || run.status === "RUNNING",
                      )
                    }
                    onClick={() => void enqueueBookScan(selectedBook.book_id)}
                    variant="secondary"
                  >
                    Quét kiểm tra toàn sách
                  </Button>
                </div>

                {selectedBook.decision_history.length > 0 ? (
                  <div className="mt-3">
                    <h4 className="text-xs font-bold uppercase tracking-wide text-muted">
                      Lịch sử quyết định Admin
                    </h4>
                    <ul className="mt-2 grid gap-2">
                      {selectedBook.decision_history.map((decision, index) => (
                        <li
                          className="rounded-control border border-border bg-white p-3 text-xs"
                          key={`${decision.action}:${decision.created_at}:${index}`}
                        >
                          <p className="font-bold text-ink">
                            {decision.action}
                            {decision.created_at
                              ? ` · ${formatDate(decision.created_at)}`
                              : ""}
                            {decision.actor_name
                              ? ` · ${decision.actor_name}`
                              : ""}
                          </p>
                          <p className="mt-1 text-muted">
                            {decision.reason ?? "Không có ghi chú"}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted">
                    Chưa có quyết định phê duyệt hoặc từ chối nào.
                  </p>
                )}

                {selectedBook.scans.length > 0 ? (
                  <div className="mt-4">
                    <h4 className="text-xs font-bold uppercase tracking-wide text-muted">
                      Lịch sử các lần quét ({selectedBook.scans.length})
                    </h4>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedBook.scans.map((scan) => (
                        <Button
                          className="h-9 w-auto px-3 text-xs"
                          key={scan.id}
                          onClick={() => void openScan(scan.id)}
                          variant={
                            selectedScan?.id === scan.id
                              ? "primary"
                              : "secondary"
                          }
                        >
                          {scanStatusLabels[scan.status] ?? scan.status} ·{" "}
                          {formatDate(scan.created_at)}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {selectedScan ? (
                  <details className="mt-4 rounded-control border border-border bg-white p-3 text-xs">
                    <summary className="cursor-pointer font-bold text-ink">
                      Chi tiết lần quét đang chọn (
                      {selectedScan.completed_pages}/{selectedScan.total_pages}{" "}
                      trang)
                    </summary>
                    <div className="mt-3 grid gap-2">
                      {selectedScan.pages.map((scanPage) => (
                        <div
                          className="rounded-control bg-canvas p-3"
                          key={scanPage.id}
                        >
                          <p className="font-bold text-ink">
                            Trang {scanPage.page_number} · {scanPage.status} ·{" "}
                            {scanPage.findings.length} phát hiện
                          </p>
                          {scanPage.findings.length > 0 ? (
                            <ul className="mt-2 space-y-2">
                              {scanPage.findings.map((finding) => (
                                <li
                                  className="rounded-control border border-border bg-white p-2"
                                  key={finding.id}
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="font-bold">
                                      {finding.issue_type} · {finding.severity}
                                    </span>
                                    <span>
                                      {findingStatusLabels[finding.status]}
                                    </span>
                                  </div>
                                  <p className="mt-1 text-muted">
                                    {finding.explanation}
                                  </p>
                                  {finding.status === "NEEDS_REVIEW" ? (
                                    <div className="mt-2 flex flex-wrap gap-2">
                                      <Button
                                        className="h-8 w-auto px-2.5 text-xs"
                                        disabled={
                                          busyKey === `finding:${finding.id}`
                                        }
                                        onClick={() =>
                                          void updateFinding(
                                            finding,
                                            "CONFIRMED",
                                          )
                                        }
                                        variant="secondary"
                                      >
                                        Xác nhận cảnh báo
                                      </Button>
                                      <Button
                                        className="h-8 w-auto px-2.5 text-xs"
                                        disabled={
                                          busyKey === `finding:${finding.id}`
                                        }
                                        onClick={() =>
                                          void updateFinding(
                                            finding,
                                            "DISMISSED",
                                          )
                                        }
                                        variant="secondary"
                                      >
                                        Bỏ qua
                                      </Button>
                                    </div>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}

                {/* Chi tiết kỹ thuật — thu gọn */}
                <details className="mt-4 rounded-control border border-border bg-white p-3 text-xs">
                  <summary className="cursor-pointer font-bold text-ink">
                    Thông số kỹ thuật (Hash đánh giá, Workflow AI)
                  </summary>
                  <dl className="mt-3 grid gap-2 break-all font-mono sm:grid-cols-2">
                    <div>
                      <dt className="font-bold">AssessmentHash</dt>
                      <dd>{selectedBook.assessment.assessment_hash}</dd>
                    </div>
                    <div>
                      <dt className="font-bold">RightsProfileHash</dt>
                      <dd>{selectedBook.assessment.rights_profile_hash ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="font-bold">Tổng workflow AI</dt>
                      <dd>{selectedBook.ai_workflows.length}</dd>
                    </div>
                    <div>
                      <dt className="font-bold">Trang đánh giá stale</dt>
                      <dd>{selectedBook.assessment.stale_pages}</dd>
                    </div>
                  </dl>
                </details>
              </section>
            </section>
          ) : null}
        </div>
      ) : null}

      {/* WORKSPACE 2: BÁO CÁO PHỤ HUYNH */}
      {activeTab === "reports" ? (
        <div
          aria-labelledby="quality-tab-reports"
          id="quality-panel-reports"
          role="tabpanel"
        >
          <section className="rounded-card border border-border bg-white p-4 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-ink">
                  Hộp thư báo cáo phụ huynh
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Báo cáo an toàn cho trẻ chưa xử lý luôn được ưu tiên lên đầu.
                </p>
              </div>
              <span className="text-sm font-semibold text-muted">
                {reports?.total ?? 0} báo cáo
              </span>
            </div>

            {/* Quick status tabs */}
            <div
              aria-label="Lọc trạng thái báo cáo"
              className="mt-4 flex flex-wrap gap-2"
              role="group"
            >
              {(
                [
                  ["", "Tất cả"],
                  ["OPEN", "Mới"],
                  ["UNDER_REVIEW", "Đang xử lý"],
                  ["RESOLVED", "Đã xử lý"],
                  ["REJECTED", "Không chấp nhận"],
                ] as const
              ).map(([value, label]) => {
                const active = statusFilter === value;
                const count =
                  value === "" ? undefined : reports?.summary?.[value];
                return (
                  <button
                    aria-pressed={active}
                    className={
                      "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-xs font-bold transition " +
                      (active
                        ? "border-primary bg-sky text-primary-hover"
                        : "border-border bg-canvas text-ink hover:bg-white")
                    }
                    key={value || "ALL"}
                    onClick={() => {
                      setReportOffset(0);
                      setStatusFilter(value);
                    }}
                    type="button"
                  >
                    <span>{label}</span>
                    {count !== undefined ? (
                      <span className="rounded-full bg-white px-1.5 py-0.5 text-[11px] tabular-nums text-ink">
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="block text-sm font-semibold text-ink">
                Tìm kiếm
                <span className="relative mt-1 block">
                  <Search
                    aria-hidden
                    className="absolute left-3 top-3 size-4 text-muted"
                  />
                  <input
                    className="min-h-11 w-full rounded-control border border-border bg-white pl-9 pr-3 font-normal"
                    onChange={(event) => {
                      setReportOffset(0);
                      setSearch(event.target.value);
                    }}
                    placeholder="Tên sách, nội dung, phụ huynh…"
                    value={search}
                  />
                </span>
              </label>

              <label className="block text-sm font-semibold text-ink">
                Phạm vi báo cáo
                <select
                  className="mt-1 min-h-11 w-full rounded-control border border-border bg-white px-3 font-normal"
                  onChange={(event) => {
                    setReportOffset(0);
                    setScopeFilter(
                      event.target.value as "" | "BOOK" | "PAGE",
                    );
                  }}
                  value={scopeFilter}
                >
                  <option value="">Tất cả phạm vi</option>
                  <option value="BOOK">Cấp sách</option>
                  <option value="PAGE">Cấp trang</option>
                </select>
              </label>

              <label className="block text-sm font-semibold text-ink">
                Loại vấn đề
                <select
                  className="mt-1 min-h-11 w-full rounded-control border border-border bg-white px-3 font-normal"
                  onChange={(event) => {
                    setReportOffset(0);
                    setIssueFilter(
                      event.target.value as BookContentIssueType | "",
                    );
                  }}
                  value={issueFilter}
                >
                  <option value="">Tất cả loại vấn đề</option>
                  {Object.entries(issueLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-sm font-semibold text-ink">
                Sách
                <select
                  className="mt-1 min-h-11 w-full rounded-control border border-border bg-white px-3 font-normal"
                  onChange={(event) => {
                    setReportOffset(0);
                    setBookFilter(event.target.value);
                  }}
                  value={bookFilter}
                >
                  <option value="">Tất cả sách</option>
                  {(books?.items ?? []).map((book) => (
                    <option key={book.book_id} value={book.book_id}>
                      {book.book_title}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <details className="mt-3 text-xs text-muted">
              <summary className="cursor-pointer font-semibold text-ink">
                Lọc theo khoảng ngày
              </summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label className="block font-semibold text-ink">
                  Từ ngày
                  <input
                    className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 font-normal"
                    onChange={(event) => {
                      setReportOffset(0);
                      setCreatedAfter(event.target.value);
                    }}
                    type="date"
                    value={createdAfter}
                  />
                </label>
                <label className="block font-semibold text-ink">
                  Đến ngày
                  <input
                    className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 font-normal"
                    onChange={(event) => {
                      setReportOffset(0);
                      setCreatedBefore(event.target.value);
                    }}
                    type="date"
                    value={createdBefore}
                  />
                </label>
              </div>
            </details>

            {loadingReports ? (
              <AdminLoading label="Đang tải báo cáo phụ huynh…" />
            ) : reportError ? (
              <StatusMessage
                className="mt-4"
                tone="error"
                title="Không thể tải danh sách báo cáo"
              >
                {reportError}
              </StatusMessage>
            ) : !reports || reports.items.length === 0 ? (
              <div className="mt-4">
                <EmptyState
                  title="Không có báo cáo phù hợp"
                  description="Thử chọn bộ lọc khác hoặc quay lại sau."
                />
              </div>
            ) : (
              <div className="mt-4 grid gap-3">
                {reports.items.map((report) => {
                  const isSafetyPriority =
                    report.issue_type === "CHILD_UNSAFE_CONTENT" &&
                    ["OPEN", "UNDER_REVIEW"].includes(report.status);
                  const isPageScope = report.page_id !== null;
                  return (
                    <article
                      className={
                        "rounded-control border p-4 " +
                        (isSafetyPriority
                          ? "border-rose-300 bg-rose-50/40"
                          : "border-border bg-white")
                      }
                      key={report.id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-border bg-canvas px-2.5 py-0.5 text-xs font-bold text-ink">
                              {isPageScope
                                ? `Cấp trang · Trang ${report.page_number ?? "?"}`
                                : "Cấp sách"}
                            </span>
                            {isSafetyPriority ? (
                              <span className="rounded-full bg-rose-700 px-2.5 py-0.5 text-xs font-extrabold text-white">
                                Ưu tiên an toàn
                              </span>
                            ) : null}
                            <span
                              className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${reportStatusStyles[report.status]}`}
                            >
                              {reportStatusLabels[report.status]}
                            </span>
                          </div>
                          <h3 className="mt-2 font-bold text-ink">
                            {report.book_title} ·{" "}
                            {issueLabels[report.issue_type]}
                          </h3>
                          <p className="mt-1 text-xs text-muted">
                            Phụ huynh:{" "}
                            {report.reporter_name || "Tài khoản phụ huynh"} ·{" "}
                            {formatDate(report.created_at)}
                          </p>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">
                            {report.description}
                          </p>
                        </div>
                        <Button
                          className="h-10 w-auto px-4 text-sm"
                          disabled={busyKey === `report:${report.id}`}
                          onClick={() => void openReport(report.id)}
                          variant="secondary"
                        >
                          Xem chi tiết
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {reports && reports.total > reportLimit ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted">
                  {reports.offset + 1}–{reportLast} / {reports.total}
                </p>
                <div className="flex gap-2">
                  <Button
                    className="h-10 w-auto px-3 text-sm"
                    disabled={reportOffset === 0 || loadingReports}
                    onClick={() =>
                      setReportOffset((value) =>
                        Math.max(0, value - reportLimit),
                      )
                    }
                    variant="secondary"
                  >
                    Trước
                  </Button>
                  <Button
                    className="h-10 w-auto px-3 text-sm"
                    disabled={
                      reportOffset + reportLimit >= reports.total ||
                      loadingReports
                    }
                    onClick={() =>
                      setReportOffset((value) => value + reportLimit)
                    }
                    variant="secondary"
                  >
                    Tiếp
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          {/* CHI TIẾT BÁO CÁO PHỤ HUYNH */}
          {selectedReport ? (
            <section
              aria-label="Chi tiết báo cáo phụ huynh"
              className="mt-6 rounded-card border border-border bg-white p-4 sm:p-6"
              data-testid="parent-report-detail"
            >
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-border bg-canvas px-2.5 py-0.5 text-xs font-bold text-ink">
                      {selectedReport.page_id !== null
                        ? `Cấp trang · Trang ${selectedReport.page_number ?? "?"}`
                        : "Cấp sách"}
                    </span>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${reportStatusStyles[selectedReport.status]}`}
                    >
                      {reportStatusLabels[selectedReport.status]}
                    </span>
                  </div>
                  <h2 className="mt-2 text-xl font-bold text-ink">
                    {selectedReport.book_title} ·{" "}
                    {issueLabels[selectedReport.issue_type]}
                  </h2>
                  <p className="mt-1 text-xs text-muted">
                    Người gửi: {selectedReport.reporter_name || "Phụ huynh"} ·{" "}
                    {formatDate(selectedReport.created_at)}
                  </p>
                </div>
                <Button
                  className="h-10 w-auto px-3 text-sm"
                  onClick={() => setSelectedReport(null)}
                  variant="secondary"
                >
                  Đóng chi tiết
                </Button>
              </div>

              {selectedReport.page_revision_changed ? (
                <div
                  className="mt-4 rounded-control border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950"
                  role="status"
                >
                  <strong>Nội dung trang đã thay đổi</strong> kể từ thời điểm
                  phụ huynh gửi báo cáo. Hãy đối chiếu với snapshot bên dưới.
                </div>
              ) : null}

              <div className="mt-4 grid gap-5 lg:grid-cols-2">
                <div>
                  <h3 className="text-sm font-extrabold text-ink">
                    Nội dung báo cáo & Snapshot lúc gửi
                  </h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">
                    {selectedReport.description}
                  </p>
                  {selectedReport.reported_text ? (
                    <p className="mt-2 text-sm text-muted">
                      Đoạn phụ huynh trích dẫn:{" "}
                      <strong className="text-ink">
                        {selectedReport.reported_text}
                      </strong>
                    </p>
                  ) : null}
                  {selectedReport.suggested_correction ? (
                    <p className="mt-1 text-sm text-muted">
                      Đề xuất sửa:{" "}
                      <strong className="text-ink">
                        {selectedReport.suggested_correction}
                      </strong>
                    </p>
                  ) : null}
                  {selectedReport.verified_text_snapshot ? (
                    <div className="mt-3">
                      <p className="text-xs font-bold text-muted">
                        Bản chụp nội dung trang tại thời điểm gửi
                      </p>
                      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-control bg-canvas p-3 text-xs leading-5 text-ink">
                        {selectedReport.verified_text_snapshot}
                      </pre>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-muted">
                      Không có bản chụp nội dung trang (báo cáo cấp sách hoặc
                      chưa có revision đã xác minh).
                    </p>
                  )}

                  {selectedReport.page_id && selectedReport.book_id ? (
                    <Link
                      className="mt-4 inline-flex min-h-10 items-center rounded-control border border-primary px-4 text-sm font-bold text-primary hover:bg-sky"
                      href={pageReviewHref(
                        selectedReport.book_id,
                        selectedReport.page_id,
                        selectedReport.page_revision_id,
                      )}
                    >
                      Mở trang được báo
                    </Link>
                  ) : null}
                </div>

                <div>
                  <h3 className="text-sm font-extrabold text-ink">
                    Lịch sử xử lý
                  </h3>
                  <ol className="mt-2 space-y-3 border-l-2 border-border pl-4">
                    {selectedReport.history.map((item, index) => (
                      <li key={`${item.created_at}-${index}`}>
                        <p className="text-sm font-semibold text-ink">
                          {item.from_status
                            ? `${reportStatusLabels[item.from_status]} → `
                            : ""}
                          {reportStatusLabels[item.to_status]}
                        </p>
                        <p className="text-xs text-muted">
                          {item.actor_name || "Hệ thống"} ·{" "}
                          {formatDate(item.created_at)}
                        </p>
                        {item.note ? (
                          <p className="mt-1 text-sm text-muted">{item.note}</p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              <div className="mt-5 border-t border-border pt-4">
                <label
                  className="block text-sm font-semibold text-ink"
                  htmlFor="report-resolution-note"
                >
                  Lý do / ghi chú xử lý của Admin
                  <textarea
                    className="mt-2 min-h-20 w-full rounded-control border border-border p-3 font-normal"
                    id="report-resolution-note"
                    maxLength={2000}
                    onChange={(event) => setResolutionNote(event.target.value)}
                    placeholder="Nêu căn cứ kiểm tra, nội dung đã sửa hoặc lý do không chấp nhận…"
                    value={resolutionNote}
                  />
                </label>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedReport.status === "OPEN" ? (
                    <Button
                      className="h-10 w-auto px-4 text-sm"
                      disabled={busyKey === `report-status:${selectedReport.id}`}
                      onClick={() =>
                        void changeReportStatus(
                          selectedReport.id,
                          "UNDER_REVIEW",
                        )
                      }
                      variant="secondary"
                    >
                      Đang xử lý
                    </Button>
                  ) : null}
                  {["OPEN", "UNDER_REVIEW"].includes(selectedReport.status) ? (
                    <>
                      <Button
                        className="h-10 w-auto px-4 text-sm"
                        disabled={
                          !resolutionNote.trim() ||
                          busyKey === `report-status:${selectedReport.id}`
                        }
                        onClick={() =>
                          void changeReportStatus(selectedReport.id, "RESOLVED")
                        }
                      >
                        Đã xử lý
                      </Button>
                      <Button
                        className="h-10 w-auto px-4 text-sm"
                        disabled={
                          !resolutionNote.trim() ||
                          busyKey === `report-status:${selectedReport.id}`
                        }
                        onClick={() =>
                          void changeReportStatus(selectedReport.id, "REJECTED")
                        }
                        variant="secondary"
                      >
                        Không chấp nhận
                      </Button>
                    </>
                  ) : (
                    <Button
                      className="h-10 w-auto px-4 text-sm"
                      disabled={
                        !resolutionNote.trim() ||
                        busyKey === `report-status:${selectedReport.id}`
                      }
                      onClick={() =>
                        void changeReportStatus(
                          selectedReport.id,
                          "UNDER_REVIEW",
                        )
                      }
                      variant="secondary"
                    >
                      Mở lại báo cáo
                    </Button>
                  )}
                </div>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
