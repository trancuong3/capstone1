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
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";
import { ParentKaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";
import { KaraokeLibraryScreen } from "@/components/karaoke/karaoke-library-screen";
import { KaraokePlayerScreen } from "@/components/karaoke/karaoke-player-screen";
import { SongCard } from "@/components/karaoke/song-card";
import {
  previewDetail,
  songId,
  versionId,
  lineId,
  stamp,
} from "@/test/karaoke-fixtures";
import type { KaraokePlayback } from "@/lib/api/karaoke-service";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "karaoke-unit-test" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));
const childA = {
  id: versionId,
  parent_id: songId,
  alias: "Bé Hát",
  grade: 2,
  settings: {},
  created_at: stamp,
};
const childB = { ...childA, id: lineId, alias: "Bé Khác", grade: 3 };
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
const card = {
  song_id: songId,
  version_id: versionId,
  title: "Bài hát thật từ API",
  author: "Tác giả",
  min_grade: 1,
  max_grade: 5,
  duration_ms: 20000,
  cover_url: null,
};
function playback(): KaraokePlayback {
  const source = previewDetail();
  return {
    ...source,
    title: card.title,
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
const audios: FakeAudio[] = [];
class FakeAudio extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 20;
  volume = 1;
  preload = "";
  paused = true;
  ended = false;
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
const fetchMock = vi.fn<typeof fetch>();
function response(input: RequestInfo | URL) {
  const url = new URL(String(input));
  if (url.pathname === `/profiles/children/${childA.id}`)
    return Response.json(childA);
  if (url.pathname === `/profiles/children/${childB.id}`)
    return Response.json(childB);
  if (url.pathname === "/karaoke/songs")
    return Response.json({ items: [card], total: 1, limit: 12, offset: 0 });
  if (url.pathname.endsWith("/playback")) return Response.json(playback());
  throw new Error(`Unexpected isolated path ${url.pathname}`);
}
function Seed({
  children,
  initialId,
}: {
  children: ReactNode;
  initialId: string | null;
}) {
  const { selectChild, clearSelectedChild } = useAppStore();
  const [ready, setReady] = useState(!initialId);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) {
        if (initialId) selectChild(initialId);
        setReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [initialId, selectChild]);
  return (
    <>
      <button onClick={() => selectChild(childB.id)}>Đổi bé kiểm thử</button>
      <button onClick={clearSelectedChild}>Bỏ chọn bé kiểm thử</button>
      {ready && children}
    </>
  );
}
function Harness({
  children,
  runtime = auth,
  initialId = childA.id,
}: {
  children: ReactNode;
  runtime?: AuthRuntimeState;
  initialId?: string | null;
}) {
  return (
    <AuthRuntimeContext.Provider value={runtime}>
      <AppServicesProvider>
        <AppStoreProvider>
          <Seed initialId={initialId}>
            <ParentKaraokeServicesProvider>
              {children}
            </ParentKaraokeServicesProvider>
          </Seed>
        </AppStoreProvider>
      </AppServicesProvider>
    </AuthRuntimeContext.Provider>
  );
}
beforeEach(() => {
  replace.mockReset();
  audios.length = 0;
  fetchMock.mockReset().mockImplementation(async (input) => response(input));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function karaokeCalls() {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("/karaoke/"),
  );
}

describe("parent karaoke library with real guards and HTTP adapters", () => {
  it("requires a selected child, ignoring any URL-supplied child", async () => {
    render(
      <Harness initialId={null}>
        <KaraokeLibraryScreen />
      </Harness>,
    );
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "/dashboard?focus=child-selection&reason=missing",
      ),
    );
    expect(karaokeCalls()).toHaveLength(0);
  });
  it("waits for auth and never requests child content when signed out", async () => {
    const { rerender } = render(
      <Harness runtime={{ ...auth, status: "initializing", session: null }}>
        <KaraokeLibraryScreen />
      </Harness>,
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Đang kiểm tra phiên",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(
      <Harness runtime={{ ...auth, session: null, lastEvent: null }}>
        <KaraokeLibraryScreen />
      </Harness>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Đang kiểm tra phiên");
    expect(replace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(
      <Harness runtime={{ ...auth, session: null, lastEvent: "SIGNED_OUT" }}>
        <KaraokeLibraryScreen />
      </Harness>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(karaokeCalls()).toHaveLength(0);
  });
  it("validates ownership before fetching catalog and binds links to published version", async () => {
    render(
      <Harness>
        <KaraokeLibraryScreen />
      </Harness>,
    );
    expect(
      await screen.findByRole("heading", { name: card.title }),
    ).toBeInTheDocument();
    const calls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(calls[0].pathname).toBe(`/profiles/children/${childA.id}`);
    expect(calls[1].searchParams.get("child_id")).toBe(childA.id);
    expect(
      screen.getByRole("link", { name: `Hát bài ${card.title}` }),
    ).toHaveAttribute("href", `/karaoke/${songId}?version=${versionId}`);
    expect(audios).toHaveLength(0);
  });
  it("clears a foreign/deleted selection without ever loading songs", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ detail: "private ownership data" }, { status: 403 }),
    );
    render(
      <Harness>
        <KaraokeLibraryScreen />
      </Harness>,
    );
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "/dashboard?focus=child-selection&reason=invalid",
      ),
    );
    expect(karaokeCalls()).toHaveLength(0);
    expect(
      screen.queryByText("private ownership data"),
    ).not.toBeInTheDocument();
  });
  it("distinguishes empty catalog from failed fetch and retries safely", async () => {
    let failed = true;
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("/karaoke/songs")
        ? failed
          ? Response.json({ detail: "private token" }, { status: 503 })
          : Response.json({ items: [], total: 0, limit: 12, offset: 0 })
        : response(input),
    );
    render(
      <Harness>
        <KaraokeLibraryScreen />
      </Harness>,
    );
    await screen.findByText("Chưa tải được thư viện");
    expect(
      screen.queryByText("Chưa có bài hát phù hợp"),
    ).not.toBeInTheDocument();
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Thử lại thư viện" }));
    await screen.findByRole("heading", { name: "Chưa có bài hát phù hợp" });
    expect(screen.queryByText("private token")).not.toBeInTheDocument();
  });
  it("searches on submit and uses real server pagination", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("/karaoke/songs")
        ? Response.json({
            items: [card],
            total: 20,
            limit: 12,
            offset: Number(new URL(String(input)).searchParams.get("offset")),
          })
        : response(input),
    );
    render(
      <Harness>
        <KaraokeLibraryScreen />
      </Harness>,
    );
    await screen.findByRole("heading", { name: card.title });
    fireEvent.change(screen.getByLabelText("Tìm bài hát hoặc tác giả"), {
      target: { value: "Bé & bạn" },
    });
    expect(karaokeCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Tìm bài hát" }));
    await screen.findByRole("heading", { name: card.title });
    expect(
      new URL(String(karaokeCalls().at(-1)![0])).searchParams.get("search"),
    ).toBe("Bé & bạn");
    fireEvent.click(screen.getByRole("button", { name: "Trang sau" }));
    await screen.findByRole("heading", { name: card.title });
    expect(
      new URL(String(karaokeCalls().at(-1)![0])).searchParams.get("offset"),
    ).toBe("12");
  });
  it("aborts old-child catalog and ignores late data after switching", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname !== "/karaoke/songs") return response(input);
      if (url.searchParams.get("child_id") === childA.id)
        return new Promise<Response>((done) => {
          release = done;
        });
      return Response.json({
        items: [{ ...card, title: "Bài của bé mới" }],
        total: 1,
        limit: 12,
        offset: 0,
      });
    });
    render(
      <Harness>
        <KaraokeLibraryScreen />
      </Harness>,
    );
    await waitFor(() => expect(karaokeCalls()).toHaveLength(1));
    const oldSignal = karaokeCalls()[0][1]!.signal!;
    fireEvent.click(screen.getByRole("button", { name: "Đổi bé kiểm thử" }));
    await screen.findByRole("heading", { name: "Bài của bé mới" });
    expect(oldSignal.aborted).toBe(true);
    await act(async () =>
      release(Response.json({ items: [card], total: 1, limit: 12, offset: 0 })),
    );
    expect(
      screen.queryByRole("heading", { name: card.title }),
    ).not.toBeInTheDocument();
  });
  it("uses a safe icon after the optional cover fails", () => {
    render(
      <SongCard
        song={{ ...card, cover_url: "https://media.example.test/cover.png" }}
      />,
    );
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveTextContent(card.title);
  });
});

