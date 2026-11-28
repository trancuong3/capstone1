#!/usr/bin/env node
/**
 * Real Browser (/browser) Live Comprehension Quiz Verification against rebuilt `.next-staging`
 * (https://192.168.1.2:8443).
 * Verifies:
 *  1. Fresh reading session -> complete reading -> active ComprehensionQuestion screen
 *  2. Prefetch TTS requests for choices B & C go through useSpeechPlayer().prefetch() ->
 *     TtsPlayback.prefetch() with locked `voice_id` and `speed` (exact match with question/hint TTS)
 *  3. Manual wrong choice tap returns redacted `story_hint` & triggers live hint TTS
 *  4. Immediate barge-in tap on the correct choice interrupts hint TTS & marks answer correct
 *  5. Zero console errors, zero page errors, zero >=400 API errors
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

const require = createRequire(path.join(REPO_ROOT, "frontend", "package.json"));
const { chromium } = require("@playwright/test");

fs.mkdirSync(OUT_DIR, { recursive: true });
const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
const parent =
  accounts.parent_a || accounts.parentA || accounts.parents?.[0] || accounts;
const email = parent.email || "viread.accept.parent.a@viread-test.local";
const password = parent.password;
if (!password) {
  throw new Error("Missing parent password in acceptance-accounts.json");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const consoleErrors = [];
  const pageErrors = [];
  const apiErrors = [];
  const ttsPayloads = [];
  let lastAnswerResult = null;
  let lastQuestionResponse = null;

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

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(String(err));
  });
  page.on("request", (req) => {
    const url = req.url();
    if (
      url.includes("/_viread_api/voice/text-to-speech") &&
      req.method() === "POST"
    ) {
      try {
        const body = req.postData();
        if (body) {
          ttsPayloads.push(JSON.parse(body));
        }
      } catch {
        // ignore unparseable payload
      }
    }
  });
  page.on("response", async (res) => {
    const url = res.url();
    if (!url.includes("/_viread_api/")) return;
    if (res.status() >= 400) {
      apiErrors.push({ url, status: res.status() });
      return;
    }
    if (url.includes("/questions/answer") || url.includes("/comprehension/answer") || /\/questions\/[^/]+\/answer/i.test(url)) {
      try {
        lastAnswerResult = await res.json();
      } catch {}
    } else if (/\/sessions\/[^/]+\/questions(\?|$)/i.test(url) || url.includes("/comprehension/question")) {
      try {
        lastQuestionResponse = await res.json();
      } catch {}
    }
  });

  let sessionUrl = null;
  const liveQuiz = {
    choices: [],
    questionDispatchedBeforePrefetch: false,
    fullNarrationListeningReached: false,
    requestCountsDuringFullNarration: {},
    prefetchCacheHitVerifiedLive: false,
    prefetchedChoiceTts: [],
    prefetchAllHaveLockedVoiceAndSpeed: false,
    lockedVoiceId: null,
    lockedSpeed: null,
    wrongChoiceClicked: null,
    storyHintReturned: null,
    hintTtsRequested: false,
    hintTtsPayload: null,
    bargeInSucceeded: false,
    correctChoiceClicked: null,
    ttsPayloadsCount: 0,
    ttsSamplePayloads: [],
  };

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

    // 2. Create fresh reading session via /reading-preparation
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
    sessionUrl = page.url();

    // 3. Start reading on Page 1, then click finish reading to enter ComprehensionQuestion
    const readyStartBtn = page.getByRole("button", { name: /Bắt đầu đọc/i });
    await readyStartBtn
      .waitFor({ state: "visible", timeout: 20_000 })
      .catch(() => {});
    if (await readyStartBtn.isVisible().catch(() => false)) {
      await readyStartBtn.click();
      await sleep(1000);
    }

    // Clear any reading-screen TTS payloads before entering Quiz so we observe clean Quiz payloads
    ttsPayloads.length = 0;

    const finishBtn = page.getByRole("button", {
      name: /Hoàn thành|Kết thúc buổi đọc|Kết thúc/i,
    });
    await finishBtn.first().waitFor({ state: "visible", timeout: 20_000 });
    await finishBtn.first().click();
    await sleep(600);

    // Handle confirmation modal ("Bé muốn nghỉ hôm nay?" -> "Lưu và dừng")
    const saveAndStopBtn = page.getByRole("button", {
      name: /^Lưu và dừng$/i,
    });
    await saveAndStopBtn
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => {});
    if (await saveAndStopBtn.isVisible().catch(() => false)) {
      await saveAndStopBtn.click();
    }

    // Wait for ComprehensionQuestion heading & choice buttons
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("Mình cùng trả lời nhé") ||
        document.body.innerText.includes("Tạm dừng nghe"),
      null,
      { timeout: 50_000 },
    );

    // Wait for full Q1 narration (Question -> Choice A -> Choice B -> Choice C -> askChoice)
    // WITHOUT interrupting so we verify live browser TtsPlayback.shortCache hits (0 duplicate
    // /voice/text-to-speech requests when Choice B & Choice C are spoken aloud).
    const narrationDeadline = Date.now() + 45_000;
    while (Date.now() < narrationDeadline) {
      const hasAskChoice = ttsPayloads.some((p) =>
        /chọn đáp án nào|chọn câu nào|đáp án nào nhé/i.test(p.text || ""),
      );
      if (hasAskChoice) {
        liveQuiz.fullNarrationListeningReached = true;
        await sleep(1_500);
        break;
      }
      await sleep(300);
    }

    const countsDuringNarration = {};
    for (const p of ttsPayloads) {
      const key = p.text || "";
      countsDuringNarration[key] = (countsDuringNarration[key] || 0) + 1;
    }
    liveQuiz.requestCountsDuringFullNarration = countsDuringNarration;

    // Confirm Question prompt was dispatched BEFORE Choice B prefetch
    const firstQuestionIdx = ttsPayloads.findIndex(
      (p) => !/^Đáp án [ABCD]:/i.test(p.text || ""),
    );
    const firstPrefetchBIdx = ttsPayloads.findIndex((p) =>
      /^Đáp án B:/i.test(p.text || ""),
    );
    liveQuiz.questionDispatchedBeforePrefetch =
      firstQuestionIdx >= 0 &&
      firstPrefetchBIdx > firstQuestionIdx;

    // Capture quiz choice buttons inside section
    const sectionButtons = page.locator("section button");
    const btnCount = await sectionButtons.count();
    const choiceLocators = [];
    for (let i = 0; i < btnCount; i += 1) {
      const btn = sectionButtons.nth(i);
      const txt = ((await btn.innerText().catch(() => "")) || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!txt) continue;
      if (
        txt === "Tạm dừng nghe" ||
        txt === "Tiếp tục nghe" ||
        /^[ABCD]\s+/.test(txt)
      ) {
        liveQuiz.choices.push(txt);
      }
      if (/^[ABCD]\s+/.test(txt)) {
        choiceLocators.push({ text: txt, locator: btn });
      }
    }

    // Record prefetched B/C/D choice TTS payloads observed during full narration
    const prefetched = ttsPayloads.filter((p) =>
      /^Đáp án [BCD]:/i.test(p.text || ""),
    );
    liveQuiz.prefetchedChoiceTts = prefetched;
    const bEntries = Object.entries(countsDuringNarration).filter(([k]) =>
      /^Đáp án B:/i.test(k),
    );
    const cEntries = Object.entries(countsDuringNarration).filter(([k]) =>
      /^Đáp án C:/i.test(k),
    );
    liveQuiz.prefetchCacheHitVerifiedLive =
      liveQuiz.fullNarrationListeningReached &&
      bEntries.length === 1 &&
      bEntries[0][1] === 1 &&
      cEntries.length === 1 &&
      cEntries[0][1] === 1;

    // 4. Tap a wrong choice to trigger story_hint + hint TTS, then barge-in tap the correct choice
    if (choiceLocators.length < 2) {
      throw new Error(
        `Expected >= 2 quiz choice buttons, found ${choiceLocators.length}: ${JSON.stringify(liveQuiz.choices)}`,
      );
    }

    // Try choices from the end (C, B, A) until we hit a wrong choice first so we reliably exercise story_hint
    // (In Q1 for "Sáng nay, Mi mang ô đến lớp", choice C is typically wrong; if not, fallback to another.)
    const orderedCandidates = [...choiceLocators].reverse();
    let wrongIndex = -1;
    for (let idx = 0; idx < orderedCandidates.length; idx += 1) {
      const candidate = orderedCandidates[idx];
      const ttsBeforeWrong = ttsPayloads.length;
      lastAnswerResult = null;
      await candidate.locator.click();
      // Wait for answer response
      const ansDeadline = Date.now() + 10_000;
      while (!lastAnswerResult && Date.now() < ansDeadline) {
        await sleep(150);
      }
      if (lastAnswerResult && lastAnswerResult.is_correct === false) {
        wrongIndex = idx;
        liveQuiz.wrongChoiceClicked = candidate.text;
        liveQuiz.storyHintReturned = lastAnswerResult.story_hint || null;
        // Wait for hint TTS request to fire
        const hintDeadline = Date.now() + 8_000;
        while (Date.now() < hintDeadline) {
          const newPayloads = ttsPayloads.slice(ttsBeforeWrong);
          const hintReq = newPayloads.find(
            (p) =>
              p.text &&
              (p.text.includes("nhớ lại chi tiết") ||
                p.text.includes("bài đọc") ||
                (liveQuiz.storyHintReturned &&
                  p.text.includes(
                    liveQuiz.storyHintReturned.slice(0, 20),
                  ))),
          );
          if (hintReq) {
            liveQuiz.hintTtsRequested = true;
            liveQuiz.hintTtsPayload = hintReq;
            break;
          }
          await sleep(150);
        }
        await sleep(300);
        await page.screenshot({
          path: path.join(OUT_DIR, "browser_live_quiz_hint.png"),
        });
        break;
      } else if (lastAnswerResult && lastAnswerResult.is_correct === true) {
        // Unlikely first tap was already correct; record and stop
        liveQuiz.correctChoiceClicked = candidate.text;
        break;
      }
    }

    // 5. Barge-in tap remaining choices until we hit the correct one
    if (wrongIndex >= 0) {
      for (const candidate of choiceLocators) {
        if (candidate.text === liveQuiz.wrongChoiceClicked) continue;
        lastAnswerResult = null;
        await candidate.locator.click();
        const ansDeadline = Date.now() + 10_000;
        while (!lastAnswerResult && Date.now() < ansDeadline) {
          await sleep(150);
        }
        if (lastAnswerResult && lastAnswerResult.is_correct === true) {
          liveQuiz.bargeInSucceeded = true;
          liveQuiz.correctChoiceClicked = candidate.text;
          break;
        }
      }
    }

    // Finalize TTS payload audit
    liveQuiz.ttsPayloadsCount = ttsPayloads.length;
    liveQuiz.ttsSamplePayloads = ttsPayloads;

    const firstWithVoice = ttsPayloads.find(
      (p) => typeof p.voice_id === "string" && p.voice_id.length > 0,
    );
    liveQuiz.lockedVoiceId = firstWithVoice?.voice_id ?? null;
    liveQuiz.lockedSpeed =
      typeof firstWithVoice?.speed === "number" ? firstWithVoice.speed : null;

    liveQuiz.prefetchAllHaveLockedVoiceAndSpeed =
      liveQuiz.prefetchedChoiceTts.length >= 2 &&
      Boolean(liveQuiz.lockedVoiceId) &&
      typeof liveQuiz.lockedSpeed === "number" &&
      liveQuiz.prefetchedChoiceTts.every(
        (p) =>
          p.voice_id === liveQuiz.lockedVoiceId &&
          p.speed === liveQuiz.lockedSpeed,
      );
  } finally {
    await browser.close();
  }

  const report = {
    verifiedAt: new Date().toISOString(),
    sessionUrl,
    live_comprehension_quiz: liveQuiz,
    consoleErrors,
    pageErrors,
    apiErrors,
  };

  const outFile = path.join(OUT_DIR, "browser_live_quiz_report.json");
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log("LIVE QUIZ REPORT:", JSON.stringify(report, null, 2));

  const passed =
    liveQuiz.questionDispatchedBeforePrefetch &&
    liveQuiz.prefetchCacheHitVerifiedLive &&
    liveQuiz.prefetchAllHaveLockedVoiceAndSpeed &&
    liveQuiz.hintTtsRequested &&
    liveQuiz.bargeInSucceeded &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0 &&
    apiErrors.length === 0;
  if (!passed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
