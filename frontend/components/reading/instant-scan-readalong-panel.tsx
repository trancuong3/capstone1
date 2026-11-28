"use client";

import {
  Mic,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { PhonicsLessonCard } from "@/components/reading/phonics-lesson-card";
import { useI18n } from "@/hooks/use-i18n";
import { useSpeechPlayer, type SpeechPlayer } from "@/hooks/use-speech-player";
import {
  useSpeechRecorder,
  type SpeechRecorder,
} from "@/hooks/use-speech-recorder";
import {
  createSpeechService,
  type SpeechService,
} from "@/lib/api/speech-service";
import {
  buildPhonicsLesson,
  type PhonicsLessonPlan,
  type SupportedPhonicsLessonPlan,
} from "@/lib/reading/phonics-lesson";
import {
  RealtimeAlignmentEngine,
  type RealtimeAlignmentSnapshot,
} from "@/lib/reading/realtime-alignment";
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
import { normalizeVietnameseWord } from "@/lib/reading/vietnamese-text";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type { ReadingPageWordDTO } from "@/types/reading";

export interface ScannedReadAlongWord extends ReadingPageWordDTO {
  readonly line_index: number;
}

interface LiveSpeechRecognitionResultAlternative {
  readonly transcript?: string;
  readonly confidence?: number;
}

interface LiveSpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<{
    readonly isFinal: boolean;
    readonly 0?: LiveSpeechRecognitionResultAlternative;
  }>;
}

