// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  createPlaywrightAuthFixtureHeaders,
  readPlaywrightAuthFixture,
} from "@/lib/auth/playwright-auth-fixture";

const token = "a".repeat(64);

function headerReader(values: Record<string, string>) {
  const headers = new Headers(values);
  return { get: (name: string) => headers.get(name) };
}

describe("Playwright auth fixture gate", () => {
  it("accepts a valid role only in an explicitly enabled non-production run", () => {
    expect(
      readPlaywrightAuthFixture(
        headerReader(createPlaywrightAuthFixtureHeaders("parent", token)),
        { enabled: "1", nodeEnvironment: "test", token },
      ),
    ).toBe("parent");
  });

  it("is always disabled in production", () => {
    expect(
      readPlaywrightAuthFixture(
        headerReader(createPlaywrightAuthFixtureHeaders("admin", token)),
        { enabled: "1", nodeEnvironment: "production", token },
      ),
    ).toBeNull();
  });

  it("rejects a wrong token, invalid role, disabled flag, and short secret", () => {
    const validHeaders = createPlaywrightAuthFixtureHeaders("parent", token);

    expect(
      readPlaywrightAuthFixture(headerReader(validHeaders), {
        enabled: "1",
        nodeEnvironment: "test",
        token: "b".repeat(64),
      }),
    ).toBeNull();
    expect(
      readPlaywrightAuthFixture(
        headerReader({
          ...validHeaders,
          "x-readalong-playwright-role": "owner",
        }),
        { enabled: "1", nodeEnvironment: "test", token },
      ),
    ).toBeNull();
    expect(
      readPlaywrightAuthFixture(headerReader(validHeaders), {
        enabled: "0",
        nodeEnvironment: "test",
        token,
      }),
    ).toBeNull();
    expect(
      readPlaywrightAuthFixture(headerReader(validHeaders), {
        enabled: "1",
        nodeEnvironment: "test",
        token: "short",
      }),
    ).toBeNull();
  });
});
