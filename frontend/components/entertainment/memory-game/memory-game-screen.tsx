"use client";

import {
  ArrowLeft,
  Brain,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Lightbulb,
  Mic,
  MicOff,
  RefreshCw,
  Sparkles,
  Star,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BookChildHeader } from "@/components/books/book-child-header";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { MemorySceneCanvas } from "@/components/entertainment/memory-game/memory-scene-canvas";
import { useAiProgress } from "@/hooks/use-ai-progress";
import {
  getEntertainmentPreferences,
  subscribeEntertainmentPreferences,
  useEntertainmentPreferences,
} from "@/hooks/use-entertainment-preferences";
import { useTranslations } from "@/hooks/use-i18n";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import {
  createMemoryGameService,
  type MemoryGameService,
} from "@/lib/api/memory-game-service";
import { isServiceError } from "@/lib/api/service-error";
import {
  createSpeechService,
  type SpeechService,
} from "@/lib/api/speech-service";
import { isInjectedTestSpeechRecognition } from "@/lib/reading/local-segment-speech-recognition";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import { cn } from "@/lib/utils/cn";
import type {
  MatchedFactDTO,
  MemoryEvaluationDTO,
  MemoryHintDTO,
  MemoryInputMode,
  MemoryRecallMode,
  MemorySessionDTO,
  MemorySessionSummaryDTO,
  MemoryThemeSelection,
  MemoryThemesCatalogDTO,
  MemoryTimerMode,
  MissedFactDTO,
} from "@/types/memory-game";

type GameStage =
  "SETUP" | "OBSERVE" | "RECALL" | "REVEAL" | "CREATIVE" | "SUMMARY";

interface BrowserSpeechRecognitionAlternative {
  readonly transcript: string;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: BrowserSpeechRecognitionResult;
  };
}

interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

const TTS_MIC_COOLDOWN_MS = 350;
const MEMORY_THEMES_PAGE_SIZE = 6;
const MEMORY_HISTORY_PAGE_SIZE = 6;

const FALLBACK_TIMER_OPTIONS: ReadonlyArray<{
  mode: MemoryTimerMode;
  seconds: number | null;
  labelKey: string;
  recommendedForKey: string;
}> = [
  {
    mode: "10S",
    seconds: 10,
    labelKey: "memoryGame.timers.10S.label",
    recommendedForKey: "memoryGame.timers.10S.recommended",
  },
  {
    mode: "20S",
    seconds: 20,
    labelKey: "memoryGame.timers.20S.label",
    recommendedForKey: "memoryGame.timers.20S.recommended",
  },
  {
    mode: "30S",
    seconds: 30,
    labelKey: "memoryGame.timers.30S.label",
    recommendedForKey: "memoryGame.timers.30S.recommended",
  },
  {
    mode: "60S",
    seconds: 60,
    labelKey: "memoryGame.timers.60S.label",
    recommendedForKey: "memoryGame.timers.60S.recommended",
  },
  {
    mode: "90S",
    seconds: 90,
    labelKey: "memoryGame.timers.90S.label",
    recommendedForKey: "memoryGame.timers.90S.recommended",
  },
  {
    mode: "120S",
    seconds: 120,
    labelKey: "memoryGame.timers.120S.label",
    recommendedForKey: "memoryGame.timers.120S.recommended",
  },
  {
    mode: "UNLIMITED",
    seconds: null,
    labelKey: "memoryGame.timers.UNLIMITED.label",
    recommendedForKey: "memoryGame.timers.UNLIMITED.recommended",
  },
];

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function renderStars(count: number, ariaLabel: string) {
  return (
    <span aria-label={ariaLabel} className="inline-flex items-center gap-1">
      {[1, 2, 3].map((idx) => (
        <Star
          key={idx}
          aria-hidden="true"
          className={`size-5 ${
            idx <= count
              ? "fill-amber-400 text-amber-500"
              : "fill-transparent text-border"
          }`}
        />
      ))}
    </span>
  );
}

export interface MemoryGameScreenProps {
  readonly service?: MemoryGameService;
}

