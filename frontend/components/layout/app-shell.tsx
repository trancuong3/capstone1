"use client";

import {
  BarChart3,
  History,
  LayoutDashboard,
  UserRound,
  UsersRound,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

interface AppShellProps {
  children: ReactNode;
}

const navigationItems = [
  {
    href: "/dashboard",
    icon: LayoutDashboard,
    label: "Tổng quan",
  },
  {
    href: "/reports",
    icon: BarChart3,
    label: "Tiến bộ",
  },
  {
    href: "/sessions",
    icon: History,
    label: "Lịch sử",
  },
  {
    href: "/reports/difficult-words",
    icon: Volume2,
    label: "Từ cần luyện",
  },
  {
    href: "/children",
    icon: UsersRound,
    label: "Hồ sơ bé",
  },
  {
    href: "/profile",
    icon: UserRound,
    label: "Ba mẹ",
  },
] as const;

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const isChildOnboarding = pathname === "/children/new";
  const isBookRoute = pathname === "/books" || pathname.startsWith("/books/");
  const isReadingRoute = pathname.startsWith("/reading/");
  const isImmersiveRoute = isBookRoute || isReadingRoute;

  return (
    <div className="min-h-dvh bg-canvas">
      <header
        className={cn(
          "px-4 pt-4 sm:px-8 sm:pt-8",
          isImmersiveRoute && "hidden",
        )}
      >
        <nav
          aria-label="Điều hướng dành cho ba mẹ"
          className={cn(
            "mx-auto flex w-full max-w-[1376px]",
            isChildOnboarding
              ? "min-h-11 items-center"
              : "flex-col gap-3 sm:min-h-16 sm:flex-row sm:items-center sm:gap-4",
          )}
        >
          <Link
            className={cn(
              "flex items-center rounded-control font-bold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
              isChildOnboarding
                ? "min-h-11 text-label"
                : "min-h-11 text-label sm:mr-auto sm:text-body",
            )}
            href="/dashboard"
          >
            READALONG VISION
          </Link>

          {!isChildOnboarding ? (
            <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:justify-end sm:gap-3">
              {navigationItems.map(({ href, icon: Icon, label }) => {
                const isActive =
                  pathname === href ||
                  (href !== "/dashboard" &&
                    href !== "/reports" &&
                    pathname.startsWith(`${href}/`));

                return (
                  <Link
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex min-h-14 min-w-0 items-center justify-center gap-1 rounded-control px-1 text-center text-[13px] font-bold text-ink transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:h-14 sm:min-w-28 sm:gap-2 sm:px-3 sm:text-label lg:min-w-32",
                      isActive
                        ? "bg-sky text-primary-hover"
                        : "bg-white hover:bg-sky",
                    )}
                    href={href}
                    key={href}
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-5 shrink-0 sm:hidden"
                    />
                    <span className="whitespace-nowrap">{label}</span>
                  </Link>
                );
              })}
            </div>
          ) : null}
        </nav>
      </header>

      <main
        className={cn(
          isImmersiveRoute
            ? "w-full"
            : "mx-auto w-full max-w-[1440px] px-4 sm:px-8",
          !isImmersiveRoute &&
            (isChildOnboarding ? "pb-8 pt-4 sm:pb-12" : "py-8 sm:py-12"),
        )}
      >
        {children}
      </main>
    </div>
  );
}
