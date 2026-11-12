import { expect, test, type Page } from "@playwright/test";
import { installReadingExperience } from "./reading-experience-fixture";

test.describe.configure({ mode: "serial" });

async function openScenario(page: Page, scenario = "single") {
  test.skip(
    process.env.VIREAD_PHASE7_POSTGRES_E2E !== "1",
    "Requires the disposable Phase 7 backend/PostgreSQL harness",
  );
  expect(
    (
      await page.request.post("http://127.0.0.1:8000/phase7/reset", {
        data: { scenario },
      })
    ).ok(),
  ).toBe(true);
  await installReadingExperience(page);
  await page.route("http://127.0.0.1:8000/reading/**", (route) =>
    route.continue(),
  );
  await page.route("http://127.0.0.1:8000/voice/speech-to-text", (route) =>
    route.continue(),
  );
  await page.reload();
}
async function capture(page: Page) {
  await page
    .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
    .click();
  await expect(
    page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
  ).toBeVisible();
  await page.waitForTimeout(3300);
  await page.getByRole("button", { name: "Dừng nhận diện giọng nói" }).click();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
  await page.getByRole("button", { name: "Lưu và dừng", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Mình đọc lại những từ này nhé?" }),
  ).toBeVisible();
}
async function evidence(page: Page) {
  return (
    await page.request.get("http://127.0.0.1:8000/phase7/evidence")
  ).json();
}

// Opt-in: the dedicated backend-e2e harness owns its own PostgreSQL schema and
// never connects to a configured application database or paid voice provider.
test("Phase 7: native capture, real reading API and PostgreSQL preserve the first pass across retry and reload", async ({
  page,
}) => {
  test.skip(
    process.env.VIREAD_PHASE7_POSTGRES_E2E !== "1",
    "Requires the disposable Phase 7 backend/PostgreSQL harness",
  );
  const reset = await page.request.post("http://127.0.0.1:8000/phase7/reset");
  expect(reset.ok()).toBe(true);
  await installReadingExperience(page);
  await page.route("http://127.0.0.1:8000/reading/**", (route) =>
    route.continue(),
  );
  await page.route("http://127.0.0.1:8000/voice/speech-to-text", (route) =>
    route.continue(),
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
    .click();
  await expect(
    page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
  ).toBeVisible();
  await page.waitForTimeout(3300);
  await page.getByRole("button", { name: "Dừng nhận diện giọng nói" }).click();
  await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
  await page.getByRole("button", { name: "Lưu và dừng", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Mình đọc lại những từ này nhé?" }),
  ).toBeVisible();
  const before = await (
    await page.request.get("http://127.0.0.1:8000/phase7/evidence")
  ).json();
  expect(before.reports).toHaveLength(1);
  expect(before.reports[0].transcript).toBe("Bé chó đọc");
  expect(before.reports[0].summary.initial_assessment[1].status).toBe(
    "MISPRONUNCIATION",
  );
  expect(before.events).toEqual([]);
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect(page.getByText("67%", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const after = await (
    await page.request.get("http://127.0.0.1:8000/phase7/evidence")
  ).json();
  expect(after.reports).toEqual(before.reports);
  expect(after.events).toHaveLength(1);
  expect(after.events[0]).toMatchObject({
    word_id: "90000000-0000-4000-8000-000000000002",
    status: "CONFIRMED",
    metadata: { retry_attempt: 1, incorrect_retry_count: 0 },
  });
  expect(after.score).toBe(67);
  expect(after.assessment).toMatchObject({
    first_pass_correct: 2,
    first_pass_incorrect: 1,
    self_corrected_words: 1,
    retry_attempts: 1,
  });
  expect(after.stt_calls).toBe(2);
  await page.reload();
  await expect(page.getByText("67%", { exact: true })).toBeVisible();
  const reloaded = await (
    await page.request.get("http://127.0.0.1:8000/phase7/evidence")
  ).json();
  expect(reloaded).toEqual(after);
  expect(
    await page.evaluate(() => {
      const probe = (
        window as unknown as {
          __readingProbe: { microphoneRequests: number; activeTracks: number };
        }
      ).__readingProbe;
      return {
        microphoneRequests: probe.microphoneRequests,
        activeTracks: probe.activeTracks,
      };
    }),
  ).toEqual({ microphoneRequests: 0, activeTracks: 0 });
});

test("Phase 7: three original errors keep separate ordered retry identities in PostgreSQL", async ({
  page,
}) => {
  await openScenario(page, "multi");
  await capture(page);
  await save(page);
  const before = await evidence(page);
  expect(
    before.reports[0].summary.initial_assessment.map(
      (word: { status: string }) => word.status,
    ),
  ).toEqual(["MISPRONUNCIATION", "MISPRONUNCIATION", "MISPRONUNCIATION"]);
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect(page.getByText("0%", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const after = await evidence(page);
  expect(after.reports).toEqual(before.reports);
  expect(
    after.events.map((event: { word_id: string }) => event.word_id),
  ).toEqual(
    [1, 2, 3].map(
      (index) => `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ),
  );
  for (const event of after.events)
    expect(event).toMatchObject({
      status: "CONFIRMED",
      metadata: { retry_attempt: 1, incorrect_retry_count: 0 },
    });
  expect(after.assessment).toMatchObject({
    first_pass_correct: 0,
    first_pass_incorrect: 3,
    self_corrected_words: 3,
    retry_attempts: 3,
  });
  expect(after.stt_calls).toBe(4);
});

test("Phase 7: offline recovery replays a committed retry without duplicating the PostgreSQL event", async ({
  page,
}) => {
  await openScenario(page);
  await capture(page);
  await save(page);
  const received: string[] = [];
  let lost = false;
  await page.route("http://127.0.0.1:8000/reading/events", async (route) => {
    if (route.request().method() === "OPTIONS") return route.continue();
    received.push(route.request().postData()!);
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (!lost) {
      lost = true;
      await page.context().setOffline(true);
      return route.abort("failed");
    }
    return route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect(
    page.getByRole("button", { name: "Thử lưu lại", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  expect((await evidence(page)).events).toHaveLength(1);
  await page.context().setOffline(false);
  await page.getByRole("button", { name: "Thử lưu lại", exact: true }).click();
  await expect(page.getByText("67%", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(received).toHaveLength(2);
  expect(received[1]).toBe(received[0]);
  const after = await evidence(page);
  expect(after.events).toHaveLength(1);
  expect(after.assessment).toMatchObject({
    first_pass_incorrect: 1,
    self_corrected_words: 1,
    retry_attempts: 1,
  });
  expect(after.stt_calls).toBe(2);
});

test("Phase 7: page transition during native capture binds its saved evidence to the original revision", async ({
  page,
}) => {
  await openScenario(page, "pages");
  await page
    .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
    .click();
  await expect(
    page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
  ).toBeVisible();
  await page.waitForTimeout(3300);
  await page
    .getByRole("button", { name: "Trang tiếp theo", exact: true })
    .click();
  await expect(page.getByLabel("Trang sách 2", { exact: true })).toBeVisible();
  await save(page);
  const after = await evidence(page);
  expect(after.reports).toHaveLength(1);
  expect(after.reports[0]).toMatchObject({
    page_id: "55555555-5555-4555-8555-555555555555",
    page_revision_id: "66666666-6666-4666-8666-666666666666",
    transcript: "Bé chó đọc",
  });
  expect(after.reports[0].summary.initial_assessment[1]).toMatchObject({
    word_id: "90000000-0000-4000-8000-000000000002",
    status: "MISPRONUNCIATION",
  });
  expect(after.events).toEqual([]);
  expect(after.stt_calls).toBe(1);
});
