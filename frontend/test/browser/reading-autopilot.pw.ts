import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { ids, installApiFixture } from "./real-data-fixture";

const EVIDENCE_DIR = resolve(process.cwd(), "../docs/reading/evidence");

const PAGE_1_ID = ids.page;
const PAGE_1_REV = ids.revision;
const PAGE_2_ID = "55555555-5555-4555-8555-555555555556";
const PAGE_2_REV = "66666666-6666-4666-8666-666666666667";

const pageOneWords = ["Bé", "mèo", "nhỏ", "đang"].map((text, index) => ({
  word_id: `91000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  word_index: index,
  text,
  bbox: [0.08 + index * 0.21, 0.22, 0.18, 0.08] as const,
  line_index: 0,
}));

const pageTwoWords = ["An", "vui", "vẻ", "đọc"].map((text, index) => ({
  word_id: `92000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  word_index: index,
  text,
  bbox: [0.08 + index * 0.21, 0.22, 0.18, 0.08] as const,
  line_index: 0,
}));

function wav(): Buffer {
  const audio = Buffer.alloc(44 + 3200);
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
  audio.writeUInt32LE(3200, 40);
  return audio;
}

interface AutopilotHarness {
  completeCalls: string[];
  presenceSettingsUpdates: boolean[];
  ttsRequests: string[];
  quizSubmissions: Array<{ questionId: string; answer: string }>;
  currentPageIndex: () => number;
}

