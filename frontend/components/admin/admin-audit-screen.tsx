"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
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
  const requestIdRef = useRef(0);
  const load = useCallback(
    async (nextCursor?: string, append = false) => {
      const requestId = ++requestIdRef.current;
      setError(false);
      if (!append) setItems(null);
      try {
        const page = await audit.list({
          action: action || undefined,
          resource_type: resource || undefined,
          cursor: nextCursor,
          limit: 10,
        });
        if (requestId !== requestIdRef.current) return;
        setItems((current) =>
          append ? [...(current ?? []), ...page.items] : page.items,
        );
        setCursor(page.next_cursor);
      } catch {
        if (requestId !== requestIdRef.current) return;
        setError(true);
        setItems([]);
      }
    },
    [action, audit, resource],
  );
  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);
  return (
    <>
      <AdminPageHeader
        eyebrow="Operational review"
        title="Nhật ký kiểm toán"
        description="Dữ liệu mock đã loại trừ âm thanh, video, bí mật và token."
      />
      <Card className="mb-6 bg-white">
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
      </Card>
      {items === null ? (
        <AdminLoading />
      ) : error ? (
        <StatusMessage tone="error">
          Không thể tải nhật ký.{" "}
          <button
            className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold underline focus-visible:outline-3 focus-visible:outline-primary"
            onClick={() => void load()}
            type="button"
          >
            Thử lại
          </button>
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          title="Chưa có sự kiện phù hợp"
          description="Thử bỏ bộ lọc để xem toàn bộ nhật ký mock."
        />
      ) : (
        <>
          <div className="grid gap-4">
            {items.map((item) => (
              <Card className="bg-white" key={item.id}>
                <div className="flex flex-col justify-between gap-3 md:flex-row">
                  <div>
                    <p className="font-black text-primary">{item.action}</p>
                    <p className="text-muted">
                      {item.resource_type} ·{" "}
                      {item.resource_id ?? "Không có resource ID"}
                    </p>
                  </div>
                  <time
                    className="text-sm text-muted"
                    dateTime={item.created_at}
                  >
                    {new Date(item.created_at).toLocaleString("vi-VN")}
                  </time>
                </div>
                <dl className="grid gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="font-bold">Actor</dt>
                    <dd className="break-all text-muted">
                      {item.actor_id ?? "Hệ thống"}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold">Request</dt>
                    <dd className="break-all text-muted">
                      {item.request_id ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold">Metadata an toàn</dt>
                    <dd className="break-all text-muted">
                      {JSON.stringify(item.metadata)}
                    </dd>
                  </div>
                </dl>
              </Card>
            ))}
          </div>
          {cursor ? (
            <Button
              className="mt-6 sm:w-auto"
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
