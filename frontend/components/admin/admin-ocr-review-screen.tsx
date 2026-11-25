"use client";

import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  X,
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
import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { SmartOcrBlockReviewLoader } from "@/components/admin/smart-ocr-block-review";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { ResponsiveTable } from "@/components/common/responsive-table";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
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
type AiTokenChange = {
  readonly index: number;
  readonly original: string;
  readonly proposed: string;
};

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
): string {
  void _paddleLineScore;
  const group = getWordReviewColorGroup(status, word);
  if (group === "green") {
    if (status === "verified") return "Admin đã xác minh từ";
    if (word?.ocr_evidence?.verification_source)
      return "Khớp reference của revision đã xác minh";
    if (hasEngineDisagreementEvidence(word))
      return "Đã phân xử bằng crop của từ · nhiều lượt đọc độc lập đồng thuận · chưa đối chiếu reference";
    return "Hai OCR đồng thuận · chưa đối chiếu reference";
  }
  if (group === "red") return "Sai so với reference đã xác minh";
  if (
    hasEngineDisagreementEvidence(word) &&
    hasDiacriticOnlyEngineDisagreement(word)
  )
    return "Hai OCR chỉ khác dấu tiếng Việt · cần đối chiếu ảnh";
  if (hasEngineDisagreementEvidence(word)) {
    return "Hai OCR bất đồng · chưa thể xác định candidate đúng";
  }
  return (
    word?.ocr_evidence?.review_reason?.trim() ||
    "Chưa đủ bằng chứng OCR · cần Admin đối chiếu ảnh"
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

export function getWordGeometryLabel(word?: AdminRevisionWordDTO): string {
  return {
    good: "Box ôm đúng vùng chữ",
    weak: "Box chạm biên hoặc crop yếu · nên căn chỉnh lại",
    invalid: "Box không hợp lệ · cần căn chỉnh lại",
    not_assessed: "Chưa đánh giá hình học của box",
  }[getWordGeometryQuality(word)];
}

export function getWordPunctuationLabel(word?: AdminRevisionWordDTO): string {
  return {
    correct: "Dấu câu khớp reference đã xác minh",
    incorrect: "Dấu câu khác reference đã xác minh",
    uncertain: "Các engine đọc dấu câu khác nhau · cần đối chiếu ảnh",
    consistent:
      "Các engine tiếng Việt đọc cùng dấu câu · chưa đối chiếu reference",
    not_assessed: "Chưa có căn cứ để đánh giá dấu câu",
  }[word?.punctuation_status ?? "not_assessed"];
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

function getEngineEvidenceDisplay(
  word: AdminRevisionWordDTO,
  engine: "paddleocr" | "vietocr" | "tesseract",
  metadata: Record<string, unknown>,
): string {
  const evidence = word.ocr_evidence;
  const line = getWordLineEvidence(word, metadata);
  const lineStatuses = asRecord(line?.engine_statuses);
  const pageStatuses = asRecord(metadata.engine_statuses);
  const rawLineStatus = lineStatuses?.[engine];
  const rawPageStatus = pageStatuses?.[engine];
  const status =
    evidence?.engine_statuses?.[engine] ??
    (typeof rawLineStatus === "string" ? rawLineStatus : undefined) ??
    (typeof rawPageStatus === "string" ? rawPageStatus : undefined);
  const candidate = evidence?.engine_outputs[engine];
  const statusLabels: Record<string, string> = {
    not_installed: "chưa cài đặt",
    not_initialized: "chưa khởi tạo",
    not_run: "không chạy",
    processing: "đang xử lý",
    success: "đã chạy",
    no_result: "đã chạy nhưng không nhận dạng được",
    error: "lỗi inference",
    disabled: "đã tắt cấu hình",
  };
  const statusLabel = status
    ? (statusLabels[status] ?? status)
    : "trạng thái chưa được ghi trong revision cũ";
  if (typeof candidate === "string" && candidate.trim()) {
    return `${candidate} · ${statusLabel}`;
  }
  if (status === "success")
    return "Đã chạy · không có token căn chỉnh an toàn cho từ này";
  if (status === "no_result") return "Đã chạy · không nhận dạng được text";
  if (status === "not_installed") return "Chưa cài đặt";
  if (status === "not_initialized") return "Chưa khởi tạo";
  if (status === "not_run") return "Không chạy";
  if (status === "processing") return "Đang xử lý";
  if (status === "error") {
    const lineErrors = asRecord(line?.engine_errors);
    const pageReasons = asRecord(metadata.engine_status_reasons);
    const reason =
      evidence?.engine_errors?.[engine] ??
      (typeof lineErrors?.[engine] === "string"
        ? lineErrors[engine]
        : undefined) ??
      (typeof pageReasons?.[engine] === "string"
        ? pageReasons[engine]
        : undefined);
    return reason ? `Lỗi inference · ${reason}` : "Lỗi inference";
  }
  if (status === "disabled") return "Đã tắt cấu hình";
  return "Không có trạng thái engine được ghi trong revision này";
}

export function getOcrScoreLabel(word: AdminRevisionWordDTO): string {
  if (
    word.ocr_score_source === null ||
    word.ocr_score_source === undefined ||
    word.ocr_confidence === null ||
    word.ocr_confidence === undefined ||
    !Number.isFinite(word.ocr_confidence) ||
    word.ocr_confidence < 0 ||
    word.ocr_confidence > 1
  ) {
    return "Không có điểm OCR riêng cho từ này";
  }
  const score = Math.round(word.ocr_confidence * 100);
  if (word.ocr_score_source === "tesseract_raw_word_score_v1") {
    return `Điểm thô Tesseract: ${score}/100 · raw recognition score, không phải xác suất đúng`;
  }
  if (word.ocr_score_source === "ocr_calibrated_word_accuracy_v1") {
    const probability = word.ocr_evidence?.calibrated_word_accuracy;
    return word.ocr_evidence?.contract === "ocr_calibrated_word_accuracy_v1" &&
      probability !== null &&
      probability !== undefined &&
      Number.isFinite(probability) &&
      probability >= 0 &&
      probability <= 1
      ? `Xác suất nhận diện đúng: ${Math.round(probability * 100)}% · đã hiệu chuẩn`
      : "Chưa có confidence cấp từ đã hiệu chuẩn";
  }
  if (
    word.ocr_score_source === "dual_engine_consensus_v1" ||
    word.ocr_score_source === "paddle_line_score_v1"
  ) {
    return "Điểm cũ chưa hiệu chuẩn · không hiển thị như xác suất";
  }
  return "Chưa có confidence cấp từ đã hiệu chuẩn";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getWordLineEvidence(
  word: AdminRevisionWordDTO,
  metadata: Record<string, unknown>,
): Record<string, unknown> | null {
  const rawLines = metadata.line_evidence;
  if (!Array.isArray(rawLines)) return null;
  return (
    rawLines
      .map(asRecord)
      .find((line) => line?.line_index === word.line_index) ?? null
  );
}

function getLineEngineOutput(
  word: AdminRevisionWordDTO,
  engine: "paddleocr" | "vietocr",
  metadata: Record<string, unknown>,
): string | null {
  const line = getWordLineEvidence(word, metadata);
  const key = engine === "paddleocr" ? "paddle_output" : "vietocr_output";
  const output = line?.[key];
  return typeof output === "string" && output.trim() ? output : null;
}

function formatRawOcrEvidence(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 12)
      .map((item) =>
        typeof item === "number" && Number.isFinite(item) ? String(item) : "—",
      )
      .join(", ");
  }
  return "Not recorded";
}

function getPaddleLineScoreLabel(
  metadata: Record<string, unknown>,
  lineIndex: number,
): string {
  const lineEvidence = metadata.line_evidence;
  if (!Array.isArray(lineEvidence)) {
    return "PaddleOCR dòng: Not recorded";
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
    return "PaddleOCR dòng: Not recorded";
  }
  const selectedWithVietOcr = line?.vietocr_output_used === true;
  return `PaddleOCR dòng: ${Math.round(rawScore * 100)}/100 · điểm thô · không phải xác suất đúng${selectedWithVietOcr ? " · VietOCR được dùng nên không áp màu theo điểm này" : ""}`;
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
): string {
  return getPaddleLineScoreForWord(metadata, word) !== null
    ? getPaddleLineScoreLabel(metadata, word.line_index)
    : getOcrScoreLabel(word);
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
          alt={`Ảnh trang ${image.page_number} của ${book.title}`}
          className="object-contain"
          fill
          sizes={expanded ? "92vw" : "(max-width:1280px) 100vw, 55vw"}
          src={image.preview_url}
          unoptimized
        />
        <div
          aria-label={`Bounding box từ OCR: ${words.length} từ`}
          className="absolute inset-0"
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
            );
            const scoreLabel = getWordScoreLabel(word, ocrMetadata);
            const selectedClass =
              word.word_index === selectedWord
                ? "z-10 border-2 ring-2 ring-white"
                : "border";
            const geometryQuality = getWordGeometryQuality(word);
            const geometryNeedsRepair =
              geometryQuality === "weak" || geometryQuality === "invalid";
            const geometryNote = geometryNeedsRepair
              ? ` ${getWordGeometryLabel(word)}.`
              : "";
            const boxLabel = `Từ ${word.word_index + 1}: ${word.text}. ${reviewLabel}. ${scoreLabel}.${geometryNote}`;
            const boxTitle = `Từ ${word.word_index + 1}: ${word.text} · ${reviewLabel} · ${scoreLabel} · bản nháp: ${currentDraftToken ?? "chưa có"}`;

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
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold">Ảnh trang gốc</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">
            {image.width} × {image.height} px
          </span>
          <button
            className="min-h-10 rounded-control border border-border px-3 text-sm font-semibold text-primary hover:bg-canvas"
            onClick={() => setIsExpanded(true)}
            ref={expandButtonRef}
            type="button"
          >
            Phóng lớn ảnh
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
              type="button"
              variant="secondary"
            >
              Đóng ảnh
            </Button>
          </div>
        }
        isOpen={isExpanded}
        onClose={() => setIsExpanded(false)}
        title={`Trang ${image.page_number} · ${book.title}`}
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
  const router = useRouter();
  const searchParams = useSearchParams();
  // Next's compatibility layer can return null outside the App Router (e.g. tests).
  const preferredRevisionId = searchParams?.get("revisionId") ?? null;
  const activeView = searchParams?.get("view") ?? "review";
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
  const [notice, setNotice] = useState<string | null>(null);
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
        setNotice(
          "Revision trong báo cáo không còn trong lịch sử trang. Đang hiển thị revision mới nhất.",
        );
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
          try {
            const latest = await ocr.getLatestWorkflow(
              pageId,
              requestedRevision,
            );
            if (latest) setAiWorkflow(latest);
          } catch {
            setNotice(
              isServiceError(cause)
                ? "Không thể lưu Candidate cho Safety rescan: " + cause.message
                : "Không thể lưu Candidate cho Safety rescan.",
            );
          }
        });
    }, 600);
    return () => {
      globalThis.clearTimeout(timer);
      candidateSyncRequestRef.current += 1;
    };
  }, [aiWorkflow, candidateEditPending, detail, draftText, ocr, pageId]);

  useEffect(() => {
    if (
      !aiWorkflow ||
      !["QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"].includes(
        aiWorkflow.status,
      )
    ) {
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const poll = async () => {
      if (disposed) return;
      try {
        const latest = await ocr.getLatestWorkflow(
          pageId,
          aiWorkflow.page_revision_id,
        );
        if (!disposed && latest?.workflow_id === aiWorkflow.workflow_id) {
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
  }, [aiWorkflow, ocr, pageId]);

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
    } catch {
      if (
        !mountedRef.current ||
        requestId !== revisionChoiceRequestIdRef.current
      )
        return;
      setNotice("Không thể tải revision đã chọn.");
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
        setWordFilter("review");
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
      `Nội dung mới có ${result.actualTokenCount} từ nhưng danh sách đang có ${result.expectedWordCount} từ. Để không gán nhầm tọa độ, hệ thống giữ nguyên Words hiện tại. Hãy khôi phục số từ hoặc xử lý lại OCR/đối chiếu tọa độ trước khi lưu.`,
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
        `Danh sách có ${result.expectedWordCount} từ, nhưng văn bản trang có ${result.actualTokenCount} từ hoặc một mục Word chứa nhiều từ. Hãy chỉnh lại trước khi lưu.`,
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
      setWordSyncError(
        "Không thể đồng bộ vì có từ rỗng hoặc một từ chứa nhiều token. Hãy chỉnh danh sách từ trước khi lưu.",
      );
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
      setNotice(
        "Đã đồng bộ từ với văn bản. Việc đồng bộ không xác minh độ đúng OCR; hãy đối chiếu với ảnh trước khi xác minh trang.",
      );
    } else {
      setWordSyncError(
        "Số lượng từ giữa văn bản và danh sách bounding box chưa khớp để đối chiếu.",
      );
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
      const correctedText = workflow.proofread_text?.normalize("NFC");
      if (!correctedText) {
        setAiCheckUnavailable(true);
        setNotice(
          workflow.error_code
            ? `Proofreading thất bại (${workflow.error_code}). Nội dung OCR gốc vẫn được giữ nguyên; hãy thử lại.`
            : "Workflow chưa có kết quả proofreading hợp lệ. Nội dung OCR gốc vẫn được giữ nguyên.",
        );
        return;
      }
      const result = syncPageTextToWords(correctedText, words);
      if (
        result.status !== "synchronized" ||
        result.tokens.length !== expectedTokenCount ||
        result.tokens.length !== words.length
      ) {
        setAiCheckUnavailable(true);
        setNotice(
          "AI trả về kết quả không thể ghép chắc chắn với các vùng chữ. Văn bản và tọa độ được giữ nguyên; hãy thử lại hoặc tiếp tục xác minh thủ công có ghi audit.",
        );
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
            ? "Proofreading hoàn tất; Child Safety gặp lỗi và có thể thử lại riêng."
            : "AI chưa phát hiện lỗi chính tả cần chỉnh sửa. Child Safety đã chạy tự động; hãy kiểm tra hai kết quả trước khi xác nhận.",
        );
        return;
      }
      setAiSuggestion(correctedText);
      setAiAcceptedChanges(new Set());
      setNotice(
        workflow.safety_status === "FAILED"
          ? `AI đưa ra ${changes.length} thay đổi để rà soát. Child Safety gặp lỗi; kết quả proofreading vẫn được giữ và có thể thử lại Safety.`
          : `AI đưa ra ${changes.length} thay đổi để rà soát. Child Safety đã quét Candidate; chưa có thay đổi nào được chọn.`,
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
        setNotice("Đã dừng theo dõi. Workflow bền vững tiếp tục ở Backend.");
      } else {
        setAiCheckUnavailable(true);
        const safeMessage = isServiceError(cause)
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "văn bản và tọa độ hiện tại được giữ nguyên.";
        setNotice(
          safeMessage.startsWith("Không thể") ||
            safeMessage.startsWith("AI OCR")
            ? safeMessage
            : "Không thể kiểm tra văn bản bằng AI: " + safeMessage,
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
      setNotice(
        "Hãy ghi lý do Admin xem xét trước khi xác nhận kết quả Safety.",
      );
      return;
    }
    setBusy("workflow");
    setNotice(null);
    try {
      setAiWorkflow(
        await ocr.decideWorkflowSafety(
          pageId,
          aiWorkflow.workflow_id,
          aiWorkflow.candidate_hash,
          confirmed,
          reason || undefined,
        ),
      );
    } catch (cause) {
      setNotice(
        isServiceError(cause)
          ? "Không thể lưu quyết định Safety: " + cause.message
          : "Không thể lưu quyết định Safety. Hãy tải lại kết quả rồi thử lại.",
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
      setNotice(
        "Hãy ghi rõ lý do trước khi đánh dấu hình ảnh không phù hợp với trẻ em.",
      );
      return;
    }
    setBusy("workflow");
    setNotice(null);
    try {
      setAiWorkflow(
        await ocr.decideWorkflowImageSafety(
          pageId,
          aiWorkflow.workflow_id,
          status,
          aiWorkflow.source_image_sha256 ?? undefined,
          reason || undefined,
        ),
      );
      setNotice(
        status === "ADMIN_CONFIRMED_SAFE"
          ? "Đã ghi nhận Admin xác nhận hình ảnh trang phù hợp với trẻ em."
          : "Đã gắn cờ hình ảnh không phù hợp; trang này sẽ bị chặn xác minh.",
      );
    } catch (cause) {
      setNotice(
        isServiceError(cause)
          ? "Không thể lưu quyết định an toàn hình ảnh: " + cause.message
          : "Không thể lưu quyết định an toàn hình ảnh. Hãy tải lại trang rồi thử lại.",
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
      setNotice(
        retryingSafety || aiWorkflow.stage === "CHILD_SAFETY_SCANNING"
          ? "Đã đưa riêng Child Safety vào hàng đợi; Proofreading và OCR được giữ nguyên."
          : "Đã đưa riêng Proofreading vào hàng đợi thử lại.",
      );
    } catch (cause) {
      setNotice(
        isServiceError(cause)
          ? "Không thể thử lại workflow: " + cause.message
          : "Không thể đưa workflow vào hàng đợi thử lại.",
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
      `Đã ghi nhận ${selected.length} gợi ý được Admin chấp nhận và ${suggestions.length - selected.length} gợi ý bị từ chối. Hãy rà soát rồi xác nhận VERIFIED.`,
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
    setNotice(
      "AI không khả dụng. Bạn đang tiếp tục xác minh thủ công; nội dung này được ghi nhận trong audit.",
    );
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
      setNotice(
        "Trang đã có bản nháp chờ duyệt từ revision khác. Hãy chọn revision NEEDS_REVIEW trong lịch sử trước khi tiếp tục.",
      );
      return true;
    }

    applyDetail(existingDraft);
    setNotice(
      "Bản nháp từ revision này đã tồn tại. Đã mở lại để bạn tiếp tục chỉnh sửa.",
    );
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
      setNotice(
        "Đã tạo revision nháp từ nội dung đã xác minh. Hãy sửa, lưu bản nháp và xác minh để áp dụng cho lượt đọc mới.",
      );
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
          ? "Không thể tạo bản nháp: " + cause.message
          : "Không thể tạo bản nháp chỉnh sửa. Dữ liệu hiện tại vẫn được giữ nguyên.",
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
      setNotice(
        "Đang đồng bộ Candidate và lên lịch Safety rescan. Hãy lưu lại sau khi hoàn tất bước này.",
      );
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
      setNotice("Đã lưu bản nháp vào database.");
      try {
        setHistory(await revisions.list(pageId));
      } catch {
        setNotice("Đã lưu bản nháp, nhưng chưa tải lại được lịch sử revision.");
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
          ? "Không thể lưu bản nháp: " + cause.message
          : "Không thể lưu bản nháp. Văn bản hiện tại được giữ nguyên.",
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
      setNotice(
        "Hãy xác nhận lựa chọn với các gợi ý AI trước khi hoàn tất VERIFIED.",
      );
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
      setNotice(
        "Candidate đang được lưu và Child Safety sẽ tự chạy lại. Vui lòng đợi hash được cập nhật.",
      );
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
      setNotice(
        "Đã xác minh revision. Revision này có thể làm ground truth cho session mới nếu trang đang ACTIVE.",
      );
      try {
        setHistory(await revisions.list(pageId));
      } catch {
        setNotice("Đã xác minh revision, nhưng chưa tải lại được lịch sử.");
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
          ? "Không thể xác minh: " + cause.message
          : "Không thể xác minh. Hãy đồng bộ văn bản với danh sách từ, kiểm tra bbox và thử lại.",
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function reprocess() {
    if (!detail) return;
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
      setImage(nextImage);
      applyDetail(result);
      setHistory(nextHistory);
      setNotice(
        "Đã tạo revision mới từ ảnh trong Supabase Storage. Revision cũ vẫn được giữ nguyên.",
      );
    } catch {
      setNotice(
        "Không thể chạy lại OCR. Kiểm tra Storage, Tesseract 5.x, vie.traineddata và thử lại.",
      );
    } finally {
      setBusy(null);
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
      setNotice("Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP.");
      return;
    }
    if (replacementFile.size <= 0 || replacementFile.size > 12 * 1024 * 1024) {
      setNotice("Ảnh phải có dung lượng lớn hơn 0 và không quá 12 MB.");
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
      setImage(nextImage);
      applyDetail(result);
      setHistory(nextHistory);
      setReplacementFile(null);
      const input = document.getElementById(
        "replacement-page-image",
      ) as HTMLInputElement | null;
      if (input) input.value = "";
      setNotice(
        "Đã OCR ảnh mới cho đúng trang này. Bản mới đang chờ duyệt; ảnh và nội dung dùng cho lượt đọc chỉ chuyển sang bản mới sau khi xác minh.",
      );
    } catch {
      setNotice(
        "Không thể tải ảnh mới hoặc chạy OCR. Dữ liệu hiện tại được giữ lại; hãy kiểm tra Storage, Tesseract 5.x, vie.traineddata và thử lại.",
      );
    } finally {
      setBusy(null);
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
            ? "Không tìm thấy trang"
            : error === "unavailable"
              ? "Dữ liệu OCR chưa khả dụng"
              : "Không thể tải OCR"
        }
        description={
          error === "not-found"
            ? "Trang không thuộc sách hoặc dữ liệu quản trị hiện tại."
            : error === "unavailable"
              ? "Ảnh hoặc revision chưa đáp ứng contract hiện tại. Không sử dữ liệu mẫu thay thế."
              : "Vui lòng thử lại sau."
        }
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void load()} variant="secondary">
              Thử lại
            </Button>
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-semibold text-primary underline"
              href={`/admin/books/${bookId}`}
            >
              Quay lại sách
            </Link>
          </div>
        }
      />
    );
  }
  if (!book || !image || !history || !detail)
    return <AdminLoading label="Đang tải ảnh và revision…" />;

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
          const nextIndex =
            words.reduce(
              (maximum, word) => Math.max(maximum, word.word_index),
              -1,
            ) + 1;
          const nextWord: AdminRevisionWordDTO = {
            word_index: nextIndex,
            line_index: words.at(-1)?.line_index ?? 0,
            text: "Từ mới",
            normalized_text: normalizeVietnameseWord("Từ mới"),
            bbox: [0.1, 0.1, 0.1, 0.05],
            ocr_confidence: null,
            ocr_review_status: "needs_review",
          };
          setWords((current) => [...current, nextWord]);
          setDraftText((current) => `${current.trim()} Từ mới`.trim());
          setSelectedWord(nextIndex);
          setWordSyncError(null);
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
            setWordSyncError(
              "Không thể đồng bộ văn bản sau khi xóa từ. Hãy kiểm tra nội dung và danh sách từ trước khi lưu.",
            );
            return;
          }
          setWords([...synced.words]);
          setDraftText(nextText.normalize("NFC"));
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

  if (activeView === "history") {
    return (
      <AdminOcrHistoryPanel
        backHref={viewHref("review")}
        bookTitle={book.title}
        busy={busy}
        detail={detail}
        history={history}
        notice={notice}
        onChooseRevision={(revisionId) => void chooseRevision(revisionId)}
        onReload={() => void load()}
        onReprocess={() => void reprocess()}
        onReplacementFileChange={setReplacementFile}
        onReplaceImage={() => void replaceImageAndReprocess()}
        pageNumber={image.page_number}
        replacementFile={replacementFile}
      />
    );
  }

  return (
    <>
      <AdminPageHeader
        eyebrow={`${book.title} · Trang ${image.page_number}`}
        title={`Kiểm tra OCR · R${detail.revision_no}`}
        description="Sửa nội dung và vị trí từ, lưu nháp, xác minh hoặc tạo revision OCR mới."
        actions={<OcrRevisionStatus status={detail.verification_status} />}
      />
      <Link
        className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-semibold text-primary focus-visible:outline-3 focus-visible:outline-primary"
        href={`/admin/books/${bookId}`}
      >
        <ArrowLeft aria-hidden className="size-5" /> Chi tiết sách
      </Link>
      {detail.verification_status === "VERIFIED" ? (
        <StatusMessage
          className="mb-6"
          title="Đã xác minh revision"
          tone="success"
        >
          Revision này có thể làm ground truth cho session mới nếu trang đang
          ACTIVE.
        </StatusMessage>
      ) : detail.verification_status === "PROCESSING" ? (
        <StatusMessage className="mb-6" title="PROCESSING" tone="info">
          Đang tạo revision mới. Revision cũ vẫn được giữ nguyên.
        </StatusMessage>
      ) : null}
      {notice ? (
        <StatusMessage
          className="mb-6"
          tone={
            notice.startsWith("Không thể") || notice.startsWith("Lỗi")
              ? "error"
              : "info"
          }
        >
          {notice}
        </StatusMessage>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,1fr)]">
        <Card className="bg-white xl:sticky xl:top-4 xl:self-start">
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
          <section
            aria-label="Chẩn đoán checkpoint VietOCR runtime"
            className="mt-4 rounded-control border border-border bg-canvas p-4"
          >
            <h2 className="font-extrabold text-ink">
              Admin OCR Diagnostics · runtime checkpoint
            </h2>
            <p className="mt-1 text-xs text-muted">
              Bằng chứng ghi tại lượt Scan từ Predictor thực sự đã nạp; không
              lấy SHA từ lựa chọn model trên Supabase.
            </p>
            <dl className="mt-3 grid gap-2 text-sm">
              <div>
                <dt className="font-semibold">Model thực tế</dt>
                <dd>{runtimeEvidence.modelProfile}</dd>
              </div>
              <div>
                <dt className="font-semibold">Checkpoint SHA256 đã xác minh</dt>
                <dd className="break-all font-mono text-xs">
                  {runtimeEvidence.checkpointSha256 ??
                    "Không có bằng chứng checkpoint được dùng"}
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Trạng thái nạp / inference</dt>
                <dd>
                  {runtimeEvidence.modelLoadStatus}
                  {" · "}
                  {runtimeEvidence.modelInferenceStatus}
                </dd>
              </div>
              <div>
                <dt className="font-semibold">Fallback</dt>
                <dd>{runtimeEvidence.fallbackReason ?? "Không ghi nhận"}</dd>
              </div>
              <div>
                <dt className="font-semibold">VietOCR package</dt>
                <dd>{runtimeEvidence.engineVersion ?? "Chưa xác định"}</dd>
              </div>
            </dl>
            {!runtimeEvidence.verified ? (
              <p className="mt-2 text-xs text-muted">
                Scan này chưa chứng minh checkpoint VietOCR được nạp. Không suy
                diễn từ profile đang active hoặc revision cũ.
              </p>
            ) : null}
          </section>
          <section className="mt-4 rounded-control border border-border bg-canvas p-4">
            <h2 className="font-extrabold text-ink">OCR gốc (bất biến)</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-ink">
              {detail.original_ocr_text ??
                "Revision cũ chưa có bản chụp OCR gốc riêng. Các revision mới sẽ lưu OCR gốc bất biến."}
            </p>
          </section>
          <p className="mt-3 text-sm leading-6 text-muted">
            Xanh biểu thị Admin/reference đã xác minh hoặc hai OCR đồng thuận
            chính xác ở cấp từ với alignment, token mapping và bbox/crop hợp lệ;
            đồng thuận là evidence tốt, không đồng nghĩa Admin verified. Vàng
            dành cho từ thiếu evidence, bất đồng hoặc mapping/chất lượng chưa an
            toàn. Đỏ chỉ xuất hiện khi candidate không khớp reference đã xác
            minh trong alignment một-một rõ ràng. Raw OCR score và similarity
            heuristic không được sử dụng như xác suất đúng.
          </p>
          <div
            aria-label="Thống kê trạng thái từ OCR"
            className="mt-4 grid grid-cols-3 gap-2"
            role="group"
          >
            {(
              [
                {
                  id: "green",
                  label: "Xanh · evidence tốt",
                  count: colorCounts.green,
                  cardClass: "border-green-600/50 bg-green-50 text-green-900",
                },
                {
                  id: "yellow",
                  label: "Vàng · cần kiểm tra",
                  count: colorCounts.yellow,
                  cardClass: "border-amber-600/50 bg-amber-50 text-amber-950",
                },
                {
                  id: "red",
                  label: "Đỏ · reference xác nhận sai",
                  count: colorCounts.red,
                  cardClass: "border-red-600/50 bg-red-50 text-red-900",
                },
              ] as const
            ).map((state) => (
              <div
                className={`grid min-h-20 content-center gap-1 rounded-control border p-2 text-center text-xs font-semibold ${state.cardClass}`}
                key={state.id}
              >
                <strong className="text-xl leading-none">{state.count}</strong>
                <span>{state.label}</span>
              </div>
            ))}
          </div>
          <div
            aria-label="Chi tiết trạng thái evidence OCR"
            className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"
          >
            <span>
              Đã xác minh:{" "}
              {
                words.filter((word) => {
                  const status = getWordReviewStatus(
                    word,
                    detail.verification_status,
                  );
                  return status === "verified" || status === "reference_match";
                }).length
              }
            </span>
            <span>
              Engine đồng ý, chưa xác minh:{" "}
              {
                words.filter(
                  (word) =>
                    getWordReviewStatus(word, detail.verification_status) ===
                    "engine_agreement",
                ).length
              }
            </span>
            <span>
              Engine bất đồng:{" "}
              {
                words.filter(
                  (word) =>
                    getWordReviewStatus(word, detail.verification_status) ===
                    "engine_disagreement",
                ).length
              }
            </span>
            <span>
              Chưa có calibrated accuracy:{" "}
              {
                words.filter(
                  (word) => word.ocr_evidence?.calibrated_word_accuracy == null,
                ).length
              }
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              className="min-h-10 rounded-control border border-border px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!nextWordToReview}
              onClick={() => {
                if (nextWordToReview) {
                  selectWordOnImage(nextWordToReview.word_index);
                }
              }}
              type="button"
            >
              Đi tới từ cần kiểm tra
            </button>
            <span className="text-xs font-semibold text-muted">
              {nextWordToReview
                ? `Tiếp theo ${nextReviewPosition}/${wordsNeedingReview.length} từ cần xem`
                : "Không còn từ cần kiểm tra"}
            </span>
          </div>
        </Card>

        <div className="grid content-start gap-6">
          <Card className="bg-white">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold">Văn bản nháp</h2>
                <p className="mt-1 text-sm text-muted">
                  Chỉnh nội dung tại đây; các vùng từ và ảnh sẽ được đồng bộ.
                </p>
              </div>
            </div>
            <label className="grid gap-2 font-semibold" htmlFor="ocr-text">
              Nội dung trang
              <textarea
                aria-describedby="ocr-help"
                className="min-h-60 max-h-[32rem] resize-y rounded-control border border-border bg-white p-4 font-normal leading-7 outline-none focus:border-primary focus:outline-3 focus:outline-primary/30 disabled:bg-canvas"
                disabled={
                  verified ||
                  detail.lifecycle_status !== "ACTIVE" ||
                  busy !== null
                }
                id="ocr-text"
                onChange={(event) => handleDraftTextChange(event.target.value)}
                value={draftText}
              />
            </label>
            <p className="mt-2 text-sm text-muted" id="ocr-help">
              Khi bấm “XÁC NHẬN & CHẠY AI”, Backend bắt đầu Proofreading và
              Child Safety song song trên cùng OCR snapshot. Nếu Proofreading
              đổi nội dung, Safety tự quét lại Candidate theo hash mới. Ollama
              chỉ được dùng cuối cùng khi cloud không trả được inference hợp lệ.
              AI chỉ đề xuất; Admin quyết định nội dung VERIFIED.
            </p>
            {busy === "ai_correct" ? (
              <div
                aria-live="polite"
                className="mt-4 grid gap-3 rounded-control border border-purple-300 bg-purple-50 p-4 text-sm text-purple-950"
                role="status"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-semibold">
                    {aiProgress?.status === "QUEUED"
                      ? "Workflow đang chờ worker"
                      : aiProgress?.status === "PROOFREADING"
                        ? `Proofreading · đoạn ${aiProgress.progress.completed_chunks}/${aiProgress.progress.total_chunks}`
                        : aiProgress?.status === "CHILD_SAFETY_SCANNING"
                          ? "Proofreading xong · Child Safety đang quét"
                          : aiProgress?.status === "FAILED"
                            ? "Workflow gặp lỗi"
                            : aiProgress?.status === "READY_FOR_ADMIN_REVIEW"
                              ? "Proofreading và Child Safety hoàn tất"
                              : "Đang chuẩn bị workflow bền vững…"}
                  </span>
                  <Button
                    className="min-h-9 w-auto border-red-300 px-3 text-red-800 hover:bg-red-50"
                    onClick={cancelAiCorrection}
                    type="button"
                    variant="secondary"
                  >
                    <X aria-hidden className="size-4" /> Dừng theo dõi
                  </Button>
                </div>
                <progress
                  aria-label="Tiến độ AI OCR"
                  className="h-2 w-full accent-purple-700"
                  max={aiProgress?.progress.total_chunks ?? 1}
                  value={aiProgress?.progress.completed_chunks ?? 0}
                />
                <span className="text-xs text-purple-900">
                  Kết quả chỉ là gợi ý. Bản nháp sẽ không đổi cho đến khi bạn áp
                  dụng.
                </span>
              </div>
            ) : null}
            {wordSyncError ? (
              <p
                aria-live="polite"
                className="mt-3 rounded-control border border-red-500/50 bg-red-50 p-3 text-sm text-red-800"
                role="alert"
              >
                {wordSyncError}
              </p>
            ) : null}
            {aiSuggestion !== null ? (
              <section
                aria-labelledby="ai-correction-review-title"
                className="mt-4 grid gap-4 rounded-control border border-purple-300 bg-purple-50 p-4"
                role="region"
              >
                <div>
                  <h3
                    className="text-lg font-semibold text-purple-950"
                    id="ai-correction-review-title"
                  >
                    Rà soát đề xuất AI
                  </h3>
                  <p className="mt-1 text-sm text-purple-900">
                    Có {aiChanges.length} gợi ý chính tả/OCR. Các bbox được giữ
                    nguyên; gợi ý chưa được lưu. AI không cung cấp điểm tin cậy
                    cấp từ; Admin cần đối chiếu từng gợi ý với ảnh. Từ được chọn
                    sẽ chấp nhận; từ bỏ chọn sẽ bị từ chối.
                  </p>
                  <p
                    aria-live="polite"
                    className="mt-1 text-sm font-semibold text-purple-950"
                  >
                    Đã chọn {aiAcceptedChanges.size} / {aiChanges.length} đề
                    xuất. Chọn thay đổi bên dưới hoặc dùng “Chọn tất cả”.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="min-h-9 w-auto px-3"
                    onClick={() =>
                      setAiAcceptedChanges(
                        new Set(aiChanges.map((change) => change.index)),
                      )
                    }
                    type="button"
                    variant="secondary"
                  >
                    Chọn tất cả
                  </Button>
                  <Button
                    className="min-h-9 w-auto px-3"
                    onClick={() => setAiAcceptedChanges(new Set())}
                    type="button"
                    variant="secondary"
                  >
                    Bỏ chọn tất cả
                  </Button>
                  <Button
                    className="min-h-9 w-auto px-3"
                    onClick={() => {
                      setAiSuggestion(null);
                      setAiAcceptedChanges(new Set());
                      setAiDiffPage(0);
                      setNotice(
                        "Đã bỏ đề xuất AI. Bản nháp hiện tại được giữ nguyên.",
                      );
                    }}
                    type="button"
                    variant="quiet"
                  >
                    Bỏ đề xuất
                  </Button>
                </div>
                <div
                  aria-live="polite"
                  className="text-xs font-semibold text-muted"
                >
                  Trang {Math.min(aiDiffPage + 1, aiDiffPageCount)} /{" "}
                  {aiDiffPageCount}
                  {aiChanges.length > aiDiffPageSize
                    ? ` · hiển thị tối đa ${aiDiffPageSize} thay đổi mỗi trang`
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
                      ? getWordScoreLabel(originalWord, detail.ocr_metadata)
                      : "Không có điểm OCR riêng cho từ này";
                    return (
                      <li
                        className="rounded-control border border-purple-200 bg-white p-3"
                        key={change.index}
                      >
                        <label className="flex cursor-pointer items-start gap-3">
                          <input
                            aria-label={`Duyệt đề xuất cho từ ${change.index + 1}`}
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
                              Từ {change.index + 1}
                            </span>
                            <span className="flex flex-wrap items-center gap-2 break-words">
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
                            <span className="mt-2 grid gap-1 text-xs">
                              <span>
                                Từ OCR:{" "}
                                {getWordReviewLabel(
                                  originalStatus,
                                  originalWord,
                                  originalPaddleLineScore,
                                )}{" "}
                                · {originalScoreLabel}
                              </span>
                              <span className="text-amber-900">
                                Vì sao AI gợi ý: nội dung khác với bản OCR khi
                                đối chiếu ảnh và ngữ cảnh. Đây chỉ là gợi ý;
                                không có điểm tin cậy riêng cho từ này.
                              </span>
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {aiDiffPageCount > 1 ? (
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      className="min-h-9 w-auto px-3"
                      disabled={aiDiffPage === 0}
                      onClick={() =>
                        setAiDiffPage((page) => Math.max(0, page - 1))
                      }
                      type="button"
                      variant="secondary"
                    >
                      <ChevronLeft aria-hidden className="size-4" /> Trang trước
                    </Button>
                    <Button
                      className="min-h-9 w-auto px-3"
                      disabled={aiDiffPage + 1 >= aiDiffPageCount}
                      onClick={() =>
                        setAiDiffPage((page) =>
                          Math.min(aiDiffPageCount - 1, page + 1),
                        )
                      }
                      type="button"
                      variant="secondary"
                    >
                      Trang sau <ChevronRight aria-hidden className="size-4" />
                    </Button>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-purple-200 pt-3">
                  <Button
                    className="sm:w-auto"
                    onClick={applySelectedAiChanges}
                    type="button"
                  >
                    <CheckCircle2 aria-hidden className="size-4" /> Xác nhận lựa
                    chọn gợi ý
                  </Button>
                </div>
              </section>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-3">
              {verified ? (
                <Button
                  className="sm:w-auto"
                  disabled={
                    busy !== null ||
                    detail.lifecycle_status !== "ACTIVE" ||
                    !isCurrentVerifiedRevision
                  }
                  isLoading={busy === "edit"}
                  onClick={() => void createEditDraft()}
                  variant="secondary"
                >
                  <Save aria-hidden className="size-4" /> Tạo bản nháp để sửa
                  nội dung
                </Button>
              ) : (
                <>
                  <Button
                    className="sm:w-auto"
                    disabled={
                      busy !== null ||
                      detail.lifecycle_status !== "ACTIVE" ||
                      wordSyncError !== null
                    }
                    isLoading={busy === "save"}
                    onClick={() => void saveDraft()}
                    variant="secondary"
                  >
                    <Save aria-hidden className="size-4" /> Lưu bản nháp
                  </Button>

                  <Button
                    className="sm:w-auto"
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
                    type="button"
                  >
                    {proofreadAudit ? (
                      <CheckCircle2 aria-hidden className="size-4" />
                    ) : (
                      <Sparkles aria-hidden className="size-4" />
                    )}
                    {busy === "ai_correct"
                      ? "Proofreading và Child Safety đang chạy…"
                      : proofreadAudit || aiWorkflow?.proofread_text
                        ? "XÁC NHẬN VÀ LƯU NỘI DUNG CUỐI CÙNG"
                        : "XÁC NHẬN & CHẠY AI"}
                  </Button>
                  {aiWorkflow?.proofread_text &&
                  workflowFinalApprovalBlocked ? (
                    <p
                      className="basis-full text-sm text-amber-900"
                      role="status"
                    >
                      {workflowHasHighRisk
                        ? "Safety có cảnh báo mức HIGH hoặc NOT_RECOMMENDED. Luồng hiện tại chưa có chính sách Admin override cho trường hợp này nên chưa thể lưu VERIFIED."
                        : workflowImageFlaggedUnsafe
                          ? "Hình ảnh trang đã bị Admin đánh dấu không phù hợp nên không thể xác minh."
                          : workflowImageUnassessed
                            ? "Chưa có AI kiểm tra an toàn hình ảnh. Admin cần kiểm tra trực tiếp ảnh trang và xác nhận an toàn hình ảnh trước khi xác minh."
                            : aiWorkflow.safety_status !== "CONFIRMED" &&
                                !workflowCanAutoConfirmSafety
                              ? "Cần Child Safety hoàn tất cho Candidate hiện tại; tự xác nhận chỉ áp dụng khi kết quả SUITABLE và không có finding."
                              : "Safety hash chưa khớp Candidate hiện tại; hãy chờ quét lại trước khi lưu VERIFIED."}
                    </p>
                  ) : null}
                  {aiCheckUnavailable && proofreadAudit === null ? (
                    <Button
                      className="sm:w-auto"
                      disabled={busy !== null}
                      onClick={continueManualVerification}
                      type="button"
                      variant="secondary"
                    >
                      Tiếp tục xác minh thủ công
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </Card>

          {aiWorkflow ? (
            <Card className="bg-white" data-testid="admin-ai-workflow">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-black">
                    Child Safety · GRADE_1_TO_5
                  </h2>
                  <p className="mt-1 text-sm text-muted">
                    Quét văn bản Candidate sau Proofreading. Kết quả là
                    provisional cho đến khi Admin xác nhận.
                  </p>
                </div>
                <span className="rounded-full border border-border px-3 py-1 text-sm font-bold">
                  {aiWorkflow.status === "READY_FOR_ADMIN_REVIEW"
                    ? "Sẵn sàng Admin review"
                    : aiWorkflow.status === "FAILED"
                      ? `Lỗi · ${aiWorkflow.error_code ?? "UNKNOWN"}`
                      : aiWorkflow.stage === "PROOFREADING"
                        ? "Đang Proofreading"
                        : aiWorkflow.stage === "CHILD_SAFETY_SCANNING"
                          ? "Đang quét Safety"
                          : "Đang chờ xử lý"}
                </span>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="min-w-0 rounded-control bg-canvas p-3">
                  <p className="text-xs text-muted">Overall suitability</p>
                  <p className="mt-1 break-words font-extrabold text-ink">
                    {aiWorkflow.suitability ?? "CHƯA CÓ KẾT QUẢ"}
                  </p>
                </div>
                <div className="min-w-0 rounded-control bg-canvas p-3">
                  <p className="text-xs text-muted">
                    An toàn văn bản (Text Safety)
                  </p>
                  <p className="mt-1 break-words font-extrabold text-ink">
                    {aiWorkflow.text_safety_status ?? aiWorkflow.safety_status}
                  </p>
                </div>
                <div className="min-w-0 rounded-control bg-canvas p-3 sm:col-span-2">
                  <p className="text-xs text-muted">
                    An toàn hình ảnh (Image Safety)
                  </p>
                  <p
                    className="mt-1 break-words font-extrabold text-ink"
                    data-testid="image-safety-status"
                  >
                    {workflowImageSafetyStatus === "ADMIN_CONFIRMED_SAFE"
                      ? "Admin đã xác nhận ảnh an toàn"
                      : workflowImageSafetyStatus === "ADMIN_FLAGGED_UNSAFE"
                        ? "Admin gắn cờ ảnh không phù hợp"
                        : "Chưa đánh giá ảnh (chưa có model vision)"}
                  </p>
                </div>
                <div className="min-w-0 rounded-control bg-canvas p-3">
                  <p className="text-xs text-muted">Candidate version</p>
                  <p className="mt-1 break-words font-extrabold text-ink">
                    {aiWorkflow.candidate_version}
                  </p>
                </div>
                <div className="min-w-0 rounded-control bg-canvas p-3">
                  <p className="text-xs text-muted">Safety hash match</p>
                  <p className="mt-1 break-words font-extrabold text-ink">
                    {candidateEditPending
                      ? "Đang lưu Candidate…"
                      : aiWorkflow.hash_match
                        ? "Khớp Candidate hiện tại"
                        : "Chưa khớp / cần quét lại"}
                  </p>
                </div>
              </div>

              <div
                className="mt-4 rounded-control border border-border bg-canvas/60 p-3"
                data-testid="image-safety-review-panel"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-extrabold text-ink">
                      Kiểm tra an toàn hình ảnh (Admin kiểm tra thủ công)
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      AI Child Safety hiện chỉ đánh giá văn bản (không kiểm tra
                      nội dung trực quan trong ảnh). Admin cần đối chiếu ảnh
                      trang sách trước khi xác nhận.
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-3">
                  <label className="block w-full text-xs font-bold text-ink">
                    Ghi chú kiểm tra ảnh (bắt buộc nếu gắn cờ không phù hợp)
                    <input
                      className="mt-1 h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal"
                      maxLength={500}
                      onChange={(event) =>
                        setImageSafetyReason(event.target.value)
                      }
                      placeholder="Ví dụ: Ảnh minh họa rõ nét, phù hợp học sinh tiểu học"
                      type="text"
                      value={imageSafetyReason}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="h-10 w-auto px-3"
                      disabled={busy !== null}
                      isLoading={busy === "workflow"}
                      onClick={() =>
                        void decideImageSafety("ADMIN_CONFIRMED_SAFE")
                      }
                      type="button"
                      variant="secondary"
                    >
                      <CheckCircle2 aria-hidden className="size-4" /> Xác nhận
                      ảnh an toàn
                    </Button>
                    <Button
                      className="h-10 w-auto px-3"
                      disabled={busy !== null || !imageSafetyReason.trim()}
                      isLoading={busy === "workflow"}
                      onClick={() =>
                        void decideImageSafety("ADMIN_FLAGGED_UNSAFE")
                      }
                      type="button"
                      variant="secondary"
                    >
                      Gắn cờ ảnh không phù hợp
                    </Button>
                  </div>
                </div>
              </div>

              {aiWorkflow.uncertain_word_indices.length > 0 ? (
                <p className="mt-4 rounded-control border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
                  Proofreading còn {aiWorkflow.uncertain_word_indices.length} từ
                  chưa chắc chắn (vị trí{" "}
                  {aiWorkflow.uncertain_word_indices
                    .map((index) => index + 1)
                    .join(", ")}
                  ). Các từ này được giữ nguyên để Admin đối chiếu.
                </p>
              ) : null}

              <dl className="mt-4 grid gap-2 break-all rounded-control border border-border p-3 font-mono text-xs">
                <div>
                  <dt className="font-bold">CandidateHash</dt>
                  <dd>{aiWorkflow.candidate_hash ?? "—"}</dd>
                </div>
                <div>
                  <dt className="font-bold">SafetyInputHash</dt>
                  <dd>{aiWorkflow.safety_input_hash ?? "—"}</dd>
                </div>
                <div>
                  <dt className="font-bold">FinalApprovedTextHash</dt>
                  <dd>
                    {aiWorkflow.final_approved_text_hash ??
                      "Chưa xác nhận OCR cuối cùng"}
                  </dd>
                </div>
              </dl>

              {aiWorkflow.status === "FAILED" ||
              aiWorkflow.safety_status === "FAILED"
                ? (() => {
                    const safetyFailure =
                      aiWorkflow.stage === "CHILD_SAFETY_SCANNING" ||
                      (aiWorkflow.proofread_text !== null &&
                        aiWorkflow.safety_status === "FAILED");
                    const failureEvent = [...aiWorkflow.provider_events]
                      .reverse()
                      .find(
                        (event) =>
                          Boolean(event.error_code) &&
                          (!event.stage || event.stage === aiWorkflow.stage),
                      );
                    const failedStageEvent = [...aiWorkflow.review_history]
                      .reverse()
                      .find(
                        (event) =>
                          event.event === "WORKFLOW_STAGE_FAILED" &&
                          event.stage ===
                            (safetyFailure
                              ? "CHILD_SAFETY_SCANNING"
                              : "PROOFREADING"),
                      );
                    const recordedFailureCode = failedStageEvent?.error_code;
                    const failureCode =
                      aiWorkflow.error_code ??
                      (typeof recordedFailureCode === "string"
                        ? recordedFailureCode
                        : null);
                    const failureMessage =
                      failureCode === "INVALID_EVIDENCE"
                        ? "AI trả về evidence không thể đối chiếu chính xác với Candidate. Nội dung OCR và Candidate vẫn được giữ nguyên."
                        : failureCode === "INVALID_JSON"
                          ? "Provider trả về JSON không hợp lệ; kết quả Safety chưa được lưu."
                          : failureCode === "MISSING_REQUIRED_FIELDS"
                            ? "Provider thiếu trường bắt buộc; Safety chưa được xác nhận."
                            : failureCode === "INVALID_OUTPUT_SCHEMA"
                              ? "Provider trả kết quả không đúng cấu trúc Safety yêu cầu."
                              : failureCode === "PROVIDER_TIMEOUT"
                                ? "Provider hết thời gian chờ; Candidate chưa được đánh giá an toàn."
                                : failureCode === "PROVIDER_UNAVAILABLE"
                                  ? "Provider không khả dụng; Candidate chưa được đánh giá an toàn."
                                  : safetyFailure
                                    ? "Safety chưa hoàn tất; Candidate hiện tại chưa được đánh giá an toàn."
                                    : "Proofreading chưa hoàn tất; Candidate hiện tại chưa được cập nhật.";
                    return (
                      <div
                        className="mt-4 rounded-control border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950"
                        role="alert"
                      >
                        <p className="font-bold">
                          {safetyFailure
                            ? "Child Safety chưa hoàn tất."
                            : "Proofreading chưa hoàn tất."}
                        </p>
                        <p className="mt-1">{failureMessage}</p>
                        <p className="mt-1">
                          Lỗi: {failureCode ?? "UNKNOWN"}
                          {failureEvent?.provider
                            ? ` · Provider ${String(failureEvent.provider)}`
                            : ""}
                          {failureEvent?.model
                            ? ` · Model ${String(failureEvent.model)}`
                            : ""}
                          {failureEvent?.duration_ms != null
                            ? ` · ${String(failureEvent.duration_ms)} ms`
                            : ""}
                          {` · Lần thử ${aiWorkflow.attempts}`}
                          {` · ${new Date(aiWorkflow.updated_at).toLocaleString("vi-VN")}`}
                        </p>
                        <p className="mt-1">
                          {safetyFailure
                            ? "Có thể thử lại riêng giai đoạn Safety; Proofreading và OCR được giữ nguyên."
                            : "Có thể thử lại riêng Proofreading; OCR được giữ nguyên."}
                        </p>
                      </div>
                    );
                  })()
                : null}

              {aiWorkflow.status === "READY_FOR_ADMIN_REVIEW" &&
              aiWorkflow.safety_status === "STALE" ? (
                <p
                  className="mt-4 rounded-control border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950"
                  role="status"
                >
                  Candidate đã đổi sau Proofreading. Child Safety cần chạy riêng
                  trên Candidate mới trước khi xác minh hoặc xuất bản.
                </p>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-2">
                {aiWorkflow.status === "FAILED" ||
                (aiWorkflow.proofread_text !== null &&
                  (aiWorkflow.safety_status === "FAILED" ||
                    aiWorkflow.safety_status === "STALE") &&
                  !["QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"].includes(
                    aiWorkflow.status,
                  )) ? (
                  <Button
                    className="h-10 w-auto px-3"
                    disabled={busy !== null}
                    isLoading={busy === "workflow"}
                    onClick={() => void retryWorkflow()}
                    type="button"
                    variant="secondary"
                  >
                    <RefreshCw aria-hidden className="size-4" />
                    {aiWorkflow.status === "FAILED" &&
                    aiWorkflow.stage === "PROOFREADING"
                      ? "Thử lại Proofreading"
                      : "Thử lại Child Safety"}
                  </Button>
                ) : null}
                {aiWorkflow.safety_status === "PROVISIONAL" &&
                aiWorkflow.hash_match &&
                (aiWorkflow.findings.length > 0 ||
                  aiWorkflow.suitability !== "SUITABLE") ? (
                  <label className="basis-full text-sm font-bold text-ink">
                    Lý do Admin xem xét Safety · bắt buộc
                    <textarea
                      className="mt-1 min-h-20 w-full rounded-control border border-border bg-white p-3 font-normal"
                      maxLength={500}
                      onChange={(event) =>
                        setSafetyDecisionReason(event.target.value)
                      }
                      value={safetyDecisionReason}
                    />
                  </label>
                ) : null}
                {aiWorkflow.safety_status === "PROVISIONAL" &&
                aiWorkflow.hash_match ? (
                  <Button
                    className="h-10 w-auto px-3"
                    disabled={
                      busy !== null ||
                      candidateEditPending ||
                      ((Boolean(aiWorkflow.findings.length) ||
                        aiWorkflow.suitability !== "SUITABLE") &&
                        !safetyDecisionReason.trim())
                    }
                    isLoading={busy === "workflow"}
                    onClick={() => void decideSafety(true)}
                    type="button"
                    variant="secondary"
                  >
                    <CheckCircle2 aria-hidden className="size-4" /> Xác nhận kết
                    quả Safety
                  </Button>
                ) : aiWorkflow.safety_status === "CONFIRMED" &&
                  aiWorkflow.hash_match ? (
                  <Button
                    className="h-10 w-auto px-3"
                    disabled={busy !== null}
                    isLoading={busy === "workflow"}
                    onClick={() => void decideSafety(false)}
                    type="button"
                    variant="secondary"
                  >
                    Bỏ xác nhận Safety
                  </Button>
                ) : null}
              </div>

              <section className="mt-5">
                <h3 className="font-extrabold">Safety findings</h3>
                {aiWorkflow.findings.length ? (
                  <ul className="mt-2 grid gap-3">
                    {aiWorkflow.findings.map((finding, index) => {
                      const severity = String(
                        finding.severity ?? "REVIEW",
                      ).toUpperCase();
                      const category = String(
                        finding.category ?? "OTHER_SENSITIVE",
                      ).replaceAll("_", " ");
                      const evidence = String(finding.evidence_text ?? "");
                      const compactEvidence =
                        evidence.length > 240
                          ? evidence.slice(0, 240).trimEnd() + "…"
                          : evidence;
                      const high = severity === "HIGH";
                      return (
                        <li key={String(finding.finding_id ?? index)}>
                          <details
                            className={
                              "rounded-control border p-3 " +
                              (high
                                ? "border-red-400 bg-red-50"
                                : "border-border bg-white")
                            }
                          >
                            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 focus-visible:outline-3 focus-visible:outline-primary">
                              <span className="font-extrabold">{category}</span>
                              <span className="text-xs text-muted">
                                {String(
                                  finding.content_type ?? "MENTION",
                                ).replaceAll("_", " ")}
                              </span>
                              <span
                                className={
                                  "rounded-full px-2.5 py-1 text-xs font-extrabold " +
                                  (high
                                    ? "bg-red-700 text-white"
                                    : "bg-canvas text-ink")
                                }
                              >
                                {severity}
                              </span>
                              <span className="ml-auto text-xs text-muted">
                                Mở chi tiết
                              </span>
                            </summary>
                            <div className="mt-3 border-t border-border pt-3">
                              <p className="text-xs font-bold uppercase tracking-wide text-muted">
                                Bằng chứng
                              </p>
                              <blockquote className="mt-1 border-l-2 border-primary pl-3 text-sm">
                                “{compactEvidence}”
                                <span className="ml-2 font-mono text-xs text-muted">
                                  [{String(finding.evidence_start ?? "?")}–
                                  {String(finding.evidence_end ?? "?")}]
                                </span>
                              </blockquote>
                              {evidence.length > 240 ? (
                                <details className="mt-2 text-sm">
                                  <summary className="cursor-pointer font-bold text-primary">
                                    Xem toàn bộ trích dẫn nguyên văn (
                                    {evidence.length} ký tự)
                                  </summary>
                                  <blockquote className="mt-2 border-l-2 border-primary pl-3">
                                    “{evidence}”
                                  </blockquote>
                                </details>
                              ) : null}
                              <p className="mt-3 text-xs font-bold uppercase tracking-wide text-muted">
                                Giải thích
                              </p>
                              <p className="mt-1 text-sm">
                                {String(finding.explanation ?? "")}
                              </p>
                              <p className="mt-3 text-xs font-bold uppercase tracking-wide text-muted">
                                Khuyến nghị
                              </p>
                              <p className="mt-1 text-sm text-muted">
                                {String(finding.recommendation ?? "")}
                              </p>
                            </div>
                          </details>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted">
                    {aiWorkflow.safety_status === "PROVISIONAL" ||
                    aiWorkflow.safety_status === "CONFIRMED" ||
                    aiWorkflow.safety_status === "AUTO_CONFIRMED"
                      ? "AI chưa phát hiện finding trong Candidate này."
                      : "Findings sẽ hiển thị sau khi Safety hoàn tất."}
                  </p>
                )}
              </section>

              {aiWorkflow.safety_history.length > 0 ? (
                <section className="mt-5">
                  <h3 className="font-extrabold">
                    Safety history · kết quả cũ
                  </h3>
                  <p className="mt-1 text-xs text-muted">
                    Các scan này chỉ phục vụ audit; không áp dụng cho Candidate
                    hiện tại.
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
                          className="rounded-control border border-border p-3"
                          key={`${String(scan.scan_id ?? scanIndex)}-${scanIndex}`}
                        >
                          <summary className="cursor-pointer text-sm font-bold">
                            {String(scan.status ?? "UNKNOWN")} ·{" "}
                            {String(scan.suitability ?? "Chưa có suitability")}
                            {` · ${historicalFindings.length} finding`}
                            {scan.content_hash
                              ? ` · hash ${String(scan.content_hash).slice(0, 12)}…`
                              : " · chưa có hash"}
                          </summary>
                          {historicalFindings.length ? (
                            <ul className="mt-2 grid gap-2">
                              {historicalFindings.map(
                                (finding, findingIndex) => {
                                  return (
                                    <li
                                      className="border-l-2 border-border pl-3 text-sm"
                                      key={`${String(finding.finding_id ?? findingIndex)}-${findingIndex}`}
                                    >
                                      <p className="font-bold">
                                        {String(
                                          finding.category ?? "OTHER_SENSITIVE",
                                        )}{" "}
                                        ·{" "}
                                        {String(finding.severity ?? "UNKNOWN")}
                                      </p>
                                      <p>
                                        “{String(finding.evidence_text ?? "")}”
                                      </p>
                                    </li>
                                  );
                                },
                              )}
                            </ul>
                          ) : (
                            <p className="mt-2 text-sm">
                              Không có finding trong scan lịch sử.
                            </p>
                          )}
                        </details>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              <section className="mt-5">
                <h3 className="font-extrabold">Provider và model provenance</h3>
                <p className="mt-1 break-all font-mono text-xs text-muted">
                  Run{" "}
                  {String(
                    aiWorkflow.proofread_metadata.run_id ??
                      aiWorkflow.workflow_id,
                  )}
                  {" · Prompt "}
                  {String(aiWorkflow.proofread_metadata.prompt_version ?? "—")}
                  {" · "}
                  {String(
                    aiWorkflow.proofread_metadata.processing_time_ms ?? 0,
                  )}{" "}
                  ms
                  {" · Safety prompt "}
                  {String(aiWorkflow.safety_metadata.prompt_version ?? "—")}
                </p>
                {aiWorkflow.provider_events.length ? (
                  <ul className="mt-2 grid gap-2 text-xs">
                    {aiWorkflow.provider_events.map((event, index) => (
                      <li
                        className="rounded-control bg-canvas p-3"
                        key={`${String(event.provider ?? "provider")}-${index}`}
                      >
                        <span className="font-bold">
                          {String(event.provider ?? "—")}
                        </span>
                        {" · "}
                        {String(event.model ?? "—")}
                        {" · "}
                        {event.availability === true
                          ? "khả dụng"
                          : event.availability === false
                            ? "không khả dụng"
                            : "đang kiểm tra"}
                        {" · HTTP "}
                        {String(event.http_status ?? "—")}
                        {" · "}
                        {String(event.duration_ms ?? 0)} ms
                        {event.output_mode
                          ? ` · ${String(event.output_mode)}`
                          : ""}
                        {Number(event.retry_count ?? 0) > 0
                          ? ` · fallback ${String(event.retry_count)}`
                          : ""}
                        {event.error_code
                          ? ` · ${String(event.error_code)}`
                          : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted">
                    Chưa có provider event.
                  </p>
                )}
              </section>

              <p className="mt-4 text-xs text-muted">
                Kết quả AI không bảo đảm nội dung an toàn tuyệt đối. Với
                workflow AI, chỉ có thể lưu VERIFIED sau khi Admin xác nhận
                Safety cho đúng Candidate hiện tại.
              </p>
            </Card>
          ) : null}
          <div className="grid gap-3">
            <ButtonLink
              className="sm:max-w-[280px]"
              href={viewHref("words")}
              size="compact"
              variant="secondary"
            >
              Kiểm tra từ và vị trí
            </ButtonLink>
            <ButtonLink
              className="sm:max-w-[280px]"
              href={viewHref("history")}
              size="compact"
              variant="secondary"
            >
              Lịch sử xử lý OCR
            </ButtonLink>
          </div>

          <details className="rounded-card border border-border bg-white p-4">
            <summary className="cursor-pointer rounded-control font-semibold text-primary focus-visible:outline-3 focus-visible:outline-primary">
              Thông tin chi tiết từ OCR và lịch sử revision
            </summary>
            <div className="mt-4 grid gap-6">
              <Card className="bg-white">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-2xl font-semibold">Danh sách từ OCR</h2>
                    <p className="mt-1 text-sm text-muted">
                      Ưu tiên xem {colorCounts.red + colorCounts.yellow} từ cần
                      kiểm tra; {colorCounts.green} từ đã có evidence tốt, nhưng
                      nhóm xanh chưa đồng nghĩa với Admin verified.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="min-h-11 h-auto w-auto px-3 text-sm"
                      disabled={verified || busy !== null || words.length === 0}
                      onClick={reconcileAllMatchedWords}
                      type="button"
                      variant="secondary"
                    >
                      <CheckCircle2 aria-hidden className="size-4" /> Đồng bộ từ
                      khớp với văn bản
                    </Button>
                    <Button
                      className="min-h-11 h-auto w-auto px-3 text-sm"
                      disabled={verified || busy !== null}
                      onClick={syncTextFromWords}
                      variant="secondary"
                    >
                      Đồng bộ văn bản từ danh sách từ
                    </Button>
                  </div>
                </div>
                <p className="mb-4 text-sm text-muted">
                  Chọn một từ để làm nổi bật vùng trên ảnh. Bằng chứng engine
                  nằm trong chi tiết; tọa độ chỉ hiện khi mở phần chỉnh sửa nâng
                  cao.
                </p>
                <div
                  aria-live="polite"
                  className="mb-4 rounded-control border border-border bg-canvas px-3 py-2 text-sm text-muted"
                  role="status"
                >
                  <span className="font-semibold">
                    Đối chiếu văn bản ↔ vùng OCR:{" "}
                  </span>
                  {textAlignment.canCompare ? (
                    <>
                      {textAlignment.matched}/{words.length} từ khớp ·{" "}
                      {textAlignment.different} từ cần đối chiếu
                    </>
                  ) : (
                    "Chưa thể ghép từng từ vì số lượng từ chưa khớp."
                  )}
                </div>
                <div
                  aria-label="Lọc danh sách từ theo trạng thái"
                  className="mb-4 flex flex-wrap gap-2"
                  role="group"
                >
                  {(
                    [
                      { id: "all", label: "Tất cả", count: words.length },
                      {
                        id: "review",
                        label: "Cần xem",
                        count: colorCounts.red + colorCounts.yellow,
                      },
                      {
                        id: "risk",
                        label: "Rủi ro cao",
                        count: colorCounts.yellow,
                      },
                      {
                        id: "disagreement",
                        label: "Engine bất đồng",
                        count: words.filter((word) => {
                          return hasEngineDisagreementEvidence(word);
                        }).length,
                      },
                      {
                        id: "red",
                        label: "Đỏ · reference xác nhận sai",
                        count: colorCounts.red,
                      },
                      {
                        id: "green",
                        label: "Xanh · evidence tốt",
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
                      {filter.label} ({filter.count})
                    </button>
                  ))}
                  <span
                    aria-live="polite"
                    className="self-center text-xs font-semibold text-muted"
                  >
                    {wordFilter === "review"
                      ? `Còn ${filteredWords.length} từ cần chú ý`
                      : `Đang hiện ${filteredWords.length}/${words.length} từ`}
                  </span>
                </div>
                <div className="grid gap-3">
                  {filteredWords.length === 0 ? (
                    <p className="rounded-control border border-border bg-canvas p-4 text-sm text-muted">
                      {wordFilter === "review"
                        ? "Không có từ nào có mismatch hoặc thiếu bằng chứng cần ưu tiên."
                        : `Không có từ nào trong nhóm ${wordFilter === "risk" ? "vàng" : wordFilter === "red" ? "đỏ" : wordFilter === "green" ? "xanh" : wordFilter === "disagreement" ? "engine bất đồng" : "này"}.`}
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
                          className={`rounded-control border border-border border-l-4 p-3 transition-shadow ${
                            colorGroup === "green"
                              ? "border-l-green-600"
                              : colorGroup === "red"
                                ? "border-l-red-600"
                                : colorGroup === "yellow"
                                  ? "border-l-amber-500"
                                  : "border-l-slate-400"
                          } ${
                            word.word_index === selectedWord
                              ? "border-y-primary border-r-primary bg-sky/30 shadow-md ring-2 ring-primary/20"
                              : "bg-white hover:shadow-sm"
                          }`}
                          key={word.word_index}
                        >
                          <div className="mb-3 flex items-center justify-between gap-2">
                            <button
                              aria-pressed={word.word_index === selectedWord}
                              className="rounded-sm text-left text-sm font-semibold text-primary underline underline-offset-2"
                              onClick={() => selectWordOnImage(word.word_index)}
                              type="button"
                            >
                              Từ #{word.word_index} · Dòng {word.line_index}
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
                                    Reference đã xác minh không khớp
                                  </span>
                                  <span className="break-words">
                                    OCR đọc “{word.text}”
                                    {word.ocr_evidence?.reference_text
                                      ? ` · Bản đã xác minh: “${word.ocr_evidence.reference_text}”`
                                      : ""}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span className="font-semibold">
                                    Reference mismatch đã được xác nhận
                                  </span>
                                  <span className="break-words">
                                    Từ OCR: “{word.text}” ·{" "}
                                    {getWordScoreLabel(
                                      word,
                                      detail.ocr_metadata,
                                    )}
                                  </span>
                                  <span className="text-xs">
                                    Màu đỏ chỉ dùng cho mismatch đã được Admin
                                    hoặc reference đáng tin cậy xác nhận.
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
                              Văn bản trang ↔ từ gắn với vùng ảnh
                            </span>
                            <span className="break-words font-semibold">
                              {canCompareToken
                                ? `${draftToken} ↔ ${word.text}`
                                : "Không thể ghép từ này theo vị trí hiện tại"}
                              {canCompareToken ? (
                                <span className="ml-2 whitespace-nowrap text-xs font-semibold text-muted">
                                  {tokenMatches ? "Khớp" : "Cần đối chiếu"}
                                </span>
                              ) : null}
                            </span>
                          </div>

                          <label className="grid gap-1 text-sm font-semibold">
                            Chỉnh từ OCR - Từ {word.word_index + 1}
                            <input
                              className="min-h-10 rounded-control border border-border px-3 font-normal disabled:bg-canvas"
                              disabled={verified || busy !== null}
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
                              Tọa độ vùng ảnh · chỉnh sửa nâng cao
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
                                      aria-label={`Từ ${word.word_index} bbox ${label}`}
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
                          <details
                            className="mt-2 rounded-control border border-border bg-canvas"
                            open={word.word_index === selectedWord}
                          >
                            <summary className="cursor-pointer rounded-control px-3 py-2 text-sm font-semibold text-primary hover:bg-white focus-visible:outline-3 focus-visible:outline-primary">
                              Bằng chứng nhận dạng ·{" "}
                              {getWordScoreLabel(word, detail.ocr_metadata)}
                            </summary>
                            <section
                              aria-label={`Bằng chứng OCR từ ${word.word_index + 1}`}
                              className="grid gap-1 border-t border-border px-3 py-3 text-xs"
                            >
                              <h3 className="text-sm font-semibold">
                                Bằng chứng OCR
                              </h3>
                              <span>
                                PaddleOCR:{" "}
                                {getEngineEvidenceDisplay(
                                  word,
                                  "paddleocr",
                                  detail.ocr_metadata,
                                )}
                              </span>
                              <span>
                                VietOCR:{" "}
                                {getEngineEvidenceDisplay(
                                  word,
                                  "vietocr",
                                  detail.ocr_metadata,
                                )}
                              </span>
                              {typeof word.ocr_evidence?.engine_outputs
                                .paddleocr !== "string" &&
                              getLineEngineOutput(
                                word,
                                "paddleocr",
                                detail.ocr_metadata,
                              ) ? (
                                <span>
                                  PaddleOCR dòng gốc (không phải token căn
                                  chỉnh):{" "}
                                  {getLineEngineOutput(
                                    word,
                                    "paddleocr",
                                    detail.ocr_metadata,
                                  )}
                                </span>
                              ) : null}
                              {typeof word.ocr_evidence?.engine_outputs
                                .vietocr !== "string" &&
                              getLineEngineOutput(
                                word,
                                "vietocr",
                                detail.ocr_metadata,
                              ) ? (
                                <span>
                                  VietOCR dòng gốc (không phải token căn chỉnh):{" "}
                                  {getLineEngineOutput(
                                    word,
                                    "vietocr",
                                    detail.ocr_metadata,
                                  )}
                                </span>
                              ) : null}
                              <span>
                                Tesseract:{" "}
                                {getEngineEvidenceDisplay(
                                  word,
                                  "tesseract",
                                  detail.ocr_metadata,
                                )}
                              </span>
                              <span>
                                OCR source token:{" "}
                                {word.ocr_evidence?.source_text ??
                                  "Not recorded"}
                              </span>
                              {word.ocr_evidence?.source_text &&
                              normalizeVietnameseWord(
                                word.ocr_evidence.source_text,
                              ) !== normalizeVietnameseWord(word.text) ? (
                                <span className="text-amber-900">
                                  {`Evidence engine thuộc token OCR ban đầu “${word.ocr_evidence.source_text}”; từ hiện tại “${word.text}” đã được chỉnh sửa. Candidate/score gốc không đánh giá độ đúng của bản chỉnh sửa.`}
                                </span>
                              ) : null}
                              <span>
                                Alignment:{" "}
                                {word.ocr_evidence?.alignment ?? "Not computed"}
                              </span>
                              <span>
                                Điểm tương đồng giữa engine:{" "}
                                {word.ocr_evidence?.engine_agreement_score ===
                                  null ||
                                word.ocr_evidence?.engine_agreement_score ===
                                  undefined
                                  ? "Not computed"
                                  : `${Math.round(word.ocr_evidence.engine_agreement_score * 100)}/100 · heuristic, không phải xác suất`}
                              </span>
                              <span>
                                Reference text:{" "}
                                {word.ocr_evidence?.reference_text ??
                                  "Not provided"}
                              </span>
                              <span>
                                Nguồn xác minh:{" "}
                                {word.ocr_evidence?.verification_source ??
                                  "None"}
                              </span>
                              <span>
                                Calibrated accuracy:{" "}
                                {word.ocr_score_source ===
                                  "ocr_calibrated_word_accuracy_v1" &&
                                word.ocr_confidence !== null
                                  ? `${Math.round(word.ocr_confidence * 100)}%`
                                  : "Not calibrated · chưa có calibration evidence"}
                              </span>
                              <span>
                                Engine dùng cho bản nháp:{" "}
                                {word.ocr_evidence?.selected_engine ??
                                  "Not selected"}{" "}
                                · lựa chọn tạm thời, chưa phải verified
                              </span>
                              <span>
                                Lý do chọn candidate:{" "}
                                {word.ocr_evidence?.selection_reason ??
                                  "Not recorded"}
                              </span>
                              <span>
                                Hình học của box: {getWordGeometryLabel(word)}
                              </span>
                              <span>
                                Dấu câu: {getWordPunctuationLabel(word)}
                              </span>
                              <span>
                                Bounding box quality:{" "}
                                {word.ocr_evidence?.bbox_quality ??
                                  "Not assessed"}
                              </span>
                              <span>
                                Crop quality:{" "}
                                {word.ocr_evidence?.crop_quality ??
                                  "Not processed"}
                              </span>
                              {word.ocr_evidence?.crop_evidence ? (
                                <>
                                  <span>
                                    Crop PaddleOCR:{" "}
                                    {typeof word.ocr_evidence.crop_evidence
                                      .paddleocr_candidate === "string"
                                      ? word.ocr_evidence.crop_evidence
                                          .paddleocr_candidate
                                      : "No crop candidate recorded"}
                                  </span>
                                  <span>
                                    Crop VietOCR:{" "}
                                    {typeof word.ocr_evidence.crop_evidence
                                      .vietocr_candidate === "string"
                                      ? word.ocr_evidence.crop_evidence
                                          .vietocr_candidate
                                      : "No crop candidate recorded"}
                                  </span>
                                  <span>
                                    Crop Tesseract:{" "}
                                    {typeof word.ocr_evidence.crop_evidence
                                      .tesseract_candidate === "string"
                                      ? word.ocr_evidence.crop_evidence
                                          .tesseract_candidate
                                      : "Not run or no candidate"}
                                  </span>
                                  <span>
                                    Phân xử candidate:{" "}
                                    {typeof word.ocr_evidence.crop_evidence
                                      .adjudication_status === "string"
                                      ? word.ocr_evidence.crop_evidence
                                          .adjudication_status
                                      : "Not recorded"}
                                    {typeof word.ocr_evidence.crop_evidence
                                      .adjudication_support === "string" &&
                                    word.ocr_evidence.crop_evidence
                                      .adjudication_support
                                      ? ` · ${word.ocr_evidence.crop_evidence.adjudication_support}`
                                      : ""}
                                  </span>
                                  {typeof word.ocr_evidence.crop_evidence
                                    .text_before_adjudication === "string" ? (
                                    <span>
                                      Text trước phân xử:{" "}
                                      {
                                        word.ocr_evidence.crop_evidence
                                          .text_before_adjudication
                                      }
                                    </span>
                                  ) : null}
                                  <span>
                                    Paddle crop raw recognition score:{" "}
                                    {formatRawOcrEvidence(
                                      word.ocr_evidence.crop_evidence
                                        .paddle_crop_recognition_score,
                                    )}{" "}
                                    · not probability
                                  </span>
                                  <span>
                                    VietOCR crop raw recognition score:{" "}
                                    {formatRawOcrEvidence(
                                      word.ocr_evidence.crop_evidence
                                        .vietocr_crop_recognition_score,
                                    )}{" "}
                                    · not probability
                                  </span>
                                  <span>
                                    Crop status:{" "}
                                    {typeof word.ocr_evidence.crop_evidence
                                      .status === "string"
                                      ? word.ocr_evidence.crop_evidence.status
                                      : "Not processed"}
                                  </span>
                                  <span>
                                    VietOCR decoding mode:{" "}
                                    {typeof word.ocr_evidence.crop_evidence
                                      .vietocr_decoding_mode === "string"
                                      ? word.ocr_evidence.crop_evidence
                                          .vietocr_decoding_mode
                                      : "Not applicable"}
                                  </span>
                                  <span>
                                    Crop contrast (standard deviation):{" "}
                                    {formatRawOcrEvidence(
                                      word.ocr_evidence.crop_evidence
                                        .contrast_std,
                                    )}
                                  </span>
                                  <span>
                                    Ink ratio:{" "}
                                    {formatRawOcrEvidence(
                                      word.ocr_evidence.crop_evidence.ink_ratio,
                                    )}
                                  </span>
                                  <span>
                                    Padding clipped by page boundary:{" "}
                                    {typeof word.ocr_evidence.crop_evidence
                                      .padding_clipped === "boolean"
                                      ? word.ocr_evidence.crop_evidence
                                          .padding_clipped
                                        ? "Yes"
                                        : "No"
                                      : "Not assessed"}
                                  </span>
                                </>
                              ) : null}
                              <span>
                                Lý do trạng thái:{" "}
                                {word.ocr_evidence?.review_reason ??
                                  (colorGroup === "green"
                                    ? "Evidence supports a likely-correct OCR token; not Admin verified"
                                    : "Insufficient OCR evidence; Admin review required")}
                              </span>
                              <span>
                                {getPaddleLineScoreLabel(
                                  detail.ocr_metadata,
                                  word.line_index,
                                )}
                              </span>
                            </section>
                          </details>
                        </div>
                      );
                    })
                  )}
                </div>
              </Card>

              <Card className="bg-white">
                <h2 className="mb-3 text-2xl font-semibold">
                  Lịch sử revision
                </h2>
                <div className="grid gap-2">
                  {history.map((revision) => (
                    <button
                      className={
                        revision.page_revision_id === detail.page_revision_id
                          ? "rounded-control border-2 border-primary bg-sky p-3 text-left"
                          : "rounded-control border border-border p-3 text-left"
                      }
                      key={revision.page_revision_id}
                      disabled={busy !== null}
                      onClick={() =>
                        void chooseRevision(revision.page_revision_id)
                      }
                      type="button"
                    >
                      <span className="font-semibold">
                        Revision R{revision.revision_no}
                      </span>
                      <span className="ml-2 text-sm text-muted">
                        {revision.verification_status}
                        {revision.is_current_verified ? " · hiện hành" : ""}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="mt-4 grid gap-3">
                  <label
                    className="grid gap-2 text-sm font-semibold"
                    htmlFor="replacement-page-image"
                  >
                    Tải ảnh mới cho riêng trang này
                    <input
                      id="replacement-page-image"
                      accept="image/jpeg,image/png,image/webp"
                      className="block w-full rounded-control border border-border bg-white p-3 text-sm"
                      disabled={
                        busy !== null || detail.lifecycle_status !== "ACTIVE"
                      }
                      onChange={(event) =>
                        setReplacementFile(event.target.files?.[0] ?? null)
                      }
                      type="file"
                    />
                  </label>
                  {replacementFile ? (
                    <p className="text-sm text-muted">
                      Đã chọn: {replacementFile.name}
                    </p>
                  ) : null}
                  <Button
                    className="sm:w-auto"
                    disabled={
                      busy !== null ||
                      !replacementFile ||
                      detail.lifecycle_status !== "ACTIVE"
                    }
                    isLoading={busy === "reupload"}
                    onClick={() => void replaceImageAndReprocess()}
                    type="button"
                    variant="secondary"
                  >
                    <RefreshCw aria-hidden className="size-4" /> Tải ảnh mới và
                    chạy OCR
                  </Button>
                </div>
                <Button
                  className="mt-4 sm:w-auto"
                  disabled={
                    busy !== null || detail.lifecycle_status !== "ACTIVE"
                  }
                  isLoading={busy === "reprocess"}
                  onClick={() => void reprocess()}
                  variant="secondary"
                >
                  <RotateCcw aria-hidden className="size-4" /> Chạy lại OCR từ
                  ảnh đã lưu
                </Button>
                <Button
                  className="mt-4 sm:w-auto"
                  disabled={busy !== null}
                  onClick={() => void load()}
                  variant="quiet"
                >
                  <RefreshCw aria-hidden className="size-4" /> Tải lại dữ liệu
                </Button>
              </Card>
            </div>
          </details>
          <details className="rounded-card border border-border bg-white p-4">
            <summary className="cursor-pointer font-bold text-ink">
              Phân loại khối chữ thông minh (V2)
            </summary>
            <div className="mt-4">
              <SmartOcrBlockReviewLoader
                pageId={pageId}
                pageImageUrl={image.preview_url}
                pageNumber={image.page_number}
              />
            </div>
          </details>
        </div>
      </div>
    </>
  );
}

function OcrRevisionStatus({
  status,
}: {
  status: AdminPageRevisionDetailDTO["verification_status"];
}) {
  const tone =
    status === "VERIFIED"
      ? "bg-success-surface text-success-ink"
      : status === "PROCESSING"
        ? "bg-sky text-primary-hover"
        : "bg-warning-surface text-warning";

  return (
    <span
      className={`inline-flex min-h-9 min-w-[220px] items-center rounded-full px-4 text-sm font-bold ${tone}`}
    >
      {status}
    </span>
  );
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
  const selected =
    words.find((word) => word.word_index === selectedWord) ?? words[0] ?? null;
  const readOnly = status !== "NEEDS_REVIEW" || busy;

  return (
    <section className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <ButtonLink className="sm:max-w-[240px]" href={backHref} variant="quiet">
        ← Quay lại
      </ButtonLink>
      <header className="flex flex-col gap-2">
        <h1 className="text-heading font-extrabold text-ink">
          Kiểm tra từ và vị trí
        </h1>
        <p className="text-sm text-muted">
          {bookTitle} · Trang {pageNumber} · Revision R{revisionNo}
        </p>
        <OcrRevisionStatus status={status} />
      </header>

      <Card className="gap-4 bg-white sm:p-8">
        <h2 className="text-2xl font-extrabold text-ink">Từ và bounding box</h2>
        <ResponsiveTable
          ariaLabel="Bảng từ và bounding box"
          className="max-h-[360px] overflow-y-auto"
        >
          <table className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-sky text-primary-hover">
              <tr>
                <th className="px-3 py-3 font-bold">#</th>
                <th className="px-3 py-3 font-bold">Từ</th>
                <th className="px-3 py-3 font-bold">Confidence</th>
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
                    <td className="px-3 py-3">{word.word_index}</td>
                    <td className="px-3 py-2">
                      <input
                        aria-label={`Từ ${word.word_index + 1}`}
                        className="min-h-9 w-full min-w-20 scroll-mt-12 bg-transparent text-ink outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
                        disabled={readOnly}
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
                        ? "—"
                        : getOcrScoreLabel(word)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ResponsiveTable>

        {selected ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {(["x", "y", "w", "h"] as const).map((label, coordinate) => (
              <label
                className="grid min-h-[72px] gap-1 rounded-control border border-border bg-white px-4 py-3 text-sm text-muted"
                key={label}
              >
                <span>{label}</span>
                <input
                  aria-label={`${label} của từ ${selected.word_index + 1}`}
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
            Chưa có từ nào trong revision này.
          </p>
        )}

        {wordSyncError ? (
          <StatusMessage tone="error">{wordSyncError}</StatusMessage>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Button
            className="min-h-12"
            disabled={readOnly}
            onClick={onAddWord}
            size="compact"
            variant="secondary"
          >
            Thêm từ
          </Button>
          <Button
            className="min-h-12"
            disabled={readOnly || !selected}
            onClick={() => selected && onRemoveWord(selected.word_index)}
            size="compact"
            variant="quiet"
          >
            Xóa từ
          </Button>
        </div>
      </Card>

      <Button className="sm:max-w-[280px]" onClick={onComplete}>
        Hoàn tất kiểm tra
      </Button>
    </section>
  );
}

function AdminOcrHistoryPanel({
  backHref,
  bookTitle,
  busy,
  detail,
  history,
  notice,
  onChooseRevision,
  onReload,
  onReprocess,
  onReplacementFileChange,
  onReplaceImage,
  pageNumber,
  replacementFile,
}: {
  backHref: string;
  bookTitle: string;
  busy:
    | "edit"
    | "save"
    | "verify"
    | "reprocess"
    | "reupload"
    | "ai_correct"
    | "workflow"
    | null;
  detail: AdminPageRevisionDetailDTO;
  history: readonly AdminRevisionSummaryUI[];
  notice: string | null;
  onChooseRevision: (revisionId: string) => void;
  onReload: () => void;
  onReprocess: () => void;
  onReplacementFileChange: (file: File | null) => void;
  onReplaceImage: () => void;
  pageNumber: number;
  replacementFile: File | null;
}) {
  const processing = detail.verification_status === "PROCESSING";
  const canChangeImage = detail.lifecycle_status === "ACTIVE" && !processing;

  return (
    <section className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <ButtonLink className="sm:max-w-[240px]" href={backHref} variant="quiet">
        ← Quay lại
      </ButtonLink>
      <header className="flex flex-col gap-2">
        <h1 className="text-heading font-extrabold text-ink">
          Lịch sử xử lý OCR
        </h1>
        <p className="text-sm text-muted">
          {bookTitle} · Trang {pageNumber} · Revision R{detail.revision_no}
        </p>
        <OcrRevisionStatus status={detail.verification_status} />
      </header>

      {notice ? (
        <StatusMessage
          tone={
            notice.startsWith("Không thể") || notice.startsWith("Lỗi")
              ? "error"
              : "info"
          }
        >
          {notice}
        </StatusMessage>
      ) : null}

      <Card className="gap-4 bg-white sm:p-8">
        <h2 className="text-2xl font-extrabold text-ink">Lịch sử revision</h2>
        <div className="grid gap-2">
          {history.map((revision) => {
            const selected =
              revision.page_revision_id === detail.page_revision_id;
            return (
              <button
                className={`rounded-card p-4 text-left ${selected ? "bg-sky" : "border border-border"}`}
                key={revision.page_revision_id}
                onClick={() => onChooseRevision(revision.page_revision_id)}
                type="button"
              >
                <span className="block font-extrabold text-ink">
                  Revision R{revision.revision_no}
                </span>
                <span className="mt-1 block text-sm text-muted">
                  {revision.verification_status} ·{" "}
                  {revision.is_current_verified ? "hiện hành" : "đang xem"}
                </span>
              </button>
            );
          })}
        </div>

        <label
          className="grid gap-2 text-center text-sm font-semibold text-ink"
          htmlFor="replacement-page-image"
        >
          Tải ảnh mới cho riêng trang này
          <input
            id="replacement-page-image"
            accept="image/jpeg,image/png,image/webp"
            className="block w-full rounded-control border border-border bg-white p-3 text-sm"
            disabled={busy !== null || !canChangeImage}
            onChange={(event) =>
              onReplacementFileChange(event.target.files?.[0] ?? null)
            }
            type="file"
          />
        </label>
        {replacementFile ? (
          <p className="text-sm text-muted">Đã chọn: {replacementFile.name}</p>
        ) : null}
        <Button
          className="min-h-12"
          disabled={busy !== null || !replacementFile || !canChangeImage}
          isLoading={busy === "reupload"}
          onClick={onReplaceImage}
          size="compact"
          variant="secondary"
        >
          Tải ảnh mới và chạy OCR
        </Button>
        <Button
          className="min-h-12"
          disabled={busy !== null || !canChangeImage}
          isLoading={busy === "reprocess"}
          onClick={onReprocess}
          size="compact"
          variant="secondary"
        >
          Chạy lại OCR từ ảnh đã lưu
        </Button>
        <Button
          className="min-h-12"
          disabled={busy !== null}
          onClick={onReload}
          size="compact"
          variant="quiet"
        >
          Tải lại dữ liệu
        </Button>
      </Card>
    </section>
  );
}
