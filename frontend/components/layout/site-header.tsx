import { ViReadLogo } from "@/components/common/viread-logo";
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
        <div className="flex min-w-0 items-center gap-3">
          <ViReadLogo
            ariaLabel={
              isAdminLogin
                ? "ViRead - đăng nhập quản trị"
                : "ViRead - đăng nhập"
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
        ) : null}
      </div>
    </header>
  );
}
