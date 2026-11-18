import { expect, test, type Page, type Route } from "@playwright/test";
import { installApiFixture, setRole, child, ids } from "./real-data-fixture";
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
async function fixture(page: Page) {
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
    const bytes = wav();
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers().range ?? "",
    );
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2]
      ? Math.min(bytes.length - 1, Number(range[2]))
      : bytes.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: "audio/wav",
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
          duration_ms: 20000,
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
  await expect(
    page.getByRole("link", { name: "Giải trí", exact: true }),
  ).toHaveAttribute("aria-current", "page");
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

test("v2 lyrics follow seeks, gaps and reduced motion using the existing child player", async ({
  page,
}) => {
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
  const { state } = await fixture(page);
  state.lyrics = syllableLyrics();
  await enter(page);
  await page
    .getByRole("link", { name: `Hát bài ${state.title}`, exact: true })
    .click();
  const seek = page.getByRole("slider", { name: "Vị trí phát" });
  await expect(seek).toBeEnabled();
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
  await seekTo(1250);
  const active = page.locator(
    '[data-testid="karaoke-active-line"] [data-state="active"]',
  );
  await expect(active).toHaveCount(1);
  await expect(active).toHaveCSS("--karaoke-fill", "50%");
  await seekTo(1600);
  await expect(active).toHaveCount(0);
  await seekTo(3300);
  await expect(active).toHaveCSS("--karaoke-fill", "50%");
  await page.emulateMedia({ reducedMotion: "reduce" });
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
test("refresh requires child reselection and ignores a foreign child_id in URL", async ({
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
  const before = state.requests.length;
  await page.goto(`/karaoke/${songId}?child_id=${lineId}`);
  await expect(page).toHaveURL(
    /\/dashboard\?focus=child-selection&reason=missing/,
  );
  expect(state.requests).toHaveLength(before);
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

test("child stage supports preparation, practice, slow loops, enlarged view and a friendly ending", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
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
  await stage
    .getByRole("button", { name: "Hủy chuẩn bị", exact: true })
    .click();
  await expect(start).toBeVisible();
  await start.click();
  await stage.getByRole("button", { name: "Tạm dừng", exact: true }).click();
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
