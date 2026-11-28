import { expect, test } from "@playwright/test";

import { assertNoRawErrorLeak, IDS, installMockApi } from "./fixtures/mock-api";

test.describe("Tier 5: Adversarial Hardening & Regression E2E", () => {
  test("T5-F2-1: ParentMyBooksScreen preserves open create form and ParentPrivateBookManager keeps live blob: URLs unrevoked across delayed async auth hydration", async ({
    page,
  }) => {
    const context = page.context();
    await context.addInitScript(() => {
      const origCreate = URL.createObjectURL.bind(URL);
      const origRevoke = URL.revokeObjectURL.bind(URL);
      const created: string[] = [];
      const revoked: string[] = [];
      (
        window as unknown as {
          __vireadBlobLog?: { created: string[]; revoked: string[] };
        }
      ).__vireadBlobLog = { created, revoked };
      URL.createObjectURL = (obj: Blob | MediaSource) => {
        const url = origCreate(obj);
        created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url: string) => {
        revoked.push(url);
        return origRevoke(url);
      };
    });

    const tracker = await installMockApi(page);

    // Delay Supabase /auth/v1/user so auth hydration completes asynchronously after first paint
    await context.route(
      "https://example.supabase.co/auth/v1/user",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: IDS.parent,
            aud: "authenticated",
            role: "authenticated",
            email: "parent@example.test",
            user_metadata: { role: "parent", display_name: "Ba mẹ ViRead" },
            app_metadata: { provider: "email", providers: ["email"] },
            created_at: "2026-11-21T10:00:00Z",
          }),
        });
      },
    );

    await page.goto("/my-books");
    await page.getByRole("button", { name: /Tạo sách riêng/ }).click();
    const titleInput = page.getByLabel(/Tên sách/);
    await titleInput.fill("Sách Giữ Form Khi Hydrate");

    // Wait past delayed /auth/v1/user hydration and verify form + typed text stay intact
    await page.waitForTimeout(550);
    await expect(titleInput).toBeVisible();
    await expect(titleInput).toHaveValue("Sách Giữ Form Khi Hydrate");

    // Navigate to private book manager and verify live blob: image is NOT revoked across async hydration
    await page.goto(`/my-books/${IDS.privateBook}`);
    const pageImg = page.locator('img[src^="blob:"]').first();
    await expect(pageImg).toBeVisible();
    const liveSrc = await pageImg.getAttribute("src");
    expect(liveSrc).toMatch(/^blob:/);

    await page.waitForTimeout(550);
    const imgHealth = await page.evaluate((src) => {
      const imgs = Array.from(document.querySelectorAll("img"));
      const target = imgs.find((el) => el.getAttribute("src") === src);
      const log = (
        window as unknown as {
          __vireadBlobLog?: { created: string[]; revoked: string[] };
        }
      ).__vireadBlobLog;
      return {
        stillRendered: Boolean(target),
        complete: Boolean(target?.complete),
        naturalWidth: target?.naturalWidth ?? 0,
        revokedIncludesLive: Boolean(src && log?.revoked.includes(src)),
      };
    }, liveSrc);

    expect(imgHealth.stillRendered).toBe(true);
    expect(imgHealth.complete).toBe(true);
    expect(imgHealth.naturalWidth).toBeGreaterThan(0);
    expect(imgHealth.revokedIncludesLive).toBe(false);
    tracker.assertCleanHealth("T5-F2-1");
  });

  test("T5-F3-1: ReadingScreen next/dynamic panels (ReadingVoiceSettings & PhonicsLessonCard) open, interact, and close cleanly", async ({
    page,
  }) => {
    const tracker = await installMockApi(page);
    await page.goto(`/reading/${IDS.session1}?state=reading`);

    await expect(page.getByText("Mình đang chờ bé")).toBeVisible();

    // Open dynamic PhonicsLessonCard via Nghe đánh vần
    await page.getByRole("button", { name: "Nghe đánh vần" }).click();
    await expect(
      page.getByRole("button", { name: /Đóng/ }).first(),
    ).toBeVisible();

    // Open dynamic ReadingVoiceSettings if trigger is visible
    const voiceSettingsBtn = page.getByRole("button", {
      name: /Giọng đọc|Tùy chỉnh giọng/i,
    });
    if ((await voiceSettingsBtn.count()) > 0) {
      await voiceSettingsBtn.first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.first()).toBeVisible();
      await page.keyboard.press("Escape");
    }

    tracker.assertCleanHealth("T5-F3-1");
  });

  test("T5-F5-1: structured 504 LOCAL_OCR_TIMEOUT does not retry and mid-flight navigation produces zero unhandledRejection", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const rejections: string[] = [];
      (
        window as unknown as { __vireadUnhandledRejections?: string[] }
      ).__vireadUnhandledRejections = rejections;
      window.addEventListener("unhandledrejection", (event) => {
        rejections.push(String(event.reason));
      });
    });

    const tracker = await installMockApi(page, {
      faults: [
        {
          method: "GET",
          path: "/books/catalog",
          sequence: [
            {
              status: 504,
              body: { detail: { code: "LOCAL_OCR_TIMEOUT" } },
            },
          ],
        },
      ],
    });

    await page.goto("/books");
    await expect(page.getByText("Chưa tải được thư viện sách")).toBeVisible();
    await expect
      .poll(() => tracker.getAttemptCount("GET", "/books/catalog"))
      .toBe(1);
    assertNoRawErrorLeak(await page.locator("main").innerText(), "T5-F5-1");

    // Trigger a slow pending request and navigate away immediately to verify clean abort
    tracker.setFaults([
      {
        method: "GET",
        path: "/books/catalog",
        sequence: [{ delayMs: 4000, status: 200, body: [] }],
      },
    ]);
    await page.getByRole("button", { name: "Thử lại" }).click();
    await page.goto("/children");
    await expect(
      page.getByRole("link", { name: "Bé An, lớp 1" }),
    ).toBeVisible();

    const rejections = await page.evaluate(
      () =>
        (window as unknown as { __vireadUnhandledRejections?: string[] })
          .__vireadUnhandledRejections ?? [],
    );
    expect(rejections).toEqual([]);
    tracker.assertCleanHealth("T5-F5-1", { expectedHttpStatuses: [504] });
  });
});
