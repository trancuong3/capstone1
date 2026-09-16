"use client";

import { ArrowRight, BookOpen, Clock3, Home, Star, Users } from "lucide-react";
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
          <div className="rounded-card bg-cream p-5 text-center">
            <Star
              aria-hidden="true"
              className="mx-auto size-7 text-purple-ink"
            />
            <p className="mt-3 text-[26px] font-extrabold">
              {summary.practiced_words} từ
            </p>
            <p className="text-label text-muted">đã luyện thêm</p>
          </div>
        </div>

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
