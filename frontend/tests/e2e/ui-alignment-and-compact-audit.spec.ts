import path from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { stringToBase64URL } from "@supabase/ssr";

import { authFixtureHeaders } from "./auth-fixture";

const API_BASE = "http://127.0.0.1:8000";
const NOW = "2026-11-21T10:00:00Z";
const ADMIN_ID = "90000000-0000-4000-8000-000000000001";
const PARENT_ID = "91000000-0000-4000-8000-000000000001";
const PARENT_2_ID = "91000000-0000-4000-8000-000000000002";
const CHILD_ID = "92000000-0000-4000-8000-000000000001";
const BOOK_1_ID = "82000000-0000-4000-8000-000000000010";
const BOOK_2_ID = "82000000-0000-4000-8000-000000000011";
const SESSION_ID = "72000000-0000-4000-8000-000000000001";
const PAGE_1_ID = "83000000-0000-4000-8000-000000000011";
const PAGE_2_ID = "83000000-0000-4000-8000-000000000012";
const REV_1_ID = "84000000-0000-4000-8000-000000000011";
const REV_2_ID = "84000000-0000-4000-8000-000000000012";
const REPORT_1_ID = "85000000-0000-4000-8000-000000000011";
const REPORT_2_ID = "85000000-0000-4000-8000-000000000012";
const SCAN_1_ID = "87000000-0000-4000-8000-000000000001";
const SUB_1_ID = "88000000-0000-4000-8000-000000000001";
const REQ_1_ID = "89000000-0000-4000-8000-000000000001";
const SONG_1_ID = "86000000-0000-4000-8000-000000000001";
const SONG_2_ID = "86000000-0000-4000-8000-000000000002";

const GOAL_1_ID = "61000000-0000-4000-8000-000000000001";
const PLAN_1_ID = "62000000-0000-4000-8000-000000000001";
const REM_1_ID = "63000000-0000-4000-8000-000000000001";
const REM_2_ID = "63000000-0000-4000-8000-000000000002";
const PROG_1_ID = "64000000-0000-4000-8000-000000000001";
const AUDIT_1_ID = "65000000-0000-4000-8000-000000000001";
const AUDIT_2_ID = "65000000-0000-4000-8000-000000000002";
const VER_1_ID = "66000000-0000-4000-8000-000000000001";
const VER_2_ID = "66000000-0000-4000-8000-000000000002";

function makeFakeJwt(sub: string, role: "admin" | "parent"): string {
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
      user_metadata: { role },
    }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-audit-signature`;
}

async function seedSession(context: BrowserContext, role: "admin" | "parent") {
  const userId = role === "admin" ? ADMIN_ID : PARENT_ID;
  const sessionPayload = {
    access_token: makeFakeJwt(userId, role),
    token_type: "bearer",
    expires_in: 36000,
    expires_at: Math.floor(Date.now() / 1000) + 36000,
    refresh_token: "synthetic-refresh-token",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${role}@viread.local`,
      user_metadata: { role },
      app_metadata: { provider: "email" },
      created_at: NOW,
    },
  };
  await context.addCookies([
    {
      name: "sb-example-auth-token",
      value: `base64-${stringToBase64URL(JSON.stringify(sessionPayload))}`,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await context.route("https://example.supabase.co/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionPayload.user),
    }),
  );
}

