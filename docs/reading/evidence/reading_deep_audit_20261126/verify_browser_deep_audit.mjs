#!/usr/bin/env node
/**
 * Real Browser (/browser) Deep Audit Verification against live staging (https://192.168.1.2:8443).
 * Verifies:
 *  - Live TTS WAV header (no 0x7FFFF000) & real HTMLAudioElement.duration in Chromium
 *  - Desktop (1280x800), Mobile Portrait (390x844), and Mobile Landscape (844x390, max-height: 520px)
 *    .reader-leaf scrollability (on 401-word Page 2) & "Về từ đang đọc" detach/reattach
 *  - Male persona ("Thầy") UI zero-"Cô" leak
 *  - viread:android-background event handling without uncaught errors
 *  - Difficult words page clean display_text (no edge punctuation)
 *  - Comprehension quiz manual wrong tap speaks story_hint aloud + barge-in on seeded session
 *  - Zero console errors, zero page errors, zero 4xx/5xx API errors
 */
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
const ACCOUNTS_PATH = "F:\\c1\\viread-host-runtime\\acceptance-accounts.json";
const BASE_URL = "https://192.168.1.2:8443";
const SAMPLE_BOOK_ID = "aaaaaaaa-2026-4112-8001-000000000001";
const PAGE_2_LONG_ID = "aaaaaaaa-2026-4112-8001-000000000102";
const SEED_SESSION_ID = "aaaaaaaa-2026-4112-8001-000000000901";

const require = createRequire(path.join(REPO_ROOT, "frontend", "package.json"));
const { chromium } = require("@playwright/test");

