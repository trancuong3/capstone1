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
import { useState, type ReactNode } from "react";
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
      <div className="flex min-h-dvh w-full flex-col bg-canvas lg:flex-row">
        <a
          className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:not-sr-only focus:rounded-control focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:text-primary focus:shadow-lg"
          href="#admin-main-content"
        >
          Bỏ qua điều hướng, đến nội dung quản trị
        </a>
        <aside className="flex shrink-0 flex-col bg-white lg:min-h-dvh lg:w-60 lg:border-r lg:border-border lg:px-5 lg:py-6">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-6 lg:border-b-0 lg:px-0 lg:py-0">
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
            className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2 lg:mt-8 lg:flex-1 lg:flex-col lg:overflow-visible lg:border-0 lg:px-0 lg:py-0"
          >
            {links.map(({ href, label, icon: Icon }) => {
              const isActive =
                pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex min-h-10 shrink-0 items-center gap-2 rounded-control px-3 text-sm font-medium focus-visible:outline-3 focus-visible:outline-primary lg:min-h-11 lg:gap-3",
                    isActive
                      ? "bg-sky font-semibold text-primary-hover"
                      : "text-muted hover:bg-canvas",
                  )}
                  href={href}
                  key={href}
                >
                  <Icon aria-hidden className="size-4 lg:size-[18px]" /> {label}
                </Link>
              );
            })}
          </nav>
          <Button
            className="mx-4 my-3 w-auto self-end lg:mx-0 lg:mt-auto lg:w-full"
            disabled={isSigningOut}
            isLoading={isSigningOut}
            onClick={() => void handleSignOut()}
            type="button"
            variant="quiet"
          >
            {!isSigningOut ? <LogOut aria-hidden className="size-4" /> : null}
            {isSigningOut ? "Đang đăng xuất…" : "Đăng xuất"}
          </Button>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {hasSignOutError ? (
            <p
              className="mx-auto mt-4 w-full max-w-[1376px] px-4 font-semibold text-danger sm:px-6 xl:px-10"
              role="alert"
            >
              Chưa thể đăng xuất lúc này. Vui lòng thử lại.
            </p>
          ) : null}
          <main
            className="mx-auto w-full min-w-0 max-w-[1440px] flex-1 px-4 py-6 sm:px-6 sm:py-8 xl:px-10"
            id="admin-main-content"
            tabIndex={-1}
          >
            {children}
          </main>
          <SiteFooter variant="admin" />
        </div>
      </div>
    </ButtonSizeContext.Provider>
  );
}
