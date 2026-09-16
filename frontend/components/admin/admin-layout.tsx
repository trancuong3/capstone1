"use client";

import { BookOpenCheck, HeartPulse, LogOut, ScrollText } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useAdminServices } from "@/hooks/use-admin-services";
import { cn } from "@/lib/utils/cn";

const links = [
  { href: "/admin/books", label: "Kho sách", icon: BookOpenCheck },
  { href: "/admin/audit-logs", label: "Nhật ký", icon: ScrollText },
  { href: "/admin/health", label: "Vận hành", icon: HeartPulse },
];

export function AdminLayout({ children }: { children: ReactNode }) {
  const { auth } = useAdminServices();
  const pathname = usePathname();
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    if (isSigningOut) return;

    setIsSigningOut(true);
    try {
      await auth.signOut();
    } catch {
      // The local session must still leave the protected UI on sign-out failure.
    } finally {
      router.replace("/admin/login");
      setIsSigningOut(false);
    }
  }

  if (pathname === "/admin/login") return <>{children}</>;
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-4 px-4 py-4 sm:px-8">
          <Link
            className="mr-auto flex min-h-11 items-center rounded-control text-xl font-black text-primary focus-visible:outline-3 focus-visible:outline-primary"
            href="/admin/books"
          >
            ReadAlong <span className="text-ink">Admin</span>
          </Link>
          <nav
            aria-label="Điều hướng quản trị"
            className="order-3 flex w-full gap-1 overflow-x-auto sm:order-2 sm:w-auto"
          >
            {links.map(({ href, label, icon: Icon }) => (
              <Link
                aria-current={pathname.startsWith(href) ? "page" : undefined}
                className={cn(
                  "flex min-h-12 shrink-0 items-center gap-2 rounded-control px-3 font-bold focus-visible:outline-3 focus-visible:outline-primary",
                  pathname.startsWith(href)
                    ? "bg-sky text-primary-hover"
                    : "text-muted hover:bg-canvas",
                )}
                href={href}
                key={href}
              >
                <Icon aria-hidden className="size-5" /> {label}
              </Link>
            ))}
          </nav>
          <button
            className="order-2 flex min-h-12 items-center gap-2 rounded-control px-3 font-bold text-muted hover:bg-canvas focus-visible:outline-3 focus-visible:outline-primary sm:order-3"
            disabled={isSigningOut}
            onClick={() => void handleSignOut()}
            type="button"
          >
            <LogOut aria-hidden className="size-5" />{" "}
            {isSigningOut ? "Đang đăng xuất…" : "Đăng xuất"}
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-8 sm:py-10">
        {children}
      </main>
    </div>
  );
}
