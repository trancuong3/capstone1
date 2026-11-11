import { expect, test, type Page } from "@playwright/test";
import { installReadingExperience } from "./reading-experience-fixture";

// The real recorder consumes only synthesized streams. Provider boundaries are
// intercepted; these scenarios verify browser behavior, not live ASR accuracy.
const startName = "Bé đọc với nhận diện giọng nói";
const stopName = "Dừng nhận diện giọng nói";

async function probe(page: Page) {
  return page.evaluate(() => {
    const value = (
      window as unknown as {
        __readingProbe: {
          microphoneRequests: number;
          activeTracks: number;
          recordingStarts: number;
        };
      }
    ).__readingProbe;
    return {
      microphoneRequests: value.microphoneRequests,
      activeTracks: value.activeTracks,
      recordingStarts: value.recordingStarts,
    };
  });
}

test("Phase 7: denied microphone creates no transcript, retry or first-pass error", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page, {
    denyMicrophone: true,
  });
  await page.getByRole("button", { name: startName }).click();
  await expect(
    page.getByRole("dialog", { name: "Mình chưa nghe thấy giọng bé" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Thử lại", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Kết thúc an toàn" }),
  ).toBeEnabled();
  await expect.poll(async () => (await probe(page)).microphoneRequests).toBe(1);
  expect(await probe(page)).toMatchObject({
    activeTracks: 0,
    recordingStarts: 0,
  });
  expect(fixture.sttCalls()).toBe(0);
  expect(fixture.comparisons).toEqual([]);
  expect(fixture.events).toEqual([]);
  await expect(page.locator('[data-reading-state="incorrect"]')).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});

test("Phase 7: digital silence never reaches STT or consumes a retry", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page, {
    restored: true,
    incorrectCount: 2,
    silentMicrophone: true,
  });
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect(page.getByRole("button", { name: stopName })).toBeVisible();
  await page.waitForTimeout(3300);
  await page.getByRole("button", { name: stopName }).click();
  await expect(
    page.getByText("ViRead chưa nghe rõ từ này.", { exact: true }),
  ).toBeVisible();
  expect(fixture.sttCalls()).toBe(0);
  expect(fixture.events).toEqual([]);
  await page.getByRole("button", { name: "Tạm dừng buổi đọc" }).click();
  await expect.poll(async () => (await probe(page)).activeTracks).toBe(0);
  expect(fixture.unexpected).toEqual([]);
});

test("Phase 7: a disconnected synthetic track cannot submit a false reading", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page);
  await page.getByRole("button", { name: startName }).click();
  await expect(page.getByRole("button", { name: stopName })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __readingProbe: { disconnect: () => void } }
    ).__readingProbe.disconnect();
  });
  await expect.poll(async () => (await probe(page)).activeTracks).toBe(0);
  await expect(
    page.getByRole("dialog", { name: "Mình chưa nghe thấy giọng bé" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: stopName })).toHaveCount(0);
  expect(fixture.sttCalls()).toBe(0);
  expect(fixture.events).toEqual([]);
  expect(fixture.comparisons).toEqual([]);
  await expect(page.locator('[data-reading-state="incorrect"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Thử lại", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: stopName })).toBeVisible();
  expect(await probe(page)).toMatchObject({
    microphoneRequests: 3,
    activeTracks: 1,
  });
  await page.getByRole("button", { name: "Tạm dừng buổi đọc" }).click();
  await expect.poll(async () => (await probe(page)).activeTracks).toBe(0);
  expect(fixture.unexpected).toEqual([]);
});

test("Phase 7: two immediate start gestures share one recorder and pause releases it", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page);
  await page.getByRole("button", { name: startName }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByRole("button", { name: stopName })).toBeVisible();
  expect(await probe(page)).toEqual({
    microphoneRequests: 1,
    activeTracks: 1,
    recordingStarts: 1,
  });
  await page.getByRole("button", { name: "Tạm dừng buổi đọc" }).click();
  await expect.poll(async () => (await probe(page)).activeTracks).toBe(0);
  expect(fixture.events).toEqual([]);
  expect(fixture.comparisons).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("Phase 7: a disconnected retry preserves the original error and incorrect-attempt budget", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page, {
    restored: true,
    incorrectCount: 2,
  });
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect(page.getByRole("button", { name: stopName })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __readingProbe: { disconnect: () => void } }
    ).__readingProbe.disconnect();
  });
  await expect(
    page.getByText("Microphone chưa sẵn sàng.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Thử bật mic", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: stopName })).toHaveCount(0);
  expect((await probe(page)).activeTracks).toBe(0);
  expect(fixture.events).toEqual([]);
  expect(fixture.comparisons).toEqual([]);
  expect(fixture.sttCalls()).toBe(0);
  await page.getByRole("button", { name: "Thử bật mic", exact: true }).click();
  await expect.poll(() => fixture.events.length, { timeout: 25_000 }).toBe(1);
  expect(fixture.events[0]).toMatchObject({
    Status: "CONFIRMED",
    Metadata: {
      retry_attempt: 3,
      incorrect_retry_count: 2,
      resolution_status: "SELF_CORRECTED",
    },
  });
  await expect(page.getByText("67%", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(async () => (await probe(page)).activeTracks).toBe(0);
  expect(fixture.unexpected).toEqual([]);
});

