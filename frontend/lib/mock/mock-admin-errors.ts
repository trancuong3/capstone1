import { ServiceError } from "@/lib/api/service-error";

export function adminServiceError(
  code: ConstructorParameters<typeof ServiceError>[0]["code"],
  status: number,
  retryable = false,
): ServiceError {
  return new ServiceError({
    code,
    message: "Không thể hoàn tất yêu cầu quản trị.",
    status,
    request_id: `mock-admin-${code.toLowerCase()}`,
    retryable,
  });
}

export function assertAdminScenarioAllowed(scenario: string): void {
  if (scenario === "unauthenticated")
    throw adminServiceError("AUTH_REQUIRED", 401);
  if (scenario === "forbidden") throw adminServiceError("FORBIDDEN", 403);
  if (scenario === "error") throw new Error("Mock admin service unavailable");
}
