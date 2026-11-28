import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthRuntimeContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import { KaraokeLibraryScreen } from "@/components/karaoke/karaoke-library-screen";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import { KaraokePlayerScreen } from "@/components/karaoke/karaoke-player-screen";
import { KaraokeScoreCard } from "@/components/karaoke/karaoke-score-card";
import { ParentKaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";
import { SongCard } from "@/components/karaoke/song-card";
import { AppShell } from "@/components/layout/app-shell";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";
import type { KaraokePlayback } from "@/lib/api/karaoke-service";
import { clearUserCache } from "@/lib/cache/user-query-cache";
import type { LiveSingingScore } from "@/lib/karaoke/live-singing-score";
import {
  authSessionFixture,
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";
import {
  lineId,
  previewDetail,
  songId,
  stamp,
  syllableLyrics,
  versionId,
} from "@/test/karaoke-fixtures";

const navigationState = vi.hoisted(() => ({
  pathname: "/karaoke",
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
  useRouter: () => ({
    replace: navigationState.replace,
    push: navigationState.push,
    refresh: navigationState.refresh,
    prefetch: navigationState.prefetch,
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "karaoke-mobile-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

function installMatchMediaController(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.add(listener);
      },
      removeEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.delete(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => true,
    })),
  );

  return {
    setMobile(nextMatches: boolean) {
      matches = nextMatches;
      for (const listener of listeners) {
        listener({
          matches: nextMatches,
          media: "(max-width: 767px)",
        } as MediaQueryListEvent);
      }
    },
  };
}

class FakeAudio extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 20;
  volume = 1;
  preload = "";
  paused = true;
  ended = false;
  playbackRate = 1;
  preservesPitch = true;
  play = vi.fn(async () => {
    this.paused = false;
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

const audios: FakeAudio[] = [];

const childA = {
  id: versionId,
  parent_id: songId,
  alias: "Bé Hát",
  grade: 2,
  settings: {},
  created_at: stamp,
};

const auth: AuthRuntimeState = {
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

const songCardFixture = {
  song_id: songId,
  version_id: versionId,
  title: "Ngôi sao nhỏ",
  author: "Nhạc thiếu nhi",
  min_grade: 1,
  max_grade: 5,
  duration_ms: 20000,
  cover_url: null,
};

function makePlayback(): KaraokePlayback {
  const source = previewDetail();
  return {
    ...source,
    title: songCardFixture.title,
    lyrics: {
      format_version: 1,
      lines: source.lyrics.lines.map((line) => ({
        ...line,
        start_ms: line.start_ms!,
        end_ms: line.end_ms!,
      })),
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
        selectChild(childA.id);
        setReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [selectChild]);

  return <>{ready ? children : null}</>;
}

function KaraokeHarness({ children }: { children: ReactNode }) {
  return (
    <AuthRuntimeContext.Provider value={auth}>
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

function AppShellKaraokeHarness({
  authService,
  children,
}: {
  authService: ReturnType<typeof createAuthServiceFixture>;
  children: ReactNode;
}) {
  return withAuthFixture(
    <AppServicesProvider>
      <AppStoreProvider initialChildId={childA.id}>
        <ParentKaraokeServicesProvider>
          <AppShell>{children}</AppShell>
        </ParentKaraokeServicesProvider>
      </AppStoreProvider>
    </AppServicesProvider>,
    authService,
    {
      session: {
        user: {
          id: songId,
          email: "parent@example.test",
          display_name: "Ba mẹ",
        },
        expires_at: null,
      },
    },
  );
}

describe("Karaoke Library & Player Mobile UI (< 768px)", () => {
  beforeEach(() => {
    navigationState.pathname = "/karaoke";
    clearUserCache();
    window.sessionStorage.clear();
    window.localStorage.clear();
    audios.length = 0;
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/profiles/dashboard-summary") {
          return Response.json({
            profile: {
              id: authSessionFixture.user.id,
              display_name: "Ba mẹ",
              role: "parent",
              created_at: stamp,
              email: "parent@example.test",
              contact_phone: null,
              pending_email: null,
              email_verified: true,
              contact_info_status: "available",
              children: [],
            },
            children: [childA],
            latest_sessions_by_child: {},
            source: "dashboard-summary",
          });
        }
        if (url.pathname === `/profiles/children/${childA.id}`) {
          return Response.json(childA);
        }
        if (url.pathname === "/karaoke/songs") {
          return Response.json({
            items: [songCardFixture],
            total: 1,
            limit: 12,
            offset: 0,
          });
        }
        if (url.pathname.endsWith("/playback")) {
          return Response.json(makePlayback());
        }
        if (url.pathname.includes("/musical-profile")) {
          return new Response(null, { status: 404 });
        }
        if (url.pathname.includes("/practice-sessions")) {
          return Response.json({
            best_full_song_score: null,
            best_full_song_stars: 0,
            total_sessions: 0,
            sessions: [],
          });
        }
        throw new Error(`Unexpected path: ${url.pathname}`);
      }),
    );
  });

  afterEach(() => {
    clearUserCache();
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("omits .song-cover on mobile SongCard while preserving desktop .song-cover and break-words CTA", () => {
    const media = installMatchMediaController(true);
    const { container } = render(<SongCard song={songCardFixture} />);

    const cardEl = container.firstElementChild;
    expect(cardEl).not.toBeNull();
    expect(cardEl?.className).not.toContain("song-cover");
    expect(cardEl?.className).toContain("shadow-sm");

    const cta = screen.getByRole("link", {
      name: `Hát bài ${songCardFixture.title}`,
    });
    expect(cta.className).toContain("min-h-12");
    expect(cta.className).toContain("break-words");

    act(() => {
      media.setMobile(false);
    });
    expect(cardEl?.className).toContain("song-cover");
  });

  it("enforces >= 44px touch targets and removes double pb-24 clearance in KaraokeLibraryScreen on mobile", async () => {
    installMatchMediaController(true);
    const { container } = render(
      <KaraokeHarness>
        <KaraokeLibraryScreen />
      </KaraokeHarness>,
    );

    await screen.findByRole("heading", { name: songCardFixture.title });

    const section = container.querySelector("section");
    expect(section?.className).toContain("pb-4");
    expect(section?.className).not.toContain("pb-24");

    const backLink = screen.getByRole("link", { name: "Về Tổng quan" });
    expect(backLink.className).toContain("min-h-11");
    expect(backLink.className).not.toContain("min-h-10");

    const searchBtn = screen.getByRole("button", { name: "Tìm bài hát" });
    expect(searchBtn.className).toContain("min-h-11");
  });

  it("dispatches viread:immersive-mode { active: true } on mobile KaraokePlayerScreen with compact header and cleans up on unmount", async () => {
    const media = installMatchMediaController(true);
    const events: boolean[] = [];
    const listener = (event: Event) => {
      const custom = event as CustomEvent<{ active?: boolean }>;
      events.push(Boolean(custom.detail?.active));
    };
    window.addEventListener("viread:immersive-mode", listener);

    const { unmount } = render(
      <KaraokeHarness>
        <KaraokePlayerScreen songId={songId} expectedVersionId={versionId} />
      </KaraokeHarness>,
    );

    const backToLib = await screen.findByRole("link", {
      name: "Về thư viện bài hát",
    });
    expect(backToLib.className).toContain("min-h-11");
    expect(backToLib.className).toContain("w-auto");
    // Compact mobile pill replaces bulky SelectedChildIdentity card
    expect(screen.getByText("Bé Hát · Lớp 2")).toBeInTheDocument();
    expect(screen.queryByText(/Đang chọn bé:/)).toBeNull();

    await waitFor(() => {
      expect(events.at(-1)).toBe(true);
    });

    // Switching to desktop restores SelectedChildIdentity and turns off mobile immersive mode
    act(() => {
      media.setMobile(false);
    });
    await waitFor(() => {
      expect(events.at(-1)).toBe(false);
    });

    unmount();
    expect(events.at(-1)).toBe(false);
    window.removeEventListener("viread:immersive-mode", listener);
  });

  it("keeps KaraokeStage controls >= 44px in a 2-col mobile grid, preserves inline <details>, and keeps KaraokeScoreCard summary >= 44px", () => {
    installMatchMediaController(true);
    const source = {
      ...previewDetail(),
      lyrics: syllableLyrics(),
      author: "Nhạc thiếu nhi",
    };

    render(
      <KaraokePlayer
        source={source}
        presentation="child"
        childAlias="Bé Tú"
        label="Hát cùng bé"
        onReload={vi.fn()}
      />,
    );
    act(() => {
      audios[0]?.dispatchEvent(new Event("loadedmetadata"));
    });

    const modeGroup = screen.getByRole("group", { name: "Chế độ hát" });
    expect(modeGroup.className).toContain("grid-cols-2");
    const freeBtn = screen.getByRole("button", { name: "Hát tự do" });
    expect(freeBtn.className).toContain("min-h-11");
    expect(freeBtn.className).toContain("w-auto");

    const practiceGroup = screen.getByRole("group", { name: "Kiểu luyện hát" });
    expect(practiceGroup.className).toContain("grid-cols-2");
    for (const label of [
      "Hát cả bài",
      "Luyện đoạn khó",
      "Tập từng câu",
      "Gõ nhịp theo bài hát",
    ]) {
      const btn = screen.getByRole("button", { name: label });
      expect(btn.className).toContain("min-h-11");
    }

    // Inline collapsible <details> remain accessible without modal backdrop
    expect(
      screen.getByText("Chọn câu để luyện").closest("summary")?.className,
    ).toContain("min-h-11");
    expect(
      screen.getByText("Âm lượng và thông tin bài hát").closest("summary")
        ?.className,
    ).toContain("min-h-11");

    // KaraokeScoreCard summary target >= 44px
    const sampleScore: LiveSingingScore = {
      kind: "whole",
      overallAccuracy: 85,
      matchedWords: 5,
      evaluatedWords: 6,
      totalWords: 6,
      lineScores: [
        {
          lineId: lineId,
          lineIndex: 0,
          lineText: "Bé hát, vui!",
          matchedWords: 3,
          evaluatedWords: 3,
          words: [],
        },
        {
          lineId: "line-2",
          lineIndex: 1,
          lineText: "Em vui đến trường",
          matchedWords: 2,
          evaluatedWords: 3,
          words: [],
        },
      ],
    };
    render(<KaraokeScoreCard score={sampleScore} onPractice={vi.fn()} />);
    expect(
      screen.getByText("Xem từng câu").closest("summary")?.className,
    ).toContain("min-h-11");

    fireEvent.click(screen.getByText("Xem từng câu"));
    expect(screen.getByText("Em vui đến trường")).toBeVisible();
  });

  it("hides AppShell parent-topbar and unmounts MobileBottomNav on initial mobile mount of /karaoke/[songId]", async () => {
    installMatchMediaController(true);
    navigationState.pathname = `/karaoke/${songId}`;
    const authService = createAuthServiceFixture();

    const { container } = render(
      <AppShellKaraokeHarness authService={authService}>
        <KaraokePlayerScreen songId={songId} expectedVersionId={versionId} />
      </AppShellKaraokeHarness>,
    );

    await screen.findByRole("link", { name: "Về thư viện bài hát" });

    await waitFor(() => {
      const topbar = container.querySelector("header.parent-topbar");
      expect(topbar).not.toBeNull();
      expect(topbar?.className).toContain("hidden");
      expect(topbar?.className).toContain("xl:block");
      expect(screen.queryByTestId("mobile-bottom-nav")).toBeNull();
    });
  });

  it("hides AppShell parent-topbar and MobileBottomNav across client-side navigation /karaoke -> /karaoke/[songId] on mobile and restores on return", async () => {
    installMatchMediaController(true);
    navigationState.pathname = "/karaoke";
    const authService = createAuthServiceFixture();

    const { container, rerender } = render(
      <AppShellKaraokeHarness authService={authService}>
        <KaraokeLibraryScreen />
      </AppShellKaraokeHarness>,
    );

    await screen.findByRole("heading", { name: songCardFixture.title });
    expect(
      container.querySelector("header.parent-topbar")?.className,
    ).not.toContain("hidden");
    expect(screen.getByTestId("mobile-bottom-nav")).toBeInTheDocument();

    navigationState.pathname = `/karaoke/${songId}`;
    rerender(
      <AppShellKaraokeHarness authService={authService}>
        <KaraokePlayerScreen songId={songId} expectedVersionId={versionId} />
      </AppShellKaraokeHarness>,
    );

    await screen.findByRole("link", { name: "Về thư viện bài hát" });

    await waitFor(() => {
      const topbar = container.querySelector("header.parent-topbar");
      expect(topbar?.className).toContain("hidden");
      expect(topbar?.className).toContain("xl:block");
      expect(screen.queryByTestId("mobile-bottom-nav")).toBeNull();
    });

    navigationState.pathname = "/karaoke";
    rerender(
      <AppShellKaraokeHarness authService={authService}>
        <KaraokeLibraryScreen />
      </AppShellKaraokeHarness>,
    );

    await screen.findByRole("heading", { name: songCardFixture.title });
    await waitFor(() => {
      expect(
        container.querySelector("header.parent-topbar")?.className,
      ).not.toContain("hidden");
      expect(screen.getByTestId("mobile-bottom-nav")).toBeInTheDocument();
    });
  });

  it("keeps AppShell parent-topbar and navigation intact on desktop (1440px) for /karaoke/[songId]", async () => {
    installMatchMediaController(false);
    navigationState.pathname = "/karaoke";
    const authService = createAuthServiceFixture();

    const { container, rerender } = render(
      <AppShellKaraokeHarness authService={authService}>
        <KaraokeLibraryScreen />
      </AppShellKaraokeHarness>,
    );

    await screen.findByRole("heading", { name: songCardFixture.title });

    navigationState.pathname = `/karaoke/${songId}`;
    rerender(
      <AppShellKaraokeHarness authService={authService}>
        <KaraokePlayerScreen songId={songId} expectedVersionId={versionId} />
      </AppShellKaraokeHarness>,
    );

    await screen.findByRole("link", { name: "Về thư viện bài hát" });

    const topbar = container.querySelector("header.parent-topbar");
    expect(topbar).not.toBeNull();
    expect(topbar?.className).not.toContain("hidden");
    expect(container.querySelector(".parent-nav-links")).not.toBeNull();
    expect(screen.getByTestId("mobile-bottom-nav")).toBeInTheDocument();
  });
});
