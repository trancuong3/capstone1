"use client";

import {
  BookHeart,
  BookmarkCheck,
  BookmarkPlus,
  BookOpenText,
  Mic,
  RotateCcw,
  Sparkles,
  Square,
  Volume2,
  X,
} from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { VocabularyNotebookDrawer } from "@/components/reading/vocabulary-notebook-drawer";
import { useTranslations } from "@/hooks/use-i18n";
import type { SpeechPlayer } from "@/hooks/use-speech-player";
import { createSpeechService } from "@/lib/api/speech-service";
import {
  buildLocalPreviewExplanation,
  createVocabularyNotebookService,
  type VocabularyNotebookService,
  type WordExplainDTO,
} from "@/lib/api/vocabulary-notebook-service";
import { createVoiceStudioService } from "@/lib/api/voice-studio-service";
import type { PhonicsLessonPlan } from "@/lib/reading/phonics-lesson";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import { cn } from "@/lib/utils/cn";
import { useWordGlossaryTranslations } from "@/messages/features/word_glossary";

type LessonTab = "PHONICS" | "MEANING";

export interface PhonicsLessonCardProps {
  readonly lesson: PhonicsLessonPlan;
  readonly activeStepIndex: number | null;
  readonly isAnalyzingAi?: boolean;
  readonly isPlayingPhonics?: boolean;
  readonly isPlayingWord?: boolean;
  readonly isListeningRetry?: boolean;
  readonly statusHint?: string | null;
  readonly compact?: boolean;
  /** True right after phonics playback completes and the card is about to auto-hide. */
  readonly isAutoHiding?: boolean;
  /** Duration of the gentle auto-hide countdown bar in ms. */
  readonly autoHideDurationMs?: number;
  /** Called when the child actively interacts (e.g., opens Meaning tab or notebook) so auto-hide pauses. */
  readonly onUserInteract?: () => void;
  readonly onPlayWord?: () => void;
  readonly onPlayPhonics?: () => void;
  readonly onStopAudio?: () => void;
  readonly onStartRetry?: () => void;
  readonly onClose?: () => void;
  // Optional Feature #6 Contextual Kids Glossary + Sổ Từ Hay props
  readonly childId?: string | null;
  readonly childGrade?: number | null;
  readonly contextSentence?: string | null;
  readonly bookId?: string | null;
  readonly pageId?: string | null;
  readonly glossaryService?: VocabularyNotebookService;
  readonly glossarySpeechPlayer?: Pick<
    SpeechPlayer,
    "play" | "stop" | "isPlaying"
  >;
}

