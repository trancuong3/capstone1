import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { MemoryGameScreen } from "@/components/entertainment/memory-game/memory-game-screen";
import { AppServicesContext } from "@/components/providers/app-services-provider";
import {
  AppStoreContext,
  AppStoreProvider,
} from "@/components/providers/app-store-provider";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import {
  applyGlobalTeacherVoiceSelection,
  getEffectiveTeacherPersona,
  getEffectiveVoiceId,
  hydrateTeacherVoiceFromChildProfile,
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
  STATIC_LOCAL_VOICES,
} from "@/lib/reading/session-voice-lock";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import { mapLocalVoiceToGoogleBackup } from "@/lib/reading/voice-engine-status";
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

    // Switch region South -> Central while Male is active: MUST stay Male (Thầy Quang Sơn)!
    await user.click(screen.getByTestId("teacher-region-central"));
    expect(getEffectiveVoiceId()).toBe("local_central_quang_son");
    expect(getEffectiveTeacherPersona().gender).toBe("male");

    // Preview voice speaks male greeting with bypassSessionLock: true
    await user.click(screen.getByTestId("teacher-voice-preview-btn"));
    expect(speechPlayerPlayMock).toHaveBeenCalledWith(
      expect.stringContaining("thầy là Thầy Quang Sơn"),
      expect.objectContaining({ bypassSessionLock: true }),
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

    // Move to recall stage and trigger spoken prompt via Listen Guide button
    const recallReadyBtn = await screen.findByTestId("finish-observe-btn");
    await user.click(recallReadyBtn);

    const listenBtn = await screen.findByRole("button", {
      name: /Nghe hướng dẫn/i,
    });
    await user.click(listenBtn);

    // MUST route through speechPlayer.play (single source of truth) and NEVER raw window.speechSynthesis.speak
    expect(speechPlayerPlayMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ utteranceKind: "game_prompt" }),
    );
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
          creative_followup_vi: "Kể tiếp nhé!",
          support_summary_vi: null,
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
    // UI praise adapts to "Thầy khen bé..." even if a legacy string had "Cô khen bé..."
    expect(
      await screen.findByText(/Thầy khen bé có trí nhớ rất tốt!/),
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
});
