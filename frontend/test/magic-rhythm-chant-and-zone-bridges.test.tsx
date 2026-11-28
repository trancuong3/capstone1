import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { KaraokeLibraryScreen } from "@/components/karaoke/karaoke-library-screen";
import { ParentKaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";
import {
  buildDeterministicChantAttemptUuid,
  getMagicChantSessionStorageKey,
  MagicRhythmChantPanel,
} from "@/components/karaoke/magic-rhythm-chant-panel";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { resetAllApiCachesForTests } from "@/lib/api/read-cache";
import type { SpeechPlayer } from "@/hooks/use-speech-player";
import {
  completeMagicRhythmChantResponseSchema,
  magicRhythmChantSchema,
  type AdaptiveLearningService,
} from "@/lib/api/adaptive-learning-service";
import type { DifficultWordService } from "@/lib/api/difficult-word-service";
import type { KaraokeService } from "@/lib/api/karaoke-service";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import type {
  EntertainmentRecommendationsDTO,
  MagicRhythmChantDTO,
} from "@/types/adaptive-learning";
import type {
  MemoryAttemptSubmitDTO,
  MemorySessionDTO,
  MemoryThemesCatalogDTO,
  SceneSpecDTO,
} from "@/types/memory-game";
import type {
  PictureCatalogDTO,
  PictureSessionDTO,
} from "@/types/picture-description";
import type { DifficultWordPracticeAttemptDTO } from "@/types/reports";

const recorderMock = vi.hoisted(() => ({
  isRecording: false,
  isSpeaking: false,
  audioLevel: 0,
  prepare: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => new Blob(["chant-audio"], { type: "audio/webm" })),
  cancel: vi.fn(),
  getStream: vi.fn(() => null),
  getIsSpeaking: vi.fn(() => false),
  getAudioLevel: vi.fn(() => 0),
  getQuality: vi.fn(() => ({
    status: "SPEECH_DETECTED" as const,
    rms: 0.08,
    peak: 0.32,
    noiseFloor: 0.005,
    speechDurationMs: 620,
    totalDurationMs: 880,
    clippingRatio: 0,
    isSpeaking: false,
  })),
  getSettings: vi.fn(() => ({})),
}));

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => recorderMock,
}));

