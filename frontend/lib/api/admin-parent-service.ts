import type { AdminParentDirectoryDTO } from "@/types/admin";
import { z } from "zod";
import { apiQuery, requestApi } from "@/lib/api/api-client";

export interface AdminParentListQuery {
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AdminParentService {
  list(query?: AdminParentListQuery): Promise<AdminParentDirectoryDTO>;
}

const responseSchema = z.object({
  items: z.array(
    z.object({
      id: z.guid(),
      display_name: z.string().nullable(),
      created_at: z.iso.datetime({ offset: true }),
      children_count: z.number().int().nonnegative(),
    }),
  ),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().nonnegative(),
});

export function createAdminParentService(): AdminParentService {
  return {
    list: (query) =>
      requestApi(
        `/profiles/admin/parents${apiQuery({
          search: query?.search?.trim() || undefined,
          limit: query?.limit ?? 10,
          offset: query?.offset ?? 0,
        })}`,
        responseSchema,
      ),
  };
}
