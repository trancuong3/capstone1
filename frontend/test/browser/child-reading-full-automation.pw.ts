import { expect, test, type Page, type Route } from "@playwright/test";
import { ids, installApiFixture, readyVoiceStatus } from "./real-data-fixture";

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

async function installFullGoldenPathFixture(page: Page) {
  await installApiFixture(page);

  const now = "2026-11-26T10:00:00Z";
  const base = `/reading/sessions/${ids.session}`;
  let currentIndex = 0;
  const completedPages = [false, false];
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

  const difficultWordsQueue = [
    {
      normalized_word: "mèo",
      display_text: "mèo",
      difficulty_score: 4,
      omission_count: 1,
      repetition_count: 0,
      long_pause_count: 0,
      read_example_count: 0,
      session_count: 1,
      last_seen_at: now,
      evidence_word_ids: [pageOneWords[1].word_id],
      mispronunciation_count: 0,
      encounter_count: 1,
      practice_status: "NOT_PRACTICED",
      practice_attempts_count: 0,
      practice_correct_count: 0,
      practice_incorrect_count: 0,
      practice_uncertain_count: 0,
      consecutive_correct_count: 0,
      last_practiced_at: null as string | null,
      last_practice_status: null as string | null,
      sources: [
        {
          book_id: ids.book,
          book_title: "Câu chuyện từ API",
          book_author: "Tác giả API",
          min_grade: 1,
          max_grade: 3,
          session_id: ids.session,
          page_id: PAGE_1_ID,
          page_revision_id: PAGE_1_REV,
          page_number: 1,
          context_phrase: "Bé mèo nhỏ đang",
          last_seen_at: now,
        },
      ],
    },
  ];
  const dwAttempts: Record<string, unknown>[] = [];

  const pages = [
    {
      page_id: PAGE_1_ID,
      page_revision_id: PAGE_1_REV,
      page_number: 1,
      confidence: 0.98,
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
      confidence: 0.98,
      width: 600,
      height: 800,
      image_overlay_safe: false,
      image_url: null,
      text: "An vui vẻ đọc",
      words: pageTwoWords,
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
    if (path.startsWith(base + "/pages/") && path.endsWith("/complete")) {
      const pageId = path.split("/")[5] ?? "";
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
    if (path === base + "/compare") {
      return json(route, {
        session_id: ids.session,
        page_id: pages[currentIndex].page_id,
        page_revision_id: pages[currentIndex].page_revision_id,
        distance: 1,
        alignment: [],
        summary: {
          missing_words: ["mèo"],
          extra_words: [],
          substitutions: [],
          repeated_count: 0,
          repeated_words: [],
          hesitations: [],
          hesitation_seconds: null,
        },
      });
    }
    if (path === "/reading/events") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, {
        Id: "99999999-0000-4000-8000-000000000001",
        SessionId: body.SessionId ?? ids.session,
        PageId: body.PageId ?? pages[currentIndex].page_id,
        PageRevisionId:
          body.PageRevisionId ?? pages[currentIndex].page_revision_id,
        WordId: body.WordId ?? null,
        Type: body.Type ?? "WORD_RETRY",
        StartMs: body.StartMs ?? 0,
        EndMs: body.EndMs ?? null,
        Confidence: null,
        Status: body.Status ?? "CONFIRMED",
        Metadata: body.Metadata ?? {},
        CreatedAt: now,
      });
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
        duration_minutes: 2,
        pages_explored: 2,
        selected_range_pages: 2,
        practiced_words: 8,
        score: 88,
        correct_words: ["Bé", "nhỏ", "đang", "An", "vui", "vẻ", "đọc"],
        mispronounced_words: ["mèo"],
        skipped_words: [],
        transcripts: ["Bé nhỏ đang", "An vui vẻ đọc"],
        spoken_words: ["Bé", "nhỏ", "đang", "An", "vui", "vẻ", "đọc"],
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
        duration_ms: 90_000,
      });
    }
    return json(route, {}, 404);
  });

  await page.route("http://127.0.0.1:8000/voice/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeaders });
    const path = new URL(route.request().url()).pathname;
    if (path === "/voice/status")
      return json(route, readyVoiceStatus("fixture_vi"));
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
      return route.fulfill({
        headers: corsHeaders,
        contentType: "audio/wav",
        body: wav(),
      });
    }
    if (path === "/voice/speech-to-text") {
      return json(route, {
        text: "mèo",
        language_code: "vi",
        language_probability: 1,
        words: null,
        provider: "local",
        fallback_used: false,
      });
    }
    return json(route, {}, 404);
  });

  await page.route("http://127.0.0.1:8000/tutor/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeaders });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/questions/generate")) {
      return json(route, {
        session_id: ids.session,
        total: quizQuestions.length,
        source: "AI",
        created: true,
      });
    }
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

  await page.route(
    `http://127.0.0.1:8000/system/difficult-words/${ids.child}**`,
    (route) => {
      if (route.request().method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: corsHeaders });
      const path = new URL(route.request().url()).pathname;
      if (path === `/system/difficult-words/${ids.child}`) {
        return json(route, difficultWordsQueue);
      }
      if (path === `/system/difficult-words/${ids.child}/practice/history`) {
        return json(route, { storage_ready: true, items: dwAttempts });
      }
      if (
        path === `/system/difficult-words/${ids.child}/practice/evaluate` &&
        route.request().method() === "POST"
      ) {
        const w = difficultWordsQueue[0];
        w.practice_status = "COMPLETED";
        w.practice_attempts_count = 1;
        w.practice_correct_count = 1;
        w.consecutive_correct_count = 1;
        w.last_practiced_at = now;
        w.last_practice_status = "CORRECT";
        const attempt = {
          attempt_id: "77777777-7777-4777-8777-000000000001",
          child_id: ids.child,
          normalized_word: w.normalized_word,
          display_text: w.display_text,
          attempt_number: 1,
          state: "COMPLETED",
          assessment_status: "CORRECT",
          recognition_source: "SERVER_STT",
          spoken_transcript: "mèo",
          confidence: null,
          audio_duration_ms: 820,
          assessment_version: 1,
          evidence_word_ids: w.evidence_word_ids,
          persistence_backend: "READING_EVENT",
          resolved_in_session: true,
          started_at: now,
          completed_at: now,
          feedback_message: "Chính xác rồi! Con giỏi lắm!",
          word_progress: {
            normalized_word: w.normalized_word,
            practice_status: "COMPLETED",
            practice_attempts_count: 1,
            practice_correct_count: 1,
            practice_incorrect_count: 0,
            practice_uncertain_count: 0,
            consecutive_correct_count: 1,
            required_consecutive_correct: 1,
            last_practiced_at: now,
            last_practice_status: "CORRECT",
          },
          next_recommended_word: null,
          evidence_count_unchanged: true,
        };
        dwAttempts.unshift(attempt);
        return json(route, attempt);
      }
      return route.fallback();
    },
  );

  await page.addInitScript(() => {
    const bursts = new WeakMap<MediaStream, () => void>();
    const NativeRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends NativeRecorder {
      start(timeslice?: number) {
        super.start(timeslice);
        bursts.get(this.stream)?.();
      }
    };

    const instances: Array<{
      onresult: ((event: unknown) => void) | null;
      onend: (() => void) | null;
      onerror: ((event: unknown) => void) | null;
      say: (transcript: string, confidence?: number) => void;
    }> = [];

    class GoldenSpeechRecognition {
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
      value: GoldenSpeechRecognition,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: GoldenSpeechRecognition,
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
        speak: (u: SpeechSynthesisUtterance) => {
          setTimeout(() => {
            u.onstart?.({} as SpeechSynthesisEvent);
            setTimeout(
              () => u.onend?.({ elapsedTime: 0.1 } as SpeechSynthesisEvent),
              20,
            );
          }, 10);
        },
        cancel: () => {},
        pause: () => {},
        resume: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });

    let activeGainNode: GainNode | null = null;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const ctx = new AudioContext();
        await ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        activeGainNode = gain;
        const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 240;
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        const stream = dest.stream;
        bursts.set(stream, () => {
          const start = ctx.currentTime;
          gain.gain.cancelScheduledValues(start);
          gain.gain.setValueAtTime(0, start);
          gain.gain.setValueAtTime(0.1, start + 0.1);
          gain.gain.setValueAtTime(0.08, start + 0.25);
          gain.gain.setValueAtTime(0, start + 0.45);
        });
        for (const track of stream.getTracks()) {
          const origStop = track.stop.bind(track);
          track.stop = () => {
            try {
              osc.stop();
              void ctx.close();
            } catch {
              // ignore
            }
            origStop();
          };
        }
        return stream;
      },
    });

    Object.assign(window, {
      __goldenSpeech: {
        count: () => instances.length,
        say: (transcript: string, confidence = 0.95) => {
          const active = instances[instances.length - 1];
          if (!active) throw new Error("No active GoldenSpeechRecognition");
          if (activeGainNode) {
            activeGainNode.gain.value = 0.1;
            setTimeout(() => {
              if (activeGainNode) activeGainNode.gain.value = 0;
            }, 220);
          }
          active.say(transcript, confidence);
        },
      },
    });
  });
}

