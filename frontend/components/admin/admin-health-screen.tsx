"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Cpu,
  HardDrive,
  Info,
  Laptop,
  Mic,
  Moon,
  RefreshCw,
  Server,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Trash2,
  Volume2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AdminBadge,
  AdminKpiCard,
  AdminKpiGrid,
  AdminLoading,
  AdminPageHeader,
  AdminStatusBadge,
  type AdminBadgeTone,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { TranslateFn } from "@/lib/i18n/types";
import {
  clearWasmModelCache,
  detectBrowserWasmSttSupport,
  getWasmModelCacheStatus,
  type BrowserWasmCapabilities,
  type WasmModelCacheStatus,
} from "@/lib/reading/browser-wasm-stt";
import {
  clearBrowserTtsCache,
  getBrowserTtsCacheStats,
  type BrowserTtsCacheStats,
} from "@/lib/reading/tts-audio-cache";
import { cn } from "@/lib/utils/cn";
import type {
  AudioCacheHealthSummaryUI,
  HealthExecutionModeUI,
  HealthOperationalStateUI,
  HealthServiceItemUI,
  HealthSnapshotUI,
  RuntimeHealthDetailUI,
} from "@/types/admin";

const HEALTH_FETCH_TIMEOUT_MS = 15_000;
const MIC_PERMISSION_TIMEOUT_MS = 2_000;
const WAKE_RECHECK_DELAY_MS = 2_500;

type AutoRefreshIntervalSeconds = 0 | 30 | 60;
type HealthFilterKey =
  "all" | "attention" | "healthy" | "standby" | "local_only";
type ServiceBucket = Exclude<HealthFilterKey, "all">;
type DeviceEnvironmentKind =
  | "viread_android_webview"
  | "android_webview"
  | "ios_webview"
  | "pwa"
  | "browser";

interface HealthFetchErrorInfo {
  readonly status: number | null;
  readonly requestId: string | null;
  readonly message: string | null;
  readonly isTimeout: boolean;
}

interface ClientDeviceCapabilitiesSnapshot {
  readonly wasmCaps: BrowserWasmCapabilities;
  readonly wasmCache: WasmModelCacheStatus;
  readonly ttsCache: BrowserTtsCacheStats;
  readonly micPermission: PermissionState | "unsupported";
  readonly hasMediaDevices: boolean;
  readonly environment: DeviceEnvironmentKind;
}

interface ActionNotice {
  readonly tone: "success" | "warning" | "error";
  readonly message: string;
}

const CORE_IDS = new Set(["api", "database", "storage"]);
const CORE_ORDER: readonly string[] = ["api", "database", "storage"];
const VOICE_IDS = new Set(["tts", "stt", "tts_audio_cache"]);
const VOICE_ORDER: readonly string[] = ["tts", "stt", "tts_audio_cache"];
const OCR_ENGINE_IDS = new Set([
  "paddleocr",
  "vietocr",
  "tesseract",
  "tesseract_vie",
]);
const OCR_ENGINE_ORDER: readonly string[] = [
  "paddleocr",
  "vietocr",
  "tesseract",
  "tesseract_vie",
];
const CLOUD_WORKER_ORDER: readonly string[] = [
  "viread_ocr_outbox",
  "viread_ocr_training",
  "book_quality",
  "admin_ai_workflow",
  "parent_book_submission",
  "reading_reminder",
  "reading_presence",
];
const LOCAL_ONLY_MODES = new Set<HealthExecutionModeUI>([
  "local_only",
  "disabled_opt_in",
  "remote_delegated",
]);

const OPERATIONAL_STATE_FALLBACK_LABELS: Record<
  HealthOperationalStateUI,
  string
> = {
  Healthy: "Ổn định",
  Degraded: "Suy giảm",
  Offline: "Ngoại tuyến",
  Queued: "Đang xếp hàng",
  "Quota exhausted": "Vượt hạn mức",
  Unsupported: "Không hỗ trợ",
  Unknown: "Không rõ",
  Standby: "Chờ kích hoạt",
  Scheduled: "Theo lịch",
  "Local only": "Chỉ cục bộ",
};

const OPERATIONAL_STATE_PILL_STYLES: Record<
  HealthOperationalStateUI,
  { readonly badge: string; readonly dot: string }
> = {
  Healthy: {
    badge: "border-emerald-200 bg-success-surface text-success-ink",
    dot: "bg-emerald-600",
  },
  Scheduled: {
    badge: "border-emerald-200 bg-success-surface text-success-ink",
    dot: "bg-emerald-600",
  },
  Standby: {
    badge: "border-primary/25 bg-sky text-primary-hover",
    dot: "bg-primary",
  },
  Queued: {
    badge: "border-sky-200 bg-sky-50 text-sky-900",
    dot: "bg-sky-600",
  },
  Degraded: {
    badge: "border-amber-200 bg-warning-surface text-warning",
    dot: "bg-amber-600",
  },
  Offline: {
    badge: "border-danger/25 bg-danger-surface text-danger",
    dot: "bg-danger",
  },
  "Quota exhausted": {
    badge: "border-rose-200 bg-rose-50 text-rose-900",
    dot: "bg-rose-600",
  },
  "Local only": {
    badge: "border-border bg-surface-subtle text-muted",
    dot: "bg-muted",
  },
  Unsupported: {
    badge: "border-border bg-surface-subtle text-muted",
    dot: "bg-muted",
  },
  Unknown: {
    badge: "border-amber-200 bg-warning-surface/75 text-warning",
    dot: "bg-amber-500",
  },
};

const DETAIL_STATUS_FALLBACK_LABELS: Record<RuntimeHealthDetailUI, string> = {
  installed: "Đã cài",
  initialized: "Đã khởi tạo",
  loaded: "Đã nạp model",
  healthy: "Đã xác minh",
  failed: "Gặp lỗi",
  unknown: "Chưa xác minh",
  disabled: "Chưa chạy",
  standby: "Chế độ chờ",
  cached: "Dùng bộ nhớ đệm",
  client_side: "Chạy trên trình duyệt",
  cloud_ready: "Đám mây sẵn sàng",
  scheduled: "Theo lịch định kỳ",
  remote_delegated: "Ủy quyền từ xa",
  local_only: "Chỉ chạy cục bộ",
};

function formatByteSize(
  bytes: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  const safe =
    typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0
      ? bytes
      : 0;
  if (safe < 1024) {
    return `${formatNumber(Math.round(safe))} B`;
  }
  if (safe < 1024 * 1024) {
    return `${formatNumber(safe / 1024, { maximumFractionDigits: 1 })} KB`;
  }
  if (safe < 1024 * 1024 * 1024) {
    return `${formatNumber(safe / (1024 * 1024), {
      maximumFractionDigits: 2,
    })} MB`;
  }
  return `${formatNumber(safe / (1024 * 1024 * 1024), {
    maximumFractionDigits: 2,
  })} GB`;
}

function formatPendingAge(seconds: number, t: TranslateFn): string {
  const safeSeconds = Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds))
    : 0;
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

function resolveEffectiveOperationalState(
  service: HealthServiceItemUI,
): HealthOperationalStateUI {
  if (service.operational_state) {
    return service.operational_state;
  }
  if (
    service.detail_status === "local_only" ||
    ((service.execution_mode === "local_only" ||
      service.execution_mode === "disabled_opt_in") &&
      service.status === "HEALTHY")
  ) {
    return "Local only";
  }
  if (
    service.detail_status === "standby" ||
    service.detail_status === "remote_delegated"
  ) {
    return "Standby";
  }
  if (service.detail_status === "scheduled" && service.status === "HEALTHY") {
    return "Scheduled";
  }
  if (service.status === "HEALTHY") {
    return "Healthy";
  }
  if (service.status === "UNAVAILABLE") {
    return "Offline";
  }
  return "Degraded";
}

function classifyServiceBucket(service: HealthServiceItemUI): ServiceBucket {
  const state = resolveEffectiveOperationalState(service);
  if (
    state === "Local only" ||
    ((service.execution_mode === "local_only" ||
      service.execution_mode === "disabled_opt_in" ||
      service.detail_status === "local_only") &&
      service.status === "HEALTHY")
  ) {
    return "local_only";
  }
  if (state === "Standby") {
    return "standby";
  }
  if (
    service.status === "UNAVAILABLE" ||
    service.status === "DEGRADED" ||
    state === "Degraded" ||
    state === "Offline" ||
    state === "Quota exhausted" ||
    state === "Unknown" ||
    state === "Unsupported" ||
    Boolean(service.last_error)
  ) {
    return "attention";
  }
  return "healthy";
}

