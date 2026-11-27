import { expect, test, type Page, type Route } from "@playwright/test";
import { ids, installApiFixture } from "./real-data-fixture";

const PAGE_1_ID = ids.page;
const PAGE_1_REV = ids.revision;
const PAGE_2_ID = "55555555-5555-4555-8555-555555555556";
const PAGE_2_REV = "66666666-6666-4666-8666-666666666667";

const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface WordSpec {
  word_id: string;
  word_index: number;
  text: string;
  bbox: readonly [number, number, number, number];
  line_index: number;
}

function buildLongProsePage(lineCount = 120): {
  words: WordSpec[];
  text: string;
} {
  const words: WordSpec[] = [];
  const sentences = [
    ["Sáng", "sớm", "bé", "Lan", "ngồi", "đọc", "sách", "truyện."],
    ["Nắng", "vàng", "chiếu", "nhẹ", "qua", "khung", "cửa", "sổ."],
    ["Chú", "mèo", "nhỏ", "nằm", "ngoan", "bên", "chân", "bé."],
    ["Từng", "dòng", "chữ", "rõ", "ràng", "giúp", "bé", "vui."],
  ];
  const lines: string[] = [];
  for (let line = 0; line < lineCount; line += 1) {
    const template = sentences[line % sentences.length];
    const lineWords =
      line === lineCount - 1
        ? ["Cuối", "trang", "bé", "đọc", "tròn", "chữ", "cuối", "cùng."]
        : line === 79
          ? ["Dòng", "tám", "mươi", "bé", "vẫn", "đọc", "rất", "đều."]
          : template;
    lines.push(lineWords.join(" "));
    for (let i = 0; i < lineWords.length; i += 1) {
      const idx = words.length;
      words.push({
        word_id: `91000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        word_index: idx,
        text: lineWords[i],
        bbox: [
          0.06 + i * 0.11,
          Math.min(0.95, 0.02 + line * 0.0075),
          0.09,
          0.006,
        ],
        line_index: line,
      });
    }
  }
  return { words, text: lines.join("\n\n") };
}

function buildLongPoetryPage(lineCount = 120): {
  words: WordSpec[];
  text: string;
} {
  const words: WordSpec[] = [];
  const verses = [
    ["Trăng", "sáng", "trước", "sân", "nhà"],
    ["Gió", "mát", "thổi", "qua", "hiên"],
    ["Bé", "ngồi", "chăm", "đọc", "sách"],
    ["Chữ", "đẹp", "lại", "thật", "hiền."],
  ];
  const lines: string[] = [];
  for (let line = 0; line < lineCount; line += 1) {
    const verse =
      line === lineCount - 1
        ? ["Hết", "thơ", "bé", "vui", "cười."]
        : verses[line % verses.length];
    lines.push(verse.join(" "));
    for (let i = 0; i < verse.length; i += 1) {
      const idx = words.length;
      words.push({
        word_id: `93000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        word_index: idx,
        text: verse[i],
        bbox: [
          0.12 + i * 0.1,
          Math.min(0.95, 0.02 + line * 0.0075),
          0.08,
          0.006,
        ],
        line_index: line,
      });
    }
  }
  return { words, text: lines.join("\n") };
}

function wav(): Buffer {
  const audio = Buffer.alloc(44 + 1600);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVE", 8);
  audio.write("fmt ", 12);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(1600, 40);
  return audio;
}

