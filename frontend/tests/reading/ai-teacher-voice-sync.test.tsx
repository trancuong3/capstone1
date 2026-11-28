import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import { AiTeacherVoiceSection } from "@/components/dashboard/ai-teacher-voice-section";
import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { SentenceShooterScreen } from "@/components/entertainment/sentence-shooter/sentence-shooter-screen";
import { AppServicesContext } from "@/components/providers/app-services-provider";
import {
  AppStoreContext,
  AppStoreProvider,
} from "@/components/providers/app-store-provider";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import { SessionComplete } from "@/components/reading/session-complete";
import { DifficultWordPracticePanel } from "@/components/reports/difficult-word-practice-panel";
import {
  applyGlobalTeacherVoiceSelection,
  getEffectiveTeacherPersona,
  getEffectiveVoiceId,
  getVoicePolicyPreferences,
  hydrateTeacherVoiceFromChildProfile,
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
  STATIC_LOCAL_VOICES,
} from "@/lib/reading/session-voice-lock";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import {
  mapLocalVoiceToGoogleBackup,
  resetVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import {
  getSpeechPreferences,
  resetSpeechPreferencesCache,
} from "@/lib/reading/speech-preferences";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import type { ChildProfileDTO } from "@/types/child";
import type { MemoryGameService } from "@/lib/api/memory-game-service";
import type { SpeechService } from "@/lib/api/speech-service";
import type { VoiceStudioService } from "@/lib/api/voice-studio-service";

const { pushMock, replaceMock, searchParamsMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  searchParamsMock: new URLSearchParams(),
}));

const {
  listVoicesMock,
  updateSessionVoiceLockMock,
  speechPlayerPlayMock,
  speechPlayerStopMock,
} = vi.hoisted(() => ({
  listVoicesMock: vi.fn(),
  updateSessionVoiceLockMock: vi.fn(),
  speechPlayerPlayMock: vi.fn(),
  speechPlayerStopMock: vi.fn(),
}));

const {
  getDashboardSummaryMock,
  updateVoicePreferencesMock,
  profileServiceMock,
} = vi.hoisted(() => {
  const getDashboardSummary = vi.fn();
  return {
    getDashboardSummaryMock: getDashboardSummary,
    updateVoicePreferencesMock: vi.fn(),
    profileServiceMock: { getDashboardSummary },
  };
});

const { routerMock, speechPlayerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  speechPlayerMock: {
    isPlaying: false,
    isPaused: false,
    state: "idle",
    fallbackNotice: null,
    play: vi.fn(),
    playPhonicsLesson: vi.fn(),
    playWithWordTimings: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    ...routerMock,
    push: pushMock,
    replace: replaceMock,
  }),
  useSearchParams: () => searchParamsMock,
}));

vi.mock("@/hooks/use-profile-service", () => ({
  useProfileService: () => profileServiceMock,
}));

vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => ({
    listVoices: listVoicesMock,
    updateSessionVoiceLock: updateSessionVoiceLockMock,
    synthesizeTimed: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => ({
    ...speechPlayerMock,
    play: speechPlayerPlayMock,
    stop: speechPlayerStopMock,
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: {
          session: {
            access_token: "fake-test-jwt-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: "00000000-0000-4000-8000-000000000001" },
          },
        },
        error: null,
      }),
    },
  }),
}));

const CHILD_1: ChildProfileDTO = {
  id: "11111111-1111-4111-8111-111111111111",
  parent_id: "00000000-0000-4000-8000-000000000001",
  alias: "Bé Dơ",
  grade: 2,
  settings: {},
  created_at: "2026-11-01T00:00:00Z",
};

const CHILD_2: ChildProfileDTO = {
  id: "22222222-2222-4222-8222-222222222222",
  parent_id: "00000000-0000-4000-8000-000000000001",
  alias: "Bé An",
  grade: 3,
  settings: {
    voice_preferences: {
      voice_id: "local_south_thai_son",
      gender: "male",
      region: "south",
      speed: 1.0,
      updated_at: 1_900_000_000_000,
    },
  },
  created_at: "2026-11-02T00:00:00Z",
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetSpeechPreferencesCache();
  resetVoiceLockAndPolicyForTests();
  pushMock.mockReset();
  replaceMock.mockReset();
  speechPlayerPlayMock.mockReset().mockResolvedValue(undefined);
  speechPlayerStopMock.mockReset();
  updateSessionVoiceLockMock.mockReset().mockResolvedValue(undefined);
  listVoicesMock.mockReset().mockResolvedValue({
    voices: [...STATIC_LOCAL_VOICES],
    default_voice_id: "local_north_truc_ly",
    local_worker_ready: true,
    google_tts_available: false,
  });
  updateVoicePreferencesMock
    .mockReset()
    .mockImplementation(async (childId, payload) => ({
      ...(childId === CHILD_2.id ? CHILD_2 : CHILD_1),
      settings: { voice_preferences: payload },
    }));
  getDashboardSummaryMock.mockReset().mockResolvedValue({
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      display_name: "Ba mẹ",
      role: "parent",
      created_at: "2026-11-01T00:00:00Z",
      email: "parent@example.com",
      contact_phone: null,
      pending_email: null,
      email_verified: null,
      contact_info_status: "not_configured",
      children: [],
    },
    children: [CHILD_1, CHILD_2],
    latest_sessions_by_child: {},
    source: "dashboard-summary",
  });
});

afterEach(() => {
  resetVoiceEngineStatus();
  vi.restoreAllMocks();
});

const TEST_AUTH_RUNTIME = {
  session: {
    user: { id: "00000000-0000-4000-8000-000000000001" },
  },
  initialUserId: "00000000-0000-4000-8000-000000000001",
  loading: false,
} as unknown as React.ContextType<typeof AuthRuntimeContext>;

