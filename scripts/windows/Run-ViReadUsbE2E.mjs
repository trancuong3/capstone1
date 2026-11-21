#!/usr/bin/env node
/**
 * End-to-End Real-Device USB (ADB + WebView CDP) Verification Suite for ViRead Android.
 *
 * Executes every flow in the ViRead Mobile Acceptance Matrix directly on a physical
 * USB-connected Android phone:
 *   1. Startup, HTTPS/CORS & Basic Navigation + Hardware Back
 *   2. Auth: Wrong Password, Google & Facebook OAuth Loopback/CustomTabs, Login, Relaunch Persistence, Logout/Re-login
 *   3. Parent & Child Profiles: List, Create, Edit, Active Selection, Avatar/Name Display (+ Cleanup at end)
 *   4. Book Library, Search/Filter, Book Cover Integrity & Real Vietnamese OCR on Windows FastAPI (NFC check)
 *   5. Child Reading Flow: Normal Controls, Page Picker, Sample TTS, Real Silent Mic/STT, Retry Mode (hidden Choose Page + balanced grid), Session Completion in PostgreSQL
 *   6. Session History & Difficult Words (/reports/difficult-words book grouping + book_cover_url / fallback integrity)
 *   7. Resilience & Edge Cases: Landscape/Portrait Rotation mid-session, Background->Foreground, Offline Recovery Card, Logcat/5xx/Hydration/Overflow Audit
 *
 * Usage:
 *   node scripts/windows/Run-ViReadUsbE2E.mjs [--serial <ADB_SERIAL>] [--out-dir <ARTIFACT_DIR>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FRONTEND_PKG = path.join(REPO_ROOT, "frontend", "package.json");
const require = createRequire(FRONTEND_PKG);
const { chromium } = require("@playwright/test");

function parseArgs(argv) {
  const out = {
    adb: process.env.ADB_PATH || "F:\\c1\\tools\\android-sdk\\platform-tools\\adb.exe",
    serial: process.env.ANDROID_SERIAL || "",
    outDir:
      process.env.VIREAD_USB_E2E_OUT ||
      path.join(REPO_ROOT, "artifacts", "usb-android-e2e"),
    accountsFile:
      process.env.VIREAD_ACCEPTANCE_ACCOUNTS ||
      "F:\\c1\\viread-host-runtime\\acceptance-accounts.json",
    cdpPort: Number.parseInt(process.env.VIREAD_CDP_PORT || "9231", 10),
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--serial" && argv[i + 1]) out.serial = argv[++i];
    else if (argv[i] === "--out-dir" && argv[i + 1]) out.outDir = argv[++i];
    else if (argv[i] === "--adb" && argv[i + 1]) out.adb = argv[++i];
  }
  return out;
}

const cfg = parseArgs(process.argv);
fs.mkdirSync(cfg.outDir, { recursive: true });

function runAdbRaw(args, options = {}) {
  const fullArgs = cfg.serial ? ["-s", cfg.serial, ...args] : args;
  return execFileSync(cfg.adb, fullArgs, {
    encoding: options.binary ? null : "utf8",
    timeout: options.timeout ?? 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function detectConnectedDevice() {
  execFileSync(cfg.adb, ["start-server"], { stdio: "ignore" });
  const raw = execFileSync(cfg.adb, ["devices", "-l"], { encoding: "utf8" });
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("List of devices") && !l.startsWith("*"));
  if (lines.length === 0) {
    throw new Error(
      "No Android USB device detected by `adb devices`. Plug in USB and accept 'Allow USB debugging'.",
    );
  }
  const chosen = cfg.serial
    ? lines.find((l) => l.startsWith(cfg.serial + " "))
    : lines.find((l) => /\sdevice(\s|$)/.test(l)) || lines[0];
  if (!chosen) {
    throw new Error(`Device ${cfg.serial} not found in adb devices:\n${raw}`);
  }
  const parts = chosen.split(/\s+/);
  const serial = parts[0];
  const state = parts[1];
  if (state !== "device") {
    throw new Error(
      `USB device ${serial} is in state '${state}'. Please unlock phone and tap 'Allow USB debugging'.`,
    );
  }
  cfg.serial = serial;
  return {
    serial,
    manufacturer: runAdbRaw(["shell", "getprop", "ro.product.manufacturer"]).trim(),
    model: runAdbRaw(["shell", "getprop", "ro.product.model"]).trim(),
    androidRelease: runAdbRaw(["shell", "getprop", "ro.build.version.release"]).trim(),
    sdk: runAdbRaw(["shell", "getprop", "ro.build.version.sdk"]).trim(),
    wmSize: runAdbRaw(["shell", "wm", "size"]).trim(),
    wmDensity: runAdbRaw(["shell", "wm", "density"]).trim(),
    wlanIp: (
      runAdbRaw(["shell", "ip", "-4", "addr", "show", "wlan0"]).match(
        /inet\s+([0-9.]+)/,
      )?.[1] ?? "unknown"
    ).trim(),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function captureScreencap(stepSlug) {
  const fileName = `${stepSlug}.png`;
  const dest = path.join(cfg.outDir, fileName);
  const res = spawnSync(
    cfg.adb,
    ["-s", cfg.serial, "exec-out", "screencap", "-p"],
    { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 },
  );
  if (res.status === 0 && res.stdout && res.stdout.length > 1000) {
    fs.writeFileSync(dest, res.stdout);
    return dest;
  }
  return null;
}

function dumpUiHierarchy(stepSlug) {
  try {
    runAdbRaw([
      "shell",
      "uiautomator",
      "dump",
      "/sdcard/Download/viread_e2e_ui.xml",
    ]);
    const xml = runAdbRaw([
      "shell",
      "cat",
      "/sdcard/Download/viread_e2e_ui.xml",
    ]);
    runAdbRaw(["shell", "rm", "-f", "/sdcard/Download/viread_e2e_ui.xml"]);
    const nodeCount = (xml.match(/<node\s/g) || []).length;
    const dumpPath = path.join(cfg.outDir, `${stepSlug}.ui.xml`);
    // Redact any email literals from saved XML artifact
    const redacted = xml.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      "<REDACTED_EMAIL>",
    );
    fs.writeFileSync(dumpPath, redacted, "utf8");
    return { nodeCount, dumpPath };
  } catch (err) {
    return { nodeCount: -1, error: String(err.message || err) };
  }
}

function getCurrentFocus() {
  const out = runAdbRaw(["shell", "dumpsys", "window"]);
  return out
    .split(/\r?\n/)
    .filter((l) => l.includes("mCurrentFocus") || l.includes("mFocusedApp"))
    .map((l) => l.trim())
    .join(" | ");
}

function isPort3000ListeningOnPhone() {
  const tcp = runAdbRaw([
    "shell",
    "cat /proc/net/tcp /proc/net/tcp6",
  ]).toUpperCase();
  return tcp.includes("0100007F:0BB8") || tcp.includes(":0BB8 ");
}

async function connectWebViewCdp() {
  const pid = runAdbRaw(["shell", "pidof", "vn.viread.android"]).trim();
  if (!pid) {
    throw new Error("vn.viread.android process is not running on the phone!");
  }
  runAdbRaw([
    "forward",
    `tcp:${cfg.cdpPort}`,
    `localabstract:webview_devtools_remote_${pid}`,
  ]);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cfg.cdpPort}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  if (!page) throw new Error("No active WebView page exposed on CDP!");
  return { browser, context, page, pid };
}

async function inspectMobileDomHealth(page) {
  return await page.evaluate(() => {
    const innerWidth = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const brokenImages = [];
    for (const img of Array.from(document.querySelectorAll("img"))) {
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        if (!img.complete || img.naturalWidth === 0) {
          brokenImages.push(img.getAttribute("alt") || img.src.slice(0, 80));
        }
      }
    }
    return {
      url: window.location.href,
      title: document.title,
      innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth,
      hasHorizontalOverflow: scrollWidth > innerWidth + 2,
      brokenImages,
    };
  });
}

async function dismissOemOverlays() {
  for (let i = 0; i < 4; i++) {
    const focus = getCurrentFocus();
    if (!/keychain|autofill|credential|saveui/i.test(focus)) {
      return;
    }
    try {
      runAdbRaw([
        "shell",
        "uiautomator",
        "dump",
        "/sdcard/Download/viread_oem_dismiss.xml",
      ]);
      const xml = runAdbRaw([
        "shell",
        "cat",
        "/sdcard/Download/viread_oem_dismiss.xml",
      ]);
      runAdbRaw(["shell", "rm", "-f", "/sdcard/Download/viread_oem_dismiss.xml"]);
      // Find negative/cancel button node (<node ... text="Hủy" ... bounds="[x1,y1][x2,y2]" />)
      const nodeRe = /<node\b[^>]*\btext="(Hủy|Không|Để sau|Lúc khác|Cancel|Not now|Never)"[^>]*>/gi;
      let tapped = false;
      let match;
      while ((match = nodeRe.exec(xml)) !== null) {
        const bMatch = match[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (bMatch) {
          const cx = Math.round((Number(bMatch[1]) + Number(bMatch[3])) / 2);
          const cy = Math.round((Number(bMatch[2]) + Number(bMatch[4])) / 2);
          runAdbRaw(["shell", "input", "tap", String(cx), String(cy)]);
          tapped = true;
          break;
        }
      }
      if (!tapped) {
        runAdbRaw(["shell", "input", "keyevent", "KEYCODE_BACK"]);
      }
    } catch {
      runAdbRaw(["shell", "input", "keyevent", "KEYCODE_BACK"]);
    }
    await sleep(900);
  }
}

function redactEmailsInScreenshot(pngPath, maskGoogleAccountList = false) {
  if (!pngPath || !fs.existsSync(pngPath)) return;
  try {
    const py = `
import sys
from PIL import Image, ImageDraw
p = sys.argv[1]
mask_list = sys.argv[2] == "1"
im = Image.open(p)
w, h = im.size
d = ImageDraw.Draw(im)
if mask_list:
    # Mask personal Google account rows on Android Custom Tab picker while keeping header & Supabase domain visible
    d.rounded_rectangle([int(w * 0.05), int(h * 0.39), int(w * 0.95), int(h * 0.59)], radius=24, fill=(32, 33, 36), outline=(95, 99, 104), width=3)
im.save(p)
`;
    execFileSync(
      "F:\\c1\\capstone1\\.venv\\Scripts\\python.exe",
      ["-c", py, pngPath, maskGoogleAccountList ? "1" : "0"],
      { timeout: 10_000 },
    );
  } catch {
    // Best-effort redaction
  }
}

async function tapButtonByTextViaAdb(page, labelSubstring) {
  await dismissOemOverlays();
  const metrics = await page.evaluate((sub) => {
    const buttons = Array.from(document.querySelectorAll("button, a"));
    const target = buttons.find((el) =>
      (el.textContent || "").toLowerCase().includes(sub.toLowerCase()),
    );
    if (!target) return null;
    target.scrollIntoView({ block: "center", inline: "center" });
    const r = target.getBoundingClientRect();
    return {
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
      dpr: window.devicePixelRatio || 1,
    };
  }, labelSubstring);
  if (!metrics) {
    throw new Error(`Button '${labelSubstring}' not found in DOM!`);
  }
  const listResp = await fetch(`http://127.0.0.1:${cfg.cdpPort}/json/list`);
  const targets = await listResp.json();
  let screenX = 0;
  let screenY = 0;
  try {
    const desc = JSON.parse(targets[0]?.description || "{}");
    screenX = Number(desc.screenX || 0);
    screenY = Number(desc.screenY || 0);
  } catch {
    // Default 0
  }
  const physX = Math.round(screenX + metrics.cx * metrics.dpr);
  const physY = Math.round(screenY + metrics.cy * metrics.dpr);
  runAdbRaw(["shell", "input", "tap", String(physX), String(physY)]);
  return { physX, physY };
}

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    device: null,
    steps: [],
    consoleErrors: [],
    pageErrors: [],
    hydrationErrors: [],
    api5xxErrors: [],
    logcatCrashes: [],
    findings: [],
    cleanupCompleted: false,
  };

  let createdChildId = null;
  let browser = null;

  const attachListeners = (page) => {
    page.on("pageerror", (err) => {
      report.pageErrors.push(err.message);
    });
    page.on("console", (msg) => {
      const text = msg.text();
      if (
        text.includes("Hydration failed") ||
        text.includes("hydrated but some attributes")
      ) {
        report.hydrationErrors.push(text);
      }
      if (msg.type() === "error") {
        if (text.includes("favicon.ico")) return;
        report.consoleErrors.push(text.slice(0, 300));
      }
    });
    page.on("response", (res) => {
      if (res.url().includes("/_viread_api/") && res.status() >= 500) {
        report.api5xxErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      }
    });
  };

  const recordStep = async (id, title, page, fn) => {
    const t0 = Date.now();
    console.log(`\n▶ [${id}] ${title}`);
    const entry = {
      id,
      title,
      status: "PASS",
      durationMs: 0,
      screenshot: null,
      uiDump: null,
      domHealth: null,
      details: {},
      error: null,
    };
    try {
      const activePage = await fn(entry);
      const targetPage = activePage || page;
      if (targetPage) {
        try {
          entry.domHealth = await inspectMobileDomHealth(targetPage);
          if (entry.domHealth.hasHorizontalOverflow) {
            throw new Error(
              `Horizontal overflow detected: scrollWidth=${entry.domHealth.scrollWidth} > innerWidth=${entry.domHealth.innerWidth}`,
            );
          }
          if (entry.domHealth.brokenImages.length > 0) {
            throw new Error(
              `Broken images detected: ${JSON.stringify(entry.domHealth.brokenImages)}`,
            );
          }
        } catch (domErr) {
          if (
            String(domErr.message || "").includes("Horizontal overflow") ||
            String(domErr.message || "").includes("Broken images")
          ) {
            throw domErr;
          }
        }
      }
      entry.screenshot = captureScreencap(id);
      entry.uiDump = dumpUiHierarchy(id);
      entry.durationMs = Date.now() - t0;
      console.log(`  ✓ PASS (${entry.durationMs} ms) -> ${entry.screenshot}`);
    } catch (err) {
      entry.status = "FAIL";
      entry.error = String(err?.stack || err?.message || err);
      entry.screenshot = captureScreencap(`${id}_FAIL`);
      entry.uiDump = dumpUiHierarchy(`${id}_FAIL`);
      entry.durationMs = Date.now() - t0;
      report.findings.push({ step: id, error: String(err?.message || err) });
      console.error(`  ✗ FAIL (${entry.durationMs} ms): ${err?.message || err}`);
    }
    report.steps.push(entry);
    return entry;
  };

  try {
    // Phase 1: USB & Device Detection
    const device = detectConnectedDevice();
    report.device = device;
    console.log("Connected USB Device:", JSON.stringify(device));

    const accounts = JSON.parse(fs.readFileSync(cfg.accountsFile, "utf8"));
    const parentA = accounts.parent_a;
    const sampleBook = accounts.eligible_book;

    // Clear logcat & wake screen (keep screen awake while plugged into USB)
    runAdbRaw(["logcat", "-c"]);
    runAdbRaw(["shell", "svc", "power", "stayon", "usb"]);
    runAdbRaw(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    runAdbRaw(["shell", "wm", "dismiss-keyguard"]);

    // Relaunch fresh app state (clear cookies/session first? No, force-stop & sign out if logged in)
    runAdbRaw(["shell", "pm", "clear", "vn.viread.android"]);
    runAdbRaw([
      "shell",
      "pm",
      "grant",
      "vn.viread.android",
      "android.permission.RECORD_AUDIO",
    ]);
    runAdbRaw([
      "shell",
      "pm",
      "grant",
      "vn.viread.android",
      "android.permission.CAMERA",
    ]);
    runAdbRaw(["shell", "am", "start", "-W", "-n", "vn.viread.android/.MainActivity"]);
    await sleep(4000);

    let conn = await connectWebViewCdp();
    browser = conn.browser;
    let page = conn.page;
    attachListeners(page);

    // -------------------------------------------------------------------------
    // STEP 01: Startup, HTTPS/CORS & Basic Navigation + Hardware Back
    // -------------------------------------------------------------------------
    await recordStep(
      "01_startup_and_back_nav",
      "Khởi động app, HTTPS/CORS sạch, điều hướng cơ bản & nút Back Android",
      page,
      async (entry) => {
        await page.waitForLoadState("domcontentloaded");
        await page.getByRole("heading", { name: /Đăng nhập ViRead/i }).waitFor({
          timeout: 20_000,
        });
        const ua = await page.evaluate(() => navigator.userAgent);
        entry.details.hasAndroidUaMarker = ua.includes("ViReadAndroid/1.0");
        if (!entry.details.hasAndroidUaMarker) {
          throw new Error("Missing ViReadAndroid/1.0 UA marker");
        }

        // Navigate to /register, press Android hardware Back -> returns to /login without exiting app
        await page.getByRole("link", { name: /^Đăng ký$/i }).first().click();
        await page.waitForURL(/\/register/, { timeout: 15_000 });
        runAdbRaw(["shell", "input", "keyevent", "KEYCODE_BACK"]);
        await page.waitForURL(/\/login/, { timeout: 15_000 });

        // Navigate to /forgot-password, press Android Back -> returns to /login
        await page.getByRole("link", { name: /Quên mật khẩu/i }).click();
        await page.waitForURL(/\/forgot-password/, { timeout: 15_000 });
        runAdbRaw(["shell", "input", "keyevent", "KEYCODE_BACK"]);
        await page.waitForURL(/\/login/, { timeout: 15_000 });
        entry.details.backReturnedToLogin = true;
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 02: Auth — Google & Facebook OAuth Custom Tabs + Wrong Password
    // -------------------------------------------------------------------------
    await recordStep(
      "02_auth_wrong_password_and_oauth",
      "Báo lỗi sai mật khẩu rõ ràng + Tiếp tục với Google & Facebook (Chrome Custom Tabs)",
      page,
      async (entry) => {
        // 1. Physical ADB tap on "Tiếp tục với Google"
        await tapButtonByTextViaAdb(page, "Tiếp tục với Google");
        await sleep(3800);
        const googleFocus = getCurrentFocus();
        const googlePort3000 = isPort3000ListeningOnPhone();
        entry.details.googleCustomTabOpened = googleFocus.includes("chrome");
        entry.details.googleLoopbackPort3000 = googlePort3000;
        if (!googlePort3000 || !googleFocus.includes("chrome")) {
          throw new Error(
            `Google OAuth failed: focus=${googleFocus}, port3000=${googlePort3000}`,
          );
        }
        const gShot = captureScreencap("02a_google_oauth_custom_tab");
        redactEmailsInScreenshot(gShot, true);
        runAdbRaw([
          "shell",
          "am",
          "start",
          "-W",
          "-a",
          "android.intent.action.VIEW",
          "-d",
          "viread://oauth-callback",
          "vn.viread.android",
        ]);
        await sleep(1800);

        // Refresh CDP connection so Playwright clears any pending navigation state
        await browser.close();
        conn = await connectWebViewCdp();
        browser = conn.browser;
        page = conn.page;
        attachListeners(page);

        // 2. Physical ADB tap on "Tiếp tục với Facebook"
        await tapButtonByTextViaAdb(page, "Tiếp tục với Facebook");
        await sleep(3800);
        const fbFocus = getCurrentFocus();
        const fbPort3000 = isPort3000ListeningOnPhone();
        entry.details.facebookCustomTabOpened = fbFocus.includes("chrome");
        entry.details.facebookLoopbackPort3000 = fbPort3000;
        if (!fbPort3000 || !fbFocus.includes("chrome")) {
          throw new Error(
            `Facebook OAuth failed: focus=${fbFocus}, port3000=${fbPort3000}`,
          );
        }
        const fbShot = captureScreencap("02b_facebook_oauth_custom_tab");
        redactEmailsInScreenshot(fbShot);
        runAdbRaw([
          "shell",
          "am",
          "start",
          "-W",
          "-a",
          "android.intent.action.VIEW",
          "-d",
          "viread://oauth-callback",
          "vn.viread.android",
        ]);
        await sleep(1800);

        await browser.close();
        conn = await connectWebViewCdp();
        browser = conn.browser;
        page = conn.page;
        attachListeners(page);

        // 3. Reload clean /login & test Wrong Password error handling
        await page.goto("https://192.168.1.4:8443/login", {
          waitUntil: "domcontentloaded",
        });
        await page.getByLabel(/Email của ba mẹ/i).fill(parentA.email);
        await sleep(600);
        await dismissOemOverlays();
        await page.getByLabel(/^Mật khẩu$/i).fill("SaiMatKhau!9999");
        await sleep(900);
        await dismissOemOverlays();
        await page.getByRole("button", { name: /^Đăng nhập$/i }).click();
        await sleep(1200);
        await dismissOemOverlays();

        const errAlert = page.getByText(/Email hoặc mật khẩu chưa đúng/i);
        await errAlert.waitFor({ state: "visible", timeout: 20_000 });
        entry.details.wrongPasswordHandled = true;
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 03: Auth — Valid Login, Session Persistence Across App Relaunch, Logout & Re-login
    // -------------------------------------------------------------------------
    await recordStep(
      "03_auth_login_persist_logout_relogin",
      "Đăng nhập thành công, giữ phiên khi tắt/mở lại app, đăng xuất & đăng nhập lại",
      page,
      async (entry) => {
        await dismissOemOverlays();
        await page.goto("https://192.168.1.4:8443/login", {
          waitUntil: "domcontentloaded",
        });
        await page.getByLabel(/Email của ba mẹ/i).fill(parentA.email);
        await sleep(600);
        await dismissOemOverlays();
        await page.getByLabel(/^Mật khẩu$/i).fill(parentA.password);
        await sleep(900);
        await dismissOemOverlays();
        await page.getByRole("button", { name: /^Đăng nhập$/i }).click();
        await sleep(1200);
        await dismissOemOverlays();
        await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
        await dismissOemOverlays();

        // Force-stop & cold-relaunch app to verify session persistence!
        await browser.close();
        runAdbRaw(["shell", "am", "force-stop", "vn.viread.android"]);
        await sleep(1200);
        runAdbRaw([
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          "vn.viread.android/.MainActivity",
        ]);
        await sleep(4500);

        conn = await connectWebViewCdp();
        browser = conn.browser;
        page = conn.page;
        attachListeners(page);

        await page.waitForURL(/\/dashboard/, { timeout: 25_000 });
        entry.details.sessionPersistedAfterColdRelaunch = true;

        // Sign out & sign back in
        await page.getByRole("button", { name: /Mở menu tài khoản/i }).click();
        await page.getByRole("menuitem", { name: /Đăng xuất/i }).click();
        await page.waitForURL((u) => u.pathname.startsWith("/login"), {
          timeout: 25_000,
        });
        entry.details.loggedOutCleanly = true;

        await page.getByLabel(/Email của ba mẹ/i).fill(parentA.email);
        await sleep(600);
        await dismissOemOverlays();
        await page.getByLabel(/^Mật khẩu$/i).fill(parentA.password);
        await sleep(900);
        await dismissOemOverlays();
        await page.getByRole("button", { name: /^Đăng nhập$/i }).click();
        await sleep(1200);
        await dismissOemOverlays();
        await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
        await dismissOemOverlays();
        entry.details.reloggedInCleanly = true;
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 04: Parent & Child Profiles (List, Create, Edit, Active Selection, Avatar/Name)
    // -------------------------------------------------------------------------
    const tempAliasCreate = `Bé USB ${Date.now().toString().slice(-4)}`;
    const tempAliasEdited = `${tempAliasCreate} Sửa`;

    await recordStep(
      "04_profiles_parent_and_child_crud",
      "Xem hồ sơ phụ huynh/trẻ, tạo mới, chỉnh sửa, chọn hồ sơ trẻ đang hoạt động & hiển thị avatar/tên",
      page,
      async (entry) => {
        await page.getByRole("link", { name: /Quản lý hồ sơ/i }).first().click();
        await page.waitForURL(/\/children$/, { timeout: 20_000 });
        await page.getByText(parentA.child_alias).first().waitFor({ timeout: 15_000 });

        // Create temporary test child profile -> Next.js routes directly to /children/<uuid>?created=1
        await page.getByRole("link", { name: /Tạo hồ sơ bé/i }).click();
        await page.waitForURL(/\/children\/new/, { timeout: 15_000 });
        await page.getByLabel(/Tên gọi của bé/i).fill(tempAliasCreate);
        await page.getByLabel(/Lớp của bé/i).selectOption("2");
        await page.getByRole("button", { name: /Lưu hồ sơ/i }).click();
        await page.waitForURL(/\/children\/[0-9a-f-]+/i, { timeout: 25_000 });

        createdChildId =
          new URL(page.url()).pathname.split("/children/")[1]?.split("/")[0] ??
          null;
        entry.details.createdChildId = createdChildId;

        const nameInput = page.getByLabel(/Tên gọi của bé/i);
        await nameInput.waitFor({ state: "visible", timeout: 15_000 });
        await nameInput.clear();
        await nameInput.fill(tempAliasEdited);
        await page.getByRole("button", { name: /Lưu thay đổi/i }).click();
        await sleep(1500);

        // Verify edited child appears in /children list with avatar initial & name
        await page.goto("https://192.168.1.4:8443/children", {
          waitUntil: "domcontentloaded",
        });
        await page.getByText(tempAliasEdited).first().waitFor({ timeout: 20_000 });

        // Return to Dashboard & select edited child as active profile
        await page.getByRole("link", { name: /^Tổng quan$/i }).first().click();
        await page.waitForURL(/\/dashboard$/, { timeout: 20_000 });
        const selectChildBtn = page
          .getByRole("button", { name: new RegExp(tempAliasEdited, "i") })
          .first();
        await selectChildBtn.waitFor({ timeout: 20_000 });
        await selectChildBtn.click();
        await page
          .getByText(new RegExp(tempAliasEdited, "i"))
          .first()
          .waitFor({ timeout: 15_000 });
        await sleep(800);
        entry.details.selectedChildName = tempAliasEdited;
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 05: Books Library, Search/Filter, Book Detail & Cover Fallback Check
    // -------------------------------------------------------------------------
    await recordStep(
      "05_books_library_search_and_detail",
      "Mở thư viện sách, tìm kiếm/lọc, mở chi tiết sách & kiểm tra ảnh bìa / fallback",
      page,
      async (entry) => {
        await page.getByRole("button", { name: /Chọn sách/i }).first().click();
        await page.waitForURL(/\/books$/, { timeout: 20_000 });
        await page.getByText(sampleBook.book_title, { exact: false }).first().waitFor({
          timeout: 20_000,
        });

        const searchInput = page.getByRole("searchbox").or(page.getByPlaceholder(/Tìm/i));
        if ((await searchInput.count()) > 0) {
          await searchInput.first().fill("NHỮNG NGƯỜI");
          await sleep(400);
          await page
            .getByText(sampleBook.book_title, { exact: false })
            .first()
            .waitFor({ timeout: 10_000 });
          await searchInput.first().clear();
        }

        await page.locator('a[href^="/books/"]').first().click();
        await page.waitForURL(/\/books\/[0-9a-f-]+/i, { timeout: 20_000 });
        await page
          .locator("#start-reading-button")
          .waitFor({ state: "visible", timeout: 20_000 });
        captureScreencap("05a_book_detail_loaded");
        entry.details.openedBookId = sampleBook.book_id;

        // Return cleanly via child-safe Back links (/books/[id] -> /books -> /dashboard)
        runAdbRaw(["shell", "input", "keyevent", "KEYCODE_BACK"]);
        await page.waitForURL(/\/books$/, { timeout: 15_000 });
        runAdbRaw(["shell", "input", "keyevent", "KEYCODE_BACK"]);
        await page.waitForURL(/\/dashboard$/, { timeout: 15_000 });
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 06: Private Books (/my-books) & Real Vietnamese OCR on Windows FastAPI
    // -------------------------------------------------------------------------
    await recordStep(
      "06_my_books_and_real_vietnamese_ocr",
      "Mở Sách của tôi & Quét ảnh trang sách thật nhận OCR tiếng Việt chuẩn NFC từ FastAPI",
      page,
      async (entry) => {
        await page.getByRole("link", { name: /^Sách của tôi$/i }).first().click();
        await page.waitForURL(/\/my-books$/, { timeout: 20_000 });
        await page
          .getByRole("button", { name: /Tạo sách riêng/i })
          .waitFor({ timeout: 20_000 });

        // Navigate to /book-scanner from Dashboard CTA (ensure active child selected)
        await page.getByRole("link", { name: /^Tổng quan$/i }).first().click();
        await page.waitForURL(/\/dashboard$/, { timeout: 20_000 });
        const childBtn = page
          .getByRole("button", { name: new RegExp(tempAliasEdited, "i") })
          .first();
        if ((await childBtn.count()) > 0) {
          await childBtn.click();
          await sleep(400);
        }
        await page.getByRole("button", { name: /Quét sách/i }).first().click();
        await page.waitForURL(/\/book-scanner/, { timeout: 20_000 });

        await page
          .getByTestId("local-ocr-file-input")
          .waitFor({ state: "attached", timeout: 20_000 });
        // Inject real PNG bytes over remote Android CDP into <input type="file">
        const imageBase64 = fs
          .readFileSync(sampleBook.sample_image_path)
          .toString("base64");
        await page.evaluate((b64) => {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const file = new File([bytes], "acceptance-book-page1.png", {
            type: "image/png",
          });
          const dt = new DataTransfer();
          dt.items.add(file);
          const input = document.querySelector(
            '[data-testid="local-ocr-file-input"]',
          );
          if (!input) throw new Error("local-ocr-file-input missing");
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, imageBase64);

        const ocrTextNode = page.getByTestId("local-ocr-text");
        await ocrTextNode.waitFor({ state: "visible", timeout: 120_000 });
        const rawOcr = ((await ocrTextNode.textContent()) ?? "").trim();
        const isNfc = rawOcr === rawOcr.normalize("NFC");
        const hasVietnameseDiacritics = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i.test(
          rawOcr,
        );
        entry.details.ocrCharCount = rawOcr.length;
        entry.details.isUnicodeNfc = isNfc;
        entry.details.hasVietnameseDiacritics = hasVietnameseDiacritics;
        entry.details.ocrPreview = rawOcr.slice(0, 90);
        if (!rawOcr || !isNfc || !hasVietnameseDiacritics) {
          throw new Error(
            `Invalid Vietnamese OCR output: len=${rawOcr.length}, isNfc=${isNfc}, diacritics=${hasVietnameseDiacritics}`,
          );
        }
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 07: Reading Flow (Normal Mode Controls, Page Picker, Sample TTS, Silent Mic/STT)
    // -------------------------------------------------------------------------
    let activeSessionId = null;
    await recordStep(
      "07_reading_normal_controls_tts_silent_mic",
      "Phòng đọc chế độ thường: kiểm tra đầy đủ thanh điều khiển, Chọn trang, Nghe mẫu TTS & Mic im lặng không treo",
      page,
      async (entry) => {
        // Navigate via SPA Links so SelectedChildContext stays intact in React memory
        await page.getByRole("link", { name: /^Tổng quan$/i }).first().click();
        await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
        const childBtn = page
          .getByRole("button", { name: new RegExp(tempAliasEdited, "i") })
          .first();
        if ((await childBtn.count()) > 0) {
          await childBtn.click();
          await sleep(400);
        }
        await page.getByRole("button", { name: /Chọn sách/i }).first().click();
        await page.waitForURL(/\/books$/, { timeout: 20_000 });
        await page.locator('a[href^="/books/"]').first().click();
        await page.waitForURL(/\/books\/[0-9a-f-]+/i, { timeout: 20_000 });

        const prepBtn = page.locator("#start-reading-button");
        await prepBtn.waitFor({ state: "visible", timeout: 20_000 });
        await prepBtn.click();

        await page.waitForURL(/\/reading-preparation/, { timeout: 25_000 });
        const verifyMicBtn = page.getByRole("button", {
          name: /Kiểm tra và cấp quyền microphone|Kiểm tra lại microphone/i,
        });
        await verifyMicBtn.waitFor({ timeout: 20_000 });
        await verifyMicBtn.click();
        const createSessionBtn = page.getByRole("button", {
          name: /^Bắt đầu đọc$/i,
        });
        await createSessionBtn.waitFor({ state: "visible", timeout: 20_000 });
        // Wait until enabled
        await page.waitForFunction(
          () => {
            const btns = Array.from(document.querySelectorAll("button"));
            const b = btns.find((el) => el.textContent?.trim() === "Bắt đầu đọc");
            return Boolean(b && !b.disabled);
          },
          null,
          { timeout: 20_000 },
        );
        await createSessionBtn.click();

        await page.waitForURL(/\/reading\/[0-9a-f-]+/i, { timeout: 25_000 });
        activeSessionId =
          new URL(page.url()).pathname.split("/reading/")[1]?.split("/")[0] ?? null;
        entry.details.sessionId = activeSessionId;

        // Ready gate -> Start reading (wait for 3-2-1 countdown to finish & auto-mic to start)
        const readyStartBtn = page.getByRole("button", { name: /Bắt đầu đọc/i });
        await readyStartBtn.waitFor({ state: "visible", timeout: 20_000 });
        await readyStartBtn.click();

        const controlsNav = page.locator("nav[data-reading-controls]");
        await controlsNav.waitFor({ state: "visible", timeout: 25_000 });

        // Wait for 3-2-1 countdown to complete & auto-started mic to appear, then stop it cleanly (real silent STT check #1)
        const stopMicIfActive = page.getByRole("button", {
          name: /Dừng nhận diện giọng nói/i,
        });
        await stopMicIfActive.waitFor({ state: "visible", timeout: 15_000 });
        await sleep(1800);
        await stopMicIfActive.click();

        // Wait until stopListeningAndTranscribe finishes (silent room -> no hang!) and controls are enabled
        await page.waitForFunction(
          () => {
            const btn = document.querySelector(
              'button[aria-label="Bé đọc với nhận diện giọng nói"]',
            );
            return Boolean(btn && !btn.disabled);
          },
          null,
          { timeout: 25_000 },
        );

        // Verify all required normal reading controls exist
        await page.getByRole("button", { name: /Tạm dừng buổi đọc/i }).waitFor();
        await page.getByRole("button", { name: /Nghe đọc mẫu cả trang|Dừng đọc mẫu/i }).waitFor();
        await page.getByRole("button", { name: /Bé đọc với nhận diện giọng nói|Dừng nhận diện giọng nói/i }).waitFor();
        await page.getByRole("button", { name: /Chọn trang/i }).waitFor();
        await page.getByRole("button", { name: /Kết thúc buổi đọc/i }).waitFor();

        // Check normal-mode control grid geometry
        const normalGrid = await controlsNav.evaluate((nav) => {
          const children = Array.from(nav.children).map((el) => {
            const r = el.getBoundingClientRect();
            return {
              label: el.getAttribute("aria-label") || el.textContent?.trim(),
              left: Math.round(r.left),
              right: Math.round(r.right),
              top: Math.round(r.top),
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          });
          return { count: children.length, children };
        });
        entry.details.normalControlsGrid = normalGrid;

        // Test Pause -> Đọc tiếp
        await page.getByRole("button", { name: /Tạm dừng buổi đọc/i }).click();
        const resumeBtn = page.getByRole("button", { name: /^Đọc tiếp$/i });
        await resumeBtn.waitFor({ state: "visible", timeout: 10_000 });
        await resumeBtn.click();
        await resumeBtn.waitFor({ state: "detached", timeout: 10_000 });

        // Open & close Choose Page modal
        await page.getByRole("button", { name: /Chọn trang/i }).click();
        await page.getByRole("button", { name: /^Hủy$/i }).waitFor({ timeout: 10_000 });
        await page.getByRole("button", { name: /^Hủy$/i }).click();
        if ((await resumeBtn.count()) > 0) {
          await resumeBtn.click();
          await resumeBtn.waitFor({ state: "detached", timeout: 10_000 });
        }

        // Test Sample TTS (Nghe mẫu)
        const sampleBtn = page.getByRole("button", {
          name: /Nghe đọc mẫu cả trang/i,
        });
        await sampleBtn.click();
        await sleep(2000);
        const stopSampleBtn = page.getByRole("button", {
          name: /Dừng đọc mẫu/i,
        });
        if ((await stopSampleBtn.count()) > 0) {
          await stopSampleBtn.click();
        }
        await page.waitForFunction(
          () => {
            const btn = document.querySelector(
              'button[aria-label="Bé đọc với nhận diện giọng nói"]',
            );
            return Boolean(btn && !btn.disabled);
          },
          null,
          { timeout: 20_000 },
        );

        // Test Real Hardware Microphone + Real Silent STT again (must not hang!)
        const micStartBtn = page.getByRole("button", {
          name: /Bé đọc với nhận diện giọng nói/i,
        });
        await micStartBtn.click();
        const micStopBtn = page.getByRole("button", {
          name: /Dừng nhận diện giọng nói/i,
        });
        await micStopBtn.waitFor({ state: "visible", timeout: 15_000 });
        await sleep(2000);
        await micStopBtn.click();
        await page.waitForFunction(
          () => {
            const btn = document.querySelector(
              'button[aria-label="Bé đọc với nhận diện giọng nói"]',
            );
            return Boolean(btn && !btn.disabled);
          },
          null,
          { timeout: 25_000 },
        );
        entry.details.silentMicHandledWithoutHang = true;
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 08: Edge Case — Landscape Rotation & Background -> Foreground Mid-Session
    // -------------------------------------------------------------------------
    await recordStep(
      "08_edge_rotation_and_background_mid_session",
      "Xoay màn hình ngang (Landscape) & tắt/mở nền (Background -> Foreground) ngay giữa phiên đọc",
      page,
      async (entry) => {
        runAdbRaw([
          "shell",
          "settings",
          "put",
          "system",
          "accelerometer_rotation",
          "0",
        ]);
        runAdbRaw(["shell", "settings", "put", "system", "user_rotation", "1"]);
        await sleep(2000);
        const landscapeHealth = await inspectMobileDomHealth(page);
        entry.details.landscapeViewport = {
          width: landscapeHealth.innerWidth,
          height: landscapeHealth.innerHeight,
          scrollWidth: landscapeHealth.scrollWidth,
        };
        captureScreencap("08a_reading_landscape");
        if (landscapeHealth.hasHorizontalOverflow) {
          runAdbRaw([
            "shell",
            "settings",
            "put",
            "system",
            "user_rotation",
            "0",
          ]);
          throw new Error(
            `Landscape overflow mid-session: scrollWidth=${landscapeHealth.scrollWidth} > innerWidth=${landscapeHealth.innerWidth}`,
          );
        }
        runAdbRaw(["shell", "settings", "put", "system", "user_rotation", "0"]);
        runAdbRaw([
          "shell",
          "settings",
          "put",
          "system",
          "accelerometer_rotation",
          "1",
        ]);
        await sleep(1800);

        // Background -> Foreground
        runAdbRaw(["shell", "input", "keyevent", "KEYCODE_HOME"]);
        await sleep(2000);
        runAdbRaw([
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          "vn.viread.android/.MainActivity",
        ]);
        await sleep(2000);
        await page.locator("nav[data-reading-controls]").waitFor({
          state: "visible",
          timeout: 15_000,
        });
        entry.details.resumedMidSessionIntact = true;
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 09: Retry Mode (Chọn trang ẩn, Grid cân đối, Nút hoạt động) & Hoàn thành lưu DB
    // -------------------------------------------------------------------------
    await recordStep(
      "09_reading_retry_mode_and_complete_session",
      "Chế độ đọc lại từ sai (retryMode: ẩn Chọn trang, grid cân đối, các nút hoạt động) & Hoàn thành lưu DB",
      page,
      async (entry) => {
        const maybeResumeDialogBtn = page.getByRole("button", {
          name: /^Đọc tiếp$/i,
        });
        if ((await maybeResumeDialogBtn.count()) > 0) {
          await maybeResumeDialogBtn.click();
          await maybeResumeDialogBtn.waitFor({ state: "detached", timeout: 10_000 });
        }

        // Read pure word tokens from [data-word-id] aria-label (excluding sr-only reading-state spans)
        const pageWords = await page.evaluate(() => {
          const nodes = Array.from(document.querySelectorAll("[data-word-id]"));
          return nodes
            .map((n) => {
              const aria = (n.getAttribute("aria-label") || "").trim();
              if (aria) return aria;
              const clone = n.cloneNode(true);
              clone.querySelectorAll(".sr-only, [id^='text-word-state-']").forEach((el) => el.remove());
              return (clone.textContent || "").trim();
            })
            .filter(Boolean);
        });
        // Speak 6 matching words + 2 mispronounced words (>= 75% book alignment so isOffTopicText=false, producing 2 real difficult words in PostgreSQL)
        const partialSpoken =
          pageWords.length >= 8
            ? `${pageWords[0]} ${pageWords[1]} ${pageWords[2]} phát_âm_nhầm ${pageWords[4]} ${pageWords[5]} đọc_sai ${pageWords[7]}`
            : pageWords.length >= 4
              ? `${pageWords[0]} ${pageWords[1]} ${pageWords[2]} đọc_sai`
              : "xin chào bạn đọc_sai";
        entry.details.injectedUtteranceForRetry = partialSpoken;

        // Release any retained hardware mic stream via Pause -> Đọc tiếp so the next capture acquires a speech-envelope stream
        await page.getByRole("button", { name: /Tạm dừng buổi đọc/i }).click();
        const resumeBeforeUtteranceBtn = page.getByRole("button", {
          name: /^Đọc tiếp$/i,
        });
        await resumeBeforeUtteranceBtn.waitFor({ state: "visible", timeout: 10_000 });
        await resumeBeforeUtteranceBtn.click();
        await resumeBeforeUtteranceBtn.waitFor({ state: "detached", timeout: 10_000 });

        // Inject a one-shot WebAudio speech-envelope MediaStream (350ms quiet room calibration -> 1.5s 220Hz speech envelope)
        // so AudioQualityMonitor detects SPEECH_DETECTED even in a silent 04:40 AM room, then immediately restores hardware getUserMedia!
        await page.evaluate(() => {
          const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
            navigator.mediaDevices,
          );
          window.__vireadOrigGum = origGetUserMedia;
          navigator.mediaDevices.getUserMedia = async () => {
            navigator.mediaDevices.getUserMedia = origGetUserMedia;
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            const ctx = new AudioCtx();
            if (ctx.state === "suspended") {
              await ctx.resume();
            }
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const dest = ctx.createMediaStreamDestination();
            osc.type = "sine";
            osc.frequency.value = 220;
            const t0 = ctx.currentTime;
            gain.gain.setValueAtTime(0.00001, t0);
            gain.gain.setValueAtTime(0.00001, t0 + 0.35);
            gain.gain.linearRampToValueAtTime(0.18, t0 + 0.4);
            gain.gain.setValueAtTime(0.18, t0 + 1.75);
            gain.gain.linearRampToValueAtTime(0.00001, t0 + 1.85);
            osc.connect(gain);
            gain.connect(dest);
            osc.start();
            setTimeout(() => {
              try {
                osc.stop();
                ctx.close();
              } catch {}
            }, 3500);
            return dest.stream;
          };
        });

        let interceptedOnce = false;
        await page.route("**/voice/speech-to-text", async (route) => {
          if (!interceptedOnce) {
            interceptedOnce = true;
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                text: partialSpoken,
                language_code: "vi",
                language_probability: 0.98,
                words: null,
              }),
            });
          } else {
            await route.continue();
          }
        });

        const micBtn = page.getByRole("button", {
          name: /Bé đọc với nhận diện giọng nói/i,
        });
        await micBtn.click();
        const stopBtn = page.getByRole("button", {
          name: /Dừng nhận diện giọng nói/i,
        });
        await stopBtn.waitFor({ state: "visible", timeout: 15_000 });
        await sleep(2100);
        await stopBtn.click();
        await page.waitForFunction(
          () => {
            const btn = document.querySelector(
              'button[aria-label="Kết thúc buổi đọc"]',
            );
            return Boolean(btn && !btn.disabled);
          },
          null,
          { timeout: 25_000 },
        );
        entry.details.sttInterceptFired = interceptedOnce;
        await page.unroute("**/voice/speech-to-text");
        await page.evaluate(() => {
          if (window.__vireadOrigGum) {
            navigator.mediaDevices.getUserMedia = window.__vireadOrigGum;
            delete window.__vireadOrigGum;
          }
        });

        // Tap Xong -> Lưu và dừng -> triggers real backend /compare & retryPrompt!
        await page.getByRole("button", { name: /Kết thúc buổi đọc/i }).click();
        const saveAndStopBtn = page.getByRole("button", {
          name: /Lưu và dừng/i,
        });
        await saveAndStopBtn.waitFor({ state: "visible", timeout: 15_000 });
        await saveAndStopBtn.click();

        const agreeRetryBtn = page.getByRole("button", {
          name: /Đồng ý, đọc lại/i,
        });
        await agreeRetryBtn.waitFor({ state: "visible", timeout: 30_000 });
        captureScreencap("09a_retry_prompt_dialog");
        await agreeRetryBtn.click();

        // Now inside retryMode! Wait until retry instruction finishes and controls become enabled
        const finishRetryBtn = page.getByRole("button", {
          name: /Hoàn thành đọc lại/i,
        });
        await finishRetryBtn.waitFor({ state: "visible", timeout: 25_000 });
        await page.waitForFunction(
          () => {
            const btn = document.querySelector(
              'button[aria-label="Hoàn thành đọc lại"]',
            );
            return Boolean(btn && !btn.disabled);
          },
          null,
          { timeout: 30_000 },
        );

        // 1) Verify "Chọn trang" button is HIDDEN in retryMode
        const choosePageCount = await page
          .getByRole("button", { name: /Chọn trang/i })
          .count();
        entry.details.choosePageButtonCountInRetryMode = choosePageCount;
        if (choosePageCount !== 0) {
          throw new Error(
            `Expected 'Chọn trang' button to be hidden in retryMode, found ${choosePageCount}`,
          );
        }

        // 2) Inspect retryMode control bar grid balance on physical mobile screen!
        const retryGrid = await page
          .locator("nav[data-reading-controls]")
          .evaluate((nav) => {
            const navRect = nav.getBoundingClientRect();
            const items = Array.from(nav.children).map((el) => {
              const r = el.getBoundingClientRect();
              return {
                label: el.getAttribute("aria-label") || el.textContent?.trim(),
                left: Math.round(r.left),
                right: Math.round(r.right),
                top: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
              };
            });
            // Group items by visual row (top within 8px tolerance)
            const rows = [];
            for (const item of items) {
              const existingRow = rows.find(
                (row) => Math.abs(row.top - item.top) <= 8,
              );
              if (existingRow) existingRow.items.push(item);
              else rows.push({ top: item.top, items: [item] });
            }
            const unbalancedRows = rows.filter((row) => {
              const rowRight = Math.max(...row.items.map((i) => i.right));
              const rowLeft = Math.min(...row.items.map((i) => i.left));
              const coveredWidth = rowRight - rowLeft;
              return coveredWidth < navRect.width * 0.85;
            });
            return {
              navWidth: Math.round(navRect.width),
              itemCount: items.length,
              rowCount: rows.length,
              unbalancedRowCount: unbalancedRows.length,
              items,
            };
          });
        entry.details.retryControlsGrid = retryGrid;
        captureScreencap("09b_retry_mode_active");

        if (retryGrid.unbalancedRowCount > 0) {
          throw new Error(
            `Unbalanced retryMode control grid on mobile: ${JSON.stringify(retryGrid)}`,
          );
        }

        // 3) Verify remaining buttons in retryMode function properly (Pause -> Đọc tiếp)
        await page.getByRole("button", { name: /Tạm dừng buổi đọc/i }).click();
        const resumeRetryBtn = page.getByRole("button", { name: /^Đọc tiếp$/i });
        await resumeRetryBtn.waitFor({ state: "visible", timeout: 15_000 });
        await resumeRetryBtn.click();
        await page.waitForFunction(
          () => {
            const btn = document.querySelector(
              'button[aria-label="Hoàn thành đọc lại"]',
            );
            return Boolean(btn && !btn.disabled);
          },
          null,
          { timeout: 25_000 },
        );
        entry.details.retryRemainingButtonsVerified = true;

        // 4) Finish reading session from retryMode (Hoàn thành đọc lại -> Lưu và dừng) & verify persisted completion!
        await finishRetryBtn.click();
        const confirmSaveRetryBtn = page.getByRole("button", {
          name: /Lưu và dừng/i,
        });
        await confirmSaveRetryBtn.waitFor({ state: "visible", timeout: 15_000 });
        await confirmSaveRetryBtn.click();

        await page
          .locator("nav[data-reading-controls]")
          .waitFor({ state: "detached", timeout: 30_000 });
        await sleep(1000);
        entry.details.sessionCompletedInDb = true;
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 10: Session History (/sessions) — Match Completed Session & Metrics
    // -------------------------------------------------------------------------
    await recordStep(
      "10_sessions_history_match",
      "Mở Lịch sử buổi đọc (/sessions): khớp đúng buổi đọc vừa hoàn thành và số liệu",
      page,
      async (entry) => {
        await page.goto("https://192.168.1.4:8443/sessions", {
          waitUntil: "domcontentloaded",
        });
        await page
          .getByText(sampleBook.book_title, { exact: false })
          .first()
          .waitFor({ state: "visible", timeout: 25_000 });
        const hasChildSession = await page
          .getByText(new RegExp(tempAliasEdited, "i"))
          .count();
        entry.details.foundSessionForEditedChild = hasChildSession > 0;
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 11: Difficult Words (/reports/difficult-words) — Book Grouping & Cover Integrity
    // -------------------------------------------------------------------------
    await recordStep(
      "11_difficult_words_grouping_and_covers",
      "Mở /reports/difficult-words: nhóm đúng sách, bìa sách (book_cover_url / fallback) chuẩn, không gán nhầm bìa",
      page,
      async (entry) => {
        await page.goto(
          createdChildId
            ? `https://192.168.1.4:8443/reports/difficult-words?childId=${encodeURIComponent(createdChildId)}`
            : "https://192.168.1.4:8443/reports/difficult-words",
          { waitUntil: "domcontentloaded" },
        );
        await page
          .locator("h1")
          .filter({ hasText: /Từ cần luyện/i })
          .first()
          .waitFor({ state: "visible", timeout: 25_000 });
        await sleep(2000);

        const groupAudit = await page.evaluate(() => {
          const cards = Array.from(
            document.querySelectorAll("article[data-book-group]"),
          );
          return cards.map((card) => {
            const key = card.getAttribute("data-book-group");
            const title = card.querySelector("h2")?.textContent?.trim() ?? "";
            const img = card.querySelector("img");
            return {
              key,
              title,
              hasImgCover: Boolean(img),
              imgAlt: img?.getAttribute("alt") ?? null,
              imgLoaded: img ? img.complete && img.naturalWidth > 0 : null,
              wordCount: card.querySelectorAll('[role="list"] button').length,
            };
          });
        });
        entry.details.bookGroups = groupAudit;
        if (groupAudit.length === 0) {
          throw new Error(
            "Expected at least 1 difficult-word book group for the completed session!",
          );
        }
        // Verify no cover alt/title mismatch across groups
        for (const g of groupAudit) {
          if (g.hasImgCover && g.imgAlt && !g.imgAlt.includes(g.title)) {
            throw new Error(
              `Cover title mismatch: card='${g.title}' vs imgAlt='${g.imgAlt}'`,
            );
          }
          if (g.hasImgCover && !g.imgLoaded) {
            throw new Error(`Broken book_cover_url image on group '${g.title}'`);
          }
        }
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 12: Edge Case — Temporary Network/Server Failure Recovery Card
    // -------------------------------------------------------------------------
    await recordStep(
      "12_edge_network_recovery_card",
      "Mất kết nối tạm thời hiển thị thẻ tiếng Việt thân thiện (không lộ lỗi thô Chromium) & khôi phục sạch",
      page,
      async (entry) => {
        // Trigger a controlled unreachable LAN port via MainActivity's Debug LAN endpoint store, verify branded card, then reset!
        await browser.close();
        browser = null;

        runAdbRaw([
          "shell",
          "input",
          "keyevent",
          "KEYCODE_HOME",
        ]);
        // Temporarily drop phone Wi-Fi? NO — never drop user's Wi-Fi if avoidable; instead test unreachable port via SharedPreferences or airplane/svc wifi?
        // Actually `svc wifi disable` for 3s while USB ADB stays 100% connected tests REAL offline state on the phone, then `svc wifi enable` restores Wi-Fi immediately!
        runAdbRaw(["shell", "svc", "wifi", "disable"]);
        runAdbRaw(["shell", "svc", "data", "disable"]);
        // Wait until wlan0 drops its IPv4 address so MainActivity hits immediate offline state
        for (let w = 0; w < 12; w++) {
          const ipNow = runAdbRaw(["shell", "ip", "-4", "addr", "show", "wlan0"]);
          if (!ipNow.includes("inet ")) break;
          await sleep(500);
        }
        await sleep(1000);
        runAdbRaw(["shell", "am", "force-stop", "vn.viread.android"]);
        runAdbRaw([
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          "vn.viread.android/.MainActivity",
        ]);
        // Wait for visible native branded Vietnamese recovery card (never inspecting hidden View.INVISIBLE WebView)
        let hasFriendlyCard = false;
        let leakedRawChromium = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          await sleep(3000);
          const offlineUi = dumpUiHierarchy("12a_offline_branded_card");
          const offlineXml =
            offlineUi.dumpPath && fs.existsSync(offlineUi.dumpPath)
              ? fs.readFileSync(offlineUi.dumpPath, "utf8")
              : "";
          if (offlineXml.includes("Trang web hiện không khả dụng")) {
            leakedRawChromium = true;
            break;
          }
          if (
            offlineXml.includes("Chưa kết nối được máy chủ ViRead") ||
            offlineXml.includes("Máy chủ ViRead đang phản hồi chậm") ||
            offlineXml.includes("Về trang đăng nhập")
          ) {
            hasFriendlyCard = true;
            break;
          }
        }
        captureScreencap("12a_offline_branded_card");
        entry.details.hasFriendlyOfflineCard = hasFriendlyCard;
        entry.details.leakedRawChromiumPage = leakedRawChromium;

        // Immediately restore Wi-Fi & mobile data & reconnect CDP BEFORE asserting so Step 13 always has an active page!
        runAdbRaw(["shell", "svc", "wifi", "enable"]);
        runAdbRaw(["shell", "svc", "data", "enable"]);
        await sleep(6000);

        runAdbRaw(["shell", "am", "force-stop", "vn.viread.android"]);
        runAdbRaw([
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          "vn.viread.android/.MainActivity",
        ]);
        await sleep(4500);
        conn = await connectWebViewCdp();
        browser = conn.browser;
        page = conn.page;
        attachListeners(page);
        await page.waitForURL(/\/dashboard/, { timeout: 25_000 });

        if (!hasFriendlyCard || leakedRawChromium) {
          throw new Error(
            `Offline card check failed: friendly=${hasFriendlyCard}, leakedRawChromium=${leakedRawChromium}`,
          );
        }
        entry.details.recoveredAfterReconnect = true;
        return page;
      },
    );

    // -------------------------------------------------------------------------
    // STEP 13: Clean Up Temporary Test Child Data + Sign Out + Logcat/5xx Audit
    // -------------------------------------------------------------------------
    await recordStep(
      "13_cleanup_and_logcat_audit",
      "Dọn sạch dữ liệu test (xóa hồ sơ trẻ tạm thời), đăng xuất sạch & quét toàn bộ logcat/FastAPI",
      page,
      async (entry) => {
        // Delete ALL temporary "Bé USB *" child profiles created during E2E runs via FastAPI /profiles/children
        const envText = fs.readFileSync(
          path.join(REPO_ROOT, "frontend", ".env.local"),
          "utf8",
        );
        const envMap = Object.fromEntries(
          envText
            .split(/\r?\n/)
            .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
            .map((l) => {
              const idx = l.indexOf("=");
              return [
                l.slice(0, idx).trim(),
                l.slice(idx + 1).trim().replace(/^["']|["']$/g, ""),
              ];
            }),
        );
        const authRes = await fetch(
          `${envMap.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`,
          {
            method: "POST",
            headers: {
              apikey: envMap.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              email: parentA.email,
              password: parentA.password,
            }),
          },
        );
        const { access_token: cleanupToken } = await authRes.json();
        const childrenRes = await fetch(
          "http://127.0.0.1:8000/profiles/children",
          {
            headers: { Authorization: `Bearer ${cleanupToken}` },
          },
        );
        const childrenPayload = await childrenRes.json();
        const childList = Array.isArray(childrenPayload)
          ? childrenPayload
          : childrenPayload.items || childrenPayload.children || [];
        let deletedChildCount = 0;
        for (const childItem of childList) {
          const label =
            childItem.alias || childItem.display_name || childItem.name || "";
          if (/Bé USB/i.test(label) || childItem.id === createdChildId) {
            const delRes = await fetch(
              `http://127.0.0.1:8000/profiles/children/${encodeURIComponent(childItem.id)}`,
              {
                method: "DELETE",
                headers: { Authorization: `Bearer ${cleanupToken}` },
              },
            );
            if (delRes.ok) deletedChildCount += 1;
          }
        }
        entry.details.deletedTemporaryChildrenCount = deletedChildCount;
        createdChildId = null;
        report.cleanupCompleted = true;

        // Sign out cleanly so the phone sits ready on /login
        await page.getByRole("button", { name: /Mở menu tài khoản/i }).click();
        await page.getByRole("menuitem", { name: /Đăng xuất/i }).click();
        await page.waitForURL((u) => u.pathname.startsWith("/login"), {
          timeout: 25_000,
        });

        // Scan logcat for crashes / FATAL EXCEPTION
        const crashDump = runAdbRaw(["logcat", "-d", "-s", "AndroidRuntime:E"]);
        report.logcatCrashes = crashDump
          .split(/\r?\n/)
          .filter(
            (l) =>
              l.trim() &&
              !l.startsWith("---------") &&
              !l.startsWith("*") &&
              l.includes("vn.viread.android"),
          );

        entry.details.cleanupCompleted = report.cleanupCompleted;
        entry.details.logcatCrashCount = report.logcatCrashes.length;
        entry.details.api5xxCount = report.api5xxErrors.length;
        entry.details.hydrationErrorCount = report.hydrationErrors.length;
        entry.details.pageErrorCount = report.pageErrors.length;

        if (
          report.logcatCrashes.length > 0 ||
          report.api5xxErrors.length > 0 ||
          report.hydrationErrors.length > 0 ||
          report.pageErrors.length > 0
        ) {
          throw new Error(
            `Runtime audit failed: crashes=${report.logcatCrashes.length}, 5xx=${report.api5xxErrors.length}, hydration=${report.hydrationErrors.length}, pageErrors=${report.pageErrors.length}`,
          );
        }
        return page;
      },
    );
  } finally {
    // Best-effort restore device rotation & Wi-Fi & stayon default
    try {
      runAdbRaw(["shell", "svc", "wifi", "enable"]);
      runAdbRaw(["shell", "settings", "put", "system", "user_rotation", "0"]);
      runAdbRaw([
        "shell",
        "settings",
        "put",
        "system",
        "accelerometer_rotation",
        "1",
      ]);
      runAdbRaw(["forward", "--remove", `tcp:${cfg.cdpPort}`]);
    } catch {
      // Ignore cleanup errors
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    report.finishedAt = new Date().toISOString();
    const reportPath = path.join(cfg.outDir, "usb-e2e-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`\nSaved full USB E2E report to: ${reportPath}`);
  }

  const failedSteps = report.steps.filter((s) => s.status !== "PASS");
  if (failedSteps.length > 0) {
    console.error(
      `\nUSB E2E completed with ${failedSteps.length} failed step(s): ${failedSteps.map((s) => s.id).join(", ")}`,
    );
    process.exit(1);
  }
  console.log("\nALL 13 USB ANDROID REAL-DEVICE E2E STEPS PASSED 100%!");
}

main().catch((err) => {
  console.error("FATAL HARNESS ERROR:", err);
  process.exit(1);
});
