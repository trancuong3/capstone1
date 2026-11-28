"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { InformationField } from "@/components/common/information-field";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAdminServices } from "@/hooks/use-admin-services";
import type { AuditLogDTO } from "@/types/admin";

export function AdminAuditScreen() {
  const { audit } = useAdminServices();
  const [items, setItems] = useState<readonly AuditLogDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [resource, setResource] = useState("");
  const [error, setError] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
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
  return (
    <>
      <AdminPageHeader
        eyebrow="Vận hành ViRead"
        title="Nhật ký kiểm toán"
        description="Xem các sự kiện quản trị và metadata an toàn."
      />
      <div className="mb-4">
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Lọc theo action chính xác"
            onChange={(event) => setAction(event.target.value)}
            value={action}
          />
          <TextField
            label="Lọc theo resource_type"
            onChange={(event) => setResource(event.target.value)}
            value={resource}
          />
        </div>
      </div>
      {items === null ? (
        <AdminLoading />
      ) : error ? (
        <StatusMessage tone="error">
          Không thể tải nhật ký.{" "}
          <Button
            className="sm:w-auto"
            onClick={() =>
              void load(
                items.length ? (cursor ?? undefined) : undefined,
                items.length > 0,
              )
            }
            type="button"
            variant="secondary"
          >
            Thử lại
          </Button>
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          title="Chưa có sự kiện phù hợp"
          description="Thử bỏ bộ lọc để xem nhật ký đã lưu trong database."
        />
      ) : (
        <>
          <div className="grid gap-4">
            {items.map((item) => (
              <Card className="gap-4 bg-white sm:px-8 sm:py-6" key={item.id}>
                <h2 className="break-words text-2xl font-extrabold text-ink">
                  {item.action}
                </h2>
                <p className="break-words text-body text-muted">
                  <time dateTime={item.created_at}>
                    {new Date(item.created_at).toLocaleString("vi-VN")}
                  </time>{" "}
                  · {item.resource_type} ·{" "}
                  {item.resource_id ?? "Không có mã dữ liệu"}
                </p>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <InformationField label="Người thực hiện">
                    {item.actor_id ?? "Hệ thống"}
                  </InformationField>
                  <InformationField label="Mã yêu cầu">
                    {item.request_id ?? "—"}
                  </InformationField>
                </dl>
                <section className="rounded-card bg-sky p-4">
                  <h3 className="text-xl font-extrabold text-ink">
                    Metadata an toàn
                  </h3>
                  {(() => {
                    const serialized = JSON.stringify(item.metadata);
                    if (serialized.length <= 240) {
                      return (
                        <p className="mt-2 break-all text-label text-muted">
                          {serialized}
                        </p>
                      );
                    }
                    return (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-sm font-bold text-primary hover:underline">
                          Xem chi tiết metadata ({serialized.length} ký tự)
                        </summary>
                        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-control bg-white p-3 text-xs text-muted">
                          {JSON.stringify(item.metadata, null, 2)}
                        </pre>
                      </details>
                    );
                  })()}
                </section>
              </Card>
            ))}
          </div>
          {loadMoreError ? (
            <div className="mt-4">
              <StatusMessage tone="error">
                Không thể tải thêm nhật ký. Các bản ghi trước đó vẫn được giữ
                nguyên.{" "}
                <Button
                  className="sm:w-auto"
                  disabled={loadingMore}
                  onClick={() => void load(cursor ?? undefined, true)}
                  type="button"
                  variant="secondary"
                >
                  Thử tải thêm lại
                </Button>
              </StatusMessage>
            </div>
          ) : null}
          {cursor ? (
            <Button
              className="mt-6 sm:w-auto"
              disabled={loadingMore}
              fullWidth={false}
              isLoading={loadingMore}
              onClick={() => void load(cursor, true)}
              variant="secondary"
            >
              Tải thêm
            </Button>
          ) : null}
        </>
      )}
    </>
  );
}
