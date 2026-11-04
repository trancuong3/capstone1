"use client";

import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Mic,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BookChildHeader } from "@/components/books/book-child-header";
import { BookCover } from "@/components/books/book-cover";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { Button, ButtonLink } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAppStore } from "@/components/providers/app-store-provider";
import { useBookService } from "@/hooks/use-book-service";
import { useChildService } from "@/hooks/use-child-service";
import { useReadingServices } from "@/hooks/use-reading-services";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { isServiceError } from "@/lib/api/service-error";
import type { BookDetailDTO, BookPagePreviewDTO } from "@/types/book";
import type { MicrophonePermissionUiState } from "@/types/reading";
import type { ChildProfileDTO } from "@/types/child";

interface ReadingPreparationScreenProps {
  bookId?: string;
  pageId?: string;
  endPageId?: string;
  confidence?: string;
}

type PreparationData = {
  book: BookDetailDTO;
  child: ChildProfileDTO;
  pages: BookPagePreviewDTO[];
  startPage: BookPagePreviewDTO | null;
  endPage: BookPagePreviewDTO | null;
  rangePages: BookPagePreviewDTO[];
  rangeValid: boolean;
  explicitPageInvalid: boolean;
  confidence: number | null;
};

type PreparationState =
  | { status: "loading"; contextKey: string }
  | { status: "ready"; contextKey: string; data: PreparationData }
  | { status: "not-found"; contextKey: string }
  | { status: "unavailable"; contextKey: string }
  | { status: "error"; contextKey: string };

const microphoneStatusLabels: Record<MicrophonePermissionUiState, string> = {
  checking: "Đang kiểm tra",
  granted: "Đã được cấp quyền",
  prompt: "Chưa cấp quyền",
  denied: "Đang bị từ chối",
  unsupported: "Không hỗ trợ kiểm tra tự động",
  no_device: "Không tìm thấy microphone",
  device_busy: "Microphone đang bận",
  error: "Không thể kiểm tra",
};

function microphoneDescription(
  status: MicrophonePermissionUiState,
  verified: boolean,
): string {
  if (verified) {
    return "Microphone đã mở thành công. ViRead đã dừng luồng kiểm tra tạm thời.";
  }
  switch (status) {
    case "checking":
      return "Đang đọc trạng thái quyền microphone của trình duyệt…";
    case "granted":
      return "Trình duyệt báo đã cấp quyền. Hãy kiểm tra thiết bị thật trước khi bắt đầu.";
    case "prompt":
      return "Chưa cấp quyền microphone. Bấm nút kiểm tra để trình duyệt hỏi quyền truy cập.";
    case "denied":
      return "Vui lòng cấp quyền microphone trong cài đặt trình duyệt rồi thử lại.";
    case "unsupported":
      return "Trình duyệt không cung cấp trạng thái tự động. Ba mẹ vẫn có thể kiểm tra microphone bằng nút bên dưới.";
    case "no_device":
      return "Không tìm thấy microphone trên thiết bị. Hãy kết nối microphone rồi thử lại.";
    case "device_busy":
      return "Microphone đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.";
    case "error":
      return "Không thể kiểm tra microphone. Hãy sử dụng HTTPS hoặc localhost và thử lại.";
  }
}

function isRangeContiguous(
  pages: readonly BookPagePreviewDTO[],
  start: BookPagePreviewDTO | null,
  end: BookPagePreviewDTO | null,
): boolean {
  if (!start || !end || end.page_number < start.page_number) return false;
  const range = pages.filter(
    (page) =>
      page.page_number >= start.page_number &&
      page.page_number <= end.page_number,
  );
  if (
    range.length === 0 ||
    range[0]?.page_number !== start.page_number ||
    range[range.length - 1]?.page_number !== end.page_number
  ) {
    return false;
  }
  return range.every(
    (page, index) => page.page_number === start.page_number + index,
  );
}

