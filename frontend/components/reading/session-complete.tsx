"use client";

import { useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Home,
  Mic,
  Star,
  Users,
  XCircle,
} from "lucide-react";
import Image from "next/image";

import { BookChildHeader } from "@/components/books/book-child-header";
import { ButtonLink } from "@/components/common/button";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type { ReadingCompletionSummaryUI } from "@/types/reading";

interface SessionCompleteProps {
  booksHref: string;
  child: ChildProfileDTO;
  sessionId: string;
  summary: ReadingCompletionSummaryUI;
}

export function SessionComplete({
  booksHref,
  child,
  sessionId,
  summary,
}: SessionCompleteProps) {
  const [showWordList, setShowWordList] = useState(false);
  const spokenWords = summary.spoken_words ?? [];
  const transcripts = summary.transcripts ?? [];
  const correctWords = summary.correct_words ?? spokenWords;
  const mispronouncedWords = summary.mispronounced_words ?? [];
  const score =
    summary.score !== undefined && summary.score !== null
      ? summary.score
      : correctWords.length + mispronouncedWords.length > 0
        ? Math.round(
            (correctWords.length /
              (correctWords.length + mispronouncedWords.length)) *
              100,
          )
        : null;

  return (
    <section className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-8 sm:py-8">
      <BookChildHeader child={child} mobileLabel="Bạn nhỏ cùng đọc" />
      <div className="mx-auto flex w-full max-w-[744px] flex-col gap-4 sm:gap-6">
        <div className="flex flex-col items-start gap-5 rounded-card bg-cream p-6 sm:flex-row">
          <Image
            alt=""
            aria-hidden="true"
            height={96}
            src="/images/figma/owl-mascot.svg"
            width={96}
          />
          <div>
            <h1 className="text-heading font-extrabold text-ink">
              Bé đọc xong rồi!
            </h1>
            <p className="mt-2 text-body text-muted">
              Giỏi lắm, hôm nay bé đã hoàn thành một buổi đọc.
            </p>
          </div>
        </div>

        {score !== null && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 rounded-card bg-cream border-2 border-primary/30 p-5 shadow-sm">
            <div className="flex items-center gap-4">
              <div className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary text-2xl font-black text-white shadow-md">
                {score}%
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-wider text-primary">
                  Điểm số chuẩn xác
                </p>
                <h3 className="text-lg font-extrabold text-ink">
                  {score >= 90
                    ? "🌟 Xuất sắc! Bé đọc rất chuẩn"
                    : score >= 70
                      ? "👍 Giỏi lắm! Bé phát âm khá tốt"
                      : "💪 Bé cố gắng thêm ở lượt đọc tới nhé"}
                </h3>
                <p className="text-xs text-muted mt-0.5">
                  Đúng {correctWords.length} từ
                  {mispronouncedWords.length > 0
                    ? ` · Cần chú ý ${mispronouncedWords.length} từ`
                    : " · Không sai từ nào"}
                </p>
              </div>
            </div>
            <div
              className="flex items-center gap-1.5"
              aria-label={`Đánh giá: ${score >= 90 ? "3 sao" : score >= 70 ? "2 sao" : "1 sao"}`}
            >
              <Star className="size-7 fill-amber-400 text-amber-500" />
              <Star
                className={cn(
                  "size-7",
                  score >= 70
                    ? "fill-amber-400 text-amber-500"
                    : "text-amber-200 fill-amber-100",
                )}
              />
              <Star
                className={cn(
                  "size-7",
                  score >= 90
                    ? "fill-amber-400 text-amber-500"
                    : "text-amber-200 fill-amber-100",
                )}
              />
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-card bg-cream p-5 text-center">
            <Clock3
              aria-hidden="true"
              className="mx-auto size-7 text-purple-ink"
            />
            <p className="mt-3 text-[26px] font-extrabold">
              {summary.duration_minutes === null
                ? "Chưa ghi nhận"
                : `${summary.duration_minutes} phút`}
            </p>
            <p className="text-label text-muted">thời lượng buổi đọc</p>
          </div>
          <div className="rounded-card bg-cream p-5 text-center">
            <BookOpen
              aria-hidden="true"
              className="mx-auto size-7 text-purple-ink"
            />
            <p className="mt-3 text-[26px] font-extrabold">
              {summary.pages_explored === null
                ? "Chưa ghi nhận"
                : `${summary.pages_explored} trang`}
            </p>
            <p className="text-label text-muted">đã mở trong buổi đọc</p>
          </div>
          <button
            type="button"
            onClick={() => setShowWordList((prev) => !prev)}
            aria-expanded={showWordList}
            className="group rounded-card bg-cream p-5 text-center transition-all hover:bg-cream-dark/40 focus:outline-none focus:ring-2 focus:ring-purple-ink cursor-pointer border-2 border-transparent hover:border-purple-ink/30 shadow-sm flex flex-col items-center justify-between"
          >
            <div>
              <Star
                aria-hidden="true"
                className="mx-auto size-7 text-purple-ink transition-transform group-hover:scale-110"
              />
              <p className="mt-3 text-[26px] font-extrabold text-ink">
                {summary.practiced_words === null
                  ? "Chưa ghi nhận"
                  : `${summary.practiced_words} từ`}
              </p>
              <p className="text-label text-muted">đã luyện thêm</p>
            </div>
            <span className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-purple-ink group-hover:underline">
              {showWordList ? (
                <>
                  Thu gọn <ChevronUp aria-hidden="true" className="size-3.5" />
                </>
              ) : (
                <>
                  Xem từ bé đọc{" "}
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                </>
              )}
            </span>
          </button>
        </div>

        {showWordList && (
          <div
            className="rounded-card bg-cream p-5 sm:p-6 border border-purple-border/50 shadow-sm animate-in fade-in slide-in-from-top-2"
            data-testid="spoken-words-container"
          >
            <div className="flex items-center justify-between mb-4 border-b border-cream-dark pb-3">
              <div className="flex items-center gap-2">
                <Mic aria-hidden="true" className="size-5 text-purple-ink" />
                <h2 className="text-lg font-extrabold text-ink">
                  Kết quả nhận diện giọng nói của bé (STT)
                </h2>
              </div>
              <span className="rounded-full bg-purple-surface px-3 py-0.5 text-xs font-bold text-purple-ink border border-purple-border/40">
                {spokenWords.length} từ nhận diện
              </span>
            </div>

            {spokenWords.length > 0 ||
            correctWords.length > 0 ||
            mispronouncedWords.length > 0 ? (
              <div className="space-y-4">
                {correctWords.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-2 flex items-center gap-1.5">
                      <CheckCircle2 className="size-4 text-emerald-600" />
                      <span>
                        Danh sách các từ bé đã đọc thành công (
                        {correctWords.length} từ):
                      </span>
                    </p>
                    <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto pr-1">
                      {correctWords.map((word, idx) => (
                        <span
                          key={`${word}-${idx}`}
                          className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-bold text-ink shadow-sm border border-emerald-200 hover:bg-emerald-50/50 transition-colors"
                        >
                          <CheckCircle2
                            aria-hidden="true"
                            className="size-4 text-leaf-green flex-shrink-0"
                          />
                          {word}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {mispronouncedWords.length > 0 && (
                  <div className="rounded-card border border-rose-200 bg-rose-50/60 p-4">
                    <p className="text-xs font-black uppercase tracking-wider text-rose-700 mb-2 flex items-center gap-1.5">
                      <AlertCircle className="size-4 text-rose-600" />
                      <span>
                        Các từ bé cần chú ý phát âm lại (
                        {mispronouncedWords.length} từ):
                      </span>
                    </p>
                    <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto pr-1">
                      {mispronouncedWords.map((word, idx) => (
                        <span
                          key={`${word}-${idx}`}
                          className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-bold text-rose-800 shadow-sm border border-rose-200"
                        >
                          <XCircle
                            aria-hidden="true"
                            className="size-4 text-rose-600 flex-shrink-0"
                          />
                          {word}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {transcripts.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
                      Câu nhận diện từ microphone:
                    </p>
                    <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                      {transcripts.map((t, idx) => (
                        <div
                          key={idx}
                          className="rounded-lg bg-white/80 px-3.5 py-2 text-sm text-ink italic border border-cream-dark"
                        >
                          &ldquo;{t}&rdquo;
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-4 text-center">
                <p className="text-body font-medium text-ink">
                  Chưa ghi nhận từ nào trong lượt đọc này.
                </p>
                <p className="mt-1 text-xs text-muted">
                  Bé hãy bấm nút &ldquo;Đọc&rdquo; và nói to, rõ ràng vào
                  microphone để hệ thống ghi nhận nhé!
                </p>
              </div>
            )}
          </div>
        )}

        <ButtonLink className="mx-auto max-w-[360px]" href={booksHref}>
          Đọc cuốn khác
          <ArrowRight aria-hidden="true" className="size-5" />
        </ButtonLink>
        <ButtonLink
          className="mx-auto max-w-[360px]"
          href="/dashboard"
          variant="quiet"
        >
          <Home aria-hidden="true" className="size-5" />
          Về trang chủ
        </ButtonLink>
        <ButtonLink
          className="mx-auto max-w-[360px]"
          href={`/sessions/${sessionId}`}
          variant="secondary"
        >
          <Users aria-hidden="true" className="size-5" />
          Xem cùng ba mẹ
        </ButtonLink>
      </div>
    </section>
  );
}