export function PhonicsLessonCard({
  lesson,
  activeStepIndex,
  isAnalyzingAi = false,
  isPlayingPhonics = false,
  isPlayingWord = false,
  isListeningRetry = false,
  statusHint = null,
  compact = false,
  isAutoHiding = false,
  autoHideDurationMs = 1400,
  onUserInteract,
  onPlayWord,
  onPlayPhonics,
  onStopAudio,
  onStartRetry,
  onClose,
  childId,
  childGrade,
  contextSentence = null,
  bookId = null,
  pageId = null,
  glossaryService,
  glossarySpeechPlayer,
}: PhonicsLessonCardProps) {
  const t = useTranslations("reading");
  const tGlossary = useWordGlossaryTranslations();
  const appStore = useContext(AppStoreContext);

  const effectiveChildId =
    childId ??
    appStore?.selectedChildId ??
    appStore?.validatedSelectedChild?.id ??
    null;
  const effectiveChildGrade =
    childGrade ?? appStore?.validatedSelectedChild?.grade ?? null;
  const effectiveChildAlias = appStore?.validatedSelectedChild?.alias ?? null;

  const resolvedGlossaryService = useMemo(
    () => glossaryService ?? createVocabularyNotebookService(),
    [glossaryService],
  );
  const lazyPlayerRef = useRef<TtsPlayback | null>(null);

  const [activeTab, setActiveTab] = useState<LessonTab>("PHONICS");
  const [explanationState, setExplanationState] = useState<{
    readonly key: string;
    readonly data: WordExplainDTO | null;
    readonly error: boolean;
  } | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [isSavingWord, setIsSavingWord] = useState(false);
  const [savedOverrideKey, setSavedOverrideKey] = useState<string | null>(null);
  const [isPlayingMeaning, setIsPlayingMeaning] = useState(false);
  const [notebookDrawerOpen, setNotebookDrawerOpen] = useState(false);

  const targetWord = (
    lesson.cleanPhrase ||
    (lesson.supported ? lesson.focusSyllable : "") ||
    lesson.rawText ||
    ""
  ).trim();
  const requestKey = `${effectiveChildId ?? "preview"}:${effectiveChildGrade ?? "auto"}:${targetWord.toLowerCase()}:${contextSentence ?? ""}:${reloadNonce}`;

  const stopMeaningAudio = () => {
    setIsPlayingMeaning(false);
    if (glossarySpeechPlayer) {
      glossarySpeechPlayer.stop();
    } else {
      lazyPlayerRef.current?.stop();
    }
  };

  useEffect(() => {
    return () => {
      lazyPlayerRef.current?.dispose();
      lazyPlayerRef.current = null;
    };
  }, []);

  const localPreviewExplanation = useMemo(
    () =>
      !effectiveChildId && targetWord
        ? buildLocalPreviewExplanation(targetWord, effectiveChildGrade)
        : null,
    [effectiveChildGrade, effectiveChildId, targetWord],
  );

  useEffect(() => {
    if (activeTab !== "MEANING" || !targetWord || !effectiveChildId) return;
    if (explanationState?.key === requestKey && !explanationState.error) {
      return;
    }

    const controller = new AbortController();
    void resolvedGlossaryService
      .explainWord(
        effectiveChildId,
        {
          word: targetWord,
          context_sentence: contextSentence,
          grade_override: effectiveChildGrade,
        },
        controller.signal,
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        setExplanationState({
          key: requestKey,
          data: result,
          error: false,
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setExplanationState({
          key: requestKey,
          data: null,
          error: true,
        });
      });

    return () => controller.abort();
  }, [
    activeTab,
    contextSentence,
    effectiveChildGrade,
    effectiveChildId,
    explanationState?.error,
    explanationState?.key,
    requestKey,
    resolvedGlossaryService,
    targetWord,
  ]);

  if (!lesson.supported) {
    return (
      <section
        aria-label={t("phonics.regionAria")}
        className={cn(
          "relative overflow-hidden rounded-2xl border-2 border-amber-200 bg-amber-50/90 p-4",
          compact && "border p-2.5 shadow-sm",
        )}
        data-phonics-auto-hiding={isAutoHiding ? "true" : undefined}
        data-testid="phonics-lesson-unsupported"
      >
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-amber-950">
              {isAnalyzingAi
                ? "AI đang phân tích cách đánh vần..."
                : lesson.message}
            </p>
            <p className="text-xs text-amber-900/80">
              {isAnalyzingAi
                ? `Đang tách vần và dấu cho từ “${lesson.cleanPhrase || lesson.rawText}”...`
                : isAutoHiding
                  ? t("phonics.autoHideHint")
                  : t("phonics.unsupportedNotice", {
                      word: lesson.cleanPhrase || lesson.rawText,
                    })}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {lesson.canPlayWholeWord && onPlayWord ? (
              <Button
                className="w-auto!"
                disabled={isPlayingWord || isListeningRetry}
                onClick={() => {
                  onUserInteract?.();
                  onPlayWord();
                }}
                size="compact"
                variant="secondary"
              >
                <Volume2 aria-hidden="true" className="size-4" />
                {t("phonics.listenWord")}
              </Button>
            ) : null}
            {onClose ? (
              <button
                type="button"
                aria-label={t("phonics.closeAria")}
                onClick={onClose}
                className={cn(
                  "inline-flex shrink-0 items-center justify-center rounded-control border border-amber-300 bg-white px-2 text-xs font-semibold text-amber-950 hover:bg-amber-100 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  compact ? "min-h-9 min-w-9" : "min-h-11 min-w-11 px-2.5",
                )}
              >
                <X aria-hidden="true" className="size-4" />
                <span className="sr-only">{t("phonics.closeSr")}</span>
              </button>
            ) : null}
          </div>
        </div>
        {isAutoHiding ? (
          <div
            aria-hidden="true"
            className="mt-2 h-1 w-full overflow-hidden rounded-full bg-amber-200/70"
            data-testid="phonics-auto-hide-bar"
          >
            <div
              className="phonics-auto-hide-progress h-full origin-left bg-amber-500"
              style={{ animationDuration: `${autoHideDurationMs}ms` }}
            />
          </div>
        ) : null}
      </section>
    );
  }

  const activeStep =
    activeStepIndex !== null &&
    activeStepIndex >= 0 &&
    activeStepIndex < lesson.steps.length
      ? lesson.steps[activeStepIndex]
      : null;

  const isMultiSyllable = lesson.syllables.length > 1;
  const focusStart = lesson.focusRangeInPhrase.start;
  const focusEnd = lesson.focusRangeInPhrase.end;
  const prefixText = isMultiSyllable
    ? lesson.cleanPhrase.slice(0, focusStart)
    : "";
  const suffixText = isMultiSyllable ? lesson.cleanPhrase.slice(focusEnd) : "";

  const onsetWrittenLen = lesson.rhyme.written
    ? Math.max(0, lesson.focusSyllable.length - lesson.rhyme.written.length)
    : 0;
  const onsetSlice = lesson.focusSyllable.slice(0, onsetWrittenLen);
  const rhymeSlice = lesson.focusSyllable.slice(onsetWrittenLen);

  const highlightKind = activeStep?.highlightPart ?? null;

  const currentExplanation = !effectiveChildId
    ? localPreviewExplanation
    : explanationState?.key === requestKey
      ? explanationState.data
      : null;
  const isLoadingExplanation =
    activeTab === "MEANING" &&
    Boolean(effectiveChildId) &&
    explanationState?.key !== requestKey;
  const hasExplanationError =
    activeTab === "MEANING" &&
    Boolean(effectiveChildId) &&
    explanationState?.key === requestKey &&
    explanationState.error;
  const savedKeyForWord = `${effectiveChildId ?? ""}:${targetWord.toLowerCase()}`;
  const isWordSaved =
    Boolean(currentExplanation?.is_saved_in_notebook) ||
    savedOverrideKey === savedKeyForWord;

  const handleListenExplanation = async () => {
    if (!currentExplanation) return;
    if (isPlayingMeaning) {
      stopMeaningAudio();
      return;
    }
    onStopAudio?.();
    stopMeaningAudio();
    setIsPlayingMeaning(true);
    try {
      if (glossarySpeechPlayer) {
        await glossarySpeechPlayer.play(currentExplanation.spoken_tts_text, {
          coaching: true,
          bypassSessionLock: true,
        });
      } else {
        if (!lazyPlayerRef.current) {
          lazyPlayerRef.current = new TtsPlayback(
            createSpeechService(),
            createVoiceStudioService(),
          );
        }
        await lazyPlayerRef.current.play(currentExplanation.spoken_tts_text, {
          coaching: true,
          bypassSessionLock: true,
        });
      }
    } catch {
      // Calm silent recovery when audio output is unavailable.
    } finally {
      setIsPlayingMeaning(false);
    }
  };

  const handleSaveToNotebook = async () => {
    if (!effectiveChildId || !targetWord || isSavingWord || isWordSaved) return;
    setIsSavingWord(true);
    try {
      const saved = await resolvedGlossaryService.saveWord(effectiveChildId, {
        word: currentExplanation?.word || targetWord,
        definition_vi: currentExplanation?.definition_vi ?? null,
        example_sentence_vi: currentExplanation?.example_sentence_vi ?? null,
        nuance_note_vi: currentExplanation?.nuance_note_vi ?? null,
        grade_band: currentExplanation?.grade_band ?? null,
        source_book_id: bookId,
        source_page_id: pageId,
      });
      setSavedOverrideKey(savedKeyForWord);
      if (currentExplanation) {
        setExplanationState({
          key: requestKey,
          data: {
            ...currentExplanation,
            is_saved_in_notebook: true,
            notebook_item_id: saved.id,
          },
          error: false,
        });
      }
    } catch {
      // Preserve current state so child can tap again cleanly.
    } finally {
      setIsSavingWord(false);
    }
  };

  return (
    <section
      aria-label={t("phonics.titleAria", { syllable: lesson.focusSyllable })}
      className={cn(
        "relative overflow-hidden rounded-2xl border-2 border-primary/25 bg-gradient-to-br from-sky/70 via-white to-emerald-50/50 p-4 shadow-sm transition-opacity duration-200",
        compact &&
          "border border-primary/30 bg-white/98 p-2.5 shadow-md sm:p-3",
      )}
      data-phonics-auto-hiding={isAutoHiding ? "true" : undefined}
      data-testid="phonics-lesson-card"
    >
      <div className={cn(compact ? "space-y-1.5" : "space-y-2")}>
        <div className="flex flex-wrap items-center justify-between gap-1.5 sm:gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-bold text-primary">
              <Sparkles aria-hidden="true" className="size-3.5" />
              {t("phonics.title")}
            </span>
            <span
              className="viread-learning-content rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-950"
              dir="ltr"
              lang="vi"
            >
              {lesson.tone.label}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div
              aria-label={tGlossary("tabsAria")}
              className="inline-flex rounded-xl border border-border bg-white/95 p-0.5"
              role="tablist"
            >
              <button
                aria-selected={activeTab === "PHONICS"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-extrabold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
                  compact ? "min-h-8" : "min-h-9 gap-1.5 px-3",
                  activeTab === "PHONICS"
                    ? "bg-primary text-white shadow-2xs"
                    : "text-ink hover:bg-sky/50",
                )}
                data-testid="phonics-tab-spelling"
                onClick={() => {
                  stopMeaningAudio();
                  setActiveTab("PHONICS");
                }}
                role="tab"
                type="button"
              >
                <Sparkles aria-hidden="true" className="size-3.5" />
                {tGlossary("tabPhonics")}
              </button>
              <button
                aria-selected={activeTab === "MEANING"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-extrabold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
                  compact ? "min-h-8" : "min-h-9 gap-1.5 px-3",
                  activeTab === "MEANING"
                    ? "bg-primary text-white shadow-2xs"
                    : "text-ink hover:bg-sky/50",
                )}
                data-testid="phonics-tab-meaning"
                onClick={() => {
                  onUserInteract?.();
                  onStopAudio?.();
                  setActiveTab("MEANING");
                }}
                role="tab"
                type="button"
              >
                <BookOpenText aria-hidden="true" className="size-3.5" />
                {tGlossary("tabMeaning")}
              </button>
            </div>

            {compact && activeTab === "PHONICS" ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {onPlayWord ? (
                  <Button
                    className="min-h-8! w-auto! px-2.5! py-1! text-xs!"
                    disabled={isPlayingPhonics || isListeningRetry}
                    onClick={() => {
                      onUserInteract?.();
                      if (isPlayingWord && onStopAudio) onStopAudio();
                      else onPlayWord();
                    }}
                    size="compact"
                    variant="secondary"
                  >
                    <Volume2 aria-hidden="true" className="size-3.5" />
                    {t("phonics.listenWord")}
                  </Button>
                ) : null}

                {onPlayPhonics ? (
                  <Button
                    className="min-h-8! w-auto! px-2.5! py-1! text-xs!"
                    disabled={isPlayingWord || isListeningRetry}
                    onClick={() => {
                      if (isPlayingPhonics && onStopAudio) onStopAudio();
                      else onPlayPhonics();
                    }}
                    size="compact"
                    variant="primary"
                  >
                    {isPlayingPhonics ? (
                      <>
                        <Square aria-hidden="true" className="size-3.5" />
                        {t("phonics.stopPhonics")}
                      </>
                    ) : (
                      <>
                        <Volume2 aria-hidden="true" className="size-3.5" />
                        {t("phonics.listenPhonics")}
                      </>
                    )}
                  </Button>
                ) : null}

                {onStartRetry ? (
                  <Button
                    className="min-h-8! w-auto! px-2.5! py-1! text-xs!"
                    disabled={
                      isPlayingPhonics || isPlayingWord || isListeningRetry
                    }
                    onClick={() => {
                      onUserInteract?.();
                      onStartRetry();
                    }}
                    size="compact"
                    variant="secondary"
                  >
                    {isListeningRetry ? (
                      <>
                        <Mic
                          aria-hidden="true"
                          className="size-3.5 animate-pulse"
                        />
                        {t("phonics.listeningRetry")}
                      </>
                    ) : (
                      <>
                        <RotateCcw aria-hidden="true" className="size-3.5" />
                        {t("phonics.readAgain")}
                      </>
                    )}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {onClose ? (
              <button
                type="button"
                aria-label={t("phonics.closeAria")}
                onClick={() => {
                  stopMeaningAudio();
                  onClose();
                }}
                className={cn(
                  "inline-flex shrink-0 items-center justify-center rounded-control border border-border bg-white text-xs font-semibold text-ink hover:bg-canvas focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  compact ? "min-h-9 min-w-9 px-2" : "min-h-11 min-w-11 px-2.5",
                )}
              >
                <X aria-hidden="true" className="size-4" />
                <span className="sr-only">{t("phonics.closeSr")}</span>
              </button>
            ) : null}
          </div>
        </div>

        {!compact && activeTab === "PHONICS" ? (
          <div className="flex flex-wrap items-center gap-2">
            {onPlayWord ? (
              <Button
                className="w-auto!"
                disabled={isPlayingPhonics || isListeningRetry}
                onClick={() => {
                  onUserInteract?.();
                  if (isPlayingWord && onStopAudio) onStopAudio();
                  else onPlayWord();
                }}
                size="compact"
                variant="secondary"
              >
                <Volume2 aria-hidden="true" className="size-4" />
                {t("phonics.listenWord")}
              </Button>
            ) : null}

            {onPlayPhonics ? (
              <Button
                className="w-auto!"
                disabled={isPlayingWord || isListeningRetry}
                onClick={
                  isPlayingPhonics && onStopAudio ? onStopAudio : onPlayPhonics
                }
                size="compact"
                variant="primary"
              >
                {isPlayingPhonics ? (
                  <>
                    <Square aria-hidden="true" className="size-4" />
                    {t("phonics.stopPhonics")}
                  </>
                ) : (
                  <>
                    <Volume2 aria-hidden="true" className="size-4" />
                    {t("phonics.listenPhonics")}
                  </>
                )}
              </Button>
            ) : null}

            {onStartRetry ? (
              <Button
                className="w-auto!"
                disabled={isPlayingPhonics || isPlayingWord || isListeningRetry}
                onClick={() => {
                  onUserInteract?.();
                  onStartRetry();
                }}
                size="compact"
                variant="secondary"
              >
                {isListeningRetry ? (
                  <>
                    <Mic aria-hidden="true" className="size-4 animate-pulse" />
                    {t("phonics.listeningRetry")}
                  </>
                ) : (
                  <>
                    <RotateCcw aria-hidden="true" className="size-4" />
                    {t("phonics.readAgain")}
                  </>
                )}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Synchronized character-slice highlight of the focus syllable / phrase */}
      <div
        aria-live="polite"
        className={cn(
          "viread-learning-content flex flex-wrap items-baseline justify-center gap-1 rounded-xl border border-border bg-white text-center",
          compact ? "mt-2 px-3 py-1.5" : "mt-3 px-4 py-3",
        )}
        data-testid="phonics-focus-display"
        dir="ltr"
        lang="vi"
      >
        {prefixText ? (
          <span
            className={cn(
              "font-bold transition-colors",
              compact ? "text-xl sm:text-2xl" : "text-2xl sm:text-3xl",
              highlightKind === "context"
                ? "rounded bg-emerald-100 px-1 text-emerald-950"
                : "text-muted/60",
            )}
          >
            {prefixText}
          </span>
        ) : null}

        <span
          className={cn(
            "inline-flex items-baseline rounded-lg px-1.5 py-0.5 font-extrabold tracking-wide transition-all",
            compact ? "text-2xl sm:text-3xl" : "text-3xl sm:text-4xl",
            (highlightKind === "whole_syllable" ||
              highlightKind === "tone_and_syllable" ||
              highlightKind === "context") &&
              "bg-emerald-100 text-emerald-950 ring-2 ring-emerald-400",
          )}
          data-testid="phonics-focus-syllable"
        >
          {onsetSlice ? (
            <span
              className={cn(
                "transition-colors",
                highlightKind === "onset_and_rhyme"
                  ? "rounded bg-sky-200 px-0.5 text-sky-950 underline decoration-sky-600 decoration-4"
                  : highlightKind === "rhyme"
                    ? "text-ink/45"
                    : "text-ink",
              )}
            >
              {onsetSlice}
            </span>
          ) : null}
          <span
            className={cn(
              "transition-colors",
              highlightKind === "rhyme"
                ? "rounded bg-amber-200 px-1 text-amber-950 underline decoration-amber-600 decoration-4"
                : highlightKind === "onset_and_rhyme"
                  ? "rounded bg-amber-100 px-0.5 text-amber-950 underline decoration-amber-500 decoration-4"
                  : "text-ink",
            )}
          >
            {rhymeSlice}
          </span>
        </span>

        {suffixText ? (
          <span
            className={cn(
              "font-bold transition-colors",
              compact ? "text-xl sm:text-2xl" : "text-2xl sm:text-3xl",
              highlightKind === "context"
                ? "rounded bg-emerald-100 px-1 text-emerald-950"
                : "text-muted/60",
            )}
          >
            {suffixText}
          </span>
        ) : null}
      </div>

      {activeTab === "PHONICS" ? (
        <>
          {/* Ordered phonics steps */}
          <ol
            aria-label={t("phonics.stepsAria")}
            className={cn(
              "grid",
              compact
                ? "mt-2 grid-cols-2 gap-1.5 sm:grid-cols-4"
                : "mt-3 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4",
            )}
          >
            {lesson.steps.map((step, idx) => {
              const isCurrent = activeStepIndex === idx;
              const isDone = activeStepIndex !== null && activeStepIndex > idx;
              return (
                <li
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "flex items-center rounded-xl border-2 font-bold transition-all",
                    compact
                      ? "gap-1.5 px-2.5 py-1.5 text-xs sm:text-sm"
                      : "gap-2 px-3 py-2 text-sm",
                    isCurrent
                      ? "scale-[1.02] border-primary bg-primary text-white shadow-sm"
                      : isDone
                        ? "border-emerald-300 bg-emerald-50 text-emerald-950"
                        : "border-border bg-white text-ink",
                  )}
                  data-step-kind={step.kind}
                  key={step.id}
                >
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center justify-center rounded-full text-xs font-extrabold",
                      compact ? "size-5" : "size-6",
                      isCurrent
                        ? "bg-white text-primary"
                        : isDone
                          ? "bg-emerald-600 text-white"
                          : "bg-cream text-ink",
                    )}
                  >
                    {idx + 1}
                  </span>
                  <span
                    className="viread-learning-content truncate"
                    dir="ltr"
                    lang="vi"
                  >
                    {step.displayText}
                  </span>
                </li>
              );
            })}
          </ol>

          {isAutoHiding ? (
            <div className="mt-2 space-y-1">
              <p
                aria-live="polite"
                className="text-center text-xs font-semibold text-primary"
              >
                {t("phonics.autoHideHint")}
              </p>
              <div
                aria-hidden="true"
                className="h-1 w-full overflow-hidden rounded-full bg-primary/15"
                data-testid="phonics-auto-hide-bar"
              >
                <div
                  className="phonics-auto-hide-progress h-full origin-left bg-primary"
                  style={{ animationDuration: `${autoHideDurationMs}ms` }}
                />
              </div>
            </div>
          ) : statusHint ? (
            <p
              aria-live="polite"
              className={cn(
                "text-center font-semibold text-primary",
                compact ? "mt-1.5 text-xs sm:text-sm" : "mt-2.5 text-sm",
              )}
            >
              {statusHint}
            </p>
          ) : null}
        </>
      ) : (
        <div
          className={cn(
            "rounded-xl border border-border bg-white",
            compact ? "mt-2 space-y-2 p-3" : "mt-3 space-y-3 p-4",
          )}
          data-testid="phonics-meaning-panel"
          role="tabpanel"
        >
          {isLoadingExplanation ? (
            <p
              className="py-3 text-center text-sm font-semibold text-muted"
              data-testid="glossary-loading"
            >
              {tGlossary("loadingMeaning")}
            </p>
          ) : hasExplanationError ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 p-3">
              <p className="text-sm font-semibold text-amber-950">
                {tGlossary("explainError")}
              </p>
              <Button
                className="w-auto!"
                data-testid="glossary-retry-btn"
                onClick={() => setReloadNonce((n) => n + 1)}
                size="compact"
                type="button"
                variant="secondary"
              >
                {tGlossary("retryExplain")}
              </Button>
            </div>
          ) : currentExplanation ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold text-primary"
                    data-testid="glossary-grade-badge"
                  >
                    {currentExplanation.grade_band === "GRADE_3_5"
                      ? tGlossary("grade35Badge")
                      : tGlossary("grade12Badge")}
                  </span>
                  {currentExplanation.part_of_speech_vi ? (
                    <span
                      className="viread-learning-content rounded-full border border-border bg-cream px-2.5 py-0.5 text-xs font-semibold text-muted"
                      dir="ltr"
                      lang="vi"
                    >
                      {currentExplanation.part_of_speech_vi}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-extrabold tracking-wide text-primary uppercase">
                  {tGlossary("definitionLabel")}
                </p>
                <p
                  className="viread-learning-content text-base font-bold text-ink"
                  data-testid="glossary-definition-text"
                  dir="ltr"
                  lang="vi"
                >
                  {currentExplanation.definition_vi}
                </p>
              </div>

              {currentExplanation.nuance_note_vi ? (
                <div
                  className="rounded-xl border border-sky-200 bg-sky/35 px-3 py-2"
                  data-testid="glossary-nuance-box"
                >
                  <p className="text-xs font-extrabold text-primary">
                    💡 {tGlossary("nuanceLabel")}
                  </p>
                  <p
                    className="viread-learning-content mt-0.5 text-xs font-semibold text-ink"
                    data-testid="glossary-nuance-text"
                    dir="ltr"
                    lang="vi"
                  >
                    {currentExplanation.nuance_note_vi}
                  </p>
                </div>
              ) : null}

              <div className="rounded-xl border border-amber-200 bg-amber-50/75 px-3.5 py-2.5">
                <p className="text-xs font-extrabold text-amber-900">
                  {tGlossary("exampleLabel")}
                </p>
                <p
                  className="viread-learning-content mt-0.5 text-sm font-bold text-amber-950"
                  data-testid="glossary-example-text"
                  dir="ltr"
                  lang="vi"
                >
                  “{currentExplanation.example_sentence_vi}”
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  className="min-h-11 w-auto!"
                  data-testid="glossary-listen-tts-btn"
                  disabled={isListeningRetry}
                  onClick={() => void handleListenExplanation()}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  {isPlayingMeaning ? (
                    <>
                      <Square aria-hidden="true" className="size-4" />
                      {tGlossary("stopListeningExplanation")}
                    </>
                  ) : (
                    <>
                      <Volume2 aria-hidden="true" className="size-4" />
                      {tGlossary("listenExplanation")}
                    </>
                  )}
                </Button>

                {effectiveChildId ? (
                  <>
                    <Button
                      aria-pressed={isWordSaved}
                      className={cn(
                        "min-h-11 w-auto!",
                        isWordSaved &&
                          "border-emerald-400 bg-emerald-50 text-emerald-950 hover:bg-emerald-100",
                      )}
                      data-testid="glossary-save-notebook-btn"
                      disabled={isSavingWord || isWordSaved}
                      onClick={() => void handleSaveToNotebook()}
                      size="compact"
                      type="button"
                      variant={isWordSaved ? "secondary" : "primary"}
                    >
                      {isWordSaved ? (
                        <>
                          <BookmarkCheck
                            aria-hidden="true"
                            className="size-4 text-emerald-700"
                          />
                          {tGlossary("savedInNotebook")}
                        </>
                      ) : (
                        <>
                          <BookmarkPlus aria-hidden="true" className="size-4" />
                          {isSavingWord
                            ? tGlossary("savingToNotebook")
                            : tGlossary("saveToNotebook")}
                        </>
                      )}
                    </Button>

                    <Button
                      className="min-h-11 w-auto!"
                      data-testid="glossary-open-notebook-btn"
                      onClick={() => {
                        onUserInteract?.();
                        setNotebookDrawerOpen(true);
                      }}
                      size="compact"
                      type="button"
                      variant="quiet"
                    >
                      <BookHeart aria-hidden="true" className="size-4" />
                      {tGlossary("openNotebookDrawer")}
                    </Button>
                  </>
                ) : (
                  <p
                    className="text-xs font-semibold text-muted"
                    data-testid="glossary-select-child-hint"
                  >
                    {tGlossary("selectChildHint")}
                  </p>
                )}
              </div>
            </>
          ) : null}
        </div>
      )}

      {effectiveChildId ? (
        <VocabularyNotebookDrawer
          childAlias={effectiveChildAlias}
          childId={effectiveChildId}
          onClose={() => setNotebookDrawerOpen(false)}
          onNotebookChange={(updated) => {
            const stillSaved = updated.items.some(
              (entry) =>
                entry.normalized_word ===
                (currentExplanation?.normalized_word ||
                  targetWord.toLowerCase()),
            );
            if (!stillSaved) {
              setSavedOverrideKey(null);
              if (currentExplanation) {
                setExplanationState({
                  key: requestKey,
                  data: {
                    ...currentExplanation,
                    is_saved_in_notebook: false,
                    notebook_item_id: null,
                  },
                  error: false,
                });
              }
            }
          }}
          open={notebookDrawerOpen}
          service={resolvedGlossaryService}
          speechPlayer={glossarySpeechPlayer}
        />
      ) : null}
    </section>
  );
}
