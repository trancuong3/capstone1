"use client";

import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  History,
  Layers,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
  ZoomIn,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AdminBadge,
  AdminLoading,
  AdminPageHeader,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { SmartOcrBlockReviewLoader } from "@/components/admin/smart-ocr-block-review";
import { PageIllustrationStudio } from "@/components/books/page-illustration-studio";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { OcrServiceStatusBanner } from "@/components/common/ocr-service-status-banner";
import { ResponsiveTable } from "@/components/common/responsive-table";
import { StatusMessage } from "@/components/common/status-message";
import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useOcrWorkerStatus } from "@/hooks/use-ocr-worker-status";
import {
  cancelAdminOcrJob,
  getAdminOcrJob,
  isActiveAdminOcrJobStatus,
  isAdminOcrJobQueuedSignal,
  type AdminOcrJobDTO,
} from "@/lib/api/admin-page-service";
import { emitStudioTasksChanged } from "@/lib/api/global-tasks-service";
import { cn } from "@/lib/utils/cn";
import { isServiceError } from "@/lib/api/service-error";
import { translateMessage } from "@/lib/i18n/formatter";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import type { TranslateFn } from "@/lib/i18n/types";
import { viMessages } from "@/messages/vi";
import viAdminMessages from "@/messages/vi/admin.json";
import {
  AiCorrectionCancelledError,
  type AdminAiWorkflowDTO,
  type AdminAiWorkflowProgress,
} from "@/lib/api/ocr-review-service";
import {
  normalizeVietnameseWord,
  syncPageTextToWords,
  syncWordsToPageText,
  tokenizePageText,
} from "@/lib/ocr/sync-page-text-words";
import { adjudicateWord } from "@/lib/ocr/word-adjudication";
import { safeOcrRuntimeProvenance } from "@/lib/ocr/runtime-provenance";
import type {
  AdminBookDTO,
  AdminOcrReviewStatus,
  AdminPageImageUI,
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
  AdminRevisionWordDTO,
  AdminRevisionVerifyRequestDTO,
} from "@/types/admin";

type LoadError = "not-found" | "unavailable" | "safe";
type WordFilter = "all" | "review" | "risk" | "disagreement" | "red" | "green";
type WordReviewColorGroup = "green" | "yellow" | "red";
type OcrWorkbenchTab = "draft" | "words" | "safety" | "blocks" | "history";
type AiTokenChange = {
  readonly index: number;
  readonly original: string;
  readonly proposed: string;
};

const viAdminFallbackMessages = {
  ...viMessages,
  admin: viAdminMessages,
};

const defaultTranslate: TranslateFn = (key, params, fallback) =>
  translateMessage(
    viAdminFallbackMessages,
    viAdminFallbackMessages,
    DEFAULT_LOCALE,
    key.includes(".") && !key.startsWith("admin.") ? `admin.${key}` : key,
    params,
    fallback,
  );

function hasEngineDisagreementEvidence(word?: AdminRevisionWordDTO): boolean {
  const evidence = word?.ocr_evidence;
  if (!evidence) return false;

  const outputs = evidence.engine_outputs;
  const paddle = outputs.paddleocr;
  const vietocr = outputs.vietocr;
  if (
    typeof paddle === "string" &&
    paddle.trim() &&
    typeof vietocr === "string" &&
    vietocr.trim() &&
    normalizeVietnameseWord(paddle) !== normalizeVietnameseWord(vietocr)
  ) {
    return true;
  }

  const cropEvidence = evidence.crop_evidence;
  const paddleCrop = cropEvidence?.paddleocr_candidate;
  const vietocrCrop = cropEvidence?.vietocr_candidate;
  if (
    typeof paddleCrop === "string" &&
    paddleCrop.trim() &&
    typeof vietocrCrop === "string" &&
    vietocrCrop.trim() &&
    normalizeVietnameseWord(paddleCrop) !== normalizeVietnameseWord(vietocrCrop)
  ) {
    return true;
  }

  if (["substitute", "split", "merge"].includes(evidence.alignment)) {
    return true;
  }
  if (["unmatched", "insert", "delete"].includes(evidence.alignment)) {
    const selected = evidence.selected_engine;
    const otherStatus =
      selected === "paddleocr"
        ? evidence.engine_statuses?.vietocr
        : selected === "vietocr"
          ? evidence.engine_statuses?.paddleocr
          : undefined;
    return otherStatus === "success";
  }
  return false;
}

export function getWordReviewStatus(
  word: AdminRevisionWordDTO,
  revisionStatus?: AdminPageRevisionDetailDTO["verification_status"],
): AdminOcrReviewStatus {
  // RED comes only from a trusted one-to-one reference mismatch. Neither the
  // page status nor a stale word status may relabel it.
  if (getWordReviewColorGroup("needs_review", word) === "red")
    return "confirmed_mismatch";
  if (revisionStatus === "VERIFIED") return "verified";
  const status = word.ocr_review_status;
  if (status === "matched") return "engine_agreement";
  if (status === "suspect") {
    return hasEngineDisagreementEvidence(word)
      ? "engine_disagreement"
      : "needs_review";
  }
  if (
    status === "engine_disagreement" &&
    !hasEngineDisagreementEvidence(word)
  ) {
    return "needs_review";
  }
  return status === "engine_agreement" ||
    status === "engine_disagreement" ||
    status === "reference_match" ||
    status === "confirmed_mismatch" ||
    status === "verified"
    ? status
    : "needs_review";
}

function foldVietnameseDiacritics(value: string): string {
  return normalizeVietnameseWord(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[đĐ]/gu, "d")
    .normalize("NFC");
}

function hasDiacriticOnlyEngineDisagreement(
  word: AdminRevisionWordDTO | undefined,
): boolean {
  const outputs = word?.ocr_evidence?.engine_outputs;
  const paddle = outputs?.paddleocr;
  const vietocr = outputs?.vietocr;
  if (typeof paddle !== "string" || typeof vietocr !== "string") return false;
  const normalizedPaddle = normalizeVietnameseWord(paddle);
  const normalizedViet = normalizeVietnameseWord(vietocr);
  return (
    normalizedPaddle !== normalizedViet &&
    normalizedPaddle.length > 0 &&
    foldVietnameseDiacritics(paddle) === foldVietnameseDiacritics(vietocr)
  );
}

/**
 * Backend colors are authoritative. This fallback handles legacy payloads
 * that omit the three-color group and applies strict word-level evidence gates.
 */
export function getWordReviewColorGroup(
  status: AdminOcrReviewStatus,
  word?: AdminRevisionWordDTO,
  _paddleLineScore?: number | null,
): WordReviewColorGroup {
  void _paddleLineScore;
  const contractGroup = word?.review_color_group;
  if (
    contractGroup === "green" ||
    contractGroup === "yellow" ||
    contractGroup === "red"
  )
    return contractGroup;
  if (!word?.ocr_evidence) return status === "verified" ? "green" : "yellow";

  const evidence = word.ocr_evidence;
  const normalize = (value: string) =>
    normalizeVietnameseWord(value.normalize("NFC"));
  const source = evidence.source_text;
  const reference = evidence.reference_text;
  const hasVerifiedReferenceProvenance =
    evidence.verification_source === "admin" ||
    evidence.verification_source === "verified_revision";
  const trustedReference =
    hasVerifiedReferenceProvenance &&
    typeof reference === "string" &&
    reference.trim().length > 0 &&
    ["match", "substitute"].includes(evidence.reference_alignment ?? "");

  if (hasVerifiedReferenceProvenance && !trustedReference) return "yellow";
  if (trustedReference && typeof reference === "string") {
    if (normalize(word.text) === normalize(reference)) return "green";
    if (
      evidence.reference_alignment === "substitute" &&
      typeof source === "string" &&
      normalize(source) === normalize(word.text)
    )
      return "red";
    return "yellow";
  }
  // Word-level Admin verification is valid unless a trusted verified reference
  // above directly contradicts the OCR source token.
  if (status === "verified") return "green";
  if (
    typeof source !== "string" ||
    normalize(source) !== normalize(word.text)
  ) {
    return "yellow";
  }

  const paddle = evidence.engine_outputs.paddleocr;
  const vietocr = evidence.engine_outputs.vietocr;
  const statuses = evidence.engine_statuses ?? {};
  const selectedEngine = evidence.selected_engine;
  const selectedCandidate =
    selectedEngine === "paddleocr"
      ? paddle
      : selectedEngine === "vietocr"
        ? vietocr
        : null;
  const isTokenIndex = (value: number | null | undefined) =>
    Number.isInteger(value) && (value ?? -1) >= 0;
  const paddleRead =
    typeof paddle === "string" && statuses.paddleocr === "success"
      ? normalize(paddle)
      : "";
  const vietocrRead =
    typeof vietocr === "string" && statuses.vietocr === "success"
      ? normalize(vietocr)
      : "";
  const lineEnginesAgree =
    paddleRead.length > 0 &&
    paddleRead === vietocrRead &&
    evidence.alignment === "match";
  if (!lineEnginesAgree) {
    // PaddleOCR and VietOCR did not both return this token. It can still be
    // settled when independent engines converge on the displayed text. Split,
    // merge and unaligned tokens have no one-to-one mapping: never green.
    if (!["substitute", "unmatched", "insert"].includes(evidence.alignment))
      return "yellow";
    if (
      !isTokenIndex(evidence.paddle_token_index) &&
      !isTokenIndex(evidence.vietocr_token_index)
    )
      return "yellow";
    const adjudication = adjudicateWord(evidence);
    return adjudication.status === "resolved" &&
      adjudication.text === normalize(word.text)
      ? "green"
      : "yellow";
  }
  if (paddleRead !== normalize(word.text)) return "yellow";
  if (statuses.tesseract === "success") {
    // Tesseract ran: the two Vietnamese engines confirm the text. Box and
    // crop quality are geometry and are reported separately.
    const adjudication = adjudicateWord(evidence);
    return adjudication.status === "resolved" &&
      adjudication.text === normalize(word.text)
      ? "green"
      : "yellow";
  }
  if (
    typeof paddle !== "string" ||
    !paddle.trim() ||
    typeof vietocr !== "string" ||
    !vietocr.trim() ||
    normalize(paddle) !== normalize(vietocr) ||
    statuses.paddleocr !== "success" ||
    statuses.vietocr !== "success" ||
    evidence.alignment !== "match" ||
    typeof selectedCandidate !== "string" ||
    normalize(selectedCandidate) !== normalize(word.text) ||
    !Number.isInteger(evidence.paddle_token_index) ||
    (evidence.paddle_token_index ?? -1) < 0 ||
    !Number.isInteger(evidence.vietocr_token_index) ||
    (evidence.vietocr_token_index ?? -1) < 0 ||
    evidence.bbox_quality !== "valid" ||
    evidence.crop_quality !== "usable"
  )
    return "yellow";

  const crop = evidence.crop_evidence;
  if (crop) {
    if (
      !["not_needed", "completed"].includes(String(crop.status)) ||
      typeof crop.paddle_error === "string" ||
      typeof crop.vietocr_error === "string"
    )
      return "yellow";
    if (crop.status === "completed") {
      const candidates = [crop.paddleocr_candidate, crop.vietocr_candidate];
      if (
        !candidates.every(
          (candidate) => typeof candidate === "string" && candidate.trim(),
        ) ||
        candidates.some(
          (candidate) =>
            typeof candidate === "string" &&
            normalize(candidate) !== normalize(paddle),
        )
      )
        return "yellow";
    }
  }
  // Agreement between PaddleOCR and VietOCR still loses to a Vietnamese
  // engine that read the same letters with other marks.
  const adjudication = adjudicateWord(evidence);
  if (
    adjudication.status !== "resolved" ||
    adjudication.text !== normalize(word.text)
  )
    return "yellow";
  return "green";
}

function matchesWordFilter(
  status: AdminOcrReviewStatus,
  filter: WordFilter,
  word?: AdminRevisionWordDTO,
  paddleLineScore?: number | null,
): boolean {
  if (filter === "all") return true;
  const group = getWordReviewColorGroup(status, word, paddleLineScore);
  if (filter === "review") return group === "red" || group === "yellow";
  if (filter === "risk") return group === "yellow";
  if (filter === "red") return group === "red";
  if (filter === "green") return group === "green";
  return hasEngineDisagreementEvidence(word);
}

export function getWordReviewLabel(
  status: AdminOcrReviewStatus,
  word?: AdminRevisionWordDTO,
  _paddleLineScore?: number | null,
  t: TranslateFn = defaultTranslate,
): string {
  void _paddleLineScore;
  const group = getWordReviewColorGroup(status, word);
  if (group === "green") {
    if (status === "verified") return t("ocrReview.reviewLabels.verified");
    if (word?.ocr_evidence?.verification_source)
      return t("ocrReview.reviewLabels.referenceMatch");
    if (hasEngineDisagreementEvidence(word))
      return t("ocrReview.reviewLabels.cropAdjudicated");
    return t("ocrReview.reviewLabels.dualConsensus");
  }
  if (group === "red") return t("ocrReview.reviewLabels.red");
  if (
    hasEngineDisagreementEvidence(word) &&
    hasDiacriticOnlyEngineDisagreement(word)
  )
    return t("ocrReview.reviewLabels.diacriticDifference");
  if (hasEngineDisagreementEvidence(word)) {
    return t("ocrReview.reviewLabels.disagreement");
  }
  return (
    word?.ocr_evidence?.review_reason?.trim() ||
    t("ocrReview.reviewLabels.insufficient")
  );
}

type WordGeometryQuality = "good" | "weak" | "invalid" | "not_assessed";

/**
 * Box quality is reported next to the text color and never changes it: a
 * correct word stays green while its box may still need repair.
 */
export function getWordGeometryQuality(
  word?: AdminRevisionWordDTO,
): WordGeometryQuality {
  if (word?.geometry_quality) return word.geometry_quality;
  const evidence = word?.ocr_evidence;
  if (!evidence) return "not_assessed";
  if (evidence.bbox_quality === "rejected") return "invalid";
  if (evidence.bbox_quality !== "valid") return "not_assessed";
  return evidence.crop_quality === "usable" ? "good" : "weak";
}

export function getWordGeometryLabel(
  word?: AdminRevisionWordDTO,
  t: TranslateFn = defaultTranslate,
): string {
  return t(`ocrReview.geometryLabels.${getWordGeometryQuality(word)}`);
}

export function getWordPunctuationLabel(
  word?: AdminRevisionWordDTO,
  t: TranslateFn = defaultTranslate,
): string {
  return t(
    `ocrReview.punctuationLabels.${word?.punctuation_status ?? "not_assessed"}`,
  );
}

export function getWordReviewColor(
  status: AdminOcrReviewStatus,
  word?: AdminRevisionWordDTO,
  paddleLineScore?: number | null,
): string {
  const group = getWordReviewColorGroup(status, word, paddleLineScore);
  return {
    green: "border-green-600 bg-green-400/35 text-green-900",
    yellow: "border-amber-600 bg-amber-300/40 text-amber-950",
    red: "border-red-600 bg-red-400/35 text-red-900",
  }[group];
}

export function getWordReviewBadgeColor(
  status: AdminOcrReviewStatus,
  word?: AdminRevisionWordDTO,
  paddleLineScore?: number | null,
): string {
  const group = getWordReviewColorGroup(status, word, paddleLineScore);
  return {
    green: "bg-green-100 text-green-800 border-green-300",
    yellow: "bg-amber-100 text-amber-900 border-amber-400",
    red: "bg-red-100 text-red-900 border-red-300",
  }[group];
}

function formatWorkflowSuitability(value: string | null | undefined): string {
  const map: Record<string, string> = {
    SUITABLE: "Phù hợp",
    SUITABLE_WITH_GUIDANCE: "Phù hợp (cần lưu ý)",
    REVIEW_REQUIRED: "Cần kiểm tra",
    NOT_RECOMMENDED: "Không khuyến nghị",
  };
  if (!value) return "Chưa có kết quả";
  return map[value] ?? "Cần kiểm tra";
}

function formatSafetyStatusLabel(value: string | null | undefined): string {
  const map: Record<string, string> = {
    PROVISIONAL: "Tạm tính",
    CONFIRMED: "Đã xác nhận",
    AUTO_CONFIRMED: "Tự động xác nhận",
    STALE: "Cần quét lại",
    FAILED: "Gặp lỗi",
    PENDING: "Đang chờ",
    COMPLETED: "Hoàn tất",
  };
  if (!value) return "Đang chờ";
  return map[value] ?? "Đang xử lý";
}

function formatFindingSeverityLabel(value: unknown): string {
  const key = String(value ?? "REVIEW").toUpperCase();
  const map: Record<string, string> = {
    HIGH: "Nghiêm trọng",
    MEDIUM: "Trung bình",
    LOW: "Nhẹ",
    REVIEW: "Cần xem xét",
  };
  return map[key] ?? "Cần xem xét";
}

function formatFindingCategoryLabel(value: unknown): string {
  const key = String(value ?? "OTHER_SENSITIVE").toUpperCase();
  const map: Record<string, string> = {
    SEXUAL_CONTENT: "Nội dung nhạy cảm",
    VIOLENCE: "Bạo lực",
    HATE_SPEECH: "Ngôn từ thù ghét",
    SELF_HARM: "Tự hại",
    PROFANITY: "Ngôn từ thô tục",
    AGE_INAPPROPRIATE: "Chưa phù hợp độ tuổi",
    DANGEROUS_ACTIVITIES: "Hành vi nguy hiểm",
    SUBSTANCE_USE: "Chất kích thích",
    OTHER_SENSITIVE: "Nội dung nhạy cảm khác",
  };
  return map[key] ?? "Nội dung cần lưu ý";
}

function formatFindingContentTypeLabel(value: unknown): string {
  const key = String(value ?? "MENTION").toUpperCase();
  const map: Record<string, string> = {
    MENTION: "Đề cập",
    DEPICTION: "Mô tả",
    INSTRUCTION: "Hướng dẫn",
    EXPLICIT: "Trực tiếp",
  };
  return map[key] ?? "Nội dung";
}

export function getOcrScoreLabel(
  word: AdminRevisionWordDTO,
  t: TranslateFn = defaultTranslate,
): string {
  if (
    word.ocr_score_source === null ||
    word.ocr_score_source === undefined ||
    word.ocr_confidence === null ||
    word.ocr_confidence === undefined ||
    !Number.isFinite(word.ocr_confidence) ||
    word.ocr_confidence < 0 ||
    word.ocr_confidence > 1
  ) {
    return t("ocrReview.scoreLabels.missingWordScore");
  }
  const score = Math.round(word.ocr_confidence * 100);
  if (word.ocr_score_source === "tesseract_raw_word_score_v1") {
    return t("ocrReview.scoreLabels.tesseractRaw", { score });
  }
  if (word.ocr_score_source === "ocr_calibrated_word_accuracy_v1") {
    const probability = word.ocr_evidence?.calibrated_word_accuracy;
    return word.ocr_evidence?.contract === "ocr_calibrated_word_accuracy_v1" &&
      probability !== null &&
      probability !== undefined &&
      Number.isFinite(probability) &&
      probability >= 0 &&
      probability <= 1
      ? t("ocrReview.scoreLabels.calibratedAccuracy", {
          percent: Math.round(probability * 100),
        })
      : t("ocrReview.scoreLabels.missingCalibrated");
  }
  if (
    word.ocr_score_source === "dual_engine_consensus_v1" ||
    word.ocr_score_source === "paddle_line_score_v1"
  ) {
    return t("ocrReview.scoreLabels.uncalibratedLegacy");
  }
  return t("ocrReview.scoreLabels.missingCalibrated");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getPaddleLineScoreLabel(
  metadata: Record<string, unknown>,
  lineIndex: number,
  t: TranslateFn = defaultTranslate,
): string {
  const lineEvidence = metadata.line_evidence;
  if (!Array.isArray(lineEvidence)) {
    return t("ocrReview.scoreLabels.paddleNotRecorded");
  }
  const line = lineEvidence
    .map(asRecord)
    .find((item) => item?.line_index === lineIndex);
  const rawScore = line?.paddle_line_confidence;
  if (
    typeof rawScore !== "number" ||
    !Number.isFinite(rawScore) ||
    rawScore < 0 ||
    rawScore > 1
  ) {
    return t("ocrReview.scoreLabels.paddleNotRecorded");
  }
  return t("ocrReview.scoreLabels.paddleRaw", {
    score: Math.round(rawScore * 100),
    vietOcrSuffix: "",
  });
}

function getPaddleLineScoreForWord(
  metadata: Record<string, unknown>,
  word: AdminRevisionWordDTO,
): number | null {
  const lineEvidence = metadata.line_evidence;
  if (!Array.isArray(lineEvidence)) return null;
  const line = lineEvidence
    .map(asRecord)
    .find((item) => item?.line_index === word.line_index);
  const score = line?.paddle_line_confidence;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 1 ||
    line?.vietocr_output_used === true
  ) {
    return null;
  }

  if (line?.vietocr_output_used !== false) {
    const paddleToken = word.ocr_evidence?.engine_outputs.paddleocr;
    if (
      typeof paddleToken !== "string" ||
      normalizeVietnameseWord(paddleToken) !==
        normalizeVietnameseWord(word.text)
    ) {
      return null;
    }
  }

  return score;
}

