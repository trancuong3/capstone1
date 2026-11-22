import { requestApi } from "@/lib/api/api-client";
import { z } from "zod";

const driveQuotaSchema = z.object({
  limit_bytes: z.number().nullable(),
  usage_bytes: z.number().nullable(),
  usage_in_drive_bytes: z.number().nullable(),
  usage_in_trash_bytes: z.number().nullable(),
  available_bytes: z.number().nullable(),
  min_free_buffer_bytes: z.number(),
  max_training_budget_bytes: z.number().nullable(),
  warning_level: z.string(),
  can_accept_upload: z.boolean(),
  checked_at: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
});

const driveStatusSchema = z.object({
  provider: z.string(),
  migration_applied: z.boolean(),
  status: z.string(),
  connected: z.boolean(),
  connection_mode: z.string().nullable().optional(),
  oauth_configured: z.boolean(),
  oauth_readiness: z
    .object({
      oauth_configured: z.boolean(),
      client_id_configured: z.boolean(),
      client_secret_configured: z.boolean(),
      redirect_uri_configured: z.boolean(),
      encryption_key_configured: z.boolean(),
      required_scope: z.string(),
      required_account_email: z.string().nullable().optional(),
    })
    .optional(),
  apps_script_readiness: z
    .object({
      bridge_ready: z.boolean(),
      encryption_key_configured: z.boolean(),
      server_secret_configured: z.boolean(),
      web_app_url_configured: z.boolean(),
      required_account_email: z.string().nullable().optional(),
      script_path: z.string().optional(),
    })
    .optional(),
  drive_desktop_readiness: z
    .object({
      desktop_ready: z.boolean(),
      encryption_key_configured: z.boolean(),
      detected_mounts: z
        .array(
          z.object({
            drive_root: z.string(),
            flow2_root: z.string(),
            account_email: z.string().nullable().optional(),
            source: z.string().optional(),
          }),
        )
        .default([]),
      default_mount_path: z.string().nullable().optional(),
      required_account_email: z.string().nullable().optional(),
    })
    .optional(),
  required_account_email: z.string().nullable().optional(),
  account_email: z.string().nullable(),
  account_display_name: z.string().nullable(),
  oauth_scope: z.string().nullable(),
  scope_valid: z.boolean(),
  root_folder_id: z.string().nullable(),
  root_folder_path: z.string(),
  subfolder_ids: z.record(z.string(), z.string()).default({}),
  quota: driveQuotaSchema,
  last_health_check_at: z.string().nullable(),
  last_health_status: z.string().nullable(),
  last_error_code: z.string().nullable(),
  connected_at: z.string().nullable(),
  disconnected_at: z.string().nullable(),
  health_detail: z.string().nullable().optional(),
  google_token_revoked: z.boolean().optional(),
});

const driveConnectStartSchema = z.object({
  authorization_url: z.string().url(),
  scope: z.string(),
  redirect_uri: z.string(),
  expires_in_seconds: z.number().int(),
});

const driveSelfTestSchema = z.object({
  ok: z.boolean(),
  logical_path: z.string(),
  drive_file_id: z.string().nullable(),
  sha256: z.string().nullable(),
  size_bytes: z.number().int(),
  deleted_after_test: z.boolean(),
  is_private: z.boolean(),
  quota: driveQuotaSchema.nullable(),
  detail: z.string(),
});

const runtimeModelSchema = z.object({
  initialized: z.boolean(),
  initialization_status: z.string(),
  initialization_error: z.string().nullable(),
  loaded_profile: z.string().nullable(),
  loaded_checkpoint_sha256: z.string().nullable(),
  loaded_config_sha256: z.string().nullable(),
  verified_runtime_proof: z.boolean(),
  desired_profile: z.string(),
  desired_checkpoint_sha256: z.string(),
  matches_desired: z.boolean(),
  status_label: z.string(),
});

const storageSummarySchema = z.object({
  flow2_write_provider: z.string(),
  flow2_drive_synced_samples: z.number().int(),
  flow2_legacy_samples: z.number().int(),
  flow2_verified_total_samples: z.number().int(),
  flow2_pending_verification_samples: z.number().int().optional(),
  flow2_excluded_samples: z.number().int().optional(),
  flow2_train_samples: z.number().int(),
  flow2_validation_samples: z.number().int(),
  flow2_holdout_samples: z.number().int(),
  flow2_parent_candidates_pending: z.number().int().optional(),
  flow2_parent_candidates_sync_queued: z.number().int().optional(),
  flow2_parent_candidates_synced: z.number().int().optional(),
  flow2_parent_candidates_rejected: z.number().int().optional(),
  flow2_parent_candidates_revoked: z.number().int().optional(),
  dataset_ready_for_training: z.boolean(),
  evaluation_ready_for_model_replacement: z.boolean().optional(),
  outbox_pending: z.number().int(),
  outbox_retry: z.number().int(),
  outbox_dead: z.number().int(),
  outbox_blocked: z.number().int(),
  outbox_skipped: z.number().int(),
  outbox_done: z.number().int(),
});

