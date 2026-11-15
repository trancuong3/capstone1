import { expect, test, type Page, type Route } from "@playwright/test";
import { installApiFixture, setRole } from "./real-data-fixture";
import {
  previewDetail,
  songDetail,
  songId,
  versionId,
} from "../karaoke-fixtures";

// Entirely isolated browser API. No request reaches a real DB/Storage account.
function silentWav(seconds = 20) {
  const rate = 8000;
  const data = Buffer.alloc(44 + rate * seconds * 2);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data;
}
async function fixture(page: Page) {
  await installApiFixture(page);
  await setRole(page, "admin");
  const data = songDetail();
  const state = { data, conflict: false, requests: [] as string[] };
  async function respond(route: Route, json: unknown, status = 200) {
    await route.fulfill({
      status,
      headers: {
        "access-control-allow-origin": "http://127.0.0.1:3106",
        "access-control-allow-headers": "authorization,content-type,accept",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
      },
      contentType: "application/json",
      body: status === 204 ? undefined : JSON.stringify(json),
    });
  }
  await page.context().route("https://media.example.test/**", (route) =>
    route.fulfill({
      contentType: "audio/wav",
      body: silentWav(),
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page
    .context()
    .route("http://127.0.0.1:8000/karaoke/admin/songs**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "OPTIONS") return respond(route, null, 204);
      expect(request.headers().authorization).toMatch(/^Bearer /);
      state.requests.push(`${request.method()} ${path}`);
      if (path.endsWith("/validation"))
        return respond(route, {
          valid: true,
          revision: data.revision,
          draft_version_id: versionId,
          issues: [],
        });
      if (path.endsWith("/preview"))
        return respond(route, {
          ...previewDetail(),
          revision: data.revision,
          lyrics: data.draft!.lyrics,
        });
      if (path.endsWith("/draft") && request.method() === "PUT") {
        if (state.conflict)
          return respond(route, { detail: "private database error" }, 409);
        const body = request.postDataJSON();
        expect(body.expected_revision).toBe(data.revision);
        expect(body.draft_version_id).toBe(versionId);
        Object.assign(data.draft!, {
          title: body.title,
          author: body.author,
          min_grade: body.min_grade,
          max_grade: body.max_grade,
          source_note: body.source_note,
          usage_note: body.usage_note,
          lyrics: body.lyrics,
        });
        data.revision++;
        return respond(route, data);
      }
      if (path.endsWith("/publish")) {
        expect(request.postDataJSON()).toEqual({
          expected_revision: data.revision,
          draft_version_id: versionId,
        });
        data.published = { ...data.draft!, state: "PUBLISHED" };
        data.draft = null;
        data.status = "PUBLISHED";
        data.revision++;
        return respond(route, data);
      }
      if (path === "/karaoke/admin/songs" && request.method() === "GET") {
        const version = data.draft ?? data.published!;
        return respond(route, {
          items: [
            {
              ...version,
              song_id: songId,
              revision: data.revision,
              status: data.status,
              draft_version_id: data.draft?.id ?? null,
              published_version_id: data.published?.id ?? null,
            },
          ],
          total: 1,
          limit: 12,
          offset: 0,
        });
      }
      if (
        path === `/karaoke/admin/songs/${songId}` &&
        request.method() === "GET"
      )
        return respond(route, data);
      return respond(route, { detail: "Unexpected test request" }, 500);
    });
  return state;
}
async function assertNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}
test("imports UTF-8 LRC as editable suggested timing and saves it", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(`/admin/karaoke/${songId}/edit`);
  await expect(page.getByLabel("Lời dòng 1", { exact: true })).toHaveValue(
    "Em vui đến trường",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("File lời bài hát").setInputFiles({
    name: "example.lrc",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "\uFEFF[00:01.00]Bé hát vui\n[00:05.00]Cả nhà hát",
      "utf8",
    ),
  });
  await expect(page.getByLabel("Lời dòng 1", { exact: true })).toHaveValue(
    "Bé hát vui",
  );
  await expect(page.getByLabel("Bắt đầu dòng 1 (ms)")).toHaveValue("1000");
  await expect(page.getByLabel("Kết thúc dòng 1 (ms)")).toHaveValue("5000");
  await expect(page.getByText(/Mốc kết thúc LRC chỉ là gợi ý/)).toBeVisible();
  await page
    .getByRole("button", { name: "Lưu lời và thời gian", exact: true })
    .click();
  await expect(page.getByText("Revision 2", { exact: false })).toBeVisible();
  expect(state.data.draft!.lyrics.lines.map((l) => l.text)).toEqual([
    "Bé hát vui",
    "Cả nhà hát",
  ]);
  await assertNoHorizontalOverflow(page);
});
test("admin library/editor is navigable on desktop and mobile without writing on GET", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/admin/karaoke");
  await expect(
    page.getByRole("heading", { name: "Bài hát của bé" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Bài hát", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await assertNoHorizontalOverflow(page);
  await page.getByRole("link", { name: "Chi tiết / Chỉnh sửa" }).click();
  await expect(page.getByLabel("Tên bài hát", { exact: true })).toHaveValue(
    "Bài hát của bé",
  );
  await expect(
    page.getByRole("button", { name: "Xuất bản bài hát" }),
  ).toBeDisabled();
  await assertNoHorizontalOverflow(page);
  expect(state.requests.every((request) => request.startsWith("GET "))).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath("karaoke-editor.png"),
    fullPage: true,
  });
});
test("save, validate and listen using native audio before explicit publication", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(`/admin/karaoke/${songId}/edit`);
  await page.getByLabel("Tên bài hát", { exact: true }).fill("Bé hát cùng nhà");
  await expect(
    page.getByRole("button", { name: "Thay nhạc MP3" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Lưu bản nháp", exact: true }).click();
  await expect(page.getByText("Revision 2", { exact: false })).toBeVisible();
  await page
    .getByRole("button", { name: "Kiểm tra điều kiện xuất bản" })
    .click();
  await expect(
    page.getByText("Bản nháp hợp lệ", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Tải bản nghe thử / Căn thời gian" })
    .click();
  await expect(
    page.getByRole("button", { name: "Phát", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Phát", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Tạm dừng", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("karaoke-active-line")).toHaveText(
    "Em vui đến trường",
  );
  await page.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Xuất bản bài hát" }).click();
  await expect(
    page.getByText("Đã xuất bản bài hát.", { exact: true }),
  ).toBeVisible();
  expect(state.data.status).toBe("PUBLISHED");
  expect(state.data.published?.title).toBe("Bé hát cùng nhà");
});
test("keeps unsaved text on conflict and requires reload approval", async ({
  page,
}) => {
  const state = await fixture(page);
  state.conflict = true;
  await page.goto(`/admin/karaoke/${songId}/edit`);
  await page
    .getByLabel("Tên bài hát", { exact: true })
    .fill("Nội dung chưa được lưu");
  await page.getByRole("button", { name: "Lưu bản nháp", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Bài hát vừa thay đổi",
  );
  await expect(page.getByLabel("Tên bài hát", { exact: true })).toHaveValue(
    "Nội dung chưa được lưu",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Tải lại từ máy chủ" }).click();
  await expect(page.getByLabel("Tên bài hát", { exact: true })).toHaveValue(
    "Nội dung chưa được lưu",
  );
  await assertNoHorizontalOverflow(page);
});

test("edits and previews the 300-line limit with a throttled CPU", async ({
  page,
  context,
}) => {
  const state = await fixture(page);
  await page.goto(`/admin/karaoke/${songId}/edit`);
  await expect(page.getByLabel("Lời dòng 1", { exact: true })).toHaveValue(
    "Em vui đến trường",
  );
  state.data.draft!.lyrics.lines = Array.from({ length: 300 }, (_, index) => ({
    id: crypto.randomUUID(),
    text: `Dòng kiểm tra ${index + 1}`,
    start_ms: index === 0 ? 1000 : 3000 + (index - 1) * 50,
    end_ms: index === 0 ? 3000 : 3050 + (index - 1) * 50,
  }));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page
    .getByRole("button", { name: "Tải lại từ máy chủ", exact: true })
    .click();
  await page.getByLabel("Trang chỉnh lời", { exact: true }).selectOption("11");
  await expect(page.getByLabel("Lời dòng 300", { exact: true })).toHaveValue(
    "Dòng kiểm tra 300",
    { timeout: 30_000 },
  );
  await page
    .getByRole("button", {
      name: "Tải bản nghe thử / Căn thời gian",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Phát", exact: true }),
  ).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Phát", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Tạm dừng", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await assertNoHorizontalOverflow(page);
  await cdp.detach();
});

test("an interrupted upload preserves the saved draft and shows a retryable error", async ({
  page,
}) => {
  const state = await fixture(page);
  const before = JSON.stringify(state.data);
  await page
    .context()
    .route(
      `http://127.0.0.1:8000/karaoke/admin/songs/${songId}/draft/audio`,
      (route) => route.abort("internetdisconnected"),
    );
  await page.goto(`/admin/karaoke/${songId}/edit`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("File nhạc MP3").setInputFiles({
    name: "interrupted.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("isolated upload request, never sent to Storage"),
  });
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Thay nhạc MP3", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Tên bài hát", { exact: true })).toHaveValue(
    "Bài hát của bé",
  );
  expect(JSON.stringify(state.data)).toBe(before);
});
