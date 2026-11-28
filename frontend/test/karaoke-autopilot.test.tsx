import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthRuntimeContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import { KaraokeLibraryScreen } from "@/components/karaoke/karaoke-library-screen";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import { KaraokePlayerScreen } from "@/components/karaoke/karaoke-player-screen";
import { ParentKaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";
import { SongCard } from "@/components/karaoke/song-card";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";
import { ENTERTAINMENT_PREFERENCES_STORAGE_KEY } from "@/hooks/use-entertainment-preferences";
import {
  createKaraokeService,
  type KaraokePlayback,
} from "@/lib/api/karaoke-service";
import { LiveSingingAttempt } from "@/lib/karaoke/live-singing-score";
import {
  monitorSingingTrack,
  SingingSignalClassifier,
} from "@/lib/karaoke/microphone-signal";
import {
  lineId,
  previewDetail,
  songId,
  stamp,
  syllableLyrics,
  versionId,
} from "@/test/karaoke-fixtures";

const { replace, searchParamsState } = vi.hoisted(() => ({
  replace: vi.fn(),
  searchParamsState: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParamsState.current,
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "karaoke-autopilot-test" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const childProfile = {
  id: versionId,
  parent_id: songId,
  alias: "Bé An",
  grade: 2,
  settings: {},
  created_at: stamp,
};

const authState: AuthRuntimeState = {
  mode: "supabase",
  status: "ready",
  session: {
    user: { id: songId, email: "parent@example.test", display_name: "Ba mẹ" },
    expires_at: null,
  },
  lastEvent: "SIGNED_IN",
  isPasswordRecovery: false,
  initializationFailure: null,
};

const songCardWithWords = {
  song_id: songId,
  version_id: versionId,
  title: "Ngôi sao nhỏ",
  author: "Nhạc thiếu nhi",
  min_grade: 1,
  max_grade: 5,
  duration_ms: 20000,
  cover_url: null,
  matched_difficult_words: ["trường", "vui"],
};

const audios: AutopilotAudio[] = [];
class AutopilotAudio extends EventTarget {
  src = "";
  preload = "";
  volume = 1;
  muted = false;
  currentTime = 0;
  duration = 20;
  paused = true;
  ended = false;
  playbackRate = 1;
  preservesPitch = true;
  play = vi.fn(async () => {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause = vi.fn(() => {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  });
  load = vi.fn();
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  constructor() {
    super();
    audios.push(this);
  }
}

function installRecognition() {
  const instances: Recognition[] = [];
  class Recognition {
    onspeechstart: (() => void) | null = null;
    onspeechend: (() => void) | null = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onresult: ((event: unknown) => void) | null = null;
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  vi.stubGlobal("SpeechRecognition", Recognition);
  return instances;
}

function twoLinePlayback(): KaraokePlayback {
  const first = syllableLyrics().lines[0];
  const secondId = "55555555-5555-4555-8555-555555555555";
  const source = previewDetail();
  return {
    ...source,
    title: "Ngôi sao nhỏ",
    lyrics: {
      format_version: 2,
      lines: [
        {
          ...first,
          start_ms: first.start_ms!,
          end_ms: first.end_ms!,
        },
        {
          id: secondId,
          text: "Cùng vui hát",
          start_ms: 6000,
          end_ms: 9500,
          syllables: [
            {
              id: "66666666-6666-4666-8666-666666666661",
              text: "Cùng",
              start_ms: 6000,
              end_ms: 7000,
            },
            {
              id: "66666666-6666-4666-8666-666666666662",
              text: "vui",
              start_ms: 7000,
              end_ms: 8200,
            },
            {
              id: "66666666-6666-4666-8666-666666666663",
              text: "hát",
              start_ms: 8200,
              end_ms: 9500,
            },
          ],
        },
      ],
    },
  };
}

function SeedChild({ children }: { children: ReactNode }) {
  const { selectChild } = useAppStore();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) {
        selectChild(childProfile.id);
        setReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [selectChild]);
  return <>{ready && children}</>;
}

function Harness({ children }: { children: ReactNode }) {
  return (
    <AuthRuntimeContext.Provider value={authState}>
      <AppServicesProvider>
        <AppStoreProvider>
          <SeedChild>
            <ParentKaraokeServicesProvider>
              {children}
            </ParentKaraokeServicesProvider>
          </SeedChild>
        </AppStoreProvider>
      </AppServicesProvider>
    </AuthRuntimeContext.Provider>
  );
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  window.localStorage.clear();
  searchParamsState.current = new URLSearchParams();
  replace.mockReset();
  audios.length = 0;
  fetchMock.mockReset().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === `/profiles/children/${childProfile.id}`) {
      return Response.json(childProfile);
    }
    if (url.pathname === "/karaoke/songs") {
      return Response.json({
        items: [songCardWithWords],
        total: 1,
        limit: 12,
        offset: 0,
      });
    }
    if (url.pathname.endsWith("/playback")) {
      return Response.json(twoLinePlayback());
    }
    if (url.pathname.endsWith("/musical-profile")) {
      return Response.json(null, { status: 404 });
    }
    if (url.pathname === "/karaoke/practice-sessions") {
      return Response.json({
        child_id: childProfile.id,
        song_id: songId,
        best_full_song_score: null,
        best_full_song_stars: 0,
        total_sessions: 0,
        items: [],
        storage_ready: true,
      });
    }
    throw new Error(`Unexpected path ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Audio", AutopilotAudio);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Karaoke V4.1 difficult-word badges & 1-tap Autopilot", () => {
  it("parses optional matched_difficult_words in karaoke-service and renders RTL-isolated chips + 1-tap Sing Now link", async () => {
    const service = createKaraokeService();
    const catalog = await service.list(childProfile.id);
    expect(catalog.items[0].matched_difficult_words).toEqual(["trường", "vui"]);

    render(
      <Harness>
        <KaraokeLibraryScreen />
      </Harness>,
    );

    expect(
      await screen.findByTestId("karaoke-difficult-words-boost-hint"),
    ).toBeVisible();
    const badge = screen.getByTestId("karaoke-song-difficult-words");
    expect(badge).toHaveTextContent("Ôn từ khó:");
    const ltrWords = badge.querySelector(
      '.viread-learning-content[dir="ltr"][lang="vi"]',
    );
    expect(ltrWords).toHaveTextContent("trường");
    expect(ltrWords).toHaveTextContent("vui");

    expect(screen.getByRole("link", { name: "Hát ngay" })).toHaveAttribute(
      "href",
      `/karaoke/${songId}?version=${versionId}&autoplay=1&scored=1`,
    );
    expect(
      screen.getByRole("link", { name: `Hát bài ${songCardWithWords.title}` }),
    ).toHaveAttribute("href", `/karaoke/${songId}?version=${versionId}`);
  });

  it("omits difficult-word chip box when matched_difficult_words is absent or empty", () => {
    render(
      <SongCard
        song={{
          ...songCardWithWords,
          matched_difficult_words: [],
        }}
      />,
    );
    expect(
      screen.queryByTestId("karaoke-song-difficult-words"),
    ).not.toBeInTheDocument();
  });

  it("H4 + M4: /karaoke?autoplay=1 redirects to top song when autoPlayFlow=true and stays in library when autoPlayFlow=false or empty", async () => {
    const view1 = render(
      <Harness>
        <KaraokeLibraryScreen autoPlay />
      </Harness>,
    );
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        `/karaoke/${songId}?version=${versionId}&autoplay=1&scored=1`,
      );
    });
    view1.unmount();

    replace.mockReset();
    window.localStorage.setItem(
      ENTERTAINMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        reducedMotion: false,
        calmSound: true,
        autoPlayFlow: false,
      }),
    );
    const view2 = render(
      <Harness>
        <KaraokeLibraryScreen autoPlay />
      </Harness>,
    );
    expect(
      await screen.findByRole("heading", { name: songCardWithWords.title }),
    ).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
    view2.unmount();

    replace.mockReset();
    window.localStorage.setItem(
      ENTERTAINMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        reducedMotion: false,
        calmSound: true,
        autoPlayFlow: true,
      }),
    );
    fetchMock.mockImplementationOnce(async () => Response.json(childProfile));
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ items: [], total: 0, limit: 12, offset: 0 }),
    );
    render(
      <Harness>
        <KaraokeLibraryScreen autoPlay />
      </Harness>,
    );
    expect(await screen.findByText("Chưa có bài hát phù hợp")).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });

  it("preserves ?focus= query during /karaoke?autoplay=1 redirect and skips redirect for magic-chant mode", async () => {
    window.history.replaceState(
      {},
      "",
      "/karaoke?autoplay=1&focus=tr%C6%B0%E1%BB%9Dng",
    );
    try {
      const view1 = render(
        <Harness>
          <KaraokeLibraryScreen autoPlay />
        </Harness>,
      );
      await vi.waitFor(() => {
        expect(replace).toHaveBeenCalledWith(
          `/karaoke/${songId}?version=${versionId}&autoplay=1&scored=1&focus=tr%C6%B0%E1%BB%9Dng`,
        );
      });
      view1.unmount();

      replace.mockReset();
      window.history.replaceState(
        {},
        "",
        "/karaoke?mode=magic-chant&autoplay=1",
      );
      const view2 = render(
        <Harness>
          <KaraokeLibraryScreen autoPlay initialMode="magic-chant" />
        </Harness>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(replace).not.toHaveBeenCalled();
      view2.unmount();
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });

  it("never auto-starts countdown when ?autoplay=1 is missing from URL", async () => {
    installRecognition();
    searchParamsState.current = new URLSearchParams(`version=${versionId}`);
    render(
      <Harness>
        <KaraokePlayerScreen songId={songId} expectedVersionId={versionId} />
      </Harness>,
    );

    await screen.findByRole("heading", { name: "Ngôi sao nhỏ" });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => audios[0].dispatchEvent(new Event("loadedmetadata")));
    expect(screen.queryByTestId("karaoke-countdown")).toBeNull();
    expect(audios[0].play).not.toHaveBeenCalled();
  });

  it("respects autoPlayFlow=false preference even when ?autoplay=1&scored=1 is present", async () => {
    window.localStorage.setItem(
      ENTERTAINMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        reducedMotion: false,
        calmSound: true,
        autoPlayFlow: false,
      }),
    );
    const recognizers = installRecognition();
    searchParamsState.current = new URLSearchParams(
      `version=${versionId}&autoplay=1&scored=1`,
    );

    render(
      <Harness>
        <KaraokePlayerScreen songId={songId} expectedVersionId={versionId} />
      </Harness>,
    );

    await screen.findByRole("heading", { name: "Ngôi sao nhỏ" });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => audios[0].dispatchEvent(new Event("loadedmetadata")));
    expect(recognizers).toHaveLength(0);
    expect(screen.queryByTestId("karaoke-countdown")).toBeNull();
    expect(audios[0].play).not.toHaveBeenCalled();
  });

  it("auto-starts scored 3-2-1 countdown and singing when ?autoplay=1&scored=1 and autoPlayFlow=true", async () => {
    const recognizers = installRecognition();
    searchParamsState.current = new URLSearchParams(
      `version=${versionId}&autoplay=1&scored=1`,
    );

    render(
      <Harness>
        <KaraokePlayerScreen songId={songId} expectedVersionId={versionId} />
      </Harness>,
    );

    await screen.findByRole("heading", { name: "Ngôi sao nhỏ" });
    await act(async () => {
      await Promise.resolve();
    });
    vi.useFakeTimers();
    act(() => audios[0].dispatchEvent(new Event("loadedmetadata")));

    expect(recognizers).toHaveLength(1);
    await act(async () => recognizers[0].onstart?.());
    expect(screen.getByTestId("karaoke-countdown")).toHaveTextContent("3");

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(audios[0].play).toHaveBeenCalledOnce();
    expect(recognizers).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Hát có chấm điểm" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("shows calm single centered CTA without red error alert when browser blocks autoplay playback (NotAllowedError)", async () => {
    const recognizers = installRecognition();
    vi.useFakeTimers();

    render(
      <KaraokePlayer
        source={twoLinePlayback()}
        presentation="child"
        childAlias="Bé An"
        label="Hát cùng bé"
        autoPlay
        autoScored
      />,
    );

    const audio = audios[0];
    audio.play.mockRejectedValueOnce(
      new DOMException("Autoplay is not allowed", "NotAllowedError"),
    );

    act(() => audio.dispatchEvent(new Event("loadedmetadata")));
    await act(async () => recognizers[0].onstart?.());
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const tapBtn = screen.getByTestId("karaoke-autoplay-tap-btn");
    expect(tapBtn).toHaveTextContent("Chạm 1 lần để vào nhạc");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Nhạc đang gặp chút trục trặc"),
    ).not.toBeInTheDocument();

    fireEvent.click(tapBtn);
    await act(async () => {
      await Promise.resolve();
    });
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.paused).toBe(false);
    expect(
      screen.queryByTestId("karaoke-autoplay-tap-btn"),
    ).not.toBeInTheDocument();
  });

  it("shows calm centered CTA when mic gesture is denied during autoplay and recovers cleanly on 1 tap", async () => {
    const recognizers = installRecognition();
    vi.useFakeTimers();

    render(
      <KaraokePlayer
        source={twoLinePlayback()}
        presentation="child"
        childAlias="Bé An"
        label="Hát cùng bé"
        autoPlay
        autoScored
      />,
    );

    const audio = audios[0];
    act(() => audio.dispatchEvent(new Event("loadedmetadata")));
    await act(async () => recognizers[0].onerror?.({ error: "not-allowed" }));

    const tapBtn = screen.getByTestId("karaoke-autoplay-tap-btn");
    expect(tapBtn).toHaveTextContent("Chạm 1 lần để vào nhạc");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(tapBtn);
    expect(recognizers).toHaveLength(2);
    await act(async () => recognizers[1].onstart?.());
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it("prominently displays 1-tap weakest segment practice (0.85x) at top of report summary on completion", async () => {
    const recognizers = installRecognition();
    vi.useFakeTimers();

    render(
      <KaraokePlayer
        source={twoLinePlayback()}
        presentation="child"
        childAlias="Bé An"
        label="Hát cùng bé"
        autoPlay
        autoScored
      />,
    );

    const audio = audios[0];
    act(() => audio.dispatchEvent(new Event("loadedmetadata")));
    await act(async () => recognizers[0].onstart?.());
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    const capture = recognizers[1];
    act(() => {
      capture.onstart?.();
      audio.currentTime = 1.0;
      capture.onspeechstart?.();
      audio.currentTime = 3.9;
      capture.onspeechend?.();
      audio.dispatchEvent(new Event("timeupdate"));
      capture.onresult?.({
        resultIndex: 0,
        results: [
          { isFinal: true, 0: { transcript: "bé hát vui", confidence: 0.99 } },
        ],
      });
      // Advance through line 2 without singing so line 2 becomes weakestSegment.
      audio.currentTime = 9.6;
      audio.dispatchEvent(new Event("timeupdate"));
      audio.currentTime = 20;
      audio.ended = true;
      audio.paused = true;
      audio.dispatchEvent(new Event("ended"));
    });
    act(() => capture.onend?.());

    const weakestCallout = screen.getByTestId("karaoke-weakest-segment-cta");
    const scoreRegion = screen.getByRole("region", {
      name: "Kết quả đúng lời",
    });
    expect(
      weakestCallout.compareDocumentPosition(scoreRegion) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const practiceBtn = screen.getByTestId("karaoke-practice-weakest-btn");
    expect(practiceBtn).toHaveTextContent("Luyện ngay câu yếu nhất (0.85×)");

    fireEvent.click(practiceBtn);
    await act(async () => recognizers.at(-1)!.onstart?.());
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(audio.playbackRate).toBe(0.85);
    expect(audio.currentTime).toBe(6);
    expect(
      screen.getByRole("button", { name: "Luyện đoạn khó" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(lineId).toBeTruthy();
  });

  it("flushes trailing <50ms audio interval once on stop() before tearing down AudioContext", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let currentAmplitude = 0.04;
    const getFloatTimeDomainData = vi.fn((out: Float32Array) => {
      events.push("sample");
      out.fill(currentAmplitude);
    });
    const disconnect = vi.fn(() => events.push("disconnect"));
    const close = vi.fn(async () => {
      events.push("close");
    });

    class MockAudioContext {
      state = "running";
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect }));
      createAnalyser = vi.fn(() => ({
        fftSize: 2048,
        disconnect,
        getFloatTimeDomainData,
      }));
      resume = vi.fn(async () => {});
      close = close;
    }

    vi.stubGlobal("AudioContext", MockAudioContext);

    let mediaMs = 1000;
    const observe = vi.fn(() => {
      events.push("observe");
    });
    const track = {
      readyState: "live",
      enabled: true,
      muted: false,
    } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
    } as unknown as MediaStream;

    const classifier = new SingingSignalClassifier();
    const stop = monitorSingingTrack(
      stream,
      () => mediaMs,
      observe,
      classifier,
    );

    // 1. Audible voice tick at +50ms establishes voiceLevel and lastVoice.
    mediaMs = 1050;
    vi.advanceTimersByTime(50);
    expect(observe).toHaveBeenLastCalledWith(1000, 1050, "voice");

    // 2. Silence for 350ms (>=300ms hold) yields "quiet" on the regular 50ms interval.
    currentAmplitude = 0;
    for (let step = 0; step < 7; step += 1) {
      mediaMs += 50;
      vi.advanceTimersByTime(50);
    }
    expect(observe).toHaveBeenCalledTimes(8);
    expect(observe).toHaveBeenLastCalledWith(1350, 1400, "quiet");

    // 3. Advance only 35ms (<50ms interval) and call stop(): must flush [1400, 1435] before teardown.
    mediaMs = 1435;
    vi.advanceTimersByTime(35);
    expect(observe).toHaveBeenCalledTimes(8);

    stop();
    expect(observe).toHaveBeenCalledTimes(9);
    expect(observe).toHaveBeenLastCalledWith(1400, 1435, "quiet");
    expect(events.lastIndexOf("observe")).toBeLessThan(
      events.indexOf("disconnect"),
    );
    expect(events.indexOf("disconnect")).toBeLessThan(events.indexOf("close"));

    // Duplicate stop() must be a no-op.
    mediaMs = 1470;
    stop();
    expect(observe).toHaveBeenCalledTimes(9);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reuses provided sharedContext without closing it on stop() and falls back when closed", () => {
    vi.useFakeTimers();
    const fallbackConstructed = vi.fn();
    const fallbackClose = vi.fn(async () => {});
    class FallbackAudioContext {
      state: AudioContextState = "running";
      constructor() {
        fallbackConstructed();
      }
      createMediaStreamSource = vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      createAnalyser = vi.fn(() => ({
        fftSize: 2048,
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn((out: Float32Array) => out.fill(0.04)),
      }));
      resume = vi.fn(async () => {});
      close = fallbackClose;
    }
    vi.stubGlobal("AudioContext", FallbackAudioContext);

    const sharedDisconnect = vi.fn();
    const sharedClose = vi.fn(async () => {});
    const sharedResume = vi.fn(async () => {});
    const sharedContext = {
      state: "running",
      createMediaStreamSource: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: sharedDisconnect,
      })),
      createAnalyser: vi.fn(() => ({
        fftSize: 2048,
        disconnect: sharedDisconnect,
        getFloatTimeDomainData: vi.fn((out: Float32Array) => out.fill(0.04)),
      })),
      resume: sharedResume,
      close: sharedClose,
    } as unknown as AudioContext;

    const track = {
      readyState: "live",
      enabled: true,
      muted: false,
    } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
    } as unknown as MediaStream;

    let mediaMs = 0;
    const observe = vi.fn();
    const stopShared = monitorSingingTrack(
      stream,
      () => mediaMs,
      observe,
      new SingingSignalClassifier(),
      sharedContext,
    );

    expect(fallbackConstructed).not.toHaveBeenCalled();
    expect(sharedResume).not.toHaveBeenCalled();
    mediaMs = 40;
    stopShared();
    expect(observe).toHaveBeenCalledWith(0, 40, "voice");
    expect(sharedDisconnect).toHaveBeenCalledTimes(2);
    expect(sharedClose).not.toHaveBeenCalled();

    // Closed sharedContext falls back to an owned context and closes it on stop().
    const closedContext = {
      state: "closed",
    } as unknown as AudioContext;
    const stopFallback = monitorSingingTrack(
      stream,
      () => mediaMs,
      observe,
      new SingingSignalClassifier(),
      closedContext,
    );
    expect(fallbackConstructed).toHaveBeenCalledOnce();
    stopFallback();
    expect(fallbackClose).toHaveBeenCalledOnce();
  });

  it("accepts a 280ms paint/GC jitter tick while rejecting >450ms wall freeze and >350ms media jump", () => {
    vi.useFakeTimers();
    let wallNow = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => wallNow);

    const sharedContext = {
      state: "running",
      createMediaStreamSource: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
      createAnalyser: vi.fn(() => ({
        fftSize: 2048,
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn((out: Float32Array) => out.fill(0.04)),
      })),
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as AudioContext;

    const track = {
      readyState: "live",
      enabled: true,
      muted: false,
    } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
    } as unknown as MediaStream;

    let mediaMs = 0;
    const observe = vi.fn();
    const stop = monitorSingingTrack(
      stream,
      () => mediaMs,
      observe,
      new SingingSignalClassifier(),
      sharedContext,
    );

    // 1. 280ms transient stall (<=350ms media, <=450ms wall) is accepted.
    wallNow = 1280;
    mediaMs = 280;
    vi.advanceTimersByTime(50);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenLastCalledWith(0, 280, "voice");

    // 2. >450ms wall freeze (460ms) is still rejected even when media delta is 50ms.
    wallNow = 1740;
    mediaMs = 330;
    vi.advanceTimersByTime(50);
    expect(observe).toHaveBeenCalledTimes(1);

    // 3. >350ms media jump (360ms) is still rejected even when wall delta is 50ms.
    wallNow = 1790;
    mediaMs = 690;
    vi.advanceTimersByTime(50);
    expect(observe).toHaveBeenCalledTimes(1);
    stop();

    // 4. LiveSingingAttempt.observeAudio accepts 280ms jitter ticks and rejects >350ms jumps.
    const attempt = new LiveSingingAttempt({
      format_version: 2,
      lines: [
        {
          id: "line-1",
          text: "bé",
          start_ms: 1000,
          end_ms: 2000,
          syllables: [],
        },
      ],
    });
    attempt.observeAudio(1000, 1280, "quiet");
    attempt.observeAudio(1280, 1630, "quiet");
    attempt.observeAudio(1630, 1980, "quiet");
    attempt.observeAudio(1980, 2000, "quiet");
    expect(attempt.settleThrough(2000)).toBe(true);
    expect(attempt.result().lineScores[0].words[0].state).toBe("omitted");

    const jumpRejected = new LiveSingingAttempt({
      format_version: 2,
      lines: [
        {
          id: "line-1",
          text: "bé",
          start_ms: 1000,
          end_ms: 1360,
          syllables: [],
        },
      ],
    });
    jumpRejected.observeAudio(1000, 1360, "quiet");
    expect(jumpRejected.settleThrough(1360)).toBe(false);
    expect(jumpRejected.result().lineScores[0].words[0].state).toBe("unknown");
  });
});
