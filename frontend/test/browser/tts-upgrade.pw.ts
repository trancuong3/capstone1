import { expect, test, type Page, type Route } from "@playwright/test";
import {
  ids,
  installApiFixture,
  PLAYWRIGHT_ORIGIN,
  readyVoiceStatus,
} from "./real-data-fixture";

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
    shortTtsFail?: boolean;
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
  const prompts: {
    text: string;
    voice_id?: string;
    speed?: number;
    word_sample?: boolean;
  }[] = [];
  const headers = {
    "access-control-allow-origin": PLAYWRIGHT_ORIGIN,
    "access-control-allow-headers":
      "authorization,content-type,accept,x-voice-policy-mode,x-allow-google-stt-fallback,x-allow-google-tts-fallback,x-voice-region,x-voice-session-id,x-voice-page-id,x-voice-turn-id,x-voice-lock-update",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
    "access-control-expose-headers":
      "x-voice-provider,x-resolved-voice-id,x-voice-region,x-voice-model-version,x-voice-fallback,x-voice-gender",
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
    if (path === "/voice/status" && route.request().method() === "GET")
      return respond(route, readyVoiceStatus("voice_female"));
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
    if (path === "/voice/session-lock" && route.request().method() === "PUT") {
      const body = (route.request().postDataJSON() ?? {}) as {
        session_id?: string;
        voice_id?: string;
      };
      return respond(route, {
        session_id: body.session_id ?? ids.session,
        voice_id: body.voice_id ?? "voice_female",
        provider: (body.voice_id ?? "").startsWith("google_")
          ? "google"
          : "local",
        locked: true,
      });
    }
    if (path === "/voice/phonics/analyze") {
      const body = route.request().postDataJSON() as { text?: string };
      const text = body.text ?? "";
      return respond(route, {
        supported: false,
        source: "none",
        raw_text: text,
        clean_phrase: text,
        syllables: [],
        focus_syllable_index: 0,
        focus_syllable: "",
        steps: [],
        message: "Chưa có mẫu đánh vần",
        can_play_whole_word: true,
      });
    }
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
      if (options.shortTtsFail)
        return respond(
          route,
          { detail: { code: "LOCAL_TTS_UNAVAILABLE" } },
          503,
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

test("Phase 3: a second word cancels the first locked-voice sample with zero OS voice switching", async ({
  page,
}) => {
  const fixture = await installReading(page);
  await page.getByRole("button", { name: "Bé", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios.length))
    .toBe(1);
  await page.getByRole("button", { name: "mèo", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios.length))
    .toBe(2);

  // Word samples strictly use the session-locked voice (never OS speechSynthesis).
  // Selecting a second word cancels the first audio element cleanly.
  const playback = await page.evaluate(() => ({
    utteranceCount: window.__ttsProbe.utterances.length,
    firstPaused: window.__ttsProbe.audios[0]?.paused === true,
    secondActive: window.__ttsProbe.audios[1]?.paused === false,
  }));
  expect(playback.utteranceCount).toBe(0);
  expect(playback.firstPaused).toBe(true);
  expect(playback.secondActive).toBe(true);
  await expect(page.getByText("Đọc mẫu từ")).toBeVisible();
  const wordPromptTexts = fixture.prompts
    .filter((p) => p.word_sample)
    .map((p) => p.text);
  expect(wordPromptTexts).toContain("bé");
  expect(wordPromptTexts).toContain("mèo");
  expect(wordPromptTexts.indexOf("bé")).toBeLessThan(
    wordPromptTexts.indexOf("mèo"),
  );
  expect(fixture.requests).toEqual([]);
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

test("Phase 3: timed failure falls back to locked-voice short TTS without OS voice switching", async ({
  page,
}, testInfo) => {
  const fixture = await installReading(page, { fallback: true });
  await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios.length))
    .toBe(1);
  expect(await page.evaluate(() => window.__ttsProbe.utterances.length)).toBe(
    0,
  );
  expect(
    fixture.prompts.filter((prompt) => prompt.text === fixture.text),
  ).toEqual([
    expect.objectContaining({
      text: fixture.text,
      voice_id: fixture.requests[0]?.voice_id,
    }),
  ]);
  await page.screenshot({
    path: testInfo.outputPath("fallback-word-highlight.png"),
  });
  await page.getByRole("button", { name: "Tạm dừng mẫu", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios[0]?.paused))
    .toBe(true);
  await page.getByRole("button", { name: "Tiếp tục mẫu", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios[0]?.paused))
    .toBe(false);
  await page.getByRole("button", { name: "Dừng đọc mẫu", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios[0]?.paused))
    .toBe(true);
  await expect(page.locator("[data-child-error-count]")).toHaveAttribute(
    "data-child-error-count",
    "0",
  );
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("Phase 3: unavailable TTS produces a safe recoverable error with zero OS voice switching", async ({
  page,
}) => {
  const fixture = await installReading(page, {
    fallback: true,
    shortTtsFail: true,
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
  expect(
    fixture.prompts.filter((prompt) => prompt.text === fixture.text),
  ).toHaveLength(1);
  expect(await page.evaluate(() => window.__ttsProbe.microphoneRequests)).toBe(
    0,
  );
  await page.getByRole("button", { name: "Đọc tiếp", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
  ).toBeEnabled();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("Dashboard AI teacher selection auto-plays precomputed greeting, persists per child across reload, and syncs male persona into Reading", async ({
  page,
}, testInfo) => {
  const api = await installApiFixture(page);
  const ttsPayloads: Array<{
    text?: string;
    voice_id?: string;
    speed?: number;
    cache_scope?: string;
    word_sample?: boolean;
  }> = [];
  const timedPayloads: Array<{
    words?: string[];
    voice_id?: string;
    speed?: number;
  }> = [];
  const sessionLockUpdates: Array<{ session_id?: string; voice_id?: string }> =
    [];
  const corsHeaders = {
    "access-control-allow-origin": PLAYWRIGHT_ORIGIN,
    "access-control-allow-headers":
      "authorization,content-type,accept,x-voice-policy-mode,x-allow-google-stt-fallback,x-allow-google-tts-fallback,x-voice-region,x-voice-session-id,x-voice-page-id,x-voice-turn-id,x-voice-lock-update",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
    "access-control-expose-headers":
      "x-voice-provider,x-resolved-voice-id,x-voice-region,x-voice-model-version,x-voice-fallback,x-voice-gender",
  };

  for (const optionalPattern of [
    "http://127.0.0.1:8000/phoneme-garden/**",
    "http://127.0.0.1:8000/dialect/**",
  ]) {
    await page.route(optionalPattern, async (route) => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: corsHeaders });
      }
      return route.fulfill({
        status: 200,
        headers: corsHeaders,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });
  }

  await page.route("http://127.0.0.1:8000/reading/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const base = `/reading/sessions/${ids.session}`;
    if (!path.startsWith(base) || path.endsWith("/reports")) {
      return route.fallback();
    }
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    const fulfillJson = (body: unknown) =>
      route.fulfill({
        status: 200,
        headers: corsHeaders,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === `${base}/practice-state`) {
      return fulfillJson({
        session_id: ids.session,
        legacy_evidence_present: false,
        pages: [],
        words: [],
      });
    }
    if (path === base) {
      return fulfillJson({
        id: ids.session,
        child_id: ids.child,
        book_id: ids.book,
        state: "PAGE_READY",
        started_at: "2026-11-11T00:00:00Z",
        ended_at: null,
        duration_ms: null,
      });
    }
    if (path === `${base}/page`) {
      const pageText = "Bé mèo nhỏ đọc sách.";
      return fulfillJson({
        page_id: ids.page,
        page_revision_id: ids.revision,
        page_number: 1,
        confidence: null,
        width: 800,
        height: 1000,
        image_url: null,
        text: pageText,
        words: pageText.split(/\s+/u).map((w, index) => ({
          word_id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          word_index: index,
          text: w,
          bbox: [0.05 + index * 0.16, 0.15, 0.14, 0.05],
          line_index: 0,
        })),
      });
    }
    if (path === `${base}/progress`) {
      return fulfillJson({
        session_id: ids.session,
        persisted: true,
        start_page_id: ids.page,
        end_page_id: ids.page,
        current_page_id: ids.page,
        start_page_number: 1,
        end_page_number: 1,
        current_page_number: 1,
        current_index: 0,
        total_pages: 1,
        completed_pages: 0,
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            page_order: 0,
            status: "IN_PROGRESS",
            started_at: null,
            completed_at: null,
          },
        ],
      });
    }
    if (path === `${base}/completion-summary`) {
      return fulfillJson({
        duration_minutes: null,
        pages_explored: 0,
        selected_range_pages: 1,
        practiced_words: 0,
      });
    }
    return route.fallback();
  });

  await page.route("http://127.0.0.1:8000/voice/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    const path = new URL(route.request().url()).pathname;
    if (path === "/voice/status" && route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        headers: corsHeaders,
        contentType: "application/json",
        body: JSON.stringify({
          default_mode: "local_only",
          default_voice_id: "local_north_truc_ly",
          local: { available: false, stt_ready: false, tts_ready: false },
          google: {
            stt_configured: false,
            tts_configured: false,
            stt_cooldown: false,
            tts_cooldown: false,
          },
          elevenlabs: {
            configured: true,
            stt_configured: true,
            tts_configured: true,
            male_tts_configured: false,
            stt_cooldown: false,
            tts_cooldown: false,
          },
        }),
      });
    }
    if (path === "/voice/voices" && route.request().method() === "GET") {
      return route.fallback();
    }
    if (path === "/voice/session-lock" && route.request().method() === "PUT") {
      const body = (route.request().postDataJSON() ?? {}) as {
        session_id?: string;
        voice_id?: string;
      };
      sessionLockUpdates.push(body);
      return route.fulfill({
        status: 200,
        headers: corsHeaders,
        contentType: "application/json",
        body: JSON.stringify({
          session_id: body.session_id ?? ids.session,
          voice_id: body.voice_id ?? "local_north_truc_ly",
          provider: "local",
          locked: true,
        }),
      });
    }
    if (
      path === "/voice/text-to-speech/timed" &&
      route.request().method() === "POST"
    ) {
      const body = (route.request().postDataJSON() ?? {}) as {
        words?: string[];
        voice_id?: string;
        speed?: number;
      };
      timedPayloads.push(body);
      const words = body.words ?? [];
      return route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders,
          "x-voice-provider": "precomputed_cache",
          "x-resolved-voice-id": body.voice_id ?? "local_north_truc_ly",
        },
        contentType: "application/json",
        body: JSON.stringify({
          audio_base64: silentWav(2),
          content_type: "audio/wav",
          duration_seconds: 2,
          words: words.map((_w, index) => ({
            index,
            start: (index * 2) / Math.max(1, words.length),
            end: ((index + 1) * 2) / Math.max(1, words.length),
          })),
        }),
      });
    }
    if (
      path === "/voice/text-to-speech" &&
      route.request().method() === "POST"
    ) {
      const body = (route.request().postDataJSON() ?? {}) as {
        text?: string;
        voice_id?: string;
        speed?: number;
        cache_scope?: string;
        word_sample?: boolean;
      };
      ttsPayloads.push(body);
      if (
        body.cache_scope !== "COACHING" &&
        body.cache_scope !== "CATALOG" &&
        !body.word_sample
      ) {
        return route.fulfill({
          status: 503,
          headers: corsHeaders,
          contentType: "application/json",
          body: JSON.stringify({ detail: { code: "LOCAL_TTS_UNAVAILABLE" } }),
        });
      }
      return route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders,
          "x-voice-provider": "precomputed_cache",
          "x-resolved-voice-id": body.voice_id ?? "local_north_truc_ly",
          "x-voice-gender":
            (body.voice_id ?? "").includes("thai_son") ||
            (body.voice_id ?? "").includes("thien_minh") ||
            (body.voice_id ?? "").includes("quang_son")
              ? "male"
              : "female",
        },
        contentType: "audio/wav",
        body: Buffer.from(silentWav(2), "base64"),
      });
    }
    return route.fallback();
  });

  await page.addInitScript(() => {
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
  });

  await page.goto("/dashboard");
  const section = page.getByTestId("ai-teacher-voice-section");
  const previewBtn = page.getByTestId("teacher-voice-preview-btn");
  await expect(section).toBeVisible();
  await expect(page.getByTestId("teacher-policy-local-only")).toBeVisible();
  await expect(page.getByTestId("teacher-policy-online-backup")).toBeVisible();

  // 1. Selecting Thầy giáo AI immediately speaks the precomputed male greeting from COACHING cache
  await page.getByTestId("teacher-card-male").click();
  await expect.poll(() => ttsPayloads.length).toBe(1);
  expect(ttsPayloads[0]).toMatchObject({
    voice_id: "local_north_thien_minh",
    cache_scope: "COACHING",
    text: "Chào con, hôm nay thầy trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.",
  });
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios[0]?.paused))
    .toBe(false);
  await expect(previewBtn).toContainText("Dừng nghe thử");

  // 2. Switching region to Miền Nam keeps Male persona (Thầy Thái Sơn), stops prior audio, and plays new greeting
  await page.getByTestId("teacher-region-south").click();
  await expect.poll(() => ttsPayloads.length).toBe(2);
  expect(ttsPayloads[1]).toMatchObject({
    voice_id: "local_south_thai_son",
    cache_scope: "COACHING",
    text: "Chào con, hôm nay thầy trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.",
  });
  await expect
    .poll(() =>
      page.evaluate(() => ({
        firstPaused: window.__ttsProbe.audios[0]?.paused === true,
        secondPlaying: window.__ttsProbe.audios[1]?.paused === false,
      })),
    )
    .toEqual({ firstPaused: true, secondPlaying: true });
  await expect(previewBtn).toContainText("Dừng nghe thử");
  await expect(section.locator('[role="alert"]')).toHaveCount(0);

  await section.screenshot({
    path: testInfo.outputPath("dashboard-ai-teacher-male-voice.png"),
  });

  // Goal B: When preview audio finishes naturally, button MUST automatically reset to "Nghe thử giọng"
  await expect(previewBtn).toContainText("Nghe thử giọng", { timeout: 6_000 });

  // Goal A + B: Clicking "Nghe thử giọng" again plays immediately from client cache (0 extra network calls) and resets on completion
  await previewBtn.click();
  await expect(previewBtn).toContainText("Dừng nghe thử");
  await expect
    .poll(() => page.evaluate(() => window.__ttsProbe.audios.at(-1)?.paused))
    .toBe(false);
  expect(ttsPayloads.length).toBe(2);
  await expect(previewBtn).toContainText("Nghe thử giọng", { timeout: 6_000 });

  // 3. Reloading /dashboard hydrates the persisted child voice_preferences (Thầy Thái Sơn · Miền Nam)
  await page.reload();
  await expect(page.getByTestId("teacher-card-male")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("teacher-region-south")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // 4. Navigating to Book Reading (/reading/:session) locks & speaks page + word samples in Thầy Thái Sơn
  await page.goto(`/reading/${ids.session}?state=reading`);
  const readPageBtn = page.getByRole("button", {
    name: "Nghe đọc mẫu cả trang",
  });
  await expect(readPageBtn).toBeVisible();
  await readPageBtn.click();
  await expect.poll(() => timedPayloads.length).toBe(1);
  expect(timedPayloads[0]?.voice_id).toBe("local_south_thai_son");
  await page.getByRole("button", { name: "Bé", exact: true }).click();
  await expect
    .poll(() =>
      ttsPayloads.some(
        (p) => p.word_sample === true && p.voice_id === "local_south_thai_son",
      ),
    )
    .toBe(true);

  // 5. Navigating to Difficult Words report keeps Thầy Thái Sơn hydrated across routes
  await page.goto(`/reports/difficult-words?childId=${ids.child}`);
  await expect(
    page.getByRole("heading", { name: /Từ cần luyện của Bé API/ }),
  ).toBeVisible();
  const syncedPrefs = await page.evaluate(() =>
    JSON.parse(
      window.localStorage.getItem("viread.speech-preferences.v1") ?? "{}",
    ),
  );
  expect(syncedPrefs.voiceId).toBe("local_south_thai_son");
  await page.getByRole("button", { name: /Luyện 1 từ cần ôn/ }).click();
  await expect
    .poll(() =>
      ttsPayloads.some(
        (p) =>
          p.voice_id === "local_south_thai_son" && p.cache_scope === "CATALOG",
      ),
    )
    .toBe(true);

  await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: /Giọng đọc mẫu · Thầy giáo AI/ }),
  ).toBeVisible();
  await expect(dialog.getByText("ElevenLabs Cloud: Sẵn sàng")).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: /Thầy Thái Sơn/ }),
  ).toBeChecked();
  const stopBtn = dialog.getByRole("button", {
    name: "Dừng nghe thử",
    exact: true,
  });
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
  }
  const prevAudios = await page.evaluate(() => window.__ttsProbe.audios.length);
  await dialog.getByRole("button", { name: "Nghe thử", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Dừng nghe thử", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (n) =>
          window.__ttsProbe.audios.length > n &&
          window.__ttsProbe.audios.at(-1)?.paused === false,
        prevAudios,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("difficult-words-synced-teacher.png"),
  });

  // Goal B inside ReadingVoiceSettings: "Dừng nghe" automatically returns to "Nghe thử" when preview completes
  await expect(
    dialog.getByRole("button", { name: "Nghe thử", exact: true }),
  ).toBeVisible({ timeout: 6_000 });

  // Goal C: Explicitly switching to Cô giáo AI re-syncs persona & voice globally (Cô Thục Đoan · Miền Nam)
  await dialog.getByTestId("voice-modal-teacher-female").click();
  await expect(
    dialog.getByRole("heading", { name: /Giọng đọc mẫu · Cô giáo AI/ }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: /Cô Thục Đoan/ }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Nghe thử", exact: true }).click();
  await expect
    .poll(() =>
      ttsPayloads.some(
        (p) =>
          p.voice_id === "local_south_thuc_doan" &&
          (p.text ?? "").includes("cô trò mình"),
      ),
    )
    .toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Nghe thử", exact: true }),
  ).toBeVisible({ timeout: 6_000 });

  expect(
    api.unexpected.filter((item) => item !== "external:huggingface.co"),
  ).toEqual([]);
});