async function installAutopilotSession(
  page: Page,
  options: {
    failFirstComplete?: boolean;
    initialState?: "ready" | "reading" | "question";
  } = {},
): Promise<AutopilotHarness> {
  await installApiFixture(page);

  const now = "2026-11-21T12:00:00Z";
  const base = `/reading/sessions/${ids.session}`;
  let currentIndex = 0;
  const completedPages = [false, false];
  let failCompleteRemaining = options.failFirstComplete ? 1 : 0;
  let presenceEnabled = false;
  const completeCalls: string[] = [];
  const presenceSettingsUpdates: boolean[] = [];
  const ttsRequests: string[] = [];
  const quizSubmissions: Array<{ questionId: string; answer: string }> = [];
  let quizIndex = 0;
  const quizQuestions = [
    {
      id: "81000000-0000-4000-8000-000000000001",
      prompt: "Bạn nào thích ăn cá?",
      correct: "Con mèo",
      choices: [
        { id: "A", label: "Con mèo", value: "Con mèo" },
        { id: "B", label: "Con vịt", value: "Con vịt" },
        { id: "C", label: "Con gà", value: "Con gà" },
      ],
    },
    {
      id: "81000000-0000-4000-8000-000000000002",
      prompt: "Bé đi đâu buổi sáng?",
      correct: "Đi học",
      choices: [
        { id: "A", label: "Đi ngủ", value: "Đi ngủ" },
        { id: "B", label: "Đi học", value: "Đi học" },
        { id: "C", label: "Đi bơi", value: "Đi bơi" },
      ],
    },
    {
      id: "81000000-0000-4000-8000-000000000003",
      prompt: "Ai nấu cơm cho bé?",
      correct: "Mẹ của bé",
      choices: [
        { id: "A", label: "Bác gấu", value: "Bác gấu" },
        { id: "B", label: "Chú thỏ", value: "Chú thỏ" },
        { id: "C", label: "Mẹ của bé", value: "Mẹ của bé" },
      ],
    },
  ];

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

  const pages = [
    {
      page_id: PAGE_1_ID,
      page_revision_id: PAGE_1_REV,
      page_number: 1,
      confidence: 0.96,
      width: 600,
      height: 800,
      image_overlay_safe: false,
      image_url: null,
      text: "Bé mèo nhỏ đang",
      words: pageOneWords,
    },
    {
      page_id: PAGE_2_ID,
      page_revision_id: PAGE_2_REV,
      page_number: 2,
      confidence: 0.96,
      width: 600,
      height: 800,
      image_overlay_safe: false,
      image_url: null,
      text: "An vui vẻ đọc",
      words: pageTwoWords,
    },
  ];

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
    completed_pages: completedPages.filter(Boolean).length,
    pages: pages.map((p, index) => ({
      page_id: p.page_id,
      page_revision_id: p.page_revision_id,
      page_number: p.page_number,
      page_order: index,
      status: completedPages[index]
        ? "COMPLETED"
        : index === currentIndex
          ? "IN_PROGRESS"
          : "PENDING",
      started_at: index <= currentIndex ? now : null,
      completed_at: completedPages[index] ? now : null,
    })),
  });

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
    const path = new URL(route.request().url()).pathname;
    if (path === "/reading-presence/settings") {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON() as {
          email_enabled?: boolean;
        };
        presenceEnabled = Boolean(body?.email_enabled);
        presenceSettingsUpdates.push(presenceEnabled);
      }
      return json(route, { email_enabled: presenceEnabled, updated_at: now });
    }
    if (path.endsWith("/cancel")) {
      return json(route, { cancelled: 0 });
    }
    return json(route, { ok: true });
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
    if (path === base + "/page") {
      return json(route, pages[currentIndex]);
    }
    if (path === base + "/progress") {
      return json(route, progress());
    }
    if (path.startsWith(base + "/pages/") && path.endsWith("/complete")) {
      const pageId = path.split("/")[5] ?? "";
      completeCalls.push(pageId);
      if (failCompleteRemaining > 0) {
        failCompleteRemaining -= 1;
        return json(route, { detail: "Temporary network outage" }, 503);
      }
      const idx = pages.findIndex((p) => p.page_id === pageId);
      if (idx >= 0) completedPages[idx] = true;
      return json(route, progress());
    }
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
        pages_explored: completedPages.filter(Boolean).length,
        selected_range_pages: 2,
        practiced_words: 8,
        score: 100,
        correct_words: ["Bé", "mèo", "nhỏ", "đang"],
        mispronounced_words: [],
        skipped_words: [],
        transcripts: ["Bé mèo nhỏ đang"],
        spoken_words: ["Bé", "mèo", "nhỏ", "đang"],
      });
    }
    if (path === base + "/finish") {
      return json(route, {
        id: ids.session,
        child_id: ids.child,
        book_id: ids.book,
        state: "FINISHED",
        started_at: now,
        ended_at: now,
        duration_ms: 45_000,
      });
    }
    if (path.includes("/questions")) {
      return json(route, { session_id: ids.session, questions: [] });
    }
    return json(route, {}, 404);
  });

  await page.route("http://127.0.0.1:8000/voice/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeaders });
    const path = new URL(route.request().url()).pathname;
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
    if (path === "/voice/text-to-speech") {
      try {
        const body = route.request().postDataJSON() as { text?: string } | null;
        if (body?.text) ttsRequests.push(body.text);
      } catch {
        // ignore non-JSON body
      }
      return route.fulfill({
        headers: corsHeaders,
        contentType: "audio/wav",
        body: wav(),
      });
    }
    if (path === "/voice/speech-to-text") {
      return json(
        route,
        { detail: { code: "STT_TEMPORARILY_UNAVAILABLE" } },
        503,
      );
    }
    return json(route, {}, 404);
  });

  await page.route("http://127.0.0.1:8000/tutor/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeaders });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/questions/next")) {
      const q = quizQuestions[quizIndex];
      if (!q) {
        return json(route, {
          question: null,
          choices: [],
          progress_label: "Hoàn thành",
          position: quizQuestions.length,
          total: quizQuestions.length,
          completed: true,
        });
      }
      return json(route, {
        question: {
          id: q.id,
          type: "FACTUAL",
          prompt: q.prompt,
          page_revision_id: PAGE_1_REV,
          source_span: {
            start_word_index: 0,
            end_word_index_exclusive: 3,
            sentence_index: 0,
          },
          difficulty: 1,
          answered: false,
        },
        choices: q.choices,
        progress_label: `Câu ${quizIndex + 1}/${quizQuestions.length}`,
        position: quizIndex + 1,
        total: quizQuestions.length,
        completed: false,
      });
    }
    if (path.includes("/questions/") && path.endsWith("/answer")) {
      const body = route.request().postDataJSON() as { answer?: string };
      const answer = body?.answer ?? "";
      const q = quizQuestions[quizIndex] ?? quizQuestions[0];
      const isCorrect = answer === q.correct;
      quizSubmissions.push({ questionId: q.id, answer });
      if (isCorrect) quizIndex += 1;
      return json(route, {
        answer_id: "82000000-0000-4000-8000-000000000001",
        question_id: q.id,
        submitted_answer: answer,
        is_correct: isCorrect,
        score: isCorrect ? 1 : 0,
        feedback_code: isCorrect ? "CORRECT" : "TRY_AGAIN",
      });
    }
    return route.fallback();
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
    const spoken: string[] = [];

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

    const viVoice = {
      lang: "vi-VN",
      name: "Fixture Vietnamese",
      localService: true,
      default: true,
      voiceURI: "fixture-vi",
    } as SpeechSynthesisVoice;

    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => [viVoice],
        speak: (utterance: SpeechSynthesisUtterance) => {
          spoken.push(utterance.text);
          setTimeout(() => {
            utterance.onstart?.({} as SpeechSynthesisEvent);
            setTimeout(() => {
              utterance.onend?.({ elapsedTime: 0.25 } as SpeechSynthesisEvent);
            }, 40);
          }, 10);
        },
        cancel: () => {},
        pause: () => {},
        resume: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints?: MediaStreamConstraints) => {
        if (constraints?.video) {
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 48;
          return canvas.captureStream(1);
        }
        const ctx = new AudioContext();
        await ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 240;
        gain.gain.value = 0.12;
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
      __autopilotSpeech: {
        count: () => instances.length,
        say: (transcript: string, confidence = 0.95) => {
          const active = instances[instances.length - 1];
          if (!active) throw new Error("No active SpeechRecognition instance");
          active.say(transcript, confidence);
        },
        spoken: () => [...spoken],
      },
    });
  });

  const stateParam = options.initialState ?? "ready";
  await page.goto(`/reading/${ids.session}?state=${stateParam}`);

  return {
    completeCalls,
    presenceSettingsUpdates,
    ttsRequests,
    quizSubmissions,
    currentPageIndex: () => currentIndex,
  };
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
}

