import { expect, test, type Page, type Route } from "@playwright/test";
import { ids, installApiFixture } from "./real-data-fixture";

interface Probe {
  audios: HTMLAudioElement[];
  utterances: SpeechSynthesisUtterance[];
  microphoneRequests: number;
  cancels: number;
  pauses: number;
  resumes: number;
}
declare global {
  interface Window {
    __ttsProbe: Probe;
  }
}

function silentWav(seconds: number): string {
  // Synthetic silence tests the real decoder/media clock, never a child's audio.
  const bytes = 16_000 * 2 * seconds;
  const audio = Buffer.alloc(44 + bytes);
  audio.write("RIFF");
  audio.writeUInt32LE(36 + bytes, 4);
  audio.write("WAVE", 8);
  audio.write("fmt ", 12);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16_000, 24);
  audio.writeUInt32LE(32_000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(bytes, 40);
  return audio.toString("base64");
}

async function installReading(
  page: Page,
  options: {
    longPage?: boolean;
    fallback?: boolean;
    noVietnameseVoice?: boolean;
  } = {},
) {
  const api = await installApiFixture(page);
  const secondPage = "55555555-5555-4555-8555-555555555556";
  const secondRevision = "66666666-6666-4666-8666-666666666667";
  const text = options.longPage
    ? Array(801).fill("bé").join(" ")
    : "Bé mèo nhỏ đang đọc sách cùng mẹ.";
  let current = 0;
  const requests: { words: string[]; voice_id?: string; speed?: number }[] = [];
  const unexpected: string[] = [];
  const writes: string[] = [];
  const prompts: { text: string; voice_id?: string; speed?: number }[] = [];
  const headers = {
    "access-control-allow-origin": "http://127.0.0.1:3106",
    "access-control-allow-headers": "authorization,content-type,accept",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
  const respond = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      headers,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  const progress = () => ({
    session_id: ids.session,
    persisted: true,
    start_page_id: ids.page,
    end_page_id: secondPage,
    current_page_id: current ? secondPage : ids.page,
    start_page_number: 1,
    end_page_number: 2,
    current_page_number: current + 1,
    current_index: current,
    total_pages: 2,
    completed_pages: 0,
    pages: [ids.page, secondPage].map((id, index) => ({
      page_id: id,
      page_revision_id: index ? secondRevision : ids.revision,
      page_number: index + 1,
      page_order: index,
      status: index === current ? "IN_PROGRESS" : "PENDING",
      started_at: null,
      completed_at: null,
    })),
  });
  await page.route("http://127.0.0.1:8000/reading/**", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const path = new URL(route.request().url()).pathname;
    const base = `/reading/sessions/${ids.session}`;
    if (path === base + "/practice-state")
      return respond(route, {
        session_id: ids.session,
        legacy_evidence_present: false,
        pages: [],
        words: [],
      });
    if (path === base)
      return respond(route, {
        id: ids.session,
        child_id: ids.child,
        book_id: ids.book,
        state: "PAGE_READY",
        started_at: "2026-11-11T00:00:00Z",
        ended_at: null,
        duration_ms: null,
      });
    if (path === base + "/page") {
      const pageText = current ? "Trang mới bé đọc." : text;
      return respond(route, {
        page_id: current ? secondPage : ids.page,
        page_revision_id: current ? secondRevision : ids.revision,
        page_number: current + 1,
        confidence: null,
        width: 800,
        height: 1000,
        image_url: null,
        text: pageText,
        words: pageText.split(/\s+/u).map((word, index) => ({
          word_id: `90000000-0000-4000-8000-${String(index + 1 + current * 10000).padStart(12, "0")}`,
          word_index: index,
          text: word,
          bbox: [
            0.05 + (index % 4) * 0.2,
            0.1 + (Math.floor(index / 4) % 10) * 0.07,
            0.15,
            0.05,
          ],
          line_index: Math.floor(index / 4),
        })),
      });
    }
    if (path === base + "/progress") return respond(route, progress());
    if (path === base + "/completion-summary")
      return respond(route, {
        duration_minutes: null,
        pages_explored: 0,
        selected_range_pages: 2,
        practiced_words: 0,
      });
    if (path === base + "/navigate") {
      current =
        route.request().postDataJSON().target_page_id === secondPage ? 1 : 0;
      return respond(route, progress());
    }
    if (route.request().method() !== "GET") writes.push(path);
    unexpected.push(path);
    return respond(route, {}, 404);
  });
  await page.route("http://127.0.0.1:8000/voice/**", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const path = new URL(route.request().url()).pathname;
    if (path === "/voice/voices")
      return respond(route, {
        default_voice_id: "voice_female",
        voices: [
          { voice_id: "voice_female", name: "Giọng nữ API", gender: "female" },
          { voice_id: "voice_male", name: "Giọng nam API", gender: "male" },
          { voice_id: "voice_young", name: "Giọng Mai API", age: "young" },
          { voice_id: "voice_unknown", name: "Giọng chưa có metadata" },
        ],
      });
    if (path === "/voice/text-to-speech/timed") {
      const body = route.request().postDataJSON() as {
        words: string[];
        voice_id?: string;
        speed?: number;
      };
      requests.push(body);
      if (options.fallback)
        return respond(route, { detail: { code: "SPEECH_UNAVAILABLE" } }, 503);
      const duration = options.longPage ? 1 : 8;
      return respond(route, {
        audio_base64: silentWav(duration),
        content_type: "audio/wav",
        duration_seconds: duration,
        words: body.words.map((_word, index) => ({
          index,
          start: (index * duration) / body.words.length,
          end: ((index + 1) * duration) / body.words.length,
        })),
      });
    }
    if (path === "/voice/text-to-speech") {
      prompts.push(
        route.request().postDataJSON() as {
          text: string;
          voice_id?: string;
          speed?: number;
        },
      );
      return route.fulfill({
        status: 200,
        headers,
        contentType: "audio/wav",
        body: Buffer.from(silentWav(8), "base64"),
      });
    }
    unexpected.push(path);
    return respond(route, {}, 404);
  });
  await page.addInitScript(
    ({ noVietnameseVoice }) => {
      const probe: Probe = {
        audios: [],
        utterances: [],
        microphoneRequests: 0,
        cancels: 0,
        pauses: 0,
        resumes: 0,
      };
      window.__ttsProbe = probe;
      const OriginalAudio = window.Audio;
      Object.defineProperty(window, "Audio", {
        configurable: true,
        value: function (src?: string) {
          const audio = new OriginalAudio(src);
          probe.audios.push(audio);
          return audio;
        },
      });
      if (navigator.mediaDevices)
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          configurable: true,
          value: async () => {
            probe.microphoneRequests += 1;
            throw new DOMException(
              "No hardware in isolated TTS test",
              "NotAllowedError",
            );
          },
        });
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(window, "webkitSpeechRecognition", {
        configurable: true,
        value: undefined,
      });
      class DeviceUtteranceFixture {
        lang = "";
        rate = 1;
        pitch = 1;
        voice: SpeechSynthesisVoice | null = null;
        onstart: SpeechSynthesisUtterance["onstart"] = null;
        onboundary: SpeechSynthesisUtterance["onboundary"] = null;
        onend: SpeechSynthesisUtterance["onend"] = null;
        onerror: SpeechSynthesisUtterance["onerror"] = null;
        constructor(readonly text: string) {}
      }
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        configurable: true,
        value: DeviceUtteranceFixture,
      });
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          getVoices: () => [{ lang: noVietnameseVoice ? "en-US" : "vi-VN" }],
          speak: (utterance: SpeechSynthesisUtterance) => {
            probe.utterances.push(utterance);
            utterance.onstart?.({
              utterance,
              elapsedTime: 0,
              charIndex: 0,
            } as SpeechSynthesisEvent);
          },
          cancel: () => {
            probe.cancels += 1;
          },
          pause: () => {
            probe.pauses += 1;
          },
          resume: () => {
            probe.resumes += 1;
          },
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
      });
    },
    { noVietnameseVoice: options.noVietnameseVoice ?? false },
  );
  await page.goto(`/reading/${ids.session}?state=reading`);
  await expect(
    page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
  ).toBeVisible();
  return { api, requests, unexpected, writes, text, prompts };
}

