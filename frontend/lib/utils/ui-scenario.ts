import type { AppMockScenario } from "@/types/ui-state";

const scenarios = new Set<AppMockScenario>([
  "default",
  "loading",
  "empty",
  "error",
  "not-found",
  "unavailable",
]);

export function parseAppMockScenario(
  value: string | string[] | undefined,
): AppMockScenario {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (candidate && scenarios.has(candidate as AppMockScenario)) {
    return candidate as AppMockScenario;
  }

  return "default";
}
