import Link from "next/link";
import { ViReadLogo } from "@/components/common/viread-logo";
import { cn } from "@/lib/utils/cn";
import { VIREAD_SUPPORT_EMAIL } from "@/lib/config/contact";

interface SiteFooterProps {
  readonly className?: string;
  readonly variant?: "public" | "admin" | "parent";
}
const parentLinks = [
  { href: "/dashboard", label: "Tổng quan" },
  { href: "/reports", label: "Tiến bộ" },
  { href: "/sessions", label: "Lịch sử đọc" },
  { href: "/children", label: "Hồ sơ bé" },
  { href: "/profile", label: "Hồ sơ phụ huynh" },
  { href: "/help-support", label: "Trợ giúp & hỗ trợ" },
] as const;
const linkClass =
  "underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export function SiteFooter({ className, variant = "public" }: SiteFooterProps) {
  const isParent = variant === "parent";
  const isAdmin = variant === "admin";
  return (
    <footer
      aria-label="Thông tin ViRead"
      className={cn(
        "site-colophon mt-auto w-full shrink-0 border-t border-border bg-white",
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 py-6 sm:px-8 xl:px-16">
        <ViReadLogo
          ariaLabel={
            isParent
              ? "ViRead - Về tổng quan"
              : isAdmin
                ? "ViRead - Về quản trị"
                : "ViRead - Về trang đăng nhập"
          }
          href={isParent ? "/dashboard" : isAdmin ? "/admin/parents" : "/login"}
        />
        {isParent ? (
          <div className="grid gap-6 md:grid-cols-3 md:gap-8">
            <section aria-labelledby="footer-viread-brand">
              <h2 className="font-bold text-ink" id="footer-viread-brand">
                ViRead
              </h2>
              <p className="mt-2 max-w-md text-sm leading-[1.4] text-muted">
                Nền tảng đồng hành cùng ba mẹ, hỗ trợ trẻ phát triển kỹ năng đọc
                sách và theo dõi quá trình học tập.
              </p>
            </section>
            <section
              aria-labelledby="footer-viread-contact"
              className="min-w-0"
            >
              <h2 className="font-bold text-ink" id="footer-viread-contact">
                Thông tin liên hệ
              </h2>
              <address className="mt-2 space-y-1 text-sm not-italic text-muted">
                <p>Đại học Duy Tân</p>
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
                    0905373633
                  </a>
                </p>
              </address>
            </section>
            <nav aria-labelledby="footer-viread-links">
              <h2 className="font-bold text-ink" id="footer-viread-links">
                Truy cập nhanh
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
          <p className="text-sm text-muted">Khu vực quản trị ViRead.</p>
        ) : null}
        <p
          className={cn("text-sm leading-[1.4] text-muted", isParent && "mt-4")}
        >
          © 2026 ViRead.{!isAdmin ? " Bảo lưu mọi quyền." : ""}
        </p>
      </div>
    </footer>
  );
}
