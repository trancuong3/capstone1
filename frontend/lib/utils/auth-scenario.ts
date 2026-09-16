import type { AuthMockScenario } from "@/types/auth";

const scenarios = new Set<AuthMockScenario>([
  "default",
  "loading",
  "email-used",
  "validation-error",
  "invalid-credentials",
  "safe-error",
  "submitted",
  "invalid-token",
  "expired-token",
  "success",
]);

export function parseAuthScenario(
  value: string | string[] | undefined,
): AuthMockScenario {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (candidate && scenarios.has(candidate as AuthMockScenario)) {
    return candidate as AuthMockScenario;
  }

  return "default";
}