test("Pure-offline cross-feature Male Teacher sync: Dashboard -> Difficult Words (no ?childId) -> Sentence Shooter plays bundled static VieNeu MP3 with zero Chưa phát được giọng đọc", async ({
  page,
}, testInfo) => {
  const api = await installApiFixture(page);
  const corsHeaders = {
    "access-control-allow-origin": PLAYWRIGHT_ORIGIN,
    "access-control-allow-headers":
      "authorization,content-type,accept,x-voice-policy-mode,x-allow-google-stt-fallback,x-allow-google-tts-fallback,x-voice-region,x-voice-session-id,x-voice-page-id,x-voice-turn-id,x-voice-lock-update",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
    "access-control-expose-headers":
      "x-voice-provider,x-resolved-voice-id,x-voice-region,x-voice-model-version,x-voice-fallback,x-voice-gender",
  };

  await page.route("http://127.0.0.1:8000/reading/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    const path = new URL(route.request().url()).pathname;
    const base = `/reading/sessions/${ids.session}`;
    const respondJson = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        headers: corsHeaders,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === `${base}/practice-state`) {
      return respondJson({
        session_id: ids.session,
        legacy_evidence_present: false,
        pages: [],
        words: [],
      });
    }
    if (path === base) {
      return respondJson({
        id: ids.session,
        child_id: ids.child,
        book_id: ids.book,
        state: "PAGE_READY",
        started_at: "2026-11-11T00:00:00Z",
        ended_at: null,
        duration_ms: null,
      });
    }
    if (path === `${base}/page`) {
      return respondJson({
        page_id: ids.page,
        page_revision_id: ids.revision,
        page_number: 1,
        confidence: null,
        width: 800,
        height: 1000,
        image_url: null,
        text: "Bé mèo nhỏ đọc sách.",
        words: ["Bé", "mèo", "nhỏ", "đọc", "sách."].map((w, idx) => ({
          word_id: `90000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
          word_index: idx,
          text: w,
          bbox: [0.05 + idx * 0.16, 0.1, 0.14, 0.05],
          line_index: 0,
        })),
      });
    }
    if (path === `${base}/progress`) {
      return respondJson({
        session_id: ids.session,
        persisted: true,
        start_page_id: ids.page,
        end_page_id: ids.page,
        current_page_id: ids.page,
        start_page_number: 1,
        end_page_number: 1,
        current_page_number: 1,
        current_index: 0,
        total_pages: 1,
        completed_pages: 0,
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            page_order: 0,
            status: "IN_PROGRESS",
            started_at: null,
            completed_at: null,
          },
        ],
      });
    }
    return route.fallback();
  });

  // Simulate pure offline / worker-down hosted environment where /voice/text-to-speech ALWAYS returns 503 LOCAL_VOICE_UNCONFIGURED
  await page.route("http://127.0.0.1:8000/voice/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    const path = new URL(route.request().url()).pathname;
    if (path === "/voice/status" && route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        headers: corsHeaders,
        contentType: "application/json",
        body: JSON.stringify({
          default_mode: "local_only",
          default_voice_id: "local_north_truc_ly",
          local: {
            configured: false,
            available: false,
            stt_ready: false,
            tts_ready: false,
          },
          google: {
            stt_configured: false,
            tts_configured: false,
            stt_cooldown: false,
            tts_cooldown: false,
          },
          elevenlabs: {
            configured: true,
            stt_configured: true,
            tts_configured: true,
            male_tts_configured: false,
            stt_cooldown: false,
            tts_cooldown: false,
          },
        }),
      });
    }
    if (
      (path === "/voice/text-to-speech" ||
        path === "/voice/text-to-speech/timed") &&
      route.request().method() === "POST"
    ) {
      return route.fulfill({
        status: 503,
        headers: corsHeaders,
        contentType: "application/json",
        body: JSON.stringify({
          detail: { code: "LOCAL_VOICE_UNCONFIGURED" },
        }),
      });
    }
    return route.fallback();
  });

  await page.addInitScript(() => {
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
  });

  // 1. Select Thầy giáo AI on Dashboard BEFORE clicking child card, then click child card:
  // bundled static VieNeu MP3 plays immediately with ZERO error and pre-child Male selection is preserved!
  await page.goto("/dashboard");
  const section = page.getByTestId("ai-teacher-voice-section");
  await expect(section).toBeVisible();
  await page.getByTestId("teacher-card-male").click();
  await page.getByRole("button", { name: /Bé API, lớp 2/ }).click();
  await expect(page.getByTestId("teacher-card-male")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__ttsProbe.audios.length >= 1 &&
          window.__ttsProbe.audios.at(-1)?.paused === false,
      ),
    )
    .toBe(true);
  await expect(section.locator('[role="alert"]')).toHaveCount(0);

  // 2. Navigate to /reports/difficult-words WITHOUT ?childId=: must honor selectedChildId and keep Thầy giáo AI!
  await page.goto("/reports/difficult-words");
  await expect(
    page.getByRole("heading", { name: /Từ cần luyện/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
  const dwDialog = page.getByRole("dialog");
  await expect(
    dwDialog.getByRole("heading", { name: /Giọng đọc mẫu · Thầy giáo AI/ }),
  ).toBeVisible();
  await expect(
    dwDialog.getByText(/Đang kiểm tra nhận diện giọng nói/),
  ).toHaveCount(0);

  // 3. Navigate to Story Reading (/reading/:sessionId) and verify ReadingScreen keeps Thầy giáo AI
  // and plays bundled static MP3 via playWithWordTimings with zero error!
  await page.goto(`/reading/${ids.session}?state=reading`);
  await expect(
    page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
  const readingDialog = page.getByRole("dialog");
  await expect(
    readingDialog.getByRole("heading", {
      name: /Giọng đọc mẫu · Thầy giáo AI/,
    }),
  ).toBeVisible();
  const beforeReadingPreviewCount = await page.evaluate(
    () => window.__ttsProbe.audios.length,
  );
  await readingDialog
    .getByRole("button", { name: "Nghe thử", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (prev) =>
          window.__ttsProbe.audios.length > prev &&
          window.__ttsProbe.audios.at(-1)?.paused === false,
        beforeReadingPreviewCount,
      ),
    )
    .toBe(true);
  await expect(readingDialog.getByText(/Chưa phát được giọng đọc/)).toHaveCount(
    0,
  );

  // 4. Navigate to /entertainment/sentence-shooter (exact route from user screenshot):
  await page.goto("/entertainment/sentence-shooter");
  await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
  const shooterDialog = page.getByRole("dialog");
  await expect(
    shooterDialog.getByRole("heading", {
      name: /Giọng đọc mẫu · Thầy giáo AI/,
    }),
  ).toBeVisible();
  await expect(
    shooterDialog.getByText(/Đang kiểm tra nhận diện giọng nói/),
  ).toHaveCount(0);
  await expect(
    shooterDialog.getByRole("radio", { name: /Thầy Thiện Minh/ }),
  ).toBeChecked();

  const beforeShooterPreviewCount = await page.evaluate(
    () => window.__ttsProbe.audios.length,
  );
  await shooterDialog
    .getByRole("button", { name: "Nghe thử", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (prev) =>
          window.__ttsProbe.audios.length > prev &&
          window.__ttsProbe.audios.at(-1)?.paused === false,
        beforeShooterPreviewCount,
      ),
    )
    .toBe(true);
  await expect(shooterDialog.getByText(/Chưa phát được giọng đọc/)).toHaveCount(
    0,
  );
  await expect(shooterDialog.locator('[role="alert"]')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("sentence-shooter-offline-male-synced.png"),
  });
  expect(
    api.unexpected.filter((item) => item !== "external:huggingface.co"),
  ).toEqual([]);
});
