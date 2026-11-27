import type {
  HealthSnapshotUI,
  OcrWorkerWakeupResponseUI,
} from "@/types/admin";
import { z } from "zod";
import { requestApi } from "@/lib/api/api-client";
import { registerCacheResetListener } from "@/lib/api/read-cache";

export interface HealthGetOptions {
  forceFresh?: boolean;
}

export interface HealthService {
  get(
    signal?: AbortSignal,
    options?: HealthGetOptions,
  ): Promise<HealthSnapshotUI>;
  wakeOcrWorker(signal?: AbortSignal): Promise<OcrWorkerWakeupResponseUI>;
}

const operationalStatusSchema = z.enum(["HEALTHY", "DEGRADED", "UNAVAILABLE"]);

const operationalStateSchema = z.enum([
  "Healthy",
  "Degraded",
  "Offline",
  "Queued",
  "Quota exhausted",
  "Unsupported",
  "Unknown",
  "Standby",
  "Scheduled",
  "Local only",
]);

const runtimeDetailStatusSchema = z.enum([
  "installed",
  "initialized",
  "loaded",
  "healthy",
  "failed",
  "unknown",
  "disabled",
  "standby",
  "cached",
  "client_side",
  "cloud_ready",
  "scheduled",
  "remote_delegated",
  "local_only",
]);

const serviceGroupSchema = z.enum(["core", "voice", "ocr", "workers"]);

const executionModeSchema = z.enum([
  "always_on",
  "in_process",
  "on_demand",
  "cron_scheduled",
  "remote_worker",
  "remote_delegated",
  "precomputed_cache",
  "browser_wasm",
  "cloud_ai",
  "local_only",
  "disabled_opt_in",
]);

const criticalitySchema = z.enum(["core", "important", "optional"]);

const healthSnapshotSchema = z.object({
  overall_status: operationalStatusSchema,
  checked_at: z.iso.datetime({ offset: true }),
  services: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      status: operationalStatusSchema,
      operational_state: operationalStateSchema.nullable().optional(),
      checked_at: z.iso.datetime({ offset: true }),
      safe_message: z.string(),
      detail_status: runtimeDetailStatusSchema.nullable().optional(),
      last_success_at: z.iso.datetime({ offset: true }).nullable().optional(),
      oldest_pending_job_age_seconds: z
        .number()
        .nonnegative()
        .nullable()
        .optional(),
      queue_depth: z.number().int().nonnegative().nullable().optional(),
      last_error: z.string().nullable().optional(),
      service_group: serviceGroupSchema.nullable().optional(),
      execution_mode: executionModeSchema.nullable().optional(),
      criticality: criticalitySchema.nullable().optional(),
      action_hint: z.string().nullable().optional(),
      can_wake: z.boolean().optional(),
    }),
  ),
  audio_cache: z
    .object({
      entry_count: z.number().int().nonnegative(),
      storage_used_bytes: z.number().nonnegative(),
      storage_quota_bytes: z.number().nonnegative(),
      daily_egress_bytes: z.number().nonnegative(),
      daily_egress_limit_bytes: z.number().nonnegative().nullable().optional(),
      cache_hit_ratio: z.number().min(0).max(1).nullable(),
      quota_exhausted: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  audio_cache_error: z.string().nullable().optional(),
});

const ocrWorkerWakeupSchema = z.object({
  status: z.string().min(1),
  woken: z.boolean(),
  detail: z.string(),
});

interface InflightHealthEntry {
  readonly promise: Promise<HealthSnapshotUI>;
  readonly controller: AbortController;
  readonly waiters: Set<AbortController>;
}

let inflightHealthGet: InflightHealthEntry | null = null;
let resetListenerRegistered = false;

function clearInflightHealthGet(abortInflight = false): void {
  const current = inflightHealthGet;
  inflightHealthGet = null;
  if (current && abortInflight) {
    current.controller.abort();
  }
}

function ensureResetListener(): void {
  if (resetListenerRegistered) return;
  resetListenerRegistered = true;
  registerCacheResetListener(() => {
    clearInflightHealthGet(true);
  });
}

function wrapHealthWaiter(
  entry: InflightHealthEntry,
  signal?: AbortSignal,
): Promise<HealthSnapshotUI> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  const waiterToken = new AbortController();
  entry.waiters.add(waiterToken);

  return new Promise<HealthSnapshotUI>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      entry.waiters.delete(waiterToken);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
      // Defer aborting the underlying fetch by one microtask so React StrictMode
      // remounts or concurrent callers subscribing in the same tick can reuse it.
      queueMicrotask(() => {
        if (
          inflightHealthGet === entry &&
          entry.waiters.size === 0 &&
          !entry.controller.signal.aborted
        ) {
          clearInflightHealthGet(true);
        }
      });
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    entry.promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function createHealthService(): HealthService {
  ensureResetListener();
  return {
    get: (signal?: AbortSignal, options?: HealthGetOptions) => {
      if (signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      const forceFresh = Boolean(options?.forceFresh);
      if (forceFresh) {
        clearInflightHealthGet(true);
      } else if (inflightHealthGet) {
        return wrapHealthWaiter(inflightHealthGet, signal);
      }

      const controller = new AbortController();
      const entry: InflightHealthEntry = {
        promise: requestApi(
          "/system/admin/health",
          healthSnapshotSchema,
          controller.signal,
          {
            bypassCache: true,
          },
        ).finally(() => {
          if (inflightHealthGet === entry) {
            inflightHealthGet = null;
          }
        }),
        controller,
        waiters: new Set(),
      };
      inflightHealthGet = entry;
      entry.promise.catch(() => undefined);
      return wrapHealthWaiter(entry, signal);
    },
    wakeOcrWorker: (signal?: AbortSignal) =>
      requestApi(
        "/system/admin/health/ocr-worker/wakeup",
        ocrWorkerWakeupSchema,
        signal,
        { method: "POST" },
      ),
  };
}
