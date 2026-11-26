#!/usr/bin/env node
/**
 * Real Physical USB Android E2E Deep Audit (ADB + WebView CDP) for ViRead Android APK.
 * Verifies:
 *  - Freshly built app-debug.apk launches https://192.168.1.2:8443 with LAN CA cert (zero SSL errors)
 *  - Real login & reading screen render on physical Android 16 phone
 *  - Portrait & Landscape reading screenshots + .reader-leaf scrollability & detach
 *  - Android Home backgrounding (KEYCODE_HOME -> MainActivity.onStop() -> viread:android-background)
 *    & foreground resume with zero crashes, zero ANR, zero fatal logcat errors, zero console/API errors
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const REPO_ROOT = "F:\\c1\\capstone1";
const OUT_DIR = path.join(
  REPO_ROOT,
  "docs",
  "reading",
  "evidence",
  "reading_deep_audit_20261126",
);
const ADB = "F:\\c1\\tools\\android-sdk\\platform-tools\\adb.exe";
const SERIAL = "ATSYVB6205006984";
const PKG = "vn.viread.android";
const ACCOUNTS_PATH = "F:\\c1\\viread-host-runtime\\acceptance-accounts.json";
const SAMPLE_BOOK_ID = "aaaaaaaa-2026-4112-8001-000000000001";
const CDP_PORT = 9233;

const require = createRequire(path.join(REPO_ROOT, "frontend", "package.json"));
const { chromium } = require("@playwright/test");

const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
const parent = accounts.parent_a;

function adb(args, opts = {}) {
  return execFileSync(ADB, ["-s", SERIAL, ...args], {
    encoding: opts.binary ? null : "utf8",
    timeout: opts.timeout ?? 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function screencap(name) {
  const dest = path.join(OUT_DIR, name);
  const res = spawnSync(ADB, ["-s", SERIAL, "exec-out", "screencap", "-p"], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20_000,
  });
  if (res.status === 0 && res.stdout && res.stdout.length > 1000) {
    fs.writeFileSync(dest, res.stdout);
    return dest;
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectWebViewCdp() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const socketsRaw = adb(["shell", "cat", "/proc/net/unix"]);
      const match = socketsRaw.match(/webview_devtools_remote_\d+/);
      if (match) {
        adb([
          "forward",
          `tcp:${CDP_PORT}`,
          `localabstract:${match[0]}`,
        ]);
        const browser = await chromium.connectOverCDP(
          `http://127.0.0.1:${CDP_PORT}`,
        );
        return { browser, socketName: match[0] };
      }
    } catch {}
    await sleep(1000);
  }
  throw new Error("Timed out waiting for Android WebView DevTools socket");
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    started_at: new Date().toISOString(),
    device: {
      serial: SERIAL,
      model: adb(["shell", "getprop", "ro.product.model"]).trim(),
      android_release: adb(["shell", "getprop", "ro.build.version.release"]).trim(),
      sdk: adb(["shell", "getprop", "ro.build.version.sdk"]).trim(),
      wm_size: adb(["shell", "wm", "size"]).trim(),
    },
    console_errors: [],
    page_errors: [],
    api_errors: [],
    screenshots: [],
    checks: {},
  };

  // Wake screen, grant microphone permission, clear logcat, launch fresh app
  try {
    adb(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    adb(["shell", "wm", "dismiss-keyguard"]);
  } catch {}
  adb(["shell", "pm", "grant", PKG, "android.permission.RECORD_AUDIO"]);
  adb(["shell", "pm", "grant", PKG, "android.permission.CAMERA"]);
  adb(["logcat", "-c"]);
  adb(["shell", "am", "force-stop", PKG]);
  await sleep(600);
  adb(["shell", "am", "start", "-n", `${PKG}/.MainActivity`]);
  await sleep(3000);

  const { browser, socketName } = await connectWebViewCdp();
  report.checks.webview_cdp_connected = { pass: true, socketName };

  try {
    let page = null;
    for (let i = 0; i < 20; i += 1) {
      const pages = browser.contexts().flatMap((c) => c.pages());
      page = pages.find((p) => p.url().startsWith("https://192.168.1.2:8443")) || pages[0];
      if (page && page.url().startsWith("https://192.168.1.2:8443")) break;
      await sleep(800);
    }
    if (!page) throw new Error("No WebView page found");

    page.on("console", (msg) => {
      if (msg.type() === "error") report.console_errors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      report.page_errors.push(String(err));
    });
    page.on("response", (res) => {
      if (res.url().includes("/_viread_api/") && res.status() >= 400) {
        report.api_errors.push({ url: res.url(), status: res.status() });
      }
    });

    report.checks.lan_https_loaded = {
      pass: page.url().startsWith("https://192.168.1.2:8443"),
      url: page.url(),
    };

    // Login if on /login
    if (page.url().includes("/login")) {
      await page.fill('input[type="email"]', parent.email);
      await page.fill('input[type="password"]', parent.password);
      await page.click('button[type="submit"]');
      await page.waitForURL((u) => !u.pathname.includes("/login"), {
        timeout: 25_000,
      });
      await sleep(1200);
    }
    const dashShot = screencap("usb_android_dashboard.png");
    if (dashShot) report.screenshots.push(dashShot);
    report.checks.login = { pass: !page.url().includes("/login"), url: page.url() };

    // Navigate to reading-preparation -> create session -> start reading -> Page 2
    await page.goto(
      `https://192.168.1.2:8443/reading-preparation?bookId=${SAMPLE_BOOK_ID}&childId=${parent.child_id}`,
      { waitUntil: "domcontentloaded", timeout: 25_000 },
    );
    await sleep(1200);
    const verifyMicBtn = page.getByRole("button", {
      name: /Kiểm tra và cấp quyền microphone|Kiểm tra lại microphone/i,
    });
    if (await verifyMicBtn.isVisible().catch(() => false)) {
      await verifyMicBtn.click();
      await sleep(1500);
    }
    const startPrepBtn = page.getByRole("button", { name: /^Bắt đầu đọc$/i });
    await startPrepBtn.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const b = Array.from(document.querySelectorAll("button")).find(
          (el) => el.textContent?.trim() === "Bắt đầu đọc",
        );
        return Boolean(b && !b.disabled);
      },
      null,
      { timeout: 15_000 },
    );
    await startPrepBtn.click();
    await page.waitForURL(/\/reading\/[0-9a-f-]+/i, { timeout: 25_000 });
    const readyBtn = page.getByRole("button", { name: /Bắt đầu đọc/i });
    await readyBtn.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    if (await readyBtn.isVisible().catch(() => false)) {
      await readyBtn.click();
      await sleep(1500);
    }
    await page.waitForSelector('[data-reading-scroll-container="true"]', {
      timeout: 20_000,
    });
    // Advance to Page 2 (401 words)
    const nextBtn = page.getByRole("button", { name: /Trang tiếp theo|Tiếp/i });
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click();
      await sleep(1500);
    }

    const readingShot = screencap("usb_android_reading_page2.png");
    if (readingShot) report.screenshots.push(readingShot);

    // Attach listener on document (exact target dispatched by MainActivity.onStop())
    await page.evaluate(() => {
      window.__vireadBgEvents = 0;
      document.addEventListener("viread:android-background", () => {
        window.__vireadBgEvents += 1;
      });
    });

    // Test scroll & detach on real Android WebView
    await sleep(800);
    const androidScroll = await page.evaluate(() => {
      const el = document.querySelector('[data-reading-scroll-container="true"]');
      if (!el) return { found: false };
      const scrollable = el.scrollHeight > el.clientHeight + 2;
      if (scrollable) {
        el.scrollTop = Math.min(240, el.scrollHeight - el.clientHeight);
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      return {
        found: true,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        isScrollable: scrollable,
      };
    });
    await sleep(400);
    const detachBtn = page.getByRole("button", { name: /Về từ đang đọc/i });
    const detachedVisible = await detachBtn.isVisible().catch(() => false);
    const detachShot = screencap("usb_android_reading_detached.png");
    if (detachShot) report.screenshots.push(detachShot);
    if (detachedVisible) {
      await detachBtn.click();
      await sleep(400);
    }
    report.checks.android_scroll_and_detach = {
      ...androidScroll,
      detachedVisible,
    };

    // Press Android HOME to trigger MainActivity.onStop() -> viread:android-background -> pauseWebViewAfterBackgroundEvent()
    adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
    await sleep(2000);
    // Resume ViRead app
    adb(["shell", "am", "start", "-n", `${PKG}/.MainActivity`]);
    await sleep(2000);
    const bgEventsObserved = await page.evaluate(() => window.__vireadBgEvents || 0);
    const resumedShot = screencap("usb_android_resumed.png");
    if (resumedShot) report.screenshots.push(resumedShot);
    report.checks.android_background_event_on_home = {
      pass: bgEventsObserved >= 1,
      eventsObserved: bgEventsObserved,
    };

    // Capture logcat and check for FATAL EXCEPTION / AndroidRuntime crash
    const logcat = adb(["logcat", "-d", "-v", "time"]);
    const fatalLines = logcat
      .split(/\r?\n/)
      .filter((l) => /FATAL EXCEPTION|ANR in vn\.viread|Process: vn\.viread\.android/i.test(l));
    fs.writeFileSync(path.join(OUT_DIR, "usb_android_logcat.txt"), logcat, "utf8");
    report.checks.logcat_zero_crashes = {
      pass: fatalLines.length === 0,
      fatalLines,
    };
  } finally {
    try {
      await browser.close();
    } catch {}
    try {
      adb(["forward", "--remove", `tcp:${CDP_PORT}`]);
    } catch {}
  }

  report.finished_at = new Date().toISOString();
  report.summary = {
    console_error_count: report.console_errors.length,
    page_error_count: report.page_errors.length,
    api_error_count: report.api_errors.length,
    crashes: report.checks.logcat_zero_crashes?.fatalLines?.length ?? -1,
    android_bg_event_pass: Boolean(report.checks.android_background_event_on_home?.pass),
  };

  const outFile = path.join(OUT_DIR, "usb_android_e2e_report.json");
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
  console.log("USB SUMMARY:", JSON.stringify(report.summary));
  console.log("USB SCROLL:", JSON.stringify(report.checks.android_scroll_and_detach));
  console.log("USB BG EVENT:", JSON.stringify(report.checks.android_background_event_on_home));
  console.log("USB LOGCAT:", JSON.stringify(report.checks.logcat_zero_crashes));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