test.describe("AUTO-E2E-FULL: Golden Path across all 4 child reading flows", () => {
  for (const vp of [
    { name: "desktop-1280x800", width: 1280, height: 800 },
    { name: "mobile-390x844", width: 390, height: 844 },
  ]) {
    test(`Golden Path (reading -> retry -> comprehension quiz -> SessionComplete CTA -> difficult-words 100%) on ${vp.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await installFullGoldenPathFixture(page);

      await page.goto(`/reading/${ids.session}?state=ready`);
      await page.getByRole("button", { name: "Bắt đầu đọc" }).click();

      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as unknown as { __goldenSpeech: { count: () => number } }
            ).__goldenSpeech.count(),
          ),
        )
        .toBeGreaterThanOrEqual(1);

      // Flow 1: Read page 1 skipping "mèo" -> auto-turns to page 2
      await page.evaluate(() => {
        (
          window as unknown as {
            __goldenSpeech: { say: (t: string) => void };
          }
        ).__goldenSpeech.say("Bé nhỏ đang");
      });
      await expect(page.getByLabel("Trang sách 2")).toBeVisible({
        timeout: 15_000,
      });

      // Wait for mic #2 on page 2 -> read page 2 fluently -> auto-end triggers retryPrompt!
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as unknown as { __goldenSpeech: { count: () => number } }
            ).__goldenSpeech.count(),
          ),
        )
        .toBeGreaterThanOrEqual(2);
      await page.evaluate(() => {
        (
          window as unknown as {
            __goldenSpeech: { say: (t: string) => void };
          }
        ).__goldenSpeech.say("An vui vẻ đọc");
      });

      await expect(
        page.getByRole("dialog", { name: "Mình đọc lại những từ này nhé?" }),
      ).toBeVisible({ timeout: 15_000 });

      // Flow 2: Voice "Có" enters retryMode, auto-navigates back to page 1 and focuses "mèo"
      const recCountBeforeWrapUp = await page.evaluate(() =>
        (
          window as unknown as { __goldenSpeech: { count: () => number } }
        ).__goldenSpeech.count(),
      );
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as unknown as { __goldenSpeech: { count: () => number } }
            ).__goldenSpeech.count(),
          ),
        )
        .toBeGreaterThan(recCountBeforeWrapUp);

      await page.waitForTimeout(1700);
      await page.evaluate(() => {
        (
          window as unknown as {
            __goldenSpeech: { say: (t: string) => void };
          }
        ).__goldenSpeech.say("Có");
      });

      await expect(page.getByLabel("Trang sách 1")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.locator('[data-reading-scroll-container="true"]'),
      ).toHaveAttribute("data-auto-follow", "active");
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      // Wait for retry mic to open on "mèo", say "mèo" -> finishes reading -> transitions to 3-question Quiz!
      const recCountBeforeRetryWord = await page.evaluate(() =>
        (
          window as unknown as { __goldenSpeech: { count: () => number } }
        ).__goldenSpeech.count(),
      );
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (
                window as unknown as {
                  __goldenSpeech: { count: () => number };
                }
              ).__goldenSpeech.count(),
            ),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(recCountBeforeRetryWord);

      await page.waitForTimeout(1700);
      await page.evaluate(() => {
        (
          window as unknown as {
            __goldenSpeech: { say: (t: string) => void };
          }
        ).__goldenSpeech.say("mèo");
      });

      // Flow 3: 3 comprehension questions by voice
      await expect(page.getByText("Bạn nào thích ăn cá?")).toBeVisible({
        timeout: 15_000,
      });
      const q1RecCount = await page.evaluate(() =>
        (
          window as unknown as { __goldenSpeech: { count: () => number } }
        ).__goldenSpeech.count(),
      );
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (
                window as unknown as {
                  __goldenSpeech: { count: () => number };
                }
              ).__goldenSpeech.count(),
            ),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(q1RecCount);
      await page.waitForTimeout(1700);
      await page.evaluate(() => {
        (
          window as unknown as {
            __goldenSpeech: { say: (t: string) => void };
          }
        ).__goldenSpeech.say("đáp án A");
      });

      await expect(page.getByText("Bé đi đâu buổi sáng?")).toBeVisible({
        timeout: 15_000,
      });
      const q2RecCount = await page.evaluate(() =>
        (
          window as unknown as { __goldenSpeech: { count: () => number } }
        ).__goldenSpeech.count(),
      );
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (
                window as unknown as {
                  __goldenSpeech: { count: () => number };
                }
              ).__goldenSpeech.count(),
            ),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(q2RecCount);
      await page.waitForTimeout(1700);
      await page.evaluate(() => {
        (
          window as unknown as {
            __goldenSpeech: { say: (t: string) => void };
          }
        ).__goldenSpeech.say("con chọn B");
      });

      await expect(page.getByText("Ai nấu cơm cho bé?")).toBeVisible({
        timeout: 15_000,
      });
      const q3RecCount = await page.evaluate(() =>
        (
          window as unknown as { __goldenSpeech: { count: () => number } }
        ).__goldenSpeech.count(),
      );
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (
                window as unknown as {
                  __goldenSpeech: { count: () => number };
                }
              ).__goldenSpeech.count(),
            ),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(q3RecCount);
      await page.waitForTimeout(1700);
      await page.evaluate(() => {
        (
          window as unknown as {
            __goldenSpeech: { say: (t: string) => void };
          }
        ).__goldenSpeech.say("Mẹ của bé");
      });

      // Flow 4: SessionComplete CTA -> /reports/difficult-words -> finish queue -> reload 100%
      const cta = page.getByTestId("practice-difficult-words-cta");
      await expect(cta).toBeVisible({ timeout: 15_000 });
      const overflowBeforeNav = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflowBeforeNav).toBeLessThanOrEqual(2);

      await cta.click();
      await expect(page).toHaveURL(/\/reports\/difficult-words/);
      await page.getByRole("button", { name: "Luyện cùng bé" }).click();
      await expect(
        page.getByRole("heading", { name: "mèo", exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/Hoàn thành từ này/)).toBeVisible({
        timeout: 12_000,
      });

      await page.getByRole("button", { name: "Quay về danh sách" }).click();
      await expect(
        page.getByText(/1\/1 từ đã đọc đúng \(100%\)/),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByText(/1\/1 từ đã đọc đúng \(100%\)/),
      ).toBeVisible();
    });
  }
});
