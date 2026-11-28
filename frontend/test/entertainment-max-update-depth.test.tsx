import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthRuntimeContext,
  AuthServiceContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";
import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { SongCard } from "@/components/karaoke/song-card";
import { AppShell } from "@/components/layout/app-shell";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  AppStoreProvider,
  areEquivalentChildProfiles,
} from "@/components/providers/app-store-provider";
import {
  resetAllApiCachesForTests,
  setApiReadCacheActorScope,
  setApiReadCacheEnabled,
} from "@/lib/api/read-cache";
import { writeSessionSelectedChildId } from "@/lib/cache/selected-child-storage";
import { clearUserCache, writeUserCache } from "@/lib/cache/user-query-cache";
import {
  isConfirmedSilentVoiceCapture,
  isServerSttConfirmedUnavailable,
} from "@/lib/reading/voice-capture-guard";
import { resetVoicePreloaderForTests } from "@/lib/reading/voice-preloader";
import {
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import type { AuthService } from "@/lib/api/auth-service";
import type { AudioQualitySnapshot } from "@/lib/reading/audio-quality";
import type { VoiceEngineHealthSnapshot } from "@/lib/reading/voice-engine-status";
import type { ChildProfileDTO } from "@/types/child";

const navState = vi.hoisted(() => ({
  pathname: "/entertainment",
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

const recorderQualityState = vi.hoisted(() => ({
  snapshot: null as AudioQualitySnapshot | null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(navState.search),
  useRouter: () => ({
    push: navState.push,
    replace: navState.replace,
    refresh: navState.refresh,
  }),
}));

vi.mock("@/hooks/use-speech-recorder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-speech-recorder")>();
  return {
    ...actual,
    useSpeechRecorder: () => {
      const real = actual.useSpeechRecorder();
      if (!recorderQualityState.snapshot) {
        return real;
      }
      return {
        isRecording: false,
        isSpeaking: false,
        audioLevel: 0,
        prepare: async () => undefined,
        start: async () => undefined,
        stop: async () => new Blob(["silent-pcm"], { type: "audio/webm" }),
        cancel: () => undefined,
        getStream: () => null,
        getIsSpeaking: () => false,
        getAudioLevel: () => 0,
        getQuality: () => recorderQualityState.snapshot!,
        getSettings: () => null,
      };
    },
  };
});

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: {
          session: {
            access_token:
              "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwNzNhZjAxNS1hZjk3LTQ5NTctOGM4MC01OGZiZmJhZTI5YTEifQ.sig",
          },
        },
        error: null,
      }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8012",
  getSupabasePublicConfig: () => ({
    url: "https://example.supabase.co",
    publishableKey: "sb_publishable_test",
  }),
}));

const PARENT_ID = "073af015-af97-4957-8c80-58fbfbae29a1";
const CHILD_ID = "b4315283-d292-4b00-b1bd-8d841a6b89af";

const childFixture: ChildProfileDTO = {
  id: CHILD_ID,
  parent_id: PARENT_ID,
  alias: "Bé An",
  grade: 2,
  settings: {},
  created_at: "2026-11-28T09:00:00Z",
};

const authRuntime: AuthRuntimeState = {
  hasProvider: true,
  initialUserId: PARENT_ID,
  initializationFailure: null,
  isPasswordRecovery: false,
  lastEvent: "SIGNED_IN",
  mode: "supabase",
  session: {
    expires_at: null,
    user: {
      id: PARENT_ID,
      email: "viread.qa.test20261128@gmail.com",
      display_name: "Phụ huynh Bé An",
    },
  },
  status: "ready",
};

const fakeAuthService = {
  signOut: vi.fn(async () => undefined),
} as unknown as AuthService;

