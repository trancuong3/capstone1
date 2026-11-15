import { expect, test, type Page, type Route } from "@playwright/test";
import { installApiFixture, setRole, child, ids } from "./real-data-fixture";
import { previewDetail, songId, versionId, lineId } from "../karaoke-fixtures";

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
  };
  await page.context().route("https://media.example.test/**", (route) =>
    route.fulfill({
      contentType: "audio/wav",
      body: wav(),
      headers: { "access-control-allow-origin": "*" },
    }),
  );
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
          author: "Tác giả",
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
          version_id: state.conflict ? lineId : versionId,
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
  await page.getByRole("button", { name: "Hát vui", exact: true }).click();
  await expect(page).toHaveURL(/\/karaoke$/);
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

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
  await page.getByRole("button", { name: "Hát vui", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole("region", { name: "Chọn hồ sơ trẻ" }),
  ).toHaveClass(/ring-4/);
  await page
    .getByRole("button", { name: `${child.alias}, lớp ${child.grade}` })
    .click();
  await page.getByRole("button", { name: "Hát vui", exact: true }).click();
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
    page.getByRole("button", { name: "Phát", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __karaokeAudios: HTMLAudioElement[] }
      ).__karaokeAudios.every((audio) => audio.paused),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Phát", exact: true }).click();
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
    page.getByRole("button", { name: "Phát", exact: true }),
  ).toBeEnabled();
  state.conflict = true;
  await page.getByRole("button", { name: "Tải lại nhạc", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Tải phiên bản mới" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Hát cùng bé" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Tải phiên bản mới" }).click();
  await expect(
    page.getByRole("button", { name: "Phát", exact: true }),
  ).toBeEnabled();
});
