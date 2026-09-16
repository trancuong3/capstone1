"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminLoading,
  AdminPageHeader,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import type { HealthSnapshotUI } from "@/types/admin";

export function AdminHealthScreen() {
  const { health } = useAdminServices();
  const [snapshot, setSnapshot] = useState<HealthSnapshotUI | null>(null);
  const [error, setError] = useState(false);
  const requestIdRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setError(false);
    setSnapshot(null);
    try {
      const nextSnapshot = await health.get();
      if (requestId !== requestIdRef.current) return;
      setSnapshot(nextSnapshot);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setError(true);
    }
  }, [health]);
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
        title="Tình trạng vận hành"
        description="Màn hình frontend mock; không thăm dò dịch vụ backend thật."
        actions={
          <Button
            className="sm:w-auto"
            onClick={() => void load()}
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-5" /> Kiểm tra lại
          </Button>
        }
      />
      {!snapshot && !error ? (
        <AdminLoading />
      ) : error ? (
        <StatusMessage tone="error">
          Không thể lấy trạng thái an toàn. Vui lòng thử lại.
        </StatusMessage>
      ) : snapshot ? (
        <>
          <Card className="mb-6 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-muted">
                  Trạng thái tổng thể
                </p>
                <h2 className="text-2xl font-black">ReadAlong Vision</h2>
              </div>
              <AdminStatusBadge status={snapshot.overall_status} />
            </div>
            <p className="text-sm text-muted">
              Kiểm tra lúc{" "}
              {new Date(snapshot.checked_at).toLocaleString("vi-VN")}
            </p>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            {snapshot.services.map((service) => (
              <Card className="bg-white" key={service.id}>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-xl font-black">{service.label}</h2>
                  <AdminStatusBadge status={service.status} />
                </div>
                <p className="text-muted">{service.safe_message}</p>
                <p className="text-xs text-muted">
                  {new Date(service.checked_at).toLocaleString("vi-VN")}
                </p>
              </Card>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