function renderDashboard() {
  const services = {
    childService: {
      list: vi.fn().mockResolvedValue([CHILD_1, CHILD_2]),
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(CHILD_1),
      update: vi.fn(),
      updateVoicePreferences: updateVoicePreferencesMock,
      uploadAvatar: vi.fn(),
      removeAvatar: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as React.ContextType<typeof AppServicesContext>;

  return render(
    <AuthRuntimeContext.Provider value={TEST_AUTH_RUNTIME}>
      <AppServicesContext.Provider value={services}>
        <AppStoreProvider>
          <DashboardScreen />
        </AppStoreProvider>
      </AppServicesContext.Provider>
    </AuthRuntimeContext.Provider>,
  );
}

describe("AI Teacher Voice Selection & 100% System-Wide Synchronization", () => {
  it("renders Cô giáo AI / Thầy giáo AI in the middle of Dashboard, preserves region on gender switch, preserves gender on region switch, previews personalized greeting, and hydrates per child", async () => {
    const user = userEvent.setup();
    const { container } = renderDashboard();

    await screen.findByText("Bé An");
    const voiceSection = await screen.findByTestId("ai-teacher-voice-section");
    expect(voiceSection).toBeInTheDocument();

    // Verify placement in middle of Dashboard: below .family-spread and above .family-tools
    const spread = container.querySelector(".family-spread")!;
    const tools = container.querySelector(".family-tools")!;
    expect(spread).not.toBeNull();
    expect(tools).not.toBeNull();
    expect(
      spread.compareDocumentPosition(voiceSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      voiceSection.compareDocumentPosition(tools) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Switch region to South while Female is active -> Cô Thục Đoan
    await user.click(screen.getByTestId("teacher-region-south"));
    expect(getEffectiveVoiceId()).toBe("local_south_thuc_doan");
    expect(getEffectiveTeacherPersona().gender).toBe("female");

    // Switch Female -> Male: MUST stay in Miền Nam (Thầy Thái Sơn), NOT reset to North!
    await user.click(screen.getByTestId("teacher-card-male"));
    expect(getEffectiveVoiceId()).toBe("local_south_thai_son");
    expect(getEffectiveTeacherPersona().gender).toBe("male");
    expect(getEffectiveTeacherPersona().title).toBe("Thầy giáo AI");

    // Switch region South -> Central while Male is active: MUST stay Male (Thầy Quang Sơn)
    // and auto-play the precomputed COACHING greeting immediately!
    speechPlayerPlayMock.mockClear();
    await user.click(screen.getByTestId("teacher-region-central"));
    expect(getEffectiveVoiceId()).toBe("local_central_quang_son");
    expect(getEffectiveTeacherPersona().gender).toBe("male");
    expect(speechPlayerPlayMock).toHaveBeenCalledWith(
      "Chào con, hôm nay thầy trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.",
      expect.objectContaining({
        coaching: true,
        cacheScope: "COACHING",
        bypassSessionLock: true,
        utteranceKind: "voice_preview",
      }),
    );

    // Clicking the already-selected Thầy giáo AI card replays the male greeting!
    speechPlayerPlayMock.mockClear();
    await user.click(screen.getByTestId("teacher-card-male"));
    expect(speechPlayerPlayMock).toHaveBeenCalledWith(
      "Chào con, hôm nay thầy trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.",
      expect.objectContaining({
        coaching: true,
        cacheScope: "COACHING",
        bypassSessionLock: true,
      }),
    );

    // Preview button also speaks the allowlisted male greeting with COACHING cacheScope
    speechPlayerPlayMock.mockClear();
    await user.click(screen.getByTestId("teacher-voice-preview-btn"));
    expect(speechPlayerPlayMock).toHaveBeenCalledWith(
      "Chào con, hôm nay thầy trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.",
      expect.objectContaining({
        coaching: true,
        cacheScope: "COACHING",
        bypassSessionLock: true,
      }),
    );

    // Select CHILD_2 (who has saved Thầy Thái Sơn · Miền Nam) -> hydrates automatically!
    await user.click(screen.getByText("Bé An"));
    await waitFor(() => {
      expect(getEffectiveVoiceId()).toBe("local_south_thai_son");
      expect(getSpeechPreferences().speed).toBe(1.0);
    });
    expect(screen.getByTestId("teacher-voice-child-badge")).toHaveTextContent(
      "Bé An",
    );

    // Changing voice while CHILD_2 is selected persists to backend PATCH endpoint
    await user.click(screen.getByTestId("teacher-region-north"));
    await waitFor(() => {
      expect(updateVoicePreferencesMock).toHaveBeenCalledWith(
        CHILD_2.id,
        expect.objectContaining({
          voice_id: "local_north_thien_minh",
          gender: "male",
          region: "north",
        }),
      );
    });
  });

  it("resuming an older female-locked session honors a newer male selection from Dashboard", () => {
    // 1. Old session locked with female voice at an earlier timestamp
    window.sessionStorage.setItem(
      "viread.session-voice-lock.v1.old-session-123",
      JSON.stringify({
        sessionId: "old-session-123",
        provider: "local",
        voiceId: "local_north_truc_ly",
        gender: "female",
        region: "north",
        modelVersion: "vieneu-v3-turbo-onnx-fp32-3.8.5",
        speed: 0.9,
        lockedAt: "2026-11-20T08:00:00.000Z",
      }),
    );

    // 2. Parent switches to Thầy giáo AI on Dashboard
    applyGlobalTeacherVoiceSelection({
      voiceId: "local_south_thai_son",
      gender: "male",
      region: "south",
      speed: 0.95,
    });

    // 3. Resuming old session MUST lock to Thầy Thái Sơn (male), NEVER old female voice
    const resumedLock = lockSessionVoice("old-session-123");
    expect(resumedLock.voiceId).toBe("local_south_thai_son");
    expect(resumedLock.gender).toBe("male");
    expect(getEffectiveTeacherPersona().title).toBe("Thầy giáo AI");
  });

  it("ReadingVoiceSettings supports 1-tap Cô/Thầy switch and preserves gender when changing region tabs", async () => {
    const user = userEvent.setup();
    applyGlobalTeacherVoiceSelection({
      voiceId: "local_north_thien_minh",
      gender: "male",
      region: "north",
    });

    render(
      <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Giọng đọc" }));
    expect(
      await screen.findByTestId("voice-modal-teacher-male"),
    ).toHaveAttribute("aria-pressed", "true");

    // Switch region tab to Miền Nam while Male is active -> MUST pick Thầy Thái Sơn (male), NOT Cô Thục Đoan!
    await user.click(screen.getByRole("button", { name: "Miền Nam" }));
    await waitFor(() => {
      expect(getEffectiveVoiceId()).toBe("local_south_thai_son");
      expect(getEffectiveTeacherPersona().gender).toBe("male");
    });

    // 1-tap switch to Cô giáo AI inside modal -> switches globally to Cô Thục Đoan (Miền Nam)
    await user.click(screen.getByTestId("voice-modal-teacher-female"));
    await waitFor(() => {
      expect(getEffectiveVoiceId()).toBe("local_south_thuc_doan");
      expect(getEffectiveTeacherPersona().gender).toBe("female");
    });
  });

  it("MemoryGameScreen NEVER calls window.speechSynthesis.speak directly and adapts prompts + sends teacher_gender='male'", async () => {
    const user = userEvent.setup();
    const rawSpeakSpy = vi.fn();
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak: rawSpeakSpy,
        cancel: vi.fn(),
        getVoices: () => [],
      },
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class FakeUtterance {
        text: string;
        constructor(t: string) {
          this.text = t;
        }
      },
    );

    applyGlobalTeacherVoiceSelection({
      voiceId: "local_north_thien_minh",
      gender: "male",
      region: "north",
    });

    const submitAttemptMock = vi.fn();
    const mockMemoryService: MemoryGameService = {
      getThemes: vi.fn().mockResolvedValue({
        themes: [
          {
            theme_key: "sunny_garden",
            name_vi: "Khu vườn nắng",
            description_vi: "Quan sát khu vườn",
            badge_vi: "Dễ",
            accent_hex: "#087467",
            sprite_count: 4,
            sample_items_vi: ["chú mèo"],
          },
        ],
        timer_options: [
          {
            mode: "30S",
            seconds: 30,
            label_vi: "30 giây",
            recommended_for_vi: "Lớp 2",
          },
        ],
        grade_recommendations: [],
        total_sprites: 4,
      }),
      createSession: vi.fn().mockResolvedValue({
        id: "33333333-3333-4333-8333-333333333333",
        child_id: CHILD_1.id,
        child_grade: 2,
        theme_key: "sunny_garden",
        theme_name_vi: "Khu vườn nắng",
        difficulty_level: 2,
        scene_seed: 42,
        timer_mode: "UNLIMITED",
        timer_seconds: null,
        recall_mode: "FREE_RECALL",
        status: "OBSERVING",
        hints_used: 0,
        peek_count: 0,
        best_factual_score: 0,
        best_creative_score: 0,
        stars: 0,
        attempts_count: 0,
        scene_spec: {
          schema_version: "v4.0",
          theme_key: "sunny_garden",
          theme_name_vi: "Khu vườn nắng",
          child_grade: 2,
          difficulty_level: 2,
          scene_seed: 42,
          canvas_width: 800,
          canvas_height: 500,
          backdrop: {
            theme_key: "sunny_garden",
            sky_top_hex: "#dff6ff",
            sky_bottom_hex: "#f7fbff",
            horizon_hex: "#b2e3d0",
            ground_hex: "#8fd4a9",
            accent_hex: "#087467",
            mood_vi: "Sáng tươi",
          },
          objects: [
            {
              id: "obj-1",
              sprite_key: "cat",
              name_vi: "chú mèo",
              category_vi: "động vật",
              aliases_vi: ["mèo"],
              color_vi: "vàng",
              color_hex: "#f59e0b",
              color_stroke_hex: "#b45309",
              color_light_hex: "#fef3c7",
              shape_cue: "circle",
              count: 1,
              position_zone: "giữa",
              bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
              action_vi: "đang chơi",
              hint_tiers: {
                tier_1: "Cô gợi ý có một bạn mèo.",
                tier_2: "Bạn mèo màu vàng.",
                tier_3: "Có 1 chú mèo màu vàng ở giữa.",
              },
              is_focus_word: false,
            },
          ],
          observation_tips_vi: ["Cô mời bé quan sát kỹ bức tranh nhé!"],
          guided_questions_vi: ["Cô hỏi bé thấy con vật nào?"],
          creative_prompt_vi: "Cô mời bé kể tiếp câu chuyện nhé!",
          matched_focus_words: [],
        },
        attempts: [],
        created_at: "2026-11-22T00:00:00Z",
        updated_at: "2026-11-22T00:00:00Z",
      }),
      listSessions: vi.fn().mockResolvedValue([]),
      getSession: vi.fn(),
      requestHint: vi.fn(),
      recordPeek: vi.fn(),
      submitAttempt: submitAttemptMock,
    };

    const services = {
      childService: {
        list: vi.fn().mockResolvedValue([CHILD_1]),
        get: vi.fn().mockResolvedValue(CHILD_1),
      },
    } as unknown as React.ContextType<typeof AppServicesContext>;

    window.localStorage.setItem("viread.selected-child-id.v1", CHILD_1.id);

    render(
      <AuthRuntimeContext.Provider value={TEST_AUTH_RUNTIME}>
        <AppServicesContext.Provider value={services}>
          <AppStoreContext.Provider
            value={{
              selectedChildId: CHILD_1.id,
              validatedSelectedChild: CHILD_1,
              selectChild: vi.fn(),
              clearSelectedChild: vi.fn(),
              setValidatedSelectedChild: vi.fn(),
            }}
          >
            <MemoryGameScreen service={mockMemoryService} />
          </AppStoreContext.Provider>
        </AppServicesContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    const startBtn = await screen.findByTestId("start-memory-game-btn");
    await user.click(startBtn);

    // Observation tips adapt "Cô mời bé..." -> "Thầy mời bé..."
    expect(
      await screen.findByText(/Thầy mời bé quan sát kỹ bức tranh nhé!/),
    ).toBeInTheDocument();

    // Move to recall stage and trigger spoken prompt via Listen Guide button
    const recallReadyBtn = await screen.findByTestId("finish-observe-btn");
    await user.click(recallReadyBtn);

    const listenBtn = await screen.findByRole("button", {
      name: /Nghe hướng dẫn/i,
    });
    await user.click(listenBtn);

    // MUST route through speechPlayer.play (single source of truth) with bypassSessionLock=true and NEVER raw window.speechSynthesis.speak
    expect(speechPlayerPlayMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        utteranceKind: "game_prompt",
        bypassSessionLock: true,
      }),
    );
    expect(rawSpeakSpy).not.toHaveBeenCalled();

    // Even when speechPlayer.play rejects (e.g. 503 under local_only), MemoryGameScreen MUST NOT call raw window.speechSynthesis.speak directly
    speechPlayerPlayMock.mockRejectedValueOnce(
      new Error("503 LOCAL_TTS_UNAVAILABLE"),
    );
    await user.click(listenBtn);
    expect(rawSpeakSpy).not.toHaveBeenCalled();

    // Submit recall text -> verify teacher_gender: "male" is sent
    submitAttemptMock.mockResolvedValue({
      attempt: {
        id: "44444444-4444-4444-8444-444444444444",
        session_id: "33333333-3333-4333-8333-333333333333",
        attempt_number: 1,
        stage: "RECALL",
        input_mode: "TEXT",
        response_text: "Có một chú mèo vàng ở giữa",
        factual_score: 90,
        creative_score: 0,
        stars: 3,
        evaluation: {
          stage: "RECALL",
          factual_score: 90,
          creative_score: 0,
          stars: 3,
          matched_facts: [],
          missed_facts: [],
          creative_highlights: [],
          story_anchors: [],
          praise_message_vi: "Cô khen bé có trí nhớ rất tốt!",
          story_praise_vi: "",
          next_tip_vi: "",
          creative_followup_vi: "Cô mời bé kể tiếp câu chuyện nhé!",
          support_summary_vi: "Cô ghi nhận bé tự nhớ giỏi!",
          used_focus_words: [],
          ai_provider: "deterministic-v4",
        },
        ai_provider: "deterministic-v4",
        created_at: "2026-11-22T00:01:00Z",
      },
      session: await mockMemoryService.createSession({ child_id: CHILD_1.id }),
    });

    const textarea = await screen.findByTestId("recall-textarea");
    await user.type(textarea, "Có một chú mèo vàng ở giữa");
    const submitBtn = screen.getByTestId("submit-recall-btn");
    await user.click(submitBtn);

    await waitFor(() => {
      expect(submitAttemptMock).toHaveBeenCalledWith(
        "33333333-3333-4333-8333-333333333333",
        expect.objectContaining({
          stage: "RECALL",
          teacher_gender: "male",
        }),
      );
    });
    // UI praise, creative_followup_vi, support_summary_vi, and creative_prompt_vi all adapt "Cô" -> "Thầy"
    expect(
      await screen.findByText(/Thầy khen bé có trí nhớ rất tốt!/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Thầy mời bé kể tiếp câu chuyện nhé!/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Thầy ghi nhận bé tự nhớ giỏi!/),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId("go-creative-stage-btn"));
    expect(
      await screen.findByText(/Thầy mời bé kể tiếp câu chuyện nhé!/),
    ).toBeInTheDocument();
  });

  it("TtsPlayback skips female precomputed catalog MP3 when Male AI Teacher is selected and synthesizes exact male voice", async () => {
    applyGlobalTeacherVoiceSelection({
      voiceId: "local_north_thien_minh",
      gender: "male",
      region: "north",
    });

    const synthesizeMock = vi
      .fn()
      .mockResolvedValue(
        new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mpeg" }),
      );
    const fakeSpeechService = {
      synthesize: synthesizeMock,
      synthesizePhonics: vi.fn(),
      transcribe: vi.fn(),
    } as unknown as SpeechService;
    const fakeVoiceStudio = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn(),
    } as unknown as VoiceStudioService;

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Minimal Audio mock so TtsPlayback completes cleanly in jsdom
    class MockAudio {
      src = "";
      preload = "";
      playbackRate = 1;
      duration = 0.5;
      currentTime = 0;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener(evt: string, cb: () => void) {
        if (evt === "ended") this.onended = cb;
      }
      removeEventListener() {}
      pause() {}
      play() {
        queueMicrotask(() => this.onended?.());
        return Promise.resolve();
      }
    }
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:mock-male-tts"),
        revokeObjectURL: vi.fn(),
      }),
    );

    const playback = new TtsPlayback(fakeSpeechService, fakeVoiceStudio);
    await playback.play("Con mèo trèo cây cau", {
      precomputedAudioUrl: "https://cdn.example.test/female-truc-ly.mp3",
      precomputedVoiceId: "local_north_truc_ly",
    });

    // MUST NOT fetch the female precomputed MP3!
    expect(fetchSpy).not.toHaveBeenCalledWith(
      "https://cdn.example.test/female-truc-ly.mp3",
      expect.anything(),
    );
    // MUST call synthesize with exact Male voiceId!
    expect(synthesizeMock).toHaveBeenCalledWith(
      "Con mèo trèo cây cau",
      expect.objectContaining({
        voiceId: "local_north_thien_minh",
      }),
    );
  });

  it("adaptTextToTeacherPersona preserves quoted book words and non-teacher phrases while adapting teacher pronouns", () => {
    expect(
      adaptTextToTeacherPersona(
        'Con nghe cô đọc từ “cô giáo” và "cô" nhé.',
        "male",
      ),
    ).toBe('Con nghe thầy đọc từ “cô giáo” và "cô" nhé.');

    expect(
      adaptTextToTeacherPersona(
        "Cô khen bé đã kể về cô bé và cô tiên trong bức tranh!",
        "male",
      ),
    ).toBe("Thầy khen bé đã kể về cô bé và cô tiên trong bức tranh!");
  });

  it("restores Child A's saved Male voice after switching to Child B (changing to Female) and back to Child A, and maps Google fallback to Male", () => {
    hydrateTeacherVoiceFromChildProfile(CHILD_2);
    expect(getEffectiveVoiceId()).toBe("local_south_thai_son");
    expect(mapLocalVoiceToGoogleBackup(getEffectiveVoiceId(), "south")).toBe(
      "google_vi_vn_wavenet_b",
    );

    // Switch to CHILD_1 (no saved preferences) and change voice to Female
    hydrateTeacherVoiceFromChildProfile(CHILD_1);
    applyGlobalTeacherVoiceSelection({
      voiceId: "local_north_truc_ly",
      gender: "female",
      region: "north",
      childId: CHILD_1.id,
    });
    expect(getEffectiveVoiceId()).toBe("local_north_truc_ly");

    // Switch back to CHILD_2 -> MUST restore CHILD_2's saved Male voice!
    hydrateTeacherVoiceFromChildProfile(CHILD_2);
    expect(getEffectiveVoiceId()).toBe("local_south_thai_son");
    expect(getEffectiveTeacherPersona().gender).toBe("male");
  });

  it("picture-description timeout error adapts to Thầy giáo AI when male persona is active", async () => {
    const apiClient = await import("@/lib/api/api-client");
    const { createPictureDescriptionService } =
      await import("@/lib/api/picture-description-service");
    applyGlobalTeacherVoiceSelection({
      voiceId: "local_north_thien_minh",
      gender: "male",
      region: "north",
    });

    vi.useFakeTimers();
    const requestApiSpy = vi
      .spyOn(apiClient, "requestApi")
      .mockImplementation(() => new Promise(() => {}));
    try {
      const service = createPictureDescriptionService();
      const pending = service.getCatalog(CHILD_1.id).catch((err) => err);
      await vi.advanceTimersByTimeAsync(21_000);
      const error = (await pending) as Error & { status?: number };
      expect(error).toBeInstanceOf(Error);
      expect(error.status).toBe(504);
      expect(error.message).toContain("Thầy giáo AI");
      expect(error.message).not.toContain("Cô giáo AI");
    } finally {
      requestApiSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("resets sibling voice leak when switching to a child without saved voice_preferences, and preserves newer local selection across reload", async () => {
    const { resetSpeechPreferencesCache } =
      await import("@/lib/reading/speech-preferences");
    // CHILD_2 has saved male south voice
    hydrateTeacherVoiceFromChildProfile(CHILD_2);
    expect(getEffectiveVoiceId()).toBe("local_south_thai_son");
    expect(getEffectiveTeacherPersona().gender).toBe("male");

    // Switching directly to CHILD_1 (empty settings: {}) MUST NOT leak CHILD_2's male voice!
    hydrateTeacherVoiceFromChildProfile(CHILD_1);
    expect(getEffectiveVoiceId()).toBe("local_north_truc_ly");
    expect(getEffectiveTeacherPersona().gender).toBe("female");

    // Simulate a newer local choice for CHILD_2 followed by a page reload (in-memory cache cleared)
    applyGlobalTeacherVoiceSelection({
      voiceId: "local_north_thien_minh",
      gender: "male",
      region: "north",
      updatedAt: 9_999_999_999_999,
      childId: CHILD_2.id,
    });
    resetSpeechPreferencesCache();

    // Hydrating stale server snapshot (updated_at: 1700000000000) must keep newer local choice!
    hydrateTeacherVoiceFromChildProfile(CHILD_2);
    expect(getEffectiveVoiceId()).toBe("local_north_thien_minh");
  });

  it("fetchVoiceEngineHealth preserves elevenlabs readiness and updateVoicePreferences clears user query cache", async () => {
    const { fetchVoiceEngineHealth, resetVoiceEngineStatus } =
      await import("@/lib/reading/voice-engine-status");
    const { createChildService } = await import("@/lib/api/child-service");
    const { readUserCacheWithStale, writeUserCache } =
      await import("@/lib/cache/user-query-cache");

    resetVoiceEngineStatus();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://127.0.0.1:8000");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/voice/status")) {
          return new Response(
            JSON.stringify({
              default_mode: "local_only",
              default_voice_id: "local_north_truc_ly",
              local: {
                configured: false,
                available: false,
                stt_ready: false,
                tts_ready: false,
                error_code: "LOCAL_VOICE_UNCONFIGURED",
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
                model_id: "eleven_flash_v2_5",
                voice_id: "cgSgspJ2msm6clMCkdW9",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(CHILD_2), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    try {
      const health = await fetchVoiceEngineHealth();
      expect(health?.elevenlabs?.configured).toBe(true);
      expect(health?.elevenlabs?.tts_configured).toBe(true);
      expect(health?.elevenlabs?.male_tts_configured).toBe(false);

      writeUserCache("parent-1", "children", [CHILD_1]);
      expect(readUserCacheWithStale("parent-1", "children")).not.toBeNull();
      await createChildService().updateVoicePreferences?.(CHILD_2.id, {
        voice_id: "local_south_thai_son",
        gender: "male",
        region: "south",
        speed: 1.0,
      });
      expect(readUserCacheWithStale("parent-1", "children")).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      resetVoiceEngineStatus();
      vi.unstubAllEnvs();
    }
  });

  it("does not abort active audio playback when background child hydration resolves with the already-playing voice", async () => {
    const { subscribeSpeechPreferences } =
      await import("@/lib/reading/speech-preferences");
    const { subscribeVoicePolicyPreferences } =
      await import("@/lib/reading/session-voice-lock");

    // Initial selection is default female north (local_north_truc_ly, speed 0.9)
    const prefsListener = vi.fn();
    const policyListener = vi.fn();
    const unsubPrefs = subscribeSpeechPreferences(prefsListener);
    const unsubPolicy = subscribeVoicePolicyPreferences(policyListener);

    try {
      // Background DashboardSummary arrives with same voice (and even without updated_at)
      hydrateTeacherVoiceFromChildProfile({
        ...CHILD_1,
        settings: {
          voice_preferences: {
            voice_id: "local_north_truc_ly",
            gender: "female",
            region: "north",
            speed: 0.9,
          },
        },
      });
      // Must NOT fire preference/policy listeners (which trigger TtsPlayback.stop() mid-greeting)!
      expect(prefsListener).not.toHaveBeenCalled();
      expect(policyListener).not.toHaveBeenCalled();
    } finally {
      unsubPrefs();
      unsubPolicy();
    }
  });

  it("ignores out-of-order PATCH responses on rapid persona clicks and keeps newer local selection even on force re-hydration", async () => {
    const user = userEvent.setup();
    let resolveFirstPatch!: (value: ChildProfileDTO) => void;
    let callCount = 0;
    const updateVoicePrefsMock = vi.fn().mockImplementation((_id, payload) => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<ChildProfileDTO>((resolve) => {
          resolveFirstPatch = () =>
            resolve({
              ...CHILD_1,
              settings: { voice_preferences: payload },
            });
        });
      }
      return Promise.resolve({
        ...CHILD_1,
        settings: { voice_preferences: payload },
      });
    });

    const onUpdated = vi.fn();
    const services = {
      childService: {
        list: vi.fn().mockResolvedValue([CHILD_1]),
        get: vi.fn().mockResolvedValue(CHILD_1),
        updateVoicePreferences: updateVoicePrefsMock,
      },
    } as unknown as React.ContextType<typeof AppServicesContext>;

    render(
      <AppServicesContext.Provider value={services}>
        <AiTeacherVoiceSection
          selectedChild={CHILD_1}
          onChildSettingsUpdated={onUpdated}
        />
      </AppServicesContext.Provider>,
    );

    // Click #1 (Thầy giáo AI) -> slow in-flight PATCH #1
    await user.click(screen.getByTestId("teacher-card-male"));
    // Click #2 (Cô giáo AI) -> fast PATCH #2
    await user.click(screen.getByTestId("teacher-card-female"));

    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(getEffectiveTeacherPersona().gender).toBe("female");

    // Late resolution of stale PATCH #1 (male) MUST be ignored!
    resolveFirstPatch(CHILD_1);
    await new Promise((r) => setTimeout(r, 20));
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(getEffectiveTeacherPersona().gender).toBe("female");

    // Even `{ force: true }` re-hydration with an older server snapshot for the SAME child must NOT revert!
    hydrateTeacherVoiceFromChildProfile(
      {
        ...CHILD_1,
        settings: {
          voice_preferences: {
            voice_id: "local_north_thien_minh",
            gender: "male",
            region: "north",
            speed: 0.9,
            updated_at: 1_000,
          },
        },
      },
      { force: true },
    );
    expect(getEffectiveTeacherPersona().gender).toBe("female");
  });

  it("preserves explicit male persona for ElevenLabs/custom voice IDs, isolates sibling speed, and clears voice state on actor switch", async () => {
    const {
      getSpeechPreferences,
      resetSpeechPreferencesCache,
      setSpeechPreferences,
    } = await import("@/lib/reading/speech-preferences");
    const {
      getActiveSessionVoiceLock,
      lockSessionVoice,
      resetTeacherVoiceForActorSwitch,
    } = await import("@/lib/reading/session-voice-lock");

    // Opaque ElevenLabs male voice ID (does not contain "thien_minh"/"_male")
    applyGlobalTeacherVoiceSelection({
      voiceId: "JBFqnCBsd6RMkjVDRZzb",
      gender: "male",
      region: "north",
      speed: 1.15,
      childId: CHILD_1.id,
    });
    expect(getEffectiveTeacherPersona().gender).toBe("male");
    expect(getEffectiveTeacherPersona().title).toBe("Thầy giáo AI");

    // Speed-only update and reload must keep male persona
    setSpeechPreferences({ speed: 1.2 });
    resetSpeechPreferencesCache();
    expect(getEffectiveTeacherPersona().gender).toBe("male");
    expect(getSpeechPreferences().speed).toBe(1.2);

    // Switching to sibling CHILD_2 whose legacy voice_preferences omits `speed` must NOT leak 1.2!
    hydrateTeacherVoiceFromChildProfile({
      ...CHILD_2,
      settings: {
        voice_preferences: {
          voice_id: "local_north_truc_ly",
          gender: "female",
          region: "north",
        },
      },
    });
    expect(getSpeechPreferences().speed).toBe(0.9);
    expect(getEffectiveTeacherPersona().gender).toBe("female");

    // Lock a session and then simulate account sign-out / actor switch
    lockSessionVoice("session-actor-test", {
      voiceId: "local_south_thai_son",
      speed: 1.1,
    });
    expect(getActiveSessionVoiceLock()?.voiceId).toBe("local_south_thai_son");

    resetTeacherVoiceForActorSwitch();
    expect(getSpeechPreferences()).toEqual({ voiceId: null, speed: 0.9 });
    expect(getEffectiveTeacherPersona().gender).toBe("female");
    expect(getActiveSessionVoiceLock()).toBeNull();
  });

  it("Dashboard AiTeacherVoiceSection surfaces local_worker_ready=false hint, toggles Chỉ máy này vs Máy này + Dự phòng trực tuyến, and resets Google voice safely when returning to local_only", async () => {
    const user = userEvent.setup();
    listVoicesMock.mockResolvedValue({
      voices: [...STATIC_LOCAL_VOICES],
      default_voice_id: "local_north_truc_ly",
      local_worker_ready: false,
      google_tts_available: false,
    });

    const services = {
      childService: {
        list: vi.fn().mockResolvedValue([CHILD_1]),
        get: vi.fn().mockResolvedValue(CHILD_1),
        updateVoicePreferences: updateVoicePreferencesMock,
      },
    } as unknown as React.ContextType<typeof AppServicesContext>;

    render(
      <AppServicesContext.Provider value={services}>
        <AiTeacherVoiceSection selectedChild={CHILD_1} />
      </AppServicesContext.Provider>,
    );

    // Default mode is local_only ("Chỉ máy này") and offline worker hint is shown
    expect(screen.getByTestId("teacher-policy-local-only")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      await screen.findByTestId("teacher-voice-worker-offline-hint"),
    ).toBeInTheDocument();

    // Enable "Máy này + Dự phòng trực tuyến" directly from /dashboard
    listVoicesMock.mockResolvedValue({
      voices: [
        ...STATIC_LOCAL_VOICES,
        {
          voice_id: "google_vi_vn_neural2_d",
          name: "Google Nam Miền Bắc",
          provider: "google",
          region: "north",
          region_label: "Miền Bắc",
          model_version: "google-cloud-tts-v1",
          gender: "male",
        },
      ],
      default_voice_id: "local_north_truc_ly",
      local_worker_ready: false,
      google_tts_available: true,
    });
    await user.click(screen.getByTestId("teacher-policy-online-backup"));

    expect(getVoicePolicyPreferences()).toMatchObject({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
      allowGoogleTtsFallback: true,
    });
    expect(screen.getByTestId("teacher-policy-online-backup")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.queryByTestId("teacher-voice-worker-offline-hint"),
    ).not.toBeInTheDocument();

    // Select male persona then pick Google male backup voice, then switch back to "Chỉ máy này"
    await user.click(screen.getByTestId("teacher-card-male"));
    const googleVoiceBtn = await screen.findByTestId(
      "teacher-voice-option-google_vi_vn_neural2_d",
    );
    await user.click(googleVoiceBtn);
    expect(getEffectiveVoiceId()).toBe("google_vi_vn_neural2_d");

    await user.click(screen.getByTestId("teacher-policy-local-only"));
    expect(getVoicePolicyPreferences()).toMatchObject({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
      allowGoogleTtsFallback: false,
    });
    // Must reset cleanly to local voice of the SAME male gender & north region (never strand google_*)
    expect(getEffectiveVoiceId()).toBe("local_north_thien_minh");
    expect(getEffectiveTeacherPersona().gender).toBe("male");
  });

  it("SessionComplete speaks precomputed COACHING completion prompt with bypassSessionLock=true when difficult words exist, and stays silent when none exist", async () => {
    vi.stubGlobal("AudioContext", class FakeAudioCtx {});

    const { unmount } = render(
      <SessionComplete
        booksHref="/books"
        bookId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        child={CHILD_1}
        sessionId="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        summary={{
          duration_minutes: 4,
          pages_explored: 2,
          practiced_words: 5,
          correct_words: ["con", "mèo"],
          mispronounced_words: [],
          skipped_words: [],
        }}
      />,
    );
    expect(speechPlayerPlayMock).not.toHaveBeenCalled();
    unmount();

    render(
      <SessionComplete
        booksHref="/books"
        bookId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        child={CHILD_1}
        sessionId="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        summary={{
          duration_minutes: 4,
          pages_explored: 2,
          practiced_words: 5,
          correct_words: ["con"],
          mispronounced_words: ["mốt"],
          skipped_words: [],
        }}
      />,
    );

    await waitFor(() => {
      expect(speechPlayerPlayMock).toHaveBeenCalledWith(
        "Hoan hô con đã đọc hết bài! Con có muốn đọc lại mấy từ vừa vấp không?",
        {
          coaching: true,
          cacheScope: "COACHING",
          bypassSessionLock: true,
        },
      );
    });
  });

  it("SentenceShooterScreen passes { bookId, cacheScope: 'CATALOG', bypassSessionLock: true, utteranceKind: 'game_sample' } on in-round and result sentence playback", async () => {
    const user = userEvent.setup();
    const bookId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const roundId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const tok1 = "12121212-1212-4212-8212-121212121212";

    const shooterService = {
      listBooks: vi.fn().mockResolvedValue([
        {
          id: bookId,
          name: "Hai mươi mốt bông hoa",
          title: "Hai mươi mốt bông hoa",
          author: "ViRead",
          min_grade: 1,
          max_grade: 3,
          available_rounds: 3,
        },
      ]),
      createSession: vi.fn().mockResolvedValue({
        session_id: sessionId,
        book: {
          id: bookId,
          name: "Hai mươi mốt bông hoa",
          title: "Hai mươi mốt bông hoa",
          author: "ViRead",
          min_grade: 1,
          max_grade: 3,
          available_rounds: 3,
        },
        difficulty: "easy",
        total_rounds: 3,
        completed_rounds: 0,
        total_stars: 0,
        round: {
          round_id: roundId,
          round_number: 1,
          token_count: 1,
          tokens: [{ id: tok1, text: "Hoa." }],
        },
      }),
      shoot: vi
        .fn()
        .mockResolvedValueOnce({
          is_correct: true,
          correct_count: 1,
          token_count: 1,
          mistakes_total: 0,
          completed_rounds: 1,
          total_stars: 3,
          round_completed: true,
          session_completed: false,
          next_expected_position: 1,
          stars_awarded: 3,
          completed_sentence: "Hoa.",
          next_round: {
            round_id: "abababab-abab-4bab-8bab-abababababab",
            round_number: 2,
            token_count: 1,
            tokens: [{ id: tok1, text: "Hoa." }],
          },
          message: "Giỏi lắm!",
        })
        .mockResolvedValueOnce({
          is_correct: true,
          correct_count: 1,
          token_count: 1,
          mistakes_total: 0,
          completed_rounds: 3,
          total_stars: 9,
          round_completed: true,
          session_completed: true,
          next_expected_position: 1,
          stars_awarded: 3,
          completed_sentence: "Hoa.",
          next_round: null,
          message: "Hoàn thành!",
        }),
      nextRound: vi.fn().mockResolvedValue({
        session_id: sessionId,
        completed_rounds: 1,
        total_rounds: 3,
        total_stars: 3,
        round: {
          round_id: "abababab-abab-4bab-8bab-abababababab",
          round_number: 2,
          token_count: 1,
          tokens: [{ id: tok1, text: "Hoa." }],
        },
      }),
      hint: vi.fn(),
      result: vi.fn().mockResolvedValue({
        session_id: sessionId,
        book: {
          id: bookId,
          name: "Hai mươi mốt bông hoa",
          title: "Hai mươi mốt bông hoa",
          author: "ViRead",
          min_grade: 1,
          max_grade: 3,
          available_rounds: 3,
        },
        difficulty: "easy",
        status: "COMPLETED",
        total_rounds: 3,
        completed_rounds: 3,
        correct_count: 2,
        mistakes_total: 0,
        hint_count: 0,
        total_stars: 9,
        duration_seconds: 15,
        started_at: "2026-11-28T00:00:00Z",
        completed_at: "2026-11-28T00:00:15Z",
      }),
      abandon: vi.fn(),
    };

    const services = {
      childService: {
        list: vi.fn().mockResolvedValue([CHILD_1]),
        get: vi.fn().mockResolvedValue(CHILD_1),
      },
      sentenceShooterService: shooterService,
    } as unknown as React.ContextType<typeof AppServicesContext>;

    window.localStorage.setItem("viread.selected-child-id.v1", CHILD_1.id);

    render(
      <AuthRuntimeContext.Provider value={TEST_AUTH_RUNTIME}>
        <AppServicesContext.Provider value={services}>
          <AppStoreContext.Provider
            value={{
              selectedChildId: CHILD_1.id,
              validatedSelectedChild: CHILD_1,
              selectChild: vi.fn(),
              clearSelectedChild: vi.fn(),
              setValidatedSelectedChild: vi.fn(),
            }}
          >
            <SentenceShooterScreen initialBookId={bookId} />
          </AppStoreContext.Provider>
        </AppServicesContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    const startBtn = await screen.findByRole("button", {
      name: /Bắt đầu chơi/i,
    });
    await waitFor(() => expect(startBtn).toBeEnabled());
    await user.click(startBtn);

    // Complete Round 1 -> click "Nghe lại câu hoàn chỉnh"
    const tokenBtn = await screen.findByRole("button", { name: "Hoa." });
    await user.click(tokenBtn);
    const replayRoundBtn = await screen.findByRole("button", {
      name: /Nghe lại câu hoàn chỉnh/i,
    });
    speechPlayerPlayMock.mockClear();
    await user.click(replayRoundBtn);
    expect(speechPlayerPlayMock).toHaveBeenCalledWith("Hoa.", {
      bookId,
      cacheScope: "CATALOG",
      bypassSessionLock: true,
      utteranceKind: "game_sample",
    });

    // Advance & complete game -> click "Đọc câu mẫu" on Result screen
    await user.click(screen.getByRole("button", { name: /Câu tiếp theo/i }));
    await user.click(await screen.findByRole("button", { name: "Hoa." }));
    const resultReadBtn = await screen.findByRole("button", {
      name: /Đọc câu mẫu/i,
    });
    speechPlayerPlayMock.mockClear();
    await user.click(resultReadBtn);
    expect(speechPlayerPlayMock).toHaveBeenCalledWith("Hoa.", {
      bookId,
      cacheScope: "CATALOG",
      bypassSessionLock: true,
      utteranceKind: "game_sample",
    });
  });

  it("DifficultWordPracticePanel and TtsPlayback/SpeechService never attach stale reading session_id or synthetic practice_* session_id", async () => {
    const user = userEvent.setup();
    const { createSpeechService } = await import("@/lib/api/speech-service");
    const setCacheContextSpy = vi.fn();
    const playPhonicsMock = vi.fn().mockResolvedValue(undefined);
    speechPlayerMock.playPhonicsLesson = playPhonicsMock;
    (
      speechPlayerMock as unknown as {
        setCacheContext?: typeof setCacheContextSpy;
      }
    ).setCacheContext = setCacheContextSpy;

    // Simulate a lingering in-memory activeSessionId from an earlier reading session
    lockSessionVoice("stale-reading-session-999", {
      voiceId: "local_north_truc_ly",
    });
    applyGlobalTeacherVoiceSelection({
      voiceId: "local_north_thien_minh",
      gender: "male",
      region: "north",
    });

    const reportServicesMod = await import("@/hooks/use-report-services");
    const reportSpy = vi
      .spyOn(reportServicesMod, "useReportServices")
      .mockReturnValue({
        difficultWordService: {
          getPracticeHistory: vi.fn().mockResolvedValue({
            storage_ready: true,
            items: [],
          }),
          evaluatePracticeWord: vi.fn(),
        },
      } as unknown as ReturnType<typeof reportServicesMod.useReportServices>);

    try {
      const bookId = "abababab-abab-4bab-8bab-abababababab";
      const { unmount } = render(
        <DifficultWordPracticePanel
          child={CHILD_1}
          onClose={vi.fn()}
          onProgressSaved={vi.fn()}
          onSelectWord={vi.fn()}
          word={{
            normalized_word: "mốt",
            display_text: "mốt",
            difficulty_score: 3,
            omission_count: 0,
            repetition_count: 0,
            long_pause_count: 0,
            read_example_count: 0,
            session_count: 1,
            mispronunciation_count: 1,
            last_seen_at: "2026-11-28T00:00:00Z",
            practice_status: "NOT_PRACTICED",
            evidence_word_ids: ["33333333-3333-4333-8333-333333333333"],
            sources: [
              {
                book_id: bookId,
                visibility_scope: "PUBLIC_CATALOG",
                last_seen_at: "2026-11-28T00:00:00Z",
              },
            ],
          }}
          words={[]}
        />,
      );

      expect(setCacheContextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId,
          bypassSessionLock: true,
        }),
      );

      // Click "Nghe từ" -> passes bypassSessionLock: true
      speechPlayerPlayMock.mockClear();
      await user.click(screen.getByRole("button", { name: /Nghe từ/i }));
      expect(speechPlayerPlayMock).toHaveBeenCalledWith(
        "mốt",
        expect.objectContaining({
          wordSample: true,
          bypassSessionLock: true,
        }),
      );

      // Click "Nghe đánh vần" -> passes bypassSessionLock: true on playPhonicsLesson
      await user.click(screen.getByRole("button", { name: /Nghe đánh vần/i }));
      expect(playPhonicsMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          bypassSessionLock: true,
        }),
      );

      // Verify TtsPlayback + createSpeechService() with practice_* active lock and defaultCacheContext.bypassSessionLock=true NEVER sends session_id to /voice/text-to-speech!
      vi.stubEnv("NEXT_PUBLIC_API_URL", "http://127.0.0.1:8000");
      const postedBodies: Record<string, unknown>[] = [];
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_url, init) => {
          if (init?.body && typeof init.body === "string") {
            postedBodies.push(JSON.parse(init.body) as Record<string, unknown>);
          }
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          });
        });

      class QuickAudio {
        src = "";
        playbackRate = 1;
        duration = 0.2;
        currentTime = 0;
        onended: (() => void) | null = null;
        addEventListener(evt: string, cb: () => void) {
          if (evt === "ended") this.onended = cb;
        }
        removeEventListener() {}
        pause() {}
        play() {
          queueMicrotask(() => this.onended?.());
          return Promise.resolve();
        }
      }
      vi.stubGlobal("Audio", QuickAudio);
      vi.stubGlobal(
        "URL",
        Object.assign(URL, {
          createObjectURL: vi.fn(() => "blob:practice-tts"),
          revokeObjectURL: vi.fn(),
        }),
      );

      const realSpeech = createSpeechService();
      const player = new TtsPlayback(realSpeech, {
        listVoices: vi.fn(),
        synthesizeTimed: vi.fn(),
      } as unknown as VoiceStudioService);
      player.setCacheContext({
        bookId,
        isPrivateBook: false,
        bypassSessionLock: true,
      });

      await player.play("Con đọc từ trên màn hình nhé.", {
        coaching: true,
        isPrivateBook: false,
        cacheScope: "COACHING",
      });
      expect(postedBodies).toHaveLength(1);
      expect(postedBodies[0]).not.toHaveProperty("session_id");
      expect(postedBodies[0]).toMatchObject({
        voice_id: "local_north_thien_minh",
        cache_scope: "COACHING",
      });

      // Also verify ReadingVoiceSettings "Nghe thử" inside DifficultWordPracticePanel (even on a private book) uses COACHING + voice_preview
      speechPlayerPlayMock.mockClear();
      await user.click(screen.getByRole("button", { name: /Giọng đọc/i }));
      const previewBtn = await screen.findByRole("button", {
        name: /Nghe thử/i,
      });
      await user.click(previewBtn);
      expect(speechPlayerPlayMock).toHaveBeenCalledWith(
        expect.stringContaining("Hai mươi mốt bông hoa"),
        {
          coaching: true,
          cacheScope: "COACHING",
          isPrivateBook: false,
          bypassSessionLock: true,
          utteranceKind: "voice_preview",
        },
      );

      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
      unmount();
    } finally {
      delete (speechPlayerMock as { setCacheContext?: unknown })
        .setCacheContext;
      reportSpy.mockRestore();
    }
  });

  it("SessionComplete does NOT self-abort completion prompt when speechPlayer reference updates mid-playback, and stops only on unmount", async () => {
    vi.stubGlobal("AudioContext", class FakeAudioCtx {});
    speechPlayerStopMock.mockClear();

    const props = {
      booksHref: "/books",
      bookId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      child: CHILD_1,
      sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      summary: {
        duration_minutes: 4,
        pages_explored: 2,
        practiced_words: 5,
        correct_words: ["con"],
        mispronounced_words: ["mốt"],
        skipped_words: [],
      },
    };

    const { rerender, unmount } = render(<SessionComplete {...props} />);
    await waitFor(() => expect(speechPlayerPlayMock).toHaveBeenCalledTimes(1));
    expect(speechPlayerStopMock).not.toHaveBeenCalled();

    // Simulate useSpeechPlayer() returning a new object reference on state: "idle" -> "loading" -> "playing"
    speechPlayerMock.state = "loading";
    speechPlayerMock.isPlaying = true;
    rerender(<SessionComplete {...props} />);
    speechPlayerMock.state = "playing";
    rerender(<SessionComplete {...props} />);

    expect(speechPlayerStopMock).not.toHaveBeenCalled();
    expect(speechPlayerPlayMock).toHaveBeenCalledTimes(1);

    unmount();
    expect(speechPlayerStopMock).toHaveBeenCalledTimes(1);
    speechPlayerMock.state = "idle";
    speechPlayerMock.isPlaying = false;
  });

  it("AiTeacherVoiceSection surfaces worker-offline hint under local_only even when ElevenLabs is configured on backend or stale voiceHealth was cached", async () => {
    setCachedVoiceEngineHealth({
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: {
        configured: true,
        available: true,
        stt_ready: true,
        tts_ready: true,
      },
      google: {
        stt_configured: true,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
      elevenlabs: {
        configured: true,
        stt_configured: true,
        tts_configured: true,
        male_tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    });
    listVoicesMock.mockResolvedValue({
      voices: [...STATIC_LOCAL_VOICES],
      default_voice_id: "local_north_truc_ly",
      local_worker_ready: false,
      google_tts_available: true,
    });

    const services = {
      childService: {
        list: vi.fn().mockResolvedValue([CHILD_1]),
        get: vi.fn().mockResolvedValue(CHILD_1),
        updateVoicePreferences: updateVoicePreferencesMock,
      },
    } as unknown as React.ContextType<typeof AppServicesContext>;

    render(
      <AppServicesContext.Provider value={services}>
        <AiTeacherVoiceSection selectedChild={CHILD_1} />
      </AppServicesContext.Provider>,
    );

    // Because local_only blocks ElevenLabs on backend and fresh /voice/voices reported local_worker_ready=false,
    // the parent MUST still see the offline hint prompting them to enable "Máy này + Dự phòng trực tuyến".
    expect(
      await screen.findByTestId("teacher-voice-worker-offline-hint"),
    ).toBeInTheDocument();
  });
});
