import { timingSafeEqual } from "node:crypto";

import type { ParentRole } from "@/types/profile";

export const PLAYWRIGHT_AUTH_TOKEN_HEADER = "x-readalong-playwright-auth-token";
export const PLAYWRIGHT_AUTH_ROLE_HEADER = "x-readalong-playwright-role";

interface HeaderReader {
  get(name: string): string | null;
}

export interface PlaywrightAuthFixtureEnvironment {
  enabled: string | undefined;
  nodeEnvironment: string | undefined;
  token: string | undefined;
}

function tokensMatch(provided: string, expected: string) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export function readPlaywrightAuthFixture(
  headers: HeaderReader,
  environment: PlaywrightAuthFixtureEnvironment = {
    enabled: process.env.PLAYWRIGHT_AUTH_FIXTURES,
    nodeEnvironment: process.env.NODE_ENV,
    token: process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN,
  },
): ParentRole | null {
  if (
    environment.nodeEnvironment === "production" ||
    environment.enabled !== "1" ||
    !environment.token ||
    environment.token.length < 32
  ) {
    return null;
  }

  const providedToken = headers.get(PLAYWRIGHT_AUTH_TOKEN_HEADER);
  if (!providedToken || !tokensMatch(providedToken, environment.token)) {
    return null;
  }

  const role = headers.get(PLAYWRIGHT_AUTH_ROLE_HEADER);
  return role === "parent" || role === "admin" ? role : null;
}

export function createPlaywrightAuthFixtureHeaders(
  role: ParentRole,
  token: string,
) {
  return {
    [PLAYWRIGHT_AUTH_ROLE_HEADER]: role,
    [PLAYWRIGHT_AUTH_TOKEN_HEADER]: token,
  };
}
