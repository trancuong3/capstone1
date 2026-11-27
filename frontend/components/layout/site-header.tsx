"use client";

import { ButtonLink } from "@/components/common/button";
import { ViReadLogo } from "@/components/common/viread-logo";
import { LanguageSelector } from "@/components/i18n/language-selector";
import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

interface SiteHeaderProps {
  readonly className?: string;
  readonly variant?: "auth" | "admin-login";
}

/** Public branding only. Parent/Admin navigation stays in its existing layout. */
export function SiteHeader({ className, variant = "auth" }: SiteHeaderProps) {
  const tAuth = useTranslations("auth");
  const tNav = useTranslations("navigation");
  const isAdminLogin = variant === "admin-login";

  return (
    <header
      className={cn(
        "w-full shrink-0 border-b border-border bg-white",
        className,
      )}
    >
      <div className="mx-auto flex min-h-14 w-full max-w-[1376px] flex-wrap items-center justify-between gap-2 px-3 py-2 sm:min-h-20 sm:flex-nowrap sm:gap-6 sm:px-8 sm:py-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <ViReadLogo
            ariaLabel={
              isAdminLogin
                ? tAuth("adminLogin.logoAria")
                : tAuth("login.logoAria")
            }
            href={isAdminLogin ? "/admin/login" : "/login"}
            size="md"
          />
          {isAdminLogin ? (
            <span className="rounded-full bg-sky px-2.5 py-1 text-xs font-semibold tracking-wide text-primary-hover sm:px-3">
              {tAuth("adminLogin.badge")}
            </span>
          ) : null}
        </div>

        {isAdminLogin ? (
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <p className="hidden truncate text-xs font-medium text-muted sm:block sm:text-label">
              {tAuth("adminLogin.areaLabel")}
            </p>
            <LanguageSelector variant="compact" />
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2 sm:flex-nowrap sm:gap-3">
            <nav
              aria-label={tNav("accountMenu.accountNavAria")}
              className="flex shrink-0 items-center gap-2 sm:gap-3"
            >
              <ButtonLink
                href="/login"
                size="compact"
                variant="quiet"
                className="h-11 min-h-11! w-auto whitespace-nowrap border border-border px-3 py-0! text-sm sm:min-w-32 sm:px-4 sm:text-label"
              >
                {tAuth("login.submit")}
              </ButtonLink>
              <ButtonLink
                href="/register"
                size="compact"
                className="h-11 min-h-11! w-auto whitespace-nowrap px-3 py-0! text-sm sm:min-w-32 sm:px-4 sm:text-label"
              >
                {tAuth("register.submit")}
              </ButtonLink>
            </nav>
            <LanguageSelector variant="compact" />
          </div>
        )}
      </div>
    </header>
  );
}