test("Phase 7: keyboard dialog traps focus and returns it to the voice control", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page);
  const trigger = page.getByRole("button", { name: "Giọng đọc", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeFocused();
  const close = dialog.getByRole("button", { name: "Đóng hộp thoại" });
  const closeBounds = await close.boundingBox();
  expect(closeBounds).not.toBeNull();
  expect(closeBounds!.width).toBeLessThanOrEqual(64);
  expect(closeBounds!.height).toBeLessThanOrEqual(64);
  expect(closeBounds!.width).toBeGreaterThanOrEqual(44);
  expect(closeBounds!.height).toBeGreaterThanOrEqual(44);
  const buttons = dialog.locator(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
  );
  const last = buttons.last();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(buttons.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await probe(page)).microphoneRequests).toBe(0);
  expect(fixture.unexpected).toEqual([]);
});

test("Phase 7: 200 percent reading zoom keeps text and controls reachable", async ({
  page,
}, testInfo) => {
  const fixture = await installReadingExperience(page, { image: "missing" });
  // A 2x CSS zoom exercises reflow in this browser; OS zoom and screen-reader
  // behavior still require manual device acceptance.
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(
    await page.evaluate(() => document.body.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  const controls = page.getByRole("navigation", {
    name: "Điều khiển buổi đọc",
  });
  for (const button of await controls.getByRole("button").all()) {
    const label = button.locator("span").last();
    expect(
      await label.evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth &&
          element.scrollHeight <= element.clientHeight,
      ),
    ).toBe(true);
    expect(
      await label.evaluate((element) => getComputedStyle(element).textOverflow),
    ).not.toBe("ellipsis");
  }
  const words = page.locator("[data-word-id]");
  await expect(words).toHaveCount(3);
  for (const word of await words.all()) {
    await word.scrollIntoViewIfNeeded();
    await expect(word).toBeVisible();
    expect(await word.innerText()).not.toBe("");
  }
  const voice = page.getByRole("button", { name: "Giọng đọc", exact: true });
  await voice.scrollIntoViewIfNeeded();
  await voice.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: testInfo.outputPath("zoom-200.png"),
    fullPage: true,
  });
  expect(fixture.unexpected).toEqual([]);
});

test("Phase 7: reduced motion limits microphone animation and releases audio on pause", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await installReadingExperience(page);
  await page.getByRole("button", { name: startName }).click();
  const pulse = page
    .getByRole("button", { name: stopName })
    .locator(".animate-ping");
  await expect(pulse).toBeVisible();
  const animation = await pulse.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      duration: parseFloat(style.animationDuration),
      count: style.animationIterationCount,
    };
  });
  expect(animation.duration).toBeLessThanOrEqual(0.001);
  expect(animation.count).toBe("1");
  await page.getByRole("button", { name: "Tạm dừng buổi đọc" }).click();
  await expect.poll(async () => (await probe(page)).activeTracks).toBe(0);
  expect(fixture.events).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("Phase 7: transcript markup is displayed as text and cannot execute script", async ({
  page,
}) => {
  const text = "Bé <script>window.__phase7Injected=true</script> đọc";
  const fixture = await installReadingExperience(page, { sttTexts: [text] });
  await page.getByRole("button", { name: startName }).click();
  await expect(page.getByRole("button", { name: stopName })).toBeVisible();
  await page.waitForTimeout(3300);
  await page.getByRole("button", { name: stopName }).click();
  await expect(page.getByText(`“${text}”`, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => "__phase7Injected" in window)).toBe(false);
  await expect(
    page.locator("script").filter({ hasText: "window.__phase7Injected=true" }),
  ).toHaveCount(0);
  expect(fixture.sttCalls()).toBe(1);
  expect(fixture.events).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
