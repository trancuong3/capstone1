import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const ALLOWED_SCOPES = new Set(["all", "reminders", "presence", "engagement"]);
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 504]);
const FIRST_ATTEMPT_TIMEOUT_MS = 35_000;
const RETRY_ATTEMPT_TIMEOUT_MS = 20_000;

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
): Promise<Response> {
  return fetch(dispatchUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "X-Cron-Secret": backendSecret,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function handleCronDispatch(request: NextRequest) {
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  if (cronSecret.length < 16) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  const authHeader = (request.headers.get("authorization") ?? "").trim();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = bearerMatch?.[1]?.trim() ?? "";
  if (!token || !constantTimeMatch(token, cronSecret)) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const rawScope = request.nextUrl.searchParams.get("scope") ?? "all";
  const scope = ALLOWED_SCOPES.has(rawScope) ? rawScope : "all";
  const dispatchUrl = resolveDispatchUrl(scope);
  if (!dispatchUrl) {
    return NextResponse.json(
      { ok: false, error: "BACKEND_API_URL_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  const backendSecret =
    process.env.PARENT_EMAIL_CRON_SECRET?.trim() || cronSecret;

  let upstream: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeoutMs =
      attempt === 0 ? FIRST_ATTEMPT_TIMEOUT_MS : RETRY_ATTEMPT_TIMEOUT_MS;
    try {
      upstream = await postDispatchOnce(dispatchUrl, backendSecret, timeoutMs);
      if (
        upstream.ok ||
        !RETRYABLE_UPSTREAM_STATUSES.has(upstream.status) ||
        attempt === 1
      ) {
        break;
      }
      await upstream.body?.cancel().catch(() => undefined);
    } catch {
      upstream = null;
      if (attempt === 1) {
        return NextResponse.json(
          { ok: false, error: "UPSTREAM_UNREACHABLE" },
          { status: 504 },
        );
      }
    }
  }

  if (!upstream) {
    return NextResponse.json(
      { ok: false, error: "UPSTREAM_UNREACHABLE" },
      { status: 504 },
    );
  }

  if (!upstream.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "UPSTREAM_DISPATCH_FAILED",
        upstreamStatus: upstream.status,
      },
      { status: 502 },
    );
  }

  try {
    const summary = (await upstream.json()) as Record<string, unknown>;
    return NextResponse.json({ ok: true, summary }, { status: 200 });
  } catch {
    return NextResponse.json(
      { ok: false, error: "UPSTREAM_INVALID_JSON" },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest) {
  return handleCronDispatch(request);
}

export async function POST(request: NextRequest) {
  return handleCronDispatch(request);
}
