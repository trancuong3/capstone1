"use client";

import Image from "next/image";
import {
  ArrowRight,
  BookHeart,
  BookOpen,
  Brain,
  Coffee,
  HelpCircle,
  Mic,
  Music2,
  Sparkles,
  Volume2,
  VolumeX,
  Wind,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { FiveMinuteTrainCtaCard } from "@/components/adaptive/five-minute-train-cta-card";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button, ButtonLink } from "@/components/common/button";
import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";
import { AppServicesContext } from "@/components/providers/app-services-provider";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { VocabularyNotebookDrawer } from "@/components/reading/vocabulary-notebook-drawer";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useEntertainmentPreferences } from "@/hooks/use-entertainment-preferences";
import { useTranslations } from "@/hooks/use-i18n";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { createAdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import { createChildService } from "@/lib/api/child-service";
import {
  createVocabularyNotebookService,
  type VocabularyNotebookListDTO,
  type VocabularyNotebookService,
} from "@/lib/api/vocabulary-notebook-service";
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import { cn } from "@/lib/utils/cn";
import { useWordGlossaryTranslations } from "@/messages/features/word_glossary";
import type {
  CrossGameRecommendationDTO,
  EntertainmentRecommendationsDTO,
  GameKey,
} from "@/types/adaptive-learning";
import type { ChildProfileDTO } from "@/types/child";

const ONBOARDING_STORAGE_KEY = "viread:entertainment-v4-onboarding-done";

interface Props {
  readonly initialRecommendations?: EntertainmentRecommendationsDTO | null;
  readonly vocabularyService?: VocabularyNotebookService;
}

function ViReadMascot({ reducedMotion }: { readonly reducedMotion: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative grid size-20 shrink-0 place-items-center rounded-3xl border-2 border-amber-200 bg-gradient-to-br from-amber-50 via-yellow-50 to-sky-100 shadow-sm",
        !reducedMotion && "transition-transform duration-300 hover:scale-105",
      )}
    >
      <svg className="size-16" viewBox="0 0 80 80" fill="none">
        <circle cx="40" cy="44" r="24" fill="#F59E0B" />
        <ellipse cx="40" cy="52" rx="15" ry="14" fill="#FEF3C7" />
        <polygon points="22,26 30,14 34,27" fill="#D97706" />
        <polygon points="58,26 50,14 46,27" fill="#D97706" />
        <circle cx="31" cy="39" r="7.5" fill="#FFFFFF" />
        <circle cx="49" cy="39" r="7.5" fill="#FFFFFF" />
        <circle cx="32" cy="39" r="3.8" fill="#1E293B" />
        <circle cx="48" cy="39" r="3.8" fill="#1E293B" />
        <circle cx="33.5" cy="37.5" r="1.3" fill="#FFFFFF" />
        <circle cx="49.5" cy="37.5" r="1.3" fill="#FFFFFF" />
        <polygon points="40,43 36,48 44,48" fill="#EA580C" />
        <path
          d="M28 57 Q40 65 52 57"
          stroke="#B45309"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="62" cy="18" r="5" fill="#FDE047" />
      </svg>
    </div>
  );
}

