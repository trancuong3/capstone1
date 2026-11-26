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
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type { TranslateFn } from "@/lib/i18n/types";
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

function formatPendingAge(seconds: number, t: TranslateFn): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  if (safeSeconds < 60) {
    return t("health.secondsUnit", { seconds: safeSeconds });
  }
  const minutes = Math.floor(safeSeconds / 60);
  const remSeconds = safeSeconds % 60;
  if (minutes < 60) {
    return remSeconds > 0
      ? t("health.minutesSecondsUnit", { minutes, seconds: remSeconds })
      : t("health.minutesUnit", { minutes });
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0
    ? t("health.hoursMinutesUnit", { hours, minutes: remMinutes })
    : t("health.hoursUnit", { hours });
}

function detailStatusLabel(status: RuntimeHealthDetailUI, t: TranslateFn) {
  return t(`health.detailStatus.${status}`);
}

export function AdminHealthScreen() {
  const { health } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDateTime, formatNumber, formatPercent } = useI18n();
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
        eyebrow={t("health.eyebrow")}
        title={t("health.title")}
        description={t("health.description")}
        actions={
          <Button
            disabled={!snapshot && !error}
            className="sm:w-auto"
            onClick={() => void load()}
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-5" /> {t("health.recheck")}
          </Button>
        }
      />
      {!snapshot && !error ? (
        <AdminLoading />
      ) : error ? (
        <StatusMessage tone="error">{t("health.loadError")}</StatusMessage>
      ) : snapshot ? (
        <>
          <Card className="mb-6 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-muted">
                  {t("health.servicesHeading")}
                </p>
                <h2 className="text-2xl font-semibold text-ink">
                  {t("common:brand.name")}
                </h2>
              </div>
              <AdminStatusBadge status={snapshot.overall_status} />
            </div>
            <p className="text-sm text-muted">
              {t("health.checkedAt", {
                time: formatDateTime(snapshot.checked_at),
              })}
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
                          {t(
                            `health.operationalStates.${service.operational_state}`,
                            undefined,
                            service.operational_state,
                          )}
                        </span>
                      ) : null}
                      <AdminStatusBadge status={service.status} />
                    </div>
                  </div>
                  {service.detail_status && (
                    <p className="text-xs font-semibold text-muted">
                      {t("health.technicalStatus", {
                        status: detailStatusLabel(service.detail_status, t),
                      })}
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
                          <dt className="font-semibold text-muted">
                            {t("health.queueDepthLabel")}
                          </dt>
                          <dd className="font-bold text-ink tabular-nums">
                            {service.queue_depth !== null
                              ? t("health.queueDepthValue", {
                                  count: service.queue_depth,
                                })
                              : t("health.notApplicable")}
                          </dd>
                        </div>
                      ) : null}
                      {service.oldest_pending_job_age_seconds !== undefined ? (
                        <div>
                          <dt className="font-semibold text-muted">
                            {t("health.oldestQueuedLabel")}
                          </dt>
                          <dd className="font-bold text-ink tabular-nums">
                            {service.oldest_pending_job_age_seconds !== null
                              ? formatPendingAge(
                                  service.oldest_pending_job_age_seconds,
                                  t,
                                )
                              : t("health.none")}
                          </dd>
                        </div>
                      ) : null}
                      {service.last_success_at !== undefined ? (
                        <div className="sm:col-span-2">
                          <dt className="font-semibold text-muted">
                            {t("health.lastSuccessLabel")}
                          </dt>
                          <dd className="font-semibold text-ink">
                            {service.last_success_at
                              ? formatDateTime(service.last_success_at)
                              : t("health.notRecorded")}
                          </dd>
                        </div>
                      ) : null}
                      {service.last_error ? (
                        <div className="sm:col-span-2 rounded-control border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-rose-900">
                          <dt className="font-bold">
                            {t("health.lastErrorLabel")}
                          </dt>
                          <dd className="mt-0.5 break-words">
                            {service.last_error}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                  <p className="text-xs text-muted">
                    {formatDateTime(service.checked_at)}
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
                  {t("health.ttsCacheHeading")}
                </h2>
                {snapshot.audio_cache.quota_exhausted ? (
                  <span className="rounded-pill border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-xs font-bold text-rose-900">
                    {t("health.ttsQuotaExhausted")}
                  </span>
                ) : null}
              </div>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    {t("health.ttsCacheEntries")}
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {formatNumber(snapshot.audio_cache.entry_count)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    {t("health.ttsCacheStorage")}
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {formatByteSize(snapshot.audio_cache.storage_used_bytes)} /{" "}
                    {formatByteSize(snapshot.audio_cache.storage_quota_bytes)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    {t("health.ttsCacheEgress")}
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
                    {t("health.ttsCacheHitRate")}
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {snapshot.audio_cache.cache_hit_ratio !== null
                      ? formatPercent(snapshot.audio_cache.cache_hit_ratio, {
                          maximumFractionDigits: 0,
                        })
                      : t("health.noData")}
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
                {t("health.clientDeviceHeading")}
              </h2>
              <p className="mt-1 text-xs text-muted">
                {t("health.sttSubtitle")}
              </p>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    {t("health.sttWasmLabel")}
                  </dt>
                  <dd className="font-bold text-ink">
                    {clientCaps.wasmCaps.supported
                      ? clientCaps.wasmCaps.simd
                        ? t("health.sttReadySimd")
                        : t("health.sttSupportedNoSimd")
                      : t("health.sttUnsupported")}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    {t("health.sttModelCacheLabel")}
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {clientCaps.wasmCache.ready
                      ? t("health.sttCachedLoaded", {
                          size: formatByteSize(
                            clientCaps.wasmCache.cachedBytes,
                          ),
                        })
                      : t("health.sttCachedFiles", {
                          cached: formatNumber(
                            clientCaps.wasmCache.cachedFiles,
                          ),
                          total: formatNumber(
                            clientCaps.wasmCache.expectedFiles,
                          ),
                        })}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    {t("health.sttBrowserTtsLabel")}
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {clientCaps.ttsCache.supported
                      ? t("health.sttBrowserTtsValue", {
                          count: formatNumber(clientCaps.ttsCache.entryCount),
                          size: formatByteSize(clientCaps.ttsCache.usedBytes),
                        })
                      : t("common.notAvailable")}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    {t("health.sttMicLabel")}
                  </dt>
                  <dd className="font-bold text-ink">
                    {clientCaps.micPermission === "granted"
                      ? t("health.sttMicGranted")
                      : clientCaps.micPermission === "denied"
                        ? t("health.sttMicDenied")
                        : clientCaps.micPermission === "prompt"
                          ? t("health.sttMicPrompt")
                          : t("health.sttMicUnknown")}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted">
                    {t("health.sttEnvLabel")}
                  </dt>
                  <dd className="font-bold text-ink">
                    {clientCaps.isAndroidWebView
                      ? t("health.sttEnvWebView")
                      : t("health.sttEnvBrowser")}
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
