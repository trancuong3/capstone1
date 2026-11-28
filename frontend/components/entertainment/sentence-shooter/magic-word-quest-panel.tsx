"use client";

import {
  ArrowLeft,
  ArrowRight,
  Mic,
  MicOff,
  RefreshCw,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BookChildHeader } from "@/components/books/book-child-header";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import {
  playShooterSound,
  suspendShooterAudio,
} from "@/components/entertainment/sentence-shooter/sound-engine";
import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";
import { PhonicsLessonCard } from "@/components/reading/phonics-lesson-card";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import { useSpeechPlayer, type SpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import {
  createAdaptiveLearningService,
  magicWordQuestSchema,
  type AdaptiveLearningService,
} from "@/lib/api/adaptive-learning-service";
import {
  createDifficultWordService,
  type DifficultWordService,
} from "@/lib/api/difficult-word-service";
import {
  createSpeechService,
  type SpeechService,
} from "@/lib/api/speech-service";
import { EchoGuard } from "@/lib/reading/echo-guard";
import {
  buildPhonicsLesson,
  type PhonicsLessonPlan,
} from "@/lib/reading/phonics-lesson";
import { matchPhonicsSpelling } from "@/lib/reading/phonics-spelling";
import {
  classifyPracticePhraseTranscript,
  stripNonSpeechAnnotations,
} from "@/lib/reading/retry-word-recognition";
import {
  normalizeVietnameseWord,
  tokenizeVietnameseText,
} from "@/lib/reading/vietnamese-text";
import {
  hasShortWordSpeechActivity,
  SHORT_WORD_CAPTURE_CONFIG,
  shouldAutoStopShortWordCapture,
} from "@/lib/reading/word-practice-engine";
import { cn } from "@/lib/utils/cn";
import type {
  MagicQuestChoiceTokenDTO,
  MagicQuestMicMode,
  MagicWordQuestDTO,
  MagicWordQuestRoundDTO,
} from "@/types/adaptive-learning";
import type { ChildProfileDTO } from "@/types/child";

const MAGIC_QUEST_STORAGE_PREFIX = "viread:magic-quest:";
const POST_TTS_COOLDOWN_MS = 300;

export function getMagicQuestSessionStorageKey(childId: string): string {
  return `${MAGIC_QUEST_STORAGE_PREFIX}${childId}`;
}

export function purgeMagicQuestSessionStorage(
  activeChildId?: string | null,
  options?: {
    readonly purgeAllForActiveChild?: boolean;
    readonly skipActiveChildEntry?: boolean;
  },
): void {
  if (typeof window === "undefined") return;
  try {
    const store = window.sessionStorage;
    const nowSec = Math.floor(Date.now() / 1000);
    const keysToRemove: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key || !key.startsWith(MAGIC_QUEST_STORAGE_PREFIX)) continue;
      const keyChildId = key.slice(MAGIC_QUEST_STORAGE_PREFIX.length);
      if (activeChildId && keyChildId === activeChildId) {
        if (options?.skipActiveChildEntry) {
          continue;
        }
        if (options?.purgeAllForActiveChild ?? true) {
          keysToRemove.push(key);
          continue;
        }
      }
      if (activeChildId && keyChildId !== activeChildId) {
        keysToRemove.push(key);
        continue;
      }
      const raw = store.getItem(key);
      if (!raw) {
        keysToRemove.push(key);
        continue;
      }
      try {
        const parsed = magicWordQuestSchema.safeParse(JSON.parse(raw));
        if (!parsed.success || parsed.data.quest_exp <= nowSec) {
          keysToRemove.push(key);
        }
      } catch {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      store.removeItem(key);
    }
  } catch {
    // Ignore restricted WebView / private-browsing storage errors.
  }
}

/**
 * Deterministic RFC-4122 UUID (version 5 / variant 8) for idempotent
 * `evaluatePracticeWord` retries within a single Magic Word Quest round.
 */