vi.mock("@/hooks/use-auth-runtime", () => ({
  useAuthRuntime: () => ({
    status: "ready",
    session: {
      access_token: "magic-chant-test-token",
      user: { id: "10000000-0000-4000-8000-000000000001" },
    },
    lastEvent: "INITIAL_SESSION",
    isPasswordRecovery: false,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "magic-chant-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const CHANT_ID = "77000000-0000-4000-8000-000000000001";

function buildSampleChant(
  overrides: Partial<MagicRhythmChantDTO> = {},
): MagicRhythmChantDTO {
  const exp = Math.floor(Date.now() / 1000) + 900;
  return {
    chant_id: CHANT_ID,
    child_id: TEST_CHILD_ID,
    child_grade: 2,
    title_vi: "Đồng Dao Phép Thuật 80 BPM Của Cú Mèo",
    intro_vi: "Vỗ phách gỗ nhịp nhàng rồi đọc vang chữ cần ôn nhé!",
    ephemeral_badge_vi: "✨ Đồng Dao Tức Thì · Hát xong tự xóa",
    dissolve_message_template_vi:
      "Khúc đồng dao đã bay về bầu trời sao — còn {count} chữ giỏi đã ở lại cùng {alias} rồi!",
    bpm: 80,
    source_kind: "WEAK_WORDS",
    provider_tier: "DETERMINISTIC_FALLBACK",
    target_words: ["lung linh", "chăm chỉ"],
    lines: [
      {
        line_number: 1,
        line_text: "Phách gỗ nhịp nhàng, vang chữ lung linh!",
        target_word: "lung linh",
        normalized_word: "lung linh",
        is_weak_target: true,
        phonics_category: "coda_ng_nh",
        phonics_label_vi: "Vần -ng / -nh",
        beat_count: 4,
        clap_hint_vi: "Vỗ 4 nhịp phách gỗ đều tay nhé!",
      },
      {
        line_number: 2,
        line_text: "Sao sáng bầu trời, gọi tên lung linh!",
        target_word: "lung linh",
        normalized_word: "lung linh",
        is_weak_target: true,
        phonics_category: "coda_ng_nh",
        phonics_label_vi: "Vần -ng / -nh",
        beat_count: 4,
        clap_hint_vi: "Giữ nhịp 80 BPM thật vui!",
      },
      {
        line_number: 3,
        line_text: "Cú Mèo mỉm cười, khen chữ chăm chỉ!",
        target_word: "chăm chỉ",
        normalized_word: "chăm chỉ",
        is_weak_target: false,
        phonics_category: "general",
        phonics_label_vi: "Từ tự tin",
        beat_count: 4,
        clap_hint_vi: "Câu kết rộn ràng của bé!",
      },
    ],
    expires_at: new Date(exp * 1000).toISOString(),
    chant_exp: exp,
    chant_sig: "b".repeat(64),
    ...overrides,
  };
}

function buildPracticeAttempt(
  status: "CORRECT" | "INCORRECT" | "NO_CLEAR_AUDIO",
  word = "lung linh",
): DifficultWordPracticeAttemptDTO {
  return {
    attempt_id: "88000000-0000-4000-8000-000000000011",
    child_id: TEST_CHILD_ID,
    normalized_word: word,
    display_text: word,
    attempt_number: 1,
    state: "COMPLETED",
    assessment_status: status,
    recognition_source: "SERVER_STT",
    spoken_transcript: status === "CORRECT" ? word : "lưng linh",
    confidence: 0.95,
    audio_duration_ms: 620,
    assessment_version: 1,
    evidence_word_ids: [],
    started_at: "2026-11-28T08:00:00Z",
    completed_at: "2026-11-28T08:00:01Z",
    feedback_message: null,
    word_progress: {
      normalized_word: word,
      practice_status: status === "CORRECT" ? "COMPLETED" : "IN_PROGRESS",
      practice_attempts_count: 1,
      practice_correct_count: status === "CORRECT" ? 2 : 0,
      practice_incorrect_count: status === "INCORRECT" ? 1 : 0,
      practice_uncertain_count: 0,
      consecutive_correct_count: status === "CORRECT" ? 2 : 0,
      required_consecutive_correct: 2,
      last_practiced_at: "2026-11-28T08:00:01Z",
      last_practice_status: status,
    },
    next_recommended_word: null,
    evidence_count_unchanged: true,
  };
}

function makeMockSpeechPlayer(): SpeechPlayer & {
  readonly playMock: ReturnType<typeof vi.fn>;
  readonly playPhonicsMock: ReturnType<typeof vi.fn>;
} {
  const playMock = vi.fn(async () => {});
  const playPhonicsMock = vi.fn(async () => {});
  return {
    isPlaying: false,
    isPaused: false,
    state: "idle",
    fallbackNotice: null,
    setCacheContext: vi.fn(),
    play: playMock,
    prefetch: vi.fn(async () => {}),
    playPhonicsLesson: playPhonicsMock,
    playWithWordTimings: vi.fn(async () => {}),
    pause: vi.fn(),
    resume: vi.fn(async () => {}),
    stop: vi.fn(),
    playMock,
    playPhonicsMock,
  };
}

describe("Phase 2: Magic Rhythm Chant & Ephemeral Weak-Word Bridges", () => {
  beforeEach(() => {
    resetAllApiCachesForTests();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.localStorage.setItem("viread:entertainment-onboarded:v1", "1");
    recorderMock.start.mockReset();
    recorderMock.start.mockResolvedValue(undefined);
    recorderMock.stop.mockReset();
    recorderMock.stop.mockResolvedValue(
      new Blob(["chant-audio"], { type: "audio/webm" }),
    );
    recorderMock.cancel.mockReset();
  });

  afterEach(() => {
    resetAllApiCachesForTests();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("validates MagicRhythmChant 1:1 Zod contract and deterministic RFC-4122 UUIDs", () => {
    const chant = buildSampleChant();
    const parsed = magicRhythmChantSchema.parse(chant);
    expect(parsed.bpm).toBe(80);
    expect(parsed.lines[0]?.is_weak_target).toBe(true);
    expect(parsed.lines[2]?.is_weak_target).toBe(false);

    const parsedDone = completeMagicRhythmChantResponseSchema.parse({
      chant_id: CHANT_ID,
      child_id: TEST_CHILD_ID,
      recorded_evidence_skills: ["rhythm_timing", "lyric_delivery"],
      already_recorded: false,
      stars_earned: 3,
      ephemeral_cleared: true,
    });
    expect(parsedDone.recorded_evidence_skills).toEqual([
      "rhythm_timing",
      "lyric_delivery",
    ]);

    const id1 = buildDeterministicChantAttemptUuid(CHANT_ID, 1, 1);
    const id2 = buildDeterministicChantAttemptUuid(CHANT_ID, 1, 1);
    expect(id1).toBe(id2);
    expect(z.uuid().safeParse(id1).success).toBe(true);
  });

  it("renders Hub Zone 3 Magic Chant quick-link and unblocks empty KaraokeLibraryScreen via top card & empty-state CTA", async () => {
    const user = userEvent.setup();
    const sampleChant = buildSampleChant();
    const recs: EntertainmentRecommendationsDTO = {
      child_id: TEST_CHILD_ID,
      child_alias: "Bé Sao",
      child_grade: 2,
      mascot_greeting_vi: "Chào Bé Sao!",
      natural_break_reminder_vi: "Nghỉ mắt dịu nhẹ nhé.",
      today_activities_count: 1,
      focus_difficult_words: ["lung linh"],
      primary_recommendation: {
        game_key: "KARAOKE",
        zone_title_vi: "Sân khấu âm nhạc",
        game_title_vi: "Hát vui cùng bé",
        reason_vi: "Ôn nhịp điệu vui.",
        suggested_mode: "FULL_SONG",
        suggested_difficulty: 1,
        target_words: ["lung linh"],
        href: "/karaoke?focus=lung%20linh",
        priority: 1,
      },
      recommendations: [],
    };

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/profiles/children")) {
        return Response.json(
          url.pathname === "/profiles/children" ? [childFixture] : childFixture,
        );
      }
      if (
        url.pathname ===
        `/learning/children/${TEST_CHILD_ID}/magic-rhythm-chant`
      ) {
        return Response.json(sampleChant);
      }
      if (url.pathname.includes("/vocabulary-notebook")) {
        return Response.json({
          child_id: TEST_CHILD_ID,
          total: 0,
          items: [],
          storytelling_words: [],
        });
      }
      if (url.pathname.includes("/daily-five-minute-train")) {
        return new Response("{}", { status: 404 });
      }
      return Response.json(recs);
    });
    vi.stubGlobal("fetch", fetchMock);

    const emptyKaraokeService: KaraokeService = {
      list: vi.fn(async () => ({
        items: [],
        total: 0,
        limit: 12,
        offset: 0,
      })),
      playback: vi.fn(),
    };

    const { unmount } = render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <EntertainmentScreen initialRecommendations={recs} />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    expect(screen.getByTestId("hub-karaoke-magic-chant-cta")).toHaveAttribute(
      "href",
      expect.stringContaining("/karaoke?mode=magic-chant"),
    );
    unmount();

    render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <ParentKaraokeServicesProvider service={emptyKaraokeService}>
            <KaraokeLibraryScreen />
          </ParentKaraokeServicesProvider>
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    expect(
      await screen.findByTestId("karaoke-magic-chant-card"),
    ).toBeInTheDocument();
    const emptyCta = await screen.findByTestId("karaoke-empty-magic-chant-cta");
    await user.click(emptyCta);

    expect(
      await screen.findByTestId("magic-rhythm-chant-panel"),
    ).toBeInTheDocument();
  });

  it("completes 80 BPM beat tapping + voice graduation with SRS hygiene (evaluatePracticeWord once per unique weak word) and purges sessionStorage", async () => {
    const user = userEvent.setup();
    const chant = buildSampleChant();
    const createChantMock = vi.fn<
      AdaptiveLearningService["createMagicRhythmChant"]
    >(async () => chant);
    const completeChantMock = vi.fn<
      AdaptiveLearningService["completeMagicRhythmChant"]
    >(async () => ({
      chant_id: chant.chant_id,
      child_id: TEST_CHILD_ID,
      recorded_evidence_skills: ["rhythm_timing", "lyric_delivery"],
      already_recorded: false,
      stars_earned: 3,
      ephemeral_cleared: true,
    }));
    const evaluatePracticeWordMock = vi.fn<
      NonNullable<DifficultWordService["evaluatePracticeWord"]>
    >(async () => buildPracticeAttempt("CORRECT", "lung linh"));
    const transcribeMock = vi
      .fn()
      .mockResolvedValueOnce({
        text: "lung linh",
        language_code: "vi",
        language_probability: 0.98,
        words: null,
      })
      .mockResolvedValueOnce({
        text: "chăm chỉ",
        language_code: "vi",
        language_probability: 0.98,
        words: null,
      });

    const speechPlayer = makeMockSpeechPlayer();

    render(
      <MagicRhythmChantPanel
        adaptiveService={{
          createMagicRhythmChant: createChantMock,
          completeMagicRhythmChant: completeChantMock,
        }}
        autopilotEnabled={false}
        calmSound
        child={{
          ...childFixture,
          id: TEST_CHILD_ID,
          alias: "Bé Sao",
          grade: 2,
        }}
        difficultWordService={{
          evaluatePracticeWord: evaluatePracticeWordMock,
        }}
        focusWords={["lung linh"]}
        onExitToLibrary={vi.fn()}
        reducedMotion
        speechPlayer={speechPlayer}
        speechService={{ transcribe: transcribeMock }}
      />,
    );

    await screen.findByTestId("magic-rhythm-chant-panel");
    const storageKey = getMagicChantSessionStorageKey(TEST_CHILD_ID);
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();

    // Line 1 ("lung linh", is_weak_target=true): tap 4 beats -> speak -> evaluatePracticeWord called
    for (let b = 0; b < 4; b += 1) {
      await user.click(screen.getByTestId("magic-chant-beat-pad"));
    }
    await user.click(screen.getByTestId("magic-chant-speak-btn"));
    await user.click(await screen.findByTestId("magic-chant-stop-speak-btn"));
    await screen.findByTestId("magic-chant-line-cleared");
    expect(evaluatePracticeWordMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("magic-chant-next-line-btn"));

    // Line 2 ("lung linh" repeated -> uses transcribe, NOT evaluatePracticeWord!)
    for (let b = 0; b < 4; b += 1) {
      await user.click(screen.getByTestId("magic-chant-beat-pad"));
    }
    await user.click(screen.getByTestId("magic-chant-speak-btn"));
    await user.click(await screen.findByTestId("magic-chant-stop-speak-btn"));
    await screen.findByTestId("magic-chant-line-cleared");
    expect(evaluatePracticeWordMock).toHaveBeenCalledTimes(1);
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("magic-chant-next-line-btn"));

    // Line 3 ("chăm chỉ", is_weak_target=false -> uses transcribe!)
    for (let b = 0; b < 4; b += 1) {
      await user.click(screen.getByTestId("magic-chant-beat-pad"));
    }
    await user.click(screen.getByTestId("magic-chant-speak-btn"));
    await user.click(await screen.findByTestId("magic-chant-stop-speak-btn"));
    await screen.findByTestId("magic-chant-line-cleared");
    expect(evaluatePracticeWordMock).toHaveBeenCalledTimes(1);
    expect(transcribeMock).toHaveBeenCalledTimes(2);
    await user.click(screen.getByTestId("magic-chant-next-line-btn"));

    await screen.findByTestId("magic-chant-finale-scroll");
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(completeChantMock).toHaveBeenCalledTimes(1);
    expect(completeChantMock.mock.calls[0]?.[1]).toMatchObject({
      chant_id: CHANT_ID,
      lines_completed: 3,
      total_lines: 3,
      beat_taps_total: 12,
      spoken_correct_count: 3,
      mic_mode: "VOICE",
      stars_earned: 3,
    });

    await user.click(screen.getByTestId("magic-chant-dissolve-btn"));
    expect(
      screen.getByTestId("magic-chant-dissolved-message"),
    ).toHaveTextContent(
      "Khúc đồng dao đã bay về bầu trời sao — còn 2 chữ giỏi đã ở lại cùng Bé Sao rồi!",
    );
  });

  it("handles expired chant_exp purge, 3-strike PhonicsLessonCard + Owl Rescue, NO_MIC_FALLBACK, and exit purge", async () => {
    const user = userEvent.setup();
    const expired = buildSampleChant({
      chant_exp: Math.floor(Date.now() / 1000) - 20,
    });
    const storageKey = getMagicChantSessionStorageKey(TEST_CHILD_ID);
    window.sessionStorage.setItem(storageKey, JSON.stringify(expired));

    const starterChant = buildSampleChant({
      source_kind: "STARTER_FALLBACK",
      lines: buildSampleChant().lines.map((l) => ({
        ...l,
        is_weak_target: false,
      })),
    });
    const createChantMock = vi.fn<
      AdaptiveLearningService["createMagicRhythmChant"]
    >(async () => starterChant);
    const transcribeMock = vi
      .fn()
      .mockResolvedValueOnce({
        text: "",
        language_code: "vi",
        language_probability: 0,
        words: null,
      })
      .mockResolvedValueOnce({
        text: "bông hoa",
        language_code: "vi",
        language_probability: 0.9,
        words: null,
      })
      .mockResolvedValueOnce({
        text: "bông hoa",
        language_code: "vi",
        language_probability: 0.9,
        words: null,
      })
      .mockResolvedValueOnce({
        text: "bông hoa",
        language_code: "vi",
        language_probability: 0.9,
        words: null,
      });

    const speechPlayer = makeMockSpeechPlayer();
    const onExit = vi.fn();

    render(
      <MagicRhythmChantPanel
        adaptiveService={{
          createMagicRhythmChant: createChantMock,
          completeMagicRhythmChant: vi.fn(),
        }}
        autopilotEnabled={false}
        calmSound
        child={{ ...childFixture, id: TEST_CHILD_ID, alias: "Bé An", grade: 1 }}
        onExitToLibrary={onExit}
        reducedMotion
        speechPlayer={speechPlayer}
        speechService={{ transcribe: transcribeMock }}
      />,
    );

    expect(
      await screen.findByTestId("magic-chant-expired-banner"),
    ).toBeInTheDocument();
    expect(createChantMock).toHaveBeenCalledWith(
      TEST_CHILD_ID,
      expect.objectContaining({ refresh: true }),
      expect.anything(),
    );

    for (let b = 0; b < 4; b += 1) {
      await user.click(screen.getByTestId("magic-chant-beat-pad"));
    }

    // 0-strike silence
    await user.click(screen.getByTestId("magic-chant-speak-btn"));
    await user.click(await screen.findByTestId("magic-chant-stop-speak-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("magic-chant-status")).toHaveTextContent(
        /Không mất lượt/i,
      ),
    );

    // Strike 1 -> slow 0.88x model
    await user.click(screen.getByTestId("magic-chant-speak-btn"));
    await user.click(await screen.findByTestId("magic-chant-stop-speak-btn"));
    await waitFor(() =>
      expect(speechPlayer.playMock).toHaveBeenCalledWith(
        "lung linh",
        expect.objectContaining({ ephemeral: true, speedScale: 0.88 }),
      ),
    );

    // Strike 2 -> PhonicsLessonCard
    await user.click(screen.getByTestId("magic-chant-speak-btn"));
    await user.click(await screen.findByTestId("magic-chant-stop-speak-btn"));
    expect(
      await screen.findByTestId("phonics-lesson-card"),
    ).toBeInTheDocument();

    // Strike 3 -> Owl Rescue
    await user.click(screen.getByTestId("magic-chant-speak-btn"));
    await user.click(await screen.findByTestId("magic-chant-stop-speak-btn"));
    await user.click(await screen.findByTestId("magic-chant-owl-rescue-btn"));
    await screen.findByTestId("magic-chant-line-cleared");

    // Exit purges sessionStorage
    await user.click(screen.getByTestId("magic-chant-exit-btn"));
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("bridges empty BOOK_PAGE in PictureDescriptionScreen to SAMPLE with ephemeral focus cards and renders ephemeral Creative focus bar in MemoryGameScreen", async () => {
    const user = userEvent.setup();

    const pictureCatalog: PictureCatalogDTO = {
      samples: [
        {
          sample_key: "sunny_garden",
          title: "Khu vườn nắng sớm",
          theme: "Thiên nhiên",
          description: "Khu vườn tươi đẹp",
          image_url: "/images/picture-description/sunny-garden.jpg",
        },
      ],
      book_pages: [],
    };

    const pictureSession: PictureSessionDTO = {
      session_id: "66000000-0000-4000-8000-000000000001",
      child_id: TEST_CHILD_ID,
      child_grade: 2,
      source_type: "SAMPLE",
      sample_key: "sunny_garden",
      book_id: null,
      book_page_id: null,
      image_url: "/images/picture-description/sunny-garden.jpg",
      scene_title: "Khu vườn nắng sớm",
      status: "ACTIVE",
      best_stars: 0,
      best_score: 0,
      attempts_count: 0,
      target_words: ["lung linh"],
      guide: {
        is_child_safe: true,
        scene_title: "Khu vườn nắng sớm",
        scene_summary: "Khu vườn ngập nắng",
        guiding_questions: ["Bé thấy gì trong tranh?"],
        suggested_vocabulary: [{ word: "bông hoa", hint: "Hoa nở đẹp" }],
        model_sample_sentences: ["Khu vườn có bông hoa đẹp."],
        target_words: ["lung linh"],
      },
      attempts: [],
      created_at: "2026-11-28T08:00:00Z",
      updated_at: "2026-11-28T08:00:00Z",
    };

    const sceneSpec: SceneSpecDTO = {
      schema_version: "v4.0",
      theme_key: "sunny_garden",
      theme_name_vi: "Khu vườn nắng mai",
      child_grade: 2,
      difficulty_level: 1,
      scene_seed: 101,
      canvas_width: 800,
      canvas_height: 500,
      backdrop: {
        theme_key: "sunny_garden",
        sky_top_hex: "#BCE8FF",
        sky_bottom_hex: "#FFF8D9",
        horizon_hex: "#A4E48E",
        ground_hex: "#73C66A",
        accent_hex: "#F7B731",
        mood_vi: "Nắng sớm",
      },
      objects: [
        {
          id: "obj_1",
          sprite_key: "paper_kite",
          name_vi: "diều giấy",
          category_vi: "đồ chơi",
          aliases_vi: ["diều"],
          color_vi: "đỏ",
          color_hex: "#D63031",
          color_stroke_hex: "#8E1B1B",
          color_light_hex: "#FF8A8A",
          shape_cue: "circle",
          count: 1,
          position_zone: "trên trái",
          bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          action_vi: "bay cao",
          hint_tiers: { tier_1: "G1", tier_2: "G2", tier_3: "G3" },
          is_focus_word: false,
        },
      ],
      observation_tips_vi: ["Nhìn kỹ nhé."],
      guided_questions_vi: ["Có mấy chiếc diều?"],
      creative_prompt_vi: "Chuyện gì xảy ra tiếp theo?",
      matched_focus_words: [],
    };

    const memoryThemes: MemoryThemesCatalogDTO = {
      themes: [
        {
          theme_key: "sunny_garden",
          name_vi: "Khu vườn nắng mai",
          description_vi: "Khu vườn đẹp.",
          badge_vi: "Thiên nhiên",
          accent_hex: "#F7B731",
          sprite_count: 5,
          sample_items_vi: ["diều giấy"],
        },
      ],
      timer_options: [
        {
          mode: "UNLIMITED",
          seconds: null,
          label_vi: "Tự chọn",
          recommended_for_vi: "Mọi lớp",
        },
      ],
      grade_recommendations: [
        {
          grade: 2,
          min_objects: 4,
          max_objects: 6,
          recommended_timer: "UNLIMITED",
          recommended_recall_mode: "FREE_RECALL",
          recommended_difficulty: 1,
          note_vi: "Vui học",
        },
      ],
      total_sprites: 5,
    };

    const memorySession: MemorySessionDTO = {
      id: "55000000-0000-4000-8000-000000000001",
      child_id: TEST_CHILD_ID,
      child_grade: 2,
      theme_key: "sunny_garden",
      theme_name_vi: "Khu vườn nắng mai",
      difficulty_level: 1,
      scene_seed: 101,
      timer_mode: "UNLIMITED",
      timer_seconds: null,
      recall_mode: "FREE_RECALL",
      status: "OBSERVING",
      hints_used: 0,
      peek_count: 0,
      best_factual_score: 90,
      best_creative_score: 0,
      stars: 2,
      attempts_count: 1,
      scene_spec: sceneSpec,
      attempts: [],
      created_at: "2026-11-28T08:00:00Z",
      updated_at: "2026-11-28T08:00:00Z",
    };

    let createdPictureBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path.startsWith("/profiles/children")) {
        return Response.json(
          path === "/profiles/children" ? [childFixture] : childFixture,
        );
      }
      if (path === `/learning/children/${TEST_CHILD_ID}/recommendations`) {
        return Response.json({
          child_id: TEST_CHILD_ID,
          child_alias: "Bé Sao",
          child_grade: 2,
          mascot_greeting_vi: "Chào Bé Sao!",
          natural_break_reminder_vi: "Nghỉ mắt nhé.",
          today_activities_count: 0,
          focus_difficult_words: ["lung linh"],
          primary_recommendation: {
            game_key: "PICTURE_DESCRIPTION",
            zone_title_vi: "Kể chuyện",
            game_title_vi: "Kể chuyện qua tranh",
            reason_vi: "Ôn từ.",
            suggested_mode: "STORY",
            suggested_difficulty: 1,
            target_words: ["lung linh"],
            href: "/entertainment/picture-description",
            priority: 1,
          },
          recommendations: [],
        });
      }
      if (path.includes("/vocabulary")) {
        return Response.json({
          child_id: TEST_CHILD_ID,
          total: 0,
          items: [],
          storytelling_words: [],
        });
      }
      if (path === "/games/picture-description/catalog") {
        return Response.json(pictureCatalog);
      }
      if (path === "/games/picture-description/sessions") {
        if (init?.method === "POST") {
          if (init.body instanceof FormData) {
            const rawTargetWords = init.body.get("target_words");
            createdPictureBody = {
              child_id: init.body.get("child_id"),
              source_type: init.body.get("source_type"),
              sample_key: init.body.get("sample_key"),
              target_words:
                typeof rawTargetWords === "string"
                  ? (JSON.parse(rawTargetWords) as string[])
                  : [],
            };
          } else {
            createdPictureBody = JSON.parse(String(init.body)) as Record<
              string,
              unknown
            >;
          }
          return Response.json(pictureSession, { status: 201 });
        }
        return Response.json([]);
      }
      if (path === "/games/memory/themes") {
        return Response.json(memoryThemes);
      }
      if (path === "/games/memory/sessions") {
        if (init?.method === "POST") {
          return Response.json(memorySession, { status: 201 });
        }
        return Response.json([]);
      }
      if (path === `/games/memory/sessions/${memorySession.id}/attempts`) {
        const body = JSON.parse(String(init?.body)) as { stage: string };
        const submitPayload: MemoryAttemptSubmitDTO = {
          attempt: {
            id: "55000000-0000-4000-8000-000000000099",
            session_id: memorySession.id,
            attempt_number: body.stage === "CREATIVE" ? 2 : 1,
            stage: body.stage === "CREATIVE" ? "CREATIVE" : "RECALL",
            input_mode: "TEXT",
            response_text: "Chiếc diều đỏ lung linh bay cao.",
            factual_score: 90,
            creative_score: 95,
            stars: 3,
            ai_provider: "RULE_BASED",
            created_at: "2026-11-28T08:00:05Z",
            evaluation: {
              stage: body.stage === "CREATIVE" ? "CREATIVE" : "RECALL",
              factual_score: 90,
              creative_score: 95,
              stars: 3,
              matched_facts: [],
              missed_facts: [],
              creative_highlights: ["lung linh"],
              story_anchors: ["diều giấy"],
              praise_message_vi: "Giỏi lắm!",
              story_praise_vi: "Câu chuyện lung linh tuyệt vời!",
              next_tip_vi: "Tiếp tục nhé!",
              creative_followup_vi: "Chiếc diều sẽ bay đi đâu?",
              support_summary_vi: null,
              used_focus_words: ["lung linh"],
              ai_provider: "RULE_BASED",
            },
          },
          session: {
            ...memorySession,
            status: body.stage === "CREATIVE" ? "COMPLETED" : "RECALLING",
            best_creative_score: body.stage === "CREATIVE" ? 95 : 0,
            stars: 3,
          },
        };
        return Response.json(submitPayload);
      }
      if (path === "/voice/text-to-speech") {
        return new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    // 1. Zone 1: PictureDescriptionScreen empty BOOK_PAGE -> SAMPLE bridge + ephemeral focus bar
    const { unmount } = render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <PictureDescriptionScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const bookPageTab = await screen.findByRole("tab", {
      name: /Tranh từ sách ViRead/i,
    });
    await user.click(bookPageTab);

    const bridgeBtn = await screen.findByTestId(
      "picture-empty-focus-bridge-cta",
    );
    await user.click(bridgeBtn);

    expect(
      await screen.findByTestId("picture-ephemeral-focus-bar"),
    ).toBeInTheDocument();
    expect(createdPictureBody).toMatchObject({
      source_type: "SAMPLE",
      sample_key: "sunny_garden",
      target_words: ["lung linh"],
    });
    expect(
      screen.getByTestId("picture-ephemeral-word-lung linh"),
    ).toBeInTheDocument();

    // Resetting ("Chọn bức tranh khác") clears the active session cleanly
    await user.click(
      screen.getByRole("button", { name: /Chọn bức tranh khác/i }),
    );
    expect(
      screen.queryByTestId("picture-ephemeral-focus-bar"),
    ).not.toBeInTheDocument();
    unmount();

    // 2. Zone 4: MemoryGameScreen Stage CREATIVE ephemeral challenge word bar + finish cleanup
    render(
      <AppServicesProvider>
        <WithSelectedChild childId={TEST_CHILD_ID}>
          <MemoryGameScreen />
        </WithSelectedChild>
      </AppServicesProvider>,
    );

    const startMemoryBtn = await screen.findByTestId("start-memory-game-btn");
    await user.click(startMemoryBtn);

    const finishObserveBtn = await screen.findByTestId("finish-observe-btn");
    await user.click(finishObserveBtn);

    const recallBox = await screen.findByTestId("recall-textarea");
    await user.type(recallBox, "Có một chiếc diều giấy màu đỏ.");
    await user.click(screen.getByTestId("submit-recall-btn"));

    const goCreativeBtn = await screen.findByTestId("go-creative-stage-btn");
    await user.click(goCreativeBtn);

    expect(
      await screen.findByTestId("memory-ephemeral-focus-bar"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("memory-ephemeral-word-lung linh"),
    ).toBeInTheDocument();

    const creativeBox = screen.getByTestId("creative-textarea");
    await user.type(
      creativeBox,
      "Chiếc diều tỏa sáng lung linh trên bầu trời.",
    );
    await user.click(screen.getByTestId("submit-creative-btn"));

    await screen.findByTestId("summary-stage");
    expect(
      screen.queryByTestId("memory-ephemeral-focus-bar"),
    ).not.toBeInTheDocument();
  });
});
