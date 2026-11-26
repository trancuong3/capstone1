"use client";

import { Eye, FileJson2, RefreshCw, X } from "lucide-react";
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
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type { AuditLogDTO } from "@/types/admin";

const AUDIT_TABLE_GRID_COLS =
  "md:grid-cols-[minmax(0,11rem)_minmax(0,1.25fr)_minmax(0,1.7fr)_minmax(0,1.15fr)_7.5rem]";

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

function summarizeMetadata(metadata: Record<string, unknown>): string {
  const serialized = JSON.stringify(metadata);
  if (serialized.length <= 72) return serialized;
  return `${serialized.slice(0, 72)}…`;
}

export function AdminAuditScreen() {
  const { audit } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDateTime } = useI18n();
  const [items, setItems] = useState<readonly AuditLogDTO[] | null>(null);
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
        setItems((current) =>
          append
            ? Array.from(
                new Map(
                  [...(current ?? []), ...page.items].map((item) => [
                    item.id,
                    item,
                  ]),
                ).values(),
              )
            : page.items,
        );
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
          icon={<FileJson2 aria-hidden className="size-8 text-primary" />}
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
              {items.map((item) => {
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
                          className="max-w-full truncate font-mono"
                          dot
                          tone={resolveAuditActionTone(item.action)}
                        >
                          {item.action}
                        </AdminBadge>
                      </div>
                    </div>

                    <div className="min-w-0 space-y-1">
                      <p className="break-all text-sm font-medium text-ink">
                        {item.resource_type} ·{" "}
                        {item.resource_id ?? t("auditLogs.noResourceId")}
                      </p>
                      <p className="truncate font-mono text-xs text-muted">
                        {metadataPreview}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <span className="me-1.5 text-xs font-semibold text-muted md:hidden">
                        {t("auditLogs.actorLabel")}:
                      </span>
                      <span className="break-all font-mono text-xs font-medium text-muted md:text-ink">
                        {item.actor_id ?? t("auditLogs.systemActor")}
                      </span>
                    </div>

                    <div className="flex items-center justify-end">
                      <Button
                        aria-label={t(
                          "auditLogs.inspectEventAria",
                          { action: item.action },
                          "Xem chi tiết sự kiện {action}",
                        )}
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
                {selectedEvent.resource_type}
              </AdminBadge>
            </div>

            <dl className="grid gap-3">
              <div className="rounded-control border border-border bg-surface-subtle/50 px-3.5 py-2.5">
                <dt className="text-xs font-semibold text-muted">
                  {t("auditLogs.columns.resource", undefined, "Tài nguyên")}
                </dt>
                <dd className="mt-1 break-all font-mono text-xs font-semibold text-ink">
                  {selectedEvent.resource_type} ·{" "}
                  {selectedEvent.resource_id ?? t("auditLogs.noResourceId")}
                </dd>
              </div>
              <div className="rounded-control border border-border bg-surface-subtle/50 px-3.5 py-2.5">
                <dt className="text-xs font-semibold text-muted">
                  {t("auditLogs.actorLabel")}
                </dt>
                <dd className="mt-1 break-all font-mono text-xs font-semibold text-ink">
                  {selectedEvent.actor_id ?? t("auditLogs.systemActor")}
                </dd>
              </div>
              <div className="rounded-control border border-border bg-surface-subtle/50 px-3.5 py-2.5">
                <dt className="text-xs font-semibold text-muted">
                  {t("auditLogs.requestIdLabel")}
                </dt>
                <dd className="mt-1 break-all font-mono text-xs font-semibold text-ink">
                  {selectedEvent.request_id ?? t("common.emptyDash")}
                </dd>
              </div>
              <div className="rounded-control border border-border bg-surface-subtle/50 px-3.5 py-2.5">
                <dt className="text-xs font-semibold text-muted">
                  {t("auditLogs.eventIdLabel", undefined, "Mã sự kiện")}
                </dt>
                <dd className="mt-1 break-all font-mono text-xs font-semibold text-ink">
                  {selectedEvent.id}
                </dd>
              </div>
            </dl>

            <section className="space-y-2">
              <h3 className="text-sm font-extrabold text-ink">
                {t("auditLogs.safeMetadataLabel")}
              </h3>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-primary/20 bg-sky/30 p-3.5 font-mono text-xs leading-relaxed text-ink">
                {JSON.stringify(selectedEvent.metadata, null, 2)}
              </pre>
            </section>
          </div>
        ) : null}
      </AdminDrawer>
    </>
  );
}
