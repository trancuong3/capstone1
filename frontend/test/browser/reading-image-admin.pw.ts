import { expect, test } from "@playwright/test";
import { ids, installApiFixture, setRole } from "./real-data-fixture";

test("Admin uploads two real PNGs, keeps page images distinct and replaces only the selected revision", async ({
  page,
}, testInfo) => {
  const api = await installApiFixture(page);
  await setRole(page, "admin");
  const timestamp = "2026-11-11T00:00:00Z";
  const secondPage = "55555555-5555-4555-8555-555555555556";
  const secondRevision = "66666666-6666-4666-8666-666666666667";
  const pages: {
    id: string;
    revision: string;
    previous: string | null;
    number: number;
  }[] = [];
  const uploads: string[] = [];
  let replacement = "";
  const headers = {
    "access-control-allow-origin": "http://127.0.0.1:3106",
    "access-control-allow-headers": "authorization,content-type,accept",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
  const respond = (route: import("@playwright/test").Route, body: unknown) =>
    route.fulfill({
      headers,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  const processing = (item: (typeof pages)[number]) => ({
    page_id: item.id,
    page_revision_id: item.revision,
    revision_no: item.previous ? 2 : 1,
    verification_status: "NEEDS_REVIEW",
    lifecycle_status: "ACTIVE",
    ocr_preview_metadata: {},
    verified_at: null,
    current_verified_revision_id: item.previous,
  });
  const detail = (item: (typeof pages)[number]) => ({
    ...processing(item),
    draft_text: `Trang ${item.number}`,
    words: [],
    ocr_metadata: {},
    created_at: timestamp,
    verified_by: null,
  });
  await page.route("http://127.0.0.1:8000/books/admin/**", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    const url = new URL(route.request().url());
    if (url.pathname === `/books/admin/catalog/${ids.book}/pages`) {
      if (route.request().method() === "POST") {
        uploads.push(route.request().postData() ?? "");
        const number = pages.length + 1;
        const item = {
          id: number === 1 ? ids.page : secondPage,
          revision: number === 1 ? ids.revision : secondRevision,
          previous: null,
          number,
        };
        pages.push(item);
        return respond(route, detail(item));
      }
      return respond(
        route,
        pages.map((item) => ({
          book_id: ids.book,
          page_number: item.number,
          processing: processing(item),
        })),
      );
    }
    const item = pages.find((item) => url.pathname.includes(item.id));
    if (item && url.pathname.endsWith("/reupload-ocr")) {
      replacement = route.request().postData() ?? "";
      item.previous = item.revision;
      item.revision = ids.draftRevision;
      return respond(route, detail(item));
    }
    if (item && url.pathname.endsWith("/image"))
      return respond(route, {
        page_id: item.id,
        page_revision_id: url.searchParams.get("revision_id"),
        page_number: item.number,
        preview_url: `http://127.0.0.1:8000/admin-source-${item.number}.svg`,
        width: 600,
        height: 800,
      });
    return route.fallback();
  });
  await page.route("http://127.0.0.1:8000/admin-source-*.svg", (route) =>
    route.fulfill({
      headers,
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="${route.request().url().includes("-1.") ? "#fdf2c4" : "#cee3f6"}"/><text x="40" y="150" font-size="50">${route.request().url().includes("-1.") ? "Trang một" : "Trang hai"}</text></svg>`,
    }),
  );
  await page.goto(`/admin/books/${ids.book}`);
  const pngs = await page.evaluate(() =>
    ["#fdf2c4", "#cee3f6"].map((color) => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 800;
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, 600, 800);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
  );
  await page.locator("#page-images").setInputFiles(
    pngs.map((png, index) => ({
      name: `page-${index + 1}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    })),
  );
  await page.getByRole("button", { name: "Upload và chạy OCR" }).click();
  await expect(
    page.getByRole("heading", { name: "Trang 1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Trang 2", exact: true }),
  ).toBeVisible();
  const first = page.getByRole("img", { name: "Ảnh trang 1", exact: true });
  const second = page.getByRole("img", { name: "Ảnh trang 2", exact: true });
  await expect(first).toHaveAttribute("src", /admin-source-1/);
  await expect(second).toHaveAttribute("src", /admin-source-2/);
  expect(uploads).toHaveLength(2);
  expect(uploads[0]).toContain('name="upload_id"');
  expect(uploads[1]).toContain('name="upload_id"');
  await page.screenshot({
    path: testInfo.outputPath("admin-two-source-images.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Chọn ảnh mới cho trang 1", { exact: true })
    .setInputFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: Buffer.from(pngs[1], "base64"),
    });
  await page
    .getByRole("button", { name: "Thay ảnh trang 1", exact: true })
    .click();
  await expect(
    page.getByText("Ảnh mới đang chờ duyệt", { exact: true }),
  ).toBeVisible();
  expect(pages[0].previous).toBe(ids.revision);
  expect(pages[0].revision).toBe(ids.draftRevision);
  expect(pages[1].revision).toBe(secondRevision);
  expect(replacement).toContain('name="upload_id"');
  await page.screenshot({
    path: testInfo.outputPath("admin-replacement-needs-review.png"),
    fullPage: true,
  });
  expect(api.unexpected).toEqual([]);
});
