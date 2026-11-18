"use client";

import { ArrowRight, BookOpen } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, ButtonLink } from "@/components/common/button";
import { useReportServices } from "@/hooks/use-report-services";
import type { ChildProfileDTO } from "@/types/child";

interface ReadingDeskProps {
  child?: Pick<ChildProfileDTO, "id" | "alias">;
  hasProfiles: boolean;
  onChooseBook: () => void;
}

interface RecentReading {
  title: string;
  href: string;
  resumable: boolean;
}

export function FamilyReadingDesk({
  child,
  hasProfiles,
  onChooseBook,
}: ReadingDeskProps) {
  const { sessionService } = useReportServices();
  const [recent, setRecent] = useState<RecentReading | null>(null);
  const childId = child?.id;

  useEffect(() => {
    if (!childId) return;
    let current = true;
    async function load(id: string) {
      const { sessions } = await sessionService.list(id, { limit: 1 });
      const session = sessions[0];
      if (!current || !session || session.child_id !== id) return;
      const book = await sessionService.getBook(session.id);
      if (!current || book.id !== session.book_id) return;
      const resumable =
        !session.ended_at && !["FINISHED", "ABORTED"].includes(session.state);
      setRecent({
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
  }, [childId, sessionService]);

  return (
    <section className="family-reading-desk" aria-labelledby="desk-title">
      <div className="desk-copy">
        <div className="desk-label">
          <BookOpen aria-hidden="true" size={17} />
          {recent?.resumable ? "Sách đang đọc" : "Tủ sách gia đình"}
        </div>
        <h2 id="desk-title">
          {recent?.resumable ? recent.title : "Hôm nay bé đọc gì?"}
        </h2>
        <p>
          {recent?.resumable
            ? `Cùng ${child?.alias} tiếp tục buổi đọc còn dở.`
            : child
              ? `Mở tủ sách và chọn một cuốn cho ${child.alias}.`
              : hasProfiles
                ? "Chọn hồ sơ của bé để mở tủ sách riêng."
                : "Tạo hồ sơ cho bé để mở cuốn sách đầu tiên."}
        </p>
        <div className="desk-actions">
          {recent?.resumable ? (
            <ButtonLink href={recent.href} className="desk-primary">
              Đọc tiếp <ArrowRight aria-hidden="true" size={18} />
            </ButtonLink>
          ) : hasProfiles ? (
            <Button onClick={onChooseBook} className="desk-primary">
              Chọn sách <ArrowRight aria-hidden="true" size={18} />
            </Button>
          ) : (
            <ButtonLink href="/children/new" className="desk-primary">
              Tạo hồ sơ đầu tiên <ArrowRight aria-hidden="true" size={18} />
            </ButtonLink>
          )}
          {recent?.resumable ? (
            <button
              className="desk-text-link"
              type="button"
              onClick={onChooseBook}
            >
              Chọn sách
            </button>
          ) : null}
        </div>
        {recent && !recent.resumable ? (
          <Link className="desk-recent" href={recent.href}>
            Lần đọc gần nhất · {recent.title}
          </Link>
        ) : null}
      </div>
      <div className="desk-illustration">
        <Image
          alt=""
          src="/images/reading-studio.webp"
          fill
          priority
          unoptimized
          sizes="(min-width: 1000px) 380px, 50vw"
          className="object-cover"
        />
      </div>
    </section>
  );
}
