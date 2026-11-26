"use client";

import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCheck,
  Eye,
  FileText,
  Pencil,
  RotateCcw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import {
  applyPageOcrExtractionToDraft,
  computeCanonicalPreviewText,
  extractPageOcrBlocks,
  getPageOcrExtraction,
  patchPageOcrBlocks,
  type ApplyOcrExtractionToDraftResponseDTO,
} from "@/lib/api/ocr-extraction-service";
import { isServiceError } from "@/lib/api/service-error";
import { cn } from "@/lib/utils/cn";
import {
  BLOCK_TYPE_LABELS_VI,
  PAGE_KIND_LABELS_VI,
  type BlockDecision,
  type BlockDecisionActionInputDTO,
  type ExtractedBlockDTO,
  type PageOcrExtractionDTO,
  type PatchPageBlocksRequestDTO,
} from "@/types/ocr-extraction";

export type OcrReviewTabId =
  "original" | "clean" | "excluded" | "review" | "preview";

export interface SmartOcrBlockReviewProps {
  readonly extraction: PageOcrExtractionDTO;
  readonly pageNumber?: number;
  readonly pageImageUrl?: string | null;
  readonly pageId?: string | null;
  readonly pageRevisionId?: string | null;
  readonly isRevisionVerified?: boolean;
  readonly canApplyToDraft?: boolean;
  readonly applyToDraftFn?: (
    pageId: string,
    payload?: { readonly page_revision_id?: string | null },
  ) => Promise<ApplyOcrExtractionToDraftResponseDTO>;
  readonly onApplyToDraft?: (
    result: ApplyOcrExtractionToDraftResponseDTO,
  ) => Promise<void> | void;
  readonly onPatchBlocks?: (
    payload: PatchPageBlocksRequestDTO,
  ) => Promise<PageOcrExtractionDTO> | PageOcrExtractionDTO;
  readonly onExtractionChange?: (next: PageOcrExtractionDTO) => void;
  readonly className?: string;
}

const DECISION_BADGE_STYLES: Record<BlockDecision, string> = {
  KEEP: "bg-success-surface text-success-ink border-success-ink/20",
  REVIEW: "bg-warning-surface text-warning border-warning/30",
  EXCLUDE: "bg-danger-surface text-danger border-danger/25",
};

const DECISION_LABELS_VI: Record<BlockDecision, string> = {
  KEEP: "Giữ lại",
  REVIEW: "Cần xác minh",
  EXCLUDE: "Đã loại",
};

const OVERLAY_BOX_STYLES: Record<BlockDecision, string> = {
  KEEP: "border-emerald-600 bg-emerald-500/10 text-emerald-950",
  REVIEW: "border-amber-500 bg-amber-400/20 text-amber-950",
  EXCLUDE: "border-rose-500 border-dashed bg-rose-500/15 text-rose-950",
};

