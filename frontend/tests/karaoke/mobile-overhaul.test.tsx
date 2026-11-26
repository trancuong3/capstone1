import fs from "node:fs";
import path from "node:path";

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import { ButtonSizeProvider } from "@/components/common/button";
import { KaraokeControls } from "@/components/karaoke/karaoke-controls";
import { KaraokeLibraryScreen } from "@/components/karaoke/karaoke-library-screen";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import { KaraokeScoreCard } from "@/components/karaoke/karaoke-score-card";
import { ParentKaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";
import { SongCard } from "@/components/karaoke/song-card";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import {
  previewDetail,
  songId,
  stamp,
  syllableLyrics,
  versionId,
} from "@/test/karaoke-fixtures";
import type { KaraokePlayerController } from "@/hooks/use-karaoke-player";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "karaoke-mobile-test" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

class StageAudio extends EventTarget {
  src = "";
  preload = "";
  volume = 1;
  currentTime = 0;
  duration = 20;
  paused = true;
  ended = false;
  muted = false;
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
}

const childFixture = {
  id: versionId,
  parent_id: songId,
  alias: "Bé Nguyễn Hoàng Minh Khuê An Nhiên",
  grade: 2,
  settings: {},
  created_at: stamp,
};

describe("Karaoke M3.4 mobile overhaul", () => {
  const audios: StageAudio[] = [];

  beforeEach(() => {
    audios.length = 0;
    vi.stubGlobal(
      "Audio",
      class extends StageAudio {
        constructor() {
          super();
          audios.push(this);
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "SpeechRecognition",
      class {
        lang = "";
        continuous = false;
        interimResults = false;
        onstart: (() => void) | null = null;
        onresult: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onend: (() => void) | null = null;
        start = vi.fn();
        stop = vi.fn();
        abort = vi.fn();
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders KaraokeLibraryScreen with 640px 2-col grid, wrapping h1, and conflict-free submit button", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `/profiles/children/${childFixture.id}`) {
        return Response.json(childFixture);
      }
      if (url.pathname === "/karaoke/songs") {
        return Response.json({
          items: [
            {
              song_id: songId,
              version_id: versionId,
              title: "Bài hát kiểm thử",
              author: "Tác giả",
              min_grade: 1,
              max_grade: 5,
              duration_ms: 20000,
              cover_url: null,
            },
          ],
          total: 1,
          limit: 12,
          offset: 0,
        });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthRuntimeContext.Provider
        value={{
          mode: "supabase",
          status: "ready",
          session: {
            user: {
              id: songId,
              email: "parent@example.test",
              display_name: "Ba mẹ",
            },
            expires_at: null,
          },
          lastEvent: "SIGNED_IN",
          isPasswordRecovery: false,
          initializationFailure: null,
        }}
      >
        <AppServicesProvider>
          <AppStoreContext.Provider
            value={{
              selectedChildId: childFixture.id,
              validatedSelectedChild: childFixture,
              selectChild: vi.fn(),
              clearSelectedChild: vi.fn(),
              setValidatedSelectedChild: vi.fn(),
              syncAvailableChildren: vi.fn(),
            }}
          >
            <ButtonSizeProvider size="compact">
              <ParentKaraokeServicesProvider>
                <KaraokeLibraryScreen />
              </ParentKaraokeServicesProvider>
            </ButtonSizeProvider>
          </AppStoreContext.Provider>
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    const heading = await screen.findByRole("heading", {
      name: `Hát vui cùng ${childFixture.alias}`,
    });
    expect(heading).toHaveClass(
      "line-clamp-2",
      "break-words",
      "md:line-clamp-none",
    );
    expect(heading).not.toHaveClass("truncate");

    const submitBtn = screen.getByRole("button", { name: "Tìm bài hát" });
    expect(submitBtn).toHaveClass("w-full", "min-[640px]:w-auto", "min-h-12");
    expect(submitBtn).not.toHaveClass("min-h-11");

    const songLink = await screen.findByRole("link", {
      name: /Hát bài Bài hát kiểm thử/,
    });
    const grid = songLink.closest("div.grid");
    expect(grid).toHaveClass("min-[640px]:grid-cols-2", "lg:grid-cols-3");
  });

  it("preserves SongCard touch targets and clean long-title wrapping", () => {
    render(
      <SongCard
        song={{
          song_id: songId,
          version_id: versionId,
          title: "Bài hát rất dài để kiểm tra xuống dòng",
          author: "Nhạc sĩ Việt Nam",
          min_grade: 1,
          max_grade: 3,
          duration_ms: 15000,
          cover_url: null,
        }}
      />,
    );

    const summary = screen.getByText("Thông tin bài hát");
    expect(summary).toHaveClass("min-h-11");

    const link = screen.getByRole("link", { name: /Hát bài/ });
    expect(link).toHaveClass("min-h-12", "break-words");
    expect(link).toHaveStyle({ height: "auto" });
  });

  it("gives KaraokeStage headphones checkbox a full-bleed >=56px touch label while preserving checkbox role", () => {
    const source = { ...previewDetail(), lyrics: syllableLyrics() };
    render(
      <KaraokePlayer
        source={source}
        presentation="child"
        childAlias="Bé Tú"
        label="Hát cùng bé"
        onReload={vi.fn()}
      />,
    );
    act(() => audios[0].dispatchEvent(new Event("loadedmetadata")));

    const scoredBtn = screen.getByRole("button", { name: /Hát có chấm điểm/ });
    expect(scoredBtn).toHaveClass("min-h-12", "md:min-h-14");
    fireEvent.click(scoredBtn);

    const checkbox = screen.getByRole("checkbox", { name: /tai nghe/ });
    expect(checkbox).toHaveClass(
      "absolute",
      "inset-0",
      "size-full",
      "opacity-0",
    );
    const label = checkbox.closest("label");
    expect(label).toHaveClass("relative", "min-h-14");

    expect(audios[0].muted).toBe(true);
    fireEvent.click(checkbox);
    expect(audios[0].muted).toBe(false);
  });

  it("enforces min-h-11 on KaraokeScoreCard line accordion summary and min-[640px] on KaraokeControls", () => {
    const onPractice = vi.fn();
    render(
      <KaraokeScoreCard
        score={{
          kind: "whole",
          overallAccuracy: 85,
          matchedWords: 5,
          evaluatedWords: 6,
          totalWords: 6,
          lineScores: [
            {
              lineId: "l1",
              lineIndex: 0,
              lineText: "Bé hát vui",
              matchedWords: 3,
              evaluatedWords: 3,
              words: [],
            },
            {
              lineId: "l2",
              lineIndex: 1,
              lineText: "Bé đọc sách",
              matchedWords: 2,
              evaluatedWords: 3,
              words: [],
            },
          ],
        }}
        onPractice={onPractice}
      />,
    );

    expect(screen.getByText("Xem từng câu")).toHaveClass("min-h-11");
    expect(screen.getByTestId("karaoke-score-breakdown")).toHaveClass(
      "min-[640px]:text-sm",
    );

    const playerMock: KaraokePlayerController = {
      ready: true,
      playing: false,
      waiting: false,
      ended: false,
      error: "",
      currentMs: 0,
      volume: 0.6,
      rate: 1,
      loopPass: 0,
      segmentFinished: false,
      getCurrentMs: () => 0,
      play: vi.fn(async () => {}),
      pause: vi.fn(),
      seek: vi.fn(),
      setVolume: vi.fn(),
      setRate: vi.fn(),
      setMuted: vi.fn(),
    };
    render(<KaraokeControls player={playerMock} durationMs={20000} />);
    expect(screen.getByRole("button", { name: "Phát" })).toHaveClass(
      "w-full",
      "min-[640px]:w-auto",
    );
    expect(screen.getByLabelText("Âm lượng").closest("label")).toHaveClass(
      "min-[640px]:max-w-xs",
    );
  });

  it("contains zero legacy sm:, max-sm:, max-[639px]:, or max-[767px]: classes across karaoke sources", () => {
    const rootDir = path.resolve(process.cwd(), "components/karaoke");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|css)$/.test(entry.name)) files.push(full);
      }
    };
    walk(rootDir);

    const violations: string[] = [];
    const forbidden = /(?<![\w-])(sm:|max-sm:|max-\[639px\]:|max-\[767px\]:)/;
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      if (forbidden.test(content)) {
        violations.push(path.relative(process.cwd(), file));
      }
    }
    expect(violations).toEqual([]);
  });
});
