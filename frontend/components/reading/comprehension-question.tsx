"use client";

import { ArrowRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { BookChildHeader } from "@/components/books/book-child-header";
import { Button } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useReadingServices } from "@/hooks/use-reading-services";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type {
  ComprehensionAnswerResultDTO,
  ComprehensionQuestionViewModelUI,
} from "@/types/reading";

interface ComprehensionQuestionProps {
  child: ChildProfileDTO;
  onComplete: () => void;
  sessionId: string;
}

type QuestionLoadState =
  | { status: "loading" }
  | { status: "ready"; value: ComprehensionQuestionViewModelUI }
  | { status: "error" };

export function ComprehensionQuestion({
  child,
  onComplete,
  sessionId,
}: ComprehensionQuestionProps) {
  const { comprehensionService } = useReadingServices();
  const [loadKey, setLoadKey] = useState(0);
  const [loadState, setLoadState] = useState<QuestionLoadState>({
    status: "loading",
  });
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [result, setResult] = useState<ComprehensionAnswerResultDTO | null>(
    null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void comprehensionService
      .getQuestion(sessionId)
      .then((value) => {
        if (active) setLoadState({ status: "ready", value });
      })
      .catch(() => {
        if (active) setLoadState({ status: "error" });
      });

    return () => {
      active = false;
    };
  }, [comprehensionService, loadKey, sessionId]);

  async function submitAnswer(answer: string) {
    if (loadState.status !== "ready" || isSubmitting || result?.is_correct) {
      return;
    }

    setSelectedAnswer(answer);
    setIsSubmitting(true);
    setResult(null);
    try {
      const nextResult = await comprehensionService.submitAnswer(
        sessionId,
        loadState.value.question.id,
        answer,
      );
      if (mountedRef.current) setResult(nextResult);
    } finally {
      if (mountedRef.current) setIsSubmitting(false);
    }
  }

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      <BookChildHeader child={child} mobileLabel="Bạn nhỏ cùng đọc" />
      <div className="mx-auto flex w-full max-w-[700px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink sm:text-center">
          Mình cùng trả lời nhé!
        </h1>
        <div
          aria-hidden="true"
          className="mx-auto hidden w-[392px] grid-cols-5 gap-1 sm:grid"
        >
          {[0, 1, 2, 3, 4].map((step) => (
            <span
              className={cn("h-2", step < 2 ? "bg-primary" : "bg-border")}
              key={step}
            />
          ))}
        </div>

        {loadState.status === "loading" ? (
          <div aria-label="Đang tải câu hỏi" className="space-y-4">
            <Skeleton className="h-40 rounded-card" />
            <Skeleton className="h-18 rounded-card" />
            <Skeleton className="h-18 rounded-card" />
          </div>
        ) : loadState.status === "error" ? (
          <div className="space-y-4">
            <StatusMessage title="Chưa tải được câu hỏi" tone="error">
              Có lỗi xảy ra. Bé có thể thử lại mà không ảnh hưởng buổi đọc.
            </StatusMessage>
            <Button
              onClick={() => {
                setLoadState({ status: "loading" });
                setLoadKey((key) => key + 1);
              }}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-5" />
              Thử lại
            </Button>
          </div>
        ) : (
          <>
            <div className="rounded-card bg-cream p-4 sm:p-6">
              <p className="text-label font-bold text-purple-ink">
                {loadState.value.progress_label}
              </p>
              <p className="mt-4 text-[26px] font-extrabold text-ink sm:text-heading">
                {loadState.value.question.prompt}
              </p>
            </div>

            <div className="space-y-3">
              {loadState.value.choices.map((choice) => {
                const selected = selectedAnswer === choice.value;
                const correct = selected && result?.is_correct === true;
                return (
                  <button
                    aria-pressed={selected}
                    className={cn(
                      "flex min-h-18 w-full items-center gap-6 rounded-card border-2 bg-white p-4 text-left text-body font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                      selected && "border-primary",
                      correct && "bg-success-surface text-success-ink",
                    )}
                    disabled={isSubmitting || result?.is_correct === true}
                    key={choice.id}
                    onClick={() => void submitAnswer(choice.value)}
                    type="button"
                  >
                    <span className="w-8 shrink-0 text-purple-ink">
                      {choice.id}
                    </span>
                    <span className="flex-1 text-center">{choice.label}</span>
                  </button>
                );
              })}
            </div>

            {result ? (
              <StatusMessage tone={result.is_correct ? "success" : "warning"}>
                {result.is_correct
                  ? "Đúng rồi! Bé nhớ rất tốt."
                  : "Gần đúng rồi, thử lại nhé."}
              </StatusMessage>
            ) : (
              <p className="text-center text-body text-muted">
                Không cần vội. Bé cứ nghĩ một chút nhé.
              </p>
            )}

            {result?.is_correct ? (
              <Button className="mx-auto max-w-[360px]" onClick={onComplete}>
                Câu tiếp theo
                <ArrowRight aria-hidden="true" className="size-5" />
              </Button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
