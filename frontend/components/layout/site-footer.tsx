import { cn } from "@/lib/utils/cn";

interface SiteFooterProps {
  readonly className?: string;
  readonly variant?: "public" | "admin";
}

/** Keep this in document flow, outside main; the hosting layout sizes the page. */
export function SiteFooter({ className, variant = "public" }: SiteFooterProps) {
  return (
    <footer
      aria-label="Thông tin ReadAlong Vision"
      className={cn(
        "mt-auto w-full shrink-0 border-t border-border bg-white",
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-[1376px] flex-col gap-3 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-8">
        <div className="min-w-0 space-y-1">
          <p className="text-label font-extrabold text-primary">
            ReadAlong Vision
          </p>
          <p className="text-sm leading-relaxed text-muted">
            {variant === "admin"
              ? "Khu vực quản trị ReadAlong Vision."
              : "Đồng hành cùng bé trên hành trình đọc sách."}
          </p>
        </div>
        <p className="text-sm leading-relaxed text-muted sm:shrink-0">
          © 2026 ReadAlong Vision.
        </p>
      </div>
    </footer>
  );
}
