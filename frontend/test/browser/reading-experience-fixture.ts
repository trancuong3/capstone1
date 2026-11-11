import { expect, type Page, type Route } from "@playwright/test";
import { ids, installApiFixture } from "./real-data-fixture";

export const readingWords = ["Bé", "mèo", "đọc"].map((text, index) => ({
  word_id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  word_index: index,
  text,
  bbox: [0.1 + index * 0.28, 0.2, 0.25, 0.08],
  line_index: 0,
}));

function wav(): Buffer {
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

export async function installReadingExperience(
  page: Page,
  options: {
    image?: "valid" | "missing" | "broken" | "bad-boxes" | "untrusted-boxes";
    restored?: boolean;
    terminal?: "correct" | "unresolved";
    incorrectCount?: number;
    denyMicrophone?: boolean;
    silentMicrophone?: boolean;
    stt?: string;
    sttTexts?: string[];
    sttUnavailable?: boolean;
    loseEventResponse?: boolean;
  } = {},
) {
  const api = await installApiFixture(page);
  let finished = false;
  let initial = options.restored ?? false;
  const events: Record<string, unknown>[] = [];
  const receivedEvents: Record<string, unknown>[] = [];
  const comparisons: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const base = `/reading/sessions/${ids.session}`;
  const now = "2026-11-11T00:00:00Z";
  let initialAssessment = readingWords.map((word) => ({
    ...word,
    status: word.word_index === 1 ? "MISPRONUNCIATION" : "CORRECT",
  }));
  const failedBefore = options.incorrectCount ?? 0;
  let lostResponse = false;
  let sttCalls = 0;
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
  const session = () => ({
    id: ids.session,
    child_id: ids.child,
    book_id: ids.book,
    state: finished ? "FINISHED" : "PAGE_READY",
    started_at: now,
    ended_at: finished ? now : null,
    duration_ms: finished ? 60000 : null,
  });
  const progress = () => ({
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
    completed_pages: finished ? 1 : 0,
    pages: [
      {
        page_id: ids.page,
        page_revision_id: ids.revision,
        page_number: 1,
        page_order: 0,
        status: finished ? "COMPLETED" : "IN_PROGRESS",
        started_at: now,
        completed_at: finished ? now : null,
      },
    ],
  });
  const corrected = () =>
    options.terminal === "correct" ||
    events.some(
      (event) => event.Status === "CONFIRMED" || event.status === "CONFIRMED",
    );
  const failed = () =>
    failedBefore +
    events.filter(
      (event) => event.Status === "FAILED" || event.status === "FAILED",
    ).length;
  const summary = () => ({
    assessment_version: 1,
    initial_assessment: initialAssessment,
    missing_words: [],
    extra_words: [],
    substitutions: [{ book_word: "mèo", spoken_word: "chó", book_index: 1 }],
    repeated_count: 0,
    repeated_words: [],
    hesitations: [],
    hesitation_seconds: null,
  });
  const report = () => ({
    report_id: ids.oldRevision,
    created_at: now,
    page_id: ids.page,
    page_revision_id: ids.revision,
    transcript: "Bé chó đọc",
    distance: 1,
    alignment: readingWords.map((word) => ({
      book_word: word.text,
      spoken_word: word.word_index === 1 ? "chó" : word.text,
      book_index: word.word_index,
      spoken_index: word.word_index,
      status: word.word_index === 1 ? "SUBSTITUTE" : "MATCH",
    })),
    summary: summary(),
  });
  const assessment = () =>
    initial
      ? {
          first_pass_correct: 2,
          first_pass_incorrect: 1,
          self_corrected_words: corrected() ? 1 : 0,
          unresolved_words: corrected() ? 0 : 1,
          retry_attempts: failedBefore + events.length,
          skipped_after_retry_limit:
            !corrected() && (failed() >= 3 || options.terminal === "unresolved")
              ? 1
              : 0,
          recognition_uncertain: 0,
        }
      : null;
  await page.route("http://127.0.0.1:8000/reading-source.svg", (route) =>
    options.image === "broken"
      ? route.fulfill({ status: 403, headers })
      : route.fulfill({
          headers,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#fff8df"/><path d="M0 500 Q300 300 600 500V800H0Z" fill="#d7e9be"/><g font-size="40" font-family="sans-serif" fill="#172c40"><text x="60" y="208">Bé</text><text x="228" y="208">mèo</text><text x="396" y="208">đọc</text></g></svg>',
        }),
  );
  await page.route("http://127.0.0.1:8000/reading/**", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const path = new URL(route.request().url()).pathname;
    if (path === base) return respond(route, session());
    if (path === base + "/page" || path === `/reading/pages/${ids.page}`)
      return respond(route, {
        page_id: ids.page,
        page_revision_id: ids.revision,
        page_number: 1,
        confidence: null,
        width: 600,
        height: 800,
        image_overlay_safe: options.image !== "untrusted-boxes",
        image_url:
          options.image === "missing"
            ? null
            : "http://127.0.0.1:8000/reading-source.svg",
        text: "Bé mèo đọc",
        words:
          options.image === "bad-boxes"
            ? readingWords.map((word) => ({ ...word, bbox: [-1, 0.2, 1, 1] }))
            : readingWords,
      });
    if (
      path === base + "/progress" ||
      path === base + `/pages/${ids.page}/complete`
    )
      return respond(route, progress());
    if (path === base + "/practice-state")
      return respond(route, {
        session_id: ids.session,
        legacy_evidence_present: false,
        pages: initial
          ? [
              {
                page_id: ids.page,
                page_revision_id: ids.revision,
                page_number: 1,
                transcript: "Bé chó đọc",
                initial_assessment: initialAssessment,
              },
            ]
          : [],
        words: initial
          ? [
              {
                page_id: ids.page,
                page_revision_id: ids.revision,
                word_id: readingWords[1].word_id,
                retry_attempt_count: failedBefore + events.length,
                incorrect_retry_count: failed(),
                resolution_status: corrected()
                  ? "SELF_CORRECTED"
                  : options.terminal || failed() >= 3
                    ? "UNRESOLVED"
                    : "RETRYING",
              },
            ]
          : [],
      });
    if (path === base + "/completion-summary")
      return respond(route, {
        assessment: assessment(),
        duration_minutes: finished ? 1 : null,
        pages_explored: finished ? 1 : 0,
        selected_range_pages: 1,
        practiced_words: initial ? 3 : 0,
        score: initial ? 67 : null,
        correct_words: initial ? ["Bé", "đọc"] : [],
        mispronounced_words: initial ? ["mèo"] : [],
        skipped_words: [],
        transcripts: initial ? ["Bé chó đọc"] : [],
        spoken_words: initial ? ["Bé", "chó", "đọc"] : [],
      });
    if (path === base + "/finish") {
      finished = true;
      return respond(route, session());
    }
    if (path === base + "/reports")
      return respond(route, {
        session_id: ids.session,
        reports: initial ? [report()] : [],
        total: initial ? 1 : 0,
        assessment: assessment(),
      });
    if (path === "/reading/events") {
      const event = route.request().postDataJSON() as Record<string, unknown>;
      receivedEvents.push(event);
      if (
        !events.some((saved) => JSON.stringify(saved) === JSON.stringify(event))
      )
        events.push(event);
      if (options.loseEventResponse && !lostResponse) {
        lostResponse = true;
        return route.abort("failed");
      }
      return respond(
        route,
        { ...event, Id: ids.draftRevision, Confidence: null, CreatedAt: now },
        201,
      );
    }
    if (path === base + "/compare") {
      comparisons.push(
        route.request().postDataJSON() as Record<string, unknown>,
      );
      const submitted = comparisons.at(-1)?.initial_assessment as {
        word_id: string;
        status: string;
      }[];
      initialAssessment = readingWords.map((word) => ({
        ...word,
        status:
          submitted.find((item) => item.word_id === word.word_id)?.status ??
          "UNCERTAIN",
      }));
      initial = true;
      return respond(route, { session_id: ids.session, ...report() });
    }
    if (path.includes("/questions"))
      return respond(route, { session_id: ids.session, questions: [] });
    unexpected.push(path);
    return respond(route, {}, 404);
  });
  await page.route("http://127.0.0.1:8000/voice/**", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const path = new URL(route.request().url()).pathname;
    if (path === "/voice/voices")
      return respond(route, {
        default_voice_id: "fixture_vi",
        voices: [
          {
            voice_id: "fixture_vi",
            name: "Giọng mẫu tổng hợp",
            gender: "female",
          },
        ],
      });
    if (path === "/voice/text-to-speech")
      return route.fulfill({ headers, contentType: "audio/wav", body: wav() });
    if (path === "/voice/speech-to-text") {
      sttCalls++;
      return options.sttUnavailable
        ? respond(
            route,
            { detail: { code: "STT_TEMPORARILY_UNAVAILABLE" } },
            503,
          )
        : respond(route, {
            text: options.sttTexts?.[sttCalls - 1] ?? options.stt ?? "mèo",
            language_code: "vi",
            language_probability: 0.99,
            words: options.sttTexts
              ? (options.sttTexts[sttCalls - 1] ?? "mèo")
                  .split(" ")
                  .map((text, index) => ({
                    text,
                    start: index * 0.2,
                    end: (index + 1) * 0.2,
                    type: "word",
                    logprob: -0.02,
                  }))
              : null,
          });
    }
    unexpected.push(path);
    return respond(route, {}, 404);
  });
  await page.route("http://127.0.0.1:8000/tutor/**", (route) =>
    respond(route, {
      session_id: ids.session,
      total: 0,
      source: null,
      created: false,
    }),
  );
  await page.addInitScript(
    ({ deny, silent }) => {
      const probe = {
        microphoneRequests: 0,
        activeTracks: 0,
        recordingStarts: 0,
        disconnect: () => {},
      };
      Object.assign(window, { __readingProbe: probe });
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
          probe.microphoneRequests++;
          if (deny)
            throw new DOMException(
              "Isolated denied microphone fixture",
              "NotAllowedError",
            );
          const context = new AudioContext();
          await context.resume();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const destination = context.createMediaStreamDestination();
          oscillator.frequency.value = 240;
          gain.gain.value = 0;
          oscillator.connect(gain);
          gain.connect(destination);
          oscillator.start();
          const stream = destination.stream;
          const schedule = () => {
            const start = context.currentTime;
            gain.gain.cancelScheduledValues(start);
            gain.gain.setValueAtTime(0, start);
            if (silent) return;
            for (let n = 0; n < 18; n++)
              gain.gain.setValueAtTime(
                n % 2 ? 0.035 : 0.12,
                start + 0.5 + n * 0.12,
              );
            gain.gain.setValueAtTime(0, start + 2.8);
          };
          Object.assign(stream, { __schedule: schedule });
          for (const track of stream.getTracks()) {
            probe.activeTracks++;
            const stop = track.stop.bind(track);
            let stopped = false;
            track.stop = () => {
              if (!stopped) {
                stopped = true;
                probe.activeTracks--;
                oscillator.stop();
                void context.close();
              }
              stop();
            };
          }
          probe.disconnect = () => {
            for (const track of stream.getTracks()) {
              track.stop();
              track.dispatchEvent(new Event("ended"));
            }
          };
          return stream;
        },
      });
      const NativeRecorder = window.MediaRecorder;
      class SyntheticRecorder extends NativeRecorder {
        start(timeslice?: number) {
          probe.recordingStarts++;
          (
            this.stream as MediaStream & { __schedule?: () => void }
          ).__schedule?.();
          super.start(timeslice);
        }
      }
      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        value: SyntheticRecorder,
      });
    },
    {
      deny: options.denyMicrophone ?? false,
      silent: options.silentMicrophone ?? false,
    },
  );
  await page.goto(`/reading/${ids.session}?state=reading`);
  await expect(
    page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
  ).toBeVisible();
  return {
    api,
    events,
    receivedEvents,
    comparisons,
    unexpected,
    sttCalls: () => sttCalls,
  };
}
