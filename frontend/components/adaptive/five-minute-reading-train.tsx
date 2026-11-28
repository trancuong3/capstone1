"use client";

import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Coffee,
  Mic,
  MicOff,
  RotateCcw,
  Sparkles,
  TrainFront,
  Volume2,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { AppServicesContext } from "@/components/providers/app-services-provider";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { useI18n } from "@/hooks/use-i18n";
import { useSpeechPlayer, type SpeechPlayer } from "@/hooks/use-speech-player";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import {
  createAdaptiveLearningService,
  type AdaptiveLearningService,
} from "@/lib/api/adaptive-learning-service";
import { createChildService, type ChildService } from "@/lib/api/child-service";
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import { cn } from "@/lib/utils/cn";
import type {
  DailyFiveMinuteTrainCompleteResponseDTO,
  DailyFiveMinuteTrainDTO,
  TrainInteractionMode,
} from "@/types/adaptive-learning";
import type { ChildProfileDTO } from "@/types/child";

type TrainStage = "CAR_1" | "CAR_2" | "CAR_3" | "COMPLETED";

export interface FiveMinuteReadingTrainProps {
  readonly initialChildId?: string;
  readonly sourceSurface?: string;
  readonly initialPlan?: DailyFiveMinuteTrainDTO | null;
  readonly adaptiveServiceOverride?: AdaptiveLearningService;
  readonly childServiceOverride?: Pick<ChildService, "list">;
  readonly speechPlayerOverride?: Pick<SpeechPlayer, "play" | "stop">;
  /** Optional hook for deterministic mic availability/permission testing. */
  readonly requestMicrophoneTurn?: () => Promise<boolean>;
}

function splitIntoRhythmPhrases(text: string): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  const clauses = cleaned
    .split(/(?<=[.,!?;:—–])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (clauses.length >= 2) {
    return clauses.slice(0, 4);
  }
  const words = cleaned.split(/\s+/u).filter(Boolean);
  if (words.length <= 5) return [cleaned];
  const chunkSize = Math.ceil(words.length / 3);
  const chunks: string[] = [];
  for (let idx = 0; idx < words.length; idx += chunkSize) {
    chunks.push(words.slice(idx, idx + chunkSize).join(" "));
  }
  return chunks;
}

function deterministicTokenPool(
  sentenceTokens: readonly string[],
  distractorTokens: readonly string[],
): Array<{ readonly id: string; readonly text: string }> {
  const combined = [
    ...sentenceTokens.map((text, idx) => ({ id: `tok-${idx}`, text })),
    ...distractorTokens.map((text, idx) => ({ id: `dist-${idx}`, text })),
  ];
  // Gentle deterministic interleave (odd indices then even indices) so order requires real attention without randomness flicker
  const evens = combined.filter((_, idx) => idx % 2 === 0);
  const odds = combined.filter((_, idx) => idx % 2 === 1);
  return [...odds, ...evens];
}

async function defaultProbeMicrophoneTurn(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return true;
  } catch {
    return false;
  }
}