function isLocalOrDelegatedGroupItem(service: HealthServiceItemUI): boolean {
  const state = resolveEffectiveOperationalState(service);
  if (state === "Local only") return true;
  if (service.id === "local_ocr") {
    return false;
  }
  if (service.execution_mode && LOCAL_ONLY_MODES.has(service.execution_mode)) {
    return true;
  }
  if (
    service.id === "active_model_registry" &&
    (service.detail_status === "remote_delegated" || state === "Standby")
  ) {
    return true;
  }
  if (
    service.id === "local_trainer_process" &&
    service.detail_status === "local_only"
  ) {
    return true;
  }
  if (
    service.id === "karaoke_processing" &&
    (service.detail_status === "local_only" ||
      service.execution_mode === "disabled_opt_in")
  ) {
    return true;
  }
  return false;
}

function sortByOrder(
  items: readonly HealthServiceItemUI[],
  order: readonly string[],
): HealthServiceItemUI[] {
  const rank = new Map(order.map((id, idx) => [id, idx]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id) ?? 999;
    const rb = rank.get(b.id) ?? 999;
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label);
  });
}

function detectDeviceEnvironment(): DeviceEnvironmentKind {
  if (typeof navigator === "undefined") {
    return "browser";
  }
  const ua = navigator.userAgent || "";
  if (/ViReadAndroid\//i.test(ua)) {
    return "viread_android_webview";
  }
  if (
    /;\s*wv\)/i.test(ua) ||
    (/\bAndroid\b/i.test(ua) && /\bVersion\/\d/i.test(ua))
  ) {
    return "android_webview";
  }
  if (/(iPhone|iPod|iPad)/i.test(ua) && !/Safari\//i.test(ua)) {
    return "ios_webview";
  }
  const isStandalone =
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches) ||
    (navigator as Navigator & { readonly standalone?: boolean }).standalone ===
      true;
  if (isStandalone) {
    return "pwa";
  }
  return "browser";
}

function getUtilizationBarTone(
  percent: number | null,
  forceDanger = false,
): { readonly bar: string; readonly text: string } {
  if (forceDanger || (percent !== null && percent >= 95)) {
    return { bar: "bg-rose-500", text: "text-rose-700" };
  }
  if (percent !== null && percent >= 80) {
    return { bar: "bg-amber-500", text: "text-amber-800" };
  }
  return { bar: "bg-emerald-600", text: "text-emerald-700" };
}

function detailStatusLabel(status: RuntimeHealthDetailUI, t: TranslateFn) {
  return t(
    `health.detailStatus.${status}`,
    undefined,
    DETAIL_STATUS_FALLBACK_LABELS[status],
  );
}

function hasAnyWorkerMetrics(service: HealthServiceItemUI): boolean {
  return (
    service.queue_depth != null ||
    service.oldest_pending_job_age_seconds != null ||
    service.last_success_at != null ||
    Boolean(service.last_error)
  );
}

interface ServiceCardProps {
  readonly service: HealthServiceItemUI;
  readonly snapshotCheckedAt: string;
  readonly compact?: boolean;
  readonly t: TranslateFn;
  readonly formatDateTime: (value: Date | string | number) => string;
  readonly extraFooter?: React.ReactNode;
}

