import { expect, test, type Page, type Route } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DifficultWordDTO } from "../../types/reports";
import { ids, installApiFixture } from "./real-data-fixture";

type MutableDifficultWord = {
  -readonly [K in keyof DifficultWordDTO]: DifficultWordDTO[K];
};

const ARTIFACT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/antigravity-word-practice-upgrade",
);

function wavBuffer(): Buffer {
  const audio = Buffer.alloc(44 + 6400);
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
  audio.writeUInt32LE(6400, 40);
  return audio;
}

async function installDifficultWordsE2EFixture(
  page: Page,
  options?: { readonly micMode?: "synthetic" | "synthetic-burst" | "denied" },
) {
  await installApiFixture(page);

  const fixtureState = {
    wordsStatus: 200,
    emptyWords: false,
  };
  const micMode = options?.micMode ?? "synthetic";

  const now = "2026-11-18T02:00:00Z";
  const childBId = "22222222-2222-4222-8222-333333333333";
  const children = [
    {
      id: ids.child,
      parent_id: ids.parent,
      alias: "Bé An",
      grade: 2,
      settings: {},
      created_at: now,
    },
    {
      id: childBId,
      parent_id: ids.parent,
      alias: "Bé Bình",
      grade: 1,
      settings: {},
      created_at: now,
    },
  ];

  const bookAId = ids.book;
  const bookBId = "33333333-3333-4333-8333-333333333399";
  const wordListA: MutableDifficultWord[] = [
    {
      normalized_word: "có",
      display_text: "có",
      difficulty_score: 4,
      omission_count: 1,
      repetition_count: 0,
      long_pause_count: 0,
      read_example_count: 0,
      session_count: 1,
      last_seen_at: now,
      evidence_word_ids: [ids.revision],
      mispronunciation_count: 0,
      encounter_count: 1,
      practice_status: "NOT_PRACTICED",
      practice_attempts_count: 0,
      practice_correct_count: 0,
      practice_incorrect_count: 0,
      practice_uncertain_count: 0,
      consecutive_correct_count: 0,
      last_practiced_at: null,
      last_practice_status: null,
      sources: [
        {
          book_id: bookAId,
          book_title: "Chào ngày mới",
          book_author: "Minh Anh",
          min_grade: 1,
          max_grade: 1,
          session_id: ids.session,
          page_id: ids.page,
          page_revision_id: ids.revision,
          page_number: 2,
          context_phrase: "Bé có một bông hoa.",
          last_seen_at: now,
        },
      ],
    },
    {
      normalized_word: "ngập ngừng",
      display_text: "ngập ngừng",
      difficulty_score: 3,
      omission_count: 1,
      repetition_count: 0,
      long_pause_count: 1,
      read_example_count: 0,
      session_count: 2,
      last_seen_at: now,
      evidence_word_ids: [ids.revision],
      mispronunciation_count: 0,
      encounter_count: 2,
      practice_status: "NOT_PRACTICED",
      practice_attempts_count: 0,
      practice_correct_count: 0,
      practice_incorrect_count: 0,
      practice_uncertain_count: 0,
      consecutive_correct_count: 0,
      last_practiced_at: null,
      last_practice_status: null,
      sources: [
        {
          book_id: bookAId,
          book_title: "Chào ngày mới",
          book_author: "Minh Anh",
          min_grade: 1,
          max_grade: 1,
          session_id: ids.session,
          page_id: ids.page,
          page_revision_id: ids.revision,
          page_number: 3,
          last_seen_at: now,
        },
      ],
    },
  ];

  const wordListB: MutableDifficultWord[] = [
    {
      normalized_word: "chuyến đi",
      display_text: "chuyến đi",
      difficulty_score: 2,
      omission_count: 0,
      repetition_count: 0,
      long_pause_count: 1,
      read_example_count: 0,
      session_count: 1,
      last_seen_at: now,
      evidence_word_ids: [ids.revision],
      mispronunciation_count: 1,
      encounter_count: 2,
      practice_status: "NOT_PRACTICED",
      practice_attempts_count: 0,
      practice_correct_count: 0,
      practice_incorrect_count: 0,
      practice_uncertain_count: 0,
      consecutive_correct_count: 0,
      last_practiced_at: null,
      last_practice_status: null,
      sources: [
        {
          book_id: bookBId,
          book_title: "Chuyến đi mùa thu",
          book_author: "Lan Chi",
          min_grade: 1,
          max_grade: 1,
          session_id: ids.session,
          page_number: 1,
          last_seen_at: now,
        },
      ],
    },
  ];

  const attemptsA: Record<string, unknown>[] = [];
  const corsHeaders = {
    "access-control-allow-origin": "http://127.0.0.1:3106",
    "access-control-allow-headers": "authorization,content-type,accept",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  };
  const jsonRespond = (route: Route, data: unknown, status = 200) =>
    route.fulfill({
      status,
      headers: corsHeaders,
      contentType: "application/json",
      body: JSON.stringify(data),
    });

  await page.route("http://127.0.0.1:8000/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();

    if (pathname === "/profiles/dashboard-summary") {
      return jsonRespond(route, {
        profile: {
          id: ids.parent,
          role: "parent",
          display_name: "Ba mẹ API",
          created_at: now,
          email: "parent@example.test",
          contact_phone: "+84900000000",
          email_verified: true,
          contact_info_status: "available",
          avatar_url: null,
          children,
        },
        children,
        latest_sessions_by_child: {},
      });
    }
    if (pathname === "/profiles/me") {
      return jsonRespond(route, {
        id: ids.parent,
        role: "parent",
        display_name: "Ba mẹ API",
        created_at: now,
        email: "parent@example.test",
        contact_phone: "+84900000000",
        email_verified: true,
        contact_info_status: "available",
        children,
      });
    }
    if (pathname === "/profiles/children") {
      return jsonRespond(route, children);
    }
    if (pathname === `/profiles/children/${ids.child}`) {
      return jsonRespond(route, children[0]);
    }
    if (pathname === `/profiles/children/${childBId}`) {
      return jsonRespond(route, children[1]);
    }
    if (pathname === "/voice/text-to-speech" && method === "POST") {
      return route.fulfill({
        status: 200,
        headers: corsHeaders,
        contentType: "audio/wav",
        body: wavBuffer(),
      });
    }
    if (pathname === `/system/difficult-words/${ids.child}`) {
      if (fixtureState.wordsStatus !== 200) {
        return jsonRespond(
          route,
          { detail: "Backend unavailable" },
          fixtureState.wordsStatus,
        );
      }
      return jsonRespond(route, fixtureState.emptyWords ? [] : wordListA);
    }
    if (pathname === `/system/difficult-words/${childBId}`) {
      return jsonRespond(route, wordListB);
    }
    if (pathname === `/system/difficult-words/${ids.child}/practice/history`) {
      const norm = url.searchParams.get("normalized_word");
      const filtered = norm
        ? attemptsA.filter((item) => item.normalized_word === norm)
        : attemptsA;
      return jsonRespond(route, { storage_ready: true, items: filtered });
    }
    if (
      pathname === `/system/difficult-words/${ids.child}/practice/evaluate` &&
      method === "POST"
    ) {
      const formData = route.request().postData() ?? "";
      const normMatch = formData.match(
        /name="normalized_word"\r\n\r\n([^\r\n]+)/,
      );
      const norm = normMatch?.[1]?.trim() || "có";
      const wordEntry = wordListA.find((w) => w.normalized_word === norm);
      const count = (wordEntry?.practice_attempts_count ?? 0) + 1;
      if (wordEntry) {
        wordEntry.practice_attempts_count = count;
        wordEntry.practice_correct_count = count;
        wordEntry.consecutive_correct_count = 1;
        wordEntry.practice_status = "COMPLETED";
        wordEntry.last_practiced_at = now;
        wordEntry.last_practice_status = "CORRECT";
      }
      const attemptId = `77777777-7777-4777-8777-${String(attemptsA.length + 1).padStart(12, "0")}`;
      const attempt = {
        attempt_id: attemptId,
        child_id: ids.child,
        normalized_word: norm,
        display_text: wordEntry?.display_text ?? norm,
        attempt_number: count,
        state: "COMPLETED",
        assessment_status: "CORRECT",
        recognition_source: "SERVER_STT",
        spoken_transcript: wordEntry?.display_text ?? norm,
        confidence: null,
        audio_duration_ms: 820,
        assessment_version: 1,
        evidence_word_ids: [ids.revision],
        persistence_backend: "READING_EVENT",
        resolved_in_session: true,
        started_at: now,
        completed_at: now,
        feedback_message: "Chính xác rồi! Con giỏi lắm!",
        word_progress: {
          normalized_word: norm,
          practice_status: "COMPLETED",
          practice_attempts_count: count,
          practice_correct_count: count,
          practice_incorrect_count: 0,
          practice_uncertain_count: 0,
          consecutive_correct_count: 1,
          required_consecutive_correct: 1,
          last_practiced_at: now,
          last_practice_status: "CORRECT",
        },
        next_recommended_word: norm === "có" ? "ngập ngừng" : null,
        evidence_count_unchanged: true,
      };
      attemptsA.unshift(attempt);
      return jsonRespond(route, attempt);
    }
    if (
      pathname === `/system/difficult-words/${ids.child}/practice/start` &&
      method === "POST"
    ) {
      const body = route.request().postDataJSON() as {
        normalized_word: string;
        display_text?: string;
        evidence_word_ids?: string[];
      };
      const attemptId = `77777777-7777-4777-8777-${String(attemptsA.length + 1).padStart(12, "0")}`;
      const attemptNum =
        attemptsA.filter((a) => a.normalized_word === body.normalized_word)
          .length + 1;
      const attempt = {
        attempt_id: attemptId,
        child_id: ids.child,
        normalized_word: body.normalized_word,
        display_text: body.display_text ?? body.normalized_word,
        attempt_number: attemptNum,
        state: "STARTED",
        assessment_status: null,
        recognition_source: null,
        spoken_transcript: null,
        confidence: null,
        audio_duration_ms: null,
        assessment_version: 1,
        evidence_word_ids: body.evidence_word_ids ?? [ids.revision],
        started_at: now,
        completed_at: null,
        feedback_message: null,
        word_progress: {
          normalized_word: body.normalized_word,
          practice_status: "IN_PROGRESS",
          practice_attempts_count: attemptNum - 1,
          practice_correct_count: attemptNum - 1,
          practice_incorrect_count: 0,
          practice_uncertain_count: 0,
          consecutive_correct_count: attemptNum - 1,
          required_consecutive_correct: 2,
          last_practiced_at: null,
          last_practice_status: null,
        },
        next_recommended_word: "ngập ngừng",
        evidence_count_unchanged: true,
      };
      attemptsA.unshift(attempt);
      return jsonRespond(route, attempt);
    }
    if (
      pathname.startsWith(`/system/difficult-words/${ids.child}/practice/`) &&
      pathname.endsWith("/evaluate-audio") &&
      method === "POST"
    ) {
      const attemptId = pathname.split("/")[5];
      const target = attemptsA.find((a) => a.attempt_id === attemptId);
      const norm = String(target?.normalized_word ?? "khu vườn");
      const wordEntry = wordListA.find((w) => w.normalized_word === norm);
      const count = (wordEntry?.practice_attempts_count ?? 0) + 1;
      const consecutive = (wordEntry?.consecutive_correct_count ?? 0) + 1;
      const completed = consecutive >= 2;
      if (wordEntry) {
        wordEntry.practice_attempts_count = count;
        wordEntry.practice_correct_count = count;
        wordEntry.consecutive_correct_count = consecutive;
        wordEntry.practice_status = completed ? "COMPLETED" : "IN_PROGRESS";
        wordEntry.last_practiced_at = now;
        wordEntry.last_practice_status = "CORRECT";
      }
      if (target) {
        target.state = "COMPLETED";
        target.assessment_status = "CORRECT";
        target.recognition_source = "SERVER_STT";
        target.spoken_transcript = norm;
        target.audio_duration_ms = 900;
        target.completed_at = now;
        target.feedback_message = completed
          ? "Tuyệt vời! Con đã đọc đúng từ này 2 lần liên tiếp và hoàn thành bài luyện rồi!"
          : "Giỏi lắm! Con đọc đúng từ này rồi! Con hãy đọc đúng thêm 1 lần nữa để hoàn thành nhé!";
        target.word_progress = {
          normalized_word: norm,
          practice_status: completed ? "COMPLETED" : "IN_PROGRESS",
          practice_attempts_count: count,
          practice_correct_count: count,
          practice_incorrect_count: 0,
          practice_uncertain_count: 0,
          consecutive_correct_count: consecutive,
          required_consecutive_correct: 2,
          last_practiced_at: now,
          last_practice_status: "CORRECT",
        };
      }
      return jsonRespond(route, target);
    }
    return route.fallback();
  });

  // Synthetic Web Audio / MediaRecorder or permission-denied fixture (never touches real hardware)
  await page.addInitScript(
    (mode: "synthetic" | "synthetic-burst" | "denied") => {
      const bursts = new WeakMap<MediaStream, () => void>();
      if (mode === "synthetic-burst") {
        const NativeRecorder = window.MediaRecorder;
        window.MediaRecorder = class extends NativeRecorder {
          start(timeslice?: number) {
            super.start(timeslice);
            bursts.get(this.stream)?.();
          }
        };
      }
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(window, "webkitSpeechRecognition", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          if (mode === "denied") {
            throw new DOMException("Permission denied", "NotAllowedError");
          }
          const context = new AudioContext();
          await context.resume();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const destination = context.createMediaStreamDestination();
          oscillator.frequency.value = 260;
          gain.gain.value = mode === "synthetic-burst" ? 0 : 0.008;
          oscillator.connect(gain);
          gain.connect(destination);
          oscillator.start();
          const stream = destination.stream;
          if (mode === "synthetic-burst") {
            // Preparing the mic can happen before TTS. Aim the synthetic
            // utterance at each actual recording, including reused streams.
            bursts.set(stream, () => {
              const start = context.currentTime;
              gain.gain.cancelScheduledValues(start);
              gain.gain.setValueAtTime(0, start);
              gain.gain.setValueAtTime(0.08, start + 0.12);
              gain.gain.setValueAtTime(0.04, start + 0.26);
              gain.gain.setValueAtTime(0.08, start + 0.4);
              gain.gain.setValueAtTime(0, start + 0.54);
            });
          }
          for (const track of stream.getTracks()) {
            const origStop = track.stop.bind(track);
            track.stop = () => {
              try {
                oscillator.stop();
                void context.close();
              } catch {
                // Ignore cleanup errors
              }
              origStop();
            };
          }
          return stream;
        },
      });
    },
    micMode,
  );

  return { childBId, fixtureState };
}

