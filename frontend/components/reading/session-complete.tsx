"use client";

import { useState } from "react";
import {
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
} from "lucide-react";
import Image from "next/image";

import { BookChildHeader } from "@/components/books/book-child-header";
import { ButtonLink } from "@/components/common/button";
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

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-card bg-cream p-5 text-center">
            <Clock3
              aria-hidden="true"
              className="mx-auto size-7 text-purple-ink"
            />
            <p className="mt-3 text-[26px] font-extrabold">
              {summary.duration_minutes} phút
            </p>
            <p className="text-label text-muted">cùng trang sách</p>
          </div>
          <div className="rounded-card bg-cream p-5 text-center">
            <BookOpen
              aria-hidden="true"
              className="mx-auto size-7 text-purple-ink"
            />
            <p className="mt-3 text-[26px] font-extrabold">
              {summary.pages_explored} trang
            </p>
            <p className="text-label text-muted">đã khám phá</p>
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
                {summary.practiced_words} từ
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

            {spokenWords.length > 0 ? (
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">
                    Danh sách các từ bé đã đọc thành công:
                  </p>
                  <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto pr-1">
                    {spokenWords.map((word, idx) => (
                      <span
                        key={`${word}-${idx}`}
                        className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-bold text-ink shadow-sm border border-purple-border/30 hover:bg-purple-surface transition-colors"
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