function ServiceStatusCard({
  service,
  snapshotCheckedAt,
  compact = false,
  t,
  formatDateTime,
  extraFooter,
}: ServiceCardProps) {
  const effectiveState = resolveEffectiveOperationalState(service);
  const pillStyle = OPERATIONAL_STATE_PILL_STYLES[effectiveState];
  const stateLabel = t(
    `health.operationalStates.${effectiveState}`,
    undefined,
    OPERATIONAL_STATE_FALLBACK_LABELS[effectiveState],
  );
  const showDetailStatus =
    Boolean(service.detail_status) && service.detail_status !== "healthy";
  const showWorkerMetrics = hasAnyWorkerMetrics(service);
  const showCardCheckedAt =
    Boolean(service.checked_at) && service.checked_at !== snapshotCheckedAt;
  const bucket = classifyServiceBucket(service);

  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-xl border bg-white shadow-2xs transition-colors",
        compact ? "p-3.5" : "p-4",
        bucket === "attention" ? "border-amber-200/90" : "border-border",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <h3
          className={cn(
            "min-w-0 font-bold tracking-tight text-ink break-words",
            compact ? "text-sm leading-snug" : "text-base leading-snug",
          )}
        >
          {service.label}
        </h3>
        <span
          className={cn(
            "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-bold leading-5 whitespace-nowrap",
            pillStyle.badge,
          )}
          data-testid={`operational-state-${service.id}`}
        >
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", pillStyle.dot)}
          />
          {stateLabel}
        </span>
      </div>

      {showDetailStatus && service.detail_status ? (
        <p className="text-xs font-semibold text-muted">
          {t("health.technicalStatus", {
            status: detailStatusLabel(service.detail_status, t),
          })}
        </p>
      ) : null}

      <p className="text-sm leading-relaxed text-muted break-words">
        {service.safe_message}
      </p>

      {service.action_hint ? (
        <div className="flex items-start gap-2 rounded-control border border-border/80 bg-surface-subtle/80 px-2.5 py-2 text-xs leading-relaxed text-ink">
          <Info
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-primary"
          />
          <p className="min-w-0 break-words">
            <span className="font-bold">
              {t("health.actionHintLabel", undefined, "Gợi ý xử lý")}:{" "}
            </span>
            {service.action_hint}
          </p>
        </div>
      ) : null}

      {showWorkerMetrics ? (
        <dl
          className="mt-0.5 grid grid-cols-1 gap-2 rounded-control border border-border bg-surface-subtle/70 p-2.5 text-xs sm:grid-cols-2"
          data-testid={`worker-metrics-${service.id}`}
        >
          {service.queue_depth != null ? (
            <div className="min-w-0">
              <dt className="font-semibold text-muted">
                {t("health.queueDepthLabel")}
              </dt>
              <dd className="font-bold text-ink tabular-nums">
                {t("health.queueDepthValue", { count: service.queue_depth })}
              </dd>
            </div>
          ) : null}
          {service.oldest_pending_job_age_seconds != null ? (
            <div className="min-w-0">
              <dt className="font-semibold text-muted">
                {t("health.oldestQueuedLabel")}
              </dt>
              <dd className="font-bold text-ink tabular-nums">
                {formatPendingAge(service.oldest_pending_job_age_seconds, t)}
              </dd>
            </div>
          ) : null}
          {service.last_success_at !== undefined ? (
            <div className="min-w-0 sm:col-span-2">
              <dt className="font-semibold text-muted">
                {t("health.lastSuccessLabel")}
              </dt>
              <dd className="font-semibold text-ink tabular-nums">
                {service.last_success_at
                  ? formatDateTime(service.last_success_at)
                  : t("health.notRecorded")}
              </dd>
            </div>
          ) : null}
          {service.last_error ? (
            <div className="min-w-0 rounded-control border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-rose-900 sm:col-span-2">
              <dt className="font-bold">{t("health.lastErrorLabel")}</dt>
              <dd className="mt-0.5 font-mono text-[11px] break-words">
                {service.last_error}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {extraFooter}

      {showCardCheckedAt ? (
        <p className="mt-auto pt-1 text-[11px] text-muted tabular-nums">
          {formatDateTime(service.checked_at)}
        </p>
      ) : null}
    </article>
  );
}

interface UtilizationBarProps {
  readonly label: string;
  readonly percent: number | null;
  readonly forceDanger?: boolean;
  readonly formatPercent: (
    value: number,
    options?: Intl.NumberFormatOptions & { readonly isRatio?: boolean },
  ) => string;
  readonly t: TranslateFn;
}

function UtilizationBar({
  label,
  percent,
  forceDanger = false,
  formatPercent,
  t,
}: UtilizationBarProps) {
  if (percent === null) return null;
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = getUtilizationBarTone(clamped, forceDanger);
  const percentText = formatPercent(clamped / 100, {
    maximumFractionDigits: 0,
  });

  return (
    <div className="mt-1.5 space-y-1">
      <div
        aria-label={t(
          "health.audioCacheUsageAria",
          { label, percent: Math.round(clamped) },
          "Mức sử dụng {label}: {percent}%",
        )}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(clamped)}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-subtle"
        role="progressbar"
      >
        <div
          className={cn("h-full rounded-full transition-all", tone.bar)}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <p className={cn("text-[11px] font-semibold tabular-nums", tone.text)}>
        {t(
          "health.audioCachePercentUsed",
          { percent: percentText },
          "{percent} đã dùng",
        )}
      </p>
    </div>
  );
}

interface AudioCacheSummaryPanelProps {
  readonly audioCache: AudioCacheHealthSummaryUI;
  readonly t: TranslateFn;
  readonly formatNumber: (
    value: number,
    options?: Intl.NumberFormatOptions,
  ) => string;
  readonly formatPercent: (
    value: number,
    options?: Intl.NumberFormatOptions & { readonly isRatio?: boolean },
  ) => string;
}

function AudioCacheSummaryPanel({
  audioCache,
  t,
  formatNumber,
  formatPercent,
}: AudioCacheSummaryPanelProps) {
  const storagePct =
    audioCache.storage_quota_bytes > 0
      ? Math.min(
          100,
          (Math.max(0, audioCache.storage_used_bytes) /
            audioCache.storage_quota_bytes) *
            100,
        )
      : null;

  const hasEgressLimit =
    audioCache.daily_egress_limit_bytes !== null &&
    audioCache.daily_egress_limit_bytes !== undefined;
  const egressLimit = hasEgressLimit
    ? Math.max(0, audioCache.daily_egress_limit_bytes)
    : null;
  const egressPct =
    egressLimit !== null && egressLimit > 0
      ? Math.min(
          100,
          (Math.max(0, audioCache.daily_egress_bytes) / egressLimit) * 100,
        )
      : egressLimit === 0 && audioCache.daily_egress_bytes > 0
        ? 100
        : null;

  return (
    <div
      className="rounded-xl border border-border bg-white p-4 shadow-2xs"
      data-testid="admin-audio-cache-summary"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <HardDrive
            aria-hidden="true"
            className="size-4 shrink-0 text-primary"
          />
          <h3 className="text-base font-bold text-ink">
            {t("health.ttsCacheHeading")}
          </h3>
        </div>
        {audioCache.quota_exhausted ? (
          <AdminBadge dot tone="danger">
            {t("health.ttsQuotaExhausted")}
          </AdminBadge>
        ) : null}
      </div>

      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0 rounded-control border border-border/70 bg-surface-subtle/50 p-3">
          <dt className="text-xs font-semibold text-muted">
            {t("health.ttsCacheEntries")}
          </dt>
          <dd className="mt-1 text-lg font-extrabold text-ink tabular-nums">
            {formatNumber(audioCache.entry_count)}
          </dd>
        </div>

        <div className="min-w-0 rounded-control border border-border/70 bg-surface-subtle/50 p-3">
          <dt className="text-xs font-semibold text-muted">
            {t("health.ttsCacheStorage")}
          </dt>
          <dd className="mt-1 font-bold text-ink tabular-nums">
            {formatByteSize(audioCache.storage_used_bytes, formatNumber)} /{" "}
            {audioCache.storage_quota_bytes > 0
              ? formatByteSize(audioCache.storage_quota_bytes, formatNumber)
              : t("health.audioCacheUnlimited", undefined, "Không giới hạn")}
          </dd>
          <UtilizationBar
            forceDanger={Boolean(audioCache.quota_exhausted)}
            formatPercent={formatPercent}
            label={t("health.ttsCacheStorage")}
            percent={storagePct}
            t={t}
          />
        </div>

        <div className="min-w-0 rounded-control border border-border/70 bg-surface-subtle/50 p-3">
          <dt className="text-xs font-semibold text-muted">
            {t("health.ttsCacheEgress")}
          </dt>
          <dd className="mt-1 font-bold text-ink tabular-nums">
            {formatByteSize(audioCache.daily_egress_bytes, formatNumber)}
            {egressLimit !== null
              ? ` / ${formatByteSize(egressLimit, formatNumber)}`
              : ""}
          </dd>
          <UtilizationBar
            forceDanger={Boolean(audioCache.quota_exhausted)}
            formatPercent={formatPercent}
            label={t("health.ttsCacheEgress")}
            percent={egressPct}
            t={t}
          />
        </div>

        <div className="min-w-0 rounded-control border border-border/70 bg-surface-subtle/50 p-3">
          <dt className="text-xs font-semibold text-muted">
            {t("health.ttsCacheHitRate")}
          </dt>
          <dd className="mt-1 text-lg font-extrabold text-ink tabular-nums">
            {audioCache.cache_hit_ratio !== null
              ? formatPercent(audioCache.cache_hit_ratio, {
                  maximumFractionDigits: 0,
                })
              : t("health.noData")}
          </dd>
        </div>
      </dl>
    </div>
  );
}

interface SectionHeaderProps {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly badge?: React.ReactNode;
}

function GroupSectionHeader({
  icon,
  title,
  description,
  badge,
}: SectionHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-white text-primary shadow-2xs"
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-extrabold tracking-tight text-ink sm:text-lg">
            {title}
          </h2>
          {description ? (
            <p className="text-xs leading-relaxed text-muted">{description}</p>
          ) : null}
        </div>
      </div>
      {badge}
    </div>
  );
}

export function AdminHealthScreen() {
  const { health } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDateTime, formatNumber, formatPercent } = useI18n();

  const [snapshot, setSnapshot] = useState<HealthSnapshotUI | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<HealthFetchErrorInfo | null>(
    null,
  );
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [autoRefreshSec, setAutoRefreshSec] =
    useState<AutoRefreshIntervalSeconds>(0);
  const [isTabHidden, setIsTabHidden] = useState(false);

  const [activeFilter, setActiveFilter] = useState<HealthFilterKey>("all");
  const [localGroupManualOpen, setLocalGroupManualOpen] = useState<
    boolean | null
  >(null);

  const [isWakingOcr, setIsWakingOcr] = useState(false);
  const [wakeNotice, setWakeNotice] = useState<ActionNotice | null>(null);

  const [clientCaps, setClientCaps] =
    useState<ClientDeviceCapabilitiesSnapshot | null>(null);
  const [isProbingClient, setIsProbingClient] = useState(false);
  const [clientProbeError, setClientProbeError] = useState(false);
  const [clientActionNotice, setClientActionNotice] =
    useState<ActionNotice | null>(null);
  const [isClearingWasm, setIsClearingWasm] = useState(false);
  const [isClearingTts, setIsClearingTts] = useState(false);

  const mountedRef = useRef(true);
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const healthRequestSeqRef = useRef(0);
  const healthAbortRef = useRef<AbortController | null>(null);
  const isRefreshingRef = useRef(false);
  const wakeAbortRef = useRef<AbortController | null>(null);
  const wakeRecheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clientProbeSeqRef = useRef(0);
  const micPermissionStatusRef = useRef<PermissionStatus | null>(null);

  const clearWakeRecheckTimer = useCallback(() => {
    if (wakeRecheckTimerRef.current !== null) {
      globalThis.clearTimeout(wakeRecheckTimerRef.current);
      wakeRecheckTimerRef.current = null;
    }
  }, []);

  const fetchHealthAsync = useCallback(
    async (options?: { forceFresh?: boolean }) => {
      const forceFresh = Boolean(options?.forceFresh);
      if (!forceFresh && isRefreshingRef.current) {
        return;
      }
      clearWakeRecheckTimer();
      const seq = ++healthRequestSeqRef.current;
      if (forceFresh) {
        healthAbortRef.current?.abort();
      }
      const controller = new AbortController();
      healthAbortRef.current = controller;
      isRefreshingRef.current = true;

      let timedOut = false;
      const timeoutId = globalThis.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, HEALTH_FETCH_TIMEOUT_MS);

      try {
        const nextSnapshot = forceFresh
          ? await health.get(controller.signal, { forceFresh: true })
          : await health.get(controller.signal);
        if (!mountedRef.current || seq !== healthRequestSeqRef.current) {
          return;
        }
        setSnapshot(nextSnapshot);
        setFetchError(null);
        setErrorDismissed(false);
      } catch (err) {
        if (!mountedRef.current || seq !== healthRequestSeqRef.current) {
          return;
        }
        if (!timedOut && controller.signal.aborted) {
          return;
        }
        if (timedOut) {
          setFetchError({
            status: null,
            requestId: null,
            message: tRef.current(
              "health.refreshTimeoutError",
              undefined,
              "Yêu cầu kiểm tra vượt quá thời gian chờ 15 giây.",
            ),
            isTimeout: true,
          });
        } else if (isServiceError(err)) {
          setFetchError({
            status: err.status > 0 ? err.status : null,
            requestId: err.request_id || null,
            message: err.message || null,
            isTimeout: false,
          });
        } else {
          setFetchError({
            status: null,
            requestId: null,
            message: null,
            isTimeout: false,
          });
        }
      } finally {
        globalThis.clearTimeout(timeoutId);
        if (mountedRef.current && seq === healthRequestSeqRef.current) {
          isRefreshingRef.current = false;
          setIsInitialLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [clearWakeRecheckTimer, health],
  );

  const executeHealthFetch = useCallback(
    async (options?: { forceFresh?: boolean }) => {
      setIsRefreshing(true);
      setErrorDismissed(false);
      await fetchHealthAsync(options);
    },
    [fetchHealthAsync],
  );

  const probeClientAsync = useCallback(async () => {
    const seq = ++clientProbeSeqRef.current;

    if (micPermissionStatusRef.current) {
      micPermissionStatusRef.current.onchange = null;
      micPermissionStatusRef.current = null;
    }

    try {
      const wasmCaps = detectBrowserWasmSttSupport();
      const [wasmCache, ttsCache] = await Promise.all([
        getWasmModelCacheStatus().catch((): WasmModelCacheStatus => ({
          ready: false,
          cachedFiles: 0,
          expectedFiles: 4,
          cachedBytes: 0,
          totalBytes: 0,
          supported: false,
          error: "PROBE_FAILED",
        })),
        getBrowserTtsCacheStats().catch((): BrowserTtsCacheStats => ({
          supported: false,
          entryCount: 0,
          usedBytes: 0,
          quotaBytes: 0,
          hits: 0,
          misses: 0,
          error: "PROBE_FAILED",
        })),
      ]);

      const hasMediaDevices =
        typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getUserMedia === "function";

      let micPermission: PermissionState | "unsupported" = "unsupported";
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.permissions?.query === "function"
      ) {
        let permTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          const perm = await Promise.race<PermissionStatus | null>([
            navigator.permissions.query({
              name: "microphone" as PermissionName,
            }),
            new Promise<null>((resolve) => {
              permTimer = globalThis.setTimeout(
                () => resolve(null),
                MIC_PERMISSION_TIMEOUT_MS,
              );
            }),
          ]);
          if (permTimer !== null) {
            globalThis.clearTimeout(permTimer);
          }
          if (perm && mountedRef.current && seq === clientProbeSeqRef.current) {
            micPermission = perm.state;
            micPermissionStatusRef.current = perm;
            perm.onchange = () => {
              if (!mountedRef.current || seq !== clientProbeSeqRef.current) {
                return;
              }
              setClientCaps((prev) =>
                prev ? { ...prev, micPermission: perm.state } : prev,
              );
            };
          }
        } catch {
          if (permTimer !== null) {
            globalThis.clearTimeout(permTimer);
          }
          micPermission = "unsupported";
        }
      }

      if (!mountedRef.current || seq !== clientProbeSeqRef.current) {
        return;
      }

      setClientCaps({
        wasmCaps,
        wasmCache,
        ttsCache,
        micPermission,
        hasMediaDevices,
        environment: detectDeviceEnvironment(),
      });
      setClientProbeError(false);
    } catch {
      if (!mountedRef.current || seq !== clientProbeSeqRef.current) {
        return;
      }
      setClientProbeError(true);
    } finally {
      if (mountedRef.current && seq === clientProbeSeqRef.current) {
        setIsProbingClient(false);
      }
    }
  }, []);

  const probeClientDevice = useCallback(async () => {
    setIsProbingClient(true);
    setClientProbeError(false);
    await probeClientAsync();
  }, [probeClientAsync]);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    queueMicrotask(() => {
      if (!active || !mountedRef.current) return;
      void fetchHealthAsync();
      void probeClientAsync().catch(() => undefined);
    });

    return () => {
      active = false;
      mountedRef.current = false;
      healthRequestSeqRef.current += 1;
      clientProbeSeqRef.current += 1;
      healthAbortRef.current?.abort();
      wakeAbortRef.current?.abort();
      clearWakeRecheckTimer();
      if (micPermissionStatusRef.current) {
        micPermissionStatusRef.current.onchange = null;
        micPermissionStatusRef.current = null;
      }
    };
  }, [clearWakeRecheckTimer, fetchHealthAsync, probeClientAsync]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibility = () => {
      setIsTabHidden(document.hidden);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (autoRefreshSec === 0 || isTabHidden) return;
    const intervalId = globalThis.setInterval(() => {
      if (
        (typeof document === "undefined" || !document.hidden) &&
        !isRefreshingRef.current
      ) {
        void executeHealthFetch();
      }
    }, autoRefreshSec * 1000);
    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [autoRefreshSec, executeHealthFetch, isTabHidden]);

  const handleManualRecheck = useCallback(() => {
    void executeHealthFetch({ forceFresh: true });
  }, [executeHealthFetch]);

  const handleWakeOcrWorker = useCallback(async () => {
    if (isWakingOcr) return;
    setIsWakingOcr(true);
    setWakeNotice(null);
    wakeAbortRef.current?.abort();
    const controller = new AbortController();
    wakeAbortRef.current = controller;

    try {
      const response = await health.wakeOcrWorker(controller.signal);
      if (!mountedRef.current) return;
      if (response.woken) {
        const suffix = tRef.current(
          "health.wakeOcrRechecking",
          undefined,
          "Tự động kiểm tra lại sau vài giây…",
        );
        setWakeNotice({
          tone: "success",
          message: response.detail ? `${response.detail} ${suffix}` : suffix,
        });
        clearWakeRecheckTimer();
        wakeRecheckTimerRef.current = globalThis.setTimeout(() => {
          wakeRecheckTimerRef.current = null;
          if (mountedRef.current) {
            void executeHealthFetch({ forceFresh: true });
          }
        }, WAKE_RECHECK_DELAY_MS);
      } else {
        setWakeNotice({
          tone: "warning",
          message:
            response.detail ||
            t(
              "health.wakeOcrError",
              undefined,
              "Không thể gửi lệnh đánh thức OCR worker. Vui lòng thử lại.",
            ),
        });
      }
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      const safeDetail =
        isServiceError(err) && err.message ? err.message : null;
      setWakeNotice({
        tone: "error",
        message:
          safeDetail ??
          t(
            "health.wakeOcrError",
            undefined,
            "Không thể gửi lệnh đánh thức OCR worker. Vui lòng thử lại.",
          ),
      });
    } finally {
      if (mountedRef.current) {
        setIsWakingOcr(false);
      }
    }
  }, [clearWakeRecheckTimer, executeHealthFetch, health, isWakingOcr, t]);

  const handleClearWasmCache = useCallback(async () => {
    if (isClearingWasm) return;
    setIsClearingWasm(true);
    setClientActionNotice(null);
    try {
      const ok = await clearWasmModelCache();
      if (!mountedRef.current) return;
      setClientActionNotice(
        ok
          ? {
              tone: "success",
              message: t(
                "health.clearWasmCacheSuccess",
                undefined,
                "Đã xóa cache model STT trên trình duyệt.",
              ),
            }
          : {
              tone: "warning",
              message: t(
                "health.clearWasmCacheError",
                undefined,
                "Không thể xóa cache model STT lúc này.",
              ),
            },
      );
      await probeClientDevice();
    } catch {
      if (!mountedRef.current) return;
      setClientActionNotice({
        tone: "error",
        message: t(
          "health.clearWasmCacheError",
          undefined,
          "Không thể xóa cache model STT lúc này.",
        ),
      });
    } finally {
      if (mountedRef.current) {
        setIsClearingWasm(false);
      }
    }
  }, [isClearingWasm, probeClientDevice, t]);

  const handleClearTtsCache = useCallback(async () => {
    if (isClearingTts) return;
    setIsClearingTts(true);
    setClientActionNotice(null);
    try {
      const ok = await clearBrowserTtsCache();
      if (!mountedRef.current) return;
      setClientActionNotice(
        ok
          ? {
              tone: "success",
              message: t(
                "health.clearTtsCacheSuccess",
                undefined,
                "Đã xóa cache TTS trên trình duyệt.",
              ),
            }
          : {
              tone: "warning",
              message: t(
                "health.clearTtsCacheError",
                undefined,
                "Không thể xóa cache TTS lúc này.",
              ),
            },
      );
      await probeClientDevice();
    } catch {
      if (!mountedRef.current) return;
      setClientActionNotice({
        tone: "error",
        message: t(
          "health.clearTtsCacheError",
          undefined,
          "Không thể xóa cache TTS lúc này.",
        ),
      });
    } finally {
      if (mountedRef.current) {
        setIsClearingTts(false);
      }
    }
  }, [isClearingTts, probeClientDevice, t]);

  const counts = useMemo(() => {
    const services = snapshot?.services ?? [];
    let healthy = 0;
    let attention = 0;
    let standby = 0;
    let localOnly = 0;
    for (const service of services) {
      const bucket = classifyServiceBucket(service);
      if (bucket === "healthy") healthy += 1;
      else if (bucket === "attention") attention += 1;
      else if (bucket === "standby") standby += 1;
      else localOnly += 1;
    }
    return {
      all: services.length,
      healthy,
      attention,
      standby,
      local_only: localOnly,
    };
  }, [snapshot]);

  const groupedServices = useMemo(() => {
    const services = snapshot?.services ?? [];
    const filtered =
      activeFilter === "all"
        ? services
        : services.filter(
            (service) => classifyServiceBucket(service) === activeFilter,
          );

    const core: HealthServiceItemUI[] = [];
    const voice: HealthServiceItemUI[] = [];
    let ocrWorker: HealthServiceItemUI | null = null;
    const ocrEngines: HealthServiceItemUI[] = [];
    const ocrExtra: HealthServiceItemUI[] = [];
    const cloudWorkers: HealthServiceItemUI[] = [];
    const localOnlyWorkers: HealthServiceItemUI[] = [];

    for (const service of filtered) {
      if (CORE_IDS.has(service.id) || service.service_group === "core") {
        core.push(service);
      } else if (
        VOICE_IDS.has(service.id) ||
        service.service_group === "voice"
      ) {
        voice.push(service);
      } else if (service.id === "ocr_worker") {
        ocrWorker = service;
      } else if (OCR_ENGINE_IDS.has(service.id)) {
        ocrEngines.push(service);
      } else if (service.id === "local_ocr") {
        if (resolveEffectiveOperationalState(service) === "Local only") {
          localOnlyWorkers.push(service);
        } else {
          ocrExtra.push(service);
        }
      } else if (service.service_group === "ocr") {
        ocrExtra.push(service);
      } else if (isLocalOrDelegatedGroupItem(service)) {
        localOnlyWorkers.push(service);
      } else {
        cloudWorkers.push(service);
      }
    }

    return {
      totalMatched: filtered.length,
      core: sortByOrder(core, CORE_ORDER),
      voice: sortByOrder(voice, VOICE_ORDER),
      ocrWorker,
      ocrEngines: sortByOrder(ocrEngines, OCR_ENGINE_ORDER),
      ocrExtra,
      cloudWorkers: sortByOrder(cloudWorkers, CLOUD_WORKER_ORDER),
      localOnlyWorkers,
    };
  }, [activeFilter, snapshot]);

  const summarySentence = useMemo(() => {
    if (!snapshot) return "";
    if (
      counts.attention === 0 &&
      counts.standby === 0 &&
      counts.local_only === 0
    ) {
      return t(
        "health.summaryAllHealthy",
        { healthy: counts.healthy },
        "Tất cả {healthy} dịch vụ đang hoạt động ổn định.",
      );
    }
    const parts: string[] = [];
    if (counts.attention > 0) {
      parts.push(
        t(
          "health.summaryAttentionSegment",
          { count: counts.attention },
          "{count} cần chú ý",
        ),
      );
    }
    if (counts.healthy > 0) {
      parts.push(
        t(
          "health.summaryHealthySegment",
          { count: counts.healthy },
          "{count} hoạt động",
        ),
      );
    }
    if (counts.standby > 0) {
      parts.push(
        t(
          "health.summaryStandbySegment",
          { count: counts.standby },
          "{count} chờ kích hoạt",
        ),
      );
    }
    if (counts.local_only > 0) {
      parts.push(
        t(
          "health.summaryLocalOnlySegment",
          { count: counts.local_only },
          "{count} chỉ cục bộ",
        ),
      );
    }
    return parts.join(" · ");
  }, [counts, snapshot, t]);

  const localOnlyHasAttention = groupedServices.localOnlyWorkers.some(
    (item) => classifyServiceBucket(item) === "attention",
  );
  const autoExpandLocalGroup = activeFilter !== "all" || localOnlyHasAttention;
  const isLocalGroupExpanded =
    autoExpandLocalGroup || localGroupManualOpen === true;

  const showAudioCachePanel =
    Boolean(snapshot?.audio_cache) &&
    (activeFilter === "all" ||
      (activeFilter === "attention" &&
        Boolean(snapshot?.audio_cache?.quota_exhausted)) ||
      (activeFilter === "healthy" && !snapshot?.audio_cache?.quota_exhausted));
  const showAudioCacheError =
    Boolean(snapshot?.audio_cache_error) &&
    (activeFilter === "all" || activeFilter === "attention");
  const showVoiceGroup =
    groupedServices.voice.length > 0 ||
    showAudioCachePanel ||
    showAudioCacheError;
  const showOcrGroup =
    Boolean(groupedServices.ocrWorker) ||
    groupedServices.ocrEngines.length > 0 ||
    groupedServices.ocrExtra.length > 0;
  const showWorkersGroup =
    groupedServices.cloudWorkers.length > 0 ||
    groupedServices.localOnlyWorkers.length > 0;

  const toggleKpiFilter = useCallback((bucket: ServiceBucket) => {
    setActiveFilter((prev) => (prev === bucket ? "all" : bucket));
  }, []);

  const errorDiagnosticParts = useMemo(() => {
    if (!fetchError) return [];
    const parts: string[] = [];
    if (fetchError.status !== null) {
      parts.push(
        t(
          "health.errorHttpStatus",
          { status: fetchError.status },
          "Mã HTTP {status}",
        ),
      );
    }
    if (
      fetchError.requestId &&
      (!fetchError.message ||
        !fetchError.message.includes(fetchError.requestId))
    ) {
      parts.push(
        t(
          "health.errorRequestId",
          { requestId: fetchError.requestId },
          "Mã yêu cầu: {requestId}",
        ),
      );
    }
    if (fetchError.message) {
      parts.push(fetchError.message);
    }
    return parts;
  }, [fetchError, t]);

  const filterPills: readonly {
    readonly key: HealthFilterKey;
    readonly label: string;
    readonly count: number;
  }[] = [
    {
      key: "all",
      label: t("health.filters.all", undefined, "Tất cả"),
      count: counts.all,
    },
    {
      key: "attention",
      label: t("health.filters.attention", undefined, "Cần chú ý"),
      count: counts.attention,
    },
    {
      key: "healthy",
      label: t("health.filters.healthy", undefined, "Hoạt động"),
      count: counts.healthy,
    },
    {
      key: "standby",
      label: t("health.filters.standby", undefined, "Chờ kích hoạt"),
      count: counts.standby,
    },
    {
      key: "local_only",
      label: t("health.filters.local_only", undefined, "Chỉ cục bộ"),
      count: counts.local_only,
    },
  ];

  const environmentLabel = (env: DeviceEnvironmentKind): string => {
    switch (env) {
      case "viread_android_webview":
        return t("health.sttEnvWebView");
      case "android_webview":
        return t("health.sttEnvAndroidWebView", undefined, "Android WebView");
      case "ios_webview":
        return t("health.sttEnvIosWebView", undefined, "iOS WebView");
      case "pwa":
        return t("health.sttEnvPwa", undefined, "Ứng dụng PWA");
      default:
        return t("health.sttEnvBrowser");
    }
  };

  const renderOverallAccentClass = (
    status: HealthSnapshotUI["overall_status"],
  ) => {
    if (status === "HEALTHY") return "border-s-emerald-600";
    if (status === "DEGRADED") return "border-s-amber-500";
    return "border-s-danger";
  };

  const wasmModelPercent =
    clientCaps && clientCaps.wasmCache.totalBytes > 0
      ? Math.min(
          100,
          (Math.max(0, clientCaps.wasmCache.cachedBytes) /
            clientCaps.wasmCache.totalBytes) *
            100,
        )
      : null;

  const browserTtsPercent =
    clientCaps &&
    clientCaps.ttsCache.supported &&
    clientCaps.ttsCache.quotaBytes > 0
      ? Math.min(
          100,
          (Math.max(0, clientCaps.ttsCache.usedBytes) /
            clientCaps.ttsCache.quotaBytes) *
            100,
        )
      : null;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div
              aria-label={t("health.autoRefreshLabel", undefined, "Tự làm mới")}
              className="inline-flex items-center rounded-control border border-border bg-white p-0.5 text-xs font-semibold"
              role="group"
            >
              <span className="hidden px-2 text-muted sm:inline">
                {t("health.autoRefreshLabel", undefined, "Tự làm mới")}
              </span>
              {(
                [
                  {
                    value: 0 as const,
                    label: t("health.autoRefreshOff", undefined, "Tắt"),
                  },
                  {
                    value: 30 as const,
                    label: t("health.autoRefresh30s", undefined, "30s"),
                  },
                  {
                    value: 60 as const,
                    label: t("health.autoRefresh60s", undefined, "60s"),
                  },
                ] as const
              ).map((opt) => {
                const selected = autoRefreshSec === opt.value;
                return (
                  <button
                    aria-pressed={selected}
                    className={cn(
                      "min-h-8 rounded-[6px] px-2.5 py-1 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-primary",
                      selected
                        ? "bg-primary text-white"
                        : "text-muted hover:bg-surface-subtle hover:text-ink",
                    )}
                    key={opt.value}
                    onClick={() => setAutoRefreshSec(opt.value)}
                    type="button"
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <Button
              fullWidth={false}
              onClick={handleManualRecheck}
              size="admin"
              variant="secondary"
            >
              <RefreshCw
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0",
                  isRefreshing && "animate-spin",
                )}
              />
              {t("health.recheck")}
            </Button>
          </div>
        }
        description={t("health.description")}
        eyebrow={t("health.eyebrow")}
        title={t("health.title")}
      />

      {isInitialLoading && !snapshot && !fetchError ? (
        <AdminLoading />
      ) : !snapshot && fetchError ? (
        <StatusMessage tone="error">
          <div className="space-y-2">
            <p className="font-semibold">{t("health.loadError")}</p>
            {errorDiagnosticParts.length > 0 ? (
              <p className="text-xs opacity-90 break-words">
                {errorDiagnosticParts.join(" · ")}
              </p>
            ) : null}
            <div>
              <Button
                fullWidth={false}
                onClick={handleManualRecheck}
                size="admin"
                variant="outline"
              >
                {t("common.retry")}
              </Button>
            </div>
          </div>
        </StatusMessage>
      ) : snapshot ? (
        <div className="space-y-6">
          {fetchError && !errorDismissed ? (
            <StatusMessage
              data-testid="health-refresh-warning"
              title={t(
                "health.refreshWarningTitle",
                undefined,
                "Không thể làm mới trạng thái mới nhất",
              )}
              tone="warning"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1 text-xs sm:text-sm">
                  <p>
                    {t(
                      "health.refreshWarningBody",
                      undefined,
                      "Đang giữ dữ liệu kiểm tra gần nhất. Hãy thử kiểm tra lại.",
                    )}
                  </p>
                  {errorDiagnosticParts.length > 0 ? (
                    <p className="font-mono text-xs opacity-90 break-words">
                      {errorDiagnosticParts.join(" · ")}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    fullWidth={false}
                    onClick={handleManualRecheck}
                    size="admin"
                    variant="outline"
                  >
                    {t("common.retry")}
                  </Button>
                  <button
                    aria-label={t(
                      "health.dismissErrorAria",
                      undefined,
                      "Đóng thông báo lỗi",
                    )}
                    className="inline-flex size-9 items-center justify-center rounded-control text-warning transition-colors hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-primary"
                    onClick={() => setErrorDismissed(true)}
                    type="button"
                  >
                    <X aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </div>
            </StatusMessage>
          ) : null}

          <section
            aria-label={t(
              "health.summaryAria",
              undefined,
              "Tổng quan tình trạng hệ thống",
            )}
            className={cn(
              "rounded-xl border border-border border-s-4 bg-white p-4 shadow-2xs sm:p-5",
              renderOverallAccentClass(snapshot.overall_status),
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2 className="text-lg font-extrabold tracking-tight text-ink sm:text-xl">
                    {t("common:brand.name")}
                  </h2>
                  <AdminStatusBadge status={snapshot.overall_status} />
                </div>
                <p className="text-sm font-medium text-ink/90">
                  {summarySentence}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-subtle px-2.5 py-1 font-semibold tabular-nums">
                  <Clock aria-hidden="true" className="size-3.5" />
                  {t("health.checkedAt", {
                    time: formatDateTime(snapshot.checked_at),
                  })}
                </span>
                {isRefreshing ? (
                  <AdminBadge tone="info">
                    {t("health.refreshing", undefined, "Đang cập nhật…")}
                  </AdminBadge>
                ) : null}
                {autoRefreshSec > 0 ? (
                  <AdminBadge tone={isTabHidden ? "neutral" : "info"}>
                    {isTabHidden
                      ? t(
                          "health.autoRefreshPaused",
                          undefined,
                          "Tự làm mới tạm dừng khi ẩn tab",
                        )
                      : t(
                          "health.autoRefreshActive",
                          { seconds: autoRefreshSec },
                          "Tự làm mới mỗi {seconds}s",
                        )}
                  </AdminBadge>
                ) : null}
              </div>
            </div>
          </section>

          <AdminKpiGrid
            ariaLabel={t("health.kpiAria", undefined, "Thống kê nhanh dịch vụ")}
            columns={4}
          >
            <AdminKpiCard
              active={activeFilter === "healthy"}
              detail={t(
                "health.kpiTotalDetail",
                { total: counts.all },
                "/ {total} dịch vụ",
              )}
              icon={<CheckCircle2 className="size-4 text-emerald-600" />}
              label={t("health.filters.healthy", undefined, "Hoạt động")}
              onClick={() => toggleKpiFilter("healthy")}
              testId="health-kpi-healthy"
              tone="success"
              value={formatNumber(counts.healthy)}
            />
            <AdminKpiCard
              active={activeFilter === "attention"}
              detail={t(
                "health.kpiTotalDetail",
                { total: counts.all },
                "/ {total} dịch vụ",
              )}
              icon={
                <AlertTriangle
                  className={cn(
                    "size-4",
                    counts.attention > 0 ? "text-danger" : "text-muted",
                  )}
                />
              }
              label={t("health.filters.attention", undefined, "Cần chú ý")}
              onClick={() => toggleKpiFilter("attention")}
              testId="health-kpi-attention"
              tone={counts.attention > 0 ? "danger" : "neutral"}
              value={formatNumber(counts.attention)}
            />
            <AdminKpiCard
              active={activeFilter === "standby"}
              detail={t(
                "health.kpiTotalDetail",
                { total: counts.all },
                "/ {total} dịch vụ",
              )}
              icon={<Moon className="size-4 text-primary" />}
              label={t("health.filters.standby", undefined, "Chờ kích hoạt")}
              onClick={() => toggleKpiFilter("standby")}
              testId="health-kpi-standby"
              tone={counts.standby > 0 ? "info" : "neutral"}
              value={formatNumber(counts.standby)}
            />
            <AdminKpiCard
              active={activeFilter === "local_only"}
              detail={t(
                "health.kpiTotalDetail",
                { total: counts.all },
                "/ {total} dịch vụ",
              )}
              icon={<Laptop className="size-4 text-muted" />}
              label={t("health.filters.local_only", undefined, "Chỉ cục bộ")}
              onClick={() => toggleKpiFilter("local_only")}
              testId="health-kpi-local-only"
              tone="neutral"
              value={formatNumber(counts.local_only)}
            />
          </AdminKpiGrid>

          <div
            aria-label={t(
              "health.filterAria",
              undefined,
              "Lọc dịch vụ theo trạng thái",
            )}
            className="flex flex-wrap items-center gap-2"
            role="group"
          >
            {filterPills.map((pill) => {
              const active = activeFilter === pill.key;
              return (
                <button
                  aria-pressed={active}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    active
                      ? "border-primary bg-primary text-white"
                      : "border-border bg-white text-ink hover:border-primary/40 hover:bg-surface-subtle",
                  )}
                  data-testid={`health-filter-${pill.key}`}
                  key={pill.key}
                  onClick={() => setActiveFilter(pill.key)}
                  type="button"
                >
                  <span>{pill.label}</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.25 text-[11px] tabular-nums",
                      active
                        ? "bg-white/20 text-white"
                        : "bg-surface-subtle text-muted",
                    )}
                  >
                    {formatNumber(pill.count)}
                  </span>
                </button>
              );
            })}
          </div>

          {groupedServices.totalMatched === 0 &&
          !showAudioCachePanel &&
          !showAudioCacheError ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-white p-5 text-sm text-muted">
              <p>
                {t(
                  "health.filteredEmpty",
                  undefined,
                  "Không có dịch vụ nào thuộc nhóm trạng thái này.",
                )}
              </p>
              <Button
                fullWidth={false}
                onClick={() => setActiveFilter("all")}
                size="admin"
                variant="outline"
              >
                {t("health.resetFilter", undefined, "Xem tất cả dịch vụ")}
              </Button>
            </div>
          ) : null}

          {groupedServices.core.length > 0 ? (
            <section className="space-y-3" data-testid="health-group-core">
              <GroupSectionHeader
                description={t(
                  "health.groups.coreDesc",
                  undefined,
                  "API, cơ sở dữ liệu và lưu trữ đối tượng thiết yếu cho toàn hệ thống.",
                )}
                icon={<Server className="size-4" />}
                title={t("health.groups.core", undefined, "Hạ tầng lõi")}
              />
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {groupedServices.core.map((service) => (
                  <ServiceStatusCard
                    formatDateTime={formatDateTime}
                    key={service.id}
                    service={service}
                    snapshotCheckedAt={snapshot.checked_at}
                    t={t}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {showVoiceGroup ? (
            <section className="space-y-3" data-testid="health-group-voice">
              <GroupSectionHeader
                description={t(
                  "health.groups.voiceDesc",
                  undefined,
                  "Text-to-Speech, Speech-to-Text và kho âm thanh đọc mẫu dựng sẵn.",
                )}
                icon={<Volume2 className="size-4" />}
                title={t(
                  "health.groups.voice",
                  undefined,
                  "Giọng đọc & Bộ nhớ đệm",
                )}
              />
              {groupedServices.voice.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {groupedServices.voice.map((service) => (
                    <ServiceStatusCard
                      formatDateTime={formatDateTime}
                      key={service.id}
                      service={service}
                      snapshotCheckedAt={snapshot.checked_at}
                      t={t}
                    />
                  ))}
                </div>
              ) : null}
              {showAudioCacheError && snapshot.audio_cache_error ? (
                <StatusMessage
                  data-testid="admin-audio-cache-error"
                  title={t(
                    "health.audioCacheErrorTitle",
                    undefined,
                    "Không thể tải thống kê kho âm thanh đọc mẫu",
                  )}
                  tone="warning"
                >
                  <p className="text-xs font-mono">
                    {t(
                      "health.audioCacheErrorDetail",
                      { code: snapshot.audio_cache_error },
                      "Mã chẩn đoán: {code}",
                    )}
                  </p>
                </StatusMessage>
              ) : null}
              {showAudioCachePanel && snapshot.audio_cache ? (
                <AudioCacheSummaryPanel
                  audioCache={snapshot.audio_cache}
                  formatNumber={formatNumber}
                  formatPercent={formatPercent}
                  t={t}
                />
              ) : null}
            </section>
          ) : null}

          {showOcrGroup ? (
            <section className="space-y-3" data-testid="health-group-ocr">
              <GroupSectionHeader
                description={t(
                  "health.groups.ocrDesc",
                  undefined,
                  "OCR worker từ xa, 4 engine nhận diện chữ và AI hậu kiểm chính tả.",
                )}
                icon={<Cpu className="size-4" />}
                title={t(
                  "health.groups.ocr",
                  undefined,
                  "Pipeline OCR & AI Engines",
                )}
              />

              {groupedServices.ocrWorker ? (
                <ServiceStatusCard
                  extraFooter={
                    groupedServices.ocrWorker.can_wake || wakeNotice ? (
                      <div className="space-y-2 pt-1">
                        {groupedServices.ocrWorker.can_wake ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              disabled={isWakingOcr}
                              fullWidth={false}
                              isLoading={isWakingOcr}
                              onClick={() => void handleWakeOcrWorker()}
                              size="admin"
                              variant="primary"
                            >
                              {!isWakingOcr ? (
                                <Zap
                                  aria-hidden="true"
                                  className="size-4 shrink-0"
                                />
                              ) : null}
                              {isWakingOcr
                                ? t(
                                    "health.wakingOcrWorker",
                                    undefined,
                                    "Đang đánh thức…",
                                  )
                                : t(
                                    "health.wakeOcrWorker",
                                    undefined,
                                    "Đánh thức OCR worker",
                                  )}
                            </Button>
                          </div>
                        ) : null}
                        {wakeNotice ? (
                          <StatusMessage
                            className="p-3 text-xs"
                            data-testid="ocr-wakeup-notice"
                            tone={wakeNotice.tone}
                          >
                            {wakeNotice.message}
                          </StatusMessage>
                        ) : null}
                      </div>
                    ) : null
                  }
                  formatDateTime={formatDateTime}
                  service={groupedServices.ocrWorker}
                  snapshotCheckedAt={snapshot.checked_at}
                  t={t}
                />
              ) : null}

              {groupedServices.ocrEngines.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-bold uppercase tracking-wider text-muted">
                    {t(
                      "health.ocrEnginesSubheading",
                      undefined,
                      "Các engine nhận diện OCR",
                    )}
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {groupedServices.ocrEngines.map((service) => (
                      <ServiceStatusCard
                        compact
                        formatDateTime={formatDateTime}
                        key={service.id}
                        service={service}
                        snapshotCheckedAt={snapshot.checked_at}
                        t={t}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {groupedServices.ocrExtra.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {groupedServices.ocrExtra.map((service) => (
                    <ServiceStatusCard
                      formatDateTime={formatDateTime}
                      key={service.id}
                      service={service}
                      snapshotCheckedAt={snapshot.checked_at}
                      t={t}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {showWorkersGroup ? (
            <section className="space-y-3" data-testid="health-group-workers">
              <GroupSectionHeader
                description={t(
                  "health.groups.workersDesc",
                  undefined,
                  "Các tác vụ định kỳ, hàng đợi kiểm duyệt và sự kiện đọc sách.",
                )}
                icon={<Activity className="size-4" />}
                title={t(
                  "health.groups.workers",
                  undefined,
                  "Tiến trình nền & Cron",
                )}
              />

              {groupedServices.cloudWorkers.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {groupedServices.cloudWorkers.map((service) => (
                    <ServiceStatusCard
                      formatDateTime={formatDateTime}
                      key={service.id}
                      service={service}
                      snapshotCheckedAt={snapshot.checked_at}
                      t={t}
                    />
                  ))}
                </div>
              ) : null}

              {groupedServices.localOnlyWorkers.length > 0 ? (
                <div
                  className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs"
                  data-testid="health-group-local-only"
                >
                  <button
                    aria-expanded={isLocalGroupExpanded}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start transition-colors hover:bg-surface-subtle/70 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
                    onClick={() =>
                      setLocalGroupManualOpen((prev) =>
                        prev === null ? !isLocalGroupExpanded : !prev,
                      )
                    }
                    type="button"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Wrench
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted"
                      />
                      <span className="text-sm font-bold text-ink">
                        {t(
                          "health.groups.localOnlyWorkers",
                          undefined,
                          "Chỉ cục bộ / Ủy quyền từ xa / Tắt theo cấu hình",
                        )}
                      </span>
                      <AdminBadge
                        tone={localOnlyHasAttention ? "warning" : "neutral"}
                      >
                        {t(
                          "health.groups.localOnlyWorkersToggleHint",
                          { count: groupedServices.localOnlyWorkers.length },
                          "{count} mục",
                        )}
                      </AdminBadge>
                    </div>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 text-muted transition-transform",
                        isLocalGroupExpanded && "rotate-180",
                      )}
                    />
                  </button>
                  {isLocalGroupExpanded ? (
                    <div className="grid grid-cols-1 gap-3 border-t border-border bg-surface-subtle/35 p-4 md:grid-cols-2 lg:grid-cols-3">
                      {groupedServices.localOnlyWorkers.map((service) => (
                        <ServiceStatusCard
                          compact
                          formatDateTime={formatDateTime}
                          key={service.id}
                          service={service}
                          snapshotCheckedAt={snapshot.checked_at}
                          t={t}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      <section
        className="space-y-3"
        data-testid="admin-client-device-capabilities"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <GroupSectionHeader
            description={t("health.sttSubtitle")}
            icon={<Smartphone className="size-4" />}
            title={t("health.clientDeviceHeading")}
          />
          <Button
            disabled={isProbingClient}
            fullWidth={false}
            onClick={() => void probeClientDevice()}
            size="admin"
            variant="outline"
          >
            <RefreshCw
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                isProbingClient && "animate-spin",
              )}
            />
            {isProbingClient
              ? t("health.probingDevice", undefined, "Đang kiểm tra thiết bị…")
              : t("health.probeDevice", undefined, "Kiểm tra thiết bị")}
          </Button>
        </div>

        {clientActionNotice ? (
          <StatusMessage
            className="p-3 text-xs"
            data-testid="client-cache-notice"
            tone={clientActionNotice.tone}
          >
            {clientActionNotice.message}
          </StatusMessage>
        ) : null}

        {clientProbeError ? (
          <StatusMessage tone="warning">
            {t(
              "health.deviceProbeError",
              undefined,
              "Không thể kiểm tra đầy đủ năng lực thiết bị hiện tại.",
            )}
          </StatusMessage>
        ) : null}

        {clientCaps ? (
          <div className="rounded-xl border border-border bg-white p-4 shadow-2xs">
            {!clientCaps.wasmCaps.isSecureContext ||
            !clientCaps.wasmCaps.indexedDb ? (
              <div className="mb-3 space-y-2">
                {!clientCaps.wasmCaps.isSecureContext ? (
                  <div className="flex items-start gap-2 rounded-control border border-amber-200 bg-warning-surface/70 px-3 py-2 text-xs text-warning">
                    <ShieldAlert
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0"
                    />
                    <span>
                      {t(
                        "health.sttInsecureContextWarning",
                        undefined,
                        "Kết nối chưa phải HTTPS (Secure Context); micro và một số API trình duyệt có thể bị chặn.",
                      )}
                    </span>
                  </div>
                ) : null}
                {!clientCaps.wasmCaps.indexedDb ? (
                  <div className="flex items-start gap-2 rounded-control border border-amber-200 bg-warning-surface/70 px-3 py-2 text-xs text-warning">
                    <AlertTriangle
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0"
                    />
                    <span>
                      {t(
                        "health.sttNoIndexedDbWarning",
                        undefined,
                        "IndexedDB không khả dụng; không thể lưu model STT hoặc cache TTS cục bộ.",
                      )}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}

            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
              <div className="flex min-w-0 flex-col gap-1.5 rounded-control border border-border/70 bg-surface-subtle/40 p-3">
                <dt className="flex items-center gap-1.5 text-xs font-semibold text-muted">
                  <Sparkles aria-hidden="true" className="size-3.5 shrink-0" />
                  <span>{t("health.sttWasmLabel")}</span>
                </dt>
                <dd className="font-bold text-ink">
                  {clientCaps.wasmCaps.supported
                    ? clientCaps.wasmCaps.simd
                      ? t("health.sttReadySimd")
                      : t("health.sttSupportedNoSimd")
                    : t("health.sttUnsupported")}
                </dd>
                {clientCaps.wasmCaps.reason ? (
                  <p className="text-xs text-muted break-words">
                    {clientCaps.wasmCaps.reason}
                  </p>
                ) : null}
              </div>

              <div className="flex min-w-0 flex-col justify-between gap-2 rounded-control border border-border/70 bg-surface-subtle/40 p-3">
                <div className="space-y-1">
                  <dt className="text-xs font-semibold text-muted">
                    {t("health.sttModelCacheLabel")}
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {clientCaps.wasmCache.error
                      ? t(
                          "health.sttModelCacheError",
                          { code: clientCaps.wasmCache.error },
                          "Lỗi đọc IndexedDB ({code})",
                        )
                      : clientCaps.wasmCache.ready
                        ? t("health.sttCachedLoaded", {
                            size: formatByteSize(
                              clientCaps.wasmCache.cachedBytes,
                              formatNumber,
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
                  {clientCaps.wasmCache.totalBytes > 0 ? (
                    <p className="text-xs text-muted tabular-nums">
                      {t(
                        "health.sttModelBytesDetail",
                        {
                          used: formatByteSize(
                            clientCaps.wasmCache.cachedBytes,
                            formatNumber,
                          ),
                          total: formatByteSize(
                            clientCaps.wasmCache.totalBytes,
                            formatNumber,
                          ),
                        },
                        "{used} / {total}",
                      )}
                    </p>
                  ) : null}
                  {wasmModelPercent !== null &&
                  clientCaps.wasmCache.cachedBytes > 0 ? (
                    <UtilizationBar
                      formatPercent={formatPercent}
                      label={t("health.sttModelCacheLabel")}
                      percent={wasmModelPercent}
                      t={t}
                    />
                  ) : null}
                </div>
                <Button
                  className="mt-1 justify-center text-xs"
                  disabled={
                    isClearingWasm || clientCaps.wasmCache.supported === false
                  }
                  fullWidth={false}
                  isLoading={isClearingWasm}
                  onClick={() => void handleClearWasmCache()}
                  size="admin"
                  variant="outline"
                >
                  {!isClearingWasm ? (
                    <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
                  ) : null}
                  {isClearingWasm
                    ? t("health.clearingCache", undefined, "Đang xóa…")
                    : t(
                        "health.clearWasmCache",
                        undefined,
                        "Xóa cache model STT",
                      )}
                </Button>
              </div>

              <div className="flex min-w-0 flex-col justify-between gap-2 rounded-control border border-border/70 bg-surface-subtle/40 p-3">
                <div className="space-y-1">
                  <dt className="text-xs font-semibold text-muted">
                    {t("health.sttBrowserTtsLabel")}
                  </dt>
                  <dd className="font-bold text-ink tabular-nums">
                    {!clientCaps.ttsCache.supported || clientCaps.ttsCache.error
                      ? clientCaps.ttsCache.error
                        ? t(
                            "health.ttsCacheBrowserError",
                            { code: clientCaps.ttsCache.error },
                            "Lỗi bộ nhớ đệm ({code})",
                          )
                        : t("common.notAvailable")
                      : clientCaps.ttsCache.entryCount === 0
                        ? t(
                            "health.ttsCacheBrowserEmpty",
                            undefined,
                            "Trống (0 mục)",
                          )
                        : t("health.sttBrowserTtsValue", {
                            count: formatNumber(clientCaps.ttsCache.entryCount),
                            size: formatByteSize(
                              clientCaps.ttsCache.usedBytes,
                              formatNumber,
                            ),
                          })}
                  </dd>
                  {clientCaps.ttsCache.supported &&
                  !clientCaps.ttsCache.error ? (
                    <>
                      <p className="text-xs text-muted tabular-nums">
                        {formatByteSize(
                          clientCaps.ttsCache.usedBytes,
                          formatNumber,
                        )}{" "}
                        /{" "}
                        {formatByteSize(
                          clientCaps.ttsCache.quotaBytes,
                          formatNumber,
                        )}
                      </p>
                      <p className="text-[11px] text-muted tabular-nums">
                        {t(
                          "health.ttsCacheBrowserHitsMisses",
                          {
                            hits: formatNumber(clientCaps.ttsCache.hits),
                            misses: formatNumber(clientCaps.ttsCache.misses),
                          },
                          "Trúng: {hits} · Trượt: {misses}",
                        )}
                      </p>
                      <UtilizationBar
                        formatPercent={formatPercent}
                        label={t("health.sttBrowserTtsLabel")}
                        percent={browserTtsPercent}
                        t={t}
                      />
                    </>
                  ) : null}
                </div>
                <Button
                  className="mt-1 justify-center text-xs"
                  disabled={isClearingTts || !clientCaps.ttsCache.supported}
                  fullWidth={false}
                  isLoading={isClearingTts}
                  onClick={() => void handleClearTtsCache()}
                  size="admin"
                  variant="outline"
                >
                  {!isClearingTts ? (
                    <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
                  ) : null}
                  {isClearingTts
                    ? t("health.clearingCache", undefined, "Đang xóa…")
                    : t("health.clearTtsCache", undefined, "Xóa cache TTS")}
                </Button>
              </div>

              <div className="flex min-w-0 flex-col gap-1.5 rounded-control border border-border/70 bg-surface-subtle/40 p-3">
                <dt className="flex items-center gap-1.5 text-xs font-semibold text-muted">
                  <Mic aria-hidden="true" className="size-3.5 shrink-0" />
                  <span>{t("health.sttMicLabel")}</span>
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
                {!clientCaps.wasmCaps.isSecureContext ? (
                  <p className="text-xs text-warning">
                    {t(
                      "health.sttMicNeedsHttps",
                      undefined,
                      "Cần HTTPS để ghi âm",
                    )}
                  </p>
                ) : !clientCaps.hasMediaDevices ? (
                  <p className="text-xs text-muted">
                    {t(
                      "health.sttMicNoMediaDevices",
                      undefined,
                      "Không hỗ trợ getUserMedia",
                    )}
                  </p>
                ) : null}
              </div>

              <div className="flex min-w-0 flex-col gap-1.5 rounded-control border border-border/70 bg-surface-subtle/40 p-3">
                <dt className="text-xs font-semibold text-muted">
                  {t("health.sttEnvLabel")}
                </dt>
                <dd className="font-bold text-ink">
                  {environmentLabel(clientCaps.environment)}
                </dd>
                <AdminBadge
                  className="mt-auto"
                  tone={
                    clientCaps.environment === "browser"
                      ? "neutral"
                      : ("info" as AdminBadgeTone)
                  }
                >
                  {clientCaps.wasmCaps.isSecureContext ? "HTTPS" : "HTTP"}
                </AdminBadge>
              </div>
            </dl>
          </div>
        ) : null}
      </section>
    </div>
  );
}
