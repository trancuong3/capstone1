import path from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { stringToBase64URL } from "@supabase/ssr";

import { authFixtureHeaders } from "./auth-fixture";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SONG_ID = "91000000-0000-4000-8000-000000000001";
const VERSION_ID = "92000000-0000-4000-8000-000000000001";
const SESSION_ID = "93000000-0000-4000-8000-000000000001";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, X-Request-Id, x-readalong-playwright-auth-token, x-readalong-playwright-role",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
};

function makeFakeJwt(sub: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 36000,
      iat: Math.floor(Date.now() / 1000) - 60,
      role: "authenticated",
      sub,
      user_metadata: { role: "parent" },
    }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-e2e-signature`;
}

async function seedParentContext(context: BrowserContext) {
  await context.setExtraHTTPHeaders(authFixtureHeaders("parent"));
  const token = makeFakeJwt(PARENT_ID);
  const sessionPayload = {
    access_token: token,
    token_type: "bearer",
    expires_in: 36000,
    expires_at: Math.floor(Date.now() / 1000) + 36000,
    refresh_token: "synthetic-refresh-token",
    user: {
      id: PARENT_ID,
      aud: "authenticated",
      role: "authenticated",
      email: "parent@viread.local",
      user_metadata: { role: "parent" },
      app_metadata: { provider: "email" },
      created_at: "2026-11-21T10:00:00Z",
    },
  };
  const encoded = `base64-${stringToBase64URL(JSON.stringify(sessionPayload))}`;
  await context.addCookies([
    {
      name: "sb-example-auth-token",
      value: encoded,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
    {
      name: "sb-sampleid-auth-token",
      value: encoded,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await context.route("https://*.supabase.co/**", async (route) => {
    const reqUrl = new URL(route.request().url());
    if (reqUrl.pathname.startsWith("/auth/v1/token")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(sessionPayload),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionPayload.user),
    });
  });
  await context.addInitScript(
    ({ userId, childId }) => {
      try {
        window.sessionStorage.setItem(
          `viread:selected-child:${userId}`,
          childId,
        );
      } catch {
        // Ignore restricted storage contexts.
      }
    },
    { userId: PARENT_ID, childId: CHILD_ID },
  );
}

test.describe("Entertainment Autopilot, 3-2-1 Auto-Mic & Karaoke Reference Pitch E2E", () => {
  test.setTimeout(120_000);

  test.beforeAll(async ({ playwright, baseURL }) => {
    if (!baseURL) return;
    const api = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: authFixtureHeaders("parent"),
    });
    try {
      for (const routePath of [
        "/entertainment",
        "/entertainment/picture-description",
        "/karaoke",
        `/karaoke/${SONG_ID}`,
      ]) {
        const res = await api.get(routePath, {
          timeout: 90_000,
          maxRedirects: 0,
        });
        await res.dispose();
      }
    } finally {
      await api.dispose();
    }
  });

  test("navigates Hub -> Picture Description 3-2-1 countdown -> Karaoke reference pitch stage without overflow", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    const context = page.context();
    await seedParentContext(context);

    await context.route(
      /^http:\/\/127\.0\.0\.1:(8000|18080)\/.*/,
      async (route) => {
        const req = route.request();
        const requestedHeaders =
          req.headers()["access-control-request-headers"];
        const corsHeaders = requestedHeaders
          ? {
              ...CORS_HEADERS,
              "Access-Control-Allow-Headers": requestedHeaders,
            }
          : CORS_HEADERS;
        if (req.method() === "OPTIONS") {
          await route.fulfill({ status: 204, headers: corsHeaders });
          return;
        }
        const url = new URL(req.url());
        const path = url.pathname;
        const json = (body: unknown, status = 200) =>
          route.fulfill({
            status,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

        if (path === "/profiles/children") {
          return json([
            {
              id: CHILD_ID,
              parent_id: PARENT_ID,
              alias: "Bé An",
              grade: 2,
              settings: {},
              avatar_url: null,
              created_at: "2026-11-20T08:00:00Z",
            },
          ]);
        }
        if (path === `/profiles/children/${CHILD_ID}`) {
          return json({
            id: CHILD_ID,
            parent_id: PARENT_ID,
            alias: "Bé An",
            grade: 2,
            settings: {},
            avatar_url: null,
            created_at: "2026-11-20T08:00:00Z",
          });
        }
        if (path === `/learning/children/${CHILD_ID}/recommendations`) {
          return json({
            child_id: CHILD_ID,
            child_alias: "Bé An",
            child_grade: 2,
            mascot_greeting_vi:
              "Chào Bé An! Hôm nay mình cùng ôn nhẹ từ lung linh và hoa hướng dương nhé!",
            natural_break_reminder_vi:
              "Mỗi phiên chơi 10–15 phút giúp mắt bé luôn khỏe mạnh.",
            today_activities_count: 1,
            focus_difficult_words: ["lung linh", "hoa hướng dương"],
            primary_recommendation: {
              game_key: "PICTURE_DESCRIPTION",
              zone_title_vi: "Thế giới kể chuyện",
              game_title_vi: "Kể chuyện qua tranh",
              reason_vi:
                "Lồng ghép từ lung linh tự nhiên vào câu chuyện tranh.",
              suggested_mode: "OBSERVE",
              suggested_difficulty: 2,
              target_words: ["lung linh", "hoa hướng dương"],
              href: "/entertainment/picture-description",
              priority: 1,
            },
            recommendations: [
              {
                game_key: "PICTURE_DESCRIPTION",
                zone_title_vi: "Thế giới kể chuyện",
                game_title_vi: "Kể chuyện qua tranh",
                reason_vi:
                  "Lồng ghép từ lung linh tự nhiên vào câu chuyện tranh.",
                suggested_mode: "OBSERVE",
                suggested_difficulty: 2,
                target_words: ["lung linh", "hoa hướng dương"],
                href: "/entertainment/picture-description",
                priority: 1,
              },
            ],
          });
        }
        if (path === "/games/picture-description/catalog") {
          return json({
            samples: [
              {
                sample_key: "sunny-garden",
                title: "Khu vườn đầy nắng",
                theme: "Thiên nhiên",
                description: "Chú mèo cam ngủ trưa.",
                image_url: "/images/picture-description/sunny-garden.jpg",
              },
            ],
            book_pages: [],
          });
        }
        if (
          path === "/games/picture-description/sessions" &&
          req.method() === "GET"
        ) {
          return json([]);
        }
        if (
          path === "/games/picture-description/sessions" &&
          req.method() === "POST"
        ) {
          return json(
            {
              session_id: SESSION_ID,
              child_id: CHILD_ID,
              child_grade: 2,
              source_type: "SAMPLE",
              sample_key: "sunny-garden",
              book_id: null,
              book_page_id: null,
              image_url: "/images/picture-description/sunny-garden.jpg",
              scene_title: "Chú mèo ngủ trưa trong vườn nắng",
              status: "ACTIVE",
              best_stars: 0,
              best_score: 0,
              attempts_count: 0,
              target_words: ["lung linh", "hoa hướng dương"],
              guide: {
                is_child_safe: true,
                scene_title: "Chú mèo ngủ trưa trong vườn nắng",
                scene_summary: "Chú mèo cam nằm ngủ.",
                guiding_questions: ["Bé thấy con vật nào đang ngủ?"],
                suggested_vocabulary: [
                  { word: "lung linh", hint: "⭐ Từ bé đang luyện phát âm" },
                ],
                model_sample_sentences: ["Nắng sớm lung linh trên vườn hoa."],
                target_words: ["lung linh", "hoa hướng dương"],
              },
              attempts: [],
              created_at: "2026-11-28T08:00:00Z",
              updated_at: "2026-11-28T08:00:00Z",
            },
            201,
          );
        }
        if (path === `/karaoke/songs/${SONG_ID}/playback`) {
          return json({
            song_id: SONG_ID,
            version_id: VERSION_ID,
            title: "Bắc kim thang",
            author: "Đồng dao Nam Bộ",
            duration_ms: 42430,
            audio_url: `${url.origin}/mock-audio.mp3`,
            audio_url_expires_at: "2026-12-31T23:59:59+00:00",
            cover_url: null,
            lyrics: {
              format_version: 2,
              lines: [
                {
                  id: "94000000-0000-4000-8000-000000000001",
                  text: "Bắc kim thang lung linh",
                  start_ms: 2000,
                  end_ms: 5500,
                  syllables: [
                    {
                      id: "95000000-0000-4000-8000-000000000001",
                      text: "Bắc",
                      start_ms: 2000,
                      end_ms: 2600,
                    },
                    {
                      id: "95000000-0000-4000-8000-000000000002",
                      text: "kim",
                      start_ms: 2700,
                      end_ms: 3300,
                    },
                    {
                      id: "95000000-0000-4000-8000-000000000003",
                      text: "thang",
                      start_ms: 3400,
                      end_ms: 4000,
                    },
                    {
                      id: "95000000-0000-4000-8000-000000000004",
                      text: "lung",
                      start_ms: 4100,
                      end_ms: 4700,
                    },
                    {
                      id: "95000000-0000-4000-8000-000000000005",
                      text: "linh",
                      start_ms: 4800,
                      end_ms: 5500,
                    },
                  ],
                },
              ],
            },
            melody_profile: {
              melody_version: 1,
              hop_ms: 60,
              duration_ms: 42430,
              min_midi: 60,
              max_midi: 69,
              median_midi: 64,
              bpm: 96,
              notes: [
                {
                  start_ms: 2000,
                  end_ms: 2600,
                  midi: 64,
                  hz: 329.63,
                  confidence: 0.95,
                  voiced: true,
                  syllable_id: "95000000-0000-4000-8000-000000000001",
                  line_id: "94000000-0000-4000-8000-000000000001",
                  text: "Bắc",
                },
                {
                  start_ms: 4100,
                  end_ms: 5500,
                  midi: 67,
                  hz: 392.0,
                  confidence: 0.95,
                  voiced: true,
                  syllable_id: "95000000-0000-4000-8000-000000000004",
                  line_id: "94000000-0000-4000-8000-000000000001",
                  text: "lung linh",
                },
              ],
              pitch_contour: [],
            },
          });
        }
        if (path === "/karaoke/songs") {
          return json({
            items: [
              {
                song_id: SONG_ID,
                version_id: VERSION_ID,
                title: "Bắc kim thang",
                author: "Đồng dao dân gian Việt Nam",
                duration_ms: 42430,
                cover_url: null,
                min_grade: 1,
                max_grade: 3,
              },
            ],
            total: 1,
            limit: 12,
            offset: 0,
          });
        }
        if (path === `/karaoke/songs/${SONG_ID}/musical-profile`) {
          return json({
            song_id: SONG_ID,
            song_version_id: VERSION_ID,
            bpm: 96,
            audio_type: "INSTRUMENTAL_ONLY",
            has_pitch_contour: true,
            has_beat_grid: true,
            source_method: "AUDIO_DSP",
            beat_grid_ms: [2000, 2700, 3400, 4100, 4800],
            pitch_contour: [
              { time_ms: 2000, hz: 329.63, midi: 64 },
              { time_ms: 4100, hz: 392.0, midi: 67 },
            ],
            phrase_windows: [{ start_ms: 2000, end_ms: 5500 }],
            melody_profile: null,
          });
        }
        if (path === "/karaoke/practice-sessions") {
          return json({
            child_id: CHILD_ID,
            song_id: SONG_ID,
            best_full_song_score: 88,
            best_full_song_stars: 3,
            total_sessions: 1,
            items: [],
            storage_ready: true,
          });
        }
        if (path === "/mock-audio.mp3") {
          return route.fulfill({
            status: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "audio/mpeg" },
            body: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
          });
        }
        return json({});
      },
    );

    // 1. Entertainment Hub: Autopilot toggle, focus words, and zero horizontal overflow
    const shotsDir = process.env.CAPTURE_WALKTHROUGH_SCREENSHOTS_DIR?.trim();
    await page.goto("/entertainment");
    await expect(page.getByTestId("hub-autopilot-toggle")).toBeVisible();
    await expect(page.getByTestId("hub-autopilot-cta")).toBeVisible();
    await expect(page.getByTestId("hub-focus-word-lung linh")).toBeVisible();
    if (shotsDir) {
      await page.screenshot({
        path: path.join(shotsDir, "e2e_entertainment_hub.png"),
      });
    }

    const hubOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    );
    expect(hubOverflow).toBe(false);

    // 2. Launch Hands-Free Autopilot into Picture Description -> verify 3-2-1 countdown appears!
    await page.getByTestId("hub-autopilot-cta").click();
    await expect(page).toHaveURL(/\/entertainment\/picture-description/, {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Khám phá tranh này" }).click();

    await expect(page.getByTestId("picture-mic-countdown")).toBeVisible();
    await expect(page.getByTestId("target-words-panel")).toContainText(
      "lung linh",
    );
    if (shotsDir) {
      await page.screenshot({
        path: path.join(shotsDir, "e2e_picture_countdown.png"),
      });
    }

    // Cancel countdown via "Hủy / Gõ chữ" and verify clean dismissal
    await page.getByTestId("picture-countdown-cancel").click();
    await expect(page.getByTestId("picture-mic-countdown")).toHaveCount(0);

    // 3. Karaoke Library -> Karaoke Stage with Reference Melody Synth ("Đàn dẫn âm mẫu") + 3-note Warmup + Focus Words
    await page.goto("/karaoke?autopilot=1&focus=lung%20linh");
    await expect(page.getByText(/Vần ang \/ an & thanh hỏi/)).toBeVisible();
    if (shotsDir) {
      await page.screenshot({
        path: path.join(shotsDir, "e2e_karaoke_library.png"),
      });
    }
    await page.getByRole("link", { name: /Hát bài Bắc kim thang/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/karaoke/${SONG_ID}.*autopilot=1.*focus=lung`),
      { timeout: 30_000 },
    );

    await expect(
      page.getByRole("heading", { name: "Bắc kim thang" }),
    ).toBeVisible();
    await expect(page.getByTestId("karaoke-focus-words-banner")).toContainText(
      "lung linh",
    );
    await expect(page.getByTestId("karaoke-melody-guide-toggle")).toBeVisible();
    await expect(page.getByTestId("karaoke-vocal-warmup-button")).toBeVisible();
    await expect(page.getByTestId("karaoke-pitch-highway")).toBeVisible();
    await expect(page.getByTestId("pitch-highway-canvas")).toBeVisible();
    if (shotsDir) {
      await page.screenshot({
        path: path.join(shotsDir, "e2e_karaoke_pitch_guide.png"),
      });
    }

    const karaokeOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    );
    expect(karaokeOverflow).toBe(false);
    expect(pageErrors).toEqual([]);
  });
});