function recomputeLocalExtraction(
  base: PageOcrExtractionDTO,
  nextBlocks: readonly ExtractedBlockDTO[],
  undoDepth: number,
): PageOcrExtractionDTO {
  const normalizedBlocks = nextBlocks.map((block) => ({
    ...block,
    in_canonical:
      block.block_type !== "ILLUSTRATION" &&
      (base.filter_mode !== "active" || block.decision !== "EXCLUDE"),
  }));
  const textBlocks = normalizedBlocks.filter(
    (block) => block.block_type !== "ILLUSTRATION",
  );
  const keepCount = textBlocks.filter((b) => b.decision === "KEEP").length;
  const excludeCount = textBlocks.filter(
    (b) => b.decision === "EXCLUDE",
  ).length;
  const reviewCount = textBlocks.filter((b) => b.decision === "REVIEW").length;

  const totalChars = textBlocks.reduce(
    (sum, b) => sum + b.display_text.length,
    0,
  );
  const keptChars = textBlocks
    .filter((b) => b.decision === "KEEP")
    .reduce((sum, b) => sum + b.display_text.length, 0);
  const excludedChars = textBlocks
    .filter((b) => b.decision === "EXCLUDE")
    .reduce((sum, b) => sum + b.display_text.length, 0);
  const reviewChars = textBlocks
    .filter((b) => b.decision === "REVIEW")
    .reduce((sum, b) => sum + b.display_text.length, 0);
  const inCanonicalChars = textBlocks
    .filter((b) => b.in_canonical)
    .reduce((sum, b) => sum + b.display_text.length, 0);

  const canonicalText = computeCanonicalPreviewText(
    normalizedBlocks,
    base.filter_mode,
  );
  const requiresReview =
    reviewCount > 0 || Boolean(base.geometry_transform?.requires_crop_review);

  return {
    ...base,
    blocks: normalizedBlocks,
    canonical_text: canonicalText,
    requires_review: requiresReview,
    undo_available: undoDepth > 0,
    undo_depth: undoDepth,
    stats: {
      ...base.stats,
      total_blocks: normalizedBlocks.length,
      keep_blocks: keepCount,
      exclude_blocks: excludeCount,
      review_blocks: reviewCount,
      total_chars: totalChars,
      kept_chars: keptChars,
      excluded_chars: excludedChars,
      review_chars: reviewChars,
      retention_ratio:
        totalChars > 0
          ? Math.round((inCanonicalChars / totalChars) * 10000) / 10000
          : 1,
    },
  };
}

function applyLocalPatch(
  current: PageOcrExtractionDTO,
  payload: PatchPageBlocksRequestDTO,
  undoStack: readonly (readonly ExtractedBlockDTO[])[],
): {
  nextExtraction: PageOcrExtractionDTO;
  nextUndoStack: (readonly ExtractedBlockDTO[])[];
  notice: string;
} {
  if (payload.undo) {
    if (undoStack.length === 0) {
      return {
        nextExtraction: current,
        nextUndoStack: [...undoStack],
        notice: "Chưa có thao tác nào để hoàn tác.",
      };
    }
    const nextStack = undoStack.slice(0, -1);
    const previousBlocks = undoStack[undoStack.length - 1];
    return {
      nextExtraction: recomputeLocalExtraction(
        current,
        previousBlocks,
        nextStack.length,
      ),
      nextUndoStack: nextStack,
      notice: "Đã hoàn tác thao tác gần nhất.",
    };
  }

  const nextStack = [...undoStack, current.blocks].slice(-20);
  const actionMap = new Map<string, BlockDecisionActionInputDTO>();
  for (const act of payload.actions ?? []) {
    actionMap.set(act.block_id, act);
  }

  let clearConfirmedCount = 0;
  let remainingReviewCount = 0;

  const updatedBlocks = current.blocks.map((block) => {
    const act = actionMap.get(block.block_id);
    if (act) {
      if (act.action === "KEEP") {
        return {
          ...block,
          decision: "KEEP" as const,
          decision_source: "HUMAN" as const,
          user_override: true,
          reason_vi: act.reason ?? "Người dùng chọn giữ lại khối này.",
          reason_code: "HUMAN_KEEP",
        };
      }
      if (act.action === "EXCLUDE") {
        return {
          ...block,
          decision: "EXCLUDE" as const,
          decision_source: "HUMAN" as const,
          user_override: true,
          reason_vi: act.reason ?? "Người dùng chọn loại bỏ khối này.",
          reason_code: "HUMAN_EXCLUDE",
        };
      }
      if (act.action === "RESTORE") {
        return {
          ...block,
          decision: "KEEP" as const,
          decision_source: "HUMAN" as const,
          user_override: true,
          reason_vi: act.reason ?? "Đã khôi phục khối vào bài đọc.",
          reason_code: "HUMAN_RESTORE",
        };
      }
      if (act.action === "EDIT" && act.edited_text) {
        const cleaned = act.edited_text.normalize("NFC").trim();
        return {
          ...block,
          edited_text: cleaned,
          display_text: cleaned,
          decision: "KEEP" as const,
          decision_source: "HUMAN" as const,
          user_override: true,
          reason_vi: act.reason ?? "Người dùng đã chỉnh sửa nội dung khối này.",
          reason_code: "HUMAN_EDIT",
        };
      }
    }

    if (payload.accept_clear_blocks) {
      // STRICT SAFETY RULE: Batch accept NEVER bypasses or modifies REVIEW blocks!
      if (block.decision === "REVIEW") {
        remainingReviewCount += 1;
        return block;
      }
      clearConfirmedCount += 1;
    }
    return block;
  });

  const nextExtraction = recomputeLocalExtraction(
    current,
    updatedBlocks,
    nextStack.length,
  );

  let notice = "Đã cập nhật trạng thái khối nội dung.";
  if (payload.accept_clear_blocks) {
    notice =
      remainingReviewCount > 0
        ? `Đã xác nhận ${clearConfirmedCount} khối rõ ràng. Vẫn còn ${remainingReviewCount} khối cần bạn xác minh thủ công.`
        : `Đã xác nhận tất cả ${clearConfirmedCount} khối rõ ràng.`;
  }

  return {
    nextExtraction,
    nextUndoStack: nextStack,
    notice,
  };
}

