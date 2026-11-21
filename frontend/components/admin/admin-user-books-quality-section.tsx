"use client";

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Lock,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AuthenticatedImage } from "@/components/common/authenticated-image";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  ADMIN_USER_BOOK_FILTER_LABELS,
  type AdminUserBookDecisionType,
  type AdminUserBookQueueFilter,
  type AdminUserBookQueueItemDTO,
  type AdminUserBookQueuePageDTO,
  type AdminUserBookSubmissionDetailDTO,
} from "@/types/parent-private-book";

const QUEUE_FILTER_KEYS: readonly AdminUserBookQueueFilter[] = [
  "PENDING_ADMIN",
  "FLAGGED",
  "CHECK_FAILED",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
];

const QUEUE_STATUS_TONES: Record<string, string> = {
  PENDING_ADMIN: "border-indigo-300 bg-indigo-100 text-indigo-950",
  FLAGGED: "border-amber-300 bg-amber-100 text-amber-950",
  CHECK_FAILED: "border-rose-300 bg-rose-100 text-rose-900",
  APPROVED: "border-emerald-300 bg-emerald-100 text-emerald-950",
  REJECTED: "border-rose-300 bg-rose-100 text-rose-900",
  SUSPENDED: "border-rose-400 bg-rose-100 text-rose-950",
};

const WORKFLOW_TONES: Record<string, string> = {
  CHECKING: "border-primary/30 bg-sky text-primary-hover",
  PASSED_READY_TO_ADD: "border-emerald-300 bg-emerald-100 text-emerald-950",
  NEEDS_ADMIN_REVIEW: "border-amber-300 bg-amber-100 text-amber-950",
  CHECK_FAILED: "border-rose-300 bg-rose-100 text-rose-900",
  PENDING_ADMIN: "border-indigo-300 bg-indigo-100 text-indigo-950",
  APPROVED_READY_TO_ADD: "border-emerald-300 bg-emerald-100 text-emerald-950",
  REJECTED: "border-rose-300 bg-rose-100 text-rose-900",
  NEEDS_RECHECK: "border-orange-300 bg-orange-100 text-orange-950",
  ADDED_TO_BOOK: "border-teal-300 bg-teal-100 text-teal-950",
  CANCELLED: "border-slate-300 bg-slate-100 text-slate-700",
};

