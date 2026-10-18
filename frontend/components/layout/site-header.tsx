import { BookOpen } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils/cn";

interface SiteHeaderProps {
  readonly className?: string;
  readonly variant?: "auth" | "admin-login";
}

/** Public branding only. Parent/Admin navigation stays in its existing layout. */
export function SiteHeader({ className, variant = "auth" }: SiteHeaderProps) {
  const isAdminLogin = variant === "admin-login";

  return (
    <header
      className={cn(
        "w-full shrink-0 border-b border-border bg-white",
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-[1376px] flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-8">
        <Link
          aria-label={
            isAdminLogin
              ? "ViRead - đăng nhập quản trị"
              : "ViRead - đăng nhập"
          }
          className="inline-flex min-h-11 w-fit max-w-full flex-wrap items-center gap-2 rounded-control text-label font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:text-body"
          href={isAdminLogin ? "/admin/login" : "/login"}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sky text-primary">
            <BookOpen aria-hidden="true" className="size-5" />
          </span>
          <span className="tracking-tight">ViRead</span>
          {isAdminLogin ? (
            <span className="rounded-full bg-sky px-3 py-1 text-sm font-bold text-primary-hover">
              ADMIN
            </span>
          ) : null}
        </Link>

        {isAdminLogin ? (
          <p className="text-label font-bold text-muted">Khu vực quản trị</p>
        ) : (
          <nav
            aria-label="Điều hướng tài khoản"
            className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto sm:flex-wrap"
          >
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-control border border-border bg-white px-4 py-3 text-center text-label font-bold text-ink transition-colors hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
              href="/login"
            >
              Đăng nhập
            </Link>
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-control bg-primary px-4 py-3 text-center text-label font-bold text-white transition-colors hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
              href="/register"
            >
              Đăng ký
            </Link>
          </nav>
        )}
      </div>
    </header>
  );
}
