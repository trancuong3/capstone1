import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import {
  OPAQUE_ADMIN_ID,
  OPAQUE_BOOK_ID,
  OPAQUE_CHILD_ID,
  OPAQUE_CRON_SECRET,
  OPAQUE_PARENT_ID,
  OPAQUE_SESSION_ID,
  makeAdminCatalogItem,
  makeAdminHealthSnapshot,
  makeAssistantChatReply,
  makeAssistantContext,
  makeAssistantStatus,
  makeCatalogBook,
  makeCatalogPagePreview,
  makeChildProfile,
  makeCronDispatchResponse,
  makeDashboardSummary,
  makeGlobalTaskList,
  makeHealthPayload,
  makeParentProfile,
  makeReadingHistoryList,
  makeReadingSessionDetail,
} from "./test-data";

export interface ContractRecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly bodyText: string;
  readonly ts: number;
}

export interface ContractFaultConfig {
  readonly method?: string;
  readonly path: string;
  readonly status: number;
  readonly remaining?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

interface MutableFaultEntry {
  method: string | null;
  path: string;
  status: number;
  remaining: number;
  body: unknown;
  headers: Readonly<Record<string, string>>;
}

export interface ContractRouteResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface ContractRouteRequest {
  readonly method: string;
  readonly path: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly bodyText: string;
  readonly jsonBody: unknown;
}

export type ContractRouteHandler = (
  request: ContractRouteRequest,
) =>
  | Promise<ContractRouteResponse | null | undefined>
  | ContractRouteResponse
  | null
  | undefined;

export interface StartApiContractServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly cronSecret?: string;
}

export interface ApiContractServerHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
  reset(): void;
  getRecordedRequests(): readonly ContractRecordedRequest[];
  getCronAttempts(): number;
  armFault(fault: ContractFaultConfig): void;
  setRouteHandler(key: string, handler: ContractRouteHandler): void;
  clearRouteHandlers(): void;
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Expose-Headers":
    "X-Request-ID,X-ViRead-Version,X-TTS-Cache,Retry-After",
};

const VALID_CRON_SCOPES = new Set([
  "all",
  "reminders",
  "presence",
  "engagement",
]);

