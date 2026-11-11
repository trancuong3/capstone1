import { expect, test, type Page } from "@playwright/test";
import {
  installReadingExperience,
  readingWords,
} from "./reading-experience-fixture";
import { ids } from "./real-data-fixture";

// Native MediaRecorder receives the fixture's oscillator, never a microphone.
// These tests check the application's submitted evidence. Report aggregation
// is tested against the real backend functions in test_reading_assessment.py.
async function capture(page: Page) {
  await page
    .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
    .click();
  await expect(
    page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
  ).toBeVisible();
  await page.waitForTimeout(3300);
  await page.getByRole("button", { name: "Dừng nhận diện giọng nói" }).click();
  await expect(
    page.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
  ).toBeEnabled();
}

async function save(page: Page) {
  await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
  await page.getByRole("button", { name: "Lưu và dừng", exact: true }).click();
}

async function installSecondPage(page: Page) {
  const secondPage = "55555555-5555-4555-8555-555555555556";
  const secondRevision = "66666666-6666-4666-8666-666666666667";
  let index = 0;
  const headers = {
    "access-control-allow-origin": "http://127.0.0.1:3106",
    "access-control-allow-headers": "authorization,content-type,accept",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
  const pages = [ids.page, secondPage].map((id, position) => ({
    page_id: id,
    page_revision_id: position ? secondRevision : ids.revision,
    page_number: position + 1,
    page_order: position,
    status: position ? "PENDING" : "IN_PROGRESS",
    started_at: null,
    completed_at: null,
  }));
  await page.route("http://127.0.0.1:8000/reading/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const base = `/reading/sessions/${ids.session}`;
    if (
      ![`${base}/page`, `${base}/progress`, `${base}/navigate`].includes(path)
    )
      return route.fallback();
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (path.endsWith("/navigate")) {
      const body = request.postDataJSON() as { target_page_id: string };
      expect([ids.page, secondPage]).toContain(body.target_page_id);
      index = body.target_page_id === ids.page ? 0 : 1;
    }
    const current = pages[index];
    const body = path.endsWith("/page")
      ? {
          ...current,
          confidence: null,
          width: 600,
          height: 800,
          image_url: null,
          text: "Bé mèo đọc",
          words: readingWords.map((word, position) => ({
            ...word,
            word_id: index
              ? `90000000-0000-4000-8000-${String(position + 11).padStart(12, "0")}`
              : word.word_id,
          })),
        }
      : {
          session_id: ids.session,
          persisted: true,
          start_page_id: ids.page,
          end_page_id: secondPage,
          current_page_id: current.page_id,
          start_page_number: 1,
          end_page_number: 2,
          current_page_number: index + 1,
          current_index: index,
          total_pages: 2,
          completed_pages: 0,
          pages,
        };
    await route.fulfill({
      status: 200,
      headers,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Trang tiếp theo" }),
  ).toBeEnabled();
}

test("Revisiting a completed page preserves its first error and transcript", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page, {
    sttTexts: ["Bé chó đọc", "Bé mèo đọc"],
  });
  await installSecondPage(page);
  await capture(page);
  await page.getByRole("button", { name: "Trang tiếp theo" }).click();
  await expect(page.getByLabel("Trang sách 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Trang trước" }).click();
  await expect(page.getByLabel("Trang sách 1", { exact: true })).toBeVisible();
  await capture(page);
  await save(page);
  await expect(
    page.getByRole("dialog", { name: "Mình đọc lại những từ này nhé?" }),
  ).toBeVisible();
  expect(fixture.sttCalls()).toBe(2);
  expect(fixture.comparisons).toHaveLength(1);
  expect(fixture.comparisons[0]).toMatchObject({
    page_id: ids.page,
    page_revision_id: ids.revision,
    transcript: "Bé chó đọc",
    finalize: true,
    initial_assessment: readingWords.map((word, index) => ({
      word_id: word.word_id,
      status: index === 1 ? "MISPRONUNCIATION" : "CORRECT",
    })),
  });
  expect(fixture.events).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("An unclear later segment retains known words and persists uncertainty", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page, {
    sttTexts: ["Bé", ""],
  });
  await capture(page);
  await capture(page);
  await save(page);
  await expect.poll(() => fixture.comparisons.length).toBe(1);
  expect(fixture.comparisons[0]).toMatchObject({
    transcript: "Bé",
    finalize: true,
    initial_assessment: readingWords.map((word, index) => ({
      word_id: word.word_id,
      status: index === 0 ? "CORRECT" : "UNCERTAIN",
    })),
  });
  expect(fixture.events).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("A repeated correct word remains correct in the saved first pass", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page, {
    sttTexts: ["Bé mèo mèo đọc"],
  });
  await capture(page);
  await save(page);
  await expect.poll(() => fixture.comparisons.length).toBe(1);
  expect(fixture.comparisons[0]).toMatchObject({
    transcript: "Bé mèo mèo đọc",
    finalize: true,
    initial_assessment: readingWords.map((word) => ({
      word_id: word.word_id,
      status: "CORRECT",
    })),
  });
  expect(fixture.events).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
