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
  options?: {
    readonly micMode?: "synthetic" | "synthetic-burst" | "denied";
    readonly speechMode?: "none" | "scripted";
    readonly evaluateMode?: "always-correct" | "scripted";
    readonly failEvaluateOnce?: boolean;
  },
) {
  await installApiFixture(page);

  const fixtureState = {
    wordsStatus: 200,
    emptyWords: false,
    failEvaluateRemaining: options?.failEvaluateOnce ? 1 : 0,
    ttsRequests: [] as string[],
    evaluateRequests: [] as Array<{
      request_id: string;
      normalized_word: string;
      browser_transcript: string;
      context_phrase: string;
    }>,
  };
  const micMode = options?.micMode ?? "synthetic";
  const speechMode = options?.speechMode ?? "none";
  const evaluateMode = options?.evaluateMode ?? "always-correct";

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
      try {
        const body = route.request().postDataJSON() as { text?: string } | null;
        if (body?.text) fixtureState.ttsRequests.push(body.text);
      } catch {
        // ignore non-JSON body
      }
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
      const extractField = (name: string) =>
        formData
          .match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]+)`))?.[1]
          ?.trim() ?? "";
      const norm = extractField("normalized_word") || "có";
      const requestId = extractField("request_id");
      const browserTranscript = extractField("browser_transcript");
      const contextPhrase = extractField("context_phrase");
      fixtureState.evaluateRequests.push({
        request_id: requestId,
        normalized_word: norm,
        browser_transcript: browserTranscript,
        context_phrase: contextPhrase,
      });

      if (fixtureState.failEvaluateRemaining > 0) {
        fixtureState.failEvaluateRemaining -= 1;
        return jsonRespond(route, { detail: "Offline outage" }, 503);
      }

      const wordEntry = wordListA.find((w) => w.normalized_word === norm);
      const count = (wordEntry?.practice_attempts_count ?? 0) + 1;
      const isCorrect =
        evaluateMode === "always-correct"
          ? true
          : browserTranscript
              .toLocaleLowerCase("vi")
              .includes(norm.toLocaleLowerCase("vi"));
      const assessmentStatus = isCorrect ? "CORRECT" : "INCORRECT";
      if (wordEntry) {
        wordEntry.practice_attempts_count = count;
        if (isCorrect) {
          wordEntry.practice_correct_count =
            (wordEntry.practice_correct_count ?? 0) + 1;
          wordEntry.consecutive_correct_count = 1;
          wordEntry.practice_status = "COMPLETED";
        } else {
          wordEntry.practice_incorrect_count =
            (wordEntry.practice_incorrect_count ?? 0) + 1;
          wordEntry.practice_status = "NEEDS_MORE_PRACTICE";
        }
        wordEntry.last_practiced_at = now;
        wordEntry.last_practice_status = assessmentStatus;
      }
      const attemptId = `77777777-7777-4777-8777-${String(attemptsA.length + 1).padStart(12, "0")}`;
      const attempt = {
        attempt_id: attemptId,
        child_id: ids.child,
        normalized_word: norm,
        display_text: wordEntry?.display_text ?? norm,
        attempt_number: count,
        state: "COMPLETED",
        assessment_status: assessmentStatus,
        recognition_source: "SERVER_STT",
        spoken_transcript: isCorrect
          ? (wordEntry?.display_text ?? norm)
          : browserTranscript || "cò",
        confidence: null,
        audio_duration_ms: 820,
        assessment_version: 1,
        evidence_word_ids: [ids.revision],
        persistence_backend: "READING_EVENT",
        resolved_in_session: isCorrect,
        started_at: now,
        completed_at: now,
        feedback_message: isCorrect
          ? "Chính xác rồi! Con giỏi lắm!"
          : "Con nghe lại rồi đọc theo nhé!",
        word_progress: {
          normalized_word: norm,
          practice_status: isCorrect ? "COMPLETED" : "NEEDS_MORE_PRACTICE",
          practice_attempts_count: count,
          practice_correct_count: wordEntry?.practice_correct_count ?? 0,
          practice_incorrect_count: wordEntry?.practice_incorrect_count ?? 0,
          practice_uncertain_count: 0,
          consecutive_correct_count: isCorrect ? 1 : 0,
          required_consecutive_correct: 1,
          last_practiced_at: now,
          last_practice_status: assessmentStatus,
        },
        next_recommended_word:
          wordListA.find(
            (w) =>
              w.normalized_word !== norm && w.practice_status !== "COMPLETED",
          )?.normalized_word ?? null,
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
    ({
      mode,
      recMode,
    }: {
      mode: "synthetic" | "synthetic-burst" | "denied";
      recMode: "none" | "scripted";
    }) => {
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
      if (recMode === "scripted") {
        const instances: Array<{
          onresult: ((e: unknown) => void) | null;
          onend: (() => void) | null;
          onerror: ((e: unknown) => void) | null;
          say: (t: string, conf?: number) => void;
        }> = [];
        class ScriptedSpeechRecognition {
          continuous = true;
          interimResults = true;
          lang = "vi-VN";
          maxAlternatives = 1;
          onresult: ((e: unknown) => void) | null = null;
          onend: (() => void) | null = null;
          onerror: ((e: unknown) => void) | null = null;
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
          value: ScriptedSpeechRecognition,
        });
        Object.defineProperty(window, "webkitSpeechRecognition", {
          configurable: true,
          value: ScriptedSpeechRecognition,
        });
        Object.assign(window, {
          __dwSpeech: {
            count: () => instances.length,
            say: (transcript: string, confidence = 0.95) => {
              const active = instances[instances.length - 1];
              if (!active) throw new Error("No active DW SpeechRecognition");
              active.say(transcript, confidence);
            },
          },
        });
      } else {
        Object.defineProperty(window, "SpeechRecognition", {
          configurable: true,
          value: undefined,
        });
        Object.defineProperty(window, "webkitSpeechRecognition", {
          configurable: true,
          value: undefined,
        });
      }
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
    { mode: micMode, recMode: speechMode },
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
  await page.getByLabel("Chọn hồ sơ bé để xem dữ liệu").selectOption(childBId);
  await expect(
    page.getByRole("heading", { name: "Từ cần luyện của Bé Bình" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Chuyến đi mùa thu", exact: true }),
  ).toBeVisible();

  // Switch back to Bé An
  await page.getByLabel("Chọn hồ sơ bé để xem dữ liệu").selectOption(ids.child);
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

test("AUTO-DW-01: hands-free ladder (wrong -> context phrase -> 'đánh vần giúp con' -> partial syllable -> full word -> auto-advance & reload persist)", async ({
  page,
}) => {
  await installDifficultWordsE2EFixture(page, {
    micMode: "synthetic",
    speechMode: "scripted",
    evaluateMode: "scripted",
  });

  await page.goto(`/reports/difficult-words?childId=${ids.child}`);
  await page.getByRole("button", { name: "Luyện cùng bé" }).click();
  await expect(
    page.getByRole("heading", { name: "có", exact: true }),
  ).toBeVisible();

  // Attempt 1: wrong pronunciation "cò" -> switches to context phrase "có một bông" on attempt 2
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    (
      window as unknown as { __dwSpeech: { say: (t: string) => void } }
    ).__dwSpeech.say("cò");
  });
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();
  await expect(page.getByText("có một bông", { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // Attempt 2: ask "đánh vần giúp con" -> runs phonics steps & reopens mic
  const countBeforeAttempt2 = await page.evaluate(() =>
    (
      window as unknown as { __dwSpeech: { count: () => number } }
    ).__dwSpeech.count(),
  );
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    (
      window as unknown as { __dwSpeech: { say: (t: string) => void } }
    ).__dwSpeech.say("đánh vần giúp con");
  });
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();
  await expect(page.getByText(/Cô đánh vần từng bước tiếng/i)).toBeVisible({
    timeout: 10_000,
  });

  // Attempt 3: partial syllable ("cờ o") -> SPELLING_STEP_ONLY (must stay on "có")
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (
            window as unknown as { __dwSpeech: { count: () => number } }
          ).__dwSpeech.count(),
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(countBeforeAttempt2);
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible({
    timeout: 10_000,
  });
  const countBeforeAttempt3 = await page.evaluate(() =>
    (
      window as unknown as { __dwSpeech: { count: () => number } }
    ).__dwSpeech.count(),
  );
  await page.waitForTimeout(1700);
  await page.evaluate(() => {
    (
      window as unknown as { __dwSpeech: { say: (t: string) => void } }
    ).__dwSpeech.say("cờ o");
  });
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();
  await expect(
    page.getByText(/Con đánh vần đúng nhịp rồi! Giờ con đọc trọn tiếng/i),
  ).toBeVisible({ timeout: 10_000 });

  // Attempt 4: full word "có" -> CORRECT -> auto-advances to word #2 ("ngập ngừng") with autoStart=true
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (
            window as unknown as { __dwSpeech: { count: () => number } }
          ).__dwSpeech.count(),
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(countBeforeAttempt3);
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible({
    timeout: 10_000,
  });
  const countBeforeAttempt4 = await page.evaluate(() =>
    (
      window as unknown as { __dwSpeech: { count: () => number } }
    ).__dwSpeech.count(),
  );
  await page.waitForTimeout(1700);
  await page.evaluate(() => {
    (
      window as unknown as { __dwSpeech: { say: (t: string) => void } }
    ).__dwSpeech.say("có");
  });
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();

  await expect(
    page.getByRole("heading", { name: "ngập ngừng", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (
            window as unknown as { __dwSpeech: { count: () => number } }
          ).__dwSpeech.count(),
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(countBeforeAttempt4);
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(1700);
  await page.evaluate(() => {
    (
      window as unknown as { __dwSpeech: { say: (t: string) => void } }
    ).__dwSpeech.say("ngập ngừng");
  });
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();
  await expect(page.getByText(/Hoàn thành từ này/)).toBeVisible({
    timeout: 10_000,
  });

  await page.getByRole("button", { name: "Quay về danh sách" }).click();
  await expect(page.getByText(/2\/2 từ đã đọc đúng \(100%\)/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/2\/2 từ đã đọc đúng \(100%\)/)).toBeVisible();
});

test("AUTO-DW-02: max attempts advances, voice 'từ tiếp theo'/'dừng luyện', offline evaluate idempotent request_id, and 100% celebration", async ({
  page,
}) => {
  const { fixtureState } = await installDifficultWordsE2EFixture(page, {
    micMode: "synthetic",
    speechMode: "scripted",
    evaluateMode: "scripted",
    failEvaluateOnce: true,
  });

  await page.goto(`/reports/difficult-words?childId=${ids.child}`);
  await page.getByRole("button", { name: "Luyện cùng bé" }).click();
  await expect(
    page.getByRole("heading", { name: "có", exact: true }),
  ).toBeVisible();

  // 1) Offline/503 on first evaluate -> retry "Lưu lại kết quả" reuses identical request_id!
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    (
      window as unknown as { __dwSpeech: { say: (t: string) => void } }
    ).__dwSpeech.say("cò");
  });
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();
  await expect(
    page.getByRole("button", { name: "Lưu lại kết quả" }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Lưu lại kết quả" }).click();
  expect(fixtureState.evaluateRequests.length).toBeGreaterThanOrEqual(2);
  expect(fixtureState.evaluateRequests[1].request_id).toBe(
    fixtureState.evaluateRequests[0].request_id,
  );

  // 2) Voice "dừng luyện" pauses cleanly; resume & say "từ tiếp theo" -> advances to "ngập ngừng"
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    (
      window as unknown as { __dwSpeech: { say: (t: string) => void } }
    ).__dwSpeech.say("dừng luyện");
  });
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();
  await expect(
    page.getByRole("button", { name: "Tiếp tục luyện" }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Tiếp tục luyện" }).click();
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    (
      window as unknown as { __dwSpeech: { say: (t: string) => void } }
    ).__dwSpeech.say("từ tiếp theo");
  });
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();
  await expect(
    page.getByRole("heading", { name: "ngập ngừng", exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // 3) Complete "ngập ngừng" -> also go back and complete "có" -> 100% completion celebration
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    (
      window as unknown as { __dwSpeech: { say: (t: string) => void } }
    ).__dwSpeech.say("ngập ngừng");
  });
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();
  await expect(page.getByText(/Hoàn thành từ này/)).toBeVisible({
    timeout: 10_000,
  });

  // Advance to remaining incomplete word "có" via CTA -> complete "có" -> triggers 100% celebration!
  await page.getByRole("button", { name: /Sang từ tiếp theo \(có\)/ }).click();
  await expect(
    page.getByRole("heading", { name: "có", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Dừng ghi âm" })).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    (
      window as unknown as { __dwSpeech: { say: (t: string) => void } }
    ).__dwSpeech.say("có");
  });
  await page.getByRole("button", { name: "Dừng ghi âm" }).click();
  await expect(page.getByText(/Hoàn thành từ này/)).toBeVisible({
    timeout: 10_000,
  });
  await expect
    .poll(
      () =>
        fixtureState.ttsRequests.some((t) =>
          /hoàn thành hết tất cả các từ cần luyện/i.test(t),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
});
