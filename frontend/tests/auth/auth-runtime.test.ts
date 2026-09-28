import { describe, expect, it } from "vitest";

import { resolveAuthRuntime } from "@/lib/utils/auth-scenario";

describe("auth runtime selection", () => {
  it("uses Supabase when no mock state was requested", () => {
    expect(resolveAuthRuntime(undefined, "development")).toEqual({
      mode: "supabase",
      scenario: "default",
    });
  });

  it("uses an explicit mock state only when mock states are enabled", () => {
    expect(resolveAuthRuntime("loading", "development")).toEqual({
      mode: "mock",
      scenario: "loading",
    });
  });

  it("ignores query-driven mock states when they are disabled", () => {
    expect(resolveAuthRuntime("safe-error", "production")).toEqual({
      mode: "supabase",
      scenario: "default",
    });
  });

  it("normalizes an unknown enabled mock state", () => {
    expect(resolveAuthRuntime("unknown-state", "test")).toEqual({
      mode: "mock",
      scenario: "default",
    });
  });
});
