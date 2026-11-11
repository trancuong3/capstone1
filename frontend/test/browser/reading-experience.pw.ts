import { expect, test } from "@playwright/test";
import {
  installReadingExperience,
  readingWords,
} from "./reading-experience-fixture";

test("Image overlay fits the source and large controls at every required viewport", async ({
  page,
}, testInfo) => {
  const fixture = await installReadingExperience(page);
  const viewer = page.locator("[data-render-mode]");
  await expect(viewer).toHaveAttribute("data-render-mode", "image-overlay");
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(
    page.getByRole("navigation", { name: "Điều hướng dành cho ba mẹ" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Mình đang chờ bé", { exact: true }),
  ).toBeVisible();
  const viewport = page.viewportSize()!;
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(viewport.width);
  const controls = page.getByRole("navigation", {
    name: "Điều khiển buổi đọc",
  });
  for (const button of await controls.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    const label = button.locator("span").last();
    expect(
      await label.evaluate(
        (element) =>
          element.scrollHeight <= element.clientHeight &&
          element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
  for (const word of await viewer.locator("[data-word-id]").all()) {
    expect(
      await word.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit !== null && element.contains(hit);
      }),
    ).toBe(true);
  }
  await page.screenshot({
    path: testInfo.outputPath("reading-image.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("voice-and-speed.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(fixture.unexpected).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __readingProbe: { microphoneRequests: number };
          }
        ).__readingProbe.microphoneRequests,
    ),
  ).toBe(0);
});

for (const image of [
  "missing",
  "broken",
  "bad-boxes",
  "untrusted-boxes",
] as const) {
  test(`OCR remains readable with ${image} image evidence`, async ({
    page,
  }, testInfo) => {
    const fixture = await installReadingExperience(page, { image });
    await expect(page.locator("[data-render-mode]")).toHaveAttribute(
      "data-render-mode",
      image === "bad-boxes" || image === "untrusted-boxes"
        ? "image-reference"
        : "text",
    );
    await expect(
      page.getByRole("button", { name: "mèo", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`reading-${image}.png`),
      fullPage: true,
    });
    expect(fixture.unexpected).toEqual([]);
  });
}

test("Refresh preserves the original error and two failed attempts without starting a microphone", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page, {
    restored: true,
    incorrectCount: 2,
    denyMicrophone: true,
  });
  await expect(
    page.getByRole("dialog", { name: "Mình đọc lại những từ này nhé?" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: "Mình đọc lại những từ này nhé?" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __readingProbe: { microphoneRequests: number };
          }
        ).__readingProbe.microphoneRequests,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect(
    page.getByText("Microphone chưa sẵn sàng.", { exact: true }),
  ).toBeVisible();
  expect(fixture.events).toEqual([]);
  expect(fixture.sttCalls()).toBe(0);
  expect(fixture.unexpected).toEqual([]);
});

test("A decoded synthetic retry self-corrects separately from first-pass assessment", async ({
  page,
}, testInfo) => {
  const fixture = await installReadingExperience(page, {
    restored: true,
    incorrectCount: 2,
  });
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect.poll(() => fixture.events.length, { timeout: 25000 }).toBe(1);
  expect(fixture.sttCalls()).toBe(1);
  const event = fixture.events[0];
  expect(event).toMatchObject({
    Status: "CONFIRMED",
    Metadata: {
      retry_attempt: 3,
      incorrect_retry_count: 2,
      resolution_status: "SELF_CORRECTED",
    },
  });
  await expect(
    page.getByRole("region", { name: "Kết quả lượt đầu và luyện lại" }),
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("67%", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("self-correction-completion.png"),
    fullPage: true,
  });
  expect(fixture.unexpected).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __readingProbe: { activeTracks: number } })
          .__readingProbe.activeTracks,
    ),
  ).toBe(0);
});

test("The third incorrect retry stays unresolved and stops without a fourth attempt", async ({
  page,
}, testInfo) => {
  const fixture = await installReadingExperience(page, {
    restored: true,
    incorrectCount: 2,
    stt: "chó",
  });
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect.poll(() => fixture.events.length, { timeout: 25000 }).toBe(1);
  expect(fixture.events[0]).toMatchObject({
    Status: "FAILED",
    Metadata: {
      retry_attempt: 3,
      incorrect_retry_count: 3,
      resolution_status: "UNRESOLVED",
    },
  });
  await expect(page.getByText("67%", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  expect(fixture.sttCalls()).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("unresolved-completion.png"),
    fullPage: true,
  });
  expect(fixture.unexpected).toEqual([]);
});

test("A committed retry with a lost response is resubmitted identically and only counted once", async ({
  page,
}, testInfo) => {
  const fixture = await installReadingExperience(page, {
    restored: true,
    loseEventResponse: true,
  });
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect(
    page.getByRole("button", { name: "Thử lưu lại", exact: true }),
  ).toBeVisible({ timeout: 25000 });
  expect(fixture.events).toHaveLength(1);
  await page.screenshot({
    path: testInfo.outputPath("retry-save-recovery.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Thử lưu lại", exact: true }).click();
  await expect(page.getByText("67%", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  expect(fixture.receivedEvents).toHaveLength(2);
  expect(fixture.receivedEvents[1]).toEqual(fixture.receivedEvents[0]);
  expect(fixture.events).toHaveLength(1);
  expect(fixture.sttCalls()).toBe(1);
  expect(fixture.unexpected).toEqual([]);
});

test("STT 503 never consumes an incorrect attempt", async ({ page }) => {
  const fixture = await installReadingExperience(page, {
    restored: true,
    incorrectCount: 2,
    sttUnavailable: true,
  });
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect(
    page.getByText("Dịch vụ nhận diện đang tạm dừng.", { exact: true }),
  ).toBeVisible({ timeout: 25000 });
  expect(fixture.events).toEqual([]);
  expect(fixture.sttCalls()).toBe(1);
  expect(fixture.unexpected).toEqual([]);
});

for (const terminal of ["correct", "unresolved"] as const) {
  test(`Persisted ${terminal} words keep a separate presentation and original assessment`, async ({
    page,
  }, testInfo) => {
    const fixture = await installReadingExperience(page, {
      restored: true,
      terminal,
      incorrectCount: terminal === "unresolved" ? 3 : 1,
    });
    await page.getByRole("button", { name: "Đọc tiếp", exact: true }).click();
    const word = page.locator(`[data-word-id="${readingWords[1].word_id}"]`);
    await expect(word).toHaveAttribute(
      "data-reading-state",
      terminal === "correct" ? "self-corrected" : "unresolved",
    );
    await expect(
      page.locator(`[data-word-id="${readingWords[0].word_id}"]`),
    ).toHaveAttribute("data-reading-state", "correct");
    await page.screenshot({
      path: testInfo.outputPath(`${terminal}-word.png`),
      fullPage: true,
    });
    expect(fixture.events).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
