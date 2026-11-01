"use client";

import {
  BarChart3,
  CalendarClock,
  History,
  LayoutDashboard,
  LogOut,
  UserRound,
  UsersRound,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { ViReadLogo } from "@/components/common/viread-logo";
import { SiteFooter } from "@/components/layout/site-footer";
import { useAuthService } from "@/hooks/use-auth-service";
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
    href: "/reading-management",
    icon: CalendarClock,
    label: "Quản lý đọc",
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
  const authService = useAuthService();
  const pathname = usePathname();
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [hasSignOutError, setHasSignOutError] = useState(false);
  const isChildOnboarding = pathname === "/children/new";
  const isBookRoute = pathname === "/books" || pathname.startsWith("/books/");
  const isReadingRoute = pathname.startsWith("/reading/");
  const isImmersiveRoute = isBookRoute || isReadingRoute;

  async function handleSignOut() {
    if (isSigningOut) return;

    setHasSignOutError(false);
    setIsSigningOut(true);

    try {
      await authService.signOut();
      router.replace("/login");
      router.refresh();
    } catch {
      setHasSignOutError(true);
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header
        className={cn(
          "shrink-0 border-b border-border bg-white px-4 py-4 sm:px-8",
          isImmersiveRoute && "hidden",
        )}
      >
        <nav
          aria-label="Điều hướng dành cho ba mẹ"
          className={cn(
            "mx-auto flex w-full min-w-0 max-w-[1376px]",
            isChildOnboarding
              ? "min-h-11 items-center"
              : "flex-col gap-3 sm:min-h-16 sm:flex-row sm:items-center sm:gap-4",
          )}
        >
          <ViReadLogo
            ariaLabel="ViRead - về tổng quan"
            className={cn(isChildOnboarding ? "text-label" : "sm:mr-auto")}
            href="/dashboard"
            size="md"
          />

          {!isChildOnboarding ? (
            <div className="flex w-full min-w-0 max-w-full items-center gap-2 overflow-x-auto overscroll-x-contain pb-1 sm:w-auto sm:max-w-none sm:flex-wrap sm:justify-end sm:overflow-visible sm:pb-0">
              {navigationItems.map(({ href, icon: Icon, label }) => {
                const isActive =
                  pathname === href ||
                  (href !== "/dashboard" &&
                    href !== "/reports" &&
                    pathname.startsWith(href + "/"));

                return (
                  <Link
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex min-h-12 shrink-0 items-center justify-center gap-1 rounded-control px-3 text-center text-[13px] font-bold text-ink transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:h-14 sm:min-w-28 sm:gap-2 sm:px-3 sm:text-label lg:min-w-32",
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
              <button
                className="flex min-h-12 shrink-0 items-center justify-center gap-1 rounded-control bg-white px-3 text-center text-[13px] font-bold text-ink transition-colors hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-55 sm:h-14 sm:min-w-28 sm:gap-2 sm:px-3 sm:text-label lg:min-w-32"
                disabled={isSigningOut}
                onClick={handleSignOut}
                type="button"
              >
                <LogOut aria-hidden="true" className="size-5 shrink-0" />
                <span className="whitespace-nowrap">
                  {isSigningOut ? "Đang đăng xuất…" : "Đăng xuất"}
                </span>
              </button>
            </div>
          ) : null}
        </nav>
        {hasSignOutError ? (
          <p
            className="mx-auto mt-3 w-full max-w-[1376px] text-label font-bold text-danger"
            role="alert"
          >
            Chưa thể đăng xuất lúc này. Ba mẹ vui lòng thử lại.
          </p>
        ) : null}
      </header>

      <main
        className={cn(
          isImmersiveRoute
            ? "w-full flex-1"
            : "mx-auto w-full max-w-[1440px] px-4 sm:px-8",
          !isImmersiveRoute && "min-w-0 flex-1",
          !isImmersiveRoute &&
            (isChildOnboarding ? "pb-8 pt-4 sm:pb-12" : "py-8 sm:py-12"),
        )}
      >
        {children}
      </main>
      <SiteFooter variant="parent" />
    </div>
  );
}
