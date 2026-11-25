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
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { MemorySceneCanvas } from "@/components/entertainment/memory-game/memory-scene-canvas";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import {
  createMemoryGameService,
  type MemoryGameService,
} from "@/lib/api/memory-game-service";
import { isServiceError } from "@/lib/api/service-error";
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

const FALLBACK_TIMER_OPTIONS: ReadonlyArray<{
  mode: MemoryTimerMode;
  seconds: number | null;
  label_vi: string;
  recommended_for_vi: string;
}> = [
  {
    mode: "10S",
    seconds: 10,
    label_vi: "10 giây",
    recommended_for_vi: "Siêu nhanh",
  },
  {
    mode: "20S",
    seconds: 20,
    label_vi: "20 giây",
    recommended_for_vi: "Lớp 4–5",
  },
  {
    mode: "30S",
    seconds: 30,
    label_vi: "30 giây",
    recommended_for_vi: "Lớp 2–3",
  },
  {
    mode: "60S",
    seconds: 60,
    label_vi: "60 giây",
    recommended_for_vi: "Lớp 1–2",
  },
  {
    mode: "90S",
    seconds: 90,
    label_vi: "90 giây",
    recommended_for_vi: "Quan sát kỹ",
  },
  {
    mode: "120S",
    seconds: 120,
    label_vi: "120 giây",
    recommended_for_vi: "Chậm rãi",
  },
  {
    mode: "UNLIMITED",
    seconds: null,
    label_vi: "Không giới hạn",
    recommended_for_vi: "Tự bấm khi nhớ xong",
  },
];

