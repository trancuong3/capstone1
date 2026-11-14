import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/common/button";
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
    <PageHeader
      action={actions}
      description={description}
      eyebrow={eyebrow}
      title={title}
    />
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
      className="grid min-h-64 place-items-center rounded-card border border-border bg-white p-8 text-center shadow-sm"
    >
      <div>
        <div className="mx-auto mb-4 size-10 animate-spin rounded-full border-4 border-sky border-t-primary" />
        <p className="font-bold text-muted">{label}</p>
      </div>
    </div>
  );
}

export function AdminResultsPagination({
  page,
  pageSize,
  total,
  itemLabel,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
}) {
  const pageCount = Math.ceil(total / pageSize);
  if (pageCount < 2) return null;
  const firstItem = (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label={`Điều hướng danh sách ${itemLabel}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border bg-white px-4 py-3"
    >
      <p className="text-sm text-muted">
        Đang xem {firstItem}–{lastItem} / {total} {itemLabel}
      </p>
      <div className="flex items-center gap-2">
        <Button
          className="min-h-10 w-auto px-3 text-sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          type="button"
          variant="secondary"
        >
          <ChevronLeft aria-hidden className="size-4" /> Trước
        </Button>
        <span
          aria-current="page"
          className="min-w-16 text-center text-sm font-bold"
        >
          {page} / {pageCount}
        </span>
        <Button
          className="min-h-10 w-auto px-3 text-sm"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          type="button"
          variant="secondary"
        >
          Tiếp <ChevronRight aria-hidden className="size-4" />
        </Button>
      </div>
    </nav>
  );
}
