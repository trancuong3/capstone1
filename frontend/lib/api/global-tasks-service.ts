import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import { registerCacheResetListener } from "@/lib/api/read-cache";
import type {
  CapabilitiesHealthResponse,
  GlobalTaskActionResponse,
  GlobalTaskActorRole,
  GlobalTaskCreatePayload,
  GlobalTaskListResponse,
} from "@/types/global-tasks";

const actorRoleSchema = z.enum(["admin", "parent"]);

const taskSourceSchema = z.enum([
  "smart_studio_job",
  "ocr_inference_job",
  "admin_ai_workflow",
  "parent_submission",
]);

const taskStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_WORKER",
  "WAITING_FOR_QUOTA",
  "WAITING_FOR_REVIEW",
  "RETRY_SCHEDULED",
  "PARTIAL_SUCCESS",
  "SUCCEEDED",
  "FAILED",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "STALE",
]);

const globalTaskItemSchema = z.object({
  id: z.string(),
  source: taskSourceSchema,
  job_type: z.string(),
  title_vi: z.string(),
  book_id: z.string().nullable().default(null),
  book_page_id: z.string().nullable().default(null),
  book_title: z.string().nullable().default(null),
  page_number: z.number().int().nullable().default(null),
  source_revision_id: z.string().nullable().default(null),
  actor_role: actorRoleSchema,
  status: taskStatusSchema,
  status_label_vi: z.string(),
  stage: z.string(),
  stage_label_vi: z.string(),
  priority: z.number().int(),
  attempt_count: z.number().int().default(0),
  max_attempts: z.number().int().default(3),
  progress_completed: z.number().int().nullable().default(null),
  progress_total: z.number().int().nullable().default(null),
  progress_unit: z.string().nullable().default(null),
  progress_pct: z.number().nullable().default(null),
  is_indeterminate: z.boolean().default(true),
  can_retry: z.boolean().default(false),
  can_cancel: z.boolean().default(false),
  result_href: z.string().nullable().default(null),
  result_ref: z.record(z.string(), z.unknown()).default({}),
  checkpoints: z.record(z.string(), z.unknown()).default({}),
  error_code: z.string().nullable().default(null),
  error_message_vi: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),
});

const globalTaskListSchema = z.object({
  actor_id: z.string(),
  actor_role: actorRoleSchema,
  active_count: z.number().int().default(0),
  waiting_review_count: z.number().int().default(0),
  failed_count: z.number().int().default(0),
  completed_count: z.number().int().default(0),
  worker_online: z.boolean().nullable().default(null),
  recommended_poll_ms: z.number().int().nullable().default(null),
  tasks: z.array(globalTaskItemSchema).default([]),
});

const globalTaskActionSchema = z.object({
  task: globalTaskItemSchema,
  action: z.string(),
  deduplicated: z.boolean().default(false),
  message_vi: z.string(),
});

const capabilitiesHealthSchema = z.object({
  feature_flags: z.record(z.string(), z.unknown()).default({}),
  providers: z
    .array(
      z.object({
        provider_id: z.string(),
        family: z.string(),
        model_id: z.string(),
        quota_group: z.string().nullable().default(null),
        is_local: z.boolean().default(false),
        enabled: z.boolean().default(false),
        capabilities: z.array(z.string()).default([]),
        max_attempt_timeout_seconds: z.number(),
        provider_circuit_state: z.string(),
        quota_group_circuit_state: z.string(),
        available_now: z.boolean().default(false),
        notes: z.string().default(""),
      }),
    )
    .default([]),
  circuit_breakers: z.record(z.string(), z.unknown()).default({}),
  cache_entries: z.number().int().default(0),
  scheduler: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Memory-only task feed cache strictly keyed by `(actorId, actorRole)`.
 * Never persists book text or task snapshots to `localStorage` / `sessionStorage`.
 */
const actorTaskMemoryCache = new Map<string, GlobalTaskListResponse>();

export function buildTaskActorCacheKey(
  actorId: string | null | undefined,
  actorRole: GlobalTaskActorRole | null | undefined,
): string | null {
  const trimmedId = actorId?.trim();
  if (!trimmedId || !actorRole) return null;
  return `${trimmedId}:${actorRole}`;
}

export function getCachedGlobalTasksSnapshot(
  actorId: string | null | undefined,
  actorRole: GlobalTaskActorRole | null | undefined,
): GlobalTaskListResponse | null {
  const key = buildTaskActorCacheKey(actorId, actorRole);
  if (!key) return null;
  return actorTaskMemoryCache.get(key) ?? null;
}

export function setCachedGlobalTasksSnapshot(
  actorId: string | null | undefined,
  actorRole: GlobalTaskActorRole | null | undefined,
  snapshot: GlobalTaskListResponse,
): void {
  const key = buildTaskActorCacheKey(actorId, actorRole);
  if (!key) return;
  if (
    snapshot.actor_id !== actorId?.trim() ||
    snapshot.actor_role !== actorRole
  ) {
    return;
  }
  actorTaskMemoryCache.set(key, snapshot);
}

export function clearGlobalTasksMemoryCache(): void {
  actorTaskMemoryCache.clear();
}

registerCacheResetListener(clearGlobalTasksMemoryCache);

export interface GlobalTasksService {
  listTasks(options?: {
    readonly activeOnly?: boolean;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<GlobalTaskListResponse>;
  createTask(
    payload: GlobalTaskCreatePayload,
  ): Promise<GlobalTaskActionResponse>;
  retryTask(jobId: string): Promise<GlobalTaskActionResponse>;
  cancelTask(jobId: string): Promise<GlobalTaskActionResponse>;
  getCapabilities(signal?: AbortSignal): Promise<CapabilitiesHealthResponse>;
}

export function createGlobalTasksService(): GlobalTasksService {
  return {
    async listTasks(options = {}): Promise<GlobalTaskListResponse> {
      const query = apiQuery({
        limit: options.limit ?? 40,
        active_only: options.activeOnly ? "true" : undefined,
      });
      return await requestApi(
        `/studio/tasks${query}`,
        globalTaskListSchema,
        options.signal,
        {
          method: "GET",
          bypassCache: true,
        },
      );
    },

    async createTask(
      payload: GlobalTaskCreatePayload,
    ): Promise<GlobalTaskActionResponse> {
      return await requestApi(
        "/studio/tasks",
        globalTaskActionSchema,
        undefined,
        {
          method: "POST",
          body: payload,
        },
      );
    },

    async retryTask(jobId: string): Promise<GlobalTaskActionResponse> {
      return await requestApi(
        `/studio/tasks/${encodeURIComponent(jobId)}/retry`,
        globalTaskActionSchema,
        undefined,
        {
          method: "POST",
        },
      );
    },

    async cancelTask(jobId: string): Promise<GlobalTaskActionResponse> {
      return await requestApi(
        `/studio/tasks/${encodeURIComponent(jobId)}/cancel`,
        globalTaskActionSchema,
        undefined,
        {
          method: "POST",
        },
      );
    },

    async getCapabilities(
      signal?: AbortSignal,
    ): Promise<CapabilitiesHealthResponse> {
      return await requestApi(
        "/studio/capabilities",
        capabilitiesHealthSchema,
        signal,
        {
          method: "GET",
          bypassCache: true,
        },
      );
    },
  };
}
