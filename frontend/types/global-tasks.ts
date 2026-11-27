export type GlobalTaskActorRole = "admin" | "parent";

export type GlobalTaskSource =
  | "smart_studio_job"
  | "ocr_inference_job"
  | "admin_ai_workflow"
  | "parent_submission";

export type GlobalTaskStatus =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_FOR_WORKER"
  | "WAITING_FOR_QUOTA"
  | "WAITING_FOR_REVIEW"
  | "RETRY_SCHEDULED"
  | "PARTIAL_SUCCESS"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "STALE";

export type SmartJobType =
  | "OCR_EXTRACT"
  | "COVER_GENERATE"
  | "ILLUSTRATION_EXTRACT"
  | "ILLUSTRATION_GENERATE"
  | "STYLE_BIBLE"
  | "BATCH_BOOK_IMPORT";

export type GlobalTaskProgressMode = "measured" | "staged";

export interface GlobalTaskItem {
  readonly id: string;
  readonly source: GlobalTaskSource;
  readonly job_type: string;
  readonly title_vi: string;
  readonly book_id: string | null;
  readonly book_page_id: string | null;
  readonly book_title: string | null;
  readonly page_number: number | null;
  readonly source_revision_id: string | null;
  readonly actor_id?: string | null;
  readonly actor_role: GlobalTaskActorRole;
  readonly portal?: GlobalTaskActorRole;
  readonly status: GlobalTaskStatus;
  readonly status_label_vi: string;
  readonly stage: string;
  readonly stage_label_vi: string;
  readonly priority: number;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly progress_completed: number | null;
  readonly progress_total: number | null;
  readonly progress_unit: string | null;
  readonly progress_pct: number | null;
  readonly progress_mode?: GlobalTaskProgressMode;
  readonly is_indeterminate: boolean;
  readonly can_retry: boolean;
  readonly can_cancel: boolean;
  readonly result_href: string | null;
  readonly result_ref: Readonly<Record<string, unknown>>;
  readonly checkpoints: Readonly<Record<string, unknown>>;
  readonly error_code: string | null;
  readonly error_message_vi: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

export interface GlobalTaskListResponse {
  readonly actor_id: string;
  readonly actor_role: GlobalTaskActorRole;
  readonly portal?: GlobalTaskActorRole;
  readonly active_count: number;
  readonly waiting_review_count: number;
  readonly failed_count: number;
  readonly completed_count: number;
  readonly worker_online: boolean | null;
  readonly recommended_poll_ms: number | null;
  readonly tasks: readonly GlobalTaskItem[];
}

export interface StudioTasksChangedDetail {
  readonly source?: string;
  readonly actorId?: string | null;
  readonly portal?: GlobalTaskActorRole | null;
}

export interface GlobalTaskActionResponse {
  readonly task: GlobalTaskItem;
  readonly action: string;
  readonly deduplicated: boolean;
  readonly message_vi: string;
}

export interface GlobalTaskCreatePayload {
  readonly job_type: SmartJobType;
  readonly book_id?: string | null;
  readonly book_page_id?: string | null;
  readonly source_revision_id?: string | null;
  readonly input_hash: string;
  readonly idempotency_key: string;
  readonly priority?: number;
  readonly max_attempts?: number;
  readonly progress_completed?: number | null;
  readonly progress_total?: number | null;
  readonly progress_unit?: string | null;
  readonly initial_checkpoints?: Record<string, unknown>;
}

export interface ProviderCapabilitySummary {
  readonly provider_id: string;
  readonly family: string;
  readonly model_id: string;
  readonly quota_group: string | null;
  readonly is_local: boolean;
  readonly enabled: boolean;
  readonly capabilities: readonly string[];
  readonly max_attempt_timeout_seconds: number;
  readonly provider_circuit_state: string;
  readonly quota_group_circuit_state: string;
  readonly available_now: boolean;
  readonly notes: string;
}

export interface CapabilitiesHealthResponse {
  readonly feature_flags: Readonly<Record<string, unknown>>;
  readonly providers: readonly ProviderCapabilitySummary[];
  readonly circuit_breakers: Readonly<Record<string, unknown>>;
  readonly cache_entries: number;
  readonly scheduler: Readonly<Record<string, unknown>>;
}

export const ACTIVE_GLOBAL_TASK_STATUSES: ReadonlySet<GlobalTaskStatus> =
  new Set<GlobalTaskStatus>([
    "QUEUED",
    "RUNNING",
    "WAITING_FOR_WORKER",
    "WAITING_FOR_QUOTA",
    "RETRY_SCHEDULED",
    "CANCEL_REQUESTED",
  ]);
