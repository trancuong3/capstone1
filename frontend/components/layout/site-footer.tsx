"use client";

import Link from "next/link";

import { ViReadLogo } from "@/components/common/viread-logo";
import { useTranslations } from "@/hooks/use-i18n";
import { VIREAD_SUPPORT_EMAIL } from "@/lib/config/contact";
import { cn } from "@/lib/utils/cn";

interface SiteFooterProps {
  readonly className?: string;
  readonly variant?: "public" | "admin" | "admin-login" | "parent";
}

const linkClass =
  "underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export function SiteFooter({ className, variant = "public" }: SiteFooterProps) {
  const tCommon = useTranslations("common");
  const tNav = useTranslations("navigation");
  const isParent = variant === "parent";
  const isAdminLogin = variant === "admin-login";
  const isAdmin = variant === "admin" || isAdminLogin;

  const parentLinks = [
    { href: "/dashboard", label: tNav("parent.dashboard") },
    { href: "/reports", label: tNav("parent.reports") },
    { href: "/sessions", label: tNav("parent.sessionsLong") },
    { href: "/children", label: tNav("parent.children") },
    { href: "/profile", label: tNav("parent.parentProfileLong") },
    { href: "/help-support", label: tNav("parent.helpSupport") },
  ] as const;

  return (
    <footer
      aria-label={tNav("footer.ariaLabel")}
      className={cn(
        "site-colophon mt-auto w-full shrink-0 border-t border-border bg-white",
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 py-6 sm:px-8 xl:px-16">
        <ViReadLogo
          ariaLabel={
            isParent
              ? tNav("footer.logoDashboardAria")
              : tNav("footer.logoHomeAria")
          }
          href={
            isParent
              ? "/dashboard"
              : isAdminLogin
                ? "/admin/login"
                : isAdmin
                  ? "/admin/parents"
                  : "/login"
          }
          prefetch={isAdminLogin ? false : undefined}
        />
        {isParent ? (
          <div className="grid gap-6 md:grid-cols-3 md:gap-8">
            <section aria-labelledby="footer-viread-brand">
              <h2 className="font-bold text-ink" id="footer-viread-brand">
                {tCommon("brand.name")}
              </h2>
              <p className="mt-2 max-w-md text-sm leading-[1.4] text-muted">
                {tCommon("footer.parentDescription")}
              </p>
            </section>
            <section
              aria-labelledby="footer-viread-contact"
              className="min-w-0"
            >
              <h2 className="font-bold text-ink" id="footer-viread-contact">
                {tCommon("footer.contactHeading")}
              </h2>
              <address className="mt-2 space-y-1 text-sm not-italic text-muted">
                <p>{tCommon("footer.organization")}</p>
                <p>
                  <a
                    className={cn(linkClass, "break-all")}
                    href={"mailto:" + VIREAD_SUPPORT_EMAIL}
                  >
                    {VIREAD_SUPPORT_EMAIL}
                  </a>
                </p>
                <p>
                  <a className={linkClass} href="tel:0905373633">
                    {tCommon("footer.contactPhone")}
                  </a>
                </p>
              </address>
            </section>
            <nav aria-labelledby="footer-viread-links">
              <h2 className="font-bold text-ink" id="footer-viread-links">
                {tCommon("footer.quickLinksHeading")}
              </h2>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted">
                {parentLinks.map(({ href, label }) => (
                  <li key={href}>
                    <Link className={linkClass} href={href}>
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        ) : isAdmin ? (
          <p className="text-sm text-muted">{tCommon("footer.adminNotice")}</p>
        ) : null}
        <p
          className={cn("text-sm leading-[1.4] text-muted", isParent && "mt-4")}
        >
          {isAdmin
            ? tCommon("footer.adminCopyright", { year: 2026 })
            : tCommon("footer.copyright", { year: 2026 })}
        </p>
      </div>
    </footer>
  );
}
