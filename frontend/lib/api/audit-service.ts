import type { AuditLogPageDTO, AuditLogQueryUI } from "@/types/admin";
import { z } from "zod";
import { apiQuery, requestApi } from "@/lib/api/api-client";

export interface AuditService {
  list(query?: AuditLogQueryUI): Promise<AuditLogPageDTO>;
}

export function createAuditService(): AuditService {
  return {
    list: (query) =>
      requestApi(
        `/system/admin/audit-logs${apiQuery({ action: query?.action, resource_type: query?.resource_type, cursor: query?.cursor, limit: query?.limit })}`,
        z.object({
          items: z.array(
            z.object({
              // Match PostgreSQL UUIDs without imposing RFC version/variant bits.
              id: z.guid(),
              actor_id: z.guid().nullable(),
              action: z.string(),
              resource_type: z.string(),
              resource_id: z.guid().nullable(),
              request_id: z.string().nullable(),
              created_at: z.iso.datetime({ offset: true }),
              metadata: z.record(z.string(), z.unknown()),
            }),
          ),
          next_cursor: z.string().nullable(),
        }),
      ),
  };
}
