import { requestApi } from "@/lib/api/api-client";
import { z } from "zod";

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
        attempts: z.number().int(),
        progress: z.record(z.string(), z.unknown()),
        last_error_code: z.string().nullable(),
        metadata: z.record(z.string(), z.unknown()),
        colab_execution_id: z.string().nullable().optional(),
        colab_execution_resource_name: z.string().nullable().optional(),
        colab_operation_name: z.string().nullable().optional(),
        colab_execution_number: z.number().int().optional(),
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
    }),
  ),
  active_model: z
    .object({
      model_family: z.string(),
      checkpoint_sha256: z.string(),
      storage_path: z.string().nullable(),
      profile: z.string(),
      decision_id: z.uuid().nullable(),
      updated_at: z.iso.datetime({ offset: true }),
    })
    .nullable(),
});

export type VireadTrainingOverview = z.infer<typeof overviewSchema>;

export interface VireadTrainingService {
  overview(): Promise<VireadTrainingOverview>;
  retry(jobId: string): Promise<{ job_id: string; status: string }>;
  discardMismatchedCandidate(jobId: string): Promise<{
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
}

export function createVireadTrainingService(): VireadTrainingService {
  return {
    overview: () =>
      requestApi("/books/admin/viread-training/overview", overviewSchema),
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
    decide: (input) =>
      requestApi(
        "/books/admin/viread-training/decisions",
        z.unknown(),
        undefined,
        { method: "POST", body: input },
      ),
  };
}
