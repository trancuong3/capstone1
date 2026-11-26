import { expect, test, type Page } from "@playwright/test";
import { normalizeProjectBucket } from "./mobile-overhaul-fixture";
import { ids } from "./real-data-fixture";
import {
  buildLongPoetryPageSpec,
  buildWordsFromText,
  installReadingVoiceSession,
} from "./reading-voice-harness";

const PAGE_2_ID = "55555555-5555-4555-8555-555555555556";
const PAGE_2_REV = "66666666-6666-4666-8666-666666666667";

async function assertZeroHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
}

async function measureRectOverlap(
  page: Page,
  selectorA: string,
  selectorB: string,
): Promise<{
  overlapArea: number;
  rectA: { x: number; y: number; width: number; height: number } | null;
  rectB: { x: number; y: number; width: number; height: number } | null;
}> {
  return page.evaluate(
    ([selA, selB]) => {
      const a = document.querySelector<HTMLElement>(selA);
      const b = document.querySelector<HTMLElement>(selB);
      if (!a || !b) return { overlapArea: 0, rectA: null, rectB: null };
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const xOverlap = Math.max(
        0,
        Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left),
      );
      const yOverlap = Math.max(
        0,
        Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top),
      );
      return {
        overlapArea: Math.round(xOverlap * yOverlap),
        rectA: {
          x: Math.round(ra.left),
          y: Math.round(ra.top),
          width: Math.round(ra.width),
          height: Math.round(ra.height),
        },
        rectB: {
          x: Math.round(rb.left),
          y: Math.round(rb.top),
          width: Math.round(rb.width),
          height: Math.round(rb.height),
        },
      };
    },
    [selectorA, selectorB],
  );
}

