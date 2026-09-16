import {
  AdminAuthError,
  type AdminAuthService,
} from "@/lib/api/admin-auth-service";
import { waitForAdminMock, waitForever } from "@/lib/mock/mock-admin-store";
import type { AdminMockScenario } from "@/types/admin";

export function createMockAdminAuthService(
  scenario: AdminMockScenario,
): AdminAuthService {
  return {
    async signIn(request) {
      if (scenario === "loading") return waitForever();
      await waitForAdminMock();
      if (scenario === "invalid-credentials") {
        throw new AdminAuthError("invalid-credentials");
      }
      if (scenario === "forbidden") throw new AdminAuthError("forbidden");
      if (scenario === "error") throw new AdminAuthError("safe-error");
      if (!request.email.trim() || !request.password) {
        throw new AdminAuthError("invalid-credentials");
      }
      return {
        actor_id: "88000000-0000-4000-8000-000000000001",
        role: "admin",
        display_name: "Quản trị viên ReadAlong",
      };
    },
    async signOut() {
      await waitForAdminMock(100);
    },
  };
}
