"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Mic, Volume2 } from "lucide-react";

import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { createSpeechService } from "@/lib/api/speech-service";
import {
  alignReadingSegment,
  DEFAULT_WORD_CONFIDENCE_THRESHOLD,
  type PronunciationReviewGroup,
  type ReadingSourceWord,
} from "@/lib/utils/reading-pronunciation-alignment";

interface ReadingPronunciationReviewProps {
  readonly groups: readonly PronunciationReviewGroup[];
  readonly onComplete: () => void;
}

const MAX_ATTEMPTS = 2;

export function ReadingPronunciationReview({
  groups,
  onComplete,
}: ReadingPronunciationReviewProps) {
  const recorder = useSpeechRecorder();
  const player = useSpeechPlayer();
  const speechService = useMemo(() => createSpeechService(), []);
  const [groupIndex, setGroupIndex] = useState(0);
  const [wordIndex, setWordIndex] = useState(0);
  const [phase, setPhase] = useState<"word" | "sentence">("word");
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [canContinue, setCanContinue] = useState(false);
  const [feedback, setFeedback] = useState(
    "Con đọc từ này một lần nữa nhé.",
  );

  const group = groups[groupIndex] ?? null;
  const currentWord = group?.words[wordIndex] ?? null;
  const targetText =
    phase === "word" ? currentWord?.expected_word ?? "" : group?.sentence_text ?? "";

  const targetWords = useMemo<ReadingSourceWord[]>(
    () =>
      targetText
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map((text, index) => ({
          word_id: `review-${phase}-${groupIndex}-${wordIndex}-${index}`,
          word_index: index,
          text,
        })),
    [groupIndex, phase, targetText, wordIndex],
  );

  if (!groups.length || !group) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col items-center justify-center gap-5 p-6 text-center">
        <CheckCircle2 aria-hidden="true" className="size-14 text-emerald-600" />
        <h1 className="text-2xl font-extrabold text-ink">Con đã hoàn thành!</h1>
        <button
          type="button"
          onClick={onComplete}
          className="rounded-control bg-primary px-6 py-3 font-bold text-white"
        >
          Xem kết quả buổi đọc
        </button>
      </main>
    );
  }

  function advance() {
    setAttempts(0);
    setCanContinue(false);
    if (phase === "word") {
      if (wordIndex + 1 < group.words.length) {
        setWordIndex((value) => value + 1);
        setFeedback("Con đọc từ tiếp theo nhé.");
        return;
      }
      if (group.sentence_text) {
        setPhase("sentence");
        setFeedback("Bây giờ con đọc lại cả câu nhé.");
        return;
      }
      moveToNextGroup();
      return;
    }
    moveToNextGroup();
  }

  function moveToNextGroup() {
    if (groupIndex + 1 >= groups.length) {
      onComplete();
      return;
    }
    setGroupIndex((value) => value + 1);
    setWordIndex(0);
    setPhase("word");
    setFeedback("Mình cùng luyện từ tiếp theo nhé.");
  }

  async function handleRecordButton() {
    if (isProcessing) return;

    if (!isRecording) {
      setFeedback("Mình đang nghe con đọc…");
      try {
        await recorder.start();
        setIsRecording(true);
      } catch {
        setFeedback("Chưa mở được micro. Con nhờ ba mẹ kiểm tra quyền micro nhé.");
      }
      return;
    }

    setIsProcessing(true);
    try {
      const recording = await recorder.stop();
      setIsRecording(false);
      if (!recording || recording.size <= 800) {
        setFeedback("Mình chưa nghe rõ. Con thử đọc lại nhé.");
        return;
      }

      const transcript = await speechService.transcribe(recording, {
        languageCode: "vi",
      });
      if (!transcript.text.trim() || !transcript.words?.length) {
        const nextAttempt = attempts + 1;
        setAttempts(nextAttempt);
        setCanContinue(nextAttempt >= MAX_ATTEMPTS);
        setFeedback(
          nextAttempt >= MAX_ATTEMPTS
            ? "Mình chưa nghe đủ rõ để xác nhận. Con có thể nghe mẫu rồi chuyển tiếp nhé."
            : "Mình chưa có đủ dữ liệu để kiểm tra. Con thử đọc chậm và rõ hơn nhé.",
        );
        return;
      }

      const result = alignReadingSegment(
        targetWords,
        0,
        transcript.text,
        transcript.words,
        DEFAULT_WORD_CONFIDENCE_THRESHOLD,
      );
      const isConfirmedCorrect =
        result.assessments.length === targetWords.length &&
        result.assessments.every((item) => item.status === "CORRECT") &&
        result.next_word_index === targetWords.length;

      if (isConfirmedCorrect) {
        setFeedback(
          phase === "word"
            ? "Con đọc đúng rồi! Bây giờ mình luyện tiếp nhé."
            : "Con đã đọc lại cả câu rất tốt!",
        );
        advance();
      } else {
        const nextAttempt = attempts + 1;
        setAttempts(nextAttempt);
        if (nextAttempt >= MAX_ATTEMPTS) {
          setCanContinue(true);
          setFeedback(
            "Mình chưa thể xác nhận chắc chắn. Con nghe mẫu rồi chuyển sang phần tiếp theo nhé.",
          );
        } else {
          setFeedback(
            "Mình chưa nghe đủ rõ để xác nhận. Con thử đọc chậm và rõ hơn một lần nhé.",
          );
        }
      }
    } catch {
      setIsRecording(false);
      recorder.cancel();
      const nextAttempt = attempts + 1;
      setAttempts(nextAttempt);
      setFeedback(
        nextAttempt >= MAX_ATTEMPTS
          ? "Kết nối nhận diện chưa ổn định. Con nghe mẫu rồi chuyển tiếp nhé."
          : "Chưa kiểm tra được giọng đọc. Con thử lại nhé.",
      );
      setCanContinue(nextAttempt >= MAX_ATTEMPTS);
    } finally {
      setIsProcessing(false);
    }
  }

  async function playSample() {
    if (!targetText) return;
    try {
      await player.play(targetText);
      setFeedback("Con vừa nghe mẫu. Mình chuyển sang phần tiếp theo nhé.");
      setCanContinue(true);
    } catch {
      setFeedback("Chưa phát được giọng mẫu. Con vẫn có thể chuyển tiếp.");
      setCanContinue(true);
    }
  }

  return (
    <main
      aria-label="Luyện phát âm sau buổi đọc"
      className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col justify-center gap-6 px-4 py-8"
      data-testid="reading-pronunciation-review"
      data-review-phase={phase}
    >
      <header className="space-y-3 text-center">
        <p className="text-sm font-bold text-primary">Con đã đọc xong sách!</p>
        <h1 className="text-2xl font-extrabold text-ink sm:text-3xl">
          Mình cùng luyện lại một chút nhé.
        </h1>
        <p className="text-sm text-muted" aria-live="polite">
          Phần {groupIndex + 1} / {groups.length}
          {phase === "word"
            ? ` · Từ ${wordIndex + 1} / ${group.words.length}`
            : " · Đọc lại câu"}
        </p>
        <div className="h-2 overflow-hidden rounded-full bg-cream-dark">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{
              width: `${Math.min(100, ((groupIndex + 1) / groups.length) * 100)}%`,
            }}
          />
        </div>
      </header>

      <section className="flex flex-col items-center gap-5 rounded-card border border-line bg-white px-5 py-8 text-center shadow-sm sm:px-8">
        <p className="text-base font-semibold text-muted">
          {phase === "word" ? "Con đọc lại từ này nhé" : "Con đọc lại cả câu nhé"}
        </p>
        <p
          className={
            phase === "word"
              ? "text-5xl font-black leading-tight text-ink sm:text-6xl"
              : "max-w-2xl text-2xl font-extrabold leading-relaxed text-ink sm:text-3xl"
          }
          data-testid="pronunciation-review-target"
        >
          {targetText}
        </p>

        {isRecording ? (
          <div className="flex flex-col items-center gap-2" role="status">
            <span className="flex size-12 items-center justify-center rounded-full bg-rose-100 text-rose-700">
              <Mic aria-hidden="true" className="size-6 animate-pulse" />
            </span>
            <p className="font-semibold text-rose-700">Mình đang nghe con đọc…</p>
          </div>
        ) : (
          <button
            type="button"
            disabled={isProcessing}
            onClick={() => void handleRecordButton()}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-control bg-primary px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
          >
            <Mic aria-hidden="true" className="size-5" />
            {isProcessing ? "Đang kiểm tra…" : "Bắt đầu đọc"}
          </button>
        )}

        <p className="min-h-6 text-sm font-semibold text-muted" aria-live="polite">
          {feedback}
        </p>
        <p className="text-xs text-muted">
          Lượt thử: {Math.min(attempts, MAX_ATTEMPTS)} / {MAX_ATTEMPTS}
        </p>
      </section>

      <div className="flex flex-col justify-center gap-3 sm:flex-row">
        <button
          type="button"
          disabled={isRecording || isProcessing || player.isPlaying}
          onClick={() => void playSample()}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-line bg-white px-5 py-2 text-sm font-bold text-ink transition hover:bg-cream disabled:opacity-50"
        >
          <Volume2 aria-hidden="true" className="size-4" />
          Nghe đọc mẫu
        </button>
        {canContinue ? (
          <button
            type="button"
            disabled={isRecording || isProcessing}
            onClick={advance}
            className="inline-flex min-h-11 items-center justify-center rounded-control bg-primary px-5 py-2 text-sm font-bold text-white transition hover:bg-primary/90 disabled:opacity-50"
          >
            Tiếp tục
          </button>
        ) : null}
      </div>
    </main>
  );
}