function getWordScoreLabel(
  word: AdminRevisionWordDTO,
  metadata: Record<string, unknown>,
  t: TranslateFn = defaultTranslate,
): string {
  return getPaddleLineScoreForWord(metadata, word) !== null
    ? getPaddleLineScoreLabel(metadata, word.line_index, t)
    : getOcrScoreLabel(word, t);
}

function OcrImageViewer({
  book,
  draftTokens,
  image,
  ocrMetadata,
  onSelectWord,
  selectedWord,
  verificationStatus,
  words,
}: {
  book: AdminBookDTO;
  draftTokens: readonly string[];
  image: AdminPageImageUI;
  ocrMetadata: Record<string, unknown>;
  onSelectWord: (index: number) => void;
  selectedWord: number | null;
  verificationStatus: AdminPageRevisionDetailDTO["verification_status"];
  words: readonly AdminRevisionWordDTO[];
}) {
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const restoreExpandFocusRef = useRef(true);

  useEffect(() => {
    if (!isExpanded) return;

    const expandButton = expandButtonRef.current;
    return () => {
      if (restoreExpandFocusRef.current) expandButton?.focus();
      restoreExpandFocusRef.current = true;
    };
  }, [isExpanded]);

  function renderImageFrame(expanded = false) {
    const maxExpandedWidth = `${(image.width / image.height) * 86}dvh`;
    return (
      <div
        className={`ocr-review-image-frame relative mx-auto overflow-hidden rounded-control bg-desk ${
          expanded ? "border border-white/30 shadow-2xl" : ""
        }`}
        dir="ltr"
        style={
          {
            aspectRatio: `${image.width} / ${image.height}`,
            maxWidth: expanded ? `min(92vw, ${maxExpandedWidth})` : undefined,
            width: expanded ? `min(92vw, ${maxExpandedWidth})` : undefined,
            "--ocr-image-frame-max-width": `${(image.width / image.height) * 50}dvh`,
          } as CSSProperties
        }
      >
        <Image
          alt={t("ocrReview.canvas.imageAlt", {
            pageNumber: formatNumber(image.page_number),
            title: book.title,
          })}
          className="object-contain"
          fill
          sizes={expanded ? "92vw" : "(max-width:1280px) 100vw, 55vw"}
          src={image.preview_url}
          unoptimized
        />
        <div
          aria-label={t("ocrReview.canvas.bboxOverlayAria", {
            count: formatNumber(words.length),
          })}
          className="absolute inset-0"
          dir="ltr"
          role="group"
        >
          {words.map((word) => {
            const currentDraftToken = draftTokens[word.word_index];
            const reviewStatus = getWordReviewStatus(word, verificationStatus);
            const paddleLineScore = getPaddleLineScoreForWord(
              ocrMetadata,
              word,
            );
            const reviewLabel = getWordReviewLabel(
              reviewStatus,
              word,
              paddleLineScore,
              t,
            );
            const scoreLabel = getWordScoreLabel(word, ocrMetadata, t);
            const selectedClass =
              word.word_index === selectedWord
                ? "z-10 border-2 ring-2 ring-white"
                : "border";
            const geometryQuality = getWordGeometryQuality(word);
            const geometryNeedsRepair =
              geometryQuality === "weak" || geometryQuality === "invalid";
            const geometryNote = geometryNeedsRepair
              ? ` ${getWordGeometryLabel(word, t)}.`
              : "";
            const boxLabel = t("ocrReview.canvas.wordAriaLabel", {
              num: formatNumber(word.word_index + 1),
              text: word.text,
              reviewLabel,
              scoreLabel,
              geometryNote,
            });
            const boxTitle = t("ocrReview.canvas.wordTitle", {
              num: formatNumber(word.word_index + 1),
              text: word.text,
              reviewLabel,
              scoreLabel,
              draftToken:
                currentDraftToken ?? t("ocrReview.canvas.draftMissing"),
            });

            return (
              <button
                aria-label={boxLabel}
                aria-pressed={word.word_index === selectedWord}
                className={`absolute box-border cursor-pointer rounded-[2px] p-0 ${getWordReviewColor(reviewStatus, word, paddleLineScore)} ${selectedClass}${geometryNeedsRepair ? " border-dashed" : ""}`}
                data-geometry-quality={geometryQuality}
                key={`${word.line_index}-${word.word_index}`}
                onClick={() => {
                  onSelectWord(word.word_index);
                  if (expanded) {
                    restoreExpandFocusRef.current = false;
                    setIsExpanded(false);
                  }
                }}
                style={{
                  height: `${word.bbox[3] * 100}%`,
                  left: `${word.bbox[0] * 100}%`,
                  top: `${word.bbox[1] * 100}%`,
                  width: `${word.bbox[2] * 100}%`,
                }}
                title={boxTitle}
                type="button"
              />
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-extrabold text-ink">
          {t("ocrReview.canvas.originalImageHeading")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted tabular-nums">
            {t("ocrReview.canvas.dimensions", {
              width: formatNumber(image.width),
              height: formatNumber(image.height),
            })}
          </span>
          <button
            className="inline-flex min-h-9 items-center gap-1.5 rounded-control border border-border bg-white px-2.5 text-xs font-bold text-ink transition-colors hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => setIsExpanded(true)}
            ref={expandButtonRef}
            type="button"
          >
            <ZoomIn aria-hidden="true" className="size-3.5 text-primary" />
            {t("ocrReview.canvas.zoomImage")}
          </button>
        </div>
      </div>
      {renderImageFrame()}
      <Modal
        closeOnBackdropClick
        footer={
          <div className="flex justify-end">
            <Button
              fullWidth={false}
              onClick={() => setIsExpanded(false)}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("ocrReview.canvas.closeImage")}
            </Button>
          </div>
        }
        isOpen={isExpanded}
        onClose={() => setIsExpanded(false)}
        title={t("ocrReview.canvas.zoomModalTitle", {
          pageNumber: formatNumber(image.page_number),
          title: book.title,
        })}
        tone="paper"
      >
        <div className="grid justify-items-center gap-3">
          {renderImageFrame(true)}
        </div>
      </Modal>
    </>
  );
}

function getWordRangeInText(
  text: string,
  targetIndex: number,
): [number, number] | null {
  const matches = [...text.matchAll(/\S+/gu)];
  if (targetIndex < 0 || targetIndex >= matches.length) return null;
  const match = matches[targetIndex];
  if (match && typeof match.index === "number") {
    return [match.index, match.index + match[0].length];
  }
  return null;
}

export function AdminOcrReviewScreen({
  bookId,
  pageId,
}: {
  bookId: string;
  pageId: string;
}) {
  const { books, pages, ocr, revisions } = useAdminServices();
  const taskCenter = useOptionalAiTaskCenter();
  const t = useTranslations("admin");
  const tCommon = useTranslations("common");
  const { formatDateTime, formatNumber } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Next's compatibility layer can return null outside the App Router (e.g. tests).
  const preferredRevisionId = searchParams?.get("revisionId") ?? null;
  const activeView = searchParams?.get("view") ?? "review";
  const [activeTab, setActiveTab] = useState<OcrWorkbenchTab>(() =>
    activeView === "history" ? "history" : "draft",
  );
  const [book, setBook] = useState<AdminBookDTO | null>(null);
  const [image, setImage] = useState<AdminPageImageUI | null>(null);
  const [history, setHistory] = useState<
    readonly AdminRevisionSummaryUI[] | null
  >(null);
  const [detail, setDetail] = useState<AdminPageRevisionDetailDTO | null>(null);
  const [draftText, setDraftText] = useState("");
  const [words, setWords] = useState<AdminRevisionWordDTO[]>([]);
  const [wordSyncError, setWordSyncError] = useState<string | null>(null);
  const [selectedWord, setSelectedWord] = useState<number | null>(null);
  const [wordFilter, setWordFilter] = useState<WordFilter>("all");
  const [error, setError] = useState<LoadError | null>(null);
  const [noticeState, setNoticeState] = useState<{
    message: string;
    tone: "info" | "error";
  } | null>(null);
  const [queuedOcrJob, setQueuedOcrJob] = useState<AdminOcrJobDTO | null>(null);
  const [busyQueuedJobAction, setBusyQueuedJobAction] = useState<
    "check" | "cancel" | null
  >(null);
  const notice = noticeState?.message ?? null;
  const noticeTone = noticeState?.tone ?? "info";
  const setNotice = useCallback(
    (value: string | null, tone: "info" | "error" = "info") => {
      setNoticeState(value ? { message: value, tone } : null);
    },
    [],
  );
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [proofreadAudit, setProofreadAudit] = useState<
    AdminRevisionVerifyRequestDTO["proofread_audit"] | null
  >(null);
  const [aiCheckUnavailable, setAiCheckUnavailable] = useState(false);
  const [aiAcceptedChanges, setAiAcceptedChanges] = useState<Set<number>>(
    () => new Set(),
  );
  const [aiDiffPage, setAiDiffPage] = useState(0);
  const [aiProgress, setAiProgress] = useState<AdminAiWorkflowProgress | null>(
    null,
  );
  const [aiWorkflow, setAiWorkflow] = useState<AdminAiWorkflowDTO | null>(null);
  const [safetyDecisionReason, setSafetyDecisionReason] = useState("");
  const [imageSafetyReason, setImageSafetyReason] = useState("");
  const [candidateEditPending, setCandidateEditPending] = useState(false);
  const [busy, setBusy] = useState<
    | "edit"
    | "save"
    | "verify"
    | "reprocess"
    | "reupload"
    | "ai_correct"
    | "workflow"
    | null
  >(null);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [illustrationStudioOpen, setIllustrationStudioOpen] = useState(false);

  const aiCorrectRealPercent = useMemo(() => {
    if (busy !== "ai_correct") return null;
    if (
      typeof aiWorkflow?.progress_pct === "number" &&
      Number.isFinite(aiWorkflow.progress_pct)
    ) {
      return aiWorkflow.progress_pct;
    }
    const status = aiProgress?.status;
    const completed = aiProgress?.progress.completed_chunks ?? 0;
    const total = aiProgress?.progress.total_chunks ?? 0;
    const ratio = total > 0 ? Math.min(1, completed / total) : 0;
    if (status === "READY_FOR_ADMIN_REVIEW") return 100;
    if (status === "CHILD_SAFETY_SCANNING") {
      return total > 0 ? Math.round(55 + ratio * 38) : 65;
    }
    if (status === "PROOFREADING") {
      return total > 0 ? Math.round(10 + ratio * 45) : 16;
    }
    if (status === "QUEUED") return 6;
    return 10;
  }, [aiProgress, aiWorkflow?.progress_pct, busy]);

  const aiCorrectBarProgress = useAiProgress({
    active: busy === "ai_correct",
    realPercent: aiCorrectRealPercent,
    progressMode:
      aiProgress?.status === "READY_FOR_ADMIN_REVIEW" ? "measured" : "staged",
    completed: aiProgress?.status === "READY_FOR_ADMIN_REVIEW",
    failed: aiProgress?.status === "FAILED",
    expectedDurationMs: 16_000,
  });

  const isQueuedJobOffline = Boolean(
    queuedOcrJob &&
    queuedOcrJob.worker_online === false &&
    (queuedOcrJob.status === "QUEUED" ||
      queuedOcrJob.status === "FAILED_RETRYABLE"),
  );
  const queuedOcrRealPercent = useMemo(() => {
    if (!queuedOcrJob) return null;
    if (isQueuedJobOffline) return 2;
    if (
      typeof queuedOcrJob.progress_pct === "number" &&
      Number.isFinite(queuedOcrJob.progress_pct)
    ) {
      return queuedOcrJob.progress_pct;
    }
    if (queuedOcrJob.status === "RUNNING") return 55;
    if (queuedOcrJob.status === "CLAIMED") return 30;
    if (queuedOcrJob.status === "FAILED_RETRYABLE") return 15;
    return 12;
  }, [isQueuedJobOffline, queuedOcrJob]);

  const queuedOcrBarProgress = useAiProgress({
    active: Boolean(queuedOcrJob),
    realPercent: queuedOcrRealPercent,
    progressMode: isQueuedJobOffline ? "measured" : "staged",
    expectedDurationMs: 14_000,
  });

  const reprocessStages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.uploading") },
      { atPct: 30, label: tCommon("aiProgress.ocrExtracting") },
      { atPct: 82, label: tCommon("aiProgress.finalizing") },
    ],
    [tCommon],
  );
  const reprocessBarProgress = useAiProgress({
    active: busy === "reprocess" || busy === "reupload",
    stages: reprocessStages,
    expectedDurationMs: 14_000,
  });
  const requestIdRef = useRef(0);
  const revisionChoiceRequestIdRef = useRef(0);
  const draftEditVersionRef = useRef(0);
  const mountedRef = useRef(false);
  const wordRefs = useRef(new Map<number, HTMLElement>());
  const autoScrolledRevisionRef = useRef<string | null>(null);
  const aiCorrectionAbortRef = useRef<AbortController | null>(null);
  const candidateSyncRequestRef = useRef(0);

  const applyDetail = useCallback((next: AdminPageRevisionDetailDTO) => {
    draftEditVersionRef.current += 1;
    setDetail(next);
    setAiWorkflow(null);
    setCandidateEditPending(false);
    setDraftText(next.draft_text ?? "");
    setWordSyncError(null);
    setAiSuggestion(null);
    setProofreadAudit(null);
    setAiCheckUnavailable(false);
    setAiAcceptedChanges(new Set());
    setAiDiffPage(0);
    setWordFilter("all");
    setWords(
      next.words.map((word) => ({
        ...word,
        text: word.text.normalize("NFC"),
        normalized_text: normalizeVietnameseWord(word.text),
        bbox: [...word.bbox] as [number, number, number, number],
      })),
    );
    setSelectedWord(null);
  }, []);

  const restoreWorkflowReview = useCallback(
    (
      workflow: AdminAiWorkflowDTO | null,
      revision: AdminPageRevisionDetailDTO,
    ) => {
      if (!workflow?.candidate_text || !workflow.proofread_text) return;
      const savedDraft = revision.draft_text ?? "";
      if (workflow.candidate_version <= 1) {
        if (workflow.candidate_text !== savedDraft) {
          setAiSuggestion(workflow.candidate_text);
        } else {
          setProofreadAudit({
            mode: "AI_CHECKED",
            checked_text: savedDraft,
            suggestions: [],
          });
        }
        return;
      }
      const synchronized = syncPageTextToWords(
        workflow.candidate_text,
        revision.words,
      );
      if (
        synchronized.status === "synchronized" &&
        synchronized.tokens.length === revision.words.length
      ) {
        setDraftText(workflow.candidate_text);
        setWords([...synchronized.words]);
        setCandidateEditPending(false);
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      revisionChoiceRequestIdRef.current += 1;
      aiCorrectionAbortRef.current?.abort();
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setError(null);
    setBook(null);
    setImage(null);
    setHistory(null);
    setDetail(null);
    setNotice(null);
    revisionChoiceRequestIdRef.current += 1;
    try {
      const bookPromise = books.get(bookId);
      const bookPages = await pages.list(bookId);
      const belongsToBook = bookPages.some(
        (item) => item.processing.page_id === pageId,
      );
      if (!belongsToBook) {
        void bookPromise.catch(() => {});
        if (requestId === requestIdRef.current) setError("not-found");
        return;
      }

      const historyPromise = revisions.list(pageId);
      const preferredCallsPromise = preferredRevisionId
        ? Promise.all([
            ocr
              .getRevision(pageId, preferredRevisionId)
              .then((value) => ({ ok: true as const, value }))
              .catch((cause: unknown) => ({ ok: false as const, cause })),
            pages
              .getImage(pageId, preferredRevisionId)
              .then((value) => ({ ok: true as const, value }))
              .catch((cause: unknown) => ({ ok: false as const, cause })),
            ocr
              .getLatestWorkflow(pageId, preferredRevisionId)
              .catch(() => null),
          ])
        : null;

      const [nextBook, nextHistory] = await Promise.all([
        bookPromise,
        historyPromise,
      ]);
      const active = nextHistory[0];
      if (!active) {
        if (requestId === requestIdRef.current) setError("unavailable");
        return;
      }
      const preferredRevision = preferredRevisionId
        ? nextHistory.find(
            (item) => item.page_revision_id === preferredRevisionId,
          )
        : undefined;
      const selectedRevision = preferredRevision ?? active;

      let nextDetail: Awaited<ReturnType<typeof ocr.getRevision>>;
      let nextImage: Awaited<ReturnType<typeof pages.getImage>>;
      let nextWorkflow: Awaited<ReturnType<typeof ocr.getLatestWorkflow>>;

      if (preferredRevision && preferredCallsPromise) {
        const [detailRes, imageRes, workflowRes] = await preferredCallsPromise;
        if (!detailRes.ok) throw detailRes.cause;
        if (!imageRes.ok) throw imageRes.cause;
        nextDetail = detailRes.value;
        nextImage = imageRes.value;
        nextWorkflow = workflowRes;
      } else {
        [nextDetail, nextImage, nextWorkflow] = await Promise.all([
          ocr.getRevision(pageId, selectedRevision.page_revision_id),
          pages.getImage(pageId, selectedRevision.page_revision_id),
          ocr
            .getLatestWorkflow(pageId, selectedRevision.page_revision_id)
            .catch(() => null),
        ]);
      }
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setBook(nextBook);
      setImage(nextImage);
      setHistory(nextHistory);
      applyDetail(nextDetail);
      setAiWorkflow(nextWorkflow);
      restoreWorkflowReview(nextWorkflow, nextDetail);
      if (preferredRevisionId && !preferredRevision) {
        setNotice(t("ocrReview.notices.reportRevisionFallback"));
      }
    } catch (cause) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setError(
        isServiceError(cause) && cause.code === "RESOURCE_NOT_FOUND"
          ? "not-found"
          : isServiceError(cause) && [501, 503].includes(cause.status)
            ? "unavailable"
            : "safe",
      );
    }
  }, [
    applyDetail,
    bookId,
    books,
    ocr,
    pageId,
    pages,
    preferredRevisionId,
    revisions,
    restoreWorkflowReview,
    setNotice,
    t,
  ]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (
      !candidateEditPending ||
      !aiWorkflow ||
      !detail ||
      detail.page_revision_id !== aiWorkflow.page_revision_id ||
      !draftText.trim()
    ) {
      return;
    }
    const requestId = ++candidateSyncRequestRef.current;
    const requestedRevision = detail.page_revision_id;
    const timer = globalThis.setTimeout(() => {
      void ocr
        .updateWorkflowCandidate(
          pageId,
          aiWorkflow.workflow_id,
          aiWorkflow.candidate_version,
          draftText,
        )
        .then((updated) => {
          if (
            !mountedRef.current ||
            candidateSyncRequestRef.current !== requestId ||
            detail?.page_revision_id !== requestedRevision
          ) {
            return;
          }
          setAiWorkflow(updated);
          setCandidateEditPending(false);
        })
        .catch(async (cause: unknown) => {
          if (
            !mountedRef.current ||
            candidateSyncRequestRef.current !== requestId ||
            detail?.page_revision_id !== requestedRevision
          ) {
            return;
          }
          setCandidateEditPending(false);
          try {
            const latest = await ocr.getLatestWorkflow(
              pageId,
              requestedRevision,
            );
            if (
              !mountedRef.current ||
              candidateSyncRequestRef.current !== requestId ||
              detail?.page_revision_id !== requestedRevision
            ) {
              return;
            }
            if (latest) setAiWorkflow(latest);
          } catch {
            if (
              !mountedRef.current ||
              candidateSyncRequestRef.current !== requestId ||
              detail?.page_revision_id !== requestedRevision
            ) {
              return;
            }
            setNotice(
              isServiceError(cause)
                ? t("ocrReview.notices.candidateSaveErrorWithMsg", {
                    message: cause.message,
                  })
                : t("ocrReview.notices.candidateSaveError"),
              "error",
            );
          }
        });
    }, 600);
    return () => {
      globalThis.clearTimeout(timer);
      candidateSyncRequestRef.current += 1;
    };
  }, [
    aiWorkflow,
    candidateEditPending,
    detail,
    draftText,
    ocr,
    pageId,
    setNotice,
    t,
  ]);

  const activeWorkflowId = aiWorkflow?.workflow_id ?? null;
  const activeWorkflowStatus = aiWorkflow?.status ?? null;
  const activeWorkflowRevisionId = aiWorkflow?.page_revision_id ?? null;

  useEffect(() => {
    if (
      !activeWorkflowId ||
      !activeWorkflowRevisionId ||
      !activeWorkflowStatus ||
      !["QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"].includes(
        activeWorkflowStatus,
      )
    ) {
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const poll = async () => {
      if (disposed) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        if (!disposed) timer = globalThis.setTimeout(() => void poll(), 1800);
        return;
      }
      try {
        const latest = await ocr.getLatestWorkflow(
          pageId,
          activeWorkflowRevisionId,
        );
        if (!disposed && latest?.workflow_id === activeWorkflowId) {
          setAiWorkflow(latest);
        }
      } catch {
        // The page remains usable while this durable workflow is temporarily unavailable.
      }
      if (!disposed) timer = globalThis.setTimeout(() => void poll(), 1800);
    };
    timer = globalThis.setTimeout(() => void poll(), 1800);
    return () => {
      disposed = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [
    activeWorkflowId,
    activeWorkflowRevisionId,
    activeWorkflowStatus,
    ocr,
    pageId,
  ]);

  useEffect(() => {
    if (!detail || words.length === 0) return;
    if (autoScrolledRevisionRef.current === detail.page_revision_id) return;

    const firstUncertain = words.find((word) => {
      const status = getWordReviewStatus(word, detail.verification_status);
      const paddleLineScore = getPaddleLineScoreForWord(
        detail.ocr_metadata,
        word,
      );
      return getWordReviewColorGroup(status, word, paddleLineScore) !== "green";
    });
    if (firstUncertain) {
      autoScrolledRevisionRef.current = detail.page_revision_id;
      const element =
        wordRefs.current.get(firstUncertain.word_index) ||
        document.getElementById(`ocr-word-${firstUncertain.word_index}`);
      if (typeof element?.scrollIntoView === "function") {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [detail, words]);

  async function chooseRevision(revisionId: string) {
    const requestId = ++revisionChoiceRequestIdRef.current;
    try {
      const [selected, selectedImage, selectedWorkflow] = await Promise.all([
        ocr.getRevision(pageId, revisionId),
        pages.getImage(pageId, revisionId),
        ocr.getLatestWorkflow(pageId, revisionId).catch(() => null),
      ]);
      if (
        !mountedRef.current ||
        requestId !== revisionChoiceRequestIdRef.current
      )
        return;
      applyDetail(selected);
      setAiWorkflow(selectedWorkflow);
      restoreWorkflowReview(selectedWorkflow, selected);
      setImage(selectedImage);
      setNotice(null);
      setActiveTab((current) => (current === "history" ? "draft" : current));
    } catch {
      if (
        !mountedRef.current ||
        requestId !== revisionChoiceRequestIdRef.current
      )
        return;
      setNotice(t("ocrReview.notices.loadRevisionError"), "error");
    }
  }

  const selectWordOnImage = useCallback(
    (index: number | null) => {
      setSelectedWord(index);
      if (index === null) return;

      const selected = words.find((word) => word.word_index === index);
      const selectedStatus = selected
        ? getWordReviewStatus(selected, detail?.verification_status)
        : "needs_review";
      const paddleLineScore =
        selected && detail
          ? getPaddleLineScoreForWord(detail.ocr_metadata, selected)
          : null;
      if (
        !matchesWordFilter(
          selectedStatus,
          wordFilter,
          selected,
          paddleLineScore,
        )
      ) {
        setWordFilter(
          matchesWordFilter(selectedStatus, "review", selected, paddleLineScore)
            ? "review"
            : "all",
        );
      }

      const element =
        wordRefs.current.get(index) ||
        document.getElementById(`ocr-word-${index}`);
      if (typeof element?.scrollIntoView === "function") {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      const textarea = document.getElementById(
        "ocr-text",
      ) as HTMLTextAreaElement | null;
      if (textarea) {
        const range = getWordRangeInText(draftText, index);
        if (range) {
          textarea.focus();
          textarea.setSelectionRange(range[0], range[1]);
        }
      }
    },
    [detail, draftText, wordFilter, words],
  );

  function handleDraftTextChange(value: string, preserveProofread = false) {
    draftEditVersionRef.current += 1;
    setAiSuggestion(null);
    setAiAcceptedChanges(new Set());
    if (!preserveProofread) {
      setProofreadAudit(null);
      setAiCheckUnavailable(false);
    }
    setAiDiffPage(0);
    const normalizedText = value.normalize("NFC");
    setDraftText(normalizedText);
    setCandidateEditPending(true);
    const result = syncPageTextToWords(normalizedText, words);
    if (result.status === "synchronized") {
      setWords([...result.words]);
      setWordSyncError(null);
      return;
    }
    setWordSyncError(
      t("ocrReview.notices.syncTextBlockedCount", {
        actual: formatNumber(result.actualTokenCount),
        expected: formatNumber(result.expectedWordCount),
      }),
    );
  }

  function updateWord(index: number, patch: Partial<AdminRevisionWordDTO>) {
    draftEditVersionRef.current += 1;
    setAiSuggestion(null);
    setAiAcceptedChanges(new Set());
    setProofreadAudit(null);
    setAiCheckUnavailable(false);
    const nextWords = words.map((word) => {
      if (word.word_index !== index) return word;
      const nextText =
        patch.text !== undefined ? patch.text.normalize("NFC") : word.text;
      const tokenChanged = nextText !== word.text.normalize("NFC");
      return {
        ...word,
        ...patch,
        text: nextText,
        ocr_confidence: tokenChanged
          ? null
          : patch.ocr_confidence !== undefined
            ? patch.ocr_confidence
            : word.ocr_confidence,
        ocr_score_source: tokenChanged
          ? null
          : (patch.ocr_score_source ?? word.ocr_score_source),
        // Keep the original OCR candidates for audit. source_text makes it clear
        // that this evidence belongs to the engine output, not the edited token.
        ocr_evidence: word.ocr_evidence,
        ocr_review_status: tokenChanged
          ? ("needs_review" as const)
          : (word.ocr_review_status ?? "needs_review"),
        normalized_text:
          patch.text === undefined
            ? (patch.normalized_text ?? word.normalized_text)
            : normalizeVietnameseWord(patch.text),
      };
    });
    setWords(nextWords);
    const result = syncWordsToPageText(draftText, nextWords);
    if (result.status === "synchronized") {
      setDraftText(result.text.normalize("NFC"));
      setCandidateEditPending(true);
      setWordSyncError(null);
    } else {
      setWordSyncError(
        t("ocrReview.notices.syncWordsBlockedCount", {
          expected: formatNumber(result.expectedWordCount),
          actual: formatNumber(result.actualTokenCount),
        }),
      );
    }
  }

  function updateBbox(index: number, coordinate: number, value: number) {
    draftEditVersionRef.current += 1;
    setAiSuggestion(null);
    setAiAcceptedChanges(new Set());
    setProofreadAudit(null);
    setAiCheckUnavailable(false);
    setWords((current) =>
      current.map((word) => {
        if (word.word_index !== index) return word;
        const next = [...word.bbox] as [number, number, number, number];
        next[coordinate] = value;
        return { ...word, bbox: next };
      }),
    );
  }

  function syncTextFromWords() {
    draftEditVersionRef.current += 1;
    setAiSuggestion(null);
    setAiAcceptedChanges(new Set());
    setProofreadAudit(null);
    setAiCheckUnavailable(false);
    const nextText = words
      .map((word) => word.text.trim())
      .filter(Boolean)
      .join(" ")
      .normalize("NFC");
    setDraftText(nextText);
    setCandidateEditPending(true);
    const result = syncPageTextToWords(nextText, words);
    if (result.status === "synchronized") {
      setWords([...result.words]);
      setWordSyncError(null);
    } else {
      setWordSyncError(t("ocrReview.notices.syncEmptyOrMultiWord"));
    }
  }

  function reconcileAllMatchedWords() {
    draftEditVersionRef.current += 1;
    setAiSuggestion(null);
    setAiAcceptedChanges(new Set());
    setProofreadAudit(null);
    setAiCheckUnavailable(false);
    const result = syncPageTextToWords(draftText, words);
    if (result.status === "synchronized") {
      setWords([...result.words]);
      setWordSyncError(null);
      setNotice(t("ocrReview.notices.syncSuccess"));
    } else {
      setWordSyncError(t("ocrReview.notices.syncCountMismatch"));
    }
  }

  async function correctWithAi() {
    if (aiWorkflow?.status === "FAILED" && aiWorkflow.proofread_text === null) {
      await retryWorkflow();
      return;
    }
    if (
      !draftText.trim() ||
      busy !== null ||
      detail?.lifecycle_status !== "ACTIVE" ||
      detail.verification_status !== "NEEDS_REVIEW"
    ) {
      return;
    }
    const requestedRevisionId = detail.page_revision_id;
    const requestedText = draftText;
    const requestedVersion = draftEditVersionRef.current;
    const requestedTokens = tokenizePageText(requestedText);
    const expectedTokenCount = requestedTokens.length;
    const controller = new AbortController();
    aiCorrectionAbortRef.current = controller;
    setAiWorkflow(null);
    setCandidateEditPending(false);
    setBusy("ai_correct");
    setAiProgress(null);
    setAiSuggestion(null);
    setProofreadAudit(null);
    setAiCheckUnavailable(false);
    setAiAcceptedChanges(new Set());
    setAiDiffPage(0);
    setNotice(null);
    taskCenter?.markTargetAlertsSeen({ bookId, bookPageId: pageId });
    try {
      const workflow = await ocr.runCombinedWorkflow(
        pageId,
        requestedRevisionId,
        requestedText,
        words,
        (progress) => {
          if (mountedRef.current) setAiProgress(progress);
        },
        controller.signal,
      );
      if (
        !mountedRef.current ||
        draftEditVersionRef.current !== requestedVersion ||
        detail?.page_revision_id !== requestedRevisionId
      ) {
        return;
      }
      setAiWorkflow(workflow);
      taskCenter?.markTaskAlertSeen(workflow.workflow_id, {
        includeNextSync: true,
      });
      taskCenter?.markTargetAlertsSeen(
        { bookId, bookPageId: pageId },
        { includeNextSync: true },
      );
      emitStudioTasksChanged({ portal: "admin" });
      const correctedText = workflow.proofread_text?.normalize("NFC");
      if (!correctedText) {
        setAiCheckUnavailable(true);
        setNotice(t("ocrReview.notices.proofreadInvalid"), "error");
        return;
      }
      const result = syncPageTextToWords(correctedText, words);
      if (
        result.status !== "synchronized" ||
        result.tokens.length !== expectedTokenCount ||
        result.tokens.length !== words.length
      ) {
        setAiCheckUnavailable(true);
        setNotice(t("ocrReview.notices.proofreadUnaligned"), "error");
        return;
      }
      const changes = result.tokens.flatMap((token, index) =>
        token === requestedTokens[index] ? [] : [{ index, token }],
      );
      if (changes.length === 0) {
        setProofreadAudit({
          mode: "AI_CHECKED",
          checked_text: requestedText,
          suggestions: [],
        });
        setNotice(
          workflow.safety_status === "FAILED"
            ? t("ocrReview.notices.proofreadNoneSafetyFailed")
            : t("ocrReview.notices.proofreadNoneSafetyOk"),
        );
        return;
      }
      setAiSuggestion(correctedText);
      setAiAcceptedChanges(new Set());
      setNotice(
        workflow.safety_status === "FAILED"
          ? t("ocrReview.notices.proofreadChangesSafetyFailed", {
              count: formatNumber(changes.length),
            })
          : t("ocrReview.notices.proofreadChangesSafetyOk", {
              count: formatNumber(changes.length),
            }),
      );
    } catch (cause) {
      if (
        !mountedRef.current ||
        draftEditVersionRef.current !== requestedVersion ||
        detail?.page_revision_id !== requestedRevisionId
      ) {
        return;
      }
      if (
        controller.signal.aborted ||
        cause instanceof AiCorrectionCancelledError
      ) {
        setNotice(t("ocrReview.notices.stoppedTracking"));
      } else {
        setAiCheckUnavailable(true);
        const safeMessage = isServiceError(cause)
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : t("ocrReview.notices.aiErrorKeepCurrent");
        setNotice(
          safeMessage.startsWith("Không thể") ||
            safeMessage.startsWith("AI OCR")
            ? safeMessage
            : t("ocrReview.notices.aiErrorPrefix", { message: safeMessage }),
          "error",
        );
      }
    } finally {
      aiCorrectionAbortRef.current = null;
      if (mountedRef.current) {
        setBusy(null);
        setAiProgress(null);
      }
    }
  }

  function cancelAiCorrection() {
    aiCorrectionAbortRef.current?.abort();
  }

  async function decideSafety(confirmed: boolean) {
    if (!aiWorkflow?.candidate_hash || !aiWorkflow.hash_match || busy !== null)
      return;
    const reason = safetyDecisionReason.trim();
    const reasonRequired =
      Boolean(aiWorkflow.findings.length) ||
      aiWorkflow.suitability !== "SUITABLE";
    if (confirmed && reasonRequired && !reason) {
      setNotice(t("ocrReview.notices.safetyReasonRequired"), "error");
      return;
    }
    setBusy("workflow");
    setNotice(null);
    try {
      const updatedWorkflow = await ocr.decideWorkflowSafety(
        pageId,
        aiWorkflow.workflow_id,
        aiWorkflow.candidate_hash,
        confirmed,
        reason || undefined,
      );
      if (!mountedRef.current) return;
      setAiWorkflow(updatedWorkflow);
      taskCenter?.markTaskAlertSeen(updatedWorkflow.workflow_id, {
        includeNextSync: true,
      });
      taskCenter?.markTargetAlertsSeen(
        { bookId, bookPageId: pageId },
        { includeNextSync: true },
      );
      emitStudioTasksChanged({ portal: "admin" });
    } catch (cause) {
      setNotice(
        isServiceError(cause)
          ? t("ocrReview.notices.safetyDecisionErrorWithMsg", {
              message: cause.message,
            })
          : t("ocrReview.notices.safetyDecisionError"),
        "error",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function decideImageSafety(
    status: "ADMIN_CONFIRMED_SAFE" | "ADMIN_FLAGGED_UNSAFE",
  ) {
    if (!aiWorkflow || busy !== null || !ocr.decideWorkflowImageSafety) return;
    const reason = imageSafetyReason.trim();
    if (status === "ADMIN_FLAGGED_UNSAFE" && !reason) {
      setNotice(t("ocrReview.notices.imageFlagReasonRequired"), "error");
      return;
    }
    setBusy("workflow");
    setNotice(null);
    try {
      const updatedWorkflow = await ocr.decideWorkflowImageSafety(
        pageId,
        aiWorkflow.workflow_id,
        status,
        aiWorkflow.source_image_sha256 ?? undefined,
        reason || undefined,
      );
      if (!mountedRef.current) return;
      setAiWorkflow(updatedWorkflow);
      taskCenter?.markTaskAlertSeen(updatedWorkflow.workflow_id, {
        includeNextSync: true,
      });
      taskCenter?.markTargetAlertsSeen(
        { bookId, bookPageId: pageId },
        { includeNextSync: true },
      );
      emitStudioTasksChanged({ portal: "admin" });
      setNotice(
        status === "ADMIN_CONFIRMED_SAFE"
          ? t("ocrReview.notices.imageMarkedSafe")
          : t("ocrReview.notices.imageFlaggedUnsafe"),
      );
    } catch (cause) {
      setNotice(
        isServiceError(cause)
          ? t("ocrReview.notices.imageSafetyErrorWithMsg", {
              message: cause.message,
            })
          : t("ocrReview.notices.imageSafetyError"),
        "error",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function retryWorkflow() {
    if (!aiWorkflow || busy !== null) return;
    const retryingSafety =
      aiWorkflow.status !== "FAILED" &&
      aiWorkflow.proofread_text !== null &&
      (aiWorkflow.safety_status === "FAILED" ||
        aiWorkflow.safety_status === "STALE");
    if (aiWorkflow.status !== "FAILED" && !retryingSafety) return;
    setBusy("workflow");
    setNotice(null);
    try {
      setAiWorkflow(await ocr.retryWorkflow(pageId, aiWorkflow.workflow_id));
      taskCenter?.markTaskAlertSeen(aiWorkflow.workflow_id);
      taskCenter?.markTargetAlertsSeen({ bookId, bookPageId: pageId });
      emitStudioTasksChanged({ portal: "admin" });
      setNotice(
        retryingSafety || aiWorkflow.stage === "CHILD_SAFETY_SCANNING"
          ? t("ocrReview.notices.retrySafetyQueued")
          : t("ocrReview.notices.retryProofreadQueued"),
      );
    } catch (cause) {
      setNotice(
        isServiceError(cause)
          ? t("ocrReview.notices.retryWorkflowErrorWithMsg", {
              message: cause.message,
            })
          : t("ocrReview.notices.retryWorkflowError"),
        "error",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  function applySelectedAiChanges() {
    if (!aiSuggestion) return;
    const checkedText = draftText;
    const suggestions = aiChanges.map((change) => ({
      word_index: change.index,
      original: change.original,
      proposed: change.proposed,
      decision: aiAcceptedChanges.has(change.index)
        ? ("ACCEPTED" as const)
        : ("REJECTED" as const),
    }));
    const sourceRanges = [...draftText.matchAll(/\S+/gu)];
    const proposedTokens = tokenizePageText(aiSuggestion);
    let nextText = draftText;
    const selected = [...aiAcceptedChanges].sort((left, right) => right - left);
    for (const index of selected) {
      const source = sourceRanges[index];
      const proposed = proposedTokens[index];
      if (!source || typeof source.index !== "number" || !proposed) continue;
      nextText =
        nextText.slice(0, source.index) +
        proposed +
        nextText.slice(source.index + source[0].length);
    }
    if (aiAcceptedChanges.size > 0) handleDraftTextChange(nextText, true);
    else {
      setAiSuggestion(null);
      setAiAcceptedChanges(new Set());
    }
    setCandidateEditPending(true);
    setProofreadAudit({
      mode: "AI_CHECKED",
      checked_text: checkedText,
      suggestions,
    });
    setAiCheckUnavailable(false);
    setNotice(
      t("ocrReview.notices.aiConfirmedCount", {
        accepted: formatNumber(selected.length),
        rejected: formatNumber(suggestions.length - selected.length),
      }),
    );
  }

  function continueManualVerification() {
    setProofreadAudit({
      mode: "MANUAL_FALLBACK",
      checked_text: draftText,
      suggestions: [],
      reason_code: "AI_CHECK_UNAVAILABLE",
    });
    setAiCheckUnavailable(false);
    setNotice(t("ocrReview.notices.manualContinueAudit"));
  }

  async function resumePendingDraft(
    revisionHistory: readonly AdminRevisionSummaryUI[],
    expectedSourceRevisionId: string,
    requestedPageRequestId: number,
  ): Promise<boolean> {
    const pending = revisionHistory.find(
      (revision) => revision.verification_status === "NEEDS_REVIEW",
    );
    if (!pending) return false;

    const existingDraft = await ocr.getRevision(
      pageId,
      pending.page_revision_id,
    );
    if (
      !mountedRef.current ||
      requestedPageRequestId !== requestIdRef.current
    ) {
      return true;
    }

    if (
      existingDraft.ocr_metadata.source_revision_id !== expectedSourceRevisionId
    ) {
      setNotice(t("ocrReview.notices.draftConflictOther"), "error");
      return true;
    }

    applyDetail(existingDraft);
    setNotice(t("ocrReview.notices.draftReopened"));
    return true;
  }

  async function createEditDraft() {
    if (
      !detail ||
      detail.verification_status !== "VERIFIED" ||
      busy !== null ||
      !history?.some(
        (revision) =>
          revision.page_revision_id === detail.page_revision_id &&
          revision.is_current_verified,
      )
    ) {
      return;
    }
    const expectedSourceRevisionId = detail.page_revision_id;
    const requestedPageRequestId = requestIdRef.current;
    setBusy("edit");
    setNotice(null);
    try {
      if (
        history &&
        (await resumePendingDraft(
          history,
          expectedSourceRevisionId,
          requestedPageRequestId,
        ))
      ) {
        return;
      }

      const created = await revisions.createDraft(
        pageId,
        expectedSourceRevisionId,
      );
      if (
        !mountedRef.current ||
        requestedPageRequestId !== requestIdRef.current
      ) {
        return;
      }
      applyDetail(created);
      try {
        setHistory(await revisions.list(pageId));
      } catch {
        // The new revision remains usable if history refresh fails.
      }
      setNotice(t("ocrReview.notices.draftCreatedFromVerified"));
    } catch (cause) {
      if (isServiceError(cause) && cause.status === 409) {
        try {
          const latestHistory = await revisions.list(pageId);
          if (
            !mountedRef.current ||
            requestedPageRequestId !== requestIdRef.current
          ) {
            return;
          }
          setHistory(latestHistory);
          if (
            await resumePendingDraft(
              latestHistory,
              expectedSourceRevisionId,
              requestedPageRequestId,
            )
          ) {
            return;
          }
        } catch {
          // Keep the original conflict notice if the refresh also fails.
        }
      }
      setNotice(
        isServiceError(cause)
          ? t("ocrReview.notices.draftCreateErrorWithMsg", {
              message: cause.message,
            })
          : t("ocrReview.notices.draftCreateError"),
        "error",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }
  async function saveDraft() {
    if (
      !detail ||
      detail.verification_status !== "NEEDS_REVIEW" ||
      busy !== null
    ) {
      return;
    }
    if (candidateEditPending && aiWorkflow?.proofread_text) {
      setNotice(t("ocrReview.notices.candidateSyncingNotice"));
      return;
    }
    const requestedRevisionId = detail.page_revision_id;
    const requestedVersion = draftEditVersionRef.current;
    setBusy("save");
    setNotice(null);
    try {
      const saved = await ocr.saveDraft(
        pageId,
        requestedRevisionId,
        draftText,
        words,
      );
      if (
        !mountedRef.current ||
        requestedVersion !== draftEditVersionRef.current ||
        detail?.page_revision_id !== requestedRevisionId
      ) {
        return;
      }
      const latestWorkflow = aiWorkflow
        ? await ocr
            .getLatestWorkflow(pageId, requestedRevisionId)
            .catch(() => aiWorkflow)
        : null;
      applyDetail(saved);
      setAiWorkflow(latestWorkflow);
      restoreWorkflowReview(latestWorkflow, saved);
      if (latestWorkflow) {
        taskCenter?.markTaskAlertSeen(latestWorkflow.workflow_id, {
          includeNextSync: true,
        });
      }
      taskCenter?.markTargetAlertsSeen(
        { bookId, bookPageId: pageId },
        { includeNextSync: true },
      );
      emitStudioTasksChanged({ portal: "admin" });
      setNotice(t("ocrReview.notices.draftSaved"));
      try {
        setHistory(await revisions.list(pageId));
      } catch {
        setNotice(t("ocrReview.notices.draftSavedHistoryError"), "error");
      }
    } catch (cause) {
      if (
        !mountedRef.current ||
        requestedVersion !== draftEditVersionRef.current ||
        detail?.page_revision_id !== requestedRevisionId
      ) {
        return;
      }
      setNotice(
        isServiceError(cause)
          ? t("ocrReview.notices.draftSaveErrorWithMsg", {
              message: cause.message,
            })
          : t("ocrReview.notices.draftSaveError"),
        "error",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function verifyRevision() {
    if (
      !detail ||
      detail.verification_status !== "NEEDS_REVIEW" ||
      busy !== null
    ) {
      return;
    }
    if (aiSuggestion !== null) {
      setNotice(t("ocrReview.notices.confirmAiBeforeVerify"), "error");
      return;
    }
    let finalProofreadAudit = proofreadAudit;
    if (finalProofreadAudit === null && aiWorkflow?.proofread_text) {
      finalProofreadAudit = {
        mode: "ADMIN_EDITED",
        checked_text: draftText,
        suggestions: [],
      };
    }
    if (finalProofreadAudit === null) {
      await correctWithAi();
      return;
    }
    if (candidateEditPending && aiWorkflow?.proofread_text) {
      setNotice(t("ocrReview.notices.waitCandidateHash"));
      return;
    }
    const requestedRevisionId = detail.page_revision_id;
    const requestedVersion = draftEditVersionRef.current;
    setBusy("verify");
    setNotice(null);
    try {
      const verifiedResult = await revisions.verify(pageId, {
        page_revision_id: requestedRevisionId,
        workflow_id: aiWorkflow?.proofread_text
          ? aiWorkflow.workflow_id
          : undefined,
        corrected_text: draftText,
        words,
        proofread_audit: finalProofreadAudit,
      });
      if (
        !mountedRef.current ||
        requestedVersion !== draftEditVersionRef.current ||
        detail?.page_revision_id !== requestedRevisionId
      ) {
        return;
      }
      applyDetail(verifiedResult);
      if (aiWorkflow) {
        taskCenter?.markTaskAlertSeen(aiWorkflow.workflow_id, {
          includeNextSync: true,
        });
      }
      taskCenter?.markTargetAlertsSeen(
        { bookId, bookPageId: pageId },
        { includeNextSync: true },
      );
      emitStudioTasksChanged({ portal: "admin" });
      setNotice(t("ocrReview.notices.verifiedSaved"));
      try {
        setHistory(await revisions.list(pageId));
      } catch {
        setNotice(t("ocrReview.notices.verifiedSavedHistoryError"), "error");
      }
    } catch (cause) {
      if (
        !mountedRef.current ||
        requestedVersion !== draftEditVersionRef.current ||
        detail?.page_revision_id !== requestedRevisionId
      ) {
        return;
      }
      setNotice(
        isServiceError(cause)
          ? t("ocrReview.notices.verifyErrorWithMsg", {
              message: cause.message,
            })
          : t("ocrReview.notices.verifyError"),
        "error",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  // Restore any active queued/running OCR job for this page across reloads.
  useEffect(() => {
    if (typeof pages.listOcrJobs !== "function") return;
    let active = true;
    const controller = new AbortController();
    void pages
      .listOcrJobs(bookId, controller.signal)
      .then((jobs) => {
        if (!active || controller.signal.aborted) return;
        const match =
          jobs.find(
            (job) =>
              job.page_id === pageId && isActiveAdminOcrJobStatus(job.status),
          ) ?? null;
        setQueuedOcrJob(match);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      controller.abort();
    };
  }, [bookId, pageId, pages]);

  // Gently auto-poll queued OCR job (12s when laptop worker is offline, 3s when online)
  // and refresh the new revision automatically as soon as the worker completes it.
  const queuedOcrJobId = queuedOcrJob?.id ?? null;
  const queuedOcrWorkerOffline = queuedOcrJob?.worker_online === false;

  const applyPolledQueuedJob = useCallback(
    async (
      nextJob: AdminOcrJobDTO,
      isCancelled?: () => boolean,
    ): Promise<"done" | "pending"> => {
      if (isCancelled?.()) return "done";
      if (nextJob.status === "SUCCEEDED") {
        setQueuedOcrJob(null);
        const nextRevisionId =
          nextJob.revision_id ?? (await pages.reload(pageId)).page_revision_id;
        const [nextDetail, nextImage, nextHistory] = await Promise.all([
          ocr.getRevision(pageId, nextRevisionId),
          pages.getImage(pageId, nextRevisionId),
          revisions.list(pageId),
        ]);
        if (!mountedRef.current || isCancelled?.()) return "done";
        setImage(nextImage);
        applyDetail(nextDetail);
        setHistory(nextHistory);
        if (
          typeof document === "undefined" ||
          document.visibilityState !== "hidden"
        ) {
          taskCenter?.markTaskAlertSeen(nextJob.id, { includeNextSync: true });
          taskCenter?.markTargetAlertsSeen(
            { bookId, bookPageId: pageId },
            { includeNextSync: true },
          );
        }
        emitStudioTasksChanged({ portal: "admin" });
        setNotice(
          nextJob.job_kind === "ADMIN_PAGE_REUPLOAD"
            ? t("ocrReview.notices.reuploadCreated")
            : t("ocrReview.notices.reprocessCreated"),
        );
        return "done";
      }
      if (nextJob.status === "DEAD_LETTER" || nextJob.status === "CANCELLED") {
        setQueuedOcrJob(null);
        if (
          mountedRef.current &&
          (typeof document === "undefined" ||
            document.visibilityState !== "hidden")
        ) {
          taskCenter?.markTaskAlertSeen(nextJob.id, { includeNextSync: true });
          taskCenter?.markTargetAlertsSeen(
            { bookId, bookPageId: pageId },
            { includeNextSync: true },
          );
        }
        emitStudioTasksChanged({ portal: "admin" });
        setNotice(
          nextJob.error_message || t("ocrReview.notices.reprocessError"),
          "error",
        );
        return "done";
      }
      setQueuedOcrJob(nextJob);
      return "pending";
    },
    [
      applyDetail,
      bookId,
      ocr,
      pageId,
      pages,
      revisions,
      setNotice,
      t,
      taskCenter,
    ],
  );

  const checkQueuedOcrJobNow = useCallback(async () => {
    if (!queuedOcrJobId || busyQueuedJobAction !== null) return;
    setBusyQueuedJobAction("check");
    try {
      const nextJob = await getAdminOcrJob(queuedOcrJobId);
      if (!mountedRef.current) return;
      const outcome = await applyPolledQueuedJob(nextJob);
      if (outcome === "pending" && mountedRef.current) {
        setNotice(
          t(
            "ocrReview.notices.queuedJobStillPending",
            undefined,
            "Yêu cầu OCR vẫn đang ở trạng thái chờ xử lý.",
          ),
          "info",
        );
      }
    } catch {
      if (mountedRef.current) {
        setNotice(t("ocrReview.notices.reprocessError"), "error");
      }
    } finally {
      if (mountedRef.current) setBusyQueuedJobAction(null);
    }
  }, [applyPolledQueuedJob, busyQueuedJobAction, queuedOcrJobId, setNotice, t]);

  const cancelQueuedOcrJob = useCallback(async () => {
    if (!queuedOcrJobId || busyQueuedJobAction !== null) return;
    setBusyQueuedJobAction("cancel");
    try {
      if (typeof pages.cancelOcrJob === "function") {
        await pages.cancelOcrJob(queuedOcrJobId);
        emitStudioTasksChanged({ portal: "admin" });
      } else {
        await cancelAdminOcrJob(queuedOcrJobId);
      }
      taskCenter?.markTaskAlertSeen(queuedOcrJobId);
      if (!mountedRef.current) return;
      setQueuedOcrJob(null);
      setNotice(
        t(
          "ocrReview.notices.queuedJobCancelled",
          undefined,
          "Đã hủy yêu cầu chờ chạy OCR cho trang này.",
        ),
        "info",
      );
    } catch {
      if (mountedRef.current) {
        setNotice(
          t(
            "ocrReview.notices.queuedJobCancelError",
            undefined,
            "Không thể hủy yêu cầu chờ OCR lúc này. Vui lòng thử lại.",
          ),
          "error",
        );
      }
    } finally {
      if (mountedRef.current) setBusyQueuedJobAction(null);
    }
  }, [busyQueuedJobAction, pages, queuedOcrJobId, setNotice, t, taskCenter]);

  const ocrWorkerStatus = useOcrWorkerStatus({
    onRecovered: () => {
      if (queuedOcrJobId) {
        void checkQueuedOcrJobNow();
      }
    },
  });

  useEffect(() => {
    if (!queuedOcrJobId) return;
    let active = true;
    let timerId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const controller = new AbortController();

    const clearTimer = () => {
      if (timerId !== null) {
        globalThis.clearTimeout(timerId);
        timerId = null;
      }
    };

    const schedule = (ms: number) => {
      clearTimer();
      if (!active) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      timerId = globalThis.setTimeout(() => {
        void tick();
      }, ms);
    };

    const tick = async () => {
      if (!active) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      try {
        const nextJob = await getAdminOcrJob(queuedOcrJobId, controller.signal);
        const outcome = await applyPolledQueuedJob(
          nextJob,
          () => !active || controller.signal.aborted,
        );
        if (outcome === "done") return;
        schedule(nextJob.worker_online === false ? 12_000 : 3_000);
      } catch {
        if (!active || controller.signal.aborted) return;
        schedule(queuedOcrWorkerOffline ? 12_000 : 5_000);
      }
    };

    const onVisibilityChange = () => {
      if (!active) return;
      if (document.visibilityState === "hidden") {
        clearTimer();
      } else {
        schedule(400);
      }
    };

    schedule(queuedOcrWorkerOffline ? 12_000 : 3_000);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      active = false;
      clearTimer();
      controller.abort();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [applyPolledQueuedJob, queuedOcrJobId, queuedOcrWorkerOffline]);

  async function reprocess() {
    if (!detail || detail.lifecycle_status !== "ACTIVE" || busy !== null)
      return;
    const generation = ++revisionChoiceRequestIdRef.current;
    setBusy("reprocess");
    setNotice(null);
    try {
      const result = await revisions.reprocess(pageId, (status) => {
        if (status.page_id !== pageId) return;
      });
      const [nextImage, nextHistory] = await Promise.all([
        pages.getImage(pageId, result.page_revision_id),
        revisions.list(pageId),
      ]);
      if (
        !mountedRef.current ||
        generation !== revisionChoiceRequestIdRef.current
      )
        return;
      setQueuedOcrJob(null);
      setImage(nextImage);
      applyDetail(result);
      setHistory(nextHistory);
      taskCenter?.markTargetAlertsSeen(
        { bookId, bookPageId: pageId },
        { includeNextSync: true },
      );
      emitStudioTasksChanged({ portal: "admin" });
      setActiveTab("draft");
      setNotice(t("ocrReview.notices.reprocessCreated"));
    } catch (cause) {
      if (
        !mountedRef.current ||
        generation !== revisionChoiceRequestIdRef.current
      )
        return;
      if (isAdminOcrJobQueuedSignal(cause)) {
        setQueuedOcrJob(cause.job);
        taskCenter?.markTargetAlertsSeen({ bookId, bookPageId: pageId });
        setNotice(cause.message, "info");
        return;
      }
      setNotice(t("ocrReview.notices.reprocessError"), "error");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function replaceImageAndReprocess() {
    if (
      !replacementFile ||
      !detail ||
      detail.lifecycle_status !== "ACTIVE" ||
      busy !== null
    )
      return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(replacementFile.type)
    ) {
      setNotice(t("ocrReview.notices.invalidImageType"), "error");
      return;
    }
    if (replacementFile.size <= 0 || replacementFile.size > 12 * 1024 * 1024) {
      setNotice(t("ocrReview.notices.invalidImageSize"), "error");
      return;
    }
    setBusy("reupload");
    const generation = ++revisionChoiceRequestIdRef.current;
    setNotice(null);
    try {
      const result = await pages.replaceImageAndReprocess(
        pageId,
        replacementFile,
      );
      if (result.page_id !== pageId || result.lifecycle_status !== "ACTIVE") {
        throw new Error("Unexpected page OCR response");
      }
      const [nextImage, nextHistory] = await Promise.all([
        pages.getImage(pageId, result.page_revision_id),
        revisions.list(pageId),
      ]);
      if (
        !mountedRef.current ||
        generation !== revisionChoiceRequestIdRef.current
      )
        return;
      setQueuedOcrJob(null);
      setImage(nextImage);
      applyDetail(result);
      setHistory(nextHistory);
      taskCenter?.markTargetAlertsSeen(
        { bookId, bookPageId: pageId },
        { includeNextSync: true },
      );
      emitStudioTasksChanged({ portal: "admin" });
      setReplacementFile(null);
      const input = document.getElementById(
        "replacement-page-image",
      ) as HTMLInputElement | null;
      if (input) input.value = "";
      setActiveTab("draft");
      setNotice(t("ocrReview.notices.reuploadCreated"));
    } catch (cause) {
      if (
        !mountedRef.current ||
        generation !== revisionChoiceRequestIdRef.current
      )
        return;
      if (isAdminOcrJobQueuedSignal(cause)) {
        setQueuedOcrJob(cause.job);
        taskCenter?.markTargetAlertsSeen({ bookId, bookPageId: pageId });
        setReplacementFile(null);
        const input = document.getElementById(
          "replacement-page-image",
        ) as HTMLInputElement | null;
        if (input) input.value = "";
        setNotice(cause.message, "info");
        return;
      }
      setNotice(t("ocrReview.notices.reuploadError"), "error");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  const verified = detail?.verification_status === "VERIFIED";
  const isCurrentVerifiedRevision =
    detail?.verification_status === "VERIFIED" &&
    history?.some(
      (revision) =>
        revision.page_revision_id === detail?.page_revision_id &&
        revision.is_current_verified,
    ) === true;
  const workflowHasHighRisk = Boolean(
    aiWorkflow &&
    (aiWorkflow.suitability === "NOT_RECOMMENDED" ||
      aiWorkflow.findings.some(
        (finding) => String(finding.severity ?? "").toUpperCase() === "HIGH",
      )),
  );
  const workflowCanAutoConfirmSafety = Boolean(
    aiWorkflow?.safety_status === "PROVISIONAL" &&
    aiWorkflow.suitability === "SUITABLE" &&
    aiWorkflow.findings.length === 0 &&
    aiWorkflow.safety_input_hash === aiWorkflow.candidate_hash,
  );
  const workflowSafetyConfirmed = Boolean(
    aiWorkflow?.safety_status === "CONFIRMED" ||
    aiWorkflow?.safety_status === "AUTO_CONFIRMED",
  );
  const workflowImageSafetyStatus =
    aiWorkflow?.image_safety_status ?? "UNASSESSED_NO_VISION_MODEL";
  const workflowImageFlaggedUnsafe =
    workflowImageSafetyStatus === "ADMIN_FLAGGED_UNSAFE";
  const workflowImageUnassessed =
    Boolean(aiWorkflow?.image_safety_status) &&
    workflowImageSafetyStatus !== "ADMIN_CONFIRMED_SAFE";
  const workflowFinalApprovalBlocked = Boolean(
    aiWorkflow?.proofread_text &&
    (!(workflowSafetyConfirmed || workflowCanAutoConfirmSafety) ||
      !aiWorkflow.hash_match ||
      workflowHasHighRisk ||
      workflowImageFlaggedUnsafe ||
      workflowImageUnassessed),
  );

  const draftTokens = useMemo(() => tokenizePageText(draftText), [draftText]);

  const aiSuggestionTokens =
    aiSuggestion === null ? [] : tokenizePageText(aiSuggestion);
  const aiChanges: AiTokenChange[] = (() => {
    if (
      aiSuggestion === null ||
      aiSuggestionTokens.length !== draftTokens.length
    )
      return [];
    return draftTokens.flatMap((original, index) => {
      const proposed = aiSuggestionTokens[index];
      return proposed !== undefined && proposed !== original
        ? [{ index, original, proposed }]
        : [];
    });
  })();
  const aiDiffPageSize = 40;
  const aiDiffPageCount = Math.max(
    1,
    Math.ceil(aiChanges.length / aiDiffPageSize),
  );
  const visibleAiChanges = aiChanges.slice(
    aiDiffPage * aiDiffPageSize,
    (aiDiffPage + 1) * aiDiffPageSize,
  );

  const colorCounts = useMemo(() => {
    const counts: Record<WordReviewColorGroup, number> = {
      green: 0,
      yellow: 0,
      red: 0,
    };
    for (const word of words) {
      const status = getWordReviewStatus(word, detail?.verification_status);
      const paddleLineScore = detail
        ? getPaddleLineScoreForWord(detail.ocr_metadata, word)
        : null;
      counts[getWordReviewColorGroup(status, word, paddleLineScore)] += 1;
    }
    return counts;
  }, [detail, words]);

  const filteredWords = useMemo(
    () =>
      words.filter((word) => {
        const status = getWordReviewStatus(word, detail?.verification_status);
        const paddleLineScore = detail
          ? getPaddleLineScoreForWord(detail.ocr_metadata, word)
          : null;
        return matchesWordFilter(status, wordFilter, word, paddleLineScore);
      }),
    [detail, wordFilter, words],
  );

  useEffect(() => {
    if (selectedWord === null) return;
    const element = wordRefs.current.get(selectedWord);
    if (typeof element?.scrollIntoView === "function") {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [filteredWords, selectedWord]);

  const textAlignment = useMemo(() => {
    if (wordSyncError !== null || draftTokens.length !== words.length) {
      return { canCompare: false, matched: 0, different: 0 };
    }

    let matched = 0;
    for (const word of words) {
      const draftToken = draftTokens[word.word_index];
      if (
        draftToken !== undefined &&
        normalizeVietnameseWord(draftToken) ===
          normalizeVietnameseWord(word.text)
      ) {
        matched += 1;
      }
    }
    return { canCompare: true, matched, different: words.length - matched };
  }, [draftTokens, wordSyncError, words]);

  const wordsNeedingReview = useMemo(
    () =>
      words.filter((word) => {
        const status = getWordReviewStatus(word, detail?.verification_status);
        const paddleLineScore = detail
          ? getPaddleLineScoreForWord(detail.ocr_metadata, word)
          : null;
        return (
          getWordReviewColorGroup(status, word, paddleLineScore) !== "green"
        );
      }),
    [detail, words],
  );
  const nextWordToReview = useMemo(
    () =>
      wordsNeedingReview.find(
        (word) => word.word_index > (selectedWord ?? -1),
      ) ?? wordsNeedingReview[0],
    [selectedWord, wordsNeedingReview],
  );
  const nextReviewPosition = nextWordToReview
    ? wordsNeedingReview.findIndex(
        (word) => word.word_index === nextWordToReview.word_index,
      ) + 1
    : 0;

  if (error) {
    return (
      <EmptyState
        headingLevel={1}
        title={
          error === "not-found"
            ? t("ocrReview.errors.notFoundTitle")
            : error === "unavailable"
              ? t("ocrReview.errors.unavailableTitle")
              : t("ocrReview.errors.loadErrorTitle")
        }
        description={
          error === "not-found"
            ? t("ocrReview.errors.notFoundDesc")
            : error === "unavailable"
              ? t("ocrReview.errors.unavailableDesc")
              : t("ocrReview.errors.genericDesc")
        }
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void load()} variant="secondary">
              {t("common.retry")}
            </Button>
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-semibold text-primary underline"
              href={`/admin/books/${bookId}`}
            >
              {t("ocrReview.errors.backToBook")}
            </Link>
          </div>
        }
      />
    );
  }
  if (!book || !image || !history || !detail)
    return <AdminLoading label={t("ocrReview.loading")} />;

  const runtimeEvidence = safeOcrRuntimeProvenance(detail.ocr_metadata);
  const pagePath = `/admin/books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}`;
  function viewHref(view: "review" | "words" | "history") {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (view === "review") params.delete("view");
    else params.set("view", view);
    const query = params.toString();
    return `${pagePath}${query ? `?${query}` : ""}`;
  }

  if (activeView === "words") {
    return (
      <AdminOcrWordReviewPanel
        backHref={viewHref("review")}
        bookTitle={book.title}
        busy={busy !== null}
        onAddWord={() => {
          if (detail.verification_status !== "NEEDS_REVIEW") return;
          const rawPlaceholder = t("ocrReview.newWordPlaceholder");
          const newWordText =
            tokenizePageText(rawPlaceholder)[0] ?? rawPlaceholder;
          const nextIndex =
            words.reduce(
              (maximum, word) => Math.max(maximum, word.word_index),
              -1,
            ) + 1;
          const nextWord: AdminRevisionWordDTO = {
            word_index: nextIndex,
            line_index: words.at(-1)?.line_index ?? 0,
            text: newWordText,
            normalized_text: normalizeVietnameseWord(newWordText),
            bbox: [0.1, 0.1, 0.1, 0.05],
            ocr_confidence: null,
            ocr_review_status: "needs_review",
          };
          const nextWords = [...words, nextWord];
          const nextText = `${draftText.trim()} ${newWordText}`
            .trim()
            .normalize("NFC");
          const synced = syncPageTextToWords(nextText, nextWords);
          if (synced.status === "synchronized") {
            setWords([...synced.words]);
            setWordSyncError(null);
          } else {
            setWords(nextWords);
            setWordSyncError(t("ocrReview.notices.wordAddSyncError"));
          }
          setDraftText(nextText);
          setCandidateEditPending(true);
          setSelectedWord(nextIndex);
          draftEditVersionRef.current += 1;
        }}
        onComplete={() => router.push(viewHref("review"))}
        onRemoveWord={(wordIndex) => {
          if (detail.verification_status !== "NEEDS_REVIEW") return;
          const removedOrdinal = words.findIndex(
            (word) => word.word_index === wordIndex,
          );
          const range = getWordRangeInText(draftText, removedOrdinal);
          if (!range) return;
          let [start, end] = range;
          if (end < draftText.length && /\s/u.test(draftText[end] ?? "")) {
            end += 1;
          } else if (start > 0 && /\s/u.test(draftText[start - 1] ?? "")) {
            start -= 1;
          }
          const nextText = draftText.slice(0, start) + draftText.slice(end);
          const nextWords = words
            .filter((word) => word.word_index !== wordIndex)
            .map((word, index) => ({ ...word, word_index: index }));
          const synced = syncPageTextToWords(nextText, nextWords);
          if (synced.status !== "synchronized") {
            setWordSyncError(t("ocrReview.notices.wordDeleteSyncError"));
            return;
          }
          setWords([...synced.words]);
          setDraftText(nextText.normalize("NFC"));
          setCandidateEditPending(true);
          setSelectedWord(nextWords[0]?.word_index ?? null);
          setWordSyncError(null);
          draftEditVersionRef.current += 1;
        }}
        onSelectWord={setSelectedWord}
        onUpdateBbox={updateBbox}
        onUpdateWord={updateWord}
        pageNumber={image.page_number}
        revisionNo={detail.revision_no}
        selectedWord={selectedWord}
        status={detail.verification_status}
        wordSyncError={wordSyncError}
        words={words}
      />
    );
  }

  const resolvedBookTitle = book.title.trim() || t("books.detail.missingTitle");
  const workbenchTabs: ReadonlyArray<{
    readonly id: OcrWorkbenchTab;
    readonly label: string;
    readonly badge?: number | null;
    readonly badgeTone?: "warning" | "danger" | "neutral" | "info" | "success";
  }> = [
    {
      id: "draft",
      label: t("ocrReview.workbenchTabs.draft", undefined, "Văn bản & Duyệt"),
    },
    {
      id: "words",
      label: t("ocrReview.workbenchTabs.words", undefined, "Từ & BBox"),
      badge:
        wordsNeedingReview.length > 0
          ? wordsNeedingReview.length
          : words.length,
      badgeTone: wordsNeedingReview.length > 0 ? "warning" : "neutral",
    },
    {
      id: "safety",
      label: t("ocrReview.workbenchTabs.safety", undefined, "AI Safety"),
      badge: aiWorkflow ? aiWorkflow.findings.length : null,
      badgeTone: workflowHasHighRisk
        ? "danger"
        : aiWorkflow?.findings.length
          ? "warning"
          : aiWorkflow
            ? "success"
            : "neutral",
    },
    {
      id: "blocks",
      label: t(
        "ocrReview.workbenchTabs.smartBlocks",
        undefined,
        "Khối thông minh V2",
      ),
    },
    {
      id: "history",
      label: t(
        "ocrReview.workbenchTabs.history",
        undefined,
        "Lịch sử phiên bản",
      ),
      badge: history.length,
      badgeTone: "neutral",
    },
  ];

  const aiWorkflowCard = aiWorkflow ? (
    <section
      className="rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5"
      data-testid="admin-ai-workflow"
    >
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div>
          <h2 className="text-base font-extrabold text-ink">
            {t("ocrReview.safetyPanel.heading")}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {t("ocrReview.safetyPanel.subtitle")}
          </p>
        </div>
        <AdminBadge
          dot
          tone={
            aiWorkflow.status === "FAILED"
              ? "danger"
              : aiWorkflow.status === "READY_FOR_ADMIN_REVIEW"
                ? "success"
                : "info"
          }
        >
          {aiWorkflow.status === "READY_FOR_ADMIN_REVIEW"
            ? t("ocrReview.safetyPanel.readyForReview")
            : aiWorkflow.status === "FAILED"
              ? t("ocrReview.draft.statusFailed")
              : aiWorkflow.stage === "PROOFREADING"
                ? t("ocrReview.safetyPanel.proofreadingRunning")
                : aiWorkflow.stage === "CHILD_SAFETY_SCANNING"
                  ? t("ocrReview.safetyPanel.safetyRunning")
                  : t("ocrReview.safetyPanel.pendingStatus")}
        </AdminBadge>
      </div>

      <div className="mt-3.5 grid gap-2.5 sm:grid-cols-2">
        <div className="min-w-0 rounded-lg border border-border bg-surface-subtle/60 p-2.5">
          <p className="text-[11px] font-semibold text-muted">
            {t("ocrReview.safetyPanel.overallSuitabilityLabel")}
          </p>
          <p className="mt-0.5 break-words text-sm font-extrabold text-ink">
            {aiWorkflow.suitability
              ? formatWorkflowSuitability(aiWorkflow.suitability)
              : t("ocrReview.safetyPanel.noResultBadge")}
          </p>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-surface-subtle/60 p-2.5">
          <p className="text-[11px] font-semibold text-muted">
            {t("ocrReview.safetyPanel.textSafetyHeading")}
          </p>
          <p className="mt-0.5 break-words text-sm font-extrabold text-ink">
            {formatSafetyStatusLabel(
              aiWorkflow.text_safety_status ?? aiWorkflow.safety_status,
            )}
          </p>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-surface-subtle/60 p-2.5 sm:col-span-2">
          <p className="text-[11px] font-semibold text-muted">
            {t("ocrReview.safetyPanel.imageSafetyHeading")}
          </p>
          <p
            className="mt-0.5 break-words text-sm font-extrabold text-ink"
            data-testid="image-safety-status"
          >
            {workflowImageSafetyStatus === "ADMIN_CONFIRMED_SAFE"
              ? t("ocrReview.safetyPanel.imageSafeLabel")
              : workflowImageSafetyStatus === "ADMIN_FLAGGED_UNSAFE"
                ? t("ocrReview.safetyPanel.imageUnsafeLabel")
                : t("ocrReview.safetyPanel.imageUnassessedLabel")}
          </p>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-surface-subtle/60 p-2.5">
          <p className="text-[11px] font-semibold text-muted">
            {t("ocrReview.safetyPanel.candidateVersionLabel")}
          </p>
          <p className="mt-0.5 break-words text-sm font-extrabold text-ink tabular-nums">
            {formatNumber(aiWorkflow.candidate_version)}
          </p>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-surface-subtle/60 p-2.5">
          <p className="text-[11px] font-semibold text-muted">
            {t("ocrReview.safetyPanel.safetyHashMatchLabel")}
          </p>
          <p className="mt-0.5 break-words text-sm font-extrabold text-ink">
            {candidateEditPending
              ? t("ocrReview.safetyPanel.savingCandidateLabel")
              : aiWorkflow.hash_match
                ? t("ocrReview.safetyPanel.hashMatchLabel")
                : t("ocrReview.safetyPanel.hashMismatchLabel")}
          </p>
        </div>
      </div>

      <div
        className="mt-3.5 rounded-lg border border-border bg-surface-subtle/50 p-3"
        data-testid="image-safety-review-panel"
      >
        <p className="text-xs font-extrabold text-ink">
          {t("ocrReview.safetyPanel.manualImageHeading")}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {t("ocrReview.safetyPanel.manualImageDesc")}
        </p>
        <div className="mt-2.5 flex flex-col gap-2.5">
          <label className="block w-full text-xs font-bold text-ink">
            {t("ocrReview.safetyPanel.imageNoteLabel")}
            <input
              className="mt-1 h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary"
              maxLength={500}
              onChange={(event) => setImageSafetyReason(event.target.value)}
              placeholder={t("ocrReview.safetyPanel.imageNotePlaceholder")}
              type="text"
              value={imageSafetyReason}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy !== null}
              isLoading={busy === "workflow"}
              onClick={() => void decideImageSafety("ADMIN_CONFIRMED_SAFE")}
              size="admin"
              type="button"
              variant="secondary"
            >
              <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0" />
              {t("ocrReview.safetyPanel.confirmImageSafeBtn")}
            </Button>
            <Button
              disabled={busy !== null || !imageSafetyReason.trim()}
              isLoading={busy === "workflow"}
              onClick={() => void decideImageSafety("ADMIN_FLAGGED_UNSAFE")}
              size="admin"
              type="button"
              variant="destructive-outline"
            >
              {t("ocrReview.safetyPanel.flagImageUnsafeBtn")}
            </Button>
          </div>
        </div>
      </div>

      {aiWorkflow.uncertain_word_indices.length > 0 ? (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
          {t("ocrReview.safetyPanel.uncertainWordsNote", {
            count: formatNumber(aiWorkflow.uncertain_word_indices.length),
            indices: aiWorkflow.uncertain_word_indices
              .map((index) => index + 1)
              .join(", "),
          })}
        </p>
      ) : null}

      {aiWorkflow.status === "FAILED" || aiWorkflow.safety_status === "FAILED"
        ? (() => {
            const safetyFailure =
              aiWorkflow.stage === "CHILD_SAFETY_SCANNING" ||
              (aiWorkflow.proofread_text !== null &&
                aiWorkflow.safety_status === "FAILED");
            const failedStageEvent = [...aiWorkflow.review_history]
              .reverse()
              .find(
                (event) =>
                  event.event === "WORKFLOW_STAGE_FAILED" &&
                  event.stage ===
                    (safetyFailure ? "CHILD_SAFETY_SCANNING" : "PROOFREADING"),
              );
            const recordedFailureCode = failedStageEvent?.error_code;
            const failureCode =
              aiWorkflow.error_code ??
              (typeof recordedFailureCode === "string"
                ? recordedFailureCode
                : null);
            const failureMessage =
              failureCode === "INVALID_EVIDENCE"
                ? t("ocrReview.safetyPanel.stageFailures.evidenceMismatch")
                : failureCode === "INVALID_JSON"
                  ? t("ocrReview.safetyPanel.stageFailures.invalidJson")
                  : failureCode === "MISSING_REQUIRED_FIELDS"
                    ? t("ocrReview.safetyPanel.stageFailures.missingFields")
                    : failureCode === "INVALID_OUTPUT_SCHEMA"
                      ? t("ocrReview.safetyPanel.stageFailures.schemaMismatch")
                      : failureCode === "PROVIDER_TIMEOUT"
                        ? t("ocrReview.safetyPanel.stageFailures.timeout")
                        : failureCode === "PROVIDER_UNAVAILABLE"
                          ? t("ocrReview.safetyPanel.stageFailures.unavailable")
                          : safetyFailure
                            ? t(
                                "ocrReview.safetyPanel.stageFailures.safetyIncomplete",
                              )
                            : t(
                                "ocrReview.safetyPanel.stageFailures.proofreadIncomplete",
                              );
            return (
              <div
                className="mt-3 rounded-lg border border-amber-400 bg-amber-50 p-3 text-xs text-amber-950"
                role="alert"
              >
                <p className="font-bold">
                  {safetyFailure
                    ? t("ocrReview.safetyPanel.stageFailures.safetyTitle")
                    : t("ocrReview.safetyPanel.stageFailures.proofreadTitle")}
                </p>
                <p className="mt-1">{failureMessage}</p>
                <p className="mt-1">
                  {t("ocrReview.safetyPanel.attemptSuffix", {
                    attempts: formatNumber(aiWorkflow.attempts),
                  }).replace(/^ · /, "")}
                  {` · ${formatDateTime(aiWorkflow.updated_at)}`}
                </p>
                <p className="mt-1">
                  {safetyFailure
                    ? t("ocrReview.safetyPanel.retrySafetyHint")
                    : t("ocrReview.safetyPanel.retryProofreadHint")}
                </p>
              </div>
            );
          })()
        : null}

      {aiWorkflow.status === "READY_FOR_ADMIN_REVIEW" &&
      aiWorkflow.safety_status === "STALE" ? (
        <p
          className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950"
          role="status"
        >
          {t("ocrReview.safetyPanel.candidateChangedWarning")}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {aiWorkflow.status === "FAILED" ||
        (aiWorkflow.proofread_text !== null &&
          (aiWorkflow.safety_status === "FAILED" ||
            aiWorkflow.safety_status === "STALE") &&
          !["QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"].includes(
            aiWorkflow.status,
          )) ? (
          <Button
            disabled={busy !== null}
            isLoading={busy === "workflow"}
            onClick={() => void retryWorkflow()}
            size="admin"
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />
            {aiWorkflow.status === "FAILED" &&
            aiWorkflow.stage === "PROOFREADING"
              ? t("ocrReview.safetyPanel.retryProofreadBtn")
              : t("ocrReview.safetyPanel.retrySafetyBtn")}
          </Button>
        ) : null}
        {aiWorkflow.safety_status === "PROVISIONAL" &&
        aiWorkflow.hash_match &&
        (aiWorkflow.findings.length > 0 ||
          aiWorkflow.suitability !== "SUITABLE") ? (
          <label className="basis-full text-xs font-bold text-ink">
            {t("ocrReview.safetyPanel.reviewReasonLabel")}
            <textarea
              className="mt-1 min-h-20 w-full rounded-control border border-border bg-white p-2.5 text-sm font-normal focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary"
              maxLength={500}
              onChange={(event) => setSafetyDecisionReason(event.target.value)}
              value={safetyDecisionReason}
            />
          </label>
        ) : null}
        {aiWorkflow.safety_status === "PROVISIONAL" && aiWorkflow.hash_match ? (
          <Button
            disabled={
              busy !== null ||
              candidateEditPending ||
              ((Boolean(aiWorkflow.findings.length) ||
                aiWorkflow.suitability !== "SUITABLE") &&
                !safetyDecisionReason.trim())
            }
            isLoading={busy === "workflow"}
            onClick={() => void decideSafety(true)}
            size="admin"
            type="button"
            variant="secondary"
          >
            <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0" />
            {t("ocrReview.safetyPanel.confirmSafetyBtn")}
          </Button>
        ) : aiWorkflow.safety_status === "CONFIRMED" &&
          aiWorkflow.hash_match ? (
          <Button
            disabled={busy !== null}
            isLoading={busy === "workflow"}
            onClick={() => void decideSafety(false)}
            size="admin"
            type="button"
            variant="outline"
          >
            {t("ocrReview.safetyPanel.clearSafetyConfirmBtn")}
          </Button>
        ) : null}
      </div>

      <section className="mt-4">
        <h3 className="text-xs font-extrabold uppercase tracking-wide text-muted">
          {t("ocrReview.safetyPanel.findingsHeading")}
        </h3>
        {aiWorkflow.findings.length ? (
          <ul className="mt-2 grid gap-2.5">
            {aiWorkflow.findings.map((finding, index) => {
              const rawSeverity = String(
                finding.severity ?? "REVIEW",
              ).toUpperCase();
              const severity = formatFindingSeverityLabel(rawSeverity);
              const category = formatFindingCategoryLabel(finding.category);
              const contentType = formatFindingContentTypeLabel(
                finding.content_type,
              );
              const evidence = String(finding.evidence_text ?? "");
              const compactEvidence =
                evidence.length > 240
                  ? evidence.slice(0, 240).trimEnd() + "…"
                  : evidence;
              const high = rawSeverity === "HIGH";
              return (
                <li key={String(finding.finding_id ?? index)}>
                  <details
                    className={
                      "rounded-lg border p-3 " +
                      (high
                        ? "border-red-400 bg-red-50"
                        : "border-border bg-white")
                    }
                  >
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 focus-visible:outline-2 focus-visible:outline-primary">
                      <span className="text-xs font-extrabold">{category}</span>
                      <span className="text-xs text-muted">{contentType}</span>
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-xs font-extrabold " +
                          (high
                            ? "bg-red-700 text-white"
                            : "bg-surface-subtle text-ink")
                        }
                      >
                        {severity}
                      </span>
                      <span className="ms-auto text-xs font-semibold text-primary">
                        {t("ocrReview.safetyPanel.openDetail")}
                      </span>
                    </summary>
                    <div className="mt-2.5 border-t border-border pt-2.5">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
                        {t("ocrReview.safetyPanel.evidenceLabel")}
                      </p>
                      <blockquote className="mt-1 border-s-2 border-primary ps-3 text-xs">
                        <span
                          className="viread-learning-content"
                          dir="ltr"
                          lang="vi"
                        >
                          “{compactEvidence}”
                        </span>
                        <span className="ms-2 font-mono text-[11px] text-muted">
                          [{String(finding.evidence_start ?? "?")}–
                          {String(finding.evidence_end ?? "?")}]
                        </span>
                      </blockquote>
                      {evidence.length > 240 ? (
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer font-bold text-primary">
                            {t("ocrReview.safetyPanel.viewFullQuote", {
                              length: formatNumber(evidence.length),
                            })}
                          </summary>
                          <blockquote
                            className="viread-learning-content mt-1.5 border-s-2 border-primary ps-3"
                            dir="ltr"
                            lang="vi"
                          >
                            “{evidence}”
                          </blockquote>
                        </details>
                      ) : null}
                      <p className="mt-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">
                        {t("ocrReview.safetyPanel.explanationLabel")}
                      </p>
                      <p className="mt-0.5 text-xs">
                        {String(finding.explanation ?? "")}
                      </p>
                      <p className="mt-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">
                        {t("ocrReview.safetyPanel.recommendationLabel")}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {String(finding.recommendation ?? "")}
                      </p>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs text-muted">
            {aiWorkflow.safety_status === "PROVISIONAL" ||
            aiWorkflow.safety_status === "CONFIRMED" ||
            aiWorkflow.safety_status === "AUTO_CONFIRMED"
              ? t("ocrReview.safetyPanel.noFindings")
              : t("ocrReview.safetyPanel.findingsPending")}
          </p>
        )}
      </section>

      {aiWorkflow.safety_history.length > 0 ? (
        <section className="mt-4">
          <h3 className="text-xs font-extrabold uppercase tracking-wide text-muted">
            {t("ocrReview.safetyPanel.historyHeading")}
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            {t("ocrReview.safetyPanel.historyDesc")}
          </p>
          <div className="mt-2 grid gap-2">
            {aiWorkflow.safety_history.map((scan, scanIndex) => {
              const historicalFindings = Array.isArray(scan.findings)
                ? scan.findings.filter(
                    (item): item is Record<string, unknown> =>
                      typeof item === "object" &&
                      item !== null &&
                      !Array.isArray(item),
                  )
                : [];
              return (
                <details
                  className="rounded-lg border border-border p-2.5"
                  key={`${String(scan.scan_id ?? scanIndex)}-${scanIndex}`}
                >
                  <summary className="cursor-pointer text-xs font-bold">
                    {t("ocrReview.safetyPanel.scanStatusLine", {
                      status: formatSafetyStatusLabel(
                        typeof scan.status === "string" ? scan.status : null,
                      ),
                      suitability: scan.suitability
                        ? formatWorkflowSuitability(String(scan.suitability))
                        : t("ocrReview.safetyPanel.noSuitabilityFallback"),
                      count: formatNumber(historicalFindings.length),
                    })}
                  </summary>
                  {historicalFindings.length ? (
                    <ul className="mt-2 grid gap-2">
                      {historicalFindings.map((finding, findingIndex) => (
                        <li
                          className="border-s-2 border-border ps-2.5 text-xs"
                          key={`${String(finding.finding_id ?? findingIndex)}-${findingIndex}`}
                        >
                          <p className="font-bold">
                            {formatFindingCategoryLabel(finding.category)} ·{" "}
                            {formatFindingSeverityLabel(finding.severity)}
                          </p>
                          <p
                            className="viread-learning-content"
                            dir="ltr"
                            lang="vi"
                          >
                            “{String(finding.evidence_text ?? "")}”
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1.5 text-xs text-muted">
                      {t("ocrReview.safetyPanel.noHistoricalFindings")}
                    </p>
                  )}
                </details>
              );
            })}
          </div>
        </section>
      ) : null}

      <details className="mt-4 rounded-lg border border-border bg-surface-subtle/40 p-2.5">
        <summary className="cursor-pointer text-xs font-bold text-ink">
          {t("ocrReview.safetyPanel.provenanceHeading")}
        </summary>
        <p className="mt-1.5 text-xs text-muted">
          {t("ocrReview.safetyPanel.attemptSuffix", {
            attempts: formatNumber(aiWorkflow.attempts),
          }).replace(/^ · /, "")}
          {" · "}
          {formatDateTime(aiWorkflow.updated_at)}
        </p>
        {aiWorkflow.provider_events.length ? (
          <ul className="mt-2 grid gap-1.5 text-[11px]">
            {aiWorkflow.provider_events.map((event, index) => (
              <li
                className="rounded-md bg-white p-2 ring-1 ring-border/70"
                key={`ai-event-${index}`}
              >
                <span className="font-bold">
                  {event.stage === "CHILD_SAFETY_SCANNING"
                    ? "Kiểm tra an toàn"
                    : "Kiểm tra chính tả"}
                </span>
                {" · "}
                {event.availability === true
                  ? t("ocrReview.safetyPanel.providerAvailable")
                  : event.availability === false
                    ? t("ocrReview.safetyPanel.providerUnavailable")
                    : t("ocrReview.safetyPanel.providerChecking")}
                {Number(event.retry_count ?? 0) > 0
                  ? t("ocrReview.safetyPanel.fallbackRetryPart", {
                      count: String(event.retry_count),
                    })
                  : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs text-muted">
            {t("ocrReview.safetyPanel.noProviderEvents")}
          </p>
        )}
      </details>

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        {t("ocrReview.safetyPanel.safetyDisclaimer")}
      </p>
    </section>
  ) : null;

  return (
    <div className="space-y-4">
      <AdminPageHeader
        actions={
          <ButtonLink
            href={`/admin/books/${encodeURIComponent(bookId)}`}
            size="admin"
            variant="outline"
          >
            <ArrowLeft
              aria-hidden="true"
              className="size-3.5 shrink-0 rtl:rotate-180"
            />
            {t("ocrReview.header.backToDetail")}
          </ButtonLink>
        }
        badge={<OcrRevisionStatus status={detail.verification_status} />}
        breadcrumbs={[
          { label: t("books.detail.backToBooks"), href: "/admin/books" },
          {
            label: resolvedBookTitle,
            href: `/admin/books/${encodeURIComponent(bookId)}`,
          },
          {
            label: t("books.detail.pageNumber", {
              pageNumber: formatNumber(image.page_number),
            }),
          },
        ]}
        description={t("ocrReview.header.description")}
        eyebrow={t("ocrReview.header.eyebrow", {
          title: book.title,
          pageNumber: formatNumber(image.page_number),
        })}
        title={t("ocrReview.header.title", {
          revisionNo: formatNumber(detail.revision_no),
        })}
      />

      {!queuedOcrJob || ocrWorkerStatus.justRecovered ? (
        <OcrServiceStatusBanner
          body={
            ocrWorkerStatus.status === "unreachable"
              ? t(
                  "books.uploader.workerUnreachableBody",
                  undefined,
                  "Hệ thống đang khởi động hoặc mạng chậm. Bạn vẫn có thể bấm Kiểm tra lại hoặc tải lên để xếp hàng xử lý.",
                )
              : t(
                  "books.uploader.workerOfflineBody",
                  undefined,
                  "Bạn vẫn có thể tải ảnh hoặc PDF/DOCX ngay bây giờ: hệ thống sẽ xếp hàng an toàn và tự động chạy OCR khi dịch vụ xử lý OCR hoạt động.",
                )
          }
          className="mb-4"
          isChecking={ocrWorkerStatus.isChecking}
          justRecovered={ocrWorkerStatus.justRecovered}
          onDismissRecovered={ocrWorkerStatus.dismissRecoveredNotice}
          onRecheck={() => void ocrWorkerStatus.recheckNow()}
          queuedCount={ocrWorkerStatus.queueDepth}
          recheckLabel={t(
            "books.uploader.recheckWorkerBtn",
            undefined,
            "Kiểm tra lại kết nối OCR",
          )}
          recoveredMessage={t(
            "ocrReview.notices.ocrRecoveredNotice",
            undefined,
            "Dịch vụ xử lý OCR đã hoạt động trở lại.",
          )}
          status={ocrWorkerStatus.status}
          title={
            ocrWorkerStatus.status === "unreachable"
              ? t(
                  "books.uploader.workerUnreachableTitle",
                  undefined,
                  "Chưa kiểm tra được trạng thái dịch vụ OCR",
                )
              : t(
                  "books.uploader.workerOfflineTitle",
                  undefined,
                  "Dịch vụ xử lý OCR hiện đang ngoại tuyến",
                )
          }
          variant="admin"
        />
      ) : null}

      {detail.verification_status === "VERIFIED" ? (
        <StatusMessage
          title={t("ocrReview.header.verifiedBannerTitle")}
          tone="success"
        >
          {t("ocrReview.header.verifiedBannerDesc", { status: "ACTIVE" })}
        </StatusMessage>
      ) : detail.verification_status === "PROCESSING" ? (
        <StatusMessage
          title={t("ocrReview.header.processingBannerTitle")}
          tone="info"
        >
          {t("ocrReview.header.processingBannerDesc")}
        </StatusMessage>
      ) : null}
      {queuedOcrJob ? (
        <div
          className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50/85 p-4 text-amber-950"
          data-testid="admin-review-ocr-queued-banner"
          role="status"
        >
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <Clock3
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-amber-700"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-extrabold">
                {queuedOcrJob.worker_online === false
                  ? t("books.detail.ocrQueueOfflineBanner", {
                      count: formatNumber(1),
                    })
                  : t("books.detail.ocrQueueOnlineBanner", {
                      count: formatNumber(1),
                    })}
              </p>
              <p className="mt-1 text-xs text-amber-900">
                {queuedOcrJob.worker_online === false
                  ? t("books.detail.ocrQueueOfflineHint")
                  : t("books.detail.ocrQueueOnlineHint")}
              </p>
              <AiProgressBar
                active={!isQueuedJobOffline}
                className="mt-2.5"
                elapsedSeconds={
                  isQueuedJobOffline
                    ? undefined
                    : queuedOcrBarProgress.elapsedSeconds
                }
                label={
                  isQueuedJobOffline
                    ? tCommon("aiProgress.waitingWorker")
                    : tCommon("aiProgress.ocrExtracting")
                }
                percent={queuedOcrBarProgress.percent}
                size="sm"
                testId="admin-review-ocr-queued-progress"
                tone={isQueuedJobOffline ? "warning" : "primary"}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="admin-review-check-ocr-now"
              disabled={busyQueuedJobAction !== null}
              isLoading={busyQueuedJobAction === "check"}
              onClick={() => void checkQueuedOcrJobNow()}
              size="admin"
              type="button"
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />
              {t(
                "ocrReview.queuedBanner.checkNowBtn",
                undefined,
                "Kiểm tra lại ngay",
              )}
            </Button>
            <Button
              data-testid="admin-review-cancel-ocr-job"
              disabled={busyQueuedJobAction !== null}
              isLoading={busyQueuedJobAction === "cancel"}
              onClick={() => void cancelQueuedOcrJob()}
              size="admin"
              type="button"
              variant="outline"
            >
              <X aria-hidden="true" className="size-3.5 shrink-0" />
              {t(
                "ocrReview.queuedBanner.cancelBtn",
                undefined,
                "Hủy yêu cầu chờ",
              )}
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <StatusMessage tone={noticeTone}>{notice}</StatusMessage>
      ) : null}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(440px,0.95fr)]">
        {/* Left Sticky Pane: ONLY Image + BBox Canvas + Compact Zoom & Color-Legend Bar */}
        <section className="rounded-xl border border-border bg-white p-4 shadow-2xs xl:sticky xl:top-6 xl:max-h-[calc(100dvh-7rem)] xl:overflow-auto">
          <OcrImageViewer
            book={book}
            draftTokens={draftTokens}
            image={image}
            ocrMetadata={detail.ocr_metadata}
            onSelectWord={selectWordOnImage}
            selectedWord={selectedWord}
            verificationStatus={detail.verification_status}
            words={words}
          />

          <div
            aria-label={t("ocrReview.legend.countsAria")}
            className="mt-3 grid grid-cols-3 gap-2"
            role="group"
          >
            {(
              [
                {
                  id: "green",
                  label: t("ocrReview.legend.green"),
                  count: colorCounts.green,
                  cardClass:
                    "border-emerald-200 bg-success-surface/70 text-success-ink",
                },
                {
                  id: "yellow",
                  label: t("ocrReview.legend.yellow"),
                  count: colorCounts.yellow,
                  cardClass:
                    "border-amber-200 bg-warning-surface/70 text-warning",
                },
                {
                  id: "red",
                  label: t("ocrReview.legend.red"),
                  count: colorCounts.red,
                  cardClass:
                    "border-danger/25 bg-danger-surface/70 text-danger",
                },
              ] as const
            ).map((state) => (
              <div
                className={`flex flex-col items-center justify-center rounded-lg border px-2 py-2 text-center text-[11px] font-bold leading-tight ${state.cardClass}`}
                key={state.id}
              >
                <strong className="text-base leading-none tabular-nums">
                  {formatNumber(state.count)}
                </strong>
                <span className="mt-1">{state.label}</span>
              </div>
            ))}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
            <button
              className="inline-flex min-h-9 items-center rounded-control border border-border bg-white px-2.5 text-xs font-bold text-ink transition-colors hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!nextWordToReview}
              onClick={() => {
                if (nextWordToReview) {
                  selectWordOnImage(nextWordToReview.word_index);
                }
              }}
              type="button"
            >
              {t("ocrReview.legend.goToReviewBtn")}
            </button>
            <span className="text-xs font-semibold text-muted tabular-nums">
              {nextWordToReview
                ? t("ocrReview.legend.nextReviewPosition", {
                    current: formatNumber(nextReviewPosition),
                    total: formatNumber(wordsNeedingReview.length),
                  })
                : t("ocrReview.legend.noWordsToReview")}
            </span>
          </div>

          <details className="mt-2.5 border-t border-border pt-2 text-xs text-muted">
            <summary className="cursor-pointer font-semibold text-primary hover:underline">
              {t("ocrReview.legend.detailsAria")}
            </summary>
            <p className="mt-1.5 leading-relaxed">
              {t("ocrReview.legend.description")}
            </p>
            <div
              aria-label={t("ocrReview.legend.detailsAria")}
              className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]"
            >
              <span>
                {t("ocrReview.legend.verifiedCount")}{" "}
                {formatNumber(
                  words.filter((word) => {
                    const status = getWordReviewStatus(
                      word,
                      detail.verification_status,
                    );
                    return (
                      status === "verified" || status === "reference_match"
                    );
                  }).length,
                )}
              </span>
              <span>
                {t("ocrReview.legend.consensusCount")}{" "}
                {formatNumber(
                  words.filter(
                    (word) =>
                      getWordReviewStatus(word, detail.verification_status) ===
                      "engine_agreement",
                  ).length,
                )}
              </span>
              <span>
                {t("ocrReview.legend.disagreementCount")}{" "}
                {formatNumber(
                  words.filter(
                    (word) =>
                      getWordReviewStatus(word, detail.verification_status) ===
                      "engine_disagreement",
                  ).length,
                )}
              </span>
              <span>
                {t("ocrReview.legend.uncalibratedCount")}{" "}
                {formatNumber(
                  words.filter(
                    (word) =>
                      word.ocr_evidence?.calibrated_word_accuracy == null,
                  ).length,
                )}
              </span>
            </div>
          </details>
        </section>

        {/* Right Pane: Segmented Tabs + Sticky Bottom Action Bar */}
        <div className="flex min-w-0 flex-col gap-4">
          <div
            aria-label={t(
              "ocrReview.workbenchTabs.ariaLabel",
              undefined,
              "Khu vực làm việc duyệt OCR",
            )}
            className="flex flex-wrap gap-1 rounded-xl border border-border bg-surface-subtle p-1"
            role="tablist"
          >
            {workbenchTabs.map((tab) => {
              const isSelected = activeTab === tab.id;
              const TabIcon =
                tab.id === "draft"
                  ? FileText
                  : tab.id === "words"
                    ? SlidersHorizontal
                    : tab.id === "safety"
                      ? ShieldCheck
                      : tab.id === "blocks"
                        ? Layers
                        : History;
              return (
                <button
                  aria-controls={`ocr-workbench-panel-${tab.id}`}
                  aria-selected={isSelected}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    isSelected
                      ? "bg-white text-primary shadow-2xs ring-1 ring-border"
                      : "text-muted hover:text-ink",
                  )}
                  id={`ocr-workbench-tab-${tab.id}`}
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  role="tab"
                  type="button"
                >
                  <TabIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span>{tab.label}</span>
                  {tab.badge !== undefined && tab.badge !== null ? (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[11px] font-extrabold tabular-nums",
                        tab.badgeTone === "danger"
                          ? "bg-danger-surface text-danger"
                          : tab.badgeTone === "warning"
                            ? "bg-warning-surface text-warning"
                            : tab.badgeTone === "success"
                              ? "bg-success-surface text-success-ink"
                              : isSelected
                                ? "bg-sky text-primary-hover"
                                : "bg-white text-muted",
                      )}
                    >
                      {formatNumber(tab.badge)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* Tab 1: Văn bản & Duyệt */}
          <div
            aria-labelledby="ocr-workbench-tab-draft"
            className={activeTab === "draft" ? "space-y-4" : "hidden"}
            id="ocr-workbench-panel-draft"
            role="tabpanel"
          >
            <section className="rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5">
              <div className="mb-3">
                <h2 className="text-base font-extrabold text-ink">
                  {t("ocrReview.draft.heading")}
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  {t("ocrReview.draft.subtitle")}
                </p>
              </div>
              <label
                className="grid gap-1.5 text-xs font-bold text-ink"
                htmlFor="ocr-text"
              >
                {t("ocrReview.draft.label")}
                <textarea
                  aria-describedby="ocr-help"
                  className="viread-learning-content min-h-56 max-h-[30rem] resize-y rounded-control border border-border bg-white p-3.5 text-base font-normal leading-7 outline-none focus:border-primary focus:outline-3 focus:outline-primary/30 disabled:bg-surface-subtle"
                  dir="ltr"
                  disabled={
                    verified ||
                    detail.lifecycle_status !== "ACTIVE" ||
                    busy !== null
                  }
                  id="ocr-text"
                  lang="vi"
                  onChange={(event) =>
                    handleDraftTextChange(event.target.value)
                  }
                  value={draftText}
                />
              </label>
              <p
                className="mt-2 text-xs leading-relaxed text-muted"
                id="ocr-help"
              >
                {t("ocrReview.draft.aiHint")}
              </p>

              {busy === "ai_correct" ? (
                <div
                  aria-live="polite"
                  className="mt-3 grid gap-2.5 rounded-lg border border-purple-300 bg-purple-50 p-3.5 text-xs text-purple-950"
                  role="status"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-bold">
                      {aiProgress?.status === "QUEUED"
                        ? t("ocrReview.draft.statusQueued")
                        : aiProgress?.status === "PROOFREADING"
                          ? t("ocrReview.draft.statusProofreadingChunk", {
                              completed: formatNumber(
                                aiProgress.progress.completed_chunks,
                              ),
                              total: formatNumber(
                                aiProgress.progress.total_chunks,
                              ),
                            })
                          : aiProgress?.status === "CHILD_SAFETY_SCANNING"
                            ? t("ocrReview.draft.statusSafetyRunning")
                            : aiProgress?.status === "FAILED"
                              ? t("ocrReview.draft.statusFailed")
                              : aiProgress?.status === "READY_FOR_ADMIN_REVIEW"
                                ? t("ocrReview.draft.statusCompleted")
                                : t("ocrReview.draft.statusPreparing")}
                    </span>
                    <Button
                      onClick={cancelAiCorrection}
                      size="admin"
                      type="button"
                      variant="destructive-outline"
                    >
                      <X aria-hidden="true" className="size-3.5 shrink-0" />
                      {t("ocrReview.draft.stopTrackingBtn")}
                    </Button>
                  </div>
                  <AiProgressBar
                    active={
                      aiProgress?.status !== "READY_FOR_ADMIN_REVIEW" &&
                      aiProgress?.status !== "FAILED"
                    }
                    detail={
                      aiProgress && aiProgress.progress.total_chunks > 0
                        ? `${formatNumber(aiProgress.progress.completed_chunks)}/${formatNumber(aiProgress.progress.total_chunks)}`
                        : undefined
                    }
                    elapsedSeconds={aiCorrectBarProgress.elapsedSeconds}
                    label={t("ocrReview.draft.progressAria")}
                    percent={aiCorrectBarProgress.percent}
                    size="sm"
                    testId="ocr-review-ai-workflow-progress"
                    tone={
                      aiProgress?.status === "FAILED"
                        ? "danger"
                        : aiProgress?.status === "READY_FOR_ADMIN_REVIEW"
                          ? "success"
                          : "primary"
                    }
                  />
                  <span className="text-[11px] text-purple-900">
                    {t("ocrReview.draft.suggestionOnlyNote")}
                  </span>
                </div>
              ) : null}

              {wordSyncError ? (
                <p
                  aria-live="polite"
                  className="mt-3 rounded-lg border border-danger/35 bg-danger-surface p-3 text-xs font-semibold text-danger"
                  role="alert"
                >
                  {wordSyncError}
                </p>
              ) : null}

              {aiSuggestion !== null ? (
                <section
                  aria-labelledby="ai-correction-review-title"
                  className="mt-4 grid gap-3 rounded-lg border border-purple-300 bg-purple-50 p-3.5"
                  role="region"
                >
                  <div>
                    <h3
                      className="text-sm font-extrabold text-purple-950"
                      id="ai-correction-review-title"
                    >
                      {t("ocrReview.draft.diffHeading")}
                    </h3>
                    <p className="mt-1 text-xs text-purple-900">
                      {t("ocrReview.draft.diffSubtitle", {
                        count: formatNumber(aiChanges.length),
                      })}
                    </p>
                    <p
                      aria-live="polite"
                      className="mt-1 text-xs font-bold text-purple-950"
                    >
                      {t("ocrReview.draft.diffSelectionCount", {
                        selected: formatNumber(aiAcceptedChanges.size),
                        total: formatNumber(aiChanges.length),
                      })}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() =>
                        setAiAcceptedChanges(
                          new Set(aiChanges.map((change) => change.index)),
                        )
                      }
                      size="admin"
                      type="button"
                      variant="secondary"
                    >
                      {t("ocrReview.draft.selectAll")}
                    </Button>
                    <Button
                      onClick={() => setAiAcceptedChanges(new Set())}
                      size="admin"
                      type="button"
                      variant="outline"
                    >
                      {t("ocrReview.draft.deselectAll")}
                    </Button>
                    <Button
                      onClick={() => {
                        setAiSuggestion(null);
                        setAiAcceptedChanges(new Set());
                        setAiDiffPage(0);
                        setNotice(t("ocrReview.notices.aiRejectedAll"));
                      }}
                      size="admin"
                      type="button"
                      variant="outline"
                    >
                      {t("ocrReview.draft.rejectSuggestions")}
                    </Button>
                  </div>
                  <div
                    aria-live="polite"
                    className="text-xs font-semibold text-muted"
                  >
                    {t("common:pagination.pageStatus", {
                      page: formatNumber(
                        Math.min(aiDiffPage + 1, aiDiffPageCount),
                      ),
                      totalPages: formatNumber(aiDiffPageCount),
                    })}
                    {aiChanges.length > aiDiffPageSize
                      ? t("ocrReview.draft.diffPageSizeSuffix", {
                          size: formatNumber(aiDiffPageSize),
                        })
                      : ""}
                  </div>
                  <ul className="grid gap-2">
                    {visibleAiChanges.map((change) => {
                      const originalWord = words[change.index];
                      const originalStatus = originalWord
                        ? getWordReviewStatus(
                            originalWord,
                            detail.verification_status,
                          )
                        : "needs_review";
                      const originalPaddleLineScore = originalWord
                        ? getPaddleLineScoreForWord(
                            detail.ocr_metadata,
                            originalWord,
                          )
                        : null;
                      const originalScoreLabel = originalWord
                        ? getWordScoreLabel(
                            originalWord,
                            detail.ocr_metadata,
                            t,
                          )
                        : t("ocrReview.scoreLabels.missingWordScore");
                      return (
                        <li
                          className="rounded-lg border border-purple-200 bg-white p-3"
                          key={change.index}
                        >
                          <label className="flex cursor-pointer items-start gap-2.5">
                            <input
                              aria-label={t(
                                "ocrReview.draft.reviewChangeAria",
                                {
                                  num: formatNumber(change.index + 1),
                                },
                              )}
                              checked={aiAcceptedChanges.has(change.index)}
                              className="mt-1 size-4 accent-purple-700"
                              onChange={(event) => {
                                setAiAcceptedChanges((current) => {
                                  const next = new Set(current);
                                  if (event.target.checked)
                                    next.add(change.index);
                                  else next.delete(change.index);
                                  return next;
                                });
                              }}
                              type="checkbox"
                            />
                            <span className="min-w-0 text-sm">
                              <span className="block text-xs text-muted">
                                {t("ocrReview.draft.wordNumber", {
                                  num: formatNumber(change.index + 1),
                                })}
                              </span>
                              <span
                                className="viread-learning-content flex flex-wrap items-center gap-2 break-words"
                                dir="ltr"
                                lang="vi"
                              >
                                <del
                                  className={`rounded border px-1.5 py-0.5 ${getWordReviewBadgeColor(originalStatus, originalWord, originalPaddleLineScore)}`}
                                >
                                  {change.original}
                                </del>
                                <span aria-hidden="true" className="text-muted">
                                  →
                                </span>
                                <strong className="rounded border border-amber-400 bg-amber-100 px-1.5 py-0.5 text-amber-950">
                                  {change.proposed}
                                </strong>
                              </span>
                              <span className="mt-1.5 grid gap-0.5 text-xs">
                                <span>
                                  {t("ocrReview.draft.ocrWordPrefix")}{" "}
                                  {getWordReviewLabel(
                                    originalStatus,
                                    originalWord,
                                    originalPaddleLineScore,
                                    t,
                                  )}{" "}
                                  · {originalScoreLabel}
                                </span>
                                <span className="text-amber-900">
                                  {t("ocrReview.draft.whyAiSuggested")}
                                </span>
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  {aiDiffPageCount > 1 ? (
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        disabled={aiDiffPage === 0}
                        onClick={() =>
                          setAiDiffPage((page) => Math.max(0, page - 1))
                        }
                        size="admin"
                        type="button"
                        variant="outline"
                      >
                        <ChevronLeft
                          aria-hidden="true"
                          className="size-3.5 rtl:rotate-180"
                        />
                        {t("ocrReview.draft.prevDiffPage")}
                      </Button>
                      <Button
                        disabled={aiDiffPage + 1 >= aiDiffPageCount}
                        onClick={() =>
                          setAiDiffPage((page) =>
                            Math.min(aiDiffPageCount - 1, page + 1),
                          )
                        }
                        size="admin"
                        type="button"
                        variant="outline"
                      >
                        {t("ocrReview.draft.nextDiffPage")}
                        <ChevronRight
                          aria-hidden="true"
                          className="size-3.5 rtl:rotate-180"
                        />
                      </Button>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-purple-200 pt-2.5">
                    <Button
                      onClick={applySelectedAiChanges}
                      size="admin"
                      type="button"
                      variant="primary"
                    >
                      <CheckCircle2
                        aria-hidden="true"
                        className="size-3.5 shrink-0"
                      />
                      {t("ocrReview.draft.confirmAiSelectionBtn")}
                    </Button>
                  </div>
                </section>
              ) : null}

              <div className="mt-3 border-t border-border pt-2.5">
                <button
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                  onClick={() => setActiveTab("history")}
                  type="button"
                >
                  <History aria-hidden="true" className="size-3.5 shrink-0" />
                  {t("ocrReview.tabs.ariaLabel")}
                </button>
              </div>
            </section>

            {activeTab === "draft" ? aiWorkflowCard : null}
          </div>

          {/* Tab 2: Từ & BBox */}
          <div
            aria-labelledby="ocr-workbench-tab-words"
            className={activeTab === "words" ? "space-y-4" : "hidden"}
            id="ocr-workbench-panel-words"
            role="tabpanel"
          >
            <section className="rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
                <div>
                  <h2 className="text-base font-extrabold text-ink">
                    {t("ocrReview.wordsPanel.heading")}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted">
                    {t("ocrReview.wordsPanel.prioritySummary", {
                      attention: formatNumber(
                        colorCounts.red + colorCounts.yellow,
                      ),
                      good: formatNumber(colorCounts.green),
                    })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={verified || busy !== null || words.length === 0}
                    onClick={reconcileAllMatchedWords}
                    size="admin"
                    type="button"
                    variant="outline"
                  >
                    <CheckCircle2
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                    />
                    {t("ocrReview.wordsPanel.alignedBadge")}
                  </Button>
                  <Button
                    disabled={verified || busy !== null}
                    onClick={syncTextFromWords}
                    size="admin"
                    variant="outline"
                  >
                    {t("ocrReview.wordsPanel.syncFromWordsBtn")}
                  </Button>
                </div>
              </div>
              <p className="mb-3 text-xs text-muted">
                {t("ocrReview.wordsPanel.hint")}
              </p>
              <div
                aria-live="polite"
                className="mb-3 rounded-lg border border-border bg-surface-subtle/60 px-3 py-2 text-xs text-muted"
                role="status"
              >
                <span className="font-bold text-ink">
                  {t("ocrReview.wordsPanel.alignmentLabel")}{" "}
                </span>
                {textAlignment.canCompare ? (
                  <>
                    {t("ocrReview.wordsPanel.alignmentCount", {
                      matched: formatNumber(textAlignment.matched),
                      total: formatNumber(words.length),
                      different: formatNumber(textAlignment.different),
                    })}
                  </>
                ) : (
                  t("ocrReview.wordsPanel.alignmentMismatch")
                )}
              </div>
              <div
                aria-label={t("ocrReview.wordsPanel.filterAria")}
                className="mb-3 flex flex-wrap gap-1.5"
                role="group"
              >
                {(
                  [
                    {
                      id: "all",
                      label: t("ocrReview.wordsPanel.filters.all"),
                      count: words.length,
                    },
                    {
                      id: "review",
                      label: t("ocrReview.wordsPanel.filters.attention"),
                      count: colorCounts.red + colorCounts.yellow,
                    },
                    {
                      id: "risk",
                      label: t("ocrReview.wordsPanel.filters.risk"),
                      count: colorCounts.yellow,
                    },
                    {
                      id: "disagreement",
                      label: t("ocrReview.wordsPanel.filters.disagreement"),
                      count: words.filter((word) => {
                        return hasEngineDisagreementEvidence(word);
                      }).length,
                    },
                    {
                      id: "red",
                      label: t("ocrReview.wordsPanel.filters.red"),
                      count: colorCounts.red,
                    },
                    {
                      id: "green",
                      label: t("ocrReview.wordsPanel.filters.green"),
                      count: colorCounts.green,
                    },
                  ] as const satisfies readonly {
                    id: WordFilter;
                    label: string;
                    count: number;
                  }[]
                ).map((filter) => (
                  <button
                    aria-pressed={wordFilter === filter.id}
                    className={`min-h-10 rounded-full border px-3 text-sm font-semibold ${
                      wordFilter === filter.id
                        ? filter.id === "risk" || filter.id === "disagreement"
                          ? "border-amber-700 bg-amber-100 text-amber-950 ring-2 ring-amber-700/15"
                          : filter.id === "green"
                            ? "border-green-700 bg-green-100 text-green-950 ring-2 ring-green-700/15"
                            : filter.id === "red"
                              ? "border-red-700 bg-red-100 text-red-950 ring-2 ring-red-700/15"
                              : "border-primary bg-sky text-primary-hover"
                        : "border-border bg-white text-muted hover:bg-canvas"
                    }`}
                    key={filter.id}
                    onClick={() => setWordFilter(filter.id)}
                    type="button"
                  >
                    {filter.label} ({formatNumber(filter.count)})
                  </button>
                ))}
                <span
                  aria-live="polite"
                  className="self-center text-xs font-semibold text-muted"
                >
                  {wordFilter === "review"
                    ? t("ocrReview.wordsPanel.attentionRemaining", {
                        count: formatNumber(filteredWords.length),
                      })
                    : t("ocrReview.wordsPanel.showingRatio", {
                        shown: formatNumber(filteredWords.length),
                        total: formatNumber(words.length),
                      })}
                </span>
              </div>
              <div className="grid gap-3">
                {filteredWords.length === 0 ? (
                  <p className="rounded-control border border-border bg-canvas p-4 text-sm text-muted">
                    {wordFilter === "review"
                      ? t("ocrReview.wordsPanel.emptyAttention")
                      : t("ocrReview.wordsPanel.emptyGroup", {
                          group:
                            wordFilter === "risk"
                              ? t("ocrReview.wordsPanel.groupNames.risk")
                              : wordFilter === "red"
                                ? t("ocrReview.wordsPanel.groupNames.red")
                                : wordFilter === "green"
                                  ? t("ocrReview.wordsPanel.groupNames.green")
                                  : wordFilter === "disagreement"
                                    ? t(
                                        "ocrReview.wordsPanel.groupNames.disagreement",
                                      )
                                    : t(
                                        "ocrReview.wordsPanel.groupNames.default",
                                      ),
                        })}
                  </p>
                ) : (
                  filteredWords.map((word) => {
                    const reviewStatus = getWordReviewStatus(
                      word,
                      detail.verification_status,
                    );
                    const paddleLineScore = getPaddleLineScoreForWord(
                      detail.ocr_metadata,
                      word,
                    );
                    const colorGroup = getWordReviewColorGroup(
                      reviewStatus,
                      word,
                      paddleLineScore,
                    );
                    const reviewLabel = getWordReviewLabel(
                      reviewStatus,
                      word,
                      paddleLineScore,
                      t,
                    );
                    const draftToken = draftTokens[word.word_index];
                    const canCompareToken =
                      textAlignment.canCompare && draftToken !== undefined;
                    const tokenMatches =
                      canCompareToken &&
                      normalizeVietnameseWord(draftToken) ===
                        normalizeVietnameseWord(word.text);

                    return (
                      <div
                        ref={(el) => {
                          if (el) wordRefs.current.set(word.word_index, el);
                          else wordRefs.current.delete(word.word_index);
                        }}
                        id={`ocr-word-${word.word_index}`}
                        className={`rounded-control border border-border border-s-4 p-3 transition-shadow ${
                          colorGroup === "green"
                            ? "border-s-green-600"
                            : colorGroup === "red"
                              ? "border-s-red-600"
                              : colorGroup === "yellow"
                                ? "border-s-amber-500"
                                : "border-s-slate-400"
                        } ${
                          word.word_index === selectedWord
                            ? "border-y-primary border-e-primary bg-sky/30 shadow-md ring-2 ring-primary/20"
                            : "bg-white hover:shadow-sm"
                        }`}
                        key={word.word_index}
                      >
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <button
                            aria-pressed={word.word_index === selectedWord}
                            className="rounded-sm text-start text-sm font-semibold text-primary underline underline-offset-2"
                            onClick={() => selectWordOnImage(word.word_index)}
                            type="button"
                          >
                            {t("ocrReview.wordsPanel.wordIndexLine", {
                              index: formatNumber(word.word_index),
                              line: formatNumber(word.line_index),
                            })}
                          </button>
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <span
                              className={`rounded border px-2 py-0.5 text-xs font-semibold ${getWordReviewBadgeColor(reviewStatus, word, paddleLineScore)}`}
                            >
                              {reviewLabel}
                            </span>
                          </div>
                        </div>

                        {colorGroup === "red" ? (
                          <div className="mb-3 grid gap-1 rounded-control border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-950">
                            {reviewStatus === "confirmed_mismatch" ? (
                              <>
                                <span className="font-semibold">
                                  {t(
                                    "ocrReview.wordsPanel.referenceMismatchHeading",
                                  )}
                                </span>
                                <span className="break-words">
                                  {t("ocrReview.wordsPanel.ocrReadPrefix", {
                                    text: word.text,
                                  })}
                                  {word.ocr_evidence?.reference_text
                                    ? t(
                                        "ocrReview.wordsPanel.verifiedReferenceSuffix",
                                        {
                                          text: word.ocr_evidence
                                            .reference_text,
                                        },
                                      )
                                    : ""}
                                </span>
                              </>
                            ) : (
                              <>
                                <span className="font-semibold">
                                  {t(
                                    "ocrReview.wordsPanel.mismatchConfirmedTitle",
                                  )}
                                </span>
                                <span className="break-words">
                                  {t("ocrReview.wordsPanel.ocrTokenLine", {
                                    text: word.text,
                                  })}
                                  {getWordScoreLabel(
                                    word,
                                    detail.ocr_metadata,
                                    t,
                                  )}
                                </span>
                                <span className="text-xs">
                                  {t("ocrReview.wordsPanel.redWarningNote")}
                                </span>
                              </>
                            )}
                            {word.ocr_evidence?.review_reason ? (
                              <span className="text-xs">
                                {word.ocr_evidence.review_reason}
                              </span>
                            ) : null}
                          </div>
                        ) : null}

                        <div className="mb-3 grid gap-1 rounded-control border border-border bg-canvas px-3 py-2 text-sm">
                          <span className="text-xs font-semibold text-muted">
                            {t("ocrReview.wordsPanel.textVsBoxHeading")}
                          </span>
                          <span className="break-words font-semibold">
                            {canCompareToken ? (
                              <span
                                className="viread-learning-content"
                                dir="ltr"
                                lang="vi"
                              >
                                {t("ocrReview.wordsPanel.tokenCompare", {
                                  draftToken,
                                  wordText: word.text,
                                })}
                              </span>
                            ) : (
                              t("ocrReview.wordsPanel.cannotAlignByPosition")
                            )}
                            {canCompareToken ? (
                              <span className="ms-2 whitespace-nowrap text-xs font-semibold text-muted">
                                {tokenMatches
                                  ? t("ocrReview.wordsPanel.matchedLabel")
                                  : t("ocrReview.wordsPanel.needsCompareLabel")}
                              </span>
                            ) : null}
                          </span>
                        </div>

                        <label className="grid gap-1 text-sm font-semibold">
                          {t("ocrReview.wordsPanel.editWordInputAria", {
                            num: formatNumber(word.word_index + 1),
                          })}
                          <input
                            className="viread-learning-content min-h-10 rounded-control border border-border px-3 font-normal disabled:bg-canvas"
                            dir="ltr"
                            disabled={verified || busy !== null}
                            lang="vi"
                            onChange={(event) =>
                              updateWord(word.word_index, {
                                text: event.target.value,
                                normalized_text: normalizeVietnameseWord(
                                  event.target.value,
                                ),
                              })
                            }
                            value={word.text}
                          />
                        </label>
                        <details className="mt-2 rounded-control border border-border bg-white">
                          <summary className="cursor-pointer rounded-control px-3 py-2 text-sm font-semibold text-primary hover:bg-canvas focus-visible:outline-3 focus-visible:outline-primary">
                            {t("ocrReview.wordsPanel.advancedBboxSummary")}
                          </summary>
                          <div className="grid grid-cols-4 gap-2 border-t border-border p-3">
                            {(["x", "y", "w", "h"] as const).map(
                              (label, coordinate) => (
                                <label
                                  className="grid gap-1 text-xs font-semibold"
                                  key={label}
                                >
                                  {label}
                                  <input
                                    aria-label={t(
                                      "ocrReview.wordsPanel.bboxInputAria",
                                      {
                                        index: formatNumber(word.word_index),
                                        axis: label,
                                      },
                                    )}
                                    className="min-h-10 min-w-0 rounded-control border border-border px-2 font-normal disabled:bg-canvas"
                                    disabled={verified || busy !== null}
                                    max={1}
                                    min={0}
                                    onChange={(event) =>
                                      updateBbox(
                                        word.word_index,
                                        coordinate,
                                        Number(event.target.value),
                                      )
                                    }
                                    step="0.001"
                                    type="number"
                                    value={word.bbox[coordinate]}
                                  />
                                </label>
                              ),
                            )}
                          </div>
                        </details>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>

          {/* Tab 3: AI Safety */}
          <div
            aria-labelledby="ocr-workbench-tab-safety"
            className={activeTab === "safety" ? "space-y-4" : "hidden"}
            id="ocr-workbench-panel-safety"
            role="tabpanel"
          >
            {activeTab === "safety"
              ? (aiWorkflowCard ?? (
                  <section className="rounded-xl border border-border bg-white p-5 text-center shadow-2xs">
                    <ShieldCheck
                      aria-hidden="true"
                      className="mx-auto mb-2 size-7 text-muted"
                    />
                    <h2 className="text-sm font-extrabold text-ink">
                      {t(
                        "ocrReview.safetyPanel.emptyTitle",
                        undefined,
                        "Chưa có kết quả kiểm tra an toàn cho bản này",
                      )}
                    </h2>
                    <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">
                      {t(
                        "ocrReview.safetyPanel.emptyDesc",
                        undefined,
                        "Chạy XÁC NHẬN & CHẠY AI ở thanh thao tác bên dưới để tự động rà soát chính tả và quét an toàn trẻ em.",
                      )}
                    </p>
                  </section>
                ))
              : null}
          </div>

          {/* Tab 4: Khối thông minh V2 */}
          <div
            aria-labelledby="ocr-workbench-tab-blocks"
            className={activeTab === "blocks" ? "space-y-4" : "hidden"}
            id="ocr-workbench-panel-blocks"
            role="tabpanel"
          >
            <section className="rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5">
              <SmartOcrBlockReviewLoader
                isRevisionVerified={detail.verification_status === "VERIFIED"}
                onApplyToDraft={async (result) => {
                  handleDraftTextChange(result.canonical_text);
                  await load();
                }}
                pageId={pageId}
                pageImageUrl={image.preview_url}
                pageNumber={image.page_number}
                pageRevisionId={detail.page_revision_id}
              />
            </section>
            <details
              className="rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5"
              onToggle={(event) =>
                setIllustrationStudioOpen(event.currentTarget.open)
              }
            >
              <summary className="min-h-11 cursor-pointer py-2 font-bold text-ink">
                Studio tranh minh họa sạch chữ (V2)
              </summary>
              <div className="mt-4">
                <PageIllustrationStudio
                  actorRole="admin"
                  autoLoad={illustrationStudioOpen}
                  bookId={bookId}
                  canonicalText={draftText}
                  compact
                  pageId={pageId}
                  pageNumber={image.page_number}
                  wordBboxes={words.map((word) => [...word.bbox])}
                />
              </div>
            </details>
          </div>

          {/* Tab 5: Lịch sử Revision + Diagnostics + Original OCR */}
          <div
            aria-labelledby="ocr-workbench-tab-history"
            className={activeTab === "history" ? "space-y-4" : "hidden"}
            id="ocr-workbench-panel-history"
            role="tabpanel"
          >
            <section className="space-y-4 rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5">
              <h2 className="text-base font-extrabold text-ink">
                {t("ocrReview.revisionsPanel.heading")}
              </h2>

              <div className="grid gap-2">
                {history.map((revision) => (
                  <button
                    className={cn(
                      "flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-start transition-colors",
                      revision.page_revision_id === detail.page_revision_id
                        ? "border-primary bg-sky/40 ring-1 ring-primary/30"
                        : "border-border bg-white hover:bg-surface-subtle/60",
                    )}
                    disabled={busy !== null}
                    key={revision.page_revision_id}
                    onClick={() =>
                      void chooseRevision(revision.page_revision_id)
                    }
                    type="button"
                  >
                    <span className="text-sm font-extrabold text-ink">
                      Bản R{formatNumber(revision.revision_no)}
                      {revision.is_current_verified ? (
                        <span className="ms-1.5 text-xs font-semibold text-primary">
                          {t("ocrReview.revisionsPanel.currentSuffix")}
                        </span>
                      ) : null}
                    </span>
                    <AdminStatusBadge status={revision.verification_status} />
                  </button>
                ))}
              </div>

              <div className="space-y-2.5 border-t border-border pt-4">
                <label
                  className="grid gap-1.5 text-xs font-bold text-ink"
                  htmlFor="replacement-page-image"
                >
                  {t("ocrReview.revisionsPanel.reuploadLabel")}
                  <input
                    accept="image/jpeg,image/png,image/webp"
                    className="block w-full rounded-control border border-border bg-white px-3 py-2 text-xs file:me-2 file:rounded file:border-0 file:bg-sky file:px-2.5 file:py-1 file:text-xs file:font-bold file:text-primary-hover"
                    disabled={
                      busy !== null || detail.lifecycle_status !== "ACTIVE"
                    }
                    id="replacement-page-image"
                    onChange={(event) =>
                      setReplacementFile(event.target.files?.[0] ?? null)
                    }
                    type="file"
                  />
                </label>
                {replacementFile ? (
                  <p className="text-xs text-muted">
                    {t("ocrReview.revisionsPanel.selectedFile", {
                      fileName: replacementFile.name,
                    })}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={
                      busy !== null ||
                      !replacementFile ||
                      detail.lifecycle_status !== "ACTIVE"
                    }
                    isLoading={busy === "reupload"}
                    onClick={() => void replaceImageAndReprocess()}
                    size="admin"
                    type="button"
                    variant="secondary"
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                    />
                    {t("ocrReview.revisionsPanel.reuploadBtn")}
                  </Button>
                  <Button
                    disabled={
                      busy !== null || detail.lifecycle_status !== "ACTIVE"
                    }
                    isLoading={busy === "reprocess"}
                    onClick={() => void reprocess()}
                    size="admin"
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                    />
                    {t("ocrReview.revisionsPanel.reprocessBtn")}
                  </Button>
                  <Button
                    disabled={busy !== null}
                    onClick={() => void load()}
                    size="admin"
                    type="button"
                    variant="outline"
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                    />
                    {t("ocrReview.revisionsPanel.reloadDataBtn")}
                  </Button>
                </div>
                {busy === "reprocess" || busy === "reupload" ? (
                  <AiProgressBar
                    active
                    elapsedSeconds={reprocessBarProgress.elapsedSeconds}
                    label={
                      reprocessBarProgress.stageLabel ??
                      tCommon("aiProgress.ocrExtracting")
                    }
                    percent={reprocessBarProgress.percent}
                    size="sm"
                    testId="ocr-review-reprocess-progress"
                  />
                ) : null}
              </div>
            </section>

            {/* Original Immutable OCR & Runtime Diagnostics cleanly housed here */}
            <details className="rounded-xl border border-border bg-white p-4 shadow-2xs">
              <summary className="cursor-pointer text-xs font-extrabold text-ink">
                {t("ocrReview.originalOcr.heading")}
              </summary>
              {detail.original_ocr_text ? (
                <p
                  className="viread-learning-content mt-2 whitespace-pre-wrap text-xs leading-6 text-ink"
                  dir="ltr"
                  lang="vi"
                >
                  {detail.original_ocr_text}
                </p>
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-muted">
                  {t("ocrReview.originalOcr.missingSnapshot")}
                </p>
              )}
            </details>

            <details className="rounded-xl border border-border bg-white p-4 shadow-2xs">
              <summary className="cursor-pointer text-xs font-extrabold text-ink">
                {t("ocrReview.diagnostics.heading")}
              </summary>
              <section
                aria-label={t("ocrReview.diagnostics.ariaLabel")}
                className="mt-2.5"
              >
                <p className="text-xs font-semibold text-ink">
                  {runtimeEvidence.verified ||
                  runtimeEvidence.modelInferenceStatus === "healthy"
                    ? "Mô hình nhận diện đang hoạt động"
                    : "Cần kiểm tra mô hình"}
                </p>
                {!runtimeEvidence.verified ? (
                  <p className="mt-1 text-xs text-muted">
                    {t("ocrReview.diagnostics.unverifiedRuntimeWarning")}
                  </p>
                ) : null}
              </section>
            </details>
          </div>

          {/* Sticky Bottom Save / AI / Verify Action Bar */}
          <div className="sticky bottom-3 z-20 rounded-xl border border-border bg-white/95 p-3.5 shadow-md backdrop-blur-xs">
            <div className="flex flex-wrap items-center gap-2">
              {verified ? (
                <Button
                  disabled={
                    busy !== null ||
                    detail.lifecycle_status !== "ACTIVE" ||
                    !isCurrentVerifiedRevision
                  }
                  isLoading={busy === "edit"}
                  onClick={() => void createEditDraft()}
                  size="admin"
                  variant="secondary"
                >
                  <Save aria-hidden="true" className="size-4 shrink-0" />
                  {t("ocrReview.draft.createDraftToEditBtn")}
                </Button>
              ) : (
                <>
                  <Button
                    disabled={
                      busy !== null ||
                      detail.lifecycle_status !== "ACTIVE" ||
                      wordSyncError !== null
                    }
                    isLoading={busy === "save"}
                    onClick={() => void saveDraft()}
                    size="admin"
                    variant="outline"
                  >
                    <Save aria-hidden="true" className="size-4 shrink-0" />
                    {t("ocrReview.draft.saveDraftBtn")}
                  </Button>

                  <Button
                    disabled={
                      busy !== null ||
                      detail.lifecycle_status !== "ACTIVE" ||
                      words.length === 0 ||
                      wordSyncError !== null ||
                      candidateEditPending ||
                      workflowFinalApprovalBlocked ||
                      aiSuggestion !== null ||
                      (aiWorkflow !== null &&
                        [
                          "QUEUED",
                          "PROOFREADING",
                          "CHILD_SAFETY_SCANNING",
                        ].includes(aiWorkflow.status))
                    }
                    isLoading={busy === "verify" || busy === "ai_correct"}
                    onClick={() => void verifyRevision()}
                    size="admin"
                    type="button"
                    variant="primary"
                  >
                    {proofreadAudit ? (
                      <CheckCircle2
                        aria-hidden="true"
                        className="size-4 shrink-0"
                      />
                    ) : (
                      <Sparkles
                        aria-hidden="true"
                        className="size-4 shrink-0"
                      />
                    )}
                    {busy === "ai_correct"
                      ? t("ocrReview.draft.runningAiBtn")
                      : proofreadAudit || aiWorkflow?.proofread_text
                        ? t("ocrReview.draft.verifyFinalBtn")
                        : t("ocrReview.draft.confirmRunAiBtn")}
                  </Button>

                  {aiCheckUnavailable && proofreadAudit === null ? (
                    <Button
                      disabled={busy !== null}
                      onClick={continueManualVerification}
                      size="admin"
                      type="button"
                      variant="outline"
                    >
                      {t("ocrReview.draft.continueManualVerify")}
                    </Button>
                  ) : null}

                  {aiWorkflow?.proofread_text &&
                  workflowFinalApprovalBlocked ? (
                    <p
                      className="basis-full text-xs font-medium text-warning"
                      role="status"
                    >
                      {workflowHasHighRisk
                        ? t("ocrReview.draft.blockedHighSafety")
                        : workflowImageFlaggedUnsafe
                          ? t("ocrReview.draft.blockedUnsafeImage")
                          : workflowImageUnassessed
                            ? t("ocrReview.draft.blockedUnassessedImage")
                            : aiWorkflow.safety_status !== "CONFIRMED" &&
                                !workflowCanAutoConfirmSafety
                              ? t("ocrReview.draft.blockedIncompleteSafety")
                              : t("ocrReview.draft.blockedStaleSafety")}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OcrRevisionStatus({
  status,
}: {
  status: AdminPageRevisionDetailDTO["verification_status"];
}) {
  return <AdminStatusBadge status={status} />;
}

function AdminOcrWordReviewPanel({
  backHref,
  bookTitle,
  busy,
  onAddWord,
  onComplete,
  onRemoveWord,
  onSelectWord,
  onUpdateBbox,
  onUpdateWord,
  pageNumber,
  revisionNo,
  selectedWord,
  status,
  wordSyncError,
  words,
}: {
  backHref: string;
  bookTitle: string;
  busy: boolean;
  onAddWord: () => void;
  onComplete: () => void;
  onRemoveWord: (wordIndex: number) => void;
  onSelectWord: (wordIndex: number) => void;
  onUpdateBbox: (wordIndex: number, coordinate: number, value: number) => void;
  onUpdateWord: (
    wordIndex: number,
    patch: Partial<AdminRevisionWordDTO>,
  ) => void;
  pageNumber: number;
  revisionNo: number;
  selectedWord: number | null;
  status: AdminPageRevisionDetailDTO["verification_status"];
  wordSyncError: string | null;
  words: readonly AdminRevisionWordDTO[];
}) {
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
  const selected =
    words.find((word) => word.word_index === selectedWord) ?? words[0] ?? null;
  const readOnly = status !== "NEEDS_REVIEW" || busy;

  return (
    <section className="mx-auto flex w-full max-w-[680px] flex-col gap-4">
      <AdminPageHeader
        actions={
          <ButtonLink href={backHref} size="admin" variant="outline">
            {t("ocrReview.bboxView.backBtn")}
          </ButtonLink>
        }
        badge={<OcrRevisionStatus status={status} />}
        description={t("ocrReview.bboxView.subtitle", {
          title: bookTitle,
          pageNumber: formatNumber(pageNumber),
          revisionNo: formatNumber(revisionNo),
        })}
        title={t("ocrReview.bboxView.heading")}
      />

      <Card className="gap-4 bg-white sm:p-6">
        <h2 className="text-2xl font-extrabold text-ink">
          {t("ocrReview.bboxView.sectionHeading")}
        </h2>
        <div
          aria-label={t("ocrReview.bboxView.mobileListAria")}
          className="grid max-h-[360px] gap-2.5 overflow-y-auto md:hidden"
        >
          {words.map((word) => {
            const isSelected = word.word_index === selected?.word_index;
            return (
              <div
                className={
                  isSelected
                    ? "rounded-control border border-primary bg-sky/50 p-3"
                    : "rounded-control border border-border bg-white p-3"
                }
                key={word.word_index}
              >
                <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted">
                  <span className="font-bold text-ink">
                    #{formatNumber(word.word_index)}
                  </span>
                  <span>
                    {t("ocrReview.bboxView.confidencePrefix")}{" "}
                    {word.ocr_confidence === null
                      ? t("common.emptyDash")
                      : getOcrScoreLabel(word, t)}
                  </span>
                </div>
                <input
                  aria-label={t("ocrReview.bboxView.mobileWordAria", {
                    num: formatNumber(word.word_index + 1),
                  })}
                  className="viread-learning-content min-h-12 w-full rounded-control border border-border bg-white px-3 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-primary"
                  dir="ltr"
                  disabled={readOnly}
                  lang="vi"
                  onChange={(event) =>
                    onUpdateWord(word.word_index, {
                      text: event.target.value,
                    })
                  }
                  onFocus={() => onSelectWord(word.word_index)}
                  value={word.text}
                />
              </div>
            );
          })}
        </div>
        <div className="hidden md:block">
          <ResponsiveTable
            ariaLabel={t("ocrReview.bboxView.tableAria")}
            className="max-h-[360px] overflow-y-auto"
          >
            <table className="w-full border-collapse text-start text-sm">
              <thead className="sticky top-0 z-10 bg-sky text-primary-hover">
                <tr>
                  <th className="px-3 py-3 font-bold">
                    {t("ocrReview.bboxView.hashColumnLabel", undefined, "#")}
                  </th>
                  <th className="px-3 py-3 font-bold">
                    {t("ocrReview.bboxView.wordColumn")}
                  </th>
                  <th className="px-3 py-3 font-bold">
                    {t("ocrReview.bboxView.confidenceColumn")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {words.map((word) => {
                  const isSelected = word.word_index === selected?.word_index;
                  return (
                    <tr
                      className={
                        isSelected ? "bg-sky/50" : "border-b border-border"
                      }
                      key={word.word_index}
                    >
                      <td className="px-3 py-3">
                        {formatNumber(word.word_index)}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          aria-label={t("ocrReview.bboxView.wordInputAria", {
                            num: formatNumber(word.word_index + 1),
                          })}
                          className="viread-learning-content min-h-9 w-full min-w-20 scroll-mt-12 bg-transparent text-ink outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
                          dir="ltr"
                          disabled={readOnly}
                          lang="vi"
                          onChange={(event) =>
                            onUpdateWord(word.word_index, {
                              text: event.target.value,
                            })
                          }
                          onFocus={() => onSelectWord(word.word_index)}
                          value={word.text}
                        />
                      </td>
                      <td className="px-3 py-3">
                        {word.ocr_confidence === null
                          ? t("common.emptyDash")
                          : getOcrScoreLabel(word, t)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ResponsiveTable>
        </div>

        {selected ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {(["x", "y", "w", "h"] as const).map((label, coordinate) => (
              <label
                className="grid min-h-[72px] gap-1 rounded-control border border-border bg-white px-4 py-3 text-sm text-muted"
                key={label}
              >
                <span>{label}</span>
                <input
                  aria-label={t("ocrReview.bboxView.coordInputAria", {
                    axis: label,
                    num: formatNumber(selected.word_index + 1),
                  })}
                  className="min-h-6 w-full bg-transparent text-ink outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary disabled:text-muted"
                  disabled={readOnly}
                  max="1"
                  min="0"
                  onChange={(event) =>
                    onUpdateBbox(
                      selected.word_index,
                      coordinate,
                      Number(event.target.value),
                    )
                  }
                  step="0.01"
                  type="number"
                  value={selected.bbox[coordinate].toFixed(2)}
                />
              </label>
            ))}
          </div>
        ) : (
          <p className="rounded-control bg-canvas p-4 text-sm text-muted">
            {t("ocrReview.bboxView.noWords")}
          </p>
        )}

        {wordSyncError ? (
          <StatusMessage tone="error">{wordSyncError}</StatusMessage>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={readOnly}
            onClick={onAddWord}
            size="admin"
            variant="secondary"
          >
            {t("ocrReview.bboxView.addWord")}
          </Button>
          <Button
            disabled={readOnly || !selected}
            onClick={() => selected && onRemoveWord(selected.word_index)}
            size="admin"
            variant="destructive-outline"
          >
            {t("ocrReview.bboxView.deleteWord")}
          </Button>
        </div>
      </Card>

      <div>
        <Button onClick={onComplete} size="admin" variant="primary">
          {t("ocrReview.bboxView.finishReview")}
        </Button>
      </div>
    </section>
  );
}
