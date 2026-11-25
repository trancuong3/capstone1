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
import {
  detectBrowserWasmSttSupport,
  getWasmModelCacheStatus,
  type BrowserWasmCapabilities,
  type WasmModelCacheStatus,
} from "@/lib/reading/browser-wasm-stt";
import {
  getBrowserTtsCacheStats,
  type BrowserTtsCacheStats,
} from "@/lib/reading/tts-audio-cache";
import type {
  HealthOperationalStateUI,
  HealthSnapshotUI,
  RuntimeHealthDetailUI,
} from "@/types/admin";

const detailLabels: Record<RuntimeHealthDetailUI, string> = {
  installed: "Đã cài",
  initialized: "Đã khởi tạo",
  loaded: "Đã nạp model",
  healthy: "Đã xác minh",
  failed: "Gặp lỗi",
  unknown: "Chưa xác minh",
  disabled: "Chưa chạy",
};

const operationalStateClassNames: Record<HealthOperationalStateUI, string> = {
  Healthy: "border-emerald-200 bg-emerald-50 text-emerald-800",
  Degraded: "border-amber-200 bg-amber-50 text-amber-900",
  Offline: "border-slate-200 bg-slate-100 text-slate-800",
  Queued: "border-sky-200 bg-sky-50 text-sky-900",
  "Quota exhausted": "border-rose-200 bg-rose-50 text-rose-900",
  Unsupported: "border-slate-200 bg-slate-100 text-slate-700",
  Unknown: "border-border bg-canvas text-muted",
};

function formatByteSize(bytes: number): string {
  const safe = Math.max(0, bytes);
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${(safe / (1024 * 1024)).toFixed(2)} MB`;
}

interface ClientDeviceCapabilitiesSnapshot {
  readonly wasmCaps: BrowserWasmCapabilities;
  readonly wasmCache: WasmModelCacheStatus;
  readonly ttsCache: BrowserTtsCacheStats;
  readonly micPermission: PermissionState | "unsupported";
  readonly isAndroidWebView: boolean;
}

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
  const [clientCaps, setClientCaps] =
    useState<ClientDeviceCapabilitiesSnapshot | null>(null);
  const requestIdRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setError(false);
    setSnapshot(null);
    const probeClient = async (): Promise<ClientDeviceCapabilitiesSnapshot> => {
      const wasmCaps = detectBrowserWasmSttSupport();
      const [wasmCache, ttsCache] = await Promise.all([
        getWasmModelCacheStatus(),
        getBrowserTtsCacheStats(),
      ]);
      let micPermission: PermissionState | "unsupported" = "unsupported";
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.permissions?.query === "function"
      ) {
        try {
          const perm = await navigator.permissions.query({
            name: "microphone" as PermissionName,
          });
          micPermission = perm.state;
        } catch {
          micPermission = "unsupported";
        }
      }
      const isAndroidWebView =
        typeof navigator !== "undefined" &&
        /ViReadAndroid\//i.test(navigator.userAgent || "");
      return {
        wasmCaps,
        wasmCache,
        ttsCache,
        micPermission,
        isAndroidWebView,
      };
    };
    void probeClient().then((caps) => {
      if (requestId === requestIdRef.current) {
        setClientCaps(caps);
      }
    });
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
                    <div className="flex flex-wrap items-center gap-2">
                      {service.operational_state ? (
                        <span
                          data-testid={`operational-state-${service.id}`}
                          className={`rounded-pill border px-2.5 py-0.5 text-xs font-bold ${
                            operationalStateClassNames[
                              service.operational_state
                            ]
                          }`}
                        >
                          {service.operational_state}
                        </span>
                      ) : null}
                      <AdminStatusBadge status={service.status} />
                    </div>
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
          {snapshot.audio_cache ? (
            <Card
              className="mt-6 bg-white"
              data-testid="admin-audio-cache-summary"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xl font-extrabold text-ink">
                  Kho âm thanh đọc mẫu (Precomputed TTS Cache)
                </h2>
                {snapshot.audio_cache.quota_exhausted ? (
                  <span className="rounded-pill border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-xs font-bold text-rose-900">
                    Quota exhausted
                  </span>
                ) : null}
              </div>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    Số mục cache
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {snapshot.audio_cache.entry_count}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    Dung lượng lưu trữ
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {formatByteSize(snapshot.audio_cache.storage_used_bytes)} /{" "}
                    {formatByteSize(snapshot.audio_cache.storage_quota_bytes)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    Egress trong ngày
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {formatByteSize(snapshot.audio_cache.daily_egress_bytes)}
                    {snapshot.audio_cache.daily_egress_limit_bytes
                      ? ` / ${formatByteSize(snapshot.audio_cache.daily_egress_limit_bytes)}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    Tỉ lệ cache hit
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {snapshot.audio_cache.cache_hit_ratio !== null
                      ? `${Math.round(snapshot.audio_cache.cache_hit_ratio * 100)}%`
                      : "Chưa có dữ liệu"}
                  </dd>
                </div>
              </dl>
            </Card>
          ) : null}
          {clientCaps ? (
            <Card
              className="mt-6 bg-white"
              data-testid="admin-client-device-capabilities"
            >
              <h2 className="text-xl font-extrabold text-ink">
                Client Device Capabilities
              </h2>
              <p className="mt-1 text-xs text-muted">
                Kiểm tra năng lực chạy STT trên trình duyệt/WebView và bộ nhớ
                đệm thiết bị hiện tại.
              </p>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    WebAssembly SIMD
                  </dt>
                  <dd className="font-bold text-ink">
                    {clientCaps.wasmCaps.supported
                      ? clientCaps.wasmCaps.simd
                        ? "Sẵn sàng (SIMD)"
                        : "Hỗ trợ (không SIMD)"
                      : "Không hỗ trợ"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    Model STT (IndexedDB)
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {clientCaps.wasmCache.ready
                      ? `Đã tải (${formatByteSize(clientCaps.wasmCache.cachedBytes)})`
                      : `${clientCaps.wasmCache.cachedFiles}/${clientCaps.wasmCache.expectedFiles} tệp`}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    Cache TTS trình duyệt
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {clientCaps.ttsCache.supported
                      ? `${clientCaps.ttsCache.entryCount} mục (${formatByteSize(clientCaps.ttsCache.usedBytes)})`
                      : "Không khả dụng"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    Quyền Microphone
                  </dt>
                  <dd className="font-bold text-ink">
                    {clientCaps.micPermission === "granted"
                      ? "Đã cấp quyền"
                      : clientCaps.micPermission === "denied"
                        ? "Đã từ chối"
                        : clientCaps.micPermission === "prompt"
                          ? "Chưa hỏi"
                          : "Không rõ"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    Môi trường WebView
                  </dt>
                  <dd className="font-bold text-ink">
                    {clientCaps.isAndroidWebView
                      ? "ViRead Android WebView"
                      : "Trình duyệt Web"}
                  </dd>
                </div>
              </dl>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}