export function ReadingPreparationScreen({
  bookId,
  pageId,
  endPageId,
  confidence,
}: ReadingPreparationScreenProps) {
  const router = useRouter();
  const bookService = useBookService();
  const childService = useChildService();
  const { devicePermissionService, readingService } = useReadingServices();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const selectedChildKey =
    childState.status === "ready" ? childState.child.id : "";
  const { selectedChildId, clearSelectedChild } = useAppStore();
  const selectedChildIdRef = useRef(selectedChildId);
  const mountedRef = useRef(false);
  const verificationInFlightRef = useRef(false);
  const verificationRequestIdRef = useRef(0);
  const contextKeyRef = useRef("");
  const permissionStateRef = useRef<MicrophonePermissionUiState>("checking");
  const startInFlightRef = useRef(false);
  const permissionCleanupRef = useRef<(() => void) | null>(null);
  const contextKey = `${selectedChildId ?? ""}|${bookId ?? ""}|${pageId ?? ""}|${endPageId ?? ""}`;
  const [requestKey, setRequestKey] = useState(0);
  const loadContextKey = `${contextKey}|${requestKey}`;
  const [storedState, setStoredState] = useState<PreparationState>({
    status: "loading",
    contextKey: "",
  });
  const state = useMemo<PreparationState>(
    () =>
      storedState.contextKey === loadContextKey
        ? storedState
        : { status: "loading", contextKey: loadContextKey },
    [loadContextKey, storedState],
  );
  const [permissionState, setPermissionState] =
    useState<MicrophonePermissionUiState>("checking");
  const [microphoneVerified, setMicrophoneVerified] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [permissionMessage, setPermissionMessage] = useState<string | null>(
    null,
  );
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    selectedChildIdRef.current = selectedChildId;
  }, [selectedChildId]);

  useEffect(() => {
    if (!contextKeyRef.current) {
      contextKeyRef.current = contextKey;
      return;
    }
    if (contextKeyRef.current === contextKey) return;
    contextKeyRef.current = contextKey;
    verificationRequestIdRef.current += 1;
    verificationInFlightRef.current = false;
    setMicrophoneVerified(false);
    setPermissionMessage(null);
    setStartError(null);
    setPermissionState("checking");
    permissionStateRef.current = "checking";
  }, [contextKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      permissionCleanupRef.current?.();
      permissionCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (childState.status !== "ready") return;
    let active = true;
    const selectedChild = childState.child;

    async function loadPreparation() {
      if (!bookId) {
        setStoredState({ status: "not-found", contextKey: loadContextKey });
        return;
      }
      try {
        const [book, pages] = await Promise.all([
          bookService.get(bookId),
          bookService.listPages(bookId),
        ]);
        if (!active) return;
        pages.sort((left, right) => left.page_number - right.page_number);
        const startPage = pageId
          ? (pages.find((page) => page.page_id === pageId) ?? null)
          : (pages[0] ?? null);
        const explicitPageInvalid = Boolean(pageId) && !startPage;
        const endPage = endPageId
          ? (pages.find((page) => page.page_id === endPageId) ?? null)
          : (pages[pages.length - 1] ?? null);
        const parsedConfidence =
          confidence === undefined ? NaN : Number(confidence);
        const validConfidence =
          Number.isFinite(parsedConfidence) &&
          parsedConfidence >= 0 &&
          parsedConfidence <= 1
            ? parsedConfidence
            : null;
        const rangePages =
          startPage && endPage
            ? pages.filter(
                (page) =>
                  page.page_number >= startPage.page_number &&
                  page.page_number <= endPage.page_number,
              )
            : [];
        setStoredState({
          status: "ready",
          contextKey: loadContextKey,
          data: {
            book,
            child: selectedChild,
            pages,
            startPage,
            endPage,
            rangePages,
            rangeValid: isRangeContiguous(pages, startPage, endPage),
            explicitPageInvalid,
            confidence: validConfidence,
          },
        });
      } catch (error) {
        if (!active) return;
        if (isServiceError(error) && error.code === "RESOURCE_NOT_FOUND") {
          setStoredState({ status: "not-found", contextKey: loadContextKey });
        } else if (isServiceError(error) && error.code === "CONTENT_INACTIVE") {
          setStoredState({ status: "unavailable", contextKey: loadContextKey });
        } else {
          setStoredState({ status: "error", contextKey: loadContextKey });
        }
      }
    }

    void loadPreparation();
    return () => {
      active = false;
    };
  }, [
    bookId,
    bookService,
    childState,
    confidence,
    endPageId,
    loadContextKey,
    pageId,
  ]);

  useEffect(() => {
    if (childState.status !== "ready") return;
    let active = true;
    permissionCleanupRef.current?.();
    permissionCleanupRef.current = null;
    void devicePermissionService
      .watchMicrophonePermissionState((nextState) => {
        if (!active || !mountedRef.current) return;
        const previousState = permissionStateRef.current;
        permissionStateRef.current = nextState;
        setPermissionState(nextState);
        if (previousState === "granted" && nextState !== "granted") {
          setMicrophoneVerified(false);
          setPermissionMessage(
            "Quyền microphone đã thay đổi. Hãy xác minh lại trước khi bắt đầu đọc.",
          );
        } else if (nextState === "denied") {
          setMicrophoneVerified(false);
          setPermissionMessage(
            "Vui lòng cấp quyền microphone trong cài đặt trình duyệt.",
          );
        }
      })
      .then((cleanup) => {
        if (!active) {
          cleanup();
          return;
        }
        permissionCleanupRef.current = cleanup;
      })
      .catch(() => {
        if (active && mountedRef.current) {
          setPermissionState("error");
          permissionStateRef.current = "error";
        }
      });
    return () => {
      active = false;
      permissionCleanupRef.current?.();
      permissionCleanupRef.current = null;
    };
  }, [childState.status, selectedChildKey, devicePermissionService]);

  const handleVerifyMicrophone = useCallback(async () => {
    if (verificationInFlightRef.current || childState.status !== "ready")
      return;
    verificationInFlightRef.current = true;
    const requestId = ++verificationRequestIdRef.current;
    const requestContextKey = contextKey;
    setIsVerifying(true);
    setPermissionMessage(null);
    setMicrophoneVerified(false);
    try {
      const result = await devicePermissionService.requestAccess("microphone");
      if (
        !mountedRef.current ||
        requestId !== verificationRequestIdRef.current ||
        requestContextKey !== contextKeyRef.current
      )
        return;
      setPermissionState(result.status as MicrophonePermissionUiState);
      permissionStateRef.current = result.status as MicrophonePermissionUiState;
      setPermissionMessage(result.verified ? null : result.message);
      setMicrophoneVerified(result.verified);
      const actualPermissionState =
        await devicePermissionService.getMicrophonePermissionState();
      if (
        mountedRef.current &&
        requestId === verificationRequestIdRef.current &&
        requestContextKey === contextKeyRef.current
      ) {
        setPermissionState(actualPermissionState);
        permissionStateRef.current = actualPermissionState;
        if (actualPermissionState === "denied") setMicrophoneVerified(false);
      }
    } catch {
      if (
        mountedRef.current &&
        requestId === verificationRequestIdRef.current &&
        requestContextKey === contextKeyRef.current
      ) {
        setPermissionState("error");
        permissionStateRef.current = "error";
        setMicrophoneVerified(false);
        setPermissionMessage("Không thể kiểm tra microphone. Hãy thử lại.");
      }
    } finally {
      if (requestId === verificationRequestIdRef.current) {
        verificationInFlightRef.current = false;
        if (mountedRef.current) setIsVerifying(false);
      }
    }
  }, [childState.status, contextKey, devicePermissionService]);

  const handleStartReading = useCallback(async () => {
    if (
      state.status !== "ready" ||
      childState.status !== "ready" ||
      !microphoneVerified ||
      isVerifying ||
      startInFlightRef.current ||
      !state.data.startPage ||
      !state.data.endPage ||
      !state.data.rangeValid ||
      state.data.explicitPageInvalid
    ) {
      return;
    }
    startInFlightRef.current = true;
    setIsStarting(true);
    setStartError(null);
    try {
      const currentChild = await childService.get(childState.child.id);
      if (currentChild.id !== childState.child.id) {
        clearSelectedChild();
        router.replace("/dashboard?focus=child-selection&reason=invalid");
        return;
      }
      if (selectedChildIdRef.current !== childState.child.id) {
        router.replace("/dashboard?focus=child-selection&reason=change");
        return;
      }
      const session = await readingService.create({
        book_id: state.data.book.id,
        child_id: currentChild.id,
        mode: "realtime",
        selected_page_id: state.data.startPage.page_id,
        selected_page_revision_id:
          state.data.startPage.current_verified_revision_id,
        end_page_id: state.data.endPage.page_id,
      });
      if (!mountedRef.current) return;
      router.push(
        `/reading/${encodeURIComponent(session.session_id)}?state=ready&pageId=${encodeURIComponent(state.data.startPage.page_id)}`,
      );
    } catch {
      if (mountedRef.current) {
        setStartError(
          "Chưa thể tạo buổi đọc với phạm vi này. Ba mẹ hãy kiểm tra trang đã chọn rồi thử lại.",
        );
      }
    } finally {
      startInFlightRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  }, [
    childService,
    childState,
    clearSelectedChild,
    isVerifying,
    microphoneVerified,
    readingService,
    router,
    state,
  ]);

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[980px] px-4 py-8"
      >
        <span className="sr-only" role="status">
          Đang xác minh hồ sơ trẻ…
        </span>
        <Skeleton className="h-14 w-full max-w-sm rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title="Không thể xác minh hồ sơ trẻ" tone="error">
          Chưa thể xác nhận hồ sơ thuộc tài khoản hiện tại. Ba mẹ vui lòng thử
          lại.
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }

  if (state.status === "loading") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[980px] px-4 py-8"
      >
        <span className="sr-only" role="status">
          Đang tải thông tin sách…
        </span>
        <Skeleton className="h-14 w-full max-w-sm rounded-card" />
        <Skeleton className="mt-6 h-64 w-full rounded-card" />
      </section>
    );
  }

  if (state.status === "not-found" || state.status === "unavailable") {
    const unavailable = state.status === "unavailable";
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-4 py-8">
        <StatusMessage
          title={
            unavailable ? "Sách hiện chưa sẵn sàng" : "Không tìm thấy sách"
          }
          tone="error"
        >
          {unavailable
            ? "Cuốn sách này chưa có nội dung ACTIVE và VERIFIED để bé đọc."
            : "Cuốn sách không tồn tại hoặc không có trong thư viện hiện tại."}
        </StatusMessage>
        <ButtonLink className="sm:max-w-72" href="/books" variant="secondary">
          <ArrowLeft aria-hidden="true" className="size-5" />
          Về thư viện sách
        </ButtonLink>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title="Chưa tải được thông tin đọc sách" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
        <Button
          className="sm:w-auto"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }

  const data = state.data;
  const detailHref = `/books/${encodeURIComponent(data.book.id)}${pageId ? `?pageId=${encodeURIComponent(pageId)}` : ""}`;
  const statusText = microphoneStatusLabels[permissionState];
  const canStart =
    microphoneVerified &&
    !isVerifying &&
    !isStarting &&
    Boolean(data.startPage && data.endPage && data.rangeValid) &&
    !data.explicitPageInvalid;

  return (
    <section className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-[1120px] flex-col gap-5 px-4 py-6 sm:gap-7 sm:px-8 sm:py-8">
      <BookChildHeader
        child={data.child}
        backHref={detailHref}
        mobileLabel="Chuẩn bị đọc sách"
      />
      <SelectedChildIdentity child={data.child} />

      <header className="flex flex-col gap-2">
        <p className="text-label font-bold uppercase tracking-wide text-primary">
          ViRead · Bước cuối trước khi đọc
        </p>
        <h1 className="text-heading font-extrabold text-ink">
          Chuẩn bị đọc sách
        </h1>
        <p className="max-w-[760px] text-body leading-7 text-muted">
          Kiểm tra microphone trước khi bắt đầu buổi đọc.
        </p>
      </header>

      <article className="grid gap-5 rounded-card border border-line bg-white p-4 shadow-[0_6px_24px_rgba(33,61,66,0.06)] sm:grid-cols-[220px_1fr] sm:items-center sm:gap-7 sm:p-6">
        <BookCover book={data.book} className="mx-auto w-full max-w-[220px]" />
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-2xl font-extrabold text-ink">
              {data.book.title}
            </h2>
            {data.book.author ? (
              <p className="mt-1 text-body text-muted">{data.book.author}</p>
            ) : null}
          </div>
          {data.startPage && data.endPage && data.rangeValid ? (
            <p className="font-bold text-primary">
              Phạm vi đọc: Trang {data.startPage.page_number}–
              {data.endPage.page_number} ({data.rangePages.length} trang)
            </p>
          ) : null}
          {data.confidence !== null && data.startPage ? (
            <p className="text-sm text-muted">
              Trang OCR xác nhận: Trang {data.startPage.page_number} · Độ tin
              cậy {Math.round(data.confidence * 100)}%
            </p>
          ) : null}
          {data.explicitPageInvalid ? (
            <StatusMessage
              title="Không tìm thấy trang được nhận diện"
              tone="warning"
            >
              Trang OCR không nằm trong danh sách trang hợp lệ của sách. ViRead
              sẽ không tự đổi sang trang khác.
            </StatusMessage>
          ) : null}
          {!data.rangeValid && !data.explicitPageInvalid ? (
            <StatusMessage title="Khoảng trang không hợp lệ" tone="error">
              Hãy quay lại chi tiết sách và chọn lại trang bắt đầu, trang kết
              thúc hoặc khoảng liên tục.
            </StatusMessage>
          ) : null}
        </div>
      </article>

      <section
        aria-labelledby="microphone-check-title"
        className="rounded-card border border-primary/20 bg-sky p-4 sm:p-6"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-card bg-white text-primary">
            <Mic aria-hidden="true" className="size-7" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                className="text-xl font-extrabold text-ink"
                id="microphone-check-title"
              >
                Microphone
              </h2>
              <span className="rounded-control bg-white px-3 py-1 text-sm font-bold text-primary">
                {isVerifying
                  ? "Đang kiểm tra"
                  : microphoneVerified
                    ? "Đã xác minh thiết bị"
                    : statusText}
              </span>
            </div>
            <p className="mt-2 text-body text-muted">
              {microphoneDescription(permissionState, microphoneVerified)}
            </p>
            {permissionMessage ? (
              <StatusMessage
                className="mt-3"
                title="Chưa thể xác minh microphone"
                tone="error"
              >
                {permissionMessage}
              </StatusMessage>
            ) : null}
            <Button
              className="mt-4 sm:w-auto"
              disabled={isVerifying || isStarting}
              isLoading={isVerifying}
              onClick={() => void handleVerifyMicrophone()}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-5" />
              {microphoneVerified
                ? "Kiểm tra lại microphone"
                : "Kiểm tra và cấp quyền microphone"}
            </Button>
          </div>
          {microphoneVerified ? (
            <CheckCircle2
              aria-label="Microphone đã được xác minh"
              className="size-7 shrink-0 text-success-ink"
            />
          ) : null}
        </div>
      </section>

      <StatusMessage title="Quyền riêng tư" tone="info">
        ViRead chỉ mở luồng âm thanh tạm thời để kiểm tra microphone rồi dừng
        mọi track. Không lưu hoặc tải âm thanh trong bước này.
      </StatusMessage>

      {startError ? (
        <StatusMessage title="Chưa thể bắt đầu đọc" tone="error">
          {startError}
        </StatusMessage>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button
          className="sm:max-w-[320px]"
          disabled={!canStart}
          isLoading={isStarting}
          onClick={() => void handleStartReading()}
        >
          {isStarting ? "Đang tạo buổi đọc…" : "Bắt đầu đọc"}
          {!isStarting ? (
            <ArrowRight aria-hidden="true" className="size-5" />
          ) : null}
        </Button>
        <ButtonLink
          className="sm:max-w-[260px]"
          href={detailHref}
          variant="quiet"
        >
          <ArrowLeft aria-hidden="true" className="size-5" />
          Quay lại chi tiết sách
        </ButtonLink>
      </div>
      <p className="inline-flex items-center gap-2 text-sm text-muted">
        <ShieldCheck aria-hidden="true" className="size-4" />
        Buổi đọc chỉ được tạo sau khi microphone và trang sách đã được xác minh.
      </p>
    </section>
  );
}
