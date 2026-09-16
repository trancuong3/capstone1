import type { HealthService } from "@/lib/api/health-service";
import { assertAdminScenarioAllowed } from "@/lib/mock/mock-admin-errors";
import { waitForAdminMock, waitForever } from "@/lib/mock/mock-admin-store";
import type {
  AdminMockScenario,
  OperationalHealthStatusUI,
} from "@/types/admin";

export function createMockHealthService(
  scenario: AdminMockScenario,
): HealthService {
  return {
    async get() {
      if (scenario === "loading") return waitForever();
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      const status: OperationalHealthStatusUI =
        scenario === "unavailable"
          ? "UNAVAILABLE"
          : scenario === "degraded"
            ? "DEGRADED"
            : "HEALTHY";
      const checkedAt = new Date().toISOString();
      return {
        overall_status: status,
        checked_at: checkedAt,
        services: [
          {
            id: "web-ui",
            label: "Giao diện quản trị",
            status: "HEALTHY",
            checked_at: checkedAt,
            safe_message: "Sẵn sàng phục vụ.",
          },
          {
            id: "content-api-mock",
            label: "Dịch vụ nội dung (mock)",
            status,
            checked_at: checkedAt,
            safe_message:
              status === "HEALTHY"
                ? "Phản hồi bình thường."
                : "Đang mô phỏng trạng thái vận hành hạn chế.",
          },
        ],
      };
    },
  };
}
