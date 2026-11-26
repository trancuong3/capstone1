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
import { LanguageSelector } from "@/components/i18n/language-selector";
import {
  ADMIN_MOBILE_MORE_ITEMS,
  ADMIN_MOBILE_PRIMARY_TABS,
  MobileBottomNav,
} from "@/components/layout/mobile-bottom-nav";
import { SiteFooter } from "@/components/layout/site-footer";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
import { clearPrivateMediaMemoryCache } from "@/lib/api/api-client";
import { resetApiReadCacheForActorSwitch } from "@/lib/api/read-cache";
import { clearUserCache } from "@/lib/cache/user-query-cache";
import { cn } from "@/lib/utils/cn";

const links = [
  { href: "/admin/karaoke", labelKey: "layout.nav.karaoke", icon: Music2 },
  { href: "/admin/parents", labelKey: "layout.nav.parents", icon: UsersRound },
  { href: "/admin/books", labelKey: "layout.nav.books", icon: BookOpenCheck },
  {
    href: "/admin/metadata-quality",
    labelKey: "layout.nav.metadataQuality",
    icon: ClipboardCheck,
  },
  {
    href: "/admin/audit-logs",
    labelKey: "layout.nav.auditLogs",
    icon: ScrollText,
  },
  {
    href: "/admin/viread-training",
    labelKey: "layout.nav.training",
    icon: BrainCircuit,
  },
  { href: "/admin/health", labelKey: "layout.nav.health", icon: HeartPulse },
] as const;

export function AdminLayout({ children }: { children: ReactNode }) {
  const { auth } = useAdminServices();
  const t = useTranslations("admin");
  const pathname = usePathname();
  const router = useRouter();
  const activeNavigationRef = useRef<HTMLAnchorElement>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [hasSignOutError, setHasSignOutError] = useState(false);
  const [isDesktopSidebar, setIsDesktopSidebar] = useState(false);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mediaQuery = window.matchMedia("(min-width: 1280px)");
    const syncViewport = () => setIsDesktopSidebar(mediaQuery.matches);
    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);
    return () => mediaQuery.removeEventListener("change", syncViewport);
  }, []);

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
          className="sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[100] focus:not-sr-only focus:rounded-control focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:text-primary focus:shadow-lg"
          href="#admin-main-content"
        >
          {t("layout.skipToContent")}
        </a>
        <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 xl:static xl:bg-white">
          <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between gap-2 px-3 sm:gap-3 sm:px-6 xl:grid xl:h-auto xl:min-h-18 xl:grid-cols-[auto_minmax(0,1fr)_auto] xl:gap-x-2 xl:px-16">
            <div className="flex min-h-12 min-w-0 items-center gap-2 sm:gap-3">
              <ViReadLogo
                ariaLabel={t("layout.logoAria")}
                href="/admin/parents"
                size="md"
              />
              <span className="max-[360px]:sr-only truncate border-s border-border ps-2 text-xs font-semibold text-muted sm:ps-3 sm:text-sm">
                {t("layout.badge")}
              </span>
            </div>
            <nav
              aria-label={t("layout.navAria")}
              className="hidden min-w-0 items-center gap-1 py-1 xl:flex xl:flex-nowrap xl:justify-end"
            >
              {links.map(({ href, labelKey, icon: Icon }) => {
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
                    <Icon aria-hidden className="size-4 xl:hidden" />{" "}
                    {t(labelKey)}
                  </Link>
                );
              })}
            </nav>
            <div className="ms-auto flex shrink-0 items-center gap-1.5 sm:gap-2 xl:ms-0 xl:mt-auto xl:flex-col xl:items-stretch xl:gap-2">
              <LanguageSelector
                align="end"
                className={cn(
                  "max-[380px]:max-w-[7.25rem]",
                  // Sidebar .admin-workspace > header button unlayered styles on xl must be overridden so trigger & dialog stay crisp.
                  "xl:[&>button]:!mt-0 xl:[&>button]:!w-full xl:[&>button]:!justify-between xl:[&>button]:!rounded-full xl:[&>button]:!border xl:[&>button]:!border-[#aacfc2] xl:[&>button]:!bg-white xl:[&>button]:!px-2.5 xl:[&>button]:!text-[#144f49]",
                  "xl:[&_[data-language-sheet]>button]:!mt-0 xl:[&_[data-language-sheet]>button]:!border-t-0 xl:[&_[data-language-sheet]>button]:!rounded-none xl:[&_[data-language-sheet]>button]:!bg-ink/40",
                  "xl:[&_[data-language-sheet]_section_button]:!mt-0 xl:[&_[data-language-sheet]_section_button]:!border-t-0 xl:[&_[data-language-sheet]_section_button]:!rounded-control xl:[&_[data-language-sheet]_section_button]:!text-ink",
                  "xl:[&_[data-language-sheet]_section_[role=option]]:!justify-start xl:[&_[data-language-sheet]_section_[aria-selected=true]]:!bg-sky/50 xl:[&_[data-language-sheet]_section_[aria-selected=true]]:!text-primary",
                  "xl:[&_[data-language-sheet]_section_button[aria-label]]:!justify-center xl:[&_[data-language-sheet]_section_button[aria-label]]:!rounded-full xl:[&_[data-language-sheet]_section_button[aria-label]]:!text-muted",
                )}
                presentation={isDesktopSidebar ? "sheet" : "auto"}
                variant="compact"
              />
              <Button
                className="w-auto shrink-0 px-2.5 sm:px-3 xl:!mt-0 xl:w-full"
                disabled={isSigningOut}
                isLoading={isSigningOut}
                onClick={() => void handleSignOut()}
                size="compact"
                type="button"
                variant="quiet"
              >
                {!isSigningOut ? (
                  <LogOut aria-hidden className="size-5" />
                ) : null}
                <span className="max-[400px]:sr-only">
                  {isSigningOut ? t("layout.signingOut") : t("layout.signOut")}
                </span>
              </Button>
            </div>
          </div>
        </header>
        {hasSignOutError ? (
          <p
            className="mx-auto mt-4 w-full max-w-[1360px] px-4 font-semibold text-danger sm:px-6 xl:px-10"
            role="alert"
          >
            {t("layout.signOutError")}
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
          ariaLabel={t("layout.mobileNavAria")}
          moreItems={ADMIN_MOBILE_MORE_ITEMS}
          moreTitle={t("layout.moreTitle")}
          pathname={pathname}
          sheetId="admin-mobile-more-sheet"
          tabs={ADMIN_MOBILE_PRIMARY_TABS}
        />
      </div>
    </ButtonSizeContext.Provider>
  );
}