test.describe("E2E-F4: Child Reading Clean Canvas & On-Tap Menu Sheet (R2)", () => {
  test.describe("Tier 1: Core Mobile Clean Canvas & Desktop Parity", () => {
    test("T1.1: <768px mobile canvas keeps .reader-leaf >= 55% height with minimal dock & no stacked top bars", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-360x800" && bucket !== "mobile-390x844",
        "Runs on mobile-360x800 and mobile-390x844",
      );

      const vp = page.viewportSize() ?? { width: 390, height: 844 };
      const words = buildWordsFromText(
        "Sáng sớm bé Lan ngồi đọc sách truyện bên khung cửa sổ đầy nắng ấm.",
      );
      const session = await installReadingVoiceSession(page, {
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            confidence: 0.98,
            width: 600,
            height: 800,
            image_overlay_safe: false,
            image_url: null,
            text: "Sáng sớm bé Lan ngồi đọc sách truyện bên khung cửa sổ đầy nắng ấm.",
            words,
          },
        ],
        wasmWorker: { scriptedOutputs: ["Sáng sớm"] },
      });

      const leaf = page.locator(
        '.reader-leaf[data-reading-scroll-container="true"]',
      );
      await expect(leaf).toBeVisible();
      const leafBox = await leaf.boundingBox();
      expect(leafBox).not.toBeNull();
      expect(leafBox!.height).toBeGreaterThanOrEqual(vp.height * 0.55);

      await expect(page.locator(".reader-bookplate")).toBeHidden();
      await expect(page.locator('[data-reading-topbar="true"]')).toBeHidden();

      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Bé đọc với nhận diện giọng nói" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Kết thúc buổi đọc" }),
      ).toBeVisible();

      await expect(page.getByTestId("mobile-reading-menu-btn")).toBeVisible();
      await assertZeroHorizontalOverflow(page);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.2: Secondary controls, status badge & warning notice are tucked inside ⋮ sheet on 390x844", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(bucket !== "mobile-390x844", "Runs on mobile-390x844");

      const session = await installReadingVoiceSession(page, {
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            confidence: 0.98,
            width: 600,
            height: 800,
            image_overlay_safe: false,
            image_url: null,
            text: "Trang một bé đọc.",
            words: buildWordsFromText("Trang một bé đọc."),
          },
          {
            page_id: PAGE_2_ID,
            page_revision_id: PAGE_2_REV,
            page_number: 2,
            confidence: 0.98,
            width: 600,
            height: 800,
            image_overlay_safe: false,
            image_url: null,
            text: "Trang hai bé đọc.",
            words: buildWordsFromText("Trang hai bé đọc.", {
              prefix: "92000000-0000-4000-8000-",
            }),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: false,
          timedTtsStatus: 503,
          shortTtsStatus: 503,
        },
      });

      // Trigger fallback notice by clicking single word while local TTS is down
      await page
        .getByRole("button", { name: "Trang", exact: true })
        .first()
        .click();

      // Secondary controls & badge must NOT clutter main canvas
      await expect(page.getByTestId("voice-engine-status-badge")).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Tạm dừng buổi đọc" }),
      ).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Chọn trang" }),
      ).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Giọng đọc", exact: true }),
      ).toBeHidden();

      // Open ⋮ sheet
      await page.getByTestId("mobile-reading-menu-btn").click();
      const dialog = page.getByRole("dialog", { name: "Tùy chọn buổi đọc" });
      await expect(dialog).toBeVisible();

      for (const label of [
        "Trang trước",
        "Trang tiếp",
        "Chọn trang khác",
        "Cài đặt giọng đọc",
        "Nhờ gia sư giúp đọc",
        "Tạm dừng buổi đọc",
      ]) {
        await expect(dialog.getByRole("button", { name: label })).toBeVisible();
      }
      await expect(
        dialog.getByTestId("voice-engine-status-badge"),
      ).toBeVisible();
      await expect(dialog.getByText(/Giọng đọc đã khóa/)).toBeVisible();

      // Verify secondary action is actually operable from inside ⋮ sheet
      await dialog.getByRole("button", { name: "Trang tiếp" }).click();
      await expect(
        page.locator(`[data-page-revision-id="${PAGE_2_REV}"]`).first(),
      ).toBeVisible();
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.3: V2 illustrated/mode book collapses oversized bookplate, mode tabs & illustration on <768px", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-360x800" && bucket !== "mobile-390x844",
        "Runs on mobile-360x800 and mobile-390x844",
      );

      const vp = page.viewportSize() ?? { width: 390, height: 844 };
      const words = buildWordsFromText(
        "Chú thỏ trắng chạy tung tăng trong vườn.",
      );
      const session = await installReadingVoiceSession(page, {
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            confidence: 0.99,
            width: 600,
            height: 800,
            image_overlay_safe: false,
            image_url: "http://127.0.0.1:8000/fixture-page.png",
            illustration_url: "http://127.0.0.1:8000/fixture-illustration.png",
            illustration_text_free: true,
            text: "Chú thỏ trắng chạy tung tăng trong vườn.",
            words,
          },
        ],
      });

      const leaf = page.locator(
        '.reader-leaf[data-reading-scroll-container="true"]',
      );
      const dock = page.locator('[data-reading-dock="true"]');
      const leafBox = await leaf.boundingBox();
      const dockBox = await dock.boundingBox();
      expect(leafBox).not.toBeNull();
      expect(dockBox).not.toBeNull();

      // Reading area must remain dominant (>= 55% of viewport) even on V2 illustrated pages
      expect(leafBox!.height).toBeGreaterThanOrEqual(vp.height * 0.55);

      // Oversized V2 bookplate / mode switcher / inline giant illustration must be collapsed or kept off main mobile reading leaf
      await expect(page.locator(".reader-bookplate")).toBeHidden();
      await expect(page.getByTestId("reading-mode-switcher")).toBeHidden();
      await expect(
        page.getByTestId("storybook-illustration-card"),
      ).toBeHidden();

      // First readable word must be visible above the fold and above the bottom dock
      const firstWord = page
        .locator('[data-reading-panel="text"] [data-word-id]')
        .first();
      const wordBox = await firstWord.boundingBox();
      expect(wordBox).not.toBeNull();
      expect(wordBox!.y).toBeGreaterThanOrEqual(0);
      expect(wordBox!.y + wordBox!.height).toBeLessThanOrEqual(dockBox!.y + 2);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.4: Touch targets >= 44px and 0px horizontal overflow across all <768px mobile & gap viewports", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        ![
          "mobile-360x800",
          "mobile-390x844",
          "mobile-430x932",
          "gap-640x960",
          "gap-720x900",
        ].includes(bucket),
        "Runs 1 viewport per <768px mobile & gap project",
      );

      const vp = page.viewportSize() ?? { width: 390, height: 844 };
      const session = await installReadingVoiceSession(page, {
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            confidence: 0.98,
            width: 600,
            height: 800,
            image_overlay_safe: false,
            image_url: "http://127.0.0.1:8000/fixture-page.png",
            text: "Bé mèo nhỏ đọc sách.",
            words: buildWordsFromText("Bé mèo nhỏ đọc sách."),
          },
        ],
      });

      await assertZeroHorizontalOverflow(page);

      const touchViolations = await page.evaluate(() => {
        const shell = document.querySelector('[data-reading-shell="true"]');
        if (!shell) return ["missing reading shell"];
        const buttons = Array.from(
          shell.querySelectorAll<HTMLElement>(
            "header button, header a[href], [data-reading-dock] button, [data-reading-dock] a[href]",
          ),
        );
        const bad: string[] = [];
        for (const btn of buttons) {
          const style = window.getComputedStyle(btn);
          if (style.display === "none" || style.visibility === "hidden")
            continue;
          const rect = btn.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.height < 44 || rect.width < 44) {
            bad.push(
              `${btn.getAttribute("aria-label") || btn.textContent?.trim()} (${Math.round(rect.width)}x${Math.round(rect.height)})`,
            );
          }
          if (
            rect.bottom > window.innerHeight + 2 ||
            rect.right > window.innerWidth + 2
          ) {
            bad.push(
              `clipped:${btn.getAttribute("aria-label") || btn.textContent?.trim()} bottom=${Math.round(rect.bottom)} vpH=${window.innerHeight}`,
            );
          }
        }
        return bad;
      });
      expect(touchViolations, `Viewport ${vp.width}x${vp.height}`).toEqual([]);

      // Also check touch targets (both width & height >= 44px, buttons + a[href]) inside ⋮ sheet
      await page.getByTestId("mobile-reading-menu-btn").click();
      const dialog = page.getByRole("dialog", { name: "Tùy chọn buổi đọc" });
      await expect(dialog).toBeVisible();
      const sheetViolations = await dialog.evaluate((el) => {
        const bad: string[] = [];
        for (const target of Array.from(
          el.querySelectorAll<HTMLElement>("button, a[href]"),
        )) {
          const style = window.getComputedStyle(target);
          if (style.display === "none" || style.visibility === "hidden")
            continue;
          const rect = target.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.width < 44 || rect.height < 44) {
            bad.push(
              `${target.getAttribute("aria-label") || target.textContent?.trim()} (${Math.round(rect.width)}x${Math.round(rect.height)})`,
            );
          }
        }
        return bad;
      });
      expect(sheetViolations, `Sheet ${vp.width}x${vp.height}`).toEqual([]);
      await page.keyboard.press("Escape");
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.5: Desktop (>=768px: 768x1024, 1024x768, 1440x1000) retains 100% parity", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        !["tablet-768x1024", "tablet-1024x768", "desktop-1440x1000"].includes(
          bucket,
        ),
        "Runs 1 viewport per >=768px tablet & desktop project",
      );

      const session = await installReadingVoiceSession(page, {
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            confidence: 0.98,
            width: 600,
            height: 800,
            image_overlay_safe: false,
            image_url: null,
            text: "Bé mèo nhỏ đọc sách hay.",
            words: buildWordsFromText("Bé mèo nhỏ đọc sách hay."),
          },
        ],
      });

      await expect(page.getByTestId("mobile-reading-menu-btn")).toBeHidden();
      await expect(page.locator(".reader-bookplate")).toBeVisible();
      await expect(page.locator('[data-reading-topbar="true"]')).toBeVisible();
      await expect(page.getByTestId("voice-engine-status-badge")).toBeVisible();

      // Desktop 2-column grid layout check (.reader-bookplate left of .reader-leaf)
      const layout = await page.evaluate(() => {
        const bp = document
          .querySelector(".reader-bookplate")
          ?.getBoundingClientRect();
        const leaf = document
          .querySelector(".reader-leaf")
          ?.getBoundingClientRect();
        return { bp, leaf };
      });
      expect(layout.bp).not.toBeNull();
      expect(layout.leaf).not.toBeNull();
      expect(layout.bp!.right).toBeLessThanOrEqual(layout.leaf!.left + 4);

      for (const name of [
        "Tạm dừng buổi đọc",
        "Nghe đọc mẫu cả trang",
        "Giọng đọc",
        "Bé đọc với nhận diện giọng nói",
        "Chọn trang",
        "Kết thúc buổi đọc",
      ]) {
        await expect(
          page.getByRole("button", { name, exact: true }),
        ).toBeVisible();
      }
      await assertZeroHorizontalOverflow(page);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });
  });

  test.describe("Tier 2: Boundary & Dead-Zone (640-767px) + Occlusion Checks", () => {
    test("T2.1: 640x960 portrait closes 640-767px dead zone with aligned mobile dock & ⋮ sheet", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(bucket !== "gap-640x960", "Runs on gap-640x960");

      const session = await installReadingVoiceSession(page);

      await expect(page.getByTestId("mobile-reading-menu-btn")).toBeVisible();
      await expect(page.locator(".reader-bookplate")).toBeHidden();
      await expect(
        page.locator('[data-desktop-only-control="true"]').first(),
      ).toBeHidden();
      await expect(
        page.locator('[data-voice-settings-wrap="true"] > button'),
      ).toBeHidden();

      const leafBox = await page.locator(".reader-leaf").boundingBox();
      expect(leafBox).not.toBeNull();
      expect(leafBox!.height).toBeGreaterThanOrEqual(960 * 0.55);

      const dockStats = await page.evaluate(() => {
        const nav = document.querySelector<HTMLElement>(
          "[data-reading-controls]",
        );
        if (!nav) return null;
        const visibleBtns = Array.from(
          nav.querySelectorAll<HTMLElement>("button"),
        ).filter((b) => window.getComputedStyle(b).display !== "none");
        const cols = window
          .getComputedStyle(nav)
          .gridTemplateColumns.split(" ").length;
        return {
          declaredCols: Number(
            nav.getAttribute("data-mobile-dock-cols") ?? "0",
          ),
          computedCols: cols,
          visibleCount: visibleBtns.length,
          tops: visibleBtns.map((b) =>
            Math.round(b.getBoundingClientRect().top),
          ),
        };
      });
      expect(dockStats).not.toBeNull();
      expect(dockStats!.computedCols).toBe(dockStats!.visibleCount);
      // All mobile dock buttons align on one clean single row
      expect(new Set(dockStats!.tops).size).toBe(1);
      await assertZeroHorizontalOverflow(page);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.2: 720x900 portrait (upper 640-767px edge) maintains unified mobile dock & clean canvas", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(bucket !== "gap-720x900", "Runs on gap-720x900");

      const session = await installReadingVoiceSession(page);

      await expect(page.getByTestId("mobile-reading-menu-btn")).toBeVisible();
      await expect(page.locator(".reader-bookplate")).toBeHidden();
      const leafBox = await page.locator(".reader-leaf").boundingBox();
      expect(leafBox).not.toBeNull();
      expect(leafBox!.height).toBeGreaterThanOrEqual(900 * 0.55);

      const dockBox = await page
        .locator("[data-reading-controls]")
        .boundingBox();
      expect(dockBox).not.toBeNull();
      expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(902);
      await assertZeroHorizontalOverflow(page);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.3: [data-reading-feedback='true'] has 0px occlusion over active/readable .reader-leaf words at 360x800 & 640x960", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-360x800" && bucket !== "gap-640x960",
        "Runs on mobile-360x800 and gap-640x960",
      );

      const vp = page.viewportSize() ?? { width: 360, height: 800 };
      const words = buildWordsFromText(
        "Sáng sớm bé Lan ngồi đọc sách truyện bên khung cửa sổ.",
      );
      const session = await installReadingVoiceSession(page, {
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            confidence: 0.98,
            width: 600,
            height: 800,
            image_overlay_safe: false,
            image_url: null,
            text: "Sáng sớm bé Lan ngồi đọc sách truyện bên khung cửa sổ.",
            words,
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: false,
        },
        wasmWorker: { scriptedOutputs: ["Sáng sớm"] },
      });

      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();
      await page.evaluate(() => {
        (
          window as unknown as {
            __voiceHarness: { pulseSpeech: (ms?: number) => void };
          }
        ).__voiceHarness.pulseSpeech(260);
      });

      await expect(
        page.locator('[data-reading-feedback="true"]'),
      ).toBeVisible();

      // Active word & visible .reader-leaf text must NOT be covered by floating feedback
      const overlap = await measureRectOverlap(
        page,
        '[data-reading-feedback="true"]',
        '.reader-leaf [aria-current="true"]',
      );
      expect(
        overlap.overlapArea,
        `Feedback overlapped active word at ${vp.width}x${vp.height}: ${JSON.stringify(overlap)}`,
      ).toBe(0);

      const leafOverlap = await measureRectOverlap(
        page,
        '[data-reading-feedback="true"]',
        ".reader-leaf",
      );
      expect(
        leafOverlap.overlapArea,
        `Feedback overlapped .reader-leaf at ${vp.width}x${vp.height}: ${JSON.stringify(leafOverlap)}`,
      ).toBe(0);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.4: Long locked-voice warning + phonics card active simultaneously on 360x800 without duplicate 'Đọc mẫu' or dock clipping", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(bucket !== "mobile-360x800", "Runs on mobile-360x800");

      const session = await installReadingVoiceSession(page, {
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            confidence: 0.98,
            width: 600,
            height: 800,
            image_overlay_safe: false,
            image_url: null,
            text: "Nghiên cứu sách hay.",
            words: buildWordsFromText("Nghiên cứu sách hay."),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: false,
          shortTtsStatus: 503,
          phonicsTtsStatus: 503,
        },
      });

      // Trigger fallbackNotice + open phonics card
      await page
        .getByRole("button", { name: "Nghiên", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: "Đánh vần từ này" }).click();
      await expect(page.getByTestId("phonics-lesson-card")).toBeVisible();

      // Long warning notice must NOT render inline on main canvas
      await expect(page.locator('[data-reading-topbar="true"]')).toBeHidden();

      // Dock remains cleanly within 800px viewport
      const dockBox = await page
        .locator("[data-reading-controls]")
        .boundingBox();
      expect(dockBox).not.toBeNull();
      expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(802);

      // Zero duplicate "Đọc mẫu" status panels anywhere in [data-reading-shell="true"]
      const sampleHeaders = await page
        .locator('[data-reading-shell="true"]')
        .getByText(/^Đọc mẫu$/)
        .count();
      expect(sampleHeaders).toBeLessThanOrEqual(1);
      await assertZeroHorizontalOverflow(page);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.5: 360x640 & 844x390 landscape compact height with 120-line poetry + reference image", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-360x800" && bucket !== "mobile-390x844",
        "Runs 1 compact landscape viewport per mobile-360x800 (360x640) and mobile-390x844 (844x390)",
      );

      const vp =
        bucket === "mobile-360x800"
          ? { width: 360, height: 640 }
          : { width: 844, height: 390 };
      await page.setViewportSize(vp);

      const poetryPage = buildLongPoetryPageSpec(120);
      const session = await installReadingVoiceSession(page, {
        pages: [poetryPage],
      });

      await assertZeroHorizontalOverflow(page);
      const dockBox = await page
        .locator("[data-reading-controls]")
        .boundingBox();
      expect(dockBox).not.toBeNull();
      expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(vp.height + 2);

      const imageBtn = page.locator('[data-landscape-image-btn="true"]');
      await expect(imageBtn).toBeVisible();
      await imageBtn.click();
      const imgDialog = page.getByRole("dialog", { name: "Ảnh trang 1" });
      await expect(imgDialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(imgDialog).toBeHidden();
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });
  });

  test.describe("Tier 3: Pairwise Cross-Feature Canvas Interactions", () => {
    test("T3.1: Open/close ⋮ sheet while live reading & word highlighting are active on 390x844", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(bucket !== "mobile-390x844", "Runs on mobile-390x844");

      const session = await installReadingVoiceSession(page, {
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            confidence: 0.98,
            width: 600,
            height: 800,
            image_overlay_safe: false,
            image_url: null,
            text: "Sáng sớm bé Lan đọc.",
            words: buildWordsFromText("Sáng sớm bé Lan đọc."),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
        },
        wasmWorker: { scriptedOutputs: ["Sáng sớm"] },
      });

      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();
      await page.evaluate(() => {
        (
          window as unknown as {
            __voiceHarness: { pulseSpeech: (ms?: number) => void };
          }
        ).__voiceHarness.pulseSpeech(260);
      });

      await expect(
        page.getByRole("button", { name: "sớm" }).first(),
      ).toHaveAttribute("data-reading-state", "correct");
      await expect(
        page.getByRole("button", { name: "bé" }).first(),
      ).toHaveAttribute("aria-current", "true");

      // Open and close ⋮ sheet mid-reading
      await page.getByTestId("mobile-reading-menu-btn").click();
      const dialog = page.getByRole("dialog", { name: "Tùy chọn buổi đọc" });
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      // Reading state, cursor & error count remain intact
      await expect(
        page.getByRole("button", { name: "sớm" }).first(),
      ).toHaveAttribute("data-reading-state", "correct");
      await expect(
        page.getByRole("button", { name: "bé" }).first(),
      ).toHaveAttribute("aria-current", "true");
      await expect(page.locator('[data-reading-shell="true"]')).toHaveAttribute(
        "data-child-error-count",
        "0",
      );
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T3.2: Dynamic viewport resize 768x1024 <-> 640x960 mid-session preserves cursor & clean dock", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "tablet-768x1024",
        "Dynamic resize test runs on tablet-768x1024",
      );

      const session = await installReadingVoiceSession(page, {
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            confidence: 0.98,
            width: 600,
            height: 800,
            image_overlay_safe: false,
            image_url: null,
            text: "Bé Lan đọc sách hay.",
            words: buildWordsFromText("Bé Lan đọc sách hay."),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
        },
        wasmWorker: { scriptedOutputs: ["Bé"] },
      });

      await expect(page.locator(".reader-bookplate")).toBeVisible();
      await expect(page.getByTestId("mobile-reading-menu-btn")).toBeHidden();

      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();
      await page.evaluate(() => {
        (
          window as unknown as {
            __voiceHarness: { pulseSpeech: (ms?: number) => void };
          }
        ).__voiceHarness.pulseSpeech(260);
      });
      await expect(
        page.getByRole("button", { name: "Lan" }).first(),
      ).toHaveAttribute("aria-current", "true");

      // Resize across 768 -> 640 boundary
      await page.setViewportSize({ width: 640, height: 960 });
      await expect(page.getByTestId("mobile-reading-menu-btn")).toBeVisible();
      await expect(page.locator(".reader-bookplate")).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Lan" }).first(),
      ).toHaveAttribute("aria-current", "true");
      await assertZeroHorizontalOverflow(page);

      // Resize back to 768x1024
      await page.setViewportSize({ width: 768, height: 1024 });
      await expect(page.locator(".reader-bookplate")).toBeVisible();
      await expect(page.getByTestId("mobile-reading-menu-btn")).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Lan" }).first(),
      ).toHaveAttribute("aria-current", "true");
      await assertZeroHorizontalOverflow(page);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T3.3: Opening 'Cài đặt giọng đọc' from inside ⋮ sheet and closing cleanly at 390x844 & 640x960", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "gap-640x960",
        "Runs on mobile-390x844 and gap-640x960",
      );

      const poetryPage = buildLongPoetryPageSpec(80);
      const session = await installReadingVoiceSession(page, {
        pages: [poetryPage],
      });

      const container = page.locator('[data-reading-scroll-container="true"]');
      const scrolled = await container.evaluate((el) => {
        el.scrollTop = 240;
        return el.scrollTop;
      });

      await page.getByTestId("mobile-reading-menu-btn").click();
      const menuDialog = page.getByRole("dialog", {
        name: "Tùy chọn buổi đọc",
      });
      await expect(menuDialog).toBeVisible();
      await menuDialog
        .getByRole("button", { name: "Cài đặt giọng đọc" })
        .click();

      await expect(menuDialog).toBeHidden();
      const voiceDialog = page.getByRole("dialog");
      await expect(voiceDialog).toBeVisible();
      await expect(voiceDialog.getByText(/Tốc độ đọc/i)).toBeVisible();

      await voiceDialog.getByRole("button", { name: "Đóng hộp thoại" }).click();
      await expect(voiceDialog).toBeHidden();

      const scrollAfter = await container.evaluate((el) => el.scrollTop);
      expect(Math.abs(scrollAfter - scrolled)).toBeLessThanOrEqual(4);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });
  });
});