export function buildDeterministicQuestAttemptUuid(
  questId: string,
  roundNumber: number,
  attemptOrdinal: number,
): string {
  const seed = `viread:magic-quest-attempt:${questId}:${roundNumber}:${attemptOrdinal}`;
  const hash32 = (input: string, init: number): number => {
    let h = init >>> 0;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  const p0 = hash32(`${seed}#0`, 0x811c9dc5).toString(16).padStart(8, "0");
  const p1Raw = hash32(`${seed}#1`, 0x9e3779b9).toString(16).padStart(8, "0");
  const p2Raw = hash32(`${seed}#2`, 0x85ebca6b).toString(16).padStart(8, "0");
  const p3 = hash32(`${seed}#3`, 0xc2b2ae35).toString(16).padStart(8, "0");

  const timeMid = p1Raw.slice(0, 4);
  const versionAndHi = `5${p1Raw.slice(5, 8)}`;
  const variantNibble = ((parseInt(p2Raw[0] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  const variantAndSeq = `${variantNibble}${p2Raw.slice(1, 4)}`;
  const node = `${p2Raw.slice(4, 8)}${p3}`;
  return `${p0}-${timeMid}-${versionAndHi}-${variantAndSeq}-${node}`;
}

type QuestPhase = "LOADING" | "ERROR" | "PLAYING" | "FINALE" | "DISSOLVED";
type RoundStep =
  | "TAP_CHOICE"
  | "READY_TO_SPEAK"
  | "LISTENING"
  | "EVALUATING"
  | "ROUND_CLEARED";

type RoundClearKind = "SPOKEN" | "EFFORT_RESCUE" | "NO_MIC";

export interface MagicWordQuestPanelProps {
  readonly child: ChildProfileDTO;
  readonly focusWords?: readonly string[];
  readonly calmSound: boolean;
  readonly reducedMotion: boolean;
  readonly autopilotEnabled: boolean;
  readonly onToggleCalmSound?: () => void;
  readonly onExitToLobby: () => void;
  readonly adaptiveService?: Pick<
    AdaptiveLearningService,
    "createMagicWordQuest" | "completeMagicWordQuest"
  >;
  readonly difficultWordService?: Pick<
    DifficultWordService,
    "evaluatePracticeWord"
  >;
  readonly speechService?: Pick<SpeechService, "transcribe">;
  readonly speechPlayer?: SpeechPlayer;
}

function interpolateDissolveMessage(
  template: string,
  alias: string,
  count: number,
): string {
  return template
    .replace(/\{alias\}/gu, alias)
    .replace(/\{count\}/gu, String(count));
}

function normalizePhraseTokens(text: string): string[] {
  return tokenizeVietnameseText(text)
    .map((tok) => normalizeVietnameseWord(tok))
    .filter(Boolean);
}

function evaluateTranscriptAgainstTarget(
  targetWord: string,
  sentenceText: string,
  rawTranscript: string,
): "CORRECT" | "INCORRECT" | "UNCERTAIN" | "NO_CLEAR_AUDIO" {
  const cleaned = stripNonSpeechAnnotations(rawTranscript).trim();
  if (!cleaned) return "NO_CLEAR_AUDIO";

  const phraseVerdict = classifyPracticePhraseTranscript(targetWord, cleaned, {
    contextPhrase: sentenceText,
  });
  if (phraseVerdict === "CORRECT") return "CORRECT";

  const targetTokens = normalizePhraseTokens(targetWord);
  const spokenTokens = normalizePhraseTokens(cleaned);
  if (!spokenTokens.length) return "NO_CLEAR_AUDIO";

  if (targetTokens.length === 1) {
    const targetNorm = targetTokens[0]!;
    if (spokenTokens.includes(targetNorm)) return "CORRECT";
    const phonics = matchPhonicsSpelling(spokenTokens, targetNorm);
    if (phonics?.matched) return "CORRECT";
  } else if (targetTokens.length > 1) {
    const joinedTarget = targetTokens.join(" ");
    const joinedSpoken = spokenTokens.join(" ");
    if (joinedSpoken.includes(joinedTarget)) return "CORRECT";
  }

  if (phraseVerdict === "NOT_RECOGNIZED" || phraseVerdict === "UNCERTAIN") {
    return "UNCERTAIN";
  }
  return "INCORRECT";
}

export function MagicWordQuestPanel({
  child,
  focusWords = [],
  calmSound,
  reducedMotion,
  autopilotEnabled,
  onToggleCalmSound,
  onExitToLobby,
  adaptiveService: adaptiveServiceProp,
  difficultWordService: difficultWordServiceProp,
  speechService: speechServiceProp,
  speechPlayer: speechPlayerProp,
}: MagicWordQuestPanelProps) {
  const t = useTranslations("games");
  const tCommon = useTranslations("common");
  const teacherPersona = useTeacherPersona();
  const internalSpeechPlayer = useSpeechPlayer();
  const speechPlayer = speechPlayerProp ?? internalSpeechPlayer;

  const resolvedAdaptiveService = useMemo(
    () => adaptiveServiceProp ?? createAdaptiveLearningService(),
    [adaptiveServiceProp],
  );
  const resolvedDifficultWordService = useMemo(
    () => difficultWordServiceProp ?? createDifficultWordService(),
    [difficultWordServiceProp],
  );
  const resolvedSpeechService = useMemo(
    () => speechServiceProp ?? createSpeechService(),
    [speechServiceProp],
  );

  const [phase, setPhase] = useState<QuestPhase>("LOADING");
  const [quest, setQuest] = useState<MagicWordQuestDTO | null>(null);
  const [expiredReloadBanner, setExpiredReloadBanner] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const forceFreshRef = useRef(false);

  const [roundIndex, setRoundIndex] = useState(0);
  const [roundStep, setRoundStep] = useState<RoundStep>("TAP_CHOICE");
  const [roundClearKind, setRoundClearKind] = useState<RoundClearKind | null>(
    null,
  );
  const [wobbleChoiceId, setWobbleChoiceId] = useState("");
  const [cannonAngle, setCannonAngle] = useState(0);
  const [strikeCount, setStrikeCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState("");
  const [micMode, setMicMode] = useState<MagicQuestMicMode>("VOICE");
  const [micFallbackBanner, setMicFallbackBanner] = useState(false);
  const [autoMicSeconds, setAutoMicSeconds] = useState<number | null>(null);
  const [activePhonicsStep, setActivePhonicsStep] = useState<number | null>(
    null,
  );
  const [isPlayingPhonics, setIsPlayingPhonics] = useState(false);

  const [tapCorrectCount, setTapCorrectCount] = useState(0);
  const [tapMistakeCount, setTapMistakeCount] = useState(0);
  const [spokenCorrectCount, setSpokenCorrectCount] = useState(0);
  const [effortRescuedCount, setEffortRescuedCount] = useState(0);
  const [usedPhonicsHint, setUsedPhonicsHint] = useState(false);
  const [earnedStars, setEarnedStars] = useState(3);

  const startedAtMsRef = useRef<number>(0);
  const evaluatedWeakWordsRef = useRef<Set<string>>(new Set());
  const completionSentForQuestRef = useRef<string | null>(null);
  const echoGuardRef = useRef(new EchoGuard());
  const lastTtsEndedAtRef = useRef(0);
  const playbackSeqRef = useRef(0);
  const activeAbortRef = useRef<AbortController | null>(null);
  const autoMicTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoNextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capturePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previousChildIdRef = useRef<string>(child.id);

  const clearTimers = useCallback(() => {
    if (autoMicTimerRef.current !== null) {
      clearTimeout(autoMicTimerRef.current);
      autoMicTimerRef.current = null;
    }
    if (autoNextTimerRef.current !== null) {
      clearTimeout(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
    if (capturePollRef.current !== null) {
      clearInterval(capturePollRef.current);
      capturePollRef.current = null;
    }
    setAutoMicSeconds(null);
  }, []);

  const recorder = useSpeechRecorder((err) => {
    const name = err?.name ?? "";
    if (
      name === "NotAllowedError" ||
      name === "NotFoundError" ||
      name === "NotReadableError" ||
      name === "SecurityError"
    ) {
      setMicMode("NO_MIC_FALLBACK");
      setMicFallbackBanner(true);
    }
  });
  const recorderRef = useRef(recorder);
  useEffect(() => {
    recorderRef.current = recorder;
  }, [recorder]);

  const loadingProgress = useAiProgress({
    active: phase === "LOADING",
    stages: [
      { atPct: 0, label: t("sentenceShooter.magicQuest.loadingStage1") },
      { atPct: 52, label: t("sentenceShooter.magicQuest.loadingStage2") },
      { atPct: 85, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 2_800,
  });

  // Set ephemeral context on speechPlayer while MagicWordQuestPanel is mounted.
  useEffect(() => {
    speechPlayer.setCacheContext?.({
      ephemeral: true,
      bypassSessionLock: true,
    });
    return () => {
      speechPlayer.setCacheContext?.(null);
    };
  }, [speechPlayer]);

  // Child-switch purge: immediately wipe any previous/other child's ephemeral quest.
  useEffect(() => {
    if (previousChildIdRef.current !== child.id) {
      purgeMagicQuestSessionStorage(previousChildIdRef.current, {
        purgeAllForActiveChild: true,
      });
      previousChildIdRef.current = child.id;
    }
    purgeMagicQuestSessionStorage(child.id, {
      purgeAllForActiveChild: false,
      skipActiveChildEntry: true,
    });
  }, [child.id]);

  // Background / visibility / unmount cleanup.
  useEffect(() => {
    const pauseEverything = () => {
      clearTimers();
      recorderRef.current.cancel({ retainStream: false });
      speechPlayer.stop();
      setIsPlayingPhonics(false);
      setActivePhonicsStep(null);
      suspendShooterAudio();
      setRoundStep((prev) => (prev === "LISTENING" ? "READY_TO_SPEAK" : prev));
    };
    const onVisibility = () => {
      if (document.hidden) {
        pauseEverything();
      }
    };
    document.addEventListener("viread:android-background", pauseEverything);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener(
        "viread:android-background",
        pauseEverything,
      );
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimers();
      activeAbortRef.current?.abort();
      recorderRef.current.cancel({ retainStream: false });
      speechPlayer.stop();
    };
  }, [clearTimers, speechPlayer]);

  const playEphemeralSpeech = useCallback(
    async (
      text: string,
      opts?: {
        readonly wordSample?: boolean;
        readonly speedScale?: number;
        readonly coaching?: boolean;
      },
    ) => {
      if (!calmSound || !text.trim()) return;
      speechPlayer.stop();
      setIsPlayingPhonics(false);
      setActivePhonicsStep(null);
      playbackSeqRef.current += 1;
      const playId = `mq-tts-${playbackSeqRef.current}`;
      echoGuardRef.current.playbackStarted(playId, text, Date.now());
      try {
        await speechPlayer.play(text, {
          ephemeral: true,
          bypassSessionLock: true,
          wordSample: opts?.wordSample,
          speedScale: opts?.speedScale,
          coaching: opts?.coaching,
          utteranceKind: opts?.wordSample ? "word_sample" : "game_sample",
        });
      } catch {
        echoGuardRef.current.discardPlayback(playId);
      } finally {
        const now = Date.now();
        lastTtsEndedAtRef.current = now;
        echoGuardRef.current.playbackEnded(playId, now);
      }
    },
    [calmSound, speechPlayer],
  );

  // Load or hydrate quest on mount / reload.
  useEffect(() => {
    const controller = new AbortController();
    activeAbortRef.current?.abort();
    activeAbortRef.current = controller;
    let active = true;

    async function loadQuest() {
      clearTimers();
      setPhase("LOADING");
      setRoundIndex(0);
      setRoundStep("TAP_CHOICE");
      setRoundClearKind(null);
      setWobbleChoiceId("");
      setCannonAngle(0);
      setStrikeCount(0);
      setStatusMessage("");
      setTapCorrectCount(0);
      setTapMistakeCount(0);
      setSpokenCorrectCount(0);
      setEffortRescuedCount(0);
      setUsedPhonicsHint(false);
      evaluatedWeakWordsRef.current = new Set();
      completionSentForQuestRef.current = null;
      startedAtMsRef.current = Date.now();

      const storageKey = getMagicQuestSessionStorageKey(child.id);
      let hadExpiredCachedQuest = false;

      if (!forceFreshRef.current && typeof window !== "undefined") {
        try {
          const cachedRaw = window.sessionStorage.getItem(storageKey);
          if (cachedRaw) {
            const parsed = magicWordQuestSchema.safeParse(
              JSON.parse(cachedRaw),
            );
            const nowSec = Math.floor(Date.now() / 1000);
            if (parsed.success && parsed.data.child_id === child.id) {
              if (parsed.data.quest_exp > nowSec) {
                if (!active) return;
                setQuest(parsed.data);
                setPhase("PLAYING");
                return;
              }
              hadExpiredCachedQuest = true;
            }
            window.sessionStorage.removeItem(storageKey);
          }
        } catch {
          purgeMagicQuestSessionStorage(child.id);
        }
      }

      const shouldRefresh = forceFreshRef.current || hadExpiredCachedQuest;
      forceFreshRef.current = false;
      if (hadExpiredCachedQuest && active) {
        setExpiredReloadBanner(true);
      }

      try {
        const created = await resolvedAdaptiveService.createMagicWordQuest(
          child.id,
          {
            focus_words: focusWords.slice(0, 6),
            teacher_gender: teacherPersona.gender,
            refresh: shouldRefresh,
          },
          controller.signal,
        );
        if (!active || controller.signal.aborted) return;
        if (typeof window !== "undefined") {
          try {
            window.sessionStorage.setItem(storageKey, JSON.stringify(created));
          } catch {
            // Storage quota / private mode is non-blocking.
          }
        }
        setQuest(created);
        setPhase("PLAYING");
      } catch {
        if (!active || controller.signal.aborted) return;
        setPhase("ERROR");
      }
    }

    void loadQuest();
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [child.id, reloadNonce, resolvedAdaptiveService, teacherPersona.gender]);

  const currentRound: MagicWordQuestRoundDTO | null = useMemo(
    () => (quest ? (quest.rounds[roundIndex] ?? null) : null),
    [quest, roundIndex],
  );

  const currentPhonicsLesson: PhonicsLessonPlan | null = useMemo(() => {
    if (!currentRound || strikeCount < 2) return null;
    return buildPhonicsLesson(currentRound.target_word);
  }, [currentRound, strikeCount]);

  const playCurrentPhonics = useCallback(
    async (lesson: PhonicsLessonPlan) => {
      if (!calmSound || !lesson.supported) return;
      speechPlayer.stop();
      setIsPlayingPhonics(true);
      setActivePhonicsStep(0);
      playbackSeqRef.current += 1;
      const playId = `mq-phonics-${playbackSeqRef.current}`;
      echoGuardRef.current.playbackStarted(
        playId,
        lesson.cleanPhrase || lesson.focusSyllable,
        Date.now(),
      );
      try {
        await speechPlayer.playPhonicsLesson(lesson, {
          ephemeral: true,
          bypassSessionLock: true,
          onStepChange: (idx) => setActivePhonicsStep(idx),
        });
      } catch {
        echoGuardRef.current.discardPlayback(playId);
      } finally {
        const now = Date.now();
        lastTtsEndedAtRef.current = now;
        echoGuardRef.current.playbackEnded(playId, now);
        setIsPlayingPhonics(false);
        setActivePhonicsStep(null);
      }
    },
    [calmSound, speechPlayer],
  );

  const computeFinalStars = useCallback(
    (
      totalRounds: number,
      nextSpokenCorrect: number,
      nextEffortRescued: number,
      nextTapMistakes: number,
      activeMicMode: MagicQuestMicMode,
    ): number => {
      let raw = 1;
      if (
        activeMicMode === "VOICE" &&
        nextSpokenCorrect >= totalRounds &&
        nextEffortRescued === 0 &&
        nextTapMistakes <= 2
      ) {
        raw = 3;
      } else if (
        nextSpokenCorrect >= 1 ||
        (activeMicMode === "NO_MIC_FALLBACK" && nextTapMistakes <= 2)
      ) {
        raw = 2;
      }
      return Math.max(1, Math.min(3, raw));
    },
    [],
  );

  const enterFinale = useCallback(
    async (overrides?: {
      readonly spokenCorrect?: number;
      readonly effortRescued?: number;
      readonly tapCorrect?: number;
      readonly tapMistakes?: number;
      readonly phonicsUsed?: boolean;
      readonly activeMicMode?: MagicQuestMicMode;
    }) => {
      if (!quest) return;
      clearTimers();
      recorderRef.current.cancel({ retainStream: false });
      speechPlayer.stop();

      const finalSpoken = overrides?.spokenCorrect ?? spokenCorrectCount;
      const finalRescued = overrides?.effortRescued ?? effortRescuedCount;
      const finalTapCorrect = overrides?.tapCorrect ?? tapCorrectCount;
      const finalTapMistakes = overrides?.tapMistakes ?? tapMistakeCount;
      const finalPhonics = overrides?.phonicsUsed ?? usedPhonicsHint;
      const finalMicMode = overrides?.activeMicMode ?? micMode;

      const stars = computeFinalStars(
        quest.rounds.length,
        finalSpoken,
        finalRescued,
        finalTapMistakes,
        finalMicMode,
      );
      setEarnedStars(stars);
      setPhase("FINALE");
      playShooterSound("celebrate", calmSound, { reducedMotion, calmSound });

      // Ephemeral purge immediately on quest completion ("chơi xong rồi xóa").
      purgeMagicQuestSessionStorage(child.id, {
        purgeAllForActiveChild: true,
      });

      if (completionSentForQuestRef.current === quest.quest_id) return;
      completionSentForQuestRef.current = quest.quest_id;

      const nowSec = Math.floor(Date.now() / 1000);
      if (quest.quest_exp <= nowSec) {
        return;
      }

      const startedAtMs = startedAtMsRef.current;
      const durationSeconds = Math.max(
        1,
        Math.min(
          900,
          startedAtMs > 0
            ? Math.round((Date.now() - startedAtMs) / 1000) || 1
            : 1,
        ),
      );

      try {
        const res = await resolvedAdaptiveService.completeMagicWordQuest(
          child.id,
          {
            quest_id: quest.quest_id,
            quest_exp: quest.quest_exp,
            quest_sig: quest.quest_sig,
            target_words: quest.target_words,
            rounds_completed: quest.rounds.length,
            total_rounds: quest.rounds.length,
            tap_correct_count: finalTapCorrect,
            tap_mistake_count: finalTapMistakes,
            spoken_correct_count: finalSpoken,
            effort_rescued_count: finalRescued,
            used_phonics_hint: finalPhonics,
            mic_mode: finalMicMode,
            stars_earned: stars,
            duration_seconds: durationSeconds,
          },
        );
        setEarnedStars(Math.max(1, Math.min(3, res.stars_earned)));
      } catch {
        // Non-blocking: local celebration & weak-word mastery attempts already succeeded.
      }
    },
    [
      calmSound,
      child.id,
      clearTimers,
      computeFinalStars,
      effortRescuedCount,
      micMode,
      quest,
      reducedMotion,
      resolvedAdaptiveService,
      speechPlayer,
      spokenCorrectCount,
      tapCorrectCount,
      tapMistakeCount,
      usedPhonicsHint,
    ],
  );

  const advanceToNextRoundOrFinale = useCallback(
    (overrides?: {
      readonly spokenCorrect?: number;
      readonly effortRescued?: number;
      readonly activeMicMode?: MagicQuestMicMode;
    }) => {
      if (!quest) return;
      clearTimers();
      speechPlayer.stop();
      setIsPlayingPhonics(false);
      setActivePhonicsStep(null);

      if (roundIndex + 1 >= quest.rounds.length) {
        void enterFinale(overrides);
        return;
      }

      setRoundIndex((idx) => idx + 1);
      setRoundStep("TAP_CHOICE");
      setRoundClearKind(null);
      setWobbleChoiceId("");
      setCannonAngle(0);
      setStrikeCount(0);
      setStatusMessage("");
    },
    [clearTimers, enterFinale, quest, roundIndex, speechPlayer],
  );

  const stopAndEvaluateRecording = useCallback(async () => {
    if (!quest || !currentRound) return;
    if (capturePollRef.current !== null) {
      clearInterval(capturePollRef.current);
      capturePollRef.current = null;
    }

    const qualitySnapshot = recorderRef.current.getQuality?.();
    setRoundStep("EVALUATING");
    setStatusMessage(t("sentenceShooter.magicQuest.evaluatingStatus"));

    let audioBlob: Blob | null = null;
    try {
      audioBlob = await recorderRef.current.stop();
    } catch {
      audioBlob = null;
    }

    if (!audioBlob || audioBlob.size === 0) {
      setRoundStep("READY_TO_SPEAK");
      setStatusMessage(
        t("sentenceShooter.magicQuest.unclearVoiceRetry", {
          word: currentRound.target_word,
        }),
      );
      return;
    }

    const normTarget =
      currentRound.normalized_word ||
      normalizeVietnameseWord(currentRound.target_word);
    const shouldEvaluateDurableWeakWord =
      quest.source_kind === "WEAK_WORDS" &&
      currentRound.is_weak_target !== false &&
      !evaluatedWeakWordsRef.current.has(normTarget) &&
      typeof resolvedDifficultWordService.evaluatePracticeWord === "function";

    const receivedAt = Date.now();
    let verdict: "CORRECT" | "INCORRECT" | "UNCERTAIN" | "NO_CLEAR_AUDIO" =
      "UNCERTAIN";

    try {
      if (shouldEvaluateDurableWeakWord) {
        const attempt =
          await resolvedDifficultWordService.evaluatePracticeWord!(child.id, {
            request_id: buildDeterministicQuestAttemptUuid(
              quest.quest_id,
              currentRound.round_number,
              strikeCount + 1,
            ),
            normalized_word: normTarget,
            display_text: currentRound.target_word,
            context_phrase: currentRound.sentence_text,
            audio: audioBlob,
            filename: "magic-quest-word.webm",
            audio_duration_ms: qualitySnapshot?.speechDurationMs ?? null,
            audio_quality_status: qualitySnapshot?.status ?? null,
            book_id: undefined,
          });
        const spokenText = attempt.spoken_transcript ?? "";
        if (spokenText) {
          const echoCheck = echoGuardRef.current.evaluate({
            text: spokenText,
            receivedAt,
          });
          if (!echoCheck.accept) {
            verdict = "NO_CLEAR_AUDIO";
          }
        }
        if (verdict !== "NO_CLEAR_AUDIO") {
          if (attempt.assessment_status === "CORRECT") {
            verdict = "CORRECT";
            evaluatedWeakWordsRef.current.add(normTarget);
          } else if (attempt.assessment_status === "INCORRECT") {
            verdict = "INCORRECT";
            if (strikeCount + 1 >= 3) {
              evaluatedWeakWordsRef.current.add(normTarget);
            }
          } else {
            verdict = "NO_CLEAR_AUDIO";
          }
        }
      } else {
        // SRS Hygiene (Correction #3): Starter words, confidence filler words, or a
        // 2nd contextual round of an already-evaluated weak word use lightweight STT
        // without creating synthetic `difficult_word_practice_attempts` rows.
        const transcriptRes = await resolvedSpeechService.transcribe(
          audioBlob,
          {
            filename: "magic-quest-word.webm",
            languageCode: "vi",
            keyterms: [currentRound.target_word],
            source: "magic_word_quest",
          },
        );
        const rawText = transcriptRes.text ?? "";
        const echoCheck = echoGuardRef.current.evaluate({
          text: rawText,
          receivedAt,
        });
        if (!echoCheck.accept) {
          verdict = "NO_CLEAR_AUDIO";
        } else {
          verdict = evaluateTranscriptAgainstTarget(
            currentRound.target_word,
            currentRound.sentence_text,
            rawText,
          );
        }
      }
    } catch {
      verdict = "NO_CLEAR_AUDIO";
    }

    if (verdict === "CORRECT") {
      const nextSpoken = spokenCorrectCount + 1;
      setSpokenCorrectCount(nextSpoken);
      setRoundClearKind("SPOKEN");
      setRoundStep("ROUND_CLEARED");
      setStatusMessage(
        t("sentenceShooter.magicQuest.spokenPraise", {
          word: currentRound.target_word,
        }),
      );
      playShooterSound("correct", calmSound, { reducedMotion, calmSound });
      if (autopilotEnabled) {
        autoNextTimerRef.current = setTimeout(() => {
          advanceToNextRoundOrFinale({ spokenCorrect: nextSpoken });
        }, SHORT_WORD_CAPTURE_CONFIG.autoAdvanceCorrectMs);
      }
      return;
    }

    if (verdict === "NO_CLEAR_AUDIO" || verdict === "UNCERTAIN") {
      // Zero strikes consumed on silence, noise, or TTS echo bleed.
      setRoundStep("READY_TO_SPEAK");
      setStatusMessage(
        t("sentenceShooter.magicQuest.unclearVoiceRetry", {
          word: currentRound.target_word,
        }),
      );
      return;
    }

    // Gentle 3-Strike Ladder on genuine mispronunciation (`INCORRECT`).
    const nextStrike = strikeCount + 1;
    setStrikeCount(nextStrike);
    setRoundStep("READY_TO_SPEAK");

    if (nextStrike === 1) {
      setStatusMessage(
        t("sentenceShooter.magicQuest.strike1Gentle", {
          word: currentRound.target_word,
        }),
      );
      void playEphemeralSpeech(currentRound.target_word, {
        wordSample: true,
        speedScale: 0.88,
      });
      return;
    }

    if (nextStrike === 2) {
      setUsedPhonicsHint(true);
      setStatusMessage(
        t("sentenceShooter.magicQuest.strike2Phonics", {
          word: currentRound.target_word,
        }),
      );
      const lesson = buildPhonicsLesson(currentRound.target_word);
      if (lesson.supported) {
        void playCurrentPhonics(lesson);
      } else {
        void playEphemeralSpeech(currentRound.target_word, {
          wordSample: true,
          speedScale: 0.85,
        });
      }
      return;
    }

    setStatusMessage(t("sentenceShooter.magicQuest.strike3RescueReady"));
  }, [
    advanceToNextRoundOrFinale,
    autopilotEnabled,
    calmSound,
    child.id,
    currentRound,
    playCurrentPhonics,
    playEphemeralSpeech,
    quest,
    reducedMotion,
    resolvedDifficultWordService,
    resolvedSpeechService,
    spokenCorrectCount,
    strikeCount,
    t,
  ]);

  const startVoiceCapture = useCallback(async () => {
    if (!currentRound) return;
    clearTimers();
    speechPlayer.stop();
    setIsPlayingPhonics(false);
    setActivePhonicsStep(null);

    const sinceTtsEnd = Date.now() - lastTtsEndedAtRef.current;
    if (
      echoGuardRef.current.isPlaying() ||
      sinceTtsEnd < POST_TTS_COOLDOWN_MS
    ) {
      await new Promise<void>((resolve) => {
        setTimeout(
          resolve,
          Math.max(60, POST_TTS_COOLDOWN_MS - Math.max(0, sinceTtsEnd)),
        );
      });
    }

    try {
      await recorderRef.current.start({
        retainStream: true,
        mode: "short-word",
      });
    } catch {
      setMicMode("NO_MIC_FALLBACK");
      setMicFallbackBanner(true);
      setRoundStep("READY_TO_SPEAK");
      setStatusMessage(t("sentenceShooter.magicQuest.step2NoMicPrompt"));
      return;
    }

    setRoundStep("LISTENING");
    setStatusMessage(t("sentenceShooter.magicQuest.listeningStatus"));

    const startedAt = Date.now();
    let speechObserved = false;
    let lastSpeechAt = startedAt;
    let prevSpeechDur = 0;
    let consecutiveEnergy = 0;

    capturePollRef.current = setInterval(() => {
      const now = Date.now();
      const elapsed = now - startedAt;
      if (elapsed < SHORT_WORD_CAPTURE_CONFIG.acousticSettleMs) return;

      const quality = recorderRef.current.getQuality?.();
      const level = recorderRef.current.getAudioLevel?.() ?? 0;
      const activeSpeech = hasShortWordSpeechActivity({
        isSpeakingNow: recorderRef.current.getIsSpeaking(),
        audioLevel: level,
        quality,
        hasLiveBrowserSpeech: false,
        speechObserved,
        previousSpeechDurationMs: prevSpeechDur,
        consecutiveEnergyPolls: consecutiveEnergy,
      });
      prevSpeechDur = quality?.speechDurationMs ?? prevSpeechDur;
      if (activeSpeech) {
        speechObserved = true;
        lastSpeechAt = now;
        consecutiveEnergy += 1;
      } else {
        consecutiveEnergy = 0;
      }

      if (
        shouldAutoStopShortWordCapture({
          elapsedMs: elapsed,
          speechObserved,
          silenceElapsedMs: speechObserved ? now - lastSpeechAt : elapsed,
        })
      ) {
        void stopAndEvaluateRecording();
      }
    }, SHORT_WORD_CAPTURE_CONFIG.pollIntervalMs);
  }, [clearTimers, currentRound, speechPlayer, stopAndEvaluateRecording, t]);

  const scheduleAutoMicCountdown = useCallback(() => {
    clearTimers();
    setAutoMicSeconds(3);
    const tick = (remaining: number) => {
      setAutoMicSeconds(remaining);
      if (remaining <= 0) {
        setAutoMicSeconds(null);
        void startVoiceCapture();
        return;
      }
      autoMicTimerRef.current = setTimeout(() => tick(remaining - 1), 420);
    };
    autoMicTimerRef.current = setTimeout(() => tick(2), 420);
  }, [clearTimers, startVoiceCapture]);

  const handleSelectChoice = (
    choice: MagicQuestChoiceTokenDTO,
    choiceIdx: number,
  ) => {
    if (!currentRound || roundStep !== "TAP_CHOICE") return;
    const isCorrect =
      choice.id === currentRound.expected_choice_id || choice.is_target;
    const angle = (choiceIdx - (currentRound.choices.length - 1) / 2) * 14;
    setCannonAngle(angle);

    if (!isCorrect) {
      setTapMistakeCount((c) => c + 1);
      setWobbleChoiceId(choice.id);
      setStatusMessage(t("sentenceShooter.magicQuest.tapWrongGentle"));
      playShooterSound("wrong", calmSound, { reducedMotion, calmSound });
      return;
    }

    setTapCorrectCount((c) => c + 1);
    setWobbleChoiceId("");
    playShooterSound("shot", calmSound, { reducedMotion, calmSound });
    setRoundStep("READY_TO_SPEAK");

    if (micMode === "NO_MIC_FALLBACK") {
      setStatusMessage(t("sentenceShooter.magicQuest.step2NoMicPrompt"));
      void playEphemeralSpeech(currentRound.target_word, { wordSample: true });
      return;
    }

    setStatusMessage(
      t("sentenceShooter.magicQuest.step2SpeakPrompt", {
        word: currentRound.target_word,
      }),
    );
    if (autopilotEnabled) {
      scheduleAutoMicCountdown();
    }
  };

  const handleOwlRescueFire = () => {
    if (!currentRound) return;
    clearTimers();
    const normTarget =
      currentRound.normalized_word ||
      normalizeVietnameseWord(currentRound.target_word);
    evaluatedWeakWordsRef.current.add(normTarget);
    const nextRescued = effortRescuedCount + 1;
    setEffortRescuedCount(nextRescued);
    setRoundClearKind("EFFORT_RESCUE");
    setRoundStep("ROUND_CLEARED");
    setStatusMessage(t("sentenceShooter.magicQuest.rescuePraise"));
    playShooterSound("correct", calmSound, { reducedMotion, calmSound });
    void playEphemeralSpeech(currentRound.target_word, { wordSample: true });
  };

  const handleNoMicFire = async () => {
    if (!currentRound) return;
    clearTimers();
    await playEphemeralSpeech(currentRound.target_word, { wordSample: true });
    setRoundClearKind("NO_MIC");
    setRoundStep("ROUND_CLEARED");
    setStatusMessage(
      t("sentenceShooter.magicQuest.noMicPraise", {
        word: currentRound.target_word,
      }),
    );
    playShooterSound("correct", calmSound, { reducedMotion, calmSound });
    if (autopilotEnabled) {
      autoNextTimerRef.current = setTimeout(() => {
        advanceToNextRoundOrFinale({ activeMicMode: "NO_MIC_FALLBACK" });
      }, SHORT_WORD_CAPTURE_CONFIG.autoAdvanceCorrectMs);
    }
  };

  const handleExit = () => {
    clearTimers();
    recorderRef.current.cancel({ retainStream: false });
    speechPlayer.stop();
    suspendShooterAudio();
    purgeMagicQuestSessionStorage(child.id, {
      purgeAllForActiveChild: true,
    });
    onExitToLobby();
  };

  const handleDissolveScroll = () => {
    clearTimers();
    speechPlayer.stop();
    purgeMagicQuestSessionStorage(child.id, {
      purgeAllForActiveChild: true,
    });
    setPhase("DISSOLVED");
  };

  const handleWeaveFreshQuest = () => {
    clearTimers();
    speechPlayer.stop();
    purgeMagicQuestSessionStorage(child.id, {
      purgeAllForActiveChild: true,
    });
    forceFreshRef.current = true;
    setExpiredReloadBanner(false);
    setReloadNonce((n) => n + 1);
  };

  if (phase === "LOADING") {
    return (
      <section
        aria-busy="true"
        className={cn(
          "mx-auto flex w-full max-w-[920px] flex-col gap-5 px-4 py-6 sm:px-6",
          reducedMotion && "motion-reduce",
        )}
        data-testid="magic-word-quest-loading"
      >
        <BookChildHeader
          backHref="/entertainment"
          child={child}
          mobileLabel={t("sentenceShooter.mobilePlayZoneLabel")}
        />
        <div className="flex flex-col items-center gap-4 rounded-card border border-primary/25 bg-gradient-to-br from-sky via-white to-amber-50 p-8 text-center shadow-xs">
          <div className="grid size-16 place-items-center rounded-full bg-white text-3xl shadow-2xs">
            🦉
          </div>
          <h1 className="book-title text-2xl font-extrabold text-ink sm:text-3xl">
            {t("sentenceShooter.magicQuest.loadingTitle")}
          </h1>
          <div className="w-full max-w-md">
            <AiProgressBar
              active
              label={
                loadingProgress.stageLabel ??
                t("sentenceShooter.magicQuest.loadingStage1")
              }
              percent={loadingProgress.percent}
              size="sm"
              testId="magic-word-quest-progress"
            />
          </div>
        </div>
      </section>
    );
  }

  if (phase === "ERROR" || !quest) {
    return (
      <section
        className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-6 sm:px-6"
        data-testid="magic-word-quest-error"
      >
        <BookChildHeader
          backHref="/entertainment"
          child={child}
          mobileLabel={t("sentenceShooter.mobilePlayZoneLabel")}
        />
        <StatusMessage
          title={t("sentenceShooter.magicQuest.errorTitle")}
          tone="error"
        >
          {t("sentenceShooter.magicQuest.errorBody")}
        </StatusMessage>
        <div className="flex flex-wrap gap-3">
          <Button
            className="sm:w-auto"
            data-testid="magic-quest-retry-btn"
            onClick={handleWeaveFreshQuest}
            type="button"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("sentenceShooter.retry")}
          </Button>
          <Button
            className="sm:w-auto"
            onClick={handleExit}
            type="button"
            variant="secondary"
          >
            <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
            {t("sentenceShooter.magicQuest.backToLobbyBtn")}
          </Button>
        </div>
      </section>
    );
  }

  if (phase === "FINALE" || phase === "DISSOLVED") {
    const fullStoryText = quest.rounds.map((r) => r.sentence_text).join(" ");
    const dissolvedText = interpolateDissolveMessage(
      quest.dissolve_message_template_vi,
      child.alias,
      quest.target_words.length,
    );
    const showEffortBadge = effortRescuedCount > 0 || earnedStars === 1;

    return (
      <section
        className={cn(
          "mx-auto flex w-full max-w-[860px] flex-col gap-5 px-4 py-6 sm:px-6",
          reducedMotion && "motion-reduce",
        )}
        data-testid="magic-word-quest-finale"
      >
        <BookChildHeader
          backHref="/entertainment"
          child={child}
          mobileLabel={t("sentenceShooter.mobilePlayZoneLabel")}
        />

        {phase === "FINALE" ? (
          <div
            className="flex flex-col gap-5 rounded-card border-2 border-amber-300 bg-gradient-to-br from-amber-50 via-white to-sky/60 p-6 shadow-sm sm:p-8"
            data-testid="magic-finale-scroll"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold text-amber-950">
                <Sparkles aria-hidden="true" className="size-3.5" />
                {t("sentenceShooter.magicQuest.finaleEyebrow")}
              </span>
              <span
                aria-label={t("sentenceShooter.starsAria", {
                  count: earnedStars,
                })}
                className="inline-flex items-center gap-1 rounded-full bg-white px-3.5 py-1 text-base font-extrabold text-amber-600 shadow-2xs"
                data-testid="magic-finale-stars"
              >
                {"★".repeat(earnedStars)}
                {"☆".repeat(Math.max(0, 3 - earnedStars))}
              </span>
            </div>

            <h1
              className="viread-learning-content book-title text-2xl font-extrabold text-ink sm:text-3xl"
              dir="ltr"
              lang="vi"
            >
              {quest.title_vi}
            </h1>

            {showEffortBadge ? (
              <div
                className="inline-flex self-start rounded-full border border-emerald-300 bg-emerald-50 px-3.5 py-1 text-xs font-extrabold text-emerald-900"
                data-testid="magic-effort-badge"
              >
                {t("sentenceShooter.magicQuest.effortBadge")}
              </div>
            ) : null}

            <div
              className="viread-learning-content space-y-2.5 rounded-2xl border border-amber-200 bg-white/95 p-5 text-lg leading-relaxed font-bold text-ink"
              dir="ltr"
              lang="vi"
            >
              {quest.rounds.map((r) => (
                <p key={r.round_number}>{r.sentence_text}</p>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-extrabold text-muted">
                {t("sentenceShooter.practicedDifficultWordsSummary")}
              </span>
              {quest.target_words.map((word) => (
                <span
                  className="viread-learning-content rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-extrabold text-amber-950"
                  dir="ltr"
                  key={word}
                  lang="vi"
                >
                  ⭐ {word}
                </span>
              ))}
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <Button
                className="sm:w-auto"
                data-testid="magic-listen-scroll-btn"
                onClick={() => void playEphemeralSpeech(fullStoryText)}
                type="button"
                variant="secondary"
              >
                <Volume2 aria-hidden="true" className="size-4" />
                {t("sentenceShooter.magicQuest.listenFullScrollBtn")}
              </Button>
              <Button
                className="sm:w-auto"
                data-testid="magic-dissolve-btn"
                onClick={handleDissolveScroll}
                type="button"
              >
                {t("sentenceShooter.magicQuest.dissolveBtn")}
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="flex flex-col items-center gap-4 rounded-card border border-primary/25 bg-gradient-to-br from-sky/65 via-white to-emerald-50/70 p-7 text-center shadow-xs transition-opacity duration-300"
            data-testid="magic-dissolved-card"
          >
            <div aria-hidden="true" className="text-4xl">
              ✨🦉✨
            </div>
            <span className="rounded-full bg-emerald-100 px-3.5 py-1 text-xs font-extrabold text-emerald-950">
              {t("sentenceShooter.magicQuest.dissolvedBadge")}
            </span>
            <p
              className="viread-learning-content max-w-xl text-lg font-extrabold text-ink sm:text-xl"
              data-testid="magic-dissolved-message"
              dir="ltr"
              lang="vi"
            >
              {dissolvedText}
            </p>
            <div className="flex flex-wrap justify-center gap-3 pt-2">
              <Button
                className="sm:w-auto"
                data-testid="magic-play-another-btn"
                onClick={handleWeaveFreshQuest}
                type="button"
              >
                <Sparkles aria-hidden="true" className="size-4" />
                {t("sentenceShooter.magicQuest.playAnotherQuestBtn")}
              </Button>
              <Button
                className="sm:w-auto"
                data-testid="magic-back-lobby-btn"
                onClick={handleExit}
                type="button"
                variant="secondary"
              >
                {t("sentenceShooter.magicQuest.backToLobbyBtn")}
              </Button>
              <Link
                className="inline-flex min-h-12 items-center justify-center gap-1.5 rounded-control px-4 font-bold text-primary hover:bg-sky"
                href="/entertainment"
              >
                <ArrowLeft
                  aria-hidden="true"
                  className="viread-rtl-flip size-4"
                />
                {t("sentenceShooter.backToEntertainment")}
              </Link>
            </div>
          </div>
        )}
      </section>
    );
  }

  if (!currentRound) return null;

  const isTargetLoaded = roundStep !== "TAP_CHOICE";
  const isRoundCleared = roundStep === "ROUND_CLEARED";
  const isLastRound = roundIndex + 1 >= quest.rounds.length;

  return (
    <section
      className={cn(
        "mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-4 py-4 sm:px-6 sm:py-5",
        reducedMotion && "motion-reduce",
      )}
      data-calm-sound={calmSound ? "true" : "false"}
      data-mic-mode={micMode}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-testid="magic-word-quest-panel"
    >
      <BookChildHeader
        backHref="/entertainment"
        child={child}
        mobileLabel={t("sentenceShooter.mobilePlayZoneLabel")}
      />

      {expiredReloadBanner ? (
        <p
          className="rounded-control border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-950"
          data-testid="magic-expired-banner"
          role="status"
        >
          {t("sentenceShooter.magicQuest.expiredNotice")}
        </p>
      ) : null}

      {micFallbackBanner ? (
        <p
          className="rounded-control border border-sky-300 bg-sky/70 px-4 py-2.5 text-sm font-semibold text-ink"
          data-testid="magic-mic-fallback-banner"
          role="status"
        >
          {t("sentenceShooter.magicQuest.micDeniedFallbackNotice")}
        </p>
      ) : null}

      <header className="flex flex-col gap-2.5 rounded-card border border-primary/25 bg-white px-4 py-3.5 shadow-2xs lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="viread-learning-content inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-0.5 text-xs font-extrabold text-amber-950"
              dir="ltr"
              lang="vi"
            >
              {quest.ephemeral_badge_vi}
            </span>
            {quest.source_kind === "STARTER_FALLBACK" ? (
              <span
                className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-extrabold text-emerald-950"
                data-testid="magic-starter-badge"
              >
                {t("sentenceShooter.magicQuest.starterModeBadge", {
                  grade: quest.child_grade,
                })}
              </span>
            ) : (
              <span
                className="viread-learning-content rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold text-primary"
                dir="ltr"
                lang="vi"
              >
                {currentRound.phonics_label_vi}
              </span>
            )}
            <span className="text-sm font-bold text-muted">
              {t("sentenceShooter.magicQuest.roundBadge", {
                current: roundIndex + 1,
                total: quest.rounds.length,
              })}
            </span>
          </div>
          <h1
            className="viread-learning-content mt-1 text-lg font-extrabold text-ink sm:text-xl"
            dir="ltr"
            lang="vi"
          >
            {quest.title_vi}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            aria-pressed={micMode === "NO_MIC_FALLBACK"}
            className={cn(
              "inline-flex min-h-11 items-center gap-1.5 rounded-control border px-3 py-1.5 text-xs font-extrabold transition-colors",
              micMode === "NO_MIC_FALLBACK"
                ? "border-primary bg-sky text-primary"
                : "border-border bg-white text-ink hover:bg-canvas",
            )}
            data-testid="magic-nomic-toggle"
            onClick={() => {
              clearTimers();
              recorderRef.current.cancel({ retainStream: false });
              setMicMode((prev) =>
                prev === "VOICE" ? "NO_MIC_FALLBACK" : "VOICE",
              );
              if (roundStep === "LISTENING") {
                setRoundStep("READY_TO_SPEAK");
              }
            }}
            type="button"
          >
            {micMode === "NO_MIC_FALLBACK" ? (
              <MicOff aria-hidden="true" className="size-4" />
            ) : (
              <Mic aria-hidden="true" className="size-4" />
            )}
            {micMode === "NO_MIC_FALLBACK"
              ? t("sentenceShooter.magicQuest.toggleNoMicOn")
              : t("sentenceShooter.magicQuest.toggleNoMicOff")}
          </button>

          {onToggleCalmSound ? (
            <button
              aria-label={
                calmSound
                  ? t("sentenceShooter.muteSoundAria")
                  : t("sentenceShooter.enableSoundAria")
              }
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border bg-white px-2.5 text-ink hover:bg-canvas"
              onClick={onToggleCalmSound}
              type="button"
            >
              {calmSound ? (
                <Volume2 aria-hidden="true" className="size-4" />
              ) : (
                <VolumeX aria-hidden="true" className="size-4" />
              )}
            </button>
          ) : null}

          <button
            className="inline-flex min-h-11 items-center justify-center rounded-control border border-border bg-white px-3.5 text-sm font-bold text-ink hover:bg-canvas"
            data-testid="magic-exit-btn"
            onClick={handleExit}
            type="button"
          >
            {t("sentenceShooter.exit")}
          </button>
        </div>
      </header>

      {/* Story Sentence Stage */}
      <div className="flex flex-col gap-4 rounded-card border border-border bg-gradient-to-b from-sky/55 via-white to-cream/60 p-5 shadow-xs sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-extrabold text-primary">
            {roundStep === "TAP_CHOICE"
              ? t("sentenceShooter.magicQuest.step1TapPrompt")
              : micMode === "NO_MIC_FALLBACK"
                ? t("sentenceShooter.magicQuest.step2NoMicPrompt")
                : t("sentenceShooter.magicQuest.step2SpeakPrompt", {
                    word: currentRound.target_word,
                  })}
          </p>
          <Button
            className="w-auto!"
            data-testid="magic-listen-sentence-btn"
            disabled={roundStep === "LISTENING" || roundStep === "EVALUATING"}
            onClick={() => void playEphemeralSpeech(currentRound.sentence_text)}
            size="compact"
            type="button"
            variant="secondary"
          >
            <Volume2 aria-hidden="true" className="size-4" />
            {t("sentenceShooter.magicQuest.listenSentenceBtn")}
          </Button>
        </div>

        <div
          aria-label={t("sentenceShooter.slotsAria")}
          className="viread-learning-content flex min-h-24 flex-wrap items-center justify-center gap-2.5 rounded-2xl border border-primary/20 bg-white px-4 py-5"
          data-testid="magic-sentence-slots"
          dir="ltr"
          lang="vi"
        >
          {currentRound.prompt_slots.map((slot) => {
            if (!slot.is_blank) {
              return (
                <span
                  className="rounded-xl bg-cream/70 px-3 py-1.5 text-xl font-extrabold text-ink sm:text-2xl"
                  key={slot.position}
                >
                  {slot.text}
                </span>
              );
            }
            return (
              <span
                className={cn(
                  "inline-flex min-h-12 min-w-24 items-center justify-center rounded-xl border-2 px-4 py-1.5 text-xl font-extrabold transition-all sm:text-2xl",
                  isRoundCleared
                    ? "border-emerald-400 bg-emerald-100 text-emerald-950 shadow-2xs"
                    : isTargetLoaded
                      ? "border-amber-400 bg-amber-100 text-amber-950 ring-2 ring-amber-300"
                      : "border-dashed border-primary bg-sky/50 text-primary",
                )}
                data-testid="magic-blank-slot"
                key={slot.position}
              >
                {isTargetLoaded ? `✨ ${currentRound.target_word}` : "___"}
              </span>
            );
          })}
        </div>

        {/* Step 1: Choice Bubbles */}
        {roundStep === "TAP_CHOICE" ? (
          <div
            aria-label={t("sentenceShooter.wordBankAria")}
            className="flex flex-wrap items-center justify-center gap-3 pt-1"
            data-testid="magic-choice-bank"
          >
            {currentRound.choices.map((choice, idx) => (
              <button
                className={cn(
                  "viread-learning-content min-h-13 rounded-control border-2 bg-white px-5 py-2.5 text-lg font-extrabold text-ink shadow-2xs transition-transform hover:border-primary hover:bg-sky active:scale-95 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:text-xl",
                  wobbleChoiceId === choice.id
                    ? "sentence-token-wobble border-danger/60 bg-rose-50"
                    : "border-border",
                )}
                data-choice-target={choice.is_target ? "true" : "false"}
                data-testid={`magic-choice-${choice.id}`}
                dir="ltr"
                key={choice.id}
                lang="vi"
                onClick={() => handleSelectChoice(choice, idx)}
                type="button"
              >
                {choice.text}
              </button>
            ))}
          </div>
        ) : null}

        {/* Step 2: Loaded Cannon + Voice / No-Mic Fire Controls */}
        {isTargetLoaded && !isRoundCleared ? (
          <div
            className="flex flex-col items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 p-4"
            data-testid="magic-voice-stage"
          >
            {autoMicSeconds !== null ? (
              <p
                className="rounded-full bg-primary/10 px-3.5 py-1 text-sm font-extrabold text-primary"
                data-testid="magic-automic-countdown"
              >
                {t("sentenceShooter.magicQuest.autoMicCountdown", {
                  seconds: autoMicSeconds,
                })}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-center gap-3">
              {micMode === "NO_MIC_FALLBACK" ? (
                <Button
                  className="min-h-13 w-auto! px-6"
                  data-testid="magic-fire-nomic-btn"
                  onClick={() => void handleNoMicFire()}
                  type="button"
                >
                  {t("sentenceShooter.magicQuest.fireNoMicBtn")}
                </Button>
              ) : roundStep === "LISTENING" ? (
                <Button
                  className="min-h-13 w-auto! px-6"
                  data-testid="magic-stop-speak-btn"
                  onClick={() => void stopAndEvaluateRecording()}
                  type="button"
                >
                  <Square aria-hidden="true" className="size-4" />
                  {t("sentenceShooter.magicQuest.stopListeningBtn")}
                </Button>
              ) : (
                <Button
                  className="min-h-13 w-auto! px-6"
                  data-testid="magic-speak-btn"
                  disabled={roundStep === "EVALUATING"}
                  isLoading={roundStep === "EVALUATING"}
                  onClick={() => void startVoiceCapture()}
                  type="button"
                >
                  <Mic aria-hidden="true" className="size-5" />
                  {t("sentenceShooter.magicQuest.speakNowBtn")}
                </Button>
              )}

              <Button
                className="min-h-12 w-auto!"
                data-testid="magic-listen-slow-btn"
                disabled={
                  roundStep === "LISTENING" || roundStep === "EVALUATING"
                }
                onClick={() =>
                  void playEphemeralSpeech(currentRound.target_word, {
                    wordSample: true,
                    speedScale: 0.88,
                  })
                }
                size="compact"
                type="button"
                variant="secondary"
              >
                <Volume2 aria-hidden="true" className="size-4" />
                {t("sentenceShooter.magicQuest.listenWordSlowBtn")}
              </Button>

              {strikeCount >= 3 && micMode === "VOICE" ? (
                <Button
                  className="min-h-13 w-auto! border-amber-400 bg-amber-400 px-5 text-ink hover:bg-amber-300"
                  data-testid="magic-owl-rescue-btn"
                  onClick={handleOwlRescueFire}
                  type="button"
                  variant="secondary"
                >
                  {t("sentenceShooter.magicQuest.owlRescueBtn")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Strike 2 Inline Phonics Scaffold */}
        {currentPhonicsLesson && !isRoundCleared ? (
          <PhonicsLessonCard
            activeStepIndex={activePhonicsStep}
            childGrade={quest.child_grade}
            childId={child.id}
            compact
            contextSentence={currentRound.sentence_text}
            glossarySpeechPlayer={speechPlayer}
            isListeningRetry={roundStep === "LISTENING"}
            isPlayingPhonics={isPlayingPhonics}
            lesson={currentPhonicsLesson}
            onPlayPhonics={() => void playCurrentPhonics(currentPhonicsLesson)}
            onPlayWord={() =>
              void playEphemeralSpeech(currentRound.target_word, {
                wordSample: true,
                speedScale: 0.88,
              })
            }
            onStartRetry={() => void startVoiceCapture()}
            onStopAudio={() => {
              speechPlayer.stop();
              setIsPlayingPhonics(false);
              setActivePhonicsStep(null);
            }}
          />
        ) : null}

        {/* Round Cleared Celebration Bar */}
        {isRoundCleared ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3.5"
            data-clear-kind={roundClearKind ?? "SPOKEN"}
            data-testid="magic-round-cleared"
          >
            <p
              className="viread-learning-content text-base font-extrabold text-emerald-950"
              dir="ltr"
              lang="vi"
            >
              {statusMessage}
            </p>
            <Button
              className="w-auto!"
              data-testid="magic-next-round-btn"
              onClick={() => advanceToNextRoundOrFinale()}
              size="compact"
              type="button"
            >
              {isLastRound
                ? t("sentenceShooter.magicQuest.openFinaleScrollBtn")
                : t("sentenceShooter.magicQuest.nextRoundBtn")}
              <ArrowRight
                aria-hidden="true"
                className="viread-rtl-flip size-4"
              />
            </Button>
          </div>
        ) : null}

        {/* Toy Cannon Dock */}
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <div
            aria-hidden="true"
            className="shrink-0 motion-safe:transition-transform"
            data-cannon-angle={Math.round(cannonAngle)}
          >
            <ToyCannon angle={cannonAngle} className="size-14" />
          </div>
          <p
            aria-live="polite"
            className="viread-learning-content min-h-10 flex-1 content-center text-sm font-bold text-primary"
            data-testid="magic-status-message"
            dir="ltr"
            lang="vi"
            role="status"
          >
            {statusMessage || currentRound.prompt_hint_vi}
          </p>
        </div>
      </div>
    </section>
  );
}
