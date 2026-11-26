"use client";

import {
  BarChart3,
  BookMarked,
  BookOpen,
  BookOpenCheck,
  BrainCircuit,
  CalendarClock,
  Camera,
  ClipboardCheck,
  Gamepad2,
  HeartPulse,
  History,
  LayoutDashboard,
  LayoutGrid,
  Music2,
  ScrollText,
  UsersRound,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  MobileMoreSheet,
  type MobileMoreSheetItem,
} from "@/components/layout/mobile-more-sheet";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

export interface MobileNavTabItem {
  readonly href: string;
  readonly label: string;
  readonly labelKey?: string;
  readonly icon: LucideIcon;
  readonly isPrimaryAction?: boolean;
  readonly isActive?: (pathname: string) => boolean;
}

function routeMatches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export const PARENT_MOBILE_PRIMARY_TABS: readonly MobileNavTabItem[] = [
  {
    href: "/dashboard",
    label: "Tổng quan",
    labelKey: "navigation.parent.dashboard",
    icon: LayoutDashboard,
  },
  {
    href: "/books",
    label: "Sách",
    labelKey: "navigation.parent.booksShort",
    icon: BookOpen,
  },
  {
    href: "/book-scanner",
    label: "Quét",
    labelKey: "navigation.parent.scannerShort",
    icon: Camera,
    isPrimaryAction: true,
  },
  {
    href: "/reports",
    label: "Tiến bộ",
    labelKey: "navigation.parent.reports",
    icon: BarChart3,
    isActive: (pathname) =>
      pathname === "/reports" ||
      (pathname.startsWith("/reports/") &&
        !routeMatches(pathname, "/reports/difficult-words")),
  },
] as const;

export const PARENT_MOBILE_MORE_ITEMS: readonly MobileMoreSheetItem[] = [
  {
    href: "/my-books",
    label: "Sách của tôi",
    labelKey: "navigation.parent.myBooks",
    description: "Tải lên và quản lý sách riêng của gia đình",
    descriptionKey: "navigation.parent.moreDescriptions.myBooks",
    icon: BookMarked,
  },
  {
    href: "/reading-management",
    label: "Quản lý đọc",
    labelKey: "navigation.parent.readingManagement",
    description: "Mục tiêu, lịch đọc và sách đã lưu cho bé",
    descriptionKey: "navigation.parent.moreDescriptions.readingManagement",
    icon: CalendarClock,
  },
  {
    href: "/sessions",
    label: "Lịch sử",
    labelKey: "navigation.parent.sessions",
    description: "Xem lại các buổi đọc đã hoàn thành",
    descriptionKey: "navigation.parent.moreDescriptions.sessions",
    icon: History,
  },
  {
    href: "/entertainment",
    label: "Giải trí",
    labelKey: "navigation.parent.entertainment",
    description: "Trò chơi ngôn ngữ, kể chuyện và karaoke",
    descriptionKey: "navigation.parent.moreDescriptions.entertainment",
    icon: Gamepad2,
    isActive: (pathname) =>
      routeMatches(pathname, "/entertainment") ||
      routeMatches(pathname, "/karaoke"),
  },
  {
    href: "/reports/difficult-words",
    label: "Từ cần luyện",
    labelKey: "navigation.parent.difficultWords",
    description: "Ôn luyện các từ bé hay đọc nhầm",
    descriptionKey: "navigation.parent.moreDescriptions.difficultWords",
    icon: Volume2,
  },
] as const;

export const ADMIN_MOBILE_PRIMARY_TABS: readonly MobileNavTabItem[] = [
  {
    href: "/admin/parents",
    label: "Phụ huynh",
    labelKey: "navigation.admin.parents",
    icon: UsersRound,
  },
  {
    href: "/admin/books",
    label: "Kho sách",
    labelKey: "navigation.admin.books",
    icon: BookOpenCheck,
  },
  {
    href: "/admin/metadata-quality",
    label: "Chất lượng",
    labelKey: "navigation.admin.mobileQualityShort",
    icon: ClipboardCheck,
  },
  {
    href: "/admin/karaoke",
    label: "Bài hát",
    labelKey: "navigation.admin.karaoke",
    icon: Music2,
  },
] as const;

export const ADMIN_MOBILE_MORE_ITEMS: readonly MobileMoreSheetItem[] = [
  {
    href: "/admin/audit-logs",
    label: "Nhật ký",
    labelKey: "navigation.admin.auditLogs",
    description: "Theo dõi nhật ký kiểm toán quản trị",
    descriptionKey: "navigation.admin.mobileMoreDescriptions.auditLogs",
    icon: ScrollText,
  },
  {
    href: "/admin/viread-training",
    label: "OCR",
    labelKey: "navigation.admin.mobileOcrShort",
    description: "Huấn luyện và vận hành model VietOCR V2",
    descriptionKey: "navigation.admin.mobileMoreDescriptions.training",
    icon: BrainCircuit,
  },
  {
    href: "/admin/health",
    label: "Vận hành",
    labelKey: "navigation.admin.health",
    description: "Tình trạng hệ thống, OCR worker và voice",
    descriptionKey: "navigation.admin.mobileMoreDescriptions.health",
    icon: HeartPulse,
  },
] as const;