async function installMockApi(page: Page) {
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  };
  const json = (data: unknown) => ({
    status: 200,
    headers: corsHeaders,
    contentType: "application/json",
    body: JSON.stringify(data),
  });

  await page.route(`${API_BASE}/**`, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    const url = new URL(route.request().url());
    const p = url.pathname;

    if (p === "/profiles/me") {
      await route.fulfill(
        json({
          id: PARENT_ID,
          display_name: "Phụ huynh Kiểm thử",
          email: "parent@viread.local",
          role: "parent",
          avatar_url: null,
          preferred_locale: "vi",
          created_at: NOW,
        }),
      );
      return;
    }
    if (p === "/profiles/children") {
      await route.fulfill(
        json([
          {
            id: CHILD_ID,
            parent_id: PARENT_ID,
            alias: "Bé An",
            grade: 2,
            settings: {},
            created_at: NOW,
          },
        ]),
      );
      return;
    }
    if (p === `/profiles/children/${CHILD_ID}`) {
      await route.fulfill(
        json({
          id: CHILD_ID,
          parent_id: PARENT_ID,
          alias: "Bé An",
          grade: 2,
          settings: {},
          created_at: NOW,
        }),
      );
      return;
    }
    if (p === "/profiles/dashboard-summary") {
      await route.fulfill(
        json({
          profile: {
            id: PARENT_ID,
            display_name: "Phụ huynh Kiểm thử",
            email: "parent@viread.local",
            role: "parent",
            avatar_url: null,
            preferred_locale: "vi",
            created_at: NOW,
          },
          children: [
            {
              id: CHILD_ID,
              parent_id: PARENT_ID,
              alias: "Bé An",
              grade: 2,
              settings: {},
              created_at: NOW,
            },
          ],
          latest_sessions_by_child: { [CHILD_ID]: null },
        }),
      );
      return;
    }
    if (p === "/tasks" || p.startsWith("/tasks/")) {
      await route.fulfill(json({ items: [], total: 0 }));
      return;
    }
    if (p === "/studio/tasks") {
      await route.fulfill(
        json({
          actor_id: PARENT_ID,
          actor_role: "parent",
          active_count: 0,
          waiting_review_count: 0,
          failed_count: 0,
          completed_count: 0,
          worker_online: true,
          recommended_poll_ms: 30_000,
          tasks: [],
        }),
      );
      return;
    }
    if (p.includes("/learning/children/") && p.endsWith("/recommendations")) {
      const rec = {
        game_key: "PICTURE_DESCRIPTION",
        zone_title_vi: "Thế giới kể chuyện",
        game_title_vi: "Kể chuyện qua tranh",
        reason_vi: "Luyện diễn đạt từ vựng nhẹ nhàng cùng bé.",
        suggested_mode: "STORYTELLING",
        suggested_difficulty: 1,
        target_words: ["khỏe"],
        href: "/entertainment/picture-description",
        priority: 1,
      };
      await route.fulfill(
        json({
          child_id: CHILD_ID,
          child_alias: "Bé An",
          child_grade: 2,
          mascot_greeting_vi: "Chào Bé An! Hôm nay con muốn chơi góc nào?",
          natural_break_reminder_vi:
            "Mỗi phiên chơi khoảng 10–15 phút là vừa đẹp để mắt bé khỏe mạnh.",
          today_activities_count: 1,
          focus_difficult_words: ["khỏe"],
          primary_recommendation: rec,
          recommendations: [rec],
        }),
      );
      return;
    }
    if (p.includes("/learning/children/") && p.endsWith("/parent-analytics")) {
      await route.fulfill(
        json({
          child_id: CHILD_ID,
          child_alias: "Bé An",
          child_grade: 2,
          window_days: 30,
          is_diagnostic: false,
          disclaimer_vi: "Thông tin tham khảo đồng hành cùng ba mẹ tại nhà.",
          observed_skills_count: 0,
          estimated_skills_count: 0,
          unknown_skills_count: 0,
          skills: [],
          practiced_difficult_words: [],
          module_activities: [],
          karaoke_weak_segments: [],
          home_support_tips_vi: [],
          generated_at: NOW,
        }),
      );
      return;
    }

    // Progress reports
    if (p.endsWith("/periods")) {
      await route.fulfill(
        json({
          items: [
            {
              id: PROG_1_ID,
              child_id: CHILD_ID,
              period_start: "2026-10-01",
              period_end: "2026-10-31",
              generated_at: NOW,
            },
          ],
          next_cursor: null,
        }),
      );
      return;
    }
    if (p.startsWith("/system/progress/")) {
      await route.fulfill(
        json({
          id: PROG_1_ID,
          child_id: CHILD_ID,
          period_start: "2026-10-01",
          period_end: "2026-10-31",
          generated_at: NOW,
          data_status: "complete",
          completed_sessions: 8,
          reading_duration_ms: 48 * 60_000,
          comprehension_accuracy: 88,
          omission_rate: 4.5,
          omission_count: 12,
          repetition_count: 5,
          repetition_rate: 1.9,
          long_pause_count: 7,
          long_pause_rate: 2.6,
          previous_period: {
            completed_sessions: 6,
            reading_duration_ms: 38 * 60_000,
            omission_count: 15,
            repetition_count: 6,
            long_pause_count: 8,
            omission_rate: 6,
            repetition_rate: 2.2,
            long_pause_rate: 3.1,
            comprehension_accuracy: 84,
          },
          trend_deltas: {
            completed_sessions: 2,
            reading_duration_ms: 10 * 60_000,
            comprehension_accuracy: 4,
            omission_rate: -1.5,
            repetition_rate: -0.3,
            long_pause_rate: -0.5,
          },
          legacy: null,
          availability: {
            metrics: "available",
            difficult_words: "available",
            comparison: "available",
          },
          assessment: {
            first_pass_correct: 120,
            first_pass_incorrect: 15,
            self_corrected_words: 9,
            unresolved_words: 6,
            retry_attempts: 14,
            skipped_after_retry_limit: 2,
            recognition_uncertain: 3,
          },
          difficult_words: [
            "khỏe",
            "ngoan",
            "nhanh",
            "chuyện",
            "nghiêng",
            "xuyên",
          ].map((w, i) => ({
            normalized_word: w,
            display_text: w,
            difficulty_score: 70 - i * 5,
            session_count: 3,
            mispronunciation_count: 2,
            omission_count: 1,
            repetition_count: 0,
            long_pause_count: 0,
            read_example_count: 1,
            last_seen_at: NOW,
            evidence_word_ids: [],
            practice_status: i % 2 === 0 ? "IN_PROGRESS" : "NOT_PRACTICED",
          })),
        }),
      );
      return;
    }
    if (p.includes("/progress-assessment")) {
      await route.fulfill(
        json({
          child_id: CHILD_ID,
          period_start: "2026-10-20",
          period_end: "2026-11-19",
          days: 30,
          generated_at: NOW,
          data_status: "OK",
          score: {
            overall: 82,
            previous_overall: 76,
            delta: 6,
            grade: "GOOD",
            grade_label: "Tốt",
            components: [
              {
                key: "ACCURACY",
                label: "Đọc đúng",
                score: 86,
                previous_score: 80,
                detail: "Đọc đúng 86% từ.",
              },
              {
                key: "FLUENCY",
                label: "Trôi chảy",
                score: 79,
                previous_score: 74,
                detail: "Ít ngắt quãng hơn tuần trước.",
              },
              {
                key: "COMPREHENSION",
                label: "Hiểu bài",
                score: 88,
                previous_score: 82,
                detail: "Trả lời tốt câu hỏi đọc hiểu.",
              },
              {
                key: "CONSISTENCY",
                label: "Thói quen",
                score: 75,
                previous_score: 70,
                detail: "Duy trì đọc đều mỗi tuần.",
              },
            ],
          },
          metrics: {
            sessions: 8,
            active_days: 6,
            reading_minutes: 48,
            books: 3,
            pages_compared: 16,
            words_read: 420,
            coverage_pct: 80,
            accuracy_pct: 86,
            skipped_rate_pct: 4.5,
            substitution_rate_pct: 6.2,
            hesitations: 7,
            repeated_words: 5,
            hesitations_per_100_words: 1.7,
            words_per_minute: 55,
            comprehension_answered: 8,
            comprehension_first_try_pct: 88,
            comprehension_by_type: [],
            retry_confirmed: 9,
            retry_failed: 2,
          },
          weekly: [
            {
              week_start: "2026-10-26",
              sessions: 2,
              minutes: 15,
              accuracy_pct: 82,
            },
            {
              week_start: "2026-11-02",
              sessions: 3,
              minutes: 18,
              accuracy_pct: 85,
            },
            {
              week_start: "2026-11-09",
              sessions: 3,
              minutes: 22,
              accuracy_pct: 88,
            },
          ],
          difficult_words: [{ word: "khỏe", times: 4, heard_as: "khóe" }],
          assessment: {
            source: "AI",
            model: "gemini-audit",
            headline: "Bé An đang tiến bộ rõ rệt",
            summary:
              "Tốc độ và độ chính xác đều tăng đều trong 3 tuần gần đây.",
            strengths: ["Đọc rõ âm cuối", "Duy trì lịch đọc đều"],
            weaknesses: [
              {
                area: "Âm vần khó",
                detail: "Đôi khi nhầm thanh hỏi và thanh ngã.",
              },
            ],
            actions: [
              {
                title: "Đọc cùng bé 10 phút",
                detail: "Nhắc bé ngắt nghỉ ở dấu phẩy.",
                audience: "PARENT",
              },
              {
                title: "Luyện từ khó mỗi ngày",
                detail: "Đọc to rõ 3 lần từ mới.",
                audience: "CHILD",
              },
            ],
            practice_words: ["khỏe", "nghiêng"],
            encouragement: "Con đọc giỏi lắm, cố gắng thêm nhé!",
          },
          ai_cached: true,
        }),
      );
      return;
    }

    // Reading management
    if (p === "/reading-management/goals") {
      await route.fulfill(
        json([
          {
            id: GOAL_1_ID,
            child_id: CHILD_ID,
            metric: "MINUTES",
            target_value: 20,
            current_value: 15,
            progress_percent: 75,
            period: "DAILY",
            starts_on: "2026-11-01",
            ends_on: null,
            timezone: "Asia/Ho_Chi_Minh",
            status: "ACTIVE",
            phase: "RUNNING",
            streak_cycles: 3,
            created_at: NOW,
            updated_at: NOW,
          },
        ]),
      );
      return;
    }
    if (p === "/reading-management/plans") {
      await route.fulfill(
        json([
          {
            id: PLAN_1_ID,
            child_id: CHILD_ID,
            book_id: BOOK_1_ID,
            book_title: "Chú mèo đi hia",
            title: "Đọc truyện buổi tối",
            target_minutes: 15,
            weekdays: [0, 2, 4],
            starts_on: "2026-11-01",
            ends_on: null,
            timezone: "Asia/Ho_Chi_Minh",
            status: "ACTIVE",
            phase: "RUNNING",
            scheduled_days_this_week: 3,
            completed_days_this_week: 2,
            progress_percent: 67,
            is_scheduled_today: true,
            minutes_today: 10,
            next_scheduled_date: "2026-11-22",
            completed_at: null,
            created_at: NOW,
            updated_at: NOW,
          },
        ]),
      );
      return;
    }
    if (p === "/reading-management/collections") {
      await route.fulfill(json([]));
      return;
    }
    if (p === "/reading-management/reminders/due") {
      await route.fulfill(json([]));
      return;
    }
    if (p === "/reading-management/reminders") {
      await route.fulfill(
        json([
          {
            id: REM_1_ID,
            child_id: CHILD_ID,
            remind_at: "19:30:00",
            weekdays: [0, 1, 2, 3, 4, 5, 6],
            timezone: "Asia/Ho_Chi_Minh",
            is_active: true,
            email_enabled: true,
            deleted_at: null,
            created_at: NOW,
            updated_at: NOW,
          },
          {
            id: REM_2_ID,
            child_id: CHILD_ID,
            remind_at: "20:00:00",
            weekdays: [0, 2, 4],
            timezone: "Asia/Ho_Chi_Minh",
            is_active: true,
            email_enabled: false,
            deleted_at: null,
            created_at: NOW,
            updated_at: NOW,
          },
        ]),
      );
      return;
    }
    if (p === "/books/catalog") {
      await route.fulfill(json([]));
      return;
    }
    if (p === `/books/catalog/${BOOK_1_ID}`) {
      await route.fulfill(
        json({
          id: BOOK_1_ID,
          title: "Chú mèo đi hia",
          author: "Charles Perrault",
          min_grade: 1,
          max_grade: 3,
          lifecycle_status: "ACTIVE",
        }),
      );
      return;
    }

    // Active/completed reading session endpoints for SessionComplete E2E check
    if (p === `/reading/sessions/${SESSION_ID}`) {
      await route.fulfill(
        json({
          id: SESSION_ID,
          child_id: CHILD_ID,
          book_id: BOOK_1_ID,
          state: "FINISHED",
          started_at: "2026-11-21T09:50:00Z",
          ended_at: NOW,
          duration_ms: 10 * 60_000,
        }),
      );
      return;
    }
    if (p === `/reading/sessions/${SESSION_ID}/page`) {
      await route.fulfill(
        json({
          page_id: PAGE_1_ID,
          page_revision_id: REV_1_ID,
          page_number: 1,
          confidence: 0.99,
          width: 600,
          height: 800,
          text: "Bé mèo khỏe.",
          words: ["Bé", "mèo", "khỏe"].map((text, idx) => ({
            word_id: `50000000-0000-4000-8000-00000000000${idx + 1}`,
            word_index: idx,
            text,
            bbox: [0.1 + idx * 0.2, 0.2, 0.15, 0.05],
          })),
        }),
      );
      return;
    }
    if (p === `/reading/sessions/${SESSION_ID}/progress`) {
      await route.fulfill(
        json({
          session_id: SESSION_ID,
          persisted: true,
          start_page_id: PAGE_1_ID,
          end_page_id: PAGE_2_ID,
          current_page_id: PAGE_2_ID,
          start_page_number: 1,
          end_page_number: 2,
          current_page_number: 2,
          current_index: 1,
          total_pages: 2,
          completed_pages: 2,
          pages: [
            {
              page_id: PAGE_1_ID,
              page_revision_id: REV_1_ID,
              page_number: 1,
              page_order: 0,
              status: "COMPLETED",
              started_at: "2026-11-21T09:50:00Z",
              completed_at: "2026-11-21T09:55:00Z",
            },
            {
              page_id: PAGE_2_ID,
              page_revision_id: REV_2_ID,
              page_number: 2,
              page_order: 1,
              status: "COMPLETED",
              started_at: "2026-11-21T09:55:00Z",
              completed_at: NOW,
            },
          ],
        }),
      );
      return;
    }
    if (p === "/reading-presence/settings") {
      await route.fulfill(json({ email_enabled: false }));
      return;
    }
    if (p === "/voice/status") {
      await route.fulfill(json({ available: false, mode: "browser" }));
      return;
    }
    if (p === `/reading/sessions/${SESSION_ID}/practice-state`) {
      await route.fulfill(
        json({
          session_id: SESSION_ID,
          legacy_evidence_present: false,
          pages: [],
          words: [],
        }),
      );
      return;
    }
    if (p === `/reading/sessions/${SESSION_ID}/completion-summary`) {
      await route.fulfill(
        json({
          duration_minutes: 10,
          pages_explored: 2,
          selected_range_pages: 2,
          practiced_words: 20,
          spoken_words: ["Bé", "mèo", "khóe"],
          transcripts: ["Bé mèo nhỏ đang đọc sách"],
          correct_words: ["Bé", "mèo"],
          mispronounced_words: ["khỏe"],
          skipped_words: [],
          score: 90,
          assessment: {
            first_pass_correct: 18,
            first_pass_incorrect: 2,
            self_corrected_words: 1,
            unresolved_words: 1,
            retry_attempts: 2,
            skipped_after_retry_limit: 0,
            recognition_uncertain: 1,
          },
        }),
      );
      return;
    }

    // Session history detail
    if (p === `/reading/history/${SESSION_ID}`) {
      await route.fulfill(
        json({
          id: SESSION_ID,
          child_id: CHILD_ID,
          book_id: BOOK_1_ID,
          state: "FINISHED",
          started_at: "2026-11-21T09:50:00Z",
          ended_at: NOW,
          duration_ms: 10 * 60_000,
          selected_range_pages: 2,
          pages_completed: 2,
          selected_page_revision_ids: [REV_1_ID],
          reference_page_revision_ids: [REV_1_ID],
          events: [],
          fluency_assessment: {
            score: 86,
            uncertainty: 0.05,
            model_version: "v1-audit",
            metrics: {
              active_reading_ms: 480_000,
              reference_words_attempted: 20,
              confirmed_error_words: 2,
              accuracy_percent: 90,
              reading_wpm: 58,
              repetition_rate: 0,
              long_pause_rate: 0,
              mean_pause_ms: 420,
              median_pause_ms: 380,
            },
          },
          comprehension: [],
          report_id: REPORT_1_ID,
          availability: {
            events: "available",
            fluency: "available",
            comprehension: "absent",
          },
        }),
      );
      return;
    }
    if (p === `/reading/history/${SESSION_ID}/book`) {
      await route.fulfill(
        json({
          id: BOOK_1_ID,
          title: "Chú mèo đi hia",
          author: "Charles Perrault",
          min_grade: 1,
          max_grade: 3,
          lifecycle_status: "ACTIVE",
        }),
      );
      return;
    }

    // Session report (includes an additional comparison to verify <details> button sizing)
    if (p === `/reading/sessions/${SESSION_ID}/reports`) {
      await route.fulfill(
        json({
          session_id: SESSION_ID,
          total: 2,
          assessment: {
            first_pass_correct: 18,
            first_pass_incorrect: 2,
            self_corrected_words: 1,
            unresolved_words: 1,
            retry_attempts: 2,
            skipped_after_retry_limit: 0,
            recognition_uncertain: 1,
          },
          reports: [
            {
              report_id: REPORT_1_ID,
              page_id: PAGE_1_ID,
              page_revision_id: REV_1_ID,
              transcript: "Bé mèo nhỏ đang đọc sách",
              created_at: NOW,
              distance: 1,
              alignment: [
                {
                  book_word: "Bé",
                  spoken_word: "Bé",
                  book_index: 0,
                  spoken_index: 0,
                  status: "MATCH",
                },
                {
                  book_word: "mèo",
                  spoken_word: "mèo",
                  book_index: 1,
                  spoken_index: 1,
                  status: "MATCH",
                },
                {
                  book_word: "khỏe",
                  spoken_word: "khóe",
                  book_index: 2,
                  spoken_index: 2,
                  status: "SUBSTITUTE",
                },
              ],
              summary: {
                missing_words: [],
                extra_words: [],
                substitutions: [
                  { book_word: "khỏe", spoken_word: "khóe", book_index: 2 },
                ],
                repeated_count: 0,
                repeated_words: [],
                repeated_book_indices: [],
                repeated_items: [],
                hesitations: [],
                hesitation_seconds: null,
              },
            },
            {
              report_id: REPORT_2_ID,
              page_id: PAGE_1_ID,
              page_revision_id: REV_1_ID,
              transcript: "Bé mèo khỏe",
              created_at: "2026-11-21T10:02:00Z",
              distance: 0,
              alignment: [
                {
                  book_word: "Bé",
                  spoken_word: "Bé",
                  book_index: 0,
                  spoken_index: 0,
                  status: "MATCH",
                },
                {
                  book_word: "mèo",
                  spoken_word: "mèo",
                  book_index: 1,
                  spoken_index: 1,
                  status: "MATCH",
                },
                {
                  book_word: "khỏe",
                  spoken_word: "khỏe",
                  book_index: 2,
                  spoken_index: 2,
                  status: "MATCH",
                },
              ],
              summary: {
                missing_words: [],
                extra_words: [],
                substitutions: [],
                repeated_count: 0,
                repeated_words: [],
                repeated_book_indices: [],
                repeated_items: [],
                hesitations: [],
                hesitation_seconds: null,
              },
            },
          ],
        }),
      );
      return;
    }
    if (p.includes(`/pages/${PAGE_1_ID}`)) {
      await route.fulfill(
        json({
          page_id: PAGE_1_ID,
          page_revision_id: REV_1_ID,
          page_number: 1,
          confidence: 0.99,
          width: 600,
          height: 800,
          text: "Bé mèo khỏe.",
          words: ["Bé", "mèo", "khỏe"].map((text, idx) => ({
            word_id: `50000000-0000-4000-8000-00000000000${idx + 1}`,
            word_index: idx,
            text,
            bbox: [0.1 + idx * 0.2, 0.2, 0.15, 0.05],
          })),
        }),
      );
      return;
    }

    // Admin metadata quality dashboard
    if (p === "/books/admin/metadata-quality") {
      await route.fulfill(
        json({
          summary: {
            total_books: 12,
            books_with_issues: 2,
            missing_title: 1,
            missing_author: 1,
            invalid_grade_range: 0,
            possible_duplicate_groups: 1,
            books_in_duplicate_groups: 2,
            checked_at: NOW,
          },
          items: [
            {
              id: BOOK_1_ID,
              title: "Chú mèo đi hia",
              author: null,
              min_grade: 1,
              max_grade: 3,
              lifecycle_status: "ACTIVE",
              issues: ["MISSING_AUTHOR", "POSSIBLE_DUPLICATE"],
            },
            {
              id: BOOK_2_ID,
              title: null,
              author: "Khuyết danh",
              min_grade: 2,
              max_grade: 4,
              lifecycle_status: "RETIRED",
              issues: ["MISSING_TITLE"],
            },
          ],
          total: 2,
          limit: 10,
          offset: 0,
        }),
      );
      return;
    }

    // Admin quality hub tabs: reports, approval, user-books
    if (p === "/books/admin/quality/reports") {
      await route.fulfill(
        json({
          items: [
            {
              id: REPORT_1_ID,
              book_id: BOOK_1_ID,
              book_title: "Chú mèo đi hia",
              reporter_name: "Nguyễn Minh Anh",
              page_id: PAGE_1_ID,
              page_number: 1,
              page_revision_id: REV_1_ID,
              issue_type: "SPELLING_ERROR",
              description: "Chữ bị sai dấu ở dòng thứ hai.",
              reported_text: "mèo khóe",
              suggested_correction: "mèo khỏe",
              status: "OPEN",
              scan_run_id: null,
              created_at: NOW,
              updated_at: NOW,
            },
            {
              id: REPORT_2_ID,
              book_id: BOOK_2_ID,
              book_title: "Cây tre trăm đốt",
              reporter_name: "Trần Quốc Bảo",
              page_id: null,
              page_number: null,
              page_revision_id: null,
              issue_type: "BOOK_METADATA_ERROR",
              description: "Thiếu tên tác giả gốc.",
              reported_text: null,
              suggested_correction: null,
              status: "UNDER_REVIEW",
              scan_run_id: null,
              created_at: NOW,
              updated_at: NOW,
            },
          ],
          total: 2,
          summary: {
            OPEN: 1,
            UNDER_REVIEW: 1,
            RESOLVED: 3,
            REJECTED: 0,
            REPORTED_BOOKS: 2,
            REPORTED_PAGES: 1,
          },
          limit: 10,
          offset: 0,
        }),
      );
      return;
    }
    if (p === "/books/admin/quality/books") {
      const makeAssessment = (status: string, findings: number) => ({
        status,
        page_count: 10,
        ocr_completed_pages: 10,
        ocr_approval_valid_pages: 10,
        proofreading_status: "COMPLETED",
        proofreading_completed_pages: 10,
        proofreading_suggestion_count: 2,
        child_safety_status: findings > 0 ? "REVIEW_REQUIRED" : "SUITABLE",
        child_safety_completed_pages: 10,
        processing_pages: 0,
        failed_pages: 0,
        stale_pages: 0,
        copyright_status: "UNASSESSED",
        copyright_finding_count: findings > 0 ? 1 : 0,
        finding_count: findings,
        high_finding_count: findings > 0 ? 1 : 0,
        medium_finding_count: 0,
        warning_page_count: findings > 0 ? 1 : 0,
        failed_or_unscanned_page_count: 0,
        finding_groups: [],
        assessment_hash: "abc123",
        assessed_at: NOW,
        admin_approved_at: null,
        admin_approved_by: null,
        admin_approved_by_name: null,
        admin_reason: null,
        publication_source: null,
        rights_confirmed: false,
        blockers: [],
      });
      await route.fulfill(
        json({
          items: [
            {
              book_id: BOOK_1_ID,
              book_title: "Chú mèo đi hia",
              report_count: 1,
              open_report_count: 1,
              finding_count: 2,
              needs_review_finding_count: 1,
              latest_scan: {
                id: SCAN_1_ID,
                book_id: BOOK_1_ID,
                book_title: "Chú mèo đi hia",
                trigger_type: "MANUAL",
                scope: "BOOK",
                target_page_id: null,
                status: "COMPLETED",
                total_pages: 10,
                completed_pages: 10,
                skipped_pages: 0,
                failed_pages: 0,
                ai_completed_pages: 10,
                ai_unavailable_pages: 0,
                error_summary: null,
                started_at: NOW,
                completed_at: NOW,
                created_at: NOW,
              },
              assessment: makeAssessment("PENDING_ADMIN_REVIEW", 2),
            },
            {
              book_id: BOOK_2_ID,
              book_title: "Cây tre trăm đốt",
              report_count: 0,
              open_report_count: 0,
              finding_count: 0,
              needs_review_finding_count: 0,
              latest_scan: null,
              assessment: makeAssessment("APPROVED_BY_ADMIN", 0),
            },
          ],
          total: 2,
          limit: 10,
          offset: 0,
          summary: {
            PENDING_ADMIN_REVIEW: 1,
            APPROVED_BY_ADMIN: 1,
            PROCESSING: 0,
            STALE: 0,
            SCAN_FAILED: 0,
            READY_FOR_CHILDREN: 0,
            PUBLISHED: 0,
            REJECTED_FOR_CHILDREN: 0,
          },
          alert_summary: { CHILD_SAFETY: 1, COPYRIGHT: 1, BOTH: 1 },
        }),
      );
      return;
    }
    if (p === "/books/admin/quality/user-books") {
      await route.fulfill(
        json({
          items: [
            {
              book_id: BOOK_1_ID,
              book_title: "Truyện tự viết của Bé An",
              book_author: "Phụ huynh A",
              owner_label: "Nguyễn Minh Anh",
              moderation_status: "ACTIVE",
              queue_status: "PENDING_ADMIN",
              pending_count: 1,
              flagged_count: 0,
              failed_count: 0,
              committed_page_count: 4,
              latest_submission_id: SUB_1_ID,
              latest_request_id: REQ_1_ID,
              latest_submission_version: 1,
              latest_submitted_at: NOW,
              policy_blocked: false,
            },
            {
              book_id: BOOK_2_ID,
              book_title: "Tập đọc lớp 1 gia đình",
              book_author: null,
              owner_label: "Trần Quốc Bảo",
              moderation_status: "ACTIVE",
              queue_status: "FLAGGED",
              pending_count: 0,
              flagged_count: 2,
              failed_count: 0,
              committed_page_count: 2,
              latest_submission_id: SUB_1_ID,
              latest_request_id: REQ_1_ID,
              latest_submission_version: 2,
              latest_submitted_at: NOW,
              policy_blocked: true,
            },
          ],
          total: 2,
          limit: 30,
          offset: 0,
          summary: {
            PENDING_ADMIN: 1,
            FLAGGED: 1,
            CHECK_FAILED: 0,
            APPROVED: 3,
            REJECTED: 0,
            SUSPENDED: 0,
          },
        }),
      );
      return;
    }

    // Admin endpoints
    if (p === "/books/admin/catalog") {
      await route.fulfill(
        json([
          {
            book: {
              id: BOOK_1_ID,
              name: "meo-di-hia",
              title: "Chú mèo đi hia",
              author: "Charles Perrault",
              min_grade: 1,
              max_grade: 3,
              lifecycle_status: "ACTIVE",
              created_at: NOW,
              updated_at: NOW,
            },
            page_count: 10,
            verified_count: 8,
            needs_review_count: 2,
            processing_count: 0,
            parent_catalog_eligible: true,
          },
          {
            book: {
              id: BOOK_2_ID,
              name: "sach-thieu-ten",
              title: "",
              author: "Khuyết danh",
              min_grade: 2,
              max_grade: 4,
              lifecycle_status: "RETIRED",
              created_at: NOW,
              updated_at: NOW,
            },
            page_count: 4,
            verified_count: 0,
            needs_review_count: 4,
            processing_count: 0,
            parent_catalog_eligible: false,
          },
        ]),
      );
      return;
    }
    if (p === "/profiles/admin/parents") {
      await route.fulfill(
        json({
          items: [
            {
              id: PARENT_ID,
              display_name: "Nguyễn Minh Anh",
              children_count: 2,
              created_at: NOW,
            },
            {
              id: PARENT_2_ID,
              display_name: "Trần Quốc Bảo Long",
              children_count: 1,
              created_at: NOW,
            },
          ],
          total: 2,
          limit: 10,
          offset: 0,
        }),
      );
      return;
    }
    if (p === "/system/admin/health") {
      await route.fulfill(
        json({
          overall_status: "HEALTHY",
          checked_at: NOW,
          services: [
            {
              id: "api",
              label: "FastAPI",
              status: "HEALTHY",
              operational_state: "Healthy",
              safe_message: "API phản hồi ổn định.",
              checked_at: NOW,
            },
            {
              id: "database",
              label: "Database",
              status: "HEALTHY",
              operational_state: "Healthy",
              safe_message: "Kết nối CSDL ổn định.",
              checked_at: NOW,
            },
            {
              id: "storage",
              label: "Storage",
              status: "HEALTHY",
              operational_state: "Healthy",
              safe_message: "Lưu trữ ổn định.",
              checked_at: NOW,
            },
          ],
        }),
      );
      return;
    }
    if (p === "/system/admin/audit-logs") {
      await route.fulfill(
        json({
          items: [
            {
              id: AUDIT_1_ID,
              action: "book.update",
              resource_type: "book",
              resource_id: BOOK_1_ID,
              request_id: "req-audit-1",
              actor_id: ADMIN_ID,
              metadata: { title: "Chú mèo đi hia" },
              created_at: NOW,
            },
            {
              id: AUDIT_2_ID,
              action: "parent.create",
              resource_type: "parent",
              resource_id: PARENT_ID,
              request_id: "req-audit-2",
              actor_id: ADMIN_ID,
              metadata: { display_name: "Nguyễn Minh Anh" },
              created_at: NOW,
            },
          ],
          next_cursor: null,
        }),
      );
      return;
    }
    if (p === "/karaoke/admin/songs") {
      await route.fulfill(
        json({
          items: [
            {
              song_id: SONG_1_ID,
              title: "Bắc Kim Thang",
              author: "Dân ca Nam Bộ",
              min_grade: 1,
              max_grade: 3,
              status: "PUBLISHED",
              revision: 1,
              published_version_id: VER_1_ID,
              draft_version_id: null,
              has_cover: false,
              has_audio: true,
              duration_ms: 95000,
              processing_summary: null,
              created_at: NOW,
              updated_at: NOW,
            },
            {
              song_id: SONG_2_ID,
              title: "Con Cò Bé Bé",
              author: "Xuân Mai",
              min_grade: 1,
              max_grade: 2,
              status: "HIDDEN",
              revision: 2,
              published_version_id: VER_2_ID,
              draft_version_id: null,
              has_cover: false,
              has_audio: true,
              duration_ms: 112000,
              processing_summary: null,
              created_at: NOW,
              updated_at: NOW,
            },
          ],
          total: 2,
          limit: 12,
          offset: 0,
        }),
      );
      return;
    }

    await route.fulfill(json({}));
  });
}