export function SmartOcrBlockReview({
  extraction: initialExtraction,
  pageNumber,
  pageImageUrl,
  pageId,
  pageRevisionId,
  isRevisionVerified = false,
  canApplyToDraft,
  applyToDraftFn,
  onApplyToDraft,
  onPatchBlocks,
  onExtractionChange,
  className,
}: SmartOcrBlockReviewProps) {
  const [extraction, setExtraction] =
    useState<PageOcrExtractionDTO>(initialExtraction);
  const [localUndoStack, setLocalUndoStack] = useState<
    (readonly ExtractedBlockDTO[])[]
  >([]);
  const [activeTab, setActiveTab] = useState<OcrReviewTabId>(
    initialExtraction.stats.review_blocks > 0 ? "review" : "clean",
  );
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [applyingToDraft, setApplyingToDraft] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "info" | "success" | "warning" | "error";
    text: string;
  } | null>(null);

  const orderedBlocks = useMemo(
    () =>
      [...extraction.blocks].sort((a, b) => a.reading_order - b.reading_order),
    [extraction.blocks],
  );

  const cleanBlocks = useMemo(
    () =>
      orderedBlocks.filter(
        (b) => b.block_type !== "ILLUSTRATION" && b.decision === "KEEP",
      ),
    [orderedBlocks],
  );

  const excludedBlocks = useMemo(
    () =>
      orderedBlocks.filter(
        (b) => b.block_type !== "ILLUSTRATION" && b.decision === "EXCLUDE",
      ),
    [orderedBlocks],
  );

  const reviewBlocks = useMemo(
    () =>
      orderedBlocks.filter(
        (b) => b.block_type !== "ILLUSTRATION" && b.decision === "REVIEW",
      ),
    [orderedBlocks],
  );

  const clearBlockCount = cleanBlocks.length + excludedBlocks.length;
  const canUndo = extraction.undo_available || localUndoStack.length > 0;
  const showApplyToDraftAction =
    canApplyToDraft ?? Boolean(pageId || applyToDraftFn);

  async function handleApplyCleanTextToDraft() {
    if (
      busy ||
      applyingToDraft ||
      isRevisionVerified ||
      !extraction.canonical_text.trim()
    ) {
      return;
    }
    const targetPageId = pageId ?? extraction.book_page_id;
    if (!targetPageId && !applyToDraftFn) {
      return;
    }
    setApplyingToDraft(true);
    setNotice(null);
    try {
      const targetRevisionId =
        pageRevisionId ?? extraction.page_revision_id ?? null;
      const result = applyToDraftFn
        ? await applyToDraftFn(targetPageId ?? "", {
            page_revision_id: targetRevisionId,
          })
        : await applyPageOcrExtractionToDraft(targetPageId!, {
            page_revision_id: targetRevisionId,
          });
      await onApplyToDraft?.(result);
      setNotice({
        tone: "success",
        text: `Đã áp dụng văn bản sạch (${result.applied_word_count} từ) vào bản nháp OCR.`,
      });
    } catch (error) {
      if (isServiceError(error) && error.status === 409) {
        setNotice({
          tone: "warning",
          text: "Revision hiện tại đã ở trạng thái VERIFIED nên không thể ghi đè bản nháp.",
        });
      } else {
        setNotice({
          tone: "error",
          text: "Chưa thể áp dụng văn bản sạch vào bản nháp. Vui lòng thử lại.",
        });
      }
    } finally {
      setApplyingToDraft(false);
    }
  }

  async function commitPatch(
    payload: PatchPageBlocksRequestDTO,
    customSuccessText?: string,
  ) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (onPatchBlocks) {
        const updated = await onPatchBlocks(payload);
        setExtraction(updated);
        onExtractionChange?.(updated);
        setNotice({
          tone:
            payload.accept_clear_blocks && updated.stats.review_blocks > 0
              ? "warning"
              : "success",
          text:
            customSuccessText ??
            (payload.accept_clear_blocks && updated.stats.review_blocks > 0
              ? `Đã chấp nhận các khối rõ ràng. Còn ${updated.stats.review_blocks} khối cần xác minh thủ công.`
              : payload.undo
                ? "Đã hoàn tác thao tác gần nhất."
                : "Đã lưu thay đổi khối nội dung."),
        });
      } else if (pageId && extraction.persisted) {
        const updated = await patchPageOcrBlocks(pageId, payload);
        setExtraction(updated);
        onExtractionChange?.(updated);
        setNotice({
          tone:
            payload.accept_clear_blocks && updated.stats.review_blocks > 0
              ? "warning"
              : "success",
          text:
            customSuccessText ??
            (payload.accept_clear_blocks && updated.stats.review_blocks > 0
              ? `Đã chấp nhận các khối rõ ràng. Còn ${updated.stats.review_blocks} khối cần xác minh thủ công.`
              : payload.undo
                ? "Đã hoàn tác thao tác gần nhất."
                : "Đã lưu thay đổi khối nội dung."),
        });
      } else {
        const {
          nextExtraction,
          nextUndoStack,
          notice: localNotice,
        } = applyLocalPatch(extraction, payload, localUndoStack);
        setExtraction(nextExtraction);
        setLocalUndoStack(nextUndoStack);
        onExtractionChange?.(nextExtraction);
        setNotice({
          tone:
            payload.accept_clear_blocks &&
            nextExtraction.stats.review_blocks > 0
              ? "warning"
              : "success",
          text: customSuccessText ?? localNotice,
        });
      }
    } catch {
      setNotice({
        tone: "error",
        text: "Không thể cập nhật quyết định cho khối này. Vui lòng thử lại.",
      });
    } finally {
      setBusy(false);
    }
  }

  function handleStartEdit(block: ExtractedBlockDTO) {
    setEditingBlockId(block.block_id);
    setEditDraft(block.edited_text ?? block.display_text);
  }

  async function handleSaveEdit(block: ExtractedBlockDTO) {
    const trimmed = editDraft.normalize("NFC").trim();
    if (!trimmed) {
      setNotice({
        tone: "warning",
        text: "Nội dung khối chữ không được để trống khi lưu sửa.",
      });
      return;
    }
    setEditingBlockId(null);
    await commitPatch(
      {
        actions: [
          {
            block_id: block.block_id,
            action: "EDIT",
            edited_text: trimmed,
          },
        ],
      },
      "Đã cập nhật nội dung chữ của khối và giữ trong bài đọc.",
    );
  }

  const tabs: ReadonlyArray<{
    readonly id: OcrReviewTabId;
    readonly label: string;
    readonly count?: number;
  }> = [
    { id: "original", label: "Ảnh gốc" },
    { id: "clean", label: "Nội dung sạch", count: cleanBlocks.length },
    { id: "excluded", label: "Phần bị loại", count: excludedBlocks.length },
    { id: "review", label: "Phần cần xác minh", count: reviewBlocks.length },
    { id: "preview", label: "Xem trước bài đọc" },
  ];

  function renderBlockCard(block: ExtractedBlockDTO) {
    const isEditing = editingBlockId === block.block_id;
    const typeLabel =
      BLOCK_TYPE_LABELS_VI[block.block_type] ?? block.block_type;

    return (
      <article
        key={block.block_id}
        aria-label={`Khối ${typeLabel}`}
        className="flex flex-col gap-3 rounded-control border border-border bg-white p-4 shadow-xs"
        data-block-id={block.block_id}
        data-decision={block.decision}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-sky px-2.5 py-1 text-xs font-bold text-primary-hover">
              {typeLabel}
            </span>
            <span
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-semibold",
                DECISION_BADGE_STYLES[block.decision],
              )}
            >
              {DECISION_LABELS_VI[block.decision]}
            </span>
            {block.user_override ? (
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                Đã chỉnh thủ công
              </span>
            ) : null}
          </div>
          <span className="text-xs text-muted">
            Thứ tự đọc #{block.reading_order + 1} · Độ tin cậy{" "}
            {Math.round(block.confidence * 100)}%
          </span>
        </div>

        <p className="text-sm text-muted">
          <span className="font-semibold text-ink">Lý do: </span>
          {block.reason_vi}
        </p>

        {isEditing ? (
          <div className="flex flex-col gap-2">
            <label
              className="text-xs font-semibold text-ink"
              htmlFor={`edit-block-${block.block_id}`}
            >
              Chỉnh sửa chữ của khối
            </label>
            <textarea
              className="min-h-24 w-full rounded-control border border-border bg-white p-3 text-sm text-ink focus:border-primary focus:outline-none"
              id={`edit-block-${block.block_id}`}
              onChange={(event) => setEditDraft(event.target.value)}
              value={editDraft}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                fullWidth={false}
                onClick={() => void handleSaveEdit(block)}
                size="compact"
                variant="primary"
              >
                <Check aria-hidden="true" className="size-4" />
                Lưu sửa
              </Button>
              <Button
                disabled={busy}
                fullWidth={false}
                onClick={() => setEditingBlockId(null)}
                size="compact"
                variant="quiet"
              >
                <X aria-hidden="true" className="size-4" />
                Hủy
              </Button>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "rounded-md border border-border/70 bg-slate-50/70 p-3 text-base leading-relaxed text-ink",
              block.block_type === "POEM_BODY" &&
                "whitespace-pre-line font-serif",
              block.decision === "EXCLUDE" && "text-muted line-through",
            )}
          >
            {block.display_text}
          </div>
        )}

        {!isEditing ? (
          <div className="flex flex-wrap gap-2">
            {block.decision !== "KEEP" ? (
              <Button
                disabled={busy}
                fullWidth={false}
                onClick={() =>
                  void commitPatch(
                    {
                      actions: [
                        {
                          block_id: block.block_id,
                          action:
                            block.decision === "EXCLUDE" ? "RESTORE" : "KEEP",
                        },
                      ],
                    },
                    block.decision === "EXCLUDE"
                      ? "Đã khôi phục khối chữ vào bài đọc."
                      : "Đã giữ lại khối chữ vào bài đọc.",
                  )
                }
                size="compact"
                variant="primary"
              >
                {block.decision === "EXCLUDE" ? (
                  <>
                    <RotateCcw aria-hidden="true" className="size-4" />
                    Khôi phục
                  </>
                ) : (
                  <>
                    <Check aria-hidden="true" className="size-4" />
                    Giữ lại
                  </>
                )}
              </Button>
            ) : null}

            {block.decision !== "EXCLUDE" ? (
              <Button
                disabled={busy}
                fullWidth={false}
                onClick={() =>
                  void commitPatch(
                    {
                      actions: [
                        {
                          block_id: block.block_id,
                          action: "EXCLUDE",
                        },
                      ],
                    },
                    "Đã loại bỏ khối chữ khỏi bài đọc.",
                  )
                }
                size="compact"
                variant="secondary"
              >
                <Trash2 aria-hidden="true" className="size-4" />
                Loại bỏ
              </Button>
            ) : null}

            <Button
              disabled={busy}
              fullWidth={false}
              onClick={() => handleStartEdit(block)}
              size="compact"
              variant="quiet"
            >
              <Pencil aria-hidden="true" className="size-4" />
              Sửa chữ
            </Button>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <Card className={cn("gap-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-extrabold text-ink">
            Rà soát nội dung trích xuất thông minh
            {pageNumber ? ` — Trang ${pageNumber}` : ""}
          </h2>
          <p className="text-sm text-muted">
            Loại trang:{" "}
            <strong className="text-ink">
              {PAGE_KIND_LABELS_VI[extraction.page_kind]}
            </strong>{" "}
            · Giữ lại{" "}
            <strong className="text-ink">
              {Math.round(extraction.stats.retention_ratio * 100)}%
            </strong>{" "}
            ký tự ({cleanBlocks.length} khối giữ, {excludedBlocks.length} khối
            loại, {reviewBlocks.length} khối cần xác minh)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {showApplyToDraftAction ? (
            <Button
              className="min-h-11"
              data-testid="apply-ocr-to-draft-btn"
              disabled={
                busy ||
                applyingToDraft ||
                isRevisionVerified ||
                !extraction.canonical_text.trim()
              }
              fullWidth={false}
              isLoading={applyingToDraft}
              onClick={() => void handleApplyCleanTextToDraft()}
              size="compact"
              title={
                isRevisionVerified
                  ? "Revision đã VERIFIED nên không thể chỉnh sửa bản nháp"
                  : undefined
              }
              type="button"
              variant="primary"
            >
              <FileText aria-hidden="true" className="size-4" />
              Áp dụng văn bản sạch vào bản nháp
            </Button>
          ) : null}
          <Button
            className="min-h-11"
            disabled={busy || applyingToDraft || clearBlockCount === 0}
            fullWidth={false}
            onClick={() =>
              void commitPatch({
                accept_clear_blocks: true,
              })
            }
            size="compact"
            variant="secondary"
          >
            <CheckCheck aria-hidden="true" className="size-4" />
            Chấp nhận các khối rõ ràng
          </Button>
          <Button
            className="min-h-11"
            disabled={busy || applyingToDraft || !canUndo}
            fullWidth={false}
            onClick={() => void commitPatch({ undo: true })}
            size="compact"
            variant="quiet"
          >
            <Undo2 aria-hidden="true" className="size-4" />
            Hoàn tác
          </Button>
        </div>
      </div>

      {extraction.stats.circuit_breaker_triggered ? (
        <StatusMessage
          title="Đã bật cơ chế bảo vệ chống mất nội dung"
          tone="warning"
        >
          Tỉ lệ văn bản dự kiến loại bỏ vượt quá 35% trang nên hệ thống đã tự
          động giữ lại và chuyển sang mục <strong>Phần cần xác minh</strong> để
          bạn kiểm tra thủ công.
        </StatusMessage>
      ) : null}

      {extraction.geometry_transform?.requires_crop_review ? (
        <StatusMessage
          title="Giữ nguyên khung ảnh gốc để tránh cắt mất chữ"
          tone="info"
        >
          {extraction.geometry_transform.reason_vi}
        </StatusMessage>
      ) : null}

      {extraction.filter_mode === "shadow" ? (
        <StatusMessage title="Đang chạy chế độ đối chiếu (Shadow)" tone="info">
          Các quyết định lọc nhiễu đang được ghi nhận để đối chiếu và chưa thay
          đổi văn bản đọc chính thức.
        </StatusMessage>
      ) : null}

      {notice ? (
        <StatusMessage tone={notice.tone}>{notice.text}</StatusMessage>
      ) : null}

      {/* 5 View Tabs */}
      <div
        aria-label="Chế độ xem trích xuất OCR"
        className="flex flex-wrap gap-2 border-b border-border pb-3"
        role="tablist"
      >
        {tabs.map((tab) => {
          const isSelected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              aria-controls={`ocr-review-panel-${tab.id}`}
              aria-selected={isSelected}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-control px-4 py-2 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                isSelected
                  ? "bg-primary text-white"
                  : "bg-sky/70 text-ink hover:bg-sky",
              )}
              id={`ocr-review-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              type="button"
            >
              <span>{tab.label}</span>
              {tab.count !== undefined ? (
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-extrabold",
                    isSelected
                      ? "bg-white/20 text-white"
                      : tab.id === "review" && tab.count > 0
                        ? "bg-warning-surface text-warning"
                        : "bg-white text-ink",
                  )}
                >
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Tab Panels */}
      <div
        aria-labelledby={`ocr-review-tab-${activeTab}`}
        className="space-y-4"
        id={`ocr-review-panel-${activeTab}`}
        role="tabpanel"
      >
        {activeTab === "original" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-xs border border-emerald-600 bg-emerald-500/20" />
                Giữ lại
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-xs border border-amber-500 bg-amber-400/30" />
                Cần xác minh
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-xs border border-dashed border-rose-500 bg-rose-500/20" />
                Đã loại
              </span>
            </div>

            {pageImageUrl ? (
              <div className="relative mx-auto w-full max-w-2xl overflow-hidden rounded-control border border-border bg-slate-100">
                <Image
                  alt={
                    pageNumber
                      ? `Ảnh gốc trang ${pageNumber}`
                      : "Ảnh gốc trang sách"
                  }
                  className="h-auto w-full object-contain"
                  height={extraction.geometry_transform?.image_height ?? 1400}
                  src={pageImageUrl}
                  unoptimized
                  width={extraction.geometry_transform?.image_width ?? 1000}
                />
                <div
                  aria-label="Lớp phủ vùng chữ trích xuất"
                  className="pointer-events-none absolute inset-0"
                >
                  {orderedBlocks.map((block) => {
                    const [x = 0, y = 0, w = 0, h = 0] = block.bbox;
                    return (
                      <div
                        key={block.block_id}
                        className={cn(
                          "absolute rounded-xs border-2",
                          OVERLAY_BOX_STYLES[block.decision],
                        )}
                        style={{
                          left: `${x * 100}%`,
                          top: `${y * 100}%`,
                          width: `${w * 100}%`,
                          height: `${h * 100}%`,
                        }}
                        title={`${BLOCK_TYPE_LABELS_VI[block.block_type]}: ${block.reason_vi}`}
                      />
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="rounded-control border border-dashed border-border bg-slate-50 p-6 text-center text-sm text-muted">
                <Eye
                  aria-hidden="true"
                  className="mx-auto mb-2 size-6 text-muted"
                />
                Chưa có ảnh gốc đính kèm — hệ thống vẫn hiển thị đầy đủ{" "}
                {orderedBlocks.length} khối chữ đã phân tích.
              </div>
            )}

            {extraction.geometry_transform ? (
              <p className="text-xs text-muted">
                Góc nghiêng ước lượng:{" "}
                <strong>
                  {extraction.geometry_transform.deskew_angle_deg}°
                </strong>{" "}
                · Diện tích vùng trang:{" "}
                <strong>
                  {Math.round(extraction.geometry_transform.area_ratio * 100)}%
                </strong>{" "}
                · {extraction.geometry_transform.gutter.reason_vi}
              </p>
            ) : null}
          </div>
        ) : null}

        {activeTab === "clean" ? (
          cleanBlocks.length > 0 ? (
            <div className="grid gap-3">{cleanBlocks.map(renderBlockCard)}</div>
          ) : (
            <div className="rounded-control border border-border bg-slate-50 p-6 text-center text-sm text-muted">
              <FileText aria-hidden="true" className="mx-auto mb-2 size-6" />
              Chưa có khối nội dung sạch nào được giữ lại.
            </div>
          )
        ) : null}

        {activeTab === "excluded" ? (
          excludedBlocks.length > 0 ? (
            <div className="grid gap-3">
              {excludedBlocks.map(renderBlockCard)}
            </div>
          ) : (
            <div className="rounded-control border border-border bg-slate-50 p-6 text-center text-sm text-muted">
              Không có phần nhiễu hay số trang nào bị loại bỏ trên trang này.
            </div>
          )
        ) : null}

        {activeTab === "review" ? (
          reviewBlocks.length > 0 ? (
            <div className="space-y-3">
              <StatusMessage tone="warning">
                Các khối dưới đây đang được tạm giữ trong bản xem trước để tránh
                mất chữ. Hãy chọn <strong>Giữ lại</strong> hoặc{" "}
                <strong>Loại bỏ</strong> cho từng khối.
              </StatusMessage>
              <div className="grid gap-3">
                {reviewBlocks.map(renderBlockCard)}
              </div>
            </div>
          ) : (
            <StatusMessage tone="success">
              Không còn khối nào cần xác minh thêm trên trang này.
            </StatusMessage>
          )
        ) : null}

        {activeTab === "preview" ? (
          <div className="space-y-3">
            {reviewBlocks.length > 0 ? (
              <div className="flex items-center gap-2 rounded-control bg-warning-surface px-4 py-2.5 text-sm font-medium text-warning">
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
                <span>
                  Bản xem trước hiện bao gồm {reviewBlocks.length} khối cần xác
                  minh để bảo đảm không bỏ sót nội dung bài đọc.
                </span>
              </div>
            ) : null}
            <div className="rounded-card border border-border bg-amber-50/40 p-5 sm:p-6">
              <div className="mb-3 flex items-center gap-2 text-sm font-bold text-primary-hover">
                <BookOpen aria-hidden="true" className="size-4" />
                <span>Nội dung bài đọc cho bé</span>
              </div>
              {extraction.canonical_text.trim() ? (
                <div
                  className="whitespace-pre-line text-lg leading-8 text-ink"
                  data-testid="canonical-reading-preview"
                >
                  {extraction.canonical_text}
                </div>
              ) : (
                <p className="text-sm text-muted">
                  Chưa có chữ nào trong bài đọc sau khi lọc.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export function SmartOcrBlockReviewLoader({
  pageId,
  pageNumber,
  pageImageUrl,
  pageRevisionId,
  isRevisionVerified = false,
  canApplyToDraft = true,
  onApplyToDraft,
}: {
  readonly pageId: string;
  readonly pageNumber?: number;
  readonly pageImageUrl?: string | null;
  readonly pageRevisionId?: string | null;
  readonly isRevisionVerified?: boolean;
  readonly canApplyToDraft?: boolean;
  readonly onApplyToDraft?: (
    result: ApplyOcrExtractionToDraftResponseDTO,
  ) => Promise<void> | void;
}) {
  const [extraction, setExtraction] = useState<PageOcrExtractionDTO | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadOrExtract(forceExtract = false) {
    setLoading(true);
    setError(null);
    try {
      const result = forceExtract
        ? await extractPageOcrBlocks(pageId, { include_cross_page: true })
        : await getPageOcrExtraction(pageId).catch(() =>
            extractPageOcrBlocks(pageId, { include_cross_page: true }),
          );
      setExtraction(result);
    } catch {
      setError("Chưa thể phân loại khối chữ thông minh cho trang này.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Tách tự động nội dung bài đọc khỏi số trang, tiêu đề lặp và chữ thừa
          (không bao giờ tự xóa nội dung chính).
        </p>
        <Button
          className="min-h-11"
          disabled={loading}
          fullWidth={false}
          isLoading={loading}
          onClick={() => void loadOrExtract(extraction !== null)}
          size="compact"
          type="button"
          variant="secondary"
        >
          {extraction
            ? "Phân tích lại khối chữ"
            : "Mở phân loại khối chữ thông minh"}
        </Button>
      </div>
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {extraction ? (
        <SmartOcrBlockReview
          key={`${pageId}:${extraction.extraction_id ?? "transient"}:${extraction.blocks.length}`}
          canApplyToDraft={canApplyToDraft}
          extraction={extraction}
          isRevisionVerified={isRevisionVerified}
          onApplyToDraft={onApplyToDraft}
          onExtractionChange={setExtraction}
          onPatchBlocks={(payload) => patchPageOcrBlocks(pageId, payload)}
          pageId={pageId}
          pageImageUrl={pageImageUrl}
          pageNumber={pageNumber}
          pageRevisionId={pageRevisionId}
        />
      ) : null}
    </div>
  );
}
