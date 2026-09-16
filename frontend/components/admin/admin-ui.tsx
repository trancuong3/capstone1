import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import type { OperationalHealthStatusUI } from "@/types/admin";
import type { BookLifecycleStatus } from "@/types/book";
import type { PageRevisionVerificationStatus } from "@/types/reading";

export function AdminPageHeader({
  actions,
  eyebrow,
  title,
  description,
}: {
  actions?: ReactNode;
  eyebrow?: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div>
        {eyebrow ? (
          <p className="mb-1 text-label font-extrabold uppercase tracking-wider text-primary">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-heading font-black text-ink">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-body text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap gap-3">{actions}</div>
      ) : null}
    </div>
  );
}

type Status =
  | BookLifecycleStatus
  | PageRevisionVerificationStatus
  | OperationalHealthStatusUI;
const labels: Record<Status, string> = {
  ACTIVE: "Đang hoạt động",
  RETIRED: "Đã ngừng",
  PROCESSING: "Đang xử lý",
  NEEDS_REVIEW: "Cần kiểm tra",
  VERIFIED: "Đã xác minh",
  HEALTHY: "Bình thường",
  DEGRADED: "Hạn chế",
  UNAVAILABLE: "Không khả dụng",
};
export function AdminStatusBadge({ status }: { status: Status }) {
  const tone =
    status === "ACTIVE" || status === "VERIFIED" || status === "HEALTHY"
      ? "bg-success-surface text-success-ink"
      : status === "RETIRED" || status === "UNAVAILABLE"
        ? "bg-danger-surface text-danger"
        : "bg-warning-surface text-warning";
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-3 py-1 text-sm font-extrabold",
        tone,
      )}
    >
      {labels[status]}
    </span>
  );
}

export function AdminLoading({
  label = "Đang tải dữ liệu quản trị…",
}: {
  label?: string;
}) {
  return (
    <div
      aria-live="polite"
      className="grid min-h-64 place-items-center rounded-card bg-cream p-8 text-center"
    >
      <div>
        <div className="mx-auto mb-4 size-10 animate-spin rounded-full border-4 border-sky border-t-primary" />
        <p className="font-bold text-muted">{label}</p>
      </div>
    </div>
  );
}
