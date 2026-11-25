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
import type { HealthSnapshotUI, RuntimeHealthDetailUI } from "@/types/admin";

const detailLabels: Record<RuntimeHealthDetailUI, string> = {
  installed: "Đã cài",
  initialized: "Đã khởi tạo",
  loaded: "Đã nạp model",
  healthy: "Đã xác minh",
  failed: "Gặp lỗi",
  unknown: "Chưa xác minh",
  disabled: "Chưa chạy",
};

function formatPendingAge(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  if (safeSeconds < 60) {
    return `${safeSeconds} giây`;
  }
  const minutes = Math.floor(safeSeconds / 60);
  const remSeconds = safeSeconds % 60;
  if (minutes < 60) {
    return remSeconds > 0
      ? `${minutes} phút ${remSeconds} giây`
      : `${minutes} phút`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours} giờ ${remMinutes} phút` : `${hours} giờ`;
}

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
        description="Kiểm tra nhẹ FastAPI, Database, OCR, Tesseract, worker, TTS và STT; không tải model OCR khi mở trang."
        actions={
          <Button
            disabled={!snapshot && !error}
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
                <p className="text-sm font-semibold text-muted">
                  Trạng thái các dịch vụ đã kiểm tra
                </p>
                <h2 className="text-2xl font-semibold text-ink">ViRead</h2>
              </div>
              <AdminStatusBadge status={snapshot.overall_status} />
            </div>
            <p className="text-sm text-muted">
              Kiểm tra lúc{" "}
              {new Date(snapshot.checked_at).toLocaleString("vi-VN")}
            </p>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            {snapshot.services.map((service) => {
              const hasWorkerMetrics =
                service.last_success_at !== undefined ||
                service.oldest_pending_job_age_seconds !== undefined ||
                service.queue_depth !== undefined ||
                service.last_error !== undefined;
              return (
                <Card className="bg-white" key={service.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h2 className="text-2xl font-extrabold text-ink">
                      {service.label}
                    </h2>
                    <AdminStatusBadge status={service.status} />
                  </div>
                  {service.detail_status && (
                    <p className="text-xs font-semibold text-muted">
                      Trạng thái kỹ thuật: {detailLabels[service.detail_status]}
                    </p>
                  )}
                  <p className="text-muted">{service.safe_message}</p>
                  {hasWorkerMetrics ? (
                    <dl
                      data-testid={`worker-metrics-${service.id}`}
                      className="mt-2 grid grid-cols-1 gap-2 rounded-control border border-border bg-canvas/70 p-3 text-xs sm:grid-cols-2"
                    >
                      {service.queue_depth !== undefined ? (
                        <div>
                          <dt className="font-semibold text-muted">Hàng đợi</dt>
                          <dd className="font-bold text-ink tabular-nums">
                            {service.queue_depth !== null
                              ? `${service.queue_depth} tác vụ`
                              : "Không áp dụng"}
                          </dd>
                        </div>
                      ) : null}
                      {service.oldest_pending_job_age_seconds !== undefined ? (
                        <div>
                          <dt className="font-semibold text-muted">
                            Chờ lâu nhất
                          </dt>
                          <dd className="font-bold text-ink tabular-nums">
                            {service.oldest_pending_job_age_seconds !== null
                              ? formatPendingAge(
                                  service.oldest_pending_job_age_seconds,
                                )
                              : "Không có"}
                          </dd>
                        </div>
                      ) : null}
                      {service.last_success_at !== undefined ? (
                        <div className="sm:col-span-2">
                          <dt className="font-semibold text-muted">
                            Thành công gần nhất
                          </dt>
                          <dd className="font-semibold text-ink">
                            {service.last_success_at
                              ? new Date(
                                  service.last_success_at,
                                ).toLocaleString("vi-VN")
                              : "Chưa ghi nhận"}
                          </dd>
                        </div>
                      ) : null}
                      {service.last_error ? (
                        <div className="sm:col-span-2 rounded-control border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-rose-900">
                          <dt className="font-bold">Lỗi gần nhất</dt>
                          <dd className="mt-0.5 break-words">
                            {service.last_error}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                  <p className="text-xs text-muted">
                    {new Date(service.checked_at).toLocaleString("vi-VN")}
                  </p>
                </Card>
              );
            })}
          </div>
        </>
      ) : null}
    </>
  );
}