test.describe("ViRead automatic reading flow (E2E)", () => {
  test("G5: Start once -> 0 extra clicks across fluent 2-page reading with auto page turn and responsive layout", async ({
    page,
  }, testInfo) => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const harness = await installAutopilotSession(page, {
      initialState: "ready",
    });

    // Only click in the entire reading session: "Bắt đầu đọc"
    await page.getByRole("button", { name: "Bắt đầu đọc" }).click();

    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (
              window as unknown as {
                __autopilotSpeech: { count: () => number };
              }
            ).__autopilotSpeech.count(),
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1);

    await assertNoHorizontalOverflow(page);

    // Child reads page 1 fluently
    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("Bé mèo nhỏ đang"),
    );

    // Page automatically advances to page 2 without any click
    await expect(page.getByLabel("Trang sách 2")).toBeVisible({
      timeout: 15_000,
    });
    expect(harness.completeCalls).toEqual([PAGE_1_ID]);

    // Mic automatically reopens on page 2
    await expect(
      page.getByRole("button", { name: "An", exact: true }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (
              window as unknown as {
                __autopilotSpeech: { count: () => number };
              }
            ).__autopilotSpeech.count(),
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(2);

    // Child reads page 2 fluently
    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("An vui vẻ đọc"),
    );

    await expect
      .poll(() => harness.completeCalls.length, { timeout: 10_000 })
      .toBe(2);
    expect(harness.completeCalls).toEqual([PAGE_1_ID, PAGE_2_ID]);

    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      path: resolve(
        EVIDENCE_DIR,
        `e2e-autopilot-fluent-${testInfo.project.name}.png`,
      ),
      fullPage: false,
    });
  });

  test("G4 + G9: Voice help plays sample, blocks immediate echo, then marks imitated word assisted (not green, with non-color cue)", async ({
    page,
  }, testInfo) => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const harness = await installAutopilotSession(page, {
      initialState: "reading",
    });

    await page
      .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __autopilotSpeech: { count: () => number };
            }
          ).__autopilotSpeech.count(),
        ),
      )
      .toBe(1);

    // Child reads first two words then asks for help on "nhỏ"
    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("Bé mèo"),
    );
    await expect(page.getByRole("button", { name: "mèo" })).toHaveAttribute(
      "data-reading-state",
      "correct",
    );

    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("đọc mẫu giúp con"),
    );

    // App speaks sample for "nhỏ" (via device speechSynthesis or /voice/text-to-speech)
    // and reopens recognition automatically.
    await expect
      .poll(async () => {
        const spoken = await page.evaluate(() =>
          (
            window as unknown as {
              __autopilotSpeech: { spoken: () => string[] };
            }
          ).__autopilotSpeech.spoken(),
        );
        return [...spoken, ...harness.ttsRequests].some((t) =>
          t.toLowerCase().includes("nhỏ"),
        );
      })
      .toBe(true);

    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __autopilotSpeech: { count: () => number };
            }
          ).__autopilotSpeech.count(),
        ),
      )
      .toBeGreaterThanOrEqual(2);

    // Immediate echo of "nhỏ" is blocked
    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("nhỏ"),
    );
    await expect(page.getByRole("button", { name: "nhỏ" })).not.toHaveAttribute(
      "data-reading-state",
      "correct",
    );
    await expect(page.getByRole("button", { name: "nhỏ" })).not.toHaveAttribute(
      "data-reading-state",
      "assisted",
    );

    // Wait past the 1.5s echo tail guard, then child imitates "nhỏ"
    await page.waitForTimeout(1700);
    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("nhỏ"),
    );

    const assistedWord = page.getByRole("button", { name: "nhỏ" });
    await expect(assistedWord).toHaveAttribute(
      "data-reading-state",
      "assisted",
    );
    // Non-colour cue: dotted underline + hidden accessible note
    await expect(assistedWord).toHaveClass(/underline/);
    await expect(assistedWord).not.toHaveClass(/bg-success-surface/);

    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      path: resolve(
        EVIDENCE_DIR,
        `e2e-autopilot-assisted-${testInfo.project.name}.png`,
      ),
      fullPage: false,
    });
  });

  test("G10: Save failure during auto-advance stays on page with Chưa lưu notice, recovers on retry and persists across reload", async ({
    page,
  }) => {
    const harness = await installAutopilotSession(page, {
      initialState: "reading",
      failFirstComplete: true,
    });

    await page
      .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __autopilotSpeech: { count: () => number };
            }
          ).__autopilotSpeech.count(),
        ),
      )
      .toBe(1);

    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("Bé mèo nhỏ đang"),
    );

    // Stays on page 1 with clear Chưa lưu message
    await expect(page.getByText(/Chưa lưu được trang này/i)).toBeVisible();
    await expect(page.getByLabel("Trang sách 1")).toBeVisible();
    expect(harness.completeCalls).toHaveLength(1);

    // Child retries saving -> succeeds and turns to page 2
    await page
      .getByRole("button", { name: "Đánh dấu trang đã đọc xong" })
      .click();
    await expect(page.getByLabel("Trang sách 2")).toBeVisible({
      timeout: 15_000,
    });
    expect(harness.completeCalls).toHaveLength(2);

    // Reload preserves page 2 progress from backend
    await page.reload();
    await expect(page.getByLabel("Trang sách 2")).toBeVisible();
  });

  test("G14: Parent can independently toggle Hỗ trợ tự động, Tự chuyển trang, and opt-in Nhắc ba mẹ qua email", async ({
    page,
  }, testInfo) => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const harness = await installAutopilotSession(page, {
      initialState: "reading",
    });

    await page.getByRole("button", { name: "Giọng đọc" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const assistSwitch = dialog.getByRole("switch", {
      name: /Hỗ trợ tự động/i,
    });
    const autoAdvanceSwitch = dialog.getByRole("switch", {
      name: /Tự chuyển trang/i,
    });
    const emailSwitch = dialog.getByRole("switch", {
      name: /Nhắc ba mẹ qua email/i,
    });

    await expect(assistSwitch).toBeChecked();
    await expect(autoAdvanceSwitch).toBeChecked();
    await expect(emailSwitch).not.toBeChecked();

    // Toggle autoAdvance OFF (independent of assist)
    await autoAdvanceSwitch.click();
    await expect(autoAdvanceSwitch).not.toBeChecked();
    await expect(assistSwitch).toBeChecked();

    // Opt-in parent email reminder -> saves to backend
    await emailSwitch.click();
    await expect(emailSwitch).toBeChecked();
    expect(harness.presenceSettingsUpdates).toEqual([true]);

    await page.screenshot({
      path: resolve(
        EVIDENCE_DIR,
        `e2e-autopilot-settings-${testInfo.project.name}.png`,
      ),
      fullPage: false,
    });

    // Opt-out immediately -> saves false to backend
    await emailSwitch.click();
    await expect(emailSwitch).not.toBeChecked();
    expect(harness.presenceSettingsUpdates).toEqual([true, false]);
  });

  test("G24: Voice-interactive 3-question comprehension quiz completes with 0 clicks (reads question & A/B/C, blocks echo, accepts voice)", async ({
    page,
  }, testInfo) => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const harness = await installAutopilotSession(page, {
      initialState: "question",
    });

    await expect(page.getByText("Bạn nào thích ăn cá?")).toBeVisible({
      timeout: 15_000,
    });

    // Wait for Q1 TTS to finish and recognition #1 to open with 0 clicks
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __autopilotSpeech: { count: () => number };
            }
          ).__autopilotSpeech.count(),
        ),
      )
      .toBeGreaterThanOrEqual(1);

    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      path: resolve(
        EVIDENCE_DIR,
        `e2e-autopilot-quiz-voice-${testInfo.project.name}.png`,
      ),
      fullPage: false,
    });

    // Immediate echo of an option right after TTS ends is blocked
    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("Đáp án B: Con vịt"),
    );
    expect(harness.quizSubmissions).toHaveLength(0);

    // Wait past 1.5s echo tail guard -> answer Q1 by letter "đáp án A"
    await page.waitForTimeout(1700);
    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("đáp án A"),
    );

    // Automatically advances to Q2 with 0 clicks
    await expect(page.getByText("Bé đi đâu buổi sáng?")).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __autopilotSpeech: { count: () => number };
            }
          ).__autopilotSpeech.count(),
        ),
      )
      .toBeGreaterThanOrEqual(2);

    // Wait past echo guard -> answer Q2 using Vietnamese letter name "con chọn bê"
    await page.waitForTimeout(1700);
    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("con chọn bê"),
    );

    // Automatically advances to Q3 with 0 clicks
    await expect(page.getByText("Ai nấu cơm cho bé?")).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __autopilotSpeech: { count: () => number };
            }
          ).__autopilotSpeech.count(),
        ),
      )
      .toBeGreaterThanOrEqual(3);

    // Wait past echo guard -> answer Q3 by speaking option content "Mẹ của bé"
    await page.waitForTimeout(1700);
    await page.evaluate(() =>
      (
        window as unknown as {
          __autopilotSpeech: { say: (t: string) => void };
        }
      ).__autopilotSpeech.say("Mẹ của bé"),
    );

    // Automatically finishes the quiz and transitions to completion view with 0 clicks!
    await expect
      .poll(() => harness.quizSubmissions.length, { timeout: 15_000 })
      .toBe(3);
    expect(harness.quizSubmissions.map((s) => s.answer)).toEqual([
      "Con mèo",
      "Đi học",
      "Mẹ của bé",
    ]);
    await expect(page.getByText("Ai nấu cơm cho bé?")).not.toBeVisible({
      timeout: 15_000,
    });
  });
});