test("Phase 3: selecting a second word keeps the newest word sample active", async ({
  page,
}) => {
  const fixture = await installReading(page);
  await page.getByRole("button", { name: "Bé", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios[0]?.paused))
    .toBe(false);
  await page.getByRole("button", { name: "mèo", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios[1]?.paused))
    .toBe(false);
  expect(await page.evaluate(() => window.__ttsProbe.audios[0].paused)).toBe(
    true,
  );
  await expect(page.getByText("Đọc mẫu 1 chữ:")).toBeVisible();
  expect(fixture.prompts.map((prompt) => prompt.text)).toEqual(["Bé", "mèo"]);
  expect(fixture.prompts.every((prompt) => prompt.speed === 0.9)).toBe(true);
  expect(fixture.writes).toEqual([]);
});

test("Phase 3: real voice IDs, honest metadata and speed apply to previews", async ({
  page,
}, testInfo) => {
  const fixture = await installReading(page);
  await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
  await page.getByRole("radio", { name: /Giọng nam API/ }).click();
  await page.getByRole("slider").focus();
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Nghe thử", exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  expect(fixture.requests[0]).toMatchObject({
    voice_id: "voice_male",
    speed: 0.7,
  });
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios[0]?.paused))
    .toBe(false);
  await page.getByRole("radio", { name: /Giọng nữ API/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios[0]?.paused))
    .toBe(true);
  await page.getByRole("radio", { name: /Giọng Mai API/ }).click();
  await page.getByRole("slider").focus();
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "Nghe thử", exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(2);
  expect(fixture.requests[1]).toMatchObject({
    voice_id: "voice_young",
    speed: 1.2,
  });
  await page.screenshot({
    path: testInfo.outputPath("voice-speed-settings.png"),
  });
  await page.getByRole("button", { name: "Đóng hộp thoại" }).click();
  expect(fixture.api.unexpected).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("Phase 3: real audio clock, pause/resume and page transition cleanup", async ({
  page,
}, testInfo) => {
  const fixture = await installReading(page);
  await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__ttsProbe.audios[0]?.currentTime ?? 0),
    )
    .toBeGreaterThan(0.3);
  await page.getByRole("button", { name: "Tạm dừng mẫu", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("tts-paused-playback.png"),
    fullPage: true,
  });
  const time = await page.evaluate(
    () => window.__ttsProbe.audios[0].currentTime,
  );
  await page.waitForTimeout(250);
  expect(
    Math.abs(
      (await page.evaluate(() => window.__ttsProbe.audios[0].currentTime)) -
        time,
    ),
  ).toBeLessThan(0.05);
  await page.screenshot({ path: testInfo.outputPath("paused-tts.png") });
  await page.getByRole("button", { name: "Tiếp tục mẫu", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios[0].currentTime))
    .toBeGreaterThan(time + 0.1);
  expect(await page.evaluate(() => window.__ttsProbe.microphoneRequests)).toBe(
    0,
  );
  await page.getByRole("button", { name: "Trang tiếp theo" }).click();
  await expect(
    page
      .locator('[data-page-revision-id="66666666-6666-4666-8666-666666666667"]')
      .first(),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__ttsProbe.audios[0].paused)).toBe(
    true,
  );
  await expect(page.locator("[data-child-error-count]")).toHaveAttribute(
    "data-child-error-count",
    "0",
  );
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("Phase 3: 801 words finish through two separately decoded chunks", async ({
  page,
}) => {
  const fixture = await installReading(page, { longPage: true });
  await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
  await expect
    .poll(() => fixture.requests.map((request) => request.words.length))
    .toEqual([800, 1]);
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios.length))
    .toBe(2);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__ttsProbe.audios.every((audio) => audio.paused),
      ),
    )
    .toBe(true);
  expect(fixture.requests.flatMap((request) => request.words).join(" ")).toBe(
    fixture.text,
  );
  await expect(page.locator("[data-child-error-count]")).toHaveAttribute(
    "data-child-error-count",
    "0",
  );
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("Phase 3: browser fallback uses boundary events and stops safely", async ({
  page,
}, testInfo) => {
  const fixture = await installReading(page, { fallback: true });
  await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.utterances.length))
    .toBe(1);
  expect(await page.evaluate(() => window.__ttsProbe.utterances[0].rate)).toBe(
    0.9,
  );
  await page.evaluate(() => {
    const utterance = window.__ttsProbe.utterances[0];
    utterance.onboundary?.({
      utterance,
      charIndex: 3,
      elapsedTime: 0.5,
    } as SpeechSynthesisEvent);
  });
  await expect(
    page.locator('[data-word-id="90000000-0000-4000-8000-000000000002"]'),
  ).toHaveClass(/bg-yellow-300/);
  await page.screenshot({
    path: testInfo.outputPath("fallback-word-highlight.png"),
  });
  await page.getByRole("button", { name: "Tạm dừng mẫu", exact: true }).click();
  await page.getByRole("button", { name: "Tiếp tục mẫu", exact: true }).click();
  expect(await page.evaluate(() => window.__ttsProbe.pauses)).toBe(1);
  expect(await page.evaluate(() => window.__ttsProbe.resumes)).toBe(1);
  await page.getByRole("button", { name: "Dừng đọc mẫu", exact: true }).click();
  expect(await page.evaluate(() => window.__ttsProbe.cancels)).toBe(1);
  await expect(page.locator("[data-child-error-count]")).toHaveAttribute(
    "data-child-error-count",
    "0",
  );
  expect(fixture.writes).toEqual([]);
});

test("Phase 3: unavailable Vietnamese browser voice produces a safe recoverable error", async ({
  page,
}) => {
  const fixture = await installReading(page, {
    fallback: true,
    noVietnameseVoice: true,
  });
  await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
  await expect(
    page.getByText(
      "Mình chưa phát được âm thanh. Bé vẫn có thể nhìn chữ và đọc tiếp nhé.",
    ),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__ttsProbe.utterances.length)).toBe(
    0,
  );
  await expect(page.locator("[data-child-error-count]")).toHaveAttribute(
    "data-child-error-count",
    "0",
  );
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.writes).toEqual([]);
});