function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(payload);
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function startApiContractServer(
  options: StartApiContractServerOptions = {},
): Promise<ApiContractServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 18180;
  const cronSecret = options.cronSecret ?? OPAQUE_CRON_SECRET;

  const recordedRequests: ContractRecordedRequest[] = [];
  const armedFaults: MutableFaultEntry[] = [];
  const routeHandlers = new Map<string, ContractRouteHandler>();
  let cronAttempts = 0;
  let closed = false;

  const reset = (): void => {
    recordedRequests.length = 0;
    armedFaults.length = 0;
    routeHandlers.clear();
    cronAttempts = 0;
  };

  const armFault = (fault: ContractFaultConfig): void => {
    const remaining =
      typeof fault.remaining === "number" && fault.remaining > 0
        ? Math.floor(fault.remaining)
        : 1;
    armedFaults.push({
      method: fault.method ? fault.method.toUpperCase() : null,
      path: fault.path,
      status: fault.status,
      remaining,
      body: fault.body ?? { detail: `ARMED_CONTRACT_FAULT_${fault.status}` },
      headers: fault.headers ?? {},
    });
  };

  const consumeFault = (
    method: string,
    pathname: string,
  ): MutableFaultEntry | null => {
    for (let i = 0; i < armedFaults.length; i += 1) {
      const candidate = armedFaults[i];
      if (!candidate || candidate.remaining <= 0) continue;
      if (candidate.method && candidate.method !== method) continue;
      if (candidate.path !== pathname) continue;
      candidate.remaining -= 1;
      if (candidate.remaining <= 0) {
        armedFaults.splice(i, 1);
      }
      return candidate;
    }
    return null;
  };

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const requestUrl = new URL(
      req.url ?? "/",
      `http://${host}:${requestedPort}`,
    );
    const pathname = requestUrl.pathname;
    const bodyText = await readBodyText(req);
    const jsonBody = tryParseJson(bodyText);

    if (pathname.startsWith("/__contract/")) {
      if (method === "POST" && pathname === "/__contract/reset") {
        reset();
        writeJson(res, 200, { ok: true });
        return;
      }
      if (method === "GET" && pathname === "/__contract/stats") {
        writeJson(res, 200, {
          requestCount: recordedRequests.length,
          requests: [...recordedRequests],
          cronAttempts,
        });
        return;
      }
      if (method === "POST" && pathname === "/__contract/fault") {
        const parsed =
          jsonBody && typeof jsonBody === "object"
            ? (jsonBody as Record<string, unknown>)
            : null;
        const faultPath = typeof parsed?.path === "string" ? parsed.path : "";
        const faultStatus =
          typeof parsed?.status === "number" ? parsed.status : 0;
        if (!faultPath || !Number.isInteger(faultStatus) || faultStatus < 400) {
          writeJson(res, 400, { detail: "INVALID_CONTRACT_FAULT_SPEC" });
          return;
        }
        const remaining =
          typeof parsed?.remaining === "number" && parsed.remaining > 0
            ? Math.floor(parsed.remaining)
            : 1;
        const faultMethod =
          typeof parsed?.method === "string" && parsed.method.trim()
            ? parsed.method.trim().toUpperCase()
            : undefined;
        const faultHeaders =
          parsed?.headers && typeof parsed.headers === "object"
            ? Object.fromEntries(
                Object.entries(parsed.headers as Record<string, unknown>).map(
                  ([k, v]) => [k, String(v)],
                ),
              )
            : undefined;
        armFault({
          method: faultMethod,
          path: faultPath,
          status: faultStatus,
          remaining,
          body: parsed?.body,
          headers: faultHeaders,
        });
        writeJson(res, 200, {
          ok: true,
          armed: {
            method: faultMethod ?? null,
            path: faultPath,
            status: faultStatus,
            remaining,
          },
        });
        return;
      }
      writeJson(res, 404, {
        detail: "CONTRACT_CONTROL_ROUTE_NOT_FOUND",
        path: pathname,
      });
      return;
    }

    recordedRequests.push({
      method,
      path: pathname,
      query: requestUrl.search,
      headers: req.headers,
      bodyText,
      ts: Date.now(),
    });

    if (
      pathname === "/parent-notifications/cron/dispatch" &&
      method === "POST"
    ) {
      cronAttempts += 1;
    }

    const armedFault = consumeFault(method, pathname);
    if (armedFault) {
      writeJson(res, armedFault.status, armedFault.body, armedFault.headers);
      return;
    }

    const customHandler =
      routeHandlers.get(`${method} ${pathname}`) ?? routeHandlers.get(pathname);
    if (customHandler) {
      const handled = await customHandler({
        method,
        path: pathname,
        url: requestUrl,
        headers: req.headers,
        bodyText,
        jsonBody,
      });
      if (handled) {
        writeJson(res, handled.status ?? 200, handled.body, handled.headers);
        return;
      }
    }

    if (method === "GET" && pathname === "/health") {
      writeJson(res, 200, makeHealthPayload());
      return;
    }

    if (method === "GET" && pathname === "/profiles/me") {
      writeJson(res, 200, makeParentProfile());
      return;
    }

    if (method === "GET" && pathname === "/profiles/children") {
      writeJson(res, 200, [makeChildProfile()]);
      return;
    }

    if (method === "GET" && pathname.startsWith("/profiles/children/")) {
      const childId = decodeSegment(
        pathname.slice("/profiles/children/".length),
      );
      if (childId && !childId.includes("/")) {
        writeJson(res, 200, makeChildProfile({ id: childId }));
        return;
      }
    }

    if (method === "GET" && pathname === "/profiles/dashboard-summary") {
      writeJson(res, 200, makeDashboardSummary());
      return;
    }

    if (
      method === "GET" &&
      (pathname === "/books/catalog" || pathname === "/books/")
    ) {
      writeJson(res, 200, [makeCatalogBook()]);
      return;
    }

    if (
      method === "GET" &&
      pathname.startsWith("/books/catalog/") &&
      pathname.endsWith("/preview")
    ) {
      writeJson(res, 200, [makeCatalogPagePreview()]);
      return;
    }

    if (method === "GET" && pathname.startsWith("/books/catalog/")) {
      const bookId = decodeSegment(pathname.slice("/books/catalog/".length));
      if (bookId && !bookId.includes("/")) {
        writeJson(res, 200, makeCatalogBook({ id: bookId }));
        return;
      }
    }

    if (method === "GET" && pathname === "/books/admin/catalog") {
      writeJson(res, 200, [makeAdminCatalogItem()]);
      return;
    }

    if (method === "GET" && pathname.startsWith("/books/admin/catalog/")) {
      const bookId = decodeSegment(
        pathname.slice("/books/admin/catalog/".length),
      );
      if (bookId && !bookId.includes("/")) {
        const item = makeAdminCatalogItem();
        writeJson(res, 200, {
          ...item.book,
          id: bookId,
          next_page_number: 6,
        });
        return;
      }
    }

    if (method === "GET" && pathname === "/system/admin/health") {
      writeJson(res, 200, makeAdminHealthSnapshot());
      return;
    }

    if (
      method === "POST" &&
      pathname === "/system/admin/health/ocr-worker/wakeup"
    ) {
      writeJson(res, 200, {
        status: "woken",
        woken: true,
        detail: "OCR worker wake signal dispatched.",
      });
      return;
    }

    if (method === "GET" && pathname === "/studio/tasks") {
      const actorRole =
        requestUrl.searchParams.get("actor_role") === "admin"
          ? "admin"
          : "parent";
      writeJson(
        res,
        200,
        makeGlobalTaskList({
          actor_id: actorRole === "admin" ? OPAQUE_ADMIN_ID : OPAQUE_PARENT_ID,
          actor_role: actorRole,
        }),
      );
      return;
    }

    if (method === "GET" && pathname === "/assistant/status") {
      writeJson(res, 200, makeAssistantStatus());
      return;
    }

    if (method === "GET" && pathname === "/assistant/context") {
      const currentPath =
        requestUrl.searchParams.get("current_path") || "/dashboard";
      writeJson(res, 200, makeAssistantContext({ current_path: currentPath }));
      return;
    }

    if (method === "POST" && pathname === "/assistant/chat") {
      const payload =
        jsonBody && typeof jsonBody === "object"
          ? (jsonBody as Record<string, unknown>)
          : {};
      const message =
        typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : "Xin chào";
      const bandwidth =
        payload.bandwidth_profile === "low" ||
        payload.bandwidth_profile === "medium" ||
        payload.bandwidth_profile === "high"
          ? payload.bandwidth_profile
          : "high";
      writeJson(
        res,
        200,
        makeAssistantChatReply({
          reply: `Gợi ý ViRead: ${message}`,
          bandwidth_applied: bandwidth,
        }),
      );
      return;
    }

    if (
      method === "POST" &&
      pathname === "/parent-notifications/cron/dispatch"
    ) {
      const providedSecret = req.headers["x-cron-secret"];
      const normalizedSecret = Array.isArray(providedSecret)
        ? providedSecret[0]
        : providedSecret;
      if (normalizedSecret !== cronSecret) {
        writeJson(res, 401, { detail: "INVALID_CRON_SECRET" });
        return;
      }
      const rawScope = requestUrl.searchParams.get("scope") ?? "all";
      const scope = VALID_CRON_SCOPES.has(rawScope)
        ? (rawScope as "all" | "reminders" | "presence" | "engagement")
        : "all";
      writeJson(res, 200, makeCronDispatchResponse({ scope }));
      return;
    }

    if (method === "GET" && pathname === "/reading/history") {
      const childId =
        requestUrl.searchParams.get("child_id")?.trim() || OPAQUE_CHILD_ID;
      writeJson(
        res,
        200,
        makeReadingHistoryList({
          sessions: [
            {
              id: OPAQUE_SESSION_ID,
              child_id: childId,
              book_id: OPAQUE_BOOK_ID,
              state: "FINISHED",
              started_at: "2026-11-21T09:50:00Z",
              ended_at: "2026-11-21T10:00:00Z",
              duration_ms: 600_000,
            },
          ],
        }),
      );
      return;
    }

    if (method === "GET" && pathname.startsWith("/reading/history/")) {
      const rest = pathname.slice("/reading/history/".length);
      if (rest.endsWith("/book")) {
        writeJson(res, 200, makeCatalogBook());
        return;
      }
      if (rest && !rest.includes("/")) {
        const sessionId = decodeSegment(rest);
        writeJson(res, 200, makeReadingSessionDetail({ id: sessionId }));
        return;
      }
    }

    writeJson(res, 404, {
      detail: "CONTRACT_ROUTE_NOT_FOUND",
      path: pathname,
    });
  };

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "CONTRACT_SERVER_ERROR";
      if (!res.headersSent) {
        writeJson(res, 500, { detail: message });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", reject);
      server.unref();
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  const boundPort = address?.port ?? requestedPort;
  const boundUrl = `http://${host}:${boundPort}`;

  return {
    url: boundUrl,
    port: boundPort,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (!server.listening) return;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
    reset,
    getRecordedRequests(): readonly ContractRecordedRequest[] {
      return [...recordedRequests];
    },
    getCronAttempts(): number {
      return cronAttempts;
    },
    armFault,
    setRouteHandler(key: string, handler: ContractRouteHandler): void {
      routeHandlers.set(key, handler);
    },
    clearRouteHandlers(): void {
      routeHandlers.clear();
    },
  };
}