const overviewSchema = z.object({
  outbox: z.array(z.object({ status: z.string(), count: z.number().int() })),
  samples: z.array(
    z.object({
      source_flow: z.string(),
      split: z.string(),
      count: z.number().int(),
    }),
  ),
  jobs: z
    .array(
      z.object({
        job_id: z.uuid(),
        profile: z.string(),
        target: z.string(),
        status: z.string(),
        dataset_version_id: z.uuid(),
        manifest_sha256: z.string(),
        config_sha256: z.string(),
        parent_checkpoint_sha256: z.string(),
        run_id: z.uuid().nullable(),
        run_status: z.string().nullable().optional(),
        run_config_sha256: z.string().nullable().optional(),
        generation: z.number().int().optional(),
        candidate_has_benchmark: z.boolean().optional(),
        attempts: z.number().int(),
        evaluation_attempts: z.number().int().optional(),
        progress: z.record(z.string(), z.unknown()),
        last_error_code: z.string().nullable(),
        metadata: z.record(z.string(), z.unknown()),
        colab_execution_id: z.string().nullable().optional(),
        colab_execution_resource_name: z.string().nullable().optional(),
        colab_operation_name: z.string().nullable().optional(),
        colab_execution_number: z.number().int().optional(),
        worker_id: z.string().nullable().optional(),
        lease_expires_at: z.iso
          .datetime({ offset: true })
          .nullable()
          .optional(),
        locked_test_version_id: z.uuid().nullable().optional(),
        locked_test_manifest_sha256: z.string().nullable().optional(),
        created_at: z.iso.datetime({ offset: true }),
        updated_at: z.iso.datetime({ offset: true }),
      }),
    )
    .default([]),
  runs: z.array(
    z.object({
      run_id: z.uuid(),
      profile: z.string(),
      status: z.string(),
      parent_checkpoint_sha256: z.string(),
      manifest_sha256: z.string(),
      checkpoint_sha256: z.string().nullable(),
      checkpoint_storage_path: z.string().nullable(),
      step: z.number().int(),
      created_at: z.iso.datetime({ offset: true }),
    }),
  ),
  benchmarks: z.array(
    z.object({
      benchmark_id: z.uuid(),
      run_id: z.uuid(),
      gate_status: z.string(),
      sample_count: z.number().int(),
      group_count: z.number().int(),
      candidate_checkpoint_sha256: z.string(),
      locked_test_manifest_sha256: z.string(),
      created_at: z.iso.datetime({ offset: true }),
      evaluation_type: z.string().optional(),
    }),
  ),
  active_model: z
    .object({
      model_family: z.string(),
      checkpoint_sha256: z.string(),
      storage_path: z.string().nullable(),
      storage_provider: z.string().nullable().optional(),
      drive_file_id: z.string().nullable().optional(),
      profile: z.string(),
      decision_id: z.uuid().nullable(),
      updated_at: z.iso.datetime({ offset: true }),
      version_label: z.string().nullable().optional(),
      weights_filename: z.string().nullable().optional(),
      config_source: z.string().nullable().optional(),
      config_filename: z.string().nullable().optional(),
      source: z.string().nullable().optional(),
      comparison_summary: z
        .record(z.string(), z.unknown())
        .nullable()
        .optional(),
    })
    .nullable(),
  locked_test: z
    .object({
      status: z.string(),
      version_id: z.uuid().nullable(),
      manifest_sha256: z.string().nullable(),
      sample_count: z.number().int(),
      group_count: z.number().int(),
      eligible_sample_count: z.number().int(),
      eligible_group_count: z.number().int(),
      missing_sample_count: z.number().int().optional(),
      missing_group_count: z.number().int().optional(),
      minimum_samples: z.number().int(),
      minimum_groups: z.number().int(),
    })
    .optional(),
  google_drive: driveStatusSchema.nullable().optional(),
  runtime_model: runtimeModelSchema.nullable().optional(),
  storage_summary: storageSummarySchema.nullable().optional(),
});

