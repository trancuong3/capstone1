"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ComprehensionQuestion } from "@/components/reading/comprehension-question";
import { ManualPageSelector } from "@/components/reading/manual-page-selector";
import { ReadingLayout } from "@/components/reading/reading-layout";
import { ReadingReady } from "@/components/reading/reading-ready";
import { ReadingStatusDialog } from "@/components/reading/reading-status-dialog";
import { SessionComplete } from "@/components/reading/session-complete";
import { StatusBanner } from "@/components/reading/status-banner";
import { TutorMessage } from "@/components/reading/tutor-message";
import { useReadingServices } from "@/hooks/use-reading-services";
import { isServiceError } from "@/lib/api/service-error";
import type { BookDetailDTO, BookPagePreviewDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type {
  DeviceKind,
  DevicePermissionSnapshotUI,
  ReadingCompletionSummaryUI,
  ReadingConnectionState,
  ReadingPageDTO,
  ReadingReconnectDemoMode,
  ReadingSessionState,
  ReadingUiState,
  TutorAction,
} from "@/types/reading";

interface ReadingScreenProps {
  initialPageId?: string;
  initialUiState: ReadingUiState;
  reconnectMode: ReadingReconnectDemoMode;
  sessionId: string;
}

interface ReadingScreenData {
  book: BookDetailDTO;
  child: ChildProfileDTO;
  completion: ReadingCompletionSummaryUI;
  pagePreviews: readonly BookPagePreviewDTO[];
  permissions: DevicePermissionSnapshotUI;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: ReadingScreenData }
  | { status: "not-found" }
  | { status: "error" };

export function ReadingScreen({
  initialPageId,
  initialUiState,
  reconnectMode,
  sessionId,
}: ReadingScreenProps) {
  const services = useReadingServices();
  const [loadKey, setLoadKey] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [uiState, setUiState] = useState<ReadingUiState>(initialUiState);
  const [canonicalState, setCanonicalState] =
    useState<ReadingSessionState>("CREATED");
  const [page, setPage] = useState<ReadingPageDTO | null>(null);
  const [currentWordId, setCurrentWordId] = useState<string | null>(null);
  const [selectedManualPageId, setSelectedManualPageId] = useState<
    string | null
  >(null);
  const [isBusy, setIsBusy] = useState(false);
  const [connectionState, setConnectionState] =
    useState<ReadingConnectionState>(() =>
      initialUiState === "reconnecting" || initialUiState === "stt-error"
        ? "reconnecting"
        : "connected",
    );
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [tutorAction, setTutorAction] = useState<TutorAction | null>(null);
  const finishStartedRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const session = await services.readingService.get(sessionId);
        const [
          book,
          child,
          currentPage,
          pagePreviews,
          permissions,
          completion,
        ] = await Promise.all([
          services.bookService.get(session.book_id),
          services.childService.get(session.child_id),
          services.readingService.getCurrentPage(sessionId),
          services.bookService.listPages(session.book_id),
          services.devicePermissionService.getSnapshot(),
          services.readingService.getCompletionSummary(sessionId),
        ]);

        const selectedPage = initialPageId
          ? await services.pageMatchService.selectPage(sessionId, initialPageId)
          : currentPage;

        if (!active) return;

        setPage(selectedPage);
        setCurrentWordId(selectedPage.words[3]?.word_id ?? null);
        setSelectedManualPageId(selectedPage.page_id);
        setCanonicalState(session.state);
        setLoadState({
          status: "ready",
          data: { book, child, completion, pagePreviews, permissions },
        });
      } catch (error) {
        if (active) {
          setLoadState({
            status:
              isServiceError(error) && error.code === "RESOURCE_NOT_FOUND"
                ? "not-found"
                : "error",
          });
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [initialPageId, loadKey, services, sessionId]);

  useEffect(() => {
    if (loadState.status !== "ready") return;
    return services.readingSocketAdapter.subscribe(
      sessionId,
      setCanonicalState,
    );
  }, [loadState.status, services.readingSocketAdapter, sessionId]);

  useEffect(() => {
    if (loadState.status !== "ready" || uiState !== "page-turn" || !page) {
      return;
    }

    const nextPage = loadState.data.pagePreviews.find(
      (candidate) => candidate.page_id !== page.page_id,
    );
    if (!nextPage) return;

    let active = true;
    void services.pageMatchService
      .selectPage(sessionId, nextPage.page_id)
      .then((matchedPage) => {
        if (!active) return;
        setPage(matchedPage);
        setCurrentWordId(matchedPage.words[3]?.word_id ?? null);
        setSelectedManualPageId(matchedPage.page_id);
        setCanonicalState("LISTENING");
        setUiState("reading");
      });

    return () => {
      active = false;
    };
  }, [loadState, page, services.pageMatchService, sessionId, uiState]);

  async function startReading() {
    if (isBusy) return;
    setIsBusy(true);
    const nextState = await services.readingSocketAdapter.sendControl(
      sessionId,
      "start",
    );
    if (!mountedRef.current) return;
    setCanonicalState(nextState);
    setConnectionState("connected");
    setUiState("reading");
    setIsBusy(false);
  }

  async function resumeReading() {
    if (isBusy) return;
    setIsBusy(true);
    const nextState = await services.readingSocketAdapter.sendControl(
      sessionId,
      "resume",
    );
    if (!mountedRef.current) return;
    setCanonicalState(nextState);
    setConnectionState("connected");
    setUiState("reading");
    setIsBusy(false);
  }

  async function retryPermission(kind: DeviceKind) {
    if (isBusy) return;
    setIsBusy(true);
    await services.devicePermissionService.retry(kind);
    if (!mountedRef.current) return;
    setConnectionState("connected");
    setUiState("reading");
    setCanonicalState("LISTENING");
    setIsBusy(false);
  }

  async function retryPageMatch() {
    if (isBusy) return;
    setIsBusy(true);
    const matchedPage =
      await services.pageMatchService.retryCurrentPage(sessionId);
    if (!mountedRef.current) return;
    setPage(matchedPage);
    setCurrentWordId(matchedPage.words[3]?.word_id ?? null);
    setSelectedManualPageId(matchedPage.page_id);
    setCanonicalState("LISTENING");
    setConnectionState("connected");
    setUiState("reading");
    setIsBusy(false);
  }

  async function confirmManualPage() {
    if (!selectedManualPageId || isBusy) return;
    setIsBusy(true);
    const matchedPage = await services.pageMatchService.selectPage(
      sessionId,
      selectedManualPageId,
    );
    if (!mountedRef.current) return;
    setPage(matchedPage);
    setCurrentWordId(matchedPage.words[3]?.word_id ?? null);
    setCanonicalState("LISTENING");
    setConnectionState("connected");
    setUiState("reading");
    setIsBusy(false);
  }

  async function reconnect(mode: ReadingReconnectDemoMode) {
    if (isBusy) return;
    setIsBusy(true);
    setConnectionState("reconnecting");
    const nextConnection = await services.readingSocketAdapter.reconnect(
      sessionId,
      mode,
    );
    if (!mountedRef.current) return;
    setConnectionState(nextConnection);
    if (nextConnection === "recovered") {
      setCanonicalState("LISTENING");
      setUiState("reading");
    }
    setIsBusy(false);
  }

  async function requestTutor() {
    if (!page || !currentWordId || isBusy) return;
    setTutorOpen(true);
    setIsBusy(true);
    const action = await services.tutorService.requestReadExample(
      sessionId,
      currentWordId,
    );
    if (!mountedRef.current) return;
    setTutorAction(action);
    setIsBusy(false);
  }

  async function retryTutor() {
    if (!page || !currentWordId || isBusy) return;
    setIsBusy(true);
    const baseAction =
      tutorAction ??
      (await services.tutorService.requestReadExample(
        sessionId,
        currentWordId,
      ));
    if (!mountedRef.current) return;
    const nextAction = await services.tutorService.retryReadExample(baseAction);
    if (!mountedRef.current) return;
    setTutorAction(nextAction);
    setIsBusy(false);
  }

  async function finishReading() {
    if (finishStartedRef.current) return;
    finishStartedRef.current = true;
    setIsBusy(true);
    await Promise.all([
      services.readingService.finish(sessionId),
      services.readingSocketAdapter.sendControl(sessionId, "finish"),
    ]);
    if (!mountedRef.current) return;
    setCanonicalState("FINISHED");
    setConfirmFinish(false);
    setUiState("complete");
    setIsBusy(false);
  }

  if (loadState.status === "error" || loadState.status === "not-found") {
    const notFound = loadState.status === "not-found";
    const title = notFound
      ? "Không tìm thấy buổi đọc"
      : "Chưa mở được buổi đọc";

    return (
      <section className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col justify-center gap-4 p-4">
        <h1 className="text-heading font-extrabold text-ink">{title}</h1>
        <StatusMessage tone="error">
          {notFound
            ? "Buổi đọc không tồn tại hoặc không thuộc tài khoản hiện tại."
            : "Có lỗi xảy ra. Ba mẹ vui lòng thử lại hoặc quay về thư viện."}
        </StatusMessage>
        {!notFound ? (
          <Button
            onClick={() => {
              setLoadState({ status: "loading" });
              setLoadKey((key) => key + 1);
            }}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-5" />
            Thử lại
          </Button>
        ) : null}
        <ButtonLink href="/books" variant="quiet">
          <ArrowLeft aria-hidden="true" className="size-5" />
          Về thư viện
        </ButtonLink>
      </section>
    );
  }

  if (loadState.status === "loading" || !page) {
    return (
      <section
        aria-busy="true"
        aria-label="Đang chuẩn bị buổi đọc"
        className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 p-4"
      >
        <span className="sr-only" role="status">
          Đang chuẩn bị buổi đọc…
        </span>
        <Skeleton className="h-12 w-full rounded-control" />
        <Skeleton className="min-h-[680px] w-full rounded-card" />
        <Skeleton className="h-20 w-full rounded-card" />
      </section>
    );
  }

  const { book, child, completion, pagePreviews, permissions } = loadState.data;
  const detailHref = `/books/${encodeURIComponent(book.id)}?childId=${encodeURIComponent(child.id)}`;
  const booksHref = `/books?childId=${encodeURIComponent(child.id)}`;
  const safety = services.readingSocketAdapter.getSafetySnapshot(uiState);
  const currentWord =
    page.words.find((word) => word.word_id === currentWordId)?.text ?? "đang";

  if (uiState === "ready") {
    return (
      <ReadingReady
        book={book}
        child={child}
        isStarting={isBusy}
        onStart={() => void startReading()}
        permissions={permissions}
      />
    );
  }

  if (uiState === "question") {
    return (
      <ComprehensionQuestion
        child={child}
        onComplete={() => setUiState("complete")}
        sessionId={sessionId}
      />
    );
  }

  if (uiState === "complete") {
    return (
      <SessionComplete
        booksHref={booksHref}
        child={child}
        sessionId={sessionId}
        summary={completion}
      />
    );
  }

  return (
    <div
      data-canonical-state={canonicalState}
      data-child-error-count={safety.child_error_events.length}
      data-evidence-valid={safety.evidence_valid}
      data-scoring-active={safety.scoring_active}
    >
      <ReadingLayout
        bookTitle={book.title}
        controlsDisabled={uiState !== "reading" || isBusy}
        currentWordId={currentWordId}
        exitHref={detailHref}
        isListening={uiState === "reading"}
        isPageTransitioning={uiState === "page-turn"}
        onFinish={() => setConfirmFinish(true)}
        onHelp={() => void requestTutor()}
        onManualPage={() => setUiState("manual-page")}
        onPause={() => {
          setCanonicalState("PAUSED");
          setUiState("paused");
        }}
        page={page}
      >
        {uiState === "page-turn" ? (
          <StatusBanner className="fixed left-1/2 top-20 z-40 w-[calc(100%-32px)] max-w-[520px] -translate-x-1/2">
            Đang chuyển trang và liên kết lại từ đang đọc…
          </StatusBanner>
        ) : null}
      </ReadingLayout>

      {confirmFinish ? (
        <ReadingStatusDialog
          body="Mình sẽ lưu lại phần bé đã đọc. Khi nào thích, mình lại đọc cùng nhau."
          closeOnEscape
          onClose={() => setConfirmFinish(false)}
          primaryAction={{
            isLoading: isBusy,
            label: "Lưu và dừng",
            onClick: () => void finishReading(),
          }}
          secondaryAction={{
            label: "Đọc tiếp",
            onClick: () => setConfirmFinish(false),
          }}
          title="Bé muốn nghỉ hôm nay?"
        />
      ) : uiState === "paused" ? (
        <ReadingStatusDialog
          body="Khi sẵn sàng, mình đọc tiếp nhé. Đánh giá đang tạm dừng và không tạo lỗi đọc."
          closeOnEscape
          onClose={() => void resumeReading()}
          primaryAction={{
            isLoading: isBusy,
            label: "Đọc tiếp",
            onClick: () => void resumeReading(),
          }}
          secondaryAction={{
            label: "Dừng buổi đọc",
            onClick: () => setConfirmFinish(true),
          }}
          title="Bé đang nghỉ một chút"
        />
      ) : uiState === "camera-denied" ? (
        <ReadingStatusDialog
          body="Bé hãy nhờ ba mẹ bật quyền camera trong trình duyệt. Đây là trạng thái mô phỏng, camera chưa được mở."
          onClose={() => undefined}
          primaryAction={{
            isLoading: isBusy,
            label: "Thử lại",
            onClick: () => void retryPermission("camera"),
          }}
          secondaryAction={{
            label: "Chọn trang thủ công",
            onClick: () => setUiState("manual-page"),
          }}
          title="Camera chưa sẵn sàng"
        />
      ) : uiState === "microphone-denied" ? (
        <ReadingStatusDialog
          body="Nhờ ba mẹ bật quyền micro trong trình duyệt nhé. Hệ thống đang ngừng nghe và không kết luận bé đọc sai."
          onClose={() => undefined}
          primaryAction={{
            isLoading: isBusy,
            label: "Thử lại",
            onClick: () => void retryPermission("microphone"),
          }}
          secondaryAction={{
            label: "Kết thúc an toàn",
            onClick: () => setConfirmFinish(true),
          }}
          title="Mình chưa nghe thấy giọng bé"
        />
      ) : uiState === "page-confidence-low" ? (
        <ReadingStatusDialog
          body={
            <div className="space-y-2">
              <p>Đặt sách ngay ngắn hơn một chút nhé.</p>
              <p>
                Đánh giá đang tạm dừng; chưa có trang chắc chắn nên không tạo
                lỗi đọc.
              </p>
            </div>
          }
          onClose={() => undefined}
          primaryAction={{
            isLoading: isBusy,
            label: "Thử lại",
            onClick: () => void retryPageMatch(),
          }}
          secondaryAction={{
            label: "Chọn trang",
            onClick: () => setUiState("manual-page"),
          }}
          title="Mình chưa nhìn rõ trang sách"
        />
      ) : uiState === "manual-page" ? (
        <ManualPageSelector
          isSaving={isBusy}
          onCancel={() => setUiState("reading")}
          onConfirm={() => void confirmManualPage()}
          onSelect={setSelectedManualPageId}
          pages={pagePreviews}
          selectedPageId={selectedManualPageId}
        />
      ) : uiState === "reconnecting" || uiState === "stt-error" ? (
        <ReadingStatusDialog
          body={
            <div className="space-y-2">
              <p>
                {uiState === "stt-error"
                  ? "Mình chưa thể nghe hoặc nhận dạng tạm thời."
                  : "Đang kết nối lại. Mình vẫn giữ chỗ bé vừa đọc."}
              </p>
              <p>Đánh giá đã dừng; khoảng mất kết nối không tạo lỗi đọc.</p>
              {connectionState === "timed-out" ? (
                <StatusMessage title="Chưa kết nối lại được" tone="error">
                  Ba mẹ có thể thử lại hoặc kết thúc buổi đọc an toàn.
                </StatusMessage>
              ) : null}
            </div>
          }
          onClose={() => undefined}
          primaryAction={{
            isLoading: isBusy,
            label: uiState === "stt-error" ? "Thử nghe lại" : "Kết nối lại",
            onClick: () =>
              void reconnect(
                uiState === "stt-error" ? "recover" : reconnectMode,
              ),
          }}
          secondaryAction={{
            label: "Kết thúc an toàn",
            onClick: () => setConfirmFinish(true),
          }}
          title={
            uiState === "stt-error"
              ? "Mình chưa nghe rõ"
              : "Đợi mình một chút nhé…"
          }
        />
      ) : null}

      {uiState === "tts-error" || tutorOpen ? (
        <TutorMessage
          action={tutorAction}
          isRetrying={isBusy}
          onClose={() => {
            setTutorOpen(false);
            setUiState("reading");
          }}
          onRetry={() => void retryTutor()}
          ttsFailed={uiState === "tts-error"}
          word={currentWord}
        />
      ) : null}

      <span className="sr-only" aria-live="polite">
        Trạng thái kết nối: {connectionLabel(connectionState)}. Số lỗi đọc được
        tạo trong khoảng này: 0.
      </span>
    </div>
  );
}

function connectionLabel(state: ReadingConnectionState): string {
  const labels: Record<ReadingConnectionState, string> = {
    connected: "đã kết nối",
    reconnecting: "đang kết nối lại",
    recovered: "đã khôi phục kết nối",
    "timed-out": "kết nối lại quá thời gian",
  };

  return labels[state];
}
