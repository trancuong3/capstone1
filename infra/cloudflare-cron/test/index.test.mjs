import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  DISPATCH_TIMEOUT_MS,
  HEALTH_FIRST_TIMEOUT_MS,
  HEALTH_RETRY_TIMEOUT_MS,
  runCronDispatch,
} from "../src/index.js";

const VALID_ENV = Object.freeze({
  VIREAD_BACKEND_URL: "https://capstone1-ssd8.onrender.com/",
  VIREAD_CRON_DISPATCH_TOKEN: "viread-test-cron-dispatch-token-0123456789",
});

function jsonResponse(status, body = { ok: true }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeAbortError(message = "The operation was aborted") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

test("warm /health 200 proceeds to single POST /internal/cron/dispatch 200", async () => {
  const calls = [];
  const sleeps = [];

  const result = await runCronDispatch(VALID_ENV, {
    backoffMs: 15,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers });
      if (url.endsWith("/health")) {
        return jsonResponse(200, { status: "ok" });
      }
      return jsonResponse(200, { ok: true, workers_swept: 8 });
    },
  });

  assert.deepEqual(result, { ok: true, workers_swept: 8 });
  assert.equal(sleeps.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://capstone1-ssd8.onrender.com/health");
  assert.equal(calls[0].method, "GET");
  assert.equal(
    calls[1].url,
    "https://capstone1-ssd8.onrender.com/internal/cron/dispatch",
  );
  assert.equal(calls[1].method, "POST");
  assert.equal(
    calls[1].headers["X-ViRead-Cron-Token"],
    VALID_ENV.VIREAD_CRON_DISPATCH_TOKEN,
  );
  assert.equal(HEALTH_FIRST_TIMEOUT_MS, 30_000);
  assert.equal(HEALTH_RETRY_TIMEOUT_MS, 45_000);
  assert.equal(DISPATCH_TIMEOUT_MS, 60_000);
});

test("cold-start /health 502 retries /health once then sends single POST 200", async () => {
  const calls = [];
  const sleeps = [];

  const result = await runCronDispatch(VALID_ENV, {
    backoffMs: 25,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (calls.length === 1) {
        return jsonResponse(502, { error: "bad gateway" });
      }
      if (calls.length === 2) {
        return jsonResponse(200, { status: "ok" });
      }
      return jsonResponse(200, { ok: true, cold_start_recovered: true });
    },
  });

  assert.deepEqual(result, { ok: true, cold_start_recovered: true });
  assert.deepEqual(sleeps, [25]);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    ["GET /health", "GET /health", "POST /internal/cron/dispatch"],
  );
});

test("cold-start /health AbortError retries /health once then sends single POST 200", async () => {
  const calls = [];
  const sleeps = [];

  const result = await runCronDispatch(VALID_ENV, {
    backoffMs: 10,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (calls.length === 1) {
        throw makeAbortError("health cold-start timeout");
      }
      if (calls.length === 2) {
        return jsonResponse(200, { status: "ok" });
      }
      return jsonResponse(200, { ok: true });
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(sleeps, [10]);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    ["GET /health", "GET /health", "POST /internal/cron/dispatch"],
  );
});

test("/health 503 degraded response treats FastAPI as awake and proceeds to POST", async () => {
  const calls = [];

  const result = await runCronDispatch(VALID_ENV, {
    sleepImpl: async () => {
      throw new Error("should not sleep when /health returns 503");
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (url.endsWith("/health")) {
        return jsonResponse(503, { status: "degraded", ocr_worker: "offline" });
      }
      return jsonResponse(200, { ok: true, degraded_health_accepted: true });
    },
  });

  assert.deepEqual(result, { ok: true, degraded_health_accepted: true });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    ["GET /health", "POST /internal/cron/dispatch"],
  );
});

test("/health 401/403/404 fails fast without retry or POST", async () => {
  for (const status of [401, 403, 404]) {
    const calls = [];
    await assert.rejects(
      () =>
        runCronDispatch(VALID_ENV, {
          sleepImpl: async () => {
            throw new Error("should not sleep on fail-fast health status");
          },
          fetchImpl: async (url, init) => {
            calls.push({ url, method: init.method });
            return jsonResponse(status, { detail: "misconfigured" });
          },
        }),
      new RegExp(`HTTP ${status}`),
    );
    assert.equal(calls.length, 1);
  }
});

test("POST 502 retries POST once and succeeds on 200", async () => {
  const calls = [];
  const sleeps = [];

  const result = await runCronDispatch(VALID_ENV, {
    backoffMs: 20,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (url.endsWith("/health")) {
        return jsonResponse(200, { status: "ok" });
      }
      if (calls.length === 2) {
        return jsonResponse(502, { error: "upstream reset" });
      }
      return jsonResponse(200, { ok: true, retried_post: true });
    },
  });

  assert.deepEqual(result, { ok: true, retried_post: true });
  assert.deepEqual(sleeps, [20]);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    [
      "GET /health",
      "POST /internal/cron/dispatch",
      "POST /internal/cron/dispatch",
    ],
  );
});

test("POST 401 and POST 503 throw immediately without retrying POST", async () => {
  for (const status of [401, 503]) {
    const postCalls = [];
    await assert.rejects(
      () =>
        runCronDispatch(VALID_ENV, {
          sleepImpl: async () => {
            throw new Error(`should not retry POST ${status}`);
          },
          fetchImpl: async (url, init) => {
            if (url.endsWith("/health")) {
              return jsonResponse(200, { status: "ok" });
            }
            postCalls.push(init.method);
            return jsonResponse(status, { detail: "rejected" });
          },
        }),
      new RegExp(`Cron dispatch failed with HTTP ${status}`),
    );
    assert.equal(postCalls.length, 1);
  }
});

test("POST AbortError throws WITHOUT firing a second POST", async () => {
  let postAttempts = 0;

  await assert.rejects(
    () =>
      runCronDispatch(VALID_ENV, {
        dispatchTimeoutMs: 25,
        sleepImpl: async () => {
          throw new Error("must never sleep or retry after POST AbortError");
        },
        fetchImpl: async (url, init) => {
          if (url.endsWith("/health")) {
            return jsonResponse(200, { status: "ok" });
          }
          postAttempts += 1;
          return await new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              "abort",
              () => reject(makeAbortError("POST timed out")),
              { once: true },
            );
          });
        },
      }),
    (err) => err && err.name === "AbortError",
  );

  assert.equal(postAttempts, 1);
});

test("default worker export scheduled() stays compatible with ctx.waitUntil", async () => {
  let waitedPromise = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/health")) {
      return jsonResponse(200, { status: "ok" });
    }
    return jsonResponse(200, { ok: true, via: "scheduled" });
  };

  try {
    const out = await worker.scheduled({}, VALID_ENV, {
      waitUntil(promise) {
        waitedPromise = promise;
      },
    });
    assert.ok(waitedPromise instanceof Promise);
    assert.deepEqual(await waitedPromise, { ok: true, via: "scheduled" });
    assert.deepEqual(out, { ok: true, via: "scheduled" });
  } finally {
    globalThis.fetch = origFetch;
  }
});