export type VireadTrainingOverview = z.infer<typeof overviewSchema>;
export type GoogleDriveTrainingStatus = z.infer<typeof driveStatusSchema>;
export type GoogleDriveConnectStartResult = z.infer<
  typeof driveConnectStartSchema
>;
export type GoogleDriveSelfTestResult = z.infer<typeof driveSelfTestSchema>;
export type RuntimeModelStatus = z.infer<typeof runtimeModelSchema>;
export type Flow2StorageSummary = z.infer<typeof storageSummarySchema>;

const flow1ChunkResponseSchema = z.object({
  upload_id: z.string(),
  chunk_index: z.number().int(),
  storage_path: z.string(),
  sha256: z.string(),
  bytes: z.number().int(),
});

const flow1ActivationResponseSchema = z.object({
  decision_id: z.uuid(),
  active_model: z.object({
    checkpoint_sha256: z.string(),
    storage_path: z.string(),
    profile: z.string(),
    version_label: z.string().nullable().optional(),
    updated_at: z.iso.datetime({ offset: true }),
  }),
  cleanup: z.object({
    previous_model_existed: z.boolean(),
    previous_storage_deleted: z.boolean(),
    deleted_object_count: z.number().int(),
    local_cache_deleted: z.boolean(),
    warning: z.string().nullable().optional(),
  }),
});

export type Flow1ChunkUploadResult = z.infer<typeof flow1ChunkResponseSchema>;
export type Flow1ModelActivationResult = z.infer<
  typeof flow1ActivationResponseSchema
>;

export interface VireadTrainingService {
  overview(): Promise<VireadTrainingOverview>;
  driveStatus(): Promise<GoogleDriveTrainingStatus>;
  startDriveConnect(
    redirectUri?: string,
  ): Promise<GoogleDriveConnectStartResult>;
  completeDriveCallback(input: {
    code: string;
    state: string;
  }): Promise<GoogleDriveTrainingStatus>;
  connectDriveAppsScript(input: {
    web_app_url: string;
    bridge_secret?: string;
  }): Promise<GoogleDriveTrainingStatus>;
  connectDriveDesktop(input?: {
    sync_root_path?: string;
    account_email?: string;
  }): Promise<GoogleDriveTrainingStatus>;
  checkDriveHealth(): Promise<GoogleDriveTrainingStatus>;
  runDriveSelfTest(): Promise<GoogleDriveSelfTestResult>;
  disconnectDrive(): Promise<GoogleDriveTrainingStatus>;
  deleteJob(jobId: string): Promise<unknown>;
  requestEvaluation(
    jobId: string,
    evaluationType: "PILOT" | "PRODUCTION",
  ): Promise<{
    job_id: string;
    run_id: string;
    status: string;
    operation: string;
    evaluation_type: string;
    cohort_id: string;
    sample_count: number;
    group_count: number;
    trainer_will_run: boolean;
  }>;
  retry(jobId: string): Promise<{ job_id: string; status: string }>;
  discardMismatchedCandidate(jobId: string): Promise<{
    job_id: string;
    status: string;
    run_id: string;
    checkpoint_retained: boolean;
    candidate_promoted: boolean;
  }>;
  closeUnbenchmarkedCandidate(jobId: string): Promise<{
    job_id: string;
    status: string;
    run_id: string;
    checkpoint_retained: boolean;
    candidate_promoted: boolean;
  }>;
  decide(input: {
    action: "APPROVE" | "ROLLBACK";
    run_id?: string;
    benchmark_id?: string;
    reason: string;
  }): Promise<unknown>;
  uploadFlow1ModelChunk(
    uploadId: string,
    chunkIndex: number,
    chunk: Blob,
  ): Promise<Flow1ChunkUploadResult>;
  activateFlow1Model(input: {
    uploadId: string;
    weightsFilename: string;
    chunks: Array<{
      index: number;
      path: string;
      sha256: string;
      bytes: number;
    }>;
    comparisonFile: File;
    configFile?: File | null;
    modelVersion?: string;
    reason?: string;
  }): Promise<Flow1ModelActivationResult>;
}

