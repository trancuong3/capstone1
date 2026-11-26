"use client";

import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

import { PaginationBar } from "@/components/common/pagination-bar";
import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import type { OperationalHealthStatusUI } from "@/types/admin";
import type { BookLifecycleStatus } from "@/types/book";
import type { PageRevisionVerificationStatus } from "@/types/reading";

export interface AdminBreadcrumbItem {
  readonly label: string;
  readonly href?: string;
}

export interface AdminPageHeaderProps {
  readonly actions?: ReactNode;
  readonly badge?: ReactNode;
  readonly breadcrumbs?: readonly AdminBreadcrumbItem[];
  readonly className?: string;
  readonly description?: string;
  readonly eyebrow?: string;
  readonly title: string;
}

export function AdminPageHeader({
  actions,
  badge,
  breadcrumbs,
  className,
  description,
  eyebrow,
  title,
}: AdminPageHeaderProps) {
  const t = useTranslations("admin");

  return (
    <header
      className={cn(
        "mb-5 flex flex-col justify-between gap-3 border-b border-border pb-4 lg:flex-row lg:items-end lg:gap-4",
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <nav
            aria-label={t(
              "common.breadcrumbAria",
              undefined,
              "Đường dẫn điều hướng",
            )}
            className="mb-1"
          >
            <ol className="flex flex-wrap items-center gap-1 text-xs font-semibold text-muted">
              {breadcrumbs.map((item, index) => {
                const isLast = index === breadcrumbs.length - 1;
                return (
                  <li
                    className="inline-flex min-w-0 items-center gap-1"
                    key={`${item.label}-${index}`}
                  >
                    {index > 0 ? (
                      <ChevronRight
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted/70 viread-rtl-flip"
                      />
                    ) : null}
                    {item.href && !isLast ? (
                      <Link
                        className="truncate transition-colors hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        href={item.href}
                      >
                        {item.label}
                      </Link>
                    ) : (
                      <span
                        aria-current={isLast ? "page" : undefined}
                        className={cn("truncate", isLast && "text-ink")}
                      >
                        {item.label}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        ) : null}
        {eyebrow ? (
          <p className="text-xs font-bold uppercase tracking-wider text-primary">
            {eyebrow}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink lg:text-[28px] lg:leading-tight">
            {title}
          </h1>
          {badge}
        </div>
        {description ? (
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export type AdminBadgeTone =
  "success" | "warning" | "danger" | "info" | "neutral";

const badgeToneClassNames: Record<AdminBadgeTone, string> = {
  success: "border-emerald-200 bg-success-surface text-success-ink",
  warning: "border-amber-200 bg-warning-surface text-warning",
  danger: "border-danger/25 bg-danger-surface text-danger",
  info: "border-primary/20 bg-sky text-primary-hover",
  neutral: "border-border bg-surface-subtle text-muted",
};

const badgeDotClassNames: Record<AdminBadgeTone, string> = {
  success: "bg-emerald-600",
  warning: "bg-amber-600",
  danger: "bg-danger",
  info: "bg-primary",
  neutral: "bg-muted",
};

export interface AdminBadgeProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly dot?: boolean;
  readonly icon?: ReactNode;
  readonly tone?: AdminBadgeTone;
}

export function AdminBadge({
  children,
  className,
  dot = false,
  icon,
  tone = "neutral",
}: AdminBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold leading-5 whitespace-nowrap",
        badgeToneClassNames[tone],
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            badgeDotClassNames[tone],
          )}
        />
      ) : null}
      {icon}
      {children}
    </span>
  );
}

export type AdminKnownStatus =
  | BookLifecycleStatus
  | PageRevisionVerificationStatus
  | OperationalHealthStatusUI;

const KNOWN_STATUS_KEYS = new Set<string>([
  "ACTIVE",
  "RETIRED",
  "PROCESSING",
  "NEEDS_REVIEW",
  "VERIFIED",
  "HEALTHY",
  "DEGRADED",
  "UNAVAILABLE",
]);

function inferStatusTone(status: string | undefined): AdminBadgeTone {
  switch (status) {
    case "ACTIVE":
    case "VERIFIED":
    case "HEALTHY":
    case "Healthy":
    case "PUBLISHED":
    case "APPROVED":
    case "SUCCEEDED":
      return "success";
    case "RETIRED":
    case "UNAVAILABLE":
    case "Offline":
    case "FAILED":
    case "REJECTED":
    case "SUSPENDED":
    case "Quota exhausted":
      return "danger";
    case "PROCESSING":
    case "Queued":
    case "QUEUED":
    case "RUNNING":
    case "Scheduled":
      return "info";
    case "NEEDS_REVIEW":
    case "DEGRADED":
    case "Degraded":
    case "PENDING_ADMIN":
    case "FLAGGED":
    case "WAITING_FOR_REVIEW":
      return "warning";
    case "Standby":
    case "Local only":
    case "Unsupported":
    case "Unknown":
    case "DRAFT":
    case "HIDDEN":
    default:
      return "neutral";
  }
}

export interface AdminStatusBadgeProps {
  readonly className?: string;
  readonly dot?: boolean;
  readonly label?: string;
  readonly status?: AdminKnownStatus | (string & {});
  readonly tone?: AdminBadgeTone;
}

export function AdminStatusBadge({
  className,
  dot = true,
  label,
  status,
  tone,
}: AdminStatusBadgeProps) {
  const t = useTranslations("admin");
  const resolvedTone = tone ?? inferStatusTone(status);
  const resolvedLabel =
    label ??
    (status && KNOWN_STATUS_KEYS.has(status)
      ? t(`statusBadges.${status}`)
      : (status ?? ""));

  return (
    <AdminBadge className={className} dot={dot} tone={resolvedTone}>
      {resolvedLabel}
    </AdminBadge>
  );
}

const kpiGridColumnClassNames: Record<2 | 3 | 4 | 5 | 6, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
};

export interface AdminKpiGridProps {
  readonly ariaLabel?: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly columns?: 2 | 3 | 4 | 5 | 6;
}

export function AdminKpiGrid({
  ariaLabel,
  children,
  className,
  columns = 4,
}: AdminKpiGridProps) {
  const gridClassName = cn(
    "grid gap-3",
    kpiGridColumnClassNames[columns],
    className,
  );

  if (ariaLabel) {
    return (
      <section aria-label={ariaLabel} className={gridClassName}>
        {children}
      </section>
    );
  }

  return <div className={gridClassName}>{children}</div>;
}

const kpiValueToneClassNames: Record<AdminBadgeTone, string> = {
  success: "text-success-ink",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-primary",
  neutral: "text-ink",
};

export interface AdminKpiCardProps {
  readonly active?: boolean;
  readonly className?: string;
  readonly detail?: ReactNode;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly onClick?: () => void;
  readonly testId?: string;
  readonly tone?: AdminBadgeTone;
  readonly value: ReactNode;
}

export function AdminKpiCard({
  active = false,
  className,
  detail,
  icon,
  label,
  onClick,
  testId,
  tone = "neutral",
  value,
}: AdminKpiCardProps) {
  const cardClassName = cn(
    "flex min-w-0 flex-col justify-between gap-1.5 rounded-xl border bg-white px-4 py-3 text-start tabular-nums transition-colors",
    active
      ? "border-primary bg-sky/25 ring-2 ring-primary/25"
      : "border-border",
    onClick &&
      !active &&
      "cursor-pointer hover:border-primary/40 hover:bg-surface-subtle/70",
    onClick &&
      "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
    className,
  );

  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-semibold text-muted">
          {label}
        </span>
        {icon ? (
          <span aria-hidden="true" className="shrink-0 text-muted">
            {icon}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          "text-2xl font-extrabold tracking-tight tabular-nums",
          kpiValueToneClassNames[tone],
        )}
      >
        {value}
      </div>
      {detail ? (
        <p className="text-xs leading-snug text-muted">{detail}</p>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button
        aria-pressed={active}
        className={cardClassName}
        data-testid={testId}
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <div className={cardClassName} data-testid={testId}>
      {content}
    </div>
  );
}

export interface AdminToolbarProps {
  readonly actions?: ReactNode;
  readonly ariaLabel?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function AdminToolbar({
  actions,
  ariaLabel,
  children,
  className,
}: AdminToolbarProps) {
  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-white p-3.5 shadow-2xs sm:flex-row sm:flex-wrap sm:items-end sm:justify-between",
        className,
      )}
      role={ariaLabel ? "region" : undefined}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-end gap-3">
        {children}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export interface AdminSearchInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "size" | "type" | "value"
> {
  readonly clearLabel?: string;
  readonly containerClassName?: string;
  readonly hideLabel?: boolean;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly onClear?: () => void;
  readonly value: string;
}

export function AdminSearchInput({
  className,
  clearLabel,
  containerClassName,
  disabled,
  hideLabel = false,
  id,
  label,
  onChange,
  onClear,
  placeholder,
  value,
  ...props
}: AdminSearchInputProps) {
  const t = useTranslations("admin");
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const resolvedClearLabel =
    clearLabel ?? t("common.clearSearch", undefined, "Xóa từ khóa tìm kiếm");

  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1 sm:min-w-56",
        containerClassName,
      )}
    >
      <label
        className={hideLabel ? "sr-only" : "text-xs font-semibold text-muted"}
        htmlFor={inputId}
      >
        {label}
      </label>
      <div className="relative flex items-center">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute start-3 size-4 text-muted"
        />
        <input
          className={cn(
            "h-10 min-h-10 w-full rounded-control border border-border bg-white ps-9 text-sm text-ink placeholder:text-muted/70 transition-colors focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted [&::-webkit-search-cancel-button]:hidden",
            value ? "pe-9" : "pe-3",
            className,
          )}
          disabled={disabled}
          id={inputId}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type="search"
          value={value}
          {...props}
        />
        {value && !disabled ? (
          <button
            aria-label={resolvedClearLabel}
            className="absolute end-1 inline-flex size-8 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => {
              onChange("");
              onClear?.();
            }}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface AdminSelectOption {
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: string;
}

export interface AdminSelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "onChange" | "size"
> {
  readonly children?: ReactNode;
  readonly containerClassName?: string;
  readonly hideLabel?: boolean;
  readonly label: string;
  readonly onChange?: (value: string) => void;
  readonly options?: readonly AdminSelectOption[];
}

export function AdminSelect({
  children,
  className,
  containerClassName,
  hideLabel = false,
  id,
  label,
  onChange,
  options,
  ...props
}: AdminSelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", containerClassName)}>
      <label
        className={hideLabel ? "sr-only" : "text-xs font-semibold text-muted"}
        htmlFor={selectId}
      >
        {label}
      </label>
      <div className="relative flex items-center">
        <select
          className={cn(
            "h-10 min-h-10 w-full appearance-none rounded-control border border-border bg-white pe-9 ps-3 text-sm font-medium text-ink transition-colors focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted",
            className,
          )}
          id={selectId}
          onChange={(event) => onChange?.(event.target.value)}
          {...props}
        >
          {options
            ? options.map((option) => (
                <option
                  disabled={option.disabled}
                  key={option.value}
                  value={option.value}
                >
                  {option.label}
                </option>
              ))
            : children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute end-3 size-4 text-muted"
        />
      </div>
    </div>
  );
}

const drawerSizeClassNames: Record<"md" | "lg" | "xl", string> = {
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
};

export interface AdminDrawerProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly closeLabel?: string;
  readonly description?: string;
  readonly footer?: ReactNode;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly size?: "md" | "lg" | "xl";
  readonly title: string;
}

export function AdminDrawer({
  children,
  className,
  closeLabel,
  description,
  footer,
  isOpen,
  onClose,
  size = "lg",
  title,
}: AdminDrawerProps) {
  const t = useTranslations("admin");
  const titleId = useId();
  const descriptionId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-ink/35 backdrop-blur-[1px]"
      data-testid="admin-drawer-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn(
          "relative flex h-dvh w-full flex-col border-s border-border bg-white shadow-2xl outline-none",
          drawerSizeClassNames[size],
          className,
        )}
        data-testid="admin-drawer-panel"
        role="dialog"
      >
        <header className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 border-b border-border bg-white px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2
              className="text-lg font-extrabold tracking-tight text-ink"
              id={titleId}
            >
              {title}
            </h2>
            {description ? (
              <p
                className="mt-0.5 text-xs leading-relaxed text-muted"
                id={descriptionId}
              >
                {description}
              </p>
            ) : null}
          </div>
          <button
            aria-label={closeLabel ?? t("common.close")}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>

        {footer ? (
          <footer className="sticky bottom-0 z-10 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-subtle/60 px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </section>
    </div>
  );
}

export interface AdminLoadingProps {
  readonly className?: string;
  readonly label?: string;
  readonly variant?: "spinner" | "skeleton";
}

export function AdminLoading({
  className,
  label,
  variant = "spinner",
}: AdminLoadingProps) {
  const t = useTranslations("admin");
  const displayLabel = label ?? t("common.loadingLabel");

  if (variant === "skeleton") {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className={cn(
          "space-y-3 rounded-xl border border-border bg-white p-5 shadow-2xs",
          className,
        )}
        role="status"
      >
        <span className="sr-only">{displayLabel}</span>
        <div className="h-4 w-40 animate-pulse rounded bg-surface-subtle" />
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <div className="h-16 animate-pulse rounded-lg bg-surface-subtle" />
          <div className="h-16 animate-pulse rounded-lg bg-surface-subtle" />
          <div className="h-16 animate-pulse rounded-lg bg-surface-subtle" />
        </div>
        <div className="h-24 animate-pulse rounded-lg bg-surface-subtle" />
      </div>
    );
  }

  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "grid min-h-40 place-items-center rounded-xl border border-border bg-white px-6 py-8 text-center shadow-2xs",
        className,
      )}
      role="status"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="size-8 animate-spin rounded-full border-3 border-sky border-t-primary" />
        <p className="text-sm font-semibold text-muted">{displayLabel}</p>
      </div>
    </div>
  );
}

export interface AdminResultsPaginationProps {
  readonly className?: string;
  readonly itemLabel: string;
  readonly onPageChange: (page: number) => void;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export function AdminResultsPagination({
  className,
  page,
  pageSize,
  total,
  itemLabel,
  onPageChange,
}: AdminResultsPaginationProps) {
  const t = useTranslations("admin");
  return (
    <PaginationBar
      ariaLabel={t("common.paginationAria", { itemLabel })}
      className={className}
      compact
      itemLabel={itemLabel}
      onPageChange={onPageChange}
      page={page}
      pageSize={pageSize}
      total={total}
    />
  );
}
