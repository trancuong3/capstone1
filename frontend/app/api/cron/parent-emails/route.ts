import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const ALLOWED_SCOPES = new Set(["all", "reminders", "presence", "engagement"]);
const RETRYABLE_UPSTREAM_STATUSES = new Set([
  502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530,
]);
const TOTAL_DISPATCH_BUDGET_MS = 55_000;
const FIRST_ATTEMPT_TIMEOUT_MS = 40_000;
const MIN_ATTEMPT_TIMEOUT_MS = 8_000;
const FAST_FAILURE_THRESHOLD_MS = 10_000;
const RETRY_DELAYS_MS = [500, 2_000, 5_000, 10_000, 12_000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function constantTimeMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function resolveDispatchUrl(scope: string): string | null {
  const rawBase =
    process.env.BACKEND_API_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    "";
  if (!rawBase) return null;
  try {
    const parsed = new URL(rawBase);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    const base = rawBase.replace(/\/+$/, "");
    return `${base}/parent-notifications/cron/dispatch?scope=${encodeURIComponent(scope)}`;
  } catch {
    return null;
  }
}

async function postDispatchOnce(
  dispatchUrl: string,
  backendSecret: string,
  timeoutMs: number,
  requestId: string,
): Promise<Response> {
  const controller = new AbortController();
  const timerId = globalThis.setTimeout(() => {
    controller.abort(
      typeof DOMException !== "undefined"
        ? new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          )
        : new Error("TimeoutError"),
    );
  }, timeoutMs);
  try {
    return await fetch(dispatchUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-Cron-Secret": backendSecret,
        "X-Request-ID": requestId,
      },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timerId);
  }
}

function sanitizeRequestId(
  raw: string | null | undefined,
  fallback: string,
): string {
  const trimmed = raw?.trim();
  if (trimmed && trimmed.length <= 128 && /^[\w.-]+$/.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

function resolveRequestId(request: NextRequest): string {
  return sanitizeRequestId(request.headers.get("x-request-id"), randomUUID());
}

async function readJsonWithBudget(
  response: Response,
  budgetMs: number,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.json() as Promise<Record<string, unknown>>,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            reject(
              new DOMException("Upstream body read timed out", "TimeoutError"),
            );
          },
          Math.max(1_000, budgetMs),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function handleCronDispatch(request: NextRequest) {
  const requestId = resolveRequestId(request);
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  if (cronSecret.length < 16) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET_NOT_CONFIGURED", requestId },
      { status: 503, headers: { "X-Request-ID": requestId } },
    );
  }

  const authHeader = (request.headers.get("authorization") ?? "").trim();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = bearerMatch?.[1]?.trim() ?? "";
  if (!token || !constantTimeMatch(token, cronSecret)) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED", requestId },
      { status: 401, headers: { "X-Request-ID": requestId } },
    );
  }

  const rawScope = request.nextUrl.searchParams.get("scope") ?? "all";
  const scope = ALLOWED_SCOPES.has(rawScope) ? rawScope : "all";
  const dispatchUrl = resolveDispatchUrl(scope);
  if (!dispatchUrl) {
    return NextResponse.json(
      { ok: false, error: "BACKEND_API_URL_NOT_CONFIGURED", requestId },
      { status: 503, headers: { "X-Request-ID": requestId } },
    );
  }

  const backendSecret =
    process.env.PARENT_EMAIL_CRON_SECRET?.trim() || cronSecret;

  const startedAt = Date.now();
  const deadlineAt = startedAt + TOTAL_DISPATCH_BUDGET_MS;
  let upstream: Response | null = null;
  let lastErrorName: string | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < MIN_ATTEMPT_TIMEOUT_MS) {
      break;
    }

    const timeoutMs =
      attempt === 0
        ? Math.min(FIRST_ATTEMPT_TIMEOUT_MS, remainingMs)
        : remainingMs;
    const attemptStartedAt = Date.now();

    try {
      upstream = await postDispatchOnce(
        dispatchUrl,
        backendSecret,
        timeoutMs,
        requestId,
      );
      if (upstream.ok || !RETRYABLE_UPSTREAM_STATUSES.has(upstream.status)) {
        break;
      }
      const upstreamRequestId = sanitizeRequestId(
        upstream.headers.get("x-request-id"),
        requestId,
      );
      console.error(
        "[cron/parent-emails] transient upstream status, retrying",
        {
          scope,
          attempt: attempt + 1,
          upstreamStatus: upstream.status,
          requestId: upstreamRequestId,
        },
      );
      void upstream.body?.cancel().catch(() => undefined);
    } catch (error) {
      upstream = null;
      lastErrorName = error instanceof Error ? error.name : "UnknownError";
      console.error("[cron/parent-emails] upstream dispatch attempt failed", {
        scope,
        attempt: attempt + 1,
        errorName: lastErrorName,
        requestId,
      });
    }

    if (attempt >= RETRY_DELAYS_MS.length) {
      break;
    }

    const remainingAfterAttempt = deadlineAt - Date.now();
    if (remainingAfterAttempt < MIN_ATTEMPT_TIMEOUT_MS) {
      break;
    }

    const attemptElapsedMs = Date.now() - attemptStartedAt;
    if (attemptElapsedMs < FAST_FAILURE_THRESHOLD_MS) {
      const maxDelayMs = remainingAfterAttempt - MIN_ATTEMPT_TIMEOUT_MS;
      const delayMs = Math.min(RETRY_DELAYS_MS[attempt] ?? 0, maxDelayMs);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  if (!upstream) {
    console.error("[cron/parent-emails] upstream unreachable", {
      scope,
      errorName: lastErrorName,
      requestId,
    });
    return NextResponse.json(
      { ok: false, error: "UPSTREAM_UNREACHABLE", requestId },
      { status: 504, headers: { "X-Request-ID": requestId } },
    );
  }

  const upstreamRequestId = sanitizeRequestId(
    upstream.headers.get("x-request-id"),
    requestId,
  );

  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => undefined);
    console.error("[cron/parent-emails] upstream dispatch failed", {
      scope,
      upstreamStatus: upstream.status,
      requestId: upstreamRequestId,
    });
    return NextResponse.json(
      {
        ok: false,
        error: "UPSTREAM_DISPATCH_FAILED",
        upstreamStatus: upstream.status,
        requestId: upstreamRequestId,
      },
      { status: 502, headers: { "X-Request-ID": upstreamRequestId } },
    );
  }

  try {
    const remainingReadBudgetMs =
      TOTAL_DISPATCH_BUDGET_MS - (Date.now() - startedAt);
    const summary = await readJsonWithBudget(upstream, remainingReadBudgetMs);
    return NextResponse.json(
      { ok: true, summary },
      { status: 200, headers: { "X-Request-ID": upstreamRequestId } },
    );
  } catch {
    console.error("[cron/parent-emails] upstream returned invalid JSON", {
      scope,
      upstreamStatus: upstream.status,
      requestId: upstreamRequestId,
    });
    return NextResponse.json(
      {
        ok: false,
        error: "UPSTREAM_INVALID_JSON",
        upstreamStatus: upstream.status,
        requestId: upstreamRequestId,
      },
      { status: 502, headers: { "X-Request-ID": upstreamRequestId } },
    );
  }
}

export async function GET(request: NextRequest) {
  return handleCronDispatch(request);
}

export async function POST(request: NextRequest) {
  return handleCronDispatch(request);
}
