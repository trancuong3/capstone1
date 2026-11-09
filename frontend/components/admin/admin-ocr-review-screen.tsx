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
import { useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AdminLoading,
  AdminPageHeader,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import {
  AiCorrectionCancelledError,
  type AiCorrectionProgress,
} from "@/lib/api/ocr-review-service";
import {
  normalizeVietnameseWord,
  syncPageTextToWords,
  syncWordsToPageText,
  tokenizePageText,
} from "@/lib/ocr/sync-page-text-words";
import type {
  AdminBookDTO,
  AdminOcrReviewStatus,
  AdminPageImageUI,
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
  AdminRevisionWordDTO,
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
  const contractGroup = word?.review_color_group;
  if (
    contractGroup === "green" ||
    contractGroup === "yellow" ||
    contractGroup === "red"
  ) return contractGroup;
  if (status === "verified") return "green";
  if (!word?.ocr_evidence) return "yellow";

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
    ) return "red";
    return "yellow";
  }
  if (typeof source !== "string" || normalize(source) !== normalize(word.text)) {
    return "yellow";
  }

  const paddle = evidence.engine_outputs.paddleocr;
  const vietocr = evidence.engine_outputs.vietocr;
  const statuses = evidence.engine_statuses ?? {};
  const selectedEngine = evidence.selected_engine;
  const selectedCandidate =
    selectedEngine === "paddleocr" ? paddle :
    selectedEngine === "vietocr" ? vietocr : null;
  if (
    typeof paddle !== "string" || !paddle.trim() ||
    typeof vietocr !== "string" || !vietocr.trim() ||
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
  ) return "yellow";

  const crop = evidence.crop_evidence;
  if (crop) {
    if (
      !["not_needed", "completed"].includes(String(crop.status)) ||
      typeof crop.paddle_error === "string" ||
      typeof crop.vietocr_error === "string"
    ) return "yellow";
    if (crop.status === "completed") {
      const candidates = [crop.paddleocr_candidate, crop.vietocr_candidate];
      if (
        !candidates.every(
          (candidate) => typeof candidate === "string" && candidate.trim(),
        ) ||
        candidates.some(
          (candidate) =>
            typeof candidate === "string" && normalize(candidate) !== normalize(paddle),
        )
      ) return "yellow";
    }
  }
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
  const group = getWordReviewColorGroup(status, word);
  if (group === "green") {
    if (status === "verified") return "Admin đã xác minh từ";
    if (word?.ocr_evidence?.verification_source)
      return "Khớp reference của revision đã xác minh";
    return "Hai OCR đồng thuận · chưa đối chiếu reference";
  }
  if (group === "red") return "Sai so với reference đã xác minh";
  if (
    hasEngineDisagreementEvidence(word) &&
    hasDiacriticOnlyEngineDisagreement(word)
  ) return "Hai OCR chỉ khác dấu tiếng Việt · cần đối chiếu ảnh";
  if (hasEngineDisagreementEvidence(word)) {
    return "Hai OCR bất đồng · chưa thể xác định candidate đúng";
  }
  return (
    word?.ocr_evidence?.review_reason?.trim() ||
    "Chưa đủ bằng chứng OCR · cần Admin đối chiếu ảnh"
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
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreExpandFocusRef = useRef(true);

  useEffect(() => {
    if (!isExpanded) return;

    const expandButton = expandButtonRef.current;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsExpanded(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
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
            const boxLabel = `Từ ${word.word_index + 1}: ${word.text}. ${reviewLabel}. ${scoreLabel}.`;
            const boxTitle = `Từ ${word.word_index + 1}: ${word.text} · ${reviewLabel} · ${scoreLabel} · bản nháp: ${currentDraftToken ?? "chưa có"}`;

            return (
              <button
                aria-label={boxLabel}
                aria-pressed={word.word_index === selectedWord}
                className={`absolute box-border cursor-pointer rounded-[2px] p-0 ${getWordReviewColor(reviewStatus, word, paddleLineScore)} ${selectedClass}`}
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
        <h2 className="text-2xl font-black">Ảnh trang gốc</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">
            {image.width} × {image.height} px
          </span>
          <button
            className="min-h-10 rounded-control border border-border px-3 text-sm font-bold text-primary hover:bg-canvas"
            onClick={() => setIsExpanded(true)}
            ref={expandButtonRef}
            type="button"
          >
            Phóng lớn ảnh
          </button>
        </div>
      </div>
      {renderImageFrame()}
      {isExpanded ? (
        <div
          aria-labelledby="ocr-expanded-image-title"
          aria-modal="true"
          className="fixed inset-0 z-[100] grid place-items-center bg-black/85 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setIsExpanded(false);
          }}
          role="dialog"
        >
          <div className="grid max-h-full w-full justify-items-center gap-3">
            <div className="flex w-full max-w-[92vw] items-center justify-between gap-3 text-white">
              <h2 className="font-bold" id="ocr-expanded-image-title">
                Trang {image.page_number} · {book.title}
              </h2>
              <button
                className="min-h-11 rounded-control bg-white px-4 font-bold text-ink hover:bg-canvas"
                onClick={() => setIsExpanded(false)}
                ref={closeButtonRef}
                type="button"
              >
                Đóng ảnh
              </button>
            </div>
            {renderImageFrame(true)}
          </div>
        </div>
      ) : null}
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
  const searchParams = useSearchParams();
  // Next's compatibility layer can return null outside the App Router (e.g. tests).
  const preferredRevisionId = searchParams?.get("revisionId") ?? null;
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
  const [aiAcceptedChanges, setAiAcceptedChanges] = useState<Set<number>>(
    () => new Set(),
  );
  const [aiDiffPage, setAiDiffPage] = useState(0);
  const [aiProgress, setAiProgress] = useState<AiCorrectionProgress | null>(
    null,
  );
  const [busy, setBusy] = useState<
    "edit" | "save" | "verify" | "reprocess" | "reupload" | "ai_correct" | null
  >(null);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const requestIdRef = useRef(0);
  const revisionChoiceRequestIdRef = useRef(0);
  const draftEditVersionRef = useRef(0);
  const mountedRef = useRef(false);
  const wordRefs = useRef(new Map<number, HTMLElement>());
  const autoScrolledRevisionRef = useRef<string | null>(null);
  const aiCorrectionAbortRef = useRef<AbortController | null>(null);

  const applyDetail = useCallback((next: AdminPageRevisionDetailDTO) => {
    draftEditVersionRef.current += 1;
    setDetail(next);
    setDraftText(next.draft_text ?? "");
    setWordSyncError(null);
    setAiSuggestion(null);
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
      const [nextBook, bookPages] = await Promise.all([
        books.get(bookId),
        pages.list(bookId),
      ]);
      const belongsToBook = bookPages.some(
        (item) => item.processing.page_id === pageId,
      );
      if (!belongsToBook) {
        if (requestId === requestIdRef.current) setError("not-found");
        return;
      }
      const [nextImage, nextHistory] = await Promise.all([
        pages.getImage(pageId),
        revisions.list(pageId),
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
      const nextDetail = await ocr.getRevision(
        pageId,
        selectedRevision.page_revision_id,
      );
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setBook(nextBook);
      setImage(nextImage);
      setHistory(nextHistory);
      applyDetail(nextDetail);
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
  ]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);

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
      const selected = await ocr.getRevision(pageId, revisionId);
      if (
        !mountedRef.current ||
        requestId !== revisionChoiceRequestIdRef.current
      )
        return;
      applyDetail(selected);
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

  function handleDraftTextChange(value: string) {
    draftEditVersionRef.current += 1;
    setAiSuggestion(null);
    setAiAcceptedChanges(new Set());
    setAiDiffPage(0);
    const normalizedText = value.normalize("NFC");
    setDraftText(normalizedText);
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
    const nextText = words
      .map((word) => word.text.trim())
      .filter(Boolean)
      .join(" ")
      .normalize("NFC");
    setDraftText(nextText);
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
    setBusy("ai_correct");
    setAiProgress(null);
    setAiSuggestion(null);
    setAiAcceptedChanges(new Set());
    setAiDiffPage(0);
    setNotice(null);
    try {
      const correctedText = (
        await ocr.aiCorrectText(
          pageId,
          requestedText,
          words,
          (progress) => {
            if (mountedRef.current) setAiProgress(progress);
          },
          controller.signal,
        )
      ).normalize("NFC");
      if (
        !mountedRef.current ||
        draftEditVersionRef.current !== requestedVersion ||
        detail?.page_revision_id !== requestedRevisionId
      ) {
        return;
      }
      const result = syncPageTextToWords(correctedText, words);
      if (
        result.status !== "synchronized" ||
        result.tokens.length !== expectedTokenCount ||
        result.tokens.length !== words.length
      ) {
        setNotice(
          "Không thể áp dụng kết quả AI vì số từ không khớp. Văn bản và tọa độ hiện tại vẫn được giữ nguyên.",
        );
        return;
      }
      const changes = result.tokens.flatMap((token, index) =>
        token === requestedTokens[index] ? [] : [{ index, token }],
      );
      if (changes.length === 0) {
        setNotice(
          "AI không đề xuất thay đổi nào. Bản nháp hiện tại được giữ nguyên.",
        );
        return;
      }
      setAiSuggestion(correctedText);
      setAiAcceptedChanges(new Set());
      setNotice(
        `AI đưa ra ${changes.length} thay đổi để rà soát. Chưa có thay đổi nào được chọn; bản nháp vẫn giữ nguyên.`,
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
        setNotice("Đã hủy tác vụ AI OCR. Bản nháp hiện tại được giữ nguyên.");
      } else {
        const safeMessage = isServiceError(cause)
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "văn bản và tọa độ hiện tại được giữ nguyên.";
        setNotice(
          safeMessage.startsWith("Không thể") ||
            safeMessage.startsWith("AI OCR")
            ? safeMessage
            : "Không thể sửa OCR bằng AI: " + safeMessage,
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

  function applySelectedAiChanges() {
    if (!aiSuggestion || aiAcceptedChanges.size === 0) return;
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
    handleDraftTextChange(nextText);
    setNotice(
      `Đã áp dụng ${selected.length} thay đổi AI vào bản nháp. Hãy rà soát rồi lưu bản nháp để giữ lại.`,
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
      applyDetail(saved);
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
    const requestedRevisionId = detail.page_revision_id;
    const requestedVersion = draftEditVersionRef.current;
    setBusy("verify");
    setNotice(null);
    try {
      const verifiedResult = await revisions.verify(pageId, {
        page_revision_id: requestedRevisionId,
        corrected_text: draftText,
        words,
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
    setBusy("reprocess");
    setNotice(null);
    try {
      const result = await revisions.reprocess(pageId, (status) => {
        if (status.page_id !== pageId) return;
      });
      applyDetail(result);
      setHistory(await revisions.list(pageId));
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
    setNotice(null);
    try {
      const result = await pages.replaceImageAndReprocess(
        pageId,
        replacementFile,
      );
      if (result.page_id !== pageId || result.lifecycle_status !== "ACTIVE") {
        throw new Error("Unexpected page OCR response");
      }
      applyDetail(result);
      setHistory(await revisions.list(pageId));
      setImage(await pages.getImage(pageId));
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

  const draftTokens = useMemo(() => tokenizePageText(draftText), [draftText]);

  const aiSuggestionTokens = useMemo(
    () => (aiSuggestion === null ? [] : tokenizePageText(aiSuggestion)),
    [aiSuggestion],
  );
  const aiChanges = useMemo<AiTokenChange[]>(() => {
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
  }, [aiSuggestion, aiSuggestionTokens, draftTokens]);
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
              className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold text-primary underline"
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

  return (
    <>
      <AdminPageHeader
        eyebrow={`${book.title} · Trang ${image.page_number}`}
        title={`Kiểm tra OCR · R${detail.revision_no}`}
        description="Sửa nội dung và vị trí từ, lưu nháp, xác minh hoặc tạo revision OCR mới."
        actions={<AdminStatusBadge status={detail.verification_status} />}
      />
      <Link
        className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-primary"
        href={`/admin/books/${bookId}`}
      >
        <ArrowLeft aria-hidden className="size-5" /> Chi tiết sách
      </Link>
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
          <p className="mt-3 text-sm leading-6 text-muted">
            Xanh biểu thị Admin/reference đã xác minh hoặc hai OCR đồng thuận
            chính xác ở cấp từ với alignment, token mapping và bbox/crop hợp lệ;
            đồng thuận là evidence tốt, không đồng nghĩa Admin verified. Vàng
            dành cho từ thiếu evidence, bất đồng hoặc mapping/chất lượng chưa
            an toàn. Đỏ chỉ xuất hiện khi candidate không khớp reference đã
            xác minh trong alignment một-một rõ ràng. Raw OCR score và similarity
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
                className={`grid min-h-20 content-center gap-1 rounded-control border p-2 text-center text-xs font-bold ${state.cardClass}`}
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
              className="min-h-10 rounded-control border border-border px-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
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
                <h2 className="text-2xl font-black">Văn bản OCR</h2>
                <p className="mt-1 text-sm text-muted">
                  Chỉnh nội dung tại đây; các vùng từ và ảnh sẽ được đồng bộ.
                </p>
              </div>
            </div>
            <label className="grid gap-2 font-bold" htmlFor="ocr-text">
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
              Khi chỉnh sửa văn bản, từ đã thay đổi sẽ trở về trạng thái cần
              kiểm tra. Scan OCR không gọi các model AI sửa. Khi bấm “AI sửa”,
              hệ thống lần lượt dùng gemini-3.5-flash-lite,
              gemini-3.1-flash-lite và qwen/qwen3.8-27b; Ollama chỉ là phương án
              cuối nếu các model đó không hoạt động. Ảnh và văn bản cần thiết
              được gửi tới dịch vụ AI khi bạn chủ động bấm nút này. Đề xuất giữ
              nguyên số từ để bảo toàn bounding box; lỗi cần tách/gộp từ cần
              được rà soát thủ công.
            </p>
            {busy === "ai_correct" ? (
              <div
                aria-live="polite"
                className="mt-4 grid gap-3 rounded-control border border-purple-300 bg-purple-50 p-4 text-sm text-purple-950"
                role="status"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-bold">
                    {aiProgress?.status === "QUEUED"
                      ? "AI OCR đang chờ máy xử lý"
                      : aiProgress
                        ? `AI OCR đang xử lý đoạn ${aiProgress.completed_chunks}/${aiProgress.total_chunks}`
                        : "Đang chuẩn bị tác vụ AI OCR…"}
                  </span>
                  <Button
                    className="min-h-9 w-auto border-red-300 px-3 text-red-800 hover:bg-red-50"
                    onClick={cancelAiCorrection}
                    type="button"
                    variant="secondary"
                  >
                    <X aria-hidden className="size-4" /> Hủy xử lý
                  </Button>
                </div>
                <progress
                  aria-label="Tiến độ AI OCR"
                  className="h-2 w-full accent-purple-700"
                  max={aiProgress?.total_chunks ?? 1}
                  value={aiProgress?.completed_chunks ?? 0}
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
                    className="text-lg font-extrabold text-purple-950"
                    id="ai-correction-review-title"
                  >
                    Rà soát đề xuất AI
                  </h3>
                  <p className="mt-1 text-sm text-purple-900">
                    Có {aiChanges.length} thay đổi từ. Các bbox được giữ nguyên;
                    đề xuất chưa được lưu. AI không cung cấp điểm tin cậy cấp
                    từ; mọi từ đề xuất cần Admin đối chiếu với ảnh.
                  </p>
                  <p
                    aria-live="polite"
                    className="mt-1 text-sm font-bold text-purple-950"
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
                  className="text-xs font-bold text-muted"
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
                                Từ AI: chưa đối chiếu ảnh · không có điểm OCR
                                cấp từ.
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
                    disabled={aiAcceptedChanges.size === 0}
                    onClick={applySelectedAiChanges}
                    type="button"
                  >
                    <CheckCircle2 aria-hidden className="size-4" /> Áp dụng thay
                    đổi đã chọn
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
                    className="sm:w-auto border-purple-600 bg-purple-600 text-white hover:bg-purple-700"
                    disabled={
                      busy !== null ||
                      detail.lifecycle_status !== "ACTIVE" ||
                      !draftText.trim()
                    }
                    isLoading={busy === "ai_correct"}
                    onClick={() => void correctWithAi()}
                    type="button"
                  >
                    <Sparkles aria-hidden className="size-4" /> AI sửa chính tả
                    &amp; dấu
                  </Button>

                  <Button
                    className="sm:w-auto"
                    disabled={
                      busy !== null ||
                      detail.lifecycle_status !== "ACTIVE" ||
                      words.length === 0 ||
                      wordSyncError !== null
                    }
                    isLoading={busy === "verify"}
                    onClick={() => void verifyRevision()}
                  >
                    <CheckCircle2 aria-hidden className="size-4" /> Xác minh
                    trang
                  </Button>
                </>
              )}
            </div>
          </Card>

          <Card className="bg-white">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl font-black">Danh sách từ OCR</h2>
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
              Chọn một từ để làm nổi bật vùng trên ảnh. Tọa độ và log engine
              được đặt trong phần chi tiết của từng từ.
            </p>
            <div
              aria-live="polite"
              className="mb-4 rounded-control border border-border bg-canvas px-3 py-2 text-sm text-muted"
              role="status"
            >
              <span className="font-bold">Đối chiếu văn bản ↔ vùng OCR: </span>
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
                      const status = getWordReviewStatus(
                        word,
                        detail?.verification_status,
                      );
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
                  className={`min-h-10 rounded-full border px-3 text-sm font-bold ${
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
                          className="rounded-sm text-left text-sm font-extrabold text-primary underline underline-offset-2"
                          onClick={() => selectWordOnImage(word.word_index)}
                          type="button"
                        >
                          Từ #{word.word_index} · Dòng {word.line_index}
                        </button>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <span
                            className={`rounded border px-2 py-0.5 text-xs font-bold ${getWordReviewBadgeColor(reviewStatus, word, paddleLineScore)}`}
                          >
                            {reviewLabel}
                          </span>
                        </div>
                      </div>

                      {colorGroup === "red" ? (
                        <div className="mb-3 grid gap-1 rounded-control border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-950">
                          {reviewStatus === "confirmed_mismatch" ? (
                            <>
                              <span className="font-bold">
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
                              <span className="font-bold">
                                Reference mismatch đã được xác nhận
                              </span>
                              <span className="break-words">
                                Từ OCR: “{word.text}” ·{" "}
                                {getWordScoreLabel(word, detail.ocr_metadata)}
                              </span>
                              <span className="text-xs">
                                Màu đỏ chỉ dùng cho mismatch đã được Admin hoặc
                                reference đáng tin cậy xác nhận.
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
                        <span className="text-xs font-bold text-muted">
                          Văn bản trang ↔ từ gắn với vùng ảnh
                        </span>
                        <span className="break-words font-semibold">
                          {canCompareToken
                            ? `${draftToken} ↔ ${word.text}`
                            : "Không thể ghép từ này theo vị trí hiện tại"}
                          {canCompareToken ? (
                            <span className="ml-2 whitespace-nowrap text-xs font-bold text-muted">
                              {tokenMatches ? "Khớp" : "Cần đối chiếu"}
                            </span>
                          ) : null}
                        </span>
                      </div>

                      <label className="grid gap-1 text-sm font-bold">
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
                        <summary className="cursor-pointer rounded-control px-3 py-2 text-sm font-bold text-primary hover:bg-canvas focus-visible:outline-3 focus-visible:outline-primary">
                          Tọa độ vùng ảnh · chỉnh sửa nâng cao
                        </summary>
                        <div className="grid grid-cols-4 gap-2 border-t border-border p-3">
                          {(["x", "y", "w", "h"] as const).map(
                            (label, coordinate) => (
                              <label
                                className="grid gap-1 text-xs font-bold"
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
                        <summary className="cursor-pointer rounded-control px-3 py-2 text-sm font-bold text-primary hover:bg-white focus-visible:outline-3 focus-visible:outline-primary">
                          Bằng chứng nhận dạng ·{" "}
                          {getWordScoreLabel(word, detail.ocr_metadata)}
                        </summary>
                        <section
                          aria-label={`Bằng chứng OCR từ ${word.word_index + 1}`}
                          className="grid gap-1 border-t border-border px-3 py-3 text-xs"
                        >
                          <h3 className="text-sm font-bold">Bằng chứng OCR</h3>
                          <span>
                            Bounding box:{" "}
                            {word.bbox
                              .map((value) => value.toFixed(4))
                              .join(", ")}
                          </span>
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
                              PaddleOCR dòng gốc (không phải token căn chỉnh):{" "}
                              {getLineEngineOutput(
                                word,
                                "paddleocr",
                                detail.ocr_metadata,
                              )}
                            </span>
                          ) : null}
                          {typeof word.ocr_evidence?.engine_outputs.vietocr !==
                            "string" &&
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
                            {word.ocr_evidence?.source_text ?? "Not recorded"}
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
                            {word.ocr_evidence?.verification_source ?? "None"}
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
                            Bounding box quality:{" "}
                            {word.ocr_evidence?.bbox_quality ?? "Not assessed"}
                          </span>
                          <span>
                            Crop quality:{" "}
                            {word.ocr_evidence?.crop_quality ?? "Not processed"}
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
                                  word.ocr_evidence.crop_evidence.contrast_std,
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
            <h2 className="mb-3 text-2xl font-black">Lịch sử revision</h2>
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
                  onClick={() => void chooseRevision(revision.page_revision_id)}
                  type="button"
                >
                  <span className="font-bold">
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
                className="grid gap-2 text-sm font-bold"
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
                <RefreshCw aria-hidden className="size-4" /> Tải ảnh mới và chạy
                OCR
              </Button>
            </div>
            <Button
              className="mt-4 sm:w-auto"
              disabled={busy !== null || detail.lifecycle_status !== "ACTIVE"}
              isLoading={busy === "reprocess"}
              onClick={() => void reprocess()}
              variant="secondary"
            >
              <RotateCcw aria-hidden className="size-4" /> Chạy lại OCR từ ảnh
              đã lưu
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
      </div>
    </>
  );
}
