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
import net from "node:net";

const listenHost = process.env.VIREAD_PROXY_HOST || "0.0.0.0";
const listenPort = Number.parseInt(process.env.VIREAD_PROXY_PORT || "8443", 10);
const frontendHost = "127.0.0.1";
const frontendPort = Number.parseInt(process.env.VIREAD_FRONTEND_PORT || "3000", 10);
const backendHost = "127.0.0.1";
const backendPort = Number.parseInt(process.env.VIREAD_BACKEND_PORT || "8000", 10);
const apiPrefix = (process.env.VIREAD_API_PREFIX || "/_viread_api").replace(/\/+$/, "");
const supabasePort = Number.parseInt(process.env.VIREAD_SUPABASE_PORT || "0", 10);
const supabasePrefix = (process.env.VIREAD_SUPABASE_PREFIX || "/_viread_supabase").replace(/\/+$/, "");
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

function filterHeaders(rawHeaders, stripHopByHop = true) {
  const out = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (stripHopByHop && HOP_BY_HOP.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

function resolveProxyTarget(rawUrl) {
  const isApi =
    rawUrl === apiPrefix || rawUrl.startsWith(apiPrefix + "/") || rawUrl.startsWith(apiPrefix + "?");
  const isSupabase =
    supabasePort > 0 &&
    (rawUrl === supabasePrefix ||
      rawUrl.startsWith(supabasePrefix + "/") ||
      rawUrl.startsWith(supabasePrefix + "?"));
  const targetHost = isApi ? backendHost : frontendHost;
  const targetPort = isApi ? backendPort : isSupabase ? supabasePort : frontendPort;
  let targetPath = rawUrl;
  if (isApi) {
    targetPath = rawUrl.slice(apiPrefix.length) || "/";
    if (targetPath.startsWith("?")) targetPath = "/" + targetPath;
  } else if (isSupabase) {
    targetPath = rawUrl.slice(supabasePrefix.length) || "/";
    if (targetPath.startsWith("?")) targetPath = "/" + targetPath;
  }
  return { isApi, isSupabase, targetHost, targetPort, targetPath };
}

function buildForwardedHeaders(req, { stripHopByHop = true } = {}) {
  const forwardedHeaders = filterHeaders(req.headers, stripHopByHop);
  const incomingHost = req.headers.host || `${listenHost}:${listenPort}`;
  forwardedHeaders["x-forwarded-proto"] = "https";
  forwardedHeaders["x-forwarded-host"] = incomingHost;
  forwardedHeaders["x-forwarded-for"] = req.socket.remoteAddress || "127.0.0.1";
  // Preserve original Host for Next.js SSR cookie/redirect origin resolution.
  forwardedHeaders["host"] = incomingHost;
  return { forwardedHeaders, incomingHost };
}

const server = https.createServer(tlsOptions, (req, res) => {
  const rawUrl = req.url || "/";
  const { isApi, targetHost, targetPort, targetPath } = resolveProxyTarget(rawUrl);
  const { forwardedHeaders, incomingHost } = buildForwardedHeaders(req, { stripHopByHop: true });

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
      if (typeof respHeaders.location === "string") {
        const loc = respHeaders.location;
        const internalOrigins = [
          `http://localhost:${frontendPort}`,
          `https://localhost:${frontendPort}`,
          `http://127.0.0.1:${frontendPort}`,
          `https://127.0.0.1:${frontendPort}`,
        ];
        for (const internalOrigin of internalOrigins) {
          if (loc === internalOrigin || loc.startsWith(internalOrigin + "/") || loc.startsWith(internalOrigin + "?")) {
            respHeaders.location = `https://${incomingHost}${loc.slice(internalOrigin.length)}`;
            break;
          }
        }
      }
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

server.on("upgrade", (req, clientSocket, head) => {
  const rawUrl = req.url || "/";
  const { isApi, targetHost, targetPort, targetPath } = resolveProxyTarget(rawUrl);
  if (!isApi) {
    clientSocket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const { forwardedHeaders } = buildForwardedHeaders(req, { stripHopByHop: false });
  const upstreamSocket = net.connect({ host: targetHost, port: targetPort });

  const destroyBoth = () => {
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };

  clientSocket.on("error", destroyBoth);
  upstreamSocket.on("error", (err) => {
    console.error(`[viread-proxy] upstream_ws_error code=${err.code || err.name}`);
    if (!clientSocket.destroyed) {
      try {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      } catch {
        // Ignore write error on closing socket
      }
    }
    destroyBoth();
  });

  upstreamSocket.on("connect", () => {
    const method = (req.method || "GET").toUpperCase();
    const lines = [`${method} ${targetPath} HTTP/1.1`];
    for (const [key, val] of Object.entries(forwardedHeaders)) {
      if (val === undefined) continue;
      if (Array.isArray(val)) {
        for (const item of val) {
          lines.push(`${key}: ${item}`);
        }
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
    upstreamSocket.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  clientSocket.on("close", () => {
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  });
  upstreamSocket.on("close", () => {
    if (!clientSocket.destroyed) clientSocket.destroy();
  });
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
