import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import {
  PLAYWRIGHT_ORIGIN,
  installApiFixture,
  setRole,
  book,
  child,
  ids,
} from "./real-data-fixture";
import {
  lineId,
  previewDetail,
  songDetail,
  songId,
  stamp,
  versionId,
} from "../karaoke-fixtures";
import type {
  EntertainmentRecommendationsDTO,
  ParentEntertainmentAnalyticsDTO,
} from "../../types/adaptive-learning";
import type {
  MemorySessionDTO,
  MemoryThemesCatalogDTO,
} from "../../types/memory-game";
import type {
  PictureCatalogDTO,
  PictureSessionDTO,
} from "../../types/picture-description";
import type {
  SentenceShooterBookDTO,
  SentenceShooterResultDTO,
  SentenceShooterSessionDTO,
} from "../../types/sentence-shooter";

const SECOND_CHILD_ID = "22222222-2222-4222-8222-222222222229";
const SECOND_CHILD = {
  id: SECOND_CHILD_ID,
  parent_id: ids.parent,
  alias: "Bé Bông",
  grade: 4,
  settings: {},
  created_at: "2026-10-08T00:00:00Z",
};

const PICTURE_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PICTURE_ATTEMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const PICTURE_BOOK_PAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

const SHOOTER_BOOK_ID = ids.book;
const SHOOTER_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const SHOOTER_ROUND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const SHOOTER_TOKEN_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
const SHOOTER_TOKEN_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
const SHOOTER_TOKEN_3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5";

const MEMORY_SESSION_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const MEMORY_ATTEMPT_RECALL_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const MEMORY_ATTEMPT_CREATIVE_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";

const KARAOKE_SESSION_ID = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const SIMPLE_JOB_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";

const CORS_HEADERS = {
  "access-control-allow-origin": PLAYWRIGHT_ORIGIN,
  "access-control-allow-headers": "authorization,content-type,accept",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
};

const AFTER_SCREENSHOT_DIR = path.resolve(
  process.cwd(),
  "..",
  "docs",
  "entertainment-v4",
  "screenshots",
  "after",
);

const V4_1_SCREENSHOT_DIR = process.env.V4_1_SCREENSHOT_DIR?.trim() || "";

function buildSilentWavBuffer(seconds = 1): Buffer {
  const rate = 8000;
  const bytes = Buffer.alloc(44 + rate * seconds * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

async function respondJson(
  route: Route,
  payload: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: CORS_HEADERS,
    body: status === 204 ? undefined : JSON.stringify(payload),
  });
}

async function saveAfterScreenshot(
  page: Page,
  projectName: string,
  slug: string,
): Promise<void> {
  mkdirSync(AFTER_SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => document.fonts?.ready);
  const fileName = `${slug}-${projectName}.png`;
  const targetPath = path.join(AFTER_SCREENSHOT_DIR, fileName);
  await page.screenshot({
    path: targetPath,
    fullPage: true,
  });
  if (V4_1_SCREENSHOT_DIR) {
    mkdirSync(V4_1_SCREENSHOT_DIR, { recursive: true });
    copyFileSync(targetPath, path.join(V4_1_SCREENSHOT_DIR, fileName));
  }
}

async function saveShowcaseScreenshot(
  page: Page,
  projectName: string,
  slug: string,
): Promise<void> {
  if (!V4_1_SCREENSHOT_DIR) return;
  mkdirSync(V4_1_SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => document.fonts?.ready);
  await page.screenshot({
    path: path.join(V4_1_SCREENSHOT_DIR, `${slug}-${projectName}.png`),
    fullPage: true,
  });
}

async function assertViewportHealth(
  page: Page,
  label: string,
  locators: Locator[] = [],
): Promise<void> {
  const metrics = await page.evaluate(() => {
    const brokenImages = Array.from(document.querySelectorAll("img"))
      .filter((img) => {
        const style = window.getComputedStyle(img);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        const src = img.getAttribute("src") || "";
        return src.length > 0 && img.complete && img.naturalWidth === 0;
      })
      .map(
        (img) => img.getAttribute("alt") || img.getAttribute("src") || "img",
      );

    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      brokenImages,
    };
  });

  expect(
    metrics.scrollWidth,
    `[${label}] Horizontal overflow (${metrics.scrollWidth} > ${metrics.innerWidth})`,
  ).toBeLessThanOrEqual(metrics.innerWidth);
  expect(metrics.brokenImages, `[${label}] Broken images`).toEqual([]);

  for (const locator of locators) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box, `[${label}] Missing bounding box`).not.toBeNull();
    expect(
      Math.round(box!.height),
      `[${label}] Touch target < 44px (${box?.height}px)`,
    ).toBeGreaterThanOrEqual(44);
  }
}

async function installLearningRecommendationsMock(page: Page): Promise<void> {
  await page
    .context()
    .route("http://127.0.0.1:8000/learning/**", async (route) => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (/^\/learning\/children\/[^/]+\/recommendations$/.test(pathname)) {
        await respondJson(route, buildRecommendations(child));
        return;
      }
      await route.fallback();
    });
}

async function selectChildAndEnterEntertainment(
  page: Page,
  mockRecommendations = true,
): Promise<void> {
  if (mockRecommendations) {
    await installLearningRecommendationsMock(page);
  }
  await page.goto("/dashboard", { timeout: 60_000 });
  const childButton = page.getByRole("button", {
    name: `${child.alias}, lớp ${child.grade}`,
  });
  await expect(childButton).toBeVisible({ timeout: 30_000 });
  await childButton.click();
  await expect(childButton).toHaveAttribute("aria-pressed", "true");
  const enterEntertainmentBtn = page.getByRole("button", {
    name: "Trò chơi và âm nhạc",
    exact: true,
  });
  await expect(enterEntertainmentBtn).toBeEnabled();
  await enterEntertainmentBtn.click();
  await expect(page).toHaveURL(/\/entertainment$/, { timeout: 30_000 });
}

async function installVoiceAndTtsMock(page: Page): Promise<void> {
  const wavBytes = buildSilentWavBuffer(1);

  await page
    .context()
    .route("http://127.0.0.1:8000/voice/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (url.pathname === "/voice/text-to-speech") {
        await route.fulfill({
          status: 200,
          contentType: "audio/wav",
          headers: {
            ...CORS_HEADERS,
            "x-tts-provider": "local",
            "x-resolved-voice-id": "Binh",
          },
          body: wavBytes,
        });
        return;
      }
      if (url.pathname === "/voice/speech-to-text") {
        await respondJson(route, {
          text: "Con mèo mướp đang nằm dưới nắng vàng trong khu vườn.",
          language_code: "vi",
          language_probability: 0.99,
          words: [],
        });
        return;
      }
      await route.fallback();
    });

  await page.addInitScript(() => {
    const tracks = new Set<MediaStreamTrack>();
    let audioCtx: AudioContext | undefined;

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        if (!constraints.audio || constraints.video) {
          throw new Error("Expected audio-only capture");
        }
        audioCtx ??= new AudioContext();
        const destination = audioCtx.createMediaStreamDestination();
        const oscillator = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0.002;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        void audioCtx.resume();
        const stream = destination.stream;
        stream.getTracks().forEach((track) => tracks.add(track));
        return stream;
      },
    });

    class MockSpeechRecognition {
      static active: MockSpeechRecognition | null = null;
      lang = "vi-VN";
      continuous = true;
      interimResults = true;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private activeStream = false;

      start(): void {
        this.activeStream = true;
        MockSpeechRecognition.active = this;
      }

      stop(): void {
        if (this.activeStream) {
          this.activeStream = false;
          if (MockSpeechRecognition.active === this) {
            MockSpeechRecognition.active = null;
          }
          queueMicrotask(() => this.onend?.());
        }
      }

      abort(): void {
        this.activeStream = false;
        if (MockSpeechRecognition.active === this) {
          MockSpeechRecognition.active = null;
        }
      }
    }

    Object.defineProperty(window, "__v4SpeechControl", {
      value: {
        emitTranscript(text: string, isFinal = true) {
          const active = MockSpeechRecognition.active;
          if (!active) return false;
          active.onresult?.({
            resultIndex: 0,
            results: {
              length: 1,
              0: {
                isFinal,
                length: 1,
                0: { transcript: text, confidence: 0.98 },
              },
            },
          });
          return true;
        },
      },
    });

    Object.defineProperty(window, "SpeechRecognition", {
      value: MockSpeechRecognition,
      configurable: true,
    });
  });
}

function buildRecommendations(
  targetChild: typeof child,
): EntertainmentRecommendationsDTO {
  const isOlder = targetChild.grade >= 4;
  return {
    child_id: targetChild.id,
    child_alias: targetChild.alias,
    child_grade: targetChild.grade,
    mascot_greeting_vi: isOlder
      ? `Chào ${targetChild.alias}! Cùng khám phá câu chuyện sáng tạo và luyện trí nhớ hôm nay nhé!`
      : `Chào ${targetChild.alias}! Cú Mèo đã chuẩn bị góc kể chuyện và ghép câu thật vui cho bé!`,
    natural_break_reminder_vi:
      "Mỗi phiên chơi khoảng 10–15 phút là vừa đẹp để mắt bé luôn khỏe mạnh.",
    today_activities_count: isOlder ? 3 : 2,
    focus_difficult_words: isOlder
      ? ["thành công", "dịu dàng"]
      : ["mèo mướp", "lấp lánh"],
    primary_recommendation: {
      game_key: isOlder ? "MEMORY_GAME" : "PICTURE_DESCRIPTION",
      zone_title_vi: isOlder ? "Khám phá trí nhớ" : "Thế giới kể chuyện",
      game_title_vi: isOlder ? "Bé nhớ được gì?" : "Kể chuyện qua tranh",
      reason_vi: isOlder
        ? `${targetChild.alias} đang sẵn sàng thử sức quan sát tranh và kể tiếp câu chuyện sáng tạo.`
        : `Hôm nay ${targetChild.alias} hãy thử kể chuyện với từ "mèo mướp" và "lấp lánh" nhé!`,
      suggested_mode: isOlder ? "GUIDED_RECALL" : "VOCABULARY",
      suggested_difficulty: isOlder ? 3 : 2,
      target_words: isOlder ? ["thành công"] : ["mèo mướp", "lấp lánh"],
      href: isOlder
        ? "/entertainment/memory-game"
        : "/entertainment/picture-description",
      quick_play_href: isOlder
        ? "/entertainment/memory-game?autoplay=1"
        : "/entertainment/picture-description?autoplay=1",
      priority: 1,
    },
    recommendations: [
      {
        game_key: "PICTURE_DESCRIPTION",
        zone_title_vi: "Thế giới kể chuyện",
        game_title_vi: "Kể chuyện qua tranh",
        reason_vi: "Luyện đặt câu và mở rộng vốn từ miêu tả sinh động.",
        suggested_mode: "VOCABULARY",
        suggested_difficulty: 2,
        target_words: ["mèo mướp", "lấp lánh"],
        href: "/entertainment/picture-description",
        quick_play_href: "/entertainment/picture-description?autoplay=1",
        priority: 1,
      },
      {
        game_key: "SENTENCE_SHOOTER",
        zone_title_vi: "Phiêu lưu cùng chữ",
        game_title_vi: "Xạ thủ ghép câu",
        reason_vi: "Ghép câu ngắn gắn với từ khó bé vừa đọc.",
        suggested_mode: "WORD_ORDER",
        suggested_difficulty: 1,
        target_words: ["sách"],
        href: "/entertainment/sentence-shooter",
        quick_play_href: "/entertainment/sentence-shooter?autoplay=1",
        priority: 2,
      },
      {
        game_key: "KARAOKE",
        zone_title_vi: "Sân khấu âm nhạc",
        game_title_vi: "Hát vui cùng bé",
        reason_vi: "Hát theo nhịp và luyện ngắt nhịp câu hát rõ lời.",
        suggested_mode: "RHYTHM_TAP",
        suggested_difficulty: 1,
        target_words: [],
        href: "/karaoke",
        quick_play_href: "/karaoke?autoplay=1",
        priority: 3,
      },
      {
        game_key: "MEMORY_GAME",
        zone_title_vi: "Khám phá trí nhớ",
        game_title_vi: "Bé nhớ được gì?",
        reason_vi: "Quan sát tranh Việt Nam và kể tiếp câu chuyện sáng tạo.",
        suggested_mode: "GUIDED_RECALL",
        suggested_difficulty: 2,
        target_words: ["mèo mướp"],
        href: "/entertainment/memory-game",
        quick_play_href: "/entertainment/memory-game?autoplay=1",
        priority: 4,
      },
    ],
  };
}

test.beforeAll(async ({ request }) => {
  for (const route of [
    "/entertainment/memory-game",
    "/karaoke",
    `/karaoke/${songId}`,
  ]) {
    const response = await request.get(route);
    expect(response.status()).toBe(200);
  }
});

