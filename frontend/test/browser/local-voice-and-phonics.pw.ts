import { expect, test, type Page, type Route } from "@playwright/test";
import { ids, installApiFixture, readyVoiceStatus } from "./real-data-fixture";

function silentWav(seconds: number): string {
  const bytes = Math.max(3200, Math.round(16_000 * 2 * seconds));
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

async function installVoiceAndPhonicsFixture(page: Page) {
  await installApiFixture(page);

  const corsHeaders = {
    "access-control-allow-origin": "http://127.0.0.1:3106",
    "access-control-allow-headers":
      "authorization,content-type,accept,x-voice-policy-mode,x-allow-google-stt-fallback,x-allow-google-tts-fallback,x-voice-region,x-voice-session-id,x-voice-page-id,x-voice-turn-id",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-expose-headers":
      "x-voice-provider,x-resolved-voice-id,x-voice-region,x-voice-model-version,x-voice-fallback",
  };
  const respond = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      headers: corsHeaders,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  const phonicsCalls: Array<{
    steps: Array<{ id: string; spoken_text: string; pause_after_ms: number }>;
    voice_id?: string | null;
    speed?: number;
    provider_mode?: string;
  }> = [];

  const pageWords = ["Hai", "mươi", "mốt", "bông", "hoa."];

  await page.route("http://127.0.0.1:8000/reading/**", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeaders });
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
        started_at: "2026-11-22T00:00:00Z",
        ended_at: null,
        duration_ms: null,
      });
    if (path === base + "/page") {
      return respond(route, {
        page_id: ids.page,
        page_revision_id: ids.revision,
        page_number: 1,
        confidence: 0.96,
        width: 800,
        height: 1000,
        image_url: null,
        text: pageWords.join(" "),
        words: pageWords.map((word, index) => ({
          word_id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          word_index: index,
          text: word,
          bbox: [0.05 + index * 0.18, 0.2, 0.14, 0.06],
          line_index: 0,
        })),
      });
    }
    if (path === base + "/progress")
      return respond(route, {
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
    if (path === base + "/completion-summary")
      return respond(route, {
        duration_minutes: 2,
        pages_explored: 1,
        selected_range_pages: 1,
        practiced_words: 1,
      });
    return respond(route, {}, 404);
  });

  await page.route(
    "http://127.0.0.1:8000/system/difficult-words/**",
    async (route) => {
      if (route.request().method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: corsHeaders });
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/practice/history")) {
        return respond(route, { storage_ready: true, items: [] });
      }
      if (path === `/system/difficult-words/${ids.child}`) {
        return respond(route, [
          {
            normalized_word: "mốt",
            display_text: "mốt",
            difficulty_score: 4,
            omission_count: 0,
            repetition_count: 0,
            long_pause_count: 1,
            read_example_count: 0,
            session_count: 1,
            last_seen_at: "2026-11-22T02:00:00Z",
            evidence_word_ids: [ids.revision],
            mispronunciation_count: 1,
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
                book_id: ids.book,
                book_title: "Bài đọc lớp 1",
                book_author: "ViRead",
                min_grade: 1,
                max_grade: 1,
                session_id: ids.session,
                page_id: ids.page,
                page_revision_id: ids.revision,
                page_number: 1,
                context_phrase: "Hai mươi mốt bông hoa.",
                last_seen_at: "2026-11-22T02:00:00Z",
              },
            ],
          },
        ]);
      }
      return respond(route, {}, 404);
    },
  );

  await page.route("http://127.0.0.1:8000/voice/**", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeaders });
    const path = new URL(route.request().url()).pathname;
    if (path === "/voice/status" && route.request().method() === "GET")
      return respond(route, readyVoiceStatus("local_north_truc_ly"));
    if (path === "/voice/voices") {
      return respond(route, {
        default_voice_id: "local_north_truc_ly",
        local_worker_ready: true,
        google_tts_available: false,
        voices: [
          {
            voice_id: "local_north_truc_ly",
            name: "Cô Trúc Ly",
            provider: "local",
            region: "north",
            region_label: "Miền Bắc",
            gender: "female",
            model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
          },
          {
            voice_id: "local_central_ngoc_tran",
            name: "Cô Ngọc Trân",
            provider: "local",
            region: "central",
            region_label: "Miền Trung",
            gender: "female",
            model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
          },
          {
            voice_id: "local_south_thuc_doan",
            name: "Cô Thục Đoan",
            provider: "local",
            region: "south",
            region_label: "Miền Nam",
            gender: "female",
            model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
          },
        ],
      });
    }
    if (path === "/voice/text-to-speech/phonics") {
      const body = route.request().postDataJSON() as {
        steps: Array<{
          id: string;
          spoken_text: string;
          pause_after_ms: number;
        }>;
        voice_id?: string | null;
        speed?: number;
        provider_mode?: string;
      };
      phonicsCalls.push(body);
      return respond(route, {
        audio_base64: silentWav(1.2),
        content_type: "audio/wav",
        duration_seconds: 1.2,
        step_timings: body.steps.map((s, idx) => ({
          id: s.id,
          index: idx,
          start: idx * 0.2,
          end: (idx + 1) * 0.2,
        })),
        provider: "local",
        resolved_voice_id: body.voice_id ?? "local_north_truc_ly",
        region: "north",
        model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
      });
    }
    if (path === "/voice/text-to-speech/timed") {
      const body = route.request().postDataJSON() as { words: string[] };
      return respond(route, {
        audio_base64: silentWav(1.0),
        content_type: "audio/wav",
        duration_seconds: 1.0,
        words: body.words.map((_w, i) => ({
          index: i,
          start: i * 0.18,
          end: (i + 1) * 0.18,
        })),
        provider: "local",
        resolved_voice_id: "local_north_truc_ly",
        region: "north",
        model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
      });
    }
    if (path === "/voice/text-to-speech") {
      return route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders,
          "x-voice-provider": "local",
          "x-resolved-voice-id": "local_north_truc_ly",
          "x-voice-fallback": "0",
        },
        contentType: "audio/wav",
        body: Buffer.from(silentWav(0.4), "base64"),
      });
    }
    return respond(route, {}, 404);
  });

  return { phonicsCalls };
}