describe("parent karaoke playback", () => {
  it("waits for explicit play, follows native time, shows end/replay", async () => {
    render(
      <Harness>
        <KaraokePlayerScreen songId={songId} expectedVersionId={versionId} />
      </Harness>,
    );
    await screen.findByRole("heading", { name: card.title });
    await waitFor(() => expect(audios).toHaveLength(1));
    expect(audios[0].play).not.toHaveBeenCalled();
    act(() => audios[0].dispatchEvent(new Event("loadedmetadata")));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Bắt đầu hát" }));
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    vi.useRealTimers();
    act(() => {
      audios[0].currentTime = 1.5;
      audios[0].dispatchEvent(new Event("timeupdate"));
    });
    expect(screen.getByText("Câu đang hát")).toBeInTheDocument();
    expect(screen.getByTestId("karaoke-active-line")).toHaveTextContent(
      "Em vui đến trường",
    );
    act(() => {
      audios[0].currentTime = 20;
      audios[0].ended = true;
      audios[0].paused = true;
      audios[0].dispatchEvent(new Event("ended"));
    });
    expect(
      screen.getByRole("heading", { name: "Bé Hát đã hát xong rồi!" }),
    ).toBeInTheDocument();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Hát lại bài này" }));
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    vi.useRealTimers();
    expect(audios[0].currentTime).toBe(0);
    expect(
      karaokeCalls().every(([, options]) => options?.method === "GET"),
    ).toBe(true);
  });
  it("disposes audio synchronously when auth is lost or child changes", async () => {
    const { rerender } = render(
      <Harness>
        <KaraokePlayerScreen songId={songId} />
      </Harness>,
    );
    await screen.findByRole("heading", { name: card.title });
    await waitFor(() => expect(audios).toHaveLength(1));
    const first = audios[0];
    fireEvent.click(screen.getByRole("button", { name: "Đổi bé kiểm thử" }));
    expect(first.src).toBe("");
    expect(first.pause).toHaveBeenCalled();
    await screen.findByRole("heading", { name: card.title });
    await waitFor(() => expect(audios).toHaveLength(2));
    const second = audios.at(-1)!;
    rerender(
      <Harness runtime={{ ...auth, session: null, lastEvent: "SIGNED_OUT" }}>
        <KaraokePlayerScreen songId={songId} />
      </Harness>,
    );
    expect(second.src).toBe("");
    expect(second.pause).toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: "Hát cùng bé" }),
    ).not.toBeInTheDocument();
  });
  it("requires explicit approval for a new published version", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/playback")) return response(input);
      if (url.searchParams.get("expected_version_id") === versionId)
        return Response.json({ detail: "Changed" }, { status: 409 });
      return Response.json({ ...playback(), version_id: lineId });
    });
    render(
      <Harness>
        <KaraokePlayerScreen songId={songId} expectedVersionId={versionId} />
      </Harness>,
    );
    await screen.findByRole("button", { name: "Tải phiên bản mới" });
    expect(karaokeCalls()).toHaveLength(1);
    expect(audios).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Tải phiên bản mới" }));
    await screen.findByRole("heading", { name: card.title });
    await waitFor(() => expect(audios).toHaveLength(1));
    expect(audios[0].play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Âm lượng và thông tin bài hát"));
    fireEvent.click(screen.getByRole("button", { name: "Tải lại nhạc" }));
    await screen.findByRole("heading", { name: card.title });
    expect(
      new URL(String(karaokeCalls().at(-1)![0])).searchParams.get(
        "expected_version_id",
      ),
    ).toBe(lineId);
  });
  it("binds renewed audio to the loaded version even when opened without a version", async () => {
    render(
      <Harness>
        <KaraokePlayerScreen songId={songId} />
      </Harness>,
    );
    await screen.findByRole("heading", { name: card.title });
    await waitFor(() => expect(audios).toHaveLength(1));
    const old = audios[0];
    fireEvent.click(screen.getByText("Âm lượng và thông tin bài hát"));
    fireEvent.click(screen.getByRole("button", { name: "Tải lại nhạc" }));
    expect(old.src).toBe("");
    await screen.findByRole("heading", { name: card.title });
    await waitFor(() => expect(audios).toHaveLength(2));
    expect(
      new URL(String(karaokeCalls().at(-1)![0])).searchParams.get(
        "expected_version_id",
      ),
    ).toBe(versionId);
    expect(audios.at(-1)!.play).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 503])(
    "does not create audio for unavailable playback HTTP %d",
    async (status) => {
      fetchMock.mockImplementation(async (input) =>
        String(input).includes("/playback")
          ? Response.json({ detail: "private SQL/token" }, { status })
          : response(input),
      );
      render(
        <Harness>
          <KaraokePlayerScreen songId={songId} />
        </Harness>,
      );
      await screen.findByText("Chưa mở được bài hát");
      expect(audios).toHaveLength(0);
      expect(screen.queryByText("private SQL/token")).not.toBeInTheDocument();
    },
  );
});
