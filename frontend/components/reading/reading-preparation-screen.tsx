"use client";

import { ArrowLeft, Mic, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BookCover } from "@/components/books/book-cover";
import { Button, ButtonLink } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAppStore } from "@/components/providers/app-store-provider";
import { useBookService } from "@/hooks/use-book-service";
import { useChildService } from "@/hooks/use-child-service";
import { useReadingServices } from "@/hooks/use-reading-services";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { isServiceError } from "@/lib/api/service-error";
import { isAndroidNativeSpeechAvailable } from "@/lib/reading/native-speech-bridge";
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
  checking: "Chưa kiểm tra",
  granted: "Microphone đã sẵn sàng",
  prompt: "Chưa kiểm tra",
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
    return "Mic đã kiểm tra xong. Bé có thể bấm Bắt đầu đọc.";
  }
  switch (status) {
    case "checking":
    case "granted":
    case "prompt":
      return "Cấp quyền microphone để tiếp tục. Thiết bị tạm thời dùng để kiểm tra sẽ được đóng sau đó.";
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
        if (nextState === "granted" && isAndroidNativeSpeechAvailable()) {
          // On Android APK WebView where RECORD_AUDIO is already granted by
          // the OS, auto-confirm mic readiness to avoid an extra tap loop.
          setMicrophoneVerified(true);
          setPermissionMessage(null);
        } else if (previousState === "granted" && nextState !== "granted") {
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
      <section aria-busy="true" className="mx-auto w-full max-w-[980px] py-8">
        <span className="sr-only" role="status">
          Đang xác minh hồ sơ trẻ…
        </span>
        <Skeleton className="h-14 w-full max-w-sm rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 py-8">
        <StatusMessage title="Không thể xác minh hồ sơ trẻ" tone="error">
          Chưa thể xác nhận hồ sơ thuộc tài khoản hiện tại. Ba mẹ vui lòng thử
          lại.
        </StatusMessage>
        <Button
          className="min-[640px]:w-auto"
          onClick={retryChild}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }

  if (state.status === "loading") {
    return (
      <section aria-busy="true" className="mx-auto w-full max-w-[980px] py-8">
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
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-5 py-8">
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
        <ButtonLink
          className="min-[640px]:w-auto min-[640px]:max-w-72"
          href="/books"
          variant="secondary"
        >
          <ArrowLeft aria-hidden="true" className="size-5" />
          Về thư viện sách
        </ButtonLink>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 py-8">
        <StatusMessage title="Chưa tải được thông tin đọc sách" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
        <Button
          className="min-[640px]:w-auto"
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
  const statusText = microphoneVerified
    ? "Microphone đã sẵn sàng"
    : permissionState === "granted"
      ? "Microphone đã được cấp quyền"
      : microphoneStatusLabels[permissionState];
  const canStart =
    microphoneVerified &&
    !isVerifying &&
    !isStarting &&
    Boolean(data.startPage && data.endPage && data.rangeValid) &&
    !data.explicitPageInvalid;

  return (
    <section className="mx-auto flex w-full max-w-[800px] flex-col gap-3 min-[640px]:gap-4">
      <header className="flex flex-col gap-1 min-[640px]:gap-2">
        <h1 className="text-xl font-extrabold leading-tight text-ink md:text-heading">
          Chuẩn bị đọc sách
        </h1>
        <p className="max-w-[760px] text-sm leading-6 text-muted md:text-body md:leading-7">
          Kiểm tra mic, rồi bé có thể bắt đầu đọc.
        </p>
      </header>

      <article className="flex items-start gap-3 rounded-card border border-border bg-white p-3.5 min-[640px]:items-center min-[640px]:gap-4 min-[640px]:p-4">
        <BookCover book={data.book} size="small" showTitle={false} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <div>
            <h2 className="break-words text-xl font-extrabold text-ink">
              {data.book.title}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {[data.book.author, data.child.alias, `Lớp ${data.child.grade}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {data.startPage && data.endPage && data.rangeValid ? (
            <p className="w-fit rounded-control bg-sky px-2 py-1 text-sm font-semibold text-primary-hover">
              Phạm vi đọc: Trang {data.startPage.page_number}–
              {data.endPage.page_number}
            </p>
          ) : null}
          {data.startPage && data.confidence !== null ? (
            <p className="text-sm text-primary">
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
        className="rounded-card border border-border bg-white p-3.5 min-[640px]:p-5"
      >
        <h2
          className="flex items-center gap-2 text-base font-extrabold text-ink md:text-lg"
          id="microphone-check-title"
        >
          <Mic aria-hidden="true" className="size-5 text-primary" /> Kiểm tra
          microphone
        </h2>
        <p className="mt-1.5 text-sm text-muted min-[640px]:mt-3 md:text-body">
          ViRead chỉ ghi âm sau khi buổi đọc bắt đầu.
        </p>
        <div
          role="status"
          className={`mt-2.5 rounded-control p-3 min-[640px]:mt-3 ${microphoneVerified ? "bg-sky" : "bg-cream"}`}
        >
          <p className="font-bold text-ink">
            {isVerifying ? "Đang kiểm tra" : statusText}
          </p>
          <p className="mt-1 text-sm text-muted min-[640px]:mt-2 md:text-body">
            {permissionMessage ??
              microphoneDescription(permissionState, microphoneVerified)}
          </p>
        </div>
        <Button
          className="mt-3 min-h-11! w-full min-[640px]:w-auto"
          disabled={isVerifying || isStarting}
          isLoading={isVerifying}
          onClick={() => void handleVerifyMicrophone()}
          variant={microphoneVerified ? "secondary" : "primary"}
        >
          {microphoneVerified
            ? "Kiểm tra lại microphone"
            : "Kiểm tra và cấp quyền microphone"}
        </Button>
      </section>

      {startError ? (
        <StatusMessage title="Chưa thể bắt đầu đọc" tone="error">
          {startError}
        </StatusMessage>
      ) : null}

      <div className="flex flex-col gap-2 min-[640px]:flex-row min-[640px]:justify-end">
        <Button
          className="min-h-12! min-[640px]:w-auto"
          disabled={!canStart}
          isLoading={isStarting}
          onClick={() => void handleStartReading()}
        >
          {isStarting ? "Đang tạo buổi đọc…" : "Bắt đầu đọc"}
        </Button>
        <ButtonLink
          className="min-h-12! min-[640px]:order-first min-[640px]:w-auto"
          href={detailHref}
          variant="quiet"
        >
          Quay lại chi tiết sách
        </ButtonLink>
      </div>
    </section>
  );
}