test("ReadingScreen: Bắc · Trung · Nam selector, local-first Google fallback toggles, and in-place 'mốt' phonics", async ({
  page,
}) => {
  const { phonicsCalls } = await installVoiceAndPhonicsFixture(page);

  await page.goto(`/reading/${ids.session}?state=reading`);
  await expect(
    page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
  ).toBeVisible();

  // 1. Verify Bắc · Trung · Nam tabs, speed presets, and separate Google STT/TTS toggles
  await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Giọng đọc mẫu" });
  await expect(dialog).toBeVisible();

  const localOnlyBtn = dialog.getByRole("button", { name: /Chỉ máy này/ });
  const onlineBackupBtn = dialog.getByRole("button", {
    name: /Máy này \+ Google dự phòng/,
  });
  await expect(onlineBackupBtn).toHaveAttribute("aria-pressed", "true");
  await localOnlyBtn.click();
  await expect(localOnlyBtn).toHaveAttribute("aria-pressed", "true");

  await dialog.getByRole("button", { name: "Miền Trung" }).click();
  await expect(
    dialog.getByRole("radio", { name: /Cô Ngọc Trân/ }),
  ).toBeChecked();

  await dialog.getByRole("button", { name: "Chậm" }).click();
  await expect(dialog).toContainText("0,85×");

  await onlineBackupBtn.click();
  await expect(
    dialog.getByLabel(/Dự phòng Google cho Nhận diện giọng nói \(STT\)/),
  ).toBeChecked();
  await expect(
    dialog.getByLabel(/Dự phòng Google cho Đọc mẫu \(TTS\)/),
  ).toBeChecked();

  await localOnlyBtn.click();
  await dialog.getByRole("button", { name: "Đóng hộp thoại" }).click();

  // 2. Select word "mốt" on the book page and click Nghe đánh vần -> in-place PhonicsLessonCard
  await page.getByRole("button", { name: "mốt", exact: true }).click();
  await page.getByRole("button", { name: /Nghe đánh vần/i }).click();

  const card = page.getByTestId("phonics-lesson-card");
  await expect(card).toBeVisible();
  await expect.poll(() => phonicsCalls.length).toBe(1);
  expect(phonicsCalls[0]?.steps.map((s) => s.spoken_text)).toEqual([
    "ô, tờ, ốt.",
    "mờ, ốt.",
    "sắc, mốt.",
    "mốt.",
  ]);
  expect(phonicsCalls[0]?.voice_id).toBe("local_central_ngoc_tran");
  expect(phonicsCalls[0]?.provider_mode ?? "local_only").toBe("local_only");

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("DifficultWordPracticePanel: shares PhonicsLessonCard for 'mốt' in 'Hai mươi mốt bông hoa' context", async ({
  page,
}) => {
  const { phonicsCalls } = await installVoiceAndPhonicsFixture(page);

  await page.goto(
    `/reports/difficult-words?childId=${ids.child}&word=m%E1%BB%91t`,
  );
  const card = page.getByTestId("phonics-lesson-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: /Nghe từ/ })).toBeVisible();
  await expect(
    card.getByRole("button", { name: /Nghe đánh vần/ }),
  ).toBeVisible();

  await card.getByRole("button", { name: /Nghe đánh vần/ }).click();
  await expect.poll(() => phonicsCalls.length).toBe(1);
  expect(phonicsCalls[0]?.steps.map((s) => s.spoken_text)).toEqual([
    "ô, tờ, ốt.",
    "mờ, ốt.",
    "sắc, mốt.",
    "mốt.",
    "hai mươi mốt bông hoa.",
  ]);

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