const DEFAULT_ERROR_MESSAGE =
  "Chưa kết nối được trò chơi trí nhớ. Ba mẹ và bé hãy thử lại nhé.";

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function renderStars(count: number) {
  return (
    <span
      aria-label={`${count} trên 3 sao`}
      className="inline-flex items-center gap-1"
    >
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
  const memoryService = useMemo(
    () => service ?? createMemoryGameService(),
    [service],
  );
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const child = childState.status === "ready" ? childState.child : null;
  const childId = child?.id ?? null;
  const speechPlayer = useSpeechPlayer();

  // Catalog & history
  const [catalog, setCatalog] = useState<MemoryThemesCatalogDTO | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [history, setHistory] = useState<MemorySessionSummaryDTO[]>([]);
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

  // Anti-TTS-Self-Capture Voice Lifecycle (matching G10)
  const [isListeningVoice, setIsListeningVoice] = useState(false);
  const [voiceTarget, setVoiceTarget] = useState<"RECALL" | "CREATIVE" | null>(
    null,
  );
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [isSpeakingPrompt, setIsSpeakingPrompt] = useState(false);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isSpeakingPromptRef = useRef(false);
  const ttsCooldownUntilRef = useRef<number>(0);
  const micArmTimeoutRef = useRef<number | null>(null);
  const peekIntervalRef = useRef<number | null>(null);

  const stopMicCapture = useCallback(() => {
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
  }, []);

  const stopAllTts = useCallback(() => {
    const wasSpeaking = isSpeakingPromptRef.current || speechPlayer.isPlaying;
    speechPlayer.stop();
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
  }, [speechPlayer]);

  const speakVietnamesePrompt = useCallback(
    (text: string) => {
      // Anti-self-capture invariant: ALWAYS abort active mic BEFORE speaking TTS!
      stopMicCapture();
      stopAllTts();
      isSpeakingPromptRef.current = true;
      setIsSpeakingPrompt(true);

      const finishSpeak = () => {
        isSpeakingPromptRef.current = false;
        setIsSpeakingPrompt(false);
        ttsCooldownUntilRef.current = Date.now() + TTS_MIC_COOLDOWN_MS;
      };

      if (
        typeof window !== "undefined" &&
        "speechSynthesis" in window &&
        typeof window.SpeechSynthesisUtterance === "function"
      ) {
        try {
          const utterance = new window.SpeechSynthesisUtterance(text);
          utterance.lang = "vi-VN";
          utterance.rate = 0.95;
          utterance.onend = finishSpeak;
          utterance.onerror = finishSpeak;
          window.speechSynthesis.speak(utterance);
          return;
        } catch {
          // Fall back to app speech player below.
        }
      }

      void speechPlayer
        .play(text)
        .catch(() => undefined)
        .finally(finishSpeak);
    },
    [speechPlayer, stopAllTts, stopMicCapture],
  );

  const startVoiceCapture = useCallback(
    (target: "RECALL" | "CREATIVE") => {
      if (isListeningVoice) {
        stopMicCapture();
        return;
      }

      // Anti-self-capture invariant: ALWAYS cancel TTS BEFORE arming microphone!
      stopAllTts();

      const SpeechRecognition = getSpeechRecognitionCtor();
      if (!SpeechRecognition) {
        setVoiceNotice(
          "Trình duyệt này chưa hỗ trợ ghi giọng nói trực tiếp. Bé có thể gõ câu trả lời vào ô bên dưới nhé!",
        );
        return;
      }

      const beginCapture = () => {
        micArmTimeoutRef.current = null;
        setActionError(null);
        setVoiceNotice(
          "Đang lắng nghe bé kể... Bấm lại nút micro khi nói xong nhé!",
        );
        try {
          const recognition = new SpeechRecognition();
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
          };
          recognition.onerror = () => {
            setVoiceNotice(
              "Micro tạm ngắt kết nối. Lời bé vừa kể vẫn được giữ nguyên — bé có thể nói tiếp hoặc gõ chữ nhé!",
            );
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
          setVoiceNotice(
            "Không mở được micro lúc này. Bé hãy gõ câu trả lời vào ô chữ nhé!",
          );
          stopMicCapture();
        }
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
    [isListeningVoice, stopAllTts, stopMicCapture],
  );

  // Stop mic, TTS, and peek timers cleanly on backgrounding / unmount
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        stopMicCapture();
        stopAllTts();
      }
    };
    const handleAndroidBg = () => {
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
      stopMicCapture();
      stopAllTts();
      if (peekIntervalRef.current) clearInterval(peekIntervalRef.current);
    };
  }, [stopAllTts, stopMicCapture]);

  // Load theme catalog & child history
  useEffect(() => {
    if (!childId) return;
    const controller = new AbortController();

    void Promise.all([
      memoryService.getThemes(controller.signal),
      memoryService.listSessions(childId, 6, controller.signal).catch(() => []),
    ])
      .then(([themesData, recentSessions]) => {
        if (controller.signal.aborted) return;
        setCatalog(themesData);
        setCatalogError(null);
        setHistory(recentSessions);
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
          isServiceError(err) ? err.message : DEFAULT_ERROR_MESSAGE,
        );
      });

    return () => controller.abort();
  }, [child, childId, hasCustomizedGradeDefaults, memoryService]);

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
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(id);
  }, [remainingSeconds, sceneReady, session, stage]);

  const startNewSession = async () => {
    if (!childId || isStarting) return;
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
      });
      setSession(created);
      setRemainingSeconds(created.timer_seconds);
      setStage("OBSERVE");
    } catch (err: unknown) {
      setActionError(isServiceError(err) ? err.message : DEFAULT_ERROR_MESSAGE);
    } finally {
      setIsStarting(false);
    }
  };

  const finishObservingEarly = () => {
    stopAllTts();
    setStage("RECALL");
  };

  const handleRequestHint = async () => {
    if (!session || isLoadingHint) return;
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
      setActionError(isServiceError(err) ? err.message : DEFAULT_ERROR_MESSAGE);
    } finally {
      setIsLoadingHint(false);
    }
  };

  const handleSupportedPeek = async () => {
    if (!session || isPeeking) return;
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
      setActionError(isServiceError(err) ? err.message : DEFAULT_ERROR_MESSAGE);
    }
  };

  const handleSubmitRecall = async () => {
    if (!session || isSubmittingRef.current) return;
    const trimmed = recallText.trim();
    if (!trimmed) {
      setActionError("Bé hãy kể hoặc gõ ít nhất một chi tiết bé nhớ được nhé!");
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
        input_mode: recallInputMode,
        response_text: trimmed,
      });
      setSession(result.session);
      setRecallEvaluation(result.attempt.evaluation);
      const firstMissed = result.attempt.evaluation.missed_facts[0];
      setFocusedObjectId(firstMissed ? firstMissed.object_id : null);
      setStage("REVEAL");
    } catch (err: unknown) {
      // Preserve child's recall draft cleanly on transient error!
      setActionError(isServiceError(err) ? err.message : DEFAULT_ERROR_MESSAGE);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleSubmitCreative = async () => {
    if (!session || isSubmittingRef.current) return;
    const trimmed = creativeText.trim();
    if (!trimmed) {
      setActionError(
        "Bé hãy tưởng tượng và kể ít nhất một câu về chuyện xảy ra tiếp theo nhé!",
      );
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
        input_mode: creativeInputMode,
        response_text: trimmed,
      });
      setSession(result.session);
      setCreativeEvaluation(result.attempt.evaluation);
      setStage("SUMMARY");
      if (childId) {
        void memoryService
          .listSessions(childId, 6)
          .then((items) => setHistory(items))
          .catch(() => undefined);
      }
    } catch (err: unknown) {
      setActionError(isServiceError(err) ? err.message : DEFAULT_ERROR_MESSAGE);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const resetToSetup = () => {
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
            <span>Chưa tải được hồ sơ bé. Ba mẹ hãy thử lại nhé.</span>
            <Button
              fullWidth={false}
              onClick={retryChild}
              size="compact"
              variant="secondary"
            >
              Thử lại
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
              Chọn hồ sơ bé
            </ButtonLink>
          }
          description="Ba mẹ hãy chọn hồ sơ bé trước khi mở trò chơi trí nhớ và kể chuyện sáng tạo nhé."
          title="Chưa chọn hồ sơ bé"
        />
      </section>
    );
  }

  const timerOptions = catalog?.timer_options ?? FALLBACK_TIMER_OPTIONS;
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

  return (
    <section
      className="mx-auto flex w-full max-w-[1060px] flex-col gap-5 pb-10"
      data-stage={stage}
      data-testid="memory-game-screen"
    >
      {/* Top navigation & child header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex flex-col gap-1">
          <Link className="family-inline-link w-fit" href="/entertainment">
            <ArrowLeft aria-hidden="true" className="size-4" />
            Quay lại Giải trí
          </Link>
          <h1 className="book-title flex items-center gap-2.5 text-3xl text-ink sm:text-4xl">
            <Brain aria-hidden="true" className="size-8 text-primary" />
            Bé nhớ được gì?
          </h1>
          <p className="text-body text-muted">
            Quan sát bức tranh đầy màu sắc, rèn trí nhớ vui và tưởng tượng câu
            chuyện tiếp theo!
          </p>
        </div>
        <BookChildHeader child={child} />
      </div>

      {/* Stage progress pills */}
      <nav
        aria-label="Các bước chơi Bé nhớ được gì"
        className="flex flex-wrap items-center gap-2"
      >
        {(
          [
            ["SETUP", "1. Chọn tranh"],
            ["OBSERVE", "2. Quan sát"],
            ["RECALL", "3. Bé nhớ gì?"],
            ["REVEAL", "4. Soi tranh"],
            ["CREATIVE", "5. Kể tiếp"],
            ["SUMMARY", "6. Điểm & Khen"],
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
            <StatusMessage tone="error">{catalogError}</StatusMessage>
          ) : null}

          {gradeRec ? (
            <div className="rounded-card border border-border bg-sky px-5 py-4 text-ink">
              <p className="text-body font-bold">{gradeRec.note_vi}</p>
            </div>
          ) : null}

          {/* Theme selector */}
          <div className="rounded-card border border-border bg-white p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-extrabold text-ink">
                Chọn chủ đề bức tranh
              </h2>
              <button
                aria-pressed={selectedTheme === "random"}
                className={`rounded-control border px-4 py-2 text-sm font-bold transition-colors ${
                  selectedTheme === "random"
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-cream text-ink hover:bg-sky"
                }`}
                onClick={() => setSelectedTheme("random")}
                type="button"
              >
                🎲 Ngẫu nhiên
              </button>
            </div>

            {catalogLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <Skeleton key={n} className="h-28 rounded-card" />
                ))}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {(catalog?.themes ?? []).map((theme) => {
                  const isActive = selectedTheme === theme.theme_key;
                  return (
                    <button
                      key={theme.theme_key}
                      aria-pressed={isActive}
                      className={`flex flex-col items-start gap-2 rounded-card border-2 p-4 text-left transition-colors ${
                        isActive
                          ? "border-primary bg-sky/70"
                          : "border-border bg-cream hover:border-primary/50"
                      }`}
                      onClick={() => setSelectedTheme(theme.theme_key)}
                      type="button"
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-lg font-extrabold text-ink">
                          {theme.name_vi}
                        </span>
                        <span
                          className="rounded-full px-2.5 py-0.5 text-xs font-bold text-white"
                          style={{ backgroundColor: theme.accent_hex }}
                        >
                          {theme.badge_vi}
                        </span>
                      </div>
                      <p className="text-sm leading-5 text-muted">
                        {theme.description_vi}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Timer & Recall mode */}
          <div className="grid gap-5 md:grid-cols-2">
            <div className="rounded-card border border-border bg-white p-5">
              <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold text-ink">
                <Clock aria-hidden="true" className="size-5 text-primary" />
                Thời gian quan sát
              </h2>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {timerOptions.map((opt) => {
                  const isActive = timerMode === opt.mode;
                  return (
                    <button
                      key={opt.mode}
                      aria-pressed={isActive}
                      className={`flex flex-col items-start rounded-control border px-3 py-2.5 text-left transition-colors ${
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
                        {opt.label_vi}
                      </span>
                      <span
                        className={`text-xs ${isActive ? "text-white/90" : "text-muted"}`}
                      >
                        {opt.recommended_for_vi}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-4 rounded-card border border-border bg-white p-5">
              <div>
                <h2 className="mb-3 text-lg font-extrabold text-ink">
                  Cách bé kể lại
                </h2>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      [
                        "FREE_RECALL",
                        "Kể tự do",
                        "Bé tự do kể mọi chi tiết bé nhớ được",
                      ],
                      [
                        "GUIDED_RECALL",
                        "Trả lời gợi ý",
                        "Có câu hỏi nhỏ dẫn dắt nhẹ nhàng",
                      ],
                    ] as const
                  ).map(([modeValue, title, desc]) => {
                    const active = recallMode === modeValue;
                    return (
                      <button
                        key={modeValue}
                        aria-pressed={active}
                        className={`flex flex-col items-start gap-1 rounded-control border p-3 text-left transition-colors ${
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
                  Hiển thị “Gợi ý quan sát” khi xem tranh
                </label>
                <label className="flex cursor-pointer items-center gap-3 text-sm font-bold text-ink">
                  <input
                    checked={showColorCues}
                    className="size-5 accent-primary"
                    onChange={(e) => setShowColorCues(e.target.checked)}
                    type="checkbox"
                  />
                  Hiển thị ký hiệu hình khối hỗ trợ phân biệt màu sắc
                </label>
              </div>
            </div>
          </div>

          <div className="flex justify-center">
            <Button
              className="max-w-md text-lg"
              data-testid="start-memory-game-btn"
              isLoading={isStarting}
              onClick={() => void startNewSession()}
            >
              <Sparkles aria-hidden="true" className="size-5" />
              Bắt đầu quan sát tranh
            </Button>
          </div>

          {/* Recent sessions */}
          {history.length > 0 ? (
            <div className="rounded-card border border-border bg-cream p-5">
              <h2 className="mb-3 text-lg font-extrabold text-ink">
                Các bức tranh bé vừa chơi gần đây
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {history.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col gap-1.5 rounded-control border border-border bg-white p-3.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-extrabold text-ink">
                        {item.theme_name_vi}
                      </span>
                      {renderStars(item.stars)}
                    </div>
                    <p className="text-xs text-muted">
                      {item.object_count} chi tiết ·{" "}
                      {item.timer_seconds
                        ? `${item.timer_seconds}s`
                        : "Không giới hạn"}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs font-bold">
                      <span className="rounded-full bg-success-surface px-2.5 py-0.5 text-success-ink">
                        Ghi nhớ: {item.best_factual_score}/100
                      </span>
                      <span className="rounded-full bg-purple px-2.5 py-0.5 text-purple-ink">
                        Sáng tạo: {item.best_creative_score}/100
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
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
                  Không giới hạn thời gian
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
                      className="text-2xl font-extrabold text-ink"
                      data-testid="countdown-seconds"
                    >
                      {sceneReady
                        ? `${remainingSeconds ?? session.timer_seconds} giây`
                        : "Đang chuẩn bị…"}
                    </p>
                    <p className="text-xs font-semibold text-muted">
                      Quan sát thật kỹ từng chi tiết nhé!
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
                Bé đã nhớ xong
              </Button>
            </div>
          </div>

          <MemorySceneCanvas
            mode="observe"
            onSceneReady={handleSceneReady}
            sceneSpec={session.scene_spec}
            showColorCues={showColorCues}
          />

          {session.scene_spec.matched_focus_words.length > 0 ? (
            <div className="rounded-control border border-border bg-purple/60 px-4 py-2.5 text-sm font-bold text-purple-ink">
              Từ vựng quen thuộc bé đang luyện có mặt trong tranh:{" "}
              {session.scene_spec.matched_focus_words.join(", ")}
            </div>
          ) : null}

          {showObservationGuide &&
          session.scene_spec.observation_tips_vi.length > 0 ? (
            <div className="rounded-card border border-border bg-cream p-4">
              <p className="mb-1.5 flex items-center gap-2 text-sm font-extrabold text-ink">
                <Lightbulb aria-hidden="true" className="size-4 text-warning" />
                Gợi ý quan sát thông minh:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {session.scene_spec.observation_tips_vi.map((tip) => (
                  <li key={tip}>{tip}</li>
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
                  Đang xem lại nhanh ({peekRemaining} giây)…
                </span>
                <span>Lần xem lại: {session.peek_count}</span>
              </div>
              <MemorySceneCanvas
                mode="peek"
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
                Bức tranh đang trốn sau tấm màn bí mật!
              </h2>
              <p className="max-w-xl text-body text-muted">
                Bé hãy kể lại những con vật, đồ vật, màu sắc, số lượng hoặc vị
                trí mà bé nhớ được trong tranh{" "}
                <strong>“{session.theme_name_vi}”</strong> nhé!
              </p>
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
                  Gợi ý cho bé ({session.hints_used})
                </Button>
                <Button
                  data-testid="supported-peek-btn"
                  fullWidth={false}
                  onClick={() => void handleSupportedPeek()}
                  size="compact"
                  variant="quiet"
                >
                  <Eye aria-hidden="true" className="size-4" />
                  Xem lại nhanh 3 giây ({session.peek_count})
                </Button>
                <Button
                  fullWidth={false}
                  onClick={() =>
                    isSpeakingPrompt
                      ? stopAllTts()
                      : speakVietnamesePrompt(
                          `Bé hãy kể lại những gì bé nhớ được trong bức tranh ${session.theme_name_vi} nhé!`,
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
                  {isSpeakingPrompt ? "Dừng đọc" : "Nghe hướng dẫn"}
                </Button>
              </div>
            </div>
          )}

          {peekNotice ? (
            <div className="rounded-control border border-border bg-warning-surface/70 px-4 py-2.5 text-sm font-semibold text-warning">
              {peekNotice}
            </div>
          ) : null}

          {activeHint ? (
            <div
              className="rounded-card border border-amber-300 bg-warning-surface p-4 text-ink"
              data-testid="memory-hint-card"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-extrabold text-warning">
                  💡 Gợi ý bậc {activeHint.tier}/3
                </span>
                <span className="text-xs font-bold text-muted">
                  Còn {activeHint.remaining_unmentioned_count} chi tiết chưa
                  nhắc tới
                </span>
              </div>
              <p className="text-body font-bold">{activeHint.hint_text_vi}</p>
            </div>
          ) : null}

          {session.recall_mode === "GUIDED_RECALL" &&
          session.scene_spec.guided_questions_vi.length > 0 ? (
            <div className="rounded-card border border-border bg-cream p-4">
              <p className="mb-2 text-sm font-extrabold text-ink">
                Câu hỏi nhỏ gợi nhớ cho bé:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {session.scene_spec.guided_questions_vi.map((q) => (
                  <li key={q}>{q}</li>
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
                Lời bé kể lại bức tranh
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
                    Dừng ghi âm
                  </>
                ) : (
                  <>
                    <Mic aria-hidden="true" className="size-4" />
                    Nói bằng giọng nói
                  </>
                )}
              </Button>
            </div>

            {voiceNotice ? (
              <p className="text-sm font-semibold text-primary">
                {voiceNotice}
              </p>
            ) : null}

            <textarea
              className="min-h-32 w-full rounded-control border border-border bg-cream p-3.5 text-body text-ink focus:border-primary focus:outline-none"
              data-testid="recall-textarea"
              id="memory-recall-input"
              onChange={(e) => {
                setRecallText(e.target.value);
                setRecallInputMode("TEXT");
              }}
              placeholder="Ví dụ: Bé nhớ có một con mèo mướp màu cam ở dưới trái, hai bông hoa hướng dương màu vàng..."
              value={recallText}
            />

            <div className="flex flex-wrap justify-end gap-3">
              <Button
                data-testid="submit-recall-btn"
                fullWidth={false}
                isLoading={isSubmitting}
                onClick={() => void handleSubmitRecall()}
              >
                Kiểm tra trí nhớ của bé
              </Button>
            </div>
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
                Điểm ghi nhớ (Chính xác theo tranh)
              </p>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-4xl font-extrabold text-ink">
                  {recallEvaluation.factual_score}/100
                </span>
                {renderStars(recallEvaluation.stars)}
              </div>
              <p className="mt-2 text-sm font-semibold text-ink">
                {recallEvaluation.praise_message_vi}
              </p>
            </div>

            <div className="flex flex-col justify-between rounded-card border border-border bg-purple/50 p-5">
              <div>
                <p className="text-sm font-bold text-purple-ink">
                  Bước tiếp theo: Điểm sáng tạo
                </p>
                <p className="mt-1 text-body font-bold text-ink">
                  {recallEvaluation.creative_followup_vi}
                </p>
              </div>
              <div className="mt-4">
                <Button
                  data-testid="go-creative-stage-btn"
                  onClick={() => {
                    setFocusedObjectId(null);
                    setStage("CREATIVE");
                  }}
                >
                  <Sparkles aria-hidden="true" className="size-5" />
                  Kể tiếp câu chuyện sáng tạo
                </Button>
              </div>
            </div>
          </div>

          {recallEvaluation.support_summary_vi ? (
            <div className="rounded-control border border-border bg-cream px-4 py-2.5 text-sm font-semibold text-muted">
              {recallEvaluation.support_summary_vi}
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
            sceneSpec={session.scene_spec}
            showColorCues={showColorCues}
          />

          {focusedObject ? (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-amber-400 bg-warning-surface px-4 py-3 text-sm font-bold text-ink"
              data-testid="spotlight-caption"
            >
              <span>
                🔦 Đang soi sáng:{" "}
                <strong>
                  {focusedObject.count > 1 ? `${focusedObject.count} ` : ""}
                  {focusedObject.name_vi}
                </strong>{" "}
                — màu {focusedObject.color_vi}, góc{" "}
                {focusedObject.position_zone} ({focusedObject.action_vi})
              </span>
              <button
                className="text-xs font-extrabold text-primary underline"
                onClick={() => setFocusedObjectId(null)}
                type="button"
              >
                Xem toàn tranh
              </button>
            </div>
          ) : null}

          {/* Interactive matched & missed fact pills */}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-card border border-border bg-white p-4">
              <h3 className="mb-3 text-base font-extrabold text-success-ink">
                ✓ Chi tiết bé nhớ chính xác ({matchedFacts.length})
              </h3>
              {matchedFacts.length === 0 ? (
                <p className="text-sm text-muted">
                  Bấm vào các chi tiết bên phải để xem lại vị trí trên tranh
                  nhé!
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {matchedFacts.map((fact) => (
                    <button
                      key={fact.object_id}
                      className={`rounded-control border px-3 py-2 text-left text-sm font-bold transition-colors ${
                        focusedObjectId === fact.object_id
                          ? "border-emerald-700 bg-emerald-600 text-white"
                          : "border-emerald-300 bg-success-surface text-success-ink hover:bg-emerald-100"
                      }`}
                      data-testid={`matched-fact-${fact.object_id}`}
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
                ★ Chi tiết bé khám phá thêm ({missedFacts.length}) — bấm để soi
                trên tranh!
              </h3>
              {missedFacts.length === 0 ? (
                <p className="text-sm font-bold text-success-ink">
                  Xuất sắc! Bé không bỏ sót chi tiết nào cả!
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {missedFacts.map((fact) => (
                    <button
                      key={fact.object_id}
                      className={`rounded-control border px-3 py-2 text-left text-sm font-bold transition-colors ${
                        focusedObjectId === fact.object_id
                          ? "border-amber-700 bg-amber-600 text-white"
                          : "border-amber-300 bg-warning-surface text-warning hover:bg-amber-100"
                      }`}
                      data-testid={`missed-fact-${fact.object_id}`}
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
                  ✨ Chặng Sáng tạo câu chuyện (Không chấm lỗi đúng-sai!)
                </p>
                <h2 className="mt-1 text-2xl font-extrabold text-ink">
                  Chuyện gì xảy ra tiếp theo trong bức tranh?
                </h2>
                <p className="mt-1 text-body text-muted">
                  {session.scene_spec.creative_prompt_vi}
                </p>
              </div>
              <Button
                fullWidth={false}
                onClick={() =>
                  isSpeakingPrompt
                    ? stopAllTts()
                    : speakVietnamesePrompt(
                        `Chuyện gì xảy ra tiếp theo trong bức tranh? ${session.scene_spec.creative_prompt_vi}`,
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
                {isSpeakingPrompt ? "Dừng đọc" : "Nghe câu hỏi"}
              </Button>
            </div>
          </div>

          <MemorySceneCanvas
            matchedObjectIds={matchedObjectIds}
            missedObjectIds={missedObjectIds}
            mode="reveal"
            sceneSpec={session.scene_spec}
            showColorCues={showColorCues}
          />

          <div className="flex flex-col gap-3 rounded-card border border-border bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                className="text-lg font-extrabold text-ink"
                htmlFor="memory-creative-input"
              >
                Câu chuyện tưởng tượng của bé
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
                    Dừng ghi âm
                  </>
                ) : (
                  <>
                    <Mic aria-hidden="true" className="size-4" />
                    Kể bằng giọng nói
                  </>
                )}
              </Button>
            </div>

            {voiceNotice ? (
              <p className="text-sm font-semibold text-primary">
                {voiceNotice}
              </p>
            ) : null}

            <textarea
              className="min-h-32 w-full rounded-control border border-border bg-cream p-3.5 text-body text-ink focus:border-primary focus:outline-none"
              data-testid="creative-textarea"
              id="memory-creative-input"
              onChange={(e) => {
                setCreativeText(e.target.value);
                setCreativeInputMode("TEXT");
              }}
              placeholder="Ví dụ: Sau đó chú mèo rủ các bạn cùng nhau đi khám phá khu vườn cầu vồng thật vui vẻ..."
              value={creativeText}
            />

            <div className="flex flex-wrap justify-between gap-3">
              <Button
                fullWidth={false}
                onClick={() => setStage("REVEAL")}
                size="compact"
                variant="quiet"
              >
                Quay lại soi tranh
              </Button>
              <Button
                data-testid="submit-creative-btn"
                fullWidth={false}
                isLoading={isSubmitting}
                onClick={() => void handleSubmitCreative()}
              >
                <Sparkles aria-hidden="true" className="size-5" />
                Gửi câu chuyện sáng tạo
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ===================== STAGE F: WARM DUAL-TRACK FEEDBACK ===================== */}
      {stage === "SUMMARY" && session ? (
        <div className="flex flex-col gap-5" data-testid="summary-stage">
          <div className="rounded-card border border-border bg-cream p-6 text-center">
            <div className="mb-2 flex justify-center">
              {renderStars(session.stars)}
            </div>
            <h2 className="text-3xl font-extrabold text-ink">
              Tuyệt vời quá, {child.alias}!
            </h2>
            <p className="mt-2 text-body font-semibold text-muted">
              {creativeEvaluation?.praise_message_vi ??
                recallEvaluation?.praise_message_vi}
            </p>
          </div>

          {/* SEPARATE DUAL-TRACK SCORE CARDS */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div
              className="flex flex-col gap-2 rounded-card border-2 border-emerald-500/50 bg-success-surface p-5"
              data-testid="factual-score-card"
            >
              <span className="text-sm font-extrabold uppercase tracking-wide text-success-ink">
                Điểm ghi nhớ
              </span>
              <span
                className="text-4xl font-extrabold text-ink"
                data-testid="factual-score-value"
              >
                {displayFactualScore}/100
              </span>
              <p className="text-sm text-ink">
                {recallEvaluation?.praise_message_vi ??
                  "Bé quan sát và ghi nhớ chi tiết trong tranh rất tốt!"}
              </p>
            </div>

            <div
              className="flex flex-col gap-2 rounded-card border-2 border-purple-500/40 bg-purple p-5"
              data-testid="creative-score-card"
            >
              <span className="text-sm font-extrabold uppercase tracking-wide text-purple-ink">
                Điểm sáng tạo
              </span>
              <span
                className="text-4xl font-extrabold text-ink"
                data-testid="creative-score-value"
              >
                {displayCreativeScore}/100
              </span>
              <p className="text-sm text-ink">
                {creativeEvaluation?.story_praise_vi ??
                  "Trí tưởng tượng của bé thật phong phú và đáng yêu!"}
              </p>
            </div>
          </div>

          {creativeEvaluation?.creative_highlights &&
          creativeEvaluation.creative_highlights.length > 0 ? (
            <div className="rounded-card border border-border bg-white p-5">
              <h3 className="mb-2 text-lg font-extrabold text-purple-ink">
                ✨ Điểm sáng trong câu chuyện của bé
              </h3>
              <ul className="list-disc space-y-1.5 pl-5 text-body text-ink">
                {creativeEvaluation.creative_highlights.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {(creativeEvaluation?.support_summary_vi ??
          recallEvaluation?.support_summary_vi) ? (
            <div className="rounded-control border border-border bg-cream px-4 py-3 text-sm font-semibold text-muted">
              {creativeEvaluation?.support_summary_vi ??
                recallEvaluation?.support_summary_vi}
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
              Chơi bức tranh mới
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
