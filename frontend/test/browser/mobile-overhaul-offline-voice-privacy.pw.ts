import { expect, test, type Page } from "@playwright/test";
import { normalizeProjectBucket } from "./mobile-overhaul-fixture";
import { book as baseBook, child, ids } from "./real-data-fixture";
import {
  assertMonotonicTransitions,
  buildWordsFromText,
  installHighlightObserver,
  installReadingVoiceSession,
  readHighlightTransitions,
} from "./reading-voice-harness";

async function readSttTier(page: Page): Promise<string | null> {
  const menuBtn = page.getByTestId("mobile-reading-menu-btn");
  if (await menuBtn.isVisible()) {
    await menuBtn.click();
    const dialog = page.getByRole("dialog", { name: "Tùy chọn buổi đọc" });
    await expect(dialog).toBeVisible();
    const tier = await dialog
      .getByTestId("voice-engine-status-badge")
      .getAttribute("data-stt-tier");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    return tier;
  }
  return page
    .getByTestId("voice-engine-status-badge")
    .first()
    .getAttribute("data-stt-tier");
}

async function openVoiceSettingsAndClose(page: Page): Promise<void> {
  const directBtn = page.getByRole("button", {
    name: "Giọng đọc",
    exact: true,
  });
  let healthResponse: ReturnType<Page["waitForResponse"]>;
  if (await directBtn.isVisible()) {
    healthResponse = page.waitForResponse(
      (res) => res.url().includes("/voice/status") && res.status() === 200,
    );
    await directBtn.click();
  } else {
    await page.getByTestId("mobile-reading-menu-btn").click();
    const menu = page.getByRole("dialog", { name: "Tùy chọn buổi đọc" });
    await expect(menu).toBeVisible();
    healthResponse = page.waitForResponse(
      (res) => res.url().includes("/voice/status") && res.status() === 200,
    );
    await menu.getByRole("button", { name: "Cài đặt giọng đọc" }).click();
  }
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await healthResponse;
  await expect(dialog.getByText(/Local Worker:/)).toBeVisible();
  await dialog.getByRole("button", { name: "Đóng hộp thoại" }).click();
  await expect(dialog).toBeHidden();
}

async function assertZeroHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
}

