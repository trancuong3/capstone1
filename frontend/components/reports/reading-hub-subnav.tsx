"use client";

import { BarChart3, CalendarClock, History } from "lucide-react";
import Link from "next/link";

import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

export type ReadingHubRoute = "reports" | "reading-management" | "sessions";

export interface ReadingHubSubNavProps {
  readonly active: ReadingHubRoute;
  readonly childId?: string | null;
  readonly className?: string;
}

export function ReadingHubSubNav({
  active,
  childId,
  className,
}: ReadingHubSubNavProps) {
  const tNav = useTranslations("navigation");
  const tReports = useTranslations("reports");
  const childQuery = childId ? `?childId=${encodeURIComponent(childId)}` : "";

  const items = [
    {
      key: "reports" as const,
      href: `/reports${childQuery}`,
      icon: BarChart3,
      label: tNav("parent.reports"),
    },
    {
      key: "reading-management" as const,
      href: `/reading-management${childQuery}`,
      icon: CalendarClock,
      label: tNav("parent.readingManagement"),
    },
    {
      key: "sessions" as const,
      href: `/sessions${childQuery}`,
      icon: History,
      label: tNav("parent.sessionsLong"),
    },
  ] as const;

  return (
    <nav
      aria-label={tReports("hub.navAria")}
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-control border border-border bg-canvas/80 p-0.5",
        className,
      )}
    >
      {items.map(({ key, href, icon: Icon, label }) => {
        const isActive = active === key;
        return (
          <Link
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "inline-flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-8 sm:px-3",
              isActive
                ? "bg-primary text-white"
                : "text-ink hover:bg-white hover:text-primary-hover",
            )}
            href={href}
            key={key}
          >
            <Icon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0",
                isActive ? "text-white" : "text-primary",
              )}
              strokeWidth={2}
            />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
