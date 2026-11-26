"use client";

import { ArrowRight, BookOpen } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
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
  const tParent = useTranslations("parent");
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
      <div className="desk-copy">
        <div className="desk-label">
          <BookOpen aria-hidden="true" size={17} />
          {recent?.resumable
            ? tParent("desk.continueReadingLabel")
            : tParent("desk.familyBookshelfLabel")}
        </div>
        <h2 id="desk-title">
          {recent?.resumable ? recent.title : tParent("desk.defaultHeading")}
        </h2>
        <p>
          {recent?.resumable
            ? tParent("desk.resumePrompt", { alias: child?.alias ?? "" })
            : child
              ? tParent("desk.chooseForChild", { alias: child.alias })
              : isLoadingProfiles
                ? tParent("desk.loadingProfiles")
                : hasProfiles
                  ? tParent("desk.selectChildPrompt")
                  : tParent("desk.createFirstChildPrompt")}
        </p>
        <div className="desk-actions">
          {recent?.resumable ? (
            <ButtonLink href={recent.href} className="desk-primary">
              {tParent("desk.resumeButton")}{" "}
              <ArrowRight
                aria-hidden="true"
                className="viread-rtl-flip"
                size={18}
              />
            </ButtonLink>
          ) : hasProfiles || isLoadingProfiles ? (
            <Button
              onClick={onChooseBook}
              className="desk-primary"
              disabled={isLoadingProfiles && !child}
            >
              {tParent("desk.chooseBookButton")}{" "}
              <ArrowRight
                aria-hidden="true"
                className="viread-rtl-flip"
                size={18}
              />
            </Button>
          ) : (
            <ButtonLink href="/children/new" className="desk-primary">
              {tParent("desk.createFirstChildButton")}{" "}
              <ArrowRight
                aria-hidden="true"
                className="viread-rtl-flip"
                size={18}
              />
            </ButtonLink>
          )}
          {recent?.resumable ? (
            <button
              className="desk-text-link min-h-11 px-1"
              type="button"
              onClick={onChooseBook}
            >
              {tParent("desk.chooseBookButton")}
            </button>
          ) : null}
        </div>
        {recent && !recent.resumable ? (
          <Link className="desk-recent" href={recent.href}>
            {tParent("desk.latestReadPrefix", { title: recent.title })}
          </Link>
        ) : null}
      </div>
      <div className="desk-illustration">
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
