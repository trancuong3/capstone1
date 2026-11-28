import { ViReadLogo } from "@/components/common/viread-logo";
import { cn } from "@/lib/utils/cn";
import { ButtonLink } from "@/components/common/button";

interface SiteHeaderProps {
  readonly activeRoute?: "login" | "register";
  readonly className?: string;
  readonly variant?: "auth" | "admin-login";
}

/** Public branding only. Parent/Admin navigation stays in its existing layout. */
export function SiteHeader({
  activeRoute,
  className,
  variant = "auth",
}: SiteHeaderProps) {
  const isAdminLogin = variant === "admin-login";

  return (
    <header
      className={cn(
        "w-full shrink-0 border-b border-border bg-white",
        className,
      )}
    >
      <div className="mx-auto flex min-h-24 w-full max-w-[1376px] flex-col items-start justify-between gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-6 sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <ViReadLogo
            ariaLabel={
              isAdminLogin
                ? "ViRead - Đăng nhập quản trị"
                : "ViRead - Đăng nhập"
            }
            href={isAdminLogin ? "/admin/login" : "/login"}
            size="md"
          />
          {isAdminLogin ? (
            <span className="rounded-full bg-sky px-3 py-1 text-xs font-semibold tracking-wide text-primary-hover">
              ADMIN
            </span>
          ) : null}
        </div>

        {isAdminLogin ? (
          <p className="text-label font-medium text-muted">Khu vực quản trị</p>
        ) : (
          <nav
            aria-label="Tài khoản ViRead"
            className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto"
          >
            <ButtonLink
              aria-current={activeRoute === "login" ? "page" : undefined}
              href="/login"
              size="compact"
              variant="quiet"
              className="whitespace-nowrap border border-border sm:min-w-32"
            >
              Đăng nhập
            </ButtonLink>
            <ButtonLink
              aria-current={activeRoute === "register" ? "page" : undefined}
              href="/register"
              size="compact"
              className="whitespace-nowrap sm:min-w-32"
            >
              Đăng ký
            </ButtonLink>
          </nav>
        )}
      </div>
    </header>
  );
}
