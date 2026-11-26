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

import { AdminBadge, type AdminBadgeTone } from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import {
  computeCanonicalPreviewText,
  extractPageOcrBlocks,
  getPageOcrExtraction,
  patchPageOcrBlocks,
} from "@/lib/api/ocr-extraction-service";
import type { TranslateFn } from "@/lib/i18n/types";
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
  | "original"
  | "clean"
  | "excluded"
  | "review"
  | "preview";

export interface SmartOcrBlockReviewProps {
  readonly extraction: PageOcrExtractionDTO;
  readonly pageNumber?: number;
  readonly pageImageUrl?: string | null;
  readonly pageId?: string | null;
  readonly onPatchBlocks?: (
    payload: PatchPageBlocksRequestDTO,
  ) => Promise<PageOcrExtractionDTO> | PageOcrExtractionDTO;
  readonly onExtractionChange?: (next: PageOcrExtractionDTO) => void;
  readonly className?: string;
}

const DECISION_BADGE_TONES: Record<BlockDecision, AdminBadgeTone> = {
  KEEP: "success",
  REVIEW: "warning",
  EXCLUDE: "danger",
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
  t: TranslateFn,
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
        notice: t(
          "ocrReview.smartBlocks.notices.nothingToUndo",
          undefined,
          "Chưa có thao tác nào để hoàn tác.",
        ),
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
      notice: t(
        "ocrReview.smartBlocks.notices.undone",
        undefined,
        "Đã hoàn tác thao tác gần nhất.",
      ),
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
          reason_vi:
            act.reason ??
            t(
              "ocrReview.smartBlocks.notices.humanKeepReason",
              undefined,
              "Người dùng chọn giữ lại khối này.",
            ),
          reason_code: "HUMAN_KEEP",
        };
      }
      if (act.action === "EXCLUDE") {
        return {
          ...block,
          decision: "EXCLUDE" as const,
          decision_source: "HUMAN" as const,
          user_override: true,
          reason_vi:
            act.reason ??
            t(
              "ocrReview.smartBlocks.notices.humanExcludeReason",
              undefined,
              "Người dùng chọn loại bỏ khối này.",
            ),
          reason_code: "HUMAN_EXCLUDE",
        };
      }
      if (act.action === "RESTORE") {
        return {
          ...block,
          decision: "KEEP" as const,
          decision_source: "HUMAN" as const,
          user_override: true,
          reason_vi:
            act.reason ??
            t(
              "ocrReview.smartBlocks.notices.humanRestoreReason",
              undefined,
              "Đã khôi phục khối vào bài đọc.",
            ),
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
          reason_vi:
            act.reason ??
            t(
              "ocrReview.smartBlocks.notices.humanEditReason",
              undefined,
              "Người dùng đã chỉnh sửa nội dung khối này.",
            ),
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

  let notice = t(
    "ocrReview.smartBlocks.notices.updated",
    undefined,
    "Đã cập nhật trạng thái khối nội dung.",
  );
  if (payload.accept_clear_blocks) {
    notice =
      remainingReviewCount > 0
        ? t(
            "ocrReview.smartBlocks.notices.acceptClearWithRemaining",
            {
              confirmed: clearConfirmedCount,
              remaining: remainingReviewCount,
            },
            "Đã xác nhận {confirmed} khối rõ ràng. Vẫn còn {remaining} khối cần bạn xác minh thủ công.",
          )
        : t(
            "ocrReview.smartBlocks.notices.acceptClearAll",
            { confirmed: clearConfirmedCount },
            "Đã xác nhận tất cả {confirmed} khối rõ ràng.",
          );
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
  onPatchBlocks,
  onExtractionChange,
  className,
}: SmartOcrBlockReviewProps) {
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
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
  const [notice, setNotice] = useState<{
    tone: "info" | "success" | "warning" | "error";
    text: string;
  } | null>(null);

  const decisionLabels: Record<BlockDecision, string> = {
    KEEP: t("ocrReview.smartBlocks.decisions.KEEP", undefined, "Giữ lại"),
    REVIEW: t(
      "ocrReview.smartBlocks.decisions.REVIEW",
      undefined,
      "Cần xác minh",
    ),
    EXCLUDE: t("ocrReview.smartBlocks.decisions.EXCLUDE", undefined, "Đã loại"),
  };

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

  function resolveRemoteNotice(
    payload: PatchPageBlocksRequestDTO,
    updated: PageOcrExtractionDTO,
    customSuccessText?: string,
  ): string {
    if (customSuccessText) return customSuccessText;
    if (payload.accept_clear_blocks && updated.stats.review_blocks > 0) {
      return t(
        "ocrReview.smartBlocks.notices.acceptClearRemoteRemaining",
        { remaining: formatNumber(updated.stats.review_blocks) },
        "Đã chấp nhận các khối rõ ràng. Còn {remaining} khối cần xác minh thủ công.",
      );
    }
    if (payload.undo) {
      return t(
        "ocrReview.smartBlocks.notices.undone",
        undefined,
        "Đã hoàn tác thao tác gần nhất.",
      );
    }
    return t(
      "ocrReview.smartBlocks.notices.saved",
      undefined,
      "Đã lưu thay đổi khối nội dung.",
    );
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
          text: resolveRemoteNotice(payload, updated, customSuccessText),
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
          text: resolveRemoteNotice(payload, updated, customSuccessText),
        });
      } else {
        const {
          nextExtraction,
          nextUndoStack,
          notice: localNotice,
        } = applyLocalPatch(extraction, payload, localUndoStack, t);
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
        text: t(
          "ocrReview.smartBlocks.notices.updateFailed",
          undefined,
          "Không thể cập nhật quyết định cho khối này. Vui lòng thử lại.",
        ),
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
        text: t(
          "ocrReview.smartBlocks.notices.emptyEditError",
          undefined,
          "Nội dung khối chữ không được để trống khi lưu sửa.",
        ),
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
      t(
        "ocrReview.smartBlocks.notices.editSaved",
        undefined,
        "Đã cập nhật nội dung chữ của khối và giữ trong bài đọc.",
      ),
    );
  }

  const tabs: ReadonlyArray<{
    readonly id: OcrReviewTabId;
    readonly label: string;
    readonly count?: number;
  }> = [
    {
      id: "original",
      label: t("ocrReview.smartBlocks.tabs.original", undefined, "Ảnh gốc"),
    },
    {
      id: "clean",
      label: t("ocrReview.smartBlocks.tabs.clean", undefined, "Nội dung sạch"),
      count: cleanBlocks.length,
    },
    {
      id: "excluded",
      label: t("ocrReview.smartBlocks.tabs.excluded", undefined, "Phần bị loại"),
      count: excludedBlocks.length,
    },
    {
      id: "review",
      label: t(
        "ocrReview.smartBlocks.tabs.review",
        undefined,
        "Phần cần xác minh",
      ),
      count: reviewBlocks.length,
    },
    {
      id: "preview",
      label: t(
        "ocrReview.smartBlocks.tabs.preview",
        undefined,
        "Xem trước bài đọc",
      ),
    },
  ];

  function renderBlockCard(block: ExtractedBlockDTO) {
    const isEditing = editingBlockId === block.block_id;
    const typeLabel =
      BLOCK_TYPE_LABELS_VI[block.block_type] ?? block.block_type;

    return (
      <article
        aria-label={t(
          "ocrReview.smartBlocks.blockCardAria",
          { typeLabel },
          "Khối {typeLabel}",
        )}
        className="flex flex-col gap-2.5 rounded-xl border border-border bg-white p-3.5 shadow-2xs"
        data-block-id={block.block_id}
        data-decision={block.decision}
        key={block.block_id}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <AdminBadge tone="info">{typeLabel}</AdminBadge>
            <AdminBadge tone={DECISION_BADGE_TONES[block.decision]}>
              {decisionLabels[block.decision]}
            </AdminBadge>
            {block.user_override ? (
              <AdminBadge tone="neutral">
                {t(
                  "ocrReview.smartBlocks.manualOverrideBadge",
                  undefined,
                  "Đã chỉnh thủ công",
                )}
              </AdminBadge>
            ) : null}
          </div>
          <span className="text-xs text-muted tabular-nums">
            {t(
              "ocrReview.smartBlocks.readingOrderMeta",
              {
                order: formatNumber(block.reading_order + 1),
                confidence: formatNumber(Math.round(block.confidence * 100)),
              },
              "Thứ tự đọc #{order} · Độ tin cậy {confidence}%",
            )}
          </span>
        </div>

        <p className="text-xs text-muted">
          <span className="font-bold text-ink">
            {t("ocrReview.smartBlocks.reasonPrefix", undefined, "Lý do:")}{" "}
          </span>
          {block.reason_vi}
        </p>

        {isEditing ? (
          <div className="flex flex-col gap-2">
            <label
              className="text-xs font-bold text-ink"
              htmlFor={`edit-block-${block.block_id}`}
            >
              {t(
                "ocrReview.smartBlocks.editLabel",
                undefined,
                "Chỉnh sửa chữ của khối",
              )}
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
                onClick={() => void handleSaveEdit(block)}
                size="admin"
                variant="primary"
              >
                <Check aria-hidden="true" className="size-3.5 shrink-0" />
                {t("ocrReview.smartBlocks.saveEditBtn", undefined, "Lưu sửa")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => setEditingBlockId(null)}
                size="admin"
                variant="outline"
              >
                <X aria-hidden="true" className="size-3.5 shrink-0" />
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "rounded-lg border border-border/70 bg-surface-subtle/60 p-3 text-sm leading-relaxed text-ink",
              block.block_type === "POEM_BODY" &&
                "whitespace-pre-line font-serif",
              block.decision === "EXCLUDE" && "text-muted line-through",
            )}
          >
            {block.display_text}
          </div>
        )}

        {!isEditing ? (
          <div className="flex flex-wrap gap-1.5">
            {block.decision !== "KEEP" ? (
              <Button
                disabled={busy}
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
                      ? t(
                          "ocrReview.smartBlocks.notices.restored",
                          undefined,
                          "Đã khôi phục khối chữ vào bài đọc.",
                        )
                      : t(
                          "ocrReview.smartBlocks.notices.kept",
                          undefined,
                          "Đã giữ lại khối chữ vào bài đọc.",
                        ),
                  )
                }
                size="admin"
                variant="primary"
              >
                {block.decision === "EXCLUDE" ? (
                  <>
                    <RotateCcw aria-hidden="true" className="size-3.5 shrink-0" />
                    {t(
                      "ocrReview.smartBlocks.restoreBtn",
                      undefined,
                      "Khôi phục",
                    )}
                  </>
                ) : (
                  <>
                    <Check aria-hidden="true" className="size-3.5 shrink-0" />
                    {t("ocrReview.smartBlocks.keepBtn", undefined, "Giữ lại")}
                  </>
                )}
              </Button>
            ) : null}

            {block.decision !== "EXCLUDE" ? (
              <Button
                disabled={busy}
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
                    t(
                      "ocrReview.smartBlocks.notices.excluded",
                      undefined,
                      "Đã loại bỏ khối chữ khỏi bài đọc.",
                    ),
                  )
                }
                size="admin"
                variant="destructive-outline"
              >
                <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
                {t("ocrReview.smartBlocks.excludeBtn", undefined, "Loại bỏ")}
              </Button>
            ) : null}

            <Button
              disabled={busy}
              onClick={() => handleStartEdit(block)}
              size="admin"
              variant="outline"
            >
              <Pencil aria-hidden="true" className="size-3.5 shrink-0" />
              {t("ocrReview.smartBlocks.editBtn", undefined, "Sửa chữ")}
            </Button>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <div
      className={cn(
        "space-y-4 rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-extrabold text-ink">
            {pageNumber
              ? t(
                  "ocrReview.smartBlocks.headingWithPage",
                  { pageNumber: formatNumber(pageNumber) },
                  "Rà soát nội dung trích xuất thông minh — Trang {pageNumber}",
                )
              : t(
                  "ocrReview.smartBlocks.heading",
                  undefined,
                  "Rà soát nội dung trích xuất thông minh",
                )}
          </h2>
          <p className="text-xs text-muted">
            {t(
              "ocrReview.smartBlocks.summaryLine",
              {
                pageKind: PAGE_KIND_LABELS_VI[extraction.page_kind],
                retention: formatNumber(
                  Math.round(extraction.stats.retention_ratio * 100),
                ),
                keep: formatNumber(cleanBlocks.length),
                excluded: formatNumber(excludedBlocks.length),
                review: formatNumber(reviewBlocks.length),
              },
              "Loại trang: {pageKind} · Giữ lại {retention}% ký tự ({keep} khối giữ, {excluded} khối loại, {review} khối cần xác minh)",
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={busy || clearBlockCount === 0}
            onClick={() =>
              void commitPatch({
                accept_clear_blocks: true,
              })
            }
            size="admin"
            variant="secondary"
          >
            <CheckCheck aria-hidden="true" className="size-3.5 shrink-0" />
            {t(
              "ocrReview.smartBlocks.acceptClearBtn",
              undefined,
              "Chấp nhận các khối rõ ràng",
            )}
          </Button>
          <Button
            disabled={busy || !canUndo}
            onClick={() => void commitPatch({ undo: true })}
            size="admin"
            variant="outline"
          >
            <Undo2 aria-hidden="true" className="size-3.5 shrink-0" />
            {t("ocrReview.smartBlocks.undoBtn", undefined, "Hoàn tác")}
          </Button>
        </div>
      </div>

      {extraction.stats.circuit_breaker_triggered ? (
        <StatusMessage
          title={t(
            "ocrReview.smartBlocks.circuitBreakerTitle",
            undefined,
            "Đã bật cơ chế bảo vệ chống mất nội dung",
          )}
          tone="warning"
        >
          {t(
            "ocrReview.smartBlocks.circuitBreakerDesc",
            undefined,
            "Tỉ lệ văn bản dự kiến loại bỏ vượt quá 35% trang nên hệ thống đã tự động giữ lại và chuyển sang mục Phần cần xác minh để bạn kiểm tra thủ công.",
          )}
        </StatusMessage>
      ) : null}

      {extraction.geometry_transform?.requires_crop_review ? (
        <StatusMessage
          title={t(
            "ocrReview.smartBlocks.cropReviewTitle",
            undefined,
            "Giữ nguyên khung ảnh gốc để tránh cắt mất chữ",
          )}
          tone="info"
        >
          {extraction.geometry_transform.reason_vi}
        </StatusMessage>
      ) : null}

      {extraction.filter_mode === "shadow" ? (
        <StatusMessage
          title={t(
            "ocrReview.smartBlocks.shadowModeTitle",
            undefined,
            "Đang chạy chế độ đối chiếu (Shadow)",
          )}
          tone="info"
        >
          {t(
            "ocrReview.smartBlocks.shadowModeDesc",
            undefined,
            "Các quyết định lọc nhiễu đang được ghi nhận để đối chiếu và chưa thay đổi văn bản đọc chính thức.",
          )}
        </StatusMessage>
      ) : null}

      {notice ? (
        <StatusMessage tone={notice.tone}>{notice.text}</StatusMessage>
      ) : null}

      {/* 5 View Tabs */}
      <div
        aria-label={t(
          "ocrReview.smartBlocks.tabsAria",
          undefined,
          "Chế độ xem trích xuất OCR",
        )}
        className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface-subtle p-1"
        role="tablist"
      >
        {tabs.map((tab) => {
          const isSelected = activeTab === tab.id;
          return (
            <button
              aria-controls={`ocr-review-panel-${tab.id}`}
              aria-selected={isSelected}
              className={cn(
                "inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                isSelected
                  ? "bg-white text-primary shadow-2xs ring-1 ring-border"
                  : "text-muted hover:text-ink",
              )}
              id={`ocr-review-tab-${tab.id}`}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              type="button"
            >
              <span>{tab.label}</span>
              {tab.count !== undefined ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[11px] font-extrabold tabular-nums",
                    isSelected
                      ? "bg-sky text-primary-hover"
                      : tab.id === "review" && tab.count > 0
                        ? "bg-warning-surface text-warning"
                        : "bg-white text-muted",
                  )}
                >
                  {formatNumber(tab.count)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Tab Panels */}
      <div
        aria-labelledby={`ocr-review-tab-${activeTab}`}
        className="space-y-3"
        id={`ocr-review-panel-${activeTab}`}
        role="tabpanel"
      >
        {activeTab === "original" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-xs border border-emerald-600 bg-emerald-500/20" />
                {decisionLabels.KEEP}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-xs border border-amber-500 bg-amber-400/30" />
                {decisionLabels.REVIEW}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-3 rounded-xs border border-dashed border-rose-500 bg-rose-500/20" />
                {decisionLabels.EXCLUDE}
              </span>
            </div>

            {pageImageUrl ? (
              <div className="relative mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-surface-subtle">
                <Image
                  alt={
                    pageNumber
                      ? t(
                          "ocrReview.smartBlocks.originalImageAltWithPage",
                          { pageNumber: formatNumber(pageNumber) },
                          "Ảnh gốc trang {pageNumber}",
                        )
                      : t(
                          "ocrReview.smartBlocks.originalImageAlt",
                          undefined,
                          "Ảnh gốc trang sách",
                        )
                  }
                  className="h-auto w-full object-contain"
                  height={extraction.geometry_transform?.image_height ?? 1400}
                  src={pageImageUrl}
                  unoptimized
                  width={extraction.geometry_transform?.image_width ?? 1000}
                />
                <div
                  aria-label={t(
                    "ocrReview.smartBlocks.overlayAria",
                    undefined,
                    "Lớp phủ vùng chữ trích xuất",
                  )}
                  className="pointer-events-none absolute inset-0"
                >
                  {orderedBlocks.map((block) => {
                    const [x = 0, y = 0, w = 0, h = 0] = block.bbox;
                    return (
                      <div
                        className={cn(
                          "absolute rounded-xs border-2",
                          OVERLAY_BOX_STYLES[block.decision],
                        )}
                        key={block.block_id}
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
              <div className="rounded-lg border border-dashed border-border bg-surface-subtle/60 p-6 text-center text-xs text-muted">
                <Eye
                  aria-hidden="true"
                  className="mx-auto mb-2 size-5 text-muted"
                />
                {t(
                  "ocrReview.smartBlocks.noImageFallback",
                  { count: formatNumber(orderedBlocks.length) },
                  "Chưa có ảnh gốc đính kèm — hệ thống vẫn hiển thị đầy đủ {count} khối chữ đã phân tích.",
                )}
              </div>
            )}

            {extraction.geometry_transform ? (
              <p className="text-xs text-muted">
                {t(
                  "ocrReview.smartBlocks.geometryMeta",
                  {
                    angle: formatNumber(
                      extraction.geometry_transform.deskew_angle_deg,
                    ),
                    area: formatNumber(
                      Math.round(extraction.geometry_transform.area_ratio * 100),
                    ),
                    gutterReason: extraction.geometry_transform.gutter.reason_vi,
                  },
                  "Góc nghiêng ước lượng: {angle}° · Diện tích vùng trang: {area}% · {gutterReason}",
                )}
              </p>
            ) : null}
          </div>
        ) : null}

        {activeTab === "clean" ? (
          cleanBlocks.length > 0 ? (
            <div className="grid gap-3">{cleanBlocks.map(renderBlockCard)}</div>
          ) : (
            <div className="rounded-lg border border-border bg-surface-subtle/60 p-6 text-center text-xs text-muted">
              <FileText aria-hidden="true" className="mx-auto mb-2 size-5" />
              {t(
                "ocrReview.smartBlocks.emptyClean",
                undefined,
                "Chưa có khối nội dung sạch nào được giữ lại.",
              )}
            </div>
          )
        ) : null}

        {activeTab === "excluded" ? (
          excludedBlocks.length > 0 ? (
            <div className="grid gap-3">
              {excludedBlocks.map(renderBlockCard)}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-surface-subtle/60 p-6 text-center text-xs text-muted">
              {t(
                "ocrReview.smartBlocks.emptyExcluded",
                undefined,
                "Không có phần nhiễu hay số trang nào bị loại bỏ trên trang này.",
              )}
            </div>
          )
        ) : null}

        {activeTab === "review" ? (
          reviewBlocks.length > 0 ? (
            <div className="space-y-3">
              <StatusMessage tone="warning">
                {t(
                  "ocrReview.smartBlocks.reviewBanner",
                  undefined,
                  "Các khối dưới đây đang được tạm giữ trong bản xem trước để tránh mất chữ. Hãy chọn Giữ lại hoặc Loại bỏ cho từng khối.",
                )}
              </StatusMessage>
              <div className="grid gap-3">
                {reviewBlocks.map(renderBlockCard)}
              </div>
            </div>
          ) : (
            <StatusMessage tone="success">
              {t(
                "ocrReview.smartBlocks.emptyReview",
                undefined,
                "Không còn khối nào cần xác minh thêm trên trang này.",
              )}
            </StatusMessage>
          )
        ) : null}

        {activeTab === "preview" ? (
          <div className="space-y-3">
            {reviewBlocks.length > 0 ? (
              <div className="flex items-center gap-2 rounded-lg bg-warning-surface px-3.5 py-2.5 text-xs font-semibold text-warning">
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
                <span>
                  {t(
                    "ocrReview.smartBlocks.previewReviewNotice",
                    { count: formatNumber(reviewBlocks.length) },
                    "Bản xem trước hiện bao gồm {count} khối cần xác minh để bảo đảm không bỏ sót nội dung bài đọc.",
                  )}
                </span>
              </div>
            ) : null}
            <div className="rounded-xl border border-border bg-amber-50/40 p-4 sm:p-5">
              <div className="mb-2.5 flex items-center gap-2 text-xs font-bold text-primary-hover">
                <BookOpen aria-hidden="true" className="size-4 shrink-0" />
                <span>
                  {t(
                    "ocrReview.smartBlocks.previewHeading",
                    undefined,
                    "Nội dung bài đọc cho bé",
                  )}
                </span>
              </div>
              {extraction.canonical_text.trim() ? (
                <div
                  className="whitespace-pre-line text-base leading-7 text-ink"
                  data-testid="canonical-reading-preview"
                >
                  {extraction.canonical_text}
                </div>
              ) : (
                <p className="text-xs text-muted">
                  {t(
                    "ocrReview.smartBlocks.previewEmpty",
                    undefined,
                    "Chưa có chữ nào trong bài đọc sau khi lọc.",
                  )}
                </p>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SmartOcrBlockReviewLoader({
  pageId,
  pageNumber,
  pageImageUrl,
}: {
  readonly pageId: string;
  readonly pageNumber?: number;
  readonly pageImageUrl?: string | null;
}) {
  const t = useTranslations("admin");
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
      setError(
        t(
          "ocrReview.smartBlocks.loaderError",
          undefined,
          "Chưa thể phân loại khối chữ thông minh cho trang này.",
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
          {t(
            "ocrReview.smartBlocks.loaderDesc",
            undefined,
            "Tách tự động nội dung bài đọc khỏi số trang, tiêu đề lặp và chữ thừa (không bao giờ tự xóa nội dung chính).",
          )}
        </p>
        <Button
          disabled={loading}
          isLoading={loading}
          onClick={() => void loadOrExtract(extraction !== null)}
          size="admin"
          type="button"
          variant="secondary"
        >
          {extraction
            ? t(
                "ocrReview.smartBlocks.loaderReextractBtn",
                undefined,
                "Phân tích lại khối chữ",
              )
            : t(
                "ocrReview.smartBlocks.loaderOpenBtn",
                undefined,
                "Mở phân loại khối chữ thông minh",
              )}
        </Button>
      </div>
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {extraction ? (
        <SmartOcrBlockReview
          extraction={extraction}
          key={`${pageId}:${extraction.extraction_id ?? "transient"}:${extraction.blocks.length}`}
          onExtractionChange={setExtraction}
          onPatchBlocks={(payload) => patchPageOcrBlocks(pageId, payload)}
          pageId={pageId}
          pageImageUrl={pageImageUrl}
          pageNumber={pageNumber}
        />
      ) : null}
    </div>
  );
}
