import { expect, test, type Page, type Route } from "@playwright/test";

import { ids, installApiFixture } from "./real-data-fixture";

// Isolated API/browser fixtures, not production data or a live Gemini test.
const wordIds = [
  "51000000-0000-4000-8000-000000000001",
  "51000000-0000-4000-8000-000000000002",
];
const words = ["Bé", "mèo"];
const explanation = "Mèo là một loài vật nuôi quen thuộc.";
const readingHint = "Bé đọc lại câu có từ mèo nhé.";
const headers = {
  "access-control-allow-origin": "http://127.0.0.1:3106",
  "access-control-allow-headers": "authorization,content-type,accept",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

interface TutorFixture {
  status: number;
  ttsStatus: number;
  delay: Promise<void> | null;
  calls: { page_revision_id: string; word_id: string }[];
  speech: string[];
}

function silentWav() {
  const samples = 16_000 * 3;
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16_000, 24);
  audio.writeUInt32LE(32_000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(samples * 2, 40);
  return audio;
}

async function installTutorFixture(page: Page) {
  const api = await installApiFixture(page);
  const failedRequests: string[] = [];
  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${new URL(request.url()).pathname}:${request.failure()?.errorText}`,
    );
  });
  const tutor: TutorFixture = {
    status: 200,
    ttsStatus: 200,
    delay: null,
    calls: [],
    speech: [],
  };
  async function json(route: Route, body: unknown, status = 200) {
    await route.fulfill({ status, headers, json: body });
  }
  // Page handlers run before the existing context fixture. Every other external
  // request still falls through to its deny-by-default network interceptor.
  await page.route("http://127.0.0.1:8000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers });
    }
    const tutorPath = `/tutor/sessions/${ids.session}/explain-word`;
    if (path === tutorPath) {
      expect(request.method()).toBe("POST");
      expect(request.headers().authorization).toMatch(/^Bearer /);
      const input = request.postDataJSON();
      expect(Object.keys(input).sort()).toEqual([
        "page_revision_id",
        "word_id",
      ]);
      expect(input.page_revision_id).toBe(ids.revision);
      expect(wordIds).toContain(input.word_id);
      tutor.calls.push(input);
      if (tutor.delay) await tutor.delay;
      if (tutor.status !== 200) {
        return json(route, { detail: "private-provider-secret" }, tutor.status);
      }
      return json(route, {
        ...input,
        word: words[wordIds.indexOf(input.word_id)],
        explanation,
        reading_hint: readingHint,
      });
    }
    if (path === "/voice/text-to-speech") {
      expect(request.method()).toBe("POST");
      expect(request.headers().authorization).toMatch(/^Bearer /);
      tutor.speech.push(request.postDataJSON().text);
      if (tutor.ttsStatus !== 200)
        return json(route, { detail: "private-tts-secret" }, tutor.ttsStatus);
      return route.fulfill({
        headers,
        contentType: "audio/wav",
        body: silentWav(),
      });
    }
    if (request.method() !== "GET") return route.fallback();
    if (path === `/reading/sessions/${ids.session}`)
      return json(route, {
        id: ids.session,
        child_id: ids.child,
        book_id: ids.book,
        state: "PAGE_READY",
        started_at: "2026-10-17T00:00:00Z",
        ended_at: null,
        duration_ms: null,
      });
    if (path === `/reading/sessions/${ids.session}/page`)
      return json(route, {
        page_id: ids.page,
        page_revision_id: ids.revision,
        page_number: 1,
        confidence: 1,
        width: 600,
        height: 800,
        words: words.map((text, index) => ({
          text,
          word_id: wordIds[index],
          word_index: index,
          bbox: [0.1 + index * 0.15, 0.2, 0.1, 0.05],
        })),
      });
    if (path === `/reading/sessions/${ids.session}/completion-summary`)
      return json(route, {
        duration_minutes: null,
        pages_explored: null,
        practiced_words: null,
        spoken_words: null,
        transcripts: null,
      });
    if (path === `/books/catalog/${ids.book}/preview`) return json(route, []);
    return route.fallback();
  });
  await page.addInitScript(() => {
    // No external browser speech service, actual mic or camera in this suite.
    Object.defineProperty(window, "SpeechRecognition", { value: undefined });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: undefined,
    });
  });
  await page.goto(`/reading/${ids.session}?state=reading`);
  try {
    await expect(page.getByLabel("Trợ giảng đọc sách")).toBeVisible();
  } catch {
    throw new Error(
      JSON.stringify({
        unexpected: api.unexpected,
        requests: api.requests,
        failedRequests,
        hasFixtureCookie: (await page.context().cookies()).some(
          (cookie) => cookie.name === "sb-example-auth-token",
        ),
      }),
    );
  }
  return { api, tutor };
}

const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Mình cùng hiểu từ này nhé!" });

async function openTutor(page: Page) {
  await page.locator(`[data-word-id="${wordIds[1]}"]`).click();
  await page
    .getByRole("button", { name: "Giải thích từ", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
}

test("Tutor requests only on explicit action, caches and reflows", async ({
  page,
}, testInfo) => {
  const { api, tutor } = await installTutorFixture(page);
  const trigger = page.getByRole("button", {
    name: "Giải thích từ",
    exact: true,
  });
  await expect(trigger).toBeDisabled();
  expect(tutor.calls).toHaveLength(0);
  await page.locator(`[data-word-id="${wordIds[1]}"]`).focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toBeEnabled();
  expect(tutor.calls).toHaveLength(0);
  await trigger.click();
  await expect(
    dialog(page).getByText(explanation, { exact: true }),
  ).toBeVisible();
  expect(tutor.calls).toEqual([
    { page_revision_id: ids.revision, word_id: wordIds[1] },
  ]);
  expect(tutor.speech).toEqual([]);
  const closeBox = await dialog(page)
    .getByRole("button", { name: "Đóng hộp thoại" })
    .boundingBox();
  const titleBox = await dialog(page)
    .getByRole("heading", { name: "Mình cùng hiểu từ này nhé!" })
    .boundingBox();
  expect(closeBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(closeBox!.width).toBeLessThanOrEqual(52);
  expect(titleBox!.height).toBeLessThan(150);
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog(page).getByRole("button", { name: "Đọc tiếp" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog(page).getByRole("button", { name: "Đóng hộp thoại" }),
  ).toBeFocused();
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  await page.screenshot({
    path: testInfo.outputPath("ai-tutor-ready.png"),
    fullPage: true,
    caret: "initial",
  });
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(
    dialog(page).getByText(explanation, { exact: true }),
  ).toBeVisible();
  expect(tutor.calls).toHaveLength(1);
  await dialog(page).getByRole("button", { name: "Đọc tiếp" }).click();
  await expect(
    page.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
  ).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Tutor provider failure is safe and retries only on user click", async ({
  page,
}) => {
  const { api, tutor } = await installTutorFixture(page);
  tutor.status = 503;
  await openTutor(page);
  await expect(
    dialog(page).getByText(/Mình chưa giải thích được/),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    "private-provider-secret",
  );
  expect(tutor.calls).toHaveLength(1);
  tutor.status = 200;
  await dialog(page).getByRole("button", { name: "Thử lại" }).click();
  await expect(
    dialog(page).getByText(explanation, { exact: true }),
  ).toBeVisible();
  expect(tutor.calls).toHaveLength(2);
  expect(api.unexpected).toEqual([]);
});

test("Tutor revision conflict is recoverable without retry or fake answer", async ({
  page,
}) => {
  const { api, tutor } = await installTutorFixture(page);
  tutor.status = 409;
  await openTutor(page);
  await expect(dialog(page).getByText(/Bé hãy chọn lại một từ/)).toBeVisible();
  await expect(
    dialog(page).getByRole("button", { name: "Thử lại" }),
  ).toHaveCount(0);
  await expect(
    dialog(page).getByText(explanation, { exact: true }),
  ).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Đọc tiếp" }).click();
  await expect(page.getByLabel("Trang sách 1")).toBeVisible();
  expect(api.unexpected).toEqual([]);
});

test("Closing a pending explanation does not reopen it on late response", async ({
  page,
}) => {
  const { api, tutor } = await installTutorFixture(page);
  let release!: () => void;
  tutor.delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await openTutor(page);
    await expect(dialog(page).getByRole("status")).toContainText(
      "Mình đang tìm",
    );
    await expect.poll(() => tutor.calls.length).toBe(1);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
  } finally {
    release();
    tutor.delay = null;
  }
  await openTutor(page);
  await expect(
    dialog(page).getByText(explanation, { exact: true }),
  ).toBeVisible();
  expect(tutor.calls).toHaveLength(2);
  expect(api.unexpected).toEqual([]);
});

test("Tutor audio is explicit, separate from generation and optional on failure", async ({
  page,
}) => {
  const { api, tutor } = await installTutorFixture(page);
  await openTutor(page);
  const listen = dialog(page).getByRole("button", { name: "Nghe giải thích" });
  await expect(listen).toBeVisible();
  expect(tutor.speech).toEqual([]);
  await listen.click();
  await expect(
    dialog(page).getByRole("button", { name: "Dừng giải thích" }),
  ).toBeVisible();
  expect(tutor.speech).toEqual([`${explanation} ${readingHint}`]);
  await dialog(page).getByRole("button", { name: "Dừng giải thích" }).click();
  tutor.ttsStatus = 503;
  await listen.click();
  await expect(
    dialog(page).getByText(/Mình chưa phát được âm thanh/),
  ).toBeVisible();
  await expect(
    dialog(page).getByText(explanation, { exact: true }),
  ).toBeVisible();
  expect(tutor.calls).toHaveLength(1);
  await expect(page.locator("body")).not.toContainText("private-tts-secret");
  expect(api.unexpected).toEqual([]);
});

test("Tutor pauses the microphone and resumes only on Continue, never Escape", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let starts = 0;
    let stops = 0;
    Object.defineProperty(window, "tutorMicrophoneCounts", {
      get: () => ({ starts, stops }),
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        starts += 1;
        // A browser-generated silent stream, never the user's microphone.
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            stops += 1;
            stop();
            oscillator.stop();
            void context.close();
          };
        }
        return destination.stream;
      },
    });
  });
  const { api, tutor } = await installTutorFixture(page);
  const counts = () =>
    page.evaluate(
      () =>
        (
          window as typeof window & {
            tutorMicrophoneCounts: { starts: number; stops: number };
          }
        ).tutorMicrophoneCounts,
    );
  await page
    .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
    .click();
  await expect(
    page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
  ).toBeVisible();
  await openTutor(page);
  await expect(
    dialog(page).getByText(explanation, { exact: true }),
  ).toBeVisible();
  await expect.poll(counts).toEqual({ starts: 1, stops: 1 });
  await dialog(page).getByRole("button", { name: "Đọc tiếp" }).click();
  await expect(
    page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
  ).toBeVisible();
  await expect.poll(counts).toEqual({ starts: 2, stops: 1 });
  await page
    .getByRole("button", { name: "Giải thích từ", exact: true })
    .click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
  ).toBeVisible();
  await expect.poll(counts).toEqual({ starts: 2, stops: 2 });
  expect(tutor.calls).toHaveLength(1);
  expect(tutor.speech).toEqual([]);
  expect(api.unexpected).toEqual([]);
});