export function FiveMinuteReadingTrain({
  initialChildId,
  sourceSurface,
  initialPlan = null,
  adaptiveServiceOverride,
  childServiceOverride,
  speechPlayerOverride,
  requestMicrophoneTurn,
}: FiveMinuteReadingTrainProps) {
  const { t } = useI18n();
  const teacherPersona = useTeacherPersona();
  const appStore = useContext(AppStoreContext);
  const appServices = useContext(AppServicesContext);
  const defaultSpeechPlayer = useSpeechPlayer();
  const speechPlayer = speechPlayerOverride ?? defaultSpeechPlayer;
  const speechRef = useRef(speechPlayer);
  const childSelectId = useId();
  const startedAtMsRef = useRef<number>(0);

  useEffect(() => {
    if (startedAtMsRef.current === 0) {
      startedAtMsRef.current = Date.now();
    }
  }, []);

  const adaptiveService = useMemo(
    () => adaptiveServiceOverride ?? createAdaptiveLearningService(),
    [adaptiveServiceOverride],
  );
  const childService = useMemo(
    () =>
      childServiceOverride ?? appServices?.childService ?? createChildService(),
    [appServices?.childService, childServiceOverride],
  );

  useEffect(() => {
    speechRef.current = speechPlayer;
  }, [speechPlayer]);

  useEffect(() => {
    return () => {
      speechRef.current.stop();
    };
  }, []);

  const [childrenList, setChildrenList] = useState<readonly ChildProfileDTO[]>(
    [],
  );
  const [activeChildId, setActiveChildId] = useState<string | null>(
    initialPlan?.child_id ??
      initialChildId ??
      appStore?.selectedChildId ??
      null,
  );
  const [loadStatus, setLoadStatus] = useState<
    "loading" | "ready" | "no-children" | "error"
  >(initialPlan ? "ready" : "loading");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [plan, setPlan] = useState<DailyFiveMinuteTrainDTO | null>(initialPlan);

  // Seamless 3-car coordinator state
  const initialMicMissing =
    !requestMicrophoneTurn &&
    typeof window !== "undefined" &&
    (typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function");
  const [stage, setStage] = useState<TrainStage>("CAR_1");
  const [noMicMode, setNoMicMode] = useState<boolean>(initialMicMissing);
  const [autoNoMicReason, setAutoNoMicReason] =
    useState<boolean>(initialMicMissing);
  const [usedVoiceStep, setUsedVoiceStep] = useState(false);
  const [usedTouchStep, setUsedTouchStep] = useState(false);
  const [recordingWordKey, setRecordingWordKey] = useState<string | null>(null);

  // Car 1 state
  const [practicedWords, setPracticedWords] = useState<Record<string, boolean>>(
    {},
  );
  // Car 2 state
  const [selectedTokenIds, setSelectedTokenIds] = useState<string[]>([]);
  const [car2Hint, setCar2Hint] = useState<string | null>(null);
  const [car2Completed, setCar2Completed] = useState(false);
  // Car 3 state
  const [tappedPhraseIndices, setTappedPhraseIndices] = useState<
    Record<number, boolean>
  >({});
  const [car3VoiceDone, setCar3VoiceDone] = useState(false);
  // Completion state
  const [isCompleting, setIsCompleting] = useState(false);
  const [completionError, setCompletionError] = useState(false);
  const [completionResult, setCompletionResult] =
    useState<DailyFiveMinuteTrainCompleteResponseDTO | null>(null);

  const resetJourneyState = useCallback(() => {
    startedAtMsRef.current = Date.now();
    setStage("CAR_1");
    setPracticedWords({});
    setSelectedTokenIds([]);
    setCar2Hint(null);
    setCar2Completed(false);
    setTappedPhraseIndices({});
    setCar3VoiceDone(false);
    setCompletionError(false);
    setCompletionResult(null);
  }, []);

  // Automatic microphone permission check on mount
  useEffect(() => {
    if (requestMicrophoneTurn) return;
    if (
      typeof navigator === "undefined" ||
      typeof navigator.permissions?.query !== "function"
    ) {
      return;
    }
    let active = true;
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((perm) => {
        if (active && perm.state === "denied") {
          setNoMicMode(true);
          setAutoNoMicReason(true);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [requestMicrophoneTurn]);

  // Load children + active child's 5-minute train plan
  useEffect(() => {
    if (initialPlan && reloadNonce === 0) {
      return;
    }
    let active = true;
    async function load() {
      setLoadStatus("loading");
      try {
        const children = await childService.list();
        if (!active) return;
        setChildrenList(children);
        if (children.length === 0) {
          setLoadStatus("no-children");
          return;
        }
        const preferredId =
          activeChildId && children.some((c) => c.id === activeChildId)
            ? activeChildId
            : initialChildId && children.some((c) => c.id === initialChildId)
              ? initialChildId
              : appStore?.selectedChildId &&
                  children.some((c) => c.id === appStore.selectedChildId)
                ? appStore.selectedChildId
                : children[0].id;

        const chosenChild =
          children.find((c) => c.id === preferredId) ?? children[0];
        hydrateTeacherVoiceFromChildProfile(chosenChild);
        if (preferredId !== activeChildId) {
          setActiveChildId(chosenChild.id);
        }

        const fetchedPlan = await adaptiveService.getDailyFiveMinuteTrain(
          chosenChild.id,
          teacherPersona.gender,
        );
        if (!active) return;
        setPlan(fetchedPlan);
        resetJourneyState();
        setLoadStatus("ready");
      } catch {
        if (active) {
          setLoadStatus("error");
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [
    activeChildId,
    adaptiveService,
    appStore?.selectedChildId,
    childService,
    initialChildId,
    initialPlan,
    reloadNonce,
    resetJourneyState,
    teacherPersona.gender,
  ]);

  const speakSafely = useCallback(
    (text: string, speedScale = 0.9) => {
      const cleaned = text.trim();
      if (!cleaned) return;
      void speechPlayer.play(cleaned, { speedScale }).catch(() => undefined);
    },
    [speechPlayer],
  );

  const runVoiceTurnOrAutoFallback = useCallback(
    async (key: string, onSuccess: () => void) => {
      setRecordingWordKey(key);
      try {
        const probe = requestMicrophoneTurn ?? defaultProbeMicrophoneTurn;
        const ok = await probe();
        if (!ok) {
          setNoMicMode(true);
          setAutoNoMicReason(true);
          return;
        }
        setUsedVoiceStep(true);
        onSuccess();
      } catch {
        setNoMicMode(true);
        setAutoNoMicReason(true);
      } finally {
        setRecordingWordKey(null);
      }
    },
    [requestMicrophoneTurn],
  );

  const handleToggleNoMic = () => {
    setAutoNoMicReason(false);
    setNoMicMode((prev) => !prev);
  };

  const car1Words = plan?.car_1_warmup.target_words ?? [];
  const car1DoneCount = car1Words.filter(
    (w) => practicedWords[w.normalized_word],
  ).length;
  const car1AllDone = car1Words.length > 0 && car1DoneCount >= car1Words.length;

  const car2Pool = useMemo(
    () =>
      plan
        ? deterministicTokenPool(
            plan.car_2_game.sentence_tokens,
            plan.car_2_game.distractor_tokens,
          )
        : [],
    [plan],
  );

  const selectedTokensText = useMemo(
    () =>
      selectedTokenIds
        .map((id) => car2Pool.find((item) => item.id === id)?.text ?? "")
        .filter(Boolean),
    [car2Pool, selectedTokenIds],
  );

  const handleTapCar2Token = (tokenId: string, tokenText: string) => {
    if (!plan || car2Completed || selectedTokenIds.includes(tokenId)) return;
    const expectedNext =
      plan.car_2_game.sentence_tokens[selectedTokenIds.length];
    if (
      expectedNext &&
      tokenText.trim().toLowerCase() === expectedNext.trim().toLowerCase()
    ) {
      const nextSelected = [...selectedTokenIds, tokenId];
      setSelectedTokenIds(nextSelected);
      setCar2Hint(null);
      if (!noMicMode) {
        speakSafely(tokenText, 0.95);
      } else {
        setUsedTouchStep(true);
      }
      if (nextSelected.length >= plan.car_2_game.sentence_tokens.length) {
        setCar2Completed(true);
      }
    } else {
      setCar2Hint(t("fiveMinTrain.car2.gentleHint"));
    }
  };

  const rhythmPhrases = useMemo(
    () => (plan ? splitIntoRhythmPhrases(plan.car_3_fluency.text_vi) : []),
    [plan],
  );
  const allPhrasesTapped =
    rhythmPhrases.length > 0 &&
    rhythmPhrases.every((_, idx) => Boolean(tappedPhraseIndices[idx]));
  const car3Ready = car3VoiceDone || allPhrasesTapped;

  const resolveInteractionMode = (): TrainInteractionMode => {
    if (noMicMode && !usedVoiceStep) return "NO_MIC_TOUCH";
    if (usedVoiceStep && (usedTouchStep || noMicMode)) return "MIXED";
    if (!usedVoiceStep && usedTouchStep) return "NO_MIC_TOUCH";
    return noMicMode ? "NO_MIC_TOUCH" : "VOICE";
  };

  const handleFinishTrain = async () => {
    if (!plan || isCompleting) return;
    setIsCompleting(true);
    setCompletionError(false);
    const elapsedSeconds = Math.min(
      1800,
      Math.max(
        30,
        Math.round((Date.now() - startedAtMsRef.current) / 1000) || 300,
      ),
    );
    const mode = resolveInteractionMode();
    try {
      const result = await adaptiveService.completeDailyFiveMinuteTrain(
        plan.child_id,
        {
          train_id: plan.train_id,
          client_completion_id: `${plan.train_id}-${mode.toLowerCase()}`,
          interaction_mode: mode,
          duration_seconds: elapsedSeconds,
          practiced_words: plan.car_1_warmup.target_words.map(
            (w) => w.display_text,
          ),
          car_2_game_key: plan.car_2_game.game_key,
          car_3_finish_mode: plan.car_3_fluency.finish_mode,
          car_1_completed: true,
          car_2_completed: true,
          car_3_completed: true,
        },
      );
      setCompletionResult(result);
      setStage("COMPLETED");
    } catch {
      setCompletionError(true);
    } finally {
      setIsCompleting(false);
    }
  };

  const backLink = useMemo(() => {
    const childParam = activeChildId
      ? `?childId=${encodeURIComponent(activeChildId)}`
      : "";
    if (sourceSurface === "reports") {
      return {
        href: `/reports${childParam}`,
        label: t("fiveMinTrain.header.backToReports"),
      };
    }
    if (sourceSurface === "entertainment") {
      return {
        href: "/entertainment",
        label: t("fiveMinTrain.header.backToEntertainment"),
      };
    }
    return {
      href: "/dashboard",
      label: t("fiveMinTrain.header.backToDashboard"),
    };
  }, [activeChildId, sourceSurface, t]);

  if (loadStatus === "loading") {
    return (
      <section
        aria-busy="true"
        aria-label={t("fiveMinTrain.states.loadingTitle")}
        className="mx-auto flex w-full max-w-[960px] flex-col gap-4"
      >
        <p className="text-sm font-bold text-muted">
          {t("fiveMinTrain.states.loadingTitle")}
        </p>
        <Skeleton className="h-20 rounded-card" />
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </section>
    );
  }

  if (loadStatus === "no-children") {
    return (
      <EmptyState
        action={
          <ButtonLink href="/children/new">
            {t("fiveMinTrain.states.createChildAction")}
          </ButtonLink>
        }
        description={t("fiveMinTrain.states.noChildrenDescription")}
        headingLevel={1}
        title={t("fiveMinTrain.states.noChildrenTitle")}
      />
    );
  }

  if (loadStatus === "error" || !plan) {
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <StatusMessage title={t("fiveMinTrain.states.errorTitle")} tone="error">
          {t("fiveMinTrain.states.errorDescription")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start"
          onClick={() => setReloadNonce((n) => n + 1)}
          type="button"
          variant="secondary"
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          {t("fiveMinTrain.states.retryAction")}
        </Button>
      </section>
    );
  }

  const stageOrder: Record<TrainStage, number> = {
    CAR_1: 1,
    CAR_2: 2,
    CAR_3: 3,
    COMPLETED: 4,
  };
  const activeOrder = stageOrder[stage];

  return (
    <section
      className="mx-auto flex w-full max-w-[960px] flex-col gap-4 pb-6"
      data-testid="five-minute-reading-train"
    >
      {/* Top Bar: Calm Back Link, Child Selector, and "Tạm không tiện bật mic" Toggle */}
      <header className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink
              className="min-h-10 px-3"
              href={backLink.href}
              size="compact"
              variant="quiet"
            >
              <ArrowLeft
                aria-hidden="true"
                className="viread-rtl-flip size-4"
              />
              {backLink.label}
            </ButtonLink>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-extrabold text-emerald-900">
              <TrainFront aria-hidden="true" className="size-3.5" />
              {t("fiveMinTrain.header.childBadge", {
                alias: plan.child_alias,
                grade: plan.child_grade,
              })}
            </span>
            {plan.is_cold_start ? (
              <span
                className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-900"
                data-testid="train-cold-start-badge"
              >
                {t("fiveMinTrain.header.coldStartBadge")}
              </span>
            ) : null}
            {plan.completed_today ? (
              <span className="rounded-full bg-sky px-2.5 py-1 text-xs font-bold text-primary-hover">
                {t("fiveMinTrain.header.completedTodayBadge", {
                  count: plan.today_completed_count,
                })}
              </span>
            ) : null}
          </div>
          <h1 className="text-xl font-extrabold tracking-[-0.02em] text-ink sm:text-2xl">
            {t("fiveMinTrain.pageTitle")}
          </h1>
          <p
            className="viread-learning-content text-sm text-muted"
            dir="ltr"
            lang="vi"
          >
            {adaptTextToTeacherPersona(plan.greeting_vi, teacherPersona.gender)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {childrenList.length > 1 ? (
            <div>
              <label className="sr-only" htmlFor={childSelectId}>
                {t("fiveMinTrain.header.selectChildAria")}
              </label>
              <select
                aria-label={t("fiveMinTrain.header.selectChildAria")}
                className="min-h-12 cursor-pointer rounded-control border border-border bg-white px-3 text-sm font-bold text-ink"
                id={childSelectId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setActiveChildId(nextId);
                  appStore?.selectChild(nextId);
                  setReloadNonce((n) => n + 1);
                }}
                value={plan.child_id}
              >
                {childrenList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.alias} (Lớp {c.grade})
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <Button
            aria-pressed={noMicMode}
            className="min-h-12 px-4"
            data-testid="train-no-mic-toggle"
            fullWidth={false}
            onClick={handleToggleNoMic}
            size="compact"
            type="button"
            variant={noMicMode ? "primary" : "secondary"}
          >
            {noMicMode ? (
              <MicOff aria-hidden="true" className="size-4" />
            ) : (
              <Mic aria-hidden="true" className="size-4" />
            )}
            {t("fiveMinTrain.header.noMicToggle")}
          </Button>
        </div>
      </header>

      {/* No-Mic Active Notice Banner */}
      {noMicMode ? (
        <div
          className="flex items-start gap-2.5 rounded-card border border-amber-200 bg-amber-50/90 px-4 py-3 text-xs font-semibold text-amber-950 sm:text-sm"
          data-testid="train-no-mic-banner"
          role="status"
        >
          <MicOff
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-amber-700"
          />
          <span>
            {autoNoMicReason
              ? t("fiveMinTrain.header.autoNoMicBanner")
              : t("fiveMinTrain.header.manualNoMicBanner")}
          </span>
        </div>
      ) : null}

      {/* Visual 3-Car Train Progress Bar (Toa 1 -> Toa 2 -> Toa 3 -> Ga Về Đích) */}
      <nav
        aria-label={t("fiveMinTrain.progress.ariaLabel")}
        className="rounded-card border border-emerald-200 bg-gradient-to-r from-emerald-50/80 via-white to-sky/40 p-4"
        data-testid="train-3car-progress"
      >
        <ol className="grid gap-2 sm:grid-cols-4">
          {[
            {
              key: "CAR_1",
              order: 1,
              label: t("fiveMinTrain.progress.car1Short"),
              secs: `${plan.car_1_warmup.estimated_seconds}s`,
            },
            {
              key: "CAR_2",
              order: 2,
              label: t("fiveMinTrain.progress.car2Short"),
              secs: `${plan.car_2_game.estimated_seconds}s`,
            },
            {
              key: "CAR_3",
              order: 3,
              label: t("fiveMinTrain.progress.car3Short"),
              secs: `${plan.car_3_fluency.estimated_seconds}s`,
            },
            {
              key: "COMPLETED",
              order: 4,
              label: t("fiveMinTrain.progress.finishShort"),
              secs: "~5p",
            },
          ].map((item) => {
            const isDone = activeOrder > item.order || stage === "COMPLETED";
            const isCurrent =
              activeOrder === item.order && stage !== "COMPLETED";
            return (
              <li
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-control border px-3 py-2.5 text-xs font-extrabold transition",
                  isCurrent
                    ? "border-primary bg-primary text-white shadow-xs"
                    : isDone
                      ? "border-emerald-300 bg-emerald-100/80 text-emerald-950"
                      : "border-border bg-white/80 text-muted",
                )}
                data-testid={`train-step-${item.key.toLowerCase()}`}
                key={item.key}
              >
                <span className="flex items-center gap-1.5 truncate">
                  {isDone ? (
                    <CheckCircle2
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                  ) : (
                    <TrainFront
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                  )}
                  <span className="truncate">{item.label}</span>
                </span>
                <span className="shrink-0 opacity-85">{item.secs}</span>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-center text-[11px] font-semibold text-muted">
          {t("fiveMinTrain.progress.paceLabel")}
        </p>
      </nav>

      {/* TOA 1: Khởi động từ khó (~90s) */}
      {stage === "CAR_1" ? (
        <section
          aria-labelledby="car1-heading"
          className="space-y-4 rounded-card border border-border bg-white p-5 shadow-xs sm:p-6"
          data-testid="train-car-1"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold text-amber-950">
                <Sparkles aria-hidden="true" className="size-3.5" />
                {plan.car_1_warmup.dominant_phonics_label_vi}
              </span>
              <h2
                className="viread-learning-content text-lg font-extrabold text-ink sm:text-xl"
                dir="ltr"
                id="car1-heading"
                lang="vi"
              >
                {plan.car_1_warmup.title_vi}
              </h2>
              <p
                className="viread-learning-content text-sm text-muted"
                dir="ltr"
                lang="vi"
              >
                {adaptTextToTeacherPersona(
                  plan.car_1_warmup.subtitle_vi,
                  teacherPersona.gender,
                )}
              </p>
            </div>
            <span className="rounded-full bg-canvas px-3 py-1 text-xs font-bold text-ink">
              {t("fiveMinTrain.car1.progressStatus", {
                done: car1DoneCount,
                total: car1Words.length,
              })}
            </span>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {car1Words.map((item) => {
              const done = Boolean(practicedWords[item.normalized_word]);
              const isRec = recordingWordKey === item.normalized_word;
              return (
                <article
                  className={cn(
                    "flex flex-col justify-between gap-3 rounded-card border p-4 transition",
                    done
                      ? "border-emerald-300 bg-emerald-50/60"
                      : "border-border bg-canvas/45",
                  )}
                  data-testid={`car1-word-card-${item.normalized_word}`}
                  key={item.normalized_word}
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded-full bg-white px-2.5 py-0.5 text-[11px] font-bold text-muted">
                        {item.phonics_label_vi}
                      </span>
                      {done ? (
                        <CheckCircle2
                          aria-label={t("fiveMinTrain.car1.wordPracticed")}
                          className="size-4 text-emerald-700"
                        />
                      ) : null}
                    </div>
                    <p
                      className="viread-learning-content text-2xl font-extrabold text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {item.display_text}
                    </p>
                    <p
                      className="viread-learning-content text-xs leading-relaxed text-muted"
                      dir="ltr"
                      lang="vi"
                    >
                      {item.syllable_hint_vi}
                    </p>
                    <p
                      className="viread-learning-content rounded-control bg-white/85 px-2.5 py-1.5 text-xs text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      <span className="font-bold">
                        {t("fiveMinTrain.car1.sampleSentenceLabel")}{" "}
                      </span>
                      {item.sample_sentence_vi}
                    </p>
                  </div>

                  <div className="flex flex-col gap-2 pt-1">
                    <Button
                      className="min-h-11"
                      onClick={() => speakSafely(item.display_text, 0.88)}
                      size="compact"
                      type="button"
                      variant="secondary"
                    >
                      <Volume2 aria-hidden="true" className="size-4" />
                      {t("fiveMinTrain.car1.listenWord")}
                    </Button>

                    {noMicMode ? (
                      <Button
                        className="min-h-12"
                        data-testid={`car1-touch-confirm-${item.normalized_word}`}
                        disabled={done}
                        onClick={() => {
                          speakSafely(item.display_text, 0.88);
                          setUsedTouchStep(true);
                          setPracticedWords((prev) => ({
                            ...prev,
                            [item.normalized_word]: true,
                          }));
                        }}
                        size="compact"
                        type="button"
                      >
                        <CheckCircle2 aria-hidden="true" className="size-4" />
                        {done
                          ? t("fiveMinTrain.car1.wordPracticed")
                          : t("fiveMinTrain.car1.tapConfirmWord")}
                      </Button>
                    ) : (
                      <Button
                        className="min-h-12"
                        data-testid={`car1-voice-practice-${item.normalized_word}`}
                        disabled={done || isRec}
                        onClick={() =>
                          void runVoiceTurnOrAutoFallback(
                            item.normalized_word,
                            () =>
                              setPracticedWords((prev) => ({
                                ...prev,
                                [item.normalized_word]: true,
                              })),
                          )
                        }
                        size="compact"
                        type="button"
                      >
                        <Mic aria-hidden="true" className="size-4" />
                        {done
                          ? t("fiveMinTrain.car1.wordPracticed")
                          : isRec
                            ? t("fiveMinTrain.car1.recordingWord")
                            : t("fiveMinTrain.car1.speakWord")}
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="flex justify-end pt-2">
            <Button
              className="min-h-12 sm:w-auto"
              data-testid="advance-to-car-2"
              disabled={!car1AllDone}
              onClick={() => setStage("CAR_2")}
              type="button"
            >
              {t("fiveMinTrain.car1.advanceToCar2")}{" "}
              <ArrowRight
                aria-hidden="true"
                className="viread-rtl-flip size-4"
              />
            </Button>
          </div>
        </section>
      ) : null}

      {/* TOA 2: Vận dụng qua trò chơi (~120s) */}
      {stage === "CAR_2" ? (
        <section
          aria-labelledby="car2-heading"
          className="space-y-4 rounded-card border border-border bg-white p-5 shadow-xs sm:p-6"
          data-testid="train-car-2"
        >
          <div className="space-y-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sky px-3 py-1 text-xs font-extrabold text-primary-hover">
              {plan.car_2_game.game_key === "PICTURE_DESCRIPTION"
                ? "Kể chuyện qua tranh"
                : "Xạ thủ ghép câu"}
            </span>
            <h2
              className="viread-learning-content text-lg font-extrabold text-ink sm:text-xl"
              dir="ltr"
              id="car2-heading"
              lang="vi"
            >
              {plan.car_2_game.title_vi}
            </h2>
            <p
              className="viread-learning-content text-sm text-muted"
              dir="ltr"
              lang="vi"
            >
              {plan.car_2_game.prompt_vi}
            </p>
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
              <span className="font-bold text-muted">
                {t("fiveMinTrain.car2.seededWordsLabel")}
              </span>
              {plan.car_2_game.seeded_words.map((word) => (
                <span
                  className="viread-learning-content rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 font-extrabold text-amber-950"
                  dir="ltr"
                  key={word}
                  lang="vi"
                >
                  {word}
                </span>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11 sm:w-auto"
              onClick={() =>
                speakSafely(plan.car_2_game.sentence_tokens.join(" "), 0.9)
              }
              size="compact"
              type="button"
              variant="secondary"
            >
              <Volume2 aria-hidden="true" className="size-4" />
              {t("fiveMinTrain.car2.listenSentence")}
            </Button>
            {selectedTokenIds.length > 0 && !car2Completed ? (
              <Button
                className="min-h-11 sm:w-auto"
                onClick={() => {
                  setSelectedTokenIds([]);
                  setCar2Hint(null);
                }}
                size="compact"
                type="button"
                variant="quiet"
              >
                <RotateCcw aria-hidden="true" className="size-4" />
                {t("fiveMinTrain.car2.resetSentence")}
              </Button>
            ) : null}
          </div>

          {/* Built sentence tray */}
          <div className="rounded-card border border-dashed border-primary/40 bg-canvas/60 p-4">
            <p className="text-xs font-bold text-muted">
              {t("fiveMinTrain.car2.selectedSentenceLabel")}
            </p>
            <div className="mt-2 flex min-h-11 flex-wrap items-center gap-2">
              {selectedTokensText.length === 0 ? (
                <span className="text-sm text-muted">
                  {t("fiveMinTrain.car2.emptySlotsHint")}
                </span>
              ) : (
                selectedTokensText.map((tok, idx) => (
                  <span
                    className="viread-learning-content rounded-control bg-primary px-3 py-1.5 text-sm font-extrabold text-white"
                    dir="ltr"
                    key={`${tok}-${idx}`}
                    lang="vi"
                  >
                    {tok}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Interactive word chips */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted">
              {t("fiveMinTrain.car2.tapInstruction")}
            </p>
            <div className="flex flex-wrap gap-2">
              {car2Pool.map((token) => {
                const used = selectedTokenIds.includes(token.id);
                return (
                  <button
                    className={cn(
                      "viread-learning-content min-h-12 cursor-pointer rounded-control border px-3.5 py-2 text-sm font-extrabold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      used
                        ? "cursor-default border-border bg-canvas text-muted opacity-45"
                        : "border-amber-300 bg-amber-50/70 text-ink hover:border-primary hover:bg-sky/40",
                    )}
                    data-testid={`car2-token-${token.id}`}
                    dir="ltr"
                    disabled={used || car2Completed}
                    key={token.id}
                    lang="vi"
                    onClick={() => handleTapCar2Token(token.id, token.text)}
                    type="button"
                  >
                    {token.text}
                  </button>
                );
              })}
            </div>
          </div>

          {car2Hint ? (
            <p className="text-xs font-semibold text-amber-800" role="status">
              {car2Hint}
            </p>
          ) : null}

          {car2Completed ? (
            <div className="flex items-center gap-2 rounded-control bg-emerald-50 px-3.5 py-2.5 text-sm font-bold text-emerald-900">
              <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
              <span>{t("fiveMinTrain.car2.roundCompleted")}</span>
            </div>
          ) : null}

          <div className="flex justify-end pt-2">
            <Button
              className="min-h-12 sm:w-auto"
              data-testid="advance-to-car-3"
              disabled={!car2Completed}
              onClick={() => setStage("CAR_3")}
              type="button"
            >
              {t("fiveMinTrain.car2.advanceToCar3")}{" "}
              <ArrowRight
                aria-hidden="true"
                className="viread-rtl-flip size-4"
              />
            </Button>
          </div>
        </section>
      ) : null}

      {/* TOA 3: Về đích trôi chảy (~90s) */}
      {stage === "CAR_3" ? (
        <section
          aria-labelledby="car3-heading"
          className="space-y-4 rounded-card border border-border bg-white p-5 shadow-xs sm:p-6"
          data-testid="train-car-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-extrabold text-emerald-950">
                  {plan.car_3_fluency.finish_mode === "SLOW_KARAOKE_085X"
                    ? t("fiveMinTrain.car3.karaokeBadge")
                    : t("fiveMinTrain.car3.passageBadge")}
                </span>
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-950">
                  {t("fiveMinTrain.car3.speedBadge")}
                </span>
              </div>
              <h2
                className="viread-learning-content text-lg font-extrabold text-ink sm:text-xl"
                dir="ltr"
                id="car3-heading"
                lang="vi"
              >
                {plan.car_3_fluency.title_vi} —{" "}
                {plan.car_3_fluency.passage_title_vi}
              </h2>
              <p
                className="viread-learning-content text-sm text-muted"
                dir="ltr"
                lang="vi"
              >
                {plan.car_3_fluency.subtitle_vi}
              </p>
            </div>
          </div>

          <div className="rounded-card border border-emerald-200 bg-gradient-to-br from-cream via-white to-emerald-50/50 p-5">
            <p
              className="viread-learning-content text-lg leading-8 font-bold text-ink sm:text-xl"
              dir="ltr"
              lang="vi"
            >
              {plan.car_3_fluency.text_vi}
            </p>
            <p
              className="viread-learning-content mt-3 text-xs text-muted sm:text-sm"
              dir="ltr"
              lang="vi"
            >
              <span className="font-bold text-ink">
                {t("fiveMinTrain.car3.coachingLabel")}{" "}
              </span>
              {plan.car_3_fluency.coaching_tip_vi}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-12 sm:w-auto"
              data-testid="car3-listen-085x"
              onClick={() =>
                speakSafely(
                  plan.car_3_fluency.text_vi,
                  plan.car_3_fluency.playback_speed || 0.85,
                )
              }
              size="compact"
              type="button"
              variant="secondary"
            >
              <Volume2 aria-hidden="true" className="size-4" />
              {t("fiveMinTrain.car3.listenSlow085")}
            </Button>

            {!noMicMode ? (
              <Button
                className="min-h-12 sm:w-auto"
                data-testid="car3-voice-practice"
                disabled={car3VoiceDone || recordingWordKey === "car3"}
                onClick={() =>
                  void runVoiceTurnOrAutoFallback("car3", () =>
                    setCar3VoiceDone(true),
                  )
                }
                size="compact"
                type="button"
              >
                <Mic aria-hidden="true" className="size-4" />
                {car3VoiceDone
                  ? t("fiveMinTrain.car1.wordPracticed")
                  : recordingWordKey === "car3"
                    ? t("fiveMinTrain.car1.recordingWord")
                    : t("fiveMinTrain.car3.speakPassage")}
              </Button>
            ) : null}
          </div>

          {/* Listen & Tap rhythm beats (always available in No-Mic Mode and as calm companion) */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted">
              {t("fiveMinTrain.car3.tapRhythmInstruction")}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {rhythmPhrases.map((phrase, idx) => {
                const done = Boolean(tappedPhraseIndices[idx]);
                return (
                  <button
                    className={cn(
                      "viread-learning-content flex min-h-12 cursor-pointer items-center justify-between gap-2 rounded-control border px-3.5 py-2.5 text-start text-sm font-bold transition",
                      done
                        ? "border-emerald-300 bg-emerald-50 text-emerald-950"
                        : "border-border bg-canvas/50 text-ink hover:border-primary",
                    )}
                    data-testid={`car3-rhythm-phrase-${idx}`}
                    dir="ltr"
                    key={`${idx}-${phrase}`}
                    lang="vi"
                    onClick={() => {
                      speakSafely(phrase, 0.85);
                      setUsedTouchStep(true);
                      setTappedPhraseIndices((prev) => ({
                        ...prev,
                        [idx]: true,
                      }));
                    }}
                    type="button"
                  >
                    <span>{phrase}</span>
                    <span className="shrink-0 text-xs font-extrabold text-primary">
                      {done
                        ? t("fiveMinTrain.car3.rhythmStepDone", {
                            index: idx + 1,
                          })
                        : t("fiveMinTrain.car3.rhythmStepPrompt", {
                            index: idx + 1,
                          })}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {completionError ? (
            <StatusMessage
              title={t("fiveMinTrain.states.errorTitle")}
              tone="error"
            >
              {t("fiveMinTrain.states.errorDescription")}
            </StatusMessage>
          ) : null}

          <div className="flex justify-end pt-2">
            <Button
              className="min-h-12 sm:w-auto"
              data-testid="complete-five-minute-train-btn"
              disabled={!car3Ready || isCompleting}
              onClick={() => void handleFinishTrain()}
              type="button"
            >
              {isCompleting
                ? t("fiveMinTrain.car3.completingAction")
                : t("fiveMinTrain.car3.finishTrainAction")}{" "}
              <CheckCircle2 aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </section>
      ) : null}

      {/* GA VỀ ĐÍCH: Calm Celebration & Natural Break Cue (Zero Dark Patterns) */}
      {stage === "COMPLETED" && completionResult ? (
        <section
          aria-labelledby="train-completed-heading"
          className="space-y-4 rounded-card border border-emerald-300 bg-gradient-to-br from-emerald-50/90 via-cream to-sky/45 p-6 shadow-xs"
          data-testid="train-completed-cue"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-extrabold text-emerald-900 shadow-xs">
              <CheckCircle2
                aria-hidden="true"
                className="size-4 text-emerald-700"
              />
              {t("fiveMinTrain.completed.badge")}
            </span>
          </div>

          <h2
            className="viread-learning-content text-xl font-extrabold text-ink sm:text-2xl"
            dir="ltr"
            id="train-completed-heading"
            lang="vi"
          >
            {completionResult.celebration_title_vi}
          </h2>

          <div className="flex items-start gap-3 rounded-card border border-emerald-200 bg-white/90 p-4">
            <Coffee
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-emerald-700"
            />
            <div className="space-y-1">
              <p className="text-sm font-extrabold text-ink">
                {t("fiveMinTrain.completed.naturalBreakHeading")}
              </p>
              <p
                className="viread-learning-content text-sm leading-relaxed text-muted"
                dir="ltr"
                lang="vi"
              >
                {completionResult.natural_break_cue_vi}
              </p>
            </div>
          </div>

          <p className="text-xs font-semibold text-muted">
            {t("fiveMinTrain.completed.evidenceSummary", {
              count: completionResult.recorded_evidence_count,
            })}
            {completionResult.interaction_mode === "NO_MIC_TOUCH"
              ? ` · ${t("fiveMinTrain.completed.noMicEvidenceNote")}`
              : ""}
          </p>

          <div className="flex flex-wrap gap-2.5 pt-1">
            <ButtonLink
              className="min-h-12 sm:w-auto"
              href={`/reports?childId=${encodeURIComponent(plan.child_id)}`}
            >
              {t("fiveMinTrain.header.backToReports")}
            </ButtonLink>
            <ButtonLink
              className="min-h-12 sm:w-auto"
              href="/dashboard"
              variant="secondary"
            >
              {t("fiveMinTrain.header.backToDashboard")}
            </ButtonLink>
            <ButtonLink
              className="min-h-12 sm:w-auto"
              href="/entertainment"
              variant="quiet"
            >
              {t("fiveMinTrain.header.backToEntertainment")}
            </ButtonLink>
          </div>
        </section>
      ) : null}
    </section>
  );
}
