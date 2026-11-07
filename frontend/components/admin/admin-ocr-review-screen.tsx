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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  AdminPageImageUI,
  AdminPageRevisionDetailDTO,
  AdminRevisionSummaryUI,
  AdminRevisionWordDTO,
} from "@/types/admin";

type LoadError = "not-found" | "unavailable" | "safe";
type AiTokenChange = {
  readonly index: number;
  readonly original: string;
  readonly proposed: string;
};

export type WordDisplayStatus = "exact" | "partial" | "mismatch";

export function stripVietnameseAccents(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/đ/gu, "d")
    .replace(/Đ/gu, "D")
    .toLowerCase()
    .trim();
}

export function getConfidenceLevel(
  confidence: number | null | undefined,
): "Cao" | "Trung bình" | "Thấp" | "Chưa xác định" {
  if (
    confidence === null ||
    confidence === undefined ||
    !Number.isFinite(confidence)
  ) {
    return "Chưa xác định";
  }
  if (confidence > 0.8) {
    return "Cao";
  }
  if (confidence >= 0.6) {
    return "Trung bình";
  }
  return "Thấp";
}

export function getWordDisplayStatus(
  word: AdminRevisionWordDTO,
  draftToken: string | undefined,
): WordDisplayStatus {
  if (!draftToken) return "mismatch";
  const normBox = normalizeVietnameseWord(word.text);
  const normDraft = normalizeVietnameseWord(draftToken);
  if (!normBox || !normDraft) return "mismatch";

  const baseBox = stripVietnameseAccents(normBox);
  const baseDraft = stripVietnameseAccents(normDraft);

  if (baseBox !== baseDraft) {
    return "mismatch";
  }

  if (normBox !== normDraft) {
    return "partial";
  }

  return "exact";
}

