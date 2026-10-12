import type {
  AdminParentDetailDTO,
  AdminParentDirectoryDTO,
} from "@/types/admin";
import { z } from "zod";
import { apiQuery, requestApi } from "@/lib/api/api-client";

export interface AdminParentListQuery {
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AdminParentCreateInput {
  readonly display_name: string;
  readonly email: string;
  readonly phone?: string;
}

export interface AdminParentUpdateInput {
  readonly display_name?: string;
  readonly email?: string;
  readonly phone?: string;
}

export interface AdminParentService {
  list(query?: AdminParentListQuery): Promise<AdminParentDirectoryDTO>;
  getById(
    parentId: string,
    signal?: AbortSignal,
  ): Promise<AdminParentDetailDTO>;
  create(input: AdminParentCreateInput): Promise<AdminParentDetailDTO>;
  update(parentId: string, input: AdminParentUpdateInput): Promise<AdminParentDetailDTO>;
}

const parentListResponseSchema = z.object({
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

const parentDetailResponseSchema = z.object({
  id: z.guid(),
  display_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  children: z.array(
    z.object({
      id: z.guid(),
      alias: z.string(),
      grade: z.number().int().min(1).max(5),
      created_at: z.iso.datetime({ offset: true }),
    }),
  ),
  contact_info_status: z.enum([
    "available",
    "not_configured",
    "user_not_found",
    "lookup_failed",
  ]),
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
        parentListResponseSchema,
      ),
    getById: (parentId, signal) =>
      requestApi(
        `/profiles/admin/parents/${encodeURIComponent(parentId)}`,
        parentDetailResponseSchema,
        signal,
      ),
    create: (input) =>
      requestApi(
        "/profiles/admin/parents",
        parentDetailResponseSchema,
        undefined,
        { method: "POST", body: input },
      ),
    update: (parentId, input) =>
      requestApi(
        `/profiles/admin/parents/${encodeURIComponent(parentId)}`,
        parentDetailResponseSchema,
        undefined,
        { method: "PATCH", body: input },
      ),

  };
}
