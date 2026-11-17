"use client";

import {
  BookOpenCheck,
  ClipboardCheck,
  BrainCircuit,
  HeartPulse,
  LogOut,
  Music2,
  ScrollText,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ViReadLogo } from "@/components/common/viread-logo";
import { Button, ButtonSizeContext } from "@/components/common/button";
import { SiteFooter } from "@/components/layout/site-footer";
import { useAdminServices } from "@/hooks/use-admin-services";
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
    if (typeof activeLink?.scrollIntoView !== "function") return;
    activeLink.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  async function handleSignOut() {
    if (isSigningOut) return;

    setHasSignOutError(false);
    setIsSigningOut(true);
    try {
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
      <div className="flex min-h-dvh w-full flex-col bg-canvas">
        <a
          className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:not-sr-only focus:rounded-control focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:text-primary focus:shadow-lg"
          href="#admin-main-content"
        >
          Bỏ qua điều hướng, đến nội dung quản trị
        </a>
        <header className="shrink-0 border-b border-border bg-white">
          <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-8 xl:grid xl:min-h-24 xl:grid-cols-[auto_minmax(0,1fr)_auto] xl:gap-x-2 xl:px-16">
            <div className="order-1 flex min-h-12 items-center gap-3 xl:order-none">
              <ViReadLogo
                ariaLabel="ViRead - khu vực quản trị"
                href="/admin/parents"
                size="md"
              />
              <span className="rounded-control bg-sky px-2.5 py-1 text-xs font-semibold text-primary-hover">
                ADMIN
              </span>
            </div>
            <nav
              aria-label="Điều hướng quản trị"
              className="order-3 flex w-full min-w-0 flex-1 flex-wrap items-center gap-1 py-1 xl:order-none xl:ml-0 xl:flex-nowrap xl:justify-end"
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
                        ? "bg-sky text-primary-hover"
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
              className="order-2 ml-auto w-auto shrink-0 px-3 xl:order-none xl:ml-0"
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
          className="mx-auto w-full min-w-0 max-w-[1360px] flex-1 px-4 py-8 sm:px-6 sm:py-10 xl:px-10"
          id="admin-main-content"
          tabIndex={-1}
        >
          {children}
        </main>
        <SiteFooter variant="admin" />
      </div>
    </ButtonSizeContext.Provider>
  );
}