describe("QA Live Regression Suite: Render Loops, Notebook, Karaoke Covers & Silent STT", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    recorderQualityState.snapshot = null;
    window.localStorage.clear();
    window.sessionStorage.clear();
    clearUserCache();
    resetAllApiCachesForTests();
    resetVoicePreloaderForTests();
    resetVoiceLockAndPolicyForTests();
    setApiReadCacheEnabled(true);
    setApiReadCacheActorScope(PARENT_ID);
    writeSessionSelectedChildId(PARENT_ID, CHILD_ID);
    writeUserCache(
      PARENT_ID,
      "dashboard-summary",
      {
        profile: {
          id: PARENT_ID,
          role: "parent",
          display_name: "Phụ huynh Bé An",
          email: "viread.qa.test20261128@gmail.com",
          contact_phone: null,
          avatar_url: null,
          children: [childFixture],
          created_at: "2026-11-28T09:00:00Z",
        },
        children: [childFixture],
        recent_sessions: [],
        books: [],
      },
      { persist: "session" },
    );

    fetchMock.mockReset().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/profiles/dashboard-summary") {
        return Response.json({
          profile: {
            id: PARENT_ID,
            role: "parent",
            display_name: "Phụ huynh Bé An",
            email: "viread.qa.test20261128@gmail.com",
            contact_phone: null,
            avatar_url: null,
            children: [childFixture],
            created_at: "2026-11-28T09:00:00Z",
          },
          children: [childFixture],
          recent_sessions: [],
          books: [],
        });
      }
      if (url.pathname === "/profiles/children") {
        return Response.json([childFixture]);
      }
      if (url.pathname === `/profiles/children/${CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (url.pathname === `/vocabulary/children/${CHILD_ID}/notebook`) {
        return Response.json({
          child_id: CHILD_ID,
          total: 0,
          storytelling_words: [],
          items: [],
        });
      }
      if (url.pathname.startsWith("/learning/")) {
        return Response.json({
          child_id: CHILD_ID,
          child_alias: "Bé An",
          child_grade: 2,
          mascot_greeting_vi: "Chào Bé An!",
          focus_difficult_words: [],
          primary_recommendation: null,
          recommendations: [],
          natural_break_reminder_vi: "Nghỉ mắt chút nhé.",
        });
      }
      if (url.pathname === "/games/picture-description/catalog") {
        return Response.json({
          samples: [
            {
              sample_key: "sunny_garden",
              title: "Khu vườn đầy nắng",
              theme: "Thiên nhiên",
              description:
                "Chú mèo cam nằm phơi nắng bên luống hoa hướng dương.",
              image_url: "/images/picture-description/sunny-garden.jpg",
            },
          ],
          book_pages: [],
        });
      }
      if (url.pathname === "/games/picture-description/sessions") {
        return Response.json([]);
      }
      if (
        url.pathname === "/games/picture-description/sessions/create" ||
        url.pathname === "/games/picture-description/sessions"
      ) {
        return Response.json([]);
      }
      if (url.pathname === "/voice/status") {
        return Response.json({
          default_mode: "local_only",
          default_voice_id: "local_north_truc_ly",
          local: { available: false, tts_ready: false, stt_ready: false },
          google: {
            tts_configured: false,
            stt_configured: false,
            tts_cooldown: false,
            stt_cooldown: false,
          },
          elevenlabs: {
            configured: false,
            tts_configured: false,
            stt_configured: false,
            tts_cooldown: false,
            stt_cooldown: false,
          },
        });
      }
      if (url.pathname === "/voice/speech-to-text") {
        return Response.json(
          { detail: { code: "STT_UNAVAILABLE" } },
          { status: 503 },
        );
      }
      if (url.pathname.includes("/tasks")) {
        return Response.json({
          actor_id: PARENT_ID,
          actor_role: "parent",
          portal: "parent",
          tasks: [],
          active_count: 0,
          waiting_review_count: 0,
          failed_count: 0,
          completed_count: 0,
          worker_online: false,
          recommended_poll_ms: 8000,
        });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    recorderQualityState.snapshot = null;
    resetAllApiCachesForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mounts /entertainment inside AppShell + AppStoreProvider with read-cache enabled without Maximum update depth exceeded", async () => {
    navState.pathname = "/entertainment";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <I18nProvider initialLocale="vi">
        <AuthRuntimeContext.Provider value={authRuntime}>
          <AuthServiceContext.Provider value={fakeAuthService}>
            <AppServicesProvider scenario="default">
              <AppStoreProvider>
                <AppShell>
                  <EntertainmentScreen />
                </AppShell>
              </AppStoreProvider>
            </AppServicesProvider>
          </AuthServiceContext.Provider>
        </AuthRuntimeContext.Provider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("hub-active-child-badge")).toBeInTheDocument();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });

    const childListCalls = fetchMock.mock.calls.filter(
      ([u]) => new URL(String(u)).pathname === "/profiles/children",
    );
    expect(childListCalls.length).toBe(1);

    const maxDepthErrors = errorSpy.mock.calls
      .flat()
      .map(String)
      .filter((msg) => msg.includes("Maximum update depth exceeded"));
    expect(maxDepthErrors).toEqual([]);
  });

  it("mounts /entertainment/picture-description inside AppShell + AppStoreProvider without render loops", async () => {
    navState.pathname = "/entertainment/picture-description";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <I18nProvider initialLocale="vi">
        <AuthRuntimeContext.Provider value={authRuntime}>
          <AuthServiceContext.Provider value={fakeAuthService}>
            <AppServicesProvider scenario="default">
              <AppStoreProvider>
                <AppShell>
                  <PictureDescriptionScreen />
                </AppShell>
              </AppStoreProvider>
            </AppServicesProvider>
          </AuthServiceContext.Provider>
        </AuthRuntimeContext.Provider>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Khu vườn đầy nắng")).toBeInTheDocument();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });

    const maxDepthErrors = errorSpy.mock.calls
      .flat()
      .map(String)
      .filter((msg) => msg.includes("Maximum update depth exceeded"));
    expect(maxDepthErrors).toEqual([]);
  });

  it("compares ChildProfileDTO snapshots accurately to prevent redundant store updates", () => {
    const clone: ChildProfileDTO = { ...childFixture, settings: {} };
    expect(areEquivalentChildProfiles(childFixture, clone)).toBe(true);
    expect(
      areEquivalentChildProfiles(childFixture, { ...childFixture, grade: 3 }),
    ).toBe(false);
    expect(areEquivalentChildProfiles(childFixture, null)).toBe(false);
  });

  it("renders themed cover illustrations on SongCard when cover_url is null or errors, and recovers on URL refresh", () => {
    const baseSong = {
      song_id: "7c639364-6780-558f-a011-0f35d861cbcd",
      version_id: "5f61e2b2-d619-529c-8773-0170a1913a21",
      title: "Cò lả đồng dao",
      author: "Dân ca đồng bằng Bắc Bộ",
      min_grade: 2,
      max_grade: 5,
      duration_ms: 37478,
      cover_url: null as string | null,
    };

    const { rerender } = render(
      <I18nProvider initialLocale="vi">
        <SongCard song={baseSong} />
      </I18nProvider>,
    );

    expect(
      screen.getByTestId("song-card-cover-illustration"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    rerender(
      <I18nProvider initialLocale="vi">
        <SongCard
          song={{ ...baseSong, cover_url: "https://example.test/broken.webp" }}
        />
      </I18nProvider>,
    );
    fireEvent.error(screen.getByRole("img"));
    expect(
      screen.getByTestId("song-card-cover-illustration"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    // Fresh signed URL recovers cleanly without staying stuck in failed state
    rerender(
      <I18nProvider initialLocale="vi">
        <SongCard
          song={{ ...baseSong, cover_url: "https://example.test/fresh.webp" }}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://example.test/fresh.webp",
    );
  });

  it("short-circuits silent mic captures (rms = 0) and confirmed offline server STT without hitting /voice/speech-to-text", async () => {
    expect(
      isConfirmedSilentVoiceCapture({
        status: "SILENCE",
        durationMs: 1200,
        speechDurationMs: 0,
        silenceDurationMs: 1200,
        rms: 0,
        peak: 0,
        noiseFloor: 0,
        clipped: false,
        isSpeaking: false,
      }),
    ).toBe(true);
    expect(
      isConfirmedSilentVoiceCapture({
        status: "UNKNOWN",
        durationMs: 0,
        speechDurationMs: 0,
        silenceDurationMs: 0,
        rms: 0,
        peak: 0,
        noiseFloor: 0,
        clipped: false,
        isSpeaking: false,
      }),
    ).toBe(false);
    expect(
      isConfirmedSilentVoiceCapture({
        status: "SPEECH_DETECTED",
        durationMs: 1500,
        speechDurationMs: 800,
        silenceDurationMs: 100,
        rms: 0.04,
        peak: 0.22,
        noiseFloor: 0.002,
        clipped: false,
        isSpeaking: false,
      }),
    ).toBe(false);

    const offlineHealth: VoiceEngineHealthSnapshot = {
      default_mode: "local_only",
      default_voice_id: "local_north_truc_ly",
      local: { available: false, stt_ready: false, tts_ready: false },
      google: {
        stt_configured: true,
        tts_configured: true,
        stt_cooldown: false,
        tts_cooldown: false,
      },
      elevenlabs: {
        configured: false,
        stt_configured: false,
        tts_configured: false,
      },
    };
    setVoicePolicyPreferences({
      providerMode: "local_only",
      allowGoogleSttFallback: false,
    });
    expect(isServerSttConfirmedUnavailable(offlineHealth)).toBe(true);

    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleSttFallback: true,
    });
    expect(isServerSttConfirmedUnavailable(offlineHealth)).toBe(false);

    // End-to-end component check: silent capture after 3-2-1 countdown skips POST /voice/speech-to-text
    recorderQualityState.snapshot = {
      status: "SILENCE",
      durationMs: 1400,
      speechDurationMs: 0,
      silenceDurationMs: 1400,
      rms: 0,
      peak: 0,
      noiseFloor: 0,
      clipped: false,
      isSpeaking: false,
    };
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (
        url.pathname === "/games/picture-description/sessions" &&
        init?.method === "POST"
      ) {
        return Response.json({
          session_id: "a1111111-2222-4333-8444-555555555555",
          child_id: CHILD_ID,
          child_grade: 2,
          source_type: "SAMPLE",
          sample_key: "sunny_garden",
          book_id: null,
          book_page_id: null,
          scene_title: "Khu vườn đầy nắng",
          image_url: "/images/picture-description/sunny-garden.jpg",
          status: "ACTIVE",
          teaching_mode: "OBSERVE",
          best_score: 0,
          best_stars: 0,
          attempts_count: 0,
          provider_tier: "CURATED",
          target_words: [],
          guide: {
            is_child_safe: true,
            scene_title: "Khu vườn đầy nắng",
            scene_summary: "Chú mèo cam nằm phơi nắng.",
            guiding_questions: ["Trong tranh có con vật gì?"],
            suggested_vocabulary: [{ word: "nắng ấm", hint: "ánh nắng dịu" }],
            sentence_starters: ["Trong tranh có..."],
            model_sample_sentences: ["Chú mèo nằm sưởi nắng ấm."],
            teaching_mode: "OBSERVE",
            target_words: [],
          },
          attempts: [],
          created_at: "2026-11-28T09:00:00Z",
          updated_at: "2026-11-28T09:00:00Z",
        });
      }
      if (url.pathname === "/games/picture-description/catalog") {
        return Response.json({
          samples: [
            {
              sample_key: "sunny_garden",
              title: "Khu vườn đầy nắng",
              theme: "Thiên nhiên",
              description: "Chú mèo cam nằm phơi nắng.",
              image_url: "/images/picture-description/sunny-garden.jpg",
            },
          ],
          book_pages: [],
        });
      }
      if (url.pathname === "/games/picture-description/sessions") {
        return Response.json([]);
      }
      if (url.pathname === `/profiles/children/${CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (url.pathname === `/vocabulary/children/${CHILD_ID}/notebook`) {
        return Response.json({
          child_id: CHILD_ID,
          total: 0,
          storytelling_words: [],
          items: [],
        });
      }
      if (url.pathname === "/voice/speech-to-text") {
        return Response.json(
          { detail: { code: "STT_UNAVAILABLE" } },
          { status: 503 },
        );
      }
      return Response.json({});
    });

    navState.pathname = "/entertainment/picture-description";
    window.localStorage.setItem(
      "viread:entertainment-preferences.v1",
      JSON.stringify({
        reducedMotion: false,
        calmSound: false,
        autopilotEnabled: false,
      }),
    );

    render(
      <I18nProvider initialLocale="vi">
        <AuthRuntimeContext.Provider value={authRuntime}>
          <AuthServiceContext.Provider value={fakeAuthService}>
            <AppServicesProvider scenario="default">
              <AppStoreProvider>
                <PictureDescriptionScreen />
              </AppStoreProvider>
            </AppServicesProvider>
          </AuthServiceContext.Provider>
        </AuthRuntimeContext.Provider>
      </I18nProvider>,
    );

    const exploreBtn = await screen.findByRole("button", {
      name: "Khám phá tranh này",
    });
    fireEvent.click(exploreBtn);

    const micStartBtn = await screen.findByRole("button", {
      name: /Nói bằng Micro/i,
    });
    fireEvent.click(micStartBtn);

    const stopBtn = await screen.findByRole("button", {
      name: /Dừng ghi âm/i,
    });
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/chưa nghe thấy tiếng bé nói/i),
      ).toBeInTheDocument();
    });

    const sttNetworkCalls = fetchMock.mock.calls.filter(
      ([u]) => new URL(String(u)).pathname === "/voice/speech-to-text",
    );
    expect(sttNetworkCalls).toHaveLength(0);
  });
});