test("Flow 1: Entertainment Hub V4 (4 zones, mascot, multi-child selector, onboarding, sensory toggles)", async ({
  page,
}, testInfo) => {
  const base = await installApiFixture(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const childrenList = [child, SECOND_CHILD];
  const recommendedChildIds: string[] = [];

  await page
    .context()
    .route("http://127.0.0.1:8000/profiles/**", async (route) => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (pathname === "/profiles/dashboard-summary") {
        await respondJson(route, {
          profile: {
            id: ids.parent,
            role: "parent",
            display_name: "Ba mẹ API",
            created_at: child.created_at,
            email: "parent@example.test",
            contact_phone: "+84900000000",
            email_verified: true,
            contact_info_status: "available",
            avatar_url: null,
            children: childrenList,
          },
          children: childrenList,
          latest_sessions_by_child: {},
        });
        return;
      }
      if (pathname === "/profiles/children") {
        await respondJson(route, childrenList);
        return;
      }
      if (pathname === `/profiles/children/${SECOND_CHILD_ID}`) {
        await respondJson(route, SECOND_CHILD);
        return;
      }
      await route.fallback();
    });

  await page
    .context()
    .route("http://127.0.0.1:8000/learning/**", async (route) => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      const match = /^\/learning\/children\/([^/]+)\/recommendations$/.exec(
        pathname,
      );
      if (match) {
        const reqChildId = match[1];
        recommendedChildIds.push(reqChildId);
        const target = reqChildId === SECOND_CHILD_ID ? SECOND_CHILD : child;
        await respondJson(route, buildRecommendations(target));
        return;
      }
      await route.fallback();
    });

  await selectChildAndEnterEntertainment(page, false);

  await expect(
    page.getByRole("heading", { name: "Giải trí", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Cú Mèo ViRead gợi ý")).toBeVisible();
  await expect(page.getByTestId("hub-active-child-badge")).toContainText(
    `Hồ sơ ${child.alias} · Lớp ${child.grade}`,
  );

  // Verify all 4 V4 Play & Learn zones and links
  await expect(
    page.getByRole("heading", { name: "Kể chuyện qua tranh" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Xạ thủ ghép câu" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Hát vui cùng bé" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Bé nhớ được gì?" }),
  ).toBeVisible();

  const zoneLinks = [
    page.getByRole("link", { name: /Chọn tranh/i }),
    page.getByRole("link", { name: /Bắt đầu chơi/i }),
    page.getByRole("link", { name: /Mở thư viện bài hát/i }),
    page.getByRole("link", { name: /Khám phá trí nhớ/i }),
  ];

  // V4.1 Hub checks: misread-word chips, 1-tap Cú Mèo quick-play, 4 "Vào nhanh" links, hub-autopilot-toggle
  const misreadWordChips = page.getByTestId("hub-misread-word-chips");
  await expect(misreadWordChips).toBeVisible();
  await expect(misreadWordChips).toContainText("mèo mướp");
  await expect(misreadWordChips).toContainText("lấp lánh");

  const owlQuickPlay = page.getByTestId("hub-owl-quick-play");
  await expect(owlQuickPlay).toBeVisible();
  await expect(owlQuickPlay).toHaveAttribute(
    "href",
    "/entertainment/picture-description?autoplay=1",
  );
  await expect(owlQuickPlay).toContainText("Chơi ngay cùng Cú Mèo");

  const quickPlayLinks = [
    page.getByTestId("quick-play-picture-description"),
    page.getByTestId("quick-play-sentence-shooter"),
    page.getByTestId("quick-play-karaoke"),
    page.getByTestId("quick-play-memory-game"),
  ];
  await expect(quickPlayLinks[0]).toHaveAttribute(
    "href",
    "/entertainment/picture-description?autoplay=1",
  );
  await expect(quickPlayLinks[1]).toHaveAttribute(
    "href",
    "/entertainment/sentence-shooter?autoplay=1",
  );
  await expect(quickPlayLinks[2]).toHaveAttribute(
    "href",
    "/karaoke?autoplay=1",
  );
  await expect(quickPlayLinks[3]).toHaveAttribute(
    "href",
    "/entertainment/memory-game?autoplay=1",
  );
  await expect(page.getByText("Vào nhanh", { exact: true })).toHaveCount(4);

  const autoPlayToggle = page.getByTestId("hub-autopilot-toggle");
  await expect(autoPlayToggle).toHaveAttribute("aria-pressed", "true");

  // Verify first-visit onboarding is non-blocking (quick-play links stay enabled underneath) then dismiss (3 steps -> Done)
  const onboarding = page.getByRole("complementary", {
    name: "Hướng dẫn làm quen khu vực Giải trí",
  });
  await expect(onboarding).toBeVisible();
  await expect(owlQuickPlay).toBeEnabled();
  await expect(quickPlayLinks[1]).toBeEnabled();
  await expect(onboarding).toContainText("Hướng dẫn nhanh (1/3)");
  await onboarding.getByRole("button", { name: "Tiếp theo" }).click();
  await expect(onboarding).toContainText("Hướng dẫn nhanh (2/3)");
  await onboarding.getByRole("button", { name: "Tiếp theo" }).click();
  await expect(onboarding).toContainText("Hướng dẫn nhanh (3/3)");
  await onboarding.getByRole("button", { name: "Bé đã hiểu rồi!" }).click();
  await expect(onboarding).toHaveCount(0);

  // Multi-child switching via hub-child-selector
  const childSelector = page.getByTestId("hub-child-selector");
  await expect(childSelector).toBeVisible();
  await childSelector.selectOption(SECOND_CHILD_ID);
  await expect(page.getByTestId("hub-active-child-badge")).toContainText(
    `Hồ sơ ${SECOND_CHILD.alias} · Lớp ${SECOND_CHILD.grade}`,
  );
  await expect(page.getByText(/Chào Bé Bông!/)).toBeVisible();
  await expect(misreadWordChips).toContainText("thành công");
  expect(recommendedChildIds).toContain(SECOND_CHILD_ID);

  // Switch back to child 1 for consistent Hub AFTER screenshot
  await childSelector.selectOption(ids.child);
  await expect(page.getByTestId("hub-active-child-badge")).toContainText(
    `Hồ sơ ${child.alias} · Lớp ${child.grade}`,
  );

  await assertViewportHealth(page, `hub-${testInfo.project.name}`, [
    childSelector,
    owlQuickPlay,
    autoPlayToggle,
    ...quickPlayLinks,
    ...zoneLinks,
  ]);
  await saveAfterScreenshot(page, testInfo.project.name, "hub");

  // Sensory toggles (reducedMotion, calmSound, autoPlayFlow) + persistence across reload
  const hubSection = page.locator("section.activity-library");
  await expect(hubSection).toHaveAttribute("data-reduced-motion", "false");
  await expect(hubSection).toHaveAttribute("data-calm-sound", "true");
  await expect(hubSection).toHaveAttribute("data-auto-play-flow", "true");

  await autoPlayToggle.click();
  await expect(autoPlayToggle).toHaveAttribute("aria-pressed", "false");
  await expect(hubSection).toHaveAttribute("data-auto-play-flow", "false");

  const motionBtn = page.getByRole("button", { name: "Giảm chuyển động" });
  await motionBtn.click();
  await expect(
    page.getByRole("button", { name: "Đã giảm chuyển động" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(hubSection).toHaveAttribute("data-reduced-motion", "true");

  const soundBtn = page.getByRole("button", { name: "Âm thanh dịu" });
  await soundBtn.click();
  await expect(
    page.getByRole("button", { name: "Đang tắt tiếng" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(hubSection).toHaveAttribute("data-calm-sound", "false");
  await expect(hubSection).toHaveAttribute("data-sound-muted", "true");

  await page.reload();
  await expect(hubSection).toHaveAttribute("data-reduced-motion", "true");
  await expect(hubSection).toHaveAttribute("data-calm-sound", "false");
  await expect(hubSection).toHaveAttribute("data-auto-play-flow", "false");
  await expect(page.getByTestId("hub-autopilot-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Flow 2: Picture Description V4 (AI Teacher modes, scaffolding, voice controls)", async ({
  page,
}, testInfo) => {
  const base = await installApiFixture(page);
  await installVoiceAndTtsMock(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const catalog: PictureCatalogDTO = {
    focus_difficult_words: ["mèo mướp", "lấp lánh"],
    recommended_sample_key: "sunny-garden",
    recommended_book_page_id: null,
    samples: [
      {
        sample_key: "sunny-garden",
        title: "Khu vườn đầy nắng",
        theme: "Thiên nhiên",
        description: "Chú mèo mướp và chú bướm trong khu vườn đầy nắng.",
        image_url: "/images/picture-description/sunny-garden.jpg",
        matched_difficult_words: ["mèo mướp", "lấp lánh"],
      },
      {
        sample_key: "happy-classroom",
        title: "Lớp học vui vẻ",
        theme: "Trường học",
        description: "Các bạn nhỏ đang cùng đọc sách trong lớp.",
        image_url: "/images/picture-description/happy-classroom.jpg",
        matched_difficult_words: [],
      },
    ],
    book_pages: [
      {
        book_id: ids.book,
        book_title: "Câu chuyện từ API",
        page_id: PICTURE_BOOK_PAGE_ID,
        page_number: 1,
        image_url: "/images/picture-description/lakeside-picnic.jpg",
        matched_difficult_words: [],
      },
    ],
  };

  const sessionBase: PictureSessionDTO = {
    session_id: PICTURE_SESSION_ID,
    child_id: ids.child,
    child_grade: child.grade,
    source_type: "SAMPLE",
    sample_key: "sunny-garden",
    book_id: null,
    book_page_id: null,
    image_url: "/images/picture-description/sunny-garden.jpg",
    scene_title: "Khu vườn đầy nắng",
    status: "ACTIVE",
    best_stars: 0,
    best_score: 0,
    attempts_count: 0,
    teaching_mode: "OBSERVE",
    target_words: ["mèo mướp", "lấp lánh"],
    target_vocabulary: ["mèo mướp", "lấp lánh"],
    practiced_difficult_words: [],
    provider_tier: "GEMINI_PRIMARY",
    guide: {
      is_child_safe: true,
      scene_title: "Khu vườn đầy nắng",
      scene_summary: "Khu vườn tràn ngập ánh nắng với chú mèo mướp dễ thương.",
      guiding_questions: [
        "Trong khu vườn có những nhân vật hoặc con vật nào?",
        "Ánh nắng và hoa lá có màu sắc như thế nào?",
      ],
      suggested_vocabulary: [
        { word: "mèo mướp", hint: "Chú mèo có bộ lông vằn cam đáng yêu" },
        { word: "lấp lánh", hint: "Ánh nắng chiếu rực rỡ trên lá xanh" },
      ],
      model_sample_sentences: [
        "Trong khu vườn đầy nắng, chú mèo mướp đang nằm sưởi ấm bên khóm hoa vàng.",
      ],
      teaching_mode: "OBSERVE",
      target_words: ["mèo mướp", "lấp lánh"],
    },
    attempts: [],
    created_at: stamp,
    updated_at: stamp,
  };

  let evaluatePayload: Record<string, unknown> | null = null;
  let currentSession = sessionBase;

  await page
    .context()
    .route(
      "http://127.0.0.1:8000/games/picture-description/**",
      async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === "OPTIONS") {
          await respondJson(route, null, 204);
          return;
        }
        if (url.pathname === "/games/picture-description/catalog") {
          await respondJson(route, catalog);
          return;
        }
        if (
          url.pathname === "/games/picture-description/sessions" &&
          req.method() === "GET"
        ) {
          await respondJson(route, []);
          return;
        }
        if (
          url.pathname === "/games/picture-description/sessions" &&
          req.method() === "POST"
        ) {
          currentSession = sessionBase;
          await respondJson(route, currentSession);
          return;
        }
        if (
          url.pathname ===
            `/games/picture-description/sessions/${PICTURE_SESSION_ID}/evaluate` &&
          req.method() === "POST"
        ) {
          evaluatePayload = req.postDataJSON() as Record<string, unknown>;
          const attempt = {
            attempt_id: PICTURE_ATTEMPT_ID,
            attempt_number: 1,
            input_mode:
              (evaluatePayload.input_mode as "VOICE" | "TEXT") ?? "TEXT",
            transcript_text: String(evaluatePayload.transcript_text ?? ""),
            score_out_of_10: 9,
            stars: 3,
            evaluation_source: "AI" as const,
            provider_tier: "GEMINI_PRIMARY" as const,
            practiced_difficult_words: ["mèo mướp"],
            feedback: {
              is_relevant: true,
              score_out_of_10: 9,
              stars: 3,
              matched_details: ["Chú mèo mướp", "Ánh nắng vàng trong vườn"],
              missed_details: ["Chú bướm nhỏ bay cạnh bông hoa"],
              praise_message:
                "Tuyệt vời! Bé quan sát rất tinh tế và dùng từ gợi cảm!",
              improvement_tip: "Bé kể thêm xem chú bướm đang bay đi đâu nhé.",
              upgraded_sentences: [
                "Dưới ánh nắng vàng lấp lánh, chú mèo mướp nằm lim dim bên khóm hoa rực rỡ.",
              ],
              vocabulary_highlights: ["lim dim", "rực rỡ"],
              teaching_mode:
                (evaluatePayload.teaching_mode as PictureSessionDTO["teaching_mode"]) ??
                "SENTENCE",
              scaffolding_step: "EXPAND" as const,
              next_prompt_question:
                "Theo bé, chú mèo mướp sẽ làm gì tiếp theo khi thấy bạn bướm?",
              used_target_words: ["mèo mướp"],
              practiced_difficult_words: ["mèo mướp"],
              provider_tier: "GEMINI_PRIMARY" as const,
            },
            created_at: stamp,
          };
          currentSession = {
            ...sessionBase,
            attempts_count: 1,
            best_score: 9,
            best_stars: 3,
            practiced_difficult_words: ["mèo mướp"],
            attempts: [attempt],
          };
          await respondJson(route, {
            session: currentSession,
            latest_attempt: attempt,
            practiced_difficult_words: ["mèo mướp"],
          });
          return;
        }
        await route.fallback();
      },
    );

  await selectChildAndEnterEntertainment(page);
  await page.getByRole("link", { name: /Chọn tranh/i }).click();
  await expect(page).toHaveURL(
    /\/entertainment\/picture-description(?:\?focus=.*)?$/,
    {
      timeout: 30_000,
    },
  );

  await expect(
    page.getByRole("tab", { name: "Tranh chủ đề ViRead" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Tải ảnh từ máy" })).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Tranh từ sách ViRead" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("picture-catalog-autopilot-card"),
  ).toBeVisible();
  await expect(page.getByTestId("picture-quick-play-btn")).toBeVisible();

  await page
    .getByRole("button", { name: "Khám phá tranh này" })
    .first()
    .click();

  // Verify 6 AI Teacher pedagogical modes
  const modeGroup = page.getByTestId("teaching-mode-pills");
  await expect(modeGroup).toBeVisible();
  for (const label of [
    "Quan sát",
    "Từ vựng",
    "Ghép câu",
    "Kể chuyện",
    "Suy luận",
    "Sáng tạo",
  ]) {
    await expect(modeGroup.getByRole("button", { name: label })).toBeVisible();
  }
  await modeGroup.getByRole("button", { name: "Từ vựng" }).click();
  await expect(
    modeGroup.getByRole("button", { name: "Từ vựng" }),
  ).toHaveAttribute("aria-pressed", "true");
  await modeGroup.getByRole("button", { name: "Ghép câu" }).click();
  await expect(
    page.getByText(/Bé ghép chủ ngữ \+ hành động \+ nơi chốn/),
  ).toBeVisible();

  // Verify scaffolding (grade hints, target words, expandable guiding questions + vocab insertion)
  await expect(page.getByTestId("grade-hint-chips")).toBeVisible();
  await expect(page.getByTestId("target-words-panel")).toBeVisible();
  await page.getByRole("button", { name: "Mở gợi ý câu hỏi" }).click();
  await expect(
    page.getByText("Trong khu vườn có những nhân vật hoặc con vật nào?"),
  ).toBeVisible();

  // Verify voice controls (mic start -> live transcript -> stop -> STT transcription)
  await page.getByRole("button", { name: "Nói bằng Micro" }).click();
  await expect(page.getByTestId("live-voice-transcript")).toBeVisible();
  await page.evaluate(() => {
    const win = window as unknown as {
      __v4SpeechControl?: { emitTranscript: (text: string) => boolean };
    };
    win.__v4SpeechControl?.emitTranscript("Con mèo mướp đang nằm phơi nắng");
  });
  await expect(page.getByTestId("live-voice-transcript")).toContainText(
    "Con mèo mướp đang nằm phơi nắng",
  );
  await expect(
    page
      .getByTestId("target-words-panel")
      .locator('[data-word-matched="true"]'),
  ).toContainText("mèo mướp");
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();
  await expect(page.locator("#picture-description-input")).toHaveValue(
    /Con mèo mướp/,
  );

  // Verify TTS voice control button ("Nghe hướng dẫn")
  await page.getByRole("button", { name: "Nghe hướng dẫn" }).click();
  await assertViewportHealth(
    page,
    `picture-description-${testInfo.project.name}`,
    [
      page.getByRole("button", { name: "Gửi cô giáo AI chấm bài" }),
      page.getByRole("button", { name: "Nói bằng Micro" }),
    ],
  );
  await saveAfterScreenshot(page, testInfo.project.name, "picture-description");

  // Evaluate -> Result tab -> Scaffolding follow-up + practiced difficult words
  await page.getByRole("button", { name: "Gửi cô giáo AI chấm bài" }).click();
  await expect(
    page.getByText("Tuyệt vời! Bé quan sát rất tinh tế và dùng từ gợi cảm!"),
  ).toBeVisible();
  await expect(
    page.getByTestId("picture-practiced-difficult-words"),
  ).toContainText("mèo mướp");
  await expect(page.getByTestId("used-target-words-result")).toContainText(
    "mèo mướp",
  );
  await expect(page.getByTestId("ai-followup-question")).toContainText(
    "Mở rộng câu",
  );
  expect(evaluatePayload).toMatchObject({ teaching_mode: "SENTENCE" });

  await page.getByRole("button", { name: "Trả lời câu hỏi này" }).click();
  await expect(page.getByTestId("practice-followup-banner")).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Flow 3: Sentence Shooter V4 (<100ms projectile, 3 modes, zero UI lock under 500ms delayed POST)", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const base = await installApiFixture(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const shooterBook: SentenceShooterBookDTO = {
    id: SHOOTER_BOOK_ID,
    name: book.name,
    title: book.title,
    author: book.author,
    min_grade: 1,
    max_grade: 3,
    available_rounds: 5,
    matched_difficult_words: ["sách"],
  };

  const orderedTokens = [
    { id: SHOOTER_TOKEN_1, text: "Bé", is_difficult_word: false },
    { id: SHOOTER_TOKEN_2, text: "đọc", is_difficult_word: false },
    { id: SHOOTER_TOKEN_3, text: "sách.", is_difficult_word: true },
  ];

  const shooterSession: SentenceShooterSessionDTO = {
    session_id: SHOOTER_SESSION_ID,
    book: shooterBook,
    difficulty: "easy",
    learning_mode: "WORD_ORDER",
    total_rounds: 1,
    completed_rounds: 0,
    total_stars: 0,
    practiced_difficult_words: ["sách"],
    round: {
      round_id: SHOOTER_ROUND_ID,
      round_number: 1,
      token_count: 3,
      learning_mode: "WORD_ORDER",
      practiced_difficult_words: ["sách"],
      prompt_hint: "Ghép các từ thành câu hoàn chỉnh.",
      tokens: [orderedTokens[1], orderedTokens[0], orderedTokens[2]],
    },
  };

  let resolvedShots = 0;

  await page
    .context()
    .route("http://127.0.0.1:8000/games/sentence-shooter/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (url.pathname === "/games/sentence-shooter/books") {
        await respondJson(route, [shooterBook]);
        return;
      }
      if (
        url.pathname === "/games/sentence-shooter/sessions" &&
        req.method() === "POST"
      ) {
        await respondJson(route, shooterSession);
        return;
      }
      if (
        url.pathname ===
          `/games/sentence-shooter/sessions/${SHOOTER_SESSION_ID}/shots` &&
        req.method() === "POST"
      ) {
        const body = req.postDataJSON() as {
          token_id: string;
          client_shot_id?: string;
        };
        // Simulated >=500ms backend latency to prove non-blocking optimistic queue & <100ms projectile.
        await new Promise((resolve) => setTimeout(resolve, 650));
        const expected = orderedTokens[resolvedShots];
        const isCorrect = expected?.id === body.token_id;
        if (isCorrect) resolvedShots += 1;
        const roundCompleted = resolvedShots === orderedTokens.length;
        await respondJson(route, {
          is_correct: isCorrect,
          correct_count: resolvedShots,
          token_count: orderedTokens.length,
          mistakes_total: isCorrect ? 0 : 1,
          completed_rounds: roundCompleted ? 1 : 0,
          total_stars: roundCompleted ? 3 : 0,
          round_completed: roundCompleted,
          session_completed: roundCompleted,
          next_expected_position: resolvedShots,
          stars_awarded: roundCompleted ? 3 : 0,
          score: resolvedShots * 10,
          completed_sentence: roundCompleted ? "Bé đọc sách." : null,
          next_round: null,
          message: roundCompleted
            ? "Hoàn thành câu tuyệt vời!"
            : "Chính xác! Chọn từ tiếp theo nhé.",
          client_shot_id: body.client_shot_id ?? null,
          learning_mode: "WORD_ORDER",
          grammar_tip: roundCompleted
            ? "Câu trần thuật ngắn gồm chủ ngữ 'Bé' + vị ngữ 'đọc sách'."
            : null,
          practiced_difficult_words: ["sách"],
        });
        return;
      }
      if (
        url.pathname ===
        `/games/sentence-shooter/sessions/${SHOOTER_SESSION_ID}/result`
      ) {
        const result: SentenceShooterResultDTO = {
          session_id: SHOOTER_SESSION_ID,
          book: shooterBook,
          difficulty: "easy",
          learning_mode: "WORD_ORDER",
          status: "COMPLETED",
          total_rounds: 1,
          completed_rounds: 1,
          correct_count: 3,
          mistakes_total: 0,
          hint_count: 0,
          total_stars: 3,
          duration_seconds: 6,
          started_at: stamp,
          completed_at: stamp,
          practiced_difficult_words: ["sách"],
        };
        await respondJson(route, result);
        return;
      }
      await route.fallback();
    });

  await selectChildAndEnterEntertainment(page);
  await page.getByRole("link", { name: /Bắt đầu chơi/i }).click();
  await expect(page).toHaveURL(
    /\/entertainment\/sentence-shooter(?:\?focus=.*)?$/,
    {
      timeout: 30_000,
    },
  );

  // Verify V4.1 quick-start card, difficult-word badge, and autoplay toggle on lobby
  await expect(page.getByTestId("shooter-quick-start-card")).toBeVisible();
  await expect(page.getByTestId("shooter-quick-start-btn")).toContainText(
    "Bắt đầu ngay",
  );
  await expect(page.getByTestId("shooter-lobby-difficult-badge")).toContainText(
    "Ôn từ khó: sách",
  );
  await expect(page.getByTestId("shooter-autoplay-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Verify 3 learning modes on lobby
  const fillBlankBtn = page.getByRole("button", {
    name: /Điền từ vào chỗ trống/,
  });
  const grammarBtn = page.getByRole("button", { name: /Luyện ngữ pháp/ });
  const wordOrderBtn = page.getByRole("button", { name: /Xếp thứ tự từ/ });
  await fillBlankBtn.click();
  await expect(fillBlankBtn).toHaveAttribute("aria-pressed", "true");
  await grammarBtn.click();
  await expect(grammarBtn).toHaveAttribute("aria-pressed", "true");
  await wordOrderBtn.click();
  await expect(wordOrderBtn).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: new RegExp(book.title) }).click();
  await page.getByRole("button", { name: "Bắt đầu chơi" }).click();

  await expect(page.getByTestId("difficult-word-badge")).toBeVisible();

  const wordBank = page.getByRole("group", { name: "Các từ để ghép" });
  const token1Btn = wordBank.getByRole("button", { name: "Bé", exact: true });
  const token2Btn = wordBank.getByRole("button", { name: "đọc", exact: true });
  const token3Btn = wordBank.getByRole("button", {
    name: "sách.",
    exact: true,
  });

  // Measure DOM projectile feedback latency strictly inside browser (<100ms)
  await page.evaluate(() => {
    const state = { clickAt: 0, projectileAt: 0 };
    Object.defineProperty(window, "__shooterLatency", { value: state });
    document.addEventListener(
      "click",
      () => {
        if (state.clickAt === 0) state.clickAt = performance.now();
      },
      { capture: true },
    );
    const observer = new MutationObserver(() => {
      if (
        state.clickAt > 0 &&
        state.projectileAt === 0 &&
        document.querySelector('[data-testid="shot-projectile"]')
      ) {
        state.projectileAt = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  // Rapid tap 1 -> immediate in-flight state BEFORE >=500ms POST resolves, then rapid tap 2 (zero UI lock!)
  await token1Btn.click();
  await expect(token1Btn).toHaveAttribute("data-shot-state", "in-flight");

  await expect(token2Btn).toBeEnabled();
  await token2Btn.click();
  await expect(token2Btn).toHaveAttribute("data-shot-state", "in-flight");

  const latencyProbe = await page.evaluate(() => {
    const probe = (
      window as unknown as {
        __shooterLatency: { clickAt: number; projectileAt: number };
      }
    ).__shooterLatency;
    return probe;
  });
  expect(latencyProbe.clickAt).toBeGreaterThan(0);
  expect(latencyProbe.projectileAt).toBeGreaterThan(0);
  const latencyMs = latencyProbe.projectileAt - latencyProbe.clickAt;
  expect(latencyMs).toBeGreaterThanOrEqual(0);
  expect(latencyMs).toBeLessThan(100);

  // Wait for tokens 1 & 2 to confirm into sentence slots (removed from word bank)
  const sentenceSlots = page.getByRole("list", { name: "Các ô ghép câu" });
  await expect(
    sentenceSlots.getByRole("listitem", { name: "Ô 1: Bé" }),
  ).toBeVisible();
  await expect(
    sentenceSlots.getByRole("listitem", { name: "Ô 2: đọc" }),
  ).toBeVisible();
  await expect(token1Btn).toHaveCount(0);
  await expect(token2Btn).toHaveCount(0);

  await assertViewportHealth(
    page,
    `sentence-shooter-${testInfo.project.name}`,
    [token3Btn],
  );
  await saveAfterScreenshot(page, testInfo.project.name, "sentence-shooter");

  // Complete round 1 -> transitions to Result view
  await token3Btn.click();
  await expect(
    page.getByRole("heading", { name: /Giỏi quá, bé đã hoàn thành!/ }),
  ).toBeVisible();
  await expect(page.getByText("sách", { exact: true })).toBeVisible();
  await expect(page.getByText("Bé đọc sách.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Chơi lượt mới" }),
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Flow 4: Karaoke & Musical Karaoke Stage (modes, beat/pitch/rhythm UI, report timeline)", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const base = await installApiFixture(page);
  await installVoiceAndTtsMock(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const demoDir = path.resolve(process.cwd(), "..", "docs", "karaoke-demo");
  const demoMp3 = readFileSync(path.join(demoDir, "ngoi-sao-nho.mp3"));
  const demoLyrics = JSON.parse(
    readFileSync(path.join(demoDir, "ngoi-sao-nho-v2.json"), "utf8"),
  );
  const durationMs = 103366;
  const capturedSession: { body: Record<string, unknown> | null } = {
    body: null,
  };

  await page.context().route("https://media.example.test/**", async (route) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers().range ?? "",
    );
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(demoMp3.length - 1, Number(range[2]))
      : demoMp3.length - 1;
    await route.fulfill({
      status: range ? 206 : 200,
      contentType: "audio/mpeg",
      body: demoMp3.subarray(start, end + 1),
      headers: {
        "access-control-allow-origin": "*",
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${demoMp3.length}` }
          : {}),
      },
    });
  });

  await page
    .context()
    .route("http://127.0.0.1:8000/karaoke/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (url.pathname === "/karaoke/songs") {
        await respondJson(route, {
          items: [
            {
              song_id: songId,
              version_id: versionId,
              title: "Ngôi sao nhỏ",
              author: "Nhạc thiếu nhi",
              duration_ms: durationMs,
              min_grade: 1,
              max_grade: 3,
              cover_url: null,
              matched_difficult_words: ["trường", "vui"],
            },
          ],
          total: 1,
          limit: 12,
          offset: 0,
        });
        return;
      }
      if (url.pathname === `/karaoke/songs/${songId}/playback`) {
        const source = Object.fromEntries(
          Object.entries(previewDetail()).filter(([key]) => key !== "revision"),
        );
        await respondJson(route, {
          ...source,
          title: "Ngôi sao nhỏ",
          author: "Nhạc thiếu nhi",
          duration_ms: durationMs,
          version_id: versionId,
          lyrics: demoLyrics,
        });
        return;
      }
      if (url.pathname === `/karaoke/songs/${songId}/musical-profile`) {
        await respondJson(route, {
          song_id: songId,
          song_version_id: versionId,
          bpm: 108,
          audio_type: "VOCAL_FULL",
          has_pitch_contour: true,
          has_beat_grid: true,
          source_method: "AUDIO_DSP",
          beat_grid_ms: [1000, 1500, 2000, 2500, 3000, 6500, 7000, 7500],
          pitch_contour: [
            { time_ms: 1000, hz: 261.63, midi: 60 },
            { time_ms: 1500, hz: 293.66, midi: 62 },
            { time_ms: 2000, hz: 329.63, midi: 64 },
          ],
          phrase_windows: [{ start_ms: 1000, end_ms: 4000 }],
          updated_at: stamp,
        });
        return;
      }
      if (
        url.pathname === "/karaoke/practice-sessions" &&
        req.method() === "GET"
      ) {
        await respondJson(route, {
          child_id: ids.child,
          song_id: songId,
          best_full_song_score: 84,
          best_full_song_stars: 2,
          total_sessions: 1,
          items: [],
          storage_ready: true,
        });
        return;
      }
      if (
        url.pathname === "/karaoke/practice-sessions" &&
        req.method() === "POST"
      ) {
        const payload = req.postDataJSON() as Record<string, unknown>;
        capturedSession.body = payload;
        await respondJson(route, {
          id: KARAOKE_SESSION_ID,
          child_id: ids.child,
          song_id: songId,
          song_version_id: versionId,
          practice_mode: payload.practice_mode ?? "RHYTHM_TAP",
          scoring_mode: payload.scoring_mode ?? "RHYTHM_AND_LYRICS",
          playback_rate: Number(payload.playback_rate ?? 1),
          headphone_mode: Boolean(payload.headphone_mode),
          overall_score: (payload.overall_score as number | null) ?? 85,
          rhythm_score: (payload.rhythm_score as number | null) ?? 85,
          pitch_score: (payload.pitch_score as number | null) ?? null,
          lyrics_score: (payload.lyrics_score as number | null) ?? null,
          fluency_score: (payload.fluency_score as number | null) ?? 85,
          stars: Number(payload.stars ?? 3),
          segment_start_ms: null,
          segment_end_ms: null,
          report_payload:
            (payload.report_payload as Record<string, unknown>) ?? {},
          created_at: stamp,
          persisted: true,
        });
        return;
      }
      await route.fallback();
    });

  await selectChildAndEnterEntertainment(page);
  await page.getByRole("link", { name: /Mở thư viện bài hát/i }).click();
  await expect(page).toHaveURL(/\/karaoke(?:\?focus=.*)?$/, {
    timeout: 30_000,
  });
  await expect(page.getByRole("heading", { name: "Ngôi sao nhỏ" })).toBeVisible(
    { timeout: 30_000 },
  );

  // V4.1 Karaoke Library: boost hint, "Ôn từ khó" chips, 1-tap "Hát ngay" (?autoplay=1&scored=1)
  await expect(
    page.getByTestId("karaoke-difficult-words-boost-hint"),
  ).toBeVisible();
  const karaokeWordBadge = page.getByTestId("karaoke-song-difficult-words");
  await expect(karaokeWordBadge).toBeVisible();
  await expect(karaokeWordBadge).toContainText("Ôn từ khó:");
  await expect(karaokeWordBadge).toContainText("trường");
  await expect(karaokeWordBadge).toContainText("vui");
  const singNowLink = page.getByRole("link", { name: "Hát ngay", exact: true });
  await expect(singNowLink).toHaveAttribute(
    "href",
    new RegExp(
      `^/karaoke/${songId}\\?version=${versionId}&autoplay=1&scored=1(?:&focus=.+)?$`,
    ),
  );

  await assertViewportHealth(page, `karaoke-${testInfo.project.name}`, [
    singNowLink,
    page.getByRole("link", { name: "Hát bài Ngôi sao nhỏ", exact: true }),
  ]);
  await saveAfterScreenshot(page, testInfo.project.name, "karaoke");

  await page
    .getByRole("link", { name: "Hát bài Ngôi sao nhỏ", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/karaoke/${songId}`), {
    timeout: 30_000,
  });

  const stage = page.getByRole("region", { name: "Hát cùng bé", exact: true });
  await expect(stage).toBeVisible({ timeout: 30_000 });

  // Verify all 4 Musical Practice Mode switcher buttons
  const practiceGroup = stage.getByRole("group", { name: "Kiểu luyện hát" });
  const fullSongBtn = practiceGroup.getByRole("button", {
    name: "Hát cả bài",
  });
  const segmentBtn = practiceGroup.getByRole("button", {
    name: "Luyện đoạn khó",
  });
  const linePracticeBtn = practiceGroup.getByRole("button", {
    name: "Tập từng câu",
  });
  const rhythmTapBtn = practiceGroup.getByRole("button", {
    name: "Gõ nhịp theo bài hát",
  });
  await expect(fullSongBtn).toHaveAttribute("aria-pressed", "true");

  // Scored mode reveals headphone / speaker-filter / DSP notice UI
  await stage.getByRole("button", { name: "Hát có chấm điểm" }).click();
  await expect(
    stage.getByText(/Khuyên dùng tai nghe để chấm cao độ và nhịp điệu/),
  ).toBeVisible();
  await expect(
    stage.getByRole("button", { name: /Bật nhạc đệm qua loa/ }),
  ).toBeVisible();

  // Switch through SEGMENT and LINE_PRACTICE
  await segmentBtn.click();
  await expect(segmentBtn).toHaveAttribute("aria-pressed", "true");
  await expect(stage.getByRole("combobox", { name: "Tốc độ hát" })).toHaveValue(
    "0.85",
  );

  await linePracticeBtn.click();
  await expect(linePracticeBtn).toHaveAttribute("aria-pressed", "true");

  // Return to FULL_SONG (free mode for safe seek + syllable highlight capture)
  await fullSongBtn.click();
  await stage.getByRole("button", { name: "Hát tự do" }).click();

  const seekSlider = stage.getByRole("slider", { name: "Vị trí phát" });
  await expect(seekSlider).toBeEnabled();
  await seekSlider.evaluate((node) => {
    (node as HTMLInputElement).value = "1416";
  });
  await seekSlider.press("ArrowRight");
  await expect(seekSlider).toHaveValue("1417");
  await expect(
    stage.locator('[data-testid="karaoke-active-line"] [data-state="active"]'),
  ).toHaveCount(1);

  await assertViewportHealth(page, `karaoke-stage-${testInfo.project.name}`, [
    fullSongBtn,
    rhythmTapBtn,
  ]);
  await saveAfterScreenshot(page, testInfo.project.name, "karaoke-stage");

  // Switch to RHYTHM_TAP, start playing, tap rhythm, and verify report timeline
  await rhythmTapBtn.click();
  await expect(rhythmTapBtn).toHaveAttribute("aria-pressed", "true");
  await stage.getByRole("button", { name: /^(Bắt đầu hát|Hát tiếp)$/ }).click();
  await expect(
    stage.getByRole("button", { name: "Tạm dừng", exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  const tapButton = stage.getByRole("button", {
    name: "Gõ nhịp theo bài hát (Phím Cách)",
  });
  await expect(tapButton).toBeEnabled();
  await tapButton.click();
  await expect(stage.getByTestId("karaoke-rhythm-tap-feedback")).toBeVisible();
  await page.waitForTimeout(400);
  await tapButton.click();
  await page.waitForTimeout(400);
  await tapButton.click();

  await stage
    .getByRole("button", { name: "Kết thúc & chấm điểm", exact: true })
    .click();
  const musicalSummary = stage.getByTestId("karaoke-musical-summary");
  await expect(musicalSummary).toBeVisible();
  await expect(stage.getByTestId("karaoke-scoring-mode-badge")).toBeVisible();
  await expect(
    musicalSummary.getByText(/Báo cáo theo từng đoạn/),
  ).toBeVisible();
  await musicalSummary.getByText(/Báo cáo theo từng đoạn/).click();
  await expect(musicalSummary.getByText(/^Câu 1 \(/)).toBeVisible();
  expect(capturedSession.body?.practice_mode).toBe("RHYTHM_TAP");

  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Flow 5: Admin Karaoke Simple Mode V4 (1-MP3 upload, auto extract, Review by Exception, compliance gate, Advanced Mode)", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const base = await installApiFixture(page);
  await setRole(page, "admin");
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const demoDir = path.resolve(process.cwd(), "..", "docs", "karaoke-demo");
  const demoMp3 = readFileSync(path.join(demoDir, "ngoi-sao-nho.mp3"));
  const baseDetail = songDetail();
  const lyrics2Lines = {
    format_version: 2 as const,
    lines: [
      {
        id: lineId,
        text: "Em vui đến trường",
        start_ms: 1000,
        end_ms: 4000,
        syllables: [
          {
            id: "44444444-4444-4444-8444-444444444411",
            text: "Em",
            start_ms: 1000,
            end_ms: 1700,
          },
          {
            id: "44444444-4444-4444-8444-444444444412",
            text: "vui",
            start_ms: 1700,
            end_ms: 2400,
          },
          {
            id: "44444444-4444-4444-8444-444444444413",
            text: "đến",
            start_ms: 2400,
            end_ms: 3100,
          },
          {
            id: "44444444-4444-4444-8444-444444444414",
            text: "trường",
            start_ms: 3100,
            end_ms: 4000,
          },
        ],
      },
      {
        id: "33333333-3333-4333-8333-333333333339",
        text: "Ngôi sao sáng trên trời",
        start_ms: 4200,
        end_ms: 7800,
        syllables: [
          {
            id: "44444444-4444-4444-8444-444444444421",
            text: "Ngôi",
            start_ms: 4200,
            end_ms: 4900,
          },
          {
            id: "44444444-4444-4444-8444-444444444422",
            text: "sao",
            start_ms: 4900,
            end_ms: 5600,
          },
          {
            id: "44444444-4444-4444-8444-444444444423",
            text: "sáng",
            start_ms: 5600,
            end_ms: 6300,
          },
          {
            id: "44444444-4444-4444-8444-444444444424",
            text: "trên",
            start_ms: 6300,
            end_ms: 7000,
          },
          {
            id: "44444444-4444-4444-8444-444444444425",
            text: "trời",
            start_ms: 7000,
            end_ms: 7800,
          },
        ],
      },
    ],
  };
  baseDetail.draft = {
    ...baseDetail.draft!,
    title: "Ngôi sao nhỏ",
    author: "Nhạc thiếu nhi",
    duration_ms: 103366,
    has_cover: true,
    lyrics: lyrics2Lines,
  };

  await page.context().route("https://media.example.test/**", async (route) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers().range ?? "",
    );
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(demoMp3.length - 1, Number(range[2]))
      : demoMp3.length - 1;
    await route.fulfill({
      status: range ? 206 : 200,
      contentType: "audio/mpeg",
      body: demoMp3.subarray(start, end + 1),
      headers: {
        "access-control-allow-origin": "*",
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${demoMp3.length}` }
          : {}),
      },
    });
  });

  await page
    .context()
    .route("http://127.0.0.1:8000/karaoke/admin/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (url.pathname === "/karaoke/admin/processing-capabilities") {
        await respondJson(route, {
          enabled: true,
          configured: true,
          supported_modes: ["VOCAL_TRACK", "INSTRUMENTAL_WITH_REFERENCE"],
          unavailable_reason: null,
          limits: {
            max_audio_bytes: 20971520,
            max_duration_ms: 300000,
            max_lyric_lines: 300,
            max_lyric_characters: 50000,
          },
          queue_warning_after_seconds: 120,
        });
        return;
      }
      if (
        url.pathname === "/karaoke/admin/songs/simple-import" &&
        req.method() === "POST"
      ) {
        await respondJson(route, {
          song_id: songId,
          version_id: versionId,
          revision: 1,
          title: "Ngôi sao nhỏ",
          author: "Nhạc thiếu nhi",
          duration_ms: 103366,
          has_cover: true,
          audio_type: "VOCAL_FULL",
          bpm: 108,
          lyrics_source: "EMBEDDED_SYNCED",
          lyrics_line_count: 2,
          flagged_lines: [
            {
              line_id: lineId,
              line_index: 0,
              text: "Em vui đến trường",
              flag: "NEEDS_REVIEW",
              reason: "Kiểm tra chính tả dòng vừa tách tự động.",
              avg_logprob: -0.62,
              no_speech_prob: 0.05,
            },
            {
              line_id: "33333333-3333-4333-8333-333333333339",
              line_index: 1,
              text: "Ngôi sao sáng trên trời",
              flag: "NEEDS_TIMING_CHECK",
              reason: "Kiểm tra mốc vào nhịp câu thứ 2.",
              avg_logprob: -0.25,
              no_speech_prob: 0.02,
            },
          ],
          requires_lyrics_input: false,
          guidance_vi:
            "Đã trích xuất metadata và 2 dòng lời; hãy rà soát 2 dòng được đánh dấu.",
          ready_to_publish: false,
          missing_checks: ["rights_confirmed", "child_safe_confirmed"],
          lifecycle_state: "UPLOADED",
          worker_online: true,
          processing_queued: false,
          processing_job_id: SIMPLE_JOB_ID,
          processing_notice: "Sẵn sàng kiểm tra nhanh và xuất bản tức thì.",
          song: baseDetail,
        });
        return;
      }
      if (url.pathname === `/karaoke/admin/songs/${songId}/draft/preview`) {
        await respondJson(route, {
          ...previewDetail(),
          song_id: songId,
          version_id: versionId,
          revision: 1,
          title: "Ngôi sao nhỏ",
          author: "Nhạc thiếu nhi",
          duration_ms: 103366,
          lyrics: lyrics2Lines,
        });
        return;
      }
      if (url.pathname === `/karaoke/admin/songs/${songId}/simple-publish`) {
        const body = req.postDataJSON() as {
          rights_confirmed: boolean;
          child_safe_confirmed: boolean;
        };
        expect(body.rights_confirmed).toBe(true);
        expect(body.child_safe_confirmed).toBe(true);
        await respondJson(route, {
          ...baseDetail,
          revision: 2,
          status: "PUBLISHED",
          published: { ...baseDetail.draft!, state: "PUBLISHED" },
          draft: null,
        });
        return;
      }
      if (
        url.pathname === `/karaoke/admin/songs/${songId}` &&
        req.method() === "GET"
      ) {
        await respondJson(route, baseDetail);
        return;
      }
      await route.fallback();
    });

  await page.goto("/admin/karaoke/new");
  await expect(
    page.getByRole("heading", { name: "Thêm nhanh 1 file MP3" }),
  ).toBeVisible();

  // Verify Advanced Mode toggle (switch to Advanced -> switch back to Simple)
  await page.getByRole("button", { name: "Chỉnh sửa nâng cao" }).click();
  await expect(
    page.getByRole("heading", { name: "1. Thông tin bài hát" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Quay lại Thêm nhanh 1 file MP3" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Thêm nhanh 1 file MP3" }),
  ).toBeVisible();

  // Upload 1 MP3 file -> auto title extraction & client audio classification
  await page.getByLabel("Chọn file nhạc MP3").setInputFiles({
    name: "01 - Ngoi Sao Nho (Official).mp3",
    mimeType: "audio/mpeg",
    buffer: demoMp3,
  });
  await expect(page.getByTestId("audio-type-badge")).toBeVisible();
  await expect(page.getByLabel("Tên bài hát gợi ý")).toHaveValue(
    "Ngoi Sao Nho",
  );

  await page.getByRole("button", { name: "Tự động tạo karaoke" }).click();

  // Step 2: Auto metadata/lyrics extraction + Review by Exception
  await expect(
    page.getByRole("heading", {
      name: /Bước 2 — Kiểm tra nhanh/,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("simple-pipeline-card")).toBeVisible();
  await expect(page.getByText("Đã tự tách ảnh bìa MP3")).toBeVisible();
  await expect(
    page.getByText(/Có 2 dòng cần kiểm tra nhanh \(Review by Exception\)/),
  ).toBeVisible();
  await expect(page.getByLabel("Sửa nhanh dòng 1")).toHaveValue(
    "Em vui đến trường",
  );

  // Step 3: Compliance checkboxes start UNCHECKED and block publish until both checked
  const rightsBox = page.getByRole("checkbox", {
    name: "Tôi xác nhận quyền sử dụng bài hát phù hợp",
  });
  const childSafeBox = page.getByRole("checkbox", {
    name: "Tôi xác nhận nội dung phù hợp trẻ em lớp 1–5",
  });
  const publishBtn = page.getByRole("button", { name: "Xuất bản ngay" });

  await expect(rightsBox).not.toBeChecked();
  await expect(childSafeBox).not.toBeChecked();
  await expect(publishBtn).toBeDisabled();

  await assertViewportHealth(page, `admin-karaoke-${testInfo.project.name}`, [
    publishBtn,
  ]);
  await saveAfterScreenshot(page, testInfo.project.name, "admin-karaoke");

  await rightsBox.check();
  await expect(publishBtn).toBeDisabled();
  await childSafeBox.check();
  await expect(publishBtn).toBeEnabled();

  await publishBtn.click();
  await expect(
    page.getByText("Đã xuất bản bài hát", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Về danh sách bài hát" }),
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Flow 6: Memory Game V4 (theme/timer, SVG render, post-render timer start, hide/recall, hints, spotlight)", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const base = await installApiFixture(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const themesCatalog: MemoryThemesCatalogDTO = {
    themes: [
      {
        theme_key: "sunny_garden",
        name_vi: "Khu vườn nắng ấm",
        description_vi: "Chú mèo mướp, bướm vàng và hoa hướng dương.",
        badge_vi: "Quen thuộc",
        accent_hex: "#F59E0B",
        sprite_count: 7,
        sample_items_vi: ["mèo mướp", "bướm", "hoa hướng dương"],
      },
      {
        theme_key: "happy_classroom",
        name_vi: "Lớp học vui vẻ",
        description_vi: "Sách mở, hộp bút và quả địa cầu.",
        badge_vi: "Trường học",
        accent_hex: "#3B82F6",
        sprite_count: 7,
        sample_items_vi: ["sách mở", "hộp bút"],
      },
    ],
    timer_options: [
      {
        mode: "20S",
        seconds: 20,
        label_vi: "20 giây",
        recommended_for_vi: "Nhịp vừa phải",
      },
      {
        mode: "30S",
        seconds: 30,
        label_vi: "30 giây",
        recommended_for_vi: "Phù hợp Lớp 1–3",
      },
      {
        mode: "UNLIMITED",
        seconds: null,
        label_vi: "Không giới hạn",
        recommended_for_vi: "Không áp lực",
      },
    ],
    grade_recommendations: [
      {
        grade: 2,
        min_objects: 3,
        max_objects: 5,
        recommended_timer: "30S",
        recommended_recall_mode: "FREE_RECALL",
        recommended_difficulty: 2,
        note_vi: "Gợi ý Lớp 2: quan sát 30 giây và nhớ màu sắc + vị trí.",
      },
    ],
    total_sprites: 42,
    focus_difficult_words: ["mèo mướp", "hoa hướng dương"],
    recommended_theme_key: "sunny_garden",
  };

  const catObj = {
    id: "obj-cat",
    sprite_key: "tabby_cat",
    name_vi: "mèo mướp",
    category_vi: "con vật",
    aliases_vi: ["mèo", "con mèo"],
    color_vi: "cam" as const,
    color_hex: "#FB923C",
    color_stroke_hex: "#9A3412",
    color_light_hex: "#FED7AA",
    shape_cue: "circle" as const,
    count: 1,
    position_zone: "dưới trái" as const,
    bbox: { x: 0.12, y: 0.62, w: 0.2, h: 0.24 },
    action_vi: "đang nằm sưởi nắng",
    hint_tiers: {
      tier_1: "Ở góc dưới trái có một người bạn bốn chân lông màu cam.",
      tier_2: "Bạn ấy kêu meo meo và thích nằm sưởi nắng.",
      tier_3: "Đó là chú mèo mướp màu cam ở dưới trái!",
    },
    is_focus_word: true,
  };

  const flowerObj = {
    id: "obj-flower",
    sprite_key: "sunflower",
    name_vi: "hoa hướng dương",
    category_vi: "thực vật",
    aliases_vi: ["hoa vàng"],
    color_vi: "vàng" as const,
    color_hex: "#FACC15",
    color_stroke_hex: "#854D0E",
    color_light_hex: "#FEF08A",
    shape_cue: "star" as const,
    count: 2,
    position_zone: "dưới phải" as const,
    bbox: { x: 0.66, y: 0.58, w: 0.22, h: 0.26 },
    action_vi: "đang nở rộ đón nắng",
    hint_tiers: {
      tier_1: "Ở góc dưới phải có 2 bông hoa lớn màu vàng.",
      tier_2: "Loài hoa này luôn hướng về phía mặt trời.",
      tier_3: "Đó là 2 bông hoa hướng dương màu vàng ở dưới phải!",
    },
    is_focus_word: false,
  };

  const memorySessionBase: MemorySessionDTO = {
    id: MEMORY_SESSION_ID,
    child_id: ids.child,
    child_grade: child.grade,
    theme_key: "sunny_garden",
    theme_name_vi: "Khu vườn nắng ấm",
    difficulty_level: 2,
    scene_seed: 42,
    timer_mode: "20S",
    timer_seconds: 20,
    recall_mode: "GUIDED_RECALL",
    status: "OBSERVING",
    hints_used: 0,
    peek_count: 0,
    best_factual_score: 0,
    best_creative_score: 0,
    stars: 0,
    attempts_count: 0,
    focus_words: ["mèo mướp"],
    scene_spec: {
      schema_version: "1.0",
      theme_key: "sunny_garden",
      theme_name_vi: "Khu vườn nắng ấm",
      child_grade: child.grade,
      difficulty_level: 2,
      scene_seed: 42,
      canvas_width: 800,
      canvas_height: 500,
      backdrop: {
        theme_key: "sunny_garden",
        sky_top_hex: "#E0F2FE",
        sky_bottom_hex: "#FEF9C3",
        horizon_hex: "#BBF7D0",
        ground_hex: "#86EFAC",
        accent_hex: "#F59E0B",
        mood_vi: "Buổi sáng trong lành đầy nắng ấm",
      },
      objects: [catObj, flowerObj],
      observation_tips_vi: [
        "Nhìn từ góc dưới trái sang góc dưới phải để nhớ vị trí từng vật.",
      ],
      guided_questions_vi: [
        "Ở góc dưới trái có con vật gì màu cam?",
        "Ở góc dưới phải có mấy bông hoa màu vàng?",
      ],
      creative_prompt_vi:
        "Theo bé, chú mèo mướp sẽ rủ ai cùng chơi trốn tìm trong khu vườn?",
      matched_focus_words: ["mèo mướp"],
    },
    attempts: [],
    created_at: stamp,
    updated_at: stamp,
  };

  await page
    .context()
    .route("http://127.0.0.1:8000/games/memory/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (url.pathname === "/games/memory/themes") {
        await respondJson(route, themesCatalog);
        return;
      }
      if (url.pathname === "/games/memory/sessions" && req.method() === "GET") {
        await respondJson(route, []);
        return;
      }
      if (
        url.pathname === "/games/memory/sessions" &&
        req.method() === "POST"
      ) {
        await respondJson(route, memorySessionBase);
        return;
      }
      if (url.pathname === `/games/memory/sessions/${MEMORY_SESSION_ID}/hint`) {
        await respondJson(route, {
          session_id: MEMORY_SESSION_ID,
          hints_used: 1,
          object_id: flowerObj.id,
          tier: 1,
          hint_text_vi: flowerObj.hint_tiers.tier_1,
          remaining_unmentioned_count: 1,
          has_more_tiers: true,
        });
        return;
      }
      if (
        url.pathname ===
          `/games/memory/sessions/${MEMORY_SESSION_ID}/attempts` &&
        req.method() === "POST"
      ) {
        const body = req.postDataJSON() as { stage: "RECALL" | "CREATIVE" };
        if (body.stage === "RECALL") {
          const evalRecall = {
            stage: "RECALL" as const,
            factual_score: 75,
            creative_score: 0,
            stars: 2,
            matched_facts: [
              {
                object_id: catObj.id,
                sprite_key: catObj.sprite_key,
                name_vi: catObj.name_vi,
                color_vi: catObj.color_vi,
                count: catObj.count,
                position_zone: catObj.position_zone,
                matched_attributes: ["tên", "màu", "vị trí"],
                detail_vi: "1 mèo mướp cam ở dưới trái",
                bbox: catObj.bbox,
              },
            ],
            missed_facts: [
              {
                object_id: flowerObj.id,
                sprite_key: flowerObj.sprite_key,
                name_vi: flowerObj.name_vi,
                color_vi: flowerObj.color_vi,
                count: flowerObj.count,
                position_zone: flowerObj.position_zone,
                detail_vi: "2 hoa hướng dương vàng ở dưới phải",
                hint_tier_1: flowerObj.hint_tiers.tier_1,
                bbox: flowerObj.bbox,
              },
            ],
            creative_highlights: [],
            story_anchors: [],
            praise_message_vi: "Bé nhớ rất chính xác chú mèo mướp màu cam!",
            story_praise_vi:
              "Hãy cùng mở tranh đối chiếu và kể tiếp câu chuyện!",
            next_tip_vi:
              "Chạm vào thẻ màu vàng để phóng sáng chi tiết bị bỏ lỡ.",
            creative_followup_vi:
              "Chú mèo mướp sẽ rủ ai chơi tiếp trong khu vườn?",
            support_summary_vi: "Bé đã dùng 1 gợi ý nhẹ nhàng.",
            used_focus_words: ["mèo mướp"],
            practiced_difficult_words: ["mèo mướp"],
            focus_word_feedback_vi: "Bé đã dùng trúng từ khó mèo mướp!",
            ai_provider: "deterministic",
          };
          const attempt = {
            id: MEMORY_ATTEMPT_RECALL_ID,
            session_id: MEMORY_SESSION_ID,
            attempt_number: 1,
            stage: "RECALL" as const,
            input_mode: "TEXT" as const,
            response_text: "Có một chú mèo mướp màu cam nằm ở góc dưới trái.",
            factual_score: 75,
            creative_score: 0,
            stars: 2,
            evaluation: evalRecall,
            ai_provider: "deterministic",
            created_at: stamp,
          };
          await respondJson(route, {
            attempt,
            session: {
              ...memorySessionBase,
              status: "CREATIVE",
              hints_used: 1,
              best_factual_score: 75,
              stars: 2,
              attempts_count: 1,
              attempts: [attempt],
            },
          });
          return;
        }

        const evalCreative = {
          stage: "CREATIVE" as const,
          factual_score: 75,
          creative_score: 92,
          stars: 3,
          matched_facts: [],
          missed_facts: [],
          creative_highlights: ["Tưởng tượng hội thoại vui giữa mèo và hoa"],
          story_anchors: ["mèo mướp"],
          praise_message_vi: "Câu chuyện của bé thật giàu trí tưởng tượng!",
          story_praise_vi: "Bé tạo được câu chuyện ấm áp và rất tự nhiên!",
          next_tip_vi: "Tiếp tục thử chủ đề mới nhé!",
          creative_followup_vi: "",
          support_summary_vi: null,
          used_focus_words: ["mèo mướp"],
          ai_provider: "gemini",
        };
        const attempt = {
          id: MEMORY_ATTEMPT_CREATIVE_ID,
          session_id: MEMORY_SESSION_ID,
          attempt_number: 2,
          stage: "CREATIVE" as const,
          input_mode: "TEXT" as const,
          response_text:
            "Chú mèo mướp chào hai bông hoa hướng dương rồi cùng chạy chơi.",
          factual_score: 75,
          creative_score: 92,
          stars: 3,
          evaluation: evalCreative,
          ai_provider: "gemini",
          created_at: stamp,
        };
        await respondJson(route, {
          attempt,
          session: {
            ...memorySessionBase,
            status: "COMPLETED",
            hints_used: 1,
            best_factual_score: 75,
            best_creative_score: 92,
            stars: 3,
            attempts_count: 2,
            attempts: [attempt],
          },
        });
        return;
      }
      await route.fallback();
    });

  await selectChildAndEnterEntertainment(page);
  await page.getByRole("link", { name: /Khám phá trí nhớ/i }).click();
  await expect(page).toHaveURL(/\/entertainment\/memory-game(?:\?focus=.*)?$/, {
    timeout: 30_000,
  });

  await expect(
    page.getByRole("heading", { name: "Bé nhớ được gì?" }),
  ).toBeVisible();
  await expect(page.getByTestId("memory-quick-play-card")).toContainText(
    "mèo mướp",
  );
  await expect(page.getByTestId("memory-quick-play-btn")).toContainText(
    "Chơi ngay (Ôn từ khó)",
  );
  await expect(page.getByTestId("memory-autopilot-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: /Khu vườn nắng ấm/ }).click();
  await page.getByTestId("timer-option-20S").click();
  await page.getByRole("button", { name: /Kể có câu hỏi gợi mở/ }).click();
  await page.getByTestId("start-memory-game-btn").click();

  // Stage OBSERVE: SVG renders, then timer starts ticking strictly post-render
  await expect(page.getByTestId("observe-stage")).toBeVisible();
  const svg = page.getByTestId("memory-scene-svg");
  await expect(svg).toHaveAttribute("data-scene-ready", "true");
  const countdownEl = page.getByTestId("countdown-seconds");
  await expect(countdownEl).toHaveText(/20 giây|19 giây/);
  await expect(countdownEl).toHaveText("19 giây", { timeout: 3000 });

  await assertViewportHealth(page, `memory-game-${testInfo.project.name}`, [
    page.getByTestId("finish-observe-btn"),
  ]);
  await saveAfterScreenshot(page, testInfo.project.name, "memory-game");

  // Stage RECALL: hidden SVG curtain + progressive hint
  await page.getByTestId("finish-observe-btn").click();
  await expect(page.getByTestId("recall-stage")).toBeVisible();
  await expect(page.getByTestId("scene-hidden-curtain")).toBeVisible();
  await expect(page.getByTestId("memory-scene-svg")).toHaveCount(0);

  await page.getByTestId("request-hint-btn").click();
  await expect(page.getByTestId("memory-hint-card")).toContainText(
    flowerObj.hint_tiers.tier_1,
  );

  await page
    .getByTestId("recall-textarea")
    .fill("Có một chú mèo mướp màu cam nằm ở góc dưới trái.");
  await page.getByTestId("submit-recall-btn").click();

  // Stage REVEAL: spotlight highlights, interactive fact pills & practiced difficult words
  await expect(page.getByTestId("reveal-stage")).toBeVisible();
  await expect(page.getByTestId("reveal-practiced-words")).toContainText(
    "mèo mướp",
  );
  await expect(page.getByTestId("reveal-practiced-words")).toContainText(
    "Bé đã dùng trúng từ khó mèo mướp!",
  );
  await expect(page.getByTestId("reveal-play-new-btn")).toBeVisible();
  await expect(page.getByTestId("factual-score-card")).toContainText("75/100");
  await expect(page.getByTestId("memory-spotlight-focus")).toBeVisible();
  await expect(page.getByTestId("spotlight-caption")).toContainText(
    "hoa hướng dương",
  );
  await page.getByTestId(`matched-fact-${catObj.id}`).click();
  await expect(page.getByTestId("spotlight-caption")).toContainText("mèo mướp");

  // Stage CREATIVE -> SUMMARY dual-track feedback
  await page.getByTestId("go-creative-stage-btn").click();
  await expect(page.getByTestId("creative-stage")).toBeVisible();
  await page
    .getByTestId("creative-textarea")
    .fill("Chú mèo mướp chào hai bông hoa hướng dương rồi cùng chạy chơi.");
  await page.getByTestId("submit-creative-btn").click();

  await expect(page.getByTestId("summary-stage")).toBeVisible();
  await expect(page.getByTestId("factual-score-value")).toHaveText("75/100");
  await expect(page.getByTestId("creative-score-value")).toHaveText("92/100");

  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Flow 7: Parent Progress Report with non-diagnostic EntertainmentLearningSummary", async ({
  page,
}, testInfo) => {
  const base = await installApiFixture(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const analytics: ParentEntertainmentAnalyticsDTO = {
    child_id: ids.child,
    child_alias: child.alias,
    child_grade: child.grade,
    window_days: 30,
    is_diagnostic: false,
    disclaimer_vi:
      "Báo cáo này tổng hợp hoạt động Học mà Chơi để hỗ trợ luyện đọc tại nhà, không phải đánh giá hay chẩn đoán y khoa.",
    observed_skills_count: 2,
    estimated_skills_count: 1,
    unknown_skills_count: 1,
    skills: [
      {
        skill_key: "sentence_ordering",
        label_vi: "Sắp xếp trật tự câu tiếng Việt",
        domain: "LANGUAGE_GRAMMAR",
        status: "OBSERVED",
        mastery_pct: 88,
        confidence: 0.9,
        evidence_count: 6,
        high_confidence_count: 5,
        last_observed_at: stamp,
        source_modules: ["SENTENCE_SHOOTER"],
      },
      {
        skill_key: "picture_vocabulary",
        label_vi: "Vốn từ miêu tả tranh",
        domain: "READING_WORDS",
        status: "OBSERVED",
        mastery_pct: 82,
        confidence: 0.85,
        evidence_count: 4,
        high_confidence_count: 3,
        last_observed_at: stamp,
        source_modules: ["PICTURE_DESCRIPTION"],
      },
      {
        skill_key: "rhythm_timing",
        label_vi: "Giữ nhịp & tiết tấu",
        domain: "MUSIC_RHYTHM",
        status: "ESTIMATED",
        mastery_pct: 76,
        confidence: 0.55,
        evidence_count: 2,
        high_confidence_count: 1,
        last_observed_at: stamp,
        source_modules: ["KARAOKE"],
      },
      {
        skill_key: "visual_memory_creative",
        label_vi: "Ghi nhớ chi tiết & sáng tạo",
        domain: "OBSERVATION_MEMORY_CREATIVITY",
        status: "UNKNOWN",
        mastery_pct: null,
        confidence: 0,
        evidence_count: 0,
        high_confidence_count: 0,
        last_observed_at: null,
        source_modules: [],
      },
    ],
    practiced_difficult_words: [
      {
        normalized_word: "meo muop",
        display_text: "mèo mướp",
        priority_score: 0.85,
        practice_count: 3,
        last_practiced_at: stamp,
        days_since_practice: 1,
        recommended_game: "PICTURE_DESCRIPTION",
        reason_vi: "Bé vừa ôn qua trò chơi Kể chuyện qua tranh",
      },
    ],
    module_activities: [
      {
        game_key: "PICTURE_DESCRIPTION",
        title_vi: "Kể chuyện qua tranh",
        sessions_count: 3,
        recent_average_pct: 85,
        highlight_vi: "3 lượt kể · dùng tốt từ 'mèo mướp'",
      },
      {
        game_key: "SENTENCE_SHOOTER",
        title_vi: "Xạ thủ ghép câu",
        sessions_count: 4,
        recent_average_pct: 88,
        highlight_vi: "4 lượt chơi · ghép câu mạch lạc",
      },
      {
        game_key: "KARAOKE",
        title_vi: "Hát vui cùng bé",
        sessions_count: 2,
        recent_average_pct: 78,
        highlight_vi: "2 buổi hát · nhịp đều hơn",
      },
      {
        game_key: "MEMORY_GAME",
        title_vi: "Bé nhớ được gì?",
        sessions_count: 1,
        recent_average_pct: null,
        highlight_vi: "1 lượt khám phá khu vườn nắng ấm",
      },
    ],
    karaoke_weak_segments: [
      {
        song_id: songId,
        line_text: "Ngôi sao sáng trên trời",
        start_ms: 4200,
        end_ms: 7800,
        tip_vi: "Luyện chậm 0.85x để vào nhịp chữ 'Ngôi' chắc hơn.",
      },
    ],
    home_support_tips_vi: [
      "Hỏi bé kể lại 2 chi tiết thú vị sau mỗi bức tranh.",
      "Cùng bé gõ nhịp theo câu hát chậm 0.85x trước khi hát cả bài.",
    ],
    reading_misread_words_reinforced: 6,
    generated_at: stamp,
  };

  await page
    .context()
    .route("http://127.0.0.1:8000/learning/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (url.pathname === `/learning/children/${ids.child}/parent-analytics`) {
        await respondJson(route, analytics);
        return;
      }
      await route.fallback();
    });

  await page.goto(`/reports?childId=${ids.child}`);
  await expect(
    page.getByRole("heading", { name: `Tiến bộ của ${child.alias}` }),
  ).toBeVisible();
  await expect(page.getByText("Kỳ: 2026-09-09 → 2026-10-08")).toBeVisible();

  const summaryToggle = page.getByText(
    "Học tập qua Giải trí & Kỹ năng ngôn ngữ (V4.0)",
  );
  await expect(summaryToggle).toBeVisible();
  await summaryToggle.click();

  await expect(page.getByText(analytics.disclaimer_vi)).toBeVisible();
  await expect(
    page.getByTestId("reports-misread-words-reinforced"),
  ).toContainText("6");
  await expect(page.getByText("Kỹ năng đã quan sát rõ")).toBeVisible();
  await expect(page.getByText("Sắp xếp trật tự câu tiếng Việt")).toBeVisible();
  await expect(
    page.getByText("Bé chưa luyện hoạt động thuộc nhóm kỹ năng này", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Mở bài hát" })).toHaveAttribute(
    "href",
    `/karaoke/${songId}`,
  );

  await assertViewportHealth(page, `reports-${testInfo.project.name}`, [
    page.getByRole("link", { name: "Mở bài hát" }),
  ]);
  await saveAfterScreenshot(page, testInfo.project.name, "reports");

  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Flow 8: Sentence Shooter V4.1 Autopilot (1-tap Hub launch, 0-click auto_select_book, TTS + 2.5s auto-advance, stop cancel)", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const base = await installApiFixture(page);
  await installVoiceAndTtsMock(page);
  const ttsPayloads: Array<{ text?: string }> = [];
  await page
    .context()
    .route("http://127.0.0.1:8000/voice/text-to-speech", async (route) => {
      if (route.request().method() === "POST") {
        ttsPayloads.push(route.request().postDataJSON() as { text?: string });
      }
      await route.fallback();
    });

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const shooterBook: SentenceShooterBookDTO = {
    id: SHOOTER_BOOK_ID,
    name: book.name,
    title: book.title,
    author: book.author,
    min_grade: 1,
    max_grade: 3,
    available_rounds: 5,
    matched_difficult_words: ["sách"],
  };

  const r1Tok1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb101";
  const r1Tok2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb102";
  const r2Tok1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb201";
  const r2Tok2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb202";
  const r3Tok1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb301";
  const round2Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb002";
  const round3Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb003";

  const round2Dto = {
    round_id: round2Id,
    round_number: 2,
    token_count: 2,
    learning_mode: "WORD_ORDER" as const,
    practiced_difficult_words: ["mèo"],
    prompt_hint: "Ghép câu thứ hai.",
    tokens: [
      { id: r2Tok2, text: "ngủ.", is_difficult_word: false },
      { id: r2Tok1, text: "Mèo", is_difficult_word: true },
    ],
  };

  const round3Dto = {
    round_id: round3Id,
    round_number: 3,
    token_count: 1,
    learning_mode: "WORD_ORDER" as const,
    practiced_difficult_words: ["nắng"],
    prompt_hint: "Ghép câu cuối.",
    tokens: [{ id: r3Tok1, text: "Nắng.", is_difficult_word: true }],
  };

  let createBody: Record<string, unknown> | null = null;
  let currentRound = 1;
  let resolvedInRound = 0;

  await page
    .context()
    .route("http://127.0.0.1:8000/games/sentence-shooter/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (url.pathname === "/games/sentence-shooter/books") {
        await respondJson(route, [shooterBook]);
        return;
      }
      if (
        url.pathname === "/games/sentence-shooter/sessions" &&
        req.method() === "POST"
      ) {
        createBody = req.postDataJSON() as Record<string, unknown>;
        currentRound = 1;
        resolvedInRound = 0;
        const session: SentenceShooterSessionDTO = {
          session_id: SHOOTER_SESSION_ID,
          book: shooterBook,
          difficulty: "easy",
          learning_mode: "WORD_ORDER",
          total_rounds: 3,
          completed_rounds: 0,
          total_stars: 0,
          practiced_difficult_words: ["sách"],
          round: {
            round_id: SHOOTER_ROUND_ID,
            round_number: 1,
            token_count: 2,
            learning_mode: "WORD_ORDER",
            practiced_difficult_words: ["sách"],
            prompt_hint: "Ghép câu đầu tiên.",
            tokens: [
              { id: r1Tok2, text: "sách.", is_difficult_word: true },
              { id: r1Tok1, text: "Bé", is_difficult_word: false },
            ],
          },
        };
        await respondJson(route, session);
        return;
      }
      if (
        url.pathname ===
          `/games/sentence-shooter/sessions/${SHOOTER_SESSION_ID}/shots` &&
        req.method() === "POST"
      ) {
        const body = req.postDataJSON() as {
          round_id: string;
          token_id: string;
          client_shot_id?: string;
        };
        resolvedInRound += 1;
        if (currentRound === 1) {
          const done = resolvedInRound >= 2;
          await respondJson(route, {
            is_correct: true,
            correct_count: resolvedInRound,
            token_count: 2,
            mistakes_total: 0,
            completed_rounds: done ? 1 : 0,
            total_stars: done ? 1 : 0,
            round_completed: done,
            session_completed: false,
            next_expected_position: resolvedInRound,
            stars_awarded: done ? 1 : 0,
            score: resolvedInRound * 10,
            completed_sentence: done ? "Bé sách." : null,
            next_round: null,
            message: done ? "Hoàn thành câu 1!" : "Chính xác!",
            client_shot_id: body.client_shot_id ?? null,
            learning_mode: "WORD_ORDER",
            practiced_difficult_words: ["sách"],
          });
          return;
        }
        if (currentRound === 2) {
          const done = resolvedInRound >= 2;
          await respondJson(route, {
            is_correct: true,
            correct_count: resolvedInRound,
            token_count: 2,
            mistakes_total: 0,
            completed_rounds: done ? 2 : 1,
            total_stars: done ? 2 : 1,
            round_completed: done,
            session_completed: false,
            next_expected_position: resolvedInRound,
            stars_awarded: done ? 1 : 0,
            score: 20 + resolvedInRound * 10,
            completed_sentence: done ? "Mèo ngủ." : null,
            next_round: null,
            message: done ? "Hoàn thành câu 2!" : "Chính xác!",
            client_shot_id: body.client_shot_id ?? null,
            learning_mode: "WORD_ORDER",
            practiced_difficult_words: ["mèo"],
          });
          return;
        }
        await respondJson(route, {
          is_correct: true,
          correct_count: 1,
          token_count: 1,
          mistakes_total: 0,
          completed_rounds: 3,
          total_stars: 3,
          round_completed: true,
          session_completed: true,
          next_expected_position: 1,
          stars_awarded: 1,
          score: 50,
          completed_sentence: "Nắng.",
          next_round: null,
          message: "Hoàn thành lượt chơi!",
          client_shot_id: body.client_shot_id ?? null,
          learning_mode: "WORD_ORDER",
          practiced_difficult_words: ["nắng"],
        });
        return;
      }
      if (
        url.pathname ===
          `/games/sentence-shooter/sessions/${SHOOTER_SESSION_ID}/next-round` &&
        req.method() === "POST"
      ) {
        currentRound += 1;
        resolvedInRound = 0;
        await respondJson(route, {
          session_id: SHOOTER_SESSION_ID,
          completed_rounds: currentRound - 1,
          total_rounds: 3,
          total_stars: currentRound - 1,
          round: currentRound === 2 ? round2Dto : round3Dto,
        });
        return;
      }
      if (
        url.pathname ===
        `/games/sentence-shooter/sessions/${SHOOTER_SESSION_ID}/result`
      ) {
        const result: SentenceShooterResultDTO = {
          session_id: SHOOTER_SESSION_ID,
          book: shooterBook,
          difficulty: "easy",
          learning_mode: "WORD_ORDER",
          status: "COMPLETED",
          total_rounds: 3,
          completed_rounds: 3,
          correct_count: 5,
          mistakes_total: 0,
          hint_count: 0,
          total_stars: 3,
          duration_seconds: 8,
          started_at: stamp,
          completed_at: stamp,
          practiced_difficult_words: ["sách", "mèo", "nắng"],
        };
        await respondJson(route, result);
        return;
      }
      await route.fallback();
    });

  await selectChildAndEnterEntertainment(page);

  // Non-blocking onboarding visible, yet 1-tap "Vào nhanh" works immediately (1 tap from Hub -> 0 setup taps!)
  await expect(
    page.getByRole("complementary", {
      name: "Hướng dẫn làm quen khu vực Giải trí",
    }),
  ).toBeVisible();
  await page.getByTestId("quick-play-sentence-shooter").click();
  await expect(page).toHaveURL(
    /\/entertainment\/sentence-shooter\?autoplay=1/,
    {
      timeout: 30_000,
    },
  );

  // 0 setup clicks: session immediately enters playing stage with auto_select_book=true
  await expect(page.getByTestId("difficult-word-badge")).toContainText(
    /Ôn từ khó:\s*sách/,
  );
  expect(createBody).toMatchObject({
    child_id: ids.child,
    auto_select_book: true,
    difficulty: "easy",
    learning_mode: "WORD_ORDER",
  });
  expect(createBody).not.toHaveProperty("book_id");

  // Complete Round 1 -> TTS + 2.5s auto-advance bar -> auto-advances to Round 2 with 0 clicks
  const wordBank = page.getByRole("group", { name: "Các từ để ghép" });
  await wordBank.getByRole("button", { name: "Bé", exact: true }).click();
  await wordBank.getByRole("button", { name: "sách.", exact: true }).click();

  const autoAdvanceBar = page.getByTestId("shooter-auto-advance-bar");
  await expect(autoAdvanceBar).toBeVisible({ timeout: 10_000 });
  await expect(autoAdvanceBar).toContainText("Tự sang câu tiếp theo sau");
  expect(
    ttsPayloads.some((p) => String(p.text ?? "").includes("Bé sách")),
  ).toBe(true);
  await saveShowcaseScreenshot(
    page,
    testInfo.project.name,
    "sentence-shooter-v41-auto-advance",
  );

  // Wait for 2.5s auto-advance into Round 2 (0 clicks)
  await expect(page.getByText("Câu 2/3")).toBeVisible({ timeout: 10_000 });

  // Complete Round 2 -> test "Dừng tự động" cancels countdown cleanly
  await wordBank.getByRole("button", { name: "Mèo", exact: true }).click();
  await wordBank.getByRole("button", { name: "ngủ.", exact: true }).click();
  await expect(autoAdvanceBar).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("shooter-stop-auto-btn").click();
  await expect(autoAdvanceBar).toHaveCount(0);
  await page.waitForTimeout(2700);
  await expect(page.getByText("Câu 2/3")).toBeVisible();

  await page.getByRole("button", { name: "Câu tiếp theo" }).click();
  await expect(page.getByText("Câu 3/3")).toBeVisible();
  await wordBank.getByRole("button", { name: "Nắng.", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Giỏi quá, bé đã hoàn thành!/ }),
  ).toBeVisible({ timeout: 10_000 });

  await assertViewportHealth(
    page,
    `sentence-shooter-v41-${testInfo.project.name}`,
    [page.getByRole("button", { name: "Chơi lượt mới" })],
  );
  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Flow 9: AI Teacher V4.1 Autopilot (1-tap hub-owl-quick-play -> auto_select -> hands-free TTS/280ms/auto-mic -> green word match -> 2.2s silence auto-submit)", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const base = await installApiFixture(page);
  await installVoiceAndTtsMock(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const catalog: PictureCatalogDTO = {
    focus_difficult_words: ["mèo mướp", "lấp lánh"],
    recommended_sample_key: "sunny-garden",
    recommended_book_page_id: null,
    samples: [
      {
        sample_key: "sunny-garden",
        title: "Khu vườn đầy nắng",
        theme: "Thiên nhiên",
        description: "Chú mèo mướp và chú bướm trong khu vườn đầy nắng.",
        image_url: "/images/picture-description/sunny-garden.jpg",
        matched_difficult_words: ["mèo mướp", "lấp lánh"],
      },
    ],
    book_pages: [],
  };

  const sessionBase: PictureSessionDTO = {
    session_id: PICTURE_SESSION_ID,
    child_id: ids.child,
    child_grade: child.grade,
    source_type: "SAMPLE",
    sample_key: "sunny-garden",
    book_id: null,
    book_page_id: null,
    image_url: "/images/picture-description/sunny-garden.jpg",
    scene_title: "Khu vườn đầy nắng",
    status: "ACTIVE",
    best_stars: 0,
    best_score: 0,
    attempts_count: 0,
    teaching_mode: "OBSERVE",
    target_words: ["mèo mướp", "lấp lánh"],
    target_vocabulary: ["mèo mướp", "lấp lánh"],
    practiced_difficult_words: [],
    provider_tier: "GEMINI_PRIMARY",
    guide: {
      is_child_safe: true,
      scene_title: "Khu vườn đầy nắng",
      scene_summary: "Khu vườn tràn ngập ánh nắng với chú mèo mướp dễ thương.",
      guiding_questions: ["Trong khu vườn có những nhân vật nào?"],
      suggested_vocabulary: [
        { word: "mèo mướp", hint: "Chú mèo lông vằn cam" },
      ],
      model_sample_sentences: ["Trong vườn có chú mèo mướp dễ thương."],
      teaching_mode: "OBSERVE",
      target_words: ["mèo mướp", "lấp lánh"],
    },
    attempts: [],
    created_at: stamp,
    updated_at: stamp,
  };

  let createRawFormBody = "";
  let evaluatePayload: Record<string, unknown> | null = null;
  let currentSession = sessionBase;

  await page
    .context()
    .route(
      "http://127.0.0.1:8000/games/picture-description/**",
      async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === "OPTIONS") {
          await respondJson(route, null, 204);
          return;
        }
        if (url.pathname === "/games/picture-description/catalog") {
          await respondJson(route, catalog);
          return;
        }
        if (
          url.pathname === "/games/picture-description/sessions" &&
          req.method() === "GET"
        ) {
          await respondJson(route, []);
          return;
        }
        if (
          url.pathname === "/games/picture-description/sessions" &&
          req.method() === "POST"
        ) {
          createRawFormBody = req.postData() ?? "";
          currentSession = sessionBase;
          await respondJson(route, currentSession);
          return;
        }
        if (
          url.pathname ===
            `/games/picture-description/sessions/${PICTURE_SESSION_ID}/evaluate` &&
          req.method() === "POST"
        ) {
          evaluatePayload = req.postDataJSON() as Record<string, unknown>;
          const attempt = {
            attempt_id: PICTURE_ATTEMPT_ID,
            attempt_number: 1,
            input_mode:
              (evaluatePayload.input_mode as "VOICE" | "TEXT") ?? "VOICE",
            transcript_text: String(evaluatePayload.transcript_text ?? ""),
            score_out_of_10: 9,
            stars: 3,
            evaluation_source: "AI" as const,
            provider_tier: "GEMINI_PRIMARY" as const,
            practiced_difficult_words: ["mèo mướp"],
            feedback: {
              is_relevant: true,
              score_out_of_10: 9,
              stars: 3,
              matched_details: ["Chú mèo mướp"],
              missed_details: [],
              praise_message: "Tuyệt vời! Bé dùng trúng từ mèo mướp rồi!",
              improvement_tip: "Kể thêm màu ánh nắng nhé.",
              upgraded_sentences: ["Chú mèo mướp nằm dưới nắng."],
              vocabulary_highlights: ["mèo mướp"],
              teaching_mode: "OBSERVE" as const,
              scaffolding_step: "EXPAND" as const,
              next_prompt_question: "Chú mèo mướp sẽ làm gì tiếp theo?",
              used_target_words: ["mèo mướp"],
              practiced_difficult_words: ["mèo mướp"],
              provider_tier: "GEMINI_PRIMARY" as const,
            },
            created_at: stamp,
          };
          currentSession = {
            ...sessionBase,
            attempts_count: 1,
            best_score: 9,
            best_stars: 3,
            practiced_difficult_words: ["mèo mướp"],
            attempts: [attempt],
          };
          await respondJson(route, {
            session: currentSession,
            latest_attempt: attempt,
            practiced_difficult_words: ["mèo mướp"],
          });
          return;
        }
        await route.fallback();
      },
    );

  await selectChildAndEnterEntertainment(page);
  await page.getByTestId("hub-owl-quick-play").click();
  await expect(page).toHaveURL(
    /\/entertainment\/picture-description\?autoplay=1/,
    { timeout: 30_000 },
  );

  // 0 setup clicks: auto_select=true creates session directly, speaks prompt, waits 280ms, and auto-arms mic
  await expect(page.getByTestId("target-words-panel")).toBeVisible({
    timeout: 15_000,
  });
  expect(createRawFormBody).toContain('name="auto_select"');
  expect(createRawFormBody).toContain("true");

  await expect(page.getByTestId("live-voice-transcript")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible();

  await page.evaluate(() => {
    const win = window as unknown as {
      __v4SpeechControl?: { emitTranscript: (text: string) => boolean };
    };
    win.__v4SpeechControl?.emitTranscript("Con mèo mướp đang nằm phơi nắng");
  });

  // Real-time green highlight on "Từ bé đang ôn" + hands-free auto-submit bar
  await expect(
    page
      .getByTestId("target-words-panel")
      .locator('[data-word-matched="true"]'),
  ).toContainText("mèo mướp");
  await expect(page.getByTestId("picture-auto-submit-bar")).toBeVisible();
  await expect(page.getByTestId("picture-auto-submit-bar")).toContainText(
    "Tự gửi sau",
  );
  await expect(page.getByTestId("picture-pause-auto-btn")).toBeVisible();
  await expect(page.getByTestId("picture-send-now-btn")).toBeVisible();

  await saveShowcaseScreenshot(
    page,
    testInfo.project.name,
    "picture-description-v41-autopilot",
  );

  // 2.2s silence auto-submit triggers evaluate(VOICE) automatically with 0 clicks
  await expect(
    page.getByText("Tuyệt vời! Bé dùng trúng từ mèo mướp rồi!"),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByTestId("picture-practiced-difficult-words"),
  ).toContainText("mèo mướp");
  expect(evaluatePayload).toMatchObject({ input_mode: "VOICE" });

  await assertViewportHealth(
    page,
    `picture-description-v41-${testInfo.project.name}`,
    [page.getByRole("button", { name: "Nghe nhận xét" })],
  );
  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Flow 10: Memory Game V4.1 Autopilot (1-tap Hub launch, ?autoplay=1 auto-theme, post-render timer, voice recall -> REVEAL practiced words)", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const base = await installApiFixture(page);
  await installVoiceAndTtsMock(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const themesCatalog: MemoryThemesCatalogDTO = {
    themes: [
      {
        theme_key: "sunny_garden",
        name_vi: "Khu vườn nắng ấm",
        description_vi: "Chú mèo mướp và hoa hướng dương.",
        badge_vi: "Quen thuộc",
        accent_hex: "#F59E0B",
        sprite_count: 7,
        sample_items_vi: ["mèo mướp", "hoa hướng dương"],
      },
    ],
    timer_options: [
      {
        mode: "20S",
        seconds: 20,
        label_vi: "20 giây",
        recommended_for_vi: "Nhịp vừa phải",
      },
    ],
    grade_recommendations: [
      {
        grade: 2,
        min_objects: 3,
        max_objects: 5,
        recommended_timer: "20S",
        recommended_recall_mode: "GUIDED_RECALL",
        recommended_difficulty: 2,
        note_vi: "Gợi ý Lớp 2.",
      },
    ],
    total_sprites: 42,
    focus_difficult_words: ["mèo mướp"],
    recommended_theme_key: "sunny_garden",
  };

  const catObj = {
    id: "obj-cat",
    sprite_key: "tabby_cat",
    name_vi: "mèo mướp",
    category_vi: "con vật",
    aliases_vi: ["mèo"],
    color_vi: "cam" as const,
    color_hex: "#FB923C",
    color_stroke_hex: "#9A3412",
    color_light_hex: "#FED7AA",
    shape_cue: "circle" as const,
    count: 1,
    position_zone: "dưới trái" as const,
    bbox: { x: 0.12, y: 0.62, w: 0.2, h: 0.24 },
    action_vi: "đang nằm sưởi nắng",
    hint_tiers: {
      tier_1: "Ở góc dưới trái có bạn mèo cam.",
      tier_2: "Bạn ấy kêu meo meo.",
      tier_3: "Đó là chú mèo mướp.",
    },
    is_focus_word: true,
  };

  const memorySessionBase: MemorySessionDTO = {
    id: MEMORY_SESSION_ID,
    child_id: ids.child,
    child_grade: child.grade,
    theme_key: "sunny_garden",
    theme_name_vi: "Khu vườn nắng ấm",
    difficulty_level: 2,
    scene_seed: 42,
    timer_mode: "20S",
    timer_seconds: 2,
    recall_mode: "GUIDED_RECALL",
    status: "OBSERVING",
    hints_used: 0,
    peek_count: 0,
    best_factual_score: 0,
    best_creative_score: 0,
    stars: 0,
    attempts_count: 0,
    focus_words: ["mèo mướp"],
    scene_spec: {
      schema_version: "4.1",
      theme_key: "sunny_garden",
      theme_name_vi: "Khu vườn nắng ấm",
      child_grade: child.grade,
      difficulty_level: 2,
      scene_seed: 42,
      canvas_width: 800,
      canvas_height: 500,
      backdrop: {
        theme_key: "sunny_garden",
        sky_top_hex: "#E0F2FE",
        sky_bottom_hex: "#FEF9C3",
        horizon_hex: "#BBF7D0",
        ground_hex: "#86EFAC",
        accent_hex: "#F59E0B",
        mood_vi: "Buổi sáng trong lành",
      },
      objects: [catObj],
      observation_tips_vi: ["Nhìn kỹ góc dưới trái nhé."],
      guided_questions_vi: ["Ở góc dưới trái có con vật gì?"],
      creative_prompt_vi: "Chú mèo mướp sẽ làm gì tiếp theo?",
      matched_focus_words: ["mèo mướp"],
      focus_words: ["mèo mướp"],
    },
    attempts: [],
    created_at: stamp,
    updated_at: stamp,
  };

  let createBody: Record<string, unknown> | null = null;
  let recallInputModeSeen: string | null = null;

  await page
    .context()
    .route("http://127.0.0.1:8000/games/memory/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (url.pathname === "/games/memory/themes") {
        await respondJson(route, themesCatalog);
        return;
      }
      if (url.pathname === "/games/memory/sessions" && req.method() === "GET") {
        await respondJson(route, []);
        return;
      }
      if (
        url.pathname === "/games/memory/sessions" &&
        req.method() === "POST"
      ) {
        createBody = req.postDataJSON() as Record<string, unknown>;
        await respondJson(route, memorySessionBase);
        return;
      }
      if (
        url.pathname ===
          `/games/memory/sessions/${MEMORY_SESSION_ID}/attempts` &&
        req.method() === "POST"
      ) {
        const body = req.postDataJSON() as {
          stage: "RECALL" | "CREATIVE";
          input_mode: string;
          response_text: string;
        };
        recallInputModeSeen = body.input_mode;
        const evalRecall = {
          stage: "RECALL" as const,
          factual_score: 92,
          creative_score: 0,
          stars: 3,
          matched_facts: [
            {
              object_id: catObj.id,
              sprite_key: catObj.sprite_key,
              name_vi: catObj.name_vi,
              color_vi: catObj.color_vi,
              count: catObj.count,
              position_zone: catObj.position_zone,
              matched_attributes: ["tên", "màu"],
              detail_vi: "1 mèo mướp cam ở dưới trái",
              bbox: catObj.bbox,
            },
          ],
          missed_facts: [],
          creative_highlights: [],
          story_anchors: [],
          praise_message_vi: "Bé nhớ rất chính xác!",
          story_praise_vi: "Tuyệt vời!",
          next_tip_vi: "Kể tiếp câu chuyện nhé.",
          creative_followup_vi: "Chú mèo mướp sẽ chơi cùng ai?",
          support_summary_vi: null,
          used_focus_words: ["mèo mướp"],
          practiced_difficult_words: ["mèo mướp"],
          focus_word_feedback_vi: "Bé đã dùng trúng từ khó mèo mướp!",
          ai_provider: "deterministic",
        };
        const attempt = {
          id: MEMORY_ATTEMPT_RECALL_ID,
          session_id: MEMORY_SESSION_ID,
          attempt_number: 1,
          stage: "RECALL" as const,
          input_mode: "VOICE" as const,
          response_text: body.response_text,
          factual_score: 92,
          creative_score: 0,
          stars: 3,
          evaluation: evalRecall,
          ai_provider: "deterministic",
          created_at: stamp,
        };
        await respondJson(route, {
          attempt,
          session: {
            ...memorySessionBase,
            status: "CREATIVE",
            best_factual_score: 92,
            stars: 3,
            attempts_count: 1,
            attempts: [attempt],
          },
        });
        return;
      }
      await route.fallback();
    });

  await selectChildAndEnterEntertainment(page);
  await page.getByTestId("quick-play-memory-game").click();
  await expect(page).toHaveURL(/\/entertainment\/memory-game\?autoplay=1/, {
    timeout: 30_000,
  });

  // 0 setup clicks -> auto-theme (theme_key omitted) + post-render timer ticks 2s -> 1s -> RECALL
  await expect(page.getByTestId("observe-stage")).toBeVisible({
    timeout: 15_000,
  });
  expect(createBody).toMatchObject({
    child_id: ids.child,
    timer_mode: "20S",
  });
  expect(createBody).not.toHaveProperty("theme_key");

  await expect(page.getByTestId("memory-scene-svg")).toHaveAttribute(
    "data-scene-ready",
    "true",
  );
  await expect(page.getByTestId("countdown-seconds")).toHaveText(
    /2 giây|1 giây/,
  );

  // Auto-transitions to RECALL and arms mic hands-free
  await expect(page.getByTestId("recall-stage")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("recall-voice-btn")).toContainText("Dừng nói", {
    timeout: 15_000,
  });

  await page.evaluate(() => {
    const win = window as unknown as {
      __v4SpeechControl?: { emitTranscript: (text: string) => boolean };
    };
    win.__v4SpeechControl?.emitTranscript("Có một chú mèo mướp màu cam");
  });

  await expect(page.getByTestId("memory-recall-auto-submit-bar")).toBeVisible();
  await expect(page.getByTestId("memory-recall-auto-submit-bar")).toContainText(
    "Tự gửi sau",
  );

  // 2.5s silence auto-submits into REVEAL with practiced difficult words
  await expect(page.getByTestId("reveal-stage")).toBeVisible({
    timeout: 15_000,
  });
  expect(recallInputModeSeen).toBe("VOICE");
  await expect(page.getByTestId("reveal-practiced-words")).toContainText(
    "mèo mướp",
  );
  await expect(page.getByTestId("reveal-practiced-words")).toContainText(
    "Bé đã dùng trúng từ khó mèo mướp!",
  );

  await saveShowcaseScreenshot(
    page,
    testInfo.project.name,
    "memory-game-v41-reveal",
  );
  await assertViewportHealth(page, `memory-game-v41-${testInfo.project.name}`, [
    page.getByTestId("reveal-play-new-btn"),
  ]);
  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("Flow 11: Karaoke V4.1 (Ôn từ khó + 1-tap Hát ngay ?autoplay=1&scored=1 + calm NotAllowedError fallback + weakest segment 0.85×)", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const base = await installApiFixture(page);
  await installLearningRecommendationsMock(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.addInitScript(() => {
    const tracks = new Set<MediaStreamTrack>();
    class Recognizer {
      static active?: Recognizer;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onspeechstart: (() => void) | null = null;
      onspeechend: (() => void) | null = null;
      onresult: ((event: unknown) => void) | null = null;
      start(track?: MediaStreamTrack) {
        if (track && !tracks.has(track)) {
          throw new Error("Unexpected track");
        }
        Recognizer.active = this;
        queueMicrotask(() => this.onstart?.());
      }
      stop() {
        if (Recognizer.active === this) Recognizer.active = undefined;
        queueMicrotask(() => this.onend?.());
      }
      abort() {
        if (Recognizer.active === this) Recognizer.active = undefined;
      }
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        if (Recognizer.active) {
          throw new DOMException(
            "Microphone exclusively held by SpeechRecognition",
            "NotReadableError",
          );
        }
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        const stream = dest.stream;
        stream.getTracks().forEach((track) => tracks.add(track));
        return stream;
      },
    });
    const control = {
      audio: null as HTMLAudioElement | null,
      sing(startSeconds: number, endSeconds: number, text: string) {
        const current = Recognizer.active;
        if (!current || !this.audio || this.audio.paused) {
          throw new Error("Expected active karaoke capture and playback");
        }
        this.audio.currentTime = startSeconds;
        current.onspeechstart?.();
        this.audio.currentTime = endSeconds;
        current.onspeechend?.();
        current.onresult?.({
          resultIndex: 0,
          results: [
            { isFinal: true, 0: { transcript: text, confidence: 0.99 } },
          ],
        });
        this.audio.dispatchEvent(new Event("timeupdate"));
      },
    };
    Object.defineProperty(window, "__v4KaraokeFixture", { value: control });
    Object.defineProperty(window, "SpeechRecognition", {
      value: Recognizer,
      configurable: true,
    });
    let rejectedAutoplayOnce = false;
    window.Audio = new Proxy(window.Audio, {
      construct(target, args) {
        const audio = Reflect.construct(target, args) as HTMLAudioElement;
        const originalPlay = audio.play.bind(audio);
        audio.play = () => {
          if (!rejectedAutoplayOnce) {
            rejectedAutoplayOnce = true;
            return Promise.reject(
              new DOMException("Autoplay is not allowed", "NotAllowedError"),
            );
          }
          return originalPlay();
        };
        control.audio = audio;
        return audio;
      },
    });
  });

  const demoDir = path.resolve(process.cwd(), "..", "docs", "karaoke-demo");
  const demoMp3 = readFileSync(path.join(demoDir, "ngoi-sao-nho.mp3"));
  const durationMs = 103366;
  const twoLineLyrics = {
    format_version: 2 as const,
    lines: [
      {
        id: lineId,
        text: "Em vui đến trường",
        start_ms: 1000,
        end_ms: 4000,
        syllables: [
          {
            id: "44444444-4444-4444-8444-444444444411",
            text: "Em",
            start_ms: 1000,
            end_ms: 1700,
          },
          {
            id: "44444444-4444-4444-8444-444444444412",
            text: "vui",
            start_ms: 1700,
            end_ms: 2400,
          },
          {
            id: "44444444-4444-4444-8444-444444444413",
            text: "đến",
            start_ms: 2400,
            end_ms: 3100,
          },
          {
            id: "44444444-4444-4444-8444-444444444414",
            text: "trường",
            start_ms: 3100,
            end_ms: 4000,
          },
        ],
      },
      {
        id: "33333333-3333-4333-8333-333333333339",
        text: "Ngôi sao sáng trên trời",
        start_ms: 4200,
        end_ms: 7800,
        syllables: [
          {
            id: "44444444-4444-4444-8444-444444444421",
            text: "Ngôi",
            start_ms: 4200,
            end_ms: 4900,
          },
          {
            id: "44444444-4444-4444-8444-444444444422",
            text: "sao",
            start_ms: 4900,
            end_ms: 5600,
          },
          {
            id: "44444444-4444-4444-8444-444444444423",
            text: "sáng",
            start_ms: 5600,
            end_ms: 6300,
          },
          {
            id: "44444444-4444-4444-8444-444444444424",
            text: "trên",
            start_ms: 6300,
            end_ms: 7000,
          },
          {
            id: "44444444-4444-4444-8444-444444444425",
            text: "trời",
            start_ms: 7000,
            end_ms: 7800,
          },
        ],
      },
    ],
  };

  await page.context().route("https://media.example.test/**", async (route) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers().range ?? "",
    );
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(demoMp3.length - 1, Number(range[2]))
      : demoMp3.length - 1;
    await route.fulfill({
      status: range ? 206 : 200,
      contentType: "audio/mpeg",
      body: demoMp3.subarray(start, end + 1),
      headers: {
        "access-control-allow-origin": "*",
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${demoMp3.length}` }
          : {}),
      },
    });
  });

  await page
    .context()
    .route("http://127.0.0.1:8000/karaoke/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "OPTIONS") {
        await respondJson(route, null, 204);
        return;
      }
      if (url.pathname === "/karaoke/songs") {
        await respondJson(route, {
          items: [
            {
              song_id: songId,
              version_id: versionId,
              title: "Ngôi sao nhỏ",
              author: "Nhạc thiếu nhi",
              duration_ms: durationMs,
              min_grade: 1,
              max_grade: 3,
              cover_url: null,
              matched_difficult_words: ["trường", "vui"],
            },
          ],
          total: 1,
          limit: 12,
          offset: 0,
        });
        return;
      }
      if (url.pathname === `/karaoke/songs/${songId}/playback`) {
        const source = Object.fromEntries(
          Object.entries(previewDetail()).filter(([key]) => key !== "revision"),
        );
        await respondJson(route, {
          ...source,
          title: "Ngôi sao nhỏ",
          author: "Nhạc thiếu nhi",
          duration_ms: durationMs,
          version_id: versionId,
          lyrics: twoLineLyrics,
        });
        return;
      }
      if (url.pathname === `/karaoke/songs/${songId}/musical-profile`) {
        await respondJson(route, null, 404);
        return;
      }
      if (
        url.pathname === "/karaoke/practice-sessions" &&
        req.method() === "GET"
      ) {
        await respondJson(route, {
          child_id: ids.child,
          song_id: songId,
          best_full_song_score: null,
          best_full_song_stars: 0,
          total_sessions: 0,
          items: [],
          storage_ready: true,
        });
        return;
      }
      if (
        url.pathname === "/karaoke/practice-sessions" &&
        req.method() === "POST"
      ) {
        const payload = req.postDataJSON() as Record<string, unknown>;
        await respondJson(route, {
          id: KARAOKE_SESSION_ID,
          child_id: ids.child,
          song_id: songId,
          song_version_id: versionId,
          practice_mode: payload.practice_mode ?? "FULL_SONG",
          scoring_mode: payload.scoring_mode ?? "LYRICS_ONLY",
          playback_rate: Number(payload.playback_rate ?? 1),
          headphone_mode: Boolean(payload.headphone_mode),
          overall_score: (payload.overall_score as number | null) ?? 80,
          rhythm_score: (payload.rhythm_score as number | null) ?? null,
          pitch_score: (payload.pitch_score as number | null) ?? null,
          lyrics_score: (payload.lyrics_score as number | null) ?? 80,
          fluency_score: (payload.fluency_score as number | null) ?? null,
          stars: Number(payload.stars ?? 2),
          segment_start_ms: null,
          segment_end_ms: null,
          report_payload:
            (payload.report_payload as Record<string, unknown>) ?? {},
          created_at: stamp,
          persisted: true,
        });
        return;
      }
      await route.fallback();
    });

  await selectChildAndEnterEntertainment(page, false);

  // 1) Library route (/karaoke without ?autoplay=1) shows difficult-word chips and 1-tap Hát ngay link
  await page.getByRole("link", { name: /Mở thư viện bài hát/i }).click();
  await expect(page).toHaveURL(/\/karaoke(?:\?focus=.*)?$/, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("karaoke-song-difficult-words")).toContainText(
    "trường",
  );
  await expect(
    page.getByRole("link", { name: "Hát ngay", exact: true }),
  ).toHaveAttribute(
    "href",
    new RegExp(
      `^/karaoke/${songId}\\?version=${versionId}&autoplay=1&scored=1`,
    ),
  );

  // 2) Hub Quick Play (/karaoke?autoplay=1) skips the library and enters the top recommended song directly (0 extra taps)
  await page.goBack();
  await expect(page).toHaveURL(/\/entertainment/, { timeout: 30_000 });
  await page.getByTestId("quick-play-karaoke").click();
  await expect(page).toHaveURL(
    new RegExp(`/karaoke/${songId}\\?version=${versionId}&autoplay=1&scored=1`),
    { timeout: 30_000 },
  );

  const stage = page.getByRole("region", { name: "Hát cùng bé", exact: true });
  await expect(
    stage.getByRole("button", { name: "Hát có chấm điểm", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  // Autoplay enters 3-2-1 countdown automatically (0 stage clicks)
  await expect(stage.getByTestId("karaoke-countdown")).toBeVisible({
    timeout: 10_000,
  });

  // First audio.play() rejects with NotAllowedError -> calm centered CTA, zero error alerts
  const tapBtn = stage.getByTestId("karaoke-autoplay-tap-btn");
  await expect(tapBtn).toBeVisible({ timeout: 10_000 });
  await expect(tapBtn).toContainText("Chạm 1 lần để vào nhạc");
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await expect(stage.getByRole("alert")).toHaveCount(0);
  await saveShowcaseScreenshot(
    page,
    testInfo.project.name,
    "karaoke-v41-autoplay-fallback",
  );

  await tapBtn.click();
  await expect(
    stage.getByRole("button", { name: "Tạm dừng", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(tapBtn).toHaveCount(0);

  // Sing line 1 cleanly and skip line 2 -> weakest segment CTA appears above score report
  await page.waitForFunction(() => {
    const fixture = (
      window as unknown as {
        __v4KaraokeFixture?: { audio?: HTMLAudioElement | null };
      }
    ).__v4KaraokeFixture;
    return Boolean(fixture?.audio && !fixture.audio.paused);
  });
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        __v4KaraokeFixture: {
          audio: HTMLAudioElement;
          sing: (s: number, e: number, text: string) => void;
        };
      }
    ).__v4KaraokeFixture;
    fixture.sing(1.0, 3.8, "Em vui đến trường");
    fixture.audio.currentTime = 9.0;
    fixture.audio.dispatchEvent(new Event("timeupdate"));
  });

  await stage
    .getByRole("button", { name: "Kết thúc & chấm điểm", exact: true })
    .click();

  const weakestCta = stage.getByTestId("karaoke-weakest-segment-cta");
  await expect(weakestCta).toBeVisible({ timeout: 10_000 });
  const practiceWeakestBtn = stage.getByTestId("karaoke-practice-weakest-btn");
  await expect(practiceWeakestBtn).toContainText(
    "Luyện ngay câu yếu nhất (0.85×)",
  );
  await saveShowcaseScreenshot(
    page,
    testInfo.project.name,
    "karaoke-v41-weakest-segment",
  );

  await practiceWeakestBtn.click();
  await expect(
    stage.getByRole("button", { name: "Luyện đoạn khó", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __v4KaraokeFixture: { audio: HTMLAudioElement };
          }
        ).__v4KaraokeFixture.audio.playbackRate,
    ),
  ).toBe(0.85);

  await assertViewportHealth(page, `karaoke-v41-${testInfo.project.name}`, [
    stage.getByRole("button", { name: "Luyện đoạn khó", exact: true }),
  ]);
  expect(pageErrors).toEqual([]);
  expect(base.unexpected).toEqual([]);
});
