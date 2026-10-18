import { Mail, MapPin, Phone } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils/cn";

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
] as const;

/** Keep this in document flow, outside main; the hosting layout sizes the page. */
export function SiteFooter({ className, variant = "public" }: SiteFooterProps) {
  const isParent = variant === "parent";
  const isAdmin = variant === "admin";

  return (
    <footer
      aria-label={isParent ? "Thông tin ViRead" : "Thông tin ViRead"}
      className={cn(
        "mt-auto w-full shrink-0 border-t border-border bg-white",
        className,
      )}
    >
      {isParent ? (
        <>
          <div className="mx-auto grid w-full max-w-[1376px] gap-8 px-4 py-8 sm:px-8 md:grid-cols-2 md:gap-10 lg:grid-cols-[1.2fr_1fr_0.8fr] lg:py-10">
            <section
              aria-labelledby="footer-viread-brand"
              className="min-w-0"
            >
              <h2
                className="text-xl font-black tracking-tight text-primary"
                id="footer-viread-brand"
              >
                ViRead
              </h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted">
                Nền tảng đồng hành cùng ba mẹ, hỗ trợ trẻ phát triển kỹ năng
                đọc sách và theo dõi quá trình học tập.
              </p>
            </section>

            <section
              aria-labelledby="footer-viread-contact"
              className="min-w-0"
            >
              <h2
                className="text-sm font-extrabold uppercase tracking-wide text-ink"
                id="footer-viread-contact"
              >
                Thông tin liên hệ
              </h2>
              <address className="mt-4 flex flex-col gap-3 text-sm not-italic leading-6 text-muted">
                <p className="flex items-start gap-3">
                  <MapPin
                    aria-hidden="true"
                    className="mt-1 size-4 shrink-0 text-primary"
                  />
                  <span>
                    <span className="font-bold text-ink">Địa chỉ: </span>
                    Đại học Duy Tân
                  </span>
                </p>
                <p className="flex items-start gap-3">
                  <Mail
                    aria-hidden="true"
                    className="mt-1 size-4 shrink-0 text-primary"
                  />
                  <span>
                    <span className="font-bold text-ink">Email: </span>
                    <a
                      className="break-words underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      href="mailto:viread@gmail.com"
                    >
                      viread@gmail.com
                    </a>
                  </span>
                </p>
                <p className="flex items-start gap-3">
                  <Phone
                    aria-hidden="true"
                    className="mt-1 size-4 shrink-0 text-primary"
                  />
                  <span>
                    <span className="font-bold text-ink">Số điện thoại: </span>
                    <a
                      className="underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      href="tel:0905373633"
                    >
                      0905373633
                    </a>
                  </span>
                </p>
              </address>
            </section>

            <nav
              aria-labelledby="footer-viread-links"
              className="min-w-0"
            >
              <h2
                className="text-sm font-extrabold uppercase tracking-wide text-ink"
                id="footer-viread-links"
              >
                Truy cập nhanh
              </h2>
              <ul className="mt-4 flex flex-col items-start gap-2.5 text-sm">
                {parentLinks.map(({ href, label }) => (
                  <li key={href}>
                    <Link
                      className="text-muted underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      href={href}
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <div className="border-t border-border bg-canvas">
            <p className="mx-auto w-full max-w-[1376px] px-4 py-4 text-sm leading-6 text-muted sm:px-8">
              © 2026 ViRead. Bảo lưu mọi quyền.
            </p>
          </div>
        </>
      ) : (
        <div className="mx-auto flex w-full max-w-[1376px] flex-col gap-3 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-8">
          <div className="min-w-0 space-y-1">
            <p className="text-label font-extrabold text-primary">ViRead</p>
            <p className="text-sm leading-relaxed text-muted">
              {isAdmin
                ? "Khu vực quản trị ViRead."
                : "Đồng hành cùng bé trên hành trình đọc sách."}
            </p>
          </div>
          <p className="text-sm leading-relaxed text-muted sm:shrink-0">
            © 2026 ViRead.
          </p>
        </div>
      )}
    </footer>
  );
}
