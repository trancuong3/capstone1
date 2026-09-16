import type { HealthSnapshotUI } from "@/types/admin";

export interface HealthService {
  get(): Promise<HealthSnapshotUI>;
}
