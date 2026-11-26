"use client";

import {
  BookOpenCheck,
  BrainCircuit,
  ClipboardCheck,
  HeartPulse,
  LogOut,
  Music2,
  ScrollText,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { clearAdminBookAiBatchSessions } from "@/components/admin/admin-book-ai-batch-review";
import { Button, ButtonSizeContext } from "@/components/common/button";
import { ViReadLogo } from "@/components/common/viread-logo";
import {
  ADMIN_MOBILE_MORE_ITEMS,
  ADMIN_MOBILE_PRIMARY_TABS,
  MobileBottomNav,
} from "@/components/layout/mobile-bottom-nav";
import { SiteFooter } from "@/components/layout/site-footer";
import { useAdminServices } from "@/hooks/use-admin-services";
import { clearPrivateMediaMemoryCache } from "@/lib/api/api-client";
import { resetApiReadCacheForActorSwitch } from "@/lib/api/read-cache";
import { clearUserCache } from "@/lib/cache/user-query-cache";
import { cn } from "@/lib/utils/cn";

const links = [
  { href: "/admin/karaoke", label: "Bài hát", icon: Music2 },
  { href: "/admin/parents", label: "Phụ huynh", icon: UsersRound },
  { href: "/admin/books", label: "Kho sách", icon: BookOpenCheck },
  {
    href: "/admin/metadata-quality",
    label: "Chất lượng sách",
    icon: ClipboardCheck,
  },
  { href: "/admin/audit-logs", label: "Nhật ký", icon: ScrollText },
  {
    href: "/admin/viread-training",
    label: "Huấn luyện OCR",
    icon: BrainCircuit,
  },
  { href: "/admin/health", label: "Vận hành", icon: HeartPulse },
];

export function AdminLayout({ children }: { children: ReactNode }) {
  const { auth } = useAdminServices();
  const pathname = usePathname();
  const router = useRouter();
  const activeNavigationRef = useRef<HTMLAnchorElement>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [hasSignOutError, setHasSignOutError] = useState(false);

  useEffect(() => {
    const activeLink = activeNavigationRef.current;
    const navContainer = activeLink?.parentElement;
    if (
      !activeLink ||
      !navContainer ||
      navContainer.scrollWidth <= navContainer.clientWidth ||
      typeof activeLink.scrollIntoView !== "function"
    ) {
      return;
    }
    activeLink.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  async function handleSignOut() {
    if (isSigningOut) return;

    setHasSignOutError(false);
    setIsSigningOut(true);
    try {
      clearAdminBookAiBatchSessions();
      clearPrivateMediaMemoryCache();
      clearUserCache();
      resetApiReadCacheForActorSwitch();
      await auth.signOut();
      router.replace("/admin/login");
      router.refresh();
    } catch {
      setHasSignOutError(true);
    } finally {
      setIsSigningOut(false);
    }
  }

  if (pathname === "/admin/login") return <>{children}</>;
  return (
    <ButtonSizeContext.Provider value="compact">
      <div className="admin-workspace flex min-h-dvh w-full flex-col bg-canvas">
        <a
          className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:not-sr-only focus:rounded-control focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:text-primary focus:shadow-lg"
          href="#admin-main-content"
        >
          Bỏ qua điều hướng, đến nội dung quản trị
        </a>
        <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 backdrop-blur-sm xl:static xl:bg-white">
          <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between gap-3 px-3 sm:px-6 xl:grid xl:h-auto xl:min-h-18 xl:grid-cols-[auto_minmax(0,1fr)_auto] xl:gap-x-2 xl:px-16">
            <div className="flex min-h-12 items-center gap-2.5 sm:gap-3">
              <ViReadLogo
                ariaLabel="ViRead - khu vực quản trị"
                href="/admin/parents"
                size="md"
              />
              <span className="border-l border-border pl-2.5 text-xs font-semibold text-muted sm:pl-3 sm:text-sm">
                Quản trị
              </span>
            </div>
            <nav
              aria-label="Điều hướng quản trị"
              className="hidden min-w-0 items-center gap-1 py-1 xl:flex xl:flex-nowrap xl:justify-end"
            >
              {links.map(({ href, label, icon: Icon }) => {
                const isActive =
                  pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 shrink-0 items-center gap-1.5 rounded-control px-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:min-h-12 sm:px-2.5 sm:text-label",
                      isActive
                        ? "bg-ink text-white"
                        : "text-muted hover:bg-canvas",
                    )}
                    href={href}
                    key={href}
                    ref={isActive ? activeNavigationRef : undefined}
                  >
                    <Icon aria-hidden className="size-4 xl:hidden" /> {label}
                  </Link>
                );
              })}
            </nav>
            <Button
              className="ml-auto w-auto shrink-0 px-3 xl:ml-0"
              disabled={isSigningOut}
              isLoading={isSigningOut}
              onClick={() => void handleSignOut()}
              size="compact"
              type="button"
              variant="quiet"
            >
              {!isSigningOut ? <LogOut aria-hidden className="size-5" /> : null}
              {isSigningOut ? "Đang đăng xuất…" : "Đăng xuất"}
            </Button>
          </div>
        </header>
        {hasSignOutError ? (
          <p
            className="mx-auto mt-4 w-full max-w-[1360px] px-4 font-semibold text-danger sm:px-6 xl:px-10"
            role="alert"
          >
            Chưa thể đăng xuất lúc này. Vui lòng thử lại.
          </p>
        ) : null}
        <main
          className="mx-auto w-full min-w-0 max-w-[1360px] flex-1 tabular-nums px-4 pb-24 pt-5 sm:px-6 sm:pt-7 xl:px-10 xl:py-10"
          id="admin-main-content"
          tabIndex={-1}
        >
          {children}
        </main>
        <SiteFooter className="hidden lg:block" variant="admin" />
        <MobileBottomNav
          ariaLabel="Điều hướng quản trị trên di động"
          moreItems={ADMIN_MOBILE_MORE_ITEMS}
          moreTitle="Quản trị khác"
          pathname={pathname}
          sheetId="admin-mobile-more-sheet"
          tabs={ADMIN_MOBILE_PRIMARY_TABS}
        />
      </div>
    </ButtonSizeContext.Provider>
  );
}
