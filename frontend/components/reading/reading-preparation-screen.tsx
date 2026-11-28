"use client";

import { ArrowLeft, Mic, RefreshCw, Volume2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { BookCover } from "@/components/books/book-cover";
import { Button, ButtonLink } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAppStore } from "@/components/providers/app-store-provider";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useBookService } from "@/hooks/use-book-service";
import { useChildService } from "@/hooks/use-child-service";
import { useReadingServices } from "@/hooks/use-reading-services";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { isServiceError } from "@/lib/api/service-error";
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
import { subscribeSpeechPreferences } from "@/lib/reading/speech-preferences";
import {
  getVoicePreloadState,
  preloadReadingVoiceEngines,
  subscribeVoicePreloadState,
} from "@/lib/reading/voice-preloader";
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

type ReadingTranslateFn = ReturnType<typeof useTranslations>;

function microphoneDescription(
  status: MicrophonePermissionUiState,
  verified: boolean,
  t: ReadingTranslateFn,
): string {
  if (verified) {
    return t("preparation.statusHints.granted");
  }
  switch (status) {
    case "checking":
    case "granted":
    case "prompt":
      return t("preparation.statusHints.prompt");
    case "denied":
    case "unsupported":
    case "no_device":
    case "device_busy":
    case "error":
      return t(`preparation.statusHints.${status}`);
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
  const { formatNumber } = useI18n();
  const t = useTranslations("reading");
  const tc = useTranslations("child");
  const router = useRouter();
  const bookService = useBookService();
  const childService = useChildService();
  const { devicePermissionService, readingService } = useReadingServices();
  const speechPlayer = useSpeechPlayer();
  const preloadState = useSyncExternalStore(
    subscribeVoicePreloadState,
    getVoicePreloadState,
    getVoicePreloadState,
  );
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
    // Start warming STT (WASM/Android) & TTS immediately on entering preparation.
    void preloadReadingVoiceEngines({
      bookId: bookId ?? null,
      pageId: pageId ?? null,
    });
    return () => {
      mountedRef.current = false;
      permissionCleanupRef.current?.();
      permissionCleanupRef.current = null;
    };
  }, [bookId, pageId]);

  useEffect(() => {
    if (state.status !== "ready" || !state.data.startPage) return;
    hydrateTeacherVoiceFromChildProfile(state.data.child);
    const isPrivateBook = state.data.book.visibility_scope === "PARENT_PRIVATE";
    const preloadArgs = {
      bookId: state.data.book.id,
      pageId: state.data.startPage.page_id,
      pageRevisionId: state.data.startPage.current_verified_revision_id,
      isPrivateBook,
    };
    void preloadReadingVoiceEngines(preloadArgs);
    return subscribeSpeechPreferences(() => {
      void preloadReadingVoiceEngines({
        ...preloadArgs,
        warmWasmStt: false,
        warmTts: true,
      });
    });
  }, [state]);

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
        if (nextState === "granted") {
          setMicrophoneVerified(true);
          setPermissionMessage(null);
        } else if (previousState === "granted") {
          setMicrophoneVerified(false);
          setPermissionMessage(t("preparation.permChangedError"));
        } else if (nextState === "denied") {
          setMicrophoneVerified(false);
          setPermissionMessage(t("preparation.permDeniedAlert"));
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
  }, [childState.status, selectedChildKey, devicePermissionService, t]);

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
        setPermissionMessage(t("preparation.permCheckFailed"));
      }
    } finally {
      if (requestId === verificationRequestIdRef.current) {
        verificationInFlightRef.current = false;
        if (mountedRef.current) setIsVerifying(false);
      }
    }
  }, [childState.status, contextKey, devicePermissionService, t]);

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
      hydrateTeacherVoiceFromChildProfile(currentChild);
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
        setStartError(t("preparation.createSessionFailed"));
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
    t,
  ]);

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[980px] px-4 py-8"
      >
        <span className="sr-only" role="status">
          {tc("verification.loading")}
        </span>
        <Skeleton className="h-14 w-full max-w-sm rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title={tc("verification.errorTitle")} tone="error">
          {tc("verification.errorBody")}
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" />
          {tc("verification.retry")}
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
          {t("preparation.loadingBook")}
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
            unavailable
              ? t("preparation.bookUnavailableTitle")
              : t("preparation.bookNotFoundTitle")
          }
          tone="error"
        >
          {unavailable
            ? t("preparation.bookUnavailableDesc")
            : t("preparation.bookNotFoundDesc")}
        </StatusMessage>
        <ButtonLink className="sm:max-w-72" href="/books" variant="secondary">
          <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-5" />
          {t("preparation.backToLibrary")}
        </ButtonLink>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title={t("preparation.loadErrorTitle")} tone="error">
          {t("preparation.loadErrorBody")}
        </StatusMessage>
        <Button
          className="sm:w-auto"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          {t("session.retry")}
        </Button>
      </section>
    );
  }

  const data = state.data;
  const detailHref = `/books/${encodeURIComponent(data.book.id)}${pageId ? `?pageId=${encodeURIComponent(pageId)}` : ""}`;
  const statusText = microphoneVerified
    ? t("preparation.micReady")
    : permissionState === "granted"
      ? t("preparation.micGranted")
      : t(`preparation.statusLabels.${permissionState}`);
  const canStart =
    microphoneVerified &&
    !isVerifying &&
    !isStarting &&
    Boolean(data.startPage && data.endPage && data.rangeValid) &&
    !data.explicitPageInvalid;

  return (
    <section className="mx-auto flex w-full max-w-[800px] flex-col gap-3 px-3.5 py-3 pb-24 sm:gap-4 sm:px-0 sm:py-0 sm:pb-0">
      <header className="flex flex-col gap-1 sm:gap-2">
        <h1 className="text-xl font-extrabold leading-tight text-ink sm:text-heading">
          {t("preparation.heading")}
        </h1>
        <p className="max-w-[760px] text-sm leading-relaxed text-muted sm:text-body sm:leading-7">
          {t("preparation.subtitle")}
        </p>
      </header>

      <article className="flex items-start gap-3 rounded-card border border-border bg-white p-3 sm:items-center sm:gap-4 sm:p-4">
        <BookCover book={data.book} size="small" showTitle={false} />
        <div className="flex min-w-0 flex-col gap-1 sm:gap-1.5">
          <div>
            <h2
              className="viread-learning-content break-words text-base font-extrabold text-ink sm:text-xl"
              dir="ltr"
              lang="vi"
            >
              {data.book.title}
            </h2>
            <p className="mt-0.5 text-xs text-muted sm:mt-1 sm:text-sm">
              {[
                data.book.author,
                data.child.alias,
                tc("switcher.gradeLabel", { grade: data.child.grade }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {data.startPage && data.endPage && data.rangeValid ? (
            <p className="w-fit rounded-control bg-sky px-2 py-0.5 text-xs font-semibold text-primary-hover sm:py-1 sm:text-sm">
              {t("preparation.rangeSummary", {
                start: formatNumber(data.startPage.page_number),
                end: formatNumber(data.endPage.page_number),
              })}
            </p>
          ) : null}
          {data.startPage && data.confidence !== null ? (
            <p className="text-xs text-primary sm:text-sm">
              {t("preparation.ocrMatchSummary", {
                page: formatNumber(data.startPage.page_number),
                percent: Math.round(data.confidence * 100),
              })}
            </p>
          ) : null}
          {data.explicitPageInvalid ? (
            <StatusMessage
              title={t("preparation.matchedPageMissingTitle")}
              tone="warning"
            >
              {t("preparation.matchedPageMissingDesc")}
            </StatusMessage>
          ) : null}
          {!data.rangeValid && !data.explicitPageInvalid ? (
            <StatusMessage
              title={t("preparation.invalidRangeTitle")}
              tone="error"
            >
              {t("preparation.invalidRangeDesc")}
            </StatusMessage>
          ) : null}
        </div>
      </article>

      <section
        aria-labelledby="microphone-check-title"
        className="rounded-card border border-border bg-white p-3.5 sm:p-5"
      >
        <h2
          className="flex items-center gap-2 text-base font-extrabold text-ink sm:text-lg"
          id="microphone-check-title"
        >
          <Mic aria-hidden="true" className="size-5 text-primary" />{" "}
          {t("preparation.micCheckSectionTitle")}
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted sm:mt-3 sm:text-body">
          {t("preparation.micPrivacyNote")}
        </p>
        <div
          role="status"
          className={`mt-2.5 rounded-control p-3 sm:mt-3 ${microphoneVerified ? "bg-sky" : "bg-cream"}`}
        >
          <p className="text-sm font-bold text-ink sm:text-base">
            {isVerifying ? t("preparation.checking") : statusText}
          </p>
          <p className="mt-1 text-xs text-muted sm:mt-2 sm:text-body">
            {permissionMessage ??
              microphoneDescription(permissionState, microphoneVerified, t)}
          </p>
        </div>
        <Button
          className="mt-3 min-h-11 text-sm sm:w-auto sm:text-button"
          disabled={isVerifying || isStarting}
          isLoading={isVerifying}
          onClick={() => void handleVerifyMicrophone()}
          variant={microphoneVerified ? "secondary" : "primary"}
        >
          {microphoneVerified
            ? t("preparation.recheckMic")
            : t("preparation.checkAndAllowMic")}
        </Button>

        <div
          aria-live="polite"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-control border border-border bg-canvas/70 px-3 py-2.5"
          data-testid="preparation-voice-preload-status"
        >
          <div className="flex items-center gap-2 text-sm text-ink">
            <Volume2
              aria-hidden="true"
              className="size-4 shrink-0 text-primary"
            />
            <span className="font-semibold">
              {preloadState.sttStatus === "ready" &&
              preloadState.ttsStatus === "ready"
                ? `Giọng đọc & nhận diện giọng nói${preloadState.sttEngineLabel ? ` (${preloadState.sttEngineLabel})` : ""} đã sẵn sàng.`
                : preloadState.sttStatus === "loading"
                  ? "Đang tải sẵn bộ nhận diện giọng nói & giọng đọc cho bé..."
                  : "Giọng đọc & nhận diện giọng nói sẽ sẵn sàng ngay khi bé đọc."}
            </span>
          </div>
          <ReadingVoiceSettings
            childId={data.child.id}
            disabled={isStarting}
            fallbackNotice={speechPlayer.fallbackNotice}
            isPreviewing={speechPlayer.isPlaying && !speechPlayer.isPaused}
            onPreview={(sample) =>
              speechPlayer.play(sample, {
                coaching: true,
                cacheScope: "COACHING",
                isPrivateBook: false,
                bypassSessionLock: true,
                utteranceKind: "voice_preview",
              })
            }
            onStopPreview={speechPlayer.stop}
          />
        </div>
      </section>

      {startError ? (
        <StatusMessage title={t("preparation.startFailedTitle")} tone="error">
          {startError}
        </StatusMessage>
      ) : null}

      <div className="fixed inset-x-0 bottom-0 z-[45] flex flex-row-reverse items-center gap-2 border-t border-border bg-white/95 px-3.5 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(35,62,64,0.08)] backdrop-blur-sm sm:static sm:z-auto sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none">
        <Button
          className="min-h-12 flex-1 sm:w-auto sm:flex-none"
          disabled={!canStart}
          isLoading={isStarting}
          onClick={() => void handleStartReading()}
        >
          {isStarting
            ? t("preparation.starting")
            : t("preparation.startReading")}
        </Button>
        <ButtonLink
          className="min-h-12 w-auto shrink-0 border border-border px-3 text-sm sm:order-first sm:border-0 sm:px-4 sm:text-button"
          href={detailHref}
          variant="quiet"
        >
          {t("preparation.backToBookDetail")}
        </ButtonLink>
      </div>
    </section>
  );
}
