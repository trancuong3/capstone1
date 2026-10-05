import type { ParentRole } from "@/types/profile";
import { createPlaywrightAuthFixtureHeaders } from "@/lib/auth/playwright-auth-fixture";

export function authFixtureHeaders(role: ParentRole) {
  const token = process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN;
  if (!token) {
    throw new Error("Missing Playwright auth fixture token.");
  }

  return createPlaywrightAuthFixtureHeaders(role, token);
}
