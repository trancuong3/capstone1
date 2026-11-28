"use client";

import {
  ArrowLeft,
  ArrowRight,
  Drum,
  Mic,
  MicOff,
  Music2,
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
import { PhonicsLessonCard } from "@/components/reading/phonics-lesson-card";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import { useSpeechPlayer, type SpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import {
  createAdaptiveLearningService,
  magicRhythmChantSchema,
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
  MagicQuestMicMode,
  MagicRhythmChantDTO,
  MagicRhythmChantLineDTO,
} from "@/types/adaptive-learning";
import type { ChildProfileDTO } from "@/types/child";

const MAGIC_CHANT_STORAGE_PREFIX = "viread:magic-chant:";
const POST_TTS_COOLDOWN_MS = 300;
const ON_BEAT_TOLERANCE_MS = 260;

export function getMagicChantSessionStorageKey(childId: string): string {
  return `${MAGIC_CHANT_STORAGE_PREFIX}${childId}`;
}

export function purgeMagicChantSessionStorage(
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
      if (!key || !key.startsWith(MAGIC_CHANT_STORAGE_PREFIX)) continue;
      const keyChildId = key.slice(MAGIC_CHANT_STORAGE_PREFIX.length);
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
        const parsed = magicRhythmChantSchema.safeParse(JSON.parse(raw));
        if (!parsed.success || parsed.data.chant_exp <= nowSec) {
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

export function buildDeterministicChantAttemptUuid(
  chantId: string,
  lineNumber: number,
  attemptOrdinal: number,
): string {
  const seed = `viread:magic-chant-attempt:${chantId}:${lineNumber}:${attemptOrdinal}`;
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

let woodblockAudioCtx: AudioContext | null = null;

function playWoodblockPulse(enabled: boolean, accent: boolean): void {
  if (!enabled || typeof window === "undefined") return;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (typeof Ctor !== "function") return;
  try {
    if (!woodblockAudioCtx || woodblockAudioCtx.state === "closed") {
      woodblockAudioCtx = new Ctor();
    }
    const ctx = woodblockAudioCtx;
    const trigger = () => {
      if (ctx.state === "closed") return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(accent ? 880 : 720, now);
      osc.frequency.exponentialRampToValueAtTime(
        accent ? 520 : 440,
        now + 0.045,
      );
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(
        accent ? 0.045 : 0.032,
        now + 0.008,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.06);
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          // Ignore disconnected audio nodes.
        }
      };
    };
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      void Promise.resolve(ctx.resume())
        .then(trigger)
        .catch(() => undefined);
    } else {
      trigger();
    }
  } catch {
    // WebAudio is optional enhancement; never block gameplay.
  }
}

function suspendWoodblockAudio(): void {
  if (!woodblockAudioCtx || woodblockAudioCtx.state === "closed") return;
  try {
    if (
      woodblockAudioCtx.state === "running" &&
      typeof woodblockAudioCtx.suspend === "function"
    ) {
      void Promise.resolve(woodblockAudioCtx.suspend()).catch(() => undefined);
    }
  } catch {
    // Ignore suspend errors.
  }
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

function evaluateChantTranscript(
  targetWord: string,
  lineText: string,
  rawTranscript: string,
): "CORRECT" | "INCORRECT" | "UNCERTAIN" | "NO_CLEAR_AUDIO" {
  const cleaned = stripNonSpeechAnnotations(rawTranscript).trim();
  if (!cleaned) return "NO_CLEAR_AUDIO";

  const phraseVerdict = classifyPracticePhraseTranscript(targetWord, cleaned, {
    contextPhrase: lineText,
  });
  if (phraseVerdict === "CORRECT") return "CORRECT";

  const targetTokens = tokenizeVietnameseText(targetWord)
    .map((tok) => normalizeVietnameseWord(tok))
    .filter(Boolean);
  const spokenTokens = tokenizeVietnameseText(cleaned)
    .map((tok) => normalizeVietnameseWord(tok))
    .filter(Boolean);
  if (!spokenTokens.length) return "NO_CLEAR_AUDIO";

  if (targetTokens.length === 1) {
    const targetNorm = targetTokens[0]!;
    if (spokenTokens.includes(targetNorm)) return "CORRECT";
    const phonics = matchPhonicsSpelling(spokenTokens, targetNorm);
    if (phonics?.matched) return "CORRECT";
  } else if (targetTokens.length > 1) {
    if (spokenTokens.join(" ").includes(targetTokens.join(" "))) {
      return "CORRECT";
    }
  }

  if (phraseVerdict === "NOT_RECOGNIZED" || phraseVerdict === "UNCERTAIN") {
    return "UNCERTAIN";
  }
  return "INCORRECT";
}

type ChantPhase = "LOADING" | "ERROR" | "PLAYING" | "FINALE" | "DISSOLVED";
type LineStep =
  "CLAP_BEATS" | "READY_TO_SPEAK" | "LISTENING" | "EVALUATING" | "LINE_CLEARED";

export interface MagicRhythmChantPanelProps {
  readonly child: ChildProfileDTO;
  readonly focusWords?: readonly string[];
  readonly calmSound: boolean;
  readonly reducedMotion: boolean;
  readonly autopilotEnabled: boolean;
  readonly onToggleCalmSound?: () => void;
  readonly onExitToLibrary: () => void;
  readonly adaptiveService?: Pick<
    AdaptiveLearningService,
    "createMagicRhythmChant" | "completeMagicRhythmChant"
  >;
  readonly difficultWordService?: Pick<
    DifficultWordService,
    "evaluatePracticeWord"
  >;
  readonly speechService?: Pick<SpeechService, "transcribe">;
  readonly speechPlayer?: SpeechPlayer;
}

export function MagicRhythmChantPanel({
  child,
  focusWords = [],
  calmSound,
  reducedMotion,
  autopilotEnabled,
  onToggleCalmSound,
  onExitToLibrary,
  adaptiveService: adaptiveServiceProp,
  difficultWordService: difficultWordServiceProp,
  speechService: speechServiceProp,
  speechPlayer: speechPlayerProp,
}: MagicRhythmChantPanelProps) {
  const t = useTranslations("entertainment");
  const tGames = useTranslations("games");
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

  const [phase, setPhase] = useState<ChantPhase>("LOADING");
  const [chant, setChant] = useState<MagicRhythmChantDTO | null>(null);
  const [expiredReloadBanner, setExpiredReloadBanner] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const forceFreshRef = useRef(false);

  const [lineIndex, setLineIndex] = useState(0);
  const [lineStep, setLineStep] = useState<LineStep>("CLAP_BEATS");
  const [lineBeatTaps, setLineBeatTaps] = useState(0);
  const [activeBeatPulse, setActiveBeatPulse] = useState<number | null>(null);
  const [isPulseRunning, setIsPulseRunning] = useState(false);

  const [strikeCount, setStrikeCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState("");
  const [micMode, setMicMode] = useState<MagicQuestMicMode>("VOICE");
  const [micFallbackBanner, setMicFallbackBanner] = useState(false);
  const [activePhonicsStep, setActivePhonicsStep] = useState<number | null>(
    null,
  );
  const [isPlayingPhonics, setIsPlayingPhonics] = useState(false);

  const [beatTapsOnTime, setBeatTapsOnTime] = useState(0);
  const [beatTapsTotal, setBeatTapsTotal] = useState(0);
  const [spokenCorrectCount, setSpokenCorrectCount] = useState(0);
  const [effortRescuedCount, setEffortRescuedCount] = useState(0);
  const [usedPhonicsHint, setUsedPhonicsHint] = useState(false);
  const [earnedStars, setEarnedStars] = useState(3);

  const startedAtMsRef = useRef<number>(0);
  const evaluatedWeakWordsRef = useRef<Set<string>>(new Set());
  const completionSentForChantRef = useRef<string | null>(null);
  const echoGuardRef = useRef(new EchoGuard());
  const lastAudioEndedAtRef = useRef(0);
  const playbackSeqRef = useRef(0);
  const pulseOriginMsRef = useRef<number>(0);
  const pulseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoNextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capturePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);
  const previousChildIdRef = useRef<string>(child.id);

  const stopPulse = useCallback(() => {
    if (pulseTimerRef.current !== null) {
      clearInterval(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
    setIsPulseRunning(false);
    setActiveBeatPulse(null);
    pulseOriginMsRef.current = 0;
    lastAudioEndedAtRef.current = Date.now();
  }, []);

  const clearTimers = useCallback(() => {
    stopPulse();
    if (autoNextTimerRef.current !== null) {
      clearTimeout(autoNextTimerRef.current);
      autoNextTimerRef.current = null;
    }
    if (capturePollRef.current !== null) {
      clearInterval(capturePollRef.current);
      capturePollRef.current = null;
    }
  }, [stopPulse]);

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
      { atPct: 0, label: t("karaoke.magicChant.loadingStage1") },
      { atPct: 55, label: t("karaoke.magicChant.loadingStage2") },
      { atPct: 86, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 2_800,
  });

  useEffect(() => {
    speechPlayer.setCacheContext?.({
      ephemeral: true,
      bypassSessionLock: true,
    });
    return () => {
      speechPlayer.setCacheContext?.(null);
    };
  }, [speechPlayer]);

  useEffect(() => {
    if (previousChildIdRef.current !== child.id) {
      purgeMagicChantSessionStorage(previousChildIdRef.current, {
        purgeAllForActiveChild: true,
      });
      previousChildIdRef.current = child.id;
    }
    purgeMagicChantSessionStorage(child.id, {
      purgeAllForActiveChild: false,
      skipActiveChildEntry: true,
    });
  }, [child.id]);

  useEffect(() => {
    const pauseEverything = () => {
      clearTimers();
      recorderRef.current.cancel({ retainStream: false });
      speechPlayer.stop();
      setIsPlayingPhonics(false);
      setActivePhonicsStep(null);
      suspendWoodblockAudio();
      setLineStep((prev) => (prev === "LISTENING" ? "READY_TO_SPEAK" : prev));
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
      suspendWoodblockAudio();
    };
  }, [clearTimers, speechPlayer]);

  const playEphemeralSpeech = useCallback(
    async (
      text: string,
      opts?: {
        readonly wordSample?: boolean;
        readonly speedScale?: number;
      },
    ) => {
      if (!calmSound || !text.trim()) return;
      speechPlayer.stop();
      setIsPlayingPhonics(false);
      setActivePhonicsStep(null);
      playbackSeqRef.current += 1;
      const playId = `mc-tts-${playbackSeqRef.current}`;
      echoGuardRef.current.playbackStarted(playId, text, Date.now());
      try {
        await speechPlayer.play(text, {
          ephemeral: true,
          bypassSessionLock: true,
          wordSample: opts?.wordSample,
          speedScale: opts?.speedScale,
          utteranceKind: opts?.wordSample ? "word_sample" : "game_sample",
        });
      } catch {
        echoGuardRef.current.discardPlayback(playId);
      } finally {
        const now = Date.now();
        lastAudioEndedAtRef.current = now;
        echoGuardRef.current.playbackEnded(playId, now);
      }
    },
    [calmSound, speechPlayer],
  );

  // Load or hydrate chant on mount / reload.
  useEffect(() => {
    const controller = new AbortController();
    activeAbortRef.current?.abort();
    activeAbortRef.current = controller;
    let active = true;

    async function loadChant() {
      clearTimers();
      setPhase("LOADING");
      setLineIndex(0);
      setLineStep("CLAP_BEATS");
      setLineBeatTaps(0);
      setStrikeCount(0);
      setStatusMessage("");
      setBeatTapsOnTime(0);
      setBeatTapsTotal(0);
      setSpokenCorrectCount(0);
      setEffortRescuedCount(0);
      setUsedPhonicsHint(false);
      evaluatedWeakWordsRef.current = new Set();
      completionSentForChantRef.current = null;
      startedAtMsRef.current = Date.now();

      const storageKey = getMagicChantSessionStorageKey(child.id);
      let hadExpiredCachedChant = false;

      if (!forceFreshRef.current && typeof window !== "undefined") {
        try {
          const cachedRaw = window.sessionStorage.getItem(storageKey);
          if (cachedRaw) {
            const parsed = magicRhythmChantSchema.safeParse(
              JSON.parse(cachedRaw),
            );
            const nowSec = Math.floor(Date.now() / 1000);
            if (parsed.success && parsed.data.child_id === child.id) {
              if (parsed.data.chant_exp > nowSec) {
                if (!active) return;
                setChant(parsed.data);
                setPhase("PLAYING");
                return;
              }
              hadExpiredCachedChant = true;
            }
            window.sessionStorage.removeItem(storageKey);
          }
        } catch {
          purgeMagicChantSessionStorage(child.id);
        }
      }

      const shouldRefresh = forceFreshRef.current || hadExpiredCachedChant;
      forceFreshRef.current = false;
      if (hadExpiredCachedChant && active) {
        setExpiredReloadBanner(true);
      }

      try {
        const created = await resolvedAdaptiveService.createMagicRhythmChant(
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
            // Non-blocking storage restriction.
          }
        }
        setChant(created);
        setPhase("PLAYING");
      } catch {
        if (!active || controller.signal.aborted) return;
        setPhase("ERROR");
      }
    }

    void loadChant();
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [child.id, reloadNonce, resolvedAdaptiveService, teacherPersona.gender]);

  const currentLine: MagicRhythmChantLineDTO | null = useMemo(
    () => (chant ? (chant.lines[lineIndex] ?? null) : null),
    [chant, lineIndex],
  );

  const beatIntervalMs = useMemo(
    () => Math.round(60_000 / Math.max(40, Math.min(160, chant?.bpm ?? 80))),
    [chant?.bpm],
  );

  const currentPhonicsLesson: PhonicsLessonPlan | null = useMemo(() => {
    if (!currentLine || strikeCount < 2) return null;
    return buildPhonicsLesson(currentLine.target_word);
  }, [currentLine, strikeCount]);

  const startWoodblockBeatGuide = useCallback(
    (beatCount: number) => {
      stopPulse();
      const now = Date.now();
      pulseOriginMsRef.current = now;
      setIsPulseRunning(true);
      setActiveBeatPulse(0);
      playWoodblockPulse(calmSound, true);

      let tickCount = 0;
      pulseTimerRef.current = setInterval(() => {
        tickCount += 1;
        if (tickCount >= beatCount * 2) {
          stopPulse();
          return;
        }
        const beatIdx = tickCount % beatCount;
        setActiveBeatPulse(beatIdx);
        playWoodblockPulse(calmSound, beatIdx === 0);
      }, beatIntervalMs);
    },
    [beatIntervalMs, calmSound, stopPulse],
  );

  const playCurrentPhonics = useCallback(
    async (lesson: PhonicsLessonPlan) => {
      if (!calmSound || !lesson.supported) return;
      stopPulse();
      speechPlayer.stop();
      setIsPlayingPhonics(true);
      setActivePhonicsStep(0);
      playbackSeqRef.current += 1;
      const playId = `mc-phonics-${playbackSeqRef.current}`;
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
        lastAudioEndedAtRef.current = now;
        echoGuardRef.current.playbackEnded(playId, now);
        setIsPlayingPhonics(false);
        setActivePhonicsStep(null);
      }
    },
    [calmSound, speechPlayer, stopPulse],
  );

  const computeFinalStars = useCallback(
    (
      totalLines: number,
      nextSpokenCorrect: number,
      nextEffortRescued: number,
      nextOnTime: number,
      nextTotalTaps: number,
      activeMicMode: MagicQuestMicMode,
    ): number => {
      const rhythmGood =
        nextTotalTaps > 0 && nextOnTime / Math.max(1, nextTotalTaps) >= 0.5;
      let raw = 1;
      if (
        activeMicMode === "VOICE" &&
        nextSpokenCorrect >= totalLines &&
        nextEffortRescued === 0 &&
        rhythmGood
      ) {
        raw = 3;
      } else if (
        nextSpokenCorrect >= 1 ||
        (activeMicMode === "NO_MIC_FALLBACK" && rhythmGood)
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
      readonly onTimeTaps?: number;
      readonly totalTaps?: number;
      readonly phonicsUsed?: boolean;
      readonly activeMicMode?: MagicQuestMicMode;
    }) => {
      if (!chant) return;
      clearTimers();
      recorderRef.current.cancel({ retainStream: false });
      speechPlayer.stop();
      suspendWoodblockAudio();

      const finalSpoken = overrides?.spokenCorrect ?? spokenCorrectCount;
      const finalRescued = overrides?.effortRescued ?? effortRescuedCount;
      const finalOnTime = Math.min(32, overrides?.onTimeTaps ?? beatTapsOnTime);
      const finalTotalTaps = Math.min(
        64,
        Math.max(finalOnTime, overrides?.totalTaps ?? beatTapsTotal),
      );
      const finalPhonics = overrides?.phonicsUsed ?? usedPhonicsHint;
      const finalMicMode = overrides?.activeMicMode ?? micMode;

      const stars = computeFinalStars(
        chant.lines.length,
        finalSpoken,
        finalRescued,
        finalOnTime,
        finalTotalTaps,
        finalMicMode,
      );
      setEarnedStars(stars);
      setPhase("FINALE");

      // Purge ephemeral sessionStorage immediately upon completion ("hát xong tự xóa").
      purgeMagicChantSessionStorage(child.id, {
        purgeAllForActiveChild: true,
      });

      if (completionSentForChantRef.current === chant.chant_id) return;
      completionSentForChantRef.current = chant.chant_id;

      const nowSec = Math.floor(Date.now() / 1000);
      if (chant.chant_exp <= nowSec) return;

      const durationSeconds = Math.max(
        1,
        Math.min(
          900,
          Math.round((Date.now() - startedAtMsRef.current) / 1000) || 1,
        ),
      );

      try {
        const res = await resolvedAdaptiveService.completeMagicRhythmChant(
          child.id,
          {
            chant_id: chant.chant_id,
            chant_exp: chant.chant_exp,
            chant_sig: chant.chant_sig,
            target_words: chant.target_words,
            lines_completed: chant.lines.length,
            total_lines: chant.lines.length,
            beat_taps_on_time: finalOnTime,
            beat_taps_total: finalTotalTaps,
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
        // Non-blocking: local celebration & durable word mastery attempts already saved.
      }
    },
    [
      beatTapsOnTime,
      beatTapsTotal,
      chant,
      child.id,
      clearTimers,
      computeFinalStars,
      effortRescuedCount,
      micMode,
      resolvedAdaptiveService,
      speechPlayer,
      spokenCorrectCount,
      usedPhonicsHint,
    ],
  );

  const advanceToNextLineOrFinale = useCallback(
    (overrides?: {
      readonly spokenCorrect?: number;
      readonly effortRescued?: number;
      readonly activeMicMode?: MagicQuestMicMode;
    }) => {
      if (!chant) return;
      clearTimers();
      speechPlayer.stop();
      setIsPlayingPhonics(false);
      setActivePhonicsStep(null);

      if (lineIndex + 1 >= chant.lines.length) {
        void enterFinale(overrides);
        return;
      }

      setLineIndex((idx) => idx + 1);
      setLineStep("CLAP_BEATS");
      setLineBeatTaps(0);
      setStrikeCount(0);
      setStatusMessage("");
    },
    [chant, clearTimers, enterFinale, lineIndex, speechPlayer],
  );

  const stopAndEvaluateRecording = useCallback(async () => {
    if (!chant || !currentLine) return;
    if (capturePollRef.current !== null) {
      clearInterval(capturePollRef.current);
      capturePollRef.current = null;
    }

    const qualitySnapshot = recorderRef.current.getQuality?.();
    setLineStep("EVALUATING");
    setStatusMessage(t("karaoke.magicChant.evaluatingStatus"));

    let audioBlob: Blob | null = null;
    try {
      audioBlob = await recorderRef.current.stop();
    } catch {
      audioBlob = null;
    }

    if (!audioBlob || audioBlob.size === 0) {
      setLineStep("READY_TO_SPEAK");
      setStatusMessage(
        t("karaoke.magicChant.unclearVoiceRetry", {
          word: currentLine.target_word,
        }),
      );
      return;
    }

    const normTarget =
      currentLine.normalized_word ||
      normalizeVietnameseWord(currentLine.target_word);
    const shouldEvaluateDurableWeakWord =
      chant.source_kind === "WEAK_WORDS" &&
      currentLine.is_weak_target !== false &&
      !evaluatedWeakWordsRef.current.has(normTarget) &&
      typeof resolvedDifficultWordService.evaluatePracticeWord === "function";

    const receivedAt = Date.now();
    let verdict: "CORRECT" | "INCORRECT" | "UNCERTAIN" | "NO_CLEAR_AUDIO" =
      "UNCERTAIN";

    try {
      if (shouldEvaluateDurableWeakWord) {
        const attempt =
          await resolvedDifficultWordService.evaluatePracticeWord!(child.id, {
            request_id: buildDeterministicChantAttemptUuid(
              chant.chant_id,
              currentLine.line_number,
              strikeCount + 1,
            ),
            normalized_word: normTarget,
            display_text: currentLine.target_word,
            context_phrase: currentLine.line_text,
            audio: audioBlob,
            filename: "magic-chant-word.webm",
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
        const transcriptRes = await resolvedSpeechService.transcribe(
          audioBlob,
          {
            filename: "magic-chant-word.webm",
            languageCode: "vi",
            keyterms: [currentLine.target_word],
            source: "magic_rhythm_chant",
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
          verdict = evaluateChantTranscript(
            currentLine.target_word,
            currentLine.line_text,
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
      setLineStep("LINE_CLEARED");
      setStatusMessage(
        t("karaoke.magicChant.spokenPraise", {
          word: currentLine.target_word,
        }),
      );
      if (autopilotEnabled) {
        autoNextTimerRef.current = setTimeout(() => {
          advanceToNextLineOrFinale({ spokenCorrect: nextSpoken });
        }, SHORT_WORD_CAPTURE_CONFIG.autoAdvanceCorrectMs);
      }
      return;
    }

    if (verdict === "NO_CLEAR_AUDIO" || verdict === "UNCERTAIN") {
      setLineStep("READY_TO_SPEAK");
      setStatusMessage(
        t("karaoke.magicChant.unclearVoiceRetry", {
          word: currentLine.target_word,
        }),
      );
      return;
    }

    const nextStrike = strikeCount + 1;
    setStrikeCount(nextStrike);
    setLineStep("READY_TO_SPEAK");

    if (nextStrike === 1) {
      setStatusMessage(
        t("karaoke.magicChant.strike1Gentle", {
          word: currentLine.target_word,
        }),
      );
      void playEphemeralSpeech(currentLine.target_word, {
        wordSample: true,
        speedScale: 0.88,
      });
      return;
    }

    if (nextStrike === 2) {
      setUsedPhonicsHint(true);
      setStatusMessage(
        t("karaoke.magicChant.strike2Phonics", {
          word: currentLine.target_word,
        }),
      );
      const lesson = buildPhonicsLesson(currentLine.target_word);
      if (lesson.supported) {
        void playCurrentPhonics(lesson);
      } else {
        void playEphemeralSpeech(currentLine.target_word, {
          wordSample: true,
          speedScale: 0.85,
        });
      }
      return;
    }

    setStatusMessage(t("karaoke.magicChant.strike3RescueReady"));
  }, [
    advanceToNextLineOrFinale,
    autopilotEnabled,
    chant,
    child.id,
    currentLine,
    playCurrentPhonics,
    playEphemeralSpeech,
    resolvedDifficultWordService,
    resolvedSpeechService,
    spokenCorrectCount,
    strikeCount,
    t,
  ]);

  const startVoiceCapture = useCallback(async () => {
    if (!currentLine) return;
    // Pause 80 BPM woodblock pulse & any TTS BEFORE opening microphone (zero audio bleed).
    clearTimers();
    speechPlayer.stop();
    suspendWoodblockAudio();
    setIsPlayingPhonics(false);
    setActivePhonicsStep(null);

    const sinceAudioEnd = Date.now() - lastAudioEndedAtRef.current;
    if (
      echoGuardRef.current.isPlaying() ||
      sinceAudioEnd < POST_TTS_COOLDOWN_MS
    ) {
      await new Promise<void>((resolve) => {
        setTimeout(
          resolve,
          Math.max(60, POST_TTS_COOLDOWN_MS - Math.max(0, sinceAudioEnd)),
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
      setLineStep("READY_TO_SPEAK");
      setStatusMessage(t("karaoke.magicChant.step2NoMicPrompt"));
      return;
    }

    setLineStep("LISTENING");
    setStatusMessage(t("karaoke.magicChant.listeningStatus"));

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
  }, [clearTimers, currentLine, speechPlayer, stopAndEvaluateRecording, t]);

  const handleBeatTap = () => {
    if (!currentLine || lineStep !== "CLAP_BEATS") return;
    const now = Date.now();
    if (pulseOriginMsRef.current === 0) {
      pulseOriginMsRef.current = now;
    }
    const elapsed = Math.max(0, now - pulseOriginMsRef.current);
    const offsetInBeat = elapsed % beatIntervalMs;
    const distanceToGrid = Math.min(
      offsetInBeat,
      beatIntervalMs - offsetInBeat,
    );
    const isOnBeat = elapsed === 0 || distanceToGrid <= ON_BEAT_TOLERANCE_MS;

    const nextLineTaps = lineBeatTaps + 1;
    setLineBeatTaps(nextLineTaps);
    setBeatTapsTotal((c) => Math.min(64, c + 1));
    if (isOnBeat) {
      setBeatTapsOnTime((c) => Math.min(32, c + 1));
    }
    setActiveBeatPulse((nextLineTaps - 1) % currentLine.beat_count);
    playWoodblockPulse(calmSound, nextLineTaps === 1);

    if (nextLineTaps >= currentLine.beat_count) {
      stopPulse();
      setLineStep("READY_TO_SPEAK");
      if (micMode === "NO_MIC_FALLBACK") {
        setStatusMessage(t("karaoke.magicChant.step2NoMicPrompt"));
        void playEphemeralSpeech(currentLine.target_word, { wordSample: true });
      } else {
        setStatusMessage(
          t("karaoke.magicChant.step2SpeakPrompt", {
            word: currentLine.target_word,
          }),
        );
      }
    }
  };

  const handleListenModelChant = () => {
    if (!currentLine) return;
    startWoodblockBeatGuide(currentLine.beat_count);
    void playEphemeralSpeech(currentLine.line_text);
  };

  const handleOwlRescue = () => {
    if (!currentLine) return;
    clearTimers();
    const normTarget =
      currentLine.normalized_word ||
      normalizeVietnameseWord(currentLine.target_word);
    evaluatedWeakWordsRef.current.add(normTarget);
    setEffortRescuedCount((c) => c + 1);
    setLineStep("LINE_CLEARED");
    setStatusMessage(t("karaoke.magicChant.rescuePraise"));
    void playEphemeralSpeech(currentLine.target_word, { wordSample: true });
  };

  const handleNoMicCompleteLine = async () => {
    if (!currentLine) return;
    clearTimers();
    await playEphemeralSpeech(currentLine.line_text);
    setLineStep("LINE_CLEARED");
    setStatusMessage(
      t("karaoke.magicChant.noMicPraise", {
        word: currentLine.target_word,
      }),
    );
  };

  const handleExit = () => {
    clearTimers();
    recorderRef.current.cancel({ retainStream: false });
    speechPlayer.stop();
    suspendWoodblockAudio();
    purgeMagicChantSessionStorage(child.id, {
      purgeAllForActiveChild: true,
    });
    onExitToLibrary();
  };

  const handleDissolve = () => {
    clearTimers();
    speechPlayer.stop();
    suspendWoodblockAudio();
    purgeMagicChantSessionStorage(child.id, {
      purgeAllForActiveChild: true,
    });
    setPhase("DISSOLVED");
  };

  const handleWeaveFreshChant = () => {
    clearTimers();
    speechPlayer.stop();
    purgeMagicChantSessionStorage(child.id, {
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
        data-testid="magic-rhythm-chant-loading"
      >
        <BookChildHeader
          backHref="/entertainment"
          child={child}
          mobileLabel={t("karaoke.playerScreen.childStageLabel")}
        />
        <div className="flex flex-col items-center gap-4 rounded-card border border-rose-200 bg-gradient-to-br from-rose-50 via-white to-amber-50 p-8 text-center shadow-xs">
          <div className="grid size-16 place-items-center rounded-full bg-white text-3xl shadow-2xs">
            🥁
          </div>
          <h1 className="book-title text-2xl font-extrabold text-ink sm:text-3xl">
            {t("karaoke.magicChant.loadingTitle")}
          </h1>
          <div className="w-full max-w-md">
            <AiProgressBar
              active
              label={
                loadingProgress.stageLabel ??
                t("karaoke.magicChant.loadingStage1")
              }
              percent={loadingProgress.percent}
              size="sm"
              testId="magic-rhythm-chant-progress"
            />
          </div>
        </div>
      </section>
    );
  }

  if (phase === "ERROR" || !chant) {
    return (
      <section
        className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-6 sm:px-6"
        data-testid="magic-rhythm-chant-error"
      >
        <BookChildHeader
          backHref="/entertainment"
          child={child}
          mobileLabel={t("karaoke.playerScreen.childStageLabel")}
        />
        <StatusMessage title={t("karaoke.magicChant.errorTitle")} tone="error">
          {t("karaoke.magicChant.errorBody")}
        </StatusMessage>
        <div className="flex flex-wrap gap-3">
          <Button
            className="sm:w-auto"
            data-testid="magic-chant-retry-btn"
            onClick={handleWeaveFreshChant}
            type="button"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {tGames("sentenceShooter.retry")}
          </Button>
          <Button
            className="sm:w-auto"
            onClick={handleExit}
            type="button"
            variant="secondary"
          >
            <ArrowLeft aria-hidden="true" className="viread-rtl-flip size-4" />
            {t("karaoke.magicChant.backToLibraryBtn")}
          </Button>
        </div>
      </section>
    );
  }

  if (phase === "FINALE" || phase === "DISSOLVED") {
    const fullChantText = chant.lines.map((l) => l.line_text).join(" ");
    const dissolvedText = interpolateDissolveMessage(
      chant.dissolve_message_template_vi,
      child.alias,
      chant.target_words.length,
    );

    return (
      <section
        className={cn(
          "mx-auto flex w-full max-w-[860px] flex-col gap-5 px-4 py-6 sm:px-6",
          reducedMotion && "motion-reduce",
        )}
        data-testid="magic-rhythm-chant-finale"
      >
        <BookChildHeader
          backHref="/entertainment"
          child={child}
          mobileLabel={t("karaoke.playerScreen.childStageLabel")}
        />

        {phase === "FINALE" ? (
          <div
            className="flex flex-col gap-5 rounded-card border-2 border-rose-300 bg-gradient-to-br from-rose-50 via-white to-amber-50 p-6 shadow-sm sm:p-8"
            data-testid="magic-chant-finale-scroll"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 px-3 py-1 text-xs font-extrabold text-rose-900">
                <Music2 aria-hidden="true" className="size-3.5" />
                {t("karaoke.magicChant.finaleEyebrow")}
              </span>
              <span
                aria-label={tGames("sentenceShooter.starsAria", {
                  count: earnedStars,
                })}
                className="inline-flex items-center gap-1 rounded-full bg-white px-3.5 py-1 text-base font-extrabold text-amber-600 shadow-2xs"
                data-testid="magic-chant-finale-stars"
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
              {chant.title_vi}
            </h1>

            <div
              className="viread-learning-content space-y-2.5 rounded-2xl border border-rose-200 bg-white/95 p-5 text-lg leading-relaxed font-bold text-ink"
              dir="ltr"
              lang="vi"
            >
              {chant.lines.map((line) => (
                <p key={line.line_number}>🎵 {line.line_text}</p>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-extrabold text-muted">
                {tGames("sentenceShooter.practicedDifficultWordsSummary")}
              </span>
              {chant.target_words.map((word) => (
                <span
                  className="viread-learning-content rounded-full border border-rose-300 bg-rose-50 px-3 py-1 text-xs font-extrabold text-rose-950"
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
                data-testid="magic-chant-listen-scroll-btn"
                onClick={() => void playEphemeralSpeech(fullChantText)}
                type="button"
                variant="secondary"
              >
                <Volume2 aria-hidden="true" className="size-4" />
                {t("karaoke.magicChant.listenFullChantBtn")}
              </Button>
              <Button
                className="sm:w-auto"
                data-testid="magic-chant-dissolve-btn"
                onClick={handleDissolve}
                type="button"
              >
                {t("karaoke.magicChant.dissolveBtn")}
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="flex flex-col items-center gap-4 rounded-card border border-rose-200 bg-gradient-to-br from-rose-50/70 via-white to-emerald-50/70 p-7 text-center shadow-xs transition-opacity duration-300"
            data-testid="magic-chant-dissolved-card"
          >
            <div aria-hidden="true" className="text-4xl">
              ✨🎵🦉🎵✨
            </div>
            <span className="rounded-full bg-emerald-100 px-3.5 py-1 text-xs font-extrabold text-emerald-950">
              {t("karaoke.magicChant.dissolvedBadge")}
            </span>
            <p
              className="viread-learning-content max-w-xl text-lg font-extrabold text-ink sm:text-xl"
              data-testid="magic-chant-dissolved-message"
              dir="ltr"
              lang="vi"
            >
              {dissolvedText}
            </p>
            <div className="flex flex-wrap justify-center gap-3 pt-2">
              <Button
                className="sm:w-auto"
                data-testid="magic-chant-play-another-btn"
                onClick={handleWeaveFreshChant}
                type="button"
              >
                <Sparkles aria-hidden="true" className="size-4" />
                {t("karaoke.magicChant.playAnotherBtn")}
              </Button>
              <Button
                className="sm:w-auto"
                data-testid="magic-chant-back-library-btn"
                onClick={handleExit}
                type="button"
                variant="secondary"
              >
                {t("karaoke.magicChant.backToLibraryBtn")}
              </Button>
              <Link
                className="inline-flex min-h-12 items-center justify-center gap-1.5 rounded-control px-4 font-bold text-primary hover:bg-sky"
                href="/entertainment"
              >
                <ArrowLeft
                  aria-hidden="true"
                  className="viread-rtl-flip size-4"
                />
                {tGames("sentenceShooter.backToEntertainment")}
              </Link>
            </div>
          </div>
        )}
      </section>
    );
  }

  if (!currentLine) return null;

  const isBeatStep = lineStep === "CLAP_BEATS";
  const isLineCleared = lineStep === "LINE_CLEARED";
  const isLastLine = lineIndex + 1 >= chant.lines.length;

  return (
    <section
      className={cn(
        "mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-4 py-4 sm:px-6 sm:py-5",
        reducedMotion && "motion-reduce",
      )}
      data-calm-sound={calmSound ? "true" : "false"}
      data-mic-mode={micMode}
      data-pulse-running={isPulseRunning ? "true" : "false"}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-testid="magic-rhythm-chant-panel"
    >
      <BookChildHeader
        backHref="/entertainment"
        child={child}
        mobileLabel={t("karaoke.playerScreen.childStageLabel")}
      />

      {expiredReloadBanner ? (
        <p
          className="rounded-control border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-950"
          data-testid="magic-chant-expired-banner"
          role="status"
        >
          {t("karaoke.magicChant.expiredNotice")}
        </p>
      ) : null}

      {micFallbackBanner ? (
        <p
          className="rounded-control border border-sky-300 bg-sky/70 px-4 py-2.5 text-sm font-semibold text-ink"
          data-testid="magic-chant-mic-fallback-banner"
          role="status"
        >
          {t("karaoke.magicChant.micDeniedFallbackNotice")}
        </p>
      ) : null}

      <header className="flex flex-col gap-2.5 rounded-card border border-rose-200 bg-white px-4 py-3.5 shadow-2xs lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="viread-learning-content inline-flex items-center gap-1 rounded-full bg-rose-100 px-3 py-0.5 text-xs font-extrabold text-rose-950"
              dir="ltr"
              lang="vi"
            >
              {chant.ephemeral_badge_vi}
            </span>
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-extrabold text-amber-950">
              🥁 {chant.bpm} BPM
            </span>
            <span className="text-sm font-bold text-muted">
              {t("karaoke.magicChant.lineBadge", {
                current: lineIndex + 1,
                total: chant.lines.length,
              })}
            </span>
          </div>
          <h1
            className="viread-learning-content mt-1 text-lg font-extrabold text-ink sm:text-xl"
            dir="ltr"
            lang="vi"
          >
            {chant.title_vi}
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
            data-testid="magic-chant-nomic-toggle"
            onClick={() => {
              clearTimers();
              recorderRef.current.cancel({ retainStream: false });
              setMicMode((prev) =>
                prev === "VOICE" ? "NO_MIC_FALLBACK" : "VOICE",
              );
              if (lineStep === "LISTENING") {
                setLineStep("READY_TO_SPEAK");
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
              ? t("karaoke.magicChant.toggleNoMicOn")
              : t("karaoke.magicChant.toggleNoMicOff")}
          </button>

          {onToggleCalmSound ? (
            <button
              aria-label={
                calmSound
                  ? tGames("sentenceShooter.muteSoundAria")
                  : tGames("sentenceShooter.enableSoundAria")
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
            data-testid="magic-chant-exit-btn"
            onClick={handleExit}
            type="button"
          >
            {tGames("sentenceShooter.exit")}
          </button>
        </div>
      </header>

      {/* Chant Line & 80 BPM Beat Stage */}
      <div className="flex flex-col gap-4 rounded-card border border-rose-200 bg-gradient-to-b from-rose-50/60 via-white to-cream/60 p-5 shadow-xs sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-extrabold text-primary">
            {isBeatStep
              ? t("karaoke.magicChant.step1ClapPrompt", {
                  beats: currentLine.beat_count,
                })
              : micMode === "NO_MIC_FALLBACK"
                ? t("karaoke.magicChant.step2NoMicPrompt")
                : t("karaoke.magicChant.step2SpeakPrompt", {
                    word: currentLine.target_word,
                  })}
          </p>
          <Button
            className="w-auto!"
            data-testid="magic-chant-listen-line-btn"
            disabled={lineStep === "LISTENING" || lineStep === "EVALUATING"}
            onClick={handleListenModelChant}
            size="compact"
            type="button"
            variant="secondary"
          >
            <Volume2 aria-hidden="true" className="size-4" />
            {t("karaoke.magicChant.listenLineBtn")}
          </Button>
        </div>

        <div
          className="viread-learning-content flex flex-col items-center gap-3 rounded-2xl border border-rose-200 bg-white px-5 py-6 text-center"
          data-testid="magic-chant-line-display"
          dir="ltr"
          lang="vi"
        >
          <p className="text-2xl leading-relaxed font-extrabold text-ink sm:text-3xl">
            {currentLine.line_text}
          </p>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border-2 border-amber-300 bg-amber-50 px-4 py-1 text-base font-extrabold text-amber-950"
            data-testid="magic-chant-target-pill"
          >
            ⭐ {currentLine.target_word}
          </span>
        </div>

        {/* 4-Beat Visual Indicator */}
        <div
          className="flex items-center justify-center gap-3"
          data-testid="magic-chant-beat-dots"
        >
          {Array.from({ length: currentLine.beat_count }, (_, idx) => {
            const tapped = idx < lineBeatTaps;
            const pulsing = activeBeatPulse === idx;
            return (
              <span
                className={cn(
                  "grid size-11 place-items-center rounded-full border-2 text-sm font-extrabold transition-all",
                  tapped
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : pulsing
                      ? "scale-105 border-rose-500 bg-rose-100 text-rose-950"
                      : "border-border bg-white text-muted",
                )}
                key={idx}
              >
                {idx + 1}
              </span>
            );
          })}
        </div>

        {/* Step 1: Tactile 80 BPM Beat Pad */}
        {isBeatStep ? (
          <div className="flex flex-col items-center gap-2 pt-1">
            <Button
              className="min-h-14 w-full max-w-md text-base"
              data-testid="magic-chant-beat-pad"
              onClick={handleBeatTap}
              type="button"
            >
              <Drum aria-hidden="true" className="size-5" />
              {t("karaoke.magicChant.clapBeatBtn", {
                current: Math.min(lineBeatTaps + 1, currentLine.beat_count),
                total: currentLine.beat_count,
              })}
            </Button>
            <p
              className="viread-learning-content text-xs font-semibold text-muted"
              dir="ltr"
              lang="vi"
            >
              {currentLine.clap_hint_vi}
            </p>
          </div>
        ) : null}

        {/* Step 2: Speak Target Word / No-Mic Fallback */}
        {!isBeatStep && !isLineCleared ? (
          <div
            className="flex flex-col items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 p-4"
            data-testid="magic-chant-voice-stage"
          >
            <div className="flex flex-wrap items-center justify-center gap-3">
              {micMode === "NO_MIC_FALLBACK" ? (
                <Button
                  className="min-h-13 w-auto! px-6"
                  data-testid="magic-chant-finish-nomic-btn"
                  onClick={() => void handleNoMicCompleteLine()}
                  type="button"
                >
                  {t("karaoke.magicChant.finishNoMicBtn")}
                </Button>
              ) : lineStep === "LISTENING" ? (
                <Button
                  className="min-h-13 w-auto! px-6"
                  data-testid="magic-chant-stop-speak-btn"
                  onClick={() => void stopAndEvaluateRecording()}
                  type="button"
                >
                  <Square aria-hidden="true" className="size-4" />
                  {t("karaoke.magicChant.stopListeningBtn")}
                </Button>
              ) : (
                <Button
                  className="min-h-13 w-auto! px-6"
                  data-testid="magic-chant-speak-btn"
                  disabled={lineStep === "EVALUATING"}
                  isLoading={lineStep === "EVALUATING"}
                  onClick={() => void startVoiceCapture()}
                  type="button"
                >
                  <Mic aria-hidden="true" className="size-5" />
                  {t("karaoke.magicChant.speakWordBtn", {
                    word: currentLine.target_word,
                  })}
                </Button>
              )}

              <Button
                className="min-h-12 w-auto!"
                data-testid="magic-chant-listen-slow-btn"
                disabled={lineStep === "LISTENING" || lineStep === "EVALUATING"}
                onClick={() =>
                  void playEphemeralSpeech(currentLine.target_word, {
                    wordSample: true,
                    speedScale: 0.88,
                  })
                }
                size="compact"
                type="button"
                variant="secondary"
              >
                <Volume2 aria-hidden="true" className="size-4" />
                {t("karaoke.magicChant.listenWordSlowBtn")}
              </Button>

              {strikeCount >= 3 && micMode === "VOICE" ? (
                <Button
                  className="min-h-13 w-auto! border-amber-400 bg-amber-400 px-5 text-ink hover:bg-amber-300"
                  data-testid="magic-chant-owl-rescue-btn"
                  onClick={handleOwlRescue}
                  type="button"
                  variant="secondary"
                >
                  {t("karaoke.magicChant.owlRescueBtn")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Strike 2 Phonics Scaffold */}
        {currentPhonicsLesson && !isLineCleared ? (
          <PhonicsLessonCard
            activeStepIndex={activePhonicsStep}
            childGrade={chant.child_grade}
            childId={child.id}
            compact
            contextSentence={currentLine.line_text}
            glossarySpeechPlayer={speechPlayer}
            isListeningRetry={lineStep === "LISTENING"}
            isPlayingPhonics={isPlayingPhonics}
            lesson={currentPhonicsLesson}
            onPlayPhonics={() => void playCurrentPhonics(currentPhonicsLesson)}
            onPlayWord={() =>
              void playEphemeralSpeech(currentLine.target_word, {
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

        {/* Line Cleared Bar */}
        {isLineCleared ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3.5"
            data-testid="magic-chant-line-cleared"
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
              data-testid="magic-chant-next-line-btn"
              onClick={() => advanceToNextLineOrFinale()}
              size="compact"
              type="button"
            >
              {isLastLine
                ? t("karaoke.magicChant.openFinaleBtn")
                : t("karaoke.magicChant.nextLineBtn")}
              <ArrowRight
                aria-hidden="true"
                className="viread-rtl-flip size-4"
              />
            </Button>
          </div>
        ) : null}

        <p
          aria-live="polite"
          className="viread-learning-content min-h-8 text-center text-sm font-bold text-primary"
          data-testid="magic-chant-status"
          dir="ltr"
          lang="vi"
          role="status"
        >
          {statusMessage || currentLine.clap_hint_vi}
        </p>
      </div>
    </section>
  );
}
