"use client";

import { Eye, FileText, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminBadge,
  AdminDrawer,
  AdminLoading,
  AdminPageHeader,
  AdminSearchInput,
  AdminToolbar,
  type AdminBadgeTone,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type { AuditLogDTO } from "@/types/admin";

const AUDIT_TABLE_GRID_COLS =
  "md:grid-cols-[minmax(0,11rem)_minmax(0,1.25fr)_minmax(0,1.7fr)_minmax(0,1.15fr)_7.5rem]";
const AUDIT_PAGE_SIZE = 10;

function resolveAuditActionTone(action: string): AdminBadgeTone {
  const normalized = action.toLowerCase();
  if (
    /(delete|deactivate|suspend|reject|retire|revoke|fail|error|block)/.test(
      normalized,
    )
  ) {
    return "danger";
  }
  if (/(create|approve|verify|publish|activate|connect)/.test(normalized)) {
    return "success";
  }
  if (
    /(update|edit|flag|rollback|retry|request|change|hide)/.test(normalized)
  ) {
    return "warning";
  }
  return "info";
}

const UUID_LIKE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_HASH_PATTERN = /^[0-9a-f]{32,}$/i;
const SENSITIVE_META_KEY_PATTERN =
  /(^|_)(id|uuid|hash|sha|sha256|token|secret|key|signature|request_id|actor_id|resource_id|revision_id|workflow_id|cursor|nonce)$/i;

const AUDIT_RESOURCE_LABELS: Record<string, string> = {
  book: "Sách",
  books: "Kho sách",
  page: "Trang sách",
  page_revision: "Bản chữ trang sách",
  parent: "Tài khoản phụ huynh",
  child: "Hồ sơ trẻ em",
  song: "Bài hát karaoke",
  karaoke_song: "Bài hát karaoke",
  report: "Báo cáo nội dung",
  content_report: "Báo cáo nội dung",
  user_book: "Sách người dùng",
  training: "Huấn luyện mô hình",
  model: "Mô hình nhận diện",
  system: "Hệ thống",
};

const AUDIT_META_KEY_LABELS: Record<string, string> = {
  title: "Tiêu đề",
  book_title: "Tên sách",
  name: "Tên",
  display_name: "Tên hiển thị",
  email: "Email",
  page_number: "Trang số",
  status: "Trạng thái",
  reason: "Lý do",
  note: "Ghi chú",
  action: "Thao tác",
  count: "Số lượng",
  scope: "Phạm vi",
  mode: "Chế độ",
  provider: "Dịch vụ xử lý",
  result: "Kết quả",
};

function formatAuditResourceLabel(resourceType: string): string {
  const key = resourceType.trim().toLowerCase();
  if (AUDIT_RESOURCE_LABELS[key]) return AUDIT_RESOURCE_LABELS[key];
  return resourceType.replace(/_/g, " ");
}

function formatAuditMetadataKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  if (AUDIT_META_KEY_LABELS[normalized]) {
    return AUDIT_META_KEY_LABELS[normalized];
  }
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function formatAuditMetadataValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "Có" : "Không";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (UUID_LIKE_PATTERN.test(trimmed) || HEX_HASH_PATTERN.test(trimmed)) {
      return null;
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => formatAuditMetadataValue(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

function extractReadableMetadataEntries(
  metadata: Record<string, unknown>,
): readonly { readonly label: string; readonly value: string }[] {
  const entries: { readonly label: string; readonly value: string }[] = [];
  for (const [key, rawValue] of Object.entries(metadata)) {
    if (SENSITIVE_META_KEY_PATTERN.test(key)) continue;
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      for (const [nestedKey, nestedVal] of Object.entries(
        rawValue as Record<string, unknown>,
      )) {
        if (SENSITIVE_META_KEY_PATTERN.test(nestedKey)) continue;
        const formatted = formatAuditMetadataValue(nestedVal);
        if (formatted) {
          entries.push({
            label: formatAuditMetadataKey(nestedKey),
            value: formatted,
          });
        }
      }
      continue;
    }
    const formatted = formatAuditMetadataValue(rawValue);
    if (formatted) {
      entries.push({
        label: formatAuditMetadataKey(key),
        value: formatted,
      });
    }
  }
  return entries;
}

function summarizeMetadata(metadata: Record<string, unknown>): string {
  const entries = extractReadableMetadataEntries(metadata);
  if (entries.length === 0) return "Không có thông tin bổ sung";
  const text = entries
    .slice(0, 3)
    .map((entry) => `${entry.label}: ${entry.value}`)
    .join(" · ");
  if (text.length <= 72) return text;
  return `${text.slice(0, 72)}…`;
}

export function AdminAuditScreen() {
  const { audit } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDateTime } = useI18n();
  const [items, setItems] = useState<readonly AuditLogDTO[] | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [cursor, setCursor] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [resource, setResource] = useState("");
  const [error, setError] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<AuditLogDTO | null>(null);
  const closeSelectedEvent = useCallback(() => setSelectedEvent(null), []);
  const appendRequestRef = useRef(false);
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (nextCursor?: string, append = false) => {
      if (append && appendRequestRef.current) return;
      appendRequestRef.current = append;
      setLoadingMore(append);
      const requestId = ++requestIdRef.current;
      if (append) {
        setLoadMoreError(false);
      } else {
        setError(false);
        setLoadMoreError(false);
        setItems(null);
      }
      try {
        const page = await audit.list({
          action: action.trim() || undefined,
          resource_type: resource.trim() || undefined,
          cursor: nextCursor,
          limit: 10,
        });
        if (requestId !== requestIdRef.current) return;
        setItems((current) => {
          const nextList = append
            ? Array.from(
                new Map(
                  [...(current ?? []), ...page.items].map((item) => [
                    item.id,
                    item,
                  ]),
                ).values(),
              )
            : page.items;
          if (!append) {
            setPageNumber(1);
          } else if (
            current &&
            nextList.length > current.length &&
            nextList.length > AUDIT_PAGE_SIZE
          ) {
            setPageNumber(Math.ceil(nextList.length / AUDIT_PAGE_SIZE));
          }
          return nextList;
        });
        setCursor(page.next_cursor);
      } catch {
        if (requestId !== requestIdRef.current) return;
        if (append) {
          setLoadMoreError(true);
        } else {
          setError(true);
          setItems([]);
        }
      } finally {
        if (requestId === requestIdRef.current) {
          appendRequestRef.current = false;
          setLoadingMore(false);
        }
      }
    },
    [action, audit, resource],
  );

  useEffect(() => {
    const delay = action || resource ? 300 : 0;
    const timeout = globalThis.setTimeout(() => void load(), delay);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [action, load, resource]);

  const hasFilters = Boolean(action.trim() || resource.trim());
  const totalPages = Math.max(
    1,
    Math.ceil((items?.length ?? 0) / AUDIT_PAGE_SIZE),
  );
  const safePage = Math.min(Math.max(1, pageNumber), totalPages);
  const visibleItems =
    items?.slice(
      (safePage - 1) * AUDIT_PAGE_SIZE,
      safePage * AUDIT_PAGE_SIZE,
    ) ?? [];

  return (
    <>
      <AdminPageHeader
        eyebrow={t("auditLogs.eyebrow")}
        title={t("auditLogs.title")}
        description={t("auditLogs.description")}
        actions={
          <Button
            fullWidth={false}
            onClick={() => void load()}
            size="admin"
            variant="outline"
          >
            <RefreshCw aria-hidden className="size-4" />
            {t("common.refresh")}
          </Button>
        }
      />

      <AdminToolbar
        actions={
          hasFilters ? (
            <Button
              fullWidth={false}
              onClick={() => {
                setAction("");
                setResource("");
              }}
              size="admin"
              type="button"
              variant="outline"
            >
              <X aria-hidden className="size-4" />
              {t("auditLogs.clearFilters", undefined, "Xóa bộ lọc")}
            </Button>
          ) : undefined
        }
        ariaLabel={t(
          "auditLogs.filterAria",
          undefined,
          "Bộ lọc nhật ký kiểm toán",
        )}
        className="mb-5"
      >
        <AdminSearchInput
          label={t("auditLogs.filterActionLabel")}
          onChange={setAction}
          placeholder={t(
            "auditLogs.filterActionPlaceholder",
            undefined,
            "vd: book.read, parent.update…",
          )}
          value={action}
        />
        <AdminSearchInput
          label={t("auditLogs.filterResourceLabel")}
          onChange={setResource}
          placeholder={t(
            "auditLogs.filterResourcePlaceholder",
            undefined,
            "vd: book, parent, song…",
          )}
          value={resource}
        />
      </AdminToolbar>

      {items === null ? (
        <AdminLoading />
      ) : error ? (
        <StatusMessage tone="error">
          {t("auditLogs.loadError")}{" "}
          <Button
            fullWidth={false}
            onClick={() =>
              void load(
                items.length ? (cursor ?? undefined) : undefined,
                items.length > 0,
              )
            }
            size="admin"
            type="button"
            variant="outline"
          >
            {t("common.retry")}
          </Button>
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<FileText aria-hidden className="size-8 text-primary" />}
          title={t("auditLogs.emptyFilteredTitle")}
          description={t("auditLogs.emptyFilteredDescription")}
          action={
            hasFilters ? (
              <Button
                fullWidth={false}
                onClick={() => {
                  setAction("");
                  setResource("");
                }}
                size="admin"
                type="button"
                variant="outline"
              >
                {t("auditLogs.clearFilters", undefined, "Xóa bộ lọc")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <section
            aria-label={t(
              "auditLogs.tableAria",
              undefined,
              "Bảng nhật ký kiểm toán",
            )}
            className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs"
          >
            <div
              aria-hidden="true"
              className={`hidden border-b border-border bg-surface-subtle/75 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-muted md:grid md:items-center md:gap-4 ${AUDIT_TABLE_GRID_COLS}`}
            >
              <span>
                {t("auditLogs.columns.timestamp", undefined, "Thời điểm")}
              </span>
              <span>
                {t("auditLogs.columns.action", undefined, "Hành động")}
              </span>
              <span>
                {t("auditLogs.columns.resource", undefined, "Tài nguyên")}
              </span>
              <span>{t("auditLogs.actorLabel")}</span>
              <span className="text-end">
                {t("auditLogs.columns.metadata", undefined, "Metadata")}
              </span>
            </div>

            <ul className="divide-y divide-border">
              {visibleItems.map((item) => {
                const metadataPreview = summarizeMetadata(item.metadata);
                return (
                  <li
                    className={`flex flex-col gap-2.5 p-4 transition-colors hover:bg-surface-subtle/40 md:grid md:items-center md:gap-4 md:px-4 md:py-3 ${AUDIT_TABLE_GRID_COLS}`}
                    key={item.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 md:contents">
                      <time
                        className="text-xs font-semibold text-muted tabular-nums md:text-sm md:font-medium md:text-ink"
                        dateTime={item.created_at}
                      >
                        {formatDateTime(item.created_at)}
                      </time>

                      <div className="min-w-0">
                        <AdminBadge
                          className="max-w-full overflow-hidden font-mono"
                          dot
                          title={item.action}
                          tone={resolveAuditActionTone(item.action)}
                        >
                          <span className="min-w-0 truncate">
                            {item.action}
                          </span>
                        </AdminBadge>
                      </div>
                    </div>

                    <div className="min-w-0 space-y-1">
                      <p className="break-words text-sm font-medium text-ink">
                        {formatAuditResourceLabel(item.resource_type)}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {metadataPreview}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <span className="me-1.5 text-xs font-semibold text-muted md:hidden">
                        {t("auditLogs.actorLabel")}:
                      </span>
                      <span className="text-xs font-medium text-muted md:text-ink">
                        {item.actor_id
                          ? "Quản trị viên"
                          : t("auditLogs.systemActor")}
                      </span>
                    </div>

                    <div className="flex items-center justify-end">
                      <Button
                        aria-label={t(
                          "auditLogs.inspectEventAria",
                          { action: item.action },
                          "Xem chi tiết sự kiện {action}",
                        )}
                        className="min-w-[6.25rem] whitespace-nowrap"
                        fullWidth={false}
                        onClick={() => setSelectedEvent(item)}
                        size="admin"
                        variant="outline"
                      >
                        <Eye aria-hidden className="size-4" />
                        {t("auditLogs.inspectBtn", undefined, "Chi tiết")}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <PaginationBar
            className="mt-4"
            compact
            onPageChange={setPageNumber}
            page={safePage}
            pageSize={AUDIT_PAGE_SIZE}
            total={items.length}
          />

          {loadMoreError ? (
            <div className="mt-4">
              <StatusMessage tone="error">
                {t("auditLogs.loadMoreError")}{" "}
                <Button
                  disabled={loadingMore}
                  fullWidth={false}
                  onClick={() => void load(cursor ?? undefined, true)}
                  size="admin"
                  type="button"
                  variant="outline"
                >
                  {t("auditLogs.retryLoadMore")}
                </Button>
              </StatusMessage>
            </div>
          ) : null}

          {cursor ? (
            <div className="mt-5 flex justify-center">
              <Button
                disabled={loadingMore}
                fullWidth={false}
                isLoading={loadingMore}
                onClick={() => void load(cursor, true)}
                size="admin"
                variant="secondary"
              >
                {t("auditLogs.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <AdminDrawer
        description={
          selectedEvent ? formatDateTime(selectedEvent.created_at) : undefined
        }
        footer={
          <Button
            fullWidth={false}
            onClick={closeSelectedEvent}
            size="admin"
            variant="outline"
          >
            {t("common.close")}
          </Button>
        }
        isOpen={selectedEvent !== null}
        onClose={closeSelectedEvent}
        size="md"
        title={
          selectedEvent?.action ??
          t("auditLogs.drawerTitleFallback", undefined, "Chi tiết sự kiện")
        }
      >
        {selectedEvent ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <AdminBadge
                className="font-mono"
                dot
                tone={resolveAuditActionTone(selectedEvent.action)}
              >
                {selectedEvent.action}
              </AdminBadge>
              <AdminBadge tone="neutral">
                {formatAuditResourceLabel(selectedEvent.resource_type)}
              </AdminBadge>
            </div>

            <dl className="grid gap-3">
              <div className="rounded-control border border-border bg-surface-subtle/50 px-3.5 py-2.5">
                <dt className="text-xs font-semibold text-muted">
                  {t("auditLogs.columns.resource", undefined, "Tài nguyên")}
                </dt>
                <dd className="mt-1 text-xs font-semibold text-ink">
                  {formatAuditResourceLabel(selectedEvent.resource_type)}
                </dd>
              </div>
              <div className="rounded-control border border-border bg-surface-subtle/50 px-3.5 py-2.5">
                <dt className="text-xs font-semibold text-muted">
                  {t("auditLogs.actorLabel")}
                </dt>
                <dd className="mt-1 text-xs font-semibold text-ink">
                  {selectedEvent.actor_id
                    ? "Quản trị viên"
                    : t("auditLogs.systemActor")}
                </dd>
              </div>
            </dl>

            <section className="space-y-2">
              <h3 className="text-sm font-extrabold text-ink">
                {t("auditLogs.safeMetadataLabel")}
              </h3>
              {(() => {
                const entries = extractReadableMetadataEntries(
                  selectedEvent.metadata,
                );
                if (entries.length === 0) {
                  return (
                    <p className="rounded-xl border border-border bg-surface-subtle/50 p-3.5 text-xs text-muted">
                      {t("auditLogs.noResourceId")}
                    </p>
                  );
                }
                return (
                  <dl className="grid gap-2 rounded-xl border border-primary/20 bg-sky/30 p-3.5 text-xs">
                    {entries.map((entry, idx) => (
                      <div
                        className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/50 pb-1.5 last:border-b-0 last:pb-0"
                        key={`${entry.label}-${idx}`}
                      >
                        <dt className="font-semibold text-muted">
                          {entry.label}
                        </dt>
                        <dd className="font-medium text-ink break-words">
                          {entry.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                );
              })()}
            </section>
          </div>
        ) : null}
      </AdminDrawer>
    </>
  );
}
