"use client";

import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Users,
  Volume2,
} from "lucide-react";
import dynamic, { type DynamicOptionsLoadingProps } from "next/dynamic";
import {
  Component,
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button, ButtonLink } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import {
  buildDuetTurnsForPage,
  resolveActiveDuetTurn,
} from "@/lib/reading/duet-reading";
import { resolvePostFinishUiState } from "@/lib/reading/post-finish-questions";
import { ReadingLayout } from "@/components/reading/reading-layout";
import { ReadingReady } from "@/components/reading/reading-ready";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import {
  detectBrowserWasmSttSupport,
  getBrowserWasmSttClient,
  type WasmSttProgressEvent,
} from "@/lib/reading/browser-wasm-stt";
import {
  isInjectedTestSpeechRecognition,
  LocalSegmentSpeechRecognition,
  resolveLocalFirstSpeechRecognitionConstructor,
  shouldPreferAndroidNativeStt,
} from "@/lib/reading/local-segment-speech-recognition";
import {
  getAndroidSpeechCapabilities,
  isAndroidNativeSpeechAvailable,
} from "@/lib/reading/native-speech-bridge";
import {
  buildPhonicsLesson,
  READING_MASTERY_LABELS,
  type PhonicsLessonPlan,
  type SupportedPhonicsLessonPlan,
} from "@/lib/reading/phonics-lesson";
import {
  getActiveSessionVoiceLock,
  getEffectiveTeacherPersona,
  getEffectiveVoiceId,
  getSessionVoiceAudit,
  getVoicePolicyPreferences,
  hasPendingSessionVoiceSwitch,
  hydrateTeacherVoiceFromChildProfile,
  lockSessionVoice,
  setActiveVoiceSession,
  subscribeVoicePolicy,
} from "@/lib/reading/session-voice-lock";
import {
  awaitSttReadyBeforeListening,
  awaitVoiceEnginesReadyBeforeListening,
  preloadReadingVoiceEngines,
  warmWasmTtsIfNeeded,
} from "@/lib/reading/voice-preloader";
import {
  fetchVoiceEngineHealth,
  getFreshVoiceEngineHealth,
  getVoiceEngineHealthForRouting,
  getVoiceEngineStatus,
  isPermanentlyHostedLocalUnconfigured,
  mapLocalVoiceToGoogleBackup,
  markHostedLocalUnconfigured,
  recordSttEngineUsage,
  recordTtsEngineUsage,
} from "@/lib/reading/voice-engine-status";
import {
  createVoiceStudioService,
  type WordTiming,
} from "@/lib/api/voice-studio-service";
import {
  adaptTextToTeacherPersona,
  resolveVoiceGender,
} from "@/lib/reading/voice-persona";
import {
  buildContrastiveKeyterms,
  classifyRetryTranscript,
  classifyYesNoVoiceIntent,
  hasConfusableShortCoda,
  isAssistantPromptBleed,
  normalizeShortWordTranscript,
  shortWordContext,
  stripNonSpeechAnnotations,
} from "@/lib/reading/retry-word-recognition";
import {
  normalizeVietnameseText,
  tokenizeVietnameseText,
} from "@/lib/reading/vietnamese-text";
import {
  isSpellingHelpRequest,
  isWordHelpRequest,
  MAX_WORD_HELP_ROUNDS,
  WORD_HELP_SILENCE_LIMIT,
} from "@/lib/reading/word-help";
import {
  hasShortWordBlockingAudioIssue,
  hasUnusableAudio,
} from "@/lib/reading/audio-quality";
import {
  PHRASE_CAPTURE_CONFIG,
  SHORT_WORD_CAPTURE_CONFIG,
  SHORT_WORD_CONTEXT_RETRY_THRESHOLD,
  hasShortWordSpeechActivity,
  shouldAttemptShortWordKeytermPass2,
  shouldAutoStopShortWordCapture,
} from "@/lib/reading/word-practice-engine";
import {
  hasUsableTranscript,
  hasUsableBrowserConfidence,
  hasUsableChildWindowBrowserConfidence,
  hasUsablePhonicsBrowserConfidence,
  isConfidentExactBrowserRead,
  isConfidentPhonicsBrowserRead,
  hasHighConfidenceKeytermResult,
} from "@/lib/reading/recognition-evidence";
import {
  generateSpokenPhonicsGuide,
  isLikelyPhonicsCueForWord,
} from "@/lib/reading/phonics-spelling";
import { classifyReadingMistake } from "@/lib/reading/reading-mistake-classifier";
import type { CompanionBubbleState } from "@/components/reading/reading-companion-bubble";
import type { WordTimestamp } from "@/lib/api/speech-service";
import {
  AUTO_HELP_LADDER_CONFIG,
  ReadingAutomationRuntime,
  type AutomationClock,
  type AutomationEffect,
  type AutomationMessage,
  type AutomationState,
} from "@/lib/reading/reading-automation";
import {
  BrowserTranscriptCollector,
  extractSegmentResultMeta,
  resolveTranscriptForSegment,
  type SegmentResultMeta,
} from "@/lib/reading/browser-transcript-collector";
import { ReadingStatusDialog } from "@/components/reading/reading-status-dialog";
import { StatusBanner } from "@/components/reading/status-banner";
import { useReadingServices } from "@/hooks/use-reading-services";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useRecordingPlayback } from "@/hooks/use-recording-playback";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { prepareShortWordAudio } from "@/lib/reading/short-word-audio";
import {
  RealtimeAlignmentEngine,
  timingsForTranscript,
  tokenizeRealtimeText,
  type RealtimeAlignmentSnapshot,
  type RealtimeWordMismatch,
} from "@/lib/reading/realtime-alignment";
import {
  isImplausibleSpeechSpeed,
  sameCaptureScope,
  type CaptureScope,
} from "@/lib/reading/reading-evidence-pipeline";
import {
  sortRetryWordRecords,
  type RetryWordRecord,
} from "@/lib/reading/retry-recognition";
import { isServiceError } from "@/lib/api/service-error";
import { isSttFallbackEligibleError } from "@/lib/api/speech-error";
import { createSpeechService } from "@/lib/api/speech-service";
import { useAutomationPreferences } from "@/hooks/use-automation-preferences";
import { useReadingPresence } from "@/hooks/use-reading-presence";
import type {
  SpeechPlayOptions,
  WordTimedPlayOptions,
} from "@/hooks/use-speech-player";
import { EchoGuard } from "@/lib/reading/echo-guard";
import {
  InteractivePromptSelector,
  mistakeCategoryToPromptCategory,
} from "@/lib/reading/interactive-prompts";
import {
  isVoiceExitSentenceReinforcement,
  SentenceReinforcementTracker,
  shouldEscapeToUpcomingWords,
  type ActiveSentenceReinforcement,
} from "@/lib/reading/sentence-reinforcement";
import { parseVoiceIntent } from "@/lib/reading/voice-intent";
import type { SessionPhase } from "@/lib/reading/presence-monitor";
import type { BookDetailDTO } from "@/types/book";
import type { ReadingDisplayMode } from "@/types/book-assets";
import type { ChildProfileDTO } from "@/types/child";
import type {
  ReadingCompletionSummaryUI,
  ReadingConnectionState,
  ReadingPageDTO,
  ReadingPageWordDTO,
  ReadingReconnectDemoMode,
  ReadingSessionState,
  ReadingSessionPageProgressDTO,
  ReadingUiState,
  TutorAction,
} from "@/types/reading";
import {
  compareTranscript,
  type ComparisonResult,
} from "@/lib/api/comparison-service";

type ReadingDynamicPanelKey = "question" | "complete" | "phonics" | "picker";

interface ReadingDynamicFallbackContextValue {
  readonly booksHref: string;
  readonly onSkipQuestion: () => void;
  readonly onClosePhonics: () => void;
  readonly onClosePicker: () => void;
  readonly consumeRetryOnRemount: (panel: ReadingDynamicPanelKey) => boolean;
  readonly markRetryOnRemount: (panel: ReadingDynamicPanelKey) => void;
}

const ReadingDynamicFallbackContext =
  createContext<ReadingDynamicFallbackContextValue | null>(null);

interface ReadingSubpanelErrorBoundaryProps {
  readonly children: ReactNode;
  readonly fallback: (error: Error, reset: () => void) => ReactNode;
}

interface ReadingSubpanelErrorBoundaryState {
  readonly error: Error | null;
}

class ReadingSubpanelErrorBoundary extends Component<
  ReadingSubpanelErrorBoundaryProps,
  ReadingSubpanelErrorBoundaryState
> {
  state: ReadingSubpanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(
    error: Error,
  ): ReadingSubpanelErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error, () =>
        this.setState({ error: null }),
      );
    }
    return this.props.children;
  }
}

function ReadingSubpanelSkeleton() {
  const t = useTranslations("reading");
  return (
    <section
      aria-busy="true"
      aria-label={t("session.loadingAria")}
      className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 p-4"
    >
      <Skeleton className="h-12 w-full rounded-control" />
      <Skeleton className="min-h-[420px] w-full rounded-card" />
    </section>
  );
}

function ReadingSubpanelFallback({
  error,
  onResetBoundary,
  panel,
  retry,
}: DynamicOptionsLoadingProps & {
  readonly panel: "question" | "complete";
  readonly onResetBoundary?: () => void;
}) {
  const t = useTranslations("reading");
  const tCommon = useTranslations("common");
  const ctx = useContext(ReadingDynamicFallbackContext);
  const hasError = Boolean(error);

  useEffect(() => {
    if (hasError && retry && ctx?.consumeRetryOnRemount(panel)) {
      retry();
    }
  }, [ctx, hasError, panel, retry]);

  if (!hasError) {
    return <ReadingSubpanelSkeleton />;
  }

  return (
    <section
      className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col justify-center gap-4 p-4"
      data-testid={
        panel === "question"
          ? "reading-question-load-error"
          : "reading-complete-load-error"
      }
    >
      <h1 className="text-heading font-extrabold text-ink">
        {panel === "question"
          ? t("comprehension.loadErrorTitle")
          : tCommon("states.unavailable")}
      </h1>
      <StatusMessage tone="error">
        {panel === "question"
          ? t("comprehension.loadErrorDesc")
          : t("session.openFailedDescription")}
      </StatusMessage>
      {typeof retry === "function" || onResetBoundary ? (
        <Button
          onClick={() => {
            onResetBoundary?.();
            retry?.();
          }}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          {t("session.retry")}
        </Button>
      ) : null}
      {panel === "question" && ctx ? (
        <Button
          onClick={() => {
            ctx.markRetryOnRemount("question");
            ctx.onSkipQuestion();
          }}
          variant="primary"
        >
          {t("comprehension.skipToReport")}
        </Button>
      ) : null}
      <ButtonLink href={ctx?.booksHref ?? "/books"} variant="quiet">
        <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-5" />
        {t("session.backToLibrary")}
      </ButtonLink>
    </section>
  );
}

