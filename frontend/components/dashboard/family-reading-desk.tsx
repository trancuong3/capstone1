"use client";

import { ArrowRight, BookOpen } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { useReportServices } from "@/hooks/use-report-services";
import type { ChildProfileDTO } from "@/types/child";
import type { DashboardLatestSessionDTO } from "@/types/profile";

interface ReadingDeskProps {
  child?: Pick<ChildProfileDTO, "id" | "alias">;
  hasProfiles: boolean;
  isLoadingProfiles?: boolean;
  latestSession?: DashboardLatestSessionDTO | null;
  summarySource?: "dashboard-summary" | "fallback";
  onChooseBook: () => void;
}

interface RecentReading {
  title: string;
  href: string;
  resumable: boolean;
}

function mapSummarySessionToRecent(
  childId: string,
  session: DashboardLatestSessionDTO | null | undefined,
): RecentReading | null {
  if (!session || session.child_id !== childId) return null;
  const title = session.book_title?.trim();
  if (!title) return null;
  return {
    title,
    resumable: session.resumable,
    href: session.resumable
      ? `/reading/${encodeURIComponent(session.id)}`
      : `/sessions/${encodeURIComponent(session.id)}?childId=${encodeURIComponent(childId)}`,
  };
}

export function FamilyReadingDesk({
  child,
  hasProfiles,
  isLoadingProfiles = false,
  latestSession,
  summarySource,
  onChooseBook,
}: ReadingDeskProps) {
  const { sessionService } = useReportServices();
  const [fallbackRecent, setFallbackRecent] = useState<RecentReading | null>(
    null,
  );
  const childId = child?.id;

  const summaryRecent = useMemo(
    () =>
      childId && summarySource === "dashboard-summary"
        ? mapSummarySessionToRecent(childId, latestSession)
        : null,
    [childId, latestSession, summarySource],
  );

  useEffect(() => {
    if (!childId || summarySource === "dashboard-summary") return;
    let current = true;
    async function load(id: string) {
      const { sessions } = await sessionService.list(id, { limit: 1 });
      const session = sessions[0];
      if (!current || !session || session.child_id !== id) return;
      const book = await sessionService.getBook(session.id);
      if (!current || book.id !== session.book_id) return;
      const resumable =
        !session.ended_at && !["FINISHED", "ABORTED"].includes(session.state);
      setFallbackRecent({
        title: book.title,
        resumable,
        href: resumable
          ? `/reading/${encodeURIComponent(session.id)}`
          : `/sessions/${encodeURIComponent(session.id)}?childId=${encodeURIComponent(id)}`,
      });
    }
    // History enriches this desk. Opening the library works even when history is unavailable.
    void load(childId).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [childId, sessionService, summarySource]);

  const recent =
    summarySource === "dashboard-summary" ? summaryRecent : fallbackRecent;

  return (
    <section
      className="family-reading-desk order-2 md:order-1"
      aria-labelledby="desk-title"
    >
      <div className="desk-copy max-md:p-3.5!">
        <div className="desk-label max-md:text-xs!">
          <BookOpen aria-hidden="true" size={16} />
          {recent?.resumable ? "Tiếp tục đọc" : "Tủ sách gia đình"}
        </div>
        <h2
          id="desk-title"
          className="max-md:my-1.5! max-md:text-xl!"
        >
          {recent?.resumable ? recent.title : "Hôm nay bé đọc gì?"}
        </h2>
        <p className="max-md:text-sm!">
          {recent?.resumable
            ? `Cùng ${child?.alias} tiếp tục buổi đọc còn dở.`
            : child
              ? `Mở tủ sách và chọn một cuốn cho ${child.alias}.`
              : isLoadingProfiles
                ? "Đang tải hồ sơ gia đình để chuẩn bị tủ sách của bé…"
                : hasProfiles
                  ? "Chọn hồ sơ của bé để mở tủ sách riêng."
                  : "Tạo hồ sơ cho bé để mở cuốn sách đầu tiên."}
        </p>
        <div className="desk-actions max-md:mt-3!">
          {recent?.resumable ? (
            <ButtonLink href={recent.href} className="desk-primary min-h-11">
              Đọc tiếp <ArrowRight aria-hidden="true" size={18} />
            </ButtonLink>
          ) : hasProfiles || isLoadingProfiles ? (
            <Button
              onClick={onChooseBook}
              className="desk-primary min-h-11"
              disabled={isLoadingProfiles && !child}
            >
              Chọn sách <ArrowRight aria-hidden="true" size={18} />
            </Button>
          ) : (
            <ButtonLink href="/children/new" className="desk-primary min-h-11">
              Tạo hồ sơ đầu tiên <ArrowRight aria-hidden="true" size={18} />
            </ButtonLink>
          )}
          {recent?.resumable ? (
            <button
              className="desk-text-link min-h-11 px-1"
              type="button"
              onClick={onChooseBook}
            >
              Chọn sách
            </button>
          ) : null}
        </div>
        {recent && !recent.resumable ? (
          <Link
            className="desk-recent inline-flex! min-h-11 items-center max-md:mt-1.5!"
            href={recent.href}
          >
            Lần đọc gần nhất · {recent.title}
          </Link>
        ) : null}
      </div>
      <div className="desk-illustration max-md:min-h-[84px]! max-md:max-h-[92px]!">
        <Image
          alt=""
          src="/images/reading-studio.webp"
          fill
          priority
          sizes="(min-width: 1000px) 380px, 100vw"
          className="object-cover"
        />
      </div>
    </section>
  );
}
