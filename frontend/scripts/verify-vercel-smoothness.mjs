import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const distDir = ".next-e2e";
const distPath = path.join(frontendRoot, distDir);
const tsconfigPath = path.join(frontendRoot, "tsconfig.json");
const nextEnvPath = path.join(frontendRoot, "next-env.d.ts");
const nextBin = path.join(
  frontendRoot,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);
const playwrightBin = path.join(
  frontendRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "92000000-0000-4000-8000-000000000001";
const BOOK_ID = "82000000-0000-4000-8000-000000000010";
const PAGE_ID = "83000000-0000-4000-8000-000000000011";
const REV_ID = "84000000-0000-4000-8000-000000000011";
const NOW = "2026-11-21T10:00:00Z";

function parseArgs(argv) {
  let mode = "all";
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length).trim();
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/verify-vercel-smoothness.mjs [--mode=all|harness]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (mode !== "all" && mode !== "harness") {
    throw new Error(`Invalid --mode=${mode}. Expected "all" or "harness".`);
  }
  return { mode };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to acquire ephemeral loopback port."));
        return;
      }
      const { port } = addr;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function startMockBackendServer(cronSecret) {
  const recordedRequests = [];
  const cronState = {
    failRemaining: 0,
    attempts: 0,
  };

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  };

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  };

  const sampleBook = {
    id: BOOK_ID,
    title: "Bé Tập Đọc Sách Hay",
    author: "ViRead",
    min_grade: 1,
    max_grade: 3,
    lifecycle_status: "ACTIVE",
    visibility_scope: "CATALOG",
    cover_url:
      "https://sampleid.supabase.co/storage/v1/object/public/readalong-book-pages/cover.webp",
    cover_source_type: "AI_GENERATED",
  };

  const sampleProfile = {
    id: PARENT_ID,
    display_name: "Phụ huynh Kiểm thử",
    email: "parent@viread.local",
    role: "parent",
    avatar_url: null,
    preferred_locale: "vi",
    created_at: NOW,
  };

  const sampleChild = {
    id: CHILD_ID,
    parent_id: PARENT_ID,
    alias: "Bé An",
    grade: 2,
    settings: {},
    created_at: NOW,
    avatar_url: null,
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    if (!pathname.startsWith("/__mock/")) {
      recordedRequests.push({
        method: req.method ?? "GET",
        path: `${pathname}${reqUrl.search}`,
        ts: Date.now(),
      });
    }

    if (req.method === "POST" && pathname === "/__mock/cron-arm-502") {
      cronState.failRemaining = 1;
      cronState.attempts = 0;
      sendJson(res, 200, { armed: true });
      return;
    }

    if (req.method === "POST" && pathname === "/__mock/reset") {
      recordedRequests.length = 0;
      cronState.failRemaining = 0;
      cronState.attempts = 0;
      sendJson(res, 200, { reset: true });
      return;
    }

    if (req.method === "GET" && pathname === "/__mock/stats") {
      sendJson(res, 200, {
        cronState: { ...cronState },
        requestCount: recordedRequests.length,
        requests: recordedRequests.slice(-50),
      });
      return;
    }

    if (pathname === "/health") {
      sendJson(res, 200, { status: "ok", mode: "mock" });
      return;
    }

    if (pathname === "/books/catalog" || pathname === "/books/") {
      sendJson(res, 200, [sampleBook]);
      return;
    }

    if (pathname === `/books/catalog/${BOOK_ID}`) {
      sendJson(res, 200, sampleBook);
      return;
    }

    if (pathname === `/books/catalog/${BOOK_ID}/preview`) {
      sendJson(res, 200, [
        {
          page_id: PAGE_ID,
          page_number: 1,
          lifecycle_status: "ACTIVE",
          current_verified_revision_id: REV_ID,
          preview_url:
            "https://sampleid.supabase.co/storage/v1/object/public/readalong-book-pages/page1.webp",
        },
      ]);
      return;
    }

    if (pathname === "/profiles/me") {
      sendJson(res, 200, sampleProfile);
      return;
    }

    if (pathname === "/profiles/children") {
      sendJson(res, 200, [sampleChild]);
      return;
    }

    if (pathname === `/profiles/children/${CHILD_ID}`) {
      sendJson(res, 200, sampleChild);
      return;
    }

    if (pathname === "/profiles/dashboard-summary") {
      sendJson(res, 200, {
        profile: sampleProfile,
        children: [sampleChild],
        latest_sessions_by_child: { [CHILD_ID]: null },
      });
      return;
    }

    if (pathname === "/assistant/context") {
      sendJson(res, 200, { page_title: "ViRead", hints: [] });
      return;
    }

    if (req.method === "POST" && pathname === "/assistant/chat") {
      const payload = await readJsonBody(req);
      sendJson(res, 200, {
        reply: `Trợ lý ViRead đã nhận câu hỏi: ${String(payload?.message ?? "")}`,
        source_tier: "tier_0_kb",
        provider_id: "kb-local",
        model_id: null,
        bandwidth_applied: "high",
        latency_ms: 5,
        cached: false,
        role_scope: "parent",
        quick_actions: [],
        suggested_prompts: [],
      });
      return;
    }

    if (
      req.method === "POST" &&
      pathname === "/parent-notifications/cron/dispatch"
    ) {
      const headerSecret = req.headers["x-cron-secret"];
      if (headerSecret !== cronSecret) {
        sendJson(res, 401, { detail: "INVALID_CRON_SECRET" });
        return;
      }
      cronState.attempts += 1;
      if (cronState.failRemaining > 0) {
        cronState.failRemaining -= 1;
        sendJson(res, 502, { detail: "Simulated transient cold-start 502" });
        return;
      }
      sendJson(res, 200, {
        dispatched: 1,
        scope: reqUrl.searchParams.get("scope") ?? "all",
        attempt: cronState.attempts,
      });
      return;
    }

    sendJson(res, 404, { detail: "MOCK_NOT_FOUND", path: pathname });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Mock backend failed to bind."));
        return;
      }
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((resClose) => {
            server.close(() => resClose());
          }),
      });
    });
  });
}