test.describe("E2E-F6: Offline STT/TTS, Android Bridge & PARENT_PRIVATE Isolation (R4, R5) + Tier 4 Journeys", () => {
  test.describe("Tier 1: Core Offline Voice Autonomy & Privacy Isolation", () => {
    test("T1.1: Unauthenticated fetch of /workers/sherpa-stt-worker.js & /wasm/sherpa/sherpa-onnx-asr.js returns HTTP 200 (no /login redirect)", async ({
      browser,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "desktop-1440x1000",
        "Runs once on desktop-1440x1000",
      );

      const baseURL = testInfo.project.use.baseURL ?? "http://127.0.0.1:3106";
      const unauthContext = await browser.newContext({
        baseURL,
        extraHTTPHeaders: {},
      });
      try {
        const workerRes = await unauthContext.request.get(
          "/workers/sherpa-stt-worker.js",
          { maxRedirects: 0 },
        );
        expect(workerRes.status()).toBe(200);
        const workerText = await workerRes.text();
        expect(workerText).toContain("sherpa-onnx");

        const wasmJsRes = await unauthContext.request.get(
          "/wasm/sherpa/sherpa-onnx-asr.js",
          { maxRedirects: 0 },
        );
        expect(wasmJsRes.status()).toBe(200);
      } finally {
        await unauthContext.close();
      }
    });

    test("T1.2: Offline WASM STT preferred over Android vi-VN when local worker is down", async ({
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
            text: "Bé mèo đọc sách",
            words: buildWordsFromText("Bé mèo đọc sách"),
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
          onDeviceSttAvailable: true,
        },
        wasmWorker: {
          scriptedOutputs: ["Bé mèo"],
        },
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
        page.getByRole("button", { name: "mèo" }).first(),
      ).toHaveAttribute("data-reading-state", "correct", { timeout: 10_000 });

      const sttTier = await readSttTier(page);
      expect(sttTier).toBe("browser_wasm");

      const androidStartSttCount = await page.evaluate(
        () =>
          (
            window as unknown as {
              __nativeSpeechHarness: {
                getCommands: (action?: string) => unknown[];
              };
            }
          ).__nativeSpeechHarness.getCommands("startStt").length,
      );
      expect(androidStartSttCount).toBe(0);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.3: Worker-independent 'Đọc mẫu' succeeds via ViReadNativeSpeech (viVoicesCount: 2) without blocking", async ({
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
            text: "Bé mèo nhỏ đọc sách",
            words: buildWordsFromText("Bé mèo nhỏ đọc sách"),
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
          ttsDurationMs: 500,
        },
      });

      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();

      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __nativeSpeechHarness: {
                    getCommands: (action?: string) => unknown[];
                  };
                }
              ).__nativeSpeechHarness.getCommands("speak").length,
          ),
        )
        .toBe(1);

      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 8_000 });
      await expect(page.locator('[data-reading-shell="true"]')).toHaveAttribute(
        "data-child-error-count",
        "0",
      );
      await expect(page.getByText(/Mình chưa phát được âm thanh/)).toBeHidden();
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.4: Resilient failover to android_native ONLY on genuine unrecoverable WASM error", async ({
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
            text: "Bé mèo đọc",
            words: buildWordsFromText("Bé mèo đọc"),
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

      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();

      // Genuine WASM failure triggers clean failover to Android native STT
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __nativeSpeechHarness: {
                    getCommands: (action?: string) => unknown[];
                  };
                }
              ).__nativeSpeechHarness.getCommands("startStt").length,
          ),
        )
        .toBeGreaterThanOrEqual(1);

      const sttTier = await readSttTier(page);
      expect(sttTier).toBe("android_native");

      await page.evaluate(() => {
        (
          window as unknown as {
            __nativeSpeechHarness: { pushSttFinal: (t: string) => void };
          }
        ).__nativeSpeechHarness.pushSttFinal("Bé mèo");
      });

      await expect(
        page.getByRole("button", { name: "mèo" }).first(),
      ).toHaveAttribute("data-reading-state", "correct");
      await expect(page.locator('[data-reading-shell="true"]')).toHaveAttribute(
        "data-child-error-count",
        "0",
      );
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T1.5: PARENT_PRIVATE isolation enforces cache_scope='PRIVATE', 0 viread-catalog-tts fetches & 0 IDB/CacheStorage writes", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const session = await installReadingVoiceSession(page, {
        visibilityScope: "PARENT_PRIVATE",
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
            text: "Trang riêng tư của bé",
            words: buildWordsFromText("Trang riêng tư của bé"),
          },
        ],
        voice: { timedTtsDurationSeconds: 1.2, shortTtsDurationSeconds: 0.6 },
      });

      await page
        .getByRole("button", { name: "Trang", exact: true })
        .first()
        .click();
      await expect(page.getByText("Đọc mẫu từ")).toBeHidden({ timeout: 8_000 });

      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 8_000 });

      const leakage = await session.inspectLeakage();
      expect(leakage.catalogTtsRequests).toEqual([]);
      expect(leakage.idbEntryCount).toBe(0);
      expect(leakage.cacheStorageKeys).toEqual([]);
      expect(leakage.ttsRequests.length).toBeGreaterThanOrEqual(1);
      for (const req of leakage.ttsRequests) {
        expect(req.cacheScope).toBe("PRIVATE");
        expect(req.responseScope).toBe("PRIVATE");
      }
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });
  });

  test.describe("Tier 2: Cold-Start, Missing Voice Pack, Poisoning & Policy Boundaries", () => {
    test("T2.1: Slow WASM init cold-start (6000ms > 4s) does NOT trigger premature android_native switch", async ({
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
            text: "Bé mèo đọc sách",
            words: buildWordsFromText("Bé mèo đọc sách"),
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
          initDelayMs: 6_000,
          scriptedOutputs: ["Bé mèo"],
        },
      });

      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();

      // Trigger rolling speech pulses across the 4s mark while WASM init is still in-flight
      await page.waitForTimeout(1_600);
      await page.evaluate(() => {
        (
          window as unknown as {
            __voiceHarness: { pulseSpeech: (ms?: number) => void };
          }
        ).__voiceHarness.pulseSpeech(260);
      });
      await page.waitForTimeout(3_000);

      // Must STILL be browser_wasm (never prematurely switched to android_native!)
      const midColdStartTier = await readSttTier(page);
      expect(midColdStartTier).toBe("browser_wasm");
      const midStartSttCount = await page.evaluate(
        () =>
          (
            window as unknown as {
              __nativeSpeechHarness: {
                getCommands: (action?: string) => unknown[];
              };
            }
          ).__nativeSpeechHarness.getCommands("startStt").length,
      );
      expect(midStartSttCount).toBe(0);

      // Wait for 6000ms WASM init to complete, then pulse speech -> decodes via WASM
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (
                  window as unknown as {
                    __wasmWorkerHarness: {
                      getStats: () => { initResolvedCount: number };
                    };
                  }
                ).__wasmWorkerHarness.getStats().initResolvedCount,
            ),
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(1);

      await page.evaluate(() => {
        (
          window as unknown as {
            __wasmWorkerHarness: {
              enqueueTranscript: (...t: string[]) => void;
            };
            __voiceHarness: { pulseSpeech: (ms?: number) => void };
          }
        ).__wasmWorkerHarness.enqueueTranscript("Bé mèo");
        (
          window as unknown as {
            __voiceHarness: { pulseSpeech: (ms?: number) => void };
          }
        ).__voiceHarness.pulseSpeech(260);
      });

      await expect(
        page.getByRole("button", { name: "mèo" }).first(),
      ).toHaveAttribute("data-reading-state", "correct", { timeout: 10_000 });
      expect(await readSttTier(page)).toBe("browser_wasm");
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.2: Missing Android vi-VN TTS voice pack (viVoicesCount: 0, ttsAvailable: false) handled gracefully without trapping reading", async ({
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
            text: "Bé mèo đọc sách",
            words: buildWordsFromText("Bé mèo đọc sách"),
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
          ttsAvailable: false,
          viVoicesCount: 0,
          sttAvailable: true,
        },
        wasmWorker: { scriptedOutputs: ["Bé"] },
      });

      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();

      await expect
        .poll(() => session.ttsRequests.length)
        .toBeGreaterThanOrEqual(1);

      // Must NOT dispatch speak to Android TTS when viVoicesCount=0 / ttsAvailable=false
      const speakCount = await page.evaluate(
        () =>
          (
            window as unknown as {
              __nativeSpeechHarness: {
                getCommands: (action?: string) => unknown[];
              };
            }
          ).__nativeSpeechHarness.getCommands("speak").length,
      );
      expect(speakCount).toBe(0);

      // Reading must remain safe (0 child errors) and non-blocking (no "Đọc tiếp" error modal)
      await expect(page.locator('[data-reading-shell="true"]')).toHaveAttribute(
        "data-child-error-count",
        "0",
      );
      await expect(
        page.getByRole("button", { name: "Đọc tiếp", exact: true }),
      ).toBeHidden();

      // Non-blocking missing-voice notice / "Cài đặt TTS" guidance must be surfaced
      const inlineMissingNotice = page
        .getByText(/Cài đặt TTS|chưa cài giọng đọc tiếng Việt/i)
        .first();
      if (!(await inlineMissingNotice.isVisible().catch(() => false))) {
        await page.getByTestId("mobile-reading-menu-btn").click();
        const dialog = page.getByRole("dialog", { name: "Tùy chọn buổi đọc" });
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByText(/Cài đặt TTS|chưa cài giọng đọc tiếng Việt/i),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      }

      // Child can still start live reading without being trapped
      const micBtn = page.getByRole("button", {
        name: "Bé đọc với nhận diện giọng nói",
      });
      await expect(micBtn).toBeEnabled();
      await micBtn.click();
      await page.evaluate(() => {
        (
          window as unknown as {
            __voiceHarness: { pulseSpeech: (ms?: number) => void };
          }
        ).__voiceHarness.pulseSpeech(260);
      });
      await expect(
        page.getByRole("button", { name: "Bé" }).first(),
      ).toHaveAttribute("data-reading-state", "correct", { timeout: 10_000 });
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.3: PARENT_PRIVATE poisoning guard ignores injected tts_audio_url pointing to viread-catalog-tts", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      const session = await installReadingVoiceSession(page, {
        visibilityScope: "PARENT_PRIVATE",
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
            // Malicious/poisoned catalog URL on a PARENT_PRIVATE book
            tts_audio_url:
              "http://127.0.0.1:8000/viread-catalog-tts/poisoned-private.mp3",
            tts_word_timings: [{ index: 0, start: 0, end: 0.5 }],
            text: "Sách riêng tư",
            words: buildWordsFromText("Sách riêng tư"),
          },
        ],
        voice: { timedTtsDurationSeconds: 1 },
      });

      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 8_000 });

      const leakage = await session.inspectLeakage();
      expect(leakage.catalogTtsRequests).toEqual([]);
      expect(leakage.idbEntryCount).toBe(0);
      expect(leakage.cacheStorageKeys).toEqual([]);
      expect(leakage.ttsRequests.some((r) => r.cacheScope === "PRIVATE")).toBe(
        true,
      );
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.4: Android HAL mic contention cleanup stops WebView MediaStream tracks BEFORE startStt", async ({
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
            text: "Bé mèo đọc",
            words: buildWordsFromText("Bé mèo đọc"),
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
                    getCommands: (action?: string) => unknown[];
                  };
                }
              ).__nativeSpeechHarness.getCommands("startStt").length,
          ),
        )
        .toBeGreaterThanOrEqual(1);

      const halState = await page.evaluate(() => {
        const harness = window as unknown as {
          __voiceHarness: { activeTracks: number; lastTrackStoppedAt: number };
          __nativeSpeechHarness: {
            getCommands: (action?: string) => Array<{
              timestamp: number;
              activeTracksAtDispatch: number;
            }>;
          };
        };
        const startCmd =
          harness.__nativeSpeechHarness.getCommands("startStt")[0];
        return {
          activeTracksNow: harness.__voiceHarness.activeTracks,
          activeTracksAtDispatch: startCmd?.activeTracksAtDispatch ?? -1,
          lastTrackStoppedAt: harness.__voiceHarness.lastTrackStoppedAt,
          startSttTimestamp: startCmd?.timestamp ?? 0,
        };
      });

      expect(halState.activeTracksNow).toBe(0);
      expect(halState.activeTracksAtDispatch).toBe(0);
      if (halState.lastTrackStoppedAt > 0) {
        expect(halState.lastTrackStoppedAt).toBeLessThanOrEqual(
          halState.startSttTimestamp + 5,
        );
      }
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T2.5: local_only policy forbids Google Cloud & browser cloud fallback under double outage", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(bucket !== "desktop-1440x1000", "Runs on desktop-1440x1000");

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
            text: "Bé mèo đọc",
            words: buildWordsFromText("Bé mèo đọc"),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: false,
          googleSttConfigured: false,
          googleTtsConfigured: false,
          timedTtsStatus: 503,
          shortTtsStatus: 503,
          sttStatus: 503,
        },
        // No ViReadNativeSpeech on desktop; WASM aborted; browser SpeechRecognition & speechSynthesis spied
        wasmWorker: { initError: "WASM aborted", crashOnInit: true },
        speechAndAudio: {
          browserSpeechRecognition: true,
          browserVoices: [{ lang: "vi-VN" }],
        },
      });

      // Trigger STT & TTS under double outage with local_only policy
      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
      await page.waitForTimeout(500);

      const continueBtn = page.getByRole("button", {
        name: "Đọc tiếp",
        exact: true,
      });
      if (await continueBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await continueBtn.click();
      }

      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();
      await page.waitForTimeout(500);

      const spyStats = await page.evaluate(() => {
        const h = (
          window as unknown as {
            __voiceHarness: {
              utterances: unknown[];
              browserRecStarts: number;
            };
          }
        ).__voiceHarness;
        return {
          utterancesCount: h.utterances.length,
          browserRecStarts: h.browserRecStarts,
        };
      });
      expect(spyStats.utterancesCount).toBe(0);
      expect(spyStats.browserRecStarts).toBe(0);
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });
  });

  test.describe("Tier 3: Pairwise Voice Outage, Preemption & Privacy Switching", () => {
    test("T3.1: Clicking 'Đọc mẫu' while idle coaching TTS is loading/503 is not hijacked by locked-voice warning", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
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
            text: "Bé mèo nhỏ đọc sách",
            words: buildWordsFromText("Bé mèo nhỏ đọc sách"),
          },
        ],
        voice: {
          shortTtsDelayMs: 1_500,
          shortTtsStatus: 503,
          timedTtsDurationSeconds: 1.8,
        },
      });

      // Trigger slow/503 single-word coaching then immediately click "Nghe đọc mẫu cả trang"
      await page
        .getByRole("button", { name: "Bé", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();

      await expect(page.getByText("Đọc mẫu", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 8_000 });
      await expect(page.locator('[data-reading-shell="true"]')).toHaveAttribute(
        "data-child-error-count",
        "0",
      );

      // Ensure after the 1500ms delayed 503 settles, locked-voice warning is NOT displayed anywhere
      await expect(page.getByText(/Giọng đọc đã khóa/)).toBeHidden();
      const menuBtn = page.getByTestId("mobile-reading-menu-btn");
      if (await menuBtn.isVisible()) {
        await menuBtn.click();
        const dialog = page.getByRole("dialog", { name: "Tùy chọn buổi đọc" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText(/Giọng đọc đã khóa/)).toBeHidden();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
      }
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T3.2: Mid-session worker outage -> WASM offline STT -> worker recovery preserves confirmed words", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
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
            text: "Bé mèo nhỏ đọc",
            words: buildWordsFromText("Bé mèo nhỏ đọc"),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: true,
          sttStatus: 503,
        },
        wasmWorker: { scriptedOutputs: [] },
      });

      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();

      // Read words 0..1 via WASM while local worker is down
      await page.evaluate(() => {
        const w = window as unknown as {
          __wasmWorkerHarness: { enqueueTranscript: (...t: string[]) => void };
          __voiceHarness: { pulseSpeech: (ms?: number) => void };
        };
        w.__wasmWorkerHarness.enqueueTranscript("Bé mèo");
        w.__voiceHarness.pulseSpeech(240);
      });
      await expect(
        page.getByRole("button", { name: "mèo" }).first(),
      ).toHaveAttribute("data-reading-state", "correct", { timeout: 10_000 });
      expect(await readSttTier(page)).toBe("browser_wasm");

      // Stop listening, bring local worker back online, refresh health via voice settings, and restart STT
      await page
        .getByRole("button", { name: "Dừng nhận diện giọng nói" })
        .click();

      session.voiceState.localAvailable = true;
      session.voiceState.localSttReady = true;
      session.voiceState.sttStatus = 200;
      session.voiceState.sttTranscript = "nhỏ";

      await openVoiceSettingsAndClose(page);

      await page
        .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
        .click();

      await expect(
        page.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
      ).toBeVisible();
      await expect.poll(() => readSttTier(page)).toBe("local_offline");

      // Speak word 2 ("nhỏ") -> decoded by recovered local worker /voice/speech-to-text
      await page.evaluate(() => {
        (
          window as unknown as {
            __voiceHarness: { pulseSpeech: (ms?: number) => void };
          }
        ).__voiceHarness.pulseSpeech(260);
      });

      await expect
        .poll(() => session.sttRequests.length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(1);
      await expect(
        page.getByRole("button", { name: "nhỏ" }).first(),
      ).toHaveAttribute("data-reading-state", "correct", { timeout: 10_000 });
      expect(await readSttTier(page)).toBe("local_offline");

      // Confirmed words 0..1 must remain intact
      await expect(
        page.getByRole("button", { name: "Bé" }).first(),
      ).toHaveAttribute("data-reading-state", "correct");
      await expect(
        page.getByRole("button", { name: "mèo" }).first(),
      ).toHaveAttribute("data-reading-state", "correct");
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });

    test("T3.3: Switching from PUBLIC catalog book to PARENT_PRIVATE book in same browser context leaks zero cache entries", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-390x844" && bucket !== "desktop-1440x1000",
        "Runs on mobile-390x844 and desktop-1440x1000",
      );

      // Step 1: Open PUBLIC catalog book and play TTS
      const publicSession = await installReadingVoiceSession(page, {
        bookId: ids.book,
        sessionId: ids.session,
        visibilityScope: "CATALOG",
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
            text: "Sách công khai",
            words: buildWordsFromText("Sách công khai"),
          },
        ],
        voice: { shortTtsDurationSeconds: 0.5 },
      });
      await page
        .getByRole("button", { name: "Sách", exact: true })
        .first()
        .click();
      await expect(page.getByText("Đọc mẫu từ")).toBeHidden({ timeout: 8_000 });
      const beforePrivateLeakage = await publicSession.inspectLeakage();
      expect(publicSession.unexpectedReadingPaths).toEqual([]);
      expect(publicSession.api.unexpected).toEqual([]);

      // Step 2: Switch to PARENT_PRIVATE book in the exact same browser context
      const privateBookId = "33333333-3333-4333-8333-333333333334";
      const privateSessionId = "44444444-4444-4444-8444-444444444445";
      const privateSession = await installReadingVoiceSession(page, {
        bookId: privateBookId,
        sessionId: privateSessionId,
        visibilityScope: "PARENT_PRIVATE",
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
            text: "Trang bí mật",
            words: buildWordsFromText("Trang bí mật"),
          },
        ],
        voice: { shortTtsDurationSeconds: 0.5, timedTtsDurationSeconds: 0.8 },
      });

      await page
        .getByRole("button", { name: "Trang", exact: true })
        .first()
        .click();
      await expect(page.getByText("Đọc mẫu từ")).toBeHidden({ timeout: 8_000 });
      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 8_000 });

      const afterPrivateLeakage = await privateSession.inspectLeakage();
      expect(afterPrivateLeakage.catalogTtsRequests).toEqual([]);
      expect(afterPrivateLeakage.cacheStorageKeys).toEqual([]);
      // Zero new IndexedDB entries added for the private book
      expect(afterPrivateLeakage.idbEntryCount).toBe(
        beforePrivateLeakage.idbEntryCount,
      );
      for (const key of afterPrivateLeakage.idbKeys) {
        expect(key).not.toContain("PRIVATE");
        expect(key).not.toContain("Trang bí mật");
      }
      expect(privateSession.unexpectedReadingPaths).toEqual([]);
      expect(privateSession.api.unexpected).toEqual([]);
    });
  });

  test.describe("Tier 4: Real-World End-to-End Journeys (J4 & J5)", () => {
    for (const vp of [
      {
        name: "390x844",
        bucket: "mobile-390x844",
        width: 390,
        height: 844,
      },
      {
        name: "640x960",
        bucket: "gap-640x960",
        width: 640,
        height: 960,
      },
    ]) {
      test(`Journey J4 (${vp.name}): Parent /dashboard -> /books -> /reading-preparation -> Child Reading (Clean Canvas + 'Đọc mẫu' + Offline WASM STT) -> Finish -> /sessions Đọc lại & /reports/difficult-words`, async ({
        page,
      }, testInfo) => {
        const bucket = normalizeProjectBucket(testInfo.project.name);
        test.skip(
          bucket !== vp.bucket,
          `Journey J4 (${vp.name}) runs on ${vp.bucket}`,
        );

        const passage = "Sáng sớm đường khúc khuỷu bé đọc";
        const session = await installReadingVoiceSession(page, {
          autoNavigate: false,
          previewStatus: 200,
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
              text: passage,
              words: buildWordsFromText(passage),
            },
          ],
          voice: {
            localAvailable: false,
            localSttReady: false,
            localTtsReady: true,
            sttStatus: 503,
            timedTtsDurationSeconds: 1.8,
          },
          nativeBridge: {
            ttsAvailable: true,
            viVoicesCount: 2,
            sttAvailable: true,
          },
          wasmWorker: {
            initDelayMs: 5_000,
            scriptedOutputs: [],
          },
        });

        // 1. Parent selects child on /dashboard -> /books -> /books/[id]
        await page.goto("/dashboard");
        await assertZeroHorizontalOverflow(page);
        const childBtn = page.getByRole("button", {
          name: `${child.alias}, lớp ${child.grade}`,
        });
        await childBtn.click();
        await expect(childBtn).toHaveAttribute("aria-pressed", "true");
        await page.getByRole("button", { name: "Chọn sách" }).click();
        await expect(page).toHaveURL(/\/books$/);
        await assertZeroHorizontalOverflow(page);

        await page
          .getByRole("link", { name: `Đọc sách ${baseBook.title}` })
          .click();
        await expect(page).toHaveURL(new RegExp(`/books/${ids.book}`));
        await assertZeroHorizontalOverflow(page);

        await page.getByRole("button", { name: "Chuẩn bị đọc" }).click();
        await expect(page).toHaveURL(/\/reading-preparation/);
        await assertZeroHorizontalOverflow(page);

        // 2. Reading preparation -> "Bắt đầu đọc" -> /reading/[sessionId]?state=ready -> "Bắt đầu đọc"
        const verifyMicBtn = page.getByRole("button", {
          name: /Kiểm tra.*microphone/i,
        });
        if (await verifyMicBtn.isVisible().catch(() => false)) {
          await verifyMicBtn.click();
        }
        const prepStartBtn = page.getByRole("button", { name: "Bắt đầu đọc" });
        await expect(prepStartBtn).toBeEnabled({ timeout: 8_000 });
        await prepStartBtn.click();
        await expect(page).toHaveURL(
          new RegExp(`/reading/${ids.session}\\?state=ready`),
        );

        await page.getByRole("button", { name: "Bắt đầu đọc" }).click();
        await expect(page.locator('[data-reading-shell="true"]')).toBeVisible();

        // 3. Clean mobile canvas & ⋮ sheet check
        const leafBox = await page.locator(".reader-leaf").boundingBox();
        expect(leafBox).not.toBeNull();
        expect(leafBox!.height).toBeGreaterThanOrEqual(vp.height * 0.55);
        await expect(page.getByTestId("mobile-reading-menu-btn")).toBeVisible();

        // 4. "Đọc mẫu" with monotonic highlight
        await installHighlightObserver(page);
        await page
          .getByRole("button", { name: "Nghe đọc mẫu cả trang" })
          .click();
        await expect(
          page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
        ).toBeVisible({ timeout: 10_000 });
        const sampleTransitions = await readHighlightTransitions(page);
        assertMonotonicTransitions(sampleTransitions.slice(0, -1), {
          allowNull: false,
        });

        // 5. Offline WASM STT reading (5s cold-start + 1-word noise + compound word pause + completion)
        await installHighlightObserver(page);
        await page
          .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
          .click();

        await expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  (
                    window as unknown as {
                      __wasmWorkerHarness: {
                        getStats: () => { initResolvedCount: number };
                      };
                    }
                  ).__wasmWorkerHarness.getStats().initResolvedCount,
              ),
            { timeout: 10_000 },
          )
          .toBeGreaterThanOrEqual(1);

        // Read first phrase, inject 1-word noise "à", pause, then read compound word "khúc khuỷu"
        for (const utterance of [
          "Sáng sớm",
          "à",
          "đường khúc khuỷu",
          "bé đọc",
        ]) {
          await page.evaluate((text) => {
            const w = window as unknown as {
              __wasmWorkerHarness: {
                enqueueTranscript: (...t: string[]) => void;
              };
              __voiceHarness: { pulseSpeech: (ms?: number) => void };
            };
            w.__wasmWorkerHarness.enqueueTranscript(text);
            w.__voiceHarness.pulseSpeech(250);
          }, utterance);
          await page.waitForTimeout(950);
        }

        await expect(
          page.getByRole("button", { name: "đọc" }).first(),
        ).toHaveAttribute("data-reading-state", "correct", { timeout: 10_000 });

        const sttTransitions = await readHighlightTransitions(page);
        assertMonotonicTransitions(sttTransitions);
        const redSkips = await page
          .locator(
            '[data-reading-panel="text"] [data-word-id][data-reading-state="omission"]',
          )
          .count();
        expect(redSkips).toBe(0);
        expect(await readSttTier(page)).toBe("browser_wasm");

        // 6. Finish session -> completion summary -> /sessions -> /sessions/[id] -> /reports/difficult-words
        await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
        await page.getByRole("button", { name: "Lưu và dừng" }).click();
        await expect(
          page.getByRole("heading", {
            name: /Buổi đọc đã hoàn thành|Đã lưu tiến độ đọc/i,
          }),
        ).toBeVisible({ timeout: 10_000 });

        await page.goto("/sessions");
        await assertZeroHorizontalOverflow(page);
        await expect(page.getByText(baseBook.title).first()).toBeVisible();

        await page.goto(`/sessions/${ids.session}`);
        await assertZeroHorizontalOverflow(page);
        await expect(page.getByText(baseBook.title).first()).toBeVisible();

        await page.goto("/reports/difficult-words");
        await assertZeroHorizontalOverflow(page);
        await expect(page.getByText("Mèo API").first()).toBeVisible();

        expect(session.unexpectedReadingPaths).toEqual([]);
        expect(session.api.unexpected).toEqual([]);
      });
    }

    test("Journey J5 (360x800): PARENT_PRIVATE book on Android WebView (ViReadNativeSpeech, worker offline) zero-leakage reading -> /sessions", async ({
      page,
    }, testInfo) => {
      const bucket = normalizeProjectBucket(testInfo.project.name);
      test.skip(
        bucket !== "mobile-360x800",
        "Journey J5 (360x800) runs on mobile-360x800",
      );

      const privateBookId = "33333333-3333-4333-8333-333333333335";
      const privateSessionId = "44444444-4444-4444-8444-444444444446";
      const session = await installReadingVoiceSession(page, {
        bookId: privateBookId,
        sessionId: privateSessionId,
        visibilityScope: "PARENT_PRIVATE",
        initialState: "ready",
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
            text: "Câu chuyện riêng tư",
            words: buildWordsFromText("Câu chuyện riêng tư"),
          },
        ],
        voice: {
          localAvailable: false,
          localSttReady: false,
          localTtsReady: false,
          timedTtsStatus: 503,
          shortTtsStatus: 503,
          sttStatus: 503,
        },
        nativeBridge: {
          ttsAvailable: true,
          viVoicesCount: 2,
          sttAvailable: true,
          ttsDurationMs: 450,
        },
        wasmWorker: {
          scriptedOutputs: ["Câu chuyện riêng tư"],
        },
      });

      await page.getByRole("button", { name: "Bắt đầu đọc" }).click();
      await expect(page.locator('[data-reading-shell="true"]')).toBeVisible();
      await assertZeroHorizontalOverflow(page);

      // Listen to "Đọc mẫu" via Android native fallback (local worker offline)
      await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
      await expect(
        page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }),
      ).toBeVisible({ timeout: 8_000 });

      // Read aloud via offline WASM STT
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
        page.getByRole("button", { name: "tư" }).first(),
      ).toHaveAttribute("data-reading-state", "correct", { timeout: 10_000 });
      expect(await readSttTier(page)).toBe("browser_wasm");

      // Verify zero public cache / IndexedDB / CacheStorage leakage
      const leakage = await session.inspectLeakage();
      expect(leakage.catalogTtsRequests).toEqual([]);
      expect(leakage.idbEntryCount).toBe(0);
      expect(leakage.cacheStorageKeys).toEqual([]);

      // Finish session & verify in /sessions
      await page.getByRole("button", { name: "Kết thúc buổi đọc" }).click();
      await page.getByRole("button", { name: "Lưu và dừng" }).click();
      await expect(
        page.getByRole("heading", {
          name: /Buổi đọc đã hoàn thành|Đã lưu tiến độ đọc/i,
        }),
      ).toBeVisible({ timeout: 10_000 });

      await page.goto("/sessions");
      await assertZeroHorizontalOverflow(page);
      await expect(
        page.getByText("Sách riêng tư của bé").first(),
      ).toBeVisible();
      expect(session.unexpectedReadingPaths).toEqual([]);
      expect(session.api.unexpected).toEqual([]);
    });
  });
});
