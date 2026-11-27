import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { installApiFixture, setRole, child, ids } from "./real-data-fixture";
import { lyricsSchema } from "../../types/karaoke";
import {
  previewDetail,
  songId,
  versionId,
  lineId,
  syllableLyrics,
} from "../karaoke-fixtures";

// Browser-only synthetic media; never imported by runtime or sent to Supabase.
function wav() {
  const rate = 8000,
    seconds = 20,
    bytes = Buffer.alloc(44 + rate * seconds * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
test.beforeAll(async ({ request }) => {
  // Compile these new routes before navigating with an in-memory child selection.
  for (const path of ["/karaoke", `/karaoke/${songId}?version=${versionId}`]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
  }
});
async function fixture(
  page: Page,
  media = { bytes: wav(), contentType: "audio/wav", durationMs: 20000 },
) {
  const base = await installApiFixture(page);
  const state = {
    fail: false,
    empty: false,
    conflict: false,
    title: "Bài hát do admin xuất bản",
    requests: [] as string[],
    unexpected: [] as string[],
    lyrics: previewDetail().lyrics,
    author: "Tác giả",
  };
  await page.context().route("https://media.example.test/**", (route) => {
    const { bytes, contentType } = media;
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers().range ?? "",
    );
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(bytes.length - 1, Number(range[2]))
      : bytes.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType,
      body: bytes.subarray(start, end + 1),
      headers: {
        "access-control-allow-origin": "*",
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${bytes.length}` }
          : {}),
      },
    });
  });
  async function respond(route: Route, json: unknown, status = 200) {
    await route.fulfill({
      status,
      contentType: "application/json",
      headers: {
        "access-control-allow-origin": "http://127.0.0.1:3106",
        "access-control-allow-headers": "authorization,content-type,accept",
        "access-control-allow-methods": "GET,OPTIONS",
      },
      body: status === 204 ? undefined : JSON.stringify(json),
    });
  }
  await page
    .context()
    .route("http://127.0.0.1:8000/karaoke/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (request.method() === "OPTIONS") return respond(route, null, 204);
      if (
        request.method() === "GET" &&
        /^\/karaoke\/songs\/[^/]+\/musical-profile$/.test(url.pathname)
      ) {
        return respond(route, {
          song_id: songId,
          song_version_id: versionId,
          bpm: 108,
          audio_type: "VOCAL_FULL",
          has_pitch_contour: false,
          has_beat_grid: true,
          source_method: "LYRICS_TIMING",
          beat_grid_ms: [0, 500, 1000, 1500],
          pitch_contour: [],
          phrase_windows: [],
          updated_at: "2026-10-08T00:00:00Z",
        });
      }
      if (url.pathname === "/karaoke/practice-sessions") {
        if (request.method() === "GET") {
          return respond(route, {
            child_id: url.searchParams.get("child_id") ?? ids.child,
            song_id: url.searchParams.get("song_id") ?? songId,
            best_full_song_score: null,
            best_full_song_stars: 0,
            total_sessions: 0,
            items: [],
            storage_ready: true,
          });
        }
        if (request.method() === "POST") {
          const payload = (request.postDataJSON() ?? {}) as Record<
            string,
            unknown
          >;
          return respond(
            route,
            {
              id: "99999999-9999-4999-8999-999999999991",
              child_id: payload.child_id ?? ids.child,
              song_id: payload.song_id ?? songId,
              song_version_id: versionId,
              practice_mode: payload.practice_mode ?? "FULL_SONG",
              scoring_mode: payload.scoring_mode ?? "LYRICS_ONLY",
              playback_rate: Number(payload.playback_rate ?? 1),
              headphone_mode: Boolean(payload.headphone_mode),
              overall_score: (payload.overall_score as number | null) ?? null,
              rhythm_score: (payload.rhythm_score as number | null) ?? null,
              pitch_score: (payload.pitch_score as number | null) ?? null,
              lyrics_score: (payload.lyrics_score as number | null) ?? null,
              fluency_score: (payload.fluency_score as number | null) ?? null,
              stars: Number(payload.stars ?? 0),
              segment_start_ms: null,
              segment_end_ms: null,
              report_payload:
                (payload.report_payload as Record<string, unknown>) ?? {},
              created_at: "2026-10-08T00:00:00Z",
              persisted: true,
            },
            201,
          );
        }
      }
      expect(request.method()).toBe("GET");
      expect(request.headers().authorization).toMatch(/^Bearer /);
      expect(url.searchParams.get("child_id")).toBe(ids.child);
      state.requests.push(url.pathname + url.search);
      if (state.fail)
        return respond(route, { detail: "private database token" }, 503);
      if (url.pathname === "/karaoke/songs") {
        const card = {
          song_id: songId,
          version_id: versionId,
          title: state.title,
          author: state.author,
          duration_ms: media.durationMs,
          min_grade: 1,
          max_grade: 3,
          cover_url: null,
        };
        return respond(route, {
          items: state.empty ? [] : [card],
          total: state.empty ? 0 : 1,
          limit: 12,
          offset: 0,
        });
      }
      if (url.pathname === `/karaoke/songs/${songId}/playback`) {
        if (
          state.conflict &&
          url.searchParams.get("expected_version_id") === versionId
        )
          return respond(route, { detail: "Changed" }, 409);
        const { revision, ...source } = previewDetail();
        expect(revision).toBe(1);
        return respond(route, {
          ...source,
          title: state.title,
          author: state.author,
          duration_ms: media.durationMs,
          version_id: state.conflict ? lineId : versionId,
          lyrics: state.lyrics,
        });
      }
      state.unexpected.push(request.url());
      return respond(route, {}, 404);
    });
  return { state, base };
}
async function enter(page: Page) {
  await page.goto("/dashboard");
  await page
    .getByRole("button", { name: `${child.alias}, lớp ${child.grade}` })
    .click();
  await page
    .getByRole("button", { name: "Trò chơi và âm nhạc", exact: true })
    .click();
  await expect(page).toHaveURL(/\/entertainment$/);
  await page.getByRole("link", { name: "Mở thư viện bài hát" }).click();
  await expect(page).toHaveURL(/\/karaoke$/);
  const mobileBottomNav = page.getByTestId("mobile-bottom-nav");
  if (await mobileBottomNav.isVisible()) {
    await mobileBottomNav.getByRole("button", { name: /Thêm/ }).click();
    const sheet = page.getByRole("dialog", { name: "Tính năng khác" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("link", { name: /Giải trí/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await sheet.getByRole("button", { name: /Đóng/ }).click();
  } else {
    await expect(
      page.getByRole("link", { name: "Giải trí", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

test("Ngôi sao nhỏ highlights the current v2 syllable while seeking and with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    const audios: HTMLAudioElement[] = [];
    Object.defineProperty(window, "__karaokeProbe", { value: audios });
    window.Audio = new Proxy(NativeAudio, {
      construct(target, args) {
        const audio = Reflect.construct(target, args) as HTMLAudioElement;
        audios.push(audio);
        return audio;
      },
    });
  });
  const demo = new URL("../../../docs/karaoke-demo/", import.meta.url);
  const { state } = await fixture(page, {
    bytes: readFileSync(new URL("ngoi-sao-nho.mp3", demo)),
    contentType: "audio/mpeg",
    durationMs: 103366,
  });
  state.title = "Ngôi sao nhỏ";
  state.lyrics = lyricsSchema.parse(
    JSON.parse(readFileSync(new URL("ngoi-sao-nho-v2.json", demo), "utf8")),
  );
  await enter(page);
  await page
    .getByRole("link", { name: `Hát bài ${state.title}`, exact: true })
    .click();
  const seek = page.getByRole("slider", { name: "Vị trí phát" });
  await expect(seek).toBeEnabled();
  await page.getByRole("combobox", { name: "Tốc độ hát" }).selectOption("0.75");
  await page.getByRole("button", { name: "Bắt đầu hát", exact: true }).click();
  await page.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __karaokeProbe: HTMLAudioElement[] }
          ).__karaokeProbe.at(-1)!.seekable.length,
      ),
    )
    .toBeGreaterThan(0);
  const seekTo = async (value: number) => {
    await seek.evaluate((node, value) => {
      (node as HTMLInputElement).value = String(value - 1);
    }, value);
    await seek.press("ArrowRight");
    await expect(seek).toHaveValue(String(value));
  };
  await seekTo(1417);
  const active = page.locator(
    '[data-testid="karaoke-active-line"] [data-state="active"]',
  );
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute(
    "data-syllable-id",
    state.lyrics.lines[0].syllables![1].id,
  );
  await expect(active).toHaveCSS("--karaoke-fill", "50%");
  await expect(active).toHaveCSS("background-color", "rgb(255, 230, 109)");
  await expect(active).toHaveCSS("transform", "matrix(1.08, 0, 0, 1.08, 0, 0)");
  await seekTo(150);
  await expect(active).toHaveCount(0);
  await seekTo(6937);
  await expect(active).toHaveAttribute(
    "data-syllable-id",
    state.lyrics.lines[1].syllables![1].id,
  );
  await expect(active).toHaveCSS("--karaoke-fill", "50%");
  await page.getByRole("button", { name: "Mở rộng màn hát" }).click();
  await expect(
    page.getByRole("button", { name: "Thu gọn màn hát" }),
  ).toBeVisible();
  await expect(active).toHaveCSS("transform", "matrix(1.08, 0, 0, 1.08, 0, 0)");
  await noOverflow(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(active).toHaveCSS("background-color", "rgb(255, 230, 109)");
  await expect(active).toHaveCSS("transform", "none");
  await expect(active.locator('[aria-hidden="true"]')).toHaveCSS(
    "clip-path",
    "none",
  );
  await noOverflow(page);
  await page.screenshot({
    path: test.info().outputPath("karaoke-syllable-player.png"),
    fullPage: true,
  });
});

test("a maximum-length title keeps the singing action readable on mobile", async ({
  page,
}) => {
  const { state } = await fixture(page);
  state.title = "Ngôi sao nhỏ cùng bé ca hát ".repeat(10).slice(0, 200).trim();
  await enter(page);
  const action = page.getByRole("link", {
    name: `Hát bài ${state.title}`,
    exact: true,
  });
  await expect(action).toBeVisible();
  expect(
    await action.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return text.top >= box.top && text.bottom <= box.bottom;
    }),
  ).toBe(true);
  await noOverflow(page);
});
test("dashboard → selected child → library → native player → leave stops audio", async ({
  page,
}, info) => {
  const { state, base } = await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    Object.defineProperty(window, "__karaokeAudios", { value: [] });
    window.Audio = new Proxy(NativeAudio, {
      construct(target, args) {
        const audio = Reflect.construct(target, args) as HTMLAudioElement;
        (
          window as unknown as { __karaokeAudios: HTMLAudioElement[] }
        ).__karaokeAudios.push(audio);
        return audio;
      },
    });
  });
  await page.goto("/dashboard");
  await page
    .getByRole("button", { name: "Trò chơi và âm nhạc", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole("region", { name: "Chọn hồ sơ trẻ" }),
  ).toHaveClass(/family-profiles-prompt/);
  await page
    .getByRole("button", { name: `${child.alias}, lớp ${child.grade}` })
    .click();
  await page
    .getByRole("button", { name: "Trò chơi và âm nhạc", exact: true })
    .click();
  await page.getByRole("link", { name: "Mở thư viện bài hát" }).click();
  await expect(
    page.getByRole("heading", { name: "Bài hát do admin xuất bản" }),
  ).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("karaoke-library.png"),
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "Hát bài Bài hát do admin xuất bản" })
    .click();
  await expect(page.getByRole("region", { name: "Hát cùng bé" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Bắt đầu hát", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __karaokeAudios: HTMLAudioElement[] }
      ).__karaokeAudios.every((audio) => audio.paused),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Bắt đầu hát", exact: true }).click();
  await expect(page.getByTestId("karaoke-active-line")).toHaveText(
    "Em vui đến trường",
  );
  await expect(page.getByText("Câu đang hát", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("karaoke-active-line").locator('[data-state="active"]'),
  ).toHaveCSS("background-color", "rgb(255, 230, 109)");
  await page.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("karaoke-player.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Về thư viện bài hát" }).click();
  await expect(
    page.getByRole("heading", { name: `Hát vui cùng ${child.alias}` }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __karaokeAudios: HTMLAudioElement[] }
      ).__karaokeAudios.every(
        (audio) => audio.paused && !audio.getAttribute("src"),
      ),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(base.unexpected).toEqual([]);
});
test("refresh preserves same-tab child, ignores a foreign child_id in URL, and new tab requires child selection", async ({
  page,
}) => {
  const { state } = await fixture(page);
  await enter(page);
  await page
    .getByRole("link", { name: "Hát bài Bài hát do admin xuất bản" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Bài hát do admin xuất bản" }),
  ).toBeVisible();
  await page.goto(`/karaoke/${songId}?child_id=${lineId}`);
  await expect(
    page.getByRole("heading", { name: "Bài hát do admin xuất bản" }),
  ).toBeVisible();
  expect(state.requests.some((req) => req.includes(lineId))).toBe(false);
  const beforeFreshTab = state.requests.length;
  await page.evaluate(() => window.sessionStorage.clear());
  await page.goto(`/karaoke/${songId}?child_id=${lineId}`);
  await expect(page).toHaveURL(
    /\/dashboard\?focus=child-selection&reason=missing/,
  );
  expect(state.requests).toHaveLength(beforeFreshTab);
});
test("admin cannot enter the parent karaoke area", async ({ page }) => {
  const { state } = await fixture(page);
  await setRole(page, "admin");
  await page.goto("/karaoke");
  await expect(page).toHaveURL(/\/admin\/books$/);
  expect(state.requests).toEqual([]);
});
test("catalog failures differ from empty; playback updates need explicit action", async ({
  page,
}) => {
  const { state } = await fixture(page);
  state.fail = true;
  await enter(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Chưa tải được thư viện",
  );
  await expect(page.getByText("private database token")).toHaveCount(0);
  state.fail = false;
  state.empty = true;
  await page.getByRole("button", { name: "Thử lại thư viện" }).click();
  await expect(
    page.getByRole("heading", { name: "Chưa có bài hát phù hợp" }),
  ).toBeVisible();
  state.empty = false;
  await page.getByRole("button", { name: "Tìm bài hát", exact: true }).click();
  await page
    .getByRole("link", { name: "Hát bài Bài hát do admin xuất bản" })
    .click();
  await expect(
    page.getByRole("button", { name: "Bắt đầu hát", exact: true }),
  ).toBeEnabled();
  state.conflict = true;
  await page
    .getByText("Âm lượng và thông tin bài hát", { exact: true })
    .click();
  await page.getByRole("button", { name: "Tải lại nhạc", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Tải phiên bản mới" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Hát cùng bé" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Tải phiên bản mới" }).click();
  await expect(
    page.getByRole("button", { name: "Bắt đầu hát", exact: true }),
  ).toBeEnabled();
});

type ScoringBrowserFixture = {
  audio: HTMLAudioElement;
  listening: boolean;
  liveTracks: number;
  tracksStarted: number;
  sing: (startSeconds: number, endSeconds: number, text: string) => void;
  preview: (text: string) => void;
};
type ScoringPage = Window & { __singingFixture: ScoringBrowserFixture };

async function installScoringCapture(
  page: Page,
  quiet: boolean | "stop-singing" = false,
) {
  await page.addInitScript((quiet) => {
    // Synthetic Web Audio provides real tracks with either digital mute or a
    // calibrated quiet noise floor, without physical microphone access.
    // This test cannot prompt for the device mic or call a speech service.
    const tracks = new Set<MediaStreamTrack>();
    let context: AudioContext | undefined;
    let tracksStarted = 0;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        if (!constraints.audio || constraints.video)
          throw new Error("Expected audio-only capture");
        context ??= new AudioContext();
        const destination = context.createMediaStreamDestination();
        if (quiet) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          if (quiet === "stop-singing") {
            gain.gain.setValueAtTime(0.04, context.currentTime);
            gain.gain.setValueAtTime(0.002, context.currentTime + 0.5);
            gain.gain.setValueAtTime(0, context.currentTime + 3);
          } else gain.gain.value = 0.0002;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          void context.resume();
        }
        const stream = destination.stream;
        stream.getTracks().forEach((track) => tracks.add(track));
        return stream;
      },
    });
    window.addEventListener(
      "pagehide",
      () => {
        tracks.forEach((track) => track.stop());
        void context?.close();
      },
      { once: true },
    );
    class Recognizer {
      static active?: Recognizer;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onspeechstart: (() => void) | null = null;
      onspeechend: (() => void) | null = null;
      onresult: ((e: unknown) => void) | null = null;
      start(track: MediaStreamTrack) {
        if (!tracks.has(track))
          throw new Error("Expected an explicit fixture audio track");
        if (track.readyState === "ended")
          throw new DOMException("Track is ended", "InvalidStateError");
        tracksStarted++;
        Recognizer.active = this;
        queueMicrotask(() => this.onstart?.());
      }
      stop() {
        if (Recognizer.active === this) Recognizer.active = undefined;
        queueMicrotask(() => this.onend?.());
      }
      abort() {
        if (Recognizer.active === this) Recognizer.active = undefined;
      }
    }
    const control = {
      audio: null as HTMLAudioElement | null,
      get listening() {
        return !!Recognizer.active;
      },
      get liveTracks() {
        return [...tracks].filter((track) => track.readyState === "live")
          .length;
      },
      get tracksStarted() {
        return tracksStarted;
      },
      preview(text: string) {
        if (!this.audio || !Recognizer.active)
          throw new Error("No active capture");
        Recognizer.active.onresult?.({
          resultIndex: 0,
          results: [
            { isFinal: false, 0: { transcript: text, confidence: 0.99 } },
          ],
        });
      },
      sing(startSeconds: number, endSeconds: number, text: string) {
        const current = Recognizer.active;
        if (!current || !this.audio || this.audio.paused)
          throw new Error("Expected active capture and playback");
        this.audio.currentTime = startSeconds;
        current.onspeechstart?.();
        this.audio.currentTime = endSeconds;
        current.onspeechend?.();
        current.onresult?.({
          resultIndex: 0,
          results: [
            { isFinal: true, 0: { transcript: text, confidence: 0.99 } },
          ],
        });
        this.audio.dispatchEvent(new Event("timeupdate"));
      },
    };
    Object.defineProperty(window, "__singingFixture", { value: control });
    Object.defineProperty(window, "SpeechRecognition", {
      value: Recognizer,
      configurable: true,
    });
    window.Audio = new Proxy(window.Audio, {
      construct(target, args) {
        const audio = Reflect.construct(target, args) as HTMLAudioElement;
        control.audio = audio;
        return audio;
      },
    });
  }, quiet);
}

test("child live scoring confirms actual syllables and preserves song results after practice", async ({
  page,
}, info) => {
  await installScoringCapture(page);
  const { state, base } = await fixture(page);
  const lyrics = syllableLyrics();
  const line = lyrics.lines[0];
  // Longer tail keeps the checked live lyric visible on slow CI machines.
  line.end_ms = 11000;
  line.syllables![2].end_ms = 11000;
  state.lyrics = lyrics;
  await enter(page);
  await page
    .getByRole("link", { name: `Hát bài ${state.title}`, exact: true })
    .click();
  const stage = page.getByRole("region", { name: "Hát cùng bé", exact: true });
  const action = (name: string) =>
    stage.getByRole("button", { name, exact: true });
  const listening = () =>
    page.waitForFunction(
      () =>
        (window as unknown as ScoringPage).__singingFixture.listening &&
        !(window as unknown as ScoringPage).__singingFixture.audio.paused,
    );

  await action("Hát có chấm điểm").click();
  await action("Bắt đầu hát").click();
  await listening();
  await action("Tạm dừng").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as ScoringPage).__singingFixture.listening,
      ),
    )
    .toBe(false);
  expect(
    await page.evaluate(
      () => (window as unknown as ScoringPage).__singingFixture.liveTracks,
    ),
  ).toBe(0);
  await action("Hát tiếp").click();
  await listening();
  // Let the native clock advance: seeking here triggers buffering and restarts
  // capture, which would make this an unintended seek-boundary test.
  await page.waitForFunction(
    () =>
      (window as unknown as ScoringPage).__singingFixture.audio.currentTime >=
      1.1,
  );
  await page.evaluate(() =>
    (window as unknown as ScoringPage).__singingFixture.preview("bé nói"),
  );
  await expect(stage.locator('[data-word-state="processing"]')).not.toHaveCount(
    0,
  );
  await expect(stage.locator('[data-word-state="different"]')).toHaveCount(0);
  await expect(stage.getByTestId("karaoke-live-feedback")).toContainText(
    "Chưa đúng: 0",
  );
  await page.evaluate(() =>
    (window as unknown as ScoringPage).__singingFixture.sing(1, 3.1, "bé vui"),
  );
  const marked = stage
    .getByTestId("karaoke-active-line")
    .locator("[data-heard]");
  await expect(marked).toHaveCount(2);
  expect(
    await marked.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-heard")),
    ),
  ).toEqual([line.syllables![0].id + "/0", line.syllables![2].id + "/0"]);
  expect(
    await stage
      .locator('[data-recognition] > [aria-hidden="true"]')
      .evaluateAll((elements) =>
        elements.every(
          (element) => getComputedStyle(element).visibility === "hidden",
        ),
      ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("karaoke-v2-confirmed.png"),
    fullPage: true,
  });

  await page.evaluate(() => {
    const audio = (window as unknown as ScoringPage).__singingFixture.audio;
    audio.currentTime = audio.duration - 0.1;
  });
  const result = stage.getByRole("region", { name: "Kết quả đúng lời" });
  await expect(
    result.getByText("Điểm đúng lời", { exact: true }),
  ).toBeVisible();
  await expect(result.getByText("67/100", { exact: true })).toBeVisible();
  await expect(result).toContainText("Đã đánh giá 3/3 tiếng");
  await action("Luyện lại câu 1").click();
  await listening();
  await page.evaluate(() =>
    (window as unknown as ScoringPage).__singingFixture.sing(
      1,
      3.1,
      "bé hát vui",
    ),
  );
  await page.evaluate(() => {
    const audio = (window as unknown as ScoringPage).__singingFixture.audio;
    audio.currentTime = 11.1;
    audio.dispatchEvent(new Event("timeupdate"));
  });
  await expect(result).toContainText("Bé hát khớp 3/3 tiếng");
  await expect(result.getByText(/^\d+\/100$/)).toHaveCount(0);
  await action("Về kết quả bài hát").click();
  await expect(result.getByText("67/100", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as ScoringPage).__singingFixture.liveTracks,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () => (window as unknown as ScoringPage).__singingFixture.tracksStarted,
    ),
  ).toBeGreaterThanOrEqual(3);
  await action("Hát lại bài này").click();
  await listening();
  await page.evaluate(() => {
    const fixture = (window as unknown as ScoringPage).__singingFixture;
    fixture.sing(1, 1.5, "bé");
    fixture.audio.currentTime = fixture.audio.duration - 0.1;
  });
  await expect(result.getByText("Điểm phần đã nghe")).toBeVisible();
  await expect(result.getByText("100/100", { exact: true })).toBeVisible();
  await expect(result).toContainText("Đã đánh giá 1/3 tiếng");

  await action("Hát lại bài này").click();
  await listening();
  await page.evaluate(() => {
    const audio = (window as unknown as ScoringPage).__singingFixture.audio;
    audio.currentTime = audio.duration - 0.1;
  });
  await expect(result).toContainText("Mình chưa nghe rõ");
  await expect(result).toContainText(
    "Chưa đánh giá: 3 tiếng. Phần này không tính là sai.",
  );
  await expect(result.getByText(/^\d+\/100$/)).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("karaoke-v2-unassessed.png"),
    fullPage: true,
  });
  await noOverflow(page);
  expect(state.unexpected).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("child scoring counts stopping singing across recognition slices in live and final results", async ({
  page,
}, info) => {
  await installScoringCapture(page, "stop-singing");
  const { state, base } = await fixture(page);
  state.lyrics = {
    format_version: 1,
    lines: [
      { id: lineId, text: "Bé hát, vui!", start_ms: 1000, end_ms: 4000 },
      { id: versionId, text: "Cùng nhau hát", start_ms: 7500, end_ms: 10000 },
    ],
  };
  await enter(page);
  await page
    .getByRole("link", { name: `Hát bài ${state.title}`, exact: true })
    .click();
  const stage = page.getByRole("region", { name: "Hát cùng bé", exact: true });
  await stage
    .getByRole("button", { name: "Hát có chấm điểm", exact: true })
    .click();
  await stage.getByRole("button", { name: "Bắt đầu hát", exact: true }).click();
  // Natural media time exercises the analyser, scheduled stop and successful
  // drain. No manual scoring event or fabricated playback seek is involved.
  await expect(stage.getByTestId("karaoke-live-feedback")).toContainText(
    "Bỏ qua: 6",
    { timeout: 20000 },
  );
  await stage
    .getByRole("button", { name: "Kết thúc & chấm điểm", exact: true })
    .click();
  const result = stage.getByRole("region", { name: "Kết quả đúng lời" });
  await expect(result).toContainText("Đã đánh giá 6/6 tiếng");
  await expect(
    result
      .getByTestId("karaoke-score-breakdown")
      .locator(":scope > div")
      .filter({ hasText: "Bỏ qua" }),
  ).toHaveText("Bỏ qua6");
  await noOverflow(page);
  await result.screenshot({ path: info.outputPath("karaoke-omissions.png") });
  expect(state.unexpected).toEqual([]);
  expect(base.unexpected).toEqual([]);
});

test("child stage supports preparation, practice, slow loops, enlarged view and a friendly ending", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const cueFrequencies: number[] = [];
    Object.defineProperty(window, "__cueFrequencies", {
      value: cueFrequencies,
    });
    const originalOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const oscillator = originalOscillator.call(this);
      const setFrequency = oscillator.frequency.setValueAtTime.bind(
        oscillator.frequency,
      );
      oscillator.frequency.setValueAtTime = (frequency, time) => {
        cueFrequencies.push(frequency);
        return setFrequency(frequency, time);
      };
      return oscillator;
    };
    const NativeAudio = window.Audio;
    const audios: HTMLAudioElement[] = [];
    Object.defineProperty(window, "__stageAudio", { value: audios });
    window.Audio = new Proxy(NativeAudio, {
      construct(target, args) {
        const audio = Reflect.construct(target, args) as HTMLAudioElement;
        audios.push(audio);
        return audio;
      },
    });
  });
  const { state, base } = await fixture(page);
  const lyrics = syllableLyrics();
  const first = lyrics.lines[0];
  lyrics.lines.push({
    ...first,
    id: crypto.randomUUID(),
    start_ms: 7000,
    end_ms: 10000,
    syllables: first.syllables!.map((s) => ({
      ...s,
      id: crypto.randomUUID(),
      start_ms: s.start_ms! + 6000,
      end_ms: s.end_ms! + 6000,
    })),
  });
  state.lyrics = lyrics;
  state.author =
    "Alexander Blu · CC BY 4.0 https://creativecommons.org/licenses/by/4.0/";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await enter(page);
  await page
    .getByRole("link", { name: `Hát bài ${state.title}`, exact: true })
    .click();
  const stage = page.getByRole("region", { name: "Hát cùng bé", exact: true });
  const start = stage.getByRole("button", { name: "Bắt đầu hát", exact: true });
  await expect(start).toBeEnabled();
  const box = await start.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(56);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __stageAudio: HTMLAudioElement[] }
      ).__stageAudio.every((a) => a.paused),
    ),
  ).toBe(true);
  await start.click();
  await expect(stage.getByTestId("karaoke-cue")).toContainText("Chuẩn bị");
  const countdown = stage.getByTestId("karaoke-countdown");
  await expect(countdown).toBeVisible();
  expect(
    await countdown.evaluate((digit) =>
      parseFloat(getComputedStyle(digit).fontSize),
    ),
  ).toBeGreaterThanOrEqual(64);
  await stage
    .getByRole("button", { name: "Hủy chuẩn bị", exact: true })
    .click();
  await expect(start).toBeVisible();
  await expect(countdown).toHaveCount(0);
  await start.click();
  await stage.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __cueFrequencies: number[] }
      ).__cueFrequencies.slice(-4),
    ),
  ).toEqual([520, 520, 520, 880]);
  await stage.getByText("Chọn câu để luyện", { exact: true }).click();
  await stage
    .getByRole("button", { name: "Luyện câu 2: Bé hát, vui!", exact: true })
    .click();
  await stage
    .getByRole("combobox", { name: "Tốc độ hát" })
    .selectOption("0.75");
  await stage.getByRole("button", { name: "Lặp câu", exact: true }).click();
  // Toggling repeat cancels a pending preparation; explicit resume starts the selected segment.
  await stage.getByRole("button", { name: "Hát tiếp", exact: true }).click();
  await expect(
    stage.getByRole("button", { name: "Tạm dừng", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const audio = (
      window as unknown as { __stageAudio: HTMLAudioElement[] }
    ).__stageAudio.at(-1)!;
    audio.currentTime = 10.1;
    audio.dispatchEvent(new Event("timeupdate"));
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const a = (
          window as unknown as { __stageAudio: HTMLAudioElement[] }
        ).__stageAudio.at(-1)!;
        return (
          a.currentTime >= 7 && a.currentTime < 8 && a.playbackRate === 0.75
        );
      }),
    )
    .toBe(true);
  await stage.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await expect(
    stage.getByText("Đang luyện câu 2", { exact: true }),
  ).toBeVisible();
  await stage
    .getByRole("button", { name: "Mở rộng màn hát", exact: true })
    .click();
  await expect(
    stage.getByRole("button", { name: "Thu gọn màn hát", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await stage.screenshot({
    path: info.outputPath("karaoke-stage-expanded.png"),
  });
  await stage
    .getByRole("button", { name: "Thu gọn màn hát", exact: true })
    .click();
  await noOverflow(page);
  await stage.screenshot({
    path: info.outputPath("karaoke-stage-practice.png"),
  });
  await stage
    .getByText("Âm lượng và thông tin bài hát", { exact: true })
    .click();
  await expect(stage.getByText(state.author, { exact: true })).toBeVisible();
  await stage
    .getByRole("button", { name: "Trở về hát cả bài", exact: true })
    .click();
  await stage.getByRole("slider", { name: "Vị trí phát" }).press("End");
  await expect(
    stage.getByRole("heading", {
      name: `${child.alias} đã hát xong rồi!`,
      exact: true,
    }),
  ).toBeVisible();
  await stage
    .getByRole("button", { name: "Hát lại bài này", exact: true })
    .click();
  await stage.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await noOverflow(page);
  expect(errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(base.unexpected).toEqual([]);
});