export function MemoryGameScreen({ service }: MemoryGameScreenProps = {}) {
  const t = useTranslations("games");
  const tCommon = useTranslations("common");
  const defaultErrorMessage = t("memoryGame.defaultError");
  const memoryService = useMemo(
    () => service ?? createMemoryGameService(),
    [service],
  );
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const child = childState.status === "ready" ? childState.child : null;
  const childId = child?.id ?? null;
  const speechPlayer = useSpeechPlayer();
  const recorder = useSpeechRecorder();
  const speechService = useMemo<SpeechService>(() => createSpeechService(), []);
  const teacherPersona = useTeacherPersona();
  const {
    reducedMotion,
    calmSound,
    autopilotEnabled,
    toggleCalmSound,
    toggleAutopilot,
  } = useEntertainmentPreferences();

  const [urlFocusWords] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("focus") ?? "";
      return raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 6);
    } catch {
      return [];
    }
  });

  // Catalog & history
  const [catalog, setCatalog] = useState<MemoryThemesCatalogDTO | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [historyState, setHistory] = useState<{
    childId: string;
    items: MemorySessionSummaryDTO[];
  } | null>(null);
  const [themesPage, setThemesPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const history = historyState?.childId === childId ? historyState.items : [];
  const catalogLoading = catalog === null && catalogError === null;

  // Stage A — Setup selections
  const [selectedTheme, setSelectedTheme] =
    useState<MemoryThemeSelection>("random");
  const [timerMode, setTimerMode] = useState<MemoryTimerMode>("30S");
  const [recallMode, setRecallMode] = useState<MemoryRecallMode>("FREE_RECALL");
  const [showObservationGuide, setShowObservationGuide] = useState(true);
  const [showColorCues, setShowColorCues] = useState(true);
  const [hasCustomizedGradeDefaults, setHasCustomizedGradeDefaults] =
    useState(false);

  // Active session & stage progression
  const [stage, setStage] = useState<GameStage>("SETUP");
  const [session, setSession] = useState<MemorySessionDTO | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Stage B — Observe timer (starts STRICTLY AFTER sceneReady === true)
  const [sceneReady, setSceneReady] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  // Stage C — Recall, Progressive Hints & Supported Peek
  const [recallText, setRecallText] = useState("");
  const [recallInputMode, setRecallInputMode] =
    useState<MemoryInputMode>("TEXT");
  const [activeHint, setActiveHint] = useState<MemoryHintDTO | null>(null);
  const [isLoadingHint, setIsLoadingHint] = useState(false);
  const [isPeeking, setIsPeeking] = useState(false);
  const [peekRemaining, setPeekRemaining] = useState(0);
  const [peekNotice, setPeekNotice] = useState<string | null>(null);

  // Stage D — Creative Story Extension
  const [creativeText, setCreativeText] = useState("");
  const [creativeInputMode, setCreativeInputMode] =
    useState<MemoryInputMode>("TEXT");

  // Stage E & F — Evaluations & Interactive Spotlight
  const [recallEvaluation, setRecallEvaluation] =
    useState<MemoryEvaluationDTO | null>(null);
  const [creativeEvaluation, setCreativeEvaluation] =
    useState<MemoryEvaluationDTO | null>(null);
  const [focusedObjectId, setFocusedObjectId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const startProgress = useAiProgress({
    active: isStarting,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.preparing") },
      { atPct: 48, label: tCommon("aiProgress.analyzing") },
      { atPct: 84, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 6_000,
  });
  const hintProgress = useAiProgress({
    active: isLoadingHint,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.generatingHint") },
      { atPct: 74, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 4_000,
  });
  const submitProgress = useAiProgress({
    active: isSubmitting,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.evaluatingAnswer") },
      { atPct: 55, label: tCommon("aiProgress.analyzing") },
      { atPct: 85, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 8_000,
  });

  // Anti-TTS-Self-Capture Voice Lifecycle (matching G10) + Hands-Free Autopilot
  const [isListeningVoice, setIsListeningVoice] = useState(false);
  const [voiceTarget, setVoiceTarget] = useState<"RECALL" | "CREATIVE" | null>(
    null,
  );
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [isSpeakingPrompt, setIsSpeakingPrompt] = useState(false);
  const [micCountdown, setMicCountdown] = useState<{
    target: "RECALL" | "CREATIVE";
    seconds: number;
  } | null>(null);
  const [autoSubmitStage, setAutoSubmitStage] = useState<
    "RECALL" | "CREATIVE" | null
  >(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const recorderActiveRef = useRef(false);
  const recorderTargetRef = useRef<"RECALL" | "CREATIVE" | null>(null);
  const hadRecorderSpeechRef = useRef(false);
  const sttAbortRef = useRef<AbortController | null>(null);
  const recorderCancelRef = useRef(recorder.cancel);
  const isSpeakingPromptRef = useRef(false);
  const speakGenRef = useRef(0);
  const speechPlayerRef = useRef(speechPlayer);
  const ttsCooldownUntilRef = useRef<number>(0);
  const micArmTimeoutRef = useRef<number | null>(null);
  const peekIntervalRef = useRef<number | null>(null);
  const micCountdownTimerRef = useRef<number | null>(null);
  const silenceStopTimerRef = useRef<number | null>(null);
  const autoSubmitTimerRef = useRef<number | null>(null);
  const startVoiceCaptureRef = useRef<
    (
      target: "RECALL" | "CREATIVE",
      options?: { fromAutopilot?: boolean },
    ) => void
  >(() => undefined);
  const handleSubmitRecallRef = useRef<
    (overrideText?: string, overrideMode?: MemoryInputMode) => Promise<void>
  >(async () => undefined);
  const handleSubmitCreativeRef = useRef<
    (overrideText?: string, overrideMode?: MemoryInputMode) => Promise<void>
  >(async () => undefined);

  useEffect(() => {
    speechPlayerRef.current = speechPlayer;
    recorderCancelRef.current = recorder.cancel;
  }, [recorder.cancel, speechPlayer]);

  const clearSilenceStopTimer = useCallback(() => {
    if (silenceStopTimerRef.current !== null) {
      window.clearTimeout(silenceStopTimerRef.current);
      silenceStopTimerRef.current = null;
    }
  }, []);

  const cancelMicCountdown = useCallback(() => {
    if (micCountdownTimerRef.current !== null) {
      window.clearInterval(micCountdownTimerRef.current);
      micCountdownTimerRef.current = null;
    }
    setMicCountdown(null);
  }, []);

  const cancelAutoSubmit = useCallback(() => {
    if (autoSubmitTimerRef.current !== null) {
      window.clearTimeout(autoSubmitTimerRef.current);
      autoSubmitTimerRef.current = null;
    }
    setAutoSubmitStage(null);
  }, []);

  const startMicCountdown = useCallback(
    (target: "RECALL" | "CREATIVE", seconds = 3) => {
      if (
        isSubmittingRef.current ||
        (typeof document !== "undefined" &&
          document.visibilityState === "hidden")
      ) {
        return;
      }
      cancelMicCountdown();
      cancelAutoSubmit();
      setMicCountdown({ target, seconds });
      let remaining = seconds;
      micCountdownTimerRef.current = window.setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          if (micCountdownTimerRef.current !== null) {
            window.clearInterval(micCountdownTimerRef.current);
            micCountdownTimerRef.current = null;
          }
          setMicCountdown(null);
          if (
            !isSubmittingRef.current &&
            !(
              typeof document !== "undefined" &&
              document.visibilityState === "hidden"
            )
          ) {
            startVoiceCaptureRef.current(target, { fromAutopilot: true });
          }
        } else {
          setMicCountdown({ target, seconds: remaining });
        }
      }, 1000);
    },
    [cancelAutoSubmit, cancelMicCountdown],
  );

  const stopMicCapture = useCallback(() => {
    cancelMicCountdown();
    clearSilenceStopTimer();
    hadRecorderSpeechRef.current = false;
    sttAbortRef.current?.abort();
    sttAbortRef.current = null;
    if (recorderActiveRef.current) {
      recorderActiveRef.current = false;
      recorderTargetRef.current = null;
      recorderCancelRef.current();
    }
    if (micArmTimeoutRef.current !== null) {
      window.clearTimeout(micArmTimeoutRef.current);
      micArmTimeoutRef.current = null;
    }
    const active = recognitionRef.current;
    recognitionRef.current = null;
    if (active) {
      active.onresult = null;
      active.onerror = null;
      active.onend = null;
      try {
        active.abort();
      } catch {
        try {
          active.stop();
        } catch {
          // Ignore browser speech stop errors.
        }
      }
    }
    setIsListeningVoice(false);
    setVoiceTarget(null);
  }, [cancelMicCountdown, clearSilenceStopTimer]);

  const stopAllTts = useCallback(() => {
    speakGenRef.current += 1;
    const player = speechPlayerRef.current;
    const wasSpeaking = isSpeakingPromptRef.current || player.isPlaying;
    player.stop();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore unavailable synthesis cancel.
      }
    }
    isSpeakingPromptRef.current = false;
    setIsSpeakingPrompt(false);
    if (wasSpeaking) {
      ttsCooldownUntilRef.current = Date.now() + TTS_MIC_COOLDOWN_MS;
    }
  }, []);

  useEffect(() => {
    return subscribeEntertainmentPreferences(() => {
      if (!getEntertainmentPreferences().calmSound) {
        stopAllTts();
      }
    });
  }, [stopAllTts]);

  const speakVietnamesePrompt = useCallback(
    (text: string, options?: { wordSample?: boolean }) => {
      if (!calmSound) return;
      const adapted = options?.wordSample
        ? text.trim()
        : adaptTextToTeacherPersona(text, teacherPersona.gender);
      if (!adapted.trim()) return;
      // Anti-self-capture invariant: ALWAYS abort active mic BEFORE speaking TTS!
      cancelAutoSubmit();
      stopMicCapture();
      stopAllTts();
      const generation = speakGenRef.current;
      isSpeakingPromptRef.current = true;
      setIsSpeakingPrompt(true);

      const finishSpeak = () => {
        if (speakGenRef.current !== generation) return;
        isSpeakingPromptRef.current = false;
        setIsSpeakingPrompt(false);
        ttsCooldownUntilRef.current = Date.now() + TTS_MIC_COOLDOWN_MS;
      };

      void speechPlayerRef.current
        .play(
          adapted,
          options?.wordSample
            ? { wordSample: true, speedScale: 0.92 }
            : { coaching: true, utteranceKind: "game_prompt" },
        )
        .catch(() => undefined)
        .finally(finishSpeak);
    },
    [
      calmSound,
      cancelAutoSubmit,
      stopAllTts,
      stopMicCapture,
      teacherPersona.gender,
    ],
  );

  const stopRecorderAndTranscribe = useCallback(
    async (options?: { fromAutopilot?: boolean }) => {
      if (!recorderActiveRef.current) return;
      clearSilenceStopTimer();
      hadRecorderSpeechRef.current = false;
      const target = recorderTargetRef.current ?? "RECALL";
      recorderActiveRef.current = false;
      recorderTargetRef.current = null;
      setIsListeningVoice(false);
      setVoiceTarget(null);

      sttAbortRef.current?.abort();
      const controller = new AbortController();
      sttAbortRef.current = controller;

      try {
        const audioBlob = await recorder.stop();
        if (controller.signal.aborted || !audioBlob || audioBlob.size === 0) {
          return;
        }
        const keyterms = session
          ? Array.from(
              new Set([
                ...session.scene_spec.matched_focus_words,
                ...(session.scene_spec.creative_focus_words ?? []),
                ...urlFocusWords,
                ...session.scene_spec.objects.flatMap((obj) => [
                  obj.name_vi,
                  obj.color_vi,
                ]),
              ]),
            )
              .filter(Boolean)
              .slice(0, 18)
          : urlFocusWords;
        const sttRes = await speechService.transcribe(audioBlob, {
          languageCode: "vi",
          keyterms,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const transcript = sttRes.text?.trim() ?? "";
        if (!transcript) return;
        setVoiceNotice(null);
        if (target === "RECALL") {
          setRecallText((prev) =>
            prev.trim() ? `${prev.trim()} ${transcript}` : transcript,
          );
          setRecallInputMode("VOICE");
        } else {
          setCreativeText((prev) =>
            prev.trim() ? `${prev.trim()} ${transcript}` : transcript,
          );
          setCreativeInputMode("VOICE");
        }
        if (
          options?.fromAutopilot &&
          getEntertainmentPreferences().autopilotEnabled
        ) {
          const words = transcript.match(/\p{L}+/gu) ?? [];
          if (words.length >= 2) {
            cancelAutoSubmit();
            setAutoSubmitStage(target);
            autoSubmitTimerRef.current = window.setTimeout(() => {
              autoSubmitTimerRef.current = null;
              setAutoSubmitStage(null);
              if (target === "RECALL") {
                void handleSubmitRecallRef.current(transcript, "VOICE");
              } else {
                void handleSubmitCreativeRef.current(transcript, "VOICE");
              }
            }, 1500);
          }
        }
      } catch {
        if (!controller.signal.aborted && !options?.fromAutopilot) {
          setVoiceNotice(t("memoryGame.voiceDisconnected"));
        }
      } finally {
        if (sttAbortRef.current === controller) {
          sttAbortRef.current = null;
        }
      }
    },
    [
      cancelAutoSubmit,
      clearSilenceStopTimer,
      recorder,
      session,
      speechService,
      t,
      urlFocusWords,
    ],
  );

  const startVoiceCapture = useCallback(
    (target: "RECALL" | "CREATIVE", options?: { fromAutopilot?: boolean }) => {
      cancelMicCountdown();
      cancelAutoSubmit();
      clearSilenceStopTimer();
      if (isListeningVoice) {
        if (recorderActiveRef.current) {
          void stopRecorderAndTranscribe({ fromAutopilot: false });
        } else {
          stopMicCapture();
        }
        return;
      }

      // Anti-self-capture invariant: ALWAYS cancel TTS BEFORE arming microphone!
      stopAllTts();

      // Enforce SessionVoiceLock `local_only` child privacy: only invoke browser
      // SpeechRecognition when an isolated test mock is explicitly injected.
      // All real browsers (including Firefox & iOS WebView) use local MediaRecorder + server STT with keyterms.
      const rawCtor = getSpeechRecognitionCtor();
      const TestSpeechRecognition = isInjectedTestSpeechRecognition(rawCtor)
        ? rawCtor
        : null;

      const beginCapture = () => {
        micArmTimeoutRef.current = null;
        setActionError(null);

        if (TestSpeechRecognition) {
          setVoiceNotice(t("memoryGame.voiceListening"));
          try {
            const recognition = new TestSpeechRecognition();
            recognition.lang = "vi-VN";
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.onresult = (event) => {
              const pieces: string[] = [];
              for (let i = 0; i < event.results.length; i += 1) {
                const part = event.results[i]?.[0]?.transcript?.trim();
                if (part) pieces.push(part);
              }
              const transcript = pieces.join(" ").trim();
              if (!transcript) return;
              if (target === "RECALL") {
                setRecallText(transcript);
                setRecallInputMode("VOICE");
              } else {
                setCreativeText(transcript);
                setCreativeInputMode("VOICE");
              }
              if (getEntertainmentPreferences().autopilotEnabled) {
                clearSilenceStopTimer();
                const silenceMs =
                  (session?.child_grade ?? child?.grade ?? 2) <= 2
                    ? 2600
                    : 2000;
                silenceStopTimerRef.current = window.setTimeout(() => {
                  silenceStopTimerRef.current = null;
                  stopMicCapture();
                  const words = transcript.trim().match(/\p{L}+/gu) ?? [];
                  if (
                    words.length >= 2 &&
                    getEntertainmentPreferences().autopilotEnabled
                  ) {
                    cancelAutoSubmit();
                    setAutoSubmitStage(target);
                    autoSubmitTimerRef.current = window.setTimeout(() => {
                      autoSubmitTimerRef.current = null;
                      setAutoSubmitStage(null);
                      if (target === "RECALL") {
                        void handleSubmitRecallRef.current(transcript, "VOICE");
                      } else {
                        void handleSubmitCreativeRef.current(
                          transcript,
                          "VOICE",
                        );
                      }
                    }, 1500);
                  }
                }, silenceMs);
              }
            };
            recognition.onerror = () => {
              clearSilenceStopTimer();
              setVoiceNotice(t("memoryGame.voiceDisconnected"));
              stopMicCapture();
            };
            recognition.onend = () => {
              if (recognitionRef.current === recognition) {
                recognitionRef.current = null;
                setIsListeningVoice(false);
                setVoiceTarget(null);
              }
            };
            recognitionRef.current = recognition;
            setIsListeningVoice(true);
            setVoiceTarget(target);
            recognition.start();
          } catch {
            setVoiceNotice(t("memoryGame.voiceUnavailable"));
            stopMicCapture();
          }
          return;
        }

        const hasMediaMic =
          typeof navigator !== "undefined" &&
          typeof navigator.mediaDevices?.getUserMedia === "function";
        if (!hasMediaMic && typeof MediaRecorder === "undefined") {
          if (!options?.fromAutopilot) {
            setVoiceNotice(t("memoryGame.voiceUnsupported"));
          }
          return;
        }

        hadRecorderSpeechRef.current = false;
        void recorder
          .start()
          .then(() => {
            recorderActiveRef.current = true;
            recorderTargetRef.current = target;
            setIsListeningVoice(true);
            setVoiceTarget(target);
            setVoiceNotice(t("memoryGame.voiceListening"));
          })
          .catch(() => {
            recorderActiveRef.current = false;
            recorderTargetRef.current = null;
            setIsListeningVoice(false);
            setVoiceTarget(null);
            if (!options?.fromAutopilot) {
              setVoiceNotice(t("memoryGame.voiceUnavailable"));
            }
          });
      };

      const remainingCooldown = ttsCooldownUntilRef.current - Date.now();
      if (remainingCooldown > 0 && remainingCooldown <= TTS_MIC_COOLDOWN_MS) {
        // Brief guard against acoustic echo right after TTS stops
        micArmTimeoutRef.current = window.setTimeout(() => {
          beginCapture();
        }, remainingCooldown);
      } else {
        beginCapture();
      }
    },
    [
      cancelAutoSubmit,
      cancelMicCountdown,
      child?.grade,
      clearSilenceStopTimer,
      isListeningVoice,
      recorder,
      session?.child_grade,
      stopAllTts,
      stopMicCapture,
      stopRecorderAndTranscribe,
      t,
    ],
  );

  // Grade-adaptive silence auto-stop for local MediaRecorder voice capture
  useEffect(() => {
    if (!isListeningVoice || !recorderActiveRef.current || !autopilotEnabled) {
      clearSilenceStopTimer();
      return;
    }
    if (recorder.isSpeaking) {
      hadRecorderSpeechRef.current = true;
      clearSilenceStopTimer();
      return;
    }
    if (!hadRecorderSpeechRef.current) {
      return;
    }
    const silenceMs =
      (session?.child_grade ?? child?.grade ?? 2) <= 2 ? 2600 : 2000;
    clearSilenceStopTimer();
    silenceStopTimerRef.current = window.setTimeout(() => {
      silenceStopTimerRef.current = null;
      if (recorderActiveRef.current) {
        void stopRecorderAndTranscribe({ fromAutopilot: true });
      }
    }, silenceMs);
    return () => {
      clearSilenceStopTimer();
    };
  }, [
    autopilotEnabled,
    child?.grade,
    clearSilenceStopTimer,
    isListeningVoice,
    recorder.isSpeaking,
    session?.child_grade,
    stopRecorderAndTranscribe,
  ]);

  // Stop mic, TTS, and peek timers cleanly on backgrounding / unmount
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        cancelAutoSubmit();
        stopMicCapture();
        stopAllTts();
      }
    };
    const handleAndroidBg = () => {
      cancelAutoSubmit();
      stopMicCapture();
      stopAllTts();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    document.addEventListener("viread:android-background", handleAndroidBg);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      document.removeEventListener(
        "viread:android-background",
        handleAndroidBg,
      );
      cancelAutoSubmit();
      stopMicCapture();
      stopAllTts();
      if (peekIntervalRef.current) clearInterval(peekIntervalRef.current);
    };
  }, [cancelAutoSubmit, stopAllTts, stopMicCapture]);

  // Load theme catalog & child history
  useEffect(() => {
    if (!childId) return;
    const controller = new AbortController();

    void memoryService
      .getThemes(controller.signal)
      .then((themesData) => {
        if (controller.signal.aborted) return;
        setCatalog(themesData);
        setCatalogError(null);
        if (!hasCustomizedGradeDefaults && child) {
          const rec = themesData.grade_recommendations.find(
            (r) => r.grade === child.grade,
          );
          if (rec) {
            setTimerMode(rec.recommended_timer);
            setRecallMode(rec.recommended_recall_mode);
          }
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setCatalogError(
          isServiceError(err) ? err.message : defaultErrorMessage,
        );
      });

    return () => controller.abort();
  }, [
    child,
    childId,
    catalogRetry,
    defaultErrorMessage,
    hasCustomizedGradeDefaults,
    memoryService,
  ]);

  // History is optional and must never delay loading the playable catalog.
  useEffect(() => {
    if (!childId) return;
    const controller = new AbortController();
    void memoryService
      .listSessions(childId, 6, controller.signal)
      .then((recentSessions) => {
        if (!controller.signal.aborted)
          setHistory({ childId, items: recentSessions });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [childId, memoryService]);

  const handleSceneReady = useCallback(() => {
    setSceneReady(true);
  }, []);

  // Observation countdown — starts STRICTLY AFTER sceneReady === true and skips UNLIMITED
  useEffect(() => {
    if (stage !== "OBSERVE" || !session || !sceneReady) return;
    if (session.timer_mode === "UNLIMITED" || session.timer_seconds === null) {
      return;
    }
    if (remainingSeconds === null || remainingSeconds <= 0) return;

    const id = window.setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          setStage("RECALL");
          if (getEntertainmentPreferences().autopilotEnabled) {
            startMicCountdown("RECALL", 3);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(id);
  }, [remainingSeconds, sceneReady, session, stage, startMicCountdown]);

  const startNewSession = async () => {
    if (!childId || isStarting) return;
    cancelAutoSubmit();
    stopMicCapture();
    stopAllTts();
    setIsStarting(true);
    setActionError(null);
    setActiveHint(null);
    setPeekNotice(null);
    setRecallText("");
    setCreativeText("");
    setRecallInputMode("TEXT");
    setCreativeInputMode("TEXT");
    setRecallEvaluation(null);
    setCreativeEvaluation(null);
    setFocusedObjectId(null);
    setSceneReady(false);

    try {
      const created = await memoryService.createSession({
        child_id: childId,
        theme_key: selectedTheme,
        timer_mode: timerMode,
        recall_mode: recallMode,
        ...(urlFocusWords.length > 0 ? { focus_words: urlFocusWords } : {}),
      });
      setSession(created);
      setRemainingSeconds(created.timer_seconds);
      setStage("OBSERVE");
    } catch (err: unknown) {
      setActionError(isServiceError(err) ? err.message : defaultErrorMessage);
    } finally {
      setIsStarting(false);
    }
  };

  const finishObservingEarly = () => {
    stopAllTts();
    setStage("RECALL");
    if (getEntertainmentPreferences().autopilotEnabled) {
      void recorder.prepare?.().catch(() => undefined);
      startMicCountdown("RECALL", 3);
    }
  };

  const handleRequestHint = async () => {
    if (!session || isLoadingHint) return;
    cancelMicCountdown();
    cancelAutoSubmit();
    setIsLoadingHint(true);
    setActionError(null);
    try {
      const hint = await memoryService.requestHint(session.id, {
        mentioned_text: recallText,
      });
      setActiveHint(hint);
      setSession((prev) =>
        prev ? { ...prev, hints_used: hint.hints_used } : prev,
      );
    } catch (err: unknown) {
      setActionError(isServiceError(err) ? err.message : defaultErrorMessage);
    } finally {
      setIsLoadingHint(false);
    }
  };

  const handleSupportedPeek = async () => {
    if (!session || isPeeking) return;
    cancelAutoSubmit();
    stopMicCapture();
    setActionError(null);
    try {
      const peek = await memoryService.recordPeek(session.id);
      setSession((prev) =>
        prev ? { ...prev, peek_count: peek.peek_count } : prev,
      );
      setPeekNotice(peek.message_vi);
      setIsPeeking(true);
      setPeekRemaining(peek.peek_duration_seconds);

      if (peekIntervalRef.current) clearInterval(peekIntervalRef.current);
      peekIntervalRef.current = window.setInterval(() => {
        setPeekRemaining((prev) => {
          if (prev <= 1) {
            if (peekIntervalRef.current) {
              clearInterval(peekIntervalRef.current);
              peekIntervalRef.current = null;
            }
            setIsPeeking(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err: unknown) {
      setActionError(isServiceError(err) ? err.message : defaultErrorMessage);
    }
  };

  const handleSubmitRecall = async (
    overrideText?: string,
    overrideMode?: MemoryInputMode,
  ) => {
    cancelMicCountdown();
    cancelAutoSubmit();
    if (!session || isSubmittingRef.current) return;
    const trimmed = (overrideText ?? recallText).trim();
    const effectiveMode = overrideMode ?? recallInputMode;
    if (!trimmed) {
      setActionError(t("memoryGame.recallEmptyError"));
      return;
    }
    stopMicCapture();
    stopAllTts();
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setActionError(null);

    try {
      const result = await memoryService.submitAttempt(session.id, {
        stage: "RECALL",
        input_mode: effectiveMode,
        response_text: trimmed,
        teacher_gender: teacherPersona.gender,
      });
      setSession(result.session);
      setRecallEvaluation(result.attempt.evaluation);
      const firstMissed = result.attempt.evaluation.missed_facts[0];
      setFocusedObjectId(firstMissed ? firstMissed.object_id : null);
      setStage("REVEAL");
      if (
        effectiveMode === "VOICE" &&
        getEntertainmentPreferences().autopilotEnabled &&
        getEntertainmentPreferences().calmSound &&
        result.attempt.evaluation.praise_message_vi
      ) {
        speakVietnamesePrompt(result.attempt.evaluation.praise_message_vi);
      }
    } catch (err: unknown) {
      // Preserve child's recall draft cleanly on transient error!
      setActionError(isServiceError(err) ? err.message : defaultErrorMessage);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleSubmitCreative = async (
    overrideText?: string,
    overrideMode?: MemoryInputMode,
  ) => {
    cancelMicCountdown();
    cancelAutoSubmit();
    if (!session || isSubmittingRef.current) return;
    const trimmed = (overrideText ?? creativeText).trim();
    const effectiveMode = overrideMode ?? creativeInputMode;
    if (!trimmed) {
      setActionError(t("memoryGame.creativeEmptyError"));
      return;
    }
    stopMicCapture();
    stopAllTts();
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setActionError(null);

    try {
      const result = await memoryService.submitAttempt(session.id, {
        stage: "CREATIVE",
        input_mode: effectiveMode,
        response_text: trimmed,
        teacher_gender: teacherPersona.gender,
      });
      setSession(result.session);
      setCreativeEvaluation(result.attempt.evaluation);
      setStage("SUMMARY");
      if (
        effectiveMode === "VOICE" &&
        getEntertainmentPreferences().autopilotEnabled &&
        getEntertainmentPreferences().calmSound &&
        (result.attempt.evaluation.story_praise_vi ||
          result.attempt.evaluation.praise_message_vi)
      ) {
        speakVietnamesePrompt(
          result.attempt.evaluation.story_praise_vi ||
            result.attempt.evaluation.praise_message_vi,
        );
      }
      if (childId) {
        void memoryService
          .listSessions(childId, 6)
          .then((items) => setHistory({ childId, items }))
          .catch(() => undefined);
      }
    } catch (err: unknown) {
      setActionError(isServiceError(err) ? err.message : defaultErrorMessage);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };
  useEffect(() => {
    startVoiceCaptureRef.current = startVoiceCapture;
    handleSubmitRecallRef.current = handleSubmitRecall;
    handleSubmitCreativeRef.current = handleSubmitCreative;
  });

  const resetToSetup = () => {
    cancelAutoSubmit();
    stopMicCapture();
    stopAllTts();
    if (peekIntervalRef.current) {
      clearInterval(peekIntervalRef.current);
      peekIntervalRef.current = null;
    }
    setIsPeeking(false);
    setStage("SETUP");
    setSession(null);
    setSceneReady(false);
    setActiveHint(null);
    setRecallEvaluation(null);
    setCreativeEvaluation(null);
    setFocusedObjectId(null);
    setActionError(null);
  };

  const matchedFacts: readonly MatchedFactDTO[] = useMemo(
    () => recallEvaluation?.matched_facts ?? [],
    [recallEvaluation],
  );
  const missedFacts: readonly MissedFactDTO[] = useMemo(
    () => recallEvaluation?.missed_facts ?? [],
    [recallEvaluation],
  );

  const matchedObjectIds = useMemo(
    () => new Set(matchedFacts.map((f) => f.object_id)),
    [matchedFacts],
  );
  const missedObjectIds = useMemo(
    () => new Set(missedFacts.map((f) => f.object_id)),
    [missedFacts],
  );

  const focusedObject = useMemo(() => {
    if (!session || !focusedObjectId) return null;
    return (
      session.scene_spec.objects.find((obj) => obj.id === focusedObjectId) ??
      null
    );
  }, [focusedObjectId, session]);

  if (childState.status === "loading") {
    return (
      <section className="mx-auto flex w-full max-w-[1040px] flex-col gap-4">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-72 w-full rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[1040px] flex-col gap-4">
        <StatusMessage tone="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t("memoryGame.childLoadError")}</span>
            <Button
              fullWidth={false}
              onClick={retryChild}
              size="compact"
              variant="secondary"
            >
              {t("memoryGame.retry")}
            </Button>
          </div>
        </StatusMessage>
      </section>
    );
  }

  if (childState.status === "redirecting" || !child) {
    return (
      <section className="mx-auto flex w-full max-w-[1040px] flex-col gap-4">
        <EmptyState
          action={
            <ButtonLink fullWidth={false} href="/children" size="compact">
              {t("memoryGame.selectChildAction")}
            </ButtonLink>
          }
          description={t("memoryGame.noChildDescription")}
          title={t("memoryGame.noChildTitle")}
        />
      </section>
    );
  }

  const timerOptions = catalog?.timer_options
    ? catalog.timer_options.map((opt) => ({
        mode: opt.mode,
        seconds: opt.seconds,
        label: opt.label_vi,
        recommendedFor: opt.recommended_for_vi,
      }))
    : FALLBACK_TIMER_OPTIONS.map((opt) => ({
        mode: opt.mode,
        seconds: opt.seconds,
        label: t(opt.labelKey),
        recommendedFor: t(opt.recommendedForKey),
      }));
  const gradeRec = catalog?.grade_recommendations.find(
    (item) => item.grade === child.grade,
  );

  // Calm SVG countdown ring geometry
  const totalSec = session?.timer_seconds ?? 0;
  const ringRadius = 24;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const progressFraction =
    totalSec > 0 && remainingSeconds !== null
      ? Math.max(0, Math.min(1, remainingSeconds / totalSec))
      : 1;
  const ringDashOffset = ringCircumference * (1 - progressFraction);

  const displayFactualScore =
    session?.best_factual_score ?? recallEvaluation?.factual_score ?? 0;
  const displayCreativeScore =
    session?.best_creative_score ?? creativeEvaluation?.creative_score ?? 0;

  const creativeMagicWords = session
    ? Array.from(
        new Set([
          ...(session.scene_spec.creative_focus_words ?? []),
          ...session.scene_spec.matched_focus_words,
        ]),
      )
    : [];

  return (
    <section
      className={cn(
        "mx-auto flex w-full max-w-[1060px] flex-col gap-5 pb-10",
        reducedMotion && "motion-reduce",
      )}
      data-autopilot={autopilotEnabled ? "true" : "false"}
      data-calm-sound={calmSound ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-stage={stage}
      data-testid="memory-game-screen"
    >
      <BookChildHeader
        backHref="/entertainment"
        child={child}
        mobileLabel={t("memoryGame.mobileLabel")}
      />

      {/* Top navigation & child header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex flex-col gap-1">
          <Link className="family-inline-link w-fit" href="/entertainment">
            <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
            {t("memoryGame.backToEntertainment")}
          </Link>
          <h1 className="book-title flex items-center gap-2.5 text-3xl text-ink sm:text-4xl">
            <Brain aria-hidden="true" className="size-8 text-primary" />
            {t("memoryGame.heading")}
          </h1>
          <p className="text-body text-muted">{t("memoryGame.lead")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            aria-pressed={autopilotEnabled}
            className="min-h-11"
            data-testid="memory-autopilot-toggle"
            fullWidth={false}
            onClick={() => {
              if (autopilotEnabled) {
                cancelMicCountdown();
                cancelAutoSubmit();
              }
              toggleAutopilot();
            }}
            size="compact"
            type="button"
            variant={autopilotEnabled ? "secondary" : "quiet"}
          >
            <Mic aria-hidden="true" className="size-4" />
            {autopilotEnabled
              ? t("memoryGame.autopilotOn", undefined, "Tự động rảnh tay: Bật")
              : t(
                  "memoryGame.autopilotOff",
                  undefined,
                  "Tự động rảnh tay: Tắt",
                )}
          </Button>
          <Button
            aria-pressed={!calmSound}
            className="min-h-11"
            fullWidth={false}
            onClick={toggleCalmSound}
            size="compact"
            type="button"
            variant="quiet"
          >
            {calmSound ? (
              <Volume2 aria-hidden="true" className="size-4" />
            ) : (
              <VolumeX aria-hidden="true" className="size-4" />
            )}
            {calmSound ? t("memoryGame.calmSound") : t("memoryGame.soundMuted")}
          </Button>
        </div>
      </div>

      {/* Stage progress pills */}
      <nav
        aria-label={t("memoryGame.stepsNavAria")}
        className="flex flex-wrap items-center gap-2"
      >
        {(
          [
            ["SETUP", t("memoryGame.steps.setup")],
            ["OBSERVE", t("memoryGame.steps.observe")],
            ["RECALL", t("memoryGame.steps.recall")],
            ["REVEAL", t("memoryGame.steps.reveal")],
            ["CREATIVE", t("memoryGame.steps.creative")],
            ["SUMMARY", t("memoryGame.steps.summary")],
          ] as const
        ).map(([stepKey, label]) => {
          const isCurrent = stage === stepKey;
          return (
            <span
              key={stepKey}
              aria-current={isCurrent ? "step" : undefined}
              className={`rounded-full px-3 py-1 text-sm font-bold transition-colors ${
                isCurrent
                  ? "bg-primary text-white"
                  : "bg-cream text-muted border border-border"
              }`}
            >
              {label}
            </span>
          );
        })}
      </nav>

      {actionError ? (
        <StatusMessage tone="error">{actionError}</StatusMessage>
      ) : null}

      {/* ===================== STAGE A: SETUP ===================== */}
      {stage === "SETUP" ? (
        <div className="flex flex-col gap-5">
          {catalogError ? (
            <StatusMessage tone="error">
              {catalogError}
              <Button
                data-testid="retry-memory-catalog-btn"
                fullWidth={false}
                onClick={() => {
                  setCatalogError(null);
                  setCatalogRetry((value) => value + 1);
                }}
                size="compact"
                variant="secondary"
              >
                <RefreshCw aria-hidden="true" className="size-4" />
                {t("memoryGame.retry")}
              </Button>
            </StatusMessage>
          ) : null}

          {gradeRec ? (
            <div className="rounded-card border border-border bg-sky px-5 py-4 text-ink">
              <p
                className="viread-learning-content text-body font-bold"
                dir="ltr"
                lang="vi"
              >
                {gradeRec.note_vi}
              </p>
            </div>
          ) : null}

          {/* Theme selector */}
          <div className="rounded-card border border-border bg-white p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-extrabold text-ink">
                {t("memoryGame.chooseThemeHeading")}
              </h2>
              <button
                aria-pressed={selectedTheme === "random"}
                className={`min-h-11 rounded-control border px-4 py-2 text-sm font-bold transition-colors ${
                  selectedTheme === "random"
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-cream text-ink hover:bg-sky"
                }`}
                onClick={() => setSelectedTheme("random")}
                type="button"
              >
                {t("memoryGame.randomThemeButton")}
              </button>
            </div>

            {catalogLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <Skeleton key={n} className="h-28 rounded-card" />
                ))}
              </div>
            ) : (
              (() => {
                const allThemes = catalog?.themes ?? [];
                const totalThemesPages = Math.max(
                  1,
                  Math.ceil(allThemes.length / MEMORY_THEMES_PAGE_SIZE),
                );
                const safeThemesPage = Math.min(
                  Math.max(1, themesPage),
                  totalThemesPages,
                );
                const visibleThemes = allThemes.slice(
                  (safeThemesPage - 1) * MEMORY_THEMES_PAGE_SIZE,
                  safeThemesPage * MEMORY_THEMES_PAGE_SIZE,
                );
                return (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {visibleThemes.map((theme) => {
                        const isActive = selectedTheme === theme.theme_key;
                        return (
                          <button
                            key={theme.theme_key}
                            aria-pressed={isActive}
                            className={`flex flex-col items-start gap-2 rounded-card border-2 p-4 text-start transition-colors ${
                              isActive
                                ? "border-primary bg-sky/70"
                                : "border-border bg-cream hover:border-primary/50"
                            }`}
                            onClick={() => setSelectedTheme(theme.theme_key)}
                            type="button"
                          >
                            <div className="flex w-full items-center justify-between gap-2">
                              <span
                                className="viread-learning-content text-lg font-extrabold text-ink"
                                dir="ltr"
                                lang="vi"
                              >
                                {theme.name_vi}
                              </span>
                              <span
                                className="viread-learning-content rounded-full px-2.5 py-0.5 text-xs font-bold text-white"
                                dir="ltr"
                                lang="vi"
                                style={{ backgroundColor: theme.accent_hex }}
                              >
                                {theme.badge_vi}
                              </span>
                            </div>
                            <p
                              className="viread-learning-content text-sm leading-5 text-muted"
                              dir="ltr"
                              lang="vi"
                            >
                              {theme.description_vi}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                    <PaginationBar
                      className="mt-4"
                      compact
                      onPageChange={setThemesPage}
                      page={safeThemesPage}
                      pageSize={MEMORY_THEMES_PAGE_SIZE}
                      total={allThemes.length}
                    />
                  </>
                );
              })()
            )}
          </div>

          {/* Timer & Recall mode */}
          <div className="grid gap-5 md:grid-cols-2">
            <div className="rounded-card border border-border bg-white p-5">
              <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold text-ink">
                <Clock aria-hidden="true" className="size-5 text-primary" />
                {t("memoryGame.timerHeading")}
              </h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {timerOptions.map((opt) => {
                  const isActive = timerMode === opt.mode;
                  return (
                    <button
                      key={opt.mode}
                      aria-pressed={isActive}
                      className={`flex flex-col items-start rounded-control border px-3 py-2.5 text-start transition-colors ${
                        isActive
                          ? "border-primary bg-primary text-white"
                          : "border-border bg-cream text-ink hover:bg-sky"
                      }`}
                      data-testid={`timer-option-${opt.mode}`}
                      onClick={() => {
                        setTimerMode(opt.mode);
                        setHasCustomizedGradeDefaults(true);
                      }}
                      type="button"
                    >
                      <span className="text-base font-extrabold">
                        {opt.label}
                      </span>
                      <span
                        className={`text-xs ${isActive ? "text-white/90" : "text-muted"}`}
                      >
                        {opt.recommendedFor}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-4 rounded-card border border-border bg-white p-5">
              <div>
                <h2 className="mb-3 text-lg font-extrabold text-ink">
                  {t("memoryGame.recallModeHeading")}
                </h2>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      [
                        "FREE_RECALL",
                        t("memoryGame.freeRecallTitle"),
                        t("memoryGame.freeRecallDesc"),
                      ],
                      [
                        "GUIDED_RECALL",
                        t("memoryGame.guidedRecallTitle"),
                        t("memoryGame.guidedRecallDesc"),
                      ],
                    ] as const
                  ).map(([modeValue, title, desc]) => {
                    const active = recallMode === modeValue;
                    return (
                      <button
                        key={modeValue}
                        aria-pressed={active}
                        className={`flex flex-col items-start gap-1 rounded-control border p-3 text-start transition-colors ${
                          active
                            ? "border-primary bg-sky text-ink"
                            : "border-border bg-cream text-ink hover:bg-sky/50"
                        }`}
                        onClick={() => {
                          setRecallMode(modeValue);
                          setHasCustomizedGradeDefaults(true);
                        }}
                        type="button"
                      >
                        <span className="font-extrabold">{title}</span>
                        <span className="text-xs text-muted">{desc}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-2.5 border-t border-border pt-3">
                <label className="flex cursor-pointer items-center gap-3 text-sm font-bold text-ink">
                  <input
                    checked={showObservationGuide}
                    className="size-5 accent-primary"
                    onChange={(e) => setShowObservationGuide(e.target.checked)}
                    type="checkbox"
                  />
                  {t("memoryGame.showObservationGuideLabel")}
                </label>
                <label className="flex cursor-pointer items-center gap-3 text-sm font-bold text-ink">
                  <input
                    checked={showColorCues}
                    className="size-5 accent-primary"
                    onChange={(e) => setShowColorCues(e.target.checked)}
                    type="checkbox"
                  />
                  {t("memoryGame.showColorCuesLabel")}
                </label>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center gap-3">
            <Button
              className="max-w-md text-lg"
              data-testid="start-memory-game-btn"
              isLoading={isStarting}
              onClick={() => void startNewSession()}
            >
              <Sparkles aria-hidden="true" className="size-5" />
              {t("memoryGame.startObserveButton")}
            </Button>
            {isStarting ? (
              <div className="w-full max-w-md">
                <AiProgressBar
                  active
                  label={
                    startProgress.stageLabel ?? tCommon("aiProgress.preparing")
                  }
                  percent={startProgress.percent}
                  size="sm"
                  testId="memory-game-starting-progress"
                />
              </div>
            ) : null}
          </div>

          {/* Recent sessions */}
          {history.length > 0
            ? (() => {
                const totalHistoryPages = Math.max(
                  1,
                  Math.ceil(history.length / MEMORY_HISTORY_PAGE_SIZE),
                );
                const safeHistoryPage = Math.min(
                  Math.max(1, historyPage),
                  totalHistoryPages,
                );
                const visibleHistory = history.slice(
                  (safeHistoryPage - 1) * MEMORY_HISTORY_PAGE_SIZE,
                  safeHistoryPage * MEMORY_HISTORY_PAGE_SIZE,
                );
                return (
                  <div className="rounded-card border border-border bg-cream p-5">
                    <h2 className="mb-3 text-lg font-extrabold text-ink">
                      {t("memoryGame.recentHeading")}
                    </h2>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {visibleHistory.map((item) => (
                        <div
                          key={item.id}
                          className="flex flex-col gap-1.5 rounded-control border border-border bg-white p-3.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className="viread-learning-content font-extrabold text-ink"
                              dir="ltr"
                              lang="vi"
                            >
                              {item.theme_name_vi}
                            </span>
                            {renderStars(
                              item.stars,
                              t("memoryGame.starsAria", { count: item.stars }),
                            )}
                          </div>
                          <p className="text-xs text-muted">
                            {t("memoryGame.historyDetailsCount", {
                              count: item.object_count,
                            })}{" "}
                            ·{" "}
                            {item.timer_seconds
                              ? `${item.timer_seconds}s`
                              : t("memoryGame.timers.UNLIMITED.label")}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-2 text-xs font-bold">
                            <span className="rounded-full bg-success-surface px-2.5 py-0.5 text-success-ink">
                              {t("memoryGame.historyMemoryScore", {
                                score: item.best_factual_score,
                              })}
                            </span>
                            <span className="rounded-full bg-purple px-2.5 py-0.5 text-purple-ink">
                              {t("memoryGame.historyCreativeScore", {
                                score: item.best_creative_score,
                              })}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <PaginationBar
                      className="mt-4"
                      compact
                      onPageChange={setHistoryPage}
                      page={safeHistoryPage}
                      pageSize={MEMORY_HISTORY_PAGE_SIZE}
                      total={history.length}
                    />
                  </div>
                );
              })()
            : null}
        </div>
      ) : null}

      {/* ===================== STAGE B: OBSERVE ===================== */}
      {stage === "OBSERVE" && session ? (
        <div className="flex flex-col gap-4" data-testid="observe-stage">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-border bg-white p-4">
            <div className="flex items-center gap-3">
              {session.timer_mode === "UNLIMITED" ||
              session.timer_seconds === null ? (
                <div
                  className="flex items-center gap-2 rounded-full bg-sky px-4 py-2 font-extrabold text-primary-hover"
                  data-testid="timer-unlimited-badge"
                >
                  <Clock aria-hidden="true" className="size-5" />
                  {t("memoryGame.unlimitedTimeBadge")}
                </div>
              ) : (
                <div
                  className="flex items-center gap-3"
                  data-testid="observe-countdown"
                >
                  <svg
                    aria-hidden="true"
                    className="size-14 -rotate-90"
                    viewBox="0 0 60 60"
                  >
                    <circle
                      cx={30}
                      cy={30}
                      r={ringRadius}
                      fill="none"
                      stroke="#E2EFEA"
                      strokeWidth={6}
                    />
                    <circle
                      cx={30}
                      cy={30}
                      r={ringRadius}
                      fill="none"
                      stroke="#087467"
                      strokeDasharray={ringCircumference}
                      strokeDashoffset={ringDashOffset}
                      strokeLinecap="round"
                      strokeWidth={6}
                    />
                  </svg>
                  <div>
                    <p
                      className="text-2xl font-extrabold tabular-nums text-ink"
                      data-testid="countdown-seconds"
                    >
                      {sceneReady
                        ? t("memoryGame.secondsLeft", {
                            seconds: remainingSeconds ?? session.timer_seconds,
                          })
                        : t("memoryGame.preparingScene")}
                    </p>
                    <p className="text-xs font-semibold text-muted">
                      {t("memoryGame.observeCarefullyHint")}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-testid="finish-observe-btn"
                fullWidth={false}
                onClick={finishObservingEarly}
                size="compact"
              >
                <CheckCircle2 aria-hidden="true" className="size-4" />
                {t("memoryGame.finishObserveButton")}
              </Button>
            </div>
          </div>

          <MemorySceneCanvas
            mode="observe"
            onSceneReady={handleSceneReady}
            reducedMotion={reducedMotion}
            sceneSpec={session.scene_spec}
            showColorCues={showColorCues}
          />

          {session.scene_spec.matched_focus_words.length > 0 ? (
            <div className="rounded-control border border-border bg-purple/60 px-4 py-2.5 text-sm font-bold text-purple-ink">
              {t("memoryGame.focusWordsInScene")}{" "}
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {session.scene_spec.matched_focus_words.join(", ")}
              </span>
            </div>
          ) : null}

          {showObservationGuide &&
          session.scene_spec.observation_tips_vi.length > 0 ? (
            <div className="rounded-card border border-border bg-cream p-4">
              <p className="mb-1.5 flex items-center gap-2 text-sm font-extrabold text-ink">
                <Lightbulb aria-hidden="true" className="size-4 text-warning" />
                {t("memoryGame.observationTipsHeading")}
              </p>
              <ul className="list-disc space-y-1 ps-5 text-sm text-muted">
                {session.scene_spec.observation_tips_vi.map((tip) => (
                  <li
                    className="viread-learning-content"
                    dir="ltr"
                    key={tip}
                    lang="vi"
                  >
                    {adaptTextToTeacherPersona(tip, teacherPersona.gender)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ===================== STAGE C: RECALL (HIDDEN SCENE) ===================== */}
      {stage === "RECALL" && session ? (
        <div className="flex flex-col gap-5" data-testid="recall-stage">
          {isPeeking ? (
            <div
              className="flex flex-col gap-3"
              data-testid="supported-peek-view"
            >
              <div className="flex items-center justify-between rounded-control bg-warning-surface px-4 py-2.5 font-bold text-warning">
                <span className="flex items-center gap-2">
                  <Eye aria-hidden="true" className="size-5" />
                  {t("memoryGame.peekingCountdown", { seconds: peekRemaining })}
                </span>
                <span>
                  {t("memoryGame.peekCountLabel", {
                    count: session.peek_count,
                  })}
                </span>
              </div>
              <MemorySceneCanvas
                mode="peek"
                reducedMotion={reducedMotion}
                sceneSpec={session.scene_spec}
                showColorCues={showColorCues}
              />
            </div>
          ) : (
            <div
              className="flex flex-col items-center justify-center gap-3 rounded-card border-2 border-dashed border-primary/40 bg-sky/45 px-6 py-10 text-center"
              data-testid="scene-hidden-curtain"
            >
              <div className="grid size-16 place-items-center rounded-full bg-white text-primary shadow-xs">
                <EyeOff aria-hidden="true" className="size-8" />
              </div>
              <h2 className="text-2xl font-extrabold text-ink">
                {t("memoryGame.curtainTitle")}
              </h2>
              <p className="max-w-xl text-body text-muted">
                {t("memoryGame.curtainPromptPrefix")}{" "}
                <strong className="viread-learning-content" dir="ltr" lang="vi">
                  “{session.theme_name_vi}”
                </strong>{" "}
                {t("memoryGame.curtainPromptSuffix")}
              </p>
              {isLoadingHint ? (
                <div className="mx-auto w-full max-w-sm">
                  <AiProgressBar
                    active
                    label={
                      hintProgress.stageLabel ??
                      tCommon("aiProgress.generatingHint")
                    }
                    percent={hintProgress.percent}
                    size="compact"
                    testId="memory-game-hint-progress"
                  />
                </div>
              ) : null}
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                <Button
                  data-testid="request-hint-btn"
                  fullWidth={false}
                  isLoading={isLoadingHint}
                  onClick={() => void handleRequestHint()}
                  size="compact"
                  variant="secondary"
                >
                  <Lightbulb aria-hidden="true" className="size-4" />
                  {t("memoryGame.hintButton", { count: session.hints_used })}
                </Button>
                <Button
                  data-testid="supported-peek-btn"
                  fullWidth={false}
                  onClick={() => void handleSupportedPeek()}
                  size="compact"
                  variant="quiet"
                >
                  <Eye aria-hidden="true" className="size-4" />
                  {t("memoryGame.peekButton", { count: session.peek_count })}
                </Button>
                <Button
                  disabled={!calmSound}
                  fullWidth={false}
                  onClick={() =>
                    isSpeakingPrompt
                      ? stopAllTts()
                      : speakVietnamesePrompt(
                          t("memoryGame.recallTtsPrompt", {
                            theme: session.theme_name_vi,
                          }),
                        )
                  }
                  size="compact"
                  variant="quiet"
                >
                  {isSpeakingPrompt ? (
                    <VolumeX aria-hidden="true" className="size-4" />
                  ) : (
                    <Volume2 aria-hidden="true" className="size-4" />
                  )}
                  {isSpeakingPrompt
                    ? t("memoryGame.stopAudio")
                    : t("memoryGame.listenGuide")}
                </Button>
              </div>
            </div>
          )}

          {peekNotice ? (
            <div className="rounded-control border border-border bg-warning-surface/70 px-4 py-2.5 text-sm font-semibold text-warning">
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {adaptTextToTeacherPersona(peekNotice, teacherPersona.gender)}
              </span>
            </div>
          ) : null}

          {activeHint ? (
            <div
              className="rounded-card border border-amber-300 bg-warning-surface p-4 text-ink"
              data-testid="memory-hint-card"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-extrabold text-warning">
                  {t("memoryGame.hintTierBadge", { tier: activeHint.tier })}
                </span>
                <span className="text-xs font-bold text-muted">
                  {t("memoryGame.remainingDetails", {
                    count: activeHint.remaining_unmentioned_count,
                  })}
                </span>
              </div>
              <p
                className="viread-learning-content text-body font-bold"
                dir="ltr"
                lang="vi"
              >
                {adaptTextToTeacherPersona(
                  activeHint.hint_text_vi,
                  teacherPersona.gender,
                )}
              </p>
            </div>
          ) : null}

          {session.recall_mode === "GUIDED_RECALL" &&
          session.scene_spec.guided_questions_vi.length > 0 ? (
            <div className="rounded-card border border-border bg-cream p-4">
              <p className="mb-2 text-sm font-extrabold text-ink">
                {t("memoryGame.guidedQuestionsHeading")}
              </p>
              <ul className="list-disc space-y-1 ps-5 text-sm text-muted">
                {session.scene_spec.guided_questions_vi.map((q) => (
                  <li
                    className="viread-learning-content"
                    dir="ltr"
                    key={q}
                    lang="vi"
                  >
                    {adaptTextToTeacherPersona(q, teacherPersona.gender)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Voice or Text Recall Input */}
          <div className="flex flex-col gap-3 rounded-card border border-border bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                className="text-lg font-extrabold text-ink"
                htmlFor="memory-recall-input"
              >
                {t("memoryGame.recallTextareaLabel")}
              </label>
              <Button
                data-testid="recall-voice-btn"
                fullWidth={false}
                onClick={() => startVoiceCapture("RECALL")}
                size="compact"
                variant={
                  isListeningVoice && voiceTarget === "RECALL"
                    ? "destructive"
                    : "secondary"
                }
              >
                {isListeningVoice && voiceTarget === "RECALL" ? (
                  <>
                    <MicOff aria-hidden="true" className="size-4" />
                    {t("memoryGame.stopVoiceButton")}
                  </>
                ) : (
                  <>
                    <Mic aria-hidden="true" className="size-4" />
                    {t("memoryGame.speakVoiceButton")}
                  </>
                )}
              </Button>
            </div>

            {micCountdown?.target === "RECALL" && !isListeningVoice ? (
              <div
                aria-live="polite"
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border-2 border-amber-300 bg-amber-50/90 px-4 py-3"
                data-testid="memory-mic-countdown"
                role="status"
              >
                <div className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-amber-500 text-lg font-extrabold text-white">
                    {micCountdown.seconds}
                  </span>
                  <p className="text-sm font-extrabold text-amber-950">
                    {t(
                      "memoryGame.countdownRecall",
                      { seconds: micCountdown.seconds },
                      `Tự động bật Micro sau ${micCountdown.seconds} giây để bé kể lại nhé…`,
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    fullWidth={false}
                    onClick={() => startVoiceCapture("RECALL")}
                    size="compact"
                  >
                    <Mic aria-hidden="true" className="size-4" />
                    {t("memoryGame.speakNow", undefined, "Nói ngay")}
                  </Button>
                  <Button
                    fullWidth={false}
                    onClick={cancelMicCountdown}
                    size="compact"
                    variant="quiet"
                  >
                    {t("memoryGame.typeManually", undefined, "Tự gõ chữ")}
                  </Button>
                </div>
              </div>
            ) : null}

            {autoSubmitStage === "RECALL" && !isSubmitting ? (
              <div
                aria-live="polite"
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-emerald-300 bg-emerald-50 px-4 py-2.5"
                data-testid="memory-autosubmit-banner"
                role="status"
              >
                <p className="text-sm font-extrabold text-emerald-950">
                  {t(
                    "memoryGame.autoSubmittingRecall",
                    undefined,
                    "Đang tự động gửi câu trả lời của bé…",
                  )}
                </p>
                <Button
                  fullWidth={false}
                  onClick={cancelAutoSubmit}
                  size="compact"
                  variant="secondary"
                >
                  {t("memoryGame.editBeforeSubmit", undefined, "Sửa lại")}
                </Button>
              </div>
            ) : null}

            {voiceNotice ? (
              <p className="text-sm font-semibold text-primary">
                {voiceNotice}
              </p>
            ) : null}

            <textarea
              className="viread-learning-content min-h-32 w-full rounded-control border border-border bg-cream p-3.5 text-body text-ink focus:border-primary focus:outline-none"
              data-testid="recall-textarea"
              dir="ltr"
              id="memory-recall-input"
              lang="vi"
              onChange={(e) => {
                stopMicCapture();
                cancelAutoSubmit();
                setRecallText(e.target.value);
                setRecallInputMode("TEXT");
              }}
              placeholder={t("memoryGame.recallPlaceholder")}
              value={recallText}
            />

            <div className="flex flex-wrap justify-end gap-3">
              <Button
                data-testid="submit-recall-btn"
                fullWidth={false}
                isLoading={isSubmitting}
                onClick={() => void handleSubmitRecall()}
              >
                {t("memoryGame.submitRecallButton")}
              </Button>
            </div>
            {isSubmitting ? (
              <AiProgressBar
                active
                label={
                  submitProgress.stageLabel ??
                  tCommon("aiProgress.evaluatingAnswer")
                }
                percent={submitProgress.percent}
                size="compact"
                testId="memory-game-recall-evaluating-progress"
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ===================== STAGE E: REVEAL & INTERACTIVE SPOTLIGHT ===================== */}
      {stage === "REVEAL" && session && recallEvaluation ? (
        <div className="flex flex-col gap-5" data-testid="reveal-stage">
          <div className="grid gap-4 sm:grid-cols-2">
            <div
              className="rounded-card border-2 border-emerald-500/50 bg-success-surface p-5"
              data-testid="factual-score-card"
            >
              <p className="text-sm font-bold text-success-ink">
                {t("memoryGame.factualScoreAccurateLabel")}
              </p>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-4xl font-extrabold tabular-nums text-ink">
                  {recallEvaluation.factual_score}/100
                </span>
                {renderStars(
                  recallEvaluation.stars,
                  t("memoryGame.starsAria", { count: recallEvaluation.stars }),
                )}
              </div>
              <p
                className="viread-learning-content mt-2 text-sm font-semibold text-ink"
                dir="ltr"
                lang="vi"
              >
                {adaptTextToTeacherPersona(
                  recallEvaluation.praise_message_vi,
                  teacherPersona.gender,
                )}
              </p>
            </div>

            <div className="flex flex-col justify-between rounded-card border border-border bg-purple/50 p-5">
              <div>
                <p className="text-sm font-bold text-purple-ink">
                  {t("memoryGame.nextStepCreativeLabel")}
                </p>
                <p
                  className="viread-learning-content mt-1 text-body font-bold text-ink"
                  dir="ltr"
                  lang="vi"
                >
                  {adaptTextToTeacherPersona(
                    recallEvaluation.creative_followup_vi,
                    teacherPersona.gender,
                  )}
                </p>
              </div>
              <div className="mt-4">
                <Button
                  data-testid="go-creative-stage-btn"
                  onClick={() => {
                    setFocusedObjectId(null);
                    setStage("CREATIVE");
                    if (getEntertainmentPreferences().autopilotEnabled) {
                      void recorder.prepare?.().catch(() => undefined);
                      startMicCountdown("CREATIVE", 3);
                    }
                  }}
                >
                  <Sparkles aria-hidden="true" className="size-5" />
                  {t("memoryGame.goCreativeButton")}
                </Button>
              </div>
            </div>
          </div>

          {recallEvaluation.support_summary_vi ? (
            <div className="rounded-control border border-border bg-cream px-4 py-2.5 text-sm font-semibold text-muted">
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {adaptTextToTeacherPersona(
                  recallEvaluation.support_summary_vi,
                  teacherPersona.gender,
                )}
              </span>
            </div>
          ) : null}

          <MemorySceneCanvas
            focusedObjectId={focusedObjectId}
            matchedObjectIds={matchedObjectIds}
            missedObjectIds={missedObjectIds}
            mode="reveal"
            onSelectObject={(id) =>
              setFocusedObjectId((prev) => (prev === id ? null : id))
            }
            reducedMotion={reducedMotion}
            sceneSpec={session.scene_spec}
            showColorCues={showColorCues}
          />

          {focusedObject ? (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-amber-400 bg-warning-surface px-4 py-3 text-sm font-bold text-ink"
              data-testid="spotlight-caption"
            >
              <span>
                {t("memoryGame.spotlightLabel")}{" "}
                <strong className="viread-learning-content" dir="ltr" lang="vi">
                  {focusedObject.count > 1 ? `${focusedObject.count} ` : ""}
                  {focusedObject.name_vi}
                </strong>{" "}
                —{" "}
                <span className="viread-learning-content" dir="ltr" lang="vi">
                  {focusedObject.color_vi}, {focusedObject.position_zone} (
                  {focusedObject.action_vi})
                </span>
              </span>
              <button
                className="text-xs font-extrabold text-primary underline"
                onClick={() => setFocusedObjectId(null)}
                type="button"
              >
                {t("memoryGame.viewWholeScene")}
              </button>
            </div>
          ) : null}

          {/* Interactive matched & missed fact pills */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-card border border-border bg-white p-4">
              <h3 className="mb-3 text-base font-extrabold text-success-ink">
                {t("memoryGame.matchedFactsHeading", {
                  count: matchedFacts.length,
                })}
              </h3>
              {matchedFacts.length === 0 ? (
                <p className="text-sm text-muted">
                  {t("memoryGame.noMatchedFactsHint")}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {matchedFacts.map((fact) => (
                    <button
                      key={fact.object_id}
                      className={`viread-learning-content rounded-control border px-3 py-2 text-start text-sm font-bold transition-colors ${
                        focusedObjectId === fact.object_id
                          ? "border-emerald-700 bg-emerald-600 text-white"
                          : "border-emerald-300 bg-success-surface text-success-ink hover:bg-emerald-100"
                      }`}
                      data-testid={`matched-fact-${fact.object_id}`}
                      dir="ltr"
                      lang="vi"
                      onClick={() => setFocusedObjectId(fact.object_id)}
                      type="button"
                    >
                      ✓ {fact.detail_vi}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-card border border-border bg-white p-4">
              <h3 className="mb-3 text-base font-extrabold text-warning">
                {t("memoryGame.missedFactsHeading", {
                  count: missedFacts.length,
                })}
              </h3>
              {missedFacts.length === 0 ? (
                <p className="text-sm font-bold text-success-ink">
                  {t("memoryGame.allFactsRemembered")}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {missedFacts.map((fact) => (
                    <button
                      key={fact.object_id}
                      className={`viread-learning-content rounded-control border px-3 py-2 text-start text-sm font-bold transition-colors ${
                        focusedObjectId === fact.object_id
                          ? "border-amber-700 bg-amber-600 text-white"
                          : "border-amber-300 bg-warning-surface text-warning hover:bg-amber-100"
                      }`}
                      data-testid={`missed-fact-${fact.object_id}`}
                      dir="ltr"
                      lang="vi"
                      onClick={() => setFocusedObjectId(fact.object_id)}
                      type="button"
                    >
                      ★ {fact.detail_vi}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* ===================== STAGE D: CREATIVE STORY EXTENSION ===================== */}
      {stage === "CREATIVE" && session ? (
        <div className="flex flex-col gap-5" data-testid="creative-stage">
          <div className="rounded-card border-2 border-purple-ink/25 bg-purple/60 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-extrabold text-purple-ink">
                  {t("memoryGame.creativeStageBadge")}
                </p>
                <h2 className="mt-1 text-2xl font-extrabold text-ink">
                  {t("memoryGame.creativeStageTitle")}
                </h2>
                <p
                  className="viread-learning-content mt-1 text-body text-muted"
                  dir="ltr"
                  lang="vi"
                >
                  {adaptTextToTeacherPersona(
                    session.scene_spec.creative_prompt_vi,
                    teacherPersona.gender,
                  )}
                </p>
              </div>
              <Button
                disabled={!calmSound}
                fullWidth={false}
                onClick={() =>
                  isSpeakingPrompt
                    ? stopAllTts()
                    : speakVietnamesePrompt(
                        `${t("memoryGame.creativeStageTitle")} ${session.scene_spec.creative_prompt_vi}`,
                      )
                }
                size="compact"
                variant="quiet"
              >
                {isSpeakingPrompt ? (
                  <VolumeX aria-hidden="true" className="size-4" />
                ) : (
                  <Volume2 aria-hidden="true" className="size-4" />
                )}
                {isSpeakingPrompt
                  ? t("memoryGame.stopAudio")
                  : t("memoryGame.listenQuestion")}
              </Button>
            </div>
          </div>

          <MemorySceneCanvas
            matchedObjectIds={matchedObjectIds}
            missedObjectIds={missedObjectIds}
            mode="reveal"
            reducedMotion={reducedMotion}
            sceneSpec={session.scene_spec}
            showColorCues={showColorCues}
          />

          <div className="flex flex-col gap-3 rounded-card border border-border bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                className="text-lg font-extrabold text-ink"
                htmlFor="memory-creative-input"
              >
                {t("memoryGame.creativeTextareaLabel")}
              </label>
              <Button
                data-testid="creative-voice-btn"
                fullWidth={false}
                onClick={() => startVoiceCapture("CREATIVE")}
                size="compact"
                variant={
                  isListeningVoice && voiceTarget === "CREATIVE"
                    ? "destructive"
                    : "secondary"
                }
              >
                {isListeningVoice && voiceTarget === "CREATIVE" ? (
                  <>
                    <MicOff aria-hidden="true" className="size-4" />
                    {t("memoryGame.stopVoiceButton")}
                  </>
                ) : (
                  <>
                    <Mic aria-hidden="true" className="size-4" />
                    {t("memoryGame.speakCreativeButton")}
                  </>
                )}
              </Button>
            </div>

            {creativeMagicWords.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-2 rounded-control border border-amber-200 bg-amber-50/75 px-3.5 py-2.5"
                data-testid="memory-creative-focus-words"
              >
                <span className="text-xs font-extrabold text-amber-900">
                  ⭐{" "}
                  {t(
                    "memoryGame.magicFocusWordsLabel",
                    undefined,
                    "Từ khóa phép thuật bé đang luyện:",
                  )}
                </span>
                {creativeMagicWords.map((word) => (
                  <button
                    className="viread-learning-content inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-white px-3 py-1 text-xs font-extrabold text-amber-950 transition hover:bg-amber-100"
                    dir="ltr"
                    key={word}
                    lang="vi"
                    onClick={() =>
                      speakVietnamesePrompt(word, { wordSample: true })
                    }
                    type="button"
                  >
                    <Volume2 aria-hidden="true" className="size-3.5" />
                    {word}
                  </button>
                ))}
              </div>
            ) : null}

            {micCountdown?.target === "CREATIVE" && !isListeningVoice ? (
              <div
                aria-live="polite"
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border-2 border-amber-300 bg-amber-50/90 px-4 py-3"
                data-testid="memory-mic-countdown"
                role="status"
              >
                <div className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-amber-500 text-lg font-extrabold text-white">
                    {micCountdown.seconds}
                  </span>
                  <p className="text-sm font-extrabold text-amber-950">
                    {t(
                      "memoryGame.countdownCreative",
                      { seconds: micCountdown.seconds },
                      `Tự động bật Micro sau ${micCountdown.seconds} giây để bé kể chuyện…`,
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    fullWidth={false}
                    onClick={() => startVoiceCapture("CREATIVE")}
                    size="compact"
                  >
                    <Mic aria-hidden="true" className="size-4" />
                    {t("memoryGame.speakNow", undefined, "Nói ngay")}
                  </Button>
                  <Button
                    fullWidth={false}
                    onClick={cancelMicCountdown}
                    size="compact"
                    variant="quiet"
                  >
                    {t("memoryGame.typeManually", undefined, "Tự gõ chữ")}
                  </Button>
                </div>
              </div>
            ) : null}

            {autoSubmitStage === "CREATIVE" && !isSubmitting ? (
              <div
                aria-live="polite"
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-emerald-300 bg-emerald-50 px-4 py-2.5"
                data-testid="memory-autosubmit-banner"
                role="status"
              >
                <p className="text-sm font-extrabold text-emerald-950">
                  {t(
                    "memoryGame.autoSubmittingCreative",
                    undefined,
                    "Đang tự động gửi câu chuyện sáng tạo của bé…",
                  )}
                </p>
                <Button
                  fullWidth={false}
                  onClick={cancelAutoSubmit}
                  size="compact"
                  variant="secondary"
                >
                  {t("memoryGame.editBeforeSubmit", undefined, "Sửa lại")}
                </Button>
              </div>
            ) : null}

            {voiceNotice ? (
              <p className="text-sm font-semibold text-primary">
                {voiceNotice}
              </p>
            ) : null}

            <textarea
              className="viread-learning-content min-h-32 w-full rounded-control border border-border bg-cream p-3.5 text-body text-ink focus:border-primary focus:outline-none"
              data-testid="creative-textarea"
              dir="ltr"
              id="memory-creative-input"
              lang="vi"
              onChange={(e) => {
                stopMicCapture();
                cancelAutoSubmit();
                setCreativeText(e.target.value);
                setCreativeInputMode("TEXT");
              }}
              placeholder={t("memoryGame.creativePlaceholder")}
              value={creativeText}
            />

            <div className="flex flex-wrap justify-between gap-3">
              <Button
                fullWidth={false}
                onClick={() => setStage("REVEAL")}
                size="compact"
                variant="quiet"
              >
                {t("memoryGame.backToRevealButton")}
              </Button>
              <Button
                data-testid="submit-creative-btn"
                fullWidth={false}
                isLoading={isSubmitting}
                onClick={() => void handleSubmitCreative()}
              >
                <Sparkles aria-hidden="true" className="size-5" />
                {t("memoryGame.submitCreativeButton")}
              </Button>
            </div>
            {isSubmitting ? (
              <AiProgressBar
                active
                label={
                  submitProgress.stageLabel ??
                  tCommon("aiProgress.evaluatingAnswer")
                }
                percent={submitProgress.percent}
                size="compact"
                testId="memory-game-creative-evaluating-progress"
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ===================== STAGE F: WARM DUAL-TRACK FEEDBACK ===================== */}
      {stage === "SUMMARY" && session ? (
        <div className="flex flex-col gap-5" data-testid="summary-stage">
          <div className="rounded-card border border-border bg-cream p-6 text-center">
            <div className="mb-2 flex justify-center">
              {renderStars(
                session.stars,
                t("memoryGame.starsAria", { count: session.stars }),
              )}
            </div>
            <h2 className="text-3xl font-extrabold text-ink">
              {t("memoryGame.summaryPraiseTitle", { alias: child.alias })}
            </h2>
            <p
              className="viread-learning-content mt-2 text-body font-semibold text-muted"
              dir="ltr"
              lang="vi"
            >
              {adaptTextToTeacherPersona(
                creativeEvaluation?.praise_message_vi ??
                  recallEvaluation?.praise_message_vi ??
                  "",
                teacherPersona.gender,
              )}
            </p>
          </div>

          {/* SEPARATE DUAL-TRACK SCORE CARDS */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div
              className="flex flex-col gap-2 rounded-card border-2 border-emerald-500/50 bg-success-surface p-5"
              data-testid="factual-score-card"
            >
              <span className="text-sm font-extrabold uppercase tracking-wide text-success-ink">
                {t("memoryGame.factualScoreTitle")}
              </span>
              <span
                className="text-4xl font-extrabold tabular-nums text-ink"
                data-testid="factual-score-value"
              >
                {displayFactualScore}/100
              </span>
              <p className="text-sm text-ink">
                {recallEvaluation?.praise_message_vi ? (
                  <span className="viread-learning-content" dir="ltr" lang="vi">
                    {adaptTextToTeacherPersona(
                      recallEvaluation.praise_message_vi,
                      teacherPersona.gender,
                    )}
                  </span>
                ) : (
                  t("memoryGame.factualDefaultPraise")
                )}
              </p>
            </div>

            <div
              className="flex flex-col gap-2 rounded-card border-2 border-purple-500/40 bg-purple p-5"
              data-testid="creative-score-card"
            >
              <span className="text-sm font-extrabold uppercase tracking-wide text-purple-ink">
                {t("memoryGame.creativeScoreTitle")}
              </span>
              <span
                className="text-4xl font-extrabold tabular-nums text-ink"
                data-testid="creative-score-value"
              >
                {displayCreativeScore}/100
              </span>
              <p className="text-sm text-ink">
                {creativeEvaluation?.story_praise_vi ? (
                  <span className="viread-learning-content" dir="ltr" lang="vi">
                    {adaptTextToTeacherPersona(
                      creativeEvaluation.story_praise_vi,
                      teacherPersona.gender,
                    )}
                  </span>
                ) : (
                  adaptTextToTeacherPersona(
                    t("memoryGame.creativeDefaultPraise"),
                    teacherPersona.gender,
                  )
                )}
              </p>
            </div>
          </div>

          {creativeEvaluation?.creative_highlights &&
          creativeEvaluation.creative_highlights.length > 0 ? (
            <div className="rounded-card border border-border bg-white p-5">
              <h3 className="mb-2 text-lg font-extrabold text-purple-ink">
                {adaptTextToTeacherPersona(
                  t("memoryGame.creativeHighlightsHeading"),
                  teacherPersona.gender,
                )}
              </h3>
              <ul className="list-disc space-y-1.5 ps-5 text-body text-ink">
                {creativeEvaluation.creative_highlights.map((item) => (
                  <li
                    className="viread-learning-content"
                    dir="ltr"
                    key={item}
                    lang="vi"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {(creativeEvaluation?.support_summary_vi ??
          recallEvaluation?.support_summary_vi) ? (
            <div className="rounded-control border border-border bg-cream px-4 py-3 text-sm font-semibold text-muted">
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {adaptTextToTeacherPersona(
                  (creativeEvaluation?.support_summary_vi ??
                    recallEvaluation?.support_summary_vi)!,
                  teacherPersona.gender,
                )}
              </span>
            </div>
          ) : null}

          <MemorySceneCanvas
            focusedObjectId={focusedObjectId}
            matchedObjectIds={matchedObjectIds}
            missedObjectIds={missedObjectIds}
            mode="reveal"
            onSelectObject={(id) =>
              setFocusedObjectId((prev) => (prev === id ? null : id))
            }
            reducedMotion={reducedMotion}
            sceneSpec={session.scene_spec}
            showColorCues={showColorCues}
          />

          <div className="flex flex-wrap justify-center gap-3">
            <Button
              data-testid="play-again-btn"
              fullWidth={false}
              onClick={resetToSetup}
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {t("memoryGame.playAgainButton")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
