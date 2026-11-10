"use client";

import {
  BarChart3,
  CalendarClock,
  CircleHelp,
  History,
  LayoutDashboard,
  LogOut,
  Settings,
  UserRound,
  UsersRound,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  ProfileAvatar,
  resolveDisplayName,
} from "@/components/common/profile-avatar";
import { ViReadLogo } from "@/components/common/viread-logo";
import { SiteFooter } from "@/components/layout/site-footer";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useAuthService } from "@/hooks/use-auth-service";
import { useProfileService } from "@/hooks/use-profile-service";
import { cn } from "@/lib/utils/cn";
import type { ParentProfileDTO } from "@/types/profile";

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
] as const;

function routeMatchesPath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function getActiveNavigationHref(pathname: string): string | undefined {
  return [...navigationItems]
    .filter(({ href }) => routeMatchesPath(pathname, href))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;
}

function roleLabel(role: ParentProfileDTO["role"] | undefined): string | null {
  if (role === "parent") return "Phụ huynh";
  if (role === "admin") return "Quản trị viên";
  return null;
}

export function AppShell({ children }: AppShellProps) {
  const authRuntime = useAuthRuntime();
  const authService = useAuthService();
  const profileService = useProfileService();
  const pathname = usePathname();
  const activeNavigationHref = getActiveNavigationHref(pathname);
  const router = useRouter();
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const avatarButtonRef = useRef<HTMLButtonElement>(null);
  const [profile, setProfile] = useState<ParentProfileDTO | null>(null);
  const [accountMenu, setAccountMenu] = useState<{
    isOpen: boolean;
    pathname: string;
  }>({ isOpen: false, pathname: "" });
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [hasSignOutError, setHasSignOutError] = useState(false);
  const isAccountMenuVisible =
    accountMenu.isOpen && accountMenu.pathname === pathname;
  const isChildOnboarding = pathname === "/children/new";
  const isBookRoute = pathname === "/books" || pathname.startsWith("/books/");
  const isReadingRoute = pathname.startsWith("/reading/");
  const isImmersiveRoute = isBookRoute || isReadingRoute;
  const user = authRuntime.session?.user ?? null;
  const displayName = resolveDisplayName(
    profile?.display_name,
    user?.display_name,
    profile?.email ?? user?.email,
  );
  const email = profile?.email ?? user?.email ?? null;

  useEffect(() => {
    let isActive = true;

    void profileService
      .get()
      .then((nextProfile) => {
        if (isActive) setProfile(nextProfile);
      })
      .catch(() => {
        if (isActive) setProfile(null);
      });

    return () => {
      isActive = false;
    };
  }, [profileService]);

  useEffect(() => {
    function handleProfileUpdated(event: Event) {
      const detail = (event as CustomEvent<{ displayName?: unknown }>).detail;
      if (typeof detail?.displayName !== "string") return;
      setProfile((current) =>
        current
          ? { ...current, display_name: detail.displayName as string }
          : current,
      );
    }

    window.addEventListener("viread:profile-updated", handleProfileUpdated);
    return () =>
      window.removeEventListener(
        "viread:profile-updated",
        handleProfileUpdated,
      );
  }, []);

  useEffect(() => {
    if (!isAccountMenuVisible) return;
    accountMenuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus();
  }, [isAccountMenuVisible]);

  useEffect(() => {
    if (!isAccountMenuVisible) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !accountMenuRef.current?.contains(event.target)
      ) {
        setAccountMenu((current) => ({ ...current, isOpen: false }));
      }
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountMenu((current) => ({ ...current, isOpen: false }));
        avatarButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isAccountMenuVisible]);

  async function handleSignOut() {
    if (isSigningOut) return;

    setHasSignOutError(false);
    setIsSigningOut(true);

    try {
      await authService.signOut();
      setAccountMenu((current) => ({ ...current, isOpen: false }));
      router.replace("/login");
      router.refresh();
    } catch {
      setHasSignOutError(true);
    } finally {
      setIsSigningOut(false);
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    const items = accountMenuRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    );
    if (!items?.length) return;

    event.preventDefault();
    const currentIndex = Array.from(items).indexOf(
      document.activeElement as HTMLElement,
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? currentIndex < 0
              ? 0
              : (currentIndex + 1) % items.length
            : currentIndex < 0
              ? items.length - 1
              : (currentIndex - 1 + items.length) % items.length;

    items[nextIndex]?.focus();
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <a
        className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:not-sr-only focus:rounded-control focus:bg-white focus:px-4 focus:py-3 focus:font-bold focus:text-primary focus:shadow-lg"
        href="#main-content"
      >
        Bỏ qua điều hướng, đến nội dung
      </a>
      <header className="shrink-0 border-b border-border bg-white px-4 py-4 sm:px-8">
        <nav
          aria-label="Điều hướng dành cho ba mẹ"
          className={cn(
            "mx-auto flex w-full min-w-0 max-w-[1376px]",
            isChildOnboarding
              ? "min-h-11 items-center"
              : "flex-col gap-3 lg:min-h-16 lg:flex-row lg:items-center lg:gap-4",
          )}
        >
          <div
            className={cn(
              "flex w-full min-w-0 items-center justify-between gap-4 lg:contents",
              isChildOnboarding && "justify-start",
            )}
          >
            <ViReadLogo
              ariaLabel="ViRead - về tổng quan"
              className={cn(
                isChildOnboarding ? "text-label" : "min-w-0 lg:order-1",
              )}
              href="/dashboard"
              size="md"
            />
            {!isChildOnboarding ? (
              <div
                className="relative z-50 shrink-0 lg:order-3"
                ref={accountMenuRef}
              >
                <button
                  aria-controls="parent-account-menu"
                  aria-expanded={isAccountMenuVisible}
                  aria-haspopup="menu"
                  aria-label={
                    isAccountMenuVisible
                      ? "Đóng menu tài khoản"
                      : "Mở menu tài khoản"
                  }
                  className="flex size-11 items-center justify-center rounded-full border border-border bg-white p-0.5 shadow-sm transition-colors hover:border-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
                  onClick={() => {
                    if (isAccountMenuVisible) {
                      setAccountMenu((current) => ({
                        ...current,
                        isOpen: false,
                      }));
                    } else {
                      setAccountMenu({ isOpen: true, pathname });
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && !isAccountMenuVisible) {
                      event.preventDefault();
                      setAccountMenu({ isOpen: true, pathname });
                    }
                  }}
                  ref={avatarButtonRef}
                  type="button"
                >
                  <ProfileAvatar
                    ariaLabel="Ảnh đại diện tài khoản"
                    displayName={displayName}
                    imageUrl={profile?.avatar_url}
                    size="sm"
                  />
                </button>

                <div
                  aria-label="Menu tài khoản"
                  className="absolute right-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-card border border-border bg-white p-3 shadow-lg"
                  hidden={!isAccountMenuVisible}
                  id="parent-account-menu"
                  onKeyDown={handleMenuKeyDown}
                  role="menu"
                >
                  <div
                    className="flex flex-col items-center gap-2 px-3 py-3 text-center"
                  >
                    <ProfileAvatar
                      ariaLabel="Ảnh đại diện tài khoản"
                      displayName={displayName}
                      imageUrl={profile?.avatar_url}
                      size="lg"
                    />
                    <p className="max-w-full break-words text-label font-extrabold text-ink">
                      {displayName ?? "Tài khoản ViRead"}
                    </p>
                    {roleLabel(profile?.role) ? (
                      <p className="text-sm font-semibold text-primary">
                        {roleLabel(profile?.role)}
                      </p>
                    ) : null}
                    {email ? (
                      <p className="max-w-full break-all text-sm text-muted">
                        {email}
                      </p>
                    ) : null}
                  </div>

                  <div className="my-2 border-t border-border" />
                  <Link
                    aria-current={
                      routeMatchesPath(pathname, "/profile")
                        ? "page"
                        : undefined
                    }
                    className={cn(
                      "flex min-h-12 items-center gap-3 rounded-control px-3 text-label font-bold text-ink outline-none focus-visible:ring-3 focus-visible:ring-primary",
                      routeMatchesPath(pathname, "/profile")
                        ? "bg-sky text-primary-hover"
                        : "hover:bg-sky",
                    )}
                    href="/profile"
                    onClick={() =>
                      setAccountMenu((current) => ({
                        ...current,
                        isOpen: false,
                      }))
                    }
                    role="menuitem"
                    tabIndex={isAccountMenuVisible ? 0 : -1}
                  >
                    <UserRound aria-hidden="true" className="size-5" />
                    Hồ sơ ba mẹ
                  </Link>
                  <Link
                    aria-current={
                      routeMatchesPath(pathname, "/children")
                        ? "page"
                        : undefined
                    }
                    className={cn(
                      "flex min-h-12 items-center gap-3 rounded-control px-3 text-label font-bold text-ink outline-none focus-visible:ring-3 focus-visible:ring-primary",
                      routeMatchesPath(pathname, "/children")
                        ? "bg-sky text-primary-hover"
                        : "hover:bg-sky",
                    )}
                    href="/children"
                    onClick={() =>
                      setAccountMenu((current) => ({
                        ...current,
                        isOpen: false,
                      }))
                    }
                    role="menuitem"
                    tabIndex={isAccountMenuVisible ? 0 : -1}
                  >
                    <UsersRound aria-hidden="true" className="size-5" />
                    Hồ sơ bé
                  </Link>

                  <div className="my-2 border-t border-border" />
                  <Link
                    aria-current={
                      routeMatchesPath(pathname, "/settings")
                        ? "page"
                        : undefined
                    }
                    className={cn(
                      "flex min-h-12 items-center gap-3 rounded-control px-3 text-label font-bold text-ink outline-none focus-visible:ring-3 focus-visible:ring-primary",
                      routeMatchesPath(pathname, "/settings")
                        ? "bg-sky text-primary-hover"
                        : "hover:bg-sky",
                    )}
                    href="/settings"
                    onClick={() =>
                      setAccountMenu((current) => ({ ...current, isOpen: false }))
                    }
                    role="menuitem"
                    tabIndex={isAccountMenuVisible ? 0 : -1}
                  >
                    <Settings aria-hidden="true" className="size-5" />
                    Cài đặt
                  </Link>
                  <Link
                    aria-current={
                      routeMatchesPath(pathname, "/help-support")
                        ? "page"
                        : undefined
                    }
                    className={cn(
                      "flex min-h-12 items-center gap-3 rounded-control px-3 text-label font-bold text-ink outline-none focus-visible:ring-3 focus-visible:ring-primary",
                      routeMatchesPath(pathname, "/help-support")
                        ? "bg-sky text-primary-hover"
                        : "hover:bg-sky",
                    )}
                    href="/help-support"
                    onClick={() =>
                      setAccountMenu((current) => ({ ...current, isOpen: false }))
                    }
                    role="menuitem"
                    tabIndex={isAccountMenuVisible ? 0 : -1}
                  >
                    <CircleHelp aria-hidden="true" className="size-5" />
                    Trợ giúp &amp; hỗ trợ
                  </Link>

                  <div className="my-2 border-t border-border" />
                  <button
                    className="flex min-h-12 w-full items-center gap-3 rounded-control px-3 text-left text-label font-bold text-ink outline-none hover:bg-sky focus-visible:ring-3 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-55"
                    disabled={isSigningOut}
                    onClick={() => void handleSignOut()}
                    role="menuitem"
                    tabIndex={isAccountMenuVisible ? 0 : -1}
                    type="button"
                  >
                    <LogOut aria-hidden="true" className="size-5" />
                    {isSigningOut ? "Đang đăng xuất…" : "Đăng xuất"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {!isChildOnboarding ? (
            <div
              className="flex w-full min-w-0 flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain pb-1 lg:order-2 lg:w-auto lg:flex-1 lg:justify-end lg:overflow-visible lg:pb-0"
              data-testid="parent-primary-navigation"
            >
              {navigationItems.map(({ href, icon: Icon, label }) => {
                const isActive = activeNavigationHref === href;

                return (
                  <Link
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-control px-2.5 text-center text-[13px] font-bold text-ink transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:h-12 sm:gap-2 sm:px-3 sm:text-label",
                      isActive
                        ? "bg-sky text-primary-hover"
                        : "bg-white hover:bg-sky",
                    )}
                    href={href}
                    key={href}
                    onClick={() =>
                      setAccountMenu((current) => ({
                        ...current,
                        isOpen: false,
                      }))
                    }
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
        id="main-content"
        tabIndex={-1}
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
