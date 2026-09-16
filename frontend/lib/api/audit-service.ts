import type { AuditLogPageDTO, AuditLogQueryUI } from "@/types/admin";

export interface AuditService {
  list(query?: AuditLogQueryUI): Promise<AuditLogPageDTO>;
}