interface MobileBottomNavProps {
  readonly pathname: string;
  readonly ariaLabel?: string;
  readonly hideAbove?: "lg" | "xl";
  readonly moreTitle?: string;
  readonly sheetId?: string;
  readonly tabs?: readonly MobileNavTabItem[];
  readonly moreItems?: readonly MobileMoreSheetItem[];
}

export function MobileBottomNav({
  pathname,
  ariaLabel,
  hideAbove = "xl",
  moreTitle,
  sheetId = "parent-mobile-more-sheet",
  tabs = PARENT_MOBILE_PRIMARY_TABS,
  moreItems = PARENT_MOBILE_MORE_ITEMS,
}: MobileBottomNavProps) {
  const { t } = useI18n();
  const [openForPathname, setOpenForPathname] = useState<string | null>(null);
  const isMoreOpen = openForPathname === pathname;
  const resolvedAriaLabel = ariaLabel ?? t("navigation.parent.mobileAriaLabel");
  const resolvedMoreTitle = moreTitle ?? t("navigation.parent.moreTitle");

  const isMoreRouteActive = moreItems.some((item) =>
    item.isActive ? item.isActive(pathname) : routeMatches(pathname, item.href),
  );

  const columnCountClass = tabs.length === 3 ? "grid-cols-4" : "grid-cols-5";

  return (
    <>
      <nav
        aria-label={resolvedAriaLabel}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(35,62,64,0.06)] backdrop-blur-sm",
          hideAbove === "lg" ? "lg:hidden" : "xl:hidden",
        )}
        data-testid="mobile-bottom-nav"
      >
        <div
          className={cn(
            "mx-auto grid min-h-16 w-full max-w-[640px] items-stretch px-1",
            columnCountClass,
          )}
        >
          {tabs.map(
            ({
              href,
              label,
              labelKey,
              icon: Icon,
              isPrimaryAction,
              isActive,
            }) => {
              const active = isActive
                ? isActive(pathname)
                : routeMatches(pathname, href);
              const resolvedLabel = labelKey ? t(labelKey) : label;

              if (isPrimaryAction) {
                return (
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-control px-1 py-1.5 text-[11px] font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      active ? "text-primary-hover" : "text-primary",
                    )}
                    href={href}
                    key={href}
                    onClick={() => setOpenForPathname(null)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-9 items-center justify-center rounded-full shadow-sm transition-colors",
                        active
                          ? "bg-primary-hover text-white ring-2 ring-sky"
                          : "bg-primary text-white",
                      )}
                    >
                      <Icon className="size-5" strokeWidth={2.1} />
                    </span>
                    <span className="truncate leading-tight">
                      {resolvedLabel}
                    </span>
                  </Link>
                );
              }

              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-12 flex-col items-center justify-center gap-1 rounded-control px-1 py-2 text-[11px] font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    active ? "text-primary-hover" : "text-muted hover:text-ink",
                  )}
                  href={href}
                  key={href}
                  onClick={() => setOpenForPathname(null)}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                      active ? "bg-sky text-primary-hover" : "bg-transparent",
                    )}
                  >
                    <Icon className="size-5" strokeWidth={active ? 2.2 : 1.9} />
                  </span>
                  <span className="truncate leading-tight">
                    {resolvedLabel}
                  </span>
                </Link>
              );
            },
          )}

          <button
            aria-controls={sheetId}
            aria-expanded={isMoreOpen}
            aria-haspopup="dialog"
            className={cn(
              "flex min-h-12 flex-col items-center justify-center gap-1 rounded-control px-1 py-2 text-[11px] font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
              isMoreOpen || isMoreRouteActive
                ? "text-primary-hover"
                : "text-muted hover:text-ink",
            )}
            onClick={() =>
              setOpenForPathname((current) =>
                current === pathname ? null : pathname,
              )
            }
            type="button"
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                isMoreOpen || isMoreRouteActive
                  ? "bg-sky text-primary-hover"
                  : "bg-transparent",
              )}
            >
              <LayoutGrid
                className="size-5"
                strokeWidth={isMoreOpen || isMoreRouteActive ? 2.2 : 1.9}
              />
            </span>
            <span className="truncate leading-tight">
              {t("navigation.parent.moreButton")}
            </span>
          </button>
        </div>
      </nav>

      <MobileMoreSheet
        id={sheetId}
        isOpen={isMoreOpen}
        items={moreItems}
        onClose={() => setOpenForPathname(null)}
        pathname={pathname}
        title={resolvedMoreTitle}
      />
    </>
  );
}