interface LiveSpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  onresult: ((event: LiveSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort?(): void;
}

type LiveSpeechRecognitionConstructor = new () => LiveSpeechRecognitionLike;

interface WindowWithSpeechRecognition {
  SpeechRecognition?: LiveSpeechRecognitionConstructor;
  webkitSpeechRecognition?: LiveSpeechRecognitionConstructor;
}

export function tokenizeScannedTextToWords(
  rawText: string,
): ScannedReadAlongWord[] {
  const normalized = (rawText ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const words: ScannedReadAlongWord[] = [];
  let wordIndex = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const tokens = lines[lineIdx]?.trim().split(/\s+/u) ?? [];
    for (const token of tokens) {
      if (!token || !normalizeVietnameseWord(token)) continue;
      words.push({
        word_id: `scan-word-${wordIndex}`,
        word_index: wordIndex,
        line_index: lineIdx,
        text: token,
        bbox: [0.05, 0.05, 0.1, 0.05],
      });
      wordIndex += 1;
    }
  }

  return words;
}

export interface InstantScanReadAlongPanelProps {
  readonly ocrText: string;
  readonly isTextEdited?: boolean;
  readonly onChangeOcrText?: (nextText: string) => void;
  readonly onResetOcrText?: () => void;
  readonly child?: ChildProfileDTO | null;
  readonly speechPlayerOverride?: SpeechPlayer;
  readonly speechRecorderOverride?: SpeechRecorder;
  readonly speechServiceOverride?: SpeechService;
  readonly onClose?: () => void;
}

export function InstantScanReadAlongPanel({
  ocrText,
  isTextEdited = false,
  onChangeOcrText,
  onResetOcrText,
  child = null,
  speechPlayerOverride,
  speechRecorderOverride,
  speechServiceOverride,
  onClose,
}: InstantScanReadAlongPanelProps) {
  const { t, formatNumber } = useI18n();
  const defaultPlayer = useSpeechPlayer();
  const defaultRecorder = useSpeechRecorder();
  const defaultSpeechService = useMemo(() => createSpeechService(), []);

  const speechPlayer = speechPlayerOverride ?? defaultPlayer;
  const speechRecorder = speechRecorderOverride ?? defaultRecorder;
  const speechService = speechServiceOverride ?? defaultSpeechService;

  const [isQuickEditing, setIsQuickEditing] = useState(false);
  const [ttsWordIndex, setTtsWordIndex] = useState<number | null>(null);
  const [ttsMode, setTtsMode] = useState<
    "idle" | "passage" | "word" | "phonics"
  >("idle");
  const [ttsError, setTtsError] = useState<string | null>(null);

  const [selectedWordIndex, setSelectedWordIndex] = useState<number | null>(
    null,
  );
  const [phonicsStepIndex, setPhonicsStepIndex] = useState<number | null>(null);
  const [aiPhonicsOverride, setAiPhonicsOverride] = useState<{
    readonly wordKey: string;
    readonly lesson: SupportedPhonicsLessonPlan;
  } | null>(null);
  const [analyzingPhonicsKey, setAnalyzingPhonicsKey] = useState<string | null>(
    null,
  );

  const [isTranscribing, setIsTranscribing] = useState(false);
  const [micNotice, setMicNotice] = useState<{
    readonly tone: "error" | "info";
    readonly message: string;
  } | null>(null);

  const words = useMemo(() => tokenizeScannedTextToWords(ocrText), [ocrText]);
  const wordsKey = useMemo(
    () => words.map((w) => `${w.line_index}:${w.text}`).join("\u0001"),
    [words],
  );
  const emptyAlignmentSnapshot = useMemo(
    () => new RealtimeAlignmentEngine(words).getSnapshot(),
    [words],
  );
  const linesOfWords = useMemo(() => {
    const grouped = new Map<number, ScannedReadAlongWord[]>();
    for (const word of words) {
      const existing = grouped.get(word.line_index);
      if (existing) {
        existing.push(word);
      } else {
        grouped.set(word.line_index, [word]);
      }
    }
    return Array.from(grouped.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, lineWords]) => lineWords);
  }, [words]);

  const engineRef = useRef<RealtimeAlignmentEngine | null>(null);
  const [alignmentState, setAlignmentState] = useState<{
    readonly wordsKey: string;
    readonly snapshot: RealtimeAlignmentSnapshot;
  } | null>(null);
  const alignmentSnapshot =
    alignmentState && alignmentState.wordsKey === wordsKey
      ? alignmentState.snapshot
      : emptyAlignmentSnapshot;
  const commitAlignmentSnapshot = useCallback(
    (snapshot: RealtimeAlignmentSnapshot) => {
      setAlignmentState({ wordsKey, snapshot });
    },
    [wordsKey],
  );
  const liveRecognitionRef = useRef<LiveSpeechRecognitionLike | null>(null);
  const hadLiveFinalSegmentRef = useRef(false);

  // Respect the child's configured AI teacher voice preference
  useEffect(() => {
    if (child) {
      hydrateTeacherVoiceFromChildProfile(child);
    }
  }, [child]);

  // Keep imperative alignment engine synchronized with current words
  useEffect(() => {
    engineRef.current = new RealtimeAlignmentEngine(words);
  }, [words]);

  const getEngine = useCallback((): RealtimeAlignmentEngine => {
    if (!engineRef.current) {
      engineRef.current = new RealtimeAlignmentEngine(words);
    }
    return engineRef.current;
  }, [words]);

  const stopLiveRecognition = useCallback(() => {
    const rec = liveRecognitionRef.current;
    liveRecognitionRef.current = null;
    if (!rec) return;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.stop();
    } catch {
      try {
        rec.abort?.();
      } catch {
        // Ignore cleanup errors
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      stopLiveRecognition();
    };
  }, [stopLiveRecognition]);

  const effectiveSelectedWordIndex =
    selectedWordIndex !== null && selectedWordIndex < words.length
      ? selectedWordIndex
      : null;
  const selectedWord =
    effectiveSelectedWordIndex !== null
      ? (words[effectiveSelectedWordIndex] ?? null)
      : null;

  const basePhonicsLesson = useMemo<PhonicsLessonPlan | null>(() => {
    if (!selectedWord) return null;
    return buildPhonicsLesson(selectedWord.text);
  }, [selectedWord]);

  const selectedWordContextLine = useMemo(() => {
    if (!selectedWord) return null;
    const lineWords = linesOfWords.find(
      (lw) => lw[0]?.line_index === selectedWord.line_index,
    );
    return lineWords ? lineWords.map((w) => w.text).join(" ") : null;
  }, [linesOfWords, selectedWord]);

  const selectedWordKey = selectedWord
    ? `${selectedWord.word_id}:${selectedWord.text}`
    : null;
  const isAnalyzingPhonicsAi =
    selectedWordKey !== null && analyzingPhonicsKey === selectedWordKey;

  // Optional AI phonics fallback if deterministic Grade-1 rules mark word unsupported
  useEffect(() => {
    if (
      !selectedWord ||
      !selectedWordKey ||
      !basePhonicsLesson ||
      basePhonicsLesson.supported ||
      !speechService.analyzePhonics
    ) {
      return;
    }
    if (aiPhonicsOverride?.wordKey === selectedWordKey) {
      return;
    }
    let active = true;
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => {
        if (active) setAnalyzingPhonicsKey(selectedWordKey);
        return speechService.analyzePhonics!(selectedWord.text, {
          contextPhrase: selectedWordContextLine,
          signal: controller.signal,
        });
      })
      .then((aiPlan) => {
        if (!active || !aiPlan) return;
        setAiPhonicsOverride({ wordKey: selectedWordKey, lesson: aiPlan });
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          setAnalyzingPhonicsKey((cur) =>
            cur === selectedWordKey ? null : cur,
          );
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    aiPhonicsOverride?.wordKey,
    basePhonicsLesson,
    selectedWord,
    selectedWordContextLine,
    selectedWordKey,
    speechService,
  ]);

  const activePhonicsLesson: PhonicsLessonPlan | null = useMemo(() => {
    if (!selectedWord || !basePhonicsLesson) return null;
    if (basePhonicsLesson.supported) return basePhonicsLesson;
    const wordKey = `${selectedWord.word_id}:${selectedWord.text}`;
    if (aiPhonicsOverride?.wordKey === wordKey) {
      return aiPhonicsOverride.lesson;
    }
    return basePhonicsLesson;
  }, [aiPhonicsOverride, basePhonicsLesson, selectedWord]);

  const PHONICS_AUTO_HIDE_DELAY_MS = 1800;
  const [isPhonicsAutoHiding, setIsPhonicsAutoHiding] = useState(false);
  const phonicsAutoHideTimerRef = useRef<number | null>(null);
  const selectedWordIndexRef = useRef(selectedWordIndex);
  useEffect(() => {
    selectedWordIndexRef.current = selectedWordIndex;
  }, [selectedWordIndex]);

  const clearPhonicsAutoHideTimer = useCallback(() => {
    if (phonicsAutoHideTimerRef.current !== null) {
      window.clearTimeout(phonicsAutoHideTimerRef.current);
      phonicsAutoHideTimerRef.current = null;
    }
    setIsPhonicsAutoHiding(false);
  }, []);

  useEffect(() => {
    return () => {
      if (phonicsAutoHideTimerRef.current !== null) {
        window.clearTimeout(phonicsAutoHideTimerRef.current);
        phonicsAutoHideTimerRef.current = null;
      }
    };
  }, []);

  const handleStopAudio = useCallback(() => {
    clearPhonicsAutoHideTimer();
    speechPlayer.stop();
    setTtsWordIndex(null);
    setPhonicsStepIndex(null);
    setTtsMode("idle");
  }, [clearPhonicsAutoHideTimer, speechPlayer]);

  const handlePlayPassage = useCallback(async () => {
    const cleanPassage = ocrText.normalize("NFC").trim();
    if (!cleanPassage || words.length === 0) return;

    if (speechRecorder.isRecording) {
      stopLiveRecognition();
      speechRecorder.cancel();
    }
    setTtsError(null);
    setMicNotice(null);
    setPhonicsStepIndex(null);
    setTtsMode("passage");

    try {
      const wordStrings = words.map((w) => w.text);
      await speechPlayer.playWithWordTimings(
        wordStrings,
        {
          text: cleanPassage,
          isPrivateBook: true,
          cacheScope: "PRIVATE",
          bypassSessionLock: true,
          onWordChange: (index) => {
            setTtsWordIndex(index >= 0 && index < words.length ? index : null);
          },
          onEnded: () => {
            setTtsWordIndex(null);
            setTtsMode("idle");
          },
        },
        () =>
          speechPlayer.play(cleanPassage, {
            isPrivateBook: true,
            cacheScope: "PRIVATE",
            bypassSessionLock: true,
            onEnded: () => {
              setTtsWordIndex(null);
              setTtsMode("idle");
            },
          }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setTtsWordIndex(null);
      setTtsMode("idle");
      setTtsError(t("scanInstant.panel.ttsError"));
    }
  }, [ocrText, speechPlayer, speechRecorder, stopLiveRecognition, t, words]);

  const handleSelectWord = useCallback(
    (index: number) => {
      clearPhonicsAutoHideTimer();
      if (ttsMode === "passage" && speechPlayer.isPlaying) {
        speechPlayer.stop();
        setTtsWordIndex(null);
      }
      setTtsError(null);
      setPhonicsStepIndex(null);
      setTtsMode("idle");
      setSelectedWordIndex(index);
    },
    [clearPhonicsAutoHideTimer, speechPlayer, ttsMode],
  );

  const handlePlaySelectedWord = useCallback(async () => {
    if (!selectedWord) return;
    if (speechRecorder.isRecording) {
      stopLiveRecognition();
      speechRecorder.cancel();
    }
    setTtsError(null);
    setPhonicsStepIndex(null);
    setTtsMode("word");
    try {
      await speechPlayer.play(selectedWord.text, {
        wordSample: true,
        isPrivateBook: true,
        cacheScope: "PRIVATE",
        bypassSessionLock: true,
        onEnded: () => setTtsMode("idle"),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setTtsMode("idle");
      setTtsError(t("scanInstant.panel.ttsError"));
    }
  }, [selectedWord, speechPlayer, speechRecorder, stopLiveRecognition, t]);

  const handlePlaySelectedPhonics = useCallback(async () => {
    if (!activePhonicsLesson || !activePhonicsLesson.supported) return;
    const expectedIndex = selectedWordIndex;
    clearPhonicsAutoHideTimer();
    if (speechRecorder.isRecording) {
      stopLiveRecognition();
      speechRecorder.cancel();
    }
    setTtsError(null);
    setPhonicsStepIndex(0);
    setTtsMode("phonics");
    try {
      await speechPlayer.playPhonicsLesson(activePhonicsLesson, {
        isPrivateBook: true,
        cacheScope: "PRIVATE",
        bypassSessionLock: true,
        onStepChange: (stepIndex) => setPhonicsStepIndex(stepIndex),
        onEnded: () => {
          setPhonicsStepIndex(null);
          setTtsMode("idle");
        },
      });
      setPhonicsStepIndex(null);
      setTtsMode("idle");
      if (selectedWordIndexRef.current === expectedIndex) {
        setIsPhonicsAutoHiding(true);
        phonicsAutoHideTimerRef.current = window.setTimeout(() => {
          phonicsAutoHideTimerRef.current = null;
          setIsPhonicsAutoHiding(false);
          if (selectedWordIndexRef.current === expectedIndex) {
            setSelectedWordIndex(null);
          }
        }, PHONICS_AUTO_HIDE_DELAY_MS);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setPhonicsStepIndex(null);
      setTtsMode("idle");
      setTtsError(t("scanInstant.panel.ttsError"));
    }
  }, [
    activePhonicsLesson,
    clearPhonicsAutoHideTimer,
    selectedWordIndex,
    speechPlayer,
    speechRecorder,
    stopLiveRecognition,
    t,
  ]);

  const handleResetAlignment = useCallback(() => {
    const resetSnap = getEngine().reset();
    commitAlignmentSnapshot(resetSnap);
    setMicNotice(null);
  }, [commitAlignmentSnapshot, getEngine]);

  const handleStartMic = useCallback(async () => {
    if (words.length === 0 || isTranscribing) return;
    handleStopAudio();
    setIsQuickEditing(false);
    setMicNotice(null);
    hadLiveFinalSegmentRef.current = false;

    const engine = getEngine();
    // If all words were already finished in a previous turn, reset automatically
    if (
      alignmentSnapshot.statusByWordId.size >= words.length &&
      alignmentSnapshot.currentWordId === null
    ) {
      const resetSnap = engine.reset();
      commitAlignmentSnapshot(resetSnap);
    }

    try {
      await speechRecorder.start();
    } catch (err) {
      const msg =
        err instanceof Error &&
        (err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError" ||
          err.message.toLowerCase().includes("permission") ||
          err.message.toLowerCase().includes("denied"))
          ? t("scanInstant.panel.micPermissionError")
          : t("scanInstant.panel.sttError");
      setMicNotice({ tone: "error", message: msg });
      return;
    }

    // Attach real-time browser/local SpeechRecognition when available alongside MediaRecorder
    if (typeof window !== "undefined") {
      const win = window as unknown as WindowWithSpeechRecognition;
      const RecCtor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
      if (RecCtor) {
        try {
          const rec = new RecCtor();
          rec.lang = "vi-VN";
          rec.continuous = true;
          rec.interimResults = true;
          rec.onresult = (event) => {
            let interim = "";
            for (let i = event.resultIndex; i < event.results.length; i += 1) {
              const item = event.results[i];
              const text = item?.[0]?.transcript?.trim() ?? "";
              if (!text) continue;
              if (item.isFinal) {
                hadLiveFinalSegmentRef.current = true;
                const snap = getEngine().addFinalTranscript(
                  text,
                  `live-seg-${i}-${text}`,
                );
                commitAlignmentSnapshot(snap);
              } else {
                interim = interim ? `${interim} ${text}` : text;
              }
            }
            if (interim) {
              commitAlignmentSnapshot(getEngine().previewAlignment(interim));
            }
          };
          rec.onerror = () => undefined;
          const track = speechRecorder.getStream()?.getAudioTracks?.()[0];
          rec.start(track);
          liveRecognitionRef.current = rec;
        } catch {
          // Safe fallback to turn-based STT when live SpeechRecognition cannot start
          liveRecognitionRef.current = null;
        }
      }
    }
  }, [
    alignmentSnapshot.currentWordId,
    alignmentSnapshot.statusByWordId.size,
    commitAlignmentSnapshot,
    getEngine,
    handleStopAudio,
    isTranscribing,
    speechRecorder,
    t,
    words.length,
  ]);

  const handleStopMic = useCallback(async () => {
    stopLiveRecognition();
    let recordedBlob: Blob | null = null;
    try {
      recordedBlob = await speechRecorder.stop();
    } catch {
      setMicNotice({
        tone: "error",
        message: t("scanInstant.panel.sttError"),
      });
      return;
    }

    const engine = getEngine();
    if (hadLiveFinalSegmentRef.current) {
      commitAlignmentSnapshot(engine.getSnapshot());
      return;
    }

    if (!recordedBlob || recordedBlob.size === 0) {
      setMicNotice({
        tone: "info",
        message: t("scanInstant.panel.sttEmptyNotice"),
      });
      return;
    }

    setIsTranscribing(true);
    try {
      const keyterms = Array.from(
        new Set(words.map((w) => w.text.normalize("NFC").trim())),
      ).slice(0, 120);
      const transcript = await speechService.transcribe(recordedBlob, {
        languageCode: "vi",
        keyterms,
        source: "instant_scan_readalong",
      });
      const cleanTranscript = (transcript.text ?? "").normalize("NFC").trim();
      if (!cleanTranscript) {
        setMicNotice({
          tone: "info",
          message: t("scanInstant.panel.sttEmptyNotice"),
        });
        return;
      }
      engine.addFinalTranscript(cleanTranscript, `turn-${Date.now()}`);
      const settled = engine.finish();
      commitAlignmentSnapshot(settled);
    } catch {
      setMicNotice({
        tone: "error",
        message: t("scanInstant.panel.sttError"),
      });
    } finally {
      setIsTranscribing(false);
    }
  }, [
    commitAlignmentSnapshot,
    getEngine,
    speechRecorder,
    speechService,
    stopLiveRecognition,
    t,
    words,
  ]);

  const matchedCount = useMemo(() => {
    let count = 0;
    for (const word of words) {
      const state = alignmentSnapshot.statusByWordId.get(word.word_id);
      if (
        state?.status === "MATCH" ||
        state?.status === "REPEATED" ||
        alignmentSnapshot.previewMatchedWordIds.has(word.word_id)
      ) {
        count += 1;
      }
    }
    return count;
  }, [alignmentSnapshot, words]);

  const hasAlignmentActivity =
    alignmentSnapshot.statusByWordId.size > 0 ||
    alignmentSnapshot.previewMatchedWordIds.size > 0;
  const accuracyPct =
    words.length > 0 ? Math.round((matchedCount / words.length) * 100) : 0;

  const isPassagePlaying = ttsMode === "passage" && speechPlayer.isPlaying;
  const isPassagePaused = ttsMode === "passage" && speechPlayer.isPaused;

  return (
    <section
      aria-label={t("scanInstant.panel.regionAria")}
      className="flex flex-col gap-4 rounded-2xl border-2 border-primary/25 bg-gradient-to-br from-sky/50 via-white to-cream/60 p-4 shadow-sm sm:p-5"
      data-testid="instant-scan-readalong-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1 text-xs font-extrabold text-primary">
              <Sparkles aria-hidden="true" className="size-3.5" />
              {t("scanInstant.panel.badge")}
            </span>
            {isTextEdited ? (
              <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-950">
                {t("scanInstant.editedBadge")}
              </span>
            ) : null}
          </div>
          <h3 className="mt-2 text-lg font-extrabold text-ink">
            {t("scanInstant.panel.heading")}
          </h3>
          <p className="mt-0.5 text-sm text-muted">
            {t("scanInstant.panel.wordTapHint")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onChangeOcrText ? (
            <Button
              className="min-h-11 w-auto!"
              data-testid="instant-readalong-quick-edit-btn"
              onClick={() => {
                handleStopAudio();
                if (speechRecorder.isRecording) {
                  stopLiveRecognition();
                  speechRecorder.cancel();
                }
                setIsQuickEditing((prev) => !prev);
              }}
              size="compact"
              variant="secondary"
            >
              <Pencil aria-hidden="true" className="size-4" />
              {isQuickEditing
                ? t("scanInstant.quickEditDone")
                : t("scanInstant.quickEditToggle")}
            </Button>
          ) : null}
          {onClose ? (
            <button
              aria-label={t("scanInstant.panel.closePanel")}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border bg-white px-2.5 text-xs font-semibold text-ink hover:bg-canvas focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              onClick={() => {
                handleStopAudio();
                if (speechRecorder.isRecording) {
                  stopLiveRecognition();
                  speechRecorder.cancel();
                }
                onClose();
              }}
              type="button"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Primary AI model reading + Child microphone Read-Along controls */}
      <div className="flex flex-wrap items-center gap-2.5">
        {!isPassagePlaying ? (
          <Button
            className="min-h-12 w-full sm:w-auto"
            data-testid="instant-scan-listen-ai-btn"
            disabled={words.length === 0 || isTranscribing}
            onClick={() => void handlePlayPassage()}
            variant="secondary"
          >
            <Volume2 aria-hidden="true" className="size-5" />
            {t("scanInstant.panel.listenPassage")}
          </Button>
        ) : (
          <>
            <Button
              className="min-h-12 w-full sm:w-auto"
              onClick={() =>
                isPassagePaused
                  ? void speechPlayer.resume()
                  : speechPlayer.pause()
              }
              variant="secondary"
            >
              {isPassagePaused ? (
                <>
                  <Play aria-hidden="true" className="size-5" />
                  {t("scanInstant.panel.resumePassage")}
                </>
              ) : (
                <>
                  <Pause aria-hidden="true" className="size-5" />
                  {t("scanInstant.panel.pausePassage")}
                </>
              )}
            </Button>
            <Button
              className="min-h-12 w-full sm:w-auto"
              onClick={handleStopAudio}
              variant="secondary"
            >
              <Square aria-hidden="true" className="size-4" />
              {t("scanInstant.panel.stopPassage")}
            </Button>
          </>
        )}

        {!speechRecorder.isRecording ? (
          <Button
            className="min-h-12 w-full sm:w-auto"
            data-testid="instant-scan-mic-start-btn"
            disabled={words.length === 0 || isTranscribing}
            onClick={() => void handleStartMic()}
            variant="primary"
          >
            <Mic aria-hidden="true" className="size-5" />
            {isTranscribing
              ? t("scanInstant.panel.transcribing")
              : t("scanInstant.panel.startMic")}
          </Button>
        ) : (
          <Button
            className="min-h-12 w-full bg-rose-600 text-white hover:bg-rose-700 sm:w-auto"
            data-testid="instant-scan-mic-stop-btn"
            onClick={() => void handleStopMic()}
          >
            <Square aria-hidden="true" className="size-4" />
            {t("scanInstant.panel.stopMic")}
          </Button>
        )}

        {hasAlignmentActivity && !speechRecorder.isRecording ? (
          <Button
            className="min-h-12 w-full sm:w-auto"
            data-testid="instant-scan-reset-alignment-btn"
            onClick={handleResetAlignment}
            variant="secondary"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            {t("scanInstant.panel.resetAlignment")}
          </Button>
        ) : null}
      </div>

      {speechRecorder.isRecording ? (
        <p
          aria-live="polite"
          className="flex items-center gap-2 rounded-xl border border-primary/30 bg-sky/70 px-3.5 py-2.5 text-sm font-semibold text-primary"
          data-testid="instant-scan-live-listening"
        >
          <Mic aria-hidden="true" className="size-4 shrink-0 animate-pulse" />
          {t("scanInstant.panel.liveListeningHint")}
        </p>
      ) : null}

      {isQuickEditing && onChangeOcrText ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-white p-3.5">
          <label
            className="text-xs font-bold text-ink"
            htmlFor="instant-readalong-ocr-editor"
          >
            {t("scanInstant.quickEditLabel")}
          </label>
          <textarea
            className="viread-learning-content min-h-28 w-full rounded-xl border border-border bg-cream/60 p-3 text-base leading-relaxed text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            data-testid="instant-readalong-ocr-textarea"
            dir="ltr"
            id="instant-readalong-ocr-editor"
            lang="vi"
            onChange={(e) => onChangeOcrText(e.target.value)}
            placeholder={t("scanInstant.quickEditPlaceholder")}
            value={ocrText}
          />
          {isTextEdited && onResetOcrText ? (
            <div className="flex justify-end">
              <button
                className="text-xs font-semibold text-primary underline hover:text-primary-hover"
                onClick={onResetOcrText}
                type="button"
              >
                {t("scanInstant.quickEditReset")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Interactive word-by-word surface */}
      <div
        className="viread-learning-content flex flex-col gap-3 rounded-2xl border border-border bg-white p-4 sm:p-5"
        data-testid="instant-scan-words-surface"
        dir="ltr"
        lang="vi"
      >
        {linesOfWords.map((lineWords, lineIdx) => (
          <div
            className="flex flex-wrap items-baseline gap-2 leading-relaxed"
            key={`scan-line-${lineIdx}`}
          >
            {lineWords.map((word) => {
              const wordState = alignmentSnapshot.statusByWordId.get(
                word.word_id,
              );
              const isPreviewMatch =
                alignmentSnapshot.previewMatchedWordIds.has(word.word_id);
              const isMatched = wordState?.status === "MATCH" || isPreviewMatch;
              const isRepeated = wordState?.status === "REPEATED";
              const isNeedsPractice =
                wordState?.status === "SUBSTITUTE" ||
                wordState?.status === "DELETE";
              const isCurrentCursor =
                speechRecorder.isRecording &&
                alignmentSnapshot.currentWordId === word.word_id;
              const isTtsActive = ttsWordIndex === word.word_index;
              const isSelectedForPhonics =
                effectiveSelectedWordIndex === word.word_index;

              const visualStatus = isTtsActive
                ? "tts-active"
                : isMatched
                  ? "matched"
                  : isRepeated
                    ? "repeated"
                    : isNeedsPractice
                      ? "needs-practice"
                      : isCurrentCursor
                        ? "current"
                        : "idle";

              return (
                <button
                  aria-pressed={isSelectedForPhonics}
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-xl border px-2.5 py-1.5 text-lg font-bold transition-all focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:text-xl",
                    isTtsActive
                      ? "scale-[1.03] border-primary bg-primary text-white shadow-sm"
                      : isMatched
                        ? "border-emerald-300 bg-emerald-100 text-emerald-950"
                        : isRepeated
                          ? "border-teal-300 bg-teal-100 text-teal-950"
                          : isNeedsPractice
                            ? "border-amber-400 bg-amber-100 text-amber-950 underline decoration-amber-600 decoration-2"
                            : isCurrentCursor
                              ? "border-primary bg-sky text-primary ring-2 ring-primary/30"
                              : "border-transparent bg-cream/65 text-ink hover:border-primary/40 hover:bg-sky/50",
                    isSelectedForPhonics &&
                      !isTtsActive &&
                      "ring-2 ring-primary",
                  )}
                  data-testid={`instant-scan-word-${word.word_index}`}
                  data-word-status={visualStatus}
                  key={word.word_id}
                  onClick={() => handleSelectWord(word.word_index)}
                  type="button"
                >
                  {word.text}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Alignment feedback summary */}
      {hasAlignmentActivity ? (
        <div
          aria-live="polite"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/75 px-4 py-3 text-sm"
          data-testid="instant-scan-alignment-summary"
        >
          <span className="font-extrabold text-emerald-950">
            {t("scanInstant.panel.summaryProgress", {
              matched: formatNumber(matchedCount),
              total: formatNumber(words.length),
              accuracy: formatNumber(accuracyPct),
            })}
          </span>
          <span className="text-emerald-900">
            {accuracyPct >= 80
              ? t("scanInstant.panel.summaryGreat")
              : t("scanInstant.panel.summaryKeepGoing")}
          </span>
        </div>
      ) : null}

      {ttsError ? (
        <StatusMessage title="" tone="error">
          {ttsError}
        </StatusMessage>
      ) : null}

      {micNotice ? (
        <StatusMessage
          title=""
          tone={micNotice.tone === "error" ? "error" : "info"}
        >
          {micNotice.message}
        </StatusMessage>
      ) : null}

      {/* Vietnamese Grade-1 Phonics breakdown card when any word is tapped */}
      {activePhonicsLesson ? (
        <PhonicsLessonCard
          activeStepIndex={phonicsStepIndex}
          autoHideDurationMs={PHONICS_AUTO_HIDE_DELAY_MS}
          compact
          isAnalyzingAi={isAnalyzingPhonicsAi}
          isAutoHiding={isPhonicsAutoHiding}
          isPlayingPhonics={ttsMode === "phonics" && speechPlayer.isPlaying}
          isPlayingWord={ttsMode === "word" && speechPlayer.isPlaying}
          lesson={activePhonicsLesson}
          onClose={() => {
            clearPhonicsAutoHideTimer();
            if (ttsMode === "word" || ttsMode === "phonics") {
              handleStopAudio();
            }
            setSelectedWordIndex(null);
          }}
          onPlayPhonics={() => void handlePlaySelectedPhonics()}
          onPlayWord={() => void handlePlaySelectedWord()}
          onStopAudio={handleStopAudio}
          onUserInteract={clearPhonicsAutoHideTimer}
        />
      ) : null}
    </section>
  );
}