function ReadingPhonicsFallback({
  error,
  onResetBoundary,
  retry,
}: DynamicOptionsLoadingProps & { readonly onResetBoundary?: () => void }) {
  const t = useTranslations("reading");
  const tCommon = useTranslations("common");
  const ctx = useContext(ReadingDynamicFallbackContext);
  const hasError = Boolean(error);

  useEffect(() => {
    if (hasError && retry && ctx?.consumeRetryOnRemount("phonics")) {
      retry();
    }
  }, [ctx, hasError, retry]);

  if (!hasError) {
    return <Skeleton className="h-32 w-full rounded-2xl" />;
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-white p-3 text-sm text-ink"
      data-testid="reading-phonics-load-error"
      role="status"
    >
      <span>{tCommon("states.unavailable")}</span>
      <div className="flex items-center gap-2">
        {typeof retry === "function" || onResetBoundary ? (
          <Button
            className="h-9! min-h-9! w-auto! px-3! py-1! text-xs!"
            onClick={() => {
              onResetBoundary?.();
              retry?.();
            }}
            variant="secondary"
          >
            {t("session.retry")}
          </Button>
        ) : null}
        {ctx ? (
          <Button
            className="h-9! min-h-9! w-auto! px-3! py-1! text-xs!"
            onClick={() => {
              ctx.markRetryOnRemount("phonics");
              ctx.onClosePhonics();
            }}
            variant="quiet"
          >
            {t("phonics.closeSr")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ReadingPagePickerFallback({
  error,
  onResetBoundary,
  retry,
}: DynamicOptionsLoadingProps & { readonly onResetBoundary?: () => void }) {
  const t = useTranslations("reading");
  const ctx = useContext(ReadingDynamicFallbackContext);
  const hasError = Boolean(error);

  useEffect(() => {
    if (hasError && retry && ctx?.consumeRetryOnRemount("picker")) {
      retry();
    }
  }, [ctx, hasError, retry]);

  if (!hasError) {
    return null;
  }

  const handleClose = () => {
    if (ctx) {
      ctx.markRetryOnRemount("picker");
      ctx.onClosePicker();
    }
  };

  return (
    <ReadingStatusDialog
      body={t("session.pageLoadFailed")}
      closeOnEscape
      onClose={handleClose}
      primaryAction={{
        label: t("session.retry"),
        onClick: () => {
          onResetBoundary?.();
          retry?.();
        },
      }}
      secondaryAction={{
        label: t("session.cancel"),
        onClick: handleClose,
      }}
      title={t("session.pagePickerTitle")}
    />
  );
}

const ComprehensionQuestion = dynamic(
  () =>
    import("@/components/reading/comprehension-question").then(
      (mod) => mod.ComprehensionQuestion,
    ),
  {
    ssr: false,
    loading: (loadingProps) => (
      <ReadingSubpanelFallback {...loadingProps} panel="question" />
    ),
  },
);

const SessionComplete = dynamic(
  () =>
    import("@/components/reading/session-complete").then(
      (mod) => mod.SessionComplete,
    ),
  {
    ssr: false,
    loading: (loadingProps) => (
      <ReadingSubpanelFallback {...loadingProps} panel="complete" />
    ),
  },
);

const PhonicsLessonCard = dynamic(
  () =>
    import("@/components/reading/phonics-lesson-card").then(
      (mod) => mod.PhonicsLessonCard,
    ),
  {
    ssr: false,
    loading: (loadingProps) => <ReadingPhonicsFallback {...loadingProps} />,
  },
);

const ReadingPagePickerModal = dynamic(
  () =>
    import("@/components/reading/reading-page-picker-modal").then(
      (mod) => mod.ReadingPagePickerModal,
    ),
  {
    ssr: false,
    loading: (loadingProps) => <ReadingPagePickerFallback {...loadingProps} />,
  },
);

const ReadingVoiceSettings = dynamic(
  () =>
    import("@/components/reading/reading-voice-settings").then(
      (mod) => mod.ReadingVoiceSettings,
    ),
  {
    ssr: false,
    loading: () => (
      <span
        aria-hidden="true"
        className="min-h-11 rounded-control bg-cream/80 lg:min-h-14"
      />
    ),
  },
);

const TutorMessage = dynamic(
  () =>
    import("@/components/reading/tutor-message").then(
      (mod) => mod.TutorMessage,
    ),
  {
    ssr: false,
    loading: () => null,
  },
);

interface DynamicPanelErrorBoundaryProps {
  backHref?: string;
  backLabel?: string;
  children: ReactNode;
  closeLabel: string;
  description: string;
  onClose?: () => void;
  resetKey?: string | number | boolean | null;
  retryLabel: string;
  title: string;
  variant: "compact" | "inline" | "floating" | "fullscreen";
}

interface DynamicPanelErrorBoundaryState {
  hasError: boolean;
  retryKey: number;
}

class DynamicPanelErrorBoundary extends Component<
  DynamicPanelErrorBoundaryProps,
  DynamicPanelErrorBoundaryState
> {
  state: DynamicPanelErrorBoundaryState = {
    hasError: false,
    retryKey: 0,
  };

  static getDerivedStateFromError(): Partial<DynamicPanelErrorBoundaryState> {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: DynamicPanelErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  private handleRetry = (): void => {
    this.setState((prev) => ({
      hasError: false,
      retryKey: prev.retryKey + 1,
    }));
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return (
        <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>
      );
    }

    const {
      backHref,
      backLabel,
      closeLabel,
      description,
      onClose,
      retryLabel,
      title,
      variant,
    } = this.props;

    if (variant === "compact") {
      return (
        <div
          className="inline-flex min-h-11 items-center gap-2 rounded-control border border-amber-300 bg-amber-50/90 px-3 py-1.5 text-xs font-semibold text-amber-950 lg:min-h-14"
          data-testid="dynamic-panel-fallback-compact"
          role="status"
        >
          <span className="truncate">{title}</span>
          <button
            className="inline-flex min-h-9 shrink-0 items-center rounded-control border border-amber-300 bg-white px-2.5 text-xs font-bold text-amber-950 hover:bg-amber-100"
            onClick={this.handleRetry}
            type="button"
          >
            {retryLabel}
          </button>
        </div>
      );
    }

    if (variant === "floating") {
      return (
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-x-3 bottom-32 z-40 flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-28 sm:max-w-md"
          data-testid="dynamic-panel-fallback-floating"
          role="status"
        >
          <div className="pointer-events-auto w-full rounded-card border border-amber-300 bg-paper/98 p-4 shadow-lg backdrop-blur-xs">
            <StatusMessage title={title} tone="warning">
              {description}
            </StatusMessage>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                className="w-auto!"
                onClick={this.handleRetry}
                size="compact"
                variant="secondary"
              >
                {retryLabel}
              </Button>
              {onClose ? (
                <Button
                  className="w-auto!"
                  onClick={onClose}
                  size="compact"
                  variant="quiet"
                >
                  {closeLabel}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      );
    }

    if (variant === "fullscreen") {
      return (
        <section
          className="mx-auto flex min-h-dvh w-full max-w-[960px] flex-col justify-center gap-4 p-6"
          data-testid="dynamic-panel-fallback-fullscreen"
        >
          <StatusMessage title={title} tone="warning">
            {description}
          </StatusMessage>
          <div className="flex flex-wrap gap-3">
            <Button
              className="w-auto!"
              onClick={this.handleRetry}
              variant="primary"
            >
              {retryLabel}
            </Button>
            {onClose ? (
              <Button className="w-auto!" onClick={onClose} variant="secondary">
                {closeLabel}
              </Button>
            ) : null}
            {backHref && backLabel ? (
              <ButtonLink href={backHref} variant="secondary">
                {backLabel}
              </ButtonLink>
            ) : null}
          </div>
        </section>
      );
    }

    return (
      <div
        className="rounded-2xl border border-amber-300 bg-amber-50/90 p-3"
        data-testid="dynamic-panel-fallback-inline"
        role="status"
      >
        <StatusMessage title={title} tone="warning">
          {description}
        </StatusMessage>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button
            className="w-auto!"
            onClick={this.handleRetry}
            size="compact"
            variant="secondary"
          >
            {retryLabel}
          </Button>
          {onClose ? (
            <Button
              className="w-auto!"
              onClick={onClose}
              size="compact"
              variant="quiet"
            >
              {closeLabel}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
}

interface ReadingScreenProps {
  initialPageId?: string;
  initialUiState: ReadingUiState;
  reconnectMode: ReadingReconnectDemoMode;
  sessionId: string;
}

const EMPTY_COMPLETION_SUMMARY: ReadingCompletionSummaryUI = {
  duration_minutes: null,
  pages_explored: null,
  practiced_words: null,
};

interface ReadingScreenData {
  book: BookDetailDTO;
  child: ChildProfileDTO;
  completion: ReadingCompletionSummaryUI;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: ReadingScreenData }
  | { status: "not-found" }
  | { status: "error" };
interface BrowserSpeechEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: {
        transcript: string;
        confidence?: number;
      };
    };
  };
}

interface BrowserSpeechErrorEvent {
  error?: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: BrowserSpeechEvent) => void) | null;
  onerror: ((event: BrowserSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: (audioTrack?: MediaStreamTrack) => void;
  stop: () => void;
  abort?: () => void;
}

interface WindowWithSpeech {
  SpeechRecognition?: new () => BrowserSpeechRecognition;
  webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
}
interface RetryWordCandidate {
  wordId: string;
  text: string;
  contextPhrase: string;
  pageId: string;
  pageRevisionId: string;
  pageNumber: number;
  wordIndex: number;
  originalStatus: "OMISSION" | "MISPRONUNCIATION";
}
type RetryFeedback =
  | "waiting"
  | "preparing-microphone"
  | "playing-instruction"
  | "playing-sample"
  | "listening"
  | "processing"
  | "correct"
  | "incorrect"
  | "not-recognized"
  | "microphone-unavailable"
  | "speech-unavailable"
  | "audio-unavailable"
  | "save-error";

interface PendingRetryEvent {
  readonly candidate: RetryWordCandidate;
  readonly status: "CONFIRMED" | "FAILED" | "UNCERTAIN";
  readonly transcript: string;
  readonly attempt: number;
}
interface PageTranscriptBucket {
  readonly page_id: string;
  readonly page_revision_id: string;
  readonly page_number: number;
  readonly segments: string[];
  readonly words: WordTimestamp[];
}
interface FrozenPageAssessment extends PageTranscriptBucket {
  readonly initial_assessment: readonly {
    readonly word_id: string;
    readonly status: "CORRECT" | "MISPRONUNCIATION" | "OMISSION" | "UNCERTAIN";
  }[];
}
type RetryWordItem = RetryWordRecord;

const RETRY_CAPTURE_POLL_MS = SHORT_WORD_CAPTURE_CONFIG.pollIntervalMs;

const sessionStandbyRecognizers = new Map<
  string,
  LocalSegmentSpeechRecognition
>();

function setSessionStandbyRecognizer(
  sid: string,
  rec: LocalSegmentSpeechRecognition,
): void {
  const prev = sessionStandbyRecognizers.get(sid);
  if (prev && prev !== rec) {
    try {
      prev.cancelStandby();
    } catch {
      // Ignore cleanup error
    }
  }
  sessionStandbyRecognizers.set(sid, rec);
}

function getSessionStandbyRecognizer(
  sid: string,
): LocalSegmentSpeechRecognition | null {
  return sessionStandbyRecognizers.get(sid) ?? null;
}

function takeSessionStandbyRecognizer(
  sid: string,
): LocalSegmentSpeechRecognition | null {
  const rec = sessionStandbyRecognizers.get(sid) ?? null;
  sessionStandbyRecognizers.delete(sid);
  return rec;
}

function cancelSessionStandbyRecognizer(sid: string): void {
  const rec = sessionStandbyRecognizers.get(sid);
  sessionStandbyRecognizers.delete(sid);
  if (rec) {
    try {
      rec.cancelStandby();
    } catch {
      // Ignore standby cancel error
    }
  }
}

// Measure recorder duration with a monotonic clock from capture callbacks.
function getRetryCaptureTimeMs(): number {
  return performance.now();
}

function playRetryReadyCue(): void {
  if (typeof window === "undefined") return;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (typeof AudioCtx !== "function") return;
  try {
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.085);
    window.setTimeout(() => {
      void ctx.close().catch(() => undefined);
    }, 150);
  } catch {
    // Visual cue remains active even if WebAudio chime is blocked.
  }
}

function resolveWordArrayIndex(
  words: readonly { readonly word_id: string }[],
  snapshot: { readonly currentWordId: string | null } | null | undefined,
  fallbackWhenNull = 0,
): number {
  if (!snapshot?.currentWordId) return fallbackWhenNull;
  const idx = words.findIndex((w) => w.word_id === snapshot.currentWordId);
  return idx >= 0 ? idx : fallbackWhenNull;
}

export function ReadingScreen(props: ReadingScreenProps) {
  return <ReadingSessionScreen key={props.sessionId} {...props} />;
}

function ReadingSessionScreen({
  initialPageId,
  initialUiState,
  reconnectMode,
  sessionId,
}: ReadingScreenProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reading");
  const tCommon = useTranslations("common");
  const services = useReadingServices();
  const speechService = useMemo(() => createSpeechService(), []);
  const speechPlayer = useSpeechPlayer();
  const recorderFailureHandlerRef = useRef<() => void>(() => {});
  const speechRecorder = useSpeechRecorder(() =>
    recorderFailureHandlerRef.current(),
  );
  const cancelRecording = speechRecorder.cancel;
  const [loadKey, setLoadKey] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [uiState, setUiState] = useState<ReadingUiState>(initialUiState);
  const [canonicalState, setCanonicalState] =
    useState<ReadingSessionState>("CREATED");
  const [page, setPage] = useState<ReadingPageDTO | null>(null);
  const [pageProgress, setPageProgress] =
    useState<ReadingSessionPageProgressDTO | null>(null);
  const [pageNavigationError, setPageNavigationError] = useState<string | null>(
    null,
  );
  const [currentWordId, setCurrentWordId] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [connectionState, setConnectionState] =
    useState<ReadingConnectionState>(() =>
      initialUiState === "reconnecting" || initialUiState === "stt-error"
        ? "reconnecting"
        : "connected",
    );
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [pageOptionsOpen, setPageOptionsOpen] = useState(false);
  const [duetModeEnabled, setDuetModeEnabled] = useState(false);
  const pickerShouldReturnToReading = useRef(false);
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);
  const retryOnRemountRef = useRef({
    question: false,
    complete: false,
    phonics: false,
    picker: false,
  });
  const fallbackActionsRef = useRef({
    onSkipQuestion: () => {},
    onClosePhonics: () => {},
    onClosePicker: () => {},
  });

  useEffect(() => {
    fallbackActionsRef.current = {
      onSkipQuestion: () => {
        automationRuntimeRef.current?.dispatch({ type: "QUIZ_END" });
        setUiState("complete");
      },
      onClosePhonics: () => {
        stopAssistantAudio();
        setActivePhonicsLesson(null);
        setActivePhonicsStepIndex(null);
        setPhonicsStatusHint(null);
      },
      onClosePicker: closePagePicker,
    };
  });

  const consumeRetryOnRemount = useCallback((panel: ReadingDynamicPanelKey) => {
    if (!retryOnRemountRef.current[panel]) return false;
    retryOnRemountRef.current[panel] = false;
    return true;
  }, []);

  const markRetryOnRemount = useCallback((panel: ReadingDynamicPanelKey) => {
    retryOnRemountRef.current[panel] = true;
  }, []);

  const dynamicFallbackContextValue =
    useMemo<ReadingDynamicFallbackContextValue>(
      () => ({
        booksHref: "/books",
        onSkipQuestion: () => fallbackActionsRef.current.onSkipQuestion(),
        onClosePhonics: () => fallbackActionsRef.current.onClosePhonics(),
        onClosePicker: () => fallbackActionsRef.current.onClosePicker(),
        consumeRetryOnRemount,
        markRetryOnRemount,
      }),
      [consumeRetryOnRemount, markRetryOnRemount],
    );
  const [tutorOpen, setTutorOpen] = useState(false);
  const [tutorAction, setTutorAction] = useState<TutorAction | null>(null);
  const tutorResumeListeningRef = useRef(false);
  const tutorResumeMicAfterPlaybackRef = useRef(false);
  const tutorPlaybackGenerationRef = useRef(0);
  const [latestTranscript, setLatestTranscript] = useState<string | null>(null);
  const [comparisonResult, setComparisonResult] =
    useState<ComparisonResult | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [hasPageTranscripts, setHasPageTranscripts] = useState(false);
  const [isRetryingReports, setIsRetryingReports] = useState(false);
  const [wasmDownloadState, setWasmDownloadState] = useState<{
    percent: number | null;
    file?: string;
  } | null>(null);

  useEffect(() => {
    const wasmClient = getBrowserWasmSttClient();
    const unsubscribe = wasmClient.subscribeProgress(
      (event: WasmSttProgressEvent) => {
        const normalizedStage = event.stage.toLowerCase();
        if (
          normalizedStage === "ready" ||
          normalizedStage === "completed" ||
          normalizedStage === "done" ||
          wasmClient.isReady()
        ) {
          setWasmDownloadState(null);
          return;
        }
        const computedPercent =
          typeof event.index === "number" &&
          typeof event.total === "number" &&
          event.total > 0
            ? Math.max(
                5,
                Math.min(
                  95,
                  Math.round(((event.index + 1) / event.total) * 85),
                ),
              )
            : null;
        setWasmDownloadState({
          percent: computedPercent,
          file: event.file,
        });
      },
    );
    return unsubscribe;
  }, []);

  const isWasmDownloading = wasmDownloadState !== null;
  useEffect(() => {
    if (!isWasmDownloading) return;
    const wasmClient = getBrowserWasmSttClient();
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (wasmClient.isReady() || Date.now() - startedAt > 95_000) {
        setWasmDownloadState(null);
      }
    }, 350);
    return () => {
      window.clearInterval(timer);
    };
  }, [isWasmDownloading]);

  const isTtsSynthesizing = speechPlayer.state === "loading";
  const isReadingAiWait =
    (isBusy && !speechPlayer.isPlaying) ||
    isRetryingReports ||
    isTtsSynthesizing;
  const sessionLoadProgress = useAiProgress({
    active: loadState.status === "loading" || !page,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.preparing") },
      { atPct: 55, label: tCommon("aiProgress.connecting") },
      { atPct: 86, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 5_000,
  });
  const wasmModelProgress = useAiProgress({
    active: isWasmDownloading,
    realPercent: wasmDownloadState?.percent ?? null,
    progressMode:
      wasmDownloadState?.percent !== null &&
      wasmDownloadState?.percent !== undefined
        ? "measured"
        : "staged",
    stages: [
      { atPct: 0, label: tCommon("aiProgress.downloadingSpeechModel") },
      { atPct: 85, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 25_000,
  });
  const readingAiProgress = useAiProgress({
    active: isReadingAiWait,
    stages: isTtsSynthesizing
      ? [
          { atPct: 0, label: tCommon("aiProgress.synthesizingVoice") },
          { atPct: 74, label: tCommon("aiProgress.finalizing") },
        ]
      : isRetryingReports
        ? [
            { atPct: 0, label: tCommon("aiProgress.analyzing") },
            { atPct: 74, label: tCommon("aiProgress.finalizing") },
          ]
        : [
            { atPct: 0, label: tCommon("aiProgress.transcribing") },
            { atPct: 48, label: tCommon("aiProgress.analyzing") },
            { atPct: 84, label: tCommon("aiProgress.finalizing") },
          ],
    expectedDurationMs: 4_500,
  });
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isReadingWord, setIsReadingWord] = useState(false);
  const [isPlayingPageSample, setIsPlayingPageSample] = useState(false);
  const [isPlayingTutorAudio, setIsPlayingTutorAudio] = useState(false);
  const [readingMode, setReadingMode] = useState<ReadingDisplayMode | null>(
    null,
  );
  const [previewSnapshot, setPreviewSnapshot] =
    useState<RealtimeAlignmentSnapshot | null>(null);
  const [spokenWords, setSpokenWords] = useState<Set<string>>(() => new Set());
  const [correctWordIds, setCorrectWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [mispronouncedWordIds, setMispronouncedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [skippedWordIds, setSkippedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [repeatedWordIds, setRepeatedWordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [hesitationWordIds, setHesitationWordIds] = useState<Set<string>>(
    () => new Set(),
  );

  const [sessionSummary, setSessionSummary] =
    useState<ReadingCompletionSummaryUI | null>(null);
  const spokenWordsSetRef = useRef<Set<string>>(new Set());
  const correctWordIdsRef = useRef<Set<string>>(new Set());
  const mispronouncedWordIdsRef = useRef<Set<string>>(new Set());
  const failedWordsSetRef = useRef<Set<string>>(new Set());
  const transcriptsListRef = useRef<string[]>([]);
  const alignmentEngineRef = useRef<RealtimeAlignmentEngine | null>(null);
  const autoCompletePageAfterFinalWordRef = useRef<
    (snapshot: RealtimeAlignmentSnapshot) => Promise<void>
  >(async () => undefined);
  const lastPreviewWordIndexRef = useRef(-1);
  const skippedWordIdsRef = useRef<Set<string>>(new Set());
  const repeatedWordIdsRef = useRef<Set<string>>(new Set());
  const hesitationWordIdsRef = useRef<Set<string>>(new Set());
  const [retryPrompt, setRetryPrompt] = useState(false);
  const [retryMode, setRetryMode] = useState(false);
  const [retryCandidates, setRetryCandidates] = useState<RetryWordCandidate[]>(
    [],
  );
  const retryCandidatesRef = useRef<RetryWordCandidate[]>([]);
  // The ref is the authoritative queue for asynchronous retry handlers.
  // Update it synchronously alongside render state at each queue mutation.
  const [retryConfirmedWordIds, setRetryConfirmedWordIds] = useState<
    Set<string>
  >(() => new Set());
  const [retryWordPosition, setRetryWordPosition] = useState(0);
  const [retryFeedback, setRetryFeedback] = useState<RetryFeedback>("waiting");
  const [unresolvedRetryWordIds, setUnresolvedRetryWordIds] = useState<
    Set<string>
  >(() => new Set());
  const retryPausedRef = useRef(false);
  const transitioningToRetryRef = useRef(false);
  const retrySaveInFlightRef = useRef<Promise<boolean> | null>(null);
  const retryResolvedKeysRef = useRef(new Set<string>());
  const retryModeRef = useRef(false);
  const retryProcessingRef = useRef(false);
  const retryListeningWantedRef = useRef(false);
  const retryPositionRef = useRef(0);
  const retryShouldRestartRef = useRef(false);

  const retryAttemptIdRef = useRef(0);
  const retryAbortControllerRef = useRef<AbortController | null>(null);
  const retryUnclearStreakRef = useRef(0);
  const retryHeardFailuresRef = useRef(0);
  const retryPhraseRef = useRef<string | null>(null);
  const [retryPhrase, setRetryPhrase] = useState<string | null>(null);
  const retryHelpRoundsRef = useRef(0);
  const retryBrowserFinalRef = useRef("");
  const retryBrowserConfidenceRef = useRef<number | null>(null);
  const retryPlayback = useRecordingPlayback();
  const [retryRecording, setRetryRecording] = useState<Blob | null>(null);
  const pageHelpWordRef = useRef<{
    wordId: string;
    awaitingAttempt: boolean;
  } | null>(null);
  const passageContainsHelpRef = useRef(false);
  const retryResumeAfterAssistantAudioRef = useRef<RetryWordCandidate | null>(
    null,
  );
  const retryCaptureStartedAtRef = useRef(0);
  const retrySpeechOnsetRef = useRef<number | null>(null);
  const retrySpeechObservedRef = useRef(false);
  const retryBrowserPulseRef = useRef(false);
  const retrySilenceStartedAtRef = useRef<number | null>(null);
  const pendingRetryEventRef = useRef<PendingRetryEvent | null>(null);
  const retryEvaluatedCountsRef = useRef(new Map<string, number>());
  const retryIncorrectCountsRef = useRef(new Map<string, number>());

  // Automatic reading flow: parent switches, echo protection, help ladder.
  useTeacherPersona();
  const { preferences: automationPreferences, coachingStyle } =
    useAutomationPreferences();
  const automationRef = useRef(automationPreferences);
  const coachingStyleRef = useRef(coachingStyle);
  const echoGuard = useMemo(() => new EchoGuard(), []);
  const assistantPlaybackSeqRef = useRef(0);
  /** Words the app read aloud for the child: practised, never plain green. */
  const helpedWordIdsRef = useRef<Set<string>>(new Set());
  /** Words the app encouraged the child past after the allowed attempts. */
  const gaveUpWordIdsRef = useRef<Set<string>>(new Set());
  const automationRuntimeRef = useRef<ReadingAutomationRuntime | null>(null);
  const automationStateRef = useRef<AutomationState | null>(null);
  const lastTrailingMismatchRef = useRef<RealtimeWordMismatch | null>(null);
  const lastGivenUpWordForEncourageRef = useRef<string | null>(null);
  const selfCorrectedPraiseNotedRef = useRef<Set<string>>(new Set());
  const disambiguationPendingRef = useRef<{
    readonly candidates: readonly [ReadingPageWordDTO, ReadingPageWordDTO];
  } | null>(null);
  const activeListeningEpochRef = useRef(0);
  const lastCoachedMismatchSeqRef = useRef(0);
  const retryBrowserCollectorRef = useRef<string[]>([]);
  const pauseReadingRef = useRef<() => Promise<void>>(async () => undefined);
  const [assistedWordIds, setAssistedWordIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [companionBubble, setCompanionBubble] =
    useState<CompanionBubbleState | null>(null);
  const [presencePaused, setPresencePaused] = useState(false);
  const duetTurns = useMemo(
    () => (page ? buildDuetTurnsForPage(page) : []),
    [page],
  );
  const activeDuetTurn = useMemo(
    () =>
      duetModeEnabled && duetTurns.length >= 2
        ? resolveActiveDuetTurn(
            duetTurns,
            previewSnapshot?.currentWordId ?? currentWordId,
            correctWordIds,
          )
        : null,
    [
      correctWordIds,
      currentWordId,
      duetModeEnabled,
      duetTurns,
      previewSnapshot?.currentWordId,
    ],
  );
  const handleCompleteParentDuetTurn = useCallback(() => {
    if (!activeDuetTurn || activeDuetTurn.role !== "PARENT") return;
    for (const wId of activeDuetTurn.wordIds) {
      helpedWordIdsRef.current.add(wId);
      correctWordIdsRef.current.add(wId);
    }
    setAssistedWordIds(new Set(helpedWordIdsRef.current));
    setCorrectWordIds(new Set(correctWordIdsRef.current));
    const snap = alignmentEngineRef.current?.advanceParentTurnWords(
      activeDuetTurn.wordIds,
    );
    if (snap) {
      setCurrentWordId(snap.currentWordId);
      setPreviewSnapshot(snap);
      if (snap.currentWordId === null) {
        void autoCompletePageAfterFinalWordRef.current(snap);
      }
    }
  }, [activeDuetTurn]);
  useEffect(() => {
    automationRef.current = automationPreferences;
    coachingStyleRef.current = coachingStyle;
  });
  const presenceSessionPhase: SessionPhase =
    uiState === "complete"
      ? "ended"
      : uiState === "paused"
        ? presencePaused
          ? "paused-by-presence"
          : "paused-other"
        : uiState === "reading" &&
            (isMicRecording || canonicalState === "LISTENING")
          ? "reading"
          : "paused-other";
  // Opt-in only: does nothing unless a parent turned the email reminder on and
  // the camera is already allowed. Never prompts, never stores or sends images.
  useReadingPresence({
    sessionId,
    sessionPhase: presenceSessionPhase,
    service: services.readingPresenceService,
    onPauseRequested: () => {
      setPresencePaused(true);
      void pauseReadingRef.current();
    },
    onNotice: () => setLatestTranscript(t("session.presencePausedNotice")),
  });

  useEffect(() => {
    if (!page?.words?.length) {
      alignmentEngineRef.current = null;
      return;
    }

    lastPreviewWordIndexRef.current = -1;
    alignmentEngineRef.current = new RealtimeAlignmentEngine(page.words, 3, 1);

    return () => {
      alignmentEngineRef.current = null;
    };
  }, [page]);
  const uncertainPageIdsRef = useRef(new Set<string>());
  const [uncertainWordIds, setUncertainWordIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pageTranscriptsRef = useRef<Map<string, PageTranscriptBucket>>(
    new Map(),
  );
  const browserTranscriptCollectorRef = useRef(
    new BrowserTranscriptCollector(),
  );
  const sentenceReinforcementRef = useRef(new SentenceReinforcementTracker());
  const promptSelectorRef = useRef(new InteractivePromptSelector());
  const [activeSentenceReinforcement, setActiveSentenceReinforcement] =
    useState<ActiveSentenceReinforcement | null>(null);
  const lastPreviewTranscriptRef = useRef<string | null>(null);
  const browserStopResolveRef = useRef<(() => void) | null>(null);
  const wordTextByIdRef = useRef<Map<string, string>>(new Map());
  const retryWordsByIdRef = useRef<Map<string, RetryWordItem>>(new Map());
  const pageWordsByRevisionRef = useRef(
    new Map<string, readonly ReadingPageWordDTO[]>(),
  );
  const [activePhonicsLesson, setActivePhonicsLesson] = useState<{
    readonly wordId: string | null;
    readonly plan: PhonicsLessonPlan;
  } | null>(null);
  const [isAnalyzingPhonicsAi, setIsAnalyzingPhonicsAi] = useState(false);
  const [activePhonicsStepIndex, setActivePhonicsStepIndex] = useState<
    number | null
  >(null);
  const [isPlayingPhonicsLesson, setIsPlayingPhonicsLesson] = useState(false);
  const [phonicsStatusHint, setPhonicsStatusHint] = useState<string | null>(
    null,
  );
  const phonicsSpelledWordIdsRef = useRef(new Set<string>());
  const passageContainsSpellRef = useRef(false);

  const finishStartedRef = useRef(false);
  const retryReportSaveStartedRef = useRef(false);
  const mountedRef = useRef(false);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const lastSttTechnicalErrorCodeRef = useRef<string | null>(null);
  const sttNetworkErrorStreakRef = useRef(0);
  const sttRestartTimerRef = useRef<number | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const onBeforeExternalMicStartRef = useRef<(() => void) | null>(null);
  const isListeningActiveRef = useRef(false);
  const isStartingListeningRef = useRef(false);
  const recordingStartedAtRef = useRef<number | null>(null);
  const listeningStartRef = useRef<Promise<boolean> | null>(null);
  const listeningStopRef = useRef<Promise<string> | null>(null);
  const listeningGenerationRef = useRef(0);
  const retryRecorderActiveRef = useRef(false);
  const retryCaptureTimeoutRef = useRef<number | null>(null);
  const assistantAudioPendingRef = useRef(false);
  const assistantAudioPlayingRef = useRef(false);
  const assistantAudioGenerationRef = useRef(0);
  const assistantTurnSpokenRef = useRef<string[]>([]);
  const assistantAudioResumeRequestedRef = useRef(false);
  const pageCompletionStartedRef = useRef<string | null>(null);
  const lastPageAutoCompleteStartedRef = useRef(false);
  const savedPageProgressKeysRef = useRef<Set<string>>(new Set());
  const failedPageProgressKeyRef = useRef<string | null>(null);
  const inFlightPageSaveRef = useRef<{
    readonly key: string;
    readonly promise: Promise<ReadingSessionPageProgressDTO>;
  } | null>(null);
  const pageCompletionPromiseRef = useRef<{
    readonly key: string;
    readonly promise: Promise<boolean>;
  } | null>(null);
  const resumeCaptureAfterPageTurnRef = useRef(false);
  const pageRef = useRef<ReadingPageDTO | null>(page);
  const pageProgressRef = useRef<ReadingSessionPageProgressDTO | null>(
    pageProgress,
  );
  useEffect(() => {
    pageRef.current = page;
    pageProgressRef.current = pageProgress;
  }, [page, pageProgress]);
  const uiStateRef = useRef<ReadingUiState>(uiState);
  useEffect(() => {
    uiStateRef.current = uiState;
  }, [uiState]);
  const activePhonicsLessonRef = useRef(activePhonicsLesson);
  useEffect(() => {
    activePhonicsLessonRef.current = activePhonicsLesson;
  }, [activePhonicsLesson]);
  const liveWordTimingsRef = useRef<WordTimestamp[]>([]);
  const liveWordOffsetSecRef = useRef(0);
  const liveWsTranscriptReceivedRef = useRef(false);
  const captureScopeRef = useRef<CaptureScope | null>(null);
  const pendingSentenceReinforcementRef = useRef<{
    readonly active: ActiveSentenceReinforcement;
    readonly engine: RealtimeAlignmentEngine;
  } | null>(null);

  const startListeningRef = useRef<() => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  const isUsingRecorderRef = useRef(false);
  const prepareFinishStartedRef = useRef(false);
  const initialAssessmentPreparedRef = useRef(false);
  const frozenPageAssessmentsRef = useRef<
    readonly FrozenPageAssessment[] | null
  >(null);
  const completedPageAssessmentsRef = useRef(
    new Map<string, FrozenPageAssessment>(),
  );
  const savedInitialPagesRef = useRef(new Set<string>());

  const pageWordContextRef = useRef(
    new Map<
      string,
      {
        pageId: string;
        pageRevisionId: string;
        pageNumber: number;
        wordIndex: number;
        text: string;
      }
    >(),
  );
  const recordSpokenText = useCallback(
    (
      text: string,
      pageSnapshot: Pick<
        ReadingPageDTO,
        "page_id" | "page_revision_id" | "page_number"
      >,
      words: readonly WordTimestamp[] | null = null,
    ) => {
      const trimmed = text.trim();
      if (!trimmed || assistantAudioPlayingRef.current) return;
      const bucketKey = `${pageSnapshot.page_id}:${pageSnapshot.page_revision_id}`;
      // Revisiting a completed page is practice, not another first pass.
      if (completedPageAssessmentsRef.current.has(bucketKey)) return;

      setHasPageTranscripts(true);
      transcriptsListRef.current.push(trimmed);

      let bucket = pageTranscriptsRef.current.get(bucketKey);
      if (!bucket) {
        bucket = {
          page_id: pageSnapshot.page_id,
          page_revision_id: pageSnapshot.page_revision_id,
          page_number: pageSnapshot.page_number,
          segments: [],
          words: [],
        };
        pageTranscriptsRef.current.set(bucketKey, bucket);
      }
      const isFirstSegmentForPage = bucket.segments.length === 0;
      bucket.segments.push(trimmed);

      // ElevenLabs word timestamps are relative to the uploaded audio segment.
      // Once a page uses more than one capture segment, their clocks cannot be
      // safely merged without real inter-segment timing evidence.
      if (isFirstSegmentForPage && words?.length) {
        bucket.words.push(...words);
      } else if (!isFirstSegmentForPage) {
        bucket.words.length = 0;
      }

      const spokenTokens = trimmed
        .replace(/[.,/#!$%^&*;:{}=\-_`~()?'\"“”—]/g, "")
        .split(/\s+/)
        .map((word) => word.trim())
        .filter((word) => word.length > 0);

      for (const word of spokenTokens) {
        spokenWordsSetRef.current.add(word);
      }
      setSpokenWords(new Set(spokenWordsSetRef.current));
    },
    [],
  );

  async function handleWordClick(word: ReadingPageWordDTO): Promise<void> {
    if (uiStateRef.current === "tts-error") {
      setUiState("reading");
    }
    setPreviewSnapshot(null);
    setCurrentWordId(word.word_id);

    if (speechPlayer.isPlaying) {
      speechPlayer.stop();
      setIsPlayingPageSample(false);
    }

    // Fire word-sample TTS cache lookup / synthesis immediately in parallel
    // with microphone teardown so the audio is ready as soon as mic releases.
    void speechPlayer.prefetch?.(word.text, { wordSample: true });

    setIsReadingWord(true);
    const playbackGeneration = assistantAudioGenerationRef.current + 1;
    try {
      await playAssistantAudio(
        () => speakGuarded(word.text, { wordSample: true }),
        true,
      );
    } catch (err) {
      const isAbortError =
        typeof err === "object" &&
        err !== null &&
        "name" in err &&
        (err as { name?: unknown }).name === "AbortError";
      if (!isAbortError) {
        console.warn("Lỗi phát âm 1 từ:", err);
      }
    } finally {
      if (
        mountedRef.current &&
        playbackGeneration === assistantAudioGenerationRef.current
      ) {
        setIsReadingWord(false);
      }
    }
  }

  function handleReadCurrentWord(): void {
    const activePage = pageRef.current ?? page;
    const activeWordId =
      alignmentEngineRef.current?.getSnapshot().currentWordId ?? currentWordId;
    if (!activePage || !activeWordId) return;
    const word = activePage.words.find((w) => w.word_id === activeWordId);
    if (word) {
      void handleWordClick(word);
    }
  }

  const voiceStudio = useMemo(() => createVoiceStudioService(), []);
  const setSpeechCacheContext = speechPlayer.setCacheContext;
  const activeCacheBookId =
    loadState.status === "ready" ? loadState.data.book.id : null;
  const activeCacheIsPrivate =
    loadState.status === "ready"
      ? loadState.data.book.visibility_scope === "PARENT_PRIVATE"
      : undefined;
  const activeCachePageId = page?.page_id ?? null;
  const activeCachePageRevisionId = page?.page_revision_id ?? null;

  useEffect(() => {
    setSpeechCacheContext?.({
      bookId: activeCacheBookId,
      pageId: activeCachePageId,
      pageRevisionId: activeCachePageRevisionId,
      isPrivateBook: activeCacheIsPrivate,
    });
    if (activeCachePageId && page?.words?.length) {
      void preloadReadingVoiceEngines({
        bookId: activeCacheBookId,
        pageId: activeCachePageId,
        pageRevisionId: activeCachePageRevisionId,
        isPrivateBook: activeCacheIsPrivate,
        previewWords: page.words.slice(0, 3).map((w) => w.text),
      });
    }
    return () => {
      setSpeechCacheContext?.(null);
    };
  }, [
    setSpeechCacheContext,
    activeCacheBookId,
    activeCacheIsPrivate,
    activeCachePageId,
    activeCachePageRevisionId,
    page?.words,
  ]);

  const retryPendingRetryEventRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    mountedRef.current = true;
    // Wait for /voice/status before locking session when health is not cached yet;
    // if fresh health is already available, lock immediately with the right voice.
    const cachedHealth = getFreshVoiceEngineHealth();
    if (cachedHealth) {
      const policy = getVoicePolicyPreferences();
      const ttsAllowsFallback =
        policy.providerMode === "local_with_google_fallback" &&
        policy.allowGoogleTtsFallback;
      const localTtsDown =
        !cachedHealth.local.available || !cachedHealth.local.tts_ready;
      const useGoogleTts =
        cachedHealth.google.tts_configured && !cachedHealth.google.tts_cooldown;
      if (ttsAllowsFallback && localTtsDown && useGoogleTts) {
        lockSessionVoice(sessionId, {
          voiceId: mapLocalVoiceToGoogleBackup(
            getEffectiveVoiceId(),
            policy.region,
          ),
        });
      } else {
        lockSessionVoice(sessionId);
      }
    }
    if (isAndroidNativeSpeechAvailable()) {
      void getAndroidSpeechCapabilities().catch(() => null);
    }
    // Warm STT (WASM/Android) & TTS immediately upon entering ReadingScreen
    // (covers direct URL navigation, refresh, or resume without prep screen).
    void preloadReadingVoiceEngines();
    const cleanupMicrophoneOnLeave = () => {
      listeningGenerationRef.current += 1;
      isListeningActiveRef.current = false;
      retryModeRef.current = false;
      retryAttemptIdRef.current += 1;
      retryAbortControllerRef.current?.abort();
      cancelRecording();
      transcriptionAbortRef.current?.abort();
      if (
        sttRestartTimerRef.current !== null &&
        typeof window !== "undefined"
      ) {
        window.clearTimeout(sttRestartTimerRef.current);
        sttRestartTimerRef.current = null;
      }
      if (
        typeof window !== "undefined" &&
        retryCaptureTimeoutRef.current !== null
      ) {
        window.clearTimeout(retryCaptureTimeoutRef.current);
        retryCaptureTimeoutRef.current = null;
      }
      if (retryRecorderActiveRef.current) {
        retryRecorderActiveRef.current = false;
      }
      cancelSessionStandbyRecognizer(sessionId);
      try {
        recognitionRef.current?.abort?.();
      } catch {
        // Safe ignore
      }
    };
    const handlePageHide = () => {
      cleanupMicrophoneOnLeave();
    };
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("viread:android-background", handlePageHide);
    const handleOnline = () => {
      automationRuntimeRef.current?.dispatch({ type: "NETWORK", online: true });
      if (
        pendingRetryEventRef.current &&
        !retryProcessingRef.current &&
        retryModeRef.current
      ) {
        void retryPendingRetryEventRef.current();
      }
    };
    const handleOffline = () => {
      automationRuntimeRef.current?.dispatch({
        type: "NETWORK",
        online: false,
      });
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("viread:android-background", handlePageHide);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      setActiveVoiceSession(null);
      automationRuntimeRef.current?.dispatch({ type: "SESSION_END" });
      automationRuntimeRef.current?.dispose();
      automationRuntimeRef.current = null;
      cleanupMicrophoneOnLeave();
    };
  }, [cancelRecording, sessionId]);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    let hostedLocalUnconfigured = false;

    const probeVoiceStatus = () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      void fetchVoiceEngineHealth(signal).then((health) => {
        if (cancelled || signal.aborted) return;
        if (!health) {
          if (getActiveSessionVoiceLock()?.sessionId !== sessionId) {
            lockSessionVoice(sessionId);
          }
          return;
        }
        hostedLocalUnconfigured = isPermanentlyHostedLocalUnconfigured(health);
        const policy = getVoicePolicyPreferences();
        const sttAllowsFallback =
          policy.providerMode === "local_with_google_fallback" &&
          policy.allowGoogleSttFallback;
        const ttsAllowsFallback =
          policy.providerMode === "local_with_google_fallback" &&
          policy.allowGoogleTtsFallback;
        const localSttDown = !health.local.available || !health.local.stt_ready;
        const localTtsDown = !health.local.available || !health.local.tts_ready;

        const currentStatus = getVoiceEngineStatus();
        const currentSttTier = currentStatus.stt.tier;
        const currentTtsSnap = currentStatus.tts;
        const wasmSupported = detectBrowserWasmSttSupport().supported;
        if (localSttDown) {
          if (currentSttTier === "browser_wasm" && wasmSupported) {
            // Preserve active Tier-2 on-device Browser WASM STT; never clobber it back to local/browser.
          } else if (wasmSupported && !isAndroidNativeSpeechAvailable()) {
            // Strict Offline-First STT priority: prefer On-Device WASM BEFORE
            // Cloud Google / Browser Web Speech. Under `local_only` before reading
            // begins, keep the mount badge honestly at `"idle"` while Browser WASM
            // pre-initializes silently in the background and switches to
            // `browser_wasm` as soon as the child actually begins reading.
            if (sttAllowsFallback) {
              recordSttEngineUsage({
                provider: "wasm",
                fallbackUsed: true,
                fallbackReason: "LOCAL_STT_UNAVAILABLE",
              });
            }
          } else if (sttAllowsFallback) {
            const useGoogleStt =
              health.google.stt_configured && !health.google.stt_cooldown;
            const useElevenLabsStt = Boolean(
              health.elevenlabs?.stt_configured &&
              !health.elevenlabs?.stt_cooldown,
            );
            const hasNativeWebSpeech =
              typeof window !== "undefined" &&
              Boolean(
                (window as unknown as { SpeechRecognition?: unknown })
                  .SpeechRecognition ||
                (window as unknown as { webkitSpeechRecognition?: unknown })
                  .webkitSpeechRecognition,
              );
            recordSttEngineUsage({
              provider: isAndroidNativeSpeechAvailable()
                ? "android_native"
                : useGoogleStt
                  ? "google"
                  : useElevenLabsStt
                    ? "elevenlabs"
                    : hasNativeWebSpeech
                      ? "browser"
                      : wasmSupported
                        ? "wasm"
                        : "browser",
              fallbackUsed: true,
              fallbackReason: "LOCAL_STT_UNAVAILABLE",
            });
          }
          // Eagerly initialize Browser WASM STT whenever local STT is down so
          // the model is already warm before the child speaks the first word!
          if (wasmSupported && !isAndroidNativeSpeechAvailable()) {
            void getBrowserWasmSttClient()
              .init()
              .catch(() => undefined);
          }
        } else {
          recordSttEngineUsage({
            provider: "local",
            fallbackUsed: false,
            fallbackReason: null,
          });
        }

        if (localTtsDown) {
          void warmWasmTtsIfNeeded(
            resolveVoiceGender(getEffectiveVoiceId()),
            health,
          );
        }

        const ttsUsingCachedAudio =
          currentTtsSnap.tier === "catalog_cache" ||
          currentTtsSnap.tier === "browser_wasm" ||
          currentTtsSnap.provider === "precomputed_cache";

        if (ttsAllowsFallback && localTtsDown) {
          const useGoogleTts =
            health.google.tts_configured && !health.google.tts_cooldown;
          const useElevenLabsTts = Boolean(
            health.elevenlabs?.tts_configured &&
            !health.elevenlabs?.tts_cooldown,
          );
          const activeLock = getActiveSessionVoiceLock();
          if (useGoogleTts) {
            const googleVoiceId = mapLocalVoiceToGoogleBackup(
              activeLock?.voiceId ?? getEffectiveVoiceId(),
              activeLock?.region ?? policy.region,
            );
            // Lock directly to the configured Google voice (or resync server-side
            // lock when transitioning from local -> Google before any utterance)
            // so every turn stays consistent ("Một buổi, một giọng") with zero 409.
            if (!activeLock || activeLock.sessionId !== sessionId) {
              lockSessionVoice(sessionId, {
                voiceId: googleVoiceId,
              });
            } else if (
              activeLock.provider === "local" &&
              (getSessionVoiceAudit(sessionId).length === 0 ||
                hasPendingSessionVoiceSwitch(sessionId))
            ) {
              lockSessionVoice(sessionId, {
                voiceId: googleVoiceId,
                forceUpdate: true,
              });
              if (typeof voiceStudio.updateSessionVoiceLock === "function") {
                void voiceStudio
                  .updateSessionVoiceLock({
                    sessionId,
                    voiceId: googleVoiceId,
                  })
                  .catch(() => undefined);
              }
            }
            if (!ttsUsingCachedAudio) {
              recordTtsEngineUsage({
                provider: "google",
                fallbackUsed: true,
                fallbackReason: "LOCAL_TTS_UNAVAILABLE",
                voiceId: googleVoiceId,
                voiceGender: resolveVoiceGender(googleVoiceId),
              });
            }
          } else if (useElevenLabsTts) {
            if (!activeLock || activeLock.sessionId !== sessionId) {
              lockSessionVoice(sessionId);
            }
            const resolvedLock = getActiveSessionVoiceLock();
            if (!ttsUsingCachedAudio) {
              recordTtsEngineUsage({
                provider: "elevenlabs",
                fallbackUsed: true,
                fallbackReason: "LOCAL_TTS_UNAVAILABLE",
                voiceId: resolvedLock?.voiceId ?? null,
                voiceGender: resolveVoiceGender(resolvedLock?.voiceId),
              });
            }
          } else {
            if (!activeLock || activeLock.sessionId !== sessionId) {
              lockSessionVoice(sessionId);
            }
            if (!getActiveSessionVoiceLock() && !ttsUsingCachedAudio) {
              // Only advertise browser TTS fallback when no SessionVoiceLock forbids it.
              const effectiveVoiceId = getEffectiveVoiceId();
              recordTtsEngineUsage({
                provider: "browser",
                fallbackUsed: true,
                fallbackReason: "LOCAL_TTS_UNAVAILABLE",
                voiceId: effectiveVoiceId,
                voiceGender: resolveVoiceGender(effectiveVoiceId),
              });
            }
          }
        } else {
          if (getActiveSessionVoiceLock()?.sessionId !== sessionId) {
            lockSessionVoice(sessionId);
          }
          if (
            !ttsUsingCachedAudio &&
            (!localTtsDown ||
              (!ttsAllowsFallback && currentTtsSnap.fallbackUsed))
          ) {
            const activeLock = getActiveSessionVoiceLock();
            const resolvedVoiceId =
              activeLock?.voiceId ?? getEffectiveVoiceId();
            recordTtsEngineUsage({
              provider: "local",
              fallbackUsed: false,
              fallbackReason: null,
              voiceId: resolvedVoiceId,
              voiceGender: resolveVoiceGender(resolvedVoiceId),
            });
          }
        }
      });
    };

    probeVoiceStatus();
    const unsubscribe = subscribeVoicePolicy(() => {
      probeVoiceStatus();
    });
    const recoveryTimer =
      typeof window !== "undefined"
        ? window.setInterval(() => {
            if (hostedLocalUnconfigured) {
              // On hosted Vercel (`LOCAL_VOICE_UNCONFIGURED`), local worker will
              // never spontaneously appear — never poll/clobber badges every 45s.
              return;
            }
            const status = getVoiceEngineStatus();
            if (status.stt.fallbackUsed || status.tts.fallbackUsed) {
              probeVoiceStatus();
            }
          }, 45_000)
        : null;

    return () => {
      cancelled = true;
      controller?.abort();
      unsubscribe();
      if (recoveryTimer !== null && typeof window !== "undefined") {
        window.clearInterval(recoveryTimer);
      }
    };
  }, [sessionId, voiceStudio]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown > 0) {
      const timer = setTimeout(() => {
        if (mountedRef.current) {
          setCountdown((c) => (c !== null ? c - 1 : null));
        }
      }, 1000);
      return () => clearTimeout(timer);
    }
    const finishDelayMs = getSessionStandbyRecognizer(sessionId) ? 0 : 400;
    const finishTimer = setTimeout(() => {
      if (assistantAudioPendingRef.current) {
        setCountdown(null);
        return;
      }
      if (mountedRef.current) {
        setCountdown(null);
        void startListeningRef.current().then((ok) => {
          if (mountedRef.current && ok) {
            setIsMicRecording(true);
          }
        });
      }
    }, finishDelayMs);
    return () => clearTimeout(finishTimer);
  }, [countdown, sessionId]);

  useEffect(() => {
    if (!page) return;

    pageWordsByRevisionRef.current.set(
      `${page.page_id}:${page.page_revision_id}`,
      page.words,
    );

    page.words.forEach((word, index) => {
      wordTextByIdRef.current.set(word.word_id, word.text);

      pageWordContextRef.current.set(word.word_id, {
        pageId: page.page_id,
        pageRevisionId: page.page_revision_id,
        pageNumber: page.page_number,
        wordIndex: word.word_index ?? index,
        text: word.text,
      });
    });

    // Keep URL ?pageId= synchronized when turning pages so reload/resume stays on the active page.
    if (typeof window !== "undefined" && window.history?.replaceState) {
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get("pageId") !== page.page_id) {
          url.searchParams.set("pageId", page.page_id);
          window.history.replaceState(
            window.history.state,
            "",
            `${url.pathname}${url.search}${url.hash}`,
          );
        }
      } catch {
        // Ignore history restrictions in non-standard test environments
      }
    }
  }, [page]);

  // Release microphone, audio playback, and streaming WS cleanly whenever the
  // tab is hidden or the screen locks.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibility = () => {
      if (!document.hidden || !mountedRef.current) return;
      if (
        isListeningActiveRef.current ||
        isUsingRecorderRef.current ||
        speechRecorder.isRecording ||
        retryModeRef.current ||
        assistantAudioPlayingRef.current ||
        speechPlayer.isPlaying
      ) {
        void pauseReadingRef.current();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [speechPlayer, speechRecorder]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const session = await services.readingService.get(sessionId);
        const needsInitialCompletion =
          initialUiState === "complete" ||
          session.state === "FINISHED" ||
          session.state === "ABORTED";
        // Batch startup reads in two smaller waves (3 + 3) instead of blasting
        // 6 concurrent DB queries on mobile cold start.
        const [book, child, currentPage] = await Promise.all([
          services.bookService.get(session.book_id),
          services.childService.get(session.child_id),
          services.readingService.getCurrentPage(sessionId),
        ]);
        const [completion, initialProgress, practice] = await Promise.all([
          needsInitialCompletion
            ? services.readingService.getCompletionSummary(sessionId)
            : Promise.resolve(null),
          services.readingService.getPageProgress(sessionId),
          (
            services.readingService.getPracticeState?.(sessionId) ??
            Promise.resolve(null)
          ).catch(() => null),
        ]);

        // Server-side progress is authoritative on reload. A stale pageId query
        // must not reset a session that was already advanced to another page.
        const requestedPageIsOutsideRange =
          Boolean(initialPageId) &&
          !initialProgress.pages.some((item) => item.page_id === initialPageId);

        if (!active) return;

        const hydratedChildVoice = hydrateTeacherVoiceFromChildProfile(child, {
          syncActiveServerSessionLock:
            typeof voiceStudio.updateSessionVoiceLock === "function"
              ? (lockInput) => voiceStudio.updateSessionVoiceLock!(lockInput)
              : undefined,
        });
        if (
          hydratedChildVoice &&
          getSessionVoiceAudit(sessionId).length === 0
        ) {
          lockSessionVoice(sessionId, {
            voiceId: hydratedChildVoice.voiceId,
            speed: hydratedChildVoice.speed,
            forceUpdate: true,
          });
        }

        if (
          practice &&
          (practice.pages.length > 0 || practice.legacy_evidence_present)
        ) {
          correctWordIdsRef.current.clear();
          mispronouncedWordIdsRef.current.clear();
          skippedWordIdsRef.current.clear();
          retryWordsByIdRef.current.clear();
          retryResolvedKeysRef.current.clear();
          const selfCorrected = new Set<string>();
          const unresolved = new Set<string>();
          for (const savedPage of practice.pages) {
            savedInitialPagesRef.current.add(
              `${savedPage.page_id}:${savedPage.page_revision_id}`,
            );
            for (const word of savedPage.initial_assessment) {
              wordTextByIdRef.current.set(word.word_id, word.text);
              if (word.status === "CORRECT")
                correctWordIdsRef.current.add(word.word_id);
              if (word.status === "MISPRONUNCIATION")
                mispronouncedWordIdsRef.current.add(word.word_id);
              if (word.status === "OMISSION")
                skippedWordIdsRef.current.add(word.word_id);
              if (
                word.status === "MISPRONUNCIATION" ||
                word.status === "OMISSION"
              )
                retryWordsByIdRef.current.set(word.word_id, {
                  word_id: word.word_id,
                  page_id: savedPage.page_id,
                  page_revision_id: savedPage.page_revision_id,
                  page_number: savedPage.page_number,
                  word_index: word.word_index,
                  text: word.text,
                  original_status: word.status,
                });
            }
          }
          for (const word of practice.words) {
            const key = `${sessionId}:${word.page_id}:${word.page_revision_id}:${word.word_id}`;
            retryIncorrectCountsRef.current.set(
              key,
              word.incorrect_retry_count,
            );
            retryEvaluatedCountsRef.current.set(key, word.retry_attempt_count);
            if (word.resolution_status !== "RETRYING")
              retryResolvedKeysRef.current.add(key);
            if (word.resolution_status === "SELF_CORRECTED")
              selfCorrected.add(word.word_id);
            if (word.resolution_status === "UNRESOLVED")
              unresolved.add(word.word_id);
          }
          frozenPageAssessmentsRef.current = practice.pages.map((saved) => ({
            ...saved,
            segments: [saved.transcript],
            words: [],
            initial_assessment: saved.initial_assessment.map((word) => ({
              word_id: word.word_id,
              status: word.status,
            })),
          }));
          transcriptsListRef.current = practice.pages.map(
            (saved) => saved.transcript,
          );
          initialAssessmentPreparedRef.current = true;
          setCorrectWordIds(new Set(correctWordIdsRef.current));
          setMispronouncedWordIds(new Set(mispronouncedWordIdsRef.current));
          setSkippedWordIds(new Set(skippedWordIdsRef.current));
          setRetryConfirmedWordIds(selfCorrected);
          setUnresolvedRetryWordIds(unresolved);
          // Stored UNCERTAIN includes every unassessed word. Only a live
          // capture with a known cursor can place a word-specific marker.
          setUncertainWordIds(new Set());
          const candidates = sortRetryWordRecords(
            retryWordsByIdRef.current.values(),
          )
            .filter(
              (word) =>
                !retryResolvedKeysRef.current.has(
                  `${sessionId}:${word.page_id}:${word.page_revision_id}:${word.word_id}`,
                ),
            )
            .map((word): RetryWordCandidate => ({
              wordId: word.word_id,
              pageId: word.page_id,
              pageRevisionId: word.page_revision_id,
              pageNumber: word.page_number,
              wordIndex: word.word_index,
              text: word.text,
              contextPhrase: word.text,
              originalStatus: word.original_status,
            }));
          retryCandidatesRef.current = candidates;
          setRetryCandidates(candidates);
          if (session.state !== "FINISHED" && session.state !== "ABORTED") {
            setUiState("reading");
            setRetryPrompt(candidates.length > 0);
            setConfirmFinish(candidates.length === 0);
            setLatestTranscript(t("session.restoredSessionNotice"));
          }
        }
        if (session.state === "FINISHED" || session.state === "ABORTED") {
          setSessionSummary(completion);
          setUiState("complete");
        }

        setPage(currentPage);
        setPageProgress(initialProgress);
        setPageNavigationError(
          requestedPageIsOutsideRange
            ? t("session.outOfRangePageRestored")
            : null,
        );
        setCurrentWordId(currentPage.words[0]?.word_id ?? null);
        setCanonicalState(session.state);
        setLoadState({
          status: "ready",
          data: {
            book,
            child,
            completion: completion ?? EMPTY_COMPLETION_SUMMARY,
          },
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
  }, [
    initialPageId,
    initialUiState,
    loadKey,
    services,
    sessionId,
    t,
    voiceStudio,
  ]);

  useEffect(() => {
    if (loadState.status !== "ready") return;
    return services.readingSocketAdapter.subscribe(
      sessionId,
      setCanonicalState,
    );
  }, [loadState.status, services.readingSocketAdapter, sessionId]);

  useEffect(() => {
    if (
      loadState.status !== "ready" ||
      uiState !== "page-turn" ||
      !page ||
      !pageProgress
    ) {
      return;
    }

    const nextPage = pageProgress.pages[pageProgress.current_index + 1];
    // The final-page message and disabled Next button are rendered from
    // pageProgress; do not set state synchronously inside this effect.
    if (!nextPage) return;

    let active = true;
    void services.pageMatchService
      .selectPage(sessionId, nextPage.page_id)
      .then(async (matchedPage) => {
        const progress =
          await services.readingService.getPageProgress(sessionId);
        if (!active) return;
        setPreviewSnapshot(null);
        setLatestTranscript(null);
        setComparisonResult(null);
        setPage(matchedPage);
        setPageProgress(progress);
        setPageNavigationError(null);
        // Continue an existing reading capture, never start one merely because
        // an idle page was marked complete. Wait for the new alignment effect.
        if (resumeCaptureAfterPageTurnRef.current) setCountdown(0);
        resumeCaptureAfterPageTurnRef.current = false;
        setCurrentWordId(matchedPage.words[0]?.word_id ?? null);
        setCanonicalState("LISTENING");
        setUiState("reading");
      })
      .catch(() => {
        if (!active) return;
        setPageNavigationError(t("session.nextPageFailed"));
        setUiState("reading");
      });

    return () => {
      active = false;
    };
  }, [
    loadState,
    page,
    pageProgress,
    services.pageMatchService,
    services.readingService,
    sessionId,
    t,
    uiState,
  ]);

  function applyRealtimeSnapshot(snapshot: RealtimeAlignmentSnapshot) {
    if (
      page &&
      completedPageAssessmentsRef.current.has(
        `${page.page_id}:${page.page_revision_id}`,
      )
    )
      return;
    // Đây là kết quả đã xác nhận, không phải preview.
    const nextCorrectIds = new Set(correctWordIdsRef.current);
    const nextMispronouncedIds = new Set(mispronouncedWordIdsRef.current);
    const nextSkippedIds = new Set(skippedWordIdsRef.current);
    const nextRepeatedIds = new Set(repeatedWordIdsRef.current);
    const nextHesitationIds = new Set(hesitationWordIdsRef.current);

    for (const word of snapshot.statusByWordId.values()) {
      const retryItem = retryWordsByIdRef.current.get(word.wordId);
      const retryContext = pageWordContextRef.current.get(word.wordId);

      switch (word.status) {
        case "MATCH":
          if (helpedWordIdsRef.current.has(word.wordId)) {
            // The app read this word aloud first. Reading it afterwards is
            // practice, never a plain first-pass "correct": keep it for review.
            nextSkippedIds.add(word.wordId);
            nextCorrectIds.delete(word.wordId);
            nextMispronouncedIds.delete(word.wordId);
            nextRepeatedIds.delete(word.wordId);
            if (retryContext) {
              retryWordsByIdRef.current.set(word.wordId, {
                word_id: word.wordId,
                page_id: retryContext.pageId,
                page_revision_id: retryContext.pageRevisionId,
                page_number: retryContext.pageNumber,
                word_index: retryContext.wordIndex,
                text: retryContext.text,
                original_status: retryItem?.original_status ?? "OMISSION",
              });
            }
            break;
          }
          nextCorrectIds.add(word.wordId);
          nextMispronouncedIds.delete(word.wordId);
          nextSkippedIds.delete(word.wordId);
          nextRepeatedIds.delete(word.wordId);

          // Đọc đúng trong lượt đầu thì không cần retry.
          retryWordsByIdRef.current.delete(word.wordId);
          break;

        case "SUBSTITUTE":
          nextMispronouncedIds.add(word.wordId);
          nextCorrectIds.delete(word.wordId);
          nextSkippedIds.delete(word.wordId);
          nextRepeatedIds.delete(word.wordId);

          if (retryContext) {
            retryWordsByIdRef.current.set(word.wordId, {
              word_id: word.wordId,
              page_id: retryContext.pageId,
              page_revision_id: retryContext.pageRevisionId,
              page_number: retryContext.pageNumber,
              word_index: retryContext.wordIndex,
              text: retryContext.text,
              original_status: "MISPRONUNCIATION",
            });
          } else if (retryItem) {
            retryWordsByIdRef.current.set(word.wordId, {
              ...retryItem,
              original_status: "MISPRONUNCIATION",
            });
          }
          break;

        case "DELETE":
          nextSkippedIds.add(word.wordId);
          nextCorrectIds.delete(word.wordId);
          nextMispronouncedIds.delete(word.wordId);
          nextRepeatedIds.delete(word.wordId);

          if (retryContext) {
            retryWordsByIdRef.current.set(word.wordId, {
              word_id: word.wordId,
              page_id: retryContext.pageId,
              page_revision_id: retryContext.pageRevisionId,
              page_number: retryContext.pageNumber,
              word_index: retryContext.wordIndex,
              text: retryContext.text,
              original_status: "OMISSION",
            });
          } else if (retryItem) {
            retryWordsByIdRef.current.set(word.wordId, {
              ...retryItem,
              original_status: "OMISSION",
            });
          }
          break;

        case "REPEATED":
          nextRepeatedIds.add(word.wordId);
          break;
      }
    }

    for (const id of snapshot.repeatedWordIds) {
      nextRepeatedIds.add(id);
    }

    for (const id of snapshot.hesitationWordIds) {
      nextHesitationIds.add(id);
    }

    correctWordIdsRef.current = nextCorrectIds;
    mispronouncedWordIdsRef.current = nextMispronouncedIds;
    skippedWordIdsRef.current = nextSkippedIds;
    repeatedWordIdsRef.current = nextRepeatedIds;
    hesitationWordIdsRef.current = nextHesitationIds;

    // Helped words that were then read or passed over show as "assisted".
    const nextAssisted = new Set<string>();
    for (const id of helpedWordIdsRef.current) {
      if (nextSkippedIds.has(id) && !nextMispronouncedIds.has(id)) {
        nextAssisted.add(id);
      }
    }
    setAssistedWordIds(nextAssisted);
    const nextFailedWords = new Set<string>();

    for (const id of nextMispronouncedIds) {
      const word = wordTextByIdRef.current.get(id);
      if (word) nextFailedWords.add(word);
    }

    failedWordsSetRef.current = nextFailedWords;

    setCorrectWordIds(nextCorrectIds);
    setMispronouncedWordIds(nextMispronouncedIds);
    setSkippedWordIds(nextSkippedIds);
    setRepeatedWordIds(nextRepeatedIds);
    setHesitationWordIds(nextHesitationIds);

    setCurrentWordId(snapshot.currentWordId);

    const nextSpokenWords = new Set(spokenWordsSetRef.current);

    for (const word of snapshot.spokenWords) {
      nextSpokenWords.add(word);
    }

    spokenWordsSetRef.current = nextSpokenWords;
    setSpokenWords(nextSpokenWords);
  }

  function applyPreviewSnapshot(snapshot: RealtimeAlignmentSnapshot) {
    // Không ghi preview vào các ref hoặc cursor chính thức.
    setPreviewSnapshot(snapshot);
  }

  function markCaptureUncertain(
    engine: RealtimeAlignmentEngine | null,
    targetPage: ReadingPageDTO | null,
  ) {
    if (
      !engine ||
      !targetPage ||
      completedPageAssessmentsRef.current.has(
        `${targetPage.page_id}:${targetPage.page_revision_id}`,
      )
    )
      return;
    engine.markUncertain();
    uncertainPageIdsRef.current.add(targetPage.page_revision_id);
    const cursor = engine.getSnapshot().currentWordId;
    if (cursor)
      setUncertainWordIds((previous) =>
        previous.has(cursor) ? previous : new Set([...previous, cursor]),
      );
    if (engine === alignmentEngineRef.current) setPreviewSnapshot(null);
  }

  function resetPagePresentation() {
    automationRuntimeRef.current?.dispatch({ type: "PAUSE", by: "background" });
    pageHelpWordRef.current = null;
    disambiguationPendingRef.current = null;
    lastTrailingMismatchRef.current = null;
    lastCoachedMismatchSeqRef.current = 0;
    setCompanionBubble(null);
    sentenceReinforcementRef.current.reset();
    setActiveSentenceReinforcement(null);
    setActivePhonicsLesson(null);
    setActivePhonicsStepIndex(null);
    setPhonicsStatusHint(null);
    lastPreviewTranscriptRef.current = null;
    setPreviewSnapshot(null);
    lastPreviewWordIndexRef.current = -1;
    // Word IDs are revision-scoped. Keep earlier pages' first-pass evidence
    // for the session summary and retry queue; only reset page-local previews.
    setLatestTranscript(null);
    setComparisonResult(null);
    setCurrentWordId(null);
  }

  function capturePageAssessment(
    bucket: PageTranscriptBucket,
  ): FrozenPageAssessment {
    return {
      ...bucket,
      segments: [...bucket.segments],
      words: [...bucket.words],
      initial_assessment: (
        pageWordsByRevisionRef.current.get(
          `${bucket.page_id}:${bucket.page_revision_id}`,
        ) ?? []
      ).map((word) => ({
        word_id: word.word_id,
        status:
          retryWordsByIdRef.current.get(word.word_id)?.original_status ??
          (mispronouncedWordIdsRef.current.has(word.word_id)
            ? "MISPRONUNCIATION"
            : skippedWordIdsRef.current.has(word.word_id)
              ? "OMISSION"
              : correctWordIdsRef.current.has(word.word_id)
                ? "CORRECT"
                : "UNCERTAIN"),
      })),
    };
  }

  function freezeCompletedPageAssessment(completedPage: ReadingPageDTO): void {
    const key = `${completedPage.page_id}:${completedPage.page_revision_id}`;
    const bucket = pageTranscriptsRef.current.get(key);
    if (!bucket?.segments.some((segment) => segment.trim())) return;
    if (!completedPageAssessmentsRef.current.has(key)) {
      completedPageAssessmentsRef.current.set(
        key,
        capturePageAssessment(bucket),
      );
    }
  }

  async function startListening(): Promise<boolean> {
    if (frozenPageAssessmentsRef.current && !retryModeRef.current) {
      setConfirmFinish(true);
      return false;
    }
    if (assistantAudioPendingRef.current || !mountedRef.current) return false;
    if (listeningStartRef.current) return listeningStartRef.current;
    if (isStartingListeningRef.current) return true;
    if (listeningStopRef.current) return false;
    if (isListeningActiveRef.current) return true;

    let resolvePending!: (value: boolean) => void;
    let rejectPending!: (reason?: unknown) => void;
    const pending = new Promise<boolean>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    // Prevent unhandled rejection if beginListening rejects while no secondary
    // caller has awaited `listeningStartRef.current`.
    void pending.catch(() => undefined);
    isStartingListeningRef.current = true;
    listeningStartRef.current = pending;
    try {
      const ok = await beginListening();
      resolvePending(ok);
      return ok;
    } catch (error) {
      rejectPending(error);
      throw error;
    } finally {
      isStartingListeningRef.current = false;
      if (listeningStartRef.current === pending)
        listeningStartRef.current = null;
    }
  }

  function finishPassageAlignment(
    engine: RealtimeAlignmentEngine,
  ): RealtimeAlignmentSnapshot {
    if (
      pageHelpWordRef.current?.awaitingAttempt &&
      engine.getSnapshot().currentWordId === pageHelpWordRef.current.wordId
    ) {
      engine.markUncertain();
    }
    return engine.finish();
  }

  function extractMeaningfulPhrase(
    words: readonly ReadingPageWordDTO[],
    targetIndex: number,
  ): readonly ReadingPageWordDTO[] {
    if (!words.length) return [];
    const idx = Math.max(0, Math.min(words.length - 1, targetIndex));
    const isStopPunct = (txt: string) => /[.!?…,;:]$/u.test(txt.trim());
    let start = idx;
    let end = idx;
    while (end + 1 < words.length && end - start + 1 < 3) {
      if (isStopPunct(words[end].text)) break;
      end += 1;
    }
    while (start > 0 && end - start + 1 < 2) {
      if (isStopPunct(words[start - 1].text)) break;
      start -= 1;
    }
    return words.slice(start, end + 1);
  }

  function adaptPersona(text: string): string {
    return adaptTextToTeacherPersona(text, getEffectiveTeacherPersona().gender);
  }

  function findAmbiguousHelpTargets(
    text: string,
    engine: RealtimeAlignmentEngine,
    capturePage: ReadingPageDTO,
  ): readonly [ReadingPageWordDTO, ReadingPageWordDTO] | null {
    const normalized = normalizeVietnameseText(text);
    const isDeicticHelp =
      /(?:chữ này|từ này|chỗ này)/u.test(normalized) &&
      /(?:không|chưa) biết/u.test(normalized);
    if (!isDeicticHelp) return null;
    const snap = engine.getSnapshot();
    const curIdx = capturePage.words.findIndex(
      (w) => w.word_id === snap.currentWordId,
    );
    if (curIdx <= 0) return null;
    const curWord = capturePage.words[curIdx];
    const prevWord = capturePage.words[curIdx - 1];
    if (!curWord || !prevWord) return null;
    const prevStatus = snap.statusByWordId.get(prevWord.word_id)?.status;
    if (
      prevStatus === "SUBSTITUTE" ||
      prevStatus === "DELETE" ||
      lastTrailingMismatchRef.current?.wordId === prevWord.word_id
    ) {
      return [prevWord, curWord];
    }
    return null;
  }

  function ensureAutomationRuntime(): ReadingAutomationRuntime {
    if (automationRuntimeRef.current) {
      automationRuntimeRef.current.dispatch({
        type: "SET_SETTINGS",
        settings: automationRef.current,
      });
      return automationRuntimeRef.current;
    }
    const clock: AutomationClock = {
      now: () =>
        typeof performance !== "undefined" ? performance.now() : Date.now(),
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: (handle) => {
        if (typeof handle === "number") window.clearTimeout(handle);
      },
    };
    const runtime = new ReadingAutomationRuntime(
      clock,
      {
        startListening: async () => {
          if (!mountedRef.current || retryModeRef.current) {
            return { ok: false, reason: "unavailable" };
          }
          if (
            isListeningActiveRef.current ||
            isStartingListeningRef.current ||
            listeningStartRef.current
          ) {
            return { ok: true };
          }
          const ok = await startListeningRef.current();
          if (mountedRef.current) setIsMicRecording(ok);
          return ok ? { ok: true } : { ok: false, reason: "unavailable" };
        },
        stopListening: () => {
          // Audio playback helper manages mic suspension cleanly.
        },
        playModel: async (effect) => {
          const engine = alignmentEngineRef.current;
          const activePage = pageRef.current;
          if (!engine || !activePage || !mountedRef.current) return;
          if (
            effect.kind !== "encourage" &&
            effect.kind !== "clarify" &&
            (engine.getSnapshot().spellingInProgress ||
              sentenceReinforcementRef.current.getActive() !== null)
          ) {
            return;
          }
          if (effect.kind === "prompt") {
            const track = speechRecorder.getStream?.()?.getAudioTracks()?.[0];
            const hasInjectedRec =
              typeof window !== "undefined" &&
              isInjectedTestSpeechRecognition(
                (window as unknown as WindowWithSpeech).SpeechRecognition ||
                  (window as unknown as WindowWithSpeech)
                    .webkitSpeechRecognition,
              );
            if (
              (!track || track.readyState !== "live") &&
              !(hasInjectedRec && isListeningActiveRef.current)
            ) {
              return;
            }
            await runAutomationModelEffect(effect, engine, activePage);
            return;
          }
          await runAutomationModelEffect(effect, engine, activePage);
        },
        stopAudio: () => {
          preventAssistantAudioResume();
          speechPlayer.stop();
        },
        savePage: async (key, attempt) => {
          if (!automationRef.current.autoAdvance) return true;
          if (savedPageProgressKeysRef.current.has(key)) return true;
          const parts = key.split(":");
          const targetPageId = parts[1];
          const targetRevisionId = parts[2];
          if (!targetPageId || !targetRevisionId) return true;
          if (
            attempt === 1 &&
            !pageCompletionPromiseRef.current &&
            !inFlightPageSaveRef.current &&
            failedPageProgressKeyRef.current !== key
          ) {
            await Promise.resolve();
          }
          if (savedPageProgressKeysRef.current.has(key)) return true;
          if (inFlightPageSaveRef.current?.key === key) {
            try {
              await inFlightPageSaveRef.current.promise;
              return true;
            } catch {
              return false;
            }
          }
          if (pageCompletionPromiseRef.current?.key === key) {
            return await pageCompletionPromiseRef.current.promise;
          }
          const progress = pageProgressRef.current;
          if (!progress?.persisted) return true;
          const activePage = pageRef.current;
          if (activePage && activePage.page_id === targetPageId) {
            freezeCompletedPageAssessment(activePage);
          }
          try {
            await persistPageProgress(targetPageId, targetRevisionId);
            return true;
          } catch {
            return false;
          }
        },
        turnPage: () => {
          if (
            !mountedRef.current ||
            retryModeRef.current ||
            uiStateRef.current !== "reading"
          ) {
            return;
          }
          const progress = pageProgressRef.current;
          if (progress && progress.current_index + 1 < progress.total_pages) {
            resumeCaptureAfterPageTurnRef.current = true;
            setUiState("page-turn");
          }
        },
        finishSession: () => {
          if (!mountedRef.current || retryModeRef.current) return;
          const progress = pageProgressRef.current;
          if (
            automationRef.current.autoAdvance &&
            progress &&
            progress.current_index + 1 >= progress.total_pages
          ) {
            void handleLastPageAutoComplete();
          }
        },
        giveUpWord: (wordId) => {
          gaveUpWordIdsRef.current.add(wordId);
          helpedWordIdsRef.current.add(wordId);
          lastGivenUpWordForEncourageRef.current = wordId;
          const engine = alignmentEngineRef.current;
          if (engine) {
            applyRealtimeSnapshot(engine.giveUpWord(wordId));
          }
        },
        needsPractice: (wordId) => {
          helpedWordIdsRef.current.add(wordId);
        },
        show: (message: AutomationMessage) => {
          if (!mountedRef.current) return;
          if (message === "offer-pause") {
            const msg = adaptPersona(
              "Mình nghỉ một chút nhé? Khi sẵn sàng con nói “Đọc tiếp” hoặc bấm nút nhé.",
            );
            setLatestTranscript(msg);
            setCompanionBubble({
              mood: "comforting",
              title: t("companion.pauseTitle"),
              message: msg,
            });
          } else if (message === "wait-extended") {
            setCompanionBubble({
              mood: "listening",
              title: adaptPersona(t("companion.waitingTitle")),
              message: adaptPersona(
                "Con cứ thong thả tự đọc nhé, cô vẫn nghe đây.",
              ),
            });
          }
        },
      },
      automationRef.current,
      {
        ...AUTO_HELP_LADDER_CONFIG,
        maxAttemptsPerWord: 3,
        hesitationMinMs: 4_000,
        hesitationMaxMs: 9_000,
        initialPaceMs: 3_600,
        selfCorrectWindowMs: 1_500,
        promptToHelpMs: 250,
        maxPromptsPerPage: 0,
        maxSilenceReminders: 2,
      },
    );
    automationRuntimeRef.current = runtime;
    return runtime;
  }

  async function runAutomationModelEffect(
    effect: Extract<AutomationEffect, { type: "PLAY_MODEL" }>,
    engine: RealtimeAlignmentEngine,
    capturePage: ReadingPageDTO,
  ): Promise<void> {
    if (
      !isListeningActiveRef.current ||
      assistantAudioPendingRef.current ||
      listeningStopRef.current
    ) {
      return;
    }
    const generation = assistantAudioGenerationRef.current + 1;
    const isCurrent = () =>
      mountedRef.current &&
      !retryModeRef.current &&
      generation === assistantAudioGenerationRef.current &&
      alignmentEngineRef.current === engine;

    const targetWordId = effect.wordId ?? engine.getSnapshot().currentWordId;
    const index = targetWordId
      ? capturePage.words.findIndex((entry) => entry.word_id === targetWordId)
      : -1;
    const word = index >= 0 ? capturePage.words[index] : undefined;
    const mismatch =
      lastTrailingMismatchRef.current?.wordId === word?.word_id
        ? lastTrailingMismatchRef.current
        : null;

    if (effect.kind === "clarify" && effect.wordIds.length >= 2) {
      const w1 =
        capturePage.words.find((w) => w.word_id === effect.wordIds[0])?.text ??
        effect.wordIds[0];
      const w2 =
        capturePage.words.find((w) => w.word_id === effect.wordIds[1])?.text ??
        effect.wordIds[1];
      const clarifyText = `Con hỏi chữ “${w1}” hay chữ “${w2}”?`;
      await playAssistantAudio(
        async () => {
          if (!isCurrent()) return;
          setCompanionBubble({
            mood: "listening",
            title: t("companion.clarifyTitle"),
            message: clarifyText,
          });
          setLatestTranscript(clarifyText);
          await speakGuarded(clarifyText);
        },
        true,
        false,
        true,
      );
      if (isCurrent()) {
        const started = await startListeningRef.current();
        if (isCurrent()) setIsMicRecording(started);
      }
      return;
    }

    if (effect.kind === "encourage") {
      const givenUpId = lastGivenUpWordForEncourageRef.current;
      lastGivenUpWordForEncourageRef.current = null;
      const encourageWord = givenUpId
        ? capturePage.words.find((entry) => entry.word_id === givenUpId)
        : word;
      const encourageMismatch =
        encourageWord &&
        lastTrailingMismatchRef.current?.wordId === encourageWord.word_id
          ? lastTrailingMismatchRef.current
          : mismatch;
      await playAssistantAudio(
        async () => {
          if (!isCurrent()) return;
          const style = coachingStyleRef.current;
          const text =
            encourageMismatch && encourageWord
              ? style === "gentle"
                ? promptSelectorRef.current.next("comfortGiveUpEffort", {
                    word: encourageWord.text,
                  })
                : promptSelectorRef.current.next("encourageMoveOn")
              : "Con đã cố gắng rất tốt rồi. Mình đọc tiếp nhé!";
          if (encourageMismatch && encourageWord) {
            setCompanionBubble({
              mood: "comforting",
              title: t("companion.effortTitle"),
              message: text,
            });
          }
          setLatestTranscript(text);
          await speakGuarded(text);
          if (!isCurrent() || !encourageWord) return;
          gaveUpWordIdsRef.current.add(encourageWord.word_id);
          helpedWordIdsRef.current.add(encourageWord.word_id);
          pageHelpWordRef.current = null;
          applyRealtimeSnapshot(engine.giveUpWord(encourageWord.word_id));
          const reinforced = maybeArmSentenceReinforcement(
            capturePage,
            encourageWord.word_id,
            "helped",
          );
          if (reinforced && isCurrent()) {
            const promptText = promptSelectorRef.current.next(
              "sentenceReinforceAfterHelp",
              { sentence: reinforced.span.text },
            );
            setCompanionBubble({
              mood: "teaching",
              title: t("companion.reinforceTitle"),
              message: promptText,
            });
            setLatestTranscript(promptText);
            await speakGuarded(promptText, { preserveBookText: true });
          }
        },
        true,
        false,
        true,
      );
      if (!isCurrent()) return;
      if (engine.getSnapshot().currentWordId !== null) {
        const started = await startListeningRef.current();
        if (isCurrent()) setIsMicRecording(started);
      } else {
        await autoCompletePageAfterFinalWordRef.current(engine.getSnapshot());
      }
      return;
    }

    if (!word) return;
    if (mismatch) {
      const reconciled = engine.holdAtTrailingMismatchForCoaching();
      if (reconciled) applyRealtimeSnapshot(reconciled.snapshot);
    }
    const phraseWords = extractMeaningfulPhrase(capturePage.words, index);
    for (const helped of effect.kind === "phrase" ? phraseWords : [word]) {
      helpedWordIdsRef.current.add(helped.word_id);
    }
    pageHelpWordRef.current = {
      wordId: word.word_id,
      awaitingAttempt: true,
    };

    try {
      await playAssistantAudio(
        async () => {
          if (!isCurrent()) return;
          if (
            effect.kind === "hint" ||
            effect.kind === "word" ||
            effect.kind === "orient"
          ) {
            if (mismatch) {
              const style = coachingStyleRef.current;
              const mistakeType = classifyReadingMistake(
                word.text,
                mismatch.spokenToken,
              );
              const category = mistakeCategoryToPromptCategory(
                mistakeType,
                style,
              );
              const comfortText = promptSelectorRef.current.next(category, {
                word: word.text,
              });
              const teacherWord =
                getEffectiveTeacherPersona().gender === "male"
                  ? t("companion.teacherMaleShort")
                  : t("companion.teacherFemaleShort");
              const title =
                mistakeType === "TONE"
                  ? t("companion.toneHintTitle")
                  : mistakeType === "NEAR_SOUND"
                    ? t("companion.nearSoundHintTitle")
                    : t("companion.comfortTitle", { teacher: teacherWord });
              setCompanionBubble({
                mood: "comforting",
                title,
                message: comfortText,
              });
              setLatestTranscript(comfortText);
              await speakGuarded(comfortText, { preserveBookText: true });
            } else {
              setLatestTranscript(
                `${adaptPersona("Con nghe cô đọc từ")} “${word.text}” nhé.`,
              );
              await speakGuarded("Cô đọc mẫu cho con nhé.", { coaching: true });
              if (!isCurrent()) return;
              await speakGuarded(word.text, { wordSample: true });
              if (!isCurrent()) return;
              await speakGuarded("Đến lượt con đọc nhé.", { coaching: true });
            }
          } else if (effect.kind === "phrase") {
            // Round 3: praise persistence and model the phrase in context
            const phrase = phraseWords.map((entry) => entry.text).join(" ");
            if (mismatch) {
              const style = coachingStyleRef.current;
              const step3Text =
                style === "gentle"
                  ? promptSelectorRef.current.next("comfortStep3Phrase", {
                      phrase,
                    })
                  : `Mình đọc cả cụm “${phrase}” nhé.`;
              setCompanionBubble({
                mood: "teaching",
                title: t("companion.phraseEncourageTitle"),
                message: step3Text,
              });
              setLatestTranscript(`${step3Text} “${phrase}”`);
              await speakGuarded(step3Text, { preserveBookText: true });
              if (!isCurrent()) return;
              await speakGuarded(phrase, { preserveBookText: true });
            } else {
              setLatestTranscript(`Mình đọc nối cụm “${phrase}” nhé.`);
              await speakGuarded(phrase, { preserveBookText: true });
              if (!isCurrent()) return;
              await speakGuarded("Đến lượt con đọc nhé.", { coaching: true });
            }
          } else {
            // Round 2: model/phonics + invite returning to meaningful phrase
            const phrase = phraseWords.map((entry) => entry.text).join(" ");
            if (mismatch) {
              const style = coachingStyleRef.current;
              const phonicsGuide = generateSpokenPhonicsGuide(word.text);
              const intro =
                style === "gentle"
                  ? promptSelectorRef.current.next("comfortStep2WarmIntro")
                  : promptSelectorRef.current.next("wordSlowIntro");
              setCompanionBubble({
                mood: "teaching",
                title: t("companion.phrasePhonicsTitle"),
                message: `${intro} ${phonicsGuide} “${phrase}”`,
              });
              setLatestTranscript(`${phonicsGuide} · “${phrase}”`);
              if (style === "gentle") {
                await speakGuarded(intro, {
                  coaching: true,
                  preserveBookText: true,
                });
                if (!isCurrent()) return;
              }
              await speakGuarded(phonicsGuide, { preserveBookText: true });
              if (!isCurrent()) return;
              await speakGuarded(word.text, {
                wordSample: true,
              });
              if (!isCurrent()) return;
              await speakGuarded(phrase, { preserveBookText: true });
            } else {
              setLatestTranscript(
                `Mình đọc chậm từ “${word.text}” rồi nối cụm “${phrase}” nhé.`,
              );
              await speakGuarded(word.text, {
                wordSample: true,
              });
              if (!isCurrent()) return;
              if (phraseWords.length > 1) {
                await speakGuarded(phrase, { preserveBookText: true });
                if (!isCurrent()) return;
              }
              await speakGuarded("Đến lượt con đọc nhé.", { coaching: true });
            }
          }
        },
        true,
        false,
        true,
      );
      if (!isCurrent()) return;
      if (engine.getSnapshot().currentWordId !== null) {
        const started = await startListeningRef.current();
        if (isCurrent()) setIsMicRecording(started);
      } else {
        await autoCompletePageAfterFinalWordRef.current(engine.getSnapshot());
      }
    } catch {
      if (isCurrent()) {
        engine.markUncertain();
        setLatestTranscript(
          "Chưa phát được tiếng mẫu. Con có thể bấm nghe lại nhé.",
        );
        if (engine.getSnapshot().currentWordId !== null) {
          const started = await startListeningRef.current();
          if (isCurrent()) setIsMicRecording(started);
        }
      }
    }
  }

  function isPassageHelpRequest(
    text: string,
    engine: RealtimeAlignmentEngine,
    capturePage: ReadingPageDTO,
  ): boolean {
    const nextId = engine.getSnapshot().currentWordId;
    const next = capturePage.words.findIndex((word) => word.word_id === nextId);
    const upcoming =
      next < 0
        ? ""
        : capturePage.words
            .slice(next, next + 12)
            .map((word) => word.text)
            .join(" ");
    // "đọc mẫu giúp con", "cô ơi đọc giúp con"… (the passage wins when the
    // phrase is the next book text).
    if (parseVoiceIntent(text, { upcomingText: upcoming }).type === "HELP") {
      return true;
    }
    if (!isWordHelpRequest(text, "")) return false;
    return (
      next < 0 ||
      isWordHelpRequest(
        text,
        capturePage.words
          .slice(next)
          .map((word) => word.text)
          .join(" "),
      )
    );
  }

  /** Whole-page sample, registered with the echo guard while it plays. */
  function playPageSampleGuarded(
    words: readonly string[],
    options: WordTimedPlayOptions,
  ): Promise<void> {
    const sampleText = options.text ?? words.join(" ");
    const pageAudioMeta = page as
      | (ReadingPageDTO & {
          readonly tts_audio_url?: string | null;
          readonly tts_word_timings?: readonly WordTiming[] | null;
          readonly tts_voice_id?: string | null;
          readonly tts_cached_speed?: number | null;
        })
      | null;
    const isPrivateBook = Boolean(
      options.isPrivateBook ?? activeCacheIsPrivate,
    );
    const precomputedUrl = isPrivateBook
      ? undefined
      : (options.precomputedAudioUrl ??
        pageAudioMeta?.tts_audio_url ??
        undefined);
    const precomputedTimings = isPrivateBook
      ? undefined
      : (options.precomputedWordTimings ??
        pageAudioMeta?.tts_word_timings ??
        undefined);
    const precomputedVoiceId = isPrivateBook
      ? undefined
      : (options.precomputedVoiceId ??
        pageAudioMeta?.tts_voice_id ??
        undefined);
    const precomputedCachedSpeed = isPrivateBook
      ? undefined
      : (options.precomputedCachedSpeed ??
        pageAudioMeta?.tts_cached_speed ??
        undefined);
    const resolvedFallbackScope = isPrivateBook
      ? "PRIVATE"
      : (options.cacheScope ?? "CATALOG");
    const id = `assistant-${(assistantPlaybackSeqRef.current += 1)}`;
    echoGuard.playbackStarted(id, sampleText, performance.now());
    let audioPlayed = false;
    let playbackFailed = false;
    let fallbackLastWordIndex = -1;
    const mergedOptions: WordTimedPlayOptions = {
      ...options,
      isPrivateBook,
      cacheScope: resolvedFallbackScope,
      ...(precomputedUrl ? { precomputedAudioUrl: precomputedUrl } : {}),
      ...(precomputedTimings
        ? { precomputedWordTimings: precomputedTimings }
        : {}),
      ...(precomputedVoiceId ? { precomputedVoiceId } : {}),
      ...(precomputedCachedSpeed !== undefined &&
      precomputedCachedSpeed !== null
        ? { precomputedCachedSpeed }
        : {}),
      onPlay: () => {
        audioPlayed = true;
        options.onPlay?.();
      },
    };
    return speechPlayer
      .playWithWordTimings(words, mergedOptions, () =>
        speechPlayer.play(sampleText, {
          ...(precomputedUrl ? { precomputedAudioUrl: precomputedUrl } : {}),
          ...(precomputedVoiceId ? { precomputedVoiceId } : {}),
          ...(precomputedCachedSpeed !== undefined &&
          precomputedCachedSpeed !== null
            ? { precomputedCachedSpeed }
            : {}),
          bookId: options.bookId,
          pageId: options.pageId,
          pageRevisionId: options.pageRevisionId,
          isPrivateBook,
          cacheScope: resolvedFallbackScope,
          onPlay: () => {
            audioPlayed = true;
            fallbackLastWordIndex = 0;
            options.onPlay?.();
          },
          onTimeUpdate: options.onWordChange
            ? (currentTime, duration) => {
                if (
                  !words.length ||
                  !Number.isFinite(duration) ||
                  duration <= 0
                ) {
                  return;
                }
                const ratio = Math.max(
                  0,
                  Math.min(0.9999, currentTime / duration),
                );
                const idx = Math.min(
                  words.length - 1,
                  Math.floor(ratio * words.length),
                );
                if (idx !== fallbackLastWordIndex) {
                  fallbackLastWordIndex = idx;
                  options.onWordChange?.(idx);
                }
              }
            : undefined,
          onEnded: options.onEnded,
        }),
      )
      .catch((error: unknown) => {
        playbackFailed = true;
        throw error;
      })
      .finally(() => {
        if (playbackFailed && !audioPlayed) {
          echoGuard.discardPlayback(id);
        } else {
          echoGuard.playbackEnded(id, performance.now());
        }
      });
  }

  function isPassageSpellRequest(
    text: string,
    engine: RealtimeAlignmentEngine,
    capturePage: ReadingPageDTO,
  ): boolean {
    const nextId = engine.getSnapshot().currentWordId;
    const next = capturePage.words.findIndex((word) => word.word_id === nextId);
    const upcoming =
      next < 0
        ? ""
        : capturePage.words
            .slice(next, next + 12)
            .map((word) => word.text)
            .join(" ");
    if (parseVoiceIntent(text, { upcomingText: upcoming }).type === "SPELL") {
      return true;
    }
    return isSpellingHelpRequest(text, upcoming);
  }

  /** Speak step-by-step phonics lesson and register all steps with EchoGuard. */
  async function speakPhonicsLessonGuarded(
    lesson: SupportedPhonicsLessonPlan,
    onStep?: (stepIdx: number) => void,
  ): Promise<void> {
    const id = `assistant-${(assistantPlaybackSeqRef.current += 1)}`;
    const fullSpoken = lesson.steps.map((s) => s.spokenText).join(" ");
    echoGuard.playbackStarted(id, fullSpoken, performance.now());
    let playbackFailed = false;
    setIsPlayingPhonicsLesson(true);
    try {
      if (typeof speechPlayer.playPhonicsLesson === "function") {
        await speechPlayer.playPhonicsLesson(lesson, {
          onStepChange: (idx) => onStep?.(idx),
        });
      } else {
        for (const step of lesson.steps) {
          onStep?.(step.index);
          await speechPlayer.play(step.spokenText);
        }
      }
    } catch (err) {
      playbackFailed = true;
      throw err;
    } finally {
      setIsPlayingPhonicsLesson(false);
      if (playbackFailed) {
        echoGuard.discardPlayback(id);
      } else {
        echoGuard.playbackEnded(id, performance.now());
      }
    }
  }

  /** Speak one assistant utterance and register it individually with the echo guard. */
  async function speakGuarded(
    text: string,
    options?: SpeechPlayOptions & { readonly preserveBookText?: boolean },
  ): Promise<void> {
    const { preserveBookText, ...playOptions } = options ?? {};
    const shouldPreserveVerbatim = Boolean(
      playOptions.wordSample || preserveBookText,
    );
    const spokenText = shouldPreserveVerbatim
      ? text
      : adaptTextToTeacherPersona(text, getEffectiveTeacherPersona().gender);
    if (spokenText.trim()) {
      assistantTurnSpokenRef.current.push(spokenText.trim());
    }
    // Register ONLY this utterance's text with EchoGuard (never concatenate earlier
    // modeled book words into "Đến lượt con đọc nhé.", which would falsely reject
    // the child's immediate first spoken word as `tail-overlap`).
    const id = `assistant-${(assistantPlaybackSeqRef.current += 1)}`;
    echoGuard.playbackStarted(id, spokenText, performance.now());
    let playbackFailed = false;
    try {
      if (Object.keys(playOptions).length === 0) {
        await speechPlayer.play(spokenText);
      } else {
        await speechPlayer.play(spokenText, playOptions);
      }
    } catch (err) {
      playbackFailed = true;
      throw err;
    } finally {
      if (playbackFailed) {
        echoGuard.discardPlayback(id);
      } else {
        echoGuard.playbackEnded(id, performance.now());
      }
    }
  }

  function maybeArmSentenceReinforcement(
    capturePage: ReadingPageDTO,
    wordId: string,
    outcome: "fixed" | "helped",
  ): ActiveSentenceReinforcement | null {
    // Do not force the child to re-read the entire sentence after a single hard
    // word; let them keep reading forward naturally without interruption.
    void capturePage;
    void wordId;
    void outcome;
    return null;
  }

  async function announceSentenceReinforcement(
    active: ActiveSentenceReinforcement,
    engine: RealtimeAlignmentEngine,
  ): Promise<void> {
    if (!mountedRef.current) return;
    if (assistantAudioPendingRef.current) {
      pendingSentenceReinforcementRef.current = { active, engine };
      return;
    }
    pendingSentenceReinforcementRef.current = null;
    const generation = assistantAudioGenerationRef.current + 1;
    const isCurrent = () =>
      mountedRef.current &&
      !retryModeRef.current &&
      generation === assistantAudioGenerationRef.current &&
      alignmentEngineRef.current === engine;
    const promptText = promptSelectorRef.current.next(
      active.outcome === "fixed"
        ? "sentenceReinforceAfterSuccess"
        : "sentenceReinforceAfterHelp",
      { sentence: active.span.text },
    );
    try {
      await playAssistantAudio(
        async () => {
          if (!isCurrent()) return;
          setLatestTranscript(promptText);
          await speakGuarded(promptText, { preserveBookText: true });
        },
        true,
        false,
        false,
      );
      if (!isCurrent()) return;
      const started = await startListeningRef.current();
      if (isCurrent()) setIsMicRecording(started);
    } catch {
      // Keep reading flow moving cleanly if TTS fails.
    }
  }

  async function finishSentenceReinforcement(
    engine: RealtimeAlignmentEngine | null,
    praise: boolean,
  ): Promise<void> {
    sentenceReinforcementRef.current.finishCurrent();
    setActiveSentenceReinforcement(null);
    if (!mountedRef.current) return;
    if (praise && engine) {
      const doneText = promptSelectorRef.current.next("sentenceReinforceDone");
      const generation = assistantAudioGenerationRef.current + 1;
      const isCurrent = () =>
        mountedRef.current &&
        !retryModeRef.current &&
        generation === assistantAudioGenerationRef.current &&
        alignmentEngineRef.current === engine;
      try {
        await playAssistantAudio(
          async () => {
            if (!isCurrent()) return;
            setLatestTranscript(doneText);
            await speakGuarded(doneText, { coaching: true });
          },
          true,
          false,
          false,
        );
        if (!isCurrent()) return;
        if (!engine.getSnapshot().currentWordId) {
          await autoCompletePageAfterFinalWordRef.current(engine.getSnapshot());
          return;
        }
        const started = await startListeningRef.current();
        if (isCurrent()) setIsMicRecording(started);
      } catch {
        // Keep reading usable
      }
      return;
    }
    if (engine && !engine.getSnapshot().currentWordId) {
      await autoCompletePageAfterFinalWordRef.current(engine.getSnapshot());
    }
  }

  async function offerPassageHelp(
    engine: RealtimeAlignmentEngine,
    capturePage: ReadingPageDTO,
  ): Promise<void> {
    const rt = ensureAutomationRuntime();
    rt.dispatch({
      type: "HELP_REQUEST",
      scope: "word",
      source: "voice",
    });
    void engine;
    void capturePage;
  }

  /**
   * Explicit step-by-step Vietnamese phonics (`Đánh vần từng bước`) right in-place
   * on the current book page (triggered by voice "Đánh vần giúp con" / "Nghe đánh vần"
   * or button `Nghe đánh vần`), sharing `phonics-lesson.ts` with Difficult Words Practice.
   */
  async function offerExplicitPhonicsHelp(
    engine: RealtimeAlignmentEngine | null,
    capturePage: ReadingPageDTO | null,
    explicitWord?: { readonly word_id: string | null; readonly text: string },
    allowInterrupt = false,
  ): Promise<void> {
    if (listeningStopRef.current) return;
    if (assistantAudioPendingRef.current && !allowInterrupt) return;
    if (allowInterrupt) {
      stopAssistantAudio();
      setIsReadingWord(false);
    }

    const target =
      explicitWord ??
      (retryModeRef.current
        ? (() => {
            const cand = retryCandidatesRef.current[retryPositionRef.current];
            return cand ? { word_id: cand.wordId, text: cand.text } : null;
          })()
        : (() => {
            const wid = isListeningActiveRef.current
              ? (engine?.getSnapshot().currentWordId ?? currentWordId)
              : (currentWordId ?? engine?.getSnapshot().currentWordId);
            const found =
              (wid
                ? capturePage?.words.find((w) => w.word_id === wid)
                : null) ?? capturePage?.words[0];
            return found ? { word_id: found.word_id, text: found.text } : null;
          })());
    if (!target) return;

    let plan = buildPhonicsLesson(target.text);
    setActivePhonicsLesson({ wordId: target.word_id, plan });
    setActivePhonicsStepIndex(plan.supported ? 0 : null);
    setPhonicsStatusHint(null);
    setIsAnalyzingPhonicsAi(false);

    if (target.word_id && !retryModeRef.current) {
      helpedWordIdsRef.current.add(target.word_id);
      phonicsSpelledWordIdsRef.current.add(target.word_id);
      pageHelpWordRef.current = {
        wordId: target.word_id,
        awaitingAttempt: true,
      };
    }

    const generation = assistantAudioGenerationRef.current + 1;
    const isCurrent = () =>
      mountedRef.current && generation === assistantAudioGenerationRef.current;
    const wasListening = isListeningActiveRef.current || isMicRecording;

    try {
      await playAssistantAudio(
        async () => {
          if (!isCurrent()) return;
          if (
            !plan.supported &&
            plan.canPlayWholeWord &&
            typeof speechService.analyzePhonics === "function"
          ) {
            setIsAnalyzingPhonicsAi(true);
            try {
              const aiPlan = await speechService.analyzePhonics(target.text, {
                contextPhrase: capturePage?.words
                  ? capturePage.words
                      .slice(0, 12)
                      .map((w) => w.text)
                      .join(" ")
                  : null,
              });
              if (!isCurrent()) return;
              if (aiPlan && aiPlan.supported) {
                plan = aiPlan;
                setActivePhonicsLesson({ wordId: target.word_id, plan });
                setActivePhonicsStepIndex(0);
              }
            } finally {
              if (mountedRef.current) {
                setIsAnalyzingPhonicsAi(false);
              }
            }
          }
          if (!plan.supported) {
            setPhonicsStatusHint(plan.message);
            if (plan.canPlayWholeWord) {
              await speakGuarded(target.text, { wordSample: true });
            }
            return;
          }
          await speakPhonicsLessonGuarded(plan, (stepIdx) => {
            if (isCurrent()) setActivePhonicsStepIndex(stepIdx);
          });
          if (!isCurrent()) return;
          const invite = `Giờ con đọc trọn tiếng “${plan.focusSyllable}” nhé.`;
          setPhonicsStatusHint(invite);
          await speakGuarded("Đến lượt con đọc nhé.", { coaching: true });
        },
        true,
        false,
        wasListening,
      );
      if (!isCurrent()) return;
      if (wasListening && !retryModeRef.current) {
        const started = await startListeningRef.current();
        if (isCurrent()) setIsMicRecording(started);
      } else if (wasListening && retryModeRef.current) {
        const cand = retryCandidatesRef.current[retryPositionRef.current];
        if (cand) {
          void startRetryRecognition(cand);
        }
      }
    } catch {
      if (isCurrent()) {
        setPhonicsStatusHint(t("session.phonicsLockedVoiceBusy"));
      }
    }
  }

  function handleSpellCurrentWord(): void {
    if (uiStateRef.current === "tts-error") {
      setUiState("reading");
    }
    void offerExplicitPhonicsHelp(
      alignmentEngineRef.current,
      page,
      undefined,
      true,
    );
  }

  async function beginListening(): Promise<boolean> {
    const generation = listeningGenerationRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      generation === listeningGenerationRef.current &&
      !assistantAudioPendingRef.current;
    setLatestTranscript(null);
    setComparisonResult(null);
    setComparisonError(null);
    browserTranscriptCollectorRef.current.reset();
    passageContainsHelpRef.current = false;
    passageContainsSpellRef.current = false;
    const captureEngine = alignmentEngineRef.current;
    const capturePage = page;
    const runtime = ensureAutomationRuntime();
    if (capturePage) {
      const currentRtPage = runtime.getState().page;
      const isLastPage = pageProgress
        ? pageProgress.current_index >= pageProgress.total_pages - 1
        : false;
      const startIndex = resolveWordArrayIndex(
        capturePage.words,
        captureEngine?.getSnapshot(),
        0,
      );
      if (
        !currentRtPage ||
        currentRtPage.pageId !== capturePage.page_id ||
        currentRtPage.revisionId !== capturePage.page_revision_id ||
        runtime.getState().phase === "paused"
      ) {
        runtime.dispatch({
          type: "START_PAGE",
          page: {
            sessionId,
            pageId: capturePage.page_id,
            revisionId: capturePage.page_revision_id,
            isLastPage,
          },
          words: capturePage.words.map((w) => ({
            id: w.word_id,
            punctAfter: /[.!?…,;:]$/u.test(w.text),
          })),
          startIndex,
        });
      }
      automationStateRef.current = runtime.getState();
    }

    const preferAndroidNativeStt = shouldPreferAndroidNativeStt();
    if (
      !preferAndroidNativeStt &&
      detectBrowserWasmSttSupport().supported &&
      !getBrowserWasmSttClient().isReady()
    ) {
      const freshHealth = getFreshVoiceEngineHealth();
      const localSttReady = Boolean(
        !isPermanentlyHostedLocalUnconfigured(freshHealth) &&
        freshHealth?.local.available &&
        freshHealth.local.stt_ready,
      );
      if (!localSttReady) {
        setLatestTranscript("Đang khởi động nhận diện giọng nói...");
        await awaitSttReadyBeforeListening(1_500);
        if (!isCurrent()) return false;
        setLatestTranscript(null);
      }
    }
    let recorderStarted = false;
    if (preferAndroidNativeStt) {
      // Skip parallel WebView getUserMedia/MediaRecorder when Android native
      // SpeechRecognizer is active to eliminate Android HAL mic contention.
      isUsingRecorderRef.current = false;
      recorderStarted = false;
    } else {
      try {
        await speechRecorder.start({ mode: "child-passage" });
        if (!isCurrent()) {
          speechRecorder.cancel();
          return false;
        }
        isUsingRecorderRef.current = true;
        recorderStarted = true;
      } catch (error) {
        if (!isCurrent()) return false;
        const message = error instanceof Error ? error.message : "";
        const errorName = error instanceof Error ? error.name : "";
        const isPermissionDenied =
          errorName === "NotAllowedError" ||
          errorName === "PermissionDeniedError" ||
          /permission|denied|từ chối|quyền micro/i.test(message);
        if (!message.toLowerCase().includes("not supported")) {
          if (mountedRef.current) {
            setConnectionState("reconnecting");
            setUiState(isPermissionDenied ? "microphone-denied" : "stt-error");
          }
          return false;
        }
        // Web Speech can still provide final transcript results without MediaRecorder.
        isUsingRecorderRef.current = false;
      }
    }

    isListeningActiveRef.current = true;
    recordingStartedAtRef.current = getRetryCaptureTimeMs();
    let browserRecognitionStarted = false;

    if (typeof window !== "undefined") {
      try {
        const win = window as unknown as WindowWithSpeech & {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        };
        onBeforeExternalMicStartRef.current = () => {
          if (isUsingRecorderRef.current || speechRecorder.isRecording) {
            isUsingRecorderRef.current = false;
            recorderStarted = false;
            speechRecorder.cancel({ retainStream: false });
          }
        };
        const standbyRec = takeSessionStandbyRecognizer(sessionId);
        const SpeechRec = standbyRec
          ? null
          : (resolveLocalFirstSpeechRecognitionConstructor(
              win,
              speechService,
              () => {
                const activePage = pageRef.current;
                const words = activePage?.words ?? [];
                const cursorIdx = resolveWordArrayIndex(
                  words,
                  alignmentEngineRef.current?.getSnapshot(),
                  0,
                );
                const windowStart = Math.max(0, cursorIdx - 12);
                const windowEnd = Math.min(words.length, cursorIdx + 48);
                return {
                  sessionId,
                  pageId: activePage?.page_id ?? null,
                  keyterms: words
                    .slice(windowStart, windowEnd)
                    .map((w) => w.text.normalize("NFC").trim())
                    .filter(Boolean),
                };
              },
              () => speechRecorder.getStream?.()?.getAudioTracks()?.[0],
              {
                onBeforeExternalMicStart: () =>
                  onBeforeExternalMicStartRef.current?.(),
              },
            ) as (new () => BrowserSpeechRecognition) | undefined);
        if (standbyRec || SpeechRec) {
          const rec = standbyRec ?? new SpeechRec!();
          const isLocalSegmentRec =
            rec instanceof LocalSegmentSpeechRecognition;
          if (!isLocalSegmentRec) {
            recordSttEngineUsage({
              provider: "browser",
              fallbackUsed: true,
              fallbackReason: "BROWSER_SPEECH_RECOGNITION",
            });
          }
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = "vi-VN";
          rec.maxAlternatives = 1;
          const recEpoch = isLocalSegmentRec
            ? rec.getEpoch() + 1
            : ++activeListeningEpochRef.current;
          const activeScope: CaptureScope | null = capturePage
            ? {
                sessionId,
                pageId: capturePage.page_id,
                revisionId: capturePage.page_revision_id,
                runId: runtime.getState().runId,
              }
            : null;
          captureScopeRef.current = activeScope;
          let lastAcceptedSeq = -1;
          const isFencedResult = (meta?: SegmentResultMeta): boolean => {
            if (
              activeScope &&
              captureScopeRef.current &&
              !sameCaptureScope(activeScope, captureScopeRef.current)
            ) {
              return false;
            }
            if (!meta) return true;
            if (
              isLocalSegmentRec &&
              meta.epoch !== undefined &&
              meta.epoch !== rec.getEpoch()
            ) {
              return false;
            }
            if (
              !isLocalSegmentRec &&
              meta.epoch !== undefined &&
              meta.epoch !== recEpoch
            ) {
              return false;
            }
            if (
              meta.sessionId !== undefined &&
              meta.sessionId !== null &&
              meta.sessionId !== sessionId
            ) {
              return false;
            }
            if (
              meta.pageId !== undefined &&
              meta.pageId !== null &&
              capturePage &&
              meta.pageId !== capturePage.page_id
            ) {
              return false;
            }
            return true;
          };

          rec.onresult = (event: BrowserSpeechEvent) => {
            if (
              assistantAudioPlayingRef.current ||
              passageContainsHelpRef.current ||
              !mountedRef.current ||
              alignmentEngineRef.current !== captureEngine ||
              recognitionRef.current !== rec ||
              retryModeRef.current ||
              uiStateRef.current !== "reading"
            ) {
              return;
            }
            const audioQuality = speechRecorder.getQuality?.();
            if (
              audioQuality &&
              audioQuality.durationMs >= 300 &&
              audioQuality.status === "INVALID_AUDIO"
            ) {
              markCaptureUncertain(captureEngine, capturePage);
              setLatestTranscript(
                adaptPersona(
                  "Cô chưa nghe rõ tiếng vừa rồi, con đọc lại rõ hơn một chút nhé.",
                ),
              );
              return;
            }
            const engine = alignmentEngineRef.current;
            if (!engine || !mountedRef.current) return;
            const rt = ensureAutomationRuntime();
            const activeRunId = rt.getState().runId;
            rt.dispatch({ type: "SPEECH_ACTIVITY", runId: activeRunId });
            const isPhonicsCueUsable = (
              rawText: string,
              confidence?: number,
            ): boolean => {
              if (!hasUsablePhonicsBrowserConfidence(confidence)) return false;
              const activeReinforce =
                sentenceReinforcementRef.current.getActive();
              if (activeReinforce) {
                let nextIdx = 0;
                while (
                  nextIdx < activeReinforce.span.words.length &&
                  activeReinforce.matchedIndices.has(nextIdx)
                ) {
                  nextIdx += 1;
                }
                const reinforceTarget =
                  activeReinforce.span.words[nextIdx]?.text;
                return Boolean(
                  reinforceTarget &&
                  isLikelyPhonicsCueForWord(
                    rawText,
                    reinforceTarget,
                    sentenceReinforcementRef.current.getBufferedSpellingTokens(),
                  ),
                );
              }
              const targetId = engine.getSnapshot().currentWordId;
              const targetWord = (pageRef.current ?? capturePage)?.words.find(
                (w) => w.word_id === targetId,
              )?.text;
              return Boolean(
                targetWord &&
                isLikelyPhonicsCueForWord(
                  rawText,
                  targetWord,
                  engine.getBufferedSpellingTokens(),
                ),
              );
            };
            const newFinals = browserTranscriptCollectorRef.current.addResults(
              event,
              (part, usable, confidence, meta) => {
                if (!isFencedResult(meta)) {
                  return false;
                }
                const immediateWindowWords = (() => {
                  const activePage = pageRef.current ?? capturePage;
                  if (!activePage) return [] as string[];
                  const curId = engine.getSnapshot().currentWordId;
                  const curIdx = activePage.words.findIndex(
                    (w) => w.word_id === curId,
                  );
                  const startIdx = Math.max(0, curIdx >= 0 ? curIdx - 1 : 0);
                  return activePage.words
                    .slice(startIdx, startIdx + 6)
                    .map((w) => w.text);
                })();
                const isWindowQualityMatch =
                  (meta?.audioQuality?.status === "LOW_VOLUME" ||
                    meta?.audioQuality?.status === "CLIPPING" ||
                    meta?.audioQuality?.status === "AUDIO_TOO_SHORT") &&
                  Boolean(part.trim()) &&
                  hasUsableChildWindowBrowserConfidence(
                    part,
                    immediateWindowWords,
                    0.9,
                  );
                if (
                  meta?.audioQuality &&
                  !isWindowQualityMatch &&
                  (meta.audioQuality.status === "LOW_VOLUME" ||
                    meta.audioQuality.status === "CLIPPING" ||
                    meta.audioQuality.status === "AUDIO_TOO_SHORT")
                ) {
                  markCaptureUncertain(engine, capturePage);
                  rt.dispatch({ type: "UNSURE_POSITION", runId: activeRunId });
                  setLatestTranscript(
                    adaptPersona(
                      "Cô chưa nghe rõ tiếng vừa rồi, con đọc lại rõ hơn một chút nhé.",
                    ),
                  );
                  return false;
                }
                if (
                  passageContainsHelpRef.current ||
                  passageContainsSpellRef.current
                ) {
                  return false;
                }
                if (
                  !usable &&
                  !isPhonicsCueUsable(part, confidence) &&
                  !hasUsableChildWindowBrowserConfidence(
                    part,
                    immediateWindowWords,
                    confidence,
                  )
                ) {
                  markCaptureUncertain(engine, capturePage);
                  rt.dispatch({ type: "UNSURE_POSITION", runId: activeRunId });
                  return false;
                }
                // Benchmark/Production parity (ReadingEvidencePipeline):
                // drop implausibly fast STT bursts and out-of-order segment indices.
                const spokenTokenCount = tokenizeRealtimeText(part).length;
                if (
                  isImplausibleSpeechSpeed(
                    spokenTokenCount,
                    meta?.speechDurationMs,
                  )
                ) {
                  markCaptureUncertain(engine, capturePage);
                  rt.dispatch({ type: "UNSURE_POSITION", runId: activeRunId });
                  return false;
                }
                const segSeqMatch = meta?.segmentId?.match(/_(\d+)$/);
                const seqNum = segSeqMatch
                  ? Number.parseInt(segSeqMatch[1], 10)
                  : undefined;
                if (
                  seqNum !== undefined &&
                  Number.isFinite(seqNum) &&
                  seqNum < lastAcceptedSeq
                ) {
                  return false;
                }
                // Our own voice (including the echo after a sample ended) is
                // never the child's reading, nor a command. Forward `onsetAt`
                // so a child repeating right after TTS is never dropped as echo.
                if (
                  !echoGuard.evaluate({
                    text: part,
                    receivedAt: performance.now(),
                    onsetAt: meta?.onsetAt ?? null,
                    audioEndedAt: meta?.audioEndedAt ?? null,
                  }).accept
                ) {
                  return false;
                }
                if (seqNum !== undefined && Number.isFinite(seqNum)) {
                  lastAcceptedSeq = seqNum;
                }
                if (disambiguationPendingRef.current && capturePage) {
                  const [candA, candB] =
                    disambiguationPendingRef.current.candidates;
                  const normPart = normalizeVietnameseText(part);
                  const chosen = normPart.includes(
                    normalizeVietnameseText(candA.text),
                  )
                    ? candA
                    : normPart.includes(normalizeVietnameseText(candB.text))
                      ? candB
                      : null;
                  if (chosen) {
                    disambiguationPendingRef.current = null;
                    rt.dispatch({
                      type: "DISAMBIGUATION_RESOLVED",
                      wordId: chosen.word_id,
                    });
                    return false;
                  }
                }
                if (
                  capturePage &&
                  isPassageSpellRequest(part, engine, capturePage)
                ) {
                  passageContainsSpellRef.current = true;
                  if (!isListeningActiveRef.current) engine.markUncertain();
                  return false;
                }
                if (
                  capturePage &&
                  isPassageHelpRequest(part, engine, capturePage)
                ) {
                  const ambiguous = findAmbiguousHelpTargets(
                    part,
                    engine,
                    capturePage,
                  );
                  if (ambiguous) {
                    disambiguationPendingRef.current = {
                      candidates: ambiguous,
                    };
                    rt.dispatch({
                      type: "DISAMBIGUATION_NEEDED",
                      candidates: [ambiguous[0].word_id, ambiguous[1].word_id],
                    });
                    return false;
                  }
                  passageContainsHelpRef.current = true;
                  if (!isListeningActiveRef.current) engine.markUncertain();
                  return false;
                }
                const upcomingStartIdx = capturePage
                  ? resolveWordArrayIndex(
                      capturePage.words,
                      engine.getSnapshot(),
                      capturePage.words.length,
                    )
                  : 0;
                const command = parseVoiceIntent(part, {
                  upcomingText: capturePage
                    ? capturePage.words
                        .slice(upcomingStartIdx, upcomingStartIdx + 12)
                        .map((word) => word.text)
                        .join(" ")
                    : "",
                });
                if (command.type === "STOP") {
                  rt.dispatch({ type: "PAUSE", by: "voice" });
                  void pauseReadingRef.current();
                  return false;
                }
                if (command.type === "WAIT") {
                  rt.dispatch({ type: "WAIT_REQUESTED" });
                  return false;
                }
                if (command.type === "TRY_MORE") {
                  rt.dispatch({ type: "TRY_MORE_REQUESTED" });
                  return false;
                }
                if (command.type === "REPLAY") {
                  void handleReadCurrentWord();
                  return false;
                }
                if (command.type === "RESUME") {
                  if (sentenceReinforcementRef.current.getActive()) {
                    void finishSentenceReinforcement(engine, false);
                  }
                  rt.dispatch({ type: "RESUME" });
                  return false;
                }
                if (command.type === "NEXT_PAGE") {
                  if (!automationRef.current.autoAdvance) {
                    void confirmCurrentPageCompleted();
                  }
                  return false;
                }
                // Sentence-level fluency reinforcement (G20): speech read back
                // for the full sentence (e.g. "Tôi ăn cơm") is evaluated strictly inside
                // SentenceReinforcementTracker — NEVER call engine.addFinalTranscript(part)
                // here so first-pass scores remain immutable and backend compare transcripts
                // stay 100% aligned with first-pass reading!
                if (sentenceReinforcementRef.current.getActive()) {
                  const activeSpan =
                    sentenceReinforcementRef.current.getActive()?.span ?? null;
                  if (isVoiceExitSentenceReinforcement(part)) {
                    void finishSentenceReinforcement(engine, false);
                    return false;
                  }
                  const outcome =
                    sentenceReinforcementRef.current.consumeSpeech(part);
                  setActiveSentenceReinforcement(
                    sentenceReinforcementRef.current.getActive(),
                  );
                  if (outcome === "completed") {
                    void finishSentenceReinforcement(engine, true);
                    return false;
                  }
                  if (
                    outcome === "ignored" &&
                    activeSpan &&
                    pageRef.current &&
                    shouldEscapeToUpcomingWords(
                      part,
                      pageRef.current.words.slice(activeSpan.endIndex + 1),
                    )
                  ) {
                    // Child clearly continued reading the next sentence -> auto-escape & score!
                    sentenceReinforcementRef.current.finishCurrent();
                    setActiveSentenceReinforcement(null);
                    // Fall through to normal alignment below so the child's next sentence is scored immediately
                  } else {
                    return false;
                  }
                }
                if (isLocalSegmentRec) {
                  liveWsTranscriptReceivedRef.current = true;
                }
                if (meta?.words?.length) {
                  const baseOffset = liveWordOffsetSecRef.current;
                  let maxEnd = 0;
                  for (const w of meta.words) {
                    liveWordTimingsRef.current.push({
                      text: w.text,
                      start: Number((baseOffset + w.start).toFixed(3)),
                      end: Number((baseOffset + w.end).toFixed(3)),
                      logprob: null,
                    });
                    if (w.end > maxEnd) maxEnd = w.end;
                  }
                  liveWordOffsetSecRef.current = Number(
                    (baseOffset + maxEnd + 0.1).toFixed(3),
                  );
                }
                const helpedWordBefore =
                  pageHelpWordRef.current?.wordId ?? null;
                if (pageHelpWordRef.current)
                  pageHelpWordRef.current.awaitingAttempt = false;
                const prevSnapshot = engine.getSnapshot();
                const rejectedBefore = prevSnapshot.rejectedSegmentCount ?? 0;
                const correctedBeforeSize =
                  prevSnapshot.correctedWordIds?.size ?? 0;
                const slipBeforeSize =
                  prevSnapshot.selfCorrectedSlipWordIds?.size ?? 0;
                const spelledBeforeSize =
                  prevSnapshot.spelledOutWordIds?.size ?? 0;
                const scored = engine.addFinalTranscript(part, meta?.segmentId);
                applyRealtimeSnapshot(scored);
                if (scored.spellingInProgress) {
                  rt.dispatch({
                    type: "SPEECH_ACTIVITY",
                    runId: activeRunId,
                    holdMs: 15_000,
                  });
                }
                if (capturePage) {
                  const prevIdx = resolveWordArrayIndex(
                    capturePage.words,
                    prevSnapshot,
                    capturePage.words.length,
                  );
                  const nextIdx = resolveWordArrayIndex(
                    capturePage.words,
                    scored,
                    capturePage.words.length,
                  );
                  for (
                    let wi = prevIdx;
                    wi < Math.min(nextIdx, capturePage.words.length);
                    wi += 1
                  ) {
                    const w = capturePage.words[wi];
                    const st = scored.statusByWordId.get(w.word_id)?.status;
                    if (
                      st === "MATCH" ||
                      st === "DELETE" ||
                      st === "SUBSTITUTE"
                    ) {
                      rt.dispatch({
                        type: "WORD_EVIDENCE",
                        runId: activeRunId,
                        pageId: capturePage.page_id,
                        revisionId: capturePage.page_revision_id,
                        wordId: w.word_id,
                        outcome:
                          st === "MATCH"
                            ? "correct"
                            : st === "DELETE"
                              ? "skipped"
                              : "retry",
                      });
                    }
                  }
                }
                if (
                  scored.statusByWordId.get(helpedWordBefore ?? "")?.status ===
                    "MATCH" ||
                  (helpedWordBefore &&
                    scored.currentWordId !== helpedWordBefore)
                ) {
                  pageHelpWordRef.current = null;
                  if (
                    lastTrailingMismatchRef.current?.wordId === helpedWordBefore
                  ) {
                    lastTrailingMismatchRef.current = null;
                  }
                }
                const currentPhonicsLesson = activePhonicsLessonRef.current;
                if (
                  currentPhonicsLesson?.wordId &&
                  scored.statusByWordId.get(currentPhonicsLesson.wordId)
                    ?.status === "MATCH"
                ) {
                  setPhonicsStatusHint(
                    READING_MASTERY_LABELS.CORRECT_AFTER_SPELLING,
                  );
                } else if (
                  currentPhonicsLesson?.plan.supported &&
                  scored.spellingInProgress &&
                  scored.currentWordId === currentPhonicsLesson.wordId
                ) {
                  setPhonicsStatusHint(
                    `Con đánh vần đúng nhịp rồi! Giờ con đọc trọn tiếng “${currentPhonicsLesson.plan.focusSyllable}” nhé!`,
                  );
                }

                // Visual companion celebration for quick self-correction or phonics spelling
                if (
                  (scored.selfCorrectedSlipWordIds?.size ?? 0) > slipBeforeSize
                ) {
                  const slipId = [
                    ...(scored.selfCorrectedSlipWordIds ?? []),
                  ].at(-1);
                  const slipWord =
                    capturePage?.words.find((w) => w.word_id === slipId)
                      ?.text ?? "";
                  if (slipWord && slipId) {
                    selfCorrectedPraiseNotedRef.current.add(slipId);
                    setCompanionBubble({
                      mood: "celebrating",
                      title: t("companion.quickFixTitle"),
                      message: promptSelectorRef.current.next(
                        "celebrateQuickSelfFix",
                        { word: slipWord },
                      ),
                    });
                  }
                } else if (
                  (scored.spelledOutWordIds?.size ?? 0) > spelledBeforeSize
                ) {
                  const spelledId = [...(scored.spelledOutWordIds ?? [])].at(
                    -1,
                  );
                  const spelledWord =
                    capturePage?.words.find((w) => w.word_id === spelledId)
                      ?.text ?? "";
                  if (spelledWord) {
                    setCompanionBubble({
                      mood: "celebrating",
                      title: t("companion.phonicsWinTitle"),
                      message: promptSelectorRef.current.next(
                        "spelledOutPraise",
                        { word: spelledWord },
                      ),
                    });
                  }
                }

                // After fixing a helped word, invite full-sentence reinforcement (G20).
                // On self-correction ("bàn… bạn") without needing help, NEVER stop mic
                // or interrupt with announceSentenceReinforcement — praise concisely!
                const resolvedWordId =
                  helpedWordBefore &&
                  scored.statusByWordId.get(helpedWordBefore)?.status ===
                    "MATCH"
                    ? helpedWordBefore
                    : (scored.correctedWordIds?.size ?? 0) > correctedBeforeSize
                      ? ([...(scored.correctedWordIds ?? [])].at(-1) ?? null)
                      : null;
                if (resolvedWordId && capturePage) {
                  const fixedWordText =
                    capturePage.words.find((w) => w.word_id === resolvedWordId)
                      ?.text ?? "";
                  const wasHelpedWord =
                    helpedWordIdsRef.current.has(resolvedWordId);
                  if (wasHelpedWord) {
                    const overcomeMessage = fixedWordText
                      ? promptSelectorRef.current.next(
                          "celebrateOvercameWord",
                          { word: fixedWordText },
                        )
                      : null;
                    if (overcomeMessage) {
                      setCompanionBubble({
                        mood: "celebrating",
                        title: t("companion.overcameWordTitle"),
                        message: overcomeMessage,
                      });
                    }
                    const reinforced = maybeArmSentenceReinforcement(
                      capturePage,
                      resolvedWordId,
                      "fixed",
                    );
                    if (reinforced && isCurrent()) {
                      void announceSentenceReinforcement(reinforced, engine);
                    }
                  } else if (
                    fixedWordText &&
                    !selfCorrectedPraiseNotedRef.current.has(resolvedWordId)
                  ) {
                    selfCorrectedPraiseNotedRef.current.add(resolvedWordId);
                    setCompanionBubble({
                      mood: "celebrating",
                      title: t("companion.quickFixTitle"),
                      message: promptSelectorRef.current.next(
                        "celebrateQuickSelfFix",
                        { word: fixedWordText },
                      ),
                    });
                  }
                }
                // Speech that does not follow the book (TV, another speaker)
                // is neither scored nor kept in the page transcript.
                return (scored.rejectedSegmentCount ?? 0) === rejectedBefore;
              },
            );
            if (passageContainsSpellRef.current) {
              const activePage = pageRef.current ?? capturePage;
              if (activePage && isCurrent())
                void offerExplicitPhonicsHelp(engine, activePage);
              return;
            }
            if (passageContainsHelpRef.current) {
              const activePage = pageRef.current ?? capturePage;
              if (activePage && isCurrent())
                void offerPassageHelp(engine, activePage);
              return;
            }
            let interimText = "";
            const latestFinalText = newFinals.join(" ");
            if (latestFinalText.trim()) {
              sttNetworkErrorStreakRef.current = 0;
              lastSttTechnicalErrorCodeRef.current = null;
            }

            // 2. Lấy toàn bộ INTERIM hiện tại (kiểm tra fence, chất lượng âm & EchoGuard trước khi preview).
            for (let index = 0; index < event.results.length; index += 1) {
              const result = event.results[index] as
                | (BrowserSpeechEvent["results"][number] & SegmentResultMeta)
                | undefined;

              if (!result || result.isFinal) continue;
              if (!isFencedResult(result)) continue;
              const rawInterim = result[0]?.transcript?.trim() || "";
              const interimQualityBad = Boolean(
                result.audioQuality &&
                (result.audioQuality.status === "LOW_VOLUME" ||
                  result.audioQuality.status === "CLIPPING" ||
                  result.audioQuality.status === "AUDIO_TOO_SHORT"),
              );
              if (interimQualityBad) {
                const activePage = pageRef.current ?? capturePage;
                const curId = engine.getSnapshot().currentWordId;
                const curIdx = activePage
                  ? activePage.words.findIndex((w) => w.word_id === curId)
                  : -1;
                const previewWindowWords = activePage
                  ? activePage.words
                      .slice(
                        Math.max(0, curIdx >= 0 ? curIdx - 1 : 0),
                        Math.max(0, curIdx >= 0 ? curIdx - 1 : 0) + 6,
                      )
                      .map((w) => w.text)
                  : [];
                const interimMatchesWindow =
                  Boolean(rawInterim) &&
                  hasUsableChildWindowBrowserConfidence(
                    rawInterim,
                    previewWindowWords,
                    0.9,
                  );
                if (!interimMatchesWindow) {
                  continue;
                }
              }
              if (
                rawInterim &&
                !echoGuard.evaluate({
                  text: rawInterim,
                  receivedAt: performance.now(),
                  onsetAt: result.onsetAt ?? null,
                  audioEndedAt: result.audioEndedAt ?? null,
                }).accept
              ) {
                continue;
              }
              const conf = result[0]?.confidence;
              const part =
                rawInterim &&
                (hasUsableBrowserConfidence(conf) ||
                  isPhonicsCueUsable(rawInterim, conf) ||
                  hasUsableChildWindowBrowserConfidence(
                    rawInterim,
                    (() => {
                      const activePage = pageRef.current ?? capturePage;
                      if (!activePage) return [];
                      const curId = engine.getSnapshot().currentWordId;
                      const curIdx = activePage.words.findIndex(
                        (w) => w.word_id === curId,
                      );
                      const startIdx = Math.max(
                        0,
                        curIdx >= 0 ? curIdx - 1 : 0,
                      );
                      return activePage.words
                        .slice(startIdx, startIdx + 6)
                        .map((w) => w.text);
                    })(),
                    conf,
                  ))
                  ? rawInterim
                  : "";

              if (part) {
                sttNetworkErrorStreakRef.current = 0;
                interimText += (interimText ? " " : "") + part;
              }
            }

            if (interimText.trim()) {
              const preview = engine.previewAlignment(interimText);

              applyPreviewSnapshot(preview);
            } else {
              setPreviewSnapshot(null);
              if (alignmentEngineRef.current === engine) {
                setCurrentWordId(engine.getSnapshot().currentWordId);
              }
            }

            // 3b. Giao cho ReadingAutomationRuntime theo dõi lỗi chưa tự sửa (G27):
            const trailingMismatch = engine.getTrailingMismatch();
            lastTrailingMismatchRef.current = trailingMismatch;
            const trimmedInterim = interimText.trim();
            if (
              trailingMismatch &&
              !trimmedInterim &&
              !engine.getSnapshot().spellingInProgress &&
              sentenceReinforcementRef.current.getActive() === null &&
              capturePage &&
              automationRef.current.assist &&
              trailingMismatch.seq > lastCoachedMismatchSeqRef.current
            ) {
              lastCoachedMismatchSeqRef.current = trailingMismatch.seq;
              rt.dispatch({
                type: "WORD_EVIDENCE",
                runId: activeRunId,
                pageId: capturePage.page_id,
                revisionId: capturePage.page_revision_id,
                wordId: trailingMismatch.wordId,
                outcome: "retry",
              });
            }

            // 4. Cập nhật nội dung transcript (tránh setState lặp khi interim giống hệt,
            // và không bao giờ nối final đè sau interim chưa chốt của cùng một câu).
            if (!mountedRef.current) return;

            const committedTranscript = browserTranscriptCollectorRef.current
              .getTranscript()
              .trim();
            if (trimmedInterim) {
              const liveDisplay = [committedTranscript, trimmedInterim]
                .filter(Boolean)
                .join(" ");
              if (lastPreviewTranscriptRef.current !== liveDisplay) {
                lastPreviewTranscriptRef.current = liveDisplay;
                setLatestTranscript(liveDisplay);
              }
            } else if (latestFinalText.trim()) {
              lastPreviewTranscriptRef.current = null;
              setLatestTranscript(
                committedTranscript || latestFinalText.trim(),
              );
            }

            if (
              latestFinalText.trim() &&
              !trimmedInterim &&
              !sentenceReinforcementRef.current.getActive()
            ) {
              void autoCompletePageAfterFinalWordRef.current(
                engine.getSnapshot(),
              );
            }
          };

          rec.onerror = (event: BrowserSpeechErrorEvent) => {
            if (!mountedRef.current || recognitionRef.current !== rec) return;
            // Chrome often emits `aborted` when stopping recognition to play
            // an assistant sample. This is an expected handoff, not an STT
            // failure, and must not trigger a restart/error state.
            if (
              event.error === "aborted" ||
              event.error === "no-speech" ||
              assistantAudioPendingRef.current ||
              assistantAudioPlayingRef.current
            ) {
              return;
            }

            console.error(
              `[REALTIME STT ERROR] error=${String(event.error ?? "unknown")} recorderStarted=${String(recorderStarted)} browserRecognitionStarted=${String(browserRecognitionStarted)} isListeningActive=${String(isListeningActiveRef.current)}`,
            );

            if (event.error === "local-stt-unavailable") {
              lastSttTechnicalErrorCodeRef.current = "LOCAL_STT_UNAVAILABLE";
              recognitionRef.current = null;
              isListeningActiveRef.current = false;
              isUsingRecorderRef.current = false;
              speechRecorder.cancel();
              setIsMicRecording(false);
              setUiState("stt-error");
              setComparisonError(
                "Hệ thống nghe giọng đọc đang khởi động hoặc tạm chưa sẵn sàng. Ba mẹ vui lòng đợi ít giây rồi thử lại nhé.",
              );
              setLatestTranscript(
                "Hệ thống nghe giọng đọc tạm thời chưa sẵn sàng. Bé chờ một lát rồi đọc lại nhé.",
              );
              return;
            }

            if (event.error === "network") {
              sttNetworkErrorStreakRef.current += 1;
              lastSttTechnicalErrorCodeRef.current = "STT_NETWORK_ERROR";
              if (sttNetworkErrorStreakRef.current >= 3) {
                recognitionRef.current = null;
                setComparisonError(
                  "Mất kết nối tới hệ thống nghe giọng đọc. Bé kiểm tra lại mạng rồi bấm Thử lại nhé.",
                );
                isListeningActiveRef.current = false;
                isUsingRecorderRef.current = false;
                speechRecorder.cancel();
                setIsMicRecording(false);
                setUiState("stt-error");
              }
              return;
            }

            if (event.error === "stt-unavailable") {
              isListeningActiveRef.current = false;
              isUsingRecorderRef.current = false;
              recognitionRef.current = null;
              speechRecorder.cancel();
              setIsMicRecording(false);
              setUiState("stt-error");
              setLatestTranscript(
                adaptPersona(
                  "Nhận diện giọng nói đang tạm bận. Bé bấm Thử lại để tiếp tục nhé.",
                ),
              );
            } else if (
              event.error === "not-allowed" ||
              (!recorderStarted &&
                (event.error === "service-not-allowed" ||
                  event.error === "language-not-supported"))
            ) {
              automationRuntimeRef.current?.dispatch({
                type: "PERMISSION",
                granted: false,
              });
              isListeningActiveRef.current = false;
              isUsingRecorderRef.current = false;
              speechRecorder.cancel();
              setIsMicRecording(false);
              setUiState(
                event.error === "language-not-supported"
                  ? "stt-error"
                  : "microphone-denied",
              );
            } else if (
              event.error === "service-not-allowed" ||
              event.error === "language-not-supported"
            ) {
              // Keep MediaRecorder available without restarting a denied recognizer.
              recognitionRef.current = null;
            }
          };

          rec.onend = () => {
            if (recognitionRef.current !== rec) return;
            browserTranscriptCollectorRef.current.completeRecognitionCycle();

            if (
              mountedRef.current &&
              isListeningActiveRef.current &&
              sttNetworkErrorStreakRef.current < 6
            ) {
              const baseDelayMs = isAndroidNativeSpeechAvailable() ? 250 : 80;
              const restartDelayMs =
                sttNetworkErrorStreakRef.current > 0
                  ? Math.min(
                      3_000,
                      400 * 2 ** (sttNetworkErrorStreakRef.current - 1),
                    )
                  : baseDelayMs;
              if (sttRestartTimerRef.current !== null) {
                window.clearTimeout(sttRestartTimerRef.current);
              }
              sttRestartTimerRef.current = window.setTimeout(() => {
                sttRestartTimerRef.current = null;
                if (
                  isCurrent() &&
                  isListeningActiveRef.current &&
                  recognitionRef.current === rec &&
                  sttNetworkErrorStreakRef.current < 6
                ) {
                  try {
                    rec.start();
                  } catch {
                    // Previously collected final speech remains available.
                  }
                }
              }, restartDelayMs);
              return;
            }

            const resolveStop = browserStopResolveRef.current;
            if (resolveStop) resolveStop();
          };

          sttNetworkErrorStreakRef.current = 0;
          lastSttTechnicalErrorCodeRef.current = null;
          try {
            rec.start();
            recognitionRef.current = rec;
            browserRecognitionStarted = true;
            if (isLocalSegmentRec) {
              await rec.whenAudioGraphReady(800);
              if (!isCurrent()) {
                if (recognitionRef.current === rec) {
                  recognitionRef.current = null;
                }
                try {
                  rec.abort();
                } catch {
                  // Ignore cleanup error
                }
                return false;
              }
            }
          } catch {
            // MediaRecorder remains the primary source when available.
          }
        }
      } catch (error) {
        console.warn("SpeechRecognition initialization skipped:", error);
      }
    }

    if (!recorderStarted && !browserRecognitionStarted) {
      isListeningActiveRef.current = false;
      if (mountedRef.current) {
        automationRuntimeRef.current?.dispatch({
          type: "RECOVER_START",
        });
        setConnectionState("reconnecting");
        setUiState("stt-error");
      }
      return false;
    }

    runtime.dispatch({
      type: "LISTEN_RESULT",
      runId: runtime.getState().runId,
      ok: true,
    });
    return true;
  }

  async function stopBrowserRecognition(
    options: { nonBlockingDrain?: boolean } = {},
  ): Promise<void> {
    if (sttRestartTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(sttRestartTimerRef.current);
      sttRestartTimerRef.current = null;
    }
    try {
      cancelSessionStandbyRecognizer(sessionId);
    } catch {
      // Ignore standby cancel errors
    }
    const recognition = recognitionRef.current;
    if (!recognition) {
      browserTranscriptCollectorRef.current.completeRecognitionCycle();
      return;
    }

    isListeningActiveRef.current = false;
    // During interactive TTS handoff (tap word / read sample / preview),
    // LocalSegmentSpeechRecognition.stop() synchronously releases mic hardware
    // while draining in-flight network/WASM uploads asynchronously — never
    // stall TTS start up to 4.5s waiting for STT uploads to finish.
    if (
      options.nonBlockingDrain &&
      recognition instanceof LocalSegmentSpeechRecognition
    ) {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
      try {
        recognition.stop();
      } catch {
        // Ignore stop errors
      }
      browserTranscriptCollectorRef.current.completeRecognitionCycle();
      return;
    }
    // Allow LocalSegmentSpeechRecognition full WS flush/drain budget (3500-4000ms)
    // instead of prematurely cutting off the trailing sentence at 1500ms.
    const stopTimeoutMs =
      recognition instanceof LocalSegmentSpeechRecognition ? 4_500 : 1_500;

    await new Promise<void>((resolve) => {
      let settled = false;
      let fallbackTimer: number | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (fallbackTimer !== null) {
          window.clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        browserStopResolveRef.current = null;
        resolve();
      };

      browserStopResolveRef.current = finish;
      try {
        recognition.stop();
      } catch {
        browserTranscriptCollectorRef.current.completeRecognitionCycle();
        finish();
      }

      // Do not block session completion if a browser fails to dispatch onend.
      fallbackTimer = window.setTimeout(() => {
        if (settled) return;
        browserTranscriptCollectorRef.current.completeRecognitionCycle();
        finish();
      }, stopTimeoutMs);
    });

    if (recognitionRef.current === recognition) {
      recognitionRef.current = null;
    }
  }

  useEffect(() => {
    startListeningRef.current = startListening;
  });

  async function transcribeRecording(
    recording: Blob,
    timeoutMs: number,
  ): Promise<{ text: string; words: readonly WordTimestamp[] | null } | null> {
    transcriptionAbortRef.current?.abort();

    const controller = new AbortController();
    transcriptionAbortRef.current = controller;

    try {
      // Supply safe contextual keyterms from the current page to improve
      // recognition of short Grade-1 Vietnamese syllables & tone marks (G22),
      // while keeping all off-topic / wrong-language / low-confidence guards.
      const pageKeyterms = Array.from(
        new Set(
          (page?.words ?? [])
            .map((word) => word.text.normalize("NFC").trim())
            .filter(Boolean),
        ),
      ).slice(0, 40);
      const transcript = await speechService.transcribe(recording, {
        languageCode: "vi",
        ...(pageKeyterms.length ? { keyterms: pageKeyterms } : {}),
        signal: controller.signal,
        timeoutMs,
      });

      if (!mountedRef.current || controller.signal.aborted) return null;

      const text = transcript.text?.trim() ?? "";
      if (
        !text ||
        !hasUsableTranscript(transcript, speechRecorder.getQuality?.())
      )
        return null;

      return {
        text,
        words: transcript.words?.length ? transcript.words : null,
      };
    } catch (error) {
      if (!controller.signal.aborted) {
        if (isServiceError(error)) {
          if (isSttFallbackEligibleError(error)) {
            lastSttTechnicalErrorCodeRef.current = error.code;
          }
          console.warn("[STT SERVICE DIAGNOSTIC]", {
            code: error.code,
            status: error.status,
            request_id: error.request_id,
            retryable: error.retryable,
          });
        } else {
          console.error("Lỗi chuyển ghi âm thành văn bản:", error);
        }
      }
      return null;
    } finally {
      if (transcriptionAbortRef.current === controller) {
        transcriptionAbortRef.current = null;
      }
    }
  }

  async function stopListeningAndTranscribe(
    options: {
      finishAlignment?: boolean;
      preserveAlignment?: boolean;
      forPassageHelp?: boolean;
      skipBlockingUpload?: boolean;
      nonBlockingDrain?: boolean;
    } = {},
  ): Promise<string> {
    if (listeningStopRef.current) return listeningStopRef.current;
    const pending = finishListening(options);
    listeningStopRef.current = pending;
    try {
      return await pending;
    } finally {
      if (listeningStopRef.current === pending) listeningStopRef.current = null;
    }
  }

  async function finishListening(options: {
    finishAlignment?: boolean;
    preserveAlignment?: boolean;
    forPassageHelp?: boolean;
    skipBlockingUpload?: boolean;
    nonBlockingDrain?: boolean;
  }): Promise<string> {
    // Snapshot the page before waiting for asynchronous recorder/provider work.
    const targetPage = pageRef.current ?? page;
    const targetEngine = alignmentEngineRef.current;
    isListeningActiveRef.current = false;
    setPreviewSnapshot(null);

    await stopBrowserRecognition({
      nonBlockingDrain: Boolean(
        options.nonBlockingDrain ?? options.skipBlockingUpload,
      ),
    });

    let recording: Blob | null = null;
    if (isUsingRecorderRef.current || speechRecorder.isRecording) {
      try {
        recording = await speechRecorder.stop();
      } catch (error) {
        speechRecorder.cancel();
        console.error("Lỗi khi dừng ghi âm:", error);
      } finally {
        isUsingRecorderRef.current = false;
      }
    }

    // This text already passed the browser evidence checks and was aligned
    // live. A subsequent recorder failure cannot invalidate it.
    const browserText = browserTranscriptCollectorRef.current
      .getTranscript()
      .trim();
    const handoff = options.preserveAlignment || options.forPassageHelp;

    const sttStatus = getVoiceEngineStatus().stt;
    const freshSttHealth = getVoiceEngineHealthForRouting();
    const sttPolicy = getVoicePolicyPreferences();
    const sttCloudAllowed =
      sttPolicy.providerMode === "local_with_google_fallback" &&
      sttPolicy.allowGoogleSttFallback;
    const elevenLabsSttUsable = Boolean(
      sttCloudAllowed &&
      freshSttHealth?.elevenlabs?.stt_configured &&
      !freshSttHealth?.elevenlabs?.stt_cooldown,
    );
    const googleSttUsable = Boolean(
      sttCloudAllowed &&
      freshSttHealth?.google.stt_configured &&
      !freshSttHealth.google.stt_cooldown,
    );
    const backendSttUnavailable =
      (isPermanentlyHostedLocalUnconfigured(freshSttHealth) &&
        !elevenLabsSttUsable &&
        !googleSttUsable) ||
      (freshSttHealth !== null &&
        (!freshSttHealth.local.available || !freshSttHealth.local.stt_ready) &&
        !elevenLabsSttUsable &&
        !googleSttUsable);
    const alreadyUsingEmergencyBrowserStt =
      sttStatus.tier === "android_native" ||
      sttStatus.tier === "browser_wasm" ||
      (sttStatus.tier === "browser_default" &&
        sttStatus.fallbackReason === "LOCAL_STT_UNAVAILABLE");
    const collectedLiveWords = liveWordTimingsRef.current.length
      ? [...liveWordTimingsRef.current]
      : null;
    const hasSufficientLiveWsData =
      Boolean(browserText) &&
      (liveWsTranscriptReceivedRef.current || Boolean(collectedLiveWords));
    const captureStartedAt = recordingStartedAtRef.current;
    recordingStartedAtRef.current = null;

    const shouldUploadRecording = Boolean(
      !passageContainsHelpRef.current &&
      !(handoff && browserText) &&
      !alreadyUsingEmergencyBrowserStt &&
      !backendSttUnavailable &&
      !hasSufficientLiveWsData &&
      recording &&
      recording.size > 0 &&
      !hasUnusableAudio(speechRecorder.getQuality?.()),
    );

    const applyFinishedResult = (
      elevenLabsResult: {
        text: string;
        words: readonly WordTimestamp[] | null;
      } | null,
    ): string => {
      if (
        !mountedRef.current ||
        (targetPage && pageRef.current?.page_id !== targetPage.page_id)
      ) {
        return "";
      }
      let filteredResult = elevenLabsResult;
      if (
        !browserText &&
        filteredResult &&
        !echoGuard.evaluate({
          text: filteredResult.text,
          receivedAt: captureStartedAt ?? getRetryCaptureTimeMs(),
        }).accept
      ) {
        filteredResult = null;
      }
      if (
        !browserText &&
        filteredResult &&
        targetPage &&
        targetEngine &&
        isPassageHelpRequest(filteredResult.text, targetEngine, targetPage)
      ) {
        passageContainsHelpRef.current = true;
        if (!options.forPassageHelp) targetEngine.markUncertain();
        filteredResult = null;
      }

      // Preserve the final source already consumed by live alignment. A later
      // provider result must not give reports a different first-pass assessment.
      const resolvedText = resolveTranscriptForSegment(
        filteredResult?.text,
        browserText,
      );
      if (!mountedRef.current) return "";
      if (
        !resolvedText &&
        !passageContainsHelpRef.current &&
        !options.forPassageHelp
      ) {
        markCaptureUncertain(targetEngine, targetPage);
        const sttErrCode = lastSttTechnicalErrorCodeRef.current;
        if (sttErrCode) {
          setComparisonError(
            "Bộ nhận diện giọng nói trên máy hiện chưa sẵn sàng. Ba mẹ bật Local Voice Worker (hoặc bật Dự phòng Online trong Cài đặt giọng) rồi thử lại nhé; kết quả của bé không bị tính sai.",
          );
        } else {
          setComparisonError(t("session.uncertainSpeechRetained"));
        }
      }
      if (
        resolvedText &&
        !browserText &&
        targetEngine &&
        targetEngine.isOffTopicText(resolvedText)
      ) {
        // Provider text that does not follow the book is not the child reading.
        markCaptureUncertain(targetEngine, targetPage);
        if (!options.preserveAlignment) {
          setLatestTranscript(resolvedText);
          setComparisonError(null);
        }
      } else if (resolvedText && targetPage) {
        const timings = timingsForTranscript(
          resolvedText,
          filteredResult?.words ?? collectedLiveWords,
        );
        liveWordTimingsRef.current = [];
        liveWordOffsetSecRef.current = 0;
        liveWsTranscriptReceivedRef.current = false;
        recordSpokenText(resolvedText, targetPage, timings);

        if (targetEngine && alignmentEngineRef.current === targetEngine) {
          let snapshot = targetEngine.getSnapshot();
          if (!browserText) {
            if (pageHelpWordRef.current)
              pageHelpWordRef.current.awaitingAttempt = false;
            snapshot = targetEngine.addFinalTranscript(resolvedText);
          }
          if (!options.preserveAlignment && options.finishAlignment !== false) {
            snapshot = finishPassageAlignment(targetEngine);
          }
          if (timings.length) {
            snapshot = targetEngine.addHesitations(
              timings,
              snapshot.spokenWords.length - timings.length,
            );
          }
          if (
            !options.preserveAlignment ||
            !browserText ||
            timings.length > 0
          ) {
            applyRealtimeSnapshot(snapshot);
          }
          if (!options.preserveAlignment) {
            setLatestTranscript(resolvedText);
            setComparisonError(null);
          }
        }
      }

      return resolvedText ?? "";
    };

    if (options.skipBlockingUpload) {
      // Interactive TTS handoff (tap word / read sample / preview): mic &
      // recorder are already stopped immediately above; run any pending STT
      // reconciliation in the background (page-fenced) so TTS playback starts
      // right away instead of blocking 4-10s on STT HTTP upload.
      if (shouldUploadRecording && recording) {
        void transcribeRecording(recording, 4_000).then((res) => {
          applyFinishedResult(res);
        });
        return browserText;
      }
      return applyFinishedResult(null);
    }

    let elevenLabsResult: {
      text: string;
      words: readonly WordTimestamp[] | null;
    } | null = null;
    if (shouldUploadRecording && recording) {
      elevenLabsResult = await transcribeRecording(
        recording,
        handoff ? 4_000 : 10_000,
      );
    }
    return applyFinishedResult(elevenLabsResult);
  }

  async function playAssistantAudio(
    play: () => Promise<void>,
    resumeForPractice = false,
    resumeAfterPlayback = true,
    alignBeforePassageHelp = false,
  ): Promise<void> {
    retryPlayback.stop();
    const wasListening =
      isMicRecording ||
      isListeningActiveRef.current ||
      isUsingRecorderRef.current ||
      speechRecorder.isRecording ||
      retryRecorderActiveRef.current ||
      countdown !== null;
    assistantAudioResumeRequestedRef.current ||=
      wasListening || resumeForPractice;
    assistantAudioPendingRef.current = true;
    assistantTurnSpokenRef.current = [];
    listeningGenerationRef.current += 1;
    const generation = ++assistantAudioGenerationRef.current;
    setCountdown(null);
    cancelSessionStandbyRecognizer(sessionId);
    setPreviewSnapshot(null);
    let playbackFailed = false;
    let playAborted = false;
    try {
      if (retryModeRef.current) {
        // Retry mode has its own capture lifecycle. Cancel that capture without
        // transcribing it, and release MediaStream tracks before TTS playback so
        // Android restores loudspeaker USAGE_MEDIA instead of MODE_IN_COMMUNICATION.
        retryListeningWantedRef.current = false;
        retryShouldRestartRef.current = false;
        isListeningActiveRef.current = false;
        clearRetryCaptureTimeout();
        retryRecorderActiveRef.current = false;
        isUsingRecorderRef.current = false;
        speechRecorder.cancel({ retainStream: false });
        await stopBrowserRecognition();
        if (mountedRef.current) setIsMicRecording(false);
      } else if (
        isMicRecording ||
        isListeningActiveRef.current ||
        isUsingRecorderRef.current ||
        speechRecorder.isRecording
      ) {
        let stopTimedOut = false;
        let stopTimeoutId: number | null = null;
        try {
          setPreviewSnapshot(null);
          await Promise.race([
            stopListeningAndTranscribe({
              finishAlignment: false,
              preserveAlignment: !alignBeforePassageHelp,
              forPassageHelp: alignBeforePassageHelp,
              nonBlockingDrain: !alignBeforePassageHelp,
            }),
            new Promise<void>((resolve) => {
              stopTimeoutId = window.setTimeout(() => {
                stopTimedOut = true;
                resolve();
              }, 1_500);
            }),
          ]);
        } catch {
          speechRecorder.cancel({ retainStream: false });
        } finally {
          if (stopTimeoutId !== null) {
            window.clearTimeout(stopTimeoutId);
          }
          if (stopTimedOut) {
            isListeningActiveRef.current = false;
            isUsingRecorderRef.current = false;
            speechRecorder.cancel({ retainStream: false });
          }
          if (mountedRef.current) setIsMicRecording(false);
        }
      } else {
        // A recognition instance can outlive a stale UI/ref state. Always
        // stop it and release any permission-preflight stream before playback,
        // even when the recorder looks idle.
        speechRecorder.cancel({ retainStream: false });
        isUsingRecorderRef.current = false;
        await stopBrowserRecognition({
          nonBlockingDrain: !alignBeforePassageHelp,
        });
      }

      if (
        !mountedRef.current ||
        generation !== assistantAudioGenerationRef.current
      ) {
        return;
      }

      // Ensure session lock exists if playback starts before mount /voice/status finishes.
      if (getActiveSessionVoiceLock()?.sessionId !== sessionId) {
        lockSessionVoice(sessionId);
      }

      assistantAudioPlayingRef.current = true;
      await play();
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      playAborted = aborted;
      playbackFailed = !aborted;
      throw error;
    } finally {
      if (generation === assistantAudioGenerationRef.current) {
        assistantAudioPlayingRef.current = false;
        assistantAudioPendingRef.current = false;

        if (playbackFailed) {
          assistantAudioResumeRequestedRef.current = false;
          retryResumeAfterAssistantAudioRef.current = null;
          pendingSentenceReinforcementRef.current = null;
          tutorResumeMicAfterPlaybackRef.current = false;
        } else {
          if (!playAborted) {
            const queuedReinforce = pendingSentenceReinforcementRef.current;
            pendingSentenceReinforcementRef.current = null;
            if (
              queuedReinforce &&
              mountedRef.current &&
              !retryModeRef.current &&
              sentenceReinforcementRef.current.getActive()
            ) {
              void announceSentenceReinforcement(
                queuedReinforce.active,
                queuedReinforce.engine,
              );
              return;
            }
          } else {
            pendingSentenceReinforcementRef.current = null;
          }

          const retryCandidate = retryResumeAfterAssistantAudioRef.current;
          retryResumeAfterAssistantAudioRef.current = null;
          if (
            retryCandidate &&
            retryModeRef.current &&
            isActiveRetryCandidate(retryCandidate)
          ) {
            // If a child stops a retry sample early (for example from voice
            // settings), restore capture after the TTS promise has settled.
            await startRetryRecognition(retryCandidate);
            return;
          }

          const shouldResume = assistantAudioResumeRequestedRef.current;
          assistantAudioResumeRequestedRef.current = false;
          // A synthesis failure must reach the caller before any new capture.
          // Starting STT here can replace the recoverable TTS error with a mic
          // error or invalidate the sample generation before its catch runs.
          if (
            !playAborted &&
            resumeAfterPlayback &&
            shouldResume &&
            mountedRef.current &&
            uiStateRef.current === "reading" &&
            !retryModeRef.current
          ) {
            const resumed = await startListening();
            if (mountedRef.current) setIsMicRecording(resumed);
          }

          if (
            tutorResumeMicAfterPlaybackRef.current &&
            !playAborted &&
            mountedRef.current &&
            !retryModeRef.current
          ) {
            tutorResumeMicAfterPlaybackRef.current = false;
            const resumed = await startListening();
            if (mountedRef.current) setIsMicRecording(resumed);
          }
        }
      }
    }
  }

  function preventAssistantAudioResume(): void {
    assistantAudioGenerationRef.current += 1;
    assistantAudioResumeRequestedRef.current = false;
    retryResumeAfterAssistantAudioRef.current = null;
    assistantAudioPendingRef.current = false;
    assistantAudioPlayingRef.current = false;
  }

  function handleVoicePreview(sample: string): Promise<void> {
    return playAssistantAudio(async () => {
      const id = `voice-preview-${(assistantPlaybackSeqRef.current += 1)}`;
      echoGuard.playbackStarted(id, sample, performance.now());
      let audioPlayed = false;
      let playbackFailed = false;
      try {
        await speechPlayer.playWithWordTimings(sample.split(" "), {
          bookId: null,
          pageId: null,
          pageRevisionId: null,
          isPrivateBook: false,
          cacheScope: "COACHING",
          bypassSessionLock: true,
          utteranceKind: "voice_preview",
          onPlay: () => {
            audioPlayed = true;
          },
        });
      } catch (error) {
        playbackFailed = true;
        throw error;
      } finally {
        if (playbackFailed && !audioPlayed) {
          echoGuard.discardPlayback(id);
        } else {
          echoGuard.playbackEnded(id, performance.now());
        }
      }
    });
  }

  function clearRetryCaptureTimeout(): void {
    if (retryCaptureTimeoutRef.current !== null) {
      window.clearTimeout(retryCaptureTimeoutRef.current);
      retryCaptureTimeoutRef.current = null;
    }
  }

  function cancelRetryRecognition(preserveProcessing = false): void {
    // Vô hiệu hóa callback và request thuộc lượt retry cũ.
    retryAttemptIdRef.current += 1;
    retryResumeAfterAssistantAudioRef.current = null;

    retryAbortControllerRef.current?.abort();
    retryAbortControllerRef.current = null;

    retryListeningWantedRef.current = false;
    retryShouldRestartRef.current = false;
    isListeningActiveRef.current = false;

    if (!preserveProcessing) {
      retryProcessingRef.current = false;
    }

    clearRetryCaptureTimeout();

    const recognition = recognitionRef.current;
    recognitionRef.current = null;

    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // Recognition có thể đã kết thúc.
      }
    }

    if (retryRecorderActiveRef.current) {
      retryRecorderActiveRef.current = false;
      speechRecorder.cancel({ retainStream: true });
    }

    if (mountedRef.current) {
      setIsMicRecording(false);
    }
  }

  function stopAssistantAudio(): void {
    if (retryModeRef.current && assistantAudioPlayingRef.current) {
      retryResumeAfterAssistantAudioRef.current =
        retryCandidatesRef.current[retryPositionRef.current] ?? null;
    }
    setIsPlayingPageSample(false);
    setIsPlayingTutorAudio(false);
    speechPlayer.stop();
  }

  async function handleReadSample() {
    if (retryModeRef.current) {
      const candidate = retryCandidatesRef.current[retryPositionRef.current];
      if (!candidate) return;
      if (speechPlayer.isPlaying) {
        stopAssistantAudio();
        setIsReadingWord(false);
        return;
      }
      cancelRetryRecognition();
      void playRetryInstructionAndListen(candidate, speechRecorder.prepare());
      return;
    }
    if (isBusy && !speechPlayer.isPlaying) return;
    if (speechPlayer.isPlaying) {
      speechPlayer.stop();
      setIsPlayingPageSample(false);
      setIsReadingWord(false);
      setIsBusy(false);
      return;
    }
    if (!page) return;

    const rawText = page.text || page.words.map((w) => w.text).join(" ") || "";
    const fullText = rawText.trim();
    if (!fullText) return;

    const words = page.words;
    if (!words.length) return;

    if (uiStateRef.current === "tts-error") {
      setUiState("reading");
    }
    setPreviewSnapshot(null);
    setIsBusy(true);
    setIsReadingWord(false);
    setIsPlayingPageSample(true);
    const readingCursorBeforeSample =
      alignmentEngineRef.current?.getSnapshot().currentWordId ??
      currentWordId ??
      words[0].word_id;
    const sampleGeneration = assistantAudioGenerationRef.current + 1;
    const isCurrentSample = () =>
      mountedRef.current &&
      sampleGeneration === assistantAudioGenerationRef.current;
    // A sample only moves the visual cursor; it is not evidence of the child's reading.
    setCurrentWordId(words[0].word_id);

    try {
      await playAssistantAudio(
        () =>
          playPageSampleGuarded(
            words.map((word) => word.text),
            {
              text: fullText,
              onPlay: () => {
                if (!isCurrentSample()) return;
                setCurrentWordId(words[0].word_id);
              },
              onWordChange: (index) => {
                if (!isCurrentSample()) return;
                if (index < 0) {
                  setCurrentWordId(null);
                  return;
                }
                const targetWord = words[index];
                if (targetWord) setCurrentWordId(targetWord.word_id);
              },
              onEnded: () => {
                if (!isCurrentSample()) return;
                setCurrentWordId(
                  alignmentEngineRef.current?.getSnapshot().currentWordId ??
                    readingCursorBeforeSample,
                );
              },
            },
          ),
        true,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        if (mountedRef.current) {
          setIsPlayingPageSample(false);
          setIsBusy(false);
        }
        return;
      }
      // Do NOT auto-resume the microphone when TTS sample playback failed.
      preventAssistantAudioResume();
      if (mountedRef.current) {
        setUiState("tts-error");
        setCurrentWordId(
          alignmentEngineRef.current?.getSnapshot().currentWordId ??
            readingCursorBeforeSample,
        );
        setIsPlayingPageSample(false);
        setIsBusy(false);
      }
    } finally {
      if (mountedRef.current) {
        setIsPlayingPageSample(false);
        setIsBusy(false);
      }
      if (isCurrentSample()) {
        setCurrentWordId(
          alignmentEngineRef.current?.getSnapshot().currentWordId ??
            readingCursorBeforeSample,
        );
      }
    }
  }

  async function handleToggleListening() {
    if (uiStateRef.current === "tts-error") {
      setUiState("reading");
    }
    if (retryModeRef.current) {
      const candidate = retryCandidatesRef.current[retryPositionRef.current];
      if (!candidate || isBusy || retryProcessingRef.current) return;

      if (isMicRecording) {
        await stopRetryListeningAndTranscribe(candidate);
      } else {
        retryCurrentWord();
      }
      return;
    }
    if (isBusy && !speechPlayer.isPlaying) return;
    if (speechPlayer.isPlaying) {
      preventAssistantAudioResume();
      speechPlayer.stop();
      setIsPlayingPageSample(false);
      setIsReadingWord(false);
      setIsBusy(false);
    }
    if (isMicRecording) {
      setIsBusy(true);
      try {
        await stopListeningAndTranscribe({ finishAlignment: false });
        if (mountedRef.current) setIsMicRecording(false);
        const snapshot = alignmentEngineRef.current?.getSnapshot();
        if (snapshot) {
          await autoCompletePageAfterFinalWordRef.current(snapshot);
        }
      } finally {
        if (mountedRef.current) {
          setIsMicRecording(false);
          setIsBusy(false);
        }
      }
    } else {
      setIsBusy(true);
      try {
        const ok = await startListening();
        if (mountedRef.current && ok) {
          setIsMicRecording(true);
        }
      } finally {
        if (mountedRef.current) {
          setIsBusy(false);
        }
      }
    }
  }

  async function startReading() {
    if (frozenPageAssessmentsRef.current) {
      setConfirmFinish(true);
      return;
    }
    if (isBusy) return;

    setIsBusy(true);

    try {
      const nextState = await services.readingSocketAdapter.sendControl(
        sessionId,
        "start",
      );

      if (!mountedRef.current) return;

      setCanonicalState(nextState);
      setConnectionState("connected");
      setUiState("reading");
      setIsMicRecording(false);

      // Xóa dữ liệu transcript của buổi đọc mới.
      transcriptsListRef.current = [];
      pageTranscriptsRef.current.clear();
      completedPageAssessmentsRef.current.clear();
      uncertainPageIdsRef.current.clear();
      setUncertainWordIds(new Set());
      setHasPageTranscripts(false);
      browserTranscriptCollectorRef.current.reset();
      retryWordsByIdRef.current.clear();
      retryCandidatesRef.current = [];
      retryModeRef.current = false;
      retryListeningWantedRef.current = false;
      retryProcessingRef.current = false;
      setRetryMode(false);
      setRetryCandidates([]);
      setRetryConfirmedWordIds(new Set());
      setRetryWordPosition(0);
      setRetryFeedback("waiting");

      // Reset toàn bộ trạng thái nhận diện.
      helpedWordIdsRef.current.clear();
      gaveUpWordIdsRef.current.clear();
      selfCorrectedPraiseNotedRef.current.clear();
      disambiguationPendingRef.current = null;
      lastTrailingMismatchRef.current = null;
      setAssistedWordIds(new Set());
      setPresencePaused(false);
      correctWordIdsRef.current.clear();
      mispronouncedWordIdsRef.current.clear();
      skippedWordIdsRef.current.clear();
      repeatedWordIdsRef.current.clear();
      hesitationWordIdsRef.current.clear();

      failedWordsSetRef.current.clear();
      spokenWordsSetRef.current.clear();

      setCorrectWordIds(new Set());
      setMispronouncedWordIds(new Set());
      setSkippedWordIds(new Set());
      setRepeatedWordIds(new Set());
      setHesitationWordIds(new Set());
      setSpokenWords(new Set());

      // Reset alignment engine cho trang hiện tại.
      lastPreviewWordIndexRef.current = -1;
      const initialSnapshot = alignmentEngineRef.current?.reset();

      if (initialSnapshot) {
        setCurrentWordId(initialSnapshot.currentWordId);
      } else if (page?.words.length) {
        setCurrentWordId(page.words[0].word_id);
      }

      setLatestTranscript("");
      setComparisonResult(null);
      setComparisonError(null);

      // Pre-warm the microphone stream, standby AudioContext/AudioWorklet,
      // and WASM STT + TTS engines during the 3s countdown on Web (never on
      // Android APK where native SpeechRecognizer owns HAL mic) so the first
      // letter/word is captured & recognized immediately when countdown hits 0.
      void awaitVoiceEnginesReadyBeforeListening(2_800).catch(() => undefined);
      if (!shouldPreferAndroidNativeStt()) {
        cancelSessionStandbyRecognizer(sessionId);
        const prepPromise = speechRecorder.prepare().catch(() => undefined);
        if (typeof window !== "undefined") {
          const win = window as unknown as WindowWithSpeech;
          const StandbyCtor = resolveLocalFirstSpeechRecognitionConstructor(
            win,
            speechService,
            () => {
              const activePage = pageRef.current;
              const words = activePage?.words ?? [];
              const cursorIdx = resolveWordArrayIndex(
                words,
                alignmentEngineRef.current?.getSnapshot(),
                0,
              );
              const windowStart = Math.max(0, cursorIdx - 12);
              const windowEnd = Math.min(words.length, cursorIdx + 48);
              return {
                sessionId,
                pageId: activePage?.page_id ?? null,
                keyterms: words
                  .slice(windowStart, windowEnd)
                  .map((w) => w.text.normalize("NFC").trim())
                  .filter(Boolean),
              };
            },
            () => speechRecorder.getStream?.()?.getAudioTracks()?.[0],
            {
              onBeforeExternalMicStart: () =>
                onBeforeExternalMicStartRef.current?.(),
            },
          );
          if (
            StandbyCtor &&
            StandbyCtor.prototype instanceof LocalSegmentSpeechRecognition
          ) {
            const candidate =
              new StandbyCtor() as LocalSegmentSpeechRecognition;
            setSessionStandbyRecognizer(sessionId, candidate);
            void prepPromise.then(() => {
              if (
                mountedRef.current &&
                getSessionStandbyRecognizer(sessionId) === candidate
              ) {
                const track = speechRecorder
                  .getStream?.()
                  ?.getAudioTracks()?.[0];
                void candidate.armStandby(track).catch(() => undefined);
              }
            });
          }
        }
      }

      setCountdown(3);
    } catch (error) {
      console.error("Không thể bắt đầu buổi đọc:", error);

      if (mountedRef.current) {
        setConnectionState("reconnecting");
      }
    } finally {
      if (mountedRef.current) {
        setIsBusy(false);
      }
    }
  }

  async function resumeReading() {
    setPresencePaused(false);
    automationRuntimeRef.current?.dispatch({
      type: "RESUME",
      autoListen: false,
    });
    if (frozenPageAssessmentsRef.current && !retryModeRef.current) {
      setConfirmFinish(true);
      return;
    }
    if (isBusy) return;
    if (retryModeRef.current && retryPausedRef.current) {
      retryPausedRef.current = false;
      setUiState("reading");
      setCanonicalState("LISTENING");
      if (pendingRetryEventRef.current) await retryPendingRetryEvent();
      else
        await beginRetryWord(
          retryPositionRef.current,
          speechRecorder.prepare(),
        );
      return;
    }
    setIsBusy(true);
    try {
      const nextState = await services.readingSocketAdapter.sendControl(
        sessionId,
        "resume",
      );
      if (!mountedRef.current) return;
      setCanonicalState(nextState);
      setConnectionState("connected");
      setUiState("reading");
      setIsMicRecording(false);
    } catch {
      if (mountedRef.current) {
        setConnectionState("reconnecting");
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function pauseReading() {
    automationRuntimeRef.current?.dispatch({ type: "PAUSE", by: "child" });
    if (retryModeRef.current) {
      retryPausedRef.current = true;
      cancelRetryRecognition();
      preventAssistantAudioResume();
      speechPlayer.stop();
      speechRecorder.cancel();
      setIsMicRecording(false);
      setCountdown(null);
      setCanonicalState("PAUSED");
      setUiState("paused");
      setIsBusy(false);
      return;
    }
    if (isBusy && !speechPlayer.isPlaying) return;
    setIsBusy(true);
    setCountdown(null);
    cancelSessionStandbyRecognizer(sessionId);
    setPreviewSnapshot(null);
    listeningGenerationRef.current += 1;
    preventAssistantAudioResume();
    tutorResumeMicAfterPlaybackRef.current = false;
    setIsPlayingPageSample(false);
    setIsPlayingTutorAudio(false);
    speechPlayer.stop();
    if (
      listeningStopRef.current ||
      isMicRecording ||
      isListeningActiveRef.current ||
      isUsingRecorderRef.current ||
      speechRecorder.isRecording
    ) {
      try {
        await stopListeningAndTranscribe({ finishAlignment: false });
      } catch {
        speechRecorder.cancel();
      }
      if (mountedRef.current) {
        setIsMicRecording(false);
      }
    } else {
      // Also invalidate permission requests that have not opened a recorder yet.
      speechRecorder.cancel();
      await stopBrowserRecognition();
    }
    if (!mountedRef.current) return;
    speechRecorder.cancel();
    setCanonicalState("PAUSED");
    setUiState("paused");
    setIsBusy(false);
  }

  useEffect(() => {
    pauseReadingRef.current = pauseReading;
  });

  async function retryMicrophonePermission() {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await services.devicePermissionService.retry("microphone");
      if (!mountedRef.current) return;
      if (!(await startListening())) {
        return;
      }
      if (!mountedRef.current) return;
      setConnectionState("connected");
      setUiState("reading");
      setCanonicalState("LISTENING");
      setIsMicRecording(true);
    } catch {
      if (mountedRef.current) {
        setConnectionState("reconnecting");
        setUiState("microphone-denied");
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  function retryRetryMicrophonePermission(): void {
    const candidate = retryCandidatesRef.current[retryPositionRef.current];
    if (!candidate || isBusy) return;
    const permissionRequest = speechRecorder.prepare();
    void permissionRequest.catch(() => undefined);
    void playRetryInstructionAndListen(candidate, permissionRequest);
  }

  function retryCurrentWord(): void {
    const candidate = retryCandidatesRef.current[retryPositionRef.current];
    if (!candidate || isBusy || retryProcessingRef.current) return;
    cancelRetryRecognition();
    retryUnclearStreakRef.current = 0;
    retryHelpRoundsRef.current = 0;
    void playRetryInstructionAndListen(candidate, speechRecorder.prepare());
  }

  async function openPagePicker() {
    if (!pageProgress || retryMode || isBusy) return;
    pickerShouldReturnToReading.current =
      uiState === "reading" &&
      !isMicRecording &&
      !isListeningActiveRef.current &&
      countdown === null;
    if (uiState === "reading") await pauseReading();
    if (mountedRef.current) {
      setPageNavigationError(null);
      setPickerIndex(pageProgress.current_index);
    }
  }

  function closePagePicker() {
    if (isBusy) return;
    setPickerIndex(null);
    setPageNavigationError(null);
    if (pickerShouldReturnToReading.current && uiState === "paused") {
      setUiState("reading");
      setCanonicalState("PAGE_READY");
    }
  }

  async function navigateWithinRange(
    targetIndex: number,
    confirmSelection = false,
  ) {
    if (
      !pageProgress ||
      (isBusy && !speechPlayer.isPlaying) ||
      targetIndex < 0 ||
      targetIndex >= pageProgress.pages.length
    ) {
      return;
    }
    const target = pageProgress.pages[targetIndex];
    if (!target) return;
    if (target.page_id === page?.page_id) {
      if (confirmSelection) {
        setPickerIndex(null);
        setPageNavigationError(null);
        setUiState("reading");
        setCanonicalState("PAGE_READY");
      }
      return;
    }

    setIsBusy(true);
    setPageNavigationError(null);
    setCountdown(null);
    listeningGenerationRef.current += 1;
    preventAssistantAudioResume();
    speechPlayer.stop();
    setIsPlayingPageSample(false);
    setIsReadingWord(false);
    try {
      if (
        listeningStopRef.current ||
        isMicRecording ||
        isListeningActiveRef.current ||
        isUsingRecorderRef.current
      ) {
        await stopListeningAndTranscribe();
        if (mountedRef.current) setIsMicRecording(false);
      } else {
        speechRecorder.cancel();
        await stopBrowserRecognition();
      }

      // Finalize this page before its live alignment state is reset. Keep only
      // pages where the child actually produced final speech; opening a page
      // without reading it must not turn every word into an omission.
      const currentEngine = alignmentEngineRef.current;
      if (currentEngine) {
        const currentSnapshot = currentEngine.getSnapshot();
        if (
          currentSnapshot.spokenWords.length > 0 ||
          currentSnapshot.statusByWordId.size > 0
        ) {
          applyRealtimeSnapshot(currentEngine.finish());
        }
      }

      if (page) freezeCompletedPageAssessment(page);
      const nextProgress = await services.readingService.navigateToPage(
        sessionId,
        target.page_id,
      );
      const nextPage = await services.readingService.getCurrentPage(sessionId);
      if (!mountedRef.current) return;
      setPageProgress(nextProgress);
      resetPagePresentation();
      setPage(nextPage);
      setCurrentWordId(nextPage.words[0]?.word_id ?? null);
      if (confirmSelection) {
        setPickerIndex(null);
        setCanonicalState("PAGE_READY");
      }
      setCountdown(null);
      setUiState("reading");
    } catch {
      if (mountedRef.current) {
        setPageNavigationError(t("session.pageLoadFailed"));
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function confirmCurrentPageCompleted() {
    if (!pageProgress?.persisted || !page || isBusy) return;
    resumeCaptureAfterPageTurnRef.current =
      isMicRecording ||
      isListeningActiveRef.current ||
      isUsingRecorderRef.current;
    setIsBusy(true);
    setPageNavigationError(null);
    setCountdown(null);
    listeningGenerationRef.current += 1;
    preventAssistantAudioResume();
    speechPlayer.stop();
    try {
      if (
        listeningStopRef.current ||
        isMicRecording ||
        isListeningActiveRef.current ||
        isUsingRecorderRef.current ||
        speechRecorder.isRecording
      ) {
        await stopListeningAndTranscribe({ finishAlignment: false });
      } else {
        isListeningActiveRef.current = false;
        isUsingRecorderRef.current = false;
        speechRecorder.cancel();
        await stopBrowserRecognition();
      }
      if (mountedRef.current) setIsMicRecording(false);

      const engine = alignmentEngineRef.current;
      if (engine && engine.getSnapshot().spokenWords.length > 0) {
        applyRealtimeSnapshot(finishPassageAlignment(engine));
      }

      freezeCompletedPageAssessment(page);
      const progress = await services.readingService.completeCurrentPage(
        sessionId,
        page.page_id,
      );
      if (!mountedRef.current) return;
      setPageProgress(progress);
      if (progress.current_index + 1 < progress.total_pages) {
        setUiState("page-turn");
      }
    } catch {
      if (mountedRef.current) {
        setPageNavigationError(t("session.completePageFailed"));
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  function persistPageProgress(
    targetPageId: string,
    targetRevisionId: string,
  ): Promise<ReadingSessionPageProgressDTO> {
    const key = `${sessionId}:${targetPageId}:${targetRevisionId}`;
    if (inFlightPageSaveRef.current?.key === key) {
      return inFlightPageSaveRef.current.promise;
    }
    const promise = services.readingService
      .completeCurrentPage(sessionId, targetPageId)
      .then((nextProgress) => {
        savedPageProgressKeysRef.current.add(key);
        if (failedPageProgressKeyRef.current === key) {
          failedPageProgressKeyRef.current = null;
        }
        if (mountedRef.current) {
          pageProgressRef.current = nextProgress;
          setPageProgress(nextProgress);
          setPageNavigationError(null);
        }
        return nextProgress;
      })
      .catch((error) => {
        failedPageProgressKeyRef.current = key;
        throw error;
      })
      .finally(() => {
        if (inFlightPageSaveRef.current?.key === key) {
          inFlightPageSaveRef.current = null;
        }
      });
    inFlightPageSaveRef.current = { key, promise };
    return promise;
  }

  async function handleLastPageAutoComplete(): Promise<void> {
    if (
      lastPageAutoCompleteStartedRef.current ||
      initialAssessmentPreparedRef.current ||
      prepareFinishStartedRef.current ||
      finishStartedRef.current ||
      !mountedRef.current
    ) {
      return;
    }
    lastPageAutoCompleteStartedRef.current = true;
    try {
      if (automationRef.current.assist) {
        const praise = promptSelectorRef.current.next("pageFluentPraise");
        setLatestTranscript(praise);
        try {
          await speakGuarded(praise, { coaching: true });
        } catch {
          // Proceed even if TTS fails
        }
      }
      if (!mountedRef.current) return;
      await prepareInitialReading();
    } finally {
      if (!initialAssessmentPreparedRef.current) {
        lastPageAutoCompleteStartedRef.current = false;
      }
    }
  }

  async function autoCompletePageAfterFinalWord(
    snapshot: RealtimeAlignmentSnapshot,
  ): Promise<void> {
    // Parent turned automatic page turning off: the child ends the page with
    // the explicit "page finished" button instead.
    if (!automationRef.current.autoAdvance) return;
    const completedPage = page;
    const progress = pageProgress;
    const finalWord = completedPage?.words.at(-1);
    const finalStatus = finalWord
      ? snapshot.statusByWordId.get(finalWord.word_id)?.status
      : undefined;
    if (
      !completedPage ||
      !progress?.persisted ||
      progress.current_page_id !== completedPage.page_id ||
      !finalWord ||
      snapshot.currentWordId !== null ||
      // Read correctly, or encouraged past after the allowed attempts. A word
      // that was merely skipped never completes a page by itself.
      !(
        finalStatus === "MATCH" ||
        (finalStatus === "DELETE" &&
          gaveUpWordIdsRef.current.has(finalWord.word_id))
      ) ||
      retryModeRef.current ||
      assistantAudioPendingRef.current ||
      assistantAudioPlayingRef.current ||
      tutorOpen ||
      uiState !== "reading" ||
      isBusy ||
      progress.pages[progress.current_index]?.status === "COMPLETED" ||
      pageCompletionStartedRef.current === completedPage.page_id
    ) {
      return;
    }

    const completedPageId = completedPage.page_id;
    const completedRevisionId = completedPage.page_revision_id;
    const completedEngine = alignmentEngineRef.current;
    const completionKey = `${sessionId}:${completedPageId}:${completedRevisionId}`;
    let resolveCompletion!: (ok: boolean) => void;
    const completionPromise = new Promise<boolean>((resolve) => {
      resolveCompletion = resolve;
    });
    pageCompletionPromiseRef.current = {
      key: completionKey,
      promise: completionPromise,
    };
    let completionSucceeded = false;
    resumeCaptureAfterPageTurnRef.current = true;
    pageCompletionStartedRef.current = completedPageId;
    setIsBusy(true);
    setCountdown(null);
    setPageNavigationError(null);

    try {
      // Stop capture and save the child's final utterance without replaying
      // that already-aligned transcript through scoring a second time.
      await stopListeningAndTranscribe({
        finishAlignment: false,
        preserveAlignment: true,
      });
      if (!mountedRef.current || alignmentEngineRef.current !== completedEngine)
        return;

      const engine = alignmentEngineRef.current;
      if (engine) applyRealtimeSnapshot(finishPassageAlignment(engine));

      freezeCompletedPageAssessment(completedPage);
      const nextProgress = await persistPageProgress(
        completedPageId,
        completedRevisionId,
      );
      completionSucceeded = true;
      resolveCompletion(true);
      if (!mountedRef.current) return;

      setIsMicRecording(false);
      if (nextProgress.current_index + 1 < nextProgress.total_pages) {
        setUiState("page-turn");
      } else {
        resumeCaptureAfterPageTurnRef.current = false;
        setIsBusy(false);
        await handleLastPageAutoComplete();
      }
    } catch {
      resumeCaptureAfterPageTurnRef.current = false;
      if (mountedRef.current) {
        setIsMicRecording(false);
        setPageNavigationError(t("session.savePageRetryHint"));
      }
    } finally {
      if (!completionSucceeded) {
        resolveCompletion(false);
      }
      if (pageCompletionPromiseRef.current?.promise === completionPromise) {
        pageCompletionPromiseRef.current = null;
      }
      if (pageCompletionStartedRef.current === completedPageId) {
        pageCompletionStartedRef.current = null;
      }
      if (mountedRef.current) setIsBusy(false);
    }
  }

  useEffect(() => {
    autoCompletePageAfterFinalWordRef.current = autoCompletePageAfterFinalWord;
  });

  async function retryPageMatch() {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const matchedPage =
        await services.pageMatchService.retryCurrentPage(sessionId);
      if (!mountedRef.current) return;
      const nextProgress =
        await services.readingService.getPageProgress(sessionId);
      if (!mountedRef.current) return;
      setPage(matchedPage);
      setCurrentWordId(matchedPage.words[0]?.word_id ?? null);
      setPageProgress(nextProgress);
      setPageNavigationError(null);
      setCanonicalState("LISTENING");
      setConnectionState("connected");
      setUiState("reading");
    } catch {
      if (mountedRef.current) {
        setPageNavigationError(
          "Chưa tìm khớp lại được trang sách. Bé vui lòng thử lại nhé.",
        );
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function reconnect(mode: ReadingReconnectDemoMode) {
    if (isBusy) return;
    const resumeMicrophone = uiState === "stt-error";
    setIsBusy(true);
    ensureAutomationRuntime().dispatch({
      type: "RECOVER_START",
    });
    setConnectionState("reconnecting");
    try {
      const nextConnection = await services.readingSocketAdapter.reconnect(
        sessionId,
        mode,
      );
      if (!mountedRef.current) return;
      setConnectionState(nextConnection);
      if (nextConnection === "recovered") {
        automationRuntimeRef.current?.dispatch({ type: "RECOVER_END" });
        if (resumeMicrophone && !(await startListening())) {
          return;
        }
        if (!mountedRef.current) return;
        setCanonicalState("LISTENING");
        setUiState("reading");
      }
    } catch {
      if (mountedRef.current) {
        setConnectionState("reconnecting");
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function requestTutor() {
    if (!page || !currentWordId || isBusy) return;
    const word = page.words.find(
      (item) => item.word_id === currentWordId,
    )?.text;
    if (!word) return;
    tutorPlaybackGenerationRef.current += 1;
    tutorResumeListeningRef.current =
      isMicRecording ||
      isListeningActiveRef.current ||
      isUsingRecorderRef.current ||
      speechRecorder.isRecording ||
      countdown !== null;
    setTutorOpen(true);
    setIsBusy(true);
    const playbackGeneration = tutorPlaybackGenerationRef.current;
    try {
      await playAssistantAudio(
        async () => {
          let action: TutorAction | null = null;
          try {
            action = await services.tutorService.requestReadExample(
              sessionId,
              currentWordId,
            );
          } catch {
            // Audio assistance remains available while the separate tutor-event API
            // is being connected by the reading-session owner.
          }
          if (
            !mountedRef.current ||
            playbackGeneration !== tutorPlaybackGenerationRef.current
          ) {
            return;
          }
          const isVerbatimTutorWord =
            !action || !action.tts_text || action.tts_text === word;
          const tutorText = isVerbatimTutorWord
            ? word
            : adaptPersona(action?.tts_text ?? word);
          const tutorPlaybackId = `tutor-read-${(assistantPlaybackSeqRef.current += 1)}`;
          echoGuard.playbackStarted(
            tutorPlaybackId,
            tutorText,
            performance.now(),
          );
          let tutorPlaybackFailed = false;
          setIsPlayingTutorAudio(true);
          try {
            await speechPlayer.play(tutorText, {
              wordSample: isVerbatimTutorWord,
            });
          } catch (err) {
            tutorPlaybackFailed = true;
            throw err;
          } finally {
            setIsPlayingTutorAudio(false);
            if (tutorPlaybackFailed) {
              echoGuard.discardPlayback(tutorPlaybackId);
            } else {
              echoGuard.playbackEnded(tutorPlaybackId, performance.now());
            }
          }
          if (
            mountedRef.current &&
            playbackGeneration === tutorPlaybackGenerationRef.current
          ) {
            setTutorAction(action);
          }
        },
        false,
        false,
      );
    } catch (error) {
      if (
        mountedRef.current &&
        playbackGeneration === tutorPlaybackGenerationRef.current &&
        !(error instanceof Error && error.name === "AbortError")
      ) {
        setUiState("tts-error");
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  async function retryTutor() {
    if (!page || !currentWordId || isBusy) return;
    const word = page.words.find(
      (item) => item.word_id === currentWordId,
    )?.text;
    if (!word) return;
    tutorResumeListeningRef.current ||=
      isMicRecording ||
      isListeningActiveRef.current ||
      isUsingRecorderRef.current ||
      speechRecorder.isRecording ||
      countdown !== null;
    setIsBusy(true);
    const playbackGeneration = ++tutorPlaybackGenerationRef.current;
    try {
      let nextAction = tutorAction;
      await playAssistantAudio(
        async () => {
          try {
            nextAction = nextAction
              ? await services.tutorService.retryReadExample(nextAction)
              : await services.tutorService.requestReadExample(
                  sessionId,
                  currentWordId,
                );
          } catch {
            // A retry must still replay the word even if tutor-event persistence is unavailable.
          }
          if (
            !mountedRef.current ||
            playbackGeneration !== tutorPlaybackGenerationRef.current
          ) {
            return;
          }
          const isVerbatimRetryTutorWord =
            !nextAction || !nextAction.tts_text || nextAction.tts_text === word;
          const retryTutorText = isVerbatimRetryTutorWord
            ? word
            : adaptPersona(nextAction?.tts_text ?? word);
          const retryTutorPlaybackId = `tutor-retry-${(assistantPlaybackSeqRef.current += 1)}`;
          echoGuard.playbackStarted(
            retryTutorPlaybackId,
            retryTutorText,
            performance.now(),
          );
          let retryTutorPlaybackFailed = false;
          setIsPlayingTutorAudio(true);
          try {
            await speechPlayer.play(retryTutorText, {
              wordSample: isVerbatimRetryTutorWord,
            });
          } catch (err) {
            retryTutorPlaybackFailed = true;
            throw err;
          } finally {
            setIsPlayingTutorAudio(false);
            if (retryTutorPlaybackFailed) {
              echoGuard.discardPlayback(retryTutorPlaybackId);
            } else {
              echoGuard.playbackEnded(retryTutorPlaybackId, performance.now());
            }
          }
        },
        false,
        false,
      );
      if (
        mountedRef.current &&
        playbackGeneration === tutorPlaybackGenerationRef.current
      ) {
        setTutorAction(nextAction);
        setUiState("reading");
      }
    } catch (error) {
      if (
        mountedRef.current &&
        playbackGeneration === tutorPlaybackGenerationRef.current &&
        !(error instanceof Error && error.name === "AbortError")
      ) {
        setUiState("tts-error");
      }
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  function closeTutor(): void {
    const shouldResumeListening = tutorResumeListeningRef.current;
    tutorResumeListeningRef.current = false;
    tutorPlaybackGenerationRef.current += 1;
    setIsPlayingTutorAudio(false);
    speechPlayer.stop();
    setTutorOpen(false);
    setUiState("reading");

    if (shouldResumeListening) {
      if (
        assistantAudioPendingRef.current ||
        assistantAudioPlayingRef.current
      ) {
        tutorResumeMicAfterPlaybackRef.current = true;
      } else {
        void startListening().then((resumed) => {
          if (mountedRef.current) setIsMicRecording(resumed);
        });
      }
    }
  }
  function buildRetryContextPhrase(
    words: readonly ReadingPageWordDTO[],
    targetIndex: number,
  ): string {
    const target = words[targetIndex];
    if (!target) return "";

    const targetLine = target.line_index;

    let start = targetIndex;
    let end = targetIndex;

    // Lấy tối đa 2 từ trước và 2 từ sau.
    for (let i = targetIndex - 1; i >= Math.max(0, targetIndex - 2); i--) {
      const word = words[i];

      if (
        targetLine !== undefined &&
        word.line_index !== undefined &&
        word.line_index !== targetLine
      ) {
        break;
      }

      // Không lấy qua ranh giới câu.
      if (/[.!?…]["”']?$/.test(words[i].text)) break;

      start = i;
    }

    for (
      let i = targetIndex + 1;
      i <= Math.min(words.length - 1, targetIndex + 2);
      i++
    ) {
      const word = words[i];

      if (
        targetLine !== undefined &&
        word.line_index !== undefined &&
        word.line_index !== targetLine
      ) {
        break;
      }

      end = i;

      // Không lấy tiếp sang câu kế tiếp.
      if (/[.!?…]["”']?$/.test(word.text)) break;
    }

    return words
      .slice(start, end + 1)
      .map((word) => word.text)
      .join(" ");
  }
  function resolveRetrySentenceContext(candidate: RetryWordCandidate): string {
    const pageWords = pageWordsByRevisionRef.current.get(
      `${candidate.pageId}:${candidate.pageRevisionId}`,
    );
    if (!pageWords || pageWords.length === 0) {
      return candidate.contextPhrase;
    }
    const targetIdx = pageWords.findIndex(
      (item) => item.word_id === candidate.wordId,
    );
    if (targetIdx < 0) return candidate.contextPhrase;
    let start = targetIdx;
    for (let i = targetIdx - 1; i >= Math.max(0, targetIdx - 4); i -= 1) {
      if (/[.!?…]["”']?$/.test(pageWords[i].text)) break;
      start = i;
    }
    let end = targetIdx;
    for (
      let i = targetIdx + 1;
      i <= Math.min(pageWords.length - 1, targetIdx + 4);
      i += 1
    ) {
      end = i;
      if (/[.!?…]["”']?$/.test(pageWords[i].text)) break;
    }
    return pageWords
      .slice(start, end + 1)
      .map((item) => item.text)
      .join(" ");
  }
  function buildRetryCandidates(): RetryWordCandidate[] {
    return sortRetryWordRecords(retryWordsByIdRef.current.values())
      .filter(
        (item) =>
          !retryResolvedKeysRef.current.has(
            `${sessionId}:${item.page_id}:${item.page_revision_id}:${item.word_id}`,
          ) &&
          savedInitialPagesRef.current.has(
            `${item.page_id}:${item.page_revision_id}`,
          ),
      )
      .map((item) => {
        const pageWords = pageWordsByRevisionRef.current.get(
          `${item.page_id}:${item.page_revision_id}`,
        );

        const targetIndex = pageWords?.findIndex(
          (word) => word.word_id === item.word_id,
        );

        const contextPhrase =
          pageWords && targetIndex !== undefined && targetIndex >= 0
            ? buildRetryContextPhrase(pageWords, targetIndex)
            : item.text;

        return {
          wordId: item.word_id,
          text: item.text,
          contextPhrase,
          pageId: item.page_id,
          pageRevisionId: item.page_revision_id,
          pageNumber: item.page_number,
          wordIndex: item.word_index,
          originalStatus: item.original_status,
        };
      });
  }
  // Dừng nhận diện và hủy bản ghi đang hoạt động.
  // Không dùng hàm này để xử lý STT khi người dùng chủ động tắt mic.
  function stopRetryRecognition(): void {
    cancelRetryRecognition();
  }

  function handleRecorderFailure(): void {
    if (
      !mountedRef.current ||
      (!isUsingRecorderRef.current && !retryRecorderActiveRef.current)
    )
      return;
    listeningGenerationRef.current += 1;
    transcriptionAbortRef.current?.abort();
    if (!retryModeRef.current)
      markCaptureUncertain(alignmentEngineRef.current, page);
    isUsingRecorderRef.current = false;
    cancelRetryRecognition();
    speechRecorder.cancel();
    setIsMicRecording(false);
    setIsBusy(false);
    if (retryModeRef.current) {
      setRetryFeedback("microphone-unavailable");
      setLatestTranscript(t("session.micInterruptedNotice"));
    } else {
      setConnectionState("reconnecting");
      setUiState("microphone-denied");
    }
  }

  useEffect(() => {
    recorderFailureHandlerRef.current = handleRecorderFailure;
  });

  function scheduleRetryCaptureStop(
    candidate: RetryWordCandidate,
    useAudioActivityForSpeechOnset = true,
  ): void {
    if (retryCaptureTimeoutRef.current !== null) {
      return;
    }

    retryCaptureStartedAtRef.current = getRetryCaptureTimeMs();
    retrySpeechOnsetRef.current = null;
    retrySpeechObservedRef.current = false;
    retryBrowserPulseRef.current = false;
    retrySilenceStartedAtRef.current = null;
    let prevSpeechDurationMs = 0;

    const checkCapture = () => {
      retryCaptureTimeoutRef.current = null;
      if (
        !mountedRef.current ||
        !retryModeRef.current ||
        !retryListeningWantedRef.current
      ) {
        return;
      }

      const now = getRetryCaptureTimeMs();
      const elapsed = now - retryCaptureStartedAtRef.current;
      const quality = speechRecorder.getQuality?.();
      const browserPulse = retryBrowserPulseRef.current;
      retryBrowserPulseRef.current = false;
      const acousticActive = hasShortWordSpeechActivity({
        isSpeakingNow: speechRecorder.getIsSpeaking(),
        audioLevel:
          speechRecorder.getAudioLevel?.() ?? speechRecorder.audioLevel,
        quality,
        hasLiveBrowserSpeech: browserPulse,
        speechObserved: retrySpeechObservedRef.current,
        previousSpeechDurationMs: prevSpeechDurationMs,
      });
      prevSpeechDurationMs = quality?.speechDurationMs ?? prevSpeechDurationMs;
      if (speechRecorder.getIsSpeaking() || acousticActive) {
        if (useAudioActivityForSpeechOnset || retrySpeechObservedRef.current) {
          retrySpeechOnsetRef.current ??= now;
          retrySpeechObservedRef.current = true;
          retrySilenceStartedAtRef.current = null;
        }
      } else if (
        retrySpeechObservedRef.current &&
        retrySilenceStartedAtRef.current === null
      ) {
        retrySilenceStartedAtRef.current = now;
      }

      const silenceElapsed =
        retrySilenceStartedAtRef.current === null
          ? 0
          : now - retrySilenceStartedAtRef.current;
      if (
        shouldAutoStopShortWordCapture({
          elapsedMs: elapsed,
          speechObserved: retrySpeechObservedRef.current,
          silenceElapsedMs: silenceElapsed,
          config: retryPhraseRef.current ? PHRASE_CAPTURE_CONFIG : undefined,
        })
      ) {
        void stopRetryListeningAndTranscribe(candidate);
        return;
      }

      retryCaptureTimeoutRef.current = window.setTimeout(
        checkCapture,
        RETRY_CAPTURE_POLL_MS,
      );
    };

    retryCaptureTimeoutRef.current = window.setTimeout(
      checkCapture,
      RETRY_CAPTURE_POLL_MS,
    );
  }

  function retryCandidateKey(candidate: RetryWordCandidate): string {
    return `${sessionId}:${candidate.pageId}:${candidate.pageRevisionId}:${candidate.wordId}`;
  }

  function isActiveRetryCandidate(candidate: RetryWordCandidate): boolean {
    const active = retryCandidatesRef.current[retryPositionRef.current];
    return (
      mountedRef.current &&
      retryModeRef.current &&
      !retryPausedRef.current &&
      active !== undefined &&
      retryCandidateKey(active) === retryCandidateKey(candidate)
    );
  }

  function nextRetryAttempt(candidate: RetryWordCandidate): number {
    return (
      (retryEvaluatedCountsRef.current.get(retryCandidateKey(candidate)) ?? 0) +
      1
    );
  }

  function advanceRetryWord(candidate: RetryWordCandidate): void {
    if (!isActiveRetryCandidate(candidate) || pendingRetryEventRef.current)
      return;
    const nextPosition = retryPositionRef.current + 1;
    retryPlayback.stop();
    retryPhraseRef.current = null;
    setRetryPhrase(null);
    setRetryRecording(null);
    cancelRetryRecognition();
    if (nextPosition >= retryCandidatesRef.current.length) {
      retryModeRef.current = false;
      setRetryMode(false);
      speechRecorder.cancel();
      void completeReadingSession();
      return;
    }
    void beginRetryWord(nextPosition);
  }

  function confirmRetryWord(
    candidate: RetryWordCandidate,
    transcript: string,
    fromTranscription = false,
  ): Promise<boolean> {
    // Chặn callback trùng, nhưng cho phép luồng STT đang xử lý
    // tự xác nhận kết quả của chính nó.
    if (
      !isActiveRetryCandidate(candidate) ||
      (retryProcessingRef.current && !fromTranscription)
    ) {
      return Promise.resolve(false);
    }

    retryProcessingRef.current = true;
    retryListeningWantedRef.current = false;
    retryShouldRestartRef.current = false;
    isListeningActiveRef.current = false;

    // Giữ khóa retry cho đến khi chuyển sang từ tiếp theo.
    cancelRetryRecognition(true);
    const pending: PendingRetryEvent = {
      candidate,
      status: "CONFIRMED",
      transcript,
      attempt: nextRetryAttempt(candidate),
    };
    return persistRetryOutcome(pending);
  }

  function handleRetryVoiceCommand(
    text: string,
    candidate: RetryWordCandidate,
    isLiveMic: boolean,
  ): boolean {
    const intent = parseVoiceIntent(text, { upcomingText: candidate.text });
    if (
      intent.type === "SPELL" ||
      isSpellingHelpRequest(text, candidate.text)
    ) {
      void offerExplicitPhonicsHelp(
        null,
        page,
        { word_id: candidate.wordId, text: candidate.text },
        isLiveMic,
      );
      return true;
    }
    if (intent.type === "REPLAY") {
      void handleReadSample();
      return true;
    }
    if (intent.type === "SKIP") {
      skipRetryWord(!isLiveMic);
      return true;
    }
    if (intent.type === "STOP") {
      void pauseReading();
      return true;
    }
    if (intent.type === "HELP" || isWordHelpRequest(text, candidate.text)) {
      void offerRetryHelp(candidate);
      return true;
    }
    return false;
  }

  function selectRetryPhrase(candidate: RetryWordCandidate): string | null {
    const hadPhrase = Boolean(retryPhraseRef.current);
    const phrase =
      retryHeardFailuresRef.current >= SHORT_WORD_CONTEXT_RETRY_THRESHOLD
        ? shortWordContext(
            candidate.text,
            resolveRetrySentenceContext(candidate),
          )
        : null;
    if (!hadPhrase && phrase) {
      retryUnclearStreakRef.current = 0;
    }
    retryPhraseRef.current = phrase;
    setRetryPhrase(phrase);
    return phrase;
  }

  function retryUnclearCapture(
    candidate: RetryWordCandidate,
    transcript: string,
    heardSpeech = true,
  ): void {
    const spoken = tokenizeVietnameseText(
      stripNonSpeechAnnotations(transcript),
    );
    const meaningfulSpeech =
      heardSpeech &&
      spoken.length > 0 &&
      !isAssistantPromptBleed(spoken, tokenizeVietnameseText(candidate.text));
    retryListeningWantedRef.current = false;
    retryShouldRestartRef.current = false;
    isListeningActiveRef.current = false;
    retryProcessingRef.current = false;

    if (meaningfulSpeech && !retryPhraseRef.current) {
      retryHeardFailuresRef.current += 1;
      if (selectRetryPhrase(candidate)) {
        void playRetryInstructionAndListen(candidate);
        return;
      }
    }

    retryUnclearStreakRef.current += 1;
    if (retryUnclearStreakRef.current < WORD_HELP_SILENCE_LIMIT) {
      setRetryFeedback("not-recognized");
      setLatestTranscript(
        transcript
          ? t("session.retryUnclearAudio", { word: candidate.text })
          : t("session.retryNoSpeechAudio", { word: candidate.text }),
      );
      const generation = retryAttemptIdRef.current;
      window.setTimeout(() => {
        if (
          isActiveRetryCandidate(candidate) &&
          generation === retryAttemptIdRef.current
        ) {
          void startRetryRecognition(candidate);
        }
      }, 500);
      return;
    }

    if (meaningfulSpeech && retryPhraseRef.current) {
      retryProcessingRef.current = true;
      void persistRetryOutcome({
        candidate,
        status: "UNCERTAIN",
        transcript,
        attempt: nextRetryAttempt(candidate),
      });
      return;
    }

    if (!transcript && retryHelpRoundsRef.current < MAX_WORD_HELP_ROUNDS) {
      void offerRetryHelp(candidate);
      return;
    }
    speechRecorder.cancel();
    setRetryFeedback("not-recognized");
    setLatestTranscript(
      t("session.retryNotRecognized", { word: candidate.text }),
    );
  }

  async function persistRetryOutcome(
    pending: PendingRetryEvent,
  ): Promise<boolean> {
    if (retrySaveInFlightRef.current) return retrySaveInFlightRef.current;
    const request = persistRetryOutcomeOnce(pending);
    retrySaveInFlightRef.current = request;
    try {
      return await request;
    } finally {
      if (retrySaveInFlightRef.current === request)
        retrySaveInFlightRef.current = null;
    }
  }

  async function persistRetryOutcomeOnce(
    pending: PendingRetryEvent,
  ): Promise<boolean> {
    if (!isActiveRetryCandidate(pending.candidate)) return false;
    const candidateKey = retryCandidateKey(pending.candidate);
    const incorrectCount =
      (retryIncorrectCountsRef.current.get(candidateKey) ?? 0) +
      (pending.status === "FAILED" ? 1 : 0);
    const terminal = incorrectCount >= 3;
    pendingRetryEventRef.current = pending;
    setRetryFeedback("processing");
    setLatestTranscript(t("session.retrySavingResult"));
    setIsBusy(true);

    try {
      await services.readingService.createRetryEvent({
        sessionId,
        pageId: pending.candidate.pageId,
        pageRevisionId: pending.candidate.pageRevisionId,
        wordId: pending.candidate.wordId,
        status: pending.status,
        startMs: 0,
        endMs: null,
        metadata: {
          retry_attempt: pending.attempt,
          incorrect_retry_count: incorrectCount,
          resolution_status:
            pending.status === "CONFIRMED"
              ? "SELF_CORRECTED"
              : pending.status === "UNCERTAIN" || terminal
                ? "UNRESOLVED"
                : "RETRYING",
          ...(pending.status === "UNCERTAIN" && !pending.transcript
            ? { skip_reason: "TECHNICAL_OR_MANUAL" as const }
            : {}),
          original_status: pending.candidate.originalStatus,
          target_word: pending.candidate.text.slice(0, 100),
          ...(pending.transcript
            ? { recognized_text: pending.transcript.slice(0, 200) }
            : {}),
        },
      });
      if (!isActiveRetryCandidate(pending.candidate)) return false;
      pendingRetryEventRef.current = null;
      retryUnclearStreakRef.current = 0;
      retryEvaluatedCountsRef.current.set(candidateKey, pending.attempt);
      if (pending.status === "CONFIRMED") {
        retryResolvedKeysRef.current.add(candidateKey);
        finishConfirmedRetryWord(pending.candidate, pending.transcript);
      } else if (pending.status === "UNCERTAIN") {
        retryResolvedKeysRef.current.add(candidateKey);
        setUnresolvedRetryWordIds(
          (previous) => new Set([...previous, pending.candidate.wordId]),
        );
        advanceRetryWord(pending.candidate);
      } else {
        if (terminal) {
          retryResolvedKeysRef.current.add(candidateKey);
          setUnresolvedRetryWordIds(
            (previous) => new Set([...previous, pending.candidate.wordId]),
          );
        } else {
          retryHeardFailuresRef.current += 1;
          selectRetryPhrase(pending.candidate);
        }
        retryIncorrectCountsRef.current.set(candidateKey, incorrectCount);
        retryProcessingRef.current = true;
        setRetryFeedback("incorrect");
        setLatestTranscript(
          terminal
            ? t("session.retryExhaustedMoveNext", {
                word: pending.candidate.text,
              })
            : t("session.retryIncorrectHeard", {
                transcript: pending.transcript,
                word: pending.candidate.text,
              }),
        );
        const generation = retryAttemptIdRef.current;
        window.setTimeout(() => {
          if (
            !isActiveRetryCandidate(pending.candidate) ||
            generation !== retryAttemptIdRef.current
          )
            return;
          if (terminal) {
            advanceRetryWord(pending.candidate);
          } else {
            retryProcessingRef.current = false;
            void playRetryInstructionAndListen(pending.candidate);
          }
        }, 450);
      }
      return true;
    } catch (error) {
      console.error("[RETRY EVENT PERSISTENCE]", error);
      pendingRetryEventRef.current = pending;
      retryProcessingRef.current = false;
      setRetryFeedback("save-error");
      setLatestTranscript(t("session.retrySaveFailed"));
      return false;
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }

  function finishConfirmedRetryWord(
    candidate: RetryWordCandidate,
    transcript: string,
  ): void {
    retryProcessingRef.current = true;
    setLatestTranscript(transcript);
    setRetryFeedback("correct");

    setRetryConfirmedWordIds((previous) => {
      const next = new Set(previous);
      next.add(candidate.wordId);
      return next;
    });

    // The confirmed set controls green presentation only. First-pass word
    // sets and the original error record remain unchanged for assessment.

    const generation = retryAttemptIdRef.current;
    window.setTimeout(() => {
      if (generation === retryAttemptIdRef.current) advanceRetryWord(candidate);
    }, 450);
  }

  async function retryPendingRetryEvent(): Promise<void> {
    const pending = pendingRetryEventRef.current;
    if (!pending || retryProcessingRef.current) return;
    retryProcessingRef.current = true;
    await persistRetryOutcome(pending);
  }

  useEffect(() => {
    retryPendingRetryEventRef.current = retryPendingRetryEvent;
  });

  async function stopRetryListeningAndTranscribe(
    candidate: RetryWordCandidate,
    browserTranscript?: string,
  ): Promise<void> {
    if (!retryModeRef.current || retryProcessingRef.current) {
      return;
    }

    retryListeningWantedRef.current = false;
    retryShouldRestartRef.current = false;
    isListeningActiveRef.current = false;
    retryProcessingRef.current = true;

    clearRetryCaptureTimeout();

    const attemptId = retryAttemptIdRef.current;
    const recognition = recognitionRef.current;
    // The recognizer may emit its final result after stop().
    const browserFinalResult = recognition
      ? new Promise<void>((resolve) => {
          const finish = () => {
            window.clearTimeout(timer);
            if (recognitionRef.current === recognition)
              recognitionRef.current = null;
            resolve();
          };
          const timer = window.setTimeout(finish, 300);
          recognition.onend = finish;
          try {
            recognition.stop();
          } catch {
            finish();
          }
        })
      : Promise.resolve();

    if (mountedRef.current) {
      setIsMicRecording(false);
    }

    const retryContextPhrase = resolveRetrySentenceContext(candidate);
    const classifyOptions = { contextPhrase: retryContextPhrase };

    if (!retryRecorderActiveRef.current) {
      try {
        await browserFinalResult;
        if (
          attemptId !== retryAttemptIdRef.current ||
          !isActiveRetryCandidate(candidate)
        ) {
          return;
        }
        browserTranscript ??= retryBrowserFinalRef.current;
        if (
          browserTranscript &&
          classifyRetryTranscript(
            candidate.text,
            browserTranscript,
            classifyOptions,
          ) === "CORRECT"
        ) {
          await confirmRetryWord(candidate, browserTranscript, true);
        } else {
          retryUnclearCapture(candidate, browserTranscript ?? "");
        }
      } finally {
        retryProcessingRef.current = false;
      }
      return;
    }

    // Khóa để không xử lý cùng một bản ghi nhiều lần.
    const hadRecorder = retryRecorderActiveRef.current;
    retryRecorderActiveRef.current = false;

    retryAbortControllerRef.current?.abort();

    const controller = new AbortController();
    retryAbortControllerRef.current = controller;

    let advancePending = false;

    setIsBusy(true);
    setRetryFeedback("processing");
    const captureEndedAt = getRetryCaptureTimeMs();

    try {
      const [rawRecording] = await Promise.all([
        hadRecorder ? speechRecorder.stop() : Promise.resolve(null),
        browserFinalResult,
      ]);

      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        attemptId !== retryAttemptIdRef.current ||
        !retryModeRef.current
      ) {
        return;
      }

      browserTranscript ??= retryBrowserFinalRef.current;
      if (
        browserTranscript &&
        handleRetryVoiceCommand(browserTranscript, candidate, false)
      ) {
        return;
      }
      const captureQuality = hadRecorder
        ? speechRecorder.getQuality?.()
        : undefined;
      const exactBrowserRead =
        isConfidentExactBrowserRead(
          candidate.text,
          browserTranscript,
          retryBrowserConfidenceRef.current,
        ) ||
        isConfidentPhonicsBrowserRead(
          candidate.text,
          browserTranscript,
          retryBrowserConfidenceRef.current,
        );
      if (
        hadRecorder &&
        hasShortWordBlockingAudioIssue(captureQuality) &&
        !(exactBrowserRead && captureQuality?.status === "AUDIO_TOO_SHORT")
      ) {
        retryUnclearCapture(
          candidate,
          captureQuality?.status === "SILENCE" ||
            captureQuality?.status === "NO_AUDIO"
            ? ""
            : "Âm thanh chưa đủ rõ. Bé thử đọc lại nhé.",
          false,
        );
        return;
      }

      const recording = rawRecording?.size
        ? await prepareShortWordAudio(rawRecording)
        : null;
      if (controller.signal.aborted || attemptId !== retryAttemptIdRef.current)
        return;
      if (!recording) {
        if (browserTranscript) {
          const nativeStatus = classifyRetryTranscript(
            candidate.text,
            browserTranscript,
            classifyOptions,
          );
          setLatestTranscript(browserTranscript);
          if (nativeStatus === "CORRECT") {
            advancePending = await confirmRetryWord(
              candidate,
              browserTranscript,
              true,
            );
            return;
          }
          if (nativeStatus === "INCORRECT") {
            advancePending = await persistRetryOutcome({
              candidate,
              status: "FAILED",
              transcript: browserTranscript,
              attempt: nextRetryAttempt(candidate),
            });
            return;
          }
          retryUnclearCapture(candidate, browserTranscript);
          return;
        }
        retryUnclearCapture(candidate, "");
        return;
      }
      setRetryRecording(recording);

      if (exactBrowserRead && browserTranscript) {
        advancePending = await confirmRetryWord(
          candidate,
          browserTranscript,
          true,
        );
        return;
      }

      // Lần 1: STT bình thường, không dùng keyterms (tự chuyển sang Browser WASM khi Voice Worker offline).
      const submittedAt = getRetryCaptureTimeMs();
      const freshHealth = getFreshVoiceEngineHealth();
      const permanentlyUnconfigured =
        isPermanentlyHostedLocalUnconfigured(freshHealth);
      const localSttConfirmedDown =
        permanentlyUnconfigured ||
        (freshHealth !== null &&
          (!freshHealth.local.available || !freshHealth.local.stt_ready));
      const tryWasmRetryTranscribe = async () => {
        const wasmRes = await getBrowserWasmSttClient().transcribeBlob(
          recording,
          {
            signal: controller.signal,
            timeoutMs: 12_000,
            voicedDurationMs: speechRecorder.getQuality?.()?.speechDurationMs,
          },
        );
        recordSttEngineUsage({
          provider: "wasm",
          fallbackUsed: !permanentlyUnconfigured,
          fallbackReason: permanentlyUnconfigured
            ? null
            : "LOCAL_STT_UNAVAILABLE",
        });
        return {
          text: wasmRes.text.normalize("NFC"),
          language_code: "vi",
          language_probability: 1,
          words: null,
          provider: "wasm",
          fallback_used: !permanentlyUnconfigured,
        };
      };

      let transcription;
      if (localSttConfirmedDown && detectBrowserWasmSttSupport().supported) {
        try {
          transcription = await tryWasmRetryTranscribe();
        } catch (wasmErr) {
          if (controller.signal.aborted) return;
          if (permanentlyUnconfigured) {
            throw wasmErr;
          }
          console.warn("[RETRY WASM STT FALLBACK -> SERVER]", wasmErr);
          transcription = await speechService.transcribe(recording, {
            languageCode: "vi",
            signal: controller.signal,
            timeoutMs: 10_000,
          });
        }
      } else {
        try {
          transcription = await speechService.transcribe(recording, {
            languageCode: "vi",
            signal: controller.signal,
            timeoutMs: 10_000,
          });
        } catch (serverErr) {
          if (controller.signal.aborted) return;
          const serverErrText =
            typeof serverErr === "object" && serverErr !== null
              ? `${String((serverErr as { code?: unknown }).code ?? "")} ${String((serverErr as { providerCode?: unknown }).providerCode ?? "")} ${serverErr instanceof Error ? serverErr.message : ""}`
              : "";
          if (serverErrText.includes("LOCAL_VOICE_UNCONFIGURED")) {
            markHostedLocalUnconfigured();
          }
          if (
            detectBrowserWasmSttSupport().supported &&
            isServiceError(serverErr) &&
            (serverErr.status >= 500 ||
              serverErr.status === 0 ||
              serverErr.status === 408 ||
              serverErr.status === 429)
          ) {
            try {
              transcription = await tryWasmRetryTranscribe();
            } catch {
              throw serverErr;
            }
          } else {
            throw serverErr;
          }
        }
      }

      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        attemptId !== retryAttemptIdRef.current ||
        !retryModeRef.current
      ) {
        return;
      }

      let transcript = transcription.text?.trim() ?? "";

      if (
        hasUsableTranscript(transcription) &&
        handleRetryVoiceCommand(transcript, candidate, false)
      ) {
        return;
      }
      let status = hasUsableTranscript(transcription)
        ? classifyRetryTranscript(candidate.text, transcript, classifyOptions)
        : "UNCERTAIN";
      const browserStatus = classifyRetryTranscript(
        candidate.text,
        browserTranscript,
        classifyOptions,
      );
      const browserDisagrees =
        browserStatus === "INCORRECT" &&
        (retryBrowserConfidenceRef.current ?? 0) >= 0.75;
      if (status === "CORRECT" && browserDisagrees) {
        retryUnclearCapture(candidate, transcript);
        return;
      }

      // Lần 2: chỉ chạy khi kết quả lần đầu không rõ hoặc mâu thuẫn với trình duyệt.
      // Quan trọng: sử dụng lại chính recording cũ.
      const nonViLanguage =
        Boolean(transcription.language_code) &&
        !["vi", "vie", "vi-VN"].includes(transcription.language_code!);
      const unpromptedExact =
        Boolean(normalizeShortWordTranscript(transcript)) &&
        normalizeShortWordTranscript(transcript) ===
          normalizeShortWordTranscript(candidate.text) &&
        !nonViLanguage &&
        (!transcription.words?.length ||
          transcription.words.some(
            (word) => !word.type || word.type === "word",
          )) &&
        !browserDisagrees;
      if (
        status === "UNCERTAIN" &&
        unpromptedExact &&
        normalizeShortWordTranscript(browserTranscript ?? "") ===
          normalizeShortWordTranscript(candidate.text)
      ) {
        status = "CORRECT";
      }
      if (
        !isPermanentlyHostedLocalUnconfigured() &&
        (!nonViLanguage || browserStatus === "CORRECT") &&
        shouldAttemptShortWordKeytermPass2({
          status,
          audioQuality: captureQuality,
          transcript,
          browserStatus,
        })
      ) {
        try {
          transcription = await speechService.transcribe(recording, {
            languageCode: "vi",
            keyterms: buildContrastiveKeyterms(
              candidate.text,
              retryContextPhrase,
            ),
            signal: controller.signal,
            timeoutMs: 5_000,
          });

          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            attemptId !== retryAttemptIdRef.current ||
            !retryModeRef.current
          ) {
            return;
          }

          transcript = transcription.text?.trim() ?? "";
          status =
            hasUsableTranscript(transcription) &&
            (browserStatus === "CORRECT" ||
              hasHighConfidenceKeytermResult(
                transcription,
                candidate.text,
                browserStatus,
              )) &&
            classifyRetryTranscript(
              candidate.text,
              transcript,
              classifyOptions,
            ) === "CORRECT"
              ? "CORRECT"
              : "UNCERTAIN";
        } catch (fallbackError) {
          if (controller.signal.aborted) return;
          // Keep the first real transcript if the keyterm-biased request is
          // unavailable. It remains uncertain and is never forced to correct.
          console.warn("[RETRY STT KEYTERM FALLBACK]", fallbackError);
        }
      }

      setLatestTranscript(transcript);

      if (process.env.NODE_ENV === "development") {
        console.debug("[ViRead] thời gian đọc lại (ms)", {
          onset:
            retrySpeechOnsetRef.current === null
              ? null
              : Math.round(
                  retrySpeechOnsetRef.current -
                    retryCaptureStartedAtRef.current,
                ),
          capture: Math.round(
            captureEndedAt - retryCaptureStartedAtRef.current,
          ),
          prepareUpload: Math.round(submittedAt - captureEndedAt),
          recognition: Math.round(getRetryCaptureTimeMs() - submittedAt),
          status,
        });
      }

      if (status === "CORRECT") {
        advancePending = await confirmRetryWord(candidate, transcript, true);
        return;
      }

      if (
        browserTranscript &&
        classifyRetryTranscript(
          candidate.text,
          browserTranscript,
          classifyOptions,
        ) === "CORRECT"
      ) {
        // The live recognizer and the recorded-audio recognizer disagree.
        // Keep the word unscored and let the child try again instead of
        // accepting a result that the saved recording did not confirm.
        retryUnclearCapture(candidate, transcript);
        return;
      }

      if (status === "INCORRECT") {
        const evaluatedCount =
          retryEvaluatedCountsRef.current.get(retryCandidateKey(candidate)) ??
          0;
        if (
          hasConfusableShortCoda(candidate.text, transcript) &&
          (evaluatedCount === 0 ||
            !browserDisagrees ||
            normalizeVietnameseText(browserTranscript ?? "") !==
              normalizeVietnameseText(transcript))
        ) {
          retryUnclearCapture(candidate, transcript);
          return;
        }
        advancePending = await persistRetryOutcome({
          candidate,
          status: "FAILED",
          transcript,
          attempt: nextRetryAttempt(candidate),
        });
      } else {
        retryUnclearCapture(candidate, transcript);
      }
    } catch (error) {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        attemptId === retryAttemptIdRef.current
      ) {
        if (
          retryBrowserFinalRef.current &&
          classifyRetryTranscript(
            candidate.text,
            retryBrowserFinalRef.current,
            classifyOptions,
          ) === "CORRECT" &&
          isSttFallbackEligibleError(error)
        ) {
          advancePending = await confirmRetryWord(
            candidate,
            retryBrowserFinalRef.current,
            true,
          );
          return;
        }
        if (isServiceError(error)) {
          console.warn("[RETRY STT SERVICE DIAGNOSTIC]", {
            code: error.code,
            status: error.status,
            request_id: error.request_id,
            retryable: error.retryable,
          });
        } else {
          console.error("Lỗi nhận diện từ retry:", error);
        }

        setRetryFeedback("speech-unavailable");

        setLatestTranscript(t("session.retrySttOffline"));
      }
    } finally {
      if (attemptId === retryAttemptIdRef.current) {
        retryAbortControllerRef.current = null;

        // Khi thành công, confirmRetryWord giữ khóa
        // trong lúc chờ chuyển sang từ tiếp theo.
        if (!advancePending && !retrySaveInFlightRef.current) {
          retryProcessingRef.current = false;
        }
      }

      if (mountedRef.current) {
        setIsBusy(false);
      }
    }
  }

  async function startRetryRecognition(
    candidate: RetryWordCandidate,
    prompt?: string,
  ): Promise<boolean> {
    if (
      typeof window === "undefined" ||
      assistantAudioPendingRef.current ||
      assistantAudioPlayingRef.current ||
      !retryModeRef.current ||
      retryProcessingRef.current
    ) {
      return false;
    }

    retryPlayback.stop();
    // Nếu đây là lần restart do browser tự kết thúc,
    // không tạo bản ghi mới.
    const continuingCapture =
      retryRecorderActiveRef.current && retryListeningWantedRef.current;

    const attemptId = ++retryAttemptIdRef.current;

    retryAbortControllerRef.current?.abort();
    retryAbortControllerRef.current = null;

    retryListeningWantedRef.current = true;
    retryShouldRestartRef.current = true;
    retryProcessingRef.current = false;
    isListeningActiveRef.current = true;

    if (!continuingCapture) {
      setRetryRecording(null);
      retryBrowserFinalRef.current = "";
      retryBrowserConfidenceRef.current = null;
      retryBrowserCollectorRef.current = [];
      setRetryFeedback("listening");
      setLatestTranscript(prompt ?? "");
    }

    // Bắt đầu ghi âm dự phòng nếu chưa có bản ghi đang chạy
    // (bỏ qua MediaRecorder khi Android Native STT đang hoạt động để tránh tranh chấp micro HAL).
    const preferAndroidNativeStt = shouldPreferAndroidNativeStt();
    let startedRecorderNow = false;
    if (!preferAndroidNativeStt && !retryRecorderActiveRef.current) {
      try {
        await speechRecorder.start({ retainStream: false, mode: "short-word" });
        retryRecorderActiveRef.current = true;
        startedRecorderNow = true;
      } catch (error) {
        console.warn("[RETRY RECORDER ERROR]", error);

        retryRecorderActiveRef.current = false;
      }
    }

    // Kiểm tra lại sau thao tác bất đồng bộ xin microphone.
    if (
      !mountedRef.current ||
      assistantAudioPendingRef.current ||
      assistantAudioPlayingRef.current ||
      attemptId !== retryAttemptIdRef.current ||
      !retryModeRef.current ||
      !retryListeningWantedRef.current
    ) {
      if (speechRecorder.isRecording) {
        speechRecorder.cancel({ retainStream: false });
        retryRecorderActiveRef.current = false;
      }
      return false;
    }

    if (startedRecorderNow) {
      playRetryReadyCue();
      if (!continuingCapture) {
        setRetryFeedback("listening");
        setLatestTranscript(prompt ?? "Bíp! Bé đọc từ trên màn hình nhé.");
      }
    }

    const win = window as unknown as WindowWithSpeech & {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const SpeechRec = resolveLocalFirstSpeechRecognitionConstructor(
      win,
      speechService,
      () => ({
        sessionId,
        pageId: page?.page_id ?? null,
        keyterms: [
          candidate.text,
          ...(resolveRetrySentenceContext(candidate)?.split(/\s+/) ?? []),
        ].filter(Boolean),
      }),
      () => speechRecorder.getStream?.()?.getAudioTracks()?.[0],
      {
        onBeforeExternalMicStart: () => {
          if (retryRecorderActiveRef.current || speechRecorder.isRecording) {
            retryRecorderActiveRef.current = false;
            speechRecorder.cancel({ retainStream: false });
          }
        },
      },
    ) as (new () => BrowserSpeechRecognition) | undefined;

    // Không có Browser SpeechRecognition:
    // vẫn có thể sử dụng MediaRecorder + STT backend.
    if (!SpeechRec) {
      if (retryRecorderActiveRef.current) {
        retryShouldRestartRef.current = false;
        isListeningActiveRef.current = true;

        setIsMicRecording(true);
        setLatestTranscript(
          prompt ??
            (startedRecorderNow
              ? "Bíp! Bé đọc từ trên màn hình nhé."
              : t("session.listeningProgressNote")),
        );

        scheduleRetryCaptureStop(candidate);

        return true;
      }

      retryListeningWantedRef.current = false;
      retryShouldRestartRef.current = false;
      isListeningActiveRef.current = false;

      setIsMicRecording(false);
      setRetryFeedback("microphone-unavailable");
      setLatestTranscript(t("session.micPermissionBlocked"));

      return false;
    }

    const recognition = new SpeechRec();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "vi-VN";
    // Alternatives are competing guesses for the same audio, not separate
    // words. Only use the recognizer's best hypothesis for this single word.
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: BrowserSpeechEvent) => {
      if (
        !mountedRef.current ||
        assistantAudioPendingRef.current ||
        assistantAudioPlayingRef.current ||
        attemptId !== retryAttemptIdRef.current ||
        !retryModeRef.current ||
        recognitionRef.current !== recognition ||
        (!retryListeningWantedRef.current && !retryProcessingRef.current)
      ) {
        return;
      }

      let interim = "";
      const finalTranscripts: string[] = [];
      let finalConfidence = 1;

      // Only consume newly updated results. Each result[0] is the best
      // hypothesis; alternatives are not additional words in the recording.
      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        if (!result) continue;
        const text = result[0]?.transcript?.trim() ?? "";
        const conf = result[0]?.confidence;
        const usableNormal = hasUsableBrowserConfidence(conf);
        const usableChildWord =
          !usableNormal &&
          hasUsableChildWindowBrowserConfidence(text, [candidate.text], conf);
        const usablePhonics =
          !usableNormal &&
          !usableChildWord &&
          hasUsablePhonicsBrowserConfidence(conf) &&
          isLikelyPhonicsCueForWord(
            text,
            candidate.text,
            retryBrowserCollectorRef.current,
          );

        if (!text || (!usableNormal && !usableChildWord && !usablePhonics)) {
          continue;
        }

        const rawOnsetAt = (result as { readonly onsetAt?: number | null })
          .onsetAt;
        const rawAudioEndedAt = (
          result as { readonly audioEndedAt?: number | null }
        ).audioEndedAt;
        const normalizedOnsetAt =
          typeof rawOnsetAt === "number" && Number.isFinite(rawOnsetAt)
            ? rawOnsetAt
            : null;
        const normalizedAudioEndedAt =
          typeof rawAudioEndedAt === "number" &&
          Number.isFinite(rawAudioEndedAt)
            ? rawAudioEndedAt
            : null;
        if (result.isFinal) {
          const echoVerdict = echoGuard.evaluate({
            text,
            receivedAt: performance.now(),
            onsetAt: normalizedOnsetAt,
            audioEndedAt: normalizedAudioEndedAt,
          });
          // Always reject transcripts captured during active TTS or whose
          // acoustic onset began before playback + settle ended (`onset-during-playback`).
          // Once past `endedAt + onsetGraceMs` (or when `onsetAt` is null after
          // retry's `acousticSettleMs`), never drop the child's immediate
          // coached repetition of the target word or help request via `tail-overlap`.
          const allowCoachedRetryTarget =
            echoVerdict.reason === "tail-overlap" &&
            (isWordHelpRequest(text, candidate.text) ||
              parseVoiceIntent(text, { upcomingText: candidate.text }).type !==
                "NONE" ||
              classifyRetryTranscript(candidate.text, text, {
                contextPhrase: resolveRetrySentenceContext(candidate),
              }) === "CORRECT");
          if (!echoVerdict.accept && !allowCoachedRetryTarget) {
            continue;
          }
        }

        // Browser recognition is a better speech-onset signal than raw
        // microphone volume, which can be triggered by room noise.
        retrySpeechObservedRef.current = true;
        retryBrowserPulseRef.current = true;

        if (result.isFinal) {
          finalTranscripts.push(text);
          finalConfidence = Math.min(finalConfidence, conf ?? 0);
        } else {
          interim = [interim, text].filter(Boolean).join(" ");
        }
      }

      if (interim) {
        setLatestTranscript(
          [...retryBrowserCollectorRef.current, interim]
            .filter(Boolean)
            .join(" "),
        );
      }

      if (finalTranscripts.length === 0) {
        return;
      }

      retryBrowserCollectorRef.current = [
        ...retryBrowserCollectorRef.current,
        ...finalTranscripts,
      ];
      const finalText = retryBrowserCollectorRef.current.join(" ");
      retryBrowserConfidenceRef.current =
        retryBrowserConfidenceRef.current === null
          ? finalConfidence
          : Math.min(retryBrowserConfidenceRef.current, finalConfidence);
      retryBrowserFinalRef.current = finalText;

      if (retryProcessingRef.current) return;

      setLatestTranscript(finalText);

      if (handleRetryVoiceCommand(finalText, candidate, true)) {
        return;
      }
      // Keep the recorded tail even when speech recognition finalizes early.
      if (
        !retryRecorderActiveRef.current &&
        classifyRetryTranscript(candidate.text, finalText, {
          contextPhrase: resolveRetrySentenceContext(candidate),
        }) === "CORRECT"
      ) {
        void stopRetryListeningAndTranscribe(candidate, finalText);
        return;
      }

      // Keep listening; a non-matching browser interim result is not proof
      // that the child pronounced the target incorrectly.
      setRetryFeedback("listening");
      retryShouldRestartRef.current = true;
    };

    recognition.onerror = (event: BrowserSpeechErrorEvent) => {
      if (
        attemptId !== retryAttemptIdRef.current ||
        !retryListeningWantedRef.current
      )
        return;
      if (event.error === "aborted") {
        return;
      }

      if (event.error === "no-speech") {
        retryShouldRestartRef.current = retryListeningWantedRef.current;
        return;
      }

      console.warn("[RETRY SPEECH RECOGNITION ERROR]", event.error);

      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed" ||
        event.error === "language-not-supported" ||
        event.error === "audio-capture" ||
        event.error === "network"
      ) {
        retryShouldRestartRef.current = false;

        if (retryRecorderActiveRef.current) {
          // Keep VAD and the independent recording running if live ASR fails.
          return;
        }

        retryListeningWantedRef.current = false;
        isListeningActiveRef.current = false;

        setIsMicRecording(false);
        setRetryFeedback(
          event.error === "not-allowed" ||
            event.error === "service-not-allowed" ||
            event.error === "audio-capture"
            ? "microphone-unavailable"
            : "speech-unavailable",
        );

        const message =
          event.error === "not-allowed" || event.error === "service-not-allowed"
            ? t("session.recPermissionDenied")
            : event.error === "audio-capture"
              ? t("session.recNotFound")
              : event.error === "network"
                ? t("session.recNetworkInterrupted")
                : t("session.recUnsupportedBrowser");

        setLatestTranscript(message);
      }
    };

    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }

      if (
        !mountedRef.current ||
        !retryModeRef.current ||
        attemptId !== retryAttemptIdRef.current
      ) {
        return;
      }

      if (retryListeningWantedRef.current && retryShouldRestartRef.current) {
        // Chrome có thể kết thúc một phiên nhận diện
        // dù MediaRecorder vẫn đang thu âm.
        window.setTimeout(() => {
          if (
            mountedRef.current &&
            isActiveRetryCandidate(candidate) &&
            attemptId === retryAttemptIdRef.current &&
            retryListeningWantedRef.current &&
            retryShouldRestartRef.current &&
            !recognitionRef.current
          ) {
            void startRetryRecognition(candidate);
          }
        }, 250);

        return;
      }

      if (!retryListeningWantedRef.current) {
        isListeningActiveRef.current = false;

        if (mountedRef.current) {
          setIsMicRecording(false);
        }
      }
    };

    try {
      recognitionRef.current = recognition;
      const track = speechRecorder.getStream()?.getAudioTracks()[0];
      if (track) recognition.start(track);
      else recognition.start();

      setIsMicRecording(true);
      scheduleRetryCaptureStop(candidate, true);

      return true;
    } catch (error) {
      if (attemptId !== retryAttemptIdRef.current || !mountedRef.current) {
        return false;
      }

      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }

      console.warn("Không thể bắt đầu Browser SpeechRecognition:", error);

      // Browser recognition lỗi nhưng MediaRecorder vẫn chạy:
      // tiếp tục thu âm để backend nhận diện.
      if (retryRecorderActiveRef.current) {
        retryShouldRestartRef.current = false;
        isListeningActiveRef.current = true;

        setIsMicRecording(true);
        setLatestTranscript(prompt ?? t("session.recPreparingCue"));

        scheduleRetryCaptureStop(candidate);

        return true;
      }

      retryListeningWantedRef.current = false;
      retryShouldRestartRef.current = false;
      isListeningActiveRef.current = false;

      setIsMicRecording(false);
      setRetryFeedback("microphone-unavailable");
      setLatestTranscript(t("session.recStartFailed"));

      return false;
    }
  }

  async function offerRetryHelp(candidate: RetryWordCandidate): Promise<void> {
    if (!isActiveRetryCandidate(candidate)) return;
    cancelRetryRecognition();
    setIsMicRecording(false);
    setIsBusy(false);
    if (retryHelpRoundsRef.current >= MAX_WORD_HELP_ROUNDS) {
      speechRecorder.cancel();
      setRetryFeedback("not-recognized");
      setLatestTranscript(t("session.retryPausedOptions"));
      return;
    }
    retryHelpRoundsRef.current += 1;
    retryUnclearStreakRef.current = WORD_HELP_SILENCE_LIMIT;
    await playRetryInstructionAndListen(candidate, undefined, true);
  }

  async function playRetryInstructionAndListen(
    candidate: RetryWordCandidate,
    permissionRequest?: Promise<void>,
    guidedHelp = false,
  ): Promise<void> {
    const generation = retryAttemptIdRef.current;
    const isCurrent = () =>
      isActiveRetryCandidate(candidate) &&
      generation === retryAttemptIdRef.current;
    setRetryFeedback("preparing-microphone");
    setLatestTranscript(t("session.preparingMicShort"));

    const preferAndroidNativeStt = shouldPreferAndroidNativeStt();
    if (!preferAndroidNativeStt) {
      try {
        await (permissionRequest ?? speechRecorder.prepare());
      } catch (error) {
        console.warn("[RETRY MICROPHONE PERMISSION]", error);
        if (isCurrent()) {
          setIsMicRecording(false);
          setRetryFeedback("microphone-unavailable");
          setLatestTranscript(t("session.allowMicRetryHint"));
        }
        return;
      }
    }

    if (!isCurrent()) {
      return;
    }

    try {
      await playAssistantAudio(async () => {
        setRetryFeedback("playing-instruction");
        setLatestTranscript(t("session.guidingRetryWord"));
        const phrase = retryPhraseRef.current;
        if (phrase) {
          setLatestTranscript(t("session.readWholePhrasePrompt"));
          await speakGuarded(`Con hãy đọc cả cụm: ${phrase}.`, {
            coaching: true,
            preserveBookText: true,
          });
          return;
        }
        await speakGuarded(
          guidedHelp
            ? adaptPersona("Cô đọc mẫu cho con nhé.")
            : "Con nghe từ này nhé.",
          { coaching: true },
        );

        if (!isCurrent()) {
          return;
        }

        setRetryFeedback("playing-sample");
        setLatestTranscript(
          t("session.playingWordSampleStatus", { word: candidate.text }),
        );
        setIsReadingWord(true);
        try {
          await speakGuarded(candidate.text, { wordSample: true });
          if (guidedHelp && isCurrent())
            await speakGuarded("Đến lượt con đọc nhé.", {
              coaching: true,
            });
        } finally {
          if (isCurrent()) setIsReadingWord(false);
        }
      });

      if (!isCurrent()) {
        return;
      }

      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, SHORT_WORD_CAPTURE_CONFIG.acousticSettleMs),
      );
      if (!isCurrent()) {
        return;
      }

      await startRetryRecognition(
        candidate,
        retryPhraseRef.current ? t("session.readWholePhrasePrompt") : undefined,
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof Error && error.name === "AbortError") return;
      console.error("[RETRY TTS PLAYBACK]", error);
      if (isCurrent()) {
        setIsReadingWord(false);
        await startRetryRecognition(
          candidate,
          retryPhraseRef.current
            ? t("session.readWholePhrasePrompt")
            : t("session.readWordOnScreenPrompt"),
        );
      }
    }
  }

  async function beginRetryWord(
    position: number,
    permissionRequest?: Promise<void>,
  ): Promise<void> {
    if (!mountedRef.current) return;
    const candidate = retryCandidatesRef.current[position];
    if (!candidate) {
      setRetryFeedback("incorrect");
      setPageNavigationError(t("session.retryQueueInvalid"));
      return;
    }

    cancelRetryRecognition();
    setPreviewSnapshot(null);
    retryPositionRef.current = position;
    const generation = retryAttemptIdRef.current;
    const isCurrent = () =>
      isActiveRetryCandidate(candidate) &&
      generation === retryAttemptIdRef.current;
    retryUnclearStreakRef.current = 0;
    retryHeardFailuresRef.current =
      retryIncorrectCountsRef.current.get(retryCandidateKey(candidate)) ?? 0;
    selectRetryPhrase(candidate);
    setRetryWordPosition(position);
    retryHelpRoundsRef.current = 0;
    setRetryFeedback("waiting");
    setLatestTranscript("");
    setIsReadingWord(false);
    setPageNavigationError(null);

    // Retry candidates can belong to pages visited earlier in a multi-page
    // session. Re-open the candidate's verified page before highlighting it.
    if (
      !page ||
      page.page_id !== candidate.pageId ||
      page.page_revision_id !== candidate.pageRevisionId
    ) {
      setIsBusy(true);
      try {
        const progress = await services.readingService.navigateToPage(
          sessionId,
          candidate.pageId,
        );
        const retryPage =
          await services.readingService.getCurrentPage(sessionId);
        if (!isCurrent()) return;
        if (
          retryPage.page_id !== candidate.pageId ||
          retryPage.page_revision_id !== candidate.pageRevisionId
        ) {
          throw new Error(
            "The retry page revision no longer matches the session.",
          );
        }
        setPageProgress(progress);
        setPage(retryPage);
      } catch {
        if (isCurrent()) {
          setRetryFeedback("incorrect");
          setPageNavigationError(
            t("session.reopenRetryPageFailed", { page: candidate.pageNumber }),
          );
          speechRecorder.cancel();
        }
        return;
      } finally {
        if (mountedRef.current) setIsBusy(false);
      }
    }

    if (!isCurrent()) return;
    setCurrentWordId(candidate.wordId);
    await playRetryInstructionAndListen(candidate, permissionRequest);
  }

  function skipRetryWord(bypassProcessingGuard = false): void {
    if (
      !retryModeRef.current ||
      (!bypassProcessingGuard && retryProcessingRef.current) ||
      pendingRetryEventRef.current
    ) {
      return;
    }

    const candidate = retryCandidatesRef.current[retryPositionRef.current];
    if (!candidate) return;
    stopRetryRecognition();
    // A technical/manual skip is durable, but never a scored incorrect retry.
    retryProcessingRef.current = true;
    void persistRetryOutcome({
      candidate,
      status: "UNCERTAIN",
      transcript: "",
      attempt: nextRetryAttempt(candidate),
    });
  }

  function startRetrySession(candidates: RetryWordCandidate[]): boolean {
    retryPausedRef.current = false;
    // Prefer the exact queue shown in the consent dialog. If an older render
    // supplied an empty array, rebuild from the durable word-id map rather
    // than silently completing the reading session.
    const activeCandidates =
      candidates.length > 0 ? candidates : buildRetryCandidates();

    if (activeCandidates.length === 0) {
      setRetryFeedback("incorrect");
      setLatestTranscript(t("session.retryQueueUnavailable"));
      setRetryPrompt(true);
      return false;
    }

    // Request microphone permission synchronously from the retry button's
    // gesture, before page navigation or any unrelated asynchronous work.
    const permissionRequest = speechRecorder.prepare();
    void permissionRequest.catch(() => undefined);

    // The consent transition invalidates any remaining initial-reading countdown.
    transitioningToRetryRef.current = true;
    setPreviewSnapshot(null);
    setCountdown(null);
    retryCandidatesRef.current = [...activeCandidates];
    setRetryCandidates(activeCandidates);
    retryModeRef.current = true;
    retryProcessingRef.current = false;
    pendingRetryEventRef.current = null;
    retryPositionRef.current = 0;
    setRetryWordPosition(0);
    setRetryFeedback("waiting");
    setRetryMode(true);
    void beginRetryWord(0, permissionRequest);
    return true;
  }

  async function completeReadingSession() {
    if (finishStartedRef.current) return;

    if (pendingRetryEventRef.current) {
      retryModeRef.current = true;
      setRetryMode(true);
      setRetryFeedback("save-error");
      setLatestTranscript(t("session.retryPendingBeforeFinish"));
      return;
    }

    finishStartedRef.current = true;
    setIsBusy(true);
    speechPlayer.stop();
    speechRecorder.cancel();

    try {
      // REST là nguồn dữ liệu chính thức để kết thúc session.
      const finishedSession = await services.readingService.finish(sessionId);

      // WebSocket chỉ là thông báo phụ, không ảnh hưởng kết quả REST.
      void services.readingSocketAdapter
        .sendControl(sessionId, "finish")
        .catch((error: unknown) => {
          console.warn("Không gửi được tín hiệu kết thúc buổi đọc:", error);
        });

      if (!mountedRef.current) return;

      const wordsList = transcriptsListRef.current
        .flatMap((transcript) => transcript.trim().split(/\s+/u))
        .filter(Boolean);
      const durationMinutes = getDurationMinutes(finishedSession.duration_ms);

      const persistedCompletion = await services.readingService
        .getCompletionSummary(sessionId)
        .catch(() => null);

      const correctWordIds = Array.from(correctWordIdsRef.current).filter(
        (wordId) =>
          !mispronouncedWordIdsRef.current.has(wordId) &&
          !skippedWordIdsRef.current.has(wordId),
      );
      const correctWordsList = correctWordIds
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));

      const mispronouncedWordsList = Array.from(mispronouncedWordIdsRef.current)
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));
      const skippedWordsList = Array.from(skippedWordIdsRef.current)
        .map((wordId) => wordTextByIdRef.current.get(wordId))
        .filter((word): word is string => Boolean(word));

      const totalTracked = new Set([
        ...correctWordIds,
        ...mispronouncedWordIdsRef.current,
        ...skippedWordIdsRef.current,
      ]).size;

      const score =
        totalTracked > 0
          ? Math.round((correctWordsList.length / totalTracked) * 100)
          : null;

      const updatedSummary: ReadingCompletionSummaryUI = {
        correct_words: correctWordsList,
        duration_minutes: durationMinutes,
        mispronounced_words: mispronouncedWordsList,
        skipped_words: skippedWordsList,
        pages_explored:
          persistedCompletion?.pages_explored ??
          (pageProgress?.persisted ? pageProgress.completed_pages : null),
        selected_range_pages:
          persistedCompletion?.selected_range_pages ??
          (pageProgress?.persisted ? pageProgress.total_pages : null),
        practiced_words: wordsList.length,
        score,
        spoken_words: wordsList,
        transcripts: [...transcriptsListRef.current],
        ...(persistedCompletion?.assessment
          ? {
              assessment: persistedCompletion.assessment,
              correct_words: persistedCompletion.correct_words,
              mispronounced_words: persistedCompletion.mispronounced_words,
              skipped_words: persistedCompletion.skipped_words,
              score: persistedCompletion.score,
              practiced_words: persistedCompletion.practiced_words,
            }
          : {}),
      };

      setSessionSummary(updatedSummary);
      setCanonicalState("FINISHED");
      setConfirmFinish(false);
      setRetryPrompt(false);
      retryModeRef.current = false;
      setRetryMode(false);
      speechRecorder.cancel();
      const postFinishState = await resolvePostFinishUiState(
        services.comprehensionService,
        sessionId,
      );
      if (postFinishState === "question") {
        automationRuntimeRef.current?.dispatch({ type: "QUIZ_START" });
      } else {
        automationRuntimeRef.current?.dispatch({ type: "SESSION_END" });
      }
      setUiState(postFinishState);
    } catch (error) {
      console.error("Lỗi khi kết thúc buổi đọc:", error);
      finishStartedRef.current = false;
    } finally {
      if (mountedRef.current) {
        setIsBusy(false);
      }
    }
  }
  async function persistPageComparisonReports(): Promise<boolean> {
    const pageBuckets =
      frozenPageAssessmentsRef.current ??
      [...pageTranscriptsRef.current.values()]
        .filter((bucket) => bucket.segments.some((segment) => segment.trim()))
        .sort((left, right) => left.page_number - right.page_number)
        .map(
          (bucket) =>
            completedPageAssessmentsRef.current.get(
              `${bucket.page_id}:${bucket.page_revision_id}`,
            ) ?? capturePageAssessment(bucket),
        );
    frozenPageAssessmentsRef.current = pageBuckets;

    setComparisonResult(null);
    if (pageBuckets.length === 0) {
      setComparisonError(t("session.noSpokenReportHint"));
      return true;
    }

    setComparisonError(null);
    let latestResult: ComparisonResult | null = null;
    let allSaved = true;
    let firstComparisonError: string | null = uncertainPageIdsRef.current.size
      ? t("session.uncertainRecordedSeparately")
      : null;

    for (const bucket of pageBuckets) {
      const transcript = bucket.segments.join(" ").trim();
      if (!transcript) continue;

      try {
        latestResult = await compareTranscript(
          sessionId,
          transcript,
          bucket.words,
          {
            page_id: bucket.page_id,
            page_revision_id: bucket.page_revision_id,
            initial_assessment: bucket.initial_assessment,
          },
        );
        savedInitialPagesRef.current.add(
          `${bucket.page_id}:${bucket.page_revision_id}`,
        );
      } catch (error) {
        allSaved = false;
        console.error("Lỗi so sánh bài đọc:", {
          sessionId,
          pageId: bucket.page_id,
          pageRevisionId: bucket.page_revision_id,
          error,
        });
        firstComparisonError = t("session.saveSessionReportFailed");
      }
    }

    if (!mountedRef.current) return false;
    setComparisonResult(latestResult);
    setComparisonError(firstComparisonError);
    return allSaved;
  }

  async function retrySavingPageReports(): Promise<void> {
    if (retryReportSaveStartedRef.current) return;
    retryReportSaveStartedRef.current = true;
    setIsRetryingReports(true);
    try {
      // Re-submit the actual transcript/page snapshots. The backend returns
      // an existing identical report, so previously saved pages stay unique.
      const saved = await persistPageComparisonReports();
      if (!saved) return;
    } finally {
      retryReportSaveStartedRef.current = false;
      if (mountedRef.current) setIsRetryingReports(false);
    }
  }

  async function prepareInitialReading() {
    if (initialAssessmentPreparedRef.current) return;
    if (prepareFinishStartedRef.current) return;
    if (finishStartedRef.current) return;

    prepareFinishStartedRef.current = true;
    // Cancel the initial reading countdown before finalizing; its expiry must
    // never restart the original microphone while retry mode owns capture.
    setCountdown(null);
    listeningGenerationRef.current += 1;
    setIsBusy(true);
    preventAssistantAudioResume();
    speechPlayer.stop();

    let isCompletingSession = false;

    try {
      // 1. Dừng microphone và chờ chuyển ghi âm thành văn bản.
      if (
        listeningStopRef.current ||
        isMicRecording ||
        isListeningActiveRef.current ||
        isUsingRecorderRef.current ||
        speechRecorder.isRecording
      ) {
        try {
          await stopListeningAndTranscribe();
        } catch (error) {
          console.error("Lỗi khi dừng ghi âm:", error);
          speechRecorder.cancel();
        }

        if (mountedRef.current) {
          setIsMicRecording(false);
        }
      } else {
        speechRecorder.cancel();
        await stopBrowserRecognition();
      }

      if (!mountedRef.current) return;

      // 2. Hoàn tất alignment của lượt đọc đầu tiên.
      const engine = alignmentEngineRef.current;

      if (engine) {
        const currentSnapshot = engine.getSnapshot();
        if (
          currentSnapshot.spokenWords.length > 0 ||
          currentSnapshot.statusByWordId.size > 0
        ) {
          applyRealtimeSnapshot(finishPassageAlignment(engine));
        }
      }
      // Persist a comparison for every page with an actual transcript.
      if (!(await persistPageComparisonReports())) return;

      if (!mountedRef.current) return;

      // 6. Đánh dấu lượt đánh giá đầu tiên đã hoàn tất.
      initialAssessmentPreparedRef.current = true;

      // 7. Tạo danh sách từ cần đọc lại.
      const candidates = buildRetryCandidates();
      retryCandidatesRef.current = candidates;

      setRetryCandidates(candidates);
      setConfirmFinish(false);

      // 8. Nếu có từ sai hoặc bị bỏ qua, hỏi bé có muốn đọc lại không.
      if (candidates.length > 0) {
        setRetryPrompt(true);
        return;
      }

      // 9. Không có từ cần retry thì kết thúc session.
      isCompletingSession = true;
      await completeReadingSession();
    } catch (error) {
      console.error("Lỗi khi chuẩn bị kết thúc lượt đọc:", error);

      // Chỉ cho phép chuẩn bị lại nếu quá trình chuẩn bị thất bại.
      initialAssessmentPreparedRef.current = false;
    } finally {
      prepareFinishStartedRef.current = false;

      if (mountedRef.current) {
        // Không ghi đè trạng thái busy của completeReadingSession().
        if (!isCompletingSession) {
          setIsBusy(false);
        }
      }
    }
  }
  // Voice-first post-reading wrap-up: when the book finishes with wrong/difficult words,
  // speak the warm question in the locked voice & listen for the child's "Có" / "Không" reply.
  useEffect(() => {
    if (!retryPrompt || retryCandidatesRef.current.length === 0) return;
    if (!automationRef.current.assist) return;
    const hasRealAudioApi =
      typeof window !== "undefined" &&
      (typeof window.AudioContext === "function" ||
        typeof (window as unknown as { webkitAudioContext?: unknown })
          .webkitAudioContext === "function");
    const hasInjectedRec =
      typeof window !== "undefined" &&
      isInjectedTestSpeechRecognition(
        (window as unknown as WindowWithSpeech).SpeechRecognition ||
          (window as unknown as WindowWithSpeech).webkitSpeechRecognition,
      );
    // In real browsers / Android WebView (AudioContext exists), always run the voice
    // wrap-up even after speechRecorder.stop() ended the reading track. In headless
    // JSDOM tests without AudioContext, skip unless a test explicitly stubs AudioContext.
    if (!hasRealAudioApi) return;
    let cancelled = false;
    let activeRec: BrowserSpeechRecognition | null = null;
    let restartTimer: number | null = null;
    let noSpeechRetries = 0;
    let shouldRestartAfterNoSpeech = false;
    const promptText = promptSelectorRef.current.next(
      "postReadingWrongWordsAsk",
    );

    const stopRec = () => {
      if (restartTimer !== null && typeof window !== "undefined") {
        window.clearTimeout(restartTimer);
        restartTimer = null;
      }
      shouldRestartAfterNoSpeech = false;
      if (!activeRec) return;
      const target = activeRec;
      activeRec = null;
      try {
        target.onresult = null;
        target.onerror = null;
        target.onend = null;
        target.abort?.();
        target.stop();
      } catch {
        // Ignore cleanup errors
      }
    };

    const runVoiceWrapUp = async () => {
      try {
        await speakGuarded(promptText, {
          coaching: true,
          preserveBookText: true,
        });
      } catch {
        // Fallback silently to visual buttons if TTS is unavailable
      }
      if (cancelled || !mountedRef.current || typeof window === "undefined") {
        return;
      }
      // Acoustic settle delay after speaker stops so room echo never trips "Có"/"Không"
      await new Promise<void>((resolve) =>
        window.setTimeout(
          resolve,
          hasInjectedRec ? 0 : SHORT_WORD_CAPTURE_CONFIG.acousticSettleMs,
        ),
      );
      if (cancelled || !mountedRef.current) {
        return;
      }
      try {
        const win = window as unknown as WindowWithSpeech & {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        };
        const SpeechRec = resolveLocalFirstSpeechRecognitionConstructor(
          win,
          speechService,
          () => ({
            sessionId,
            pageId: pageRef.current?.page_id ?? null,
            keyterms: ["có", "không", "đọc lại", "bỏ qua", "thôi", "muốn"],
          }),
          () => {
            const track = speechRecorder.getStream?.()?.getAudioTracks()?.[0];
            return track && track.readyState === "live" ? track : undefined;
          },
        ) as (new () => BrowserSpeechRecognition) | undefined;
        if (!SpeechRec || cancelled) return;
        const rec = new SpeechRec();
        activeRec = rec;
        // Keep listening across ignored echo / hesitation segments until a clear "yes" or "no"
        // is received (stopRec() terminates immediately once decided or on unmount/background).
        rec.continuous = true;
        rec.interimResults = false;
        rec.lang = "vi-VN";
        rec.maxAlternatives = 1;
        rec.onresult = (event: BrowserSpeechEvent) => {
          if (cancelled || !mountedRef.current) return;
          noSpeechRetries = 0;
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const item = event.results[i];
            if (!item?.isFinal) continue;
            const spoken = item[0]?.transcript ?? "";
            const meta = extractSegmentResultMeta(item);
            if (
              !echoGuard.evaluate({
                text: spoken,
                receivedAt: performance.now(),
                onsetAt: meta?.onsetAt ?? null,
                audioEndedAt: meta?.audioEndedAt ?? null,
              }).accept
            ) {
              continue;
            }
            const intent = classifyYesNoVoiceIntent(spoken);
            if (intent === "yes") {
              stopRec();
              transitioningToRetryRef.current = true;
              if (startRetrySession(retryCandidatesRef.current)) {
                setRetryPrompt(false);
              } else {
                transitioningToRetryRef.current = false;
              }
              return;
            }
            if (intent === "no") {
              stopRec();
              retryModeRef.current = false;
              setRetryPrompt(false);
              void completeReadingSession();
              return;
            }
          }
        };
        rec.onerror = (event: BrowserSpeechErrorEvent) => {
          if (cancelled || !mountedRef.current || activeRec !== rec) return;
          if (event.error === "aborted") return;
          if (event.error === "no-speech" && noSpeechRetries < 2) {
            noSpeechRetries += 1;
            shouldRestartAfterNoSpeech = true;
            return;
          }
          stopRec();
        };
        rec.onend = () => {
          if (
            cancelled ||
            !mountedRef.current ||
            activeRec !== rec ||
            !shouldRestartAfterNoSpeech
          ) {
            return;
          }
          shouldRestartAfterNoSpeech = false;
          if (restartTimer !== null && typeof window !== "undefined") {
            window.clearTimeout(restartTimer);
          }
          restartTimer = window.setTimeout(() => {
            restartTimer = null;
            if (cancelled || !mountedRef.current || activeRec !== rec) return;
            try {
              rec.start();
            } catch {
              stopRec();
            }
          }, 200);
        };
        rec.start();
      } catch {
        // Keep manual buttons usable if mic cannot open
      }
    };

    void runVoiceWrapUp();
    return () => {
      cancelled = true;
      stopRec();
      if (transitioningToRetryRef.current) {
        transitioningToRetryRef.current = false;
      } else {
        speechPlayer.stop();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryPrompt]);

  async function finishReading() {
    if (finishStartedRef.current) return;

    // Nếu đang ở chế độ đọc lại:
    // Dừng nhận diện và kết thúc session ngay.
    if (retryModeRef.current || retryMode) {
      cancelRetryRecognition();
      speechRecorder.cancel();

      await completeReadingSession();
      return;
    }

    // Nếu lượt đọc đầu tiên đã được đánh giá,
    // không chạy alignment và compare lần nữa.
    if (initialAssessmentPreparedRef.current) {
      if (retryCandidatesRef.current.length === 0) {
        setConfirmFinish(false);
        await completeReadingSession();
        return;
      }
      setConfirmFinish(false);
      setRetryPrompt(true);
      return;
    }

    await prepareInitialReading();
  }
  if (loadState.status === "error" || loadState.status === "not-found") {
    const notFound = loadState.status === "not-found";
    const title = notFound
      ? t("session.notFoundTitle")
      : t("session.openFailedTitle");

    return (
      <section className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col justify-center gap-4 p-4">
        <h1 className="text-heading font-extrabold text-ink">{title}</h1>
        <StatusMessage tone="error">
          {notFound
            ? t("session.notFoundDescription")
            : t("session.openFailedDescription")}
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
            {t("session.retry")}
          </Button>
        ) : null}
        <ButtonLink href="/books" variant="quiet">
          <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-5" />
          {t("session.backToLibrary")}
        </ButtonLink>
      </section>
    );
  }

  if (loadState.status === "loading" || !page) {
    return (
      <section
        aria-busy="true"
        aria-label={t("session.loadingAria")}
        className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 p-4"
      >
        <span className="sr-only" role="status">
          {t("session.loadingText")}
        </span>
        <AiProgressBar
          active
          label={
            sessionLoadProgress.stageLabel ?? tCommon("aiProgress.preparing")
          }
          percent={sessionLoadProgress.percent}
          size="sm"
          testId="reading-session-loading-progress"
        />
        <Skeleton className="h-12 w-full rounded-control" />
        <Skeleton className="min-h-[680px] w-full rounded-card" />
        <Skeleton className="h-20 w-full rounded-card" />
      </section>
    );
  }

  const { book, child, completion } = loadState.data;
  const detailHref = `/books/${encodeURIComponent(book.id)}`;
  const booksHref = "/books";
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
      />
    );
  }

  if (uiState === "question") {
    return (
      <ReadingDynamicFallbackContext.Provider
        value={dynamicFallbackContextValue}
      >
        <ReadingSubpanelErrorBoundary
          fallback={(err, reset) => (
            <ReadingSubpanelFallback
              error={err}
              onResetBoundary={reset}
              panel="question"
            />
          )}
        >
          <ComprehensionQuestion
            child={child}
            onComplete={() => {
              automationRuntimeRef.current?.dispatch({ type: "QUIZ_END" });
              setUiState("complete");
            }}
            sessionId={sessionId}
          />
        </ReadingSubpanelErrorBoundary>
      </ReadingDynamicFallbackContext.Provider>
    );
  }

  if (uiState === "complete") {
    return (
      <ReadingDynamicFallbackContext.Provider
        value={dynamicFallbackContextValue}
      >
        <ReadingSubpanelErrorBoundary
          fallback={(err, reset) => (
            <ReadingSubpanelFallback
              error={err}
              onResetBoundary={reset}
              panel="complete"
            />
          )}
        >
          <SessionComplete
            booksHref={booksHref}
            bookId={book.id}
            startPageId={pageProgress?.start_page_id}
            endPageId={pageProgress?.end_page_id}
            lastPageId={page.page_id}
            child={child}
            sessionId={sessionId}
            summary={sessionSummary ?? completion}
            reportError={comparisonError}
            onRetryReports={
              hasPageTranscripts
                ? () => void retrySavingPageReports()
                : undefined
            }
            isRetryingReports={isRetryingReports}
          />
        </ReadingSubpanelErrorBoundary>
      </ReadingDynamicFallbackContext.Provider>
    );
  }

  const canUseDuetMode = !retryMode && duetTurns.length >= 2;
  const hasTopBarContent = Boolean(
    pageProgress ||
    canUseDuetMode ||
    (pageNavigationError && pickerIndex === null) ||
    speechPlayer.fallbackNotice ||
    isWasmDownloading ||
    isReadingAiWait,
  );

  const readingTopBar = hasTopBarContent ? (
    <div className="relative flex flex-col gap-1 border-b border-border/80 pb-1.5">
      {pageProgress ? (
        <div className="flex flex-wrap items-center gap-1 sm:gap-2.5">
          <div className="flex min-w-0 flex-nowrap items-center gap-1 sm:gap-1.5">
            <Button
              aria-label={t("session.previousPage")}
              className="h-11! w-auto! min-w-0 gap-1! px-2! py-1! text-xs! sm:gap-2! sm:px-2.5! sm:text-sm!"
              disabled={
                (isBusy && !speechPlayer.isPlaying) ||
                (uiState !== "reading" && uiState !== "tts-error") ||
                pageProgress.current_index <= 0
              }
              onClick={() =>
                void navigateWithinRange(pageProgress.current_index - 1)
              }
              variant="secondary"
            >
              <ChevronLeft
                aria-hidden="true"
                className="viread-rtl-flip size-4 shrink-0 sm:size-5"
              />
              <span className="hidden sm:inline">
                {t("session.previousPage")}
              </span>
              <span className="sm:hidden">{t("session.prevPageShort")}</span>
            </Button>
            <Button
              aria-label={t("session.nextPage")}
              className="h-11! w-auto! min-w-0 gap-1! px-2! py-1! text-xs! sm:gap-2! sm:px-2.5! sm:text-sm!"
              disabled={
                (isBusy && !speechPlayer.isPlaying) ||
                (uiState !== "reading" && uiState !== "tts-error") ||
                pageProgress.current_index >= pageProgress.total_pages - 1
              }
              onClick={() =>
                void navigateWithinRange(pageProgress.current_index + 1)
              }
              variant="secondary"
            >
              <span className="hidden sm:inline">{t("session.nextPage")}</span>
              <span className="sm:hidden">{t("session.nextPageShort")}</span>
              <ChevronRight
                aria-hidden="true"
                className="viread-rtl-flip size-4 shrink-0 sm:size-5"
              />
            </Button>
            {pageProgress.persisted &&
            pageProgress.pages[pageProgress.current_index]?.status !==
              "COMPLETED" ? (
              <Button
                aria-label={t("session.markPageDoneAria")}
                className="h-11! w-auto! min-w-0 px-2! py-1! text-xs! sm:px-2.5! sm:text-sm!"
                disabled={isBusy || uiState !== "reading"}
                onClick={() => void confirmCurrentPageCompleted()}
                variant="quiet"
              >
                <span className="hidden sm:inline">
                  {t("session.markPageDone")}
                </span>
                <span className="sm:hidden">
                  {t("session.markPageDoneShort")}
                </span>
              </Button>
            ) : null}
          </div>

          <button
            type="button"
            aria-label={t("session.pageOptionsAria")}
            aria-expanded={pageOptionsOpen}
            aria-controls="reading-page-options"
            onClick={() => setPageOptionsOpen((open) => !open)}
            className="ms-auto inline-flex min-h-11 shrink-0 items-center gap-1 rounded-control border border-border bg-white px-2 text-xs font-semibold text-ink hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:hidden"
          >
            <span>{t("session.pageOptions")}</span>
            <ChevronDown
              aria-hidden="true"
              className={`size-4 transition-transform ${pageOptionsOpen ? "rotate-180" : ""}`}
            />
          </button>

          <div
            id="reading-page-options"
            className={`${pageOptionsOpen ? "flex" : "hidden"} w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs sm:ms-auto sm:flex sm:w-auto sm:pt-0 sm:text-sm`}
          >
            <p
              data-reading-range-label="true"
              className="font-semibold text-ink"
            >
              {t("preparation.rangeSummary", {
                start: formatNumber(pageProgress.start_page_number),
                end: formatNumber(pageProgress.end_page_number),
              })}
            </p>
            <p
              data-reading-page-summary="true"
              className="text-muted"
              aria-live="polite"
            >
              {t("session.pageProgressDetail", {
                page: formatNumber(pageProgress.current_page_number),
                index: formatNumber(pageProgress.current_index + 1),
                total: formatNumber(pageProgress.total_pages),
                completed: formatNumber(pageProgress.completed_pages),
              })}
            </p>
          </div>
        </div>
      ) : null}
      {canUseDuetMode ? (
        <div className="flex flex-col gap-1.5 pt-0.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              aria-pressed={duetModeEnabled}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-primary ${
                duetModeEnabled
                  ? "border-primary bg-primary text-white shadow-2xs"
                  : "border-border bg-white text-ink hover:bg-sky"
              }`}
              data-testid="duet-mode-toggle"
              onClick={() => setDuetModeEnabled((prev) => !prev)}
              type="button"
            >
              <Users aria-hidden="true" className="size-3.5 shrink-0" />
              {duetModeEnabled ? t("duet.toggleActive") : t("duet.toggleLabel")}
            </button>
          </div>
          {duetModeEnabled && activeDuetTurn ? (
            <div
              className={`flex flex-wrap items-center justify-between gap-2.5 rounded-card border px-3.5 py-2.5 ${
                activeDuetTurn.role === "PARENT"
                  ? "border-amber-300 bg-amber-50/90"
                  : "border-emerald-300 bg-emerald-50/90"
              }`}
              data-duet-role={activeDuetTurn.role}
              data-testid="duet-turn-banner"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${
                      activeDuetTurn.role === "PARENT"
                        ? "bg-amber-200/80 text-amber-950"
                        : "bg-emerald-200/80 text-emerald-950"
                    }`}
                  >
                    {activeDuetTurn.role === "PARENT"
                      ? t("duet.parentTurnBadge")
                      : t("duet.childTurnBadge")}
                  </span>
                  <span className="text-xs font-semibold text-muted">
                    {t("duet.turnCounter", {
                      current: formatNumber(activeDuetTurn.turnIndex + 1),
                      total: formatNumber(duetTurns.length),
                    })}
                  </span>
                </div>
                <p
                  className="viread-learning-content mt-1 line-clamp-2 text-sm font-bold text-ink"
                  dir="ltr"
                  lang="vi"
                >
                  {activeDuetTurn.text}
                </p>
              </div>
              {activeDuetTurn.role === "PARENT" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    className="w-auto"
                    fullWidth={false}
                    onClick={() => {
                      speechPlayer.stop();
                      void speechPlayer
                        .play(activeDuetTurn.text, {
                          utteranceKind: "page_sample",
                        })
                        .catch(() => undefined);
                    }}
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    <Volume2 aria-hidden="true" className="size-3.5" />
                    {t("duet.listenParentSample")}
                  </Button>
                  <Button
                    className="w-auto"
                    data-testid="duet-complete-parent-turn"
                    fullWidth={false}
                    onClick={handleCompleteParentDuetTurn}
                    size="compact"
                    type="button"
                  >
                    {t("duet.completeParentTurn")}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {pageNavigationError && pickerIndex === null ? (
        <div
          data-topbar-notice-overlay="true"
          className="mt-1 flex flex-wrap items-center gap-2 rounded-control bg-white/95"
        >
          <StatusMessage tone="info">{pageNavigationError}</StatusMessage>
          {retryMode ? (
            <Button
              className="h-11! w-auto! px-3! py-1! text-sm!"
              disabled={isBusy}
              onClick={() => void beginRetryWord(retryPositionRef.current)}
              variant="secondary"
            >
              {t("session.retryOpenPage")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {isWasmDownloading ? (
        <AiProgressBar
          active
          detail={wasmDownloadState?.file}
          label={
            wasmModelProgress.stageLabel ??
            tCommon("aiProgress.downloadingSpeechModel")
          }
          percent={wasmModelProgress.percent}
          size="compact"
          testId="reading-wasm-model-progress"
        />
      ) : null}
      {isReadingAiWait ? (
        <AiProgressBar
          active
          label={
            readingAiProgress.stageLabel ??
            (isTtsSynthesizing
              ? tCommon("aiProgress.synthesizingVoice")
              : tCommon("aiProgress.transcribing"))
          }
          percent={readingAiProgress.percent}
          size="compact"
          testId="reading-ai-busy-progress"
        />
      ) : null}
      {pageProgress &&
      pageProgress.current_index === pageProgress.total_pages - 1 ? (
        <p
          data-reading-end-hint="true"
          className="hidden text-xs font-semibold text-primary sm:block sm:text-sm"
          role="status"
        >
          {t("session.lastPageHint")}
        </p>
      ) : null}
    </div>
  ) : null;

  return (
    <ReadingDynamicFallbackContext.Provider value={dynamicFallbackContextValue}>
      <div
        className="reading-shell"
        data-reading-shell="true"
        data-canonical-state={canonicalState}
        data-child-error-count={safety.child_error_events.length}
        data-evidence-valid={safety.evidence_valid}
        data-scoring-active={safety.scoring_active}
      >
        <ReadingLayout
          topBar={readingTopBar}
          audioLevel={speechRecorder.audioLevel}
          book={book}
          child={child}
          onChoosePage={() => void openPagePicker()}
          bookTitle={book.title}
          previewSnapshot={previewSnapshot}
          controlsDisabled={
            (uiState !== "reading" && uiState !== "tts-error") ||
            (isBusy && !speechPlayer.isPlaying) ||
            (retryMode && pageNavigationError !== null) ||
            (retryMode &&
              [
                "preparing-microphone",
                "playing-instruction",
                "playing-sample",
              ].includes(retryFeedback))
          }
          selfCorrectedWordIds={retryConfirmedWordIds}
          unresolvedWordIds={unresolvedRetryWordIds}
          uncertainWordIds={uncertainWordIds}
          progressLabel={
            pageProgress
              ? t("session.rangeCompletedSummary", {
                  completed: formatNumber(pageProgress.completed_pages),
                  total: formatNumber(pageProgress.total_pages),
                })
              : undefined
          }
          correctWordIds={
            retryConfirmedWordIds.size > 0
              ? new Set([...correctWordIds, ...retryConfirmedWordIds])
              : correctWordIds
          }
          countdown={countdown}
          currentWordId={previewSnapshot?.currentWordId ?? currentWordId}
          currentWordText={
            retryMode
              ? (retryCandidates[retryWordPosition]?.text ?? null)
              : (page.words.find(
                  (w) =>
                    w.word_id ===
                    (previewSnapshot?.currentWordId ?? currentWordId),
                )?.text ?? null)
          }
          exitHref={detailHref}
          onExit={() => setConfirmFinish(true)}
          voiceSettings={
            <DynamicPanelErrorBoundary
              closeLabel={tCommon("actions.close")}
              description={t("session.openFailedDescription")}
              resetKey={sessionId}
              retryLabel={tCommon("actions.retry")}
              title={tCommon("states.unavailable")}
              variant="compact"
            >
              <ReadingVoiceSettings
                childId={
                  loadState.status === "ready" ? loadState.data.child.id : null
                }
                disabled={isMicRecording}
                fallbackNotice={speechPlayer.fallbackNotice}
                isPreviewing={speechPlayer.isPlaying}
                onPreview={handleVoicePreview}
                onStopPreview={stopAssistantAudio}
              />
            </DynamicPanelErrorBoundary>
          }
          isCurrentWordMispronounced={Boolean(
            currentWordId && mispronouncedWordIds.has(currentWordId),
          )}
          isListening={isMicRecording}
          isMicRecording={isMicRecording}
          retryContextPhrase={retryMode ? retryPhrase : null}
          retryMode={retryMode}
          retryFocusKey={
            retryMode
              ? `${retryWordPosition}:${currentWordId ?? ""}:${Boolean(retryPhrase)}:${Boolean(activePhonicsLesson)}:${Boolean(retryRecording)}`
              : null
          }
          retryWordPosition={retryWordPosition + 1}
          retryWordCount={retryCandidates.length}
          retryFeedback={retryFeedback}
          isPageTransitioning={uiState === "page-turn"}
          isPlayingSample={
            speechPlayer.isPlaying &&
            (retryMode
              ? !isReadingWord &&
                !isPlayingPhonicsLesson &&
                !isPlayingTutorAudio
              : isPlayingPageSample)
          }
          isSamplePaused={speechPlayer.isPaused}
          readingMode={readingMode}
          onReadingModeChange={setReadingMode}
          onToggleSamplePause={() => {
            if (speechPlayer.isPaused)
              void speechPlayer.resume().catch(() => setUiState("tts-error"));
            else speechPlayer.pause();
          }}
          isReadingWord={isReadingWord}
          isSpeaking={speechRecorder.isSpeaking}
          latestTranscript={latestTranscript}
          mispronouncedWordIds={
            retryConfirmedWordIds.size > 0
              ? new Set(
                  [...mispronouncedWordIds].filter(
                    (wordId) => !retryConfirmedWordIds.has(wordId),
                  ),
                )
              : mispronouncedWordIds
          }
          onFinish={() => setConfirmFinish(true)}
          onHelp={() => void requestTutor()}
          onPause={() => void pauseReading()}
          onRetryMicrophonePermission={retryRetryMicrophonePermission}
          onRetryRead={retryCurrentWord}
          onRetrySave={() => void retryPendingRetryEvent()}
          retryRecording={
            retryMode &&
            retryRecording &&
            !isMicRecording &&
            !isBusy &&
            !speechPlayer.isPlaying ? (
              <>
                <Button
                  onClick={() => void retryPlayback.toggle(retryRecording)}
                  variant="quiet"
                >
                  <Volume2 aria-hidden="true" className="size-4" />
                  {retryPlayback.playing
                    ? t("session.stopSelfRecording")
                    : t("session.playSelfRecording")}
                </Button>
                {retryPlayback.error ? (
                  <StatusMessage tone="warning">
                    {retryPlayback.error}
                  </StatusMessage>
                ) : null}
              </>
            ) : undefined
          }
          onReadSample={() => void handleReadSample()}
          onReadWord={
            retryMode ? () => void handleReadSample() : handleReadCurrentWord
          }
          onSpellWord={handleSpellCurrentWord}
          phonicsPanel={
            activePhonicsLesson ? (
              <DynamicPanelErrorBoundary
                closeLabel={tCommon("actions.close")}
                description={t("session.openFailedDescription")}
                onClose={() => {
                  stopAssistantAudio();
                  setActivePhonicsLesson(null);
                  setActivePhonicsStepIndex(null);
                  setPhonicsStatusHint(null);
                }}
                resetKey={activePhonicsLesson.wordId}
                retryLabel={tCommon("actions.retry")}
                title={tCommon("states.unavailable")}
                variant="inline"
              >
                <PhonicsLessonCard
                  activeStepIndex={activePhonicsStepIndex}
                  compact
                  isAnalyzingAi={isAnalyzingPhonicsAi}
                  isListeningRetry={isMicRecording}
                  isPlayingPhonics={isPlayingPhonicsLesson}
                  isPlayingWord={isReadingWord}
                  lesson={activePhonicsLesson.plan}
                  onPlayPhonics={handleSpellCurrentWord}
                  onPlayWord={
                    retryMode
                      ? () => void handleReadSample()
                      : handleReadCurrentWord
                  }
                  onStopAudio={stopAssistantAudio}
                  onClose={() => {
                    stopAssistantAudio();
                    setActivePhonicsLesson(null);
                    setActivePhonicsStepIndex(null);
                    setPhonicsStatusHint(null);
                  }}
                  statusHint={phonicsStatusHint}
                />
              </DynamicPanelErrorBoundary>
            ) : null
          }
          onSkipRetryWord={skipRetryWord}
          onToggleListening={() => void handleToggleListening()}
          onWordClick={handleWordClick}
          page={page}
          spokenWords={spokenWords}
          skippedWordIds={
            retryConfirmedWordIds.size > 0
              ? new Set(
                  [...skippedWordIds].filter(
                    (wordId) => !retryConfirmedWordIds.has(wordId),
                  ),
                )
              : skippedWordIds
          }
          repeatedWordIds={repeatedWordIds}
          hesitationWordIds={hesitationWordIds}
          assistedWordIds={assistedWordIds}
          companionBubble={companionBubble}
          isCompanionSpeaking={
            speechPlayer.isPlaying &&
            !isPlayingPageSample &&
            !isPlayingPhonicsLesson &&
            !isReadingWord &&
            !isPlayingTutorAudio
          }
          comparisonResult={comparisonResult}
          sentenceReinforcementPanel={
            activeSentenceReinforcement ? (
              <div
                role="status"
                aria-live="polite"
                data-testid="sentence-reinforcement-banner"
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border-2 border-primary bg-cream px-4 py-3 shadow-xs"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="text-xs font-extrabold uppercase tracking-wide text-primary">
                    {t("session.reinforceSentence")}
                  </p>
                  <span className="sr-only">
                    {t("session.reinforceSentencePrompt", {
                      sentence: activeSentenceReinforcement.span.text,
                    })}
                  </span>
                  <p
                    aria-hidden="true"
                    className="viread-learning-content flex flex-wrap items-center gap-1.5 text-base font-bold text-ink sm:text-lg"
                    dir="ltr"
                    lang="vi"
                  >
                    {activeSentenceReinforcement.span.words.map((w, idx) => {
                      const matched =
                        activeSentenceReinforcement.matchedIndices.has(idx);
                      return (
                        <span
                          key={`${w.word_id}-${idx}`}
                          data-reinforce-matched={matched ? "true" : "false"}
                          className={
                            matched
                              ? "rounded-control bg-emerald-100 px-1.5 py-0.5 text-emerald-900 transition-colors duration-200"
                              : "rounded-control px-1.5 py-0.5 text-ink transition-colors duration-200"
                          }
                        >
                          {w.text}
                        </span>
                      );
                    })}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  className="h-10! min-h-10! w-auto! shrink-0 px-3! py-1! text-sm!"
                  onClick={() =>
                    void finishSentenceReinforcement(
                      alignmentEngineRef.current,
                      false,
                    )
                  }
                >
                  {t("session.skipSentenceReinforce")}
                </Button>
              </div>
            ) : null
          }
        >
          {uiState === "page-turn" ? (
            <StatusBanner className="fixed left-1/2 top-20 z-40 w-[calc(100%-32px)] max-w-[520px] -translate-x-1/2">
              {t("session.navigatingAndAligning")}
            </StatusBanner>
          ) : null}
        </ReadingLayout>
        {pickerIndex !== null && pageProgress ? (
          <ReadingSubpanelErrorBoundary
            fallback={(err, reset) => (
              <ReadingPagePickerFallback error={err} onResetBoundary={reset} />
            )}
          >
            <ReadingPagePickerModal
              isBusy={isBusy}
              onClose={closePagePicker}
              onConfirm={(index) => void navigateWithinRange(index, true)}
              onSelectIndex={setPickerIndex}
              pageNavigationError={pageNavigationError}
              pages={pageProgress.pages}
              pickerIndex={pickerIndex}
            />
          </ReadingSubpanelErrorBoundary>
        ) : retryPrompt ? (
          <ReadingStatusDialog
            body={adaptTextToTeacherPersona(
              t("session.retryPromptQuestion", {
                count: formatNumber(retryCandidates.length),
              }),
              getEffectiveTeacherPersona().gender,
            )}
            onClose={() => undefined}
            primaryAction={{
              isLoading: isBusy,
              label: t("session.retryAcceptAction"),
              onClick: () => {
                if (startRetrySession(retryCandidatesRef.current)) {
                  setRetryPrompt(false);
                }
              },
            }}
            secondaryAction={{
              label: t("session.retrySkipAction"),
              onClick: () => {
                retryModeRef.current = false;
                setRetryPrompt(false);
                void completeReadingSession();
              },
            }}
            title={t("session.retryModalTitle")}
          />
        ) : confirmFinish ? (
          <ReadingStatusDialog
            body={comparisonError ?? t("session.pauseModalBody")}
            closeOnEscape
            onClose={() => setConfirmFinish(false)}
            primaryAction={{
              isLoading: isBusy,
              label: t("session.saveAndStopAction"),
              onClick: () => void finishReading(),
            }}
            secondaryAction={{
              label: t("session.continueReadingAction"),
              onClick: () => setConfirmFinish(false),
            }}
            title={t("session.exitConfirmTitle")}
          />
        ) : uiState === "paused" ? (
          <ReadingStatusDialog
            body={t("session.exitConfirmBody")}
            closeOnEscape
            onClose={() => void resumeReading()}
            primaryAction={{
              isLoading: isBusy,
              label: t("session.continueReadingAction"),
              onClick: () => void resumeReading(),
            }}
            secondaryAction={{
              label: t("session.stopSessionAction"),
              onClick: () => setConfirmFinish(true),
            }}
            title={t("session.micPermissionTitle")}
          />
        ) : uiState === "microphone-denied" ? (
          <ReadingStatusDialog
            body={t("session.micPermissionBody")}
            onClose={() => undefined}
            primaryAction={{
              isLoading: isBusy,
              label: t("session.retry"),
              onClick: () => void retryMicrophonePermission(),
            }}
            secondaryAction={{
              label: t("session.safeFinishAction"),
              onClick: () => setConfirmFinish(true),
            }}
            title={t("session.noSpeechTitle")}
          />
        ) : uiState === "page-confidence-low" ? (
          <ReadingStatusDialog
            body={
              <div className="space-y-2">
                <p>{t("session.alignBookBody")}</p>
                <p>{t("session.pausedNoPageErrorBody")}</p>
              </div>
            }
            onClose={() => undefined}
            primaryAction={{
              isLoading: isBusy,
              label: t("session.retry"),
              onClick: () => void retryPageMatch(),
            }}
            secondaryAction={{
              label: t("session.choosePageAction"),
              disabled: !pageProgress || isBusy,
              onClick: () => void openPagePicker(),
            }}
            tertiaryAction={{
              label: t("session.safeFinishAction"),
              variant: "quiet",
              onClick: () => setConfirmFinish(true),
            }}
            title={t("session.cameraUnclearTitle")}
          />
        ) : uiState === "reconnecting" || uiState === "stt-error" ? (
          <ReadingStatusDialog
            body={
              <div className="space-y-2">
                <p>
                  {uiState === "stt-error"
                    ? t("session.sttErrorTitle")
                    : t("session.reconnectingTitle")}
                </p>
                <p>{t("session.disconnectedNote")}</p>
                {connectionState === "timed-out" ? (
                  <StatusMessage
                    title={t("session.reconnectFailedTitle")}
                    tone="error"
                  >
                    {t("session.reconnectFailedBody")}
                  </StatusMessage>
                ) : null}
              </div>
            }
            onClose={() => undefined}
            primaryAction={{
              isLoading: isBusy,
              label:
                uiState === "stt-error"
                  ? t("session.retryListenAction")
                  : t("session.reconnectAction"),
              onClick: () =>
                void reconnect(
                  uiState === "stt-error" ? "recover" : reconnectMode,
                ),
            }}
            secondaryAction={{
              label: t("session.safeFinishAction"),
              onClick: () => setConfirmFinish(true),
            }}
            title={
              uiState === "stt-error"
                ? t("session.sttBannerFallback")
                : t("session.reconnectingBannerFallback")
            }
          />
        ) : uiState === "tts-error" || tutorOpen ? (
          <DynamicPanelErrorBoundary
            closeLabel={tCommon("actions.close")}
            description={t("session.openFailedDescription")}
            onClose={closeTutor}
            resetKey={`${uiState}:${tutorOpen}:${tutorAction?.action_id ?? ""}`}
            retryLabel={tCommon("actions.retry")}
            title={tCommon("states.unavailable")}
            variant="floating"
          >
            <TutorMessage
              action={tutorAction}
              isPlaying={speechPlayer.isPlaying}
              isRetrying={isBusy}
              nonBlocking={uiState === "tts-error" && !tutorOpen}
              onClose={closeTutor}
              onRetry={() => void retryTutor()}
              ttsFailed={uiState === "tts-error"}
              word={currentWord}
            />
          </DynamicPanelErrorBoundary>
        ) : null}

        <span className="sr-only" aria-live="polite">
          {t("session.connectionStatusSummary", {
            state: t(`session.connectionStates.${connectionState}`),
          })}
        </span>
      </div>
    </ReadingDynamicFallbackContext.Provider>
  );
}

function getDurationMinutes(durationMs: number | null): number | null {
  if (durationMs === null) return null;
  return Math.ceil(Math.max(0, durationMs) / 60000);
}
