#!/usr/bin/env node
/**
 * Single-origin HTTPS LAN reverse proxy for ViRead on Windows.
 *
 * Exposes ONLY one TLS 1.2+ port on LAN (default 0.0.0.0:8443):
 *   - /_viread_api/* -> http://127.0.0.1:<BACKEND_PORT>/*  (FastAPI + Local OCR)
 *   - /*             -> http://127.0.0.1:<FRONTEND_PORT>/* (Next.js 16 SSR)
 *
 * Keeps Next.js (3000), FastAPI (8000), DB, and local models strictly on 127.0.0.1.
 * Never logs Authorization headers, cookies, tokens, or uploaded image/OCR bodies.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const listenHost = process.env.VIREAD_PROXY_HOST || "0.0.0.0";
const listenPort = Number.parseInt(process.env.VIREAD_PROXY_PORT || "8443", 10);
const frontendHost = "127.0.0.1";
const frontendPort = Number.parseInt(process.env.VIREAD_FRONTEND_PORT || "3000", 10);
const backendHost = "127.0.0.1";
const backendPort = Number.parseInt(process.env.VIREAD_BACKEND_PORT || "8000", 10);
const apiPrefix = (process.env.VIREAD_API_PREFIX || "/_viread_api").replace(/\/+$/, "");
const certPath = process.env.VIREAD_TLS_CERT;
const keyPath = process.env.VIREAD_TLS_KEY;

if (!certPath || !keyPath || !fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  console.error("[viread-proxy] Missing VIREAD_TLS_CERT or VIREAD_TLS_KEY.");
  process.exit(2);
}

const tlsOptions = {
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(keyPath),
  minVersion: "TLSv1.2",
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function filterHeaders(rawHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

const server = https.createServer(tlsOptions, (req, res) => {
  const rawUrl = req.url || "/";
  const isApi = rawUrl === apiPrefix || rawUrl.startsWith(apiPrefix + "/") || rawUrl.startsWith(apiPrefix + "?");
  const targetHost = isApi ? backendHost : frontendHost;
  const targetPort = isApi ? backendPort : frontendPort;
  let targetPath = rawUrl;
  if (isApi) {
    targetPath = rawUrl.slice(apiPrefix.length) || "/";
    if (targetPath.startsWith("?")) targetPath = "/" + targetPath;
  }

  const forwardedHeaders = filterHeaders(req.headers);
  const incomingHost = req.headers.host || `${listenHost}:${listenPort}`;
  forwardedHeaders["x-forwarded-proto"] = "https";
  forwardedHeaders["x-forwarded-host"] = incomingHost;
  forwardedHeaders["x-forwarded-for"] = req.socket.remoteAddress || "127.0.0.1";
  // Preserve original Host for Next.js SSR cookie/redirect origin resolution.
  forwardedHeaders["host"] = incomingHost;

  const upstreamReq = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: forwardedHeaders,
      timeout: isApi ? 150_000 : 30_000,
    },
    (upstreamRes) => {
      const respHeaders = filterHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.statusCode || 502, respHeaders);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy(new Error("Upstream request timed out"));
  });

  upstreamReq.on("error", (err) => {
    const safeTag = isApi ? "backend" : "frontend";
    console.error(`[viread-proxy] upstream_${safeTag}_error code=${err.code || err.name}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          detail: `ViRead local ${safeTag} is temporarily unavailable`,
        }),
      );
    } else {
      res.end();
    }
  });

  req.on("aborted", () => {
    upstreamReq.destroy();
  });

  req.pipe(upstreamReq);
});

server.requestTimeout = 160_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 65_000;

server.on("error", (err) => {
  console.error(`[viread-proxy] listen_error code=${err.code || err.name}`);
  process.exit(1);
});

server.listen(listenPort, listenHost, () => {
  console.log(
    `[viread-proxy] Listening on https://${listenHost}:${listenPort} (frontend=127.0.0.1:${frontendPort}, backend=127.0.0.1:${backendPort}${apiPrefix})`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
