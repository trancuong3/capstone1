import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  child,
  ids,
  installApiFixture,
  PLAYWRIGHT_ORIGIN,
} from "./real-data-fixture";

const SCREENSHOT_DIR = process.env.DASHBOARD_SCREENSHOT_DIR?.trim() || "";

function respondJson(route: Route, data: unknown, status = 200) {
  const origin = route.request().headers()["origin"] ?? PLAYWRIGHT_ORIGIN;
  return route.fulfill({
    status,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization,content-type,accept",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    },
    contentType: "application/json",
    body: JSON.stringify(data),
  });
}

async function setupDashboardRoutes(page: Page) {
  await installApiFixture(page);

  await page
    .context()
    .route(
      "http://127.0.0.1:8000/profiles/children/*/reading-passport",
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          return respondJson(route, null, 204);
        }
        return respondJson(route, {
          child_id: child.id,
          child_alias: child.alias,
          unlocked_stamps_count: 2,
          total_stamps_count: 4,
          streak_days: 3,
          gentle_message_vi:
            "Bé đã giữ nhịp đọc đều đặn 3 ngày liên tiếp — tiếp tục thật nhẹ nhàng nhé!",
          stamps: [
            {
              stamp_key: "first_read",
              title_vi: "Chuyến đọc đầu tiên",
              description_vi: "Hoàn thành buổi đọc đầu tiên cùng ViRead.",
              unlocked: true,
              progress_current: 1,
              progress_target: 1,
            },
            {
              stamp_key: "three_day_rhythm",
              title_vi: "Nhịp đọc 3 ngày",
              description_vi: "Duy trì đọc sách 3 ngày liên tiếp.",
              unlocked: true,
              progress_current: 3,
              progress_target: 3,
            },
            {
              stamp_key: "word_explorer",
              title_vi: "Nhà thám hiểm từ vựng",
              description_vi: "Ôn luyện 10 từ khó trên chuyến tàu 5 phút.",
              unlocked: false,
              progress_current: 6,
              progress_target: 10,
            },
            {
              stamp_key: "story_keeper",
              title_vi: "Người giữ truyện",
              description_vi: "Đọc trọn vẹn 5 cuốn sách yêu thích.",
              unlocked: false,
              progress_current: 2,
              progress_target: 5,
            },
          ],
        });
      },
    );

  await page
    .context()
    .route(
      "http://127.0.0.1:8000/profiles/children/*/encouragement-note",
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          return respondJson(route, null, 204);
        }
        return respondJson(route, null);
      },
    );
}

async function maybeCapture(page: Page, filename: string) {
  if (!SCREENSHOT_DIR) return;
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, filename),
    fullPage: false,
  });
}

test("dashboard reading desk, 5-minute train CTA, and passport tab stay cleanly proportioned without text squishing", async ({
  page,
}, testInfo) => {
  await setupDashboardRoutes(page);

  const isDesktopProject = testInfo.project.name === "desktop";
  if (isDesktopProject) {
    // Match common 1280x720 Windows laptop viewport where the cramped layout broke hardest
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Góc đọc gia đình" }),
  ).toBeVisible();

  const childButton = page.getByRole("button", {
    name: `${child.alias}, lớp ${child.grade}`,
  });
  await expect(childButton).toBeVisible();
  if ((await childButton.getAttribute("aria-pressed")) !== "true") {
    await childButton.click();
  }

  const desk = page.locator(".family-reading-desk");
  const deskIllustration = page.locator(".desk-illustration");
  const trainCard = page.getByTestId("five-minute-train-cta-card");
  const trainLaunchBtn = page.getByTestId("five-minute-train-launch-btn");

  await expect(desk).toBeVisible();
  await expect(deskIllustration).toBeVisible();
  await expect(trainCard).toBeVisible();
  await expect(trainLaunchBtn).toHaveAttribute(
    "href",
    `/learning-train?childId=${ids.child}&from=dashboard`,
  );

  // Verify zero horizontal overflow
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

  // Verify train card is outside the narrow reading desk
  const nestedInDesk = await page.evaluate(() => {
    const deskEl = document.querySelector(".family-reading-desk");
    const trainEl = document.querySelector(
      '[data-testid="five-minute-train-cta-card"]',
    );
    return Boolean(deskEl && trainEl && deskEl.contains(trainEl));
  });
  expect(nestedInDesk).toBe(false);

  const deskBox = await desk.boundingBox();
  const illustrationBox = await deskIllustration.boundingBox();
  const trainBox = await trainCard.boundingBox();
  const trainHeadingBox = await trainCard.locator("h3").boundingBox();
  const trainBtnBox = await trainLaunchBtn.boundingBox();

  expect(deskBox).not.toBeNull();
  expect(illustrationBox).not.toBeNull();
  expect(trainBox).not.toBeNull();
  expect(trainHeadingBox).not.toBeNull();
  expect(trainBtnBox).not.toBeNull();

  if (isDesktopProject) {
    // Desk hero must stay compact & balanced (never stretched to 1000px+)
    expect(deskBox!.height).toBeLessThanOrEqual(460);
    expect(illustrationBox!.height).toBeLessThanOrEqual(460);
    // Train CTA must span full dashboard width and render horizontally with readable heading
    expect(trainBox!.width).toBeGreaterThanOrEqual(900);
    expect(trainHeadingBox!.width).toBeGreaterThanOrEqual(400);
    expect(trainHeadingBox!.height).toBeLessThanOrEqual(48);
    // Button sits on the right side of the heading rather than crushing it
    expect(trainBtnBox!.x).toBeGreaterThan(trainHeadingBox!.x + 300);
  } else {
    // On 390px mobile, container query stacks cleanly with full-width button
    expect(trainBox!.width).toBeGreaterThanOrEqual(320);
    expect(trainHeadingBox!.height).toBeLessThanOrEqual(56);
    expect(trainBtnBox!.width).toBeGreaterThanOrEqual(280);
  }

  await maybeCapture(page, `dashboard-bookshelf-${testInfo.project.name}.png`);

  // Switch to Reading Passport tab and verify full-width expansion
  await page.getByTestId("desk-tab-passport").click();
  const passportPanel = page.getByTestId("reading-passport-panel");
  await expect(passportPanel).toBeVisible();
  await expect(deskIllustration).toBeHidden();

  const passportBox = await passportPanel.boundingBox();
  expect(passportBox).not.toBeNull();
  if (isDesktopProject) {
    expect(passportBox!.width).toBeGreaterThanOrEqual(560);
  }

  const passportOverflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(passportOverflow.scrollWidth).toBeLessThanOrEqual(
    passportOverflow.clientWidth + 1,
  );

  await maybeCapture(page, `dashboard-passport-${testInfo.project.name}.png`);

  // Switch back to Bookshelf tab and confirm illustration restores cleanly
  await page.getByTestId("desk-tab-bookshelf").click();
  await expect(deskIllustration).toBeVisible();
});