export function createVireadTrainingService(): VireadTrainingService {
  return {
    overview: () =>
      requestApi("/books/admin/viread-training/overview", overviewSchema),
    driveStatus: () =>
      requestApi(
        "/books/admin/viread-training/drive/status",
        driveStatusSchema,
      ),
    startDriveConnect: (redirectUri) =>
      requestApi(
        "/books/admin/viread-training/drive/connect/start",
        driveConnectStartSchema,
        undefined,
        {
          method: "POST",
          body: redirectUri ? { redirect_uri: redirectUri } : {},
        },
      ),
    completeDriveCallback: (input) =>
      requestApi(
        "/books/admin/viread-training/drive/connect/callback",
        driveStatusSchema,
        undefined,
        { method: "POST", body: input },
      ),
    connectDriveAppsScript: (input) =>
      requestApi(
        "/books/admin/viread-training/drive/connect/apps-script",
        driveStatusSchema,
        undefined,
        { method: "POST", body: input },
      ),
    connectDriveDesktop: (input) =>
      requestApi(
        "/books/admin/viread-training/drive/connect/desktop",
        driveStatusSchema,
        undefined,
        { method: "POST", body: input ?? {} },
      ),
    checkDriveHealth: () =>
      requestApi(
        "/books/admin/viread-training/drive/health-check",
        driveStatusSchema,
        undefined,
        { method: "POST" },
      ),
    runDriveSelfTest: () =>
      requestApi(
        "/books/admin/viread-training/drive/self-test",
        driveSelfTestSchema,
        undefined,
        { method: "POST" },
      ),
    disconnectDrive: () =>
      requestApi(
        "/books/admin/viread-training/drive/disconnect",
        driveStatusSchema,
        undefined,
        { method: "POST" },
      ),
    deleteJob: (jobId) =>
      requestApi(
        `/books/admin/viread-training/jobs/${encodeURIComponent(jobId)}`,
        z.unknown(),
        undefined,
        { method: "DELETE" },
      ),
    requestEvaluation: (jobId, evaluationType) =>
      requestApi(
        `/books/admin/viread-training/jobs/${jobId}/evaluate`,
        z.object({
          job_id: z.uuid(),
          run_id: z.uuid(),
          status: z.string(),
          operation: z.string(),
          evaluation_type: z.string(),
          cohort_id: z.uuid(),
          sample_count: z.number().int(),
          group_count: z.number().int(),
          trainer_will_run: z.boolean(),
        }),
        undefined,
        { method: "POST", body: { evaluation_type: evaluationType } },
      ),
    retry: (jobId) =>
      requestApi(
        `/books/admin/viread-training/jobs/${jobId}/retry`,
        z.object({ job_id: z.uuid(), status: z.string() }),
        undefined,
        { method: "POST" },
      ),
    discardMismatchedCandidate: (jobId) =>
      requestApi(
        `/books/admin/viread-training/jobs/${jobId}/discard-mismatched-candidate`,
        z.object({
          job_id: z.uuid(),
          status: z.string(),
          run_id: z.uuid(),
          checkpoint_retained: z.boolean(),
          candidate_promoted: z.boolean(),
        }),
        undefined,
        { method: "POST" },
      ),
    closeUnbenchmarkedCandidate: (jobId) =>
      requestApi(
        `/books/admin/viread-training/jobs/${jobId}/close-unbenchmarked-candidate`,
        z.object({
          job_id: z.uuid(),
          status: z.string(),
          run_id: z.uuid(),
          checkpoint_retained: z.boolean(),
          candidate_promoted: z.boolean(),
        }),
        undefined,
        { method: "POST" },
      ),
    decide: (input) =>
      requestApi(
        "/books/admin/viread-training/decisions",
        z.unknown(),
        undefined,
        { method: "POST", body: input },
      ),
    uploadFlow1ModelChunk: (uploadId, chunkIndex, chunk) => {
      const formData = new FormData();
      formData.append("upload_id", uploadId);
      formData.append("chunk_index", String(chunkIndex));
      formData.append("file", chunk, `chunk-${chunkIndex}.part`);
      return requestApi(
        "/books/admin/viread-training/flow1-model/chunks",
        flow1ChunkResponseSchema,
        undefined,
        { method: "POST", body: formData },
      );
    },
    activateFlow1Model: (input) => {
      const formData = new FormData();
      formData.append("upload_id", input.uploadId);
      formData.append("weights_filename", input.weightsFilename);
      formData.append("chunks_json", JSON.stringify(input.chunks));
      formData.append("comparison_file", input.comparisonFile);
      if (input.configFile) {
        formData.append("config_file", input.configFile);
      }
      if (input.modelVersion) {
        formData.append("model_version", input.modelVersion);
      }
      if (input.reason) {
        formData.append("reason", input.reason);
      }
      return requestApi(
        "/books/admin/viread-training/flow1-model/activate",
        flow1ActivationResponseSchema,
        undefined,
        { method: "POST", body: formData },
      );
    },
  };
}
