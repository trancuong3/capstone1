"use client";

import {
  BarChart3,
  CalendarClock,
  History,
  LayoutDashboard,
  UserRound,
  UsersRound,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ViReadLogo } from "@/components/common/viread-logo";
import { AccountAvatarMenu } from "@/components/layout/account-avatar-menu";
import { SiteFooter } from "@/components/layout/site-footer";
import { useAuthService } from "@/hooks/use-auth-service";
import { createProfileService } from "@/lib/api/profile-service";
import { cn } from "@/lib/utils/cn";
import type { AuthUserSnapshot, CurrentUserRole } from "@/types/auth";

interface AppShellProps {
  children: ReactNode;
}

const navigationItems = [
  { href: "/dashboard", icon: LayoutDashboard, label: "Tổng quan" },
  { href: "/reports", icon: BarChart3, label: "Tiến bộ" },
  { href: "/reading-management", icon: CalendarClock, label: "Quản lý đọc" },
  { href: "/sessions", icon: History, label: "Lịch sử" },
  { href: "/reports/difficult-words", icon: Volume2, label: "Từ cần luyện" },
  { href: "/children", icon: UsersRound, label: "Hồ sơ bé" },
  { href: "/profile", icon: UserRound, label: "Ba mẹ" },
] as const;

function roleLabel(role: CurrentUserRole): string | null {
  if (role === "parent") return "Phụ huynh";
  if (role === "admin") return "Quản trị viên";
  return null;
}

export function AppShell({ children }: AppShellProps) {
  const authService = useAuthService();
  const profileService = useMemo(() => createProfileService(), []);
  const pathname = usePathname();
  const router = useRouter();
  const [accountUser, setAccountUser] = useState<AuthUserSnapshot | null>(null);
  const [accountRole, setAccountRole] = useState<CurrentUserRole>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [hasSignOutError, setHasSignOutError] = useState(false);
  const isChildOnboarding = pathname === "/children/new";
  const isBookRoute = pathname === "/books" || pathname.startsWith("/books/");
  const isReadingRoute = pathname.startsWith("/reading/");
  const isImmersiveRoute = isBookRoute || isReadingRoute;

  useEffect(() => {
    let active = true;

    const unsubscribe = authService.onAuthStateChange((event, session) => {
      if (!active) return;
      if (session) {
        setAccountUser(session.user);
      } else if (event === "SIGNED_OUT") {
        setAccountUser(null);
        setAccountRole(null);
      }
    });

    function handleProfileUpdated(event: Event) {
      const detail = (event as CustomEvent<{ displayName?: unknown }>).detail;
      if (typeof detail?.displayName !== "string") return;
      setAccountUser((current) =>
        current ? { ...current, display_name: detail.displayName as string } : current,
      );
    }

    window.addEventListener("viread:profile-updated", handleProfileUpdated);

    void Promise.all([
      authService.getCurrentUser(),
      authService.getCurrentRole(),
      profileService.get().catch(() => null),
    ])
      .then(([user, role, profile]) => {
        if (!active) return;
        setAccountUser(
          user && profile?.display_name?.trim()
            ? { ...user, display_name: profile.display_name }
            : user,
        );
        setAccountRole(role);
      })
      .catch(() => {
        if (!active) return;
        setAccountUser(null);
        setAccountRole(null);
      });

    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("viread:profile-updated", handleProfileUpdated);
    };
  }, [authService, profileService]);

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
            <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
              <div className="flex w-full min-w-0 max-w-full flex-1 items-center gap-2 overflow-x-auto overscroll-x-contain pb-1 sm:w-auto sm:max-w-none sm:flex-none sm:flex-wrap sm:justify-end sm:overflow-visible sm:pb-0">
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
                        isActive ? "bg-sky text-primary-hover" : "bg-white hover:bg-sky",
                      )}
                      href={href}
                      key={href}
                    >
                      <Icon aria-hidden="true" className="size-5 shrink-0 sm:hidden" />
                      <span className="whitespace-nowrap">{label}</span>
                    </Link>
                  );
                })}
              </div>
              <AccountAvatarMenu
                displayName={accountUser?.display_name ?? null}
                email={accountUser?.email ?? null}
                isSigningOut={isSigningOut}
                onSignOut={handleSignOut}
                role={roleLabel(accountRole)}
              />
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