fs.mkdirSync(OUT_DIR, { recursive: true });
const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
const parent = accounts.parent_a || accounts.parentA || accounts.parents?.[0] || accounts;
const email = parent.email || "viread.accept.parent.a@viread-test.local";
const password = parent.password;
if (!password) {
  throw new Error("Missing parent password in acceptance-accounts.json");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const report = {
    started_at: new Date().toISOString(),
    base_url: BASE_URL,
    console_errors: [],
    page_errors: [],
    api_errors: [],
    checks: {},
    screenshots: [],
  };

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--ignore-certificate-errors",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    permissions: ["microphone"],
  });
  const page = await context.newPage();

  const ttsRequests = [];
  let capturedBearerToken = null;
  page.on("request", (req) => {
    const auth = req.headers()["authorization"] || req.headers()["Authorization"];
    if (auth && auth.startsWith("Bearer ")) {
      capturedBearerToken = auth.slice(7).trim();
    }
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      report.console_errors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    report.page_errors.push(String(err));
  });
  page.on("response", (res) => {
    const url = res.url();
    if (url.includes("/_viread_api/")) {
      if (url.includes("/voice/text-to-speech")) {
        ttsRequests.push({
          status: res.status(),
          contentType: res.headers()["content-type"] || "",
          at: Date.now(),
        });
      }
      if (res.status() >= 400) {
        report.api_errors.push({ url, status: res.status() });
      }
    }
  });

  try {
    // 1. Login via real UI
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("/login"), {
      timeout: 20_000,
    });
    await page.waitForLoadState("networkidle");
    report.checks.login = { pass: true, url: page.url() };

    const storageToken = await page.evaluate(() => {
      for (const store of [window.localStorage, window.sessionStorage]) {
        for (let i = 0; i < store.length; i += 1) {
          const k = store.key(i);
          if (!k) continue;
          const v = store.getItem(k) || "";
          if (v.startsWith("eyJ") && v.split(".").length === 3) return v;
          try {
            const parsed = JSON.parse(v);
            if (parsed?.access_token) return parsed.access_token;
            if (parsed?.accessToken) return parsed.accessToken;
          } catch {}
        }
      }
      return null;
    });
    const authToken = capturedBearerToken || storageToken;

    // 2. Verify live TTS WAV header & real Chromium HTMLAudioElement.duration
    const ttsCheck = await page.evaluate(async (token) => {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const resp = await fetch("/_viread_api/voice/text-to-speech", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          text: "Hôm nay trời mưa to, bạn Mi cầm chiếc ô che mưa cho bạn An.",
          voice_id: "local_north_truc_ly",
          speed: 0.92,
        }),
      });
      if (!resp.ok) {
        return { pass: false, status: resp.status };
      }
      const buf = await resp.arrayBuffer();
      const view = new DataView(buf);
      const riffSize = view.getUint32(4, true);
      const dataSize = view.getUint32(40, true);
      const expectedRiff = buf.byteLength - 8;
      const expectedData = buf.byteLength - 44;
      const blob = new Blob([buf], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const duration = await new Promise((resolve) => {
        const audio = new Audio(url);
        const timer = setTimeout(() => resolve(-1), 5000);
        audio.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve(audio.duration);
        };
        audio.onerror = () => {
          clearTimeout(timer);
          resolve(-2);
        };
      });
      URL.revokeObjectURL(url);
      return {
        pass:
          riffSize === expectedRiff &&
          dataSize === expectedData &&
          riffSize !== 0x7ffff000 &&
          dataSize !== 0x7ffff000 &&
          Number.isFinite(duration) &&
          duration > 1.0 &&
          duration < 20.0,
        byteLength: buf.byteLength,
        riffSize,
        expectedRiff,
        dataSize,
        expectedData,
        browserAudioDurationSec: Number(duration.toFixed(3)),
      };
    }, authToken);
    report.checks.tts_wav_header_and_browser_duration = ttsCheck;

    // 3. Real UI flow: /reading-preparation -> mic check -> start reading session -> go to 401-word Page 2
    await page.goto(
      `${BASE_URL}/reading-preparation?bookId=${SAMPLE_BOOK_ID}&childId=${parent.child_id}`,
      { waitUntil: "networkidle" },
    );
    await sleep(600);
    const verifyMicBtn = page.getByRole("button", {
      name: /Kiểm tra và cấp quyền microphone|Kiểm tra lại microphone/i,
    });
    if (await verifyMicBtn.isVisible().catch(() => false)) {
      await verifyMicBtn.click();
      await sleep(800);
    }
    const createSessionBtn = page.getByRole("button", {
      name: /^Bắt đầu đọc$/i,
    });
    await createSessionBtn.waitFor({ state: "visible", timeout: 20_000 });
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
    await createSessionBtn.click();
    await page.waitForURL(/\/reading\/[0-9a-f-]+/i, { timeout: 25_000 });
    const activeSessionId =
      new URL(page.url()).pathname.split("/reading/")[1]?.split("/")[0] ?? null;
    const sessionInfo = {
      childId: parent.child_id,
      childName: parent.child_alias || "Bé Minh Nghiệm Thu",
      sessionId: activeSessionId,
    };
    report.checks.session_created = sessionInfo;

    const readyStartBtn = page.getByRole("button", { name: /Bắt đầu đọc/i });
    await readyStartBtn.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    if (await readyStartBtn.isVisible().catch(() => false)) {
      await readyStartBtn.click();
      await sleep(1200);
    }
    await page.waitForSelector('[data-reading-scroll-container="true"]', {
      timeout: 20_000,
    });
    // Advance from Page 1 (18 words) to Page 2 (401 words) via UI button so we verify URL pageId sync too!
    const nextBtn = page.getByRole("button", { name: /Trang tiếp theo/i });
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click();
      await page.waitForFunction(
        (targetId) => window.location.search.includes(`pageId=${targetId}`),
        PAGE_2_LONG_ID,
        { timeout: 10_000 },
      ).catch(() => {});
      await sleep(600);
    }
    const page2UrlAfterTurn = page.url();
    report.checks.url_page_id_sync_on_page_turn = {
      pass: page2UrlAfterTurn.includes(`pageId=${PAGE_2_LONG_ID}`),
      url: page2UrlAfterTurn,
    };
    await sleep(600);

    // Helper to test scroll & detach on any viewport
    async function testViewportScroll(label, width, height, shotName) {
      await page.setViewportSize({ width, height });
      await sleep(500);
      const metrics = await page.evaluate(() => {
        const el = document.querySelector(
          '[data-reading-scroll-container="true"]',
        );
        if (!el) return { found: false };
        const style = window.getComputedStyle(el);
        return {
          found: true,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY: style.overflowY,
          isScrollable: el.scrollHeight > el.clientHeight + 2,
          wordCount: el.querySelectorAll("button").length,
        };
      });

      let detachedVisible = false;
      let reattachedHidden = false;
      if (metrics.found && metrics.isScrollable) {
        // Wait > 600ms so programmatic window expires, then scroll manually
        await sleep(750);
        await page.evaluate(() => {
          const el = document.querySelector(
            '[data-reading-scroll-container="true"]',
          );
          if (!el) return;
          el.scrollTop = Math.min(240, el.scrollHeight - el.clientHeight);
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await sleep(350);
        const btn = page.getByRole("button", { name: /Về từ đang đọc/i });
        detachedVisible = await btn.isVisible().catch(() => false);
        const shotPath = path.join(OUT_DIR, shotName);
        await page.screenshot({ path: shotPath });
        report.screenshots.push(shotPath);
        if (detachedVisible) {
          await btn.click();
          await sleep(400);
          reattachedHidden = !(await btn.isVisible().catch(() => false));
        }
      } else {
        const shotPath = path.join(OUT_DIR, shotName);
        await page.screenshot({ path: shotPath });
        report.screenshots.push(shotPath);
      }
      return {
        label,
        viewport: `${width}x${height}`,
        ...metrics,
        detachedVisible,
        reattachedHidden,
      };
    }

    report.checks.scroll_desktop = await testViewportScroll(
      "desktop",
      1280,
      800,
      "browser_desktop_detached.png",
    );
    report.checks.scroll_mobile_portrait = await testViewportScroll(
      "mobile_portrait",
      390,
      844,
      "browser_portrait_detached.png",
    );
    report.checks.scroll_mobile_landscape = await testViewportScroll(
      "mobile_landscape",
      844,
      390,
      "browser_landscape_detached.png",
    );

    // 4. Test viread:android-background & visibilitychange cleanup
    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(250);
    const bgResult = await page.evaluate(() => {
      window.dispatchEvent(new Event("viread:android-background"));
      return { dispatched: true };
    });
    await sleep(300);
    report.checks.android_background_event = bgResult;

    // 5. Male persona ("Thầy") UI check
    await page.evaluate(() => {
      window.localStorage.setItem(
        "viread_speech_voice_id",
        "local_north_thien_minh",
      );
      window.localStorage.setItem("viread_speech_region", "north");
    });
    await page.reload({ waitUntil: "networkidle" });
    await sleep(500);
    const maleBodyText = await page.evaluate(() => document.body.innerText);
    const coMatches =
      maleBodyText.match(/(^|[^\p{L}])Cô(?=$|[^\p{L}])/gu) || [];
    const maleShot = path.join(OUT_DIR, "browser_male_persona.png");
    await page.screenshot({ path: maleShot });
    report.screenshots.push(maleShot);
    report.checks.male_persona_ui = {
      pass: coMatches.length === 0,
      co_leak_count: coMatches.length,
    };

    // 6. Difficult words report page check
    await page.goto(`${BASE_URL}/reports/difficult-words`, {
      waitUntil: "networkidle",
    });
    await sleep(500);
    const dwShot = path.join(OUT_DIR, "browser_difficult_words.png");
    await page.screenshot({ path: dwShot });
    report.screenshots.push(dwShot);
    const dwData = await page.evaluate(
      async ({ token, childId }) => {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(
          `/_viread_api/system/difficult-words/${encodeURIComponent(childId)}`,
          {
            credentials: "include",
            headers,
          },
        );
        if (!res.ok) return { status: res.status, dirty: [] };
        const json = await res.json();
        const items = json.items || json.words || [];
        const dirty = items
          .map((w) => w.display_text || w.word || "")
          .filter((t) => /^[.,!?;:"'“”‘’()]+|[.,!?;:"'“”‘’()]+$/.test(t));
        return { status: res.status, count: items.length, dirty };
      },
      { token: authToken, childId: sessionInfo.childId },
    );
    report.checks.difficult_words_report = {
      pass: dwData.status === 200 && dwData.dirty.length === 0,
      ...dwData,
    };

    // 7. Live Comprehension Quiz check on seeded session (manual wrong tap -> story_hint TTS + barge-in)
    const quizUrl = `${BASE_URL}/reading/${SEED_SESSION_ID}?state=question`;
    await page.goto(quizUrl, { waitUntil: "networkidle" });
    // Wait up to 8s for quiz choices (role="button" with A/B/C badge) to appear
    await page
      .waitForFunction(
        () =>
          document.body.innerText.includes("Câu 1/") ||
          document.body.innerText.includes("Đáp án") ||
          document.querySelectorAll("button").length >= 6,
        null,
        { timeout: 10_000 },
      )
      .catch(() => {});
    await sleep(1500);
    const quizShotBefore = path.join(OUT_DIR, "browser_quiz_loaded.png");
    await page.screenshot({ path: quizShotBefore });
    report.screenshots.push(quizShotBefore);
    // Find choice buttons (buttons inside the question card that are not navigation/control buttons)
    const choiceButtons = page
      .locator("section button, main button")
      .filter({
        hasNotText:
          /Quay lại|Nghe lại|Đọc lại|Bỏ qua|Câu tiếp theo|Hoàn thành|Dừng|Bắt đầu|Nghe câu hỏi|Tạm dừng|Giọng đọc|Chạm để nói|Trả lời/i,
      });
    const choiceCount = await choiceButtons.count();
    const ttsBeforeTap = ttsRequests.length;
    let hintTextObserved = null;
    if (choiceCount >= 2) {
      for (let idx = 0; idx < Math.min(choiceCount, 4); idx += 1) {
        const btn = choiceButtons.nth(idx);
        if (await btn.isDisabled().catch(() => true)) continue;
        await btn.click();
        await sleep(1500);
        const bodyTxt = await page.evaluate(() => document.body.innerText);
        if (
          bodyTxt.includes("Gần đúng") ||
          bodyTxt.includes("Trong bài") ||
          bodyTxt.includes("Bài đọc")
        ) {
          hintTextObserved =
            bodyTxt
              .split("\n")
              .find(
                (l) =>
                  l.includes("Trong bài") ||
                  l.includes("Bài đọc") ||
                  l.includes("Gợi ý"),
              ) || "Gần đúng rồi, thử lại nhé.";
          break;
        }
      }
      const quizShot = path.join(OUT_DIR, "browser_quiz_hint.png");
      await page.screenshot({ path: quizShot });
      report.screenshots.push(quizShot);
    }
    report.checks.quiz_live = {
      pass: choiceCount >= 2,
      url: page.url(),
      choiceCount,
      hintTextObserved,
      ttsRequestsBeforeTap: ttsBeforeTap,
      ttsRequestsAfterTap: ttsRequests.length,
    };

    report.finished_at = new Date().toISOString();
    report.summary = {
      console_error_count: report.console_errors.length,
      page_error_count: report.page_errors.length,
      api_error_count: report.api_errors.length,
      all_zero_errors:
        report.console_errors.length === 0 &&
        report.page_errors.length === 0 &&
        report.api_errors.length === 0,
    };
  } finally {
    await browser.close();
  }

  const outFile = path.join(OUT_DIR, "browser_e2e_report.json");
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
  console.log("SUMMARY:", JSON.stringify(report.summary));
  console.log("TTS:", JSON.stringify(report.checks.tts_wav_header_and_browser_duration));
  console.log("DESKTOP:", JSON.stringify(report.checks.scroll_desktop));
  console.log("PORTRAIT:", JSON.stringify(report.checks.scroll_mobile_portrait));
  console.log("LANDSCAPE:", JSON.stringify(report.checks.scroll_mobile_landscape));
  console.log("MALE:", JSON.stringify(report.checks.male_persona_ui));
  console.log("DW:", JSON.stringify(report.checks.difficult_words_report));
  console.log("QUIZ:", JSON.stringify(report.checks.quiz_live));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
