import type { HealthSnapshotUI } from "@/types/admin";
import { z } from "zod";
import { requestApi } from "@/lib/api/api-client";

export interface HealthService {
  get(): Promise<HealthSnapshotUI>;
}

export function createHealthService(): HealthService {
  const status = z.enum(["HEALTHY", "DEGRADED", "UNAVAILABLE"]);
  const operationalState = z.enum([
    "Healthy",
    "Degraded",
    "Offline",
    "Queued",
    "Quota exhausted",
    "Unsupported",
    "Unknown",
  ]);
  return {
    get: () =>
      requestApi(
        "/system/admin/health",
        z.object({
          overall_status: status,
          checked_at: z.iso.datetime({ offset: true }),
          services: z.array(
            z.object({
              id: z.string(),
              label: z.string(),
              status,
              operational_state: operationalState.nullable().optional(),
              checked_at: z.iso.datetime({ offset: true }),
              safe_message: z.string(),
              detail_status: z
                .enum([
                  "installed",
                  "initialized",
                  "loaded",
                  "healthy",
                  "failed",
                  "unknown",
                  "disabled",
                ])
                .nullable()
                .optional(),
              last_success_at: z.iso
                .datetime({ offset: true })
                .nullable()
                .optional(),
              oldest_pending_job_age_seconds: z
                .number()
                .nonnegative()
                .nullable()
                .optional(),
              queue_depth: z.number().int().nonnegative().nullable().optional(),
              last_error: z.string().nullable().optional(),
            }),
          ),
          audio_cache: z
            .object({
              entry_count: z.number().int().nonnegative(),
              storage_used_bytes: z.number().nonnegative(),
              storage_quota_bytes: z.number().nonnegative(),
              daily_egress_bytes: z.number().nonnegative(),
              daily_egress_limit_bytes: z
                .number()
                .nonnegative()
                .nullable()
                .optional(),
              cache_hit_ratio: z.number().min(0).max(1).nullable(),
              quota_exhausted: z.boolean().optional(),
            })
            .nullable()
            .optional(),
        }),
      ),
  };
}
