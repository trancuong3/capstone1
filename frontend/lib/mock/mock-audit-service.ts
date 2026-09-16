import type { AuditService } from "@/lib/api/audit-service";
import { assertAdminScenarioAllowed } from "@/lib/mock/mock-admin-errors";
import {
  type MockAdminStore,
  waitForAdminMock,
  waitForever,
} from "@/lib/mock/mock-admin-store";
import type { AdminMockScenario } from "@/types/admin";

export function createMockAuditService(
  store: MockAdminStore,
  scenario: AdminMockScenario,
): AuditService {
  return {
    async list(query = {}) {
      if (scenario === "loading") return waitForever();
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      if (scenario === "empty") return { items: [], next_cursor: null };
      const filtered = store.audits.filter(
        (item) =>
          (!query.action || item.action === query.action) &&
          (!query.resource_type || item.resource_type === query.resource_type),
      );
      const start = query.cursor ? Number(query.cursor) : 0;
      const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
      const items = filtered.slice(start, start + limit);
      const next = start + items.length;
      return {
        items,
        next_cursor: next < filtered.length ? String(next) : null,
      };
    },
  };
}