async function assertNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
}

async function assertAdminWorkspaceHeaderButtonsAligned(
  page: Page,
  isDesktop: boolean,
) {
  const buttons = await page
    .locator("[data-admin-workspace] > header button")
    .evaluateAll((els) =>
      els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })
        .filter((r) => r.w > 4 && r.h > 4),
    );
  expect(buttons.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < buttons.length; i++) {
    // All workspace utility buttons (AI tasks, Language, Sign Out) share identical height (40px)
    expect(Math.abs(buttons[i].h - buttons[0].h)).toBeLessThanOrEqual(2);
    if (!isDesktop) {
      // On mobile/tablet topbar, they also share the exact same horizontal baseline
      expect(Math.abs(buttons[i].y - buttons[0].y)).toBeLessThanOrEqual(2);
    }
  }
}

test.describe("System-wide UI Alignment & Compactness Audit", () => {
  test("Admin UI buttons align horizontally & vertically without misalignment", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const isDesktop = testInfo.project.name === "desktop-chromium";
    const context = await browser.newContext({
      viewport: isDesktop
        ? { width: 1440, height: 1000 }
        : { width: 390, height: 844 },
      extraHTTPHeaders: authFixtureHeaders("admin"),
    });
    await seedSession(context, "admin");
    const page = await context.newPage();
    await installMockApi(page);

    // 1. /admin/books
    await page.goto("/admin/books", { waitUntil: "networkidle" });
    await expect(page.getByText("Chú mèo đi hia")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertAdminWorkspaceHeaderButtonsAligned(page, isDesktop);

    const bookRows = page.locator('[role="listitem"]');
    await expect(bookRows).toHaveCount(2);
    const row1Boxes = await bookRows
      .nth(0)
      .locator("a[href], button")
      .filter({ hasNot: page.locator("h2") })
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(el);
          const textW = range.getBoundingClientRect().width;
          return {
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
            textW,
            sw: el.scrollWidth,
            cw: el.clientWidth,
          };
        }),
      );
    const row2Boxes = await bookRows
      .nth(1)
      .locator("a[href], button")
      .filter({ hasNot: page.locator("h2") })
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(el);
          const textW = range.getBoundingClientRect().width;
          return {
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
            textW,
            sw: el.scrollWidth,
            cw: el.clientWidth,
          };
        }),
      );
    expect(row1Boxes).toHaveLength(4);
    expect(row2Boxes).toHaveLength(4);
    for (const box of [...row1Boxes, ...row2Boxes]) {
      expect(box.sw).toBeLessThanOrEqual(box.cw + 2);
      // Every button keeps comfortable horizontal breathing room (not jammed against borders)
      expect(box.w - box.textW).toBeGreaterThanOrEqual(12);
    }

    if (isDesktop) {
      // All 4 buttons in a row sit on the same Y baseline and same height
      for (let i = 1; i < 4; i++) {
        expect(Math.abs(row1Boxes[i].y - row1Boxes[0].y)).toBeLessThanOrEqual(
          2,
        );
        expect(Math.abs(row1Boxes[i].h - row1Boxes[0].h)).toBeLessThanOrEqual(
          2,
        );
      }
      // Columns across Row 1 and Row 2 align vertically at the exact same X and width!
      for (let i = 0; i < 4; i++) {
        expect(Math.abs(row1Boxes[i].x - row2Boxes[i].x)).toBeLessThanOrEqual(
          2,
        );
        expect(Math.abs(row1Boxes[i].w - row2Boxes[i].w)).toBeLessThanOrEqual(
          2,
        );
      }
    }

    // 2. /admin/parents
    await page.goto("/admin/parents", { waitUntil: "networkidle" });
    await expect(page.getByText("Nguyễn Minh Anh")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertAdminWorkspaceHeaderButtonsAligned(page, isDesktop);

    const parentRows = page.locator("section[aria-label] ul > li");
    await expect(parentRows).toHaveCount(2);
    const r1 = await parentRows
      .nth(0)
      .locator("a, button")
      .evaluateAll((els) =>
        els.map((el) => {
          const b = el.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(el);
          const textW = range.getBoundingClientRect().width;
          return {
            x: b.x,
            y: b.y,
            w: b.width,
            h: b.height,
            textW,
            sw: el.scrollWidth,
            cw: el.clientWidth,
          };
        }),
      );
    const r2 = await parentRows
      .nth(1)
      .locator("a, button")
      .evaluateAll((els) =>
        els.map((el) => {
          const b = el.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(el);
          const textW = range.getBoundingClientRect().width;
          return {
            x: b.x,
            y: b.y,
            w: b.width,
            h: b.height,
            textW,
            sw: el.scrollWidth,
            cw: el.clientWidth,
          };
        }),
      );
    expect(r1).toHaveLength(3);
    expect(r2).toHaveLength(3);
    for (const box of [...r1, ...r2]) {
      expect(box.sw).toBeLessThanOrEqual(box.cw + 2);
      // Even on 390px mobile, parent action buttons must never cramp text against borders
      expect(box.w - box.textW).toBeGreaterThanOrEqual(12);
    }

    if (isDesktop) {
      for (let i = 1; i < 3; i++) {
        expect(Math.abs(r1[i].y - r1[0].y)).toBeLessThanOrEqual(2);
        expect(Math.abs(r1[i].h - r1[0].h)).toBeLessThanOrEqual(2);
      }
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(r1[i].x - r2[i].x)).toBeLessThanOrEqual(2);
        expect(Math.abs(r1[i].w - r2[i].w)).toBeLessThanOrEqual(2);
      }
    }

    // 3. /admin/health
    await page.goto("/admin/health", { waitUntil: "networkidle" });
    await expect(page.getByTestId("health-group-core")).toBeVisible();
    await assertNoHorizontalOverflow(page);

    if (isDesktop) {
      const autoRefreshGroup = page.locator('header [role="group"]').first();
      const recheckBtn = page
        .locator("header button")
        .filter({ hasText: /Kiểm tra lại/i })
        .first();
      const gBox = await autoRefreshGroup.boundingBox();
      const bBox = await recheckBtn.boundingBox();
      expect(gBox).not.toBeNull();
      expect(bBox).not.toBeNull();
      expect(Math.abs(gBox!.height - bBox!.height)).toBeLessThanOrEqual(2);
      expect(Math.abs(gBox!.y - bBox!.y)).toBeLessThanOrEqual(2);
    }

    // 4. /admin/audit-logs
    await page.goto("/admin/audit-logs", { waitUntil: "networkidle" });
    await expect(page.getByText("book.update")).toBeVisible();
    await assertNoHorizontalOverflow(page);

    if (isDesktop) {
      const detailBtns = await page
        .locator("section[aria-label] ul > li button")
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, w: r.width, h: r.height };
          }),
        );
      expect(detailBtns).toHaveLength(2);
      expect(Math.abs(detailBtns[0].x - detailBtns[1].x)).toBeLessThanOrEqual(
        2,
      );
      expect(Math.abs(detailBtns[0].w - detailBtns[1].w)).toBeLessThanOrEqual(
        2,
      );
      expect(Math.abs(detailBtns[0].h - detailBtns[1].h)).toBeLessThanOrEqual(
        2,
      );
    }

    // 5. /admin/karaoke (verify at 1280px laptop width too so card buttons never overflow!)
    await page.goto("/admin/karaoke", { waitUntil: "networkidle" });
    await expect(page.getByText("Bắc Kim Thang")).toBeVisible();
    await assertNoHorizontalOverflow(page);

    if (isDesktop) {
      for (const width of [1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(150);
        await assertNoHorizontalOverflow(page);
        const cardChecks = await page
          .locator("main .grid.gap-4 > div, main .grid.gap-4 > article")
          .evaluateAll((cards) =>
            cards.map((card) => {
              const cardRect = card.getBoundingClientRect();
              const btns = Array.from(card.querySelectorAll("a, button")).map(
                (el) => {
                  const r = el.getBoundingClientRect();
                  return {
                    y: r.y,
                    h: r.height,
                    right: r.right,
                    cardRight: cardRect.right,
                  };
                },
              );
              return btns;
            }),
          );
        const flatBtns = cardChecks.flat();
        expect(flatBtns).toHaveLength(4);
        for (const btn of flatBtns) {
          // Footer buttons must stay strictly inside their card boundaries
          expect(btn.right).toBeLessThanOrEqual(btn.cardRight + 1);
          expect(Math.abs(btn.y - flatBtns[0].y)).toBeLessThanOrEqual(2);
          expect(Math.abs(btn.h - flatBtns[0].h)).toBeLessThanOrEqual(2);
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }

    // 6. /admin/metadata-quality — verify tab bar & populated table action button alignment
    await page.goto("/admin/metadata-quality?tab=metadata", {
      waitUntil: "networkidle",
    });
    await expect(
      page
        .locator(isDesktop ? "table" : "article")
        .getByText("Chú mèo đi hia")
        .first(),
    ).toBeVisible();
    await assertNoHorizontalOverflow(page);
    const tabs = await page
      .locator('[role="tablist"] [role="tab"]')
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            y: r.y,
            h: r.height,
            sw: el.scrollWidth,
            cw: el.clientWidth,
          };
        }),
      );
    expect(tabs.length).toBeGreaterThanOrEqual(4);
    for (const tab of tabs) {
      expect(Math.abs(tab.h - tabs[0].h)).toBeLessThanOrEqual(2);
      if (isDesktop) {
        expect(Math.abs(tab.y - tabs[0].y)).toBeLessThanOrEqual(2);
      }
    }
    if (isDesktop) {
      const actionBtns = await page
        .locator("tbody tr")
        .first()
        .locator("td:last-child a, td:last-child button")
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { y: r.y, h: r.height };
          }),
        );
      expect(actionBtns).toHaveLength(2);
      expect(Math.abs(actionBtns[0].y - actionBtns[1].y)).toBeLessThanOrEqual(
        2,
      );
      expect(Math.abs(actionBtns[0].h - actionBtns[1].h)).toBeLessThanOrEqual(
        2,
      );
    }

    // 6b. /admin/metadata-quality?tab=reports — populated reports, aligned KPIs & single-row 6-filter toolbar on desktop
    await page.goto("/admin/metadata-quality?tab=reports", {
      waitUntil: "networkidle",
    });
    await expect(
      page.getByText("Chữ bị sai dấu ở dòng thứ hai."),
    ).toBeVisible();
    await assertNoHorizontalOverflow(page);
    if (isDesktop) {
      const reportToolbarControls = await page
        .locator('[role="region"] input, [role="region"] select')
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { y: r.y, h: r.height };
          }),
        );
      expect(reportToolbarControls).toHaveLength(6);
      for (let i = 1; i < reportToolbarControls.length; i++) {
        expect(
          Math.abs(reportToolbarControls[i].h - reportToolbarControls[0].h),
        ).toBeLessThanOrEqual(2);
        // All 6 filter controls fit cleanly on ONE horizontal row at 1440px (no orphan wrap)
        expect(
          Math.abs(reportToolbarControls[i].y - reportToolbarControls[0].y),
        ).toBeLessThanOrEqual(2);
      }

      const reportKpiValues = await page
        .locator('section[aria-label*="báo cáo"] .text-2xl')
        .evaluateAll((els) =>
          els.map((el) => Math.round(el.getBoundingClientRect().y)),
        );
      expect(reportKpiValues).toHaveLength(4);
      for (let i = 1; i < reportKpiValues.length; i++) {
        expect(
          Math.abs(reportKpiValues[i] - reportKpiValues[0]),
        ).toBeLessThanOrEqual(2);
      }
    }

    // 6c. /admin/metadata-quality?tab=approval — populated approval list & aligned action buttons
    await page.goto("/admin/metadata-quality?tab=approval", {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("Cây tre trăm đốt")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    const approvalActionBtns = await page
      .locator("article")
      .first()
      .locator("button")
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            y: r.y,
            h: r.height,
            sw: el.scrollWidth,
            cw: el.clientWidth,
          };
        }),
      );
    expect(approvalActionBtns).toHaveLength(2);
    expect(
      Math.abs(approvalActionBtns[0].y - approvalActionBtns[1].y),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(approvalActionBtns[0].h - approvalActionBtns[1].h),
    ).toBeLessThanOrEqual(2);
    for (const btn of approvalActionBtns) {
      expect(btn.sw).toBeLessThanOrEqual(btn.cw + 2);
    }

    // 6d. /admin/metadata-quality?tab=user-books — populated moderation queue & aligned toolbar/action buttons
    await page.goto("/admin/metadata-quality?tab=user-books", {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("Truyện tự viết của Bé An")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    if (isDesktop) {
      const userBooksToolbar = await page
        .locator('[role="region"] input, [role="region"] button')
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { y: r.y, h: r.height };
          }),
        );
      expect(userBooksToolbar.length).toBeGreaterThanOrEqual(2);
      expect(
        Math.abs(userBooksToolbar[0].y - userBooksToolbar[1].y),
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(userBooksToolbar[0].h - userBooksToolbar[1].h),
      ).toBeLessThanOrEqual(2);
    }

    await context.close();
  });

  test("Public /login header buttons align in height and baseline", async ({
    browser,
  }, testInfo) => {
    const isDesktop = testInfo.project.name === "desktop-chromium";
    const context = await browser.newContext({
      viewport: isDesktop
        ? { width: 1440, height: 900 }
        : { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await page.route(`${API_BASE}/health`, (route) =>
      route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*" },
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );

    await page.goto("/login", { waitUntil: "networkidle" });
    await assertNoHorizontalOverflow(page);

    const headerControls = await page
      .locator("header nav a, header [data-variant] button")
      .evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { y: r.y, h: r.height, text: el.textContent?.trim() ?? "" };
        }),
      );
    expect(headerControls).toHaveLength(3);
    for (let i = 1; i < headerControls.length; i++) {
      expect(
        Math.abs(headerControls[i].h - headerControls[0].h),
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(headerControls[i].y - headerControls[0].y),
      ).toBeLessThanOrEqual(2);
    }
    expect(consoleErrors).toEqual([]);

    await context.close();
  });

  test("Parent screens (Entertainment, Reading Management, Progress, Session Report) are compact & aligned", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const isDesktop = testInfo.project.name === "desktop-chromium";
    const context = await browser.newContext({
      viewport: isDesktop
        ? { width: 1440, height: 1000 }
        : { width: 390, height: 844 },
      extraHTTPHeaders: authFixtureHeaders("parent"),
    });
    await seedSession(context, "parent");
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await installMockApi(page);

    // 1. /entertainment — V4 4-card 2x2 desktop grid with real card borders, rounded corners & row-aligned CTAs
    await page.goto("/entertainment", { waitUntil: "networkidle" });
    await expect(
      page.getByRole("heading", { name: "Hát vui cùng bé" }),
    ).toBeVisible();
    await assertNoHorizontalOverflow(page);

    if (isDesktop) {
      const cards = page.locator("main article");
      await expect(cards).toHaveCount(4);
      const cardBoxes = await cards.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const btn = el.querySelector("a")!.getBoundingClientRect();
          return {
            y: r.y,
            h: r.height,
            btnY: btn.y,
            btnH: btn.height,
            borderTopWidth: parseFloat(style.borderTopWidth),
            borderRadius: parseFloat(style.borderTopLeftRadius),
            backgroundColor: style.backgroundColor,
          };
        }),
      );
      for (const card of cardBoxes) {
        expect(card.borderTopWidth).toBeGreaterThanOrEqual(1);
        expect(card.borderRadius).toBeGreaterThanOrEqual(10);
        expect(card.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      }
      // 2x2 grid: row 1 (cards 0 & 1) and row 2 (cards 2 & 3) each align in Y, height, and CTA baseline
      for (const [leftIdx, rightIdx] of [
        [0, 1],
        [2, 3],
      ] as const) {
        expect(
          Math.abs(cardBoxes[rightIdx].y - cardBoxes[leftIdx].y),
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(cardBoxes[rightIdx].h - cardBoxes[leftIdx].h),
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(cardBoxes[rightIdx].btnY - cardBoxes[leftIdx].btnY),
        ).toBeLessThanOrEqual(2);
      }
    }

    // 2. /reading-management — compact header, aligned reminder buttons
    await page.goto("/reading-management", { waitUntil: "networkidle" });
    await expect(page.getByText("19:30")).toBeVisible();
    await assertNoHorizontalOverflow(page);

    if (isDesktop) {
      const firstReminder = page.locator("article[data-reminder-id]").first();
      const ctrlBoxes = await firstReminder
        .locator("label, button")
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { y: r.y, h: r.height };
          }),
        );
      expect(ctrlBoxes.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < ctrlBoxes.length; i++) {
        expect(Math.abs(ctrlBoxes[i].y - ctrlBoxes[0].y)).toBeLessThanOrEqual(
          2,
        );
      }
    }

    // 3. /reports — compact progress report WITH full AI ChildProgressAssessmentCard loaded
    await page.goto("/reports", { waitUntil: "networkidle" });
    await expect(page.getByText("8 buổi", { exact: true })).toBeVisible();
    await expect(page.getByText("Bé An đang tiến bộ rõ rệt")).toBeVisible();
    await expect(page.getByText("82", { exact: true })).toBeVisible();
    await expect(page.getByText(/2026-11-21T10:00:00/)).toHaveCount(0);
    await assertNoHorizontalOverflow(page);

    if (isDesktop) {
      const reportsHeight = await page.evaluate(
        () => document.documentElement.scrollHeight,
      );
      expect(reportsHeight).toBeLessThanOrEqual(2000);
    }

    // 4. /sessions/[id] — compact post-reading detail with single ReadingAssessmentSummary & compact details buttons
    await page.goto(`/sessions/${SESSION_ID}`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByText("Chú mèo đi hia")).toBeVisible();
    await expect(
      page.getByTestId("session-primary-reading-report"),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Kết quả lượt đầu và luyện lại" }),
    ).toHaveCount(1);
    await expect(page.getByText(/2026-11-21T09:50:00/)).toHaveCount(0);
    const detailOtherSummary = page.locator(
      '[data-testid="session-primary-reading-report"] details summary',
    );
    await detailOtherSummary.click();
    const detailOtherBtnHeights = await page
      .locator('[data-testid="session-primary-reading-report"] details button')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(detailOtherBtnHeights.length).toBeGreaterThanOrEqual(2);
    for (const h of detailOtherBtnHeights) {
      expect(h).toBeLessThanOrEqual(38);
    }
    await assertNoHorizontalOverflow(page);

    // 5. /sessions/[id]/report — aligned post-reading standalone report & consistent 36px delete buttons
    await page.goto(`/sessions/${SESSION_ID}/report`, {
      waitUntil: "networkidle",
    });
    await expect(page.getByTestId("standalone-session-report")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Kết quả lượt đầu và luyện lại" }),
    ).toHaveCount(1);
    const standaloneDetailsSummary = page.locator(
      '[data-testid="standalone-session-report"] details summary',
    );
    await standaloneDetailsSummary.click();
    const standaloneDeleteHeights = await page
      .locator('[data-testid="standalone-session-report"] button')
      .filter({ hasText: "Xóa báo cáo" })
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(standaloneDeleteHeights).toHaveLength(2);
    for (const h of standaloneDeleteHeights) {
      expect(h).toBeLessThanOrEqual(38);
    }
    await assertNoHorizontalOverflow(page);

    // 6. /reading/[id]?state=complete — SessionComplete post-reading screen with aligned KPIs & single summary
    await page.goto(`/reading/${SESSION_ID}?state=complete`, {
      waitUntil: "networkidle",
    });
    await expect(
      page.getByTestId("practice-difficult-words-banner"),
    ).toBeVisible();
    await expect(
      page.getByTestId("session-primary-reading-report"),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Kết quả lượt đầu và luyện lại" }),
    ).toHaveCount(1);
    await assertNoHorizontalOverflow(page);
    if (isDesktop) {
      const kpiIconsY = await page
        .locator("section .grid.grid-cols-2.items-stretch > * > svg")
        .evaluateAll((els) =>
          els.map((el) => Math.round(el.getBoundingClientRect().y)),
        );
      expect(kpiIconsY).toHaveLength(4);
      for (let i = 1; i < kpiIconsY.length; i++) {
        expect(Math.abs(kpiIconsY[i] - kpiIconsY[0])).toBeLessThanOrEqual(2);
      }
    }

    expect(consoleErrors).toEqual([]);

    await context.close();
  });

  test("Multi-item lists stay compact and paginate cleanly across parent & admin screens", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(60_000);
    const isDesktop = testInfo.project.name === "desktop-chromium";
    const screenshotDir = process.env.PAGINATION_AUDIT_SCREENSHOT_DIR;
    const captureIfRequested = async (page: Page, filename: string) => {
      if (!isDesktop || !screenshotDir) return;
      await page.screenshot({
        path: path.join(screenshotDir, filename),
        fullPage: true,
      });
    };

    const corsHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    };
    const json = (data: unknown) => ({
      status: 200,
      headers: corsHeaders,
      contentType: "application/json",
      body: JSON.stringify(data),
    });

    const nineChildren = Array.from({ length: 9 }, (_, i) => ({
      id: `92000000-0000-4000-8000-00000000000${i + 1}`,
      parent_id: PARENT_ID,
      alias: `Bé An ${String(i + 1).padStart(2, "0")}`,
      grade: 2,
      settings: {},
      created_at: NOW,
    }));

    const fourteenDifficultWords = [
      "khỏe",
      "ngoan",
      "nhanh",
      "chuyện",
      "nghiêng",
      "xuyên",
      "thương",
      "chiếc",
      "giếng",
      "rừng",
      "buổi",
      "truyện",
      "suối",
      "người",
    ].map((w, i) => ({
      normalized_word: w,
      display_text: w,
      difficulty_score: 90 - i * 3,
      session_count: 3,
      mispronunciation_count: 2,
      omission_count: 1,
      repetition_count: 0,
      long_pause_count: 0,
      read_example_count: 1,
      last_seen_at: NOW,
      evidence_word_ids: [],
      practice_status: i % 2 === 0 ? "IN_PROGRESS" : "NOT_PRACTICED",
    }));

    const twelveParentBooks = Array.from({ length: 12 }, (_, i) => ({
      id: `82000000-0000-4000-8000-0000000001${String(i + 1).padStart(2, "0")}`,
      name: `truyen-thieu-nhi-${i + 1}`,
      title: `Truyện thiếu nhi ${String(i + 1).padStart(2, "0")}`,
      author: `Tác giả ${i + 1}`,
      min_grade: 1,
      max_grade: 3,
      lifecycle_status: "ACTIVE",
      visibility_scope: "CATALOG",
      cover_url: null,
    }));

    const fourteenAdminBooks = Array.from({ length: 14 }, (_, i) => ({
      book: {
        id: `82000000-0000-4000-8000-0000000002${String(i + 1).padStart(2, "0")}`,
        name: `sach-kiem-thu-${i + 1}`,
        title: `Sách kiểm thử ${String(i + 1).padStart(2, "0")}`,
        author: `Tác giả ${i + 1}`,
        min_grade: 1,
        max_grade: 3,
        lifecycle_status: i % 5 === 4 ? "RETIRED" : "ACTIVE",
        created_at: NOW,
        updated_at: NOW,
      },
      page_count: 10,
      verified_count: 8,
      needs_review_count: 2,
      processing_count: 0,
      parent_catalog_eligible: i % 5 !== 4,
    }));

    // --- Parent multi-item pagination checks ---
    const parentContext = await browser.newContext({
      viewport: isDesktop
        ? { width: 1440, height: 900 }
        : { width: 390, height: 844 },
      extraHTTPHeaders: authFixtureHeaders("parent"),
    });
    await seedSession(parentContext, "parent");
    const parentPage = await parentContext.newPage();
    const parentConsoleErrors: string[] = [];
    parentPage.on("console", (msg) => {
      if (msg.type() === "error") parentConsoleErrors.push(msg.text());
    });
    await installMockApi(parentPage);
    await parentPage.route(`${API_BASE}/**`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fallback();
        return;
      }
      const url = new URL(route.request().url());
      const p = url.pathname;

      if (p === "/profiles/children") {
        await route.fulfill(json(nineChildren));
        return;
      }
      if (p.startsWith("/profiles/children/")) {
        const requestedId = p.split("/").pop();
        const found =
          nineChildren.find((c) => c.id === requestedId) ?? nineChildren[0];
        await route.fulfill(json(found));
        return;
      }
      if (p === "/profiles/dashboard-summary") {
        await route.fulfill(
          json({
            profile: {
              id: PARENT_ID,
              display_name: "Phụ huynh Kiểm thử",
              email: "parent@viread.local",
              role: "parent",
              avatar_url: null,
              preferred_locale: "vi",
              created_at: NOW,
            },
            children: nineChildren,
            latest_sessions_by_child: Object.fromEntries(
              nineChildren.map((c) => [c.id, null]),
            ),
          }),
        );
        return;
      }
      if (p.startsWith("/system/progress/") && !p.endsWith("/periods")) {
        await route.fulfill(
          json({
            id: PROG_1_ID,
            child_id: nineChildren[0].id,
            period_start: "2026-10-01",
            period_end: "2026-10-31",
            generated_at: NOW,
            data_status: "complete",
            completed_sessions: 8,
            reading_duration_ms: 48 * 60_000,
            comprehension_accuracy: 88,
            omission_rate: 4.5,
            omission_count: 12,
            repetition_count: 5,
            repetition_rate: 1.9,
            long_pause_count: 7,
            long_pause_rate: 2.6,
            previous_period: {
              completed_sessions: 6,
              reading_duration_ms: 38 * 60_000,
              omission_count: 15,
              repetition_count: 6,
              long_pause_count: 8,
              omission_rate: 6,
              repetition_rate: 2.2,
              long_pause_rate: 3.1,
              comprehension_accuracy: 84,
            },
            trend_deltas: {
              completed_sessions: 2,
              reading_duration_ms: 10 * 60_000,
              comprehension_accuracy: 4,
              omission_rate: -1.5,
              repetition_rate: -0.3,
              long_pause_rate: -0.5,
            },
            legacy: null,
            availability: {
              metrics: "available",
              difficult_words: "available",
              comparison: "available",
            },
            assessment: {
              first_pass_correct: 120,
              first_pass_incorrect: 15,
              self_corrected_words: 9,
              unresolved_words: 6,
              retry_attempts: 14,
              skipped_after_retry_limit: 2,
              recognition_uncertain: 3,
            },
            difficult_words: fourteenDifficultWords,
          }),
        );
        return;
      }
      if (p === "/studio/tasks") {
        await route.fulfill(
          json({
            actor_id: PARENT_ID,
            actor_role: "parent",
            active_count: 0,
            waiting_review_count: 0,
            failed_count: 0,
            completed_count: 0,
            worker_online: true,
            recommended_poll_ms: 30_000,
            tasks: [],
          }),
        );
        return;
      }
      if (p === "/books/catalog") {
        await route.fulfill(json(twelveParentBooks));
        return;
      }
      await route.fallback();
    });

    // 1. /dashboard with 9 children -> 4/page
    await parentPage.goto("/dashboard", { waitUntil: "networkidle" });
    const dashboardSection = parentPage.locator("#child-selection");
    await expect(dashboardSection.getByText("Bé An 01")).toBeVisible();
    await expect(
      dashboardSection.locator(".family-profile-list > *"),
    ).toHaveCount(4);
    await expect(dashboardSection.getByText("Bé An 04")).toBeVisible();
    await expect(dashboardSection.getByText("Bé An 05")).toHaveCount(0);
    const dashboardNav = dashboardSection.locator("nav");
    await expect(dashboardNav.getByText("Trang 1 / 3")).toBeVisible();
    await assertNoHorizontalOverflow(parentPage);
    if (isDesktop) {
      const dashHeight = await parentPage.evaluate(
        () => document.documentElement.scrollHeight,
      );
      expect(dashHeight).toBeLessThanOrEqual(1280);
    }
    await captureIfRequested(parentPage, "pagination-dashboard-9-children.png");

    await dashboardNav.getByRole("button", { name: /Tiếp/i }).click();
    await expect(dashboardNav.getByText("Trang 2 / 3")).toBeVisible();
    await expect(dashboardSection.getByText("Bé An 05")).toBeVisible();
    await expect(dashboardSection.getByText("Bé An 08")).toBeVisible();
    await expect(dashboardSection.getByText("Bé An 01")).toHaveCount(0);
    await expect(dashboardSection.getByText("Bé An 09")).toHaveCount(0);
    await dashboardNav.getByRole("button", { name: /Trước/i }).click();
    await expect(dashboardNav.getByText("Trang 1 / 3")).toBeVisible();
    await expect(dashboardSection.getByText("Bé An 01")).toBeVisible();

    // 2. /children with 9 children -> 6/page
    await parentPage.goto("/children", { waitUntil: "networkidle" });
    await expect(parentPage.getByText("Bé An 01")).toBeVisible();
    await expect(parentPage.getByText("Bé An 06")).toBeVisible();
    await expect(parentPage.getByText("Bé An 07")).toHaveCount(0);
    const childrenNav = parentPage.locator("main nav").first();
    await expect(childrenNav.getByText("Trang 1 / 2")).toBeVisible();
    await assertNoHorizontalOverflow(parentPage);
    if (isDesktop) {
      const childrenHeight = await parentPage.evaluate(
        () => document.documentElement.scrollHeight,
      );
      expect(childrenHeight).toBeLessThanOrEqual(1100);
    }
    await captureIfRequested(parentPage, "pagination-children-9-children.png");

    await childrenNav.getByRole("button", { name: /Tiếp/i }).click();
    await expect(childrenNav.getByText("Trang 2 / 2")).toBeVisible();
    await expect(parentPage.getByText("Bé An 07")).toBeVisible();
    await expect(parentPage.getByText("Bé An 09")).toBeVisible();
    await expect(parentPage.getByText("Bé An 01")).toHaveCount(0);
    await childrenNav.getByRole("button", { name: /Trước/i }).click();
    await expect(childrenNav.getByText("Trang 1 / 2")).toBeVisible();

    // 3. /reports with 14 difficult words -> 6/page
    await parentPage.goto("/reports", { waitUntil: "networkidle" });
    await expect(parentPage.getByText("8 buổi", { exact: true })).toBeVisible();
    const difficultWordsSection = parentPage
      .locator("section")
      .filter({
        has: parentPage.locator("h2", { hasText: /Từ cần luyện nổi bật/i }),
      })
      .last();
    await expect(difficultWordsSection.locator(":scope > ul > li")).toHaveCount(
      6,
    );
    await expect(
      difficultWordsSection.getByText("khỏe", { exact: true }),
    ).toBeVisible();
    await expect(
      difficultWordsSection.getByText("thương", { exact: true }),
    ).toHaveCount(0);
    const reportsNav = difficultWordsSection.locator("nav");
    await expect(reportsNav.getByText("Trang 1 / 3")).toBeVisible();
    await assertNoHorizontalOverflow(parentPage);
    if (isDesktop) {
      const reportsHeight = await parentPage.evaluate(
        () => document.documentElement.scrollHeight,
      );
      expect(reportsHeight).toBeLessThanOrEqual(2050);
    }
    await captureIfRequested(
      parentPage,
      "pagination-reports-14-difficult-words.png",
    );

    await reportsNav.getByRole("button", { name: /Tiếp/i }).click();
    await expect(reportsNav.getByText("Trang 2 / 3")).toBeVisible();
    await expect(difficultWordsSection.locator(":scope > ul > li")).toHaveCount(
      6,
    );
    await expect(
      difficultWordsSection.getByText("thương", { exact: true }),
    ).toBeVisible();
    await expect(
      difficultWordsSection.getByText("khỏe", { exact: true }),
    ).toHaveCount(0);
    await reportsNav.getByRole("button", { name: /Tiếp/i }).click();
    await expect(reportsNav.getByText("Trang 3 / 3")).toBeVisible();
    await expect(difficultWordsSection.locator(":scope > ul > li")).toHaveCount(
      2,
    );

    // 4. /books with 12 books -> 9/page
    await parentPage.goto(`/books?childId=${nineChildren[0].id}`, {
      waitUntil: "networkidle",
    });
    await expect(
      parentPage.getByRole("heading", { name: "Truyện thiếu nhi 01" }),
    ).toBeVisible();
    await expect(
      parentPage.getByRole("heading", { name: "Truyện thiếu nhi 09" }),
    ).toBeVisible();
    await expect(
      parentPage.getByRole("heading", { name: "Truyện thiếu nhi 10" }),
    ).toHaveCount(0);
    const booksNav = parentPage.locator("main nav, section nav").last();
    await expect(booksNav.getByText("Trang 1 / 2")).toBeVisible();
    await assertNoHorizontalOverflow(parentPage);

    await booksNav.getByRole("button", { name: /Tiếp/i }).click();
    await expect(booksNav.getByText("Trang 2 / 2")).toBeVisible();
    await expect(
      parentPage.getByRole("heading", { name: "Truyện thiếu nhi 10" }),
    ).toBeVisible();
    await expect(
      parentPage.getByRole("heading", { name: "Truyện thiếu nhi 12" }),
    ).toBeVisible();
    await expect(
      parentPage.getByRole("heading", { name: "Truyện thiếu nhi 01" }),
    ).toHaveCount(0);
    await booksNav.getByRole("button", { name: /Trước/i }).click();
    await expect(booksNav.getByText("Trang 1 / 2")).toBeVisible();

    expect(parentConsoleErrors).toEqual([]);
    await parentContext.close();

    // --- Admin multi-item pagination check (/admin/books with 14 books -> 10/page) ---
    const adminContext = await browser.newContext({
      viewport: isDesktop
        ? { width: 1440, height: 900 }
        : { width: 390, height: 844 },
      extraHTTPHeaders: authFixtureHeaders("admin"),
    });
    await seedSession(adminContext, "admin");
    const adminPage = await adminContext.newPage();
    const adminConsoleErrors: string[] = [];
    adminPage.on("console", (msg) => {
      if (msg.type() === "error") adminConsoleErrors.push(msg.text());
    });
    await installMockApi(adminPage);
    await adminPage.route(`${API_BASE}/studio/tasks**`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fallback();
        return;
      }
      await route.fulfill(
        json({
          actor_id: ADMIN_ID,
          actor_role: "admin",
          active_count: 0,
          waiting_review_count: 0,
          failed_count: 0,
          completed_count: 0,
          worker_online: true,
          recommended_poll_ms: 30_000,
          tasks: [],
        }),
      );
    });
    await adminPage.route(
      `${API_BASE}/books/admin/catalog**`,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await route.fallback();
          return;
        }
        await route.fulfill(json(fourteenAdminBooks));
      },
    );

    await adminPage.goto("/admin/books", { waitUntil: "networkidle" });
    await expect(adminPage.getByText("Sách kiểm thử 01")).toBeVisible();
    const adminBookRows = adminPage.locator('[role="listitem"]');
    await expect(adminBookRows).toHaveCount(10);
    await expect(adminPage.getByText("Sách kiểm thử 10")).toBeVisible();
    await expect(adminPage.getByText("Sách kiểm thử 11")).toHaveCount(0);

    const adminNav = adminPage.locator("main nav").last();
    await expect(adminNav.getByText("Trang 1 / 2")).toBeVisible();
    await assertNoHorizontalOverflow(adminPage);

    if (isDesktop) {
      const firstRowBtns = await adminBookRows
        .nth(0)
        .locator("a[href], button")
        .filter({ hasNot: adminPage.locator("h2") })
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }),
        );
      const lastRowBtns = await adminBookRows
        .nth(9)
        .locator("a[href], button")
        .filter({ hasNot: adminPage.locator("h2") })
        .evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }),
        );
      expect(firstRowBtns).toHaveLength(4);
      expect(lastRowBtns).toHaveLength(4);
      for (let i = 0; i < 4; i++) {
        expect(
          Math.abs(firstRowBtns[i].x - lastRowBtns[i].x),
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(firstRowBtns[i].w - lastRowBtns[i].w),
        ).toBeLessThanOrEqual(2);
      }

      const navButtons = await adminNav.locator("button").evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { y: r.y, h: r.height };
        }),
      );
      expect(navButtons).toHaveLength(2);
      expect(Math.abs(navButtons[0].y - navButtons[1].y)).toBeLessThanOrEqual(
        2,
      );
      expect(Math.abs(navButtons[0].h - navButtons[1].h)).toBeLessThanOrEqual(
        2,
      );
    }

    await captureIfRequested(adminPage, "pagination-admin-books-14-books.png");

    await adminNav.getByRole("button", { name: /Tiếp/i }).click();
    await expect(adminNav.getByText("Trang 2 / 2")).toBeVisible();
    await expect(adminBookRows).toHaveCount(4);
    await expect(adminPage.getByText("Sách kiểm thử 11")).toBeVisible();
    await expect(adminPage.getByText("Sách kiểm thử 14")).toBeVisible();
    await expect(adminPage.getByText("Sách kiểm thử 01")).toHaveCount(0);
    await adminNav.getByRole("button", { name: /Trước/i }).click();
    await expect(adminNav.getByText("Trang 1 / 2")).toBeVisible();
    await expect(adminBookRows).toHaveCount(10);

    expect(adminConsoleErrors).toEqual([]);
    await adminContext.close();
  });
});