function MemoryPreviewIllustration({
  chips,
}: {
  readonly chips: readonly string[];
}) {
  return (
    <div
      aria-hidden="true"
      className="flex min-h-52 flex-col items-center justify-center gap-4 rounded-card bg-gradient-to-br from-emerald-50 via-teal-50 to-amber-50 p-6"
    >
      <svg
        className="h-32 w-full max-w-[260px]"
        viewBox="0 0 260 128"
        fill="none"
      >
        <rect
          x="8"
          y="8"
          width="244"
          height="112"
          rx="18"
          fill="#FFFFFF"
          stroke="#A7F3D0"
          strokeWidth="2"
        />
        <circle cx="52" cy="40" r="16" fill="#FCD34D" />
        <rect x="18" y="84" width="224" height="26" rx="10" fill="#D1FAE5" />
        <circle cx="105" cy="72" r="16" fill="#FB923C" />
        <polygon points="94,59 98,48 104,58" fill="#FB923C" />
        <polygon points="116,59 112,48 106,58" fill="#FB923C" />
        <circle cx="100" cy="70" r="2.2" fill="#1E293B" />
        <circle cx="110" cy="70" r="2.2" fill="#1E293B" />
        <path
          d="M168 44 L176 62 L195 62 L180 73 L185 91 L168 80 L151 91 L156 73 L141 62 L160 62 Z"
          fill="#F43F5E"
        />
        <rect x="202" y="56" width="24" height="30" rx="5" fill="#3B82F6" />
        <line
          x1="208"
          y1="65"
          x2="220"
          y2="65"
          stroke="#FFFFFF"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <line
          x1="208"
          y1="73"
          x2="220"
          y2="73"
          stroke="#FFFFFF"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <div className="flex flex-wrap justify-center gap-2 text-xs font-bold text-emerald-900">
        {chips.map((label) => (
          <span
            className="rounded-full bg-white/90 px-3 py-1 shadow-xs"
            key={label}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

const ONBOARDING_STEP_KEYS = [
  {
    titleKey: "hub.onboardingStep1Title",
    bodyKey: "hub.onboardingStep1Body",
  },
  {
    titleKey: "hub.onboardingStep2Title",
    bodyKey: "hub.onboardingStep2Body",
  },
  {
    titleKey: "hub.onboardingStep3Title",
    bodyKey: "hub.onboardingStep3Body",
  },
] as const;

const emptySubscribe = () => () => {};

function readBrowserPref(reader: () => boolean): boolean {
  try {
    return reader();
  } catch {
    return false;
  }
}

function HubSelectedChildSync({
  onChildReady,
}: {
  readonly onChildReady: (child: ChildProfileDTO) => void;
}) {
  const { state } = useValidatedSelectedChild();

  useEffect(() => {
    if (state.status === "ready") {
      onChildReady(state.child);
    }
  }, [onChildReady, state]);

  return null;
}

export function EntertainmentScreen({
  initialRecommendations = null,
  vocabularyService,
}: Props = {}) {
  const tRaw = useTranslations("entertainment");
  const tGlossary = useWordGlossaryTranslations();
  const resolvedVocabService = useMemo(
    () => vocabularyService ?? createVocabularyNotebookService(),
    [vocabularyService],
  );
  const teacherPersona = useTeacherPersona();
  const t = useCallback(
    (
      key: string,
      params?: Record<string, string | number>,
      defaultValue?: string,
    ) =>
      adaptTextToTeacherPersona(
        tRaw(key, params, defaultValue),
        teacherPersona.gender,
      ),
    [tRaw, teacherPersona.gender],
  );
  const tCommon = useTranslations("common");
  const childSelectId = useId();
  const appStore = useContext(AppStoreContext);
  const appServices = useContext(AppServicesContext);
  const speechPlayer = useSpeechPlayer();
  const speechPlayerRef = useRef(speechPlayer);
  const {
    reducedMotion,
    calmSound,
    autopilotEnabled,
    toggleReducedMotion,
    toggleCalmSound,
    toggleAutopilot,
  } = useEntertainmentPreferences();

  useEffect(() => {
    speechPlayerRef.current = speechPlayer;
  }, [speechPlayer]);

  useEffect(() => {
    return () => {
      speechPlayerRef.current.stop();
    };
  }, []);

  function handleSpeakFocusWord(word: string) {
    const cleaned = word.trim();
    if (!cleaned || !calmSound) return;
    void speechPlayer
      .play(cleaned, { wordSample: true, speedScale: 0.92 })
      .catch(() => undefined);
  }

  const [childrenList, setChildrenList] = useState<readonly ChildProfileDTO[]>(
    [],
  );
  const [validatedChild, setValidatedChild] = useState<ChildProfileDTO | null>(
    null,
  );
  const [fallbackChildId, setFallbackChildId] = useState<string | null>(null);
  const [fetchedRecommendations, setFetchedRecommendations] =
    useState<EntertainmentRecommendationsDTO | null>(null);
  const [loadingRecsForChildId, setLoadingRecsForChildId] = useState<
    string | null
  >(null);
  const [notebookData, setNotebookData] =
    useState<VocabularyNotebookListDTO | null>(null);
  const [notebookDrawerOpen, setNotebookDrawerOpen] = useState(false);

  const storedShowOnboarding = useSyncExternalStore(
    emptySubscribe,
    () =>
      readBrowserPref(
        () => !window.localStorage.getItem(ONBOARDING_STORAGE_KEY),
      ),
    () => false,
  );

  const [onboardingOverride, setOnboardingOverride] = useState<boolean | null>(
    null,
  );
  const [onboardingStep, setOnboardingStep] = useState(0);

  const showOnboarding = onboardingOverride ?? storedShowOnboarding;
  const activeChildId =
    appStore?.selectedChildId ??
    validatedChild?.id ??
    fallbackChildId ??
    initialRecommendations?.child_id ??
    null;

  const handleValidatedChildReady = useCallback((child: ChildProfileDTO) => {
    setValidatedChild((current) =>
      current?.id === child.id ? current : child,
    );
  }, []);

  useEffect(() => {
    let active = true;
    const childService = appServices?.childService ?? createChildService();

    async function loadChildren() {
      try {
        const children = await childService.list();
        if (!active) return;
        setChildrenList(children);
        if (!children.length) return;
        const currentSelected = appStore?.selectedChildId ?? null;
        if (currentSelected) {
          const matchedSelected =
            children.find((item) => item.id === currentSelected) ?? null;
          if (matchedSelected) {
            appStore?.setValidatedSelectedChild(matchedSelected);
            hydrateTeacherVoiceFromChildProfile(matchedSelected);
          }
          return;
        }
        if (appStore) {
          appStore.selectChild(children[0].id);
          appStore.setValidatedSelectedChild(children[0]);
          hydrateTeacherVoiceFromChildProfile(children[0]);
        } else if (!initialRecommendations) {
          setFallbackChildId(children[0].id);
          hydrateTeacherVoiceFromChildProfile(children[0]);
        }
      } catch {
        // Gracefully remain in calm static child-first hub when unauthenticated or offline.
      }
    }

    void loadChildren();
    return () => {
      active = false;
    };
  }, [appServices?.childService, appStore, initialRecommendations]);

  useEffect(() => {
    const targetChildId = appStore?.selectedChildId ?? fallbackChildId;
    if (!targetChildId) return;
    if (
      initialRecommendations &&
      initialRecommendations.child_id === targetChildId
    ) {
      return;
    }

    let active = true;
    async function loadAdaptiveRecommendations(childId: string) {
      setLoadingRecsForChildId(childId);
      try {
        const recs = await createAdaptiveLearningService().getRecommendations(
          childId,
          teacherPersona.gender,
        );
        if (active) {
          setFetchedRecommendations(recs);
        }
      } catch {
        // Gracefully keep static child-first hub if adaptive recommendations are unavailable.
      } finally {
        if (active) {
          setLoadingRecsForChildId((current) =>
            current === childId ? null : current,
          );
        }
      }
    }

    void loadAdaptiveRecommendations(targetChildId);
    return () => {
      active = false;
    };
  }, [
    appStore?.selectedChildId,
    fallbackChildId,
    initialRecommendations,
    teacherPersona.gender,
  ]);

  useEffect(() => {
    if (!activeChildId) return;
    const controller = new AbortController();
    void resolvedVocabService
      .listNotebook(activeChildId, 20, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setNotebookData(data);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [activeChildId, resolvedVocabService]);

  const recommendations =
    fetchedRecommendations &&
    (!activeChildId || fetchedRecommendations.child_id === activeChildId)
      ? fetchedRecommendations
      : initialRecommendations &&
          (!activeChildId || initialRecommendations.child_id === activeChildId)
        ? initialRecommendations
        : null;
  const isLoadingRecommendations =
    Boolean(activeChildId) &&
    loadingRecsForChildId === activeChildId &&
    !recommendations;
  const recommendationsProgress = useAiProgress({
    active: isLoadingRecommendations,
    expectedDurationMs: 5_000,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.analyzing") },
      { atPct: 45, label: tCommon("aiProgress.loadingRecommendations") },
      { atPct: 85, label: tCommon("aiProgress.finalizing") },
    ],
  });

  function handleSelectChild(nextChildId: string) {
    if (!nextChildId) return;
    const matched =
      childrenList.find((item) => item.id === nextChildId) ?? null;
    if (appStore) {
      appStore.selectChild(nextChildId);
      if (matched) {
        appStore.setValidatedSelectedChild(matched);
      }
    } else {
      setFallbackChildId(nextChildId);
    }
    if (matched) {
      setValidatedChild(matched);
      hydrateTeacherVoiceFromChildProfile(matched, { force: true });
    }
  }

  function finishOnboarding() {
    setOnboardingOverride(false);
    setOnboardingStep(0);
    try {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
    } catch {
      // Ignore restricted storage.
    }
  }

  const recommendationByGame = new Map<GameKey, CrossGameRecommendationDTO>(
    (recommendations?.recommendations ?? []).map((item) => [
      item.game_key,
      item,
    ]),
  );
  const activeChildNotebook =
    notebookData && (!activeChildId || notebookData.child_id === activeChildId)
      ? notebookData
      : null;
  const notebookBonusWords = useMemo(() => {
    if (!activeChildNotebook) return [];
    const difficultNormSet = new Set(
      (recommendations?.focus_difficult_words ?? []).map((w) =>
        w.trim().toLowerCase(),
      ),
    );
    const candidates = activeChildNotebook.storytelling_words?.length
      ? activeChildNotebook.storytelling_words
      : activeChildNotebook.items.map((item) => item.word);
    return candidates
      .filter((w) => Boolean(w.trim()) && !difficultNormSet.has(w.trim().toLowerCase()))
      .slice(0, 3);
  }, [activeChildNotebook, recommendations?.focus_difficult_words]);

  const primaryRec = recommendations?.primary_recommendation ?? null;
  const baseFocusWordsForLaunch = primaryRec?.target_words.length
    ? primaryRec.target_words
    : (recommendations?.focus_difficult_words ?? []);
  const focusWordsForLaunch = Array.from(
    new Set([...baseFocusWordsForLaunch, ...notebookBonusWords]),
  );
  const pictureCardHref = notebookBonusWords.length
    ? `/entertainment/picture-description?focus=${encodeURIComponent(
        Array.from(
          new Set([
            ...(recommendationByGame.get("PICTURE_DESCRIPTION")?.target_words ??
              []),
            ...notebookBonusWords,
          ]),
        )
          .slice(0, 5)
          .join(","),
      )}`
    : "/entertainment/picture-description";
  const memoryCardHref = notebookBonusWords.length
    ? `/entertainment/memory-game?focus=${encodeURIComponent(
        Array.from(
          new Set([
            ...(recommendationByGame.get("MEMORY_GAME")?.target_words ?? []),
            ...notebookBonusWords,
          ]),
        )
          .slice(0, 5)
          .join(","),
      )}`
    : "/entertainment/memory-game";
  const autopilotHref = (() => {
    if (!primaryRec) return null;
    const baseHref = primaryRec.href;
    const sep = baseHref.includes("?") ? "&" : "?";
    const params: string[] = ["autopilot=1"];
    if (focusWordsForLaunch.length && !baseHref.includes("focus=")) {
      params.push(
        `focus=${encodeURIComponent(focusWordsForLaunch.slice(0, 4).join(","))}`,
      );
    }
    return `${baseHref}${sep}${params.join("&")}`;
  })();
  const activeStep = ONBOARDING_STEP_KEYS[onboardingStep];
  const displayChild =
    childrenList.find((item) => item.id === activeChildId) ??
    (validatedChild?.id === activeChildId ? validatedChild : null);
  const profileBadgeAlias =
    recommendations?.child_alias ?? displayChild?.alias ?? null;
  const profileBadgeGrade =
    recommendations?.child_grade ?? displayChild?.grade ?? null;

  return (
    <section
      className={cn(
        "activity-library mx-auto flex w-full max-w-[1140px] flex-col gap-5 pb-8",
        reducedMotion && "motion-reduce",
      )}
      data-autopilot={autopilotEnabled ? "true" : "false"}
      data-calm-sound={calmSound ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-sound-muted={calmSound ? "false" : "true"}
    >
      {appStore && appServices && appStore.selectedChildId ? (
        <HubSelectedChildSync onChildReady={handleValidatedChildReady} />
      ) : null}

      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold tracking-wide text-primary uppercase">
            {t("hub.eyebrow")}
          </p>
          <h1 className="book-title mt-1 text-3xl text-ink sm:text-4xl">
            {t("hub.heading")}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {childrenList.length > 1 ? (
            <div className="min-w-0 sm:min-w-52">
              <label className="sr-only" htmlFor={childSelectId}>
                {t("hub.selectChildLabel")}
              </label>
              <select
                aria-label={t("hub.selectChildAria")}
                className="min-h-12 w-full cursor-pointer rounded-control border border-border bg-white px-3.5 text-sm font-bold text-ink outline-none focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                data-testid="hub-child-selector"
                id={childSelectId}
                onChange={(event) => handleSelectChild(event.target.value)}
                value={activeChildId ?? ""}
              >
                {childrenList.map((child) => (
                  <option key={child.id} value={child.id}>
                    {t("hub.childOptionLabel", {
                      alias: child.alias,
                      grade: child.grade,
                    })}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <Button
            aria-pressed={autopilotEnabled}
            className="min-h-12 px-4"
            data-testid="hub-autopilot-toggle"
            fullWidth={false}
            onClick={toggleAutopilot}
            size="compact"
            type="button"
            variant={autopilotEnabled ? "secondary" : "quiet"}
          >
            <Mic aria-hidden="true" className="size-4" />
            {autopilotEnabled
              ? t("hub.autopilotActive", undefined, "Tự động rảnh tay: Bật")
              : t("hub.autopilotOff", undefined, "Tự động rảnh tay: Tắt")}
          </Button>
          <Button
            aria-pressed={!calmSound}
            className="min-h-12 px-4"
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
            {calmSound ? t("hub.calmSound") : t("hub.soundMuted")}
          </Button>
          <Button
            aria-pressed={reducedMotion}
            className="min-h-12 px-4"
            fullWidth={false}
            onClick={toggleReducedMotion}
            size="compact"
            type="button"
            variant="quiet"
          >
            <Wind aria-hidden="true" className="size-4" />
            {reducedMotion
              ? t("hub.reducedMotionActive")
              : t("hub.reduceMotion")}
          </Button>
          {activeChildId ? (
            <Button
              className="min-h-12 px-4"
              data-testid="hub-open-vocabulary-notebook-btn"
              fullWidth={false}
              onClick={() => setNotebookDrawerOpen(true)}
              size="compact"
              type="button"
              variant="secondary"
            >
              <BookHeart aria-hidden="true" className="size-4 text-amber-700" />
              {activeChildNotebook && activeChildNotebook.total > 0
                ? tGlossary("hubNotebookButton", {
                    count: activeChildNotebook.total,
                  })
                : tGlossary("hubNotebookButtonEmpty")}
            </Button>
          ) : null}
          <Button
            className="min-h-12 px-4"
            fullWidth={false}
            onClick={() => {
              setOnboardingStep(0);
              setOnboardingOverride(!showOnboarding);
            }}
            size="compact"
            type="button"
            variant="secondary"
          >
            <HelpCircle aria-hidden="true" className="size-4" />
            {t("hub.onboardingGuideButton")}
          </Button>
        </div>
      </header>

      {/* Mascot Guide & Gentle Adaptive Recommendation */}
      <div className="flex flex-col gap-4 rounded-card border border-amber-200 bg-gradient-to-r from-amber-50/90 via-cream to-sky/60 p-5 sm:flex-row sm:items-center sm:p-6">
        <ViReadMascot reducedMotion={reducedMotion} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-extrabold text-amber-800 shadow-xs">
              <Sparkles aria-hidden="true" className="size-3.5" />
              {t("hub.mascotBadge")}
            </span>
            {profileBadgeAlias && profileBadgeGrade !== null ? (
              <span
                className="rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-muted"
                data-testid="hub-active-child-badge"
              >
                {t("hub.childProfileBadge", {
                  alias: profileBadgeAlias,
                  grade: profileBadgeGrade,
                })}
              </span>
            ) : null}
          </div>
          <p className="text-lg font-extrabold text-ink">
            {recommendations?.mascot_greeting_vi ? (
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {adaptTextToTeacherPersona(
                  recommendations.mascot_greeting_vi,
                  teacherPersona.gender,
                )}
              </span>
            ) : (
              t("hub.defaultGreeting")
            )}
          </p>
          <p className="text-sm leading-6 text-muted">
            {primaryRec?.reason_vi ? (
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {adaptTextToTeacherPersona(
                  primaryRec.reason_vi,
                  teacherPersona.gender,
                )}
              </span>
            ) : (
              t("hub.defaultRecommendationReason")
            )}
          </p>
          {isLoadingRecommendations ? (
            <div className="pt-1">
              <AiProgressBar
                active
                label={
                  recommendationsProgress.stageLabel ??
                  tCommon("aiProgress.loadingRecommendations")
                }
                percent={recommendationsProgress.percent}
                size="compact"
                testId="entertainment-recommendations-progress"
              />
            </div>
          ) : null}
          {recommendations?.focus_difficult_words.length ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs font-bold text-ink">
                {t(
                  "hub.todayChallengeWordsLabel",
                  undefined,
                  t("hub.focusDifficultWordsLabel"),
                )}
              </span>
              {recommendations.focus_difficult_words.map((word) => (
                <button
                  aria-label={`Nghe mẫu từ ${word}`}
                  className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-amber-300 bg-white px-3 py-1 text-xs font-bold text-amber-900 transition hover:border-amber-500 hover:bg-amber-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  data-testid={`hub-focus-word-${word}`}
                  key={word}
                  onClick={() => handleSpeakFocusWord(word)}
                  type="button"
                >
                  <Volume2
                    aria-hidden="true"
                    className="size-3.5 text-amber-700"
                  />
                  <span className="viread-learning-content" dir="ltr" lang="vi">
                    {word}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {notebookBonusWords.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-2 pt-1"
              data-testid="hub-notebook-bonus-words"
            >
              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-900">
                <BookHeart aria-hidden="true" className="size-3.5" />
                {tGlossary("bonusStoryWordsLabel")}
              </span>
              {notebookBonusWords.map((word) => (
                <button
                  aria-label={`Nghe từ yêu thích ${word}`}
                  className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50/90 px-3 py-1 text-xs font-bold text-emerald-950 transition hover:border-emerald-500 hover:bg-emerald-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  data-testid={`hub-notebook-word-${word}`}
                  key={word}
                  onClick={() => handleSpeakFocusWord(word)}
                  type="button"
                >
                  <Volume2
                    aria-hidden="true"
                    className="size-3.5 text-emerald-700"
                  />
                  <span className="viread-learning-content" dir="ltr" lang="vi">
                    {word}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {primaryRec ? (
          <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto">
            {autopilotEnabled && autopilotHref ? (
              <ButtonLink
                className="min-h-12 w-full sm:w-auto"
                data-testid="hub-autopilot-cta"
                href={autopilotHref}
                size="compact"
              >
                {t("hub.autopilotLaunchCta", undefined, "Vào học vui ngay")}{" "}
                <ArrowRight
                  aria-hidden="true"
                  className="viread-rtl-flip size-4"
                />
              </ButtonLink>
            ) : null}
            <ButtonLink
              className="min-h-12 w-full sm:w-auto"
              href={primaryRec.href}
              size="compact"
              variant={autopilotEnabled ? "secondary" : "primary"}
            >
              {t("hub.playSuggestedCta")}{" "}
              <ArrowRight
                aria-hidden="true"
                className="viread-rtl-flip size-4"
              />
            </ButtonLink>
          </div>
        ) : null}
      </div>

      <FiveMinuteTrainCtaCard
        childAlias={profileBadgeAlias}
        childId={activeChildId}
        focusWords={recommendations?.focus_difficult_words?.slice(0, 3)}
        sourceSurface="entertainment"
      />

      {/* Interactive First-Visit Onboarding (Calm, Zero Dark Patterns) */}
      {showOnboarding ? (
        <aside
          aria-label={t("hub.onboardingRegionAria")}
          className="rounded-card border border-primary/25 bg-white p-5 shadow-xs sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-extrabold tracking-wide text-primary uppercase">
                {t("hub.onboardingCounter", {
                  current: onboardingStep + 1,
                  total: ONBOARDING_STEP_KEYS.length,
                })}
              </p>
              <h2 className="mt-1 text-xl font-extrabold text-ink">
                {t(activeStep.titleKey)}
              </h2>
              <p className="mt-1 text-body text-muted">
                {adaptTextToTeacherPersona(
                  t(activeStep.bodyKey),
                  teacherPersona.gender,
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onboardingStep < ONBOARDING_STEP_KEYS.length - 1 ? (
                <Button
                  className="min-h-12"
                  fullWidth={false}
                  onClick={() => setOnboardingStep((s) => s + 1)}
                  size="compact"
                  type="button"
                >
                  {t("hub.onboardingNext")}
                </Button>
              ) : (
                <Button
                  className="min-h-12"
                  fullWidth={false}
                  onClick={finishOnboarding}
                  size="compact"
                  type="button"
                >
                  {t("hub.onboardingDone")}
                </Button>
              )}
              <Button
                className="min-h-12"
                fullWidth={false}
                onClick={finishOnboarding}
                size="compact"
                type="button"
                variant="quiet"
              >
                {t("hub.onboardingClose")}
              </Button>
            </div>
          </div>
        </aside>
      ) : null}

      {/* 4 Child-First Play & Learn Zones */}
      <div className="grid items-stretch gap-5 md:grid-cols-2">
        {/* Zone 1: Storytelling */}
        <article className="flex flex-col gap-4 rounded-card border border-border bg-white p-6 shadow-xs sm:p-7">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold text-amber-900">
              <BookOpen aria-hidden="true" className="size-3.5" />
              {t("hub.pictureZoneBadge")}
            </span>
            {primaryRec?.game_key === "PICTURE_DESCRIPTION" ? (
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                {t("hub.todaySuggestionBadge")}
              </span>
            ) : null}
          </div>
          <div className="relative min-h-52 overflow-hidden rounded-card bg-cream">
            <Image
              alt={t("hub.pictureImageAlt")}
              className="object-cover"
              fill
              sizes="(max-width: 767px) 100vw, 480px"
              src="/images/picture-description/sunny-garden.jpg"
            />
          </div>
          <h2 className="text-2xl font-extrabold text-ink">
            {t("hub.pictureTitle")}
          </h2>
          <p className="text-body leading-6 text-muted">
            {t("hub.pictureDesc")}
          </p>
          {recommendationByGame.get("PICTURE_DESCRIPTION")?.target_words
            .length ? (
            <p className="text-xs font-semibold text-primary">
              {t("hub.suggestedWordsLabel")}{" "}
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {recommendationByGame
                  .get("PICTURE_DESCRIPTION")
                  ?.target_words.join(", ")}
              </span>
            </p>
          ) : null}
          <ButtonLink
            className="mt-auto min-h-12"
            href={pictureCardHref}
            size="compact"
          >
            {t("hub.pictureCta")}{" "}
            <ArrowRight aria-hidden="true" className="viread-rtl-flip size-4" />
          </ButtonLink>
        </article>

        {/* Zone 2: Word Adventure */}
        <article className="flex flex-col gap-4 rounded-card border border-border bg-white p-6 shadow-xs sm:p-7">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sky px-3 py-1 text-xs font-extrabold text-primary-hover">
              <Sparkles aria-hidden="true" className="size-3.5" />
              {t("hub.shooterZoneBadge")}
            </span>
            {primaryRec?.game_key === "SENTENCE_SHOOTER" ? (
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                {t("hub.todaySuggestionBadge")}
              </span>
            ) : null}
          </div>
          <div
            aria-hidden="true"
            className="flex min-h-52 flex-col items-center justify-center gap-5 rounded-card bg-sky p-6"
          >
            <div
              className="viread-learning-content flex flex-wrap justify-center gap-2"
              dir="ltr"
              lang="vi"
            >
              {["Bé", "đang", "đọc", "sách."].map((word) => (
                <span
                  className="rounded-control bg-white px-4 py-2 text-xl font-extrabold text-ink shadow-xs"
                  key={word}
                >
                  {word}
                </span>
              ))}
            </div>
            <ToyCannon className="size-24" />
          </div>
          <h2 className="text-2xl font-extrabold text-ink">
            {t("hub.shooterTitle")}
          </h2>
          <p className="text-body leading-6 text-muted">
            {t("hub.shooterDesc")}
          </p>
          <ButtonLink
            className="mt-auto min-h-12"
            href="/entertainment/sentence-shooter"
            size="compact"
          >
            {t("hub.shooterCta")}{" "}
            <ArrowRight aria-hidden="true" className="viread-rtl-flip size-4" />
          </ButtonLink>
        </article>

        {/* Zone 3: Music Stage */}
        <article className="flex flex-col gap-4 rounded-card border border-border bg-cream p-6 shadow-xs sm:p-7">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 px-3 py-1 text-xs font-extrabold text-rose-900">
              <Music2 aria-hidden="true" className="size-3.5" />
              {t("hub.karaokeZoneBadge")}
            </span>
            {primaryRec?.game_key === "KARAOKE" ? (
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                {t("hub.todaySuggestionBadge")}
              </span>
            ) : null}
          </div>
          <div
            aria-hidden="true"
            className="flex min-h-52 flex-col items-center justify-center gap-4 rounded-card bg-white/90 p-6"
          >
            <div className="grid size-20 place-items-center rounded-3xl bg-rose-50 text-primary shadow-xs">
              <Music2 className="size-10" />
            </div>
            <div className="flex flex-wrap justify-center gap-2 text-xs font-bold text-rose-900">
              <span className="rounded-full bg-rose-50 px-3 py-1">
                {t("hub.karaokeChipRhythm")}
              </span>
              <span className="rounded-full bg-rose-50 px-3 py-1">
                {t("hub.karaokeChipTap")}
              </span>
              <span className="rounded-full bg-rose-50 px-3 py-1">
                {t("hub.karaokeChipSlowPractice")}
              </span>
            </div>
          </div>
          <h2 className="text-2xl font-extrabold text-ink">
            {t("hub.karaokeTitle")}
          </h2>
          <p className="text-body leading-6 text-muted">
            {t("hub.karaokeDesc")}
          </p>
          <ButtonLink
            className="mt-auto min-h-12"
            href="/karaoke"
            size="compact"
          >
            {t("hub.karaokeCta")}{" "}
            <ArrowRight aria-hidden="true" className="viread-rtl-flip size-4" />
          </ButtonLink>
        </article>

        {/* Zone 4: Memory Explorer */}
        <article className="flex flex-col gap-4 rounded-card border border-emerald-200 bg-white p-6 shadow-xs sm:p-7">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-extrabold text-emerald-900">
              <Brain aria-hidden="true" className="size-3.5" />
              {t("hub.memoryZoneBadge")}
            </span>
            <span className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-extrabold text-white">
              {t("hub.newBadge")}
            </span>
          </div>
          <MemoryPreviewIllustration
            chips={[
              t("hub.memoryChipObserve"),
              t("hub.memoryChipRemember"),
              t("hub.memoryChipStory"),
            ]}
          />
          <h2 className="text-2xl font-extrabold text-ink">
            {t("hub.memoryTitle")}
          </h2>
          <p className="text-body leading-6 text-muted">
            {t("hub.memoryDesc")}
          </p>
          <ButtonLink
            className="mt-auto min-h-12"
            href={memoryCardHref}
            size="compact"
          >
            {t("hub.memoryCta")}{" "}
            <ArrowRight aria-hidden="true" className="viread-rtl-flip size-4" />
          </ButtonLink>
        </article>
      </div>

      {activeChildId ? (
        <VocabularyNotebookDrawer
          childAlias={profileBadgeAlias}
          childId={activeChildId}
          initialNotebook={activeChildNotebook}
          onClose={() => setNotebookDrawerOpen(false)}
          onNotebookChange={setNotebookData}
          open={notebookDrawerOpen}
          service={resolvedVocabService}
          speechPlayer={speechPlayer}
        />
      ) : null}

      {/* Healthy Natural Break Cue (Anti-Addiction, Zero Dark Patterns) */}
      <footer className="flex items-center gap-3 rounded-card border border-border bg-white/80 px-5 py-4 text-sm text-muted">
        <Coffee aria-hidden="true" className="size-5 shrink-0 text-primary" />
        <p>
          <strong className="font-bold text-ink">
            {t("hub.breakReminderTitle")}
          </strong>{" "}
          {recommendations?.natural_break_reminder_vi ? (
            <span className="viread-learning-content" dir="ltr" lang="vi">
              {recommendations.natural_break_reminder_vi}
            </span>
          ) : (
            t("hub.defaultBreakReminder")
          )}
        </p>
      </footer>
    </section>
  );
}