function runNodeCommand(args, { env = {}, label = "command" } = {}) {
  return new Promise((resolve) => {
    console.log(`\n>>> [${label}] node ${args.join(" ")}`);
    const child = spawn(process.execPath, args, {
      cwd: frontendRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", (err) => {
      console.error(`[${label}] spawn error:`, err);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`[${label}] terminated by signal ${signal}`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

function startBackgroundNodeServer(args, { env = {}, label = "server" } = {}) {
  console.log(`\n>>> [${label}] starting: node ${args.join(" ")}`);
  const child = spawn(process.execPath, args, {
    cwd: frontendRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  let exitCode = null;
  let recentLogs = "";

  const appendLog = (chunk) => {
    recentLogs = (recentLogs + chunk.toString("utf8")).slice(-8000);
  };
  child.stdout?.on("data", appendLog);
  child.stderr?.on("data", appendLog);
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  return {
    child,
    hasExited: () => exited,
    getExitCode: () => exitCode,
    getLogs: () => recentLogs,
  };
}

async function waitForHttpReady(url, serverHandle, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverHandle.hasExited()) {
      throw new Error(
        `Server exited early (code=${serverHandle.getExitCode()}).\nLogs:\n${serverHandle.getLogs()}`,
      );
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status < 500) {
        return;
      }
    } catch {
      // Server still booting or compiling first route.
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `Timed out waiting for ${url} after ${timeoutMs}ms.\nLogs:\n${serverHandle.getLogs()}`,
  );
}

async function killProcessTree(serverHandle) {
  if (!serverHandle || !serverHandle.child || serverHandle.hasExited()) {
    return;
  }
  const pid = serverHandle.child.pid;
  if (!pid) return;

  try {
    serverHandle.child.kill("SIGTERM");
  } catch {
    // Ignore kill errors.
  }

  const waitStart = Date.now();
  while (!serverHandle.hasExited() && Date.now() - waitStart < 2500) {
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!serverHandle.hasExited() && process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
  } else if (!serverHandle.hasExited()) {
    try {
      serverHandle.child.kill("SIGKILL");
    } catch {
      // Ignore kill errors.
    }
  }
}

function cleanDistDir() {
  if (fs.existsSync(distPath)) {
    fs.rmSync(distPath, { recursive: true, force: true });
  }
}

function snapshotManagedFiles() {
  const files = [tsconfigPath, nextEnvPath];
  return files.map((filePath) => ({
    filePath,
    exists: fs.existsSync(filePath),
    content: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
  }));
}

function restoreManagedFiles(snapshots) {
  for (const snap of snapshots) {
    if (snap.exists && snap.content !== null) {
      const current = fs.existsSync(snap.filePath)
        ? fs.readFileSync(snap.filePath)
        : null;
      if (!current || !current.equals(snap.content)) {
        fs.writeFileSync(snap.filePath, snap.content);
      }
    }
  }
}

async function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  const managedFileSnapshots = snapshotManagedFiles();
  const cronSecret = "viread_e2e_cron_secret_0123456789abcdef";
  const ssrSigningKey = "viread_e2e_test_signing_key_0123456789abcdef";
  const authFixtureToken = randomBytes(32).toString("hex");

  const mockBackend = await startMockBackendServer(cronSecret);
  console.log(`Mock backend listening on ${mockBackend.url}`);

  const baseEnv = {
    NEXT_DIST_DIR: distDir,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: "https://sampleid.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key_1234567890",
    NEXT_PUBLIC_API_URL: mockBackend.url,
    BACKEND_API_URL: mockBackend.url,
    VIREAD_SSR_AUTH_SIGNING_KEY: ssrSigningKey,
    CRON_SECRET: cronSecret,
  };

  let prodServer = null;
  let devServer = null;
  const results = [];

  const recordStep = (name, code) => {
    results.push({ name, code });
    console.log(`[${code === 0 ? "PASS" : "FAIL"}] ${name} (exit=${code})`);
    return code;
  };

  try {
    if (mode === "harness") {
      const syntaxCode = recordStep(
        "Contract syntax check",
        await runNodeCommand(
          ["--check", "tests/e2e/vercel-smoothness-contracts.mjs"],
          { label: "node --check" },
        ),
      );
      const listCode = recordStep(
        "Playwright test discovery",
        await runNodeCommand(
          [
            playwrightBin,
            "test",
            "--config=playwright.vercel-e2e.config.ts",
            "--list",
          ],
          {
            env: {
              ...baseEnv,
              PLAYWRIGHT_BASE_URL: "http://127.0.0.1:3199",
              PLAYWRIGHT_AUTH_FIXTURE_TOKEN: authFixtureToken,
            },
            label: "playwright --list",
          },
        ),
      );
      if (syntaxCode !== 0 || listCode !== 0) {
        process.exitCode = 1;
        return;
      }

      const buildCode = recordStep(
        "Production next build (.next-e2e)",
        await runNodeCommand([nextBin, "build"], {
          env: { ...baseEnv, NODE_ENV: "production" },
          label: "next build",
        }),
      );
      if (buildCode !== 0) {
        process.exitCode = 1;
        return;
      }

      const prodPort = await getFreePort();
      const prodBaseUrl = `http://127.0.0.1:${prodPort}`;
      prodServer = startBackgroundNodeServer(
        [
          nextBin,
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(prodPort),
        ],
        {
          env: { ...baseEnv, NODE_ENV: "production" },
          label: "next start",
        },
      );
      await waitForHttpReady(`${prodBaseUrl}/login`, prodServer, 60_000);

      const smokeCode = recordStep(
        "Production Playwright [harness] smoke",
        await runNodeCommand(
          [
            playwrightBin,
            "test",
            "--config=playwright.vercel-e2e.config.ts",
            "tests/e2e/vercel-smoothness-e2e.spec.ts",
            "--grep",
            "\\[harness\\]",
          ],
          {
            env: {
              ...baseEnv,
              PLAYWRIGHT_BASE_URL: prodBaseUrl,
              VIREAD_MOCK_API_URL: mockBackend.url,
            },
            label: "playwright harness",
          },
        ),
      );
      if (smokeCode !== 0) {
        process.exitCode = 1;
      }
      return;
    }

    // --mode=all
    recordStep(
      "Contract suite (vercel-smoothness-contracts.mjs)",
      await runNodeCommand(
        ["--test", "tests/e2e/vercel-smoothness-contracts.mjs"],
        { env: baseEnv, label: "node --test contracts" },
      ),
    );

    const buildCode = recordStep(
      "Production next build (.next-e2e)",
      await runNodeCommand([nextBin, "build"], {
        env: { ...baseEnv, NODE_ENV: "production" },
        label: "next build",
      }),
    );

    if (buildCode === 0) {
      const prodPort = await getFreePort();
      const prodBaseUrl = `http://127.0.0.1:${prodPort}`;
      prodServer = startBackgroundNodeServer(
        [
          nextBin,
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(prodPort),
        ],
        {
          env: { ...baseEnv, NODE_ENV: "production" },
          label: "next start",
        },
      );
      await waitForHttpReady(`${prodBaseUrl}/login`, prodServer, 60_000);

      recordStep(
        "Production Playwright E2E (vercel-smoothness-e2e.spec.ts)",
        await runNodeCommand(
          [
            playwrightBin,
            "test",
            "--config=playwright.vercel-e2e.config.ts",
            "tests/e2e/vercel-smoothness-e2e.spec.ts",
          ],
          {
            env: {
              ...baseEnv,
              PLAYWRIGHT_BASE_URL: prodBaseUrl,
              VIREAD_MOCK_API_URL: mockBackend.url,
            },
            label: "playwright prod e2e",
          },
        ),
      );

      await killProcessTree(prodServer);
      prodServer = null;
    }

    // Clear production .next-e2e build artifacts before starting next dev
    // so dev compilation does not contend with production build output.
    cleanDistDir();

    const devPort = await getFreePort();
    const devBaseUrl = `http://127.0.0.1:${devPort}`;
    devServer = startBackgroundNodeServer(
      [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(devPort)],
      {
        env: {
          ...baseEnv,
          NODE_ENV: "development",
          PLAYWRIGHT_AUTH_FIXTURES: "1",
          PLAYWRIGHT_AUTH_FIXTURE_TOKEN: authFixtureToken,
        },
        label: "next dev",
      },
    );
    await waitForHttpReady(`${devBaseUrl}/robots.txt`, devServer, 150_000);

    recordStep(
      "Authenticated Dev Playwright E2E (vercel-authenticated-flows.spec.ts)",
      await runNodeCommand(
        [
          playwrightBin,
          "test",
          "--config=playwright.vercel-e2e.config.ts",
          "tests/e2e/vercel-authenticated-flows.spec.ts",
        ],
        {
          env: {
            ...baseEnv,
            PLAYWRIGHT_BASE_URL: devBaseUrl,
            VIREAD_MOCK_API_URL: mockBackend.url,
            PLAYWRIGHT_AUTH_FIXTURES: "1",
            PLAYWRIGHT_AUTH_FIXTURE_TOKEN: authFixtureToken,
          },
          label: "playwright dev auth flows",
        },
      ),
    );

    if (results.some((entry) => entry.code !== 0)) {
      process.exitCode = 1;
    }
  } finally {
    await killProcessTree(prodServer);
    await killProcessTree(devServer);
    await mockBackend.close();
    cleanDistDir();
    restoreManagedFiles(managedFileSnapshots);
    console.log(
      "\nCleaned up servers, .next-e2e, and restored managed config files.",
    );
    if (results.length > 0) {
      console.log("Summary:");
      for (const item of results) {
        console.log(`  - ${item.name}: ${item.code === 0 ? "PASS" : "FAIL"}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  cleanDistDir();
  process.exitCode = 1;
});