test("Difficult words end-to-end flow: select child, practice, evaluate, persist across reload, and check 4 responsive widths", async ({
  page,
}, testInfo) => {
  const { childBId } = await installDifficultWordsE2EFixture(page);
  await page.addInitScript(() => {
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.src.startsWith("blob:"))
        Reflect.set(window, "practiceReplay", this);
      return originalPlay.call(this);
    };
  });

  await page.goto(`/reports/difficult-words?childId=${ids.child}`);
  await expect(
    page.getByRole("heading", { name: "Từ cần luyện của Bé An" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Chào ngày mới", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Luyện từ có/ })).toBeVisible();

  // Check responsive widths for list screen (390, 768, 1024, 1440)
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  }
  await page.setViewportSize({
    width: testInfo.project.name === "mobile" ? 390 : 1440,
    height: 900,
  });
  await page.screenshot({
    fullPage: true,
    path: path.join(
      ARTIFACT_DIR,
      `difficult-words-list-${testInfo.project.name}.png`,
    ),
  });

  // Switch child profile -> isolates Bé Bình data
  if (testInfo.project.name === "mobile") {
    await page
      .getByRole("button", { name: /Bé đang chọn: Bé An|Đổi nhanh bé/ })
      .click();
    await page
      .getByRole("listbox", { name: "Chuyển nhanh hồ sơ bé" })
      .getByRole("option", { name: /Bé Bình/ })
      .click();
  } else {
    await page
      .getByLabel("Chọn hồ sơ bé để xem dữ liệu")
      .selectOption(childBId);
  }
  await expect(
    page.getByRole("heading", { name: "Từ cần luyện của Bé Bình" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Chuyến đi mùa thu", exact: true }),
  ).toBeVisible();

  // Switch back to Bé An
  if (testInfo.project.name === "mobile") {
    await page
      .getByRole("button", { name: /Bé đang chọn: Bé Bình|Đổi nhanh bé/ })
      .click();
    await page
      .getByRole("listbox", { name: "Chuyển nhanh hồ sơ bé" })
      .getByRole("option", { name: /Bé An/ })
      .click();
  } else {
    await page
      .getByLabel("Chọn hồ sơ bé để xem dữ liệu")
      .selectOption(ids.child);
  }
  await expect(
    page.getByRole("heading", { name: "Chào ngày mới", exact: true }),
  ).toBeVisible();

  // Click target word chip 'có' -> opens focused practice stage
  await page.getByRole("button", { name: /Luyện từ có/ }).click();
  await expect(
    page.getByRole("heading", { name: "có", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Bé có một bông hoa\./)).toBeVisible();

  // The word chip starts practice. Pause before testing standalone playback.
  await page.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await page.getByRole("button", { name: "Nghe phát âm mẫu" }).click();

  // Check responsive widths inside practice panel
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  }
  await page.setViewportSize({
    width: testInfo.project.name === "mobile" ? 390 : 1440,
    height: 900,
  });

  // Resume, read once, and save a successful evaluation.
  await page.getByRole("button", { name: "Tiếp tục luyện" }).click();
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible();
  await page.waitForTimeout(450);
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();

  await expect(page.getByText(/Chính xác rồi! Con giỏi lắm!/)).toBeVisible();
  await page.getByRole("button", { name: "Nghe lại giọng bé" }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const replay = Reflect.get(window, "practiceReplay") as
          HTMLAudioElement | undefined;
        if (!replay || replay.currentTime === 0) return null;
        const response = await fetch(replay.src);
        return response.headers.get("content-type");
      }),
    )
    .toBe("audio/wav");
  await page.screenshot({
    fullPage: true,
    path: path.join(
      ARTIFACT_DIR,
      `difficult-words-practice-${testInfo.project.name}.png`,
    ),
  });

  // 3) Pause/return to list & verify persisted green status across reload!
  await page.getByRole("button", { name: "Quay về danh sách" }).click();
  await expect(page.getByText(/Đã luyện đúng 1\/2 từ/)).toBeVisible();

  await page.reload();
  await expect(page.getByText(/Đã luyện đúng 1\/2 từ/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Luyện từ có (Đã đọc đúng)" }),
  ).toBeVisible();
});

test("Difficult words resilient states: 503 retry, empty state, and microphone permission denied", async ({
  page,
}) => {
  const { fixtureState } = await installDifficultWordsE2EFixture(page, {
    micMode: "denied",
  });

  // 1) Backend 503 -> Retry -> Empty state (never manufactures mock rows)
  fixtureState.wordsStatus = 503;
  fixtureState.emptyWords = true;
  await page.goto(`/reports/difficult-words?childId=${ids.child}`);
  await expect(
    page.getByRole("heading", { name: "Dữ liệu đang chờ bổ sung" }),
  ).toBeVisible();

  fixtureState.wordsStatus = 200;
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(
    page.getByRole("heading", { name: "Chưa có từ cần luyện" }),
  ).toBeVisible();

  // 2) Restore real word list -> open practice -> trigger mic denied -> show friendly Vietnamese error
  fixtureState.emptyWords = false;
  await page.getByLabel("Chọn khoảng thời gian").selectOption("180");
  await expect(
    page.getByRole("heading", { name: "Chào ngày mới", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Luyện từ có/ }).click();
  await expect(page.getByText(/chưa được cấp quyền Micro/i)).toBeVisible();
});

test("Hands-free short-word sensitivity & zero-extra-tap auto-advance loop in real Chromium VAD", async ({
  page,
}) => {
  await installDifficultWordsE2EFixture(page, { micMode: "synthetic-burst" });
  const evaluateRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/practice/evaluate") && req.method() === "POST") {
      evaluateRequests.push(req.url());
    }
  });

  await page.goto(`/reports/difficult-words?childId=${ids.child}`);
  const startedAt = Date.now();
  await page.getByRole("button", { name: "Luyện cùng bé" }).click();
  await expect(
    page.getByRole("heading", { name: "có", exact: true }),
  ).toBeVisible();

  // The book CTA is the only tap. The analyser stops each capture.

  await expect(page.getByText(/Hoàn thành từ này/)).toBeVisible({
    timeout: 10000,
  });
  const word1ElapsedMs = Date.now() - startedAt;

  // Automatically transitions to word #2 ("ngập ngừng") and auto-completes hands-free
  await expect(
    page.getByRole("heading", { name: "ngập ngừng", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect.poll(() => evaluateRequests.length, { timeout: 10000 }).toBe(2);
  await expect(page.getByText(/Hoàn thành từ này/)).toBeVisible({
    timeout: 10000,
  });
  const totalTwoWordMs = Date.now() - startedAt;

  console.info("[PW HANDSFREE TIMING]", { word1ElapsedMs, totalTwoWordMs });
  expect(evaluateRequests).toHaveLength(2);
  expect(word1ElapsedMs).toBeLessThan(6500);
  expect(totalTwoWordMs).toBeLessThan(13000);

  await page.getByRole("button", { name: "Quay về danh sách" }).click();
  await expect(page.getByText(/Đã luyện đúng 2\/2 từ/)).toBeVisible();
  await expect(page.getByText(/2\/2 từ đã đọc đúng \(100%\)/)).toBeVisible();

  await page.reload();
  await expect(page.getByText(/Đã luyện đúng 2\/2 từ/)).toBeVisible();
  await expect(page.getByText(/2\/2 từ đã đọc đúng \(100%\)/)).toBeVisible();
});
