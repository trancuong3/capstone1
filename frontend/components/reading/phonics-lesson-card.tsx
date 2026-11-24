"use client";

import { Mic, RotateCcw, Sparkles, Square, Volume2, X } from "lucide-react";

import { Button } from "@/components/common/button";
import type { PhonicsLessonPlan } from "@/lib/reading/phonics-lesson";
import { cn } from "@/lib/utils/cn";

export interface PhonicsLessonCardProps {
  readonly lesson: PhonicsLessonPlan;
  readonly activeStepIndex: number | null;
  readonly isPlayingPhonics?: boolean;
  readonly isPlayingWord?: boolean;
  readonly isListeningRetry?: boolean;
  readonly statusHint?: string | null;
  readonly compact?: boolean;
  readonly onPlayWord?: () => void;
  readonly onPlayPhonics?: () => void;
  readonly onStopAudio?: () => void;
  readonly onStartRetry?: () => void;
  readonly onClose?: () => void;
}

export function PhonicsLessonCard({
  lesson,
  activeStepIndex,
  isPlayingPhonics = false,
  isPlayingWord = false,
  isListeningRetry = false,
  statusHint = null,
  compact = false,
  onPlayWord,
  onPlayPhonics,
  onStopAudio,
  onStartRetry,
  onClose,
}: PhonicsLessonCardProps) {
  if (!lesson.supported) {
    return (
      <section
        aria-label="Hướng dẫn đánh vần"
        className={cn(
          "rounded-2xl border-2 border-amber-200 bg-amber-50/80 p-4",
          compact && "p-3",
        )}
        data-testid="phonics-lesson-unsupported"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-amber-950">{lesson.message}</p>
            <p className="text-xs text-amber-900/80">
              Từ “{lesson.cleanPhrase || lesson.rawText}” chưa có quy tắc đánh
              vần lớp 1 chuẩn. Bé vẫn có thể nghe đọc mẫu cả từ nhé.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {lesson.canPlayWholeWord && onPlayWord ? (
              <Button
                className="w-auto!"
                disabled={isPlayingWord || isListeningRetry}
                onClick={onPlayWord}
                size="compact"
                variant="secondary"
              >
                <Volume2 aria-hidden="true" className="size-4" />
                Nghe từ
              </Button>
            ) : null}
            {onClose ? (
              <button
                type="button"
                aria-label="Đóng hướng dẫn đánh vần"
                onClick={onClose}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-amber-300 bg-white px-2.5 text-xs font-semibold text-amber-950 hover:bg-amber-100 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <X aria-hidden="true" className="size-4" />
                <span className="sr-only">Đóng</span>
              </button>
            ) : null}
          </div>
        </div>
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

  return (
    <section
      aria-label={`Đánh vần từng bước tiếng ${lesson.focusSyllable}`}
      className={cn(
        "rounded-2xl border-2 border-primary/25 bg-gradient-to-br from-sky/70 via-white to-emerald-50/50 p-4 shadow-sm",
        compact && "p-3",
      )}
      data-testid="phonics-lesson-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2.5 py-1 text-xs font-bold text-primary">
            <Sparkles aria-hidden="true" className="size-3.5" />
            Đánh vần từng bước
          </span>
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-950">
            {lesson.tone.label}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onPlayWord ? (
            <Button
              className="w-auto!"
              disabled={isPlayingPhonics || isListeningRetry}
              onClick={isPlayingWord && onStopAudio ? onStopAudio : onPlayWord}
              size="compact"
              variant="secondary"
            >
              <Volume2 aria-hidden="true" className="size-4" />
              Nghe từ
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
                  Dừng đánh vần
                </>
              ) : (
                <>
                  <Volume2 aria-hidden="true" className="size-4" />
                  Nghe đánh vần
                </>
              )}
            </Button>
          ) : null}

          {onStartRetry ? (
            <Button
              className="w-auto!"
              disabled={isPlayingPhonics || isPlayingWord || isListeningRetry}
              onClick={onStartRetry}
              size="compact"
              variant="secondary"
            >
              {isListeningRetry ? (
                <>
                  <Mic aria-hidden="true" className="size-4 animate-pulse" />
                  Đang nghe bé…
                </>
              ) : (
                <>
                  <RotateCcw aria-hidden="true" className="size-4" />
                  Đọc lại
                </>
              )}
            </Button>
          ) : null}

          {onClose ? (
            <button
              type="button"
              aria-label="Đóng hướng dẫn đánh vần"
              onClick={onClose}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border bg-white px-2.5 text-xs font-semibold text-ink hover:bg-canvas focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <X aria-hidden="true" className="size-4" />
              <span className="sr-only">Đóng</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Synchronized character-slice highlight of the focus syllable / phrase */}
      <div
        aria-live="polite"
        className="mt-3 flex flex-wrap items-baseline justify-center gap-1 rounded-xl border border-border bg-white px-4 py-3 text-center"
        data-testid="phonics-focus-display"
      >
        {prefixText ? (
          <span
            className={cn(
              "text-2xl font-bold transition-colors sm:text-3xl",
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
            "inline-flex items-baseline rounded-lg px-1.5 py-0.5 text-3xl font-extrabold tracking-wide transition-all sm:text-4xl",
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
              "text-2xl font-bold transition-colors sm:text-3xl",
              highlightKind === "context"
                ? "rounded bg-emerald-100 px-1 text-emerald-950"
                : "text-muted/60",
            )}
          >
            {suffixText}
          </span>
        ) : null}
      </div>

      {/* Ordered phonics steps */}
      <ol
        aria-label="Các bước đánh vần"
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
      >
        {lesson.steps.map((step, idx) => {
          const isCurrent = activeStepIndex === idx;
          const isDone = activeStepIndex !== null && activeStepIndex > idx;
          return (
            <li
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-xl border-2 px-3 py-2 text-sm font-bold transition-all",
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
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-extrabold",
                  isCurrent
                    ? "bg-white text-primary"
                    : isDone
                      ? "bg-emerald-600 text-white"
                      : "bg-cream text-ink",
                )}
              >
                {idx + 1}
              </span>
              <span className="truncate">{step.displayText}</span>
            </li>
          );
        })}
      </ol>

      {statusHint ? (
        <p
          aria-live="polite"
          className="mt-2.5 text-center text-sm font-semibold text-primary"
        >
          {statusHint}
        </p>
      ) : null}
    </section>
  );
}
