"use client";

import {
  CheckCircle2,
  Image as ImageIcon,
  RotateCcw,
  Scissors,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import {
  fetchAuthenticatedBlobUrl,
  revokePrivateBlobUrl,
} from "@/lib/api/api-client";
import {
  createBookAssetsService,
  isStudioAuthenticatedMediaUrl,
  type BookAssetsService,
} from "@/lib/api/book-assets-service";
import { emitStudioTasksChanged } from "@/lib/api/global-tasks-service";
import { isServiceError } from "@/lib/api/service-error";
import { cn } from "@/lib/utils/cn";
import type {
  AssetModerationStatus,
  BookAssetsSummaryDTO,
  BookPresentationAssetDTO,
} from "@/types/book-assets";

export interface PageIllustrationStudioProps {
  readonly bookId: string;
  readonly pageId: string;
  readonly pageNumber?: number;
  readonly actorRole: "admin" | "parent";
  readonly wordBboxes?: number[][];
  readonly canonicalText?: string | null;
  readonly autoLoad?: boolean;
  readonly compact?: boolean;
  readonly service?: BookAssetsService;
  readonly onAssetChanged?: (asset: BookPresentationAssetDTO | null) => void;
  readonly className?: string;
}

const MODERATION_LABELS_VI: Record<AssetModerationStatus, string> = {
  PENDING: "Chờ duyệt hiển thị",
  APPROVED: "Đã duyệt hiển thị cho bé",
  REJECTED: "Đã từ chối",
  STALE: "Phiên bản cũ",
};

const MODERATION_BADGE_TONES: Record<AssetModerationStatus, string> = {
  PENDING: "border-amber-300 bg-amber-50 text-amber-900",
  APPROVED: "border-emerald-300 bg-emerald-50 text-emerald-900",
  REJECTED: "border-rose-300 bg-rose-50 text-rose-900",
  STALE: "border-border bg-canvas text-muted",
};

const SOURCE_LABELS_VI: Record<string, string> = {
  ORIGINAL_CROP: "Tách trực tiếp từ trang sách",
  ENHANCED_CROP: "Tách từ trang & phục hồi ánh sáng",
  AI_GENERATED: "Tạo bằng AI (0 VND)",
  USER_UPLOAD: "Tải lên thủ công",
  METADATA_RENDER: "Minh họa mặc định",
};

function formatStudioError(error: unknown, fallback: string): string {
  if (isServiceError(error) && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function selectPageIllustration(
  summary: BookAssetsSummaryDTO | null,
  pageId: string,
): BookPresentationAssetDTO | null {
  if (!summary) return null;
  const pageAssets = summary.page_illustrations.filter(
    (asset) =>
      asset.book_page_id === pageId && asset.asset_role === "PAGE_ILLUSTRATION",
  );
  if (pageAssets.length === 0) return null;
  return (
    pageAssets.find(
      (asset) => asset.is_active && asset.moderation_status === "APPROVED",
    ) ??
    pageAssets.find((asset) => asset.is_active) ??
    pageAssets[0] ??
    null
  );
}

export function PageIllustrationStudio({
  bookId,
  pageId,
  pageNumber,
  actorRole,
  wordBboxes,
  canonicalText = null,
  autoLoad = true,
  compact = false,
  service: injectedService,
  onAssetChanged,
  className,
}: PageIllustrationStudioProps) {
  const defaultService = useMemo(() => createBookAssetsService(), []);
  const service = injectedService ?? defaultService;
  const taskCenter = useOptionalAiTaskCenter();
  const tCommon = useTranslations("common");

  const [summary, setSummary] = useState<BookAssetsSummaryDTO | null>(null);
  const [asset, setAsset] = useState<BookPresentationAssetDTO | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<
    "extract" | "generate" | "approve" | "reject" | "restore" | null
  >(null);
  const [promptHint, setPromptHint] = useState("");
  const [notice, setNotice] = useState<{
    tone: "info" | "success" | "warning" | "error";
    title?: string;
    message: string;
  } | null>(null);

  const [mediaBlobState, setMediaBlobState] = useState<{
    url: string;
    blobUrl: string | null;
    failed: boolean;
  }>({ url: "", blobUrl: null, failed: false });

  const scopeKey = `${bookId}:${pageId}`;

  useEffect(() => {
    if (!autoLoad) return;
    const controller = new AbortController();
    let active = true;
    void service
      .getBookAssets(bookId, controller.signal)
      .then((data) => {
        if (!active || controller.signal.aborted) return;
        setSummary(data);
        setAsset(selectPageIllustration(data, pageId));
        setLoadedKey(scopeKey);
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setLoadedKey(scopeKey);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [autoLoad, bookId, pageId, scopeKey, service]);

  const mediaUrl = asset?.media_url ?? null;
  const needsAuthFetch = isStudioAuthenticatedMediaUrl(mediaUrl);

  useEffect(() => {
    if (!mediaUrl || !needsAuthFetch) return;
    const controller = new AbortController();
    let createdBlob: string | null = null;
    let active = true;

    void fetchAuthenticatedBlobUrl(mediaUrl, controller.signal)
      .then((blobUrl) => {
        if (!active) {
          revokePrivateBlobUrl(blobUrl);
          return;
        }
        createdBlob = blobUrl;
        setMediaBlobState({ url: mediaUrl, blobUrl, failed: false });
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setMediaBlobState({ url: mediaUrl, blobUrl: null, failed: true });
      });

    return () => {
      active = false;
      controller.abort();
      if (createdBlob) {
        revokePrivateBlobUrl(createdBlob);
      }
    };
  }, [mediaUrl, needsAuthFetch]);

  const resolvedPreviewSrc = !mediaUrl
    ? null
    : needsAuthFetch
      ? mediaBlobState.url === mediaUrl && !mediaBlobState.failed
        ? mediaBlobState.blobUrl
        : null
      : mediaUrl;

  async function handleExtractFromPage() {
    if (busyAction) return;
    setBusyAction("extract");
    setNotice(null);
    try {
      const res = await service.extractPageIllustration(bookId, pageId, {
        word_bboxes: wordBboxes ?? [],
        canonical_text: canonicalText,
        apply_clahe_restore: true,
      });
      if (
        typeof document === "undefined" ||
        document.visibilityState !== "hidden"
      ) {
        if (res.asset?.job_id) {
          taskCenter?.markTaskAlertSeen(res.asset.job_id, {
            includeNextSync: true,
          });
        }
        taskCenter?.markTargetAlertsSeen(
          {
            bookId,
            bookPageId: pageId,
            jobTypes: ["ILLUSTRATION_EXTRACT", "ILLUSTRATION_GENERATE"],
          },
          { includeNextSync: true },
        );
      }
      emitStudioTasksChanged({ portal: actorRole });
      if (res.asset) {
        setAsset(res.asset);
        onAssetChanged?.(res.asset);
      }
      if (res.status === "EXTRACTED_VERIFIED") {
        setNotice({
          tone: "success",
          title: "Đã tách tranh minh họa sạch chữ",
          message: res.message_vi,
        });
      } else if (res.status === "REJECTED_CONTAINS_TEXT") {
        setNotice({
          tone: "warning",
          title: "Vùng tranh vẫn còn chữ dính kèm",
          message: res.message_vi,
        });
      } else {
        setNotice({
          tone: "info",
          title: "Không phát hiện vùng tranh sạch chữ",
          message: res.message_vi,
        });
      }
    } catch (error) {
      setNotice({
        tone: "error",
        message: formatStudioError(
          error,
          "Chưa thể tách tranh minh họa từ trang này. Vui lòng thử lại.",
        ),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleGenerateAi() {
    if (busyAction) return;
    setBusyAction("generate");
    setNotice(null);
    try {
      const res = await service.generatePageIllustration(bookId, pageId, {
        prompt_hint: promptHint.trim() || null,
      });
      const includeNextSync =
        res.status !== "QUEUED" &&
        res.status !== "WAITING_FOR_QUOTA" &&
        (typeof document === "undefined" ||
          document.visibilityState !== "hidden");
      if (res.job_id) {
        taskCenter?.markTaskAlertSeen(
          res.job_id,
          includeNextSync ? { includeNextSync: true } : undefined,
        );
      }
      taskCenter?.markTargetAlertsSeen(
        {
          bookId,
          bookPageId: pageId,
          jobTypes: ["ILLUSTRATION_EXTRACT", "ILLUSTRATION_GENERATE"],
        },
        includeNextSync ? { includeNextSync: true } : undefined,
      );
      emitStudioTasksChanged({ portal: actorRole });
      if (res.asset) {
        setAsset(res.asset);
        onAssetChanged?.(res.asset);
      }
      if (res.status === "SUCCEEDED") {
        setNotice({
          tone: "success",
          title: "Đã tạo tranh minh họa AI sạch chữ",
          message: res.message_vi,
        });
      } else if (res.status === "QUEUED") {
        setNotice({
          tone: "info",
          title: "Đã xếp hàng tạo tranh minh họa AI",
          message: res.message_vi,
        });
      } else if (res.status === "REJECTED_CONTAINS_TEXT") {
        setNotice({
          tone: "warning",
          title: "Tranh AI bị chặn do phát hiện ký tự",
          message: res.message_vi,
        });
      } else {
        setNotice({
          tone: "info",
          title:
            res.status === "WAITING_FOR_QUOTA"
              ? "Tạm chờ hạn mức tạo ảnh AI miễn phí"
              : "Chưa có nhà cung cấp tạo ảnh AI miễn phí",
          message: res.message_vi,
        });
      }
    } catch (error) {
      setNotice({
        tone: "error",
        message: formatStudioError(
          error,
          "Chưa thể tạo tranh minh họa AI lúc này. Bé vẫn đọc bình thường ở chế độ Đọc chữ.",
        ),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleModerate(action: "APPROVE" | "REJECT" | "RESTORE") {
    if (!asset || busyAction) return;
    setBusyAction(
      action === "APPROVE"
        ? "approve"
        : action === "REJECT"
          ? "reject"
          : "restore",
    );
    setNotice(null);
    try {
      const updated = await service.moderatePageIllustration(
        bookId,
        pageId,
        asset.id,
        action,
      );
      setAsset(updated);
      onAssetChanged?.(updated);
      if (updated.job_id) {
        taskCenter?.markTaskAlertSeen(updated.job_id, {
          includeNextSync: true,
        });
      }
      taskCenter?.markTargetAlertsSeen(
        {
          bookId,
          bookPageId: pageId,
          jobTypes: ["ILLUSTRATION_EXTRACT", "ILLUSTRATION_GENERATE"],
        },
        { includeNextSync: true },
      );
      emitStudioTasksChanged({ portal: actorRole });
      setNotice({
        tone: action === "REJECT" ? "warning" : "success",
        title:
          action === "APPROVE"
            ? "Đã duyệt tranh minh họa cho chế độ Đọc có tranh"
            : action === "REJECT"
              ? "Đã từ chối tranh minh họa"
              : "Đã khôi phục tranh minh họa",
        message:
          action === "APPROVE"
            ? "Bé có thể bật chế độ Đọc có tranh trên trang này với tranh minh họa sạch chữ."
            : action === "REJECT"
              ? "Tranh đã được ẩn khỏi màn hình đọc của bé; chế độ Đọc chữ luôn được ưu tiên."
              : "Tranh đã được khôi phục trạng thái kiểm duyệt.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: formatStudioError(
          error,
          "Không thể cập nhật trạng thái duyệt tranh minh họa.",
        ),
      });
    } finally {
      setBusyAction(null);
    }
  }

  const isLoadingInitial = autoLoad && loadedKey !== scopeKey;
  const ocrGateMode =
    typeof asset?.metadata?.ocr_gate_mode === "string"
      ? asset.metadata.ocr_gate_mode
      : null;

  const extractIllustrationStages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.analyzing") },
      { atPct: 38, label: tCommon("aiProgress.generatingIllustration") },
      { atPct: 74, label: tCommon("aiProgress.safetyChecking") },
    ],
    [tCommon],
  );
  const generateIllustrationStages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.preparing") },
      { atPct: 22, label: tCommon("aiProgress.generatingIllustration") },
      { atPct: 70, label: tCommon("aiProgress.safetyChecking") },
      { atPct: 88, label: tCommon("aiProgress.finalizing") },
    ],
    [tCommon],
  );
  const extractProgress = useAiProgress({
    active: busyAction === "extract",
    stages: extractIllustrationStages,
    expectedDurationMs: 12_000,
  });
  const generateProgress = useAiProgress({
    active: busyAction === "generate",
    stages: generateIllustrationStages,
    expectedDurationMs: 18_000,
  });

  return (
    <section
      aria-label={
        pageNumber
          ? `Studio tranh minh họa trang ${pageNumber}`
          : "Studio tranh minh họa trang sách"
      }
      className={cn(
        "flex flex-col gap-4 rounded-card border border-border bg-white p-4 sm:p-5",
        className,
      )}
      data-testid="page-illustration-studio"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-extrabold text-ink sm:text-lg">
            Studio tranh minh họa sạch chữ
            {pageNumber ? ` — Trang ${pageNumber}` : ""}
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            {actorRole === "parent"
              ? "Tách tranh từ trang sách gia đình hoặc tạo tranh minh họa bằng AI nội bộ 0 VND (chỉ hiển thị cho bé khi đạt kiểm tra sạch chữ)."
              : "Tách vùng tranh từ trang scan hoặc tạo tranh AI qua bộ định tuyến 0 VND; mọi tranh đều qua cổng kiểm tra Text-Free trước khi mở chế độ Đọc có tranh."}
          </p>
        </div>
        {asset ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold",
                asset.text_free_verified
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                  : "border-rose-300 bg-rose-50 text-rose-900",
              )}
              data-testid="text-free-badge"
            >
              {asset.text_free_verified ? (
                <>
                  <ShieldCheck aria-hidden="true" className="size-3.5" />
                  Đã xác minh sạch chữ
                </>
              ) : (
                <>
                  <ShieldAlert aria-hidden="true" className="size-3.5" />
                  Chưa đạt sạch chữ
                </>
              )}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold",
                MODERATION_BADGE_TONES[asset.moderation_status],
              )}
              data-testid="illustration-moderation-badge"
            >
              {MODERATION_LABELS_VI[asset.moderation_status]}
            </span>
          </div>
        ) : null}
      </div>

      {notice ? (
        <StatusMessage title={notice.title} tone={notice.tone}>
          {notice.message}
        </StatusMessage>
      ) : null}

      <div
        className={cn(
          "grid min-w-0 gap-4",
          compact ? "grid-cols-1" : "xl:grid-cols-[200px_minmax(0,1fr)]",
        )}
      >
        {/* Preview box */}
        <div className="flex min-w-0 flex-col items-center gap-2">
          <div className="flex aspect-[4/3] w-full max-w-[240px] items-center justify-center overflow-hidden rounded-control border border-border bg-cream/70 p-2">
            {isLoadingInitial ? (
              <div
                aria-busy="true"
                className="h-full w-full animate-pulse rounded-control bg-canvas"
              />
            ) : resolvedPreviewSrc ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                alt={
                  pageNumber
                    ? `Tranh minh họa trang ${pageNumber}`
                    : "Tranh minh họa trang sách"
                }
                className="h-full w-full rounded-control object-contain"
                data-testid="page-illustration-preview-img"
                src={resolvedPreviewSrc}
              />
            ) : (
              <div className="flex flex-col items-center gap-1.5 text-center text-xs text-muted">
                <ImageIcon aria-hidden="true" className="size-7 text-muted" />
                <span>Chưa có tranh minh họa sạch chữ</span>
              </div>
            )}
          </div>
          {asset ? (
            <p className="text-center text-[11px] font-medium text-muted">
              {SOURCE_LABELS_VI[asset.source_type] ?? asset.source_type}
              {ocrGateMode ? ` · Cổng OCR: ${ocrGateMode}` : ""}
            </p>
          ) : null}
        </div>

        {/* Actions */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="min-h-11 w-auto px-3.5 text-xs"
              data-testid="extract-illustration-btn"
              disabled={busyAction !== null}
              fullWidth={false}
              isLoading={busyAction === "extract"}
              onClick={() => void handleExtractFromPage()}
              type="button"
              variant="secondary"
            >
              <Scissors aria-hidden="true" className="size-4" />
              Tách tranh từ trang sách
            </Button>

            {asset && asset.moderation_status !== "APPROVED" ? (
              <Button
                className="min-h-11 w-auto px-3.5 text-xs"
                data-testid="approve-illustration-btn"
                disabled={busyAction !== null || !asset.text_free_verified}
                fullWidth={false}
                isLoading={busyAction === "approve"}
                onClick={() => void handleModerate("APPROVE")}
                title={
                  !asset.text_free_verified
                    ? "Chỉ được duyệt tranh đã đạt xác minh sạch chữ"
                    : undefined
                }
                type="button"
                variant="primary"
              >
                <CheckCircle2 aria-hidden="true" className="size-4" />
                Duyệt hiển thị
              </Button>
            ) : null}

            {asset && asset.moderation_status !== "REJECTED" ? (
              <Button
                className="min-h-11 w-auto px-3.5 text-xs"
                data-testid="reject-illustration-btn"
                disabled={busyAction !== null}
                fullWidth={false}
                isLoading={busyAction === "reject"}
                onClick={() => void handleModerate("REJECT")}
                type="button"
                variant="destructive"
              >
                <XCircle aria-hidden="true" className="size-4" />
                Từ chối tranh
              </Button>
            ) : null}

            {asset && asset.moderation_status === "REJECTED" ? (
              <Button
                className="min-h-11 w-auto px-3.5 text-xs"
                data-testid="restore-illustration-btn"
                disabled={busyAction !== null}
                fullWidth={false}
                isLoading={busyAction === "restore"}
                onClick={() => void handleModerate("RESTORE")}
                type="button"
                variant="secondary"
              >
                <RotateCcw aria-hidden="true" className="size-4" />
                Khôi phục
              </Button>
            ) : null}
          </div>

          {busyAction === "extract" ? (
            <AiProgressBar
              active
              elapsedSeconds={extractProgress.elapsedSeconds}
              label={
                extractProgress.stageLabel ??
                tCommon("aiProgress.generatingIllustration")
              }
              percent={extractProgress.percent}
              size="sm"
              testId="page-illustration-extract-progress"
            />
          ) : null}

          {/* 0 VND AI Generation block */}
          <div className="flex flex-col gap-2 rounded-control border border-border bg-canvas/70 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="inline-flex items-center gap-1.5 text-xs font-bold text-ink">
                <Sparkles
                  aria-hidden="true"
                  className="size-3.5 text-primary"
                />
                Tạo tranh minh họa bằng AI (miễn phí 0 VND)
              </p>
              {summary ? (
                <span className="text-[11px] font-semibold text-muted">
                  {summary.ai_image_provider_available
                    ? `Nhà cung cấp: ${summary.ai_image_provider_name ?? "AI 0 VND"}`
                    : "Chưa cấu hình nhà cung cấp tạo ảnh AI"}
                </span>
              ) : null}
            </div>
            <div
              className={cn(
                "flex min-w-0 flex-col gap-2",
                compact ? "" : "xl:flex-row",
              )}
            >
              <input
                aria-label="Gợi ý cảnh cho tranh minh họa AI"
                className="min-h-11 w-full min-w-0 flex-1 rounded-control border border-border bg-white px-3 text-xs text-ink placeholder:text-muted"
                onChange={(event) => setPromptHint(event.target.value)}
                placeholder="Gợi ý khung cảnh cho bé (không chứa chữ viết)…"
                type="text"
                value={promptHint}
              />
              <Button
                className={cn(
                  "min-h-11 shrink-0 px-3.5 text-xs",
                  compact ? "w-full" : "w-full xl:w-auto",
                )}
                data-testid="generate-illustration-btn"
                disabled={busyAction !== null}
                fullWidth={false}
                isLoading={busyAction === "generate"}
                onClick={() => void handleGenerateAi()}
                type="button"
                variant="secondary"
              >
                <Sparkles aria-hidden="true" className="size-3.5" />
                Tạo tranh AI
              </Button>
            </div>
            {busyAction === "generate" ? (
              <AiProgressBar
                active
                elapsedSeconds={generateProgress.elapsedSeconds}
                label={
                  generateProgress.stageLabel ??
                  tCommon("aiProgress.generatingIllustration")
                }
                percent={generateProgress.percent}
                size="sm"
                testId="page-illustration-generate-progress"
              />
            ) : null}
            {summary && !summary.ai_image_provider_available ? (
              <p className="text-[11px] text-muted">
                {summary.ai_image_provider_message_vi}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