async function installLongReadingSession(
  page: Page,
  options: {
    mode?: "prose" | "poetry";
    lineCount?: number;
    withReferenceImage?: boolean;
    initialState?: "reading" | "microphone-denied" | "reconnecting";
    voiceStatusUnavailable?: boolean;
  } = {},
) {
  await installApiFixture(page);

  const built =
    options.mode === "poetry"
      ? buildLongPoetryPage(options.lineCount ?? 120)
      : buildLongProsePage(options.lineCount ?? 120);

  const page2Words: WordSpec[] = ["Sang", "trang", "hai", "rồi."].map(
    (text, idx) => ({
      word_id: `92000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
      word_index: idx,
      text,
      bbox: [0.1 + idx * 0.18, 0.2, 0.14, 0.06],
      line_index: 0,
    }),
  );

  const pages = [
    {
      page_id: PAGE_1_ID,
      page_revision_id: PAGE_1_REV,
      page_number: 1,
      confidence: 0.98,
      width: 600,
      height: 800,
      image_overlay_safe: false,
      image_url: options.withReferenceImage
        ? "http://127.0.0.1:8000/fixture-page.png"
        : null,
      text: built.text,
      words: built.words,
    },
    {
      page_id: PAGE_2_ID,
      page_revision_id: PAGE_2_REV,
      page_number: 2,
      confidence: 0.98,
      width: 600,
      height: 800,
      image_overlay_safe: false,
      image_url: null,
      text: "Sang trang hai rồi.",
      words: page2Words,
    },
  ];

  let currentIndex = 0;
  const now = "2026-11-24T10:00:00Z";
  const base = `/reading/sessions/${ids.session}`;
  const corsHeaders = {
    "access-control-allow-origin": "http://127.0.0.1:3106",
    "access-control-allow-headers": "authorization,content-type,accept",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      headers: corsHeaders,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  const progress = () => ({
    session_id: ids.session,
    persisted: true,
    start_page_id: PAGE_1_ID,
    end_page_id: PAGE_2_ID,
    current_page_id: pages[currentIndex].page_id,
    start_page_number: 1,
    end_page_number: 2,
    current_page_number: pages[currentIndex].page_number,
    current_index: currentIndex,
    total_pages: 2,
    completed_pages: 0,
    pages: pages.map((p, index) => ({
      page_id: p.page_id,
      page_revision_id: p.page_revision_id,
      page_number: p.page_number,
      page_order: index,
      status: index === currentIndex ? "IN_PROGRESS" : "PENDING",
      started_at: index <= currentIndex ? now : null,
      completed_at: null,
    })),
  });

  await page.route("http://127.0.0.1:8000/fixture-page.png", (route) =>
    route.fulfill({
      status: 200,
      headers: corsHeaders,
      contentType: "image/png",
      body: Buffer.from(SAMPLE_PNG_BASE64, "base64"),
    }),
  );

  await page.route("http://127.0.0.1:8000/books/*/pages", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeaders });
    return json(
      route,
      pages.map((p) => ({
        page_id: p.page_id,
        page_number: p.page_number,
        lifecycle_status: "ACTIVE",
        current_verified_revision_id: p.page_revision_id,
        preview_url: null,
      })),
    );
  });

  await page.route("http://127.0.0.1:8000/reading-presence/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeaders });
    return json(route, { email_enabled: false, updated_at: now });
  });

  await page.route("http://127.0.0.1:8000/reading/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeaders });
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/reading/history")) return route.fallback();
    if (path === base) {
      return json(route, {
        id: ids.session,
        child_id: ids.child,
        book_id: ids.book,
        state: "PAGE_READY",
        started_at: now,
        ended_at: null,
        duration_ms: null,
      });
    }
    if (path === base + "/page") return json(route, pages[currentIndex]);
    if (path === base + "/progress") return json(route, progress());
    if (path === base + "/navigate") {
      const body = route.request().postDataJSON() as {
        target_page_id?: string;
      };
      const idx = pages.findIndex((p) => p.page_id === body?.target_page_id);
      if (idx >= 0) currentIndex = idx;
      return json(route, progress());
    }
    if (path === base + "/practice-state") {
      return json(route, {
        session_id: ids.session,
        legacy_evidence_present: false,
        pages: [],
        words: [],
      });
    }
    if (path === base + "/completion-summary") {
      return json(route, {
        assessment: null,
        duration_minutes: 1,
        pages_explored: 1,
        selected_range_pages: 2,
        practiced_words: 10,
        score: 100,
        correct_words: [],
        mispronounced_words: [],
        skipped_words: [],
        transcripts: [],
        spoken_words: [],
      });
    }
    if (path.includes("/questions")) {
      return json(route, { session_id: ids.session, questions: [] });
    }
    return json(route, {}, 404);
  });

  const voice503Counts = { stt: 0, tts: 0 };

  await page.route("http://127.0.0.1:8000/voice/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeaders });
    const path = new URL(route.request().url()).pathname;
    if (path === "/voice/status") {
      if (options.voiceStatusUnavailable) {
        return json(route, {
          default_mode: "local_only",
          default_voice_id: "local_north_truc_ly",
          local: {
            available: false,
            stt_ready: false,
            tts_ready: false,
            stt_model_version: null,
            tts_model_version: null,
          },
          google: {
            stt_configured: false,
            tts_configured: false,
            stt_cooldown: false,
            tts_cooldown: false,
          },
        });
      }
      return json(route, {
        default_mode: "local_only",
        default_voice_id: "local_north_truc_ly",
        local: {
          available: true,
          stt_ready: true,
          tts_ready: true,
        },
        google: {
          stt_configured: false,
          tts_configured: false,
          stt_cooldown: false,
          tts_cooldown: false,
        },
      });
    }
    if (path === "/voice/voices") {
      return json(route, {
        default_voice_id: "fixture_vi",
        voices: [
          {
            voice_id: "fixture_vi",
            name: "Giọng mẫu tiếng Việt",
            gender: "female",
          },
        ],
      });
    }
    if (path.startsWith("/voice/text-to-speech")) {
      if (options.voiceStatusUnavailable) {
        voice503Counts.tts += 1;
        return json(route, { detail: { code: "LOCAL_TTS_UNAVAILABLE" } }, 503);
      }
      return route.fulfill({
        headers: corsHeaders,
        contentType: "audio/wav",
        body: wav(),
      });
    }
    if (path === "/voice/speech-to-text") {
      voice503Counts.stt += 1;
    }
    return json(route, { detail: { code: "LOCAL_STT_UNAVAILABLE" } }, 503);
  });

  await page.addInitScript(() => {
    type RecInstance = {
      onresult: ((event: unknown) => void) | null;
      onend: (() => void) | null;
      onerror: ((event: unknown) => void) | null;
      results: Array<{
        isFinal: boolean;
        length: number;
        0: { transcript: string; confidence: number };
      }>;
      say: (transcript: string, confidence?: number) => void;
    };
    const instances: RecInstance[] = [];

    class FakeSpeechRecognition {
      continuous = true;
      interimResults = true;
      lang = "vi-VN";
      maxAlternatives = 1;
      onresult: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      results: Array<{
        isFinal: boolean;
        length: number;
        0: { transcript: string; confidence: number };
      }> = [];
      constructor() {
        instances.push(this);
      }
      start() {}
      abort() {
        this.onend?.();
      }
      stop() {
        this.onend?.();
      }
      say(transcript: string, confidence = 0.95) {
        this.results.push({
          isFinal: true,
          length: 1,
          0: { transcript, confidence },
        });
        this.onresult?.({
          resultIndex: this.results.length - 1,
          results: [...this.results],
        });
      }
    }

    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: FakeSpeechRecognition,
    });

    class FakeSpeechSynthesisUtterance {
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;

      constructor(readonly text: string) {}
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: FakeSpeechSynthesisUtterance,
    });
    const spokenSamples: string[] = [];
    const voice = {
      lang: "vi-VN",
      name: "Fixture Vietnamese",
      localService: false,
      default: true,
      voiceURI: "fixture-vi",
    } satisfies SpeechSynthesisVoice;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => [voice],
        speak: (utterance: FakeSpeechSynthesisUtterance) => {
          spokenSamples.push(utterance.text);
          queueMicrotask(() => {
            utterance.onstart?.();
            utterance.onend?.();
          });
        },
        cancel: () => {},
        pause: () => {},
        resume: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });

    let activeGainNode: GainNode | null = null;
    let speechPulseTimer: ReturnType<typeof setTimeout> | null = null;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const ctx = new AudioContext();
        await ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        activeGainNode = gain;
        const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 220;
        gain.gain.value = 0.0005;
        setTimeout(() => {
          if (activeGainNode === gain) {
            gain.gain.value = 0.12;
            setTimeout(() => {
              if (activeGainNode === gain) gain.gain.value = 0.0005;
            }, 260);
          }
        }, 210);
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        const stream = dest.stream;
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            try {
              osc.stop();
              void ctx.close();
            } catch {
              // ignore
            }
            stop();
          };
        }
        return stream;
      },
    });

    Object.assign(window, {
      __geomSpeech: {
        spoken: () => [...spokenSamples],
        count: () => instances.length,
        say: (transcript: string, confidence = 0.95) => {
          const active = instances[instances.length - 1];
          if (!active) throw new Error("No active SpeechRecognition");
          if (activeGainNode) {
            activeGainNode.gain.value = 0.12;
            if (speechPulseTimer) clearTimeout(speechPulseTimer);
            speechPulseTimer = setTimeout(() => {
              if (activeGainNode) activeGainNode.gain.value = 0.0005;
            }, 220);
          }
          active.say(transcript, confidence);
        },
      },
    });
  });

  await page.goto(
    `/reading/${ids.session}?state=${options.initialState ?? "reading"}`,
  );
  await expect(page.locator('[data-reading-shell="true"]')).toBeVisible();
  return { words: built.words, voice503Counts };
}

test.describe("Reading screen viewport-bounded layout & scroll geometry", () => {
  for (const vp of [
    { name: "desktop-1366x768", width: 1366, height: 768, bounded: true },
    { name: "mobile-390x844", width: 390, height: 844, bounded: true },
    { name: "mobile-360x640", width: 360, height: 640, bounded: true },
    { name: "landscape-844x390", width: 844, height: 390, bounded: false },
    { name: "landscape-640x360", width: 640, height: 360, bounded: false },
  ]) {
    test(`120-line prose keeps controls in viewport & zero overflow at ${vp.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await installLongReadingSession(page, { mode: "prose", lineCount: 120 });

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(2);

      const controlsBox = await page
        .locator("[data-reading-controls]")
        .boundingBox();
      expect(controlsBox).not.toBeNull();
      expect(controlsBox!.y).toBeGreaterThanOrEqual(0);
      expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(
        vp.height + 2,
      );

      if (vp.bounded) {
        const scrollInfo = await page
          .locator('[data-reading-scroll-container="true"]')
          .evaluate((el) => ({
            clientHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
          }));
        expect(scrollInfo.clientHeight).toBeGreaterThanOrEqual(140);
        expect(scrollInfo.scrollHeight).toBeGreaterThan(
          scrollInfo.clientHeight + 200,
        );
      }
    });
  }

  test("120-line poetry preserves verse breaks and stays bounded on 360x640", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await installLongReadingSession(page, { mode: "poetry", lineCount: 120 });

    const panel = page.locator('[data-reading-panel="text"]');
    await expect(panel).toHaveAttribute("data-reflow-mode", "poetry");
    expect(await panel.locator("br").count()).toBeGreaterThanOrEqual(100);

    const controlsBox = await page
      .locator("[data-reading-controls]")
      .boundingBox();
    expect(controlsBox).not.toBeNull();
    expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(642);
  });

  test("200% zoom on 1280x800 keeps controls reachable without horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installLongReadingSession(page, { mode: "prose", lineCount: 120 });

    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);

    const controls = page.locator("[data-reading-controls]");
    await expect(controls).toBeVisible();
    for (const btn of await controls.getByRole("button").all()) {
      const box = await btn.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(42);
    }
  });

  test("Mandatory flow: scroll to line 80 -> pause -> open/close Voice settings -> resume preserves position and allows reading last word", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const { words } = await installLongReadingSession(page, {
      mode: "prose",
      lineCount: 120,
    });

    const container = page.locator('[data-reading-scroll-container="true"]');
    const line80Word = page.locator('[data-line-index="79"]').first();

    // Scroll container to line 80
    const targetTop = await container.evaluate((el) => {
      const target = el.querySelector<HTMLElement>('[data-line-index="79"]');
      if (!target) return 0;
      const top =
        target.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop -
        120;
      el.scrollTop = top;
      return el.scrollTop;
    });
    expect(targetTop).toBeGreaterThan(200);
    await expect(line80Word).toBeVisible();

    // Click Tạm dừng -> modal opens -> Đọc tiếp
    await page.getByRole("button", { name: "Tạm dừng buổi đọc" }).click();
    await expect(
      page.getByRole("dialog", { name: "Bé đang nghỉ một chút" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Đọc tiếp" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Open & close Voice settings modal
    await page.getByRole("button", { name: "Giọng đọc" }).click();
    await expect(
      page.getByRole("dialog", { name: "Giọng đọc mẫu" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();

    // Scroll position at line 80 must be preserved!
    const afterTop = await container.evaluate((el) => el.scrollTop);
    expect(Math.abs(afterTop - targetTop)).toBeLessThanOrEqual(4);

    // Scroll to very bottom -> last word completely unobstructed by dock
    const lastWordId = words[words.length - 1].word_id;
    await container.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const lastWord = page.locator(`[data-word-id="${lastWordId}"]`);
    const lastWordBox = await lastWord.boundingBox();
    const dockBox = await page
      .locator('[data-reading-dock="true"]')
      .boundingBox();
    expect(lastWordBox).not.toBeNull();
    expect(dockBox).not.toBeNull();
    expect(lastWordBox!.y + lastWordBox!.height).toBeLessThanOrEqual(
      dockBox!.y + 1,
    );
  });

  test("Mobile acceptance (390x844 & 360x640): scroll to bottom -> click Tạm dừng right there -> resume without losing tracked word", async ({
    page,
  }) => {
    for (const vp of [
      { width: 390, height: 844 },
      { width: 360, height: 640 },
    ]) {
      await page.setViewportSize(vp);
      const { words } = await installLongReadingSession(page, {
        mode: "prose",
        lineCount: 120,
      });

      // Track first word via aria-current
      const trackedWordId = words[0].word_id;
      await expect(
        page.locator(`[data-word-id="${trackedWordId}"]`),
      ).toHaveAttribute("aria-current", "true");

      // Scroll all the way to the bottom of the long page
      const container = page.locator('[data-reading-scroll-container="true"]');
      const bottomScrollTop = await container.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollTop;
      });
      expect(bottomScrollTop).toBeGreaterThan(1000);

      // Pause button must be directly clickable right inside the viewport
      const pauseBtn = page.getByRole("button", { name: "Tạm dừng buổi đọc" });
      const pauseBox = await pauseBtn.boundingBox();
      expect(pauseBox).not.toBeNull();
      expect(pauseBox!.y + pauseBox!.height).toBeLessThanOrEqual(vp.height + 2);
      await pauseBtn.click();

      await expect(
        page.getByRole("dialog", { name: "Bé đang nghỉ một chút" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Đọc tiếp" }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();

      // Tracked word & bottom scroll position are both preserved
      await expect(
        page.locator(`[data-word-id="${trackedWordId}"]`),
      ).toHaveAttribute("aria-current", "true");
      const currentTop = await container.evaluate((el) => el.scrollTop);
      expect(Math.abs(currentTop - bottomScrollTop)).toBeLessThanOrEqual(4);
    }
  });

  test("Active highlight does not hijack manual user scroll and 'Về từ đang đọc' re-centers cleanly", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await installLongReadingSession(page, { mode: "prose", lineCount: 120 });

    await page
      .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { __geomSpeech: { count: () => number } }
          ).__geomSpeech.count(),
        ),
      )
      .toBe(1);
    await page.waitForTimeout(450);

    const container = page.locator('[data-reading-scroll-container="true"]');
    // User scrolls manually down to line 80 while reading at line 1
    await container.hover();
    await page.mouse.wheel(0, 2200);
    await container.evaluate((el) => {
      el.scrollTop = Math.max(el.scrollTop, 2200);
      el.dispatchEvent(new Event("scroll"));
    });

    await expect(container).toHaveAttribute("data-auto-follow", "paused");
    const resumeBtn = page.getByTestId("resume-auto-follow-btn");
    await expect(resumeBtn).toBeVisible();

    const scrollBeforeSpeech = await container.evaluate((el) => el.scrollTop);
    const windowScrollBefore = await page.evaluate(() => window.scrollY);

    // Speech advances active word & updates transcript -> MUST NOT hijack scroll!
    await page.evaluate(() => {
      (
        window as unknown as { __geomSpeech: { say: (t: string) => void } }
      ).__geomSpeech.say("Sáng sớm bé Lan");
    });
    await expect(
      page.getByRole("button", { name: "Lan" }).first(),
    ).toHaveAttribute("data-reading-state", "correct");

    const scrollAfterSpeech = await container.evaluate((el) => el.scrollTop);
    const windowScrollAfter = await page.evaluate(() => window.scrollY);
    expect(
      Math.abs(scrollAfterSpeech - scrollBeforeSpeech),
    ).toBeLessThanOrEqual(2);
    expect(windowScrollAfter).toBe(windowScrollBefore);

    // Clicking "Về từ đang đọc" jumps smoothly back to the active word near top
    await resumeBtn.click();
    await expect(container).toHaveAttribute("data-auto-follow", "active");
    await expect
      .poll(() => container.evaluate((el) => el.scrollTop))
      .toBeLessThan(300);
  });

  test("Auxiliary panels (reference image, phonics open/close, mic-denied/reconnecting) never push controls out of viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installLongReadingSession(page, {
      mode: "prose",
      lineCount: 80,
      withReferenceImage: true,
    });

    // Open reference image disclosure
    await page.getByText("Xem ảnh trang sách").click();
    let controlsBox = await page
      .locator("[data-reading-controls]")
      .boundingBox();
    expect(controlsBox).not.toBeNull();
    expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(846);

    // Open Phonics card -> controls still inside viewport; close Phonics card -> dismissed
    await page.getByRole("button", { name: "Nghe đánh vần" }).click();
    await expect(page.getByTestId("phonics-lesson-card")).toBeVisible();
    controlsBox = await page.locator("[data-reading-controls]").boundingBox();
    expect(controlsBox).not.toBeNull();
    expect(controlsBox!.y + controlsBox!.height).toBeLessThanOrEqual(846);

    await page.getByRole("button", { name: "Đóng hướng dẫn đánh vần" }).click();
    await expect(page.getByTestId("phonics-lesson-card")).not.toBeVisible();

    // Mic-denied & reconnecting modal states stay within viewport without overflow
    await installLongReadingSession(page, {
      mode: "prose",
      lineCount: 40,
      initialState: "microphone-denied",
    });
    await expect(
      page.getByRole("dialog", { name: "Mình chưa nghe thấy giọng bé" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(2);

    await installLongReadingSession(page, {
      mode: "prose",
      lineCount: 40,
      initialState: "reconnecting",
    });
    await expect(
      page.getByRole("dialog", { name: "Đợi mình một chút nhé…" }),
    ).toBeVisible();
  });

  test("Continuous auto-scroll follows active word from word 0 through line 40+ without manual mouse scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const { words } = await installLongReadingSession(page, {
      mode: "prose",
      lineCount: 60,
    });

    await page
      .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { __geomSpeech: { count: () => number } }
          ).__geomSpeech.count(),
        ),
      )
      .toBe(1);
    await page.waitForTimeout(350);

    const container = page.locator('[data-reading-scroll-container="true"]');
    const initialScrollTop = await container.evaluate((el) => el.scrollTop);
    const initialWindowY = await page.evaluate(() => window.scrollY);
    expect(initialScrollTop).toBe(0);

    // Read continuously from line 0 through line 42 (344 words) with ZERO manual mouse/wheel scroll!
    const sentences = [
      "Sáng sớm bé Lan ngồi đọc sách truyện",
      "Nắng vàng chiếu nhẹ qua khung cửa sổ",
      "Chú mèo nhỏ nằm ngoan bên chân bé",
      "Từng dòng chữ rõ ràng giúp bé vui",
    ];
    for (let line = 0; line < 43; line += 1) {
      const phrase = sentences[line % sentences.length];
      await page.evaluate((text) => {
        (
          window as unknown as { __geomSpeech: { say: (t: string) => void } }
        ).__geomSpeech.say(text);
      }, phrase);
      if (line % 5 === 4) {
        await page.waitForTimeout(120);
      }
    }

    // Auto-follow MUST remain active (never falsely detached by smooth scroll tails!)
    await expect(container).toHaveAttribute("data-auto-follow", "active");
    await expect(page.getByTestId("resume-auto-follow-btn")).toHaveCount(0);

    // Wait for smooth scroll to settle and verify container scrolled far down while window stayed at 0
    await expect
      .poll(() => container.evaluate((el) => el.scrollTop), { timeout: 5000 })
      .toBeGreaterThan(600);

    const windowYAfter = await page.evaluate(() => window.scrollY);
    expect(windowYAfter).toBe(initialWindowY);

    // Active word around line 43 must sit comfortably visible in upper/middle zone (not dropped to bottom edge!)
    const targetWord = words[43 * 8];
    expect(targetWord).toBeDefined();
    await expect
      .poll(
        async () => {
          const metrics = await container.evaluate((el, wordId) => {
            const active = el.querySelector<HTMLElement>(
              `[data-word-id="${wordId}"]`,
            );
            if (!active) return null;
            const cRect = el.getBoundingClientRect();
            const aRect = active.getBoundingClientRect();
            return {
              relTop: aRect.top - cRect.top,
              relBottom: aRect.bottom - cRect.top,
              clientHeight: el.clientHeight,
            };
          }, targetWord.word_id);
          if (!metrics) return false;
          return (
            metrics.relTop >= 0 &&
            metrics.relBottom <= metrics.clientHeight * 0.75
          );
        },
        { timeout: 5000 },
      )
      .toBe(true);
  });

  test("Healthy defaults use local engines and a worker outage preserves local-only policy until fallback is enabled", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });

    // 1. Healthy local worker on fresh browser -> stays 100% Local Offline!
    await installLongReadingSession(page, {
      mode: "prose",
      lineCount: 10,
      voiceStatusUnavailable: false,
    });
    const badgeHealthy = page.getByTestId("voice-engine-status-badge");
    const sttHealthy = page.getByTestId("voice-engine-stt-chip");
    const ttsHealthy = page.getByTestId("voice-engine-tts-chip");
    await expect(badgeHealthy).toHaveAttribute(
      "data-stt-tier",
      "local_offline",
    );
    await expect(badgeHealthy).toHaveAttribute(
      "data-tts-tier",
      "local_offline",
    );
    await expect(sttHealthy).toContainText("Offline");
    await expect(ttsHealthy).toContainText("Offline");

    // An unavailable worker cannot opt the family into an online provider.
    const { voice503Counts } = await installLongReadingSession(page, {
      mode: "prose",
      lineCount: 10,
      voiceStatusUnavailable: true,
    });
    const badge = page.getByTestId("voice-engine-status-badge");
    await expect(badge).toHaveAttribute("data-stt-tier", "idle");
    await expect(badge).toHaveAttribute("data-tts-tier", "idle");
    await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Giọng đọc mẫu" });
    await expect(
      dialog.getByRole("button", { name: /Chỉ máy này/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      dialog.getByRole("button", { name: /Máy này \+ Google dự phòng/ }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { __geomSpeech: { spoken: () => string[] } }
        ).__geomSpeech.spoken(),
      ),
    ).toEqual([]);
    // The updated reading preparation flow probes local TTS during preload.
    // Both probes fail closed locally and never trigger STT or online fallback.
    expect(voice503Counts.tts).toBeGreaterThan(0);
    expect(voice503Counts.stt).toBe(0);
  });
});
