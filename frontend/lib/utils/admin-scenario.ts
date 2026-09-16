import type { AdminMockScenario } from "@/types/admin";

const scenarios = new Set<AdminMockScenario>([
  "default",
  "loading",
  "empty",
  "error",
  "no-result",
  "invalid-credentials",
  "unauthenticated",
  "forbidden",
  "invalid-upload",
  "upload-failure",
  "invalid-lifecycle",
  "ocr-reprocess-invalid-state",
  "degraded",
  "unavailable",
]);

export function firstAdminQueryValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseAdminScenario(
  value: string | string[] | undefined,
): AdminMockScenario {
  const candidate = firstAdminQueryValue(value);
  return candidate && scenarios.has(candidate as AdminMockScenario)
    ? (candidate as AdminMockScenario)
    : "default";
}
