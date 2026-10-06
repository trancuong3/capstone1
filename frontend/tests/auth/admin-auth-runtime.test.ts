import { describe, expect, it } from "vitest";

import { resolveAdminAuthRuntime } from "@/lib/utils/admin-scenario";

describe("admin auth runtime selection", () => {
  it("uses Supabase by default", () => {
    expect(resolveAdminAuthRuntime(undefined, "development")).toEqual({
      mode: "supabase",
      scenario: "default",
    });
  });

  it("allows explicit mock states outside production", () => {
    expect(resolveAdminAuthRuntime("invalid-credentials", "test")).toEqual({
      mode: "mock",
      scenario: "invalid-credentials",
    });
  });

  it("ignores query-driven mock auth in production", () => {
    expect(resolveAdminAuthRuntime("forbidden", "production")).toEqual({
      mode: "supabase",
      scenario: "default",
    });
  });
});
