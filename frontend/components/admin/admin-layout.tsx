"use client";

import {
  BookOpenCheck,
  ClipboardCheck,
  BrainCircuit,
  HeartPulse,
  LogOut,
  ScrollText,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ViReadLogo } from "@/components/common/viread-logo";
import { Button, ButtonSizeContext } from "@/components/common/button";
import { SiteFooter } from "@/components/layout/site-footer";
import { useAdminServices } from "@/hooks/use-admin-services";
import { cn } from "@/lib/utils/cn";

const links = [
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
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [hasSignOutError, setHasSignOutError] = useState(false);

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
          className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:not-sr-only focus:rounded-control focus:bg-white focus:px-4 focus:py-3 focus:font-bold focus:text-primary focus:shadow-lg"
          href="#admin-main-content"
        >
          Bỏ qua điều hướng, đến nội dung quản trị
        </a>
        <header className="shrink-0 border-b border-border bg-white">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-4 py-3 sm:px-8">
            <div className="mr-auto flex min-w-0 items-center gap-3">
              <ViReadLogo
                ariaLabel="ViRead - khu vực quản trị"
                href="/admin/parents"
                size="md"
              />
              <span className="rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary-hover">
                ADMIN
              </span>
            </div>
            <nav
              aria-label="Điều hướng quản trị"
              className="order-3 flex w-full gap-1 overflow-x-auto sm:order-2 sm:w-auto"
            >
              {links.map(({ href, label, icon: Icon }) => {
                const isActive =
                  pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 shrink-0 items-center gap-2 rounded-control px-3 text-sm font-bold focus-visible:outline-3 focus-visible:outline-primary",
                      isActive
                        ? "bg-sky text-primary-hover"
                        : "text-muted hover:bg-canvas",
                    )}
                    href={href}
                    key={href}
                  >
                    <Icon aria-hidden className="size-5" /> {label}
                  </Link>
                );
              })}
            </nav>
            <Button
              className="order-2 sm:order-3 sm:w-auto"
              disabled={isSigningOut}
              isLoading={isSigningOut}
              onClick={() => void handleSignOut()}
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
            className="mx-auto mt-4 w-full max-w-[1376px] px-4 font-bold text-danger sm:px-8"
            role="alert"
          >
            Chưa thể đăng xuất lúc này. Vui lòng thử lại.
          </p>
        ) : null}
        <main
          className="mx-auto w-full min-w-0 max-w-[1440px] flex-1 px-4 py-6 sm:px-8 sm:py-10"
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
