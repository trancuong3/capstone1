import { expect, test } from "@playwright/test";
import {
  installReadingExperience,
  readingWords,
} from "./reading-experience-fixture";

test("A new first pass persists the original error before native retry self-correction", async ({
  page,
}) => {
  const fixture = await installReadingExperience(page, {
    sttTexts: ["Bé chó đọc", "mèo"],
  });
  await page
    .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
    .click();
  const stop = page.getByRole("button", { name: "Dừng nhận diện giọng nói" });
  await expect(stop).toBeVisible();
  // Only a deterministic oscillator stream is recorded. The transcript is an
  // intercepted provider response, not a speech-accuracy measurement.
  await page.waitForTimeout(3300);
  await stop.click();
  await expect.poll(() => fixture.sttCalls()).toBe(1);
  await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
  await page.getByRole("button", { name: "Lưu và dừng", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Mình đọc lại những từ này nhé?" }),
  ).toBeVisible();
  expect(fixture.comparisons).toHaveLength(1);
  const initial = fixture.comparisons[0];
  expect(initial).toMatchObject({ transcript: "Bé chó đọc", finalize: true });
  const assessment = initial.initial_assessment as {
    word_id: string;
    status: string;
  }[];
  expect(assessment.map((word) => word.word_id)).toEqual(
    readingWords.map((word) => word.word_id),
  );
  expect(assessment[0].status).toBe("CORRECT");
  expect(assessment[1].status).toMatch(/^(MISPRONUNCIATION|OMISSION)$/);
  expect(assessment[2].status).toBe("CORRECT");
  const frozen = structuredClone(initial);
  await page.getByRole("button", { name: "Đồng ý, đọc lại" }).click();
  await expect(page.getByText("67%", { exact: true })).toBeVisible({
    timeout: 25000,
  });
  expect(fixture.events).toHaveLength(1);
  expect(fixture.events[0]).toMatchObject({
    Status: "CONFIRMED",
    Metadata: {
      retry_attempt: 1,
      incorrect_retry_count: 0,
      resolution_status: "SELF_CORRECTED",
    },
  });
  expect(fixture.comparisons).toEqual([frozen]);
  expect(fixture.sttCalls()).toBe(2);
  expect(fixture.unexpected).toEqual([]);
});
