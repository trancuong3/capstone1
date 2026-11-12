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
    decide: (input) =>
      requestApi(
        "/books/admin/viread-training/decisions",
        z.unknown(),
        undefined,
        { method: "POST", body: input },
      ),
  };
}
