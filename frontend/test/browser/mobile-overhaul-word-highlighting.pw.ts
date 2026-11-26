import { expect, test, type Page } from "@playwright/test";
import { normalizeProjectBucket } from "./mobile-overhaul-fixture";
import { ids } from "./real-data-fixture";
import {
  assertMonotonicTransitions,
  buildLongPoetryPageSpec,
  buildWordsFromText,
  installHighlightObserver,
  installReadingVoiceSession,
  measureWordGeometrySnapshot,
  readHighlightTransitions,
  withIsolatedPage,
} from "./reading-voice-harness";

async function openVoiceSettingsDialog(page: Page): Promise<void> {
  const directBtn = page.getByRole("button", {
    name: "Giọng đọc",
    exact: true,
  });
  if (await directBtn.isVisible()) {
    await directBtn.click();
  } else {
    await page.getByTestId("mobile-reading-menu-btn").click();
    const menu = page.getByRole("dialog", { name: "Tùy chọn buổi đọc" });
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Cài đặt giọng đọc" }).click();
  }
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function pulseAndWaitForWord(
  page: Page,
  transcript: string,
  expectedWordName: string,
  expectedState: string,
): Promise<void> {
  await page.evaluate((text) => {
    (
      window as unknown as {
        __wasmWorkerHarness: { enqueueTranscript: (...t: string[]) => void };
        __voiceHarness: { pulseSpeech: (ms?: number) => void };
      }
    ).__wasmWorkerHarness.enqueueTranscript(text);
    (
      window as unknown as {
        __voiceHarness: { pulseSpeech: (ms?: number) => void };
      }
    ).__voiceHarness.pulseSpeech(240);
  }, transcript);

  await expect(
    page.getByRole("button", { name: expectedWordName }).first(),
  ).toHaveAttribute("data-reading-state", expectedState, { timeout: 10_000 });
}

test.describe("E2E-F5: Monotonic Word Highlighting Synchronization (R3)", () => {
  test.describe("Tier 1: Core Monotonicity, Zero-Reflow & Playback Sync", () => {
    test("T1.1: Live STT forward reading advances aria-current='true' monotonically (nextIdx >= prevIdx)", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Sáng sớm bé Lan ngồi đọc sách truyện";
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
            image_url: null,
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
        },
        wasmWorker: { scriptedOutputs: [] },
      });

      await installHighlightObserver(page);
      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();

      await pulseAndWaitForWord(page, "Sáng sớm", "sớm", "correct");
      await pulseAndWaitForWord(page, "bé Lan", "Lan", "correct");
      await pulseAndWaitForWord(page, "ngồi đọc", "đọc", "correct");
      await pulseAndWaitForWord(page, "sách truyện", "truyện", "correct");

      const transitions = await readHighlightTransitions(page);
      assertMonotonicTransitions(transitions, { minDistinctIndices: 4 });
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.2: 'Đọc mẫu' TTS progresses monotonically 0..N-1 with timed audio & restores reading cursor on end", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Bé mèo nhỏ đang đọc sách hay";
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
            image_url: null,
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
          timedTtsDurationSeconds: 2.8,
        },
        wasmWorker: { scriptedOutputs: ["Bé mèo"] },
      });

      // Advance reading cursor to word 2 ("nhỏ") first
      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();
      await page.evaluate(() => {
        (
          window as unknown as {
            __voiceHarness: { pulseSpeech: (ms?: number) => void };
          }
        ).__voiceHarness.pulseSpeech(240);
      });
      await expect(
        page.getByRole("button", { name: "nhỏ" }).first(),
      ).toHaveAttribute("aria-current", "true");
      await page
        .getByRole("button", { name: "Dừng nhận diện giọng nói" })
        .click();

      await installHighlightObserver(page);
      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();

      // Wait until sample playback reaches the last word and finishes
      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 12_000 });

      const transitions = await readHighlightTransitions(page);
      // Sample playback must cover monotonic indices without mid-playback null flicker
      const playbackTransitions = transitions.slice(0, -1);
      assertMonotonicTransitions(playbackTransitions, {
        allowNull: false,
        minDistinctIndices: 4,
      });

      // After sample ends, cursor restores to unread word "nhỏ"
      await expect(
        page.getByRole("button", { name: "nhỏ" }).first(),
      ).toHaveAttribute("aria-current", "true");
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.3: Zero-reflow bounding-box stability across word state transitions", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Bé mèo nhỏ đọc sách hay";
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
            image_url: null,
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
        },
        wasmWorker: { scriptedOutputs: [] },
      });

      const beforeBoxes = await measureWordGeometrySnapshot(page);
      expect(beforeBoxes.length).toBe(6);

      // Click word -> assisted/current, then read -> correct/incorrect/repeated
      await page
        .getByRole("button", { name: "Bé", exact: true })
        .first()
        .click();
      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();
      await pulseAndWaitForWord(page, "Bé chó nhỏ đọc", "nhỏ", "correct");

      const afterBoxes = await measureWordGeometrySnapshot(page);
      expect(afterBoxes.length).toBe(beforeBoxes.length);

      for (let i = 0; i < beforeBoxes.length; i += 1) {
        const b = beforeBoxes[i];
        const a = afterBoxes[i];
        expect(
          Math.abs(a.width - b.width),
          `Width reflow on word "${b.text}"`,
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(a.height - b.height),
          `Height reflow on word "${b.text}"`,
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(a.top - b.top),
          `Vertical reflow on word "${b.text}"`,
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(a.left - b.left),
          `Horizontal reflow on word "${b.text}"`,
        ).toBeLessThanOrEqual(0.5);
      }
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.4: 0.85x / 1.15x playbackRate & pause/resume preserve highlighted word index without resetting to 0", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Sáng sớm bé Lan ngồi đọc sách truyện rất vui";
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
            image_url: null,
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          timedTtsDurationSeconds: 5,
        },
      });

      // Select 0.85x speed preset ("Chậm")
      await openVoiceSettingsDialog(page);
      await page.getByRole("button", { name: /Chậm/i }).click();
      await page.getByRole("button", { name: "Đóng hộp thoại" }).click();

      await installHighlightObserver(page);
      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();

      await expect
        .poll(() =>
          page.evaluate(() => {
            const words = Array.from(
              document.querySelectorAll<HTMLElement>(
                '[data-reading-panel="text"] [data-word-id]',
              ),
            );
            return words.findIndex(
              (w) => w.getAttribute("aria-current") === "true",
            );
          }),
        )
        .toBeGreaterThanOrEqual(2);

      await page
        .getByRole("button", { name: "Tạm dừng mẫu", exact: true })
        .click();
      const pausedIdx = await page.evaluate(() => {
        const words = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-reading-panel="text"] [data-word-id]',
          ),
        );
        return words.findIndex(
          (w) => w.getAttribute("aria-current") === "true",
        );
      });
      expect(pausedIdx).toBeGreaterThanOrEqual(2);

      // Wait briefly while paused: highlight MUST NOT reset to 0
      await page.waitForTimeout(300);
      const stillPausedIdx = await page.evaluate(() => {
        const words = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-reading-panel="text"] [data-word-id]',
          ),
        );
        return words.findIndex(
          (w) => w.getAttribute("aria-current") === "true",
        );
      });
      expect(stillPausedIdx).toBe(pausedIdx);

      // Verify playbackRate reflects 0.85x
      const rateUsed = await page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceHarness: { audios: HTMLAudioElement[] };
            }
          ).__voiceHarness.audios[0]?.playbackRate ?? 1,
      );
      expect(rateUsed).toBeCloseTo(0.85, 1);

      await page
        .getByRole("button", { name: "Tiếp tục mẫu", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 12_000 });

      const transitions = await readHighlightTransitions(page);
      assertMonotonicTransitions(transitions.slice(0, -1), {
        allowNull: false,
      });

      // Now select 1.15x ("Nhanh") and verify playbackRate + monotonic playback
      await openVoiceSettingsDialog(page);
      await page.getByRole("button", { name: /Nhanh/i }).click();
      await page.getByRole("button", { name: "Đóng hộp thoại" }).click();

      const audioCountBeforeFast = await page.evaluate(
        () =>
          (
            window as unknown as {
              __voiceHarness: { audios: HTMLAudioElement[] };
            }
          ).__voiceHarness.audios.length,
      );
      await installHighlightObserver(page);
      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __voiceHarness: { audios: HTMLAudioElement[] };
                }
              ).__voiceHarness.audios.length,
          ),
        )
        .toBeGreaterThan(audioCountBeforeFast);

      const fastRateUsed = await page.evaluate(
        (idx) =>
          (
            window as unknown as {
              __voiceHarness: { audios: HTMLAudioElement[] };
            }
          ).__voiceHarness.audios[idx]?.playbackRate ?? 1,
        audioCountBeforeFast,
      );
      expect(fastRateUsed).toBeCloseTo(1.15, 1);

      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 12_000 });

      const fastTransitions = await readHighlightTransitions(page);
      assertMonotonicTransitions(fastTransitions.slice(0, -1), {
        allowNull: false,
        minDistinctIndices: 3,
      });
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.5: image-overlay & text mode parity for monotonic word highlighting", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Bé mèo đọc sách";
      const session = await installReadingVoiceSession(page, {
        pages: [
          {
            page_id: ids.page,
            page_revision_id: ids.revision,
            page_number: 1,
            confidence: 0.99,
            width: 600,
            height: 800,
            image_overlay_safe: true,
            image_url: "http://127.0.0.1:8000/fixture-page.png",
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
          timedTtsDurationSeconds: 2,
        },
        wasmWorker: { scriptedOutputs: [] },
      });

      await expect(
        page.locator('article[data-render-mode="image-overlay"]'),
      ).toBeVisible();
      await expect(page.locator('[data-image-overlay="true"]')).toBeVisible();

      await installHighlightObserver(page);
      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 10_000 });

      const ttsTransitions = await readHighlightTransitions(page);
      assertMonotonicTransitions(ttsTransitions.slice(0, -1), {
        allowNull: false,
        minDistinctIndices: 3,
      });

      // Also verify live STT advances overlay words monotonically
      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();
      await pulseAndWaitForWord(page, "Bé mèo", "mèo", "correct");
      await pulseAndWaitForWord(page, "đọc sách", "sách", "correct");
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });
  });

  test.describe("Tier 2: Boundary & Child Speech Resilience", () => {
    test("T2.1: Slow/paused child speech (2-4s pauses between words) produces zero premature red skips", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Sáng sớm bé Lan đọc sách";
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
            image_url: null,
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
        },
        wasmWorker: { scriptedOutputs: [] },
      });

      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();

      await pulseAndWaitForWord(page, "Sáng", "Sáng", "correct");
      await page.waitForTimeout(2100);
      await pulseAndWaitForWord(page, "sớm", "sớm", "correct");
      await page.waitForTimeout(2100);
      await pulseAndWaitForWord(page, "bé", "bé", "correct");

      // Upcoming unread words must NEVER be falsely turned red (omission/incorrect)
      const redCount = await page
        .locator(
          '[data-reading-panel="text"] [data-word-id][data-reading-state="omission"], [data-reading-panel="text"] [data-word-id][data-reading-state="incorrect"]',
        )
        .count();
      expect(redCount).toBe(0);
      await expect(
        page.getByRole("button", { name: "Lan" }).first(),
      ).toHaveAttribute("aria-current", "true");
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.2: 1-2 word off-book noise tokens ('à', 'ừm', 'con ơi') trigger 0 false red DELETE skips", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Sáng sớm bé Lan ngồi đọc sách";
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
            image_url: null,
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
        },
        wasmWorker: { scriptedOutputs: [] },
      });

      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();
      await pulseAndWaitForWord(page, "Sáng sớm", "sớm", "correct");

      // Inject 1-2 word off-book noise tokens
      for (const noise of ["à", "ừm", "con ơi"]) {
        await page.evaluate((text) => {
          (
            window as unknown as {
              __wasmWorkerHarness: {
                enqueueTranscript: (...t: string[]) => void;
              };
              __voiceHarness: { pulseSpeech: (ms?: number) => void };
            }
          ).__wasmWorkerHarness.enqueueTranscript(text);
          (
            window as unknown as {
              __voiceHarness: { pulseSpeech: (ms?: number) => void };
            }
          ).__voiceHarness.pulseSpeech(220);
        }, noise);
        await page.waitForTimeout(850);
      }

      const redCount = await page
        .locator(
          '[data-reading-panel="text"] [data-word-id][data-reading-state="omission"], [data-reading-panel="text"] [data-word-id][data-reading-state="incorrect"]',
        )
        .count();
      expect(redCount).toBe(0);

      // Cursor remains calmly at word 2 ("bé")
      await expect(
        page.getByRole("button", { name: "bé" }).first(),
      ).toHaveAttribute("aria-current", "true");
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.3: Long Vietnamese compound/reduplicative words with NFC diacritics highlight monotonically without splits", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence =
        "Con đường khúc khuỷu ngoằn ngoèo nghiêng ngả ánh sao lấp lánh";
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
            image_url: null,
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
        },
        wasmWorker: { scriptedOutputs: [] },
      });

      await installHighlightObserver(page);
      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();

      await pulseAndWaitForWord(
        page,
        "Con đường khúc khuỷu".normalize("NFD"),
        "khuỷu",
        "correct",
      );
      await pulseAndWaitForWord(
        page,
        "ngoằn ngoèo nghiêng ngả",
        "ngả",
        "correct",
      );
      await pulseAndWaitForWord(page, "ánh sao lấp lánh", "lánh", "correct");

      const transitions = await readHighlightTransitions(page);
      assertMonotonicTransitions(transitions, { minDistinctIndices: 5 });

      const redCount = await page
        .locator(
          '[data-reading-panel="text"] [data-word-id][data-reading-state="omission"]',
        )
        .count();
      expect(redCount).toBe(0);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.4: Android approxTimer advancing before late tts_range(0) & precomputed audio without wordTimings stay monotonic with zero flicker", async ({
      browser,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Bé mèo nhỏ đọc sách hay";

      // Part A: Android native TTS late tts_range(0) after approxTimer already advanced (isolated context)
      await withIsolatedPage(browser, testInfo, async (pageA) => {
        const sessionA = await installReadingVoiceSession(pageA, {
          pages: [
            {
              page_id: ids.page,
              page_revision_id: ids.revision,
              page_number: 1,
              confidence: 0.99,
              width: 600,
              height: 800,
              image_overlay_safe: false,
              image_url: null,
              text: sentence,
              words: buildWordsFromText(sentence),
            },
          ],
          voice: {
            localAvailable: false,
            localSttReady: false,
            localTtsReady: false,
            timedTtsStatus: 503,
            shortTtsStatus: 503,
          },
          nativeBridge: {
            ttsAvailable: true,
            viVoicesCount: 2,
            sttAvailable: true,
            autoReplyTtsDone: false,
          },
        });

        await installHighlightObserver(pageA);
        await pageA
          .getByRole("button", { name: "Nghe đọc mẫu cả trang" })
          .click();

        await expect
          .poll(() =>
            pageA.evaluate(
              () =>
                (
                  window as unknown as {
                    __nativeSpeechHarness: {
                      getCommands: (a?: string) => unknown[];
                    };
                  }
                ).__nativeSpeechHarness.getCommands("speak").length,
            ),
          )
          .toBe(1);

        // Start Android TTS and poll until approxTimer advances aria-current >= word index 1 before firing late tts_range(0)
        await pageA.evaluate(() => {
          (
            window as unknown as {
              __nativeSpeechHarness: { pushTtsStart: () => void };
            }
          ).__nativeSpeechHarness.pushTtsStart();
        });
        await expect
          .poll(() =>
            pageA.evaluate(() => {
              const words = Array.from(
                document.querySelectorAll<HTMLElement>(
                  '[data-reading-panel="text"] [data-word-id]',
                ),
              );
              return words.findIndex(
                (w) => w.getAttribute("aria-current") === "true",
              );
            }),
          )
          .toBeGreaterThanOrEqual(1);

        await pageA.evaluate(() => {
          const h = (
            window as unknown as {
              __nativeSpeechHarness: {
                pushTtsRange: (s: number, e: number) => void;
                pushTtsDone: () => void;
              };
            }
          ).__nativeSpeechHarness;
          h.pushTtsRange(0, 2);
          setTimeout(() => h.pushTtsRange(7, 10), 120);
          setTimeout(() => h.pushTtsDone(), 260);
        });

        await expect(
          pageA.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
        ).toBeVisible({ timeout: 10_000 });

        const androidTransitions = await readHighlightTransitions(pageA);
        assertMonotonicTransitions(androidTransitions.slice(0, -1), {
          allowNull: false,
        });
        expect(sessionA.unexpectedReadingPaths).toEqual([]);
        expect(sessionA.api.unexpected).toEqual([]);
      });

      // Part B: Precomputed catalog URL lacking tts_word_timings in an isolated context (no ViReadNativeSpeech bleed)
      await withIsolatedPage(browser, testInfo, async (pageB) => {
        const sessionB = await installReadingVoiceSession(pageB, {
          visibilityScope: "CATALOG",
          pages: [
            {
              page_id: ids.page,
              page_revision_id: ids.revision,
              page_number: 1,
              confidence: 0.99,
              width: 600,
              height: 800,
              image_overlay_safe: false,
              image_url: null,
              tts_audio_url:
                "http://127.0.0.1:8000/viread-catalog-tts/page1.wav",
              tts_word_timings: null,
              text: sentence,
              words: buildWordsFromText(sentence),
            },
          ],
          voice: {
            timedTtsStatus: 503,
            shortTtsStatus: 503,
            timedTtsDurationSeconds: 2,
          },
        });

        await installHighlightObserver(pageB);
        await pageB
          .getByRole("button", { name: "Nghe đọc mẫu cả trang" })
          .click();
        await expect(
          pageB.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
        ).toBeVisible({ timeout: 10_000 });

        expect(sessionB.catalogTtsRequests.length).toBeGreaterThanOrEqual(1);
        const precomputedTransitions = await readHighlightTransitions(pageB);
        assertMonotonicTransitions(precomputedTransitions.slice(0, -1), {
          allowNull: false,
        });
        expect(sessionB.unexpectedReadingPaths).toEqual([]);
        expect(sessionB.api.unexpected).toEqual([]);
      });
    });

    test("T2.5: Interim transcript repeating cursor-1 (confidence: 0) or dropping leading word does NOT rewind active cursor", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Sáng sớm bé Lan đọc sách";
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
            image_url: null,
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
          sttStatus: 503,
        },
        nativeBridge: {
          ttsAvailable: true,
          viVoicesCount: 2,
          sttAvailable: true,
        },
        wasmWorker: {
          initError: "WASM aborted",
          crashOnInit: true,
        },
      });

      await installHighlightObserver(page);
      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __nativeSpeechHarness: {
                    getCommands: (a?: string) => unknown[];
                  };
                }
              ).__nativeSpeechHarness.getCommands("startStt").length,
          ),
        )
        .toBeGreaterThanOrEqual(1);

      // Confirm words 0 ("Sáng") and 1 ("sớm") -> cursor moves to word 2 ("bé")
      await page.evaluate(() => {
        (
          window as unknown as {
            __nativeSpeechHarness: { pushSttFinal: (t: string) => void };
          }
        ).__nativeSpeechHarness.pushSttFinal("Sáng sớm");
      });
      await expect(
        page.getByRole("button", { name: "sớm" }).first(),
      ).toHaveAttribute("data-reading-state", "correct", { timeout: 10_000 });
      await expect(
        page.getByRole("button", { name: "bé" }).first(),
      ).toHaveAttribute("aria-current", "true");

      // Emit Android stt_partial (confidence: 0) repeating cursor - 1 ("sớm")
      await page.evaluate(() => {
        (
          window as unknown as {
            __nativeSpeechHarness: { pushSttPartial: (t: string) => void };
          }
        ).__nativeSpeechHarness.pushSttPartial("sớm");
      });
      await page.waitForTimeout(150);
      await expect(
        page.getByRole("button", { name: "bé" }).first(),
      ).toHaveAttribute("aria-current", "true");

      // Emit Android stt_partial (confidence: 0) dropping leading word ("Lan" while cursor is at "bé")
      await page.evaluate(() => {
        (
          window as unknown as {
            __nativeSpeechHarness: { pushSttPartial: (t: string) => void };
          }
        ).__nativeSpeechHarness.pushSttPartial("Lan");
      });
      await page.waitForTimeout(150);
      await expect(
        page.getByRole("button", { name: "bé" }).first(),
      ).toHaveAttribute("aria-current", "true");

      // Confirm remaining phrase -> cursor never rewound backward
      await page.evaluate(() => {
        (
          window as unknown as {
            __nativeSpeechHarness: { pushSttFinal: (t: string) => void };
          }
        ).__nativeSpeechHarness.pushSttFinal("bé Lan");
      });
      await expect(
        page.getByRole("button", { name: "Lan" }).first(),
      ).toHaveAttribute("data-reading-state", "correct", { timeout: 10_000 });

      const transitions = await readHighlightTransitions(page);
      assertMonotonicTransitions(transitions, { allowNull: false });
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });
  });

  test.describe("Tier 3: Pairwise Highlighting & Audio Preemption", () => {
    test("T3.1: Clicking 'Đọc mẫu' while idle coaching TTS is loading/503 preempts coaching and tracks 'Đọc mẫu' monotonically", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Bé mèo nhỏ đang đọc sách";
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
            image_url: null,
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          shortTtsDelayMs: 2500,
          shortTtsStatus: 503,
          timedTtsDurationSeconds: 2.2,
        },
      });

      // Trigger slow/503 coaching via single word, then immediately click "Nghe đọc mẫu cả trang"
      await page
        .getByRole("button", { name: "Bé", exact: true })
        .first()
        .click();
      await installHighlightObserver(page);
      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();

      // "Đọc mẫu" UI must take over immediately without being stuck in coaching
      await expect(page.getByText("Đọc mẫu", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 10_000 });

      const transitions = await readHighlightTransitions(page);
      assertMonotonicTransitions(transitions.slice(0, -1), {
        allowNull: false,
        minDistinctIndices: 3,
      });
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T3.2: Tapping single word mid-'Đọc mẫu' cancels sample cleanly and resumes live reading without cursor corruption", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const sentence = "Bé mèo nhỏ đọc sách hay";
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
            image_url: null,
            text: sentence,
            words: buildWordsFromText(sentence),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
          timedTtsDurationSeconds: 6,
          shortTtsDurationSeconds: 0.8,
        },
        wasmWorker: { scriptedOutputs: [] },
      });

      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
      await expect(page.getByText("Đọc mẫu", { exact: true })).toBeVisible();

      // Tap single word "nhỏ" mid-sample
      await page
        .getByRole("button", { name: "nhỏ", exact: true })
        .first()
        .click();
      await expect(page.getByText("Đọc mẫu từ")).toBeVisible();

      // Wait for single word to finish, then start live reading from unread word 0 ("Bé")
      await expect(page.getByText("Đọc mẫu từ")).toBeHidden({ timeout: 8_000 });
      await installHighlightObserver(page);
      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();

      await pulseAndWaitForWord(page, "Bé mèo", "mèo", "correct");
      const transitions = await readHighlightTransitions(page);
      assertMonotonicTransitions(transitions, { allowNull: false });
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T3.3: Manual scroll detach (data-auto-follow='paused') during 'Đọc mẫu' -> 'Về từ đang đọc' on 390x844", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(bucket !== "mobile-390x844", "Runs on mobile-390x844");

      const poetryPage = buildLongPoetryPageSpec(120);
      const session = await installReadingVoiceSession(page, {
        pages: [poetryPage],
        voice: { timedTtsDurationSeconds: 12 },
      });

      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
      await expect(page.getByText("Đọc mẫu", { exact: true })).toBeVisible();

      const container = page.locator('[data-reading-scroll-container="true"]');
      await container.evaluate((el) => {
        el.scrollTop = Math.max(el.scrollTop, 1600);
        el.dispatchEvent(new Event("scroll"));
      });

      await expect(container).toHaveAttribute("data-auto-follow", "paused");
      const resumeBtn = page.getByTestId("resume-auto-follow-btn");
      await expect(resumeBtn).toBeVisible();

      const scrollBefore = await container.evaluate((el) => el.scrollTop);
      await page.waitForTimeout(350);
      const scrollAfter = await container.evaluate((el) => el.scrollTop);
      expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(4);

      await resumeBtn.click();
      await expect(container).toHaveAttribute("data-auto-follow", "active");
      await expect
        .poll(() => container.evaluate((el) => el.scrollTop))
        .toBeLessThan(400);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });
  });
});