function getWordMatchLabel(status: WordDisplayStatus): string {
  return {
    exact: "Chính xác (cả từ & dấu)",
    partial: "Nghi sai / lệch dấu thanh",
    mismatch: "Không khớp từ / cần kiểm tra",
  }[status];
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
  const preferredRevisionId = searchParams.get("revisionId");
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

    const firstUncertain = words.find(
      (word) => getConfidenceLevel(word.ocr_confidence) !== "Cao",
    );
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
    [draftText],
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
    const nextWords = words.map((word) =>
      word.word_index === index
        ? {
            ...word,
            ...patch,
            text:
              patch.text !== undefined
                ? patch.text.normalize("NFC")
                : word.text,
            ocr_confidence: patch.ocr_confidence ?? word.ocr_confidence,
            normalized_text:
              patch.text === undefined
                ? (patch.normalized_text ?? word.normalized_text)
                : normalizeVietnameseWord(patch.text),
          }
        : word,
    );
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
      setWords(
        result.words.map((w) => ({
          ...w,
          ocr_confidence: 1.0,
        })),
      );
      setWordSyncError(null);
      setNotice(
        "Đã đối chiếu khớp 100% giữa nội dung văn bản và tọa độ bounding box!",
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
      setAiAcceptedChanges(new Set(changes.map((change) => change.index)));
      setNotice(
        `AI đưa ra ${changes.length} thay đổi để rà soát. Bản nháp chưa bị thay đổi; chọn áp dụng sau khi kiểm tra.`,
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
            : "Không thể sửa OCR bằng AI cục bộ: " + safeMessage,
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

  const matchCounts = useMemo(() => {
    const counts = { exact: 0, partial: 0, mismatch: 0 };
    for (let i = 0; i < words.length; i++) {
      const status = getWordDisplayStatus(words[i], draftTokens[i]);
      counts[status] += 1;
    }
    return counts;
  }, [words, draftTokens]);

  const confidenceCounts = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0, unknown: 0 };
    for (const word of words) {
      const level = getConfidenceLevel(word.ocr_confidence);
      if (level === "Cao") counts.high += 1;
      else if (level === "Trung bình") counts.medium += 1;
      else if (level === "Thấp") counts.low += 1;
      else counts.unknown += 1;
    }
    return counts;
  }, [words]);

  const firstWordToReview = useMemo(() => {
    return (
      words.find((w) => getConfidenceLevel(w.ocr_confidence) !== "Cao") ||
      words.find((word) => {
        const status = getWordDisplayStatus(word, draftTokens[word.word_index]);
        return status === "partial" || status === "mismatch";
      })
    );
  }, [words, draftTokens]);

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
        <Card className="bg-white">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-2xl font-black">Ảnh trang gốc</h2>
            <span className="text-sm text-muted">
              {image.width} × {image.height} px
            </span>
          </div>
          <div
            className="relative overflow-hidden rounded-control bg-desk"
            style={{ aspectRatio: `${image.width} / ${image.height}` }}
          >
            <Image
              alt={`Ảnh trang ${image.page_number} của ${book.title}`}
              className="object-contain"
              fill
              sizes="(max-width:1280px) 100vw, 55vw"
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
                const matchStatus = getWordDisplayStatus(
                  word,
                  currentDraftToken,
                );

                const confidenceLevel = getConfidenceLevel(word.ocr_confidence);
                const colorClass = {
                  Cao: "border-green-600 bg-green-400/35",
                  "Trung bình": "border-yellow-500 bg-yellow-300/35",
                  Thấp: "border-red-600 bg-red-400/35",
                  "Chưa xác định": "border-orange-600 bg-orange-300/35",
                }[confidenceLevel];

                const selectedClass =
                  word.word_index === selectedWord
                    ? [
                        "z-10",
                        "border-2",
                        "border-orange-700",
                        "bg-orange-300/50",
                        "ring-2",
                        "ring-white",
                      ].join(" ")
                    : "border";

                const matchLabel = getWordMatchLabel(matchStatus);
                const confText =
                  word.ocr_confidence !== null &&
                  word.ocr_confidence !== undefined
                    ? `Confidence OCR: ${word.ocr_confidence}.`
                    : "Confidence OCR: chưa rõ.";
                const boxLabel = `Từ ${word.word_index + 1}: ${word.text}. ${confText} Mức ${confidenceLevel}`;
                const boxTitle = `Từ ${word.word_index + 1}: ${word.text} (Mức ${confidenceLevel}) · ${word.text} -> ${currentDraftToken ?? "(chưa có)"} (${matchLabel})`;

                return (
                  <button
                    aria-label={boxLabel}
                    aria-pressed={word.word_index === selectedWord}
                    className={[
                      "absolute cursor-pointer p-0 box-border rounded-[2px]",
                      colorClass,
                      selectedClass,
                    ].join(" ")}
                    key={`${word.line_index}-${word.word_index}`}
                    onClick={() => selectWordOnImage(word.word_index)}
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
          <p className="mt-3 text-sm text-muted">
            Màu bounding box phản ánh độ tin cậy OCR. Trạng thái đối chiếu nội
            được hiển thị riêng trong danh sách từ và phần thống kê bên dưới.
          </p>
          <div
            aria-label="Chú giải confidence OCR"
            className="mt-3 flex flex-wrap gap-4 text-xs font-bold"
          >
            <span className="inline-flex items-center gap-1.5 text-green-800">
              <span className="size-3.5 rounded-sm border border-green-600 bg-green-400/40" />
              Cao
            </span>
            <span className="inline-flex items-center gap-1.5 text-yellow-800">
              <span className="size-3.5 rounded-sm border border-yellow-500 bg-yellow-300/40" />
              Trung bình
            </span>
            <span className="inline-flex items-center gap-1.5 text-red-800">
              <span className="size-3.5 rounded-sm border border-red-600 bg-red-400/40" />
              Thấp
            </span>
            <span className="inline-flex items-center gap-1.5 text-orange-800">
              <span className="size-3.5 rounded-sm border border-orange-600 bg-orange-300/40" />
              Chưa xác định
            </span>
          </div>
          <div
            aria-label="Thống kê confidence OCR"
            className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"
            role="group"
          >
            <div className="rounded-control border border-green-600/40 bg-green-50 p-2.5 text-center">
              <strong className="text-lg text-green-700">
                {confidenceCounts.high}
              </strong>
              <div className="text-xs font-bold text-green-900">Cao</div>
            </div>
            <div className="rounded-control border border-yellow-500/40 bg-yellow-50 p-2.5 text-center">
              <strong className="text-lg text-yellow-700">
                {confidenceCounts.medium}
              </strong>
              <div className="text-xs font-bold text-yellow-900">
                Trung bình
              </div>
            </div>
            <div className="rounded-control border border-red-600/40 bg-red-50 p-2.5 text-center">
              <strong className="text-lg text-red-700">
                {confidenceCounts.low}
              </strong>
              <div className="text-xs font-bold text-red-900">Thấp</div>
            </div>
            <div className="rounded-control border border-orange-600/40 bg-orange-50 p-2.5 text-center">
              <strong className="text-lg text-orange-700">
                {confidenceCounts.unknown}
              </strong>
              <div className="text-xs font-bold text-orange-900">
                Chưa xác định
              </div>
            </div>
          </div>
          <div
            aria-label="Thống kê đối chiếu OCR"
            className="mt-4 grid grid-cols-3 gap-3"
            role="group"
          >
            <div className="rounded-control border border-green-600/40 bg-green-50 p-2.5 text-center">
              <strong className="text-lg text-green-700">
                {matchCounts.exact}
              </strong>
              <div className="text-xs font-bold text-green-900">Chính xác</div>
            </div>
            <div className="rounded-control border border-yellow-500/40 bg-yellow-50 p-2.5 text-center">
              <strong className="text-lg text-yellow-700">
                {matchCounts.partial}
              </strong>
              <div className="text-xs font-bold text-yellow-900">
                Nghi sai dấu
              </div>
            </div>
            <div className="rounded-control border border-red-600/40 bg-red-50 p-2.5 text-center">
              <strong className="text-lg text-red-700">
                {matchCounts.mismatch}
              </strong>
              <div className="text-xs font-bold text-red-900">Không khớp</div>
            </div>
          </div>
          <button
            className="mt-3 min-h-10 rounded-control border border-border px-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!firstWordToReview}
            onClick={() => {
              if (firstWordToReview) {
                selectWordOnImage(firstWordToReview.word_index);
              }
            }}
            type="button"
          >
            Đi tới từ cần kiểm tra
          </button>
        </Card>

        <div className="grid content-start gap-6">
          <Card className="bg-white">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-black">Văn bản nháp</h2>
              <AdminStatusBadge status={detail.verification_status} />
            </div>
            <label className="grid gap-2 font-bold" htmlFor="ocr-text">
              Nội dung trang
              <textarea
                aria-describedby="ocr-help"
                className="min-h-44 rounded-control border border-border bg-white p-4 font-normal outline-none focus:border-primary focus:outline-3 focus:outline-primary/30 disabled:bg-canvas"
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
              Khi chỉnh sửa văn bản, màu sắc của các hộp chữ trên ảnh sẽ tự động
              cập nhật theo thời gian thực (Xanh: chính xác cả từ &amp; dấu,
              Vàng: nghi sai dấu, Đỏ: không khớp). AI sửa lỗi chạy qua Ollama
              cục bộ, không gửi văn bản lên dịch vụ AI đám mây. Đề xuất giữ
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
                        : "Đang chuẩn bị tác vụ AI OCR cục bộ…"}
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
                    đề xuất chưa được lưu.
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
                  {visibleAiChanges.map((change) => (
                    <li
                      className="rounded-control border border-purple-200 bg-white p-3"
                      key={change.index}
                    >
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          checked={aiAcceptedChanges.has(change.index)}
                          className="mt-1 size-4 accent-purple-700"
                          onChange={(event) => {
                            setAiAcceptedChanges((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(change.index);
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
                          <span className="break-words">
                            <del className="text-red-800">
                              {change.original}
                            </del>
                            <span
                              aria-hidden="true"
                              className="px-2 text-muted"
                            >
                              →
                            </span>
                            <strong className="text-green-800">
                              {change.proposed}
                            </strong>
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
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
                  <span className="text-sm text-purple-950">
                    Đã chọn {aiAcceptedChanges.size} / {aiChanges.length}
                  </span>
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
              <h2 className="text-2xl font-black">Từ và bounding box</h2>
              <div className="flex flex-wrap gap-2">
                <Button
                  className="h-11 w-auto border-green-600 bg-green-50 text-green-800 hover:bg-green-100"
                  disabled={verified || busy !== null || words.length === 0}
                  onClick={reconcileAllMatchedWords}
                  type="button"
                  variant="secondary"
                >
                  <CheckCircle2 aria-hidden className="size-4" /> Đối chiếu khớp
                  (100%)
                </Button>
                <Button
                  className="h-11 w-auto"
                  disabled={verified || busy !== null}
                  onClick={syncTextFromWords}
                  variant="secondary"
                >
                  Đồng bộ văn bản từ danh sách từ
                </Button>
              </div>
            </div>
            <p className="mb-4 text-sm text-muted">
              Chọn từ để làm nổi bật vùng tương ứng trên ảnh. Bốn giá trị bbox
              là x, y, width, height đã chuẩn hóa.
            </p>
            <div className="grid gap-3">
              {words.map((word) => {
                const currentDraftToken = draftTokens[word.word_index];
                const matchStatus = getWordDisplayStatus(
                  word,
                  currentDraftToken,
                );
                const matchLabel = getWordMatchLabel(matchStatus);

                const statusBadgeClass = {
                  exact: "bg-green-100 text-green-800 border-green-300",
                  partial: "bg-yellow-100 text-yellow-800 border-yellow-300",
                  mismatch: "bg-red-100 text-red-800 border-red-300",
                }[matchStatus];

                return (
                  <div
                    ref={(el) => {
                      if (el) wordRefs.current.set(word.word_index, el);
                      else wordRefs.current.delete(word.word_index);
                    }}
                    id={`ocr-word-${word.word_index}`}
                    className={
                      word.word_index === selectedWord
                        ? "rounded-control border-2 border-orange-500 p-3"
                        : "rounded-control border border-border p-3"
                    }
                    key={word.word_index}
                  >
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <button
                        aria-pressed={word.word_index === selectedWord}
                        className="text-left text-sm font-bold text-primary underline"
                        onClick={() => selectWordOnImage(word.word_index)}
                        type="button"
                      >
                        Từ #{word.word_index} · Dòng {word.line_index}
                      </button>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <span className="rounded border border-border bg-canvas px-2 py-0.5 text-xs font-bold text-muted">
                          Confidence OCR: {word.ocr_confidence ?? "chưa rõ"} ·{" "}
                          {getConfidenceLevel(word.ocr_confidence)}
                        </span>
                        <span
                          className={`rounded border px-2 py-0.5 text-xs font-bold ${statusBadgeClass}`}
                        >
                          {matchLabel}
                        </span>
                      </div>
                    </div>

                    <label className="grid gap-1 text-sm font-bold">
                      Văn bản từ
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
                    <div className="mt-2 grid grid-cols-4 gap-2">
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
                  </div>
                );
              })}
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