function formatDateTime(value: string): string {
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function getAdminErrorText(error: unknown, fallback: string): string {
  if (isServiceError(error) && error.message) {
    return error.message;
  }
  return fallback;
}

interface AdminUserBooksQualitySectionProps {
  onPendingCountChange?: (count: number) => void;
}

export function AdminUserBooksQualitySection({
  onPendingCountChange,
}: AdminUserBooksQualitySectionProps) {
  const { bookContentQuality } = useAdminServices();

  const [statusFilter, setStatusFilter] = useState<
    "" | AdminUserBookQueueFilter
  >("PENDING_ADMIN");
  const [searchText, setSearchText] = useState("");
  const [queue, setQueue] = useState<AdminUserBookQueuePageDTO | null>(null);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminUserBookSubmissionDetailDTO | null>(
    null,
  );
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [decisionReason, setDecisionReason] = useState("");
  const [suspendReason, setSuspendReason] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);

  const [queueReloadKey, setQueueReloadKey] = useState(0);

  const loadQueue = useCallback(async () => {
    setQueueReloadKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!bookContentQuality.listUserBooks) {
      return;
    }
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (!active) return;
        setLoadingQueue(true);
        setQueueError(null);
        return bookContentQuality.listUserBooks!({
          status: statusFilter || undefined,
          search: searchText.trim() || undefined,
          limit: 30,
          offset: 0,
        });
      })
      .then((response) => {
        if (!active || !response) return;
        setQueue(response);
        onPendingCountChange?.(response.summary?.PENDING_ADMIN ?? 0);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setQueueError(
          getAdminErrorText(
            error,
            "Không thể tải danh sách Sách người dùng. Vui lòng thử lại.",
          ),
        );
      })
      .finally(() => {
        if (active) setLoadingQueue(false);
      });
    return () => {
      active = false;
    };
  }, [
    bookContentQuality,
    onPendingCountChange,
    queueReloadKey,
    searchText,
    statusFilter,
  ]);

  const openDetail = useCallback(
    async (submissionId: string, options?: { preserveNotice?: boolean }) => {
      if (!bookContentQuality.getUserBookSubmission) return;
      setSelectedId(submissionId);
      setLoadingDetail(true);
      setDetailError(null);
      setConflictError(null);
      setActionError(null);
      if (!options?.preserveNotice) {
        setActionNotice(null);
      }
      try {
        const result =
          await bookContentQuality.getUserBookSubmission(submissionId);
        setDetail(result);
        setDecisionReason("");
        setSuspendReason("");
      } catch (error) {
        setDetail(null);
        setDetailError(
          getAdminErrorText(
            error,
            "Không thể tải chi tiết bản nộp của phụ huynh.",
          ),
        );
      } finally {
        setLoadingDetail(false);
      }
    },
    [bookContentQuality],
  );

  async function submitDecision(decision: AdminUserBookDecisionType) {
    if (!detail || !bookContentQuality.decideUserBookSubmission) return;
    setActionError(null);
    setActionNotice(null);
    setConflictError(null);

    const trimmedReason = decisionReason.trim();
    if (trimmedReason.length < 5) {
      setActionError("Vui lòng nhập lý do quyết định tối thiểu 5 ký tự.");
      return;
    }
    if (decision === "APPROVE" && !detail.can_approve) {
      setActionError(
        detail.approve_blocked_reason ??
          "Không thể duyệt phiên bản này do vi phạm chính sách an toàn hoặc trạng thái sách không hợp lệ.",
      );
      return;
    }
    if (!detail.snapshot_hash) {
      setActionError("Bản nộp chưa có snapshot hash hợp lệ để quyết định.");
      return;
    }

    setBusyAction(`decide:${decision}`);
    try {
      const response = await bookContentQuality.decideUserBookSubmission(
        detail.submission_id,
        {
          decision,
          reason: trimmedReason,
          expected_submission_version: detail.submission_version,
          expected_snapshot_hash: detail.snapshot_hash,
          expected_lock_version: detail.optimistic_lock_version,
        },
      );
      setDecisionReason("");
      setActionNotice(
        decision === "APPROVE"
          ? `Đã phê duyệt đúng phiên bản v${response.approved_submission_version ?? detail.submission_version} (chỉ mở cho gia đình sở hữu thêm trang vào sách riêng).`
          : decision === "REQUEST_CHANGES"
            ? "Đã gửi yêu cầu chỉnh sửa tới phụ huynh."
            : decision === "SUSPEND"
              ? "Đã đình chỉ sách riêng."
              : "Đã từ chối phiên bản trang này.",
      );
      await Promise.all([
        loadQueue(),
        openDetail(detail.submission_id, { preserveNotice: true }),
      ]);
    } catch (error) {
      if (isServiceError(error) && error.status === 409) {
        setConflictError(
          getAdminErrorText(
            error,
            "Bản nộp vừa được cập nhật bởi phụ huynh hoặc Admin khác. Hãy tải lại bản mới nhất trước khi quyết định.",
          ),
        );
      } else {
        setActionError(
          getAdminErrorText(
            error,
            "Không thể lưu quyết định kiểm duyệt. Vui lòng thử lại.",
          ),
        );
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSuspendBook() {
    if (!detail || !bookContentQuality.suspendUserBook) return;
    setActionError(null);
    setActionNotice(null);
    setConflictError(null);

    const trimmed = suspendReason.trim() || decisionReason.trim();
    if (trimmed.length < 5) {
      setActionError("Vui lòng nhập lý do đình chỉ sách riêng tối thiểu 5 ký tự.");
      return;
    }

    setBusyAction("suspend");
    try {
      await bookContentQuality.suspendUserBook(detail.book_id, trimmed);
      setActionNotice(
        `Đã đình chỉ sách riêng "${detail.book_title}". Gia đình sở hữu không thể mở đọc ngay lập tức.`,
      );
      setSuspendReason("");
      await Promise.all([
        loadQueue(),
        openDetail(detail.submission_id, { preserveNotice: true }),
      ]);
    } catch (error) {
      setActionError(
        getAdminErrorText(
          error,
          "Không thể đình chỉ sách riêng lúc này.",
        ),
      );
    } finally {
      setBusyAction(null);
    }
  }

  const summary = queue?.summary ?? {};

  return (
    <div
      aria-labelledby="quality-tab-user-books"
      className="flex flex-col gap-5"
      id="quality-panel-user-books"
      role="tabpanel"
    >
      {/* Scope & Isolation Notice */}
      <div
        role="note"
        className="flex items-start gap-3 rounded-card border border-indigo-200 bg-indigo-50/70 p-4 text-sm text-indigo-950"
      >
        <Lock
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-indigo-700"
        />
        <div>
          <p className="font-bold">
            Khu vực kiểm duyệt Sách người dùng (tách biệt hoàn toàn với Sách danh
            mục)
          </p>
          <p className="mt-0.5 text-xs text-indigo-900 sm:text-sm">
            Phê duyệt tại đây chỉ mở quyền cho đúng phụ huynh sở hữu thêm đúng
            phiên bản trang vào sách riêng của gia đình họ — tuyệt đối không đưa
            sách riêng ra thư viện chung. Nội dung vi phạm mức chặn an toàn trẻ
            em (HIGH / NOT_RECOMMENDED) không thể duyệt bỏ qua.
          </p>
        </div>
      </div>

      {/* Filters & Search */}
      <section className="rounded-card border border-border bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-extrabold text-ink">
              Hàng đợi kiểm duyệt Sách người dùng
            </h2>
            <p className="mt-1 text-xs text-muted sm:text-sm">
              Lọc theo trạng thái cần xử lý hoặc tìm theo tên sách riêng.
            </p>
          </div>
          <Button
            className="min-h-10 w-auto px-3 text-sm"
            disabled={loadingQueue}
            onClick={() => void loadQueue()}
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Tải lại hàng đợi
          </Button>
        </div>

        {/* 6 Required Status Filter Buttons + All */}
        <div
          aria-label="Bộ lọc trạng thái Sách người dùng"
          className="mt-4 flex flex-wrap gap-2"
          role="group"
        >
          <button
            aria-pressed={statusFilter === ""}
            className={
              "inline-flex min-h-10 items-center gap-1.5 rounded-control border px-3 text-xs font-bold transition sm:text-sm " +
              (statusFilter === ""
                ? "border-primary bg-primary text-white"
                : "border-border bg-white text-ink hover:bg-canvas")
            }
            onClick={() => setStatusFilter("")}
            type="button"
          >
            Tất cả
          </button>
          {QUEUE_FILTER_KEYS.map((filterKey) => {
            const count = summary[filterKey] ?? 0;
            const active = statusFilter === filterKey;
            return (
              <button
                key={filterKey}
                aria-pressed={active}
                className={
                  "inline-flex min-h-10 items-center gap-1.5 rounded-control border px-3 text-xs font-bold transition sm:text-sm " +
                  (active
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-white text-ink hover:bg-canvas")
                }
                onClick={() => setStatusFilter(filterKey)}
                type="button"
              >
                {ADMIN_USER_BOOK_FILTER_LABELS[filterKey]}
                <span
                  className={
                    "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums " +
                    (active
                      ? "bg-white/20 text-white"
                      : "bg-canvas text-ink")
                  }
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 max-w-md">
          <label className="relative block">
            <span className="sr-only">Tìm sách người dùng theo tên sách</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
            />
            <input
              aria-label="Tìm sách người dùng theo tên sách"
              className="min-h-11 w-full rounded-control border border-border bg-white pl-9 pr-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Tìm theo tên sách riêng…"
              type="search"
              value={searchText}
            />
          </label>
        </div>

        {queueError ? (
          <StatusMessage className="mt-4" title="Lỗi tải hàng đợi" tone="error">
            {queueError}
          </StatusMessage>
        ) : null}

        {loadingQueue ? (
          <div aria-busy="true" className="mt-4 grid gap-3">
            {[0, 1, 2].map((idx) => (
              <Skeleton key={idx} className="h-24 w-full rounded-control" />
            ))}
          </div>
        ) : !queue || queue.items.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              description="Không có bản nộp sách riêng nào khớp bộ lọc hiện tại."
              title="Không có mục cần xử lý"
            />
          </div>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {queue.items.map((item: AdminUserBookQueueItemDTO) => {
              const targetSubId = item.latest_submission_id;
              const isSelected = Boolean(
                targetSubId && selectedId === targetSubId,
              );
              const tone =
                QUEUE_STATUS_TONES[item.queue_status] ??
                "border-border bg-canvas text-ink";
              return (
                <li
                  key={`${item.book_id}:${targetSubId ?? "none"}`}
                  className={
                    "flex flex-col justify-between gap-3 rounded-control border p-4 transition sm:flex-row sm:items-center " +
                    (isSelected
                      ? "border-primary bg-sky/25 ring-2 ring-primary/20"
                      : "border-border bg-white hover:border-primary/50")
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold ${tone}`}
                      >
                        {ADMIN_USER_BOOK_FILTER_LABELS[item.queue_status]}
                      </span>
                      {item.moderation_status === "SUSPENDED" ? (
                        <span className="inline-flex items-center rounded-full border border-rose-300 bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-900">
                          Đang đình chỉ
                        </span>
                      ) : null}
                      {item.policy_blocked ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-rose-400 bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-900">
                          <ShieldAlert aria-hidden="true" className="size-3" />
                          Chặn chính sách
                        </span>
                      ) : null}
                    </div>
                    <h3 className="mt-1.5 text-base font-extrabold text-ink">
                      {item.book_title}
                    </h3>
                    <p className="mt-0.5 text-xs text-muted">
                      Chủ sở hữu: <strong>{item.owner_label}</strong>
                      {item.latest_submission_version
                        ? ` · Phiên bản v${item.latest_submission_version}`
                        : ""}
                      {" · "}Đã thêm {item.committed_page_count} trang
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Chờ duyệt: <strong>{item.pending_count}</strong> · Cảnh
                      báo: <strong>{item.flagged_count}</strong> · Lỗi:{" "}
                      <strong>{item.failed_count}</strong> · Cập nhật:{" "}
                      {formatDateTime(item.latest_submitted_at)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center">
                    <Button
                      className="min-h-10 w-full px-4 text-sm sm:w-auto"
                      disabled={!targetSubId}
                      onClick={() => {
                        if (targetSubId) {
                          void openDetail(targetSubId);
                        }
                      }}
                      type="button"
                      variant={isSelected ? "primary" : "secondary"}
                    >
                      Mở để duyệt
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Detail Review Panel */}
      {selectedId ? (
        <section
          aria-label="Chi tiết kiểm duyệt trang sách người dùng"
          className="rounded-card border-2 border-primary/30 bg-white p-4 shadow-sm sm:p-6"
        >
          {loadingDetail ? (
            <div aria-busy="true" className="flex flex-col gap-4">
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : detailError || !detail ? (
            <StatusMessage title="Không thể mở chi tiết bản nộp" tone="error">
              {detailError ?? "Không tìm thấy bản nộp."}
            </StatusMessage>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-bold text-indigo-900">
                      Sách riêng của phụ huynh
                    </span>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                        WORKFLOW_TONES[detail.workflow_status] ??
                        "border-border bg-canvas text-ink"
                      }`}
                    >
                      {detail.workflow_status_label}
                    </span>
                    {detail.book_moderation_status === "SUSPENDED" ? (
                      <span className="rounded-full border border-rose-300 bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-900">
                        Sách đang bị đình chỉ
                      </span>
                    ) : null}
                  </div>
                  <h3 className="mt-2 text-xl font-extrabold text-ink">
                    {detail.book_title} — Trang nguồn{" "}
                    {detail.source_page_number}/{detail.batch_total_pages}
                  </h3>
                  <p className="mt-1 text-xs text-muted">
                    Chủ sở hữu: <strong>{detail.owner_label}</strong> · Phiên
                    bản <strong>v{detail.submission_version}</strong> · Khóa
                    kiểm soát #{detail.optimistic_lock_version}
                    {detail.snapshot_hash
                      ? ` · Hash ${detail.snapshot_hash.slice(0, 12)}`
                      : ""}
                  </p>
                </div>

                <Button
                  className="min-h-10 w-auto px-3 text-xs"
                  onClick={() => void openDetail(detail.submission_id)}
                  type="button"
                  variant="secondary"
                >
                  <RefreshCw aria-hidden="true" className="size-3.5" />
                  Tải bản mới nhất
                </Button>
              </div>

              {conflictError ? (
                <StatusMessage title="Xung đột phiên bản (409)" tone="warning">
                  <div className="flex flex-col gap-2">
                    <p>{conflictError}</p>
                    <Button
                      className="min-h-9 w-auto self-start px-3 text-xs"
                      onClick={() => void openDetail(detail.submission_id)}
                      type="button"
                      variant="secondary"
                    >
                      <RotateCcw aria-hidden="true" className="size-3.5" />
                      Tải lại phiên bản mới nhất
                    </Button>
                  </div>
                </StatusMessage>
              ) : null}

              {actionError ? (
                <StatusMessage title="Chưa thể hoàn tất" tone="error">
                  {actionError}
                </StatusMessage>
              ) : null}

              {actionNotice ? (
                <StatusMessage title="Đã lưu quyết định" tone="success">
                  {actionNotice}
                </StatusMessage>
              ) : null}

              <div className="grid gap-5 lg:grid-cols-12">
                {/* Left Column: Authenticated Page Image */}
                <div className="lg:col-span-5">
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
                    Ảnh trang gốc (tải qua proxy xác thực Admin)
                  </p>
                  <div className="overflow-hidden rounded-card border border-border bg-cream p-3">
                    <AuthenticatedImage
                      alt={`Ảnh trang nguồn ${detail.source_page_number} của ${detail.book_title}`}
                      className="mx-auto max-h-[420px] w-full object-contain"
                      src={detail.image_url}
                    />
                  </div>
                  <div className="mt-3 rounded-control border border-border bg-canvas p-3 text-xs">
                    <p className="font-bold text-ink">
                      Khai báo từ phụ huynh (chỉ tham khảo)
                    </p>
                    <p className="mt-1">
                      <strong>Nguồn:</strong> {detail.source_type_label}
                    </p>
                    {detail.source_note ? (
                      <p className="mt-1">
                        <strong>Ghi chú nguồn:</strong> {detail.source_note}
                      </p>
                    ) : null}
                    {detail.parent_request_note ? (
                      <p className="mt-1">
                        <strong>Lời nhắn gửi Admin:</strong>{" "}
                        {detail.parent_request_note}
                      </p>
                    ) : null}
                  </div>
                </div>

                {/* Right Column: Evidence, Texts, Findings & Decision Controls */}
                <div className="flex flex-col gap-4 lg:col-span-7">
                  {/* Text Comparison */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-control border border-border bg-canvas p-3">
                      <p className="text-xs font-bold text-muted">
                        Văn bản OCR gốc
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink">
                        {detail.ocr_text?.trim() ||
                          "(Không trích xuất được chữ / trang chỉ có hình)"}
                      </p>
                    </div>
                    <div className="rounded-control border border-border bg-white p-3">
                      <p className="text-xs font-bold text-ink">
                        Văn bản đề xuất thêm vào sách
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink">
                        {detail.candidate_text?.trim() ||
                          "(Trang ảnh không có văn bản)"}
                      </p>
                    </div>
                  </div>

                  {/* Tool Check Summary & Scope */}
                  <div className="rounded-control border border-border bg-slate-50 p-3 text-xs">
                    <p className="font-bold text-ink">
                      Kết quả Tool Check · {detail.tool_check_status}
                      {detail.tool_check_suitability
                        ? ` (${detail.tool_check_suitability})`
                        : ""}
                    </p>
                    <p className="mt-1 text-slate-700">
                      Phạm vi: {detail.tool_check_scope.modality} · Đã quét{" "}
                      {detail.tool_check_scope.chunks_checked}/
                      {detail.tool_check_scope.total_chunks} đoạn ·{" "}
                      {detail.tool_check_scope.local_ai_enforced
                        ? "Ollama local bắt buộc"
                        : "AI mặc định"}{" "}
                      · Quét bản quyền:{" "}
                      {detail.tool_check_scope.copyright_scanner_status}.
                    </p>
                  </div>

                  {/* Findings — Sensitive Excerpts Collapsed by Default */}
                  {detail.tool_check_findings.length > 0 ? (
                    <div className="rounded-control border border-amber-300 bg-amber-50 p-3">
                      <p className="flex items-center gap-1.5 text-xs font-bold text-amber-950">
                        <AlertTriangle
                          aria-hidden="true"
                          className="size-4 shrink-0"
                        />
                        Cảnh báo Tool Check ({detail.tool_check_findings.length})
                      </p>
                      <ul className="mt-2 space-y-2 text-xs">
                        {detail.tool_check_findings.map((finding, idx) => (
                          <li
                            key={finding.finding_id ?? idx}
                            className="rounded border border-amber-200 bg-white p-2.5"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-bold text-ink">
                                {finding.category}
                              </span>
                              <span
                                className={
                                  "rounded px-1.5 py-0.5 text-[11px] font-bold " +
                                  (finding.severity === "HIGH"
                                    ? "bg-rose-100 text-rose-900"
                                    : "bg-amber-100 text-amber-950")
                                }
                              >
                                {finding.severity}
                              </span>
                            </div>
                            {finding.explanation ? (
                              <p className="mt-1 text-ink">
                                {finding.explanation}
                              </p>
                            ) : null}
                            {finding.excerpt ? (
                              <details className="mt-1.5">
                                <summary className="cursor-pointer font-semibold text-primary">
                                  Xem đoạn nhạy cảm bị gắn cờ
                                </summary>
                                <p className="mt-1 rounded bg-slate-100 p-2 font-mono text-[11px] text-ink">
                                  {finding.excerpt}
                                </p>
                              </details>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {/* Policy-Block Warning */}
                  {detail.tool_check_policy_blocked ? (
                    <StatusMessage
                      title="Nội dung bị chặn theo chính sách an toàn trẻ em"
                      tone="error"
                    >
                      {detail.approve_blocked_reason ??
                        "Phiên bản này bị gắn cờ mức chặn (HIGH / NOT_RECOMMENDED). Nút Duyệt bản này bị vô hiệu hóa; Admin chỉ có thể Yêu cầu sửa, Từ chối hoặc Đình chỉ sách riêng."}
                    </StatusMessage>
                  ) : null}

                  {/* Moderation Decision Form */}
                  <div className="rounded-card border border-border bg-canvas/60 p-4">
                    <label className="flex flex-col gap-1.5 text-xs font-bold text-ink">
                      Lý do quyết định Admin * (tối thiểu 5 ký tự)
                      <textarea
                        aria-label="Lý do quyết định Admin"
                        className="min-h-24 w-full rounded-control border border-border bg-white p-2.5 text-sm font-normal text-ink focus-visible:outline-3 focus-visible:outline-primary"
                        onChange={(event) =>
                          setDecisionReason(event.target.value)
                        }
                        placeholder="Ghi rõ lý do duyệt phiên bản này, yêu cầu chỉnh sửa hoặc từ chối…"
                        value={decisionReason}
                      />
                    </label>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        className="min-h-11 w-auto px-4 text-sm"
                        disabled={!detail.can_approve || busyAction !== null}
                        isLoading={busyAction === "decide:APPROVE"}
                        onClick={() => void submitDecision("APPROVE")}
                        type="button"
                      >
                        <ShieldCheck aria-hidden="true" className="size-4" />
                        Duyệt bản này
                      </Button>

                      <Button
                        className="min-h-11 w-auto px-4 text-sm"
                        disabled={busyAction !== null}
                        isLoading={busyAction === "decide:REQUEST_CHANGES"}
                        onClick={() => void submitDecision("REQUEST_CHANGES")}
                        type="button"
                        variant="secondary"
                      >
                        <CheckCircle2 aria-hidden="true" className="size-4" />
                        Yêu cầu sửa
                      </Button>

                      <Button
                        className="min-h-11 w-auto px-4 text-sm"
                        disabled={busyAction !== null}
                        isLoading={busyAction === "decide:REJECT"}
                        onClick={() => void submitDecision("REJECT")}
                        type="button"
                        variant="destructive"
                      >
                        <XCircle aria-hidden="true" className="size-4" />
                        Từ chối
                      </Button>
                    </div>

                    {/* Suspend Book */}
                    {detail.book_moderation_status !== "SUSPENDED" ? (
                      <div className="mt-4 border-t border-border pt-3">
                        <p className="text-xs font-bold text-ink">
                          Đình chỉ toàn bộ sách riêng (chặn đọc ngay lập tức)
                        </p>
                        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                          <input
                            aria-label="Lý do đình chỉ sách riêng"
                            className="min-h-10 flex-1 rounded-control border border-border bg-white px-3 text-xs text-ink"
                            onChange={(event) =>
                              setSuspendReason(event.target.value)
                            }
                            placeholder="Nhập lý do đình chỉ sách riêng…"
                            value={suspendReason}
                          />
                          <Button
                            className="min-h-10 w-auto px-4 text-xs"
                            disabled={busyAction !== null}
                            isLoading={busyAction === "suspend"}
                            onClick={() => void handleSuspendBook()}
                            type="button"
                            variant="destructive"
                          >
                            <Ban aria-hidden="true" className="size-3.5" />
                            Đình chỉ
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-3 rounded bg-rose-50 p-2 text-xs font-semibold text-rose-900">
                        Sách riêng này hiện đã bị đình chỉ
                        {detail.book_suspended_reason
                          ? `: ${detail.book_suspended_reason}`
                          : "."}
                      </p>
                    )}
                  </div>

                  {/* Moderation History */}
                  <div className="rounded-control border border-border bg-white p-3">
                    <p className="text-xs font-bold text-ink">
                      Lịch sử kiểm duyệt ({detail.history.length})
                    </p>
                    {detail.history.length === 0 ? (
                      <p className="mt-1 text-xs text-muted">
                        Chưa có yêu cầu duyệt hoặc quyết định nào trước đó.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-2 text-xs">
                        {detail.history.map((hist) => (
                          <li
                            key={hist.request_id}
                            className="rounded border border-border bg-canvas/50 p-2"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-1">
                              <span className="font-bold text-ink">
                                v{hist.submission_version} · {hist.status}
                                {hist.decided_by_label
                                  ? ` · ${hist.decided_by_label}`
                                  : ""}
                              </span>
                              <span className="text-[11px] text-muted">
                                {formatDateTime(hist.created_at)}
                              </span>
                            </div>
                            {hist.decision_reason ? (
                              <p className="mt-1 text-ink">
                                Lý do Admin: {hist.decision_reason}
                              </p>
                            ) : null}
                            {hist.parent_request_note ? (
                              <p className="mt-0.5 text-muted">
                                Ghi chú phụ huynh: {hist.parent_request_note}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
