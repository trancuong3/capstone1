import { request } from "@playwright/test";

import { createPlaywrightAuthFixtureHeaders } from "@/lib/auth/playwright-auth-fixture";
import type { ParentRole } from "@/types/profile";

import {
  startApiContractServer,
  type ApiContractServerHandle,
} from "./api-contract-server";
import { OPAQUE_CRON_SECRET } from "./test-data";

async function warmRouteGroup(
  baseURL: string,
  routes: readonly string[],
  headers?: Readonly<Record<string, string>>,
): Promise<void> {
  const apiContext = await request.newContext({
    baseURL,
    ...(headers ? { extraHTTPHeaders: headers } : {}),
  });
  try {
    for (const route of routes) {
      const response = await apiContext.get(route, {
        timeout: 120_000,
        maxRedirects: 0,
      });
      if (response.status() >= 400) {
        throw new Error(
          `Opaque-box route warmup failed for ${route}: HTTP ${response.status()}`,
        );
      }
    }
  } finally {
    await apiContext.dispose();
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const port = process.env.PLAYWRIGHT_OPAQUE_PORT?.trim() || "3299";
  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL?.trim() || `http://127.0.0.1:${port}`;
  const liveApiUrl = process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim() || "";
  const apiPort = Number(process.env.VIREAD_OPAQUE_API_PORT?.trim() || "18180");
  const cronSecret = process.env.CRON_SECRET?.trim() || OPAQUE_CRON_SECRET;
  const authToken = process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN?.trim() || "";

  let contractServer: ApiContractServerHandle | null = null;

  try {
    if (liveApiUrl) {
      const probeUrl = `${liveApiUrl.replace(/\/+$/, "")}/health`;
      const probeRes = await fetch(probeUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (probeRes.status >= 500) {
        throw new Error(
          `Live API probe failed at ${probeUrl}: HTTP ${probeRes.status}`,
        );
      }
    } else {
      contractServer = await startApiContractServer({
        host: "127.0.0.1",
        port: apiPort,
        cronSecret,
      });
    }

    await warmRouteGroup(baseURL, ["/login"]);

    if (authToken.length >= 32) {
      const roleHeaders = (role: ParentRole) =>
        createPlaywrightAuthFixtureHeaders(role, authToken);
      await warmRouteGroup(baseURL, ["/dashboard"], roleHeaders("parent"));
      await warmRouteGroup(
        baseURL,
        ["/admin/books", "/admin/health"],
        roleHeaders("admin"),
      );
    }
  } catch (error) {
    if (contractServer) {
      await contractServer.close();
    }
    throw error;
  }

  return async () => {
    if (contractServer) {
      await contractServer.close();
    }
  };
}
